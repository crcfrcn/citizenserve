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
            (
                |_| async { Ok(()) },
                |_| async { Ok(b"encrypted".to_vec()) }
            ),
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
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
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
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .expect("上传");
    run(service::complete(&store, &creator, "file", NOW)).expect("完成");
    let recipient = access("recipient", "tablet");
    assert_eq!(
        run(service::download(
            &store,
            &objects,
            &recipient,
            "file",
            0,
            |_| async { Ok(()) },
            NOW
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
        |_| async { Ok(()) },
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
            (
                |_| async { Ok(()) },
                |_| async { Ok(b"encrypted".to_vec()) }
            ),
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
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
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

#[test]
fn confirmed_duplicate_and_wrong_device_never_read_body_or_put_again() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "duplicate");
    run(service::upload(
        &store,
        &objects,
        &creator,
        "duplicate",
        0,
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .unwrap();
    run(service::complete(&store, &creator, "duplicate", NOW)).unwrap();
    run(service::upload(
        &store,
        &objects,
        &creator,
        "duplicate",
        0,
        (
            |_| async { panic!("已成功不应再预扣PUT") },
            |_| async { panic!("已成功不应读正文") },
        ),
        NOW,
    ))
    .unwrap();
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &access("sender", "tablet"),
            "duplicate",
            0,
            (
                |_| async { panic!("异设备不应预扣") },
                |_| async { panic!("异设备不应读正文") }
            ),
            NOW
        )),
        Err(Error::NotFound)
    );
    assert_eq!(objects.puts.get(), 1);
    assert_eq!(objects.recoveries.get(), 0);
}

#[test]
fn failed_budget_or_body_reuses_the_original_unwritten_attempt() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "unwritten");
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &creator,
            "unwritten",
            0,
            (
                |_| async { Err(Error::ResourceLimit) },
                |_| async { panic!("超额不应读正文") }
            ),
            NOW
        )),
        Err(Error::ResourceLimit)
    );
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &creator,
            "unwritten",
            0,
            (
                |_| async { Ok(()) },
                |_| async { Err(Error::InvalidRequest) }
            ),
            NOW
        )),
        Err(Error::InvalidRequest)
    );
    assert_eq!(objects.puts.get(), 0);
    run(service::upload(
        &store,
        &objects,
        &creator,
        "unwritten",
        0,
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .unwrap();
    run(service::complete(&store, &creator, "unwritten", NOW)).unwrap();
    let stored = run(ports::Store::attachment(&store, &creator, "unwritten", NOW)).unwrap();
    let written = run(ports::Store::downloaded_chunk(
        &store, &creator, &stored, 0, NOW,
    ))
    .unwrap();
    assert_eq!(written.upload.attempt_id, "attempt-1");
    assert_eq!(objects.puts.get(), 1);
}

#[test]
fn unknown_write_only_recovers_the_original_key_and_never_reads_retry_body() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "unknown");
    let stored = run(ports::Store::attachment(&store, &creator, "unknown", NOW)).unwrap();
    let ports::Reservation::Write(upload) = run(ports::Store::reserve_upload(
        &store, &creator, &stored, 0, NOW,
    ))
    .unwrap() else {
        panic!("首次必须独占");
    };
    assert_eq!(
        run(service::upload(
            &store,
            &objects,
            &creator,
            "unknown",
            0,
            (
                |cost| async move {
                    assert_eq!(
                        cost,
                        crate::tatachat::auth::ports::ResourceCost::AttachmentRecovery
                    );
                    Ok(())
                },
                |_| async { panic!("未知写入不读重试正文") }
            ),
            NOW
        )),
        Err(Error::Conflict)
    );
    let ports::Reservation::Recover(original) = run(ports::Store::reserve_upload(
        &store, &creator, &stored, 0, NOW,
    ))
    .unwrap() else {
        panic!("未知不得重分配");
    };
    assert_eq!(original, upload);
    assert_eq!(objects.puts.get(), 0);
    run(ports::Objects::put(
        &objects,
        &upload,
        b"encrypted".to_vec(),
        creator.deadline(),
    ))
    .unwrap();
    run(service::upload(
        &store,
        &objects,
        &creator,
        "unknown",
        0,
        (|_| async { Ok(()) }, |_| async { panic!("恢复只查旧键") }),
        NOW,
    ))
    .unwrap();
    assert_eq!(objects.puts.get(), 1);
    assert_eq!(objects.recoveries.get(), 2);
}

