//! 独立公共EVM入口。先验证整批ID，再逐项代理；永不代理通知或任意Substrate方法。
use crate::shared::{ids, Error, Result};
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
pub const METHODS: [&str; 26] = [
    "eth_accounts",
    "eth_blockNumber",
    "eth_call",
    "eth_chainId",
    "eth_estimateGas",
    "eth_gasPrice",
    "eth_getBalance",
    "eth_getBlockByHash",
    "eth_getBlockByNumber",
    "eth_getBlockTransactionCountByHash",
    "eth_getBlockTransactionCountByNumber",
    "eth_getCode",
    "eth_getLogs",
    "eth_getStorageAt",
    "eth_getTransactionByBlockHashAndIndex",
    "eth_getTransactionByBlockNumberAndIndex",
    "eth_getTransactionByHash",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_maxPriorityFeePerGas",
    "eth_sendRawTransaction",
    "eth_syncing",
    "net_listening",
    "net_version",
    "web3_clientVersion",
    "eth_feeHistory",
];
// 永久公共 RPC 固定为国储会域名，只允许准确 HTTPS 根路径。
pub fn target(raw: &str) -> Result<url::Url> {
    let u = url::Url::parse(raw).map_err(|_| Error::new(400, "rpc_host_invalid"))?;
    if u.scheme() != "https"
        || u.origin().ascii_serialization() != "https://nrcrpc.crcfrcn.com"
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(Error::new(404, "rpc_route_not_found"));
    }
    Ok(u)
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    pub params: Value,
}
pub struct Batch {
    pub batch: bool,
    pub items: Vec<std::result::Result<Request, Value>>,
}
pub fn fault(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn valid_id(v: &Value) -> bool {
    match v {
        Value::String(s) => !s.is_empty() && s.len() <= 128,
        Value::Number(n) => n
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991),
        _ => false,
    }
}
pub fn parse(body: &[u8]) -> std::result::Result<Batch, Value> {
    if body.len() > 128 * 1024 {
        return Err(fault(Value::Null, -32600, "Request too large"));
    }
    let root: Box<RawValue> =
        serde_json::from_slice(body).map_err(|_| fault(Value::Null, -32700, "Parse error"))?;
    let batch = root.get().trim_start().starts_with('[');
    let raw = if batch {
        serde_json::from_str::<Vec<Box<RawValue>>>(root.get())
            .map_err(|_| fault(Value::Null, -32600, "Invalid Request"))?
    } else {
        vec![root]
    };
    if raw.is_empty() || raw.len() > 20 {
        return Err(fault(Value::Null, -32600, "Invalid batch size"));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut items = vec![];
    for r in raw {
        let hint: Value =
            serde_json::from_str(r.get()).map_err(|_| fault(Value::Null, -32700, "Parse error"))?;
        let id = hint.get("id").cloned().unwrap_or(Value::Null);
        if !valid_id(&id) || !seen.insert(id.to_string()) {
            return Err(fault(Value::Null, -32600, "Invalid or duplicate id"));
        }
        if serde_json::from_str::<Unique>(r.get()).is_err() {
            items.push(Err(fault(id, -32600, "Duplicate JSON field")));
            continue;
        }
        let req = serde_json::from_str::<Request>(r.get());
        items.push(match req {
            Ok(v) if v.jsonrpc == "2.0" => match v.validate() {
                Ok(()) => Ok(v),
                Err(code) => Err(fault(
                    id,
                    code,
                    if code == -32601 {
                        "Method not found"
                    } else {
                        "Invalid params"
                    },
                )),
            },
            _ => Err(fault(id, -32600, "Invalid Request")),
        });
    }
    Ok(Batch { batch, items })
}
// 在Value折叠重复键之前遍历整个params，包括accessList和嵌套日志筛选。
struct Unique;
impl<'de> serde::Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut keys = std::collections::BTreeSet::new();
                while let Some(k) = a.next_key::<String>()? {
                    if !keys.insert(k) {
                        return Err(serde::de::Error::custom("duplicate field"));
                    }
                    a.next_value::<Unique>()?;
                }
                Ok(Unique)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                while a.next_element::<Unique>()?.is_some() {}
                Ok(Unique)
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
        }
        d.deserialize_any(Visitor)
    }
}
fn hexdata(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.starts_with("0x")
            && (s.len() - 2) % 2 == 0
            && s.len() <= 2 + max * 2
            && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}
