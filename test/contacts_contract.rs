use citizenserve::user::contacts::{self, Group, Kind, Message, MessageType, Operation, Request};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("contract/contact_mls.json")).unwrap()
}
fn caller() -> String {
    fixture()["caller"].as_str().unwrap().into()
}
fn other() -> String {
    fixture()["other"].as_str().unwrap().into()
}
fn group() -> Group {
    Group {
        group_id: "12".repeat(16),
        creator_device_id: caller(),
        group_revision: 1,
        member_device_ids: vec![caller()],
        pending_operation_id: Some("34".repeat(16)),
    }
}
fn op(kind: Kind, targets: Vec<String>) -> Operation {
    Operation {
        operation_id: "34".repeat(16),
        device_id: caller(),
        group_revision: 1,
        operation_kind: kind,
        target_device_ids: targets,
        result_json: None,
        committed_at: None,
    }
}
#[test]
fn add_requires_commit_to_old_members_and_welcome_to_only_new_members() {
    let g = group();
    let o = op(Kind::Add, vec![other()]);
    let eligible = vec![caller(), other()];
    let messages = vec![
        Message {
            message_type: MessageType::Commit,
            device_ids: vec![],
            mls_message: "0102".into(),
        },
        Message {
            message_type: MessageType::Welcome,
            device_ids: vec![other()],
            mls_message: "0304".into(),
        },
    ];
    let (members, _, canonical) = contacts::canonical(
        &g,
        &o,
        &caller(),
        &eligible,
        vec![other(), caller()],
        messages.clone(),
    )
    .unwrap();
    assert_eq!(members, vec![caller(), other()]);
    assert_eq!(
        canonical,
        serde_json::to_string(&json!({"member_device_ids":members,"messages":messages})).unwrap()
    );
    let mut bad = messages;
    bad[1].device_ids = vec![caller()];
    assert!(contacts::canonical(&g, &o, &caller(), &eligible, members, bad).is_err());
}
#[test]
fn create_only_designated_creator_at_zero_revision() {
    let mut g = group();
    g.group_revision = 0;
    g.member_device_ids.clear();
    assert_eq!(
        contacts::expected(&g, Kind::Create, &[], &[caller()], &caller()).unwrap(),
        vec![caller()]
    );
    assert!(contacts::expected(&g, Kind::Create, &[], &[caller(), other()], &other()).is_err());
    g.group_revision = 1;
    assert!(contacts::expected(&g, Kind::Create, &[], &[caller()], &caller()).is_err());
}
#[test]
fn remove_requires_inactive_target_and_clears_it_from_next_members() {
    let mut g = group();
    g.member_device_ids.push(other());
    assert!(contacts::expected(
        &g,
        Kind::Remove,
        &[other()],
        &[caller(), other()],
        &caller()
    )
    .is_err());
    assert_eq!(
        contacts::expected(&g, Kind::Remove, &[other()], &[caller()], &caller()).unwrap(),
        vec![caller()]
    );
    assert!(contacts::expected(&g, Kind::Remove, &[caller()], &[], &caller()).is_err());
}
#[test]
fn application_preserves_members_and_targets_every_other_member() {
    let mut g = group();
    g.member_device_ids.push(other());
    let o = op(Kind::Application, vec![]);
    let msg = Message {
        message_type: MessageType::Application,
        device_ids: vec![other()],
        mls_message: "01".into(),
    };
    assert!(contacts::canonical(
        &g,
        &o,
        &caller(),
        &[caller(), other()],
        g.member_device_ids.clone(),
        vec![msg]
    )
    .is_ok());
    assert!(contacts::canonical(
        &g,
        &o,
        &caller(),
        &[caller(), other()],
        g.member_device_ids.clone(),
        vec![]
    )
    .is_err());
}
#[test]
fn wire_limits_and_device_lists_reject_invalid_opaque_input() {
    assert!(contacts::wire(&"ab".repeat(16384), 16384).is_ok());
    for s in ["", "abc", "AB", "zz"] {
        assert!(contacts::wire(s, 16384).is_err());
    }
    assert!(contacts::wire(&"ab".repeat(16385), 16384).is_err());
    assert!(contacts::wire(&"ab".repeat(49153), 49152).is_err());
    assert!(contacts::devices(vec![caller(), caller()]).is_err());
    assert!(contacts::devices((0..33).map(|n| format!("{n:064x}")).collect()).is_err());
}
#[test]
fn request_rejects_private_material_forged_sender_unknown_and_duplicate_fields() {
    for v in [
        json!({"action":"publish","key_package":"01","private_key":"secret"}),
        json!({"action":"state","device_id":other()}),
        json!({"action":"ack","operation_id":"34".repeat(16),"message_type":"application","device_id":other()}),
    ] {
        assert!(serde_json::from_value::<Request>(v).is_err());
    }
    assert!(serde_json::from_str::<Request>(
        r#"{"action":"publish","key_package":"01","key_package":"02"}"#
    )
    .is_err());
}
#[test]
fn revision_overflow_and_ineligible_add_fail_closed() {
    let mut g = group();
    assert!(contacts::expected(&g, Kind::Add, &[other()], &[caller()], &caller()).is_err());
    g.group_revision = citizenserve::shared::MAX_SAFE_INTEGER;
    assert!(contacts::expected(&g, Kind::Application, &[], &[caller()], &caller()).is_err());
}
