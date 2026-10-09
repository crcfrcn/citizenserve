//! 跨功能执行测试和真实内存端口；平台SQL/对象/网络实现仍须独立运行态验收。
use super::{
    attachment::{
        self,
        ports::{Deletion, Operation, State, Stored, Upload, Written},
    },
    auth::{self, Access, Device, HostAccess},
    key, mailbox,
    protocol::{self, chat_frame::Body},
    push::{self, Endpoint, Finish, InvalidEndpoint, Lease, Outcome, PushPlatform},
    realtime::session::Session,
    service::Service,
    Error, Limits, Result,
};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

pub const NOW: u64 = 1_000_000;
pub fn run<F: Future>(future: F) -> F::Output {
    // 内存端口立即完成；使用标准空唤醒器，不建立独立异步调度器。
    let waker = Waker::noop();
    match Box::pin(future)
        .as_mut()
        .poll(&mut Context::from_waker(waker))
    {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("本测试只使用立即完成的内存端口"),
    }
}
pub fn actor(user: &str, device: &str) -> Device {
    Device {
        user_id: user.to_owned(),
        device_id: device.to_owned(),
    }
}
pub fn snapshot(device: Device) -> HostAccess {
    HostAccess {
        actor: device,
        chat_enabled: true,
        max_attachment_bytes: 10 * 1024 * 1024,
        authorization_revision: "revision-1".into(),
        session_id_digest: "a".repeat(64),
        issued_at_millis: NOW,
        expires_at_millis: NOW + 900_000,
        recheck_at_millis: NOW + 60_000,
    }
}
pub fn access(user: &str, device: &str) -> Access {
    Access::from_host(snapshot(actor(user, device)), NOW).expect("合成宿主许可")
}
pub struct FakeHost {
    pub time: Rc<Cell<u64>>,
    pub failure: Cell<Option<Error>>,
    pub revision: RefCell<Option<String>>,
    pub calls: Cell<u32>,
}
impl Default for FakeHost {
    fn default() -> Self {
        Self {
            time: Rc::new(Cell::new(NOW)),
            failure: Cell::new(None),
            revision: RefCell::new(None),
            calls: Cell::new(0),
        }
    }
}
impl auth::ports::Host for FakeHost {
    fn now_millis(&self) -> u64 {
        self.time.get()
    }
    async fn recheck(&self, previous: &HostAccess) -> Result<HostAccess> {
        self.calls.set(self.calls.get() + 1);
        if let Some(error) = self.failure.get() {
            return Err(error);
        }
        let mut fresh = previous.clone();
        fresh.issued_at_millis = self.time.get();
        fresh.expires_at_millis = self.time.get() + 900_000;
        fresh.recheck_at_millis = self.time.get() + 60_000;
        if let Some(revision) = self.revision.borrow().as_ref() {
            fresh.authorization_revision = revision.clone();
        }
        Ok(fresh)
    }
    async fn authorize_wake(&self, registered: &HostAccess) -> Result<HostAccess> {
        self.recheck(registered).await
    }
}

