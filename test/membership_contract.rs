//! 合成完整 metadata 和真实钱包签名；不把这些向量称为线上RPC验收。
#![allow(dead_code)] // metadata必须包含拒绝/未使用的完整枚举分支。
use citizenserve::{
    chain::{
        scale::{self, Metadata},
        subscription, transaction,
    },
    membership::{self, Level, Status},
    shared::crypto,
};
use frame_metadata::v14::*;
use parity_scale_codec::{Compact, Encode};
use scale_info::{meta_type, TypeInfo};
use std::marker::PhantomData;
#[derive(Encode, TypeInfo)]
enum Address {
    #[codec(index = 5)]
    Id([u8; 32]),
    Index(u32),
}
#[derive(Encode, TypeInfo)]
enum Signature {
    #[codec(index = 3)]
    Sr25519([u8; 64]),
    Ed25519([u8; 64]),
}
#[derive(Encode, TypeInfo)]
#[allow(non_camel_case_types)] // SCALE调用名称必须与runtime一致。
enum Call {
    #[codec(index = 17)]
    subscribe {
        issuer: Issuer,
        plan: Plan,
        expected_price_fen: u128,
    },
}
#[derive(Encode, TypeInfo)]
enum RuntimeCall {
    #[codec(index = 137)]
    SquarePost(Call),
    Other(Vec<u8>),
}
#[derive(TypeInfo)]
struct Extrinsic<Address, Call, Signature, Extra>(PhantomData<(Address, Call, Signature, Extra)>);
#[derive(Encode, TypeInfo)]
enum Issuer {
    #[codec(index = 9)]
    Platform,
    #[codec(index = 11)]
    Creator(Vec<u8>),
}
#[derive(Encode, TypeInfo)]
enum ChainLevel {
    Freedom,
    Democracy,
    Spark,
}
#[derive(Encode, TypeInfo)]
enum Period {
    Monthly,
    Quarterly,
    Yearly,
}
#[derive(Encode, TypeInfo)]
enum Plan {
    Platform {
        membership_level: ChainLevel,
    },
    Creator {
        tier_id: Vec<u8>,
        billing_period: Period,
    },
}
#[derive(Encode, TypeInfo)]
enum ChainStatus {
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
    subscription_status: ChainStatus,
    authorized_price_fen: u128,
    suspend_reason: Option<Reason>,
}
#[derive(Encode, TypeInfo)]
enum Phase {
    ApplyExtrinsic(u32),
    Initialization,
    Finalization,
}
#[derive(Encode, TypeInfo)]
enum SystemEvent {
    ExtrinsicSuccess,
    ExtrinsicFailed,
}
#[derive(Encode, TypeInfo)]
enum SquareEvent {
    SubscriptionCharged {
        subscriber_cid_number: Vec<u8>,
        issuer: Issuer,
        plan: Plan,
        price_fen: u128,
        charged_at: u64,
        paid_until: u64,
    },
}
#[derive(Encode, TypeInfo)]
enum Event {
    System(SystemEvent),
    SquarePost(SquareEvent),
    Other(Vec<u8>),
}
#[derive(Encode, TypeInfo)]
struct Record {
    phase: Phase,
    event: Event,
    topics: Vec<[u8; 32]>,
}
fn entry<T: TypeInfo + 'static>(name: &'static str, map: bool) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Optional,
        ty: if map {
            StorageEntryType::Map {
                hashers: vec![StorageHasher::Blake2_128Concat],
                key: meta_type::<(Vec<u8>, Issuer)>(),
                value: meta_type::<T>(),
            }
        } else {
            StorageEntryType::Plain(meta_type::<T>())
        },
        default: vec![],
        docs: vec![],
    }
}
fn raw_metadata() -> Vec<u8> {
    let m = RuntimeMetadataV14::new(
        vec![
            pallet("System", vec![plain::<Vec<Record>>("Events")]),
            pallet("Timestamp", vec![plain::<u64>("Now")]),
            pallet(
                "CitizenIdentity",
                vec![
                    map::<Vec<u8>, [u8; 32]>("CidByAccountId"),
                    map::<[u8; 32], Vec<u8>>("AccountIdByCid"),
                    map::<u64, Vec<u8>>("BindingRevisionByCid"),
                    map::<CidRecord, Vec<u8>>("CidRegistry"),
                    map::<Voting, Vec<u8>>("VotingIdentityByCid"),
                    map::<u32, Vec<u8>>("CandidateIdentityByCid"),
                ],
            ),
            PalletMetadata {
                name: "SquarePost",
                storage: Some(PalletStorageMetadata {
                    prefix: "SquarePost",
                    entries: vec![
                        entry::<State>("Subscriptions", true),
                        entry::<Vec<Record>>("Events", false),
                        StorageEntryMetadata {
                            name: "PlatformPrice",
                            modifier: StorageEntryModifier::Optional,
                            ty: StorageEntryType::Map {
                                hashers: vec![StorageHasher::Twox64Concat],
                                key: meta_type::<ChainLevel>(),
                                value: meta_type::<u128>(),
                            },
                            default: vec![],
                            docs: vec![],
                        },
                        map::<Vec<Tier>, Vec<u8>>("CreatorPlans"),
                        StorageEntryMetadata {
                            name: "CreatorTierNames",
                            modifier: StorageEntryModifier::Optional,
                            ty: StorageEntryType::Map {
                                hashers: vec![
                                    StorageHasher::Blake2_128Concat,
                                    StorageHasher::Blake2_128Concat,
                                ],
                                key: meta_type::<(Vec<u8>, Vec<u8>)>(),
                                value: meta_type::<Vec<u8>>(),
                            },
                            default: vec![],
                            docs: vec![],
                        },
                    ],
                }),
                calls: Some(PalletCallMetadata {
                    ty: meta_type::<Call>(),
                }),
                event: None,
                constants: vec![],
                error: None,
                index: 137,
            },
        ],
        ExtrinsicMetadata {
            ty: meta_type::<Extrinsic<Address, RuntimeCall, Signature, Compact<u32>>>(),
            version: 4,
            signed_extensions: vec![SignedExtensionMetadata {
                identifier: "CheckNonce",
                ty: meta_type::<Compact<u32>>(),
                additional_signed: meta_type::<()>(),
            }],
        },
        meta_type::<()>(),
    );
    frame_metadata::RuntimeMetadataPrefixed::from(m).encode()
}
fn state(status: ChainStatus) -> State {
    State {
        plan: Plan::Platform {
            membership_level: ChainLevel::Spark,
        },
        started_at: 900000,
        last_charged_at: 1000000,
        last_charged_price_fen: 5999900,
        paid_until: 2000000,
        subscription_status: status,
        authorized_price_fen: 5999900,
        suspend_reason: None,
    }
}
fn decoded(s: &State) -> subscription::State {
    let m = metadata();
    subscription::state(
        &m.decode(
            &s.encode(),
            m.storage_type("SquarePost", "Subscriptions", true).unwrap(),
        )
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn full_signed_extrinsic_uses_metadata_indices_and_real_sr25519_signature() {
    let m = metadata();
    let pair = schnorrkel::MiniSecretKey::from_bytes(&[7; 32])
        .unwrap()
        .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
    let call = RuntimeCall::SquarePost(Call::subscribe {
        issuer: Issuer::Platform,
        plan: Plan::Platform {
            membership_level: ChainLevel::Spark,
        },
        expected_price_fen: 5999900,
    });
    let mut payload = call.encode();
    payload.extend(Compact(12u32).encode());
    let signature = pair.sign_simple(b"substrate", &payload);
    pair.public
        .verify_simple(b"substrate", &payload, &signature)
        .unwrap();
    let mut body = vec![0x84];
    body.extend(Address::Id(pair.public.to_bytes()).encode());
    body.extend(Signature::Sr25519(signature.to_bytes()).encode());
    body.extend(Compact(12u32).encode());
    body.extend(call.encode());
    let mut raw = Compact(body.len() as u32).encode();
    raw.extend(body);
    let decoded = transaction::decode(&m, &raw).unwrap();
    assert_eq!(
        decoded.account,
        format!("0x{}", crypto::hex(&pair.public.to_bytes()))
    );
    assert_eq!(scale::variant(&decoded.call).unwrap(), "subscribe");
    let before = transaction::hash(&raw);
    raw.push(0);
    assert_ne!(transaction::hash(&raw), before);
    assert!(transaction::decode(&m, &raw).is_err());
    raw.pop();
    let prefix = Compact::<u32>((raw.len() - 2) as u32).encode().len();
    raw[prefix] = 0x45;
    assert!(transaction::decode(&m, &raw).is_err());
}
// 这里只测metadata驱动的完整解码；钱包密码学和canonical RPC分别由其他合同覆盖。
fn decoder_vector() -> Vec<u8> {
    let mut body = vec![0x84];
    body.extend(Address::Id([7; 32]).encode());
    body.extend(Signature::Sr25519([8; 64]).encode());
    body.extend(Compact(12u32).encode());
    body.extend(
        RuntimeCall::SquarePost(Call::subscribe {
            issuer: Issuer::Platform,
            plan: Plan::Platform {
                membership_level: ChainLevel::Spark,
            },
            expected_price_fen: 5999900,
        })
        .encode(),
    );
    let mut raw = Compact(body.len() as u32).encode();
    raw.extend(body);
    raw
}
fn outer_enums() -> frame_metadata::v15::OuterEnums {
    frame_metadata::v15::OuterEnums {
        call_enum_ty: meta_type::<RuntimeCall>(),
        event_enum_ty: meta_type::<Event>(),
        error_enum_ty: meta_type::<()>(),
    }
}
#[test]
fn metadata_v15_uses_explicit_address_signature_call_and_extension_types() {
    use frame_metadata::v15 as v;
    let m = v::RuntimeMetadataV15::new(
        vec![],
        v::ExtrinsicMetadata {
            version: 4,
            address_ty: meta_type::<Address>(),
            call_ty: meta_type::<RuntimeCall>(),
            signature_ty: meta_type::<Signature>(),
            extra_ty: meta_type::<Compact<u32>>(),
            signed_extensions: vec![v::SignedExtensionMetadata {
                identifier: "CheckNonce",
                ty: meta_type::<Compact<u32>>(),
                additional_signed: meta_type::<()>(),
            }],
        },
        meta_type::<()>(),
        vec![],
        outer_enums(),
        v::CustomMetadata {
            map: Default::default(),
        },
    );
    let m = Metadata::read(&frame_metadata::RuntimeMetadataPrefixed::from(m).encode()).unwrap();
    let mut raw = decoder_vector();
    assert_eq!(
        scale::variant(&transaction::decode(&m, &raw).unwrap().call).unwrap(),
        "subscribe"
    );
    raw.pop();
    assert!(transaction::decode(&m, &raw).is_err());
}
#[test]
fn metadata_v16_extension_version_selects_registered_indices_and_rejects_unknown() {
    use frame_metadata::v16 as v;
    let mut m = v::RuntimeMetadataV16::new(
        vec![],
        v::ExtrinsicMetadata {
            versions: vec![4, 5],
            address_ty: meta_type::<Address>(),
            call_ty: meta_type::<RuntimeCall>(),
            signature_ty: meta_type::<Signature>(),
            transaction_extensions_by_version: std::collections::BTreeMap::from([(
                0,
                vec![Compact(1)],
            )]),
            transaction_extensions: vec![
                v::TransactionExtensionMetadata {
                    identifier: "Unused",
                    ty: meta_type::<u64>(),
                    implicit: meta_type::<()>(),
                },
                v::TransactionExtensionMetadata {
                    identifier: "CheckNonce",
                    ty: meta_type::<Compact<u32>>(),
                    implicit: meta_type::<()>(),
                },
            ],
        },
        vec![],
        outer_enums(),
        v::CustomMetadata {
            map: Default::default(),
        },
    );
    let raw = decoder_vector();
    let parsed =
        Metadata::read(&frame_metadata::RuntimeMetadataPrefixed::from(m.clone()).encode()).unwrap();
    assert_eq!(
        scale::variant(&transaction::decode(&parsed, &raw).unwrap().call).unwrap(),
        "subscribe"
    );
    m.extrinsic
        .transaction_extensions_by_version
        .insert(0, vec![Compact(2)]);
    assert!(
        Metadata::read(&frame_metadata::RuntimeMetadataPrefixed::from(m.clone()).encode()).is_err()
    );
    m.extrinsic.transaction_extensions_by_version.clear();
    assert!(Metadata::read(&frame_metadata::RuntimeMetadataPrefixed::from(m).encode()).is_err());
}
#[test]
fn key_type_and_issuer_variant_indices_are_derived_from_metadata() {
    let m = metadata();
    let p = subscription::key(&m, "CID1", None).unwrap();
    assert_eq!(p.last(), Some(&9));
    let c = subscription::key(&m, "CID1", Some("CID2")).unwrap();
    assert_eq!(c[5], 11);
    assert_ne!(p, c);
    assert!(subscription::key(&m, "CID1", Some("bad/path")).is_err());
}
#[test]
fn success_requires_exact_phase_and_one_success_without_any_failure() {
    let m = metadata();
    let ty = m.storage_type("SquarePost", "Events", false).unwrap();
    let build = |events: Vec<Record>| m.decode(&events.encode(), ty).unwrap();
    let good = Record {
        phase: Phase::ApplyExtrinsic(4),
        event: Event::System(SystemEvent::ExtrinsicSuccess),
        topics: vec![],
    };
    assert!(transaction::successful(&build(vec![good]), 4).is_ok());
    assert!(transaction::successful(
        &build(vec![Record {
            phase: Phase::ApplyExtrinsic(5),
            event: Event::System(SystemEvent::ExtrinsicSuccess),
            topics: vec![]
        }]),
        4
    )
    .is_err());
    assert!(transaction::successful(
        &build(vec![
            Record {
                phase: Phase::ApplyExtrinsic(4),
                event: Event::System(SystemEvent::ExtrinsicSuccess),
                topics: vec![]
            },
            Record {
                phase: Phase::ApplyExtrinsic(4),
                event: Event::System(SystemEvent::ExtrinsicFailed),
                topics: vec![]
            }
        ]),
        4
    )
    .is_err());
}
#[test]
fn prices_decode_full_u128_and_only_wire_conversion_rejects_overflow() {
    let mut s = state(ChainStatus::Active);
    s.authorized_price_fen = u128::MAX;
    let d = decoded(&s);
    assert_eq!(d.authorized_price_fen, u128::MAX);
    assert!(d.wire().is_err());
    assert_eq!(
        subscription::safe_price(9007199254740991).unwrap(),
        9007199254740991
    );
    assert!(subscription::safe_price(9007199254740992).is_err());
}
#[test]
fn current_rights_follow_status_and_maximum_clock() {
    for st in [ChainStatus::Active, ChainStatus::Cancelled] {
        let d = decoded(&state(st));
        assert!(d.active(1000000, 1000001));
        assert!(!d.active(1000000, 2000000));
    }
    for st in [ChainStatus::Terminated, ChainStatus::IssuerPaused] {
        assert!(!decoded(&state(st)).active(1000000, 1000000));
    }
    let mut s = state(ChainStatus::Suspended);
    s.suspend_reason = Some(Reason::IdentityBindingUnavailable);
    assert!(!decoded(&s).active(1000000, 1000000));
}
#[test]
fn unicode_tier_names_and_complete_plan_limits() {
    assert!(membership::creator::name(&"😀".repeat(20)).is_ok());
    assert!(membership::creator::name(&"😀".repeat(21)).is_err());
    assert!(membership::creator::name(" name").is_err());
    assert_eq!(
        membership::limits::limits(Level::Spark).storage_bytes,
        10_000_000_000_000
    );
    assert!(!membership::Membership {
        level: Level::Spark,
        status: Status::Suspended,
        paid_until_millis: 2000000
    }
    .active(1000000));
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("contract/subscription.json")).unwrap();
    assert_eq!(fixture["safe_integer_max"], 9007199254740991u64);
}

fn metadata() -> Metadata {
    Metadata::read(&raw_metadata()).unwrap()
}
#[derive(Encode, TypeInfo)]
enum CidStatus {
    Active,
    Revoked,
}
#[derive(Encode, TypeInfo)]
struct CidRecord {
    status: CidStatus,
    revoked_at: Option<u32>,
    registered_at: u32,
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
struct PeriodPrice {
    billing_period: Period,
    price_fen: u128,
}
#[derive(Encode, TypeInfo)]
struct Tier {
    tier_id: Vec<u8>,
    prices_fen: Vec<PeriodPrice>,
}
fn plain<T: TypeInfo + 'static>(name: &'static str) -> StorageEntryMetadata {
    entry::<T>(name, false)
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
        index: 1,
    }
}
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(r) => r,
        Poll::Pending => panic!("synthetic RPC resolves immediately"),
    }
}
struct Rpc {
    values: BTreeMap<String, serde_json::Value>,
    raw: Vec<u8>,
    account: String,
    extrinsic: Vec<u8>,
    bad_header: bool,
    bad_genesis: bool,
    calls: Mutex<Vec<(String, serde_json::Value)>>,
}
const CID: &str = "CN220-CTZN2-198805201-2026";
fn h(n: u8) -> String {
    format!("0x{}", crypto::hex(&[n; 32]))
}
fn header() -> serde_json::Value {
    serde_json::json!({"number":"0x9","parentHash":h(8),"stateRoot":h(21),"extrinsicsRoot":h(22),"digest":{"logs":[]}})
}
impl Rpc {
    fn new() -> Self {
        let raw = raw_metadata();
        let m = Metadata::read(&raw).unwrap();
        let mut values = BTreeMap::new();
        let pair = schnorrkel::MiniSecretKey::from_bytes(&[7; 32])
            .unwrap()
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
        let account = format!("0x{}", crypto::hex(&pair.public.to_bytes()));
        let call = RuntimeCall::SquarePost(Call::subscribe {
            issuer: Issuer::Platform,
            plan: Plan::Platform {
                membership_level: ChainLevel::Spark,
            },
            expected_price_fen: 5999900,
        });
        let mut message = call.encode();
        message.extend(Compact(12u32).encode());
        let sig = pair.sign_simple(b"substrate", &message);
        let mut bytes = vec![0x84];
        bytes.extend(Address::Id(pair.public.to_bytes()).encode());
        bytes.extend(Signature::Sr25519(sig.to_bytes()).encode());
        bytes.extend(Compact(12u32).encode());
        bytes.extend(call.encode());
        let mut extrinsic = Compact(bytes.len() as u32).encode();
        extrinsic.extend(bytes);
        let mut put = |p: &str, n: &str, k: Option<&[u8]>, data: Vec<u8>| {
            values.insert(
                k.map(|k| scale::map_key(p, n, k))
                    .unwrap_or_else(|| scale::value_key(p, n)),
                serde_json::json!(format!("0x{}", crypto::hex(&data))),
            );
        };
        let cid = crypto::scale_string(CID).unwrap();
        put(
            "CitizenIdentity",
            "CidByAccountId",
            Some(&pair.public.to_bytes()),
            CID.as_bytes().to_vec().encode(),
        );
        put(
            "CitizenIdentity",
            "AccountIdByCid",
            Some(&cid),
            pair.public.to_bytes().encode(),
        );
        put(
            "CitizenIdentity",
            "BindingRevisionByCid",
            Some(&cid),
            1u64.encode(),
        );
        put(
            "CitizenIdentity",
            "CidRegistry",
            Some(&cid),
            CidRecord {
                status: CidStatus::Active,
                revoked_at: None,
                registered_at: 9,
            }
            .encode(),
        );
        put("Timestamp", "Now", None, 1000000u64.encode());
        put(
            "SquarePost",
            "Subscriptions",
            Some(&subscription::key(&m, CID, None).unwrap()),
            state(ChainStatus::Active).encode(),
        );
        put(
            "SquarePost",
            "CreatorPlans",
            Some(&cid),
            vec![Tier {
                tier_id: b"tier1".to_vec(),
                prices_fen: vec![
                    PeriodPrice {
                        billing_period: Period::Monthly,
                        price_fen: 100,
                    },
                    PeriodPrice {
                        billing_period: Period::Quarterly,
                        price_fen: 250,
                    },
                    PeriodPrice {
                        billing_period: Period::Yearly,
                        price_fen: 900,
                    },
                ],
            }]
            .encode(),
        );
        let events = vec![
            Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::System(SystemEvent::ExtrinsicSuccess),
                topics: vec![],
            },
            Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::SquarePost(SquareEvent::SubscriptionCharged {
                    subscriber_cid_number: CID.as_bytes().to_vec(),
                    issuer: Issuer::Platform,
                    plan: Plan::Platform {
                        membership_level: ChainLevel::Spark,
                    },
                    price_fen: 5999900,
                    charged_at: 1000000,
                    paid_until: 2000000,
                }),
                topics: vec![],
            },
        ];
        put("System", "Events", None, events.encode());
        for (l, p) in [
            (ChainLevel::Freedom, 199900u128),
            (ChainLevel::Democracy, 599900),
            (ChainLevel::Spark, 5999900),
        ] {
            values.insert(
                m.storage_key("SquarePost", "PlatformPrice", &[l.encode()])
                    .unwrap()
                    .0,
                serde_json::json!(format!("0x{}", crypto::hex(&p.encode()))),
            );
        }
        values.insert(
            m.storage_key(
                "SquarePost",
                "CreatorTierNames",
                &[cid, crypto::scale_string("tier1").unwrap()],
            )
            .unwrap()
            .0,
            serde_json::json!(format!(
                "0x{}",
                crypto::hex(&"😀".repeat(20).as_bytes().to_vec().encode())
            )),
        );
        Self {
            values,
            raw,
            account,
            extrinsic,
            bad_header: false,
            bad_genesis: false,
            calls: Mutex::new(vec![]),
        }
    }
}
impl citizenserve::chain::ports::Rpc for Rpc {
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> citizenserve::shared::Result<serde_json::Value> {
        use serde_json::json;
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        Ok(match method {
            "chain_getFinalizedHead" => json!(h(9)),
            "chain_getBlockHash" => {
                if params[0] == 0 {
                    json!(if self.bad_genesis { h(1) } else { h(0) })
                } else if params[0] == 9 {
                    json!(h(9))
                } else {
                    json!(h(8))
                }
            }
            "chain_getHeader" => header(),
            "state_getMetadata" => json!(format!("0x{}", crypto::hex(&self.raw))),
            "state_getStorage" => self
                .values
                .get(params[0].as_str().unwrap())
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "chain_getBlock" => {
                let mut hdr = header();
                if self.bad_header {
                    hdr["stateRoot"] = json!(h(33));
                }
                json!({"block":{"header":hdr,"extrinsics":[format!("0x{}",crypto::hex(&self.extrinsic))]}})
            }
            _ => {
                return Err(citizenserve::shared::Error::new(
                    503,
                    "synthetic_unknown_rpc",
                ))
            }
        })
    }
}
#[test]
fn whole_finalized_transaction_checks_hash_signer_genesis_header_and_success_phase() {
    let r = Rpc::new();
    let input = transaction::Confirm {
        tx_hash: transaction::hash(&r.extrinsic),
        block_hash: h(9),
    };
    let v = run(transaction::verify(
        &r,
        &h(0),
        CID,
        &r.account,
        &input,
        1000000,
    ))
    .unwrap();
    assert_eq!(v.evidence.extrinsic_index, 0);
    assert_eq!(v.evidence.block_hash, h(9));
    assert!(r
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "state_getStorage")
        .all(|(_, p)| p[1] == h(9)));
    let mut r = Rpc::new();
    r.bad_header = true;
    assert!(run(transaction::verify(
        &r,
        &h(0),
        CID,
        &r.account,
        &input,
        1000000
    ))
    .is_err());
    r.bad_header = false;
    r.bad_genesis = true;
    assert!(run(transaction::verify(
        &r,
        &h(0),
        CID,
        &r.account,
        &input,
        1000000
    ))
    .is_err());
    let r = Rpc::new();
    assert!(run(transaction::verify(&r, &h(0), CID, &h(2), &input, 1000000)).is_err());
}
#[test]
fn platform_current_deadline_and_same_anchor_creator_names_prices_are_real_reads() {
    let r = Rpc::new();
    let current = run(subscription::platform(&r, &h(0), CID, &r.account, 1000000)).unwrap();
    assert_eq!(current.level(1000001).unwrap(), Level::Spark);
    assert!(current.require(1060000).is_err());
    assert!(current.require(999999).is_err());
    let m = Metadata::read(&r.raw).unwrap();
    let tiers = run(membership::creator::tiers(&r, &m, &current.anchor, CID)).unwrap();
    assert_eq!(tiers[0].tier_name, "😀".repeat(20));
    assert_eq!(tiers[0].quarterly_price_fen, Some(250));
    let mut r = Rpc::new();
    let key = m
        .storage_key(
            "SquarePost",
            "CreatorTierNames",
            &[
                crypto::scale_string(CID).unwrap(),
                crypto::scale_string("tier1").unwrap(),
            ],
        )
        .unwrap()
        .0;
    r.values.remove(&key);
    assert!(run(membership::creator::tiers(&r, &m, &current.anchor, CID)).is_err());
}

