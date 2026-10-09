//! 服务端仅校验公开成员与投递事务；MLS KeyPackage/消息始终作为不透明字节保存。
use crate::{
    shared::{ids, Error, Result},
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
use std::future::Future;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Create,
    Add,
    Remove,
    Application,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Welcome,
    Commit,
    Application,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub message_type: MessageType,
    pub device_ids: Vec<String>,
    pub mls_message: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Publish {
        key_package: String,
    },
    State {},
    Reserve {
        group_revision: u64,
        operation_kind: Kind,
        target_device_ids: Vec<String>,
    },
    Commit {
        operation_id: String,
        member_device_ids: Vec<String>,
        messages: Vec<Message>,
    },
    Ack {
        operation_id: String,
        message_type: MessageType,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub group_id: String,
    pub creator_device_id: String,
    pub group_revision: u64,
    pub member_device_ids: Vec<String>,
    pub pending_operation_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub operation_id: String,
    pub device_id: String,
    pub group_revision: u64,
    pub operation_kind: Kind,
    pub target_device_ids: Vec<String>,
    pub result_json: Option<String>,
    pub committed_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Package {
    pub device_id: String,
    pub key_package: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    pub operation_id: String,
    pub sequence: u64,
    pub message_type: MessageType,
    pub mls_message: String,
    pub sender_device_id: String,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub eligible: Vec<String>,
    pub group: Option<Group>,
    pub pending: Option<Operation>,
    pub operation: Option<Operation>,
    pub packages: Vec<Package>,
    pub messages: Vec<Delivery>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Reservation {
    pub operation_id: String,
    pub group: Group,
    pub operation_kind: Kind,
    pub target_device_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Commit {
    pub group: Group,
    pub operation: Operation,
    pub member_device_ids: Vec<String>,
    pub messages: Vec<Message>,
    pub result_json: String,
}
pub trait Repository {
    fn snapshot(
        &self,
        auth: &Authorization,
        operation: Option<&str>,
        delivery: bool,
    ) -> impl Future<Output = Result<Snapshot>> + Send;
    fn publish(
        &self,
        auth: &Authorization,
        package: &str,
        group_id: &str,
    ) -> impl Future<Output = Result<()>> + Send;
    fn reserve(
        &self,
        auth: &Authorization,
        r: &Reservation,
    ) -> impl Future<Output = Result<()>> + Send;
    fn commit(&self, auth: &Authorization, c: &Commit) -> impl Future<Output = Result<()>> + Send;
    fn ack(
        &self,
        auth: &Authorization,
        id: &str,
        kind: MessageType,
    ) -> impl Future<Output = Result<()>> + Send;
}
pub fn invalid() -> Error {
    Error::new(400, "invalid_contact_mls_request")
}
pub fn conflict() -> Error {
    Error::new(409, "contact_mls_conflict")
}
pub fn devices(mut values: Vec<String>) -> Result<Vec<String>> {
    if values.len() > 32 || values.iter().any(|v| !ids::hex(v, 32, false)) {
        return Err(invalid());
    }
    values.sort();
    if values.windows(2).any(|v| v[0] == v[1]) {
        return Err(invalid());
    }
    Ok(values)
}
pub fn wire(value: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > max * 2
        || !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(())
}
fn validate_operation_id(id: &str) -> Result<()> {
    if !ids::hex(id, 16, false) {
        return Err(invalid());
    }
    Ok(())
}
fn eligible(s: &Snapshot, auth: &Authorization) -> Result<()> {
    if s.eligible.len() > 32 {
        return Err(Error::new(429, "contact_mls_devices_full"));
    }
    if !s.eligible.iter().any(|d| d == auth.device()) {
        return Err(Error::new(401, "device_not_registered"));
    }
    Ok(())
}
fn reserve_reply(o: &Operation) -> serde_json::Value {
    serde_json::json!({"ok":true,"operation_id":o.operation_id,"operation_kind":o.operation_kind,"target_device_ids":o.target_device_ids,"group_revision":o.group_revision})
}
pub fn expected(
    group: &Group,
    kind: Kind,
    targets: &[String],
    eligible: &[String],
    caller: &str,
) -> Result<Vec<String>> {
    if group.group_revision >= (crate::shared::MAX_SAFE_INTEGER - 1) / 2 {
        return Err(conflict());
    }
    let mut next = devices(group.member_device_ids.clone())?;
    match kind {
        Kind::Create
            if group.group_revision == 0
                && caller == group.creator_device_id
                && next.is_empty()
                && targets.is_empty() =>
        {
            next.push(caller.into())
        }
        Kind::Add
            if next.iter().any(|d| d == caller)
                && !targets.is_empty()
                && targets
                    .iter()
                    .all(|d| eligible.contains(d) && !next.contains(d)) =>
        {
            next.extend_from_slice(targets)
        }
        Kind::Remove
            if next.iter().any(|d| d == caller)
                && !targets.is_empty()
                && targets
                    .iter()
                    .all(|d| next.contains(d) && !eligible.contains(d) && d != caller) =>
        {
            next.retain(|d| !targets.contains(d))
        }
        Kind::Application if next.iter().any(|d| d == caller) && targets.is_empty() => {}
        _ => return Err(conflict()),
    }
    devices(next)
}
pub fn canonical(
    group: &Group,
    o: &Operation,
    caller: &str,
    eligible: &[String],
    members: Vec<String>,
    mut messages: Vec<Message>,
) -> Result<(Vec<String>, Vec<Message>, String)> {
    let members = devices(members)?;
    if expected(
        group,
        o.operation_kind,
        &o.target_device_ids,
        eligible,
        caller,
    )? != members
    {
        return Err(conflict());
    }
    let survivors: Vec<String> = group
        .member_device_ids
        .iter()
        .filter(|d| d.as_str() != caller && members.contains(d))
        .cloned()
        .collect();
    let expected = match o.operation_kind {
        Kind::Create => vec![],
        Kind::Add => vec![
            (MessageType::Commit, survivors),
            (MessageType::Welcome, o.target_device_ids.clone()),
        ],
        Kind::Remove => vec![(MessageType::Commit, survivors)],
        Kind::Application => vec![(MessageType::Application, survivors)],
    };
    if messages.len() != expected.len() {
        return Err(invalid());
    }
    for (msg, (kind, recipients)) in messages.iter_mut().zip(expected) {
        msg.device_ids = devices(msg.device_ids.clone())?;
        if msg.message_type != kind || msg.device_ids != devices(recipients)? {
            return Err(invalid());
        }
        wire(&msg.mls_message, 48 * 1024)?;
    }
    let value = serde_json::json!({"member_device_ids":members,"messages":messages});
    let result = serde_json::to_string(&value).map_err(|_| invalid())?;
    Ok((members, messages, result))
}
pub async fn handle<R: Repository>(
    repo: &R,
    auth: &Authorization,
    request: Request,
    random: [u8; 16],
) -> Result<serde_json::Value> {
    let id = crate::shared::crypto::hex(&random);
    match request {
        Request::Publish { key_package } => {
            wire(&key_package, 16 * 1024)?;
            let s = repo.snapshot(auth, None, false).await?;
            eligible(&s, auth)?;
            repo.publish(auth, &key_package, &id).await?;
            Ok(serde_json::json!({"ok":true}))
        }
        Request::State {} => {
            let s = repo.snapshot(auth, None, true).await?;
            eligible(&s, auth)?;
            let group = s.group.ok_or_else(conflict)?;
            Ok(
                serde_json::json!({"ok":true,"group_id":group.group_id,"group_revision":group.group_revision,"creator_device_id":group.creator_device_id,"member_device_ids":group.member_device_ids,"eligible_device_ids":s.eligible,"key_packages":s.packages,"busy":s.pending.as_ref().is_some_and(|o|o.device_id!=auth.device()),"pending":s.pending.filter(|o|o.device_id==auth.device()).map(|o|serde_json::json!({"operation_id":o.operation_id,"operation_kind":o.operation_kind,"target_device_ids":o.target_device_ids,"group_revision":o.group_revision})),"messages":s.messages}),
            )
        }
        Request::Reserve {
            group_revision,
            operation_kind,
            target_device_ids,
        } => {
            let targets = devices(target_device_ids)?;
            let s = repo.snapshot(auth, None, false).await?;
            eligible(&s, auth)?;
            let g = s.group.ok_or_else(conflict)?;
            if g.group_revision != group_revision {
                return Err(conflict());
            }
            expected(&g, operation_kind, &targets, &s.eligible, auth.device())?;
            if let Some(o) = s.pending {
                if o.device_id != auth.device()
                    || o.operation_kind != operation_kind
                    || o.target_device_ids != targets
                    || o.group_revision != group_revision
                {
                    return Err(conflict());
                }
                return Ok(reserve_reply(&o));
            }
            let r = Reservation {
                operation_id: id.clone(),
                group: g,
                operation_kind,
                target_device_ids: targets.clone(),
            };
            repo.reserve(auth, &r).await?;
            Ok(
                serde_json::json!({"ok":true,"operation_id":id,"operation_kind":operation_kind,"target_device_ids":targets,"group_revision":group_revision}),
            )
        }
        Request::Commit {
            operation_id,
            member_device_ids,
            messages,
        } => {
            validate_operation_id(&operation_id)?;
            let s = repo.snapshot(auth, Some(&operation_id), false).await?;
            eligible(&s, auth)?;
            let o = s.operation.ok_or_else(conflict)?;
            if o.device_id != auth.device() {
                return Err(conflict());
            }
            let g = s.group.ok_or_else(conflict)?;
            // 已提交请求仍核对同一规范结果，避免将不同消息误当作幂等重试。
            let (members, messages, result) = if o.result_json.is_some() {
                let members = devices(member_device_ids)?;
                let mut messages = messages;
                for m in &mut messages {
                    m.device_ids = devices(m.device_ids.clone())?;
                    wire(&m.mls_message, 48 * 1024)?;
                }
                if messages.len() > 2 {
                    return Err(invalid());
                }
                let result = serde_json::to_string(
                    &serde_json::json!({"member_device_ids":members,"messages":messages}),
                )
                .map_err(|_| invalid())?;
                (members, messages, result)
            } else {
                if g.group_revision != o.group_revision
                    || g.pending_operation_id.as_deref() != Some(&operation_id)
                {
                    return Err(conflict());
                }
                canonical(
                    &g,
                    &o,
                    auth.device(),
                    &s.eligible,
                    member_device_ids,
                    messages,
                )?
            };
            if o.result_json
                .as_ref()
                .is_some_and(|stored| stored != &result)
            {
                return Err(conflict());
            }
            let revision = o.group_revision + 1;
            repo.commit(
                auth,
                &Commit {
                    group: g,
                    operation: o,
                    member_device_ids: members,
                    messages,
                    result_json: result,
                },
            )
            .await?;
            Ok(serde_json::json!({"ok":true,"group_revision":revision}))
        }
        Request::Ack {
            operation_id,
            message_type,
        } => {
            validate_operation_id(&operation_id)?;
            repo.ack(auth, &operation_id, message_type).await?;
            Ok(serde_json::json!({"ok":true}))
        }
    }
}
