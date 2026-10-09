//! 合成metadata改变Platform枚举索引，验证订阅键来自metadata而非硬编码。
use citizenserve::{
    chain::{ports::Rpc, scale, subscription},
    server::routes as api,
    shared::{crypto, Error, Result},
    square::{
        feed,
        routes::{self, FeedKind},
    },
};
use frame_metadata::v14::*;
use parity_scale_codec::Encode;
use scale_info::{meta_type, TypeInfo};
use serde_json::{json, Value};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("synchronous fixture"),
    }
}
#[derive(Encode, TypeInfo)]
enum Issuer {
    #[codec(index = 3)]
    Platform,
}
#[derive(Encode, TypeInfo)]
enum Level {
    Freedom,
    Democracy,
    Spark,
}
#[derive(Encode, TypeInfo)]
enum Plan {
    Platform { membership_level: Level },
    Creator { tier_id: [u8; 16] },
}
#[derive(Encode, TypeInfo)]
enum Status {
    Active,
    Cancelled,
    Terminated,
    Suspended,
    IssuerPaused,
}
#[derive(Encode, TypeInfo)]
enum Reason {
    NeedReconsent,
    InsufficientBalance,
    IdentityBindingUnavailable,
}
#[derive(Encode, TypeInfo)]
struct State {
    plan: Plan,
    started_at: u64,
    last_charged_at: u64,
    last_charged_price_fen: u128,
    paid_until: u64,
    subscription_status: Status,
    authorized_price_fen: u128,
    suspend_reason: Option<Reason>,
}
fn state(status: Status) -> State {
    State {
        plan: Plan::Platform {
            membership_level: Level::Spark,
        },
        started_at: 1,
        last_charged_at: 2,
        last_charged_price_fen: u128::MAX,
        paid_until: 2_000_000,
        subscription_status: status,
        authorized_price_fen: u128::MAX,
        suspend_reason: None,
    }
}
fn pallet(name: &'static str, entries: Vec<StorageEntryMetadata>) -> PalletMetadata {
    PalletMetadata {
        name,
        storage: Some(PalletStorageMetadata {
            prefix: name,
            entries,
        }),
        calls: None,
        event: None,
        constants: vec![],
        error: None,
        index: 2,
    }
}
fn metadata() -> Vec<u8> {
    frame_metadata::RuntimeMetadataPrefixed::from(RuntimeMetadataV14::new(
        vec![
            pallet(
                "SquarePost",
                vec![StorageEntryMetadata {
                    name: "Subscriptions",
                    modifier: StorageEntryModifier::Optional,
                    ty: StorageEntryType::Map {
                        hashers: vec![StorageHasher::Blake2_128Concat],
                        key: meta_type::<(Vec<u8>, Issuer)>(),
                        value: meta_type::<State>(),
                    },
                    default: vec![],
                    docs: vec![],
                }],
            ),
            pallet(
                "Timestamp",
                vec![StorageEntryMetadata {
                    name: "Now",
                    modifier: StorageEntryModifier::Default,
                    ty: StorageEntryType::Plain(meta_type::<u64>()),
                    default: vec![],
                    docs: vec![],
                }],
            ),
        ],
        ExtrinsicMetadata {
            ty: meta_type::<()>(),
            version: 4,
            signed_extensions: vec![],
        },
        meta_type::<()>(),
    ))
    .encode()
}
struct Chain {
    value: Option<Vec<u8>>,
    fault: bool,
    clock: u64,
}
impl Rpc for Chain {
    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        if self.fault {
            return Err(Error::new(503, "rpc_unavailable"));
        }
        let head = format!("0x{}", "09".repeat(32));
        let genesis = format!("0x{}", "00".repeat(32));
        match method {
            "chain_getFinalizedHead" => Ok(json!(head)),
            "chain_getHeader" => {
                Ok(json!({"number":"0x9","parentHash":format!("0x{}","08".repeat(32))}))
            }
            "chain_getBlockHash" => Ok(json!(if params[0] == 0 { genesis } else { head })),
            "state_getMetadata" => {
                assert_eq!(params[0], head);
                Ok(json!(format!("0x{}", crypto::hex(&metadata()))))
            }
            "state_getStorage" => {
                assert_eq!(params[1], head);
                let key = params[0].as_str().unwrap();
                if key == scale::value_key("Timestamp", "Now") {
                    return Ok(json!(format!("0x{}", crypto::hex(&self.clock.encode()))));
                }
                let encoded = (b"CID1".to_vec(), Issuer::Platform).encode();
                assert_eq!(key, scale::map_key("SquarePost", "Subscriptions", &encoded));
                Ok(self
                    .value
                    .as_ref()
                    .map(|v| json!(format!("0x{}", crypto::hex(v))))
                    .unwrap_or(Value::Null))
            }
            _ => panic!("unexpected RPC"),
        }
    }
}
fn entitlement(s: Option<State>, clock: u64) -> subscription::Entitlement {
    run(subscription::current(
        &Chain {
            value: s.map(|v| v.encode()),
            fault: false,
            clock,
        },
        &format!("0x{}", "00".repeat(32)),
        "CID1",
        1_000_000,
    ))
    .unwrap()
}
#[test]
fn dynamic_platform_key_anchors_storage_and_preserves_full_u128_prices() {
    assert_eq!(
        entitlement(Some(state(Status::Active)), 1_000_000)
            .paid_until(1_000_001)
            .unwrap(),
        Some(2_000_000)
    );
    assert_eq!(
        entitlement(Some(state(Status::Cancelled)), 1_000_000)
            .paid_until(1_000_001)
            .unwrap(),
        Some(2_000_000)
    );
}
#[test]
fn absent_and_inactive_are_free_but_unknown_rpc_is_an_error() {
    assert_eq!(
        entitlement(None, 1_000_000).paid_until(1_000_001).unwrap(),
        None
    );
    for status in [Status::Terminated, Status::IssuerPaused] {
        assert_eq!(
            entitlement(Some(state(status)), 1_000_000)
                .paid_until(1_000_001)
                .unwrap(),
            None
        );
    }
    assert!(run(subscription::current(
        &Chain {
            value: None,
            fault: true,
            clock: 0
        },
        &format!("0x{}", "00".repeat(32)),
        "CID1",
        1_000_000
    ))
    .is_err());
}
#[test]
fn suspend_reason_and_plan_must_match_actual_state() {
    let mut s = state(Status::Suspended);
    assert!(run(subscription::current(
        &Chain {
            value: Some(s.encode()),
            fault: false,
            clock: 0
        },
        &format!("0x{}", "00".repeat(32)),
        "CID1",
        1_000_000
    ))
    .is_err());
    for r in [
        Reason::NeedReconsent,
        Reason::InsufficientBalance,
        Reason::IdentityBindingUnavailable,
    ] {
        s.suspend_reason = Some(r);
        assert_eq!(entitlement(Some(s), 0).paid_until(1_000_001).unwrap(), None);
        s = state(Status::Suspended);
    }
    s = state(Status::Active);
    s.plan = Plan::Creator { tier_id: [0; 16] };
    assert!(run(subscription::current(
        &Chain {
            value: Some(s.encode()),
            fault: false,
            clock: 0
        },
        &format!("0x{}", "00".repeat(32)),
        "CID1",
        1_000_000
    ))
    .is_err());
    for level in [Level::Freedom, Level::Democracy] {
        let mut s = state(Status::Active);
        s.plan = Plan::Platform {
            membership_level: level,
        };
        assert_eq!(
            entitlement(Some(s), 0).paid_until(1_000_001).unwrap(),
            Some(2_000_000)
        );
    }
}
#[test]
fn expiry_uses_maximum_chain_time_and_server_time_and_no_extended_confirmation() {
    let e = entitlement(Some(state(Status::Active)), 2_000_000);
    assert_eq!(e.paid_until(1_000_001).unwrap(), None);
    let e = entitlement(Some(state(Status::Active)), 0);
    assert!(e.paid_until(1_060_000).is_err());
    assert!(e.paid_until(999_999).is_err());
}
#[test]
fn malformed_scale_tail_cannot_be_ignored() {
    let mut raw = state(Status::Active).encode();
    raw.push(0);
    assert!(run(subscription::current(
        &Chain {
            value: Some(raw),
            fault: false,
            clock: 0
        },
        &format!("0x{}", "00".repeat(32)),
        "CID1",
        1_000_000
    ))
    .is_err());
}
#[test]
fn utc_dates_page_size_and_remaining_budget_match_golden() {
    let f: Value = serde_json::from_str(include_str!("contract/square_feed.json")).unwrap();
    for row in f["days"].as_array().unwrap() {
        assert_eq!(feed::utc_day(row[0].as_u64().unwrap()), row[1]);
    }
    assert_eq!(feed::budget(20, 95, false).unwrap(), 5);
    assert!(feed::budget(20, 100, false).is_err());
    assert_eq!(feed::budget(50, 100, true).unwrap(), 50);
    for q in f["query_invalid"].as_array().unwrap() {
        assert!(api::protected_target(
            "GET",
            &format!("/api/8964/feed/recommended?{}", q.as_str().unwrap())
        )
        .is_err());
    }
    assert_eq!(routes::limit(&api::query(None).unwrap()).unwrap(), 20);
}
#[test]
fn required_author_and_follow_type_cannot_be_defaulted() {
    for target in [
        "/api/8964/posts",
        "/api/8964/posts?cid_number=CID1&post_type=bad",
        "/api/8964/follows?cid_number=CID1",
        "/api/8964/follows?cid_number=CID1&type=bad",
    ] {
        assert!(api::protected_target("GET", target).is_err());
    }
    assert!(api::protected_target(
        "GET",
        "/api/8964/posts?cid_number=CID1&category=campaign&post_type=article&limit=50&cursor=1"
    )
    .is_ok());
    assert_eq!(
        FeedKind::Campaign,
        serde_json::from_value(json!("campaign")).unwrap()
    );
}

