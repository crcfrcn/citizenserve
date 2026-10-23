//! 完整合成metadata/SCALE/已签名交易及canonical RPC；不冒充线上链验收。
#![allow(dead_code)] // metadata必须包含实际拒绝分支。
use citizenserve::{
    chain::{scale::Metadata, settlement, transaction},
    shared::crypto,
};
use frame_metadata::v14::*;
use parity_scale_codec::{Compact, Encode};
use scale_info::{meta_type, TypeInfo};
use serde_json::{json, Value};
use std::{
    future::Future,
    marker::PhantomData,
    task::{Context, Poll, Waker},
};
#[derive(Encode, TypeInfo)]
enum Address {
    #[codec(index = 5)]
    Id([u8; 32]),
    Index(u32),
}
#[derive(Encode, TypeInfo)]
enum Signature {
    #[codec(index = 3)]
    Ed25519([u8; 64]),
    Sr25519([u8; 64]),
}
#[derive(TypeInfo)]
struct Extrinsic<Address, Call, Signature, Extra>(PhantomData<(Address, Call, Signature, Extra)>);
#[derive(Encode, TypeInfo)]
#[allow(non_camel_case_types)]
enum Call {
    #[codec(index = 19)]
    transfer_with_remark {
        beneficiary_account_id: [u8; 32],
        amount: u128,
        remark: Vec<u8>,
    },
    other,
}
#[derive(Encode, TypeInfo)]
enum RuntimeCall {
    #[codec(index = 142)]
    OnchainTransaction(Call),
    SquarePost(Vec<u8>),
}
#[derive(Encode, TypeInfo)]
enum Phase {
    ApplyExtrinsic(u32),
    Initialization,
    Finalization,
}
#[derive(Encode, TypeInfo)]
enum SystemEvent {
    #[codec(index = 8)]
    ExtrinsicSuccess,
    ExtrinsicFailed,
}
#[derive(Encode, TypeInfo)]
enum TransferEvent {
    #[codec(index = 27)]
    TransferWithRemark {
        from_account_id: [u8; 32],
        beneficiary_account_id: [u8; 32],
        amount: u128,
        remark: Vec<u8>,
    },
}
#[derive(Encode, TypeInfo)]
enum Event {
    #[codec(index = 3)]
    System(SystemEvent),
    #[codec(index = 142)]
    OnchainTransaction(TransferEvent),
}
#[derive(Encode, TypeInfo)]
struct AccountData {
    free: u128,
    frozen: u128,
}
#[derive(Encode, TypeInfo)]
struct AccountInfo {
    nonce: u32,
    data: AccountData,
}
#[derive(Encode, TypeInfo)]
struct Record {
    phase: Phase,
    event: Event,
    topics: Vec<[u8; 32]>,
}
#[derive(Encode, TypeInfo, Clone)]
struct Bounded<T>(Vec<T>);
#[derive(Encode, TypeInfo, Clone)]
struct Clause {
    number: u32,
    text: Bounded<u8>,
    text_en: Option<Bounded<u8>>,
}
#[derive(Encode, TypeInfo, Clone)]
struct Article {
    number: u32,
    title: Bounded<u8>,
    title_en: Option<Bounded<u8>>,
    body: Bounded<u8>,
    body_en: Option<Bounded<u8>>,
    clauses: Bounded<Clause>,
}
#[derive(Encode, TypeInfo, Clone)]
struct Section {
    number: u32,
    title: Bounded<u8>,
    title_en: Option<Bounded<u8>>,
    articles: Bounded<Article>,
}
#[derive(Encode, TypeInfo, Clone)]
struct Chapter {
    number: u32,
    title: Bounded<u8>,
    title_en: Option<Bounded<u8>>,
    sections: Bounded<Section>,
}
#[derive(Encode, TypeInfo)]
enum Tier {
    Constitution,
    National,
}
#[derive(Encode, TypeInfo)]
enum LawStatus {
    Pending,
    Effective,
    Repealed,
}
#[derive(Encode, TypeInfo)]
struct Law {
    law_id: u64,
    tier: Tier,
    scope_code: u32,
    houses: Vec<Vec<u8>>,
    effective_version: Option<u32>,
    latest_version: u32,
    pending_version: Option<u32>,
    status: LawStatus,
}
#[derive(Encode, TypeInfo)]
enum VoteType {
    Special,
    Important,
}
#[derive(Encode, TypeInfo)]
struct LawVersion {
    law_id: u64,
    version: u32,
    title: Bounded<u8>,
    title_en: Option<Bounded<u8>>,
    chapters: Bounded<Chapter>,
    content_hash: [u8; 32],
    vote_type: VoteType,
    proposal_id: u64,
    published_at: u64,
    effective_at: u64,
}
#[derive(Encode, TypeInfo)]
struct Label {
    title: Bounded<u8>,
    title_en: Option<Bounded<u8>>,
}
#[derive(Encode, TypeInfo)]
struct Manifest {
    article_numbers: Bounded<u32>,
    article_hashes: Bounded<[u8; 32]>,
}
fn raw32(s: &str) -> [u8; 32] {
    crypto::unhex(s).unwrap().try_into().unwrap()
}
fn h(n: u8) -> String {
    format!("0x{}", crypto::hex(&[n; 32]))
}
fn entry<V: TypeInfo + 'static, K: TypeInfo + 'static>(
    name: &'static str,
    hashers: Vec<StorageHasher>,
) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Optional,
        ty: if hashers.is_empty() {
            StorageEntryType::Plain(meta_type::<V>())
        } else {
            StorageEntryType::Map {
                hashers,
                key: meta_type::<K>(),
                value: meta_type::<V>(),
            }
        },
        default: vec![],
        docs: vec![],
    }
}
fn pallet(name: &'static str, index: u8, entries: Vec<StorageEntryMetadata>) -> PalletMetadata {
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
        index,
    }
}
#[derive(Encode, TypeInfo)]
enum Era {
    Immortal,
}
#[derive(Encode, TypeInfo)]
enum MetadataMode {
    Disabled,
}
fn metadata() -> Vec<u8> {
    metadata_extensions(false)
}
fn metadata_extensions(full: bool) -> Vec<u8> {
    let mut money = pallet("OnchainTransaction", 142, vec![]);
    money.calls = Some(PalletCallMetadata {
        ty: meta_type::<Call>(),
    });
    let metadata = RuntimeMetadataV14::new(
        vec![
            pallet(
                "System",
                3,
                vec![
                    entry::<Vec<Record>, ()>("Events", vec![]),
                    entry::<AccountInfo, [u8; 32]>(
                        "Account",
                        vec![StorageHasher::Blake2_128Concat],
                    ),
                ],
            ),
            pallet("Timestamp", 4, vec![entry::<u64, ()>("Now", vec![])]),
            money,
            pallet(
                "CitizenIdentity",
                55,
                vec![entry::<Vec<u8>, [u8; 32]>(
                    "CidByAccountId",
                    vec![StorageHasher::Blake2_128Concat],
                )],
            ),
            pallet(
                "LegislationYuan",
                51,
                vec![
                    entry::<Law, u64>("Laws", vec![StorageHasher::Blake2_128Concat]),
                    entry::<LawVersion, (u64, u32)>(
                        "LawVersions",
                        vec![StorageHasher::Blake2_128Concat, StorageHasher::Twox64Concat],
                    ),
                    entry::<Label, (u64, u32)>(
                        "LawVersionLabels",
                        vec![StorageHasher::Blake2_128Concat, StorageHasher::Twox64Concat],
                    ),
                    entry::<Manifest, ()>("ConstitutionImmutableManifest", vec![]),
                ],
            ),
        ],
        ExtrinsicMetadata {
            ty: meta_type::<Extrinsic<Address, RuntimeCall, Signature, Compact<u32>>>(),
            version: 4,
            signed_extensions: if full {
                vec![
                    SignedExtensionMetadata {
                        identifier: "AuthorizeCall",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckNonZeroSender",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckNonStakeSender",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckSpecVersion",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<u32>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckTxVersion",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<u32>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckGenesis",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<[u8; 32]>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckMortality",
                        ty: meta_type::<Era>(),
                        additional_signed: meta_type::<[u8; 32]>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckNonce",
                        ty: meta_type::<Compact<u32>>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckWeight",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "ChargeTransactionPayment",
                        ty: meta_type::<Compact<u128>>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "CheckMetadataHash",
                        ty: meta_type::<MetadataMode>(),
                        additional_signed: meta_type::<Option<[u8; 32]>>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "SetOrigin",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                    SignedExtensionMetadata {
                        identifier: "WeightReclaim",
                        ty: meta_type::<()>(),
                        additional_signed: meta_type::<()>(),
                    },
                ]
            } else {
                vec![SignedExtensionMetadata {
                    identifier: "CheckNonce",
                    ty: meta_type::<Compact<u32>>(),
                    additional_signed: meta_type::<()>(),
                }]
            },
        },
        meta_type::<()>(),
    );
    frame_metadata::RuntimeMetadataPrefixed::from(metadata).encode()
}
fn text(s: &str) -> Bounded<u8> {
    Bounded(s.as_bytes().to_vec())
}
fn fixture_build() -> Value {
    use ed25519_dalek::Signer;
    let base: Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/test/contract/topup.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut o = base["order"].clone();
    let signer = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let account = signer.verifying_key().to_bytes();
    let remark = format!("topup:{}", o["order_id"].as_str().unwrap()).into_bytes();
    let call = RuntimeCall::OnchainTransaction(Call::transfer_with_remark {
        beneficiary_account_id: raw32(o["intent"]["account_id"].as_str().unwrap()),
        amount: 1000000,
        remark: remark.clone(),
    });
    let mut payload = call.encode();
    payload.extend(Compact(12u32).encode());
    let signature = signer.sign(&payload);
    signer
        .verifying_key()
        .verify_strict(&payload, &signature)
        .unwrap();
    let mut bytes = vec![0x84];
    bytes.extend(Address::Id(account).encode());
    bytes.extend(Signature::Ed25519(signature.to_bytes()).encode());
    bytes.extend(Compact(12u32).encode());
    bytes.extend(call.encode());
    let mut raw = Compact(bytes.len() as u32).encode();
    raw.extend(bytes);
    o["phase"] = json!("signed");
    o["signed"] = json!({"account_id":format!("0x{}",crypto::hex(&account)),"nonce":12,"extrinsic":format!("0x{}",crypto::hex(&raw)),"tx_hash":transaction::hash(&raw),"born":8,"claim":format!("tpc_{}","33".repeat(16))});
    let meta = metadata();
    let m = Metadata::read(&meta).unwrap();
    let mut storage = serde_json::Map::new();
    let mut put = |p: &str, n: &str, keys: Vec<Vec<u8>>, data: Vec<u8>| {
        storage.insert(
            if keys.is_empty() {
                citizenserve::chain::scale::value_key(p, n)
            } else {
                m.storage_key(p, n, &keys).unwrap().0
            },
            json!(format!("0x{}", crypto::hex(&data))),
        );
    };
    put("Timestamp", "Now", vec![], 1005000u64.encode());
    put(
        "System",
        "Events",
        vec![],
        vec![
            Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::System(SystemEvent::ExtrinsicSuccess),
                topics: vec![],
            },
            Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::OnchainTransaction(TransferEvent::TransferWithRemark {
                    from_account_id: account,
                    beneficiary_account_id: raw32(o["intent"]["account_id"].as_str().unwrap()),
                    amount: 1000000,
                    remark,
                }),
                topics: vec![],
            },
        ]
        .encode(),
    );
    let article = Article {
        number: 1,
        title: text("第一条"),
        title_en: Some(text("Article 1")),
        body: text("公民宪法"),
        body_en: Some(text("Citizen Constitution")),
        clauses: Bounded(vec![Clause {
            number: 1,
            text: text("正文"),
            text_en: Some(text("Text")),
        }]),
    };
    let chapters = Bounded(vec![Chapter {
        number: 1,
        title: text("第一章"),
        title_en: None,
        sections: Bounded(vec![Section {
            number: 1,
            title: text("第一节"),
            title_en: None,
            articles: Bounded(vec![article.clone()]),
        }]),
    }]);
    put(
        "LegislationYuan",
        "Laws",
        vec![0u64.encode()],
        Law {
            law_id: 0,
            tier: Tier::Constitution,
            scope_code: 0,
            houses: vec![b"House".to_vec()],
            effective_version: Some(1),
            latest_version: 2,
            pending_version: Some(2),
            status: LawStatus::Pending,
        }
        .encode(),
    );
    put(
        "LegislationYuan",
        "LawVersions",
        vec![0u64.encode(), 1u32.encode()],
        LawVersion {
            law_id: 0,
            version: 1,
            title: text("宪法"),
            title_en: None,
            content_hash: raw32(&transaction::hash(&chapters.encode())),
            chapters,
            vote_type: VoteType::Special,
            proposal_id: 1,
            published_at: 900000,
            effective_at: 900000,
        }
        .encode(),
    );
    put(
        "LegislationYuan",
        "LawVersionLabels",
        vec![0u64.encode(), 1u32.encode()],
        Label {
            title: text("正式版"),
            title_en: Some(text("Published")),
        }
        .encode(),
    );
    put(
        "LegislationYuan",
        "ConstitutionImmutableManifest",
        vec![],
        Manifest {
            article_numbers: Bounded(vec![1]),
            article_hashes: Bounded(vec![raw32(&transaction::hash(&article.encode()))]),
        }
        .encode(),
    );
    json!({"schema":"citizenserve.settlement.test.v1","metadata":format!("0x{}",crypto::hex(&meta)),"genesis":h(0),"block_hash":h(9),"header":{"number":"0x9","parentHash":h(8),"stateRoot":h(21),"extrinsicsRoot":h(22),"digest":{"logs":[]}},"storage":storage,"order":o,"disburse_account":format!("0x{}",crypto::hex(&account)),"request":{"gmb_tx_hash":transaction::hash(&raw),"gmb_block_hash":h(9),"gmb_extrinsic_index":0,"signed_extrinsic_hex":format!("0x{}",crypto::hex(&raw))}})
}
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        _ => panic!("synthetic RPC immediately resolves"),
    }
}
struct Rpc(Value);
impl citizenserve::chain::ports::Rpc for Rpc {
    async fn call(&self, method: &str, params: Value) -> citizenserve::shared::Result<Value> {
        let v = &self.0;
        Ok(match method {
            "chain_getFinalizedHead" => v["block_hash"].clone(),
            "chain_getBlockHash" => {
                if params[0] == 0 {
                    v["genesis"].clone()
                } else {
                    v["block_hash"].clone()
                }
            }
            "chain_getHeader" => v["header"].clone(),
            "state_getMetadata" => {
                if params[0] == v["block_hash"] {
                    v.get("post_metadata").unwrap_or(&v["metadata"]).clone()
                } else {
                    v["metadata"].clone()
                }
            }
            "state_getStorage" => v["storage"][params[0].as_str().unwrap()].clone(),
            "chain_getBlock" => {
                json!({"block":{"header":v["header"],"extrinsics":[v["request"]["signed_extrinsic_hex"]]}})
            }
            _ => panic!("unknown mock call"),
        })
    }
}
fn config(v: &Value) -> citizenserve::topup::config::Config {
    use citizenserve::topup::config::{Config, Receivers};
    Config {
        service_origin: "https://www.crcfrcn.com".into(),
        chain_genesis_hash: v["genesis"].as_str().unwrap().into(),
        receivers: Receivers {
            evm: v["order"]["intent"]["recv_address"]
                .as_str()
                .unwrap()
                .into(),
            tron: citizenserve::topup::tron::from_hex(
                v["order"]["intent"]["recv_address"].as_str().unwrap(),
            )
            .unwrap(),
            solana: "11111111111111111111111111111111".into(),
        },
    }
}
#[test]
fn exact_finalized_money_proof_and_complete_golden() {
    let mut v = fixture_build();
    let order = serde_json::from_value(v["order"].clone()).unwrap();
    let request = serde_json::from_value(v["request"].clone()).unwrap();
    let proof = run(settlement::verify(
        &Rpc(v.clone()),
        &config(&v),
        &order,
        &request,
        1005000,
    ))
    .unwrap();
    assert_eq!(proof.amount, "1000000");
    assert_eq!(proof.extrinsic_index, 0);
    v["proof"] = json!(proof);
    v["auto"] = auto_fixture();
    let path = format!(
        "{}/test/contract/settlement.json",
        env!("CARGO_MANIFEST_DIR")
    );
    if std::env::var("UPDATE_STEP5_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap()
    }
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap(),
        v
    );
}
#[test]
fn wrong_beneficiary_amount_remark_signer_index_and_full_bytes_are_rejected() {
    let v = fixture_build();
    for n in 0..6 {
        let mut o: citizenserve::topup::orders::Order =
            serde_json::from_value(v["order"].clone()).unwrap();
        let mut r: settlement::Settled = serde_json::from_value(v["request"].clone()).unwrap();
        let c = config(&v);
        match n {
            0 => o.intent.account_id = h(99),
            1 => o.intent.coin_fen = "999999".into(),
            2 => o.order_id = format!("top_{}", "55".repeat(16)),
            3 => o.signed.as_mut().unwrap().account_id = h(88),
            4 => r.gmb_extrinsic_index = 1,
            5 => r.signed_extrinsic_hex.push_str("00"),
            _ => unreachable!(),
        }
        assert!(
            run(settlement::verify(&Rpc(v.clone()), &c, &o, &r, 1005000)).is_err(),
            "{n}"
        );
    }
}
#[test]
fn successful_phase_event_uniqueness_and_failure_cannot_be_bypassed() {
    let base = fixture_build();
    for n in 0..4 {
        let mut v = base.clone();
        let records = match n {
            0 => vec![Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::System(SystemEvent::ExtrinsicFailed),
                topics: vec![],
            }],
            1 => vec![Record {
                phase: Phase::ApplyExtrinsic(1),
                event: Event::System(SystemEvent::ExtrinsicSuccess),
                topics: vec![],
            }],
            2 => vec![
                Record {
                    phase: Phase::ApplyExtrinsic(0),
                    event: Event::System(SystemEvent::ExtrinsicSuccess),
                    topics: vec![],
                },
                Record {
                    phase: Phase::ApplyExtrinsic(0),
                    event: Event::System(SystemEvent::ExtrinsicSuccess),
                    topics: vec![],
                },
            ],
            _ => vec![Record {
                phase: Phase::ApplyExtrinsic(0),
                event: Event::System(SystemEvent::ExtrinsicSuccess),
                topics: vec![],
            }],
        };
        let k = citizenserve::chain::scale::value_key("System", "Events");
        v["storage"][k] = json!(format!("0x{}", crypto::hex(&records.encode())));
        let o = serde_json::from_value(v["order"].clone()).unwrap();
        let r = serde_json::from_value(v["request"].clone()).unwrap();
        assert!(run(settlement::verify(
            &Rpc(v.clone()),
            &config(&v),
            &o,
            &r,
            1005000
        ))
        .is_err());
    }
}

