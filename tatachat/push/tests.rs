use super::*;
use crate::tatachat::{
    mailbox,
    tests::{access, config, message, run, FakeHost, FakeProvider, Memory, NOW},
};

fn prepare(host: &FakeHost, store: &Memory) {
    run(mailbox::service::send(
        store,
        &access("sender", "phone"),
        &message(),
        NOW,
    ))
    .expect("持久任务");
    run(service::register(
        store,
        &access("recipient", "phone"),
        &config(),
        PushPlatform::Ios,
        "a".repeat(64),
        host.time.get(),
    ))
    .expect("登记端点");
}
#[test]
fn wake_payload_and_signing_claims_have_no_chat_content() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    prepare(&host, &store);
    let endpoints = run(ports::Store::endpoints(
        &store,
        &access("recipient", "phone").actor().clone(),
    ))
    .expect("端点");
    for payload in [apns_wake_payload(), fcm_wake_payload(&endpoints[0])] {
        for forbidden in [
            "conversation_id",
            "sender_user_id",
            "message_id",
            "attachment_id",
        ] {
            assert!(!payload.to_string().contains(forbidden));
        }
    }
    let input = fcm_signing_input("service@example.invalid", None, NOW / 1000).expect("签名原文");
    let parts: Vec<_> = std::str::from_utf8(&input.bytes)
        .expect("JWT")
        .split('.')
        .collect();
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("声明字节")).expect("声明");
    assert_eq!(claims["aud"], FCM_TOKEN_URL);
    assert_eq!(claims["exp"], NOW / 1000 + 3600);
    assert!(fcm_url("../escape").is_err());
    assert!(apns_url(&endpoints[0], &["other.app".into()], false).is_err());
    assert!(apns_signing_input("team", "key", 100)
        .expect("APNs原文")
        .finish(&[0; 63])
        .is_err());
}

#[test]
fn unknown_or_revoked_target_is_never_sent_and_lease_loss_never_completes() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let provider = FakeProvider::default();
    prepare(&host, &store);
    host.failure.set(Some(Error::StorageUnavailable));
    run(service::drain(&store, &host, &provider, &config(), 32)).expect("有界重试");
    assert_eq!(provider.sends.get(), 0);
    assert_eq!(store.finishes(), vec![Finish::RetryAt(NOW + 30_000)]);
    let store = Memory::new(&host);
    host.failure.set(None);
    prepare(&host, &store);
    store.lose_lease.set(true);
    assert_eq!(
        run(service::drain(&store, &host, &provider, &config(), 32)),
        Err(Error::Conflict)
    );
    assert_eq!(provider.sends.get(), 0);
    assert!(store.finishes().is_empty());
    let store = Memory::new(&host);
    prepare(&host, &store);
    host.failure.set(Some(Error::Forbidden));
    run(service::drain(&store, &host, &provider, &config(), 32)).expect("拒绝无资格目标");
    assert_eq!(provider.sends.get(), 0);
}

#[test]
fn retry_limit_is_terminal_and_removal_needs_no_provider_credentials() {
    let host = FakeHost::default();
    let store = Memory::new(&host);
    let provider = FakeProvider::default();
    prepare(&host, &store);
    store.set_attempts(5);
    provider.outcome.set(Outcome::Retryable);
    run(service::drain(&store, &host, &provider, &config(), 32)).expect("终态");
    assert_eq!(store.finishes(), vec![Finish::Failed]);
    run(service::remove(
        &store,
        &access("recipient", "phone"),
        PushPlatform::Ios,
        NOW,
    ))
    .expect("无凭据移除");
    assert!(run(ports::Store::endpoints(
        &store,
        access("recipient", "phone").actor()
    ))
    .expect("端点回读")
    .is_empty());
}

#[test]
fn oauth_refresh_boundary_is_shared_and_response_is_bounded() {
    let token = ProviderToken::from_oauth(
        br#"{"access_token":"synthetic","expires_in":61,"token_type":"Bearer"}"#,
        100,
    )
    .expect("合成OAuth响应");
    assert_eq!(token.reusable_value(100), Some("synthetic"));
    assert_eq!(token.reusable_value(101), None);
    assert!(ProviderToken::from_oauth(
        br#"{"access_token":"synthetic","expires_in":60,"token_type":"Bearer"}"#,
        100
    )
    .is_err());
    assert!(ProviderToken::from_oauth(&vec![0; 16 * 1024 + 1], 100).is_err());
}

#[test]
fn lease_lost_after_provider_acceptance_cannot_commit_old_sender_result() {
    struct LosingProvider<'a>(&'a Memory);
    impl ports::Provider for LosingProvider<'_> {
        async fn send(&self, _endpoint: &Endpoint, _payload: &Value, _now: u64) -> Result<Outcome> {
            self.0.lose_lease.set(true);
            Ok(Outcome::Accepted)
        }
    }
    let host = FakeHost::default();
    let store = Memory::new(&host);
    prepare(&host, &store);
    assert_eq!(
        run(service::drain(
            &store,
            &host,
            &LosingProvider(&store),
            &config(),
            32
        )),
        Err(Error::Conflict)
    );
    assert!(store.finishes().is_empty());
}