fn authorization() -> citizenserve::user::profile_service::Authorization {
    use citizenserve::{
        server::guard,
        user::{
            admission::Admission,
            auth::{device::Device, session::Session},
            identity::Identity,
            profile_service::Authorization,
            registration::protocol::Config,
        },
    };
    let identity: Identity =
        serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
    let v: Value = serde_json::from_str(include_str!("contract/activation.json")).unwrap();
    let config = Config {
        registration_scope: v["registration_scope"].as_str().unwrap().into(),
        service_origin: v["service_origin"].as_str().unwrap().into(),
        chain_scope: identity.chain_scope.clone(),
        site_key: "fixture".into(),
    };
    let admission = Admission {
        cid_number: identity.cid_number.clone(),
        enrollment_id: v["enrollment_id"].as_str().unwrap().into(),
        source: "turnstile".into(),
        human_verified_at_millis: 999999,
        registration_scope: config.registration_scope.clone(),
        service_origin: config.service_origin.clone(),
        chain_scope: config.chain_scope.clone(),
        institution: identity.institution,
    };
    let device = Device {
        cid_number: identity.cid_number.clone(),
        device_id: "ab".repeat(32),
        public_key: format!("0x{}", "ab".repeat(32)),
        account_id: identity.account_id.clone(),
        binding_revision: 1,
        active: true,
        issued_at: 900000,
        created_at: 1000000,
        updated_at: 1000000,
    };
    let token = format!("sqs_{}", "09".repeat(16));
    let session = Session {
        session_token_hash: citizenserve::user::auth::session::hash(&token).unwrap(),
        cid_number: identity.cid_number.clone(),
        account_id: identity.account_id.clone(),
        binding_revision: 1,
        device_id: device.device_id.clone(),
        created_at: 1000000,
        expires_at: 2000000,
    };
    let authority =
        guard::session_authority(&identity, &admission, &device, &session, &config, 1000001)
            .unwrap();
    Authorization::new(&authority, &config, &token, 1000001).unwrap()
}
struct Feed {
    fail_charge: bool,
    used: u32,
    charged: std::sync::atomic::AtomicU32,
}
impl citizenserve::square::ports::Repository for Feed {
    async fn browse_count(&self, _: &str, _: &str) -> Result<u32> {
        Ok(self.used)
    }
    async fn feed(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: FeedKind,
        limit: u32,
    ) -> Result<Vec<citizenserve::square::posts::Post>> {
        let post = json!({"post_id":"post1","cid_number":"CID1","account_id":format!("0x{}","cd".repeat(32)),"post_category":"normal","post_type":"document","title":null,"excerpt":"x","content_hash":"a".repeat(64),"storage_receipt_id":"r1","chain_block":9,"chain_block_hash":format!("0x{}","09".repeat(32)),"tx_hash":format!("0x{}","08".repeat(32)),"created_at":1,"post_state":"published","identity_level":"visitor","membership_level":null,"membership_active":false,"display_name":"","avatar_object_key":null});
        Ok((0..limit.min(3))
            .map(|_| serde_json::from_value(post.clone()).unwrap())
            .collect())
    }
    async fn posts(
        &self,
        a: &citizenserve::user::profile_service::Authorization,
        _: &citizenserve::square::posts::Query,
        limit: u32,
    ) -> Result<Vec<citizenserve::square::posts::Post>> {
        self.feed(a, FeedKind::Recommended, limit).await
    }
    async fn charge(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: &str,
        count: u32,
        _: &subscription::Entitlement,
    ) -> Result<u32> {
        if self.fail_charge {
            return Err(Error::new(429, "browse_limit_reached"));
        }
        self.charged
            .store(count, std::sync::atomic::Ordering::SeqCst);
        Ok(self.used + count)
    }
    async fn follows(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: &citizenserve::square::follows::Query,
    ) -> Result<Vec<citizenserve::square::follows::Entry>> {
        panic!("unused")
    }
    async fn change_follow(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: &str,
        _: &citizenserve::square::follows::Change,
    ) -> Result<()> {
        panic!("unused")
    }
}
#[test]
fn charge_failure_does_not_return_previously_read_posts() {
    let repo = Feed {
        fail_charge: true,
        used: 98,
        charged: 0.into(),
    };
    let e = entitlement(None, 0);
    let result = run(feed::feed(
        &repo,
        &authorization(),
        FeedKind::Recommended,
        20,
        &e,
    ));
    assert_eq!(result.unwrap_err().code, "browse_limit_reached");
    assert_eq!(repo.charged.load(std::sync::atomic::Ordering::SeqCst), 0);
}
#[test]
fn only_actual_returned_items_are_charged_with_remaining_budget() {
    let repo = Feed {
        fail_charge: false,
        used: 98,
        charged: 0.into(),
    };
    let e = entitlement(None, 0);
    let result = run(feed::feed(
        &repo,
        &authorization(),
        FeedKind::Recommended,
        20,
        &e,
    ))
    .unwrap();
    assert_eq!(result["posts"].as_array().unwrap().len(), 2);
    assert_eq!(result["browse_left"], 0);
    assert_eq!(repo.charged.load(std::sync::atomic::Ordering::SeqCst), 2);
}