#[test]
fn runtime_upgrade_call_and_events_use_parent_runtime_metadata() {
    use parity_scale_codec::Decode;
    let mut v = fixture_build();
    let bytes = crypto::unhex(v["metadata"].as_str().unwrap()).unwrap();
    let mut metadata =
        frame_metadata::RuntimeMetadataPrefixed::decode(&mut bytes.as_slice()).unwrap();
    if let frame_metadata::RuntimeMetadata::V14(m) = &mut metadata.1 {
        for ty in &mut m.types.types {
            if ty
                .ty
                .path
                .segments
                .last()
                .is_some_and(|s| s == "RuntimeCall")
            {
                if let scale_info::TypeDef::Variant(ref mut variants) = ty.ty.type_def {
                    for variant in &mut variants.variants {
                        if variant.name == "OnchainTransaction" {
                            variant.index = 143
                        }
                    }
                }
            }
        }
    }
    v["post_metadata"] = json!(format!("0x{}", crypto::hex(&metadata.encode())));
    let o = serde_json::from_value(v["order"].clone()).unwrap();
    let r = serde_json::from_value(v["request"].clone()).unwrap();
    assert!(run(settlement::verify(
        &Rpc(v.clone()),
        &config(&v),
        &o,
        &r,
        1005000
    ))
    .is_ok());
    let bad =
        Metadata::read(&crypto::unhex(v["post_metadata"].as_str().unwrap()).unwrap()).unwrap();
    let raw = crypto::unhex(v["request"]["signed_extrinsic_hex"].as_str().unwrap()).unwrap();
    assert!(transaction::decode_for(&bad, &raw, "OnchainTransaction").is_err());
}

