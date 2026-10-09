use citizenserve::{
    chain::{
        ethereum_rpc::{self as rpc, Request},
        network_ports::Ethereum,
    },
    shared::Result,
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
        _ => panic!("immediate mock"),
    }
}
struct Node(Mutex<Vec<String>>);
impl Ethereum for Node {
    async fn call(&self, r: &Request) -> Result<Value> {
        self.0.lock().unwrap().push(r.method.clone());
        Ok(json!({"jsonrpc":"2.0","id":r.id,"result":null}))
    }
}
#[test]
fn all_twenty_six_methods_pass_independent_contract() {
    let f: Value = serde_json::from_str(include_str!("contract/ethereum_rpc.json")).unwrap();
    assert_eq!(f["requests"].as_array().unwrap().len(), 26);
    for v in f["requests"].as_array().unwrap() {
        let r: Request = serde_json::from_value(v.clone()).unwrap();
        r.validate().unwrap();
        let b = rpc::parse(v.to_string().as_bytes()).unwrap();
        assert!(b.items[0].is_ok());
    }
}
#[test]
fn invalid_items_never_reach_node_and_mixed_batch_has_per_item_errors() {
    let b=rpc::parse(br#"[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"author_submitExtrinsic","params":[]},{"jsonrpc":"2.0","id":3,"method":"eth_getBalance","params":[]}]"#).unwrap();
    let node = Node(Mutex::new(vec![]));
    let out = run(rpc::execute(&node, b));
    assert_eq!(node.0.lock().unwrap().as_slice(), ["eth_chainId"]);
    assert_eq!(out[1]["error"]["code"], -32601);
    assert_eq!(out[2]["error"]["code"], -32602);
}
#[test]
fn duplicate_ids_notifications_batch_and_body_limits_block_all_work() {
    for v in [br#"[]"#.as_slice(),br#"{"jsonrpc":"2.0","method":"eth_chainId","params":[]}"#,br#"[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}]"#]{assert!(rpc::parse(v).is_err())}
    let v = json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]});
    let batch = Value::Array(vec![v; 21]);
    assert!(rpc::parse(batch.to_string().as_bytes()).is_err());
    assert!(rpc::parse(&vec![b' '; 128 * 1024 + 1]).is_err());
}
#[test]
fn expensive_queries_are_bounded_and_unknown_tx_fields_closed() {
    for (method, params) in [
        (
            "eth_getLogs",
            json!([{"fromBlock":"0x0","toBlock":"0x3e8"}]),
        ),
        (
            "eth_getLogs",
            json!([{"fromBlock":"latest","toBlock":"latest"}]),
        ),
        ("eth_feeHistory", json!(["0x401", "latest", []])),
        ("eth_feeHistory", json!(["0x1", "latest", [75, 25]])),
        ("eth_call", json!([{"privateKey":"secret"},"latest"])),
        (
            "eth_sendRawTransaction",
            json!([format!("0x{}", "11".repeat(65537))]),
        ),
    ] {
        assert!(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: method.into(),
            params
        }
        .validate()
        .is_err())
    }
}
#[test]
fn replies_must_match_id_and_have_exactly_one_result_or_error() {
    let r = Request {
        jsonrpc: "2.0".into(),
        id: json!(1),
        method: "eth_chainId".into(),
        params: json!([]),
    };
    for v in [
        json!({"jsonrpc":"2.0","id":2,"result":"0x1"}),
        json!({"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-1,"message":"bad"}}),
    ] {
        assert!(r.reply(v).is_err())
    }
    let e=r.reply(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"backend details","data":"secret"}})).unwrap();
    assert_eq!(e["error"]["message"], "Upstream RPC error");
    assert!(e["error"].get("data").is_none());
}

#[test]
fn nested_duplicate_rpc_fields_are_not_silently_collapsed() {
    let p=rpc::parse(br#"{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x1111111111111111111111111111111111111111","gas":"0x1","gas":"0x2"},"latest"]}"#).unwrap();
    assert!(p.items[0].is_err());
}

#[test]
fn wrong_chain_cannot_be_reported_as_citizenchain() {
    for (method, result) in [
        ("eth_chainId", json!("0x2105")),
        ("net_version", json!("8453")),
    ] {
        let r = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: method.into(),
            params: json!([]),
        };
        assert!(r
            .reply(json!({"jsonrpc":"2.0","id":1,"result":result}))
            .is_err());
    }
}
#[test]
fn aggregate_reply_budget_stops_further_upstream_work() {
    struct Large(Mutex<u32>);
    impl Ethereum for Large {
        async fn call(&self, r: &Request) -> Result<Value> {
            *self.0.lock().unwrap() += 1;
            Ok(json!({"jsonrpc":"2.0","id":r.id,"result":"a".repeat(700000)}))
        }
    }
    let node = Large(Mutex::new(0));
    let requests=(0..20).map(|i|json!({"jsonrpc":"2.0","id":i,"method":"eth_getTransactionReceipt","params":[format!("0x{}","22".repeat(32))]})).collect::<Vec<_>>();
    let b = rpc::parse(json!(requests).to_string().as_bytes()).unwrap();
    let r = run(rpc::execute(&node, b));
    assert!(r.to_string().len() < 2 * 1024 * 1024);
    assert!(*node.0.lock().unwrap() <= 3);
    assert_eq!(r[19]["error"]["code"], -32000);
}
