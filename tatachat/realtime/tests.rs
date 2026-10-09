use super::*;
use crate::tatachat::{
    mailbox::Delivery,
    tests::{access, message, run, FakeHost, NOW},
};

#[test]
fn idle_timer_rechecks_and_unknown_state_closes_permanently() {
    let host = FakeHost::default();
    let mut session = session::Session::new(access("user", "phone"));
    assert_eq!(session.next_check_at(), NOW + 60_000);
    host.time.set(NOW + 60_000);
    host.failure.set(Some(Error::StorageUnavailable));
    assert_eq!(run(session.check(&host)), Err(Error::StorageUnavailable));
    host.failure.set(None);
    assert_eq!(run(session.check(&host)), Err(Error::Forbidden));
    assert!(session.is_closed());
    assert!(run(session::Session::restore(&host, session.snapshot())).is_err());
}

#[test]
fn hibernation_restore_forces_recheck_and_keeps_original_expiry() {
    let host = FakeHost::default();
    let saved = session::Session::new(access("user", "phone")).snapshot();
    host.time.set(NOW + 61_000);
    let restored = run(session::Session::restore(&host, saved.clone())).expect("宿主恢复验真");
    assert_eq!(host.calls.get(), 1);
    assert_eq!(restored.snapshot().access.expires_at_millis, NOW + 900_000);
    *host.revision.borrow_mut() = Some("revision-2".into());
    assert!(run(session::Session::restore(&host, saved.clone())).is_err());
    host.time.set(NOW + 900_000);
    assert!(run(session::Session::restore(&host, saved)).is_err());
}

#[test]
fn internal_events_cannot_be_client_commands_and_resolve_limit_is_session_local() {
    let records =
        Delivery::from_message(&message(), access("sender", "phone").actor(), NOW).expect("密文");
    let event = Event::message_available(&records[0], NOW);
    assert!(Event::from_bytes(event.as_bytes().to_vec(), 1024).is_ok());
    assert!(Event::from_bytes(
        protocol::encode_chat_frame(&protocol::pong_frame(1, NOW)),
        1024
    )
    .is_err());
    let mut first = session::SessionLimits::default();
    let mut second = session::SessionLimits::default();
    for _ in 0..120 {
        first.consume_resolve(NOW).expect("会话预算");
    }
    assert_eq!(first.consume_resolve(NOW), Err(Error::ResourceLimit));
    assert!(second.consume_resolve(NOW).is_ok());
    assert!(first.consume_resolve(NOW + 60_000).is_ok());
}