#[derive(Clone)]
struct Retired {
    creator: Device,
    recipients: Vec<String>,
    expires: u64,
    aborted: bool,
}
#[derive(Default)]
struct Data {
    packages: BTreeMap<(String, String), key::Package>,
    receipts: BTreeMap<String, mailbox::Receipt>,
    deliveries: Vec<mailbox::Delivery>,
    attachments: BTreeMap<String, Stored>,
    chunks: BTreeMap<(String, u32), Written>,
    acknowledgements: BTreeSet<(String, String)>,
    retired: BTreeMap<String, Retired>,
    aborted: BTreeSet<String>,
    endpoints: Vec<Endpoint>,
    generation: u64,
    attempts: u64,
    jobs: Vec<Lease>,
    finishes: Vec<(String, Finish)>,
}
pub struct Memory {
    data: RefCell<Data>,
    time: Rc<Cell<u64>>,
    pub fail_commit: Cell<bool>,
    pub fail_confirm: Cell<bool>,
    pub fail_finalize: Cell<bool>,
    pub lose_lease: Cell<bool>,
}
impl Memory {
    pub fn new(host: &FakeHost) -> Self {
        Self {
            data: RefCell::new(Data::default()),
            time: host.time.clone(),
            fail_commit: Cell::new(false),
            fail_confirm: Cell::new(false),
            fail_finalize: Cell::new(false),
            lose_lease: Cell::new(false),
        }
    }
    fn guard(&self, access: &Access) -> Result<()> {
        access.ensure_current(self.time.get())
    }
    pub fn deliveries(&self) -> usize {
        self.data.borrow().deliveries.len()
    }
    pub fn receipt(&self, id: &str) -> Option<mailbox::Receipt> {
        self.data.borrow().receipts.get(id).cloned()
    }
    pub fn jobs(&self) -> usize {
        self.data.borrow().jobs.len()
    }
    pub fn finishes(&self) -> Vec<Finish> {
        self.data
            .borrow()
            .finishes
            .iter()
            .map(|(_, result)| *result)
            .collect()
    }
    pub fn state(&self, id: &str) -> Option<State> {
        self.data
            .borrow()
            .attachments
            .get(id)
            .map(|stored| stored.state)
    }
    pub fn has_retired(&self, id: &str) -> bool {
        self.data.borrow().retired.contains_key(id)
    }
    fn get(&self, access: &Access, id: &str) -> Result<Stored> {
        self.guard(access)?;
        self.data
            .borrow()
            .attachments
            .get(id)
            .cloned()
            .filter(|stored| stored.metadata.expires_at_millis > self.time.get())
            .ok_or(Error::NotFound)
    }
    fn owner(&self, access: &Access, stored: &Stored) -> Result<()> {
        if stored.metadata.sender_user_id != access.actor().user_id
            || stored.metadata.sender_device_id != access.actor().device_id
        {
            Err(Error::NotFound)
        } else {
            Ok(())
        }
    }
    pub fn set_attempts(&self, attempts: u32) {
        for job in &mut self.data.borrow_mut().jobs {
            job.attempts = attempts;
        }
    }
}
impl key::ports::Store for Memory {
    async fn publish(&self, access: &Access, package: &key::Package) -> Result<()> {
        self.guard(access)?;
        self.data.borrow_mut().packages.insert(
            (package.user_id.clone(), package.device_id.clone()),
            package.clone(),
        );
        Ok(())
    }
    async fn resolve(
        &self,
        user: &str,
        device: Option<&str>,
        now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> Result<Vec<key::Package>> {
        let data = self.data.borrow();
        let mut selected = Vec::new();
        for package in data
            .packages
            .values()
            .filter(|package| {
                package.user_id == user
                    && device.is_none_or(|id| package.device_id == id)
                    && package.not_before <= now
                    && package.not_after > now
            })
            .take(limit as usize)
        {
            selected.push(package.clone());
            if protocol::encoded_len(&protocol::key_package_batch_frame(&selected)?) > maximum_bytes
            {
                selected.pop();
                if selected.is_empty() {
                    return Err(Error::ResourceLimit);
                }
                break;
            }
        }
        Ok(selected)
    }
}
impl mailbox::ports::Store for Memory {
    async fn commit_message(
        &self,
        access: &Access,
        receipt: &mailbox::Receipt,
        deliveries: &[mailbox::Delivery],
    ) -> Result<mailbox::ports::Commit> {
        self.guard(access)?;
        let mut data = self.data.borrow_mut();
        if let Some(stored) = data.receipts.get(&receipt.message_id) {
            return if stored.fingerprint == receipt.fingerprint {
                Ok(mailbox::ports::Commit::Duplicate)
            } else {
                Err(Error::Conflict)
            };
        }
        if self.fail_commit.get() {
            return Err(Error::StorageUnavailable);
        }
        data.receipts
            .insert(receipt.message_id.clone(), receipt.clone());
        for delivery in deliveries {
            data.deliveries.push(delivery.clone());
            data.jobs.push(Lease {
                message_id: receipt.message_id.clone(),
                recipient: actor(&delivery.recipient_user_id, &delivery.recipient_device_id),
                lease_id: format!(
                    "lease-{}-{}",
                    receipt.message_id, delivery.recipient_device_id
                ),
                lease_until_millis: self.time.get() + 60_000,
                attempts: 1,
            });
        }
        Ok(mailbox::ports::Commit::Inserted)
    }
    async fn messages(
        &self,
        access: &Access,
        now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> Result<Vec<mailbox::Delivery>> {
        self.guard(access)?;
        let data = self.data.borrow();
        let mut selected = Vec::new();
        for item in data
            .deliveries
            .iter()
            .filter(|item| {
                item.recipient_user_id == access.actor().user_id
                    && item.recipient_device_id == access.actor().device_id
                    && item.expires_at_millis > now
            })
            .take(limit as usize)
        {
            selected.push(item.clone());
            if protocol::encoded_len(&protocol::message_batch_frame(&selected)?) > maximum_bytes {
                selected.pop();
                if selected.is_empty() {
                    return Err(Error::ResourceLimit);
                }
                break;
            }
        }
        Ok(selected)
    }
    async fn acknowledge_messages(&self, access: &Access, ids: &[String], _now: u64) -> Result<()> {
        self.guard(access)?;
        let mut data = self.data.borrow_mut();
        data.deliveries.retain(|item| {
            !(item.recipient_user_id == access.actor().user_id
                && item.recipient_device_id == access.actor().device_id
                && ids.contains(&item.message_id))
        });
        data.jobs
            .retain(|job| !(job.recipient == *access.actor() && ids.contains(&job.message_id)));
        Ok(())
    }
}
impl attachment::ports::Store for Memory {
    async fn completed(
        &self,
        access: &Access,
        id: &str,
        operation: Operation,
        now: u64,
    ) -> Result<bool> {
        self.guard(access)?;
        let data = self.data.borrow();
        let Some(retired) = data.retired.get(id) else {
            return Ok(false);
        };
        if retired.expires <= now {
            return Err(Error::NotFound);
        }
        let allowed = match operation {
            Operation::Acknowledge => {
                !retired.aborted && retired.recipients.contains(&access.actor().user_id)
            }
            Operation::Complete => !retired.aborted && retired.creator == *access.actor(),
            Operation::Abort => retired.aborted && retired.creator == *access.actor(),
        };
        if allowed {
            Ok(true)
        } else {
            Err(Error::NotFound)
        }
    }
    async fn begin(&self, access: &Access, attachment: &attachment::Attachment) -> Result<()> {
        self.guard(access)?;
        let mut data = self.data.borrow_mut();
        if data.retired.contains_key(&attachment.attachment_id) {
            return Err(Error::Conflict);
        }
        if let Some(stored) = data.attachments.get(&attachment.attachment_id) {
            let mut same = attachment.clone();
            same.accepted_at_millis = stored.metadata.accepted_at_millis;
            same.expires_at_millis = stored.metadata.expires_at_millis;
            return if same == stored.metadata {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        data.generation += 1;
        let generation = format!("generation-{}", data.generation);
        data.attachments.insert(
            attachment.attachment_id.clone(),
            Stored {
                metadata: attachment.clone(),
                state: State::Pending,
                generation,
            },
        );
        Ok(())
    }
    async fn attachment(&self, access: &Access, id: &str, _now: u64) -> Result<Stored> {
        self.get(access, id)
    }
    async fn reserve_upload(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        _now: u64,
    ) -> Result<Upload> {
        let current = self.get(access, &stored.metadata.attachment_id)?;
        self.owner(access, &current)?;
        if current.state != State::Pending || current.generation != stored.generation {
            return Err(Error::Conflict);
        }
        let chunk = current
            .metadata
            .expected_chunk(index)
            .ok_or(Error::NotFound)?
            .clone();
        let mut data = self.data.borrow_mut();
        data.attempts += 1;
        let attempt_id = format!("attempt-{}", data.attempts);
        Ok(Upload {
            attachment_id: current.metadata.attachment_id.clone(),
            generation: current.generation.clone(),
            object_key: format!(
                "attachments/{}/{}/{}/{}",
                current.metadata.attachment_id, current.generation, index, attempt_id
            ),
            attempt_id,
            chunk,
        })
    }
    async fn confirm_upload(&self, access: &Access, written: &Written, _now: u64) -> Result<()> {
        let stored = self.get(access, &written.upload.attachment_id)?;
        self.owner(access, &stored)?;
        if self.fail_confirm.get() {
            return Err(Error::StorageUnavailable);
        }
        if stored.state != State::Pending || stored.generation != written.upload.generation {
            return Err(Error::Conflict);
        }
        self.data
            .borrow_mut()
            .chunks
            .entry((
                written.upload.attachment_id.clone(),
                written.upload.chunk.chunk_index,
            ))
            .or_insert_with(|| written.clone());
        Ok(())
    }
    async fn downloaded_chunk(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        _now: u64,
    ) -> Result<Written> {
        self.guard(access)?;
        self.data
            .borrow()
            .chunks
            .get(&(stored.metadata.attachment_id.clone(), index))
            .cloned()
            .ok_or(Error::NotFound)
    }
    async fn complete(&self, access: &Access, id: &str, _now: u64) -> Result<()> {
        let stored = self.get(access, id)?;
        self.owner(access, &stored)?;
        let mut data = self.data.borrow_mut();
        if stored.state == State::Deleting
            || stored.metadata.chunks.iter().any(|chunk| {
                !data
                    .chunks
                    .contains_key(&(id.to_owned(), chunk.chunk_index))
            })
        {
            return Err(Error::Conflict);
        }
        data.attachments.get_mut(id).expect("已加载").state = State::Ready;
        Ok(())
    }
    async fn acknowledge(&self, access: &Access, id: &str, _now: u64) -> Result<Option<Deletion>> {
        let stored = self.get(access, id)?;
        if !stored
            .metadata
            .recipient_user_ids
            .contains(&access.actor().user_id)
        {
            return Err(Error::NotFound);
        }
        if stored.state == State::Pending {
            return Err(Error::Conflict);
        }
        let mut data = self.data.borrow_mut();
        data.acknowledgements
            .insert((id.to_owned(), access.actor().user_id.clone()));
        if stored.metadata.recipient_user_ids.iter().all(|user| {
            data.acknowledgements
                .contains(&(id.to_owned(), user.clone()))
        }) {
            data.attachments.get_mut(id).expect("已加载").state = State::Deleting;
            Ok(Some(Deletion {
                attachment_id: id.to_owned(),
                generation: stored.generation,
            }))
        } else {
            Ok(None)
        }
    }
    async fn abort(&self, access: &Access, id: &str, _now: u64) -> Result<Deletion> {
        let stored = self.get(access, id)?;
        self.owner(access, &stored)?;
        let mut data = self.data.borrow_mut();
        data.attachments.get_mut(id).expect("已加载").state = State::Deleting;
        data.aborted.insert(id.to_owned());
        Ok(Deletion {
            attachment_id: id.to_owned(),
            generation: stored.generation,
        })
    }
    async fn finalize(&self, deletion: &Deletion) -> Result<()> {
        if self.fail_finalize.get() {
            return Err(Error::StorageUnavailable);
        }
        let mut data = self.data.borrow_mut();
        let Some(stored) = data.attachments.get(&deletion.attachment_id).cloned() else {
            return Ok(());
        };
        if stored.state != State::Deleting || stored.generation != deletion.generation {
            return Err(Error::Conflict);
        }
        let aborted = data.aborted.contains(&deletion.attachment_id);
        data.retired.insert(
            deletion.attachment_id.clone(),
            Retired {
                creator: actor(
                    &stored.metadata.sender_user_id,
                    &stored.metadata.sender_device_id,
                ),
                recipients: stored.metadata.recipient_user_ids,
                expires: stored.metadata.expires_at_millis,
                aborted,
            },
        );
        data.attachments.remove(&deletion.attachment_id);
        data.chunks
            .retain(|(id, _), _| id != &deletion.attachment_id);
        Ok(())
    }
    async fn pending_deletions(&self, now: u64, limit: u32) -> Result<Vec<Deletion>> {
        let mut data = self.data.borrow_mut();
        Ok(data
            .attachments
            .values_mut()
            .filter_map(|stored| {
                if stored.metadata.expires_at_millis <= now || stored.state == State::Deleting {
                    stored.state = State::Deleting;
                    Some(Deletion {
                        attachment_id: stored.metadata.attachment_id.clone(),
                        generation: stored.generation.clone(),
                    })
                } else {
                    None
                }
            })
            .take(limit as usize)
            .collect())
    }
}
impl push::ports::Store for Memory {
    async fn register(&self, access: &Access, endpoint: &Endpoint) -> Result<()> {
        self.guard(access)?;
        endpoint.validate()?;
        let mut data = self.data.borrow_mut();
        if data.endpoints.iter().any(|old| {
            old.platform == endpoint.platform
                && old.token == endpoint.token
                && old.access.actor != endpoint.access.actor
        }) {
            return Err(Error::Conflict);
        }
        data.endpoints.retain(|old| {
            !(old.platform == endpoint.platform && old.access.actor == endpoint.access.actor)
        });
        data.generation += 1;
        let mut endpoint = endpoint.clone();
        endpoint.generation = data.generation;
        data.endpoints.push(endpoint);
        Ok(())
    }
    async fn remove(&self, access: &Access, platform: PushPlatform) -> Result<()> {
        self.guard(access)?;
        self.data.borrow_mut().endpoints.retain(|endpoint| {
            !(endpoint.platform == platform && endpoint.access.actor == *access.actor())
        });
        Ok(())
    }
    async fn claim(&self, now: u64, limit: u32) -> Result<Vec<Lease>> {
        Ok(self
            .data
            .borrow()
            .jobs
            .iter()
            .filter(|lease| lease.lease_until_millis > now)
            .take(limit as usize)
            .cloned()
            .collect())
    }
    async fn endpoints(&self, device: &Device) -> Result<Vec<Endpoint>> {
        Ok(self
            .data
            .borrow()
            .endpoints
            .iter()
            .filter(|endpoint| endpoint.access.actor == *device)
            .cloned()
            .collect())
    }
    async fn renew(&self, lease: &Lease, now: u64) -> Result<Lease> {
        if self.lose_lease.get() {
            return Err(Error::Conflict);
        }
        let mut data = self.data.borrow_mut();
        let current = data
            .jobs
            .iter_mut()
            .find(|job| job.lease_id == lease.lease_id)
            .ok_or(Error::Conflict)?;
        if current.lease_until_millis <= now {
            return Err(Error::Conflict);
        }
        current.lease_until_millis = now + 60_000;
        Ok(current.clone())
    }
    async fn finish(
        &self,
        lease: &Lease,
        result: Finish,
        invalid: &[InvalidEndpoint],
        now: u64,
    ) -> Result<()> {
        if self.lose_lease.get() || lease.lease_until_millis <= now {
            return Err(Error::Conflict);
        }
        let mut data = self.data.borrow_mut();
        if !data.jobs.iter().any(|job| job.lease_id == lease.lease_id) {
            return Err(Error::Conflict);
        }
        data.endpoints.retain(|endpoint| {
            !(endpoint.access.actor == lease.recipient
                && invalid.iter().any(|item| {
                    item.platform == endpoint.platform && item.generation == endpoint.generation
                }))
        });
        data.finishes.push((lease.lease_id.clone(), result));
        data.jobs.retain(|job| job.lease_id != lease.lease_id);
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeObjects {
    data: RefCell<BTreeMap<String, (String, Vec<u8>)>>,
    pub fail_delete: Cell<bool>,
    pub discarded: RefCell<Vec<String>>,
    pub delete_count: Cell<u32>,
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
impl FakeObjects {
    pub fn count(&self) -> usize {
        self.data.borrow().len()
    }
    pub fn keep(&self, key: &str, bytes: Vec<u8>) {
        self.data
            .borrow_mut()
            .insert(key.to_owned(), ("winner".into(), bytes));
    }
    pub fn contains(&self, key: &str) -> bool {
        self.data.borrow().contains_key(key)
    }
}
impl attachment::ports::Objects for FakeObjects {
    type UploadBody = Vec<u8>;
    type DownloadBody = Vec<u8>;
    async fn put(&self, upload: &Upload, body: Vec<u8>, _deadline: u64) -> Result<Written> {
        let sha256 = digest(&body);
        let size = body.len() as u64;
        if size != upload.chunk.cipher_byte_size || sha256 != upload.chunk.cipher_sha256 {
            return Err(Error::InvalidRequest);
        }
        let version = upload.attempt_id.clone();
        self.data
            .borrow_mut()
            .insert(upload.object_key.clone(), (version.clone(), body));
        Ok(Written {
            upload: upload.clone(),
            object_version: version,
            size,
            sha256,
        })
    }
    async fn discard(&self, written: &Written) -> Result<()> {
        let mut data = self.data.borrow_mut();
        if data
            .get(&written.upload.object_key)
            .is_some_and(|(version, _)| version == &written.object_version)
        {
            data.remove(&written.upload.object_key);
            self.discarded
                .borrow_mut()
                .push(written.upload.attempt_id.clone());
        }
        Ok(())
    }
    async fn open(&self, written: &Written, _deadline: u64) -> Result<Vec<u8>> {
        self.data
            .borrow()
            .get(&written.upload.object_key)
            .filter(|(version, _)| version == &written.object_version)
            .map(|(_, bytes)| bytes.clone())
            .ok_or(Error::NotFound)
    }
    async fn delete(&self, deletion: &Deletion) -> Result<()> {
        self.delete_count.set(self.delete_count.get() + 1);
        if self.fail_delete.get() {
            return Err(Error::StorageUnavailable);
        }
        let prefix = format!(
            "attachments/{}/{}/",
            deletion.attachment_id, deletion.generation
        );
        self.data
            .borrow_mut()
            .retain(|key, _| !key.starts_with(&prefix));
        Ok(())
    }
}
pub struct FakeProvider {
    pub outcome: Cell<Outcome>,
    pub sends: Cell<u32>,
}
impl Default for FakeProvider {
    fn default() -> Self {
        Self {
            outcome: Cell::new(Outcome::Accepted),
            sends: Cell::new(0),
        }
    }
}
impl push::ports::Provider for FakeProvider {
    async fn send(
        &self,
        _endpoint: &Endpoint,
        payload: &serde_json::Value,
        _now: u64,
    ) -> Result<Outcome> {
        assert!(payload.to_string().contains("chat_wake"));
        self.sends.set(self.sends.get() + 1);
        Ok(self.outcome.get())
    }
}
pub fn config() -> push::Config {
    push::Config {
        ios_app_id: "app.example".into(),
        android_app_id: "app.example".into(),
    }
}
pub fn message() -> protocol::EncryptedMessage {
    protocol::EncryptedMessage {
        message_id: "message-1".into(),
        conversation_id: "conversation-1".into(),
        sender_user_id: "sender".into(),
        sender_device_id: "phone".into(),
        created_at_millis: NOW,
        deliveries: vec![protocol::EncryptedDelivery {
            recipient: Some(protocol::Recipient {
                user_id: "recipient".into(),
                device_id: "phone".into(),
            }),
            openmls_ciphertext: vec![0, 255, 42],
        }],
    }
}
pub fn attachment_metadata(id: &str) -> protocol::AttachmentMetadata {
    let bytes = b"encrypted";
    protocol::AttachmentMetadata {
        attachment_id: id.into(),
        sender_user_id: "sender".into(),
        recipient_user_ids: vec!["recipient".into()],
        chunks: vec![protocol::AttachmentChunk {
            chunk_index: 0,
            cipher_byte_size: bytes.len() as u64,
            cipher_sha256: digest(bytes),
        }],
        cipher_byte_size: bytes.len() as u64,
        cipher_sha256: digest(bytes),
        created_at_millis: NOW,
    }
}
pub fn package() -> protocol::KeyPackage {
    protocol::KeyPackage {
        user_id: "sender".into(),
        device_id: "phone".into(),
        key_package_ref: "a".repeat(64),
        key_package: vec![1, 2, 3],
        cipher_suite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519".into(),
        not_before: NOW,
        not_after: NOW + 600_000,
        last_resort: true,
    }
}

#[test]
fn twelve_commands_execute_through_the_unique_service() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let config = config();
    let service = Service {
        host: &host,
        store: &store,
        objects: &objects,
        push_config: &config,
        limits: Limits {
            max_attachment_bytes: 10 * 1024 * 1024,
            max_frame_bytes: 4 * 1024 * 1024,
        },
    };
    let mut sender = Session::new(access("sender", "phone"));
    let mut recipient = Session::new(access("recipient", "phone"));
    let execute = |session: &mut Session, body| {
        run(service.execute(
            session,
            &protocol::encode_chat_frame(&protocol::ChatFrame { body: Some(body) }),
        ))
        .expect("真实命令成功")
    };
    assert!(matches!(
        execute(
            &mut sender,
            Body::Ping(protocol::Ping { sent_at_millis: 7 })
        )
        .frame
        .body,
        Some(Body::Pong(_))
    ));
    execute(
        &mut sender,
        Body::PublishKeyPackage(protocol::PublishKeyPackage {
            key_package: Some(package()),
        }),
    );
    assert!(matches!(
        execute(
            &mut sender,
            Body::ResolveKeyPackages(protocol::ResolveKeyPackages {
                user_id: "sender".into(),
                device_id: String::new(),
                limit: 32
            })
        )
        .frame
        .body,
        Some(Body::KeyPackageBatch(_))
    ));
    let sent = execute(
        &mut sender,
        Body::SendMessage(protocol::SendMessage {
            message: Some(message()),
        }),
    );
    assert_eq!(sent.notifications.len(), 1);
    assert!(matches!(
        execute(
            &mut recipient,
            Body::SyncMessages(protocol::SyncMessages { limit: 10 })
        )
        .frame
        .body,
        Some(Body::MessageBatch(_))
    ));
    execute(
        &mut recipient,
        Body::AcknowledgeMessages(protocol::AcknowledgeMessages {
            message_ids: vec!["message-1".into()],
        }),
    );
    execute(
        &mut sender,
        Body::BeginAttachment(protocol::BeginAttachment {
            attachment: Some(attachment_metadata("file-1")),
        }),
    );
    run(attachment::service::upload(
        &store,
        &objects,
        sender.access(),
        "file-1",
        0,
        b"encrypted".to_vec(),
        NOW,
    ))
    .expect("上传实际密文");
    execute(
        &mut sender,
        Body::CompleteAttachment(protocol::CompleteAttachment {
            attachment_id: "file-1".into(),
        }),
    );
    execute(
        &mut recipient,
        Body::AcknowledgeAttachment(protocol::AcknowledgeAttachment {
            attachment_id: "file-1".into(),
        }),
    );
    execute(
        &mut sender,
        Body::BeginAttachment(protocol::BeginAttachment {
            attachment: Some(attachment_metadata("file-2")),
        }),
    );
    execute(
        &mut sender,
        Body::AbortAttachment(protocol::AbortAttachment {
            attachment_id: "file-2".into(),
        }),
    );
    execute(
        &mut sender,
        Body::RegisterPush(protocol::RegisterPush {
            platform: "ios".into(),
            token: "a".repeat(64),
        }),
    );
    execute(
        &mut sender,
        Body::RemovePush(protocol::RemovePush {
            platform: "ios".into(),
        }),
    );
    assert_eq!(store.deliveries(), 0);
    assert!(store.receipt("message-1").is_some());
    assert!(store.has_retired("file-1") && store.has_retired("file-2"));
    assert_eq!(objects.count(), 0);
}

#[test]
fn failed_commit_produces_no_success_or_notifications() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    store.fail_commit.set(true);
    let config = config();
    let service = Service {
        host: &host,
        store: &store,
        objects: &objects,
        push_config: &config,
        limits: Limits {
            max_attachment_bytes: 1024,
            max_frame_bytes: 1024,
        },
    };
    let bytes = protocol::encode_chat_frame(&protocol::ChatFrame {
        body: Some(Body::SendMessage(protocol::SendMessage {
            message: Some(message()),
        })),
    });
    let mut session = Session::new(access("sender", "phone"));
    assert!(matches!(
        run(service.execute(&mut session, &bytes)),
        Err(Error::StorageUnavailable)
    ));
    assert_eq!(store.deliveries(), 0);
    assert_eq!(store.jobs(), 0);
}
