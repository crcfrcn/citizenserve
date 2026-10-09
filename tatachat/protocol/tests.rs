use super::*;
use crate::tatachat::{
    realtime::session::SessionLimits,
    tests::{actor, package, NOW},
    Error,
};

#[test]
fn sdk_wire_tags_round_trip_and_wrong_direction_is_rejected() {
    let ping = ChatFrame {
        body: Some(chat_frame::Body::Ping(Ping { sent_at_millis: 1 })),
    };
    assert_eq!(encode_chat_frame(&ping), vec![0x22, 2, 8, 1]);
    assert_eq!(
        decode_chat_frame(&encode_chat_frame(&ping), 1024).expect("协议回读"),
        ping
    );
    let mut limits = SessionLimits::default();
    assert!(command::parse_control_command(
        ready_frame(NOW),
        &actor("user", "phone"),
        NOW,
        1024,
        &mut limits
    )
    .is_err());
    assert_eq!(
        decode_chat_frame(&[0x22, 2], 1024),
        Err(Error::InvalidRequest)
    );
    assert_eq!(decode_chat_frame(&[1, 2], 1), Err(Error::ResourceLimit));
}

#[test]
fn missing_payload_and_forged_package_identity_fail_before_storage() {
    let mut limits = SessionLimits::default();
    for body in [
        chat_frame::Body::SendMessage(SendMessage { message: None }),
        chat_frame::Body::BeginAttachment(BeginAttachment { attachment: None }),
        chat_frame::Body::PublishKeyPackage(PublishKeyPackage { key_package: None }),
        chat_frame::Body::PublishKeyPackage(PublishKeyPackage {
            key_package: Some(package()),
        }),
    ] {
        assert!(command::parse_control_command(
            ChatFrame { body: Some(body) },
            &actor("other", "phone"),
            NOW,
            1024,
            &mut limits
        )
        .is_err());
    }
}