#[test]
fn download_quota_is_required_before_object_read() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "download-budget");
    run(service::upload(
        &store,
        &objects,
        &creator,
        "download-budget",
        0,
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .unwrap();
    run(service::complete(&store, &creator, "download-budget", NOW)).unwrap();
    let recipient = access("recipient", "phone");
    assert_eq!(
        run(service::download(
            &store,
            &objects,
            &recipient,
            "download-budget",
            0,
            |_| async { Err(Error::ResourceLimit) },
            NOW
        )),
        Err(Error::ResourceLimit)
    );
    assert_eq!(objects.opens.get(), 0);
    assert_eq!(
        run(service::download(
            &store,
            &objects,
            &recipient,
            "download-budget",
            0,
            |bytes| async move {
                assert_eq!(bytes, 9);
                Ok(())
            },
            NOW
        ))
        .unwrap(),
        b"encrypted"
    );
    assert_eq!(objects.opens.get(), 1);
}

#[test]
fn whole_file_limit_rechecks_downgrade_before_io_and_never_blocks_release() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    let low = |user, device| {
        access(user, device)
            .for_attachments(
                crate::tatachat::auth::AttachmentGrant {
                    max_bytes: 1,
                    deadline_millis: NOW + 60_000,
                },
                NOW,
            )
            .unwrap()
    };
    let body = vec![7; 5000];
    for id in ["downgrade_abort", "downgrade_ack"] {
        let mut raw = attachment_metadata(id);
        raw.cipher_byte_size = body.len() as u64;
        raw.cipher_sha256 = crate::tatachat::tests::digest(&body);
        raw.chunks[0].cipher_byte_size = raw.cipher_byte_size;
        raw.chunks[0].cipher_sha256 = raw.cipher_sha256.clone();
        let metadata =
            Attachment::from_protocol(&raw, creator.actor(), NOW, 10 * 1024 * 1024).unwrap();
        run(service::begin(&store, &creator, &metadata, NOW)).unwrap();
        // 降档后即使每块很小，也不能继续上传或完成整份超限文件。
        assert_eq!(
            run(service::upload(
                &store,
                &objects,
                &low("sender", "phone"),
                id,
                0,
                (
                    |_| async { panic!("整份超限不预扣IO") },
                    |_| async { panic!("整份超限不读正文") }
                ),
                NOW
            )),
            Err(Error::ResourceLimit)
        );
        assert_eq!(
            run(service::complete(&store, &low("sender", "phone"), id, NOW)),
            Err(Error::ResourceLimit)
        );
        assert_eq!(
            objects.puts.get(),
            if id == "downgrade_abort" { 0 } else { 1 }
        );
        run(service::upload(
            &store,
            &objects,
            &creator,
            id,
            0,
            (|_| async { Ok(()) }, |_| async { Ok(body.clone()) }),
            NOW,
        ))
        .unwrap();
        run(service::complete(&store, &creator, id, NOW)).unwrap();
        assert_eq!(
            run(service::upload(
                &store,
                &objects,
                &low("sender", "phone"),
                id,
                0,
                (
                    |_| async { panic!("超限成功块不重复扣IO") },
                    |_| async { panic!("超限成功块不读正文") }
                ),
                NOW
            )),
            Err(Error::ResourceLimit)
        );
        assert_eq!(
            run(service::download(
                &store,
                &objects,
                &low("recipient", "tablet"),
                id,
                0,
                |_| async { panic!("接收者整份超限不预扣IO") },
                NOW
            )),
            Err(Error::ResourceLimit)
        );
        assert_eq!(objects.opens.get(), 0);
        // 额度降低不能阻断释放旧存量；ACK/abort仍按原归属和状态执行。
        if id == "downgrade_abort" {
            run(service::abort(
                &store,
                &objects,
                &low("sender", "phone"),
                id,
                NOW,
            ))
            .unwrap();
        } else {
            run(service::acknowledge(
                &store,
                &objects,
                &low("recipient", "tablet"),
                id,
                NOW,
            ))
            .unwrap();
        }
        assert!(store.has_retired(id));
        assert_eq!(objects.count(), 0);
    }
    assert_eq!(objects.puts.get(), 2);
}

