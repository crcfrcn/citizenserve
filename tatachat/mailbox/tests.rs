use super::*;
use crate::tatachat::{
    protocol,
    tests::{access, message, run, FakeHost, Memory, NOW},
};

#[test]
fn duplicate_after_ack_does_not_recreate_delivery_or_outbox() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let sender = access("sender", "phone");
    run(service::send(&store, &sender, &message(), NOW)).expect("首发");
    let receipt = store.receipt("message-1").expect("凭据");
    run(service::acknowledge(
        &store,
        &access("recipient", "phone"),
        &["message-1".into()],
        NOW,
    ))
    .expect("ACK");
    assert_eq!(
        run(service::send(&store, &sender, &message(), NOW + 1))
            .expect("幂等重发")
            .commit,
        ports::Commit::Duplicate
    );
    assert_eq!(store.deliveries(), 0);
    assert_eq!(store.jobs(), 0);
    assert_eq!(store.receipt("message-1"), Some(receipt));
}

#[test]
fn changed_complete_recipient_set_conflicts_without_partial_insert() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let sender = access("sender", "phone");
    run(service::send(&store, &sender, &message(), NOW)).expect("首发");
    let mut changed = message();
    changed.deliveries[0].openmls_ciphertext = vec![9];
    changed.deliveries.push(protocol::EncryptedDelivery {
        recipient: Some(protocol::Recipient {
            user_id: "other".into(),
            device_id: "other".into(),
        }),
        openmls_ciphertext: vec![2],
    });
    assert!(matches!(
        run(service::send(&store, &sender, &changed, NOW)),
        Err(Error::Conflict)
    ));
    assert_eq!(store.deliveries(), 1);
    assert_eq!(store.jobs(), 1);
}

#[test]
fn device_isolation_preserves_exact_ciphertext_and_receipt_order_is_irrelevant() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let mut value = message();
    value.deliveries.push(protocol::EncryptedDelivery {
        recipient: Some(protocol::Recipient {
            user_id: "recipient".into(),
            device_id: "tablet".into(),
        }),
        openmls_ciphertext: vec![8, 7],
    });
    let first = Delivery::from_message(&value, &access("sender", "phone").actor().clone(), NOW)
        .expect("密文");
    let mut reversed = first.clone();
    reversed.reverse();
    assert_eq!(
        Receipt::from_deliveries(&first),
        Receipt::from_deliveries(&reversed)
    );
    run(service::send(
        &store,
        &access("sender", "phone"),
        &value,
        NOW,
    ))
    .expect("发送");
    let records = run(service::sync(
        &store,
        &access("recipient", "phone"),
        NOW,
        100,
        4096,
    ))
    .expect("设备同步");
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].to_protocol().expect("密文保真").deliveries[0].openmls_ciphertext,
        vec![0, 255, 42]
    );
    run(service::acknowledge(
        &store,
        &access("recipient", "phone"),
        &["message-1".into()],
        NOW,
    ))
    .expect("设备ACK");
    assert_eq!(store.deliveries(), 1);
}

#[test]
fn retention_and_duplicate_devices_are_bounded() {
    assert!(server_expiry(NOW + MAX_FUTURE_SKEW_MILLIS + 1, NOW).is_err());
    assert!(server_expiry(1, MESSAGE_RETENTION_MILLIS + 1).is_err());
    let mut value = message();
    value.deliveries.push(value.deliveries[0].clone());
    assert!(Delivery::from_message(&value, access("sender", "phone").actor(), NOW).is_err());
}

#[test]
fn sync_pages_by_wire_bytes_without_acknowledging_the_remainder() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let sender = access("sender", "phone");
    let mut first = message();
    first.deliveries[0].openmls_ciphertext = vec![42; 512];
    let mut second = first.clone();
    second.message_id = "message-2".into();
    run(service::send(&store, &sender, &first, NOW)).expect("首条");
    run(service::send(&store, &sender, &second, NOW)).expect("第二条");
    let records = run(service::sync(
        &store,
        &access("recipient", "phone"),
        NOW,
        100,
        1024,
    ))
    .expect("字节分页");
    assert_eq!(records.len(), 1);
    assert_eq!(store.deliveries(), 2);
    assert!(protocol::encoded_len(&protocol::message_batch_frame(&records).expect("帧")) <= 1024);
}