#[test]
fn server_sr25519_builder_uses_metadata_indices_and_native_payload_bytes() {
    use citizenserve::topup::{account::Account, disburse};
    use parity_scale_codec::Decode;
    let v = fixture_build();
    let o = serde_json::from_value(v["order"].clone()).unwrap();
    let m = Metadata::read(&metadata()).unwrap();
    let key = Account::read(&format!("0x{}", "01".repeat(32))).unwrap();
    let signed = disburse::build(&m, &key, &h(0), 7, 8, 12, &o, "tpc_test", 8).unwrap();
    let raw = crypto::unhex(&signed.extrinsic).unwrap();
    let mut input = raw.as_slice();
    Compact::<u32>::decode(&mut input).unwrap();
    assert_eq!(input[0], 0x84);
    assert_eq!(input[1], 5);
    assert_eq!(input[34], Signature::Sr25519([0; 64]).encode()[0]);
    let signature = schnorrkel::Signature::from_bytes(&input[35..99]).unwrap();
    let expected_call = RuntimeCall::OnchainTransaction(Call::transfer_with_remark {
        beneficiary_account_id: [4; 32],
        amount: 1000000,
        remark: format!("topup:{}", o.order_id).into_bytes(),
    })
    .encode();
    let mut payload = expected_call.clone();
    payload.extend(Compact(12u32).encode());
    schnorrkel::PublicKey::from_bytes(&key.public())
        .unwrap()
        .verify_simple(b"substrate", &payload, &signature)
        .unwrap();
    assert_eq!(&input[100..], expected_call);
    assert_eq!(input[100], 142);
    assert_eq!(input[101], 19);
    let decoded = transaction::decode_for(&m, &raw, "OnchainTransaction").unwrap();
    assert_eq!(decoded.account, key.id());
    assert_ne!(
        key.address(),
        Account::read(&format!("0x{}", "02".repeat(32)))
            .unwrap()
            .address()
    );
    // 不支持的新扩展必须报错，禁止沿用之前的签名材料。
    let mut changed = Metadata::read(&metadata()).unwrap();
    changed.extrinsic.as_mut().unwrap().identifiers[0] = "UnknownExtension".into();
    assert!(disburse::build(&changed, &key, &h(0), 7, 8, 12, &o, "tpc_test", 8).is_err());
}