#[test]
fn generic_signed_decoder_does_not_weaken_original_squarepost_wrapper() {
    let raw = decoder_vector();
    let m = metadata();
    let signed = transaction::decode_signed(&m, &raw).unwrap();
    assert_eq!(scale::variant(&signed.call).unwrap(), "SquarePost");
    assert!(transaction::decode_for(&m, &raw, "OnchainTransaction").is_err());
    assert!(transaction::decode(&m, &raw).is_ok());
    let mut body = vec![0x84];
    body.extend(Address::Id([7; 32]).encode());
    body.extend(Signature::Sr25519([8; 64]).encode());
    body.extend(Compact(12u32).encode());
    body.extend(RuntimeCall::Other(vec![1]).encode());
    let mut other = Compact(body.len() as u32).encode();
    other.extend(body);
    assert!(transaction::decode_signed(&m, &other).is_ok());
    assert!(transaction::decode(&m, &other).is_err());
}

struct NoticeRepository {
    notice: Option<membership::cleanup::Notice>,
    used: u64,
}
impl membership::ports::Repository for NoticeRepository {
    async fn cleanup_notice(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
    ) -> citizenserve::shared::Result<Option<membership::cleanup::Notice>> {
        Ok(self.notice.clone())
    }
    async fn usage(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: u64,
    ) -> citizenserve::shared::Result<membership::ports::Usage> {
        Ok(membership::ports::Usage {
            used_bytes: self.used,
            ..Default::default()
        })
    }
    async fn project(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: &membership::projection::Batch,
    ) -> citizenserve::shared::Result<()> {
        unreachable!()
    }
    async fn overview(
        &self,
        _: &citizenserve::user::profile_service::Authorization,
        _: &subscription::Current,
    ) -> citizenserve::shared::Result<membership::creator::Overview> {
        unreachable!()
    }
    async fn cursor(
        &self,
    ) -> citizenserve::shared::Result<Option<citizenserve::chain::finalized::Anchor>> {
        unreachable!()
    }
    async fn commit_block(
        &self,
        _: Option<&citizenserve::chain::finalized::Anchor>,
        _: &membership::projection::Batch,
    ) -> citizenserve::shared::Result<()> {
        unreachable!()
    }
}
#[test]
fn membership_response_only_exposes_current_inactive_overage_notice() {
    use citizenserve::{
        server::guard,
        user::{
            admission::Admission,
            auth::{device::Device, session::Session},
            profile_service::Authorization,
            registration::protocol::{Config, Institution},
        },
    };
    let rpc = Rpc::new();
    let mut current = run(subscription::platform(
        &rpc,
        &h(0),
        CID,
        &rpc.account,
        1000000,
    ))
    .unwrap();
    let m = Metadata::read(&rpc.raw).unwrap();
    let i = run(citizenserve::chain::identity::by_cid(
        &rpc,
        &m,
        &current.anchor,
        CID,
        &h(0),
        1000000,
    ))
    .unwrap()
    .unwrap();
    let config = Config {
        registration_scope: "citizenserve:fixture".into(),
        service_origin: "https://registration.example.test".into(),
        chain_scope: h(0),
        site_key: "public-test-key".into(),
    };
    let device = Device {
        cid_number: CID.into(),
        device_id: "ab".repeat(32),
        public_key: format!("0x{}", "ab".repeat(32)),
        account_id: rpc.account.clone(),
        binding_revision: 1,
        active: true,
        issued_at: 900000,
        created_at: 900000,
        updated_at: 900000,
    };
    let admission = Admission {
        cid_number: CID.into(),
        enrollment_id: "00000000-0000-4000-8000-000000000001".into(),
        source: "turnstile".into(),
        human_verified_at_millis: 999999,
        registration_scope: config.registration_scope.clone(),
        service_origin: config.service_origin.clone(),
        chain_scope: h(0),
        institution: Institution::CTZN,
    };
    let token = format!("sqs_{}", "12".repeat(16));
    let session = Session {
        session_token_hash: citizenserve::user::auth::session::hash(&token).unwrap(),
        cid_number: CID.into(),
        account_id: rpc.account.clone(),
        binding_revision: 1,
        device_id: device.device_id.clone(),
        created_at: 999999,
        expires_at: 2000000,
    };
    let authority =
        guard::session_authority(&i, &admission, &device, &session, &config, 1000000).unwrap();
    let auth = Authorization::new(&authority, &config, &token, 1000000).unwrap();
    let mut repo = NoticeRepository {
        notice: Some(membership::cleanup::Notice::new(2000000, 1000000).unwrap()),
        used: 100000000001,
    };
    assert!(
        run(membership::service::current(&repo, &auth, &current)).unwrap()
            ["storage_cleanup_notice"]
            .is_null()
    );
    current.state.as_mut().unwrap().status = Status::Terminated;
    assert_eq!(
        run(membership::service::current(&repo, &auth, &current)).unwrap()
            ["storage_cleanup_notice"]["lapse_at"],
        2000000
    );
    repo.used = 100000000000;
    assert!(
        run(membership::service::current(&repo, &auth, &current)).unwrap()
            ["storage_cleanup_notice"]
            .is_null()
    );
    repo.used += 1;
    repo.notice.as_mut().unwrap().lapse_at = 1999999;
    assert!(
        run(membership::service::current(&repo, &auth, &current)).unwrap()
            ["storage_cleanup_notice"]
            .is_null()
    );
}
