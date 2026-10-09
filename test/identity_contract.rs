//! 合成metadata/RPC验证真实解码与锚定算法；不声称线上链RPC已通过。
use citizenserve::{
    chain::{self, finalized, ports::Rpc, scale},
    shared::{crypto, Error, Result},
    user::identity::Identity,
};
use frame_metadata::v14::*;
use parity_scale_codec::Encode;
use scale_info::{meta_type, TypeInfo};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("fake RPC must resolve synchronously"),
    }
}
#[derive(Encode, TypeInfo)]
enum Status {
    Active,
    Revoked,
}
#[derive(Encode, TypeInfo)]
struct Record {
    registrar_cid_number: Vec<u8>,
    commitment: [u8; 32],
    residence_province_code: Vec<u8>,
    residence_city_code: Vec<u8>,
    status: Status,
    registered_at: u32,
    revoked_at: Option<u32>,
}
#[derive(Encode, TypeInfo)]
enum Phase {
    ApplyExtrinsic(u32),
    Finalization,
}
#[derive(Encode, TypeInfo)]
enum CitizenEvent {
    CidSelfOccupied {
        cid_number: Vec<u8>,
        account_id: [u8; 32],
        binding_revision: u64,
    },
}
#[derive(Encode, TypeInfo)]
enum RuntimeEvent {
    Other {
        opaque: Vec<u8>,
    },
    #[codec(index = 7)]
    CitizenIdentity(CitizenEvent),
}
#[derive(Encode, TypeInfo)]
struct EventRecord {
    phase: Phase,
    event: RuntimeEvent,
    topics: Vec<[u8; 32]>,
}
#[derive(Encode, TypeInfo)]
struct Voting {
    passport_valid_from: u32,
    passport_valid_until: u32,
    citizen_status: CitizenStatus,
}
#[derive(Encode, TypeInfo)]
enum CitizenStatus {
    Normal,
    Revoked,
}
fn map<T: TypeInfo + 'static>(
    name: &'static str,
    key: scale_info::MetaType,
) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Optional,
        ty: StorageEntryType::Map {
            hashers: vec![StorageHasher::Blake2_128Concat],
            key,
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
        index: 7,
    }
}
fn plain<T: TypeInfo + 'static>(name: &'static str) -> StorageEntryMetadata {
    StorageEntryMetadata {
        name,
        modifier: StorageEntryModifier::Default,
        ty: StorageEntryType::Plain(meta_type::<T>()),
        default: vec![],
        docs: vec![],
    }
}
fn metadata() -> Vec<u8> {
    let m = RuntimeMetadataV14::new(
        vec![
            pallet("System", vec![plain::<Vec<EventRecord>>("Events")]),
            pallet("Timestamp", vec![plain::<u64>("Now")]),
            pallet(
                "CitizenIdentity",
                vec![
                    map::<Vec<u8>>("CidByAccountId", meta_type::<[u8; 32]>()),
                    map::<[u8; 32]>("AccountIdByCid", meta_type::<Vec<u8>>()),
                    map::<u64>("BindingRevisionByCid", meta_type::<Vec<u8>>()),
                    map::<Record>("CidRegistry", meta_type::<Vec<u8>>()),
                    map::<Voting>("VotingIdentityByCid", meta_type::<Vec<u8>>()),
                    map::<u32>("CandidateIdentityByCid", meta_type::<Vec<u8>>()),
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
    frame_metadata::RuntimeMetadataPrefixed::from(m).encode()
}
fn hash(n: u8) -> String {
    format!("0x{}", format!("{n:02x}").repeat(32))
}
struct FakeRpc {
    values: BTreeMap<String, Value>,
    calls: Mutex<Vec<(String, Value)>>,
    wrong_genesis: bool,
}
impl FakeRpc {
    fn new() -> Self {
        let i: Identity =
            serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
        let key = crypto::scale_string(&i.cid_number).unwrap();
        let mut values = BTreeMap::new();
        let mut put = |p: &str, n: &str, k: Option<&[u8]>, bytes: Vec<u8>| {
            values.insert(
                k.map(|k| scale::map_key(p, n, k))
                    .unwrap_or_else(|| scale::value_key(p, n)),
                json!(format!("0x{}", crypto::hex(&bytes))),
            );
        };
        put(
            "CitizenIdentity",
            "CidByAccountId",
            Some(&[0xcd; 32]),
            i.cid_number.as_bytes().to_vec().encode(),
        );
        put(
            "CitizenIdentity",
            "AccountIdByCid",
            Some(&key),
            [0xcdu8; 32].encode(),
        );
        put(
            "CitizenIdentity",
            "BindingRevisionByCid",
            Some(&key),
            1u64.encode(),
        );
        put(
            "CitizenIdentity",
            "CidRegistry",
            Some(&key),
            Record {
                registrar_cid_number: b"registrar".to_vec(),
                commitment: [0; 32],
                residence_province_code: vec![],
                residence_city_code: vec![],
                status: Status::Active,
                registered_at: 3,
                revoked_at: None,
            }
            .encode(),
        );
        put("Timestamp", "Now", None, 1_000_000u64.encode());
        let events = vec![
            EventRecord {
                phase: Phase::ApplyExtrinsic(0),
                event: RuntimeEvent::Other {
                    opaque: b"fake CitizenIdentity CID bytes".to_vec(),
                },
                topics: vec![],
            },
            EventRecord {
                phase: Phase::Finalization,
                event: RuntimeEvent::CitizenIdentity(CitizenEvent::CidSelfOccupied {
                    cid_number: i.cid_number.as_bytes().to_vec(),
                    account_id: [0xcd; 32],
                    binding_revision: 1,
                }),
                topics: vec![],
            },
        ];
        put("System", "Events", None, events.encode());
        Self {
            values,
            calls: Mutex::new(vec![]),
            wrong_genesis: false,
        }
    }
}
impl Rpc for FakeRpc {
    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        Ok(match method {
            "chain_getBlockHash" => {
                if self.wrong_genesis && params[0] == 0 {
                    json!(hash(4))
                } else {
                    json!(hash(params[0].as_u64().unwrap() as u8))
                }
            }
            "chain_getFinalizedHead" => json!(hash(9)),
            "chain_getHeader" => {
                let n = u8::from_str_radix(&params[0].as_str().unwrap()[2..4], 16).unwrap();
                json!({"number":format!("0x{n:x}"),"parentHash":hash(n.saturating_sub(1))})
            }
            "state_getMetadata" => json!(format!("0x{}", crypto::hex(&metadata()))),
            "state_getStorage" => self
                .values
                .get(params[0].as_str().unwrap())
                .cloned()
                .unwrap_or(Value::Null),
            _ => return Err(Error::new(503, "unexpected_fake_rpc")),
        })
    }
}
#[test]
fn metadata_decodes_whole_events_without_fixed_pallet_index_or_byte_scan() {
    let rpc = FakeRpc::new();
    let a = run(finalized::head(&rpc, &hash(0))).unwrap();
    let m = run(chain::identity::metadata(&rpc, &a)).unwrap();
    let cids = run(chain::identity::events(&rpc, &m, &a)).unwrap();
    assert_eq!(cids, vec!["CN220-CTZN2-198805201-2026"]);
}
#[test]
fn identity_reads_both_bindings_and_storage_at_one_finalized_anchor() {
    let rpc = FakeRpc::new();
    let a = run(finalized::head(&rpc, &hash(0))).unwrap();
    let m = run(chain::identity::metadata(&rpc, &a)).unwrap();
    let i = run(chain::identity::by_account(
        &rpc,
        &m,
        &a,
        &format!("0x{}", "cd".repeat(32)),
        &hash(0),
        1_000_000,
    ))
    .unwrap()
    .unwrap();
    i.require_current(1_000_001).unwrap();
    assert_eq!(i.registered_block_hash, hash(3));
    assert_eq!(i.verification_deadline_millis, 1_060_000);
    for (method, p) in rpc.calls.lock().unwrap().iter() {
        if method == "state_getStorage" && p[0] != scale::value_key("Timestamp", "Now") {
            assert_eq!(p[1], hash(9));
        }
    }
}
#[test]
fn bidirectional_mismatch_and_unknown_encoding_fail_closed() {
    let mut rpc = FakeRpc::new();
    let key = scale::map_key("CitizenIdentity", "CidByAccountId", &[0xcd; 32]);
    rpc.values.insert(
        key,
        json!(format!(
            "0x{}",
            crypto::hex(&b"CN220-CTZN2-198805202-2026".to_vec().encode())
        )),
    );
    let a = run(finalized::head(&rpc, &hash(0))).unwrap();
    let m = run(chain::identity::metadata(&rpc, &a)).unwrap();
    assert!(run(chain::identity::by_cid(
        &rpc,
        &m,
        &a,
        "CN220-CTZN2-198805201-2026",
        &hash(0),
        1_000_000
    ))
    .is_err());
    assert!(scale::Metadata::read(&[0, 1, 2]).is_err());
}
#[test]
fn nonfinalized_or_wrong_genesis_never_becomes_authority() {
    let mut rpc = FakeRpc::new();
    let a = run(finalized::head(&rpc, &hash(0))).unwrap();
    assert!(run(finalized::canonical(&rpc, &hash(10), &a)).is_err());
    rpc.wrong_genesis = true;
    assert!(run(finalized::head(&rpc, &hash(0))).is_err());
}
#[test]
fn revoked_or_expired_confirmation_cannot_authorize() {
    let mut i: Identity =
        serde_json::from_str(include_str!("contract/finalized_identity.json")).unwrap();
    assert!(i.require_current(1_060_000).is_err());
    i.status = citizenserve::user::identity::CidStatus::Revoked;
    assert!(i.require_current(1_000_001).is_err());
    i.status = citizenserve::user::identity::CidStatus::Active;
    i.authoritative_current = false;
    assert!(i.require_current(1_000_001).is_err());
    assert!(chain::identity::institution("CN220-NATPZ-198805201-2026").is_ok());
}
#[test]
fn fixed_storage_hash_matches_substrate_system_events() {
    assert_eq!(
        scale::value_key("System", "Events"),
        "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7"
    );
}
#[test]
fn valid_revoked_record_propagates_even_without_account_mapping() {
    let mut rpc = FakeRpc::new();
    let cid = "CN220-CTZN2-198805201-2026";
    let k = crypto::scale_string(cid).unwrap();
    rpc.values
        .remove(&scale::map_key("CitizenIdentity", "AccountIdByCid", &k));
    rpc.values.insert(
        scale::map_key("CitizenIdentity", "CidRegistry", &k),
        json!(format!(
            "0x{}",
            crypto::hex(
                &Record {
                    registrar_cid_number: vec![],
                    commitment: [0; 32],
                    residence_province_code: vec![],
                    residence_city_code: vec![],
                    status: Status::Revoked,
                    registered_at: 3,
                    revoked_at: Some(9)
                }
                .encode()
            )
        )),
    );
    let a = run(finalized::head(&rpc, &hash(0))).unwrap();
    let m = run(chain::identity::metadata(&rpc, &a)).unwrap();
    let i = run(chain::identity::by_cid(
        &rpc,
        &m,
        &a,
        cid,
        &hash(0),
        1_000_000,
    ))
    .unwrap()
    .unwrap();
    assert!(i.require_current(1_000_000).is_err());
}
#[test]
fn malformed_event_tail_cannot_be_ignored() {
    let m = scale::Metadata::read(&metadata()).unwrap();
    let ty = m.storage_type("System", "Events", false).unwrap();
    let mut events = Vec::<EventRecord>::new().encode();
    events.push(0);
    assert!(m.decode(&events, ty).is_err());
}

#[test]
fn voting_identity_uses_chain_timestamp_and_revoked_status() {
    for status in [CitizenStatus::Normal, CitizenStatus::Revoked] {
        let normal = matches!(status, CitizenStatus::Normal);
        let mut rpc = FakeRpc::new();
        let k = crypto::scale_string("CN220-CTZN2-198805201-2026").unwrap();
        rpc.values.insert(
            scale::map_key("CitizenIdentity", "VotingIdentityByCid", &k),
            json!(format!(
                "0x{}",
                crypto::hex(
                    &Voting {
                        passport_valid_from: 19700101,
                        passport_valid_until: 19700102,
                        citizen_status: status
                    }
                    .encode()
                )
            )),
        );
        let a = run(finalized::head(&rpc, &hash(0))).unwrap();
        let m = run(chain::identity::metadata(&rpc, &a)).unwrap();
        let i = run(chain::identity::by_cid(
            &rpc,
            &m,
            &a,
            "CN220-CTZN2-198805201-2026",
            &hash(0),
            1_000_000,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            i.identity_level,
            if normal {
                citizenserve::user::identity::IdentityLevel::Voting
            } else {
                citizenserve::user::identity::IdentityLevel::Visitor
            }
        );
    }
}