#[test]
fn signed_order_finalizes_with_frozen_account_without_old_private_key() {
    use citizenserve::{
        chain::network_ports::{BroadcastOutcome, Broadcaster},
        shared::{Error, Result},
        topup::{
            self,
            config::Network,
            orders::Order,
            ports::{Clock, Repository},
            settlement::Cursor,
        },
    };
    use std::sync::Mutex;
    struct Memory(Mutex<Order>);
    impl Repository for Memory {
        async fn by_id(&self, _: &str) -> Result<Option<Order>> {
            Ok(Some(self.0.lock().unwrap().clone()))
        }
        async fn save(&self, b: &Order, a: &Order) -> Result<Order> {
            let mut v = self.0.lock().unwrap();
            if v.revision != b.revision {
                return Err(Error::new(409, "cas"));
            }
            *v = a.clone();
            Ok(a.clone())
        }
        async fn insert(&self, _: &Order) -> Result<Order> {
            unreachable!()
        }
        async fn list(&self, _: u32, _: Option<&Cursor>) -> Result<Vec<Order>> {
            unreachable!()
        }
        async fn pending(&self, _: u32) -> Result<Vec<Order>> {
            unreachable!()
        }
        async fn lock(&self, _: &Order, _: &str, _: &str, _: u64) -> Result<bool> {
            panic!("signed transaction cannot acquire new signer")
        }
        async fn unlock(&self, _: &str, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        async fn budget(&self, _: Network, _: u64) -> Result<()> {
            unreachable!()
        }
    }
    struct Time;
    impl Clock for Time {
        fn now(&self) -> u64 {
            1005000
        }
    }
    struct Chain {
        rpc: Rpc,
        broadcasts: Mutex<Vec<String>>,
    }
    impl citizenserve::chain::ports::Rpc for Chain {
        async fn call(&self, m: &str, p: Value) -> Result<Value> {
            citizenserve::chain::ports::Rpc::call(&self.rpc, m, p).await
        }
    }
    impl Broadcaster for Chain {
        async fn broadcast(&self, s: &str) -> Result<BroadcastOutcome> {
            self.broadcasts.lock().unwrap().push(s.into());
            Err(Error::new(503, "synthetic_timeout"))
        }
    }
    let v = fixture_build();
    let mut o: Order = serde_json::from_value(v["order"].clone()).unwrap();
    o.scan = 9;
    let id = o.order_id.clone();
    let signed = o.signed.clone().unwrap();
    let repo = Memory(Mutex::new(o));
    let chain = Chain {
        rpc: Rpc(v.clone()),
        broadcasts: Mutex::new(vec![]),
    };
    for _ in 0..2 {
        assert!(!run(topup::disburse::run(
            &repo,
            &chain,
            &Time,
            &config(&v),
            None,
            &id,
            "new_claim"
        ))
        .unwrap());
    }
    assert_eq!(
        *chain.broadcasts.lock().unwrap(),
        vec![signed.extrinsic.clone(), signed.extrinsic.clone()]
    );
    assert_eq!(repo.0.lock().unwrap().signed.as_ref().unwrap(), &signed);
    assert_eq!(
        repo.0.lock().unwrap().phase,
        topup::orders::Phase::Broadcast
    );
    // 合成下一轮暴露原交易的finalized块；只恢复扫描位置，不构造第二笔交易。
    repo.0.lock().unwrap().scan = 8;
    assert!(run(topup::disburse::run(
        &repo,
        &chain,
        &Time,
        &config(&v),
        None,
        &id,
        "another_claim"
    ))
    .unwrap());
    assert_eq!(repo.0.lock().unwrap().phase, topup::orders::Phase::Paid);
    assert_eq!(chain.broadcasts.lock().unwrap().len(), 2);
    assert!(run(topup::disburse::run(
        &repo,
        &chain,
        &Time,
        &config(&v),
        None,
        &id,
        "duplicate"
    ))
    .unwrap());
}

fn auto_fixture() -> Value {
    use citizenserve::{chain::scale, topup::account::Account};
    let key = Account::read(&format!("0x{}", "01".repeat(32))).unwrap();
    let m = Metadata::read(&metadata()).unwrap();
    let order_id = format!("top_{}", "00".repeat(16));
    let events = vec![
        Record {
            phase: Phase::ApplyExtrinsic(0),
            event: Event::System(SystemEvent::ExtrinsicSuccess),
            topics: vec![],
        },
        Record {
            phase: Phase::ApplyExtrinsic(0),
            event: Event::OnchainTransaction(TransferEvent::TransferWithRemark {
                from_account_id: key.public(),
                beneficiary_account_id: [4; 32],
                amount: 1000000,
                remark: format!("topup:{order_id}").into_bytes(),
            }),
            topics: vec![],
        },
    ]
    .encode();
    json!({"account":key.id(),"address":key.address(),"order_id":order_id,"account_key":m.storage_key("System","Account",&[key.public().to_vec()]).unwrap().0,"account_data":format!("0x{}",crypto::hex(&AccountInfo{nonce:0,data:AccountData{free:1000000000,frozen:0}}.encode())),"events_key":scale::value_key("System","Events"),"timestamp_key":scale::value_key("Timestamp","Now"),"events_template":format!("0x{}",crypto::hex(&events))})
}

#[test]
fn native_runtime_extensions_match_typed_payload_and_version_changes_signature_domain() {
    use citizenserve::topup::{account::Account, disburse};
    use parity_scale_codec::Decode;
    let v = fixture_build();
    let o = serde_json::from_value(v["order"].clone()).unwrap();
    let m = Metadata::read(&metadata_extensions(true)).unwrap();
    let key = Account::read(&format!("0x{}", "01".repeat(32))).unwrap();
    let signed = disburse::build(&m, &key, &h(0), 7, 8, 12, &o, "test", 8).unwrap();
    let raw = crypto::unhex(&signed.extrinsic).unwrap();
    let mut body = raw.as_slice();
    Compact::<u32>::decode(&mut body).unwrap();
    let sig = schnorrkel::Signature::from_bytes(&body[35..99]).unwrap();
    let call = RuntimeCall::OnchainTransaction(Call::transfer_with_remark {
        beneficiary_account_id: [4; 32],
        amount: 1000000,
        remark: format!("topup:{}", o.order_id).into_bytes(),
    });
    // 与CitizenChain signing公开合同一致，类型化独立编码extra/implicit，不从被测输出重构预期。
    let extra = (
        (),
        (),
        (),
        (),
        (),
        (),
        Era::Immortal,
        Compact(12u32),
        (),
        Compact(0u128),
        MetadataMode::Disabled,
        ((), ()),
    );
    let implicit = (
        (),
        (),
        (),
        7u32,
        8u32,
        [0u8; 32],
        [0u8; 32],
        (),
        (),
        (),
        None::<[u8; 32]>,
        ((), ()),
    );
    let payload = (call, extra, implicit).encode();
    schnorrkel::PublicKey::from_bytes(&key.public())
        .unwrap()
        .verify_simple(b"substrate", &payload, &sig)
        .unwrap();
    let mut changed = payload.clone();
    let position = changed.len() - 73;
    changed[position] ^= 1;
    assert!(schnorrkel::PublicKey::from_bytes(&key.public())
        .unwrap()
        .verify_simple(b"substrate", &changed, &sig)
        .is_err());
    assert_eq!(&body[99..103], &[0, 48, 0, 0]);
}
