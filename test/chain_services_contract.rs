use citizenserve::{
    chain::{
        self,
        network_ports::{BroadcastOutcome, Broadcaster},
        ports::Rpc,
        relay::{Attempt, Repository},
    },
    shared::{crypto, Error, Result},
};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn fixture() -> Value {
    serde_json::from_str(include_str!("contract/settlement.json")).unwrap()
}
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        _ => panic!("immediate mock"),
    }
}
struct Node(Value);
impl Rpc for Node {
    async fn call(&self, m: &str, p: Value) -> Result<Value> {
        let v = &self.0;
        Ok(match m {
            "chain_getFinalizedHead" => v["block_hash"].clone(),
            "chain_getBlockHash" => {
                if p[0] == 0 {
                    v["genesis"].clone()
                } else {
                    v["block_hash"].clone()
                }
            }
            "chain_getHeader" => v["header"].clone(),
            "state_getMetadata" => v["metadata"].clone(),
            "state_getStorage" => {
                assert_eq!(p[1], v["block_hash"]);
                v["storage"][p[0].as_str().unwrap()].clone()
            }
            _ => return Err(Error::new(503, "synthetic_unknown_rpc")),
        })
    }
}
#[test]
fn full_constitution_bounded_wrappers_hashes_effective_pointer_and_bilingual_labels() {
    let v = fixture();
    let doc = run(chain::constitution::read(
        &Node(v.clone()),
        v["genesis"].as_str().unwrap(),
        1005000,
    ))
    .unwrap();
    assert_eq!(doc["version"], 1);
    assert_eq!(doc["version_label"]["cn"], "正式版");
    assert_eq!(
        doc["chapters"][0]["sections"][0]["articles"][0]["immutable"],
        true
    );
    assert_eq!(doc["immutable_articles"], json!([1]));
    assert_eq!(
        doc["chapters"][0]["sections"][0]["articles"][0]["clauses"][0]["text_en"],
        "Text"
    );
}
#[test]
fn constitution_trailing_bytes_missing_manifest_and_hash_corruption_fail() {
    for n in 0..3 {
        let mut v = fixture();
        let m =
            chain::scale::Metadata::read(&crypto::unhex(v["metadata"].as_str().unwrap()).unwrap())
                .unwrap();
        use parity_scale_codec::Encode;
        let k = if n == 0 {
            chain::scale::value_key("LegislationYuan", "ConstitutionImmutableManifest")
        } else {
            m.storage_key(
                "LegislationYuan",
                "LawVersions",
                &[0u64.encode(), 1u32.encode()],
            )
            .unwrap()
            .0
        };
        if n == 0 {
            v["storage"][k] = Value::Null
        } else {
            let mut bytes = crypto::unhex(v["storage"][&k].as_str().unwrap()).unwrap();
            if n == 1 {
                bytes.push(0)
            } else {
                let p = bytes.len() - 16;
                bytes[p - 33] ^= 1
            }
            v["storage"][k] = json!(format!("0x{}", crypto::hex(&bytes)))
        }
        assert!(run(chain::constitution::read(
            &Node(v.clone()),
            v["genesis"].as_str().unwrap(),
            1005000
        ))
        .is_err());
    }
}
#[test]
fn bootstrap_schemas_keep_bundled_light_client_trust_and_exact_service_paths() {
    let v = fixture();
    let c = chain::bootstrap::Config {
        origin: "https://www.crcfrcn.com".into(),
        genesis_hash: v["genesis"].as_str().unwrap().into(),
        state_root: v["header"]["stateRoot"].as_str().unwrap().into(),
        bootnodes: "".into(),
        media_origin: "https://media.crcfrcn.com".into(),
        relay_enabled: false,
        ttl: 300,
    };
    let app = c.response(1000000, false).unwrap();
    let sdk = c.response(1000000, true).unwrap();
    assert_eq!(
        app["services"]["square_base_url"],
        "https://www.crcfrcn.com/api/8964"
    );
    assert_eq!(app["light_client"]["api_is_truth"], false);
    assert_eq!(app["chain"]["ss58_format"], 2027);
    assert!(sdk.get("services").is_none());
    assert!(sdk["chain"].get("chain_name").is_none());
    assert!(sdk.get("checkpoint").is_none());
    assert_eq!(
        app["services"]["signed_extrinsic_relay"]["path"],
        Value::Null
    );
}
struct Memory(Mutex<Option<Attempt>>);
impl Repository for Memory {
    async fn reserve(&self, a: &Attempt, _: u64) -> Result<Attempt> {
        let mut row = self.0.lock().unwrap();
        Ok(row.get_or_insert_with(|| a.clone()).clone())
    }
    async fn finish(
        &self,
        a: &Attempt,
        status: &str,
        error: Option<&str>,
        _: u64,
    ) -> Result<Attempt> {
        let mut a = a.clone();
        a.relay_status = status.into();
        a.error_code = error.map(str::to_string);
        *self.0.lock().unwrap() = Some(a.clone());
        Ok(a)
    }
}
struct Broadcast {
    hash: String,
    timeout: bool,
    count: Mutex<u32>,
}
impl Broadcaster for Broadcast {
    async fn broadcast(&self, _: &str) -> Result<BroadcastOutcome> {
        *self.count.lock().unwrap() += 1;
        if self.timeout {
            Err(Error::new(503, "synthetic_timeout"))
        } else {
            Ok(BroadcastOutcome::Accepted(self.hash.clone()))
        }
    }
}
#[test]
fn broadcast_unknown_keeps_exclusive_claim_and_never_resends() {
    let v = fixture();
    let node = Node(v.clone());
    let repo = Memory(Mutex::new(None));
    let b = Broadcast {
        hash: v["request"]["gmb_tx_hash"].as_str().unwrap().into(),
        timeout: true,
        count: Mutex::new(0),
    };
    for n in [1u8, 2] {
        let input = chain::Relay {
            signed_extrinsic_hex: v["request"]["signed_extrinsic_hex"]
                .as_str()
                .unwrap()
                .into(),
        };
        let (code, result) = run(chain::relay::submit(
            &repo,
            &b,
            &node,
            v["genesis"].as_str().unwrap(),
            input,
            &"33".repeat(32),
            &format!("{n:032x}"),
            1000000,
        ))
        .unwrap();
        assert_eq!(code, 202);
        assert_eq!(result["relay_status"], "unknown");
        assert_eq!(result["ok"], false);
    }
    assert_eq!(*b.count.lock().unwrap(), 1);
}
#[test]
fn node_hash_mismatch_is_unknown_and_success_only_means_broadcast() {
    let v = fixture();
    for correct in [false, true] {
        let node = Node(v.clone());
        let b = Broadcast {
            hash: if correct {
                v["request"]["gmb_tx_hash"].as_str().unwrap().into()
            } else {
                format!("0x{}", "99".repeat(32))
            },
            timeout: false,
            count: Mutex::new(0),
        };
        let input = chain::Relay {
            signed_extrinsic_hex: v["request"]["signed_extrinsic_hex"]
                .as_str()
                .unwrap()
                .into(),
        };
        let (_, r) = run(chain::relay::submit(
            &Memory(Mutex::new(None)),
            &b,
            &node,
            v["genesis"].as_str().unwrap(),
            input,
            &"33".repeat(32),
            &"55".repeat(16),
            1000000,
        ))
        .unwrap();
        assert_eq!(r["ok"], correct);
        assert_eq!(
            r["relay_status"],
            if correct { "broadcast" } else { "unknown" }
        );
        assert!(r.get("session_token").is_none());
    }
}
