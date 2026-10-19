//! 使用既有公开合成runtime跑真实canonical/SCALE解析和Ed25519验签；不代表线上链验收。
use citizenserve::{
    chain::{identity, ports::Rpc, subscription},
    membership::{chat::Permissions, Status},
    server::{gate, gate::request, tatachat as chat, tatachat_routes},
    shared::{crypto, Error, Result},
    user::{
        admission::Admission,
        auth::{device::Device, session::Session},
        chat_access::Subject,
        identity::Identity,
        registration::protocol::{Config, Institution},
    },
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
const NOW: u64 = 4_000_000_000;
const CID: &str = "CN220-CTZN2-198805201-2026";

#[test]
fn gate_classifies_client_frames_before_any_host_identity_io() {
    use citizenserve::{
        server::gate,
        tatachat::protocol::{self, chat_frame, ChatFrame, Ping},
    };
    let ping = protocol::encode_chat_frame(&ChatFrame {
        body: Some(chat_frame::Body::Ping(Ping { sent_at_millis: 1 })),
    });
    assert!(matches!(
        gate::classify_chat(&ping, 4096).unwrap().body,
        Some(chat_frame::Body::Ping(Ping { sent_at_millis: 1 }))
    ));
    // 原12类客户消息均交付原解码体；不把服务端响应或未知类型纳入允许集合。
    use chat_frame::Body;
    for body in [
        Body::PublishKeyPackage(Default::default()),
        Body::ResolveKeyPackages(Default::default()),
        Body::SendMessage(Default::default()),
        Body::SyncMessages(Default::default()),
        Body::AcknowledgeMessages(Default::default()),
        Body::BeginAttachment(Default::default()),
        Body::CompleteAttachment(Default::default()),
        Body::AcknowledgeAttachment(Default::default()),
        Body::AbortAttachment(Default::default()),
        Body::RegisterPush(Default::default()),
        Body::RemovePush(Default::default()),
    ] {
        let frame = ChatFrame { body: Some(body) };
        assert_eq!(
            gate::classify_chat(&protocol::encode_chat_frame(&frame), 4096).unwrap(),
            frame
        );
    }
    let response = protocol::encode_chat_frame(&protocol::pong_frame(1, 2));
    assert!(gate::classify_chat(&response, 4096).is_err());
    assert!(gate::classify_chat(&[], 4096).is_err());
    assert!(gate::classify_chat(&vec![0; 4097], 4096).is_err());
}
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("fixture RPC is synchronous"),
    }
}
struct Runtime {
    data: Value,
    now: u64,
    level: u8,
    status: u8,
    paid_until: u64,
}
impl Runtime {
    fn new(now: u64) -> Self {
        Self {
            data: serde_json::from_str(include_str!("contract/maintenance.json")).unwrap(),
            now,
            level: 0,
            status: 0,
            paid_until: now + 3_600_000,
        }
    }
    fn config(&self) -> Config {
        Config {
            registration_scope: "citizenserve:fixture".into(),
            service_origin: "https://registration.example.test".into(),
            chain_scope: self.data["genesis"].as_str().unwrap().into(),
            site_key: "public-test-key".into(),
        }
    }
    fn facts(&self) -> (Identity, subscription::Current) {
        let c = self.config();
        let member = run(subscription::platform(
            self,
            &c.chain_scope,
            CID,
            self.data["account"].as_str().unwrap(),
            self.now,
        ))
        .unwrap();
        let m = run(identity::metadata(self, &member.anchor)).unwrap();
        let i = run(identity::by_cid(
            self,
            &m,
            &member.anchor,
            CID,
            &c.chain_scope,
            self.now,
        ))
        .unwrap();
        (i.unwrap(), member)
    }
}
impl Rpc for Runtime {
    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        Ok(match method {
            "chain_getFinalizedHead" => self.data["head"].clone(),
            "chain_getBlockHash" => {
                if params[0] == 0 {
                    self.data["genesis"].clone()
                } else {
                    self.data["head"].clone()
                }
            }
            "chain_getHeader" => {
                json!({"number":"0x9","parentHash":format!("0x{}","08".repeat(32)),
                "stateRoot":format!("0x{}","01".repeat(32)),"extrinsicsRoot":format!("0x{}","02".repeat(32)),"digest":{"logs":[]}})
            }
            "state_getMetadata" => self.data["metadata"].clone(),
            "state_getStorage" => {
                let key = params[0].as_str().unwrap();
                assert_eq!(
                    params[1], self.data["head"],
                    "all storage uses the frozen anchor"
                );
                let raw = &self.data["storage"][key];
                if params[0] == self.data["timestamp_key"] {
                    json!(format!("0x{}", crypto::hex(&self.now.to_le_bytes())))
                } else if raw.as_str().is_some_and(|v| v.len() == 122) {
                    // 原合成runtime Subscription的SCALE布局：2字节plan，paid_until在34，status在42。
                    let mut bytes = crypto::unhex(raw.as_str().unwrap()).unwrap();
                    bytes[1] = self.level;
                    bytes[34..42].copy_from_slice(&self.paid_until.to_le_bytes());
                    bytes[42] = self.status;
                    json!(format!("0x{}", crypto::hex(&bytes)))
                } else {
                    raw.clone()
                }
            }
            _ => return Err(Error::new(503, "unexpected_test_rpc")),
        })
    }
}
struct Fixture {
    runtime: Runtime,
    identity: Identity,
    member: subscription::Current,
    identity_health: u64,
    membership_health: Option<u64>,
    device: Device,
    session: Session,
    admission: Admission,
}
impl Fixture {
    fn new(now: u64) -> Self {
        let runtime = Runtime::new(now);
        let (i, m) = runtime.facts();
        let config = runtime.config();
        Self {
            runtime,
            device: Device {
                cid_number: i.cid_number.clone(),
                device_id: "ab".repeat(32),
                account_id: i.account_id.clone(),
                public_key: format!("0x{}", "ab".repeat(32)),
                binding_revision: i.binding_revision,
                issued_at: now - 1000,
                created_at: now - 1000,
                updated_at: now - 1000,
                active: true,
            },
            session: Session {
                session_token_hash: "12".repeat(32),
                cid_number: i.cid_number.clone(),
                account_id: i.account_id.clone(),
                binding_revision: i.binding_revision,
                device_id: "ab".repeat(32),
                created_at: now - 1000,
                expires_at: now + 86_400_000,
            },
            admission: Admission {
                cid_number: i.cid_number.clone(),
                enrollment_id: "11111111-1111-4111-8111-000000000001".into(),
                source: "turnstile".into(),
                human_verified_at_millis: now - 2000,
                registration_scope: config.registration_scope,
                service_origin: config.service_origin,
                chain_scope: config.chain_scope,
                institution: Institution::CTZN,
            },
            identity: i,
            member: m,
            identity_health: now,
            membership_health: Some(now),
        }
    }
    fn record(&self) -> Option<citizenserve::membership::Record> {
        self.member.state.as_ref().map(|state| {
            let mut v = state.wire().unwrap();
            v["cid_number"] = json!(self.identity.cid_number);
            v["finalized_block_number"] = json!(self.member.anchor.number);
            v["finalized_block_hash"] = json!(self.member.anchor.hash);
            serde_json::from_value(v).unwrap()
        })
    }
    fn context(&self, now: u64) -> citizenserve::user::ports::AuthContext {
        citizenserve::user::ports::AuthContext {
            loaded_at: now,
            identity: self.identity.clone(),
            device: Some(self.device.clone()),
            admission: Some(self.admission.clone()),
            session: Some(self.session.clone()),
            membership: self.record(),
            identity_synced_at: self.identity_health,
            membership_synced_at: self.membership_health,
        }
    }
    fn subject(&self, now: u64) -> Result<Subject> {
        Subject::verified(
            &self.authority(now)?,
            &self.device,
            &self.session,
            &self.runtime.config(),
            now,
        )
    }
    fn authority(&self, now: u64) -> Result<gate::identity::Authority> {
        gate::identity::service_authority(&self.context(now), &self.runtime.config(), now)
    }
    fn authorization(&self, now: u64) -> Result<chat::Authorization> {
        chat::authorize(&self.subject(now)?, now)
    }
    fn attachment_permissions(&self, now: u64) -> Result<Permissions> {
        let authority = self.authority(now)?;
        let permit = citizenserve::membership::gate::authorize(
            &authority,
            citizenserve::membership::policy::Operation::Attachment,
            self.record().as_ref(),
            now,
        )?;
        Permissions::from_permit(&permit, &self.identity, now)
    }