#[test]
fn partial_abort_keeps_stock_until_all_owned_objects_are_deleted() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    begin(&store, &creator, "partial");
    run(service::upload(
        &store,
        &objects,
        &creator,
        "partial",
        0,
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .unwrap();
    let stored = run(ports::Store::attachment(&store, &creator, "partial", NOW)).unwrap();
    objects.keep(
        &format!("attachments/partial/{}/0/old_attempt", stored.generation),
        b"opaque".to_vec(),
    );
    objects.delete_batch.set(Some(1));
    run(service::abort(&store, &objects, &creator, "partial", NOW)).unwrap();
    assert_eq!(store.state("partial"), Some(ports::State::Deleting));
    assert!(!store.has_retired("partial"));
    assert_eq!(objects.count(), 1);
    assert_eq!(
        store.deferred.borrow().get("partial"),
        Some(&(NOW, ports::DeletionRetry::Progress))
    );
    assert_eq!(
        run(service::download(
            &store,
            &objects,
            &creator,
            "partial",
            0,
            |_| async { panic!("deleting不交付") },
            NOW
        )),
        Err(Error::NotFound)
    );
    let result = run(service::cleanup(&store, &objects, NOW + 1000, 8)).unwrap();
    assert!(result.complete && result.progressed);
    assert!(store.has_retired("partial"));
    assert_eq!(objects.count(), 0);
}

#[test]
fn unknown_first_attachment_does_not_block_another_owned_deletion() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    for id in ["a_unknown", "b_known"] {
        begin(&store, &creator, id);
        run(ports::Store::abort(&store, &creator, id, NOW)).unwrap();
    }
    objects
        .unknown_deletes
        .borrow_mut()
        .insert("a_unknown".into());
    let result = run(service::cleanup(&store, &objects, NOW, 8)).unwrap();
    assert!(!result.complete && result.progressed);
    assert_eq!(store.state("a_unknown"), Some(ports::State::Deleting));
    assert!(store.has_retired("b_known"));
    assert_eq!(
        store.deferred.borrow().get("a_unknown"),
        Some(&(NOW, ports::DeletionRetry::Unknown))
    );
}

#[test]
fn group_attachment_is_not_deleted_before_every_recipient_acknowledges() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let objects = FakeObjects::default();
    let creator = access("sender", "phone");
    let mut raw = attachment_metadata("group_ack");
    raw.recipient_user_ids.push("second".into());
    let metadata = Attachment::from_protocol(&raw, creator.actor(), NOW, 1024).unwrap();
    run(service::begin(&store, &creator, &metadata, NOW)).unwrap();
    run(service::upload(
        &store,
        &objects,
        &creator,
        "group_ack",
        0,
        (
            |_| async { Ok(()) },
            |_| async { Ok(b"encrypted".to_vec()) },
        ),
        NOW,
    ))
    .unwrap();
    run(service::complete(&store, &creator, "group_ack", NOW)).unwrap();
    run(service::acknowledge(
        &store,
        &objects,
        &access("recipient", "phone"),
        "group_ack",
        NOW,
    ))
    .unwrap();
    assert_eq!(store.state("group_ack"), Some(ports::State::Ready));
    assert_eq!(objects.count(), 1);
    assert_eq!(objects.delete_count.get(), 0);
    run(service::acknowledge(
        &store,
        &objects,
        &access("second", "tablet"),
        "group_ack",
        NOW,
    ))
    .unwrap();
    assert!(store.has_retired("group_ack"));
    assert_eq!(objects.count(), 0);
    assert_eq!(objects.delete_count.get(), 1);
}
