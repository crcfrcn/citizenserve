//! 真正生成Sr25519钱包签名与Ed25519 MLS证明，内存端口只模拟提交/失败。
use citizenserve::{
    server::guard,
    shared::{crypto, Error, Result},
    user::{
        admission::Admission,
        auth::{
            challenge::{Challenge, Consumption},
            device::{self, Commit, Device, Register},
            mls_authentication::{Proof, Purpose},
            session::{self, Session},
        },
        identity::Identity,
        ports::AuthRepository,
        registration::{ports::Repository, protocol::*, service},
    },
};
use ed25519_dalek::{Signer, SigningKey};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("fake repository must resolve synchronously"),
    }
}
struct Memory {
    enrollment: Mutex<Option<Enrollment>>,
    device: Mutex<Option<Device>>,
    admission: Mutex<Option<Admission>>,
    session: Mutex<Option<Session>>,
    consumed: AtomicBool,
    consumes: AtomicUsize,
    fail: AtomicBool,
}
impl Memory {
    fn new(e: Enrollment) -> Self {
        Self {
            enrollment: Mutex::new(Some(e)),
            device: Mutex::new(None),
            admission: Mutex::new(None),
            session: Mutex::new(None),
            consumed: AtomicBool::new(false),
            consumes: AtomicUsize::new(0),
            fail: AtomicBool::new(false),
        }
    }
}
impl Repository for Memory {
    async fn create(&self, _: &Enrollment, _: u64) -> Result<bool> {
        panic!("not used")
    }
    async fn read(&self, id: &str) -> Result<Option<Enrollment>> {
        Ok(self
            .enrollment
            .lock()
            .unwrap()
            .as_ref()
            .filter(|e| e.enrollment_id == id)
            .cloned())
    }
    async fn read_attempt(&self, _: &str) -> Result<Option<Enrollment>> {
        panic!("not used")
    }
    async fn compare_and_swap(&self, _: &Enrollment, _: &Enrollment, _: u64) -> Result<bool> {
        panic!("activation must not use registration CAS")
    }
    async fn cleanup(&self, _: u64) -> Result<u64> {
        panic!("not used")
    }
}
impl AuthRepository for Memory {
    async fn device(&self, c: &str, d: &str) -> Result<Option<Device>> {
        Ok(self
            .device
            .lock()
            .unwrap()
            .as_ref()
            .filter(|v| v.cid_number == c && v.device_id == d)
            .cloned())
    }
    async fn admission(&self, c: &str) -> Result<Option<Admission>> {
        Ok(self
            .admission
            .lock()
            .unwrap()
            .as_ref()
            .filter(|a| a.cid_number == c)
            .cloned())
    }
    async fn session(&self, hash: &str) -> Result<Option<Session>> {
        Ok(self
            .session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.session_token_hash == hash)
            .cloned())
    }
    async fn issue_challenge(&self, _: &Challenge) -> Result<bool> {
        panic!("not used")
    }
    async fn consume(&self, c: &Consumption<'_>) -> Result<bool> {
        if c.purpose == Purpose::Request {
            assert_eq!(
                c.session_token_hash,
                self.session
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|s| s.session_token_hash.as_str())
            );
        }
        self.consumes.fetch_add(1, Ordering::SeqCst);
        Ok(!self.consumed.swap(true, Ordering::SeqCst))
    }
    async fn activate(&self, c: &Commit) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::new(503, "synthetic_commit_failure"));
        }
        *self.device.lock().unwrap() = Some(c.device.clone());
        if let Some(e) = &c.enrollment {
            *self.enrollment.lock().unwrap() = Some(e.clone());
            *self.admission.lock().unwrap() = device::admission_for(c);
        }
        Ok(())
    }
    async fn issue_session(&self, s: &Session, _: &Config, _: u64) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::new(503, "synthetic_session_failure"));
        }
        *self.session.lock().unwrap() = Some(s.clone());
        Ok(())
    }
}
struct Case {
    repo: Memory,
    config: Config,
    identity: Identity,
    input: Register,
    proof: Proof,
    body: Vec<u8>,
    key: SigningKey,
}
impl Case {
    fn new() -> Self {
        let wallet = schnorrkel::MiniSecretKey::from_bytes(&[31; 32])
            .unwrap()
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
        let key = SigningKey::from_bytes(&[23; 32]);
        let config = Config {
            registration_scope: "citizenserve:fixture".into(),
            service_origin: "https://registration.example.test".into(),
            chain_scope: format!("0x{}", "00".repeat(32)),
            site_key: "fixture".into(),
        };
        let mut identity: Identity =
            serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
        identity.account_id = format!("0x{}", crypto::hex(&wallet.public.to_bytes()));
        let (mut e, r) = service::prepare(
            &config,
            &Prepare {
                protocol_version: 1,
                chain_scope: config.chain_scope.clone(),
                account_id: identity.account_id.clone(),
                institution: Institution::CTZN,
            },
            service::Entropy {
                enrollment: [1; 16],
                verification: [2; 16],
                recovery: [3; 32],
                page: [4; 32],
                nonce: [5; 32],
            },
            900_000,
        )
        .unwrap();
        // 合成外部结果走同一验证保存函数，测试中没有任何网络调用。
        let external = service::SiteverifyResult {
            http_ok: true,
            success: true,
            action: ACTION.into(),
            hostname: config.hostname(),
            cdata: e.attempt.cdata.clone(),
            challenge_at_millis: 900_001,
        };
        service::save_verification(&mut e, &config, Some(&external), 900_002).unwrap();
        let public = format!("0x{}", crypto::hex(key.verifying_key().as_bytes()));
        let issued = 900_000;
        let message = citizenserve::user::auth::mls_authentication::device_binding_message(
            &identity.cid_number,
            identity.binding_revision,
            &identity.account_id,
            &public,
            issued,
        )
        .unwrap();
        let input = Register {
            account_id: identity.account_id.clone(),
            public_key: public.clone(),
            issued_at: issued,
            binding_signature: format!(
                "0x{}",
                crypto::hex(&wallet.sign_simple(b"substrate", &message).to_bytes())
            ),
            enrollment_id: Some(e.enrollment_id.clone()),
            recovery_token: r.recovery_token,
        };
        let body = serde_json::to_vec(&input).unwrap();
        let mut proof = Proof {
            user_id: identity.cid_number.clone(),
            device_id: public[2..].into(),
            public_key: public,
            account_id: identity.account_id.clone(),
            binding_revision: 1,
            service_origin: config.service_origin.clone(),
            challenge: format!("0x{}", "77".repeat(32)),
            expires_at_millis: 1_200_000,
            method: "POST".into(),
            request_target: "/api/user/devices".into(),
            body_sha256: format!("0x{}", crypto::sha256_hex(&body)),
            signature: format!("0x{}", "00".repeat(64)),
        };
        proof.signature = format!(
            "0x{}",
            crypto::hex(&key.sign(&proof.message().unwrap()).to_bytes())
        );
        Self {
            repo: Memory::new(e),
            config,
            identity,
            input,
            proof,
            body,
            key,
        }
    }
    fn resign(&mut self) {
        self.body = serde_json::to_vec(&self.input).unwrap();
        self.proof.body_sha256 = format!("0x{}", crypto::sha256_hex(&self.body));
        self.proof.signature = format!(
            "0x{}",
            crypto::hex(&self.key.sign(&self.proof.message().unwrap()).to_bytes())
        );
    }
    fn activate(&self) -> Result<device::Registered> {
        run(device::register(
            &self.repo,
            &self.repo,
            &self.config,
            &self.identity,
            &self.input,
            &self.proof,
            &self.body,
            "/api/user/devices",
            1_000_001,
        ))
    }
}
#[test]
fn all_four_facts_activate_and_normal_session_needs_no_cloudflare_or_wallet() {
    let c = Case::new();
    c.activate().unwrap();
    assert_eq!(
        c.repo.enrollment.lock().unwrap().as_ref().unwrap().state,
        State::Activated
    );
    assert!(c.repo.admission.lock().unwrap().is_some());
    let body =
        serde_json::to_vec(&serde_json::json!({"account_id":c.identity.account_id})).unwrap();
    let mut proof = c.proof.clone();
    proof.request_target = "/api/user/sessions".into();
    proof.body_sha256 = format!("0x{}", crypto::sha256_hex(&body));
    proof.signature = format!(
        "0x{}",
        crypto::hex(&c.key.sign(&proof.message().unwrap()).to_bytes())
    );
    c.repo.consumed.store(false, Ordering::SeqCst);
    let response = run(session::create(
        &c.repo,
        &c.config,
        &c.identity,
        &session::Request {
            account_id: c.identity.account_id.clone(),
        },
        &proof,
        &body,
        "/api/user/sessions",
        [9; 16],
        1_000_002,
    ))
    .unwrap();
    assert_eq!(response.expires_at, 1_000_002 + session::TTL);
    assert!(session::hash(&response.session_token).is_ok());
}
#[test]
fn wrong_wallet_signature_does_not_consume_or_write() {
    let mut c = Case::new();
    c.input.binding_signature = format!("0x{}", "00".repeat(64));
    c.resign();
    assert_eq!(c.activate().unwrap_err().code, "invalid_binding_signature");
    assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
    assert!(c.repo.device.lock().unwrap().is_none());
}
#[test]
fn wrong_mls_signature_does_not_consume() {
    let mut c = Case::new();
    c.proof.signature = format!("0x{}", "00".repeat(64));
    assert!(c.activate().is_err());
    assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
}
#[test]
fn body_path_and_revision_are_bound() {
    for kind in 0..3 {
        let mut c = Case::new();
        match kind {
            0 => c.body.push(b' '),
            1 => c.proof.request_target = "/api/user/sessions".into(),
            _ => c.proof.binding_revision = 2,
        };
        assert!(c.activate().is_err());
        assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn prepared_or_expired_human_fact_never_activates() {
    for state in [State::Prepared, State::Expired] {
        let c = Case::new();
        c.repo.enrollment.lock().unwrap().as_mut().unwrap().state = state;
        assert!(c.activate().is_err());
        assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn institution_and_recovery_cannot_be_substituted() {
    for kind in 0..2 {
        let mut c = Case::new();
        if kind == 0 {
            c.repo
                .enrollment
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .institution = Institution::NATP;
        } else {
            c.input.recovery_token = Some(crypto::base64url(&[4; 32]));
            c.resign();
        }
        assert!(c.activate().is_err());
        assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn null_exemption_requires_server_admission() {
    let mut c = Case::new();
    c.input.enrollment_id = None;
    c.input.recovery_token = None;
    c.resign();
    assert_eq!(c.activate().unwrap_err().code, "registration_required");
    assert_eq!(c.repo.consumes.load(Ordering::SeqCst), 0);
}
#[test]
fn activation_failure_burns_nonce_and_leaves_no_half_facts() {
    let c = Case::new();
    c.repo.fail.store(true, Ordering::SeqCst);
    assert!(c.activate().is_err());
    assert!(c.repo.consumed.load(Ordering::SeqCst));
    assert!(c.repo.device.lock().unwrap().is_none());
    assert!(c.repo.admission.lock().unwrap().is_none());
    assert_eq!(
        c.repo.enrollment.lock().unwrap().as_ref().unwrap().state,
        State::HumanVerified
    );
    c.repo.fail.store(false, Ordering::SeqCst);
    assert_eq!(c.activate().unwrap_err().code, "invalid_mls_challenge");
}
#[test]
fn idempotent_retry_uses_fresh_proof_and_does_not_reverify() {
    let mut c = Case::new();
    c.activate().unwrap();
    c.repo.consumed.store(false, Ordering::SeqCst);
    c.proof.challenge = format!("0x{}", "88".repeat(32));
    c.resign();
    c.activate().unwrap();
    c.input.enrollment_id = None;
    c.input.recovery_token = None;
    c.repo.consumed.store(false, Ordering::SeqCst);
    c.resign();
    c.activate().unwrap();
}
#[test]
fn activation_result_cannot_be_reused_for_another_device() {
    let c = Case::new();
    c.activate().unwrap();
    c.repo.consumed.store(false, Ordering::SeqCst);
    c.repo
        .enrollment
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .activation
        .as_mut()
        .unwrap()
        .device_id = "ff".repeat(32);
    assert_eq!(
        c.activate().unwrap_err().code,
        "registration_activation_conflict"
    );
}
#[test]
fn stale_device_authorization_does_not_overwrite() {
    let c = Case::new();
    c.activate().unwrap();
    c.repo.consumed.store(false, Ordering::SeqCst);
    c.repo.device.lock().unwrap().as_mut().unwrap().issued_at = c.input.issued_at + 1;
    assert_eq!(c.activate().unwrap_err().code, "stale_device_binding");
}
#[test]
fn complete_session_guard_denies_revoke_rebind_and_expired_chain_confirmation() {
    let c = Case::new();
    c.activate().unwrap();
    let a = c.repo.admission.lock().unwrap().clone().unwrap();
    let d = c.repo.device.lock().unwrap().clone().unwrap();
    let s = Session {
        session_token_hash: "00".repeat(32),
        cid_number: c.identity.cid_number.clone(),
        binding_revision: 1,
        account_id: c.identity.account_id.clone(),
        device_id: d.device_id.clone(),
        created_at: 1_000_000,
        expires_at: 2_000_000,
    };
    assert!(guard::session_authority(&c.identity, &a, &d, &s, &c.config, 1_000_001).is_ok());
    assert!(guard::session_authority(&c.identity, &a, &d, &s, &c.config, 1_060_000).is_err());
    let mut i = c.identity.clone();
    i.binding_revision = 2;
    assert!(guard::session_authority(&i, &a, &d, &s, &c.config, 1_000_001).is_err());
    let mut revoked = d;
    revoked.active = false;
    assert!(guard::session_authority(&c.identity, &a, &revoked, &s, &c.config, 1_000_001).is_err());
}
#[test]
fn exact_six_fields_reject_old_token_unknown_and_missing_null() {
    let c = Case::new();
    let mut value = serde_json::to_value(&c.input).unwrap();
    value.as_object_mut().unwrap().remove("enrollment_id");
    assert!(serde_json::from_value::<Register>(value).is_err());
    let mut value = serde_json::to_value(&c.input).unwrap();
    value["turnstile_token"] = "old".into();
    assert!(serde_json::from_value::<Register>(value).is_err());
}

#[test]
fn admitted_cid_can_add_new_key_with_fresh_wallet_and_mls_proofs() {
    let mut c = Case::new();
    c.activate().unwrap();
    c.input.enrollment_id = None;
    c.input.recovery_token = None;
    c.key = SigningKey::from_bytes(&[24; 32]);
    let public = format!("0x{}", crypto::hex(c.key.verifying_key().as_bytes()));
    c.input.public_key = public.clone();
    c.proof.public_key = public.clone();
    c.proof.device_id = public[2..].into();
    let wallet = schnorrkel::MiniSecretKey::from_bytes(&[31; 32])
        .unwrap()
        .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
    let message = citizenserve::user::auth::mls_authentication::device_binding_message(
        &c.identity.cid_number,
        c.identity.binding_revision,
        &c.input.account_id,
        &public,
        c.input.issued_at,
    )
    .unwrap();
    c.input.binding_signature = format!(
        "0x{}",
        crypto::hex(&wallet.sign_simple(b"substrate", &message).to_bytes())
    );
    c.repo.consumed.store(false, Ordering::SeqCst);
    c.resign();
    c.activate().unwrap();
    assert_eq!(
        c.repo.device.lock().unwrap().as_ref().unwrap().public_key,
        public
    );
    // 原验证登记仍绑定首次设备，新设备复用的是服务器CID准入事实。
    assert_ne!(
        c.repo
            .enrollment
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .activation
            .as_ref()
            .unwrap()
            .public_key,
        public
    );
}

#[test]
fn request_guard_requires_live_session_bound_proof_and_consumes_once() {
    let c = Case::new();
    c.activate().unwrap();
    let token = format!("sqs_{}", "09".repeat(16));
    *c.repo.session.lock().unwrap() = Some(Session {
        session_token_hash: session::hash(&token).unwrap(),
        cid_number: c.identity.cid_number.clone(),
        binding_revision: 1,
        account_id: c.identity.account_id.clone(),
        device_id: c.proof.device_id.clone(),
        created_at: 1_000_000,
        expires_at: 2_000_000,
    });
    let mut proof = c.proof.clone();
    proof.method = "GET".into();
    proof.request_target = format!("/api/user/profiles/{}", c.identity.cid_number);
    proof.body_sha256 = format!("0x{}", crypto::sha256_hex(b""));
    proof.signature = format!(
        "0x{}",
        crypto::hex(&c.key.sign(&proof.message().unwrap()).to_bytes())
    );
    c.repo.consumed.store(false, Ordering::SeqCst);
    let authenticate = || {
        run(guard::authenticate(
            &c.repo,
            &c.identity,
            &c.config,
            &token,
            &proof,
            "GET",
            &format!("/api/user/profiles/{}", c.identity.cid_number),
            b"",
            1_000_001,
        ))
    };
    let a = authenticate().unwrap();
    assert_eq!(a.recheck_deadline(), 1_060_000);
    assert_eq!(authenticate().unwrap_err().code, "invalid_mls_challenge");
    c.repo.consumed.store(false, Ordering::SeqCst);
    assert!(run(guard::authenticate(
        &c.repo,
        &c.identity,
        &c.config,
        &token,
        &proof,
        "GET",
        "/api/user/profiles/different",
        b"",
        1_000_001
    ))
    .is_err());
    assert!(!c.repo.consumed.load(Ordering::SeqCst));
    *c.repo.session.lock().unwrap() = None;
    assert_eq!(authenticate().unwrap_err().code, "invalid_session");
}