    fn refresh(&mut self, now: u64) {
        self.runtime.now = now;
        let (i, m) = self.runtime.facts();
        self.identity = i;
        self.member = m;
        self.identity_health = now;
        self.membership_health = Some(now);
    }
}
fn signed(unsigned: &str) -> String {
    let key = SigningKey::from_bytes(&[39; 32]);
    format!(
        "{}.{}",
        unsigned,
        crypto::base64url(&key.sign(unsigned.as_bytes()).to_bytes())
    )
}
fn token(a: &chat::Authorization, now: u64) -> String {
    signed(&chat::unsigned(a, "local-test-1", now).unwrap())
}
fn verify(raw: &str, now: u64) -> Result<citizenserve::tatachat::auth::VerifiedCredential> {
    chat::verify_token(
        raw,
        &SigningKey::from_bytes(&[39; 32]).verifying_key().to_bytes(),
        "local-test-1",
        &Runtime::new(now).config(),
        now,
    )
}
fn rewrite(raw: &str, header: bool, f: impl FnOnce(&mut Value)) -> String {
    let mut p: Vec<String> = raw.split('.').map(String::from).collect();
    let index = usize::from(!header);
    let mut v: Value =
        serde_json::from_slice(&crypto::unbase64url(&p[index], 12288).unwrap()).unwrap();
    f(&mut v);
    p[index] = crypto::base64url(&serde_json::to_vec(&v).unwrap());
    signed(&format!("{}.{}", p[0], p[1]))
}
#[test]
fn frozen_public_contract_and_limits_match_real_permits() {
    let v: Value = serde_json::from_str(include_str!("contract/tatachat.json")).unwrap();
    assert_eq!(v["audience"], chat::AUDIENCE);
    assert_eq!(v["purpose"], chat::PURPOSE);
    assert_eq!(
        v["maximum_permission_millis"],
        citizenserve::tatachat::auth::MAX_ACCESS_MILLIS
    );
    assert_eq!(
        v["maximum_recheck_millis"],
        citizenserve::tatachat::auth::MAX_RECHECK_MILLIS
    );
    for level in 0..3 {
        let mut f = Fixture::new(NOW);
        f.runtime.level = level;
        f.refresh(NOW);
        let a = f.authorization(NOW).unwrap();
        assert_eq!(
            f.attachment_permissions(NOW)
                .unwrap()
                .max_attachment_bytes(),
            v["attachment_limits"][level as usize].as_u64().unwrap()
        );
        assert!(a.chat_enabled());
    }
}
#[test]
fn paid_states_restrict_attachments_while_all_registered_citizens_keep_basic_chat() {
    let mut f = Fixture::new(NOW);
    for status in [Status::Active, Status::Cancelled] {
        f.member.state.as_mut().unwrap().status = status;
        assert!(f.authorization(NOW).is_ok());
    }
    for status in [Status::Terminated, Status::Suspended, Status::IssuerPaused] {
        f.member.state.as_mut().unwrap().status = status;
        assert!(f.attachment_permissions(NOW).is_err());
        assert!(f.authorization(NOW).is_ok());
    }
    f.member.state = None;
    assert!(f.attachment_permissions(NOW).is_err());
    assert!(f.authorization(NOW).is_ok());
}
#[test]
fn no_human_admission_no_device_no_current_binding_no_access() {
    let mut f = Fixture::new(NOW);
    f.admission.source = "import".into();
    assert!(f.authorization(NOW).is_err());
    f.admission.source = "turnstile".into();
    f.device.active = false;
    assert!(f.authorization(NOW).is_err());
    f.device.active = true;
    f.identity.binding_revision += 1;
    assert!(f.authorization(NOW).is_err());
}
#[test]
fn independent_service_health_does_not_forge_chain_freshness() {
    let mut f = Fixture::new(NOW);
    let original = f.identity.clone();
    f.member.anchor.hash = format!("0x{}", "07".repeat(32));
    assert!(f.attachment_permissions(NOW).is_ok());
    assert!(f.authorization(NOW + 60_000).is_ok());
    f.membership_health = None;
    assert!(f.authorization(NOW + 60_000).is_ok());
    assert_eq!(
        f.attachment_permissions(NOW + 60_000).unwrap_err().code,
        "membership_verification_unavailable"
    );
    f.identity_health = NOW - 600_000;
    assert!(f.authorization(NOW).is_err());
    assert_eq!(
        serde_json::to_value(&f.identity).unwrap(),
        serde_json::to_value(original).unwrap()
    );
}
#[test]
fn current_fact_deadlines_and_clock_rollback_fail_closed() {
    let f = Fixture::new(NOW);
    assert!(f.authorization(NOW - 1).is_err());
    assert!(f.authorization(NOW + 600_000).is_err());
    let a = f.authorization(NOW).unwrap();
    assert!(a.require_current(NOW + 59_999).is_ok());
    assert!(a.require_current(NOW + 60_000).is_err());
    assert!(a.require_unexpired(NOW + 899_999).is_ok());
    assert!(a.require_unexpired(NOW + 900_000).is_err());
}
#[test]
fn attachment_deadline_is_clipped_by_member_and_session_but_basic_chat_is_not_member_clipped() {
    let mut f = Fixture::new(NOW);
    f.session.expires_at = NOW + 10_000;
    assert_eq!(f.authorization(NOW).unwrap().expires_at(), NOW + 10_000);
    f.member.state.as_mut().unwrap().paid_until = NOW + 5_000;
    let a = f.attachment_permissions(NOW).unwrap();
    assert_eq!(a.deadline(), NOW + 5_000);
    assert_eq!(a.deadline(), a.deadline());
    f.member.state.as_mut().unwrap().paid_until = NOW;
    assert!(f.attachment_permissions(NOW).is_err());
    assert_eq!(f.authorization(NOW).unwrap().expires_at(), NOW + 10_000);
}
#[test]
fn jwt_second_precision_never_returns_an_already_expired_credential() {
    let mut f = Fixture::new(NOW + 123);
    f.session.expires_at = NOW + 999;
    let a = f.authorization(NOW + 123).unwrap();
    assert!(chat::unsigned(&a, "local-test-1", NOW + 123).is_err());
    f.session.expires_at = NOW + 1001;
    let a = f.authorization(NOW + 123).unwrap();
    let v = verify(&token(&a, NOW + 123), NOW + 123).unwrap();
    assert_eq!(
        chat::from_token(&v, a, NOW + 123).unwrap().expires_at(),
        NOW + 1000
    );
}
#[test]
fn malformed_subject_times_and_digests_are_rejected() {
    for case in 0..4 {
        let mut f = Fixture::new(NOW);
        match case {
            0 => f.device.issued_at = 0,
            1 => f.device.issued_at = NOW + 300_001,
            2 => f.session.session_token_hash = "invalid".into(),
            _ => f.session.expires_at = u64::MAX,
        };
        assert!(f.subject(NOW).is_err());
    }
}
#[test]
fn current_refresh_does_not_extend_original_fifteen_minutes() {
    let mut f = Fixture::new(NOW);
    let old = f.authorization(NOW).unwrap();
    f.refresh(NOW + 60_000);
    let next = chat::recheck(&old, &f.subject(NOW + 60_000).unwrap(), NOW + 60_000).unwrap();
    assert_eq!(old.revision(), next.revision());
    assert_eq!(old.expires_at(), next.expires_at());
    assert_eq!(next.recheck_at(), NOW + 120_000);
    f.refresh(NOW + 900_000);
    assert!(chat::recheck(&next, &f.subject(NOW + 900_000).unwrap(), NOW + 900_000).is_err());
}
#[test]
fn renewal_is_stable_but_device_generation_session_and_privilege_changes_revoke() {
    let mut f = Fixture::new(NOW);
    let old = f.authorization(NOW).unwrap();
    f.member.state.as_mut().unwrap().paid_until += 10_000;
    assert_eq!(old.revision(), f.authorization(NOW).unwrap().revision());
    f.device.issued_at += 1;
    assert_ne!(old.revision(), f.authorization(NOW).unwrap().revision());
    f.device.issued_at -= 1;
    f.session.session_token_hash = "13".repeat(32);
    assert_ne!(old.revision(), f.authorization(NOW).unwrap().revision());
    f.session.session_token_hash = "12".repeat(32);
    let old_attachment = f
        .attachment_permissions(NOW)
        .unwrap()
        .max_attachment_bytes();
    f.member.state.as_mut().unwrap().plan =
        subscription::Plan::Platform(citizenserve::membership::Level::Spark);
    assert_ne!(
        old_attachment,
        f.attachment_permissions(NOW)
            .unwrap()
            .max_attachment_bytes()
    );
    assert_eq!(old.revision(), f.authorization(NOW).unwrap().revision());
}
#[test]
fn valid_ed25519_token_is_bound_to_actual_origin_user_and_permission() {
    let f = Fixture::new(NOW);
    let a = f.authorization(NOW).unwrap();
    let verified = verify(&token(&a, NOW), NOW).unwrap();
    let c = verified.claims();
    assert_eq!(c.sub, CID);
    assert_eq!(c.iss, f.runtime.config().service_origin);
    assert_eq!(c.device_id, f.device.device_id);
    assert_eq!(c.exp - c.iat, 900);
    assert_eq!(
        chat::from_token(&verified, a, NOW).unwrap().recheck_at(),
        NOW + 60_000
    );
}
#[test]
fn signed_header_and_context_changes_do_not_gain_authority() {
    let raw = token(&Fixture::new(NOW).authorization(NOW).unwrap(), NOW);
    for (field, value) in [
        ("alg", json!("none")),
        ("typ", json!("JWS")),
        ("kid", json!("wrong")),
        ("other", json!(true)),
    ] {
        assert!(verify(&rewrite(&raw, true, |v| v[field] = value), NOW).is_err());
    }
    for (field, value) in [
        ("iss", json!("https://other.example.test")),
        ("aud", json!("other")),
        ("purpose", json!("request")),
        ("version", json!(3)),
        ("chat_enabled", json!(false)),
        ("max_attachment_bytes", json!(0)),
        ("sub", json!("invalid/cid")),
        ("session_hash", json!("x")),
        ("extra", json!(true)),
    ] {
        assert!(
            verify(&rewrite(&raw, false, |v| v[field] = value), NOW).is_err(),
            "{field}"
        );
    }
}
#[test]
fn signed_time_fields_cannot_extend_credential_or_skip_consistency() {
    let raw = token(&Fixture::new(NOW).authorization(NOW).unwrap(), NOW);
    for (field, value) in [
        ("iat", NOW / 1000 + 1),
        ("nbf", NOW / 1000 + 1),
        ("exp", NOW / 1000 + 901),
        ("expires_at_millis", NOW + 900_001),
        ("recheck_at_millis", NOW + 60_001),
        ("issued_at_millis", NOW + 1),
    ] {
        assert!(
            verify(&rewrite(&raw, false, |v| v[field] = json!(value)), NOW).is_err(),
            "{field}"
        );
    }
    assert!(verify(&raw, NOW + 900_000).is_err());
    assert!(verify(&raw, NOW - 1).is_err());
}
#[test]
fn signature_key_truncation_and_duplicate_claims_fail() {
    let raw = token(&Fixture::new(NOW).authorization(NOW).unwrap(), NOW);
    let mut p: Vec<_> = raw.split('.').map(String::from).collect();
    let original = p[1].clone();
    let body = String::from_utf8(crypto::unbase64url(&original, 12288).unwrap()).unwrap();
    p[1] = crypto::base64url(format!("{},\"version\":1}}", &body[..body.len() - 1]).as_bytes());
    assert!(verify(&signed(&format!("{}.{}", p[0], p[1])), NOW).is_err());
    p[1] = original;
    p[2] = crypto::base64url(&[0; 64]);
    assert!(verify(&p.join("."), NOW).is_err());
    assert!(verify(&raw[..raw.len() - 3], NOW).is_err());
    assert!(chat::verify_token(
        &raw,
        &SigningKey::from_bytes(&[38; 32]).verifying_key().to_bytes(),
        "local-test-1",
        &Runtime::new(NOW).config(),
        NOW
    )
    .is_err());
}
#[test]
fn stale_token_requires_fresh_facts_and_new_device_cannot_reuse_it() {
    let mut f = Fixture::new(NOW);
    let old = f.authorization(NOW).unwrap();
    let raw = token(&old, NOW);
    let verified = verify(&raw, NOW + 60_000).unwrap();
    assert!(chat::from_token(&verified, old, NOW + 60_000).is_err());
    f.refresh(NOW + 60_000);
    let fresh = chat::from_token(
        &verified,
        f.authorization(NOW + 60_000).unwrap(),
        NOW + 60_000,
    )
    .unwrap();
    assert_eq!(fresh.expires_at(), NOW + 900_000);
    f.device.issued_at += 1;
    assert!(chat::from_token(
        &verified,
        f.authorization(NOW + 60_000).unwrap(),
        NOW + 60_000
    )
    .is_err());
}
#[test]
fn access_request_is_exact_object_and_route_rejects_aliases_queries() {
    for raw in [b"{}".as_slice(), b" { } \n"] {
        assert!(tatachat_routes::access_body(raw).is_ok());
    }
    for raw in [
        b"[]".as_slice(),
        b"null",
        b"",
        b"{\"cid\":\"fake\"}",
        b"{}{}",
        b"{\"device_id\":1,\"device_id\":2}",
    ] {
        assert!(tatachat_routes::access_body(raw).is_err());
    }
    assert!(tatachat_routes::access_body(&vec![b' '; 1025]).is_err());
    assert!(request::protected_target("POST", "/api/tatachat/access").is_ok());
    for (method, path) in [
        ("GET", "/api/tatachat/access"),
        ("POST", "/api/tatachat/access?x=1"),
        ("POST", "/chat/auth"),
        ("POST", "/api/chat/auth"),
    ] {
        assert!(request::protected_target(method, path).is_err());
    }
}

