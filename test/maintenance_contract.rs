//! 合成runtime仅用于真实SCALE解码、当前资格与workerd RPC测试，不代表线上链验收。
#![allow(dead_code)]
use citizenserve::{
    chain::{finalized, identity, ports::Rpc, scale::Metadata, subscription},
    membership::cleanup::{Eligibility, Notice},
    server::maintenance::{daily_due, five_minute_slot, task_id, Budget, Work},
    shared::{crypto, Result},
    square::maintenance::Locator,
};
use frame_metadata::v14::*;
use parity_scale_codec::Encode;
use scale_info::{meta_type, TypeInfo};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(x) => x,
        Poll::Pending => panic!("synthetic RPC synchronous"),
    }
}
#[derive(Encode, TypeInfo)]
enum CidStatus {
    Active,
    Revoked,
}
#[derive(Encode, TypeInfo)]
struct Registry {
    status: CidStatus,
    registered_at: u32,
    revoked_at: Option<u32>,
}
#[derive(Encode, TypeInfo)]
enum CitizenStatus {
    Normal,
    Revoked,
}
#[derive(Encode, TypeInfo)]
struct Voting {
    passport_valid_from: u32,
    passport_valid_until: u32,
    citizen_status: CitizenStatus,
}
#[derive(Encode, TypeInfo)]
enum Issuer {
    Platform,
    Creator(Vec<u8>),
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
}
#[derive(Encode, TypeInfo)]
enum Status {
    Active,
    Terminated,
}
#[derive(Encode, TypeInfo)]
enum Reason {
    NeedReconsent,
}
#[derive(Encode, TypeInfo)]
struct Subscription {
    plan: Plan,
    started_at: u64,
    last_charged_at: u64,
    last_charged_price_fen: u128,
    paid_until: u64,
    subscription_status: Status,
    authorized_price_fen: u128,
    suspend_reason: Option<Reason>,
}
#[derive(Encode, TypeInfo)]
enum Event {
    Other,
}
#[derive(Encode, TypeInfo)]
struct Record {
    event: Event,
}
fn plain<T: TypeInfo + 'static>(name: &'static str) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Optional,
        ty: StorageEntryType::Plain(meta_type::<T>()),
        default: vec![],
        docs: vec![],
    }
}
fn map<T: TypeInfo + 'static, K: TypeInfo + 'static>(name: &'static str) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Optional,
        ty: StorageEntryType::Map {
            hashers: vec![StorageHasher::Blake2_128Concat],
            key: meta_type::<K>(),
            value: meta_type::<T>(),
        },
        default: vec![],
        docs: vec![],
    }
}
fn pallet(name: &'static str, index: u8, entries: Vec<StorageEntryMetadata>) -> PalletMetadata {
    PalletMetadata {
        name,
        index,
        storage: Some(PalletStorageMetadata {
            prefix: name,
            entries,
        }),
        calls: None,
        event: None,
        error: None,
        constants: vec![],
    }
}
struct Fixture {
    raw: Vec<u8>,
    values: BTreeMap<String, Value>,
    now: u64,
}
const CID: &str = "CN220-CTZN2-198805201-2026";
fn hash(n: u8) -> String {
    format!("0x{}", crypto::hex(&[n; 32]))
}
impl Fixture {
    fn new(now: u64, lapse: u64) -> Self {
        let m = RuntimeMetadataV14::new(
            vec![
                pallet("Timestamp", 0, vec![plain::<u64>("Now")]),
                pallet("System", 1, vec![plain::<Vec<Record>>("Events")]),
                pallet(
                    "CitizenIdentity",
                    2,
                    vec![
                        map::<Registry, Vec<u8>>("CidRegistry"),
                        map::<[u8; 32], Vec<u8>>("AccountIdByCid"),
                        map::<Vec<u8>, [u8; 32]>("CidByAccountId"),
                        map::<u64, Vec<u8>>("BindingRevisionByCid"),
                        map::<Voting, Vec<u8>>("VotingIdentityByCid"),
                        map::<u32, Vec<u8>>("CandidateIdentityByCid"),
                    ],
                ),
                pallet(
                    "SquarePost",
                    3,
                    vec![
                        map::<Subscription, (Vec<u8>, Issuer)>("Subscriptions"),
                        map::<u128, Level>("PlatformPrice"),
                    ],
                ),
            ],
            ExtrinsicMetadata {
                ty: meta_type::<()>(),
                version: 4,
                signed_extensions: vec![],
            },
            meta_type::<()>(),
        );
        let raw = frame_metadata::RuntimeMetadataPrefixed::from(m).encode();
        let md = Metadata::read(&raw).unwrap();
        let mut values = BTreeMap::new();
        let mut put = |p, e, args: Vec<Vec<u8>>, v: Vec<u8>| {
            values.insert(
                if args.is_empty() {
                    citizenserve::chain::scale::value_key(p, e)
                } else {
                    md.storage_key(p, e, &args).unwrap().0
                },
                json!(format!("0x{}", crypto::hex(&v))),
            );
        };
        put("Timestamp", "Now", vec![], now.encode());
        put("System", "Events", vec![], Vec::<Record>::new().encode());
        let key = CID.as_bytes().to_vec().encode();
        put(
            "CitizenIdentity",
            "CidRegistry",
            vec![key.clone()],
            Registry {
                status: CidStatus::Active,
                registered_at: 0,
                revoked_at: None,
            }
            .encode(),
        );
        put(
            "CitizenIdentity",
            "AccountIdByCid",
            vec![key.clone()],
            [0xcdu8; 32].encode(),
        );
        put(
            "CitizenIdentity",
            "CidByAccountId",
            vec![[0xcdu8; 32].encode()],
            CID.as_bytes().to_vec().encode(),
        );
        put(
            "CitizenIdentity",
            "BindingRevisionByCid",
            vec![key],
            1u64.encode(),
        );
        put(
            "SquarePost",
            "Subscriptions",
            vec![(CID.as_bytes().to_vec(), Issuer::Platform).encode()],
            Subscription {
                plan: Plan::Platform {
                    membership_level: Level::Freedom,
                },
                started_at: 0,
                last_charged_at: 0,
                last_charged_price_fen: 199900,
                paid_until: lapse,
                subscription_status: Status::Terminated,
                authorized_price_fen: 199900,
                suspend_reason: None,
            }
            .encode(),
        );
        for (l, p) in [
            (Level::Freedom, 199900u128),
            (Level::Democracy, 599900),
            (Level::Spark, 5999900),
        ] {
            put("SquarePost", "PlatformPrice", vec![l.encode()], p.encode());
        }
        Self { raw, values, now }
    }
    fn facts(
        &self,
    ) -> (
        citizenserve::user::identity::Identity,
        subscription::Current,
    ) {
        let a = run(finalized::head(self, &hash(0))).unwrap();
        let m = run(identity::metadata(self, &a)).unwrap();
        let i = run(identity::by_cid(self, &m, &a, CID, &hash(0), self.now))
            .unwrap()
            .unwrap();
        let s = run(subscription::platform(
            self,
            &hash(0),
            CID,
            &i.account_id,
            self.now,
        ))
        .unwrap();
        (i, s)
    }
}
impl Rpc for Fixture {
    async fn call(&self, m: &str, p: Value) -> Result<Value> {
        Ok(match m {
            "chain_getFinalizedHead" => json!(hash(9)),
            "chain_getBlockHash" => json!(if p[0] == 0 {
                hash(0)
            } else {
                hash(p[0].as_u64().unwrap_or(9) as u8)
            }),
            "chain_getHeader" => {
                json!({"number":"0x9","parentHash":hash(8),"stateRoot":hash(1),"extrinsicsRoot":hash(2),"digest":{"logs":[]}})
            }
            "state_getMetadata" => json!(format!("0x{}", crypto::hex(&self.raw))),
            "state_getStorage" => self
                .values
                .get(p[0].as_str().unwrap())
                .cloned()
                .unwrap_or(Value::Null),
            _ => panic!("unexpected synthetic RPC {m}"),
        })
    }
}
#[test]
fn budget_shared_and_commit_reserved() {
    let b = Budget::default();
    let c = b.clone();
    b.business(44).unwrap();
    assert!(c.business(2).is_err());
    c.business(1).unwrap();
    assert!(b.business(1).is_err());
    b.commit(5).unwrap();
    assert_eq!(c.used(), 50);
    assert!(b.commit(1).is_err());
}
#[test]
fn scheduler_slots_and_daily_catchup() {
    assert_eq!(five_minute_slot(600001), 600000);
    assert_eq!(daily_due(11040000 - 1), None);
    assert_eq!(daily_due(11040000), Some(11040000));
    assert_eq!(daily_due(86400000 + 100), Some(11040000));
    assert_ne!(
        task_id(Work::Storage, 300000),
        task_id(Work::Uploads, 300000)
    );
}
#[test]
fn qualification_thirty_days_and_notice_twenty_four_hours() {
    let lapse = 1_000_000;
    let now = lapse + citizenserve::membership::cleanup::GRACE_MILLIS;
    let f = Fixture::new(now, lapse);
    let (i, s) = f.facts();
    let pr = Eligibility::verify(&i, &s, 100000000001, None, now)
        .unwrap()
        .unwrap();
    let n = Notice::new(lapse, now).unwrap();
    assert!(!pr.may_delete(&n, now).unwrap());
    let f = Fixture::new(now + 86400000, lapse);
    let (i, s) = f.facts();
    let pr = Eligibility::verify(&i, &s, 100000000001, Some(&n), f.now)
        .unwrap()
        .unwrap();
    assert!(pr.may_delete(&n, f.now).unwrap());
    assert!(pr.require_current(f.now + 60000).is_err());
    assert!(Eligibility::verify(&i, &s, 100000000000, Some(&n), f.now)
        .unwrap()
        .is_none());
    let early = Fixture::new(now - 1, lapse);
    let (i, s) = early.facts();
    assert!(Eligibility::verify(&i, &s, 100000000001, None, early.now)
        .unwrap()
        .is_none());
}
#[test]
fn renewal_cycle_and_anchor_fail_closed() {
    let f = Fixture::new(3_000_000_000, 3_100_000_000);
    let (i, s) = f.facts();
    assert!(Eligibility::verify(&i, &s, 100000000001, None, f.now)
        .unwrap()
        .is_none());
    let f = Fixture::new(3_000_000_000, 1_000_000);
    let (mut i, s) = f.facts();
    i.finalized_block_hash = hash(8);
    assert!(Eligibility::verify(&i, &s, 100000000001, None, f.now).is_err());
    i.finalized_block_hash = hash(9);
    let n = Notice::new(2_000_000, f.now - 86400000).unwrap();
    assert!(Eligibility::verify(&i, &s, 100000000001, Some(&n), f.now)
        .unwrap()
        .is_none());
}
#[test]
fn locator_ownership_and_all_external_completion() {
    let l = Locator {
        cid_number: CID.into(),
        upload_id: "squ_1".into(),
        post_id: "sqp_1".into(),
        private_keys: vec![format!("square/{CID}/posts/sqp_1/manifest.json")],
        public_keys: vec![],
        byte_size: 100,
        object_count: 1,
        video_seconds: 0,
        reason: "expired_upload".into(),
        lapse_at: None,
        profile_generation: None,
        object_etag: None,
        prior_status: "completed".into(),
        deletion_started: false,
        private_done: true,
        public_done: true,
        purge_done: false,
    };
    l.validate().unwrap();
    assert!(!l.ready_to_release());
    let mut x = l.clone();
    x.private_keys[0] = "square/CN456/posts/sqp_1/manifest.json".into();
    assert!(x.validate().is_err());
    let mut x = l;
    x.purge_done = true;
    assert!(x.ready_to_release());
}
#[test]
fn export_public_workerd_fixture() {
    let f = Fixture::new(3_000_000_000, 1_000_000);
    f.facts();
    if std::env::var_os("CITIZENSERVE_WRITE_STEP6_FIXTURE").is_some() {
        let fixture = json!({"description":"公开合成metadata/storage，仅测试；时间由workerd拦截器按测试时钟提供","cid":CID,"account":format!("0x{}","cd".repeat(32)),"genesis":hash(0),"head":hash(9),"metadata":format!("0x{}",crypto::hex(&f.raw)),"storage":f.values,"timestamp_key":citizenserve::chain::scale::value_key("Timestamp","Now")});
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/test/contract/maintenance.json"
            ),
            serde_json::to_vec_pretty(&fixture).unwrap(),
        )
        .unwrap();
    }
}
