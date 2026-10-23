//! 真实HMAC/ECDSA/Keccak，链端口是明确的合成RPC，私钥仅为公开测试常量。
use citizenserve::{
    shared::{crypto, Error, Result},
    topup::{
        self,
        config::{Config, Network, Receivers},
        evm_verify::{self},
        intent::{Intent, Request},
        orders::{self, Order, Outcome, Payment},
        ports::{Clock, Method, PaymentRpc, Repository},
        settlement::Cursor,
        wallet_authorization as wallet, Token,
    },
};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        _ => panic!("synthetic RPC resolves immediately"),
    }
}
fn h(n: u8) -> String {
    format!("0x{}", crypto::hex(&[n; 32]))
}
fn a(n: u8) -> String {
    format!("0x{}", crypto::hex(&[n; 20]))
}
fn config() -> Config {
    Config {
        service_origin: "https://www.crcfrcn.com".into(),
        chain_genesis_hash: h(0),
        receivers: Receivers {
            evm: a(2),
            tron: topup::tron::from_hex(&a(2)).unwrap(),
            solana: "11111111111111111111111111111111".into(),
        },
    }
}
fn intent() -> Intent {
    Intent::create(
        &config(),
        Request {
            account_id: h(4),
            token: Token::USDC,
            network: Network::Base,
            package_id: "pkg_15".into(),
            payer_address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".into(),
        },
        None,
        &"11".repeat(16),
        1000000,
    )
    .unwrap()
}
const KEY: &[u8] = b"test-only-intent-secret-32-bytes!!";
fn authorization(i: &Intent) -> (String, Vec<u8>, String) {
    let token = topup::intent::sign(i, KEY).unwrap();
    let msg = topup::intent::message(&config(), i, &token).unwrap();
    let key = k256::ecdsa::SigningKey::from_slice(&{
        let mut b = [0; 32];
        b[31] = 1;
        b
    })
    .unwrap();
    let (sig, rec) = key.sign_prehash_recoverable(&wallet::digest(&msg)).unwrap();
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(rec.to_byte());
    (msg, bytes, token)
}
struct Time(u64);
impl Clock for Time {
    fn now(&self) -> u64 {
        self.0
    }
}
struct Evm {
    receipt: Value,
    transaction: Value,
    block: Value,
    head: Value,
    chain: Value,
    amount: Value,
    contract: bool,
    magic: Value,
    reorg: bool,
    calls: Mutex<Vec<(Method, Value)>>,
}
impl Evm {
    fn new() -> Self {
        let i = intent();
        let log = json!({"address":i.asset,"topics":[format!("0x{}",crypto::hex(&evm_verify::sha3_digest(b"Transfer(address,address,uint256)"))),format!("0x{}{}","00".repeat(12),&i.payer_address[2..]),format!("0x{}{}","00".repeat(12),&i.recv_address[2..])],"data":format!("0x{:064x}",15000000u64),"removed":false,"transactionHash":h(9),"blockHash":h(10),"blockNumber":"0xa","transactionIndex":"0x0","logIndex":"0x3"});
        Self {
            receipt: json!({"transactionHash":h(9),"blockHash":h(10),"blockNumber":"0xa","transactionIndex":"0x0","status":"0x1","logs":[log]}),
            transaction: json!({"hash":h(9),"blockHash":h(10),"blockNumber":"0xa","transactionIndex":"0x0"}),
            block: json!({"hash":h(10),"number":"0xa","timestamp":"0x3e9","transactions":[h(9)]}),
            head: json!({"hash":h(11),"number":"0xb"}),
            chain: json!("0x2105"),
            amount: json!(format!("0x{:064x}", 6)),
            contract: false,
            magic: json!(format!("0x1626ba7e{}", "00".repeat(28))),
            reorg: false,
            calls: Mutex::new(vec![]),
        }
    }
}
impl PaymentRpc for Evm {
    async fn call(&self, m: Method, p: Value) -> Result<Value> {
        let mut calls = self.calls.lock().unwrap();
        let blocks = calls
            .iter()
            .filter(|(m, p)| *m == Method::Block && p[0] == "0xa")
            .count();
        calls.push((m, p.clone()));
        Ok(match m {
            Method::ChainId => self.chain.clone(),
            Method::Receipt => self.receipt.clone(),
            Method::Transaction => self.transaction.clone(),
            Method::Block => {
                if p[0] == "0xa" {
                    let mut b = self.block.clone();
                    if self.reorg && blocks > 0 {
                        b["hash"] = json!(h(99))
                    }
                    b
                } else {
                    self.head.clone()
                }
            }
            Method::Code => {
                if p[0] == intent().payer_address && !self.contract {
                    json!("0x")
                } else {
                    json!("0x6000")
                }
            }
            Method::Call => {
                if p[0]["data"] == "0x313ce567" {
                    self.amount.clone()
                } else {
                    self.magic.clone()
                }
            }
            _ => return Err(Error::new(503, "synthetic_unknown_rpc")),
        })
    }
}
fn payment(e: &Evm) -> Result<Outcome> {
    let (msg, sig, _) = authorization(&intent());
    run(evm_verify::verify(
        e,
        &Time(1005000),
        &config(),
        &intent(),
        &h(9),
        Some((&msg, &sig)),
    ))
}
#[test]
fn hmac_money_and_wallet_golden() {
    let i = intent();
    let (msg, sig, token) = authorization(&i);
    assert_eq!(topup::intent::verify(&token, KEY).unwrap(), i);
    assert_eq!(
        wallet::recover(&wallet::digest(&msg), &sig).unwrap(),
        i.payer_address
    );
    assert_eq!(
        evm_verify::decimal(&[255; 32]),
        "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    );
    assert_eq!(
        crypto::hex(&evm_verify::sha3_digest(b"")),
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
    assert_eq!(i.pay_amount, "15000000");
    assert_eq!(i.coin_fen, "1000000");
    let e = Evm::new();
    let Outcome::Confirmed(p) = payment(&e).unwrap() else {
        panic!()
    };
    let repo = Memory::default();
    run(repo.insert(&Order::create(&config(), i.clone(), &token).unwrap())).unwrap();
    let req = orders::Confirm {
        payment_intent: token.clone(),
        payment_txid: h(9),
        payer_signature: format!("0x{}", crypto::hex(&sig)),
    };
    run(orders::confirm(&repo, &Time(1005000), &config(), KEY, req)).unwrap();
    let o = repo.order.lock().unwrap().clone().unwrap();
    let mut fixture = json!({"schema":"citizenserve.topup.test.v2","receivers":config().receivers,"native":native_vectors(),"public_test_key":String::from_utf8(KEY.to_vec()).unwrap(),"intent":i,"payment_intent":token,"wallet_authorization_message":msg,"digest":crypto::hex(&wallet::digest(&msg)),"payer_signature":format!("0x{}",crypto::hex(&sig)),"payment":p,"order":o,"evm":{"receipt":e.receipt,"transaction":e.transaction,"block":e.block,"head":e.head}});
    let old: Value = serde_json::from_str(include_str!("contract/topup.json")).unwrap();
    fixture["legacy_schema"] = old["legacy_schema"].clone();
    fixture["legacy"] = old["legacy"].clone();
    golden("topup", fixture);
}
fn golden(name: &str, v: Value) {
    let path = format!("{}/test/contract/{name}.json", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_STEP5_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap()
    }
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap(),
        v
    )
}
#[test]
fn observed_payment_cannot_be_reassigned_to_another_target() {
    let mut i = intent();
    i.account_id = h(88);
    let t = topup::intent::sign(&i, KEY).unwrap();
    let msg = topup::intent::message(&config(), &i, &t).unwrap();
    let (_, sig, _) = authorization(&intent());
    assert_ne!(
        wallet::recover(&wallet::digest(&msg), &sig).unwrap(),
        i.payer_address
    );
    assert!(run(evm_verify::verify(
        &Evm::new(),
        &Time(1005000),
        &config(),
        &i,
        &h(9),
        Some((&msg, &sig))
    ))
    .is_err());
}
#[test]
fn wallet_signature_binds_every_message_byte() {
    let (msg, sig, _) = authorization(&intent());
    for field in [
        "service_origin",
        "chain_genesis_hash",
        "intent_id",
        "network",
        "payer_address",
        "asset",
        "recv_address",
        "pay_amount",
        "coin_fen",
        "account_id",
        "package_id",
        "issued_at",
        "expires_at",
        "intent_sha256",
    ] {
        let changed = msg.replacen(&format!("{field}="), &format!("{field}=x"), 1);
        assert_ne!(
            wallet::recover(&wallet::digest(&changed), &sig).unwrap(),
            intent().payer_address
        )
    }
    let mut v = sig.clone();
    v[64] += 27;
    assert_eq!(
        wallet::signature_hash(&v, false).unwrap(),
        wallet::signature_hash(&sig, false).unwrap()
    );
    v[64] = 29;
    assert!(wallet::recover(&wallet::digest(&msg), &v).is_err());
}
#[test]
fn chain_receipt_transfer_and_canonical_failure_matrix() {
    for n in 0..13 {
        let mut e = Evm::new();
        match n {
            0 => e.chain = json!("0x1"),
            1 => e.receipt["status"] = json!("0x0"),
            2 => e.transaction["hash"] = json!(h(1)),
            3 => e.block["hash"] = json!(h(99)),
            4 => e.block["transactions"] = json!([h(9), h(9)]),
            5 => e.receipt["logs"][0]["data"] = json!(format!("0x{:064x}", 14999999)),
            6 => {
                e.receipt["logs"][0]["topics"][2] =
                    json!(format!("0x{}{}", "00".repeat(12), "88".repeat(20)))
            }
            7 => e.receipt["logs"][0]["removed"] = json!(true),
            8 => e.receipt["logs"][0]["transactionIndex"] = json!("0x1"),
            9 => e.reorg = true,
            10 => e.amount = json!(format!("0x{:064x}", 18)),
            11 => e.block["timestamp"] = json!("0x3e8"),
            12 => e.block["timestamp"] = json!("0x641"),
            _ => unreachable!(),
        }
        assert!(payment(&e).is_err(), "case {n}");
    }
}
#[test]
fn receipt_absence_and_confirmation_wait_do_not_create_a_terminal_order() {
    let mut e = Evm::new();
    e.receipt = Value::Null;
    assert!(matches!(payment(&e).unwrap(), Outcome::Pending));
    let mut e = Evm::new();
    e.head["number"] = json!("0x9");
    assert!(matches!(payment(&e).unwrap(), Outcome::Pending));
}
#[test]
fn contract_wallet_uses_same_block_exact_abi_and_original_signature() {
    let mut e = Evm::new();
    e.contract = true;
    assert!(matches!(
        payment(&e).unwrap(),
        Outcome::Confirmed(Payment {
            wallet_is_contract: true,
            ..
        })
    ));
    let calls = e.calls.lock().unwrap();
    let (_, p) = calls
        .iter()
        .find(|(m, p)| *m == Method::Call && p[0]["to"] == intent().payer_address)
        .unwrap();
    assert_eq!(p[1], "0xa");
    assert_eq!(p[0]["gas"], "0x7a120");
    assert!(p[0]["data"].as_str().unwrap().starts_with("0x1626ba7e"));
    drop(calls);
    e.magic = json!("0x1626ba7e");
    assert!(payment(&e).is_err());
}
#[test]
fn ttl_boundaries_and_capability_tampering_are_closed() {
    let i = intent();
    assert!(i.require_live(999999).is_err());
    assert!(i.require_live(1599999).is_ok());
    assert!(i.require_live(1600000).is_err());
    let token = topup::intent::sign(&i, KEY).unwrap();
    assert!(topup::intent::verify(&(token.clone() + "="), KEY).is_err());
    assert!(topup::intent::verify(&token, b"another-secret-32-byte-value!!!!!").is_err());
    let mut c = config();
    c.receivers.evm = a(77);
    assert!(i.validate(&c).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"account_id":"a","account_id":"b","token":"USDC","package_id":"pkg_15","payer_address":"x"}"#).is_err());
}
#[test]
fn verified_order_retry_needs_same_intent_and_signature_without_payment_rpc() {
    let e = Evm::new();
    let repo = Memory::default();
    let (_, sig, t) = authorization(&intent());
    run(repo.insert(&Order::create(&config(), intent(), &t).unwrap())).unwrap();
    let request = || orders::Confirm {
        payment_intent: t.clone(),
        payment_txid: h(9),
        payer_signature: format!("0x{}", crypto::hex(&sig)),
    };
    run(orders::confirm(
        &repo,
        &Time(1005000),
        &config(),
        KEY,
        request(),
    ))
    .unwrap();
    let count = e.calls.lock().unwrap().len();
    assert_eq!(
        run(orders::confirm(
            &repo,
            &Time(1005000),
            &config(),
            KEY,
            request()
        ))
        .unwrap()["deduplicated"],
        true
    );
    assert_eq!(count, e.calls.lock().unwrap().len());
    let mut r = request();
    r.payer_signature = format!("0x{}", "11".repeat(65));
    assert!(run(orders::confirm(&repo, &Time(1005000), &config(), KEY, r,)).is_err());
    let s = orders::Status {
        order_id: repo
            .order
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .order_id
            .clone(),
        payment_intent: t,
    };
    assert!(run(orders::status(&repo, KEY, s)).is_ok());
}
#[derive(Default)]
struct Memory {
    order: Mutex<Option<Order>>,
}
impl Repository for Memory {
    async fn by_id(&self, _: &str) -> Result<Option<Order>> {
        Ok(self.order.lock().unwrap().clone())
    }
    async fn insert(&self, o: &Order) -> Result<Order> {
        *self.order.lock().unwrap() = Some(o.clone());
        Ok(o.clone())
    }
    async fn save(&self, b: &Order, a: &Order) -> Result<Order> {
        let mut stored = self.order.lock().unwrap();
        if stored.as_ref().map(|o| o.revision) != Some(b.revision) {
            return Err(Error::new(409, "topup_order_conflict"));
        }
        *stored = Some(a.clone());
        Ok(a.clone())
    }
    async fn list(&self, _: u32, _: Option<&Cursor>) -> Result<Vec<Order>> {
        Err(Error::new(503, "unused_test_port"))
    }
    async fn pending(&self, _: u32) -> Result<Vec<Order>> {
        Err(Error::new(503, "unused_test_port"))
    }
    async fn lock(&self, _: &Order, _: &str, _: &str, _: u64) -> Result<bool> {
        Ok(true)
    }
    async fn unlock(&self, _: &str, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn budget(&self, _: Network, _: u64) -> Result<()> {
        Ok(())
    }
}

#[test]
fn parallel_intents_have_distinct_ids_and_cannot_reuse_the_signature() {
    let handles = (0..24)
        .map(|n| {
            std::thread::spawn(move || {
                let mut i = intent();
                i.intent_id = format!("tpi_{n:032x}");
                let t = topup::intent::sign(&i, KEY).unwrap();
                topup::intent::verify(&t, KEY).unwrap();
                t
            })
        })
        .collect::<Vec<_>>();
    let tokens = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(tokens.len(), 24);
}
#[test]
fn authorization_freshness_window_cannot_be_extended() {
    let Outcome::Confirmed(mut p) = payment(&Evm::new()).unwrap() else {
        panic!()
    };
    assert!(p.require_fresh(p.checked_at).is_ok());
    assert!(p.require_fresh(p.verification_deadline).is_err());
    p.verification_deadline += 1;
    assert!(p.require_fresh(p.checked_at).is_err());
}

#[test]
fn target_cid_requires_both_actual_bindings_but_does_not_require_citizen_mls() {
    use citizenserve::chain::{finalized::Anchor, scale};
    use frame_metadata::v14::*;
    use parity_scale_codec::Encode;
    use scale_info::{meta_type, TypeInfo};
    #[derive(Encode, TypeInfo)]
    enum Status {
        Active,
        Revoked,
    }
    #[derive(Encode, TypeInfo)]
    struct Record {
        status: Status,
        revoked_at: Option<u64>,
        registered_at: u64,
    }
    fn entry<K: TypeInfo + 'static, V: TypeInfo + 'static>(
        name: &'static str,
    ) -> StorageEntryMetadata {
        StorageEntryMetadata {
            name,
            modifier: StorageEntryModifier::Optional,
            ty: StorageEntryType::Map {
                hashers: vec![StorageHasher::Blake2_128Concat],
                key: meta_type::<K>(),
                value: meta_type::<V>(),
            },
            default: vec![],
            docs: vec![],
        }
    }
    let raw = frame_metadata::RuntimeMetadataPrefixed::from(RuntimeMetadataV14::new(
        vec![PalletMetadata {
            name: "CitizenIdentity",
            storage: Some(PalletStorageMetadata {
                prefix: "CitizenIdentity",
                entries: vec![
                    entry::<[u8; 32], Vec<u8>>("CidByAccountId"),
                    entry::<Vec<u8>, [u8; 32]>("AccountIdByCid"),
                    entry::<Vec<u8>, Record>("CidRegistry"),
                ],
            }),
            calls: None,
            event: None,
            constants: vec![],
            error: None,
            index: 55,
        }],
        ExtrinsicMetadata {
            ty: meta_type::<()>(),
            version: 4,
            signed_extensions: vec![],
        },
        meta_type::<()>(),
    ))
    .encode();
    let m = scale::Metadata::read(&raw).unwrap();
    let cid = "CN220-OTHER2-198805201-2026";
    let ckey = crypto::scale_string(cid).unwrap();
    let mut values = std::collections::BTreeMap::new();
    let account = h(4);
    let forward = scale::map_key("CitizenIdentity", "CidByAccountId", &[4; 32]);
    let reverse = scale::map_key("CitizenIdentity", "AccountIdByCid", &ckey);
    let registry = scale::map_key("CitizenIdentity", "CidRegistry", &ckey);
    values.insert(
        forward.clone(),
        json!(format!(
            "0x{}",
            crypto::hex(&cid.as_bytes().to_vec().encode())
        )),
    );
    values.insert(
        reverse.clone(),
        json!(format!("0x{}", crypto::hex(&[4u8; 32].encode()))),
    );
    values.insert(
        registry.clone(),
        json!(format!(
            "0x{}",
            crypto::hex(
                &Record {
                    status: Status::Active,
                    revoked_at: None,
                    registered_at: 1
                }
                .encode()
            )
        )),
    );
    struct IdentityRpc {
        values: std::collections::BTreeMap<String, Value>,
        fail: bool,
    }
    impl citizenserve::chain::ports::Rpc for IdentityRpc {
        async fn call(&self, _: &str, p: Value) -> Result<Value> {
            if self.fail {
                return Err(Error::new(503, "synthetic_rpc_failure"));
            }
            Ok(self
                .values
                .get(p[0].as_str().unwrap())
                .cloned()
                .unwrap_or(Value::Null))
        }
    }
    let a: Anchor = citizenserve::chain::finalized::Anchor {
        number: 9,
        hash: h(9),
        parent_hash: h(8),
    };
    let mut rpc = IdentityRpc {
        values,
        fail: false,
    };
    assert_eq!(
        run(topup::intent::target_cid(&rpc, &m, &a, &account)).unwrap(),
        Some(cid.into())
    );
    rpc.fail = true;
    assert!(run(topup::intent::target_cid(&rpc, &m, &a, &account)).is_err());
    rpc.fail = false;
    rpc.values.insert(
        registry.clone(),
        json!(format!(
            "0x{}",
            crypto::hex(
                &Record {
                    status: Status::Revoked,
                    revoked_at: Some(9),
                    registered_at: 1
                }
                .encode()
            )
        )),
    );
    assert!(run(topup::intent::target_cid(&rpc, &m, &a, &account)).is_err());
    rpc.values.remove(&reverse);
    assert!(run(topup::intent::target_cid(&rpc, &m, &a, &account)).is_err());
    rpc.values.remove(&forward);
    assert_eq!(
        run(topup::intent::target_cid(&rpc, &m, &a, &account)).unwrap(),
        None
    );
}

#[test]
fn contract_signature_v_is_preserved_and_eoa_high_s_is_rejected() {
    let (msg, mut sig, _) = authorization(&intent());
    sig[64] += 27;
    let e = Evm {
        contract: true,
        ..Evm::new()
    };
    assert!(run(wallet::verify(&e, &intent().payer_address, 10, &msg, &sig)).unwrap());
    let calls = e.calls.lock().unwrap();
    let data = calls.iter().find(|(m, _)| *m == Method::Call).unwrap().1[0]["data"]
        .as_str()
        .unwrap();
    let abi = crypto::unhex(data).unwrap();
    assert_eq!(&abi[100..165], sig.as_slice());
    drop(calls);
    let n =
        crypto::unhex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").unwrap();
    let old = sig[32..64].to_vec();
    let mut borrow = 0i16;
    for j in (0..32).rev() {
        let mut v = n[j] as i16 - old[j] as i16 - borrow;
        borrow = if v < 0 { 1 } else { 0 };
        if v < 0 {
            v += 256
        }
        sig[32 + j] = v as u8;
    }
    assert!(wallet::recover(&wallet::digest(&msg), &sig).is_err());
}

// 公开合成主网端口；所有密钥仅为不可用于资金的公开测试向量。
#[derive(Clone)]
struct Native {
    values: Vec<(Method, Value)>,
}
impl PaymentRpc for Native {
    async fn call(&self, m: Method, _: Value) -> Result<Value> {
        self.values
            .iter()
            .find(|(method, _)| *method == m)
            .map(|(_, v)| v.clone())
            .ok_or(Error::new(503, "unexpected_native_rpc"))
    }
}
fn native_intent(n: Network, t: Token, payer: String) -> Intent {
    Intent::create(
        &config(),
        Request {
            account_id: h(4),
            token: t,
            network: n,
            package_id: "pkg_15".into(),
            payer_address: payer,
        },
        None,
        &"55".repeat(16),
        1000000,
    )
    .unwrap()
}
fn native_vectors() -> Value {
    use base58::ToBase58;
    use ed25519_dalek::Signer;
    let tron_i = native_intent(
        Network::Tron,
        Token::USDT,
        topup::tron::from_hex(&intent().payer_address).unwrap(),
    );
    let token = topup::intent::sign(&tron_i, KEY).unwrap();
    let msg = topup::intent::message(&config(), &tron_i, &token).unwrap();
    let mut seed = [0u8; 32];
    seed[31] = 1;
    let key = k256::ecdsa::SigningKey::from_slice(&seed).unwrap();
    let (sig, rec) = key
        .sign_prehash_recoverable(&topup::tron::digest(&msg))
        .unwrap();
    let mut signature = sig.to_bytes().to_vec();
    signature.push(rec.to_byte());
    let raw = "010203";
    let tx = crypto::sha256_hex(&crypto::unhex(raw).unwrap());
    let transaction = json!({"txID":tx,"raw_data_hex":raw,"raw_data":{"contract":[{"type":"TriggerSmartContract","parameter":{"type_url":"type.googleapis.com/protocol.TriggerSmartContract","value":{"owner_address":topup::tron::hex_address(&tron_i.payer_address).unwrap(),"contract_address":topup::tron::hex_address(&tron_i.asset).unwrap()}}}]},"ret":[{"contractRet":"SUCCESS"}]});
    let receipt = json!({"id":tx,"blockNumber":10,"blockTimeStamp":1001000,"receipt":{"result":"SUCCESS"},"log":[{"address":&topup::tron::hex_address(&tron_i.asset).unwrap()[2..],"topics":[crypto::hex(&evm_verify::sha3_digest(b"Transfer(address,address,uint256)")),format!("{}{}","00".repeat(12),&topup::tron::hex_address(&tron_i.payer_address).unwrap()[2..]),format!("{}{}","00".repeat(12),&topup::tron::hex_address(&tron_i.recv_address).unwrap()[2..])],"data":format!("{:064x}",15000000)}]});
    let block = json!({"blockID":"10".repeat(32),"block_header":{"raw_data":{"number":10,"timestamp":1001000}},"transactions":[transaction]});
    let tron = json!({"intent":tron_i,"token":token,"message":msg,"signature":format!("0x{}",crypto::hex(&signature)),"txid":tx,"transaction":transaction,"receipt":receipt,"block":block});
    let key = ed25519_dalek::SigningKey::from_bytes(&[4; 32]);
    let i = native_intent(
        Network::Solana,
        Token::USDC,
        key.verifying_key().to_bytes().to_base58(),
    );
    let token = topup::intent::sign(&i, KEY).unwrap();
    let msg = topup::intent::message(&config(), &i, &token).unwrap();
    let signature = key.sign(msg.as_bytes()).to_bytes().to_base58();
    let tx = [9u8; 64].to_base58();
    let source = [5u8; 32].to_base58();
    let dest = [6u8; 32].to_base58();
    let token_balance = |index, owner: &str| json!({"accountIndex":index,"mint":i.asset,"owner":owner,"programId":topup::solana::PROGRAM,"uiTokenAmount":{"amount":"15000000","decimals":6}});
    let balances = json!([
        token_balance(0, &i.payer_address),
        token_balance(1, &i.recv_address)
    ]);
    let transaction = json!({"slot":10,"blockTime":1001,"version":"legacy","transaction":{"signatures":[tx],"message":{"accountKeys":[{"pubkey":source,"signer":false},{"pubkey":dest,"signer":false}],"instructions":[{"programId":topup::solana::PROGRAM,"parsed":{"type":"transferChecked","info":{"source":source,"destination":dest,"authority":i.payer_address,"mint":i.asset,"tokenAmount":{"amount":"15000000","decimals":6}}}}]}},"meta":{"err":null,"preTokenBalances":balances,"postTokenBalances":balances,"innerInstructions":[]}});
    let solana = json!({"intent":i,"token":token,"message":msg,"signature":signature,"txid":tx,"transaction":transaction,"block":{"blockhash":([10u8;32].to_base58()),"blockTime":1001,"signatures":[tx]}});
    json!({"tron":tron,"solana":solana})
}
fn native_rpc(v: &Value, n: Network) -> Native {
    Native {
        values: if n == Network::Tron {
            vec![
                (Method::TronGenesis, json!({"blockID":topup::tron::GENESIS})),
                (Method::TronTransaction, v["transaction"].clone()),
                (Method::TronReceipt, v["receipt"].clone()),
                (Method::TronBlock, v["block"].clone()),
            ]
        } else {
            vec![
                (Method::SolGenesis, json!(topup::solana::GENESIS)),
                (Method::SolTransaction, v["transaction"].clone()),
                (Method::SolBlock, v["block"].clone()),
            ]
        },
    }
}
fn verify_native(v: &Value, n: Network, rpc: &Native) -> Result<Outcome> {
    let i = serde_json::from_value(v["intent"].clone()).unwrap();
    let sig = orders::signature(n, v["signature"].as_str().unwrap()).unwrap();
    if n == Network::Tron {
        run(topup::tron::verify(
            rpc,
            &Time(1005000),
            &config(),
            &i,
            v["txid"].as_str().unwrap(),
            v["message"].as_str().unwrap(),
            &sig,
        ))
    } else {
        run(topup::solana::verify(
            rpc,
            &Time(1005000),
            &config(),
            &i,
            v["txid"].as_str().unwrap(),
            v["message"].as_str().unwrap(),
            &sig,
        ))
    }
}
#[test]
fn six_allowed_rails_two_packages_and_all_other_pairs_closed() {
    for n in [
        Network::Ethereum,
        Network::Base,
        Network::Bnb,
        Network::Tron,
        Network::Solana,
    ] {
        for t in [Token::USDC, Token::USDT] {
            let accepted = topup::config::rails()
                .iter()
                .any(|r| r.network == n && r.token == t);
            assert_eq!(config().rail(t, n).is_ok(), accepted);
        }
    }
    assert_eq!(
        config().response().unwrap()["packages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for package in ["pkg_15", "pkg_1400"] {
        for r in topup::config::rails() {
            let q = topup::quote(package, r.decimals).unwrap();
            assert_eq!(
                q.payment_atomic,
                if package == "pkg_15" { 15 } else { 1400 } * 10u128.pow(r.decimals.into())
            );
        }
    }
    assert!(topup::quote("custom", 6).is_err());
    for r in topup::config::rails()
        .into_iter()
        .filter(|r| r.network.evm_id().is_some())
    {
        for package in ["pkg_15", "pkg_1400"] {
            let i = Intent::create(
                &config(),
                Request {
                    account_id: h(4),
                    token: r.token,
                    network: r.network,
                    package_id: package.into(),
                    payer_address: intent().payer_address,
                },
                None,
                &"66".repeat(16),
                1000000,
            )
            .unwrap();
            let mut e = Evm::new();
            e.chain = json!(evm_verify::quantity(r.network.evm_id().unwrap()));
            e.amount = json!(format!("0x{:064x}", r.decimals));
            e.receipt["logs"][0]["address"] = json!(r.asset);
            e.receipt["logs"][0]["data"] =
                json!(format!("0x{:064x}", i.pay_amount.parse::<u128>().unwrap()));
            let (msg, sig, _) = authorization(&i);
            assert!(matches!(
                run(evm_verify::verify(
                    &e,
                    &Time(1005000),
                    &config(),
                    &i,
                    &h(9),
                    Some((&msg, &sig))
                ))
                .unwrap(),
                Outcome::Confirmed(_)
            ));
        }
    }
    for (name, n) in [("tron", Network::Tron), ("solana", Network::Solana)] {
        let v = &native_vectors()[name];
        assert!(matches!(
            verify_native(v, n, &native_rpc(v, n)).unwrap(),
            Outcome::Confirmed(_)
        ));
    }
}
#[test]
fn native_mainnet_owner_mint_amount_finality_and_authorization_failures() {
    for (name, n) in [("tron", Network::Tron), ("solana", Network::Solana)] {
        let v = &native_vectors()[name];
        for case in 0..9 {
            let mut bad = v.clone();
            let mut rpc = native_rpc(v, n);
            match (n, case) {
                (Network::Tron, 0) => rpc.values[0].1 = json!({"blockID":"00".repeat(32)}),
                (Network::Tron, 1) => bad["receipt"]["receipt"]["result"] = json!("REVERT"),
                (Network::Tron, 2) => bad["receipt"]["log"][0]["address"] = json!("00".repeat(20)),
                (Network::Tron, 3) => {
                    bad["receipt"]["log"][0]["data"] = json!(format!("{:064x}", 14999999))
                }
                (Network::Tron, 4) => bad["transaction"]["raw_data_hex"] = json!("01"),
                (Network::Tron, 5) => {
                    let log = bad["receipt"]["log"][0].clone();
                    bad["receipt"]["log"].as_array_mut().unwrap().push(log);
                }
                (Network::Tron, 6) => {
                    bad["block"]["block_header"]["raw_data"]["timestamp"] = json!(1600001)
                }
                (Network::Tron, 7) => bad["block"]["transactions"] = json!([]),
                (Network::Tron, _) => bad["message"] = json!("wrong target"),
                (_, 0) => rpc.values[0].1 = json!("testnet"),
                (_, 1) => bad["transaction"]["meta"]["err"] = json!({"InstructionError":[0,"x"]}),
                (_, 2) => {
                    bad["transaction"]["meta"]["preTokenBalances"][0]["mint"] = json!("other")
                }
                (_, 3) => {
                    bad["transaction"]["transaction"]["message"]["instructions"][0]["parsed"]
                        ["info"]["tokenAmount"]["amount"] = json!("14999999")
                }
                (_, 4) => {
                    bad["transaction"]["transaction"]["message"]["instructions"][0]["programId"] =
                        json!("other")
                }
                (_, 5) => {
                    let ins =
                        bad["transaction"]["transaction"]["message"]["instructions"][0].clone();
                    bad["transaction"]["transaction"]["message"]["instructions"]
                        .as_array_mut()
                        .unwrap()
                        .push(ins);
                }
                (_, 6) => bad["transaction"]["blockTime"] = json!(1601),
                (_, 7) => bad["block"]["signatures"] = json!([]),
                (_, _) => bad["message"] = json!("wrong target"),
            }
            if case != 0 {
                rpc = native_rpc(&bad, n);
            }
            assert!(verify_native(&bad, n, &rpc).is_err(), "{name} {case}");
        }
        let mut rpc = native_rpc(v, n);
        let idx = 1;
        rpc.values[idx].1 = if n == Network::Tron {
            json!({})
        } else {
            Value::Null
        };
        assert!(matches!(
            verify_native(v, n, &rpc).unwrap(),
            Outcome::Pending
        ));
    }
}
#[test]
fn delayed_finality_continues_after_quote_ttl_but_payment_time_is_bound() {
    let e = Evm::new();
    let (msg, sig, _) = authorization(&intent());
    assert!(matches!(
        run(evm_verify::verify(
            &e,
            &Time(9999999),
            &config(),
            &intent(),
            &h(9),
            Some((&msg, &sig))
        ))
        .unwrap(),
        Outcome::Confirmed(_)
    ));
}

#[test]
fn payment_poll_persists_received_and_reuses_only_fresh_finalized_proof() {
    let repo = Memory::default();
    let i = intent();
    let (_, sig, t) = authorization(&i);
    run(repo.insert(&Order::create(&config(), i, &t).unwrap())).unwrap();
    run(orders::confirm(
        &repo,
        &Time(1005000),
        &config(),
        KEY,
        orders::Confirm {
            payment_intent: t,
            payment_txid: h(9),
            payer_signature: format!("0x{}", crypto::hex(&sig)),
        },
    ))
    .unwrap();
    let mut e = Evm::new();
    e.receipt = Value::Null;
    let id = repo
        .order
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .order_id
        .clone();
    assert!(
        run(orders::receive(&repo, &e, &Time(1005000), &config(), &id))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        repo.order.lock().unwrap().as_ref().unwrap().phase,
        orders::Phase::Verifying
    );
    let e = Evm::new();
    let received = run(orders::receive(&repo, &e, &Time(1005000), &config(), &id))
        .unwrap()
        .unwrap();
    assert_eq!(received.phase, orders::Phase::Received);
    let calls = e.calls.lock().unwrap().len();
    run(orders::receive(&repo, &e, &Time(1005001), &config(), &id)).unwrap();
    assert_eq!(e.calls.lock().unwrap().len(), calls);
    run(orders::receive(&repo, &e, &Time(1065000), &config(), &id)).unwrap();
    assert!(e.calls.lock().unwrap().len() > calls);
}

#[test]
fn late_first_confirm_recovers_old_order_but_never_accepts_payment_after_quote() {
    let i = intent();
    let (_, sig, token) = authorization(&i);
    for late_payment in [false, true] {
        let repo = Memory::default();
        run(repo.insert(&Order::create(&config(), i.clone(), &token).unwrap())).unwrap();
        run(orders::confirm(
            &repo,
            &Time(9_999_999),
            &config(),
            KEY,
            orders::Confirm {
                payment_intent: token.clone(),
                payment_txid: h(9),
                payer_signature: format!("0x{}", crypto::hex(&sig)),
            },
        ))
        .unwrap();
        let id = repo
            .order
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .order_id
            .clone();
        let mut evm = Evm::new();
        if late_payment {
            evm.block["timestamp"] = json!("0x641");
        }
        let order = run(orders::receive(
            &repo,
            &evm,
            &Time(9_999_999),
            &config(),
            &id,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(
            order.phase,
            if late_payment {
                orders::Phase::Exception
            } else {
                orders::Phase::Received
            }
        );
        assert!(order.signed.is_none());
    }
}