fn address(v: &Value) -> bool {
    v.as_str().is_some_and(|s| ids::hex(s, 20, true))
}
fn hash(v: &Value) -> bool {
    v.as_str().is_some_and(|s| ids::hex(s, 32, true))
}
pub fn quantity(v: &Value) -> Option<u64> {
    v.as_str()
        .and_then(|s| super::super::topup::evm_verify::quantity_u64(s).ok())
}
fn q256(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s == "0x0"
            || s.strip_prefix("0x").is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && !s.starts_with('0')
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            })
    })
}
fn block(v: &Value) -> bool {
    quantity(v).is_some()
        || v.as_str()
            .is_some_and(|s| matches!(s, "latest" | "earliest" | "pending" | "safe" | "finalized"))
}
fn keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}
fn tx(v: &Value) -> bool {
    if !keys(
        v,
        &[
            "from",
            "to",
            "gas",
            "gasPrice",
            "value",
            "data",
            "input",
            "nonce",
            "maxFeePerGas",
            "maxPriorityFeePerGas",
            "type",
            "accessList",
        ],
    ) {
        return false;
    }
    let o = v.as_object().expect("validated object");
    for (k, v) in o {
        if !match k.as_str() {
            "from" | "to" => address(v),
            "data" | "input" => hexdata(v, 65536),
            "accessList" => v.as_array().is_some_and(|a| {
                a.len() <= 64
                    && a.iter().all(|v| {
                        keys(v, &["address", "storageKeys"])
                            && address(&v["address"])
                            && v["storageKeys"]
                                .as_array()
                                .is_some_and(|a| a.len() <= 64 && a.iter().all(hash))
                    })
            }),
            _ => q256(v),
        } {
            return false;
        }
    }
    !(o.contains_key("data") && o.contains_key("input") && o["data"] != o["input"])
}
fn logs(v: &Value) -> bool {
    if !keys(
        v,
        &["fromBlock", "toBlock", "blockHash", "address", "topics"],
    ) {
        return false;
    }
    if let Some(h) = v.get("blockHash") {
        if !hash(h) || v.get("fromBlock").is_some() || v.get("toBlock").is_some() {
            return false;
        }
    } else {
        let Some(f) = quantity(&v["fromBlock"]) else {
            return false;
        };
        let Some(t) = quantity(&v["toBlock"]) else {
            return false;
        };
        if t < f || t - f >= 1000 {
            return false;
        }
    }
    if let Some(a) = v.get("address") {
        if !(address(a)
            || a.as_array()
                .is_some_and(|a| !a.is_empty() && a.len() <= 32 && a.iter().all(address)))
        {
            return false;
        }
    }
    if let Some(t) = v.get("topics") {
        if !t.as_array().is_some_and(|a| {
            a.len() <= 4
                && a.iter().all(|v| {
                    v.is_null()
                        || hash(v)
                        || v.as_array()
                            .is_some_and(|a| !a.is_empty() && a.len() <= 32 && a.iter().all(hash))
                })
        }) {
            return false;
        }
    }
    true
}
impl Request {
    pub fn validate(&self) -> std::result::Result<(), i32> {
        if !METHODS.contains(&self.method.as_str()) {
            return Err(-32601);
        }
        let Some(p) = self.params.as_array() else {
            return Err(-32602);
        };
        let good = match self.method.as_str() {
            "eth_call" => p.len() == 2 && tx(&p[0]) && block(&p[1]),
            "eth_estimateGas" => {
                (p.len() == 1 || p.len() == 2) && tx(&p[0]) && (p.len() == 1 || block(&p[1]))
            }
            "eth_getBalance" | "eth_getCode" | "eth_getTransactionCount" => {
                p.len() == 2 && address(&p[0]) && block(&p[1])
            }
            "eth_getStorageAt" => p.len() == 3 && address(&p[0]) && q256(&p[1]) && block(&p[2]),
            "eth_getBlockByHash" => p.len() == 2 && hash(&p[0]) && p[1].is_boolean(),
            "eth_getBlockByNumber" => p.len() == 2 && block(&p[0]) && p[1].is_boolean(),
            "eth_getBlockTransactionCountByHash"
            | "eth_getTransactionByHash"
            | "eth_getTransactionReceipt" => p.len() == 1 && hash(&p[0]),
            "eth_getBlockTransactionCountByNumber" => p.len() == 1 && block(&p[0]),
            "eth_getTransactionByBlockHashAndIndex" => {
                p.len() == 2 && hash(&p[0]) && quantity(&p[1]).is_some()
            }
            "eth_getTransactionByBlockNumberAndIndex" => {
                p.len() == 2 && block(&p[0]) && quantity(&p[1]).is_some()
            }
            "eth_getLogs" => p.len() == 1 && logs(&p[0]),
            "eth_sendRawTransaction" => p.len() == 1 && hexdata(&p[0], 65536) && p[0] != "0x",
            "eth_feeHistory" => {
                p.len() == 3
                    && quantity(&p[0]).is_some_and(|n| (1..=1024).contains(&n))
                    && block(&p[1])
                    && p[2].as_array().is_some_and(|a| {
                        a.len() <= 100
                            && a.iter().all(|v| {
                                v.as_f64()
                                    .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
                            })
                            && a.windows(2).all(|v| v[0].as_f64() <= v[1].as_f64())
                    })
            }
            _ => p.is_empty(),
        };
        if good {
            Ok(())
        } else {
            Err(-32602)
        }
    }
    pub fn write(&self) -> bool {
        self.method == "eth_sendRawTransaction"
    }
    pub fn reply(&self, v: Value) -> Result<Value> {
        if v.get("result").is_some()
            && ((self.method == "eth_chainId" && v["result"] != "0x7eb")
                || (self.method == "net_version" && v["result"] != "2027"))
        {
            return Err(Error::new(503, "ethereum_rpc_wrong_chain"));
        }
        if !keys(&v, &["jsonrpc", "id", "result", "error"])
            || v["jsonrpc"] != "2.0"
            || v["id"] != self.id
            || v.get("result").is_some() == v.get("error").is_some()
        {
            return Err(Error::new(503, "ethereum_rpc_unavailable"));
        }
        if let Some(e) = v.get("error") {
            if !keys(e, &["code", "message", "data"])
                || e["code"].as_i64().is_none()
                || !e["message"].as_str().is_some_and(|s| s.len() <= 1024)
            {
                return Err(Error::new(503, "ethereum_rpc_unavailable"));
            }
            return Ok(fault(
                self.id.clone(),
                e["code"]
                    .as_i64()
                    .and_then(|v| i32::try_from(v).ok())
                    .ok_or(Error::new(503, "ethereum_rpc_unavailable"))?,
                "Upstream RPC error",
            ));
        }
        Ok(v)
    }
}
pub async fn execute<E: super::network_ports::Ethereum>(rpc: &E, b: Batch) -> Value {
    let mut out = vec![];
    let mut size = 0usize;
    let mut exhausted = false;
    for item in b.items {
        let result = match item {
            Err(v) => v,
            Ok(r) if exhausted => fault(r.id, -32000, "Response budget exhausted"),
            Ok(r) => match rpc.call(&r).await.and_then(|v| r.reply(v)) {
                Ok(v) => {
                    let n = serde_json::to_vec(&v)
                        .map(|v| v.len())
                        .unwrap_or(usize::MAX);
                    if n > 1024 * 1024 || size.saturating_add(n) > 2 * 1024 * 1024 - 16384 {
                        exhausted = true;
                        fault(r.id, -32000, "Response budget exhausted")
                    } else {
                        size += n;
                        v
                    }
                }
                Err(_) => fault(r.id, -32000, "RPC unavailable"),
            },
        };
        out.push(result);
    }
    if b.batch {
        json!(out)
    } else {
        out.remove(0)
    }
}