#[test]
fn unified_member_policy_uses_exact_levels_self_targets_and_scoped_metrics() {
    use citizenserve::{
        membership::{gate as member, policy::Operation, Level},
        square::routes::{FeedKind, SquareRoute},
    };
    let mut f = Fixture::new(NOW);
    let authority = f.authority(NOW).unwrap();
    assert!(member::authorize(&authority, Operation::Card(CID.into()), None, NOW).is_ok());
    assert!(member::authorize(
        &authority,
        Operation::ProfileAsset {
            target: CID.into(),
            kind: "banner".into()
        },
        None,
        NOW
    )
    .is_ok());
    let other = Operation::Profile("CN220-CTZN2-198805202-2026".into());
    for (level, size) in [
        (Level::Freedom, 10 * 1024 * 1024u64),
        (Level::Democracy, 100 * 1024 * 1024),
        (Level::Spark, 5120 * 1024 * 1024),
    ] {
        f.member.state.as_mut().unwrap().plan = subscription::Plan::Platform(level);
        let permit =
            member::authorize(&authority, Operation::Attachment, f.record().as_ref(), NOW).unwrap();
        assert_eq!(permit.attachment_limit(NOW).unwrap(), size);
        assert!(!permit.operation().meters("published"));
        assert!(member::authorize(&authority, other.clone(), f.record().as_ref(), NOW).is_ok());
    }
    f.member.state = None;
    assert_eq!(
        member::authorize(&authority, other, f.record().as_ref(), NOW)
            .unwrap_err()
            .code,
        "profile_membership_required"
    );
    assert_eq!(
        member::authorize(&authority, Operation::Attachment, f.record().as_ref(), NOW)
            .unwrap_err()
            .code,
        "attachment_membership_required"
    );
    for op in [
        Operation::Square(SquareRoute::Feed(FeedKind::Recommended)),
        Operation::Square(SquareRoute::Post),
        Operation::Media("square/media".into()),
    ] {
        assert_eq!(
            member::authorize(&authority, op, f.record().as_ref(), NOW)
                .unwrap_err()
                .code,
            "square_membership_required"
        );
    }
    assert!(member::authorize(&authority, Operation::Chat, None, NOW).is_ok());
}

#[test]
fn service_health_fixture_matches_shared_policy_without_extending_chain_facts() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("contract/tatachat.json")).unwrap();
    assert_eq!(
        data["service_sync_health_millis"],
        citizenserve::server::gate::policy::SYNC_HEALTH_MILLIS
    );
    assert_eq!(
        data["maximum_recheck_millis"],
        citizenserve::server::gate::policy::SERVICE_AUTH_MILLIS
    );
    assert_eq!(data["chat_rpc_per_event"], 0);
    assert_eq!(data["full_context_per_event"], 1);
}
