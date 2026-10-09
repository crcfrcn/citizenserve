use super::*;
use crate::tatachat::{
    auth::Access,
    tests::{access, attachment_metadata, run, FakeHost, FakeObjects, Memory, NOW},
};

fn begin(store: &Memory, permit: &Access, id: &str) {
    let metadata = Attachment::from_protocol(&attachment_metadata(id), permit.actor(), NOW, 1024)
        .expect("附件元数据");
    run(service::begin(store, permit, &metadata, NOW)).expect("准备附件");
}
#[test]
fn creator_device_controls_upload_complete_and_abort_even_after_ready() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    let other = access("sender", "tablet");
    begin(&store, &creator, "file");
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &other,
            "file",
            0,
            b"encrypted".to_vec(),
            NOW
        )),
        Err(Error::NotFound)
    );
    run(service::upload(
        &store,
        &objects,
        &creator,
        "file",
        0,
        b"encrypted".to_vec(),
        NOW,
    ))
    .expect("上传");
    run(service::complete(&store, &creator, "file", NOW)).expect("完成");
    assert_eq!(
        run(service::complete(&store, &other, "file", NOW)),
        Err(Error::NotFound)
    );
    assert_eq!(
        run(service::abort(&store, &objects, &other, "file", NOW)),
        Err(Error::NotFound)
    );
    assert_eq!(store.state("file"), Some(ports::State::Ready));
}

#[test]
fn downloads_and_ack_use_recipient_users_and_current_device_authorization() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "file");
    run(service::upload(
        &store,
        &objects,
        &creator,
        "file",
        0,
        b"encrypted".to_vec(),
        NOW,
    ))
    .expect("上传");
    run(service::complete(&store, &creator, "file", NOW)).expect("完成");
    let recipient = access("recipient", "tablet");
    assert_eq!(
        run(service::download(
            &store, &objects, &recipient, "file", 0, NOW
        ))
        .expect("授权下载"),
        b"encrypted"
    );
    assert!(run(service::download(
        &store,
        &objects,
        &access("other", "phone"),
        "file",
        0,
        NOW
    ))
    .is_err());
    run(service::acknowledge(
        &store, &objects, &recipient, "file", NOW,
    ))
    .expect("用户ACK");
    run(service::acknowledge(
        &store,
        &objects,
        &access("recipient", "phone"),
        "file",
        NOW,
    ))
    .expect("重复用户ACK");
    assert!(store.has_retired("file"));
    assert_eq!(objects.count(), 0);
}

#[test]
fn failed_chunk_confirmation_only_discards_its_own_attempt() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "file");
    objects.keep(
        "attachments/file/generation-1/0/winner",
        b"encrypted".to_vec(),
    );
    store.fail_confirm.set(true);
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &creator,
            "file",
            0,
            b"encrypted".to_vec(),
            NOW
        )),
        Err(Error::StorageUnavailable)
    );
    assert!(objects.contains("attachments/file/generation-1/0/winner"));
    assert_eq!(objects.discarded.borrow().as_slice(), &["attempt-1"]);
}

#[test]
fn object_or_metadata_delete_failure_retains_retryable_location() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "file");
    run(service::upload(
        &store,
        &objects,
        &creator,
        "file",
        0,
        b"encrypted".to_vec(),
        NOW,
    ))
    .expect("上传");
    objects.fail_delete.set(true);
    assert_eq!(
        run(service::abort(&store, &objects, &creator, "file", NOW)),
        Err(Error::StorageUnavailable)
    );
    assert_eq!(store.state("file"), Some(ports::State::Deleting));
    assert_eq!(objects.count(), 1);
    assert_eq!(
        run(service::abort(
            &store,
            &objects,
            &access("other", "phone"),
            "file",
            NOW
        )),
        Err(Error::NotFound)
    );
    objects.fail_delete.set(false);
    store.fail_finalize.set(true);
    assert_eq!(
        run(service::cleanup(&store, &objects, NOW, 100)),
        Err(Error::StorageUnavailable)
    );
    assert_eq!(objects.count(), 0);
    assert_eq!(store.state("file"), Some(ports::State::Deleting));
    store.fail_finalize.set(false);
    run(service::cleanup(&store, &objects, NOW, 100)).expect("继续清理");
    run(service::abort(&store, &objects, &creator, "file", NOW)).expect("属主重复中止");
    assert!(store.has_retired("file"));
}

#[test]
fn sizes_hashes_and_overhead_are_checked() {
    assert!(mls_attachment_wire_limit(0).is_err());
    assert!(mls_attachment_wire_limit(u64::MAX).is_err());
    let mut metadata = attachment_metadata("file");
    metadata.chunks[0].chunk_index = 1;
    assert!(
        Attachment::from_protocol(&metadata, access("sender", "phone").actor(), NOW, 1024).is_err()
    );
    metadata.chunks[0].chunk_index = 0;
    metadata.cipher_byte_size += 1;
    assert!(
        Attachment::from_protocol(&metadata, access("sender", "phone").actor(), NOW, 1024).is_err()
    );
}
