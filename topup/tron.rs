//! Tron主网固化节点事实；按真实TRC20日志归属付款，不将同名币或余额变化当付款。
use super::{
    config::Config,
    intent::Intent,
    orders::{Outcome, Payment},
    ports::{Clock, Method, PaymentRpc},
    wallet_authorization as wallet,
};
use crate::shared::{crypto, Error, Result};
use base58::{FromBase58, ToBase58};
use serde_json::{json, Value};
pub const GENESIS: &str = "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";
fn invalid() -> Error {
    Error::new(409, "topup_tron_evidence_invalid")
}
fn checksum(b: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(Sha256::digest(b))[..4].to_vec()
}
pub fn address(s: &str) -> bool {
    let Ok(b) = s.from_base58() else { return false };
    b.len() == 25 && b[0] == 0x41 && b[21..] == checksum(&b[..21]) && b.to_base58() == s
}
pub fn hex_address(s: &str) -> Result<String> {
    if !address(s) {
        return Err(invalid());
    }
    Ok(crypto::hex(&s.from_base58().map_err(|_| invalid())?[..21]))
}
pub fn from_hex(s: &str) -> Result<String> {
    let mut b = crypto::unhex(s).map_err(|_| invalid())?;
    if b.len() == 20 {
        b.insert(0, 0x41);
    }
    if b.len() != 21 || b[0] != 0x41 {
        return Err(invalid());
    }
    b.extend(checksum(&b));
    Ok(b.to_base58())
}
pub fn digest(message: &str) -> [u8; 32] {
    super::evm_verify::sha3_digest(
        format!("\x19TRON Signed Message:\n{}{}", message.len(), message).as_bytes(),
    )
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(invalid)
}
fn block(v: &Value) -> Result<(String, u64, u64)> {
    let hash = text(v, "blockID")?;
    if !crate::shared::ids::hex(hash, 32, false) {
        return Err(invalid());
    }
    Ok((
        hash.into(),
        v["block_header"]["raw_data"]["number"]
            .as_u64()
            .unwrap_or(0),
        v["block_header"]["raw_data"]["timestamp"]
            .as_u64()
            .ok_or_else(invalid)?,
    ))
}
pub async fn verify<R: PaymentRpc, C: Clock>(
    rpc: &R,
    clock: &C,
    c: &Config,
    i: &Intent,
    tx: &str,
    message: &str,
    sig: &[u8],
) -> Result<Outcome> {
    i.validate(c)?;
    if i.network != super::config::Network::Tron || !i.network.txid(tx) {
        return Err(invalid());
    }
    let checked = clock.now();
    if rpc.call(Method::TronGenesis, json!({"num":0})).await?["blockID"] != GENESIS {
        return Err(Error::new(409, "topup_wrong_chain"));
    }
    if from_hex(&wallet::recover(&digest(message), sig)?)? != i.payer_address {
        return Err(wallet::bad());
    }
    let transaction = rpc
        .call(Method::TronTransaction, json!({"value":tx}))
        .await?;
    let receipt = rpc.call(Method::TronReceipt, json!({"value":tx})).await?;
    if transaction.as_object().is_some_and(|o| o.is_empty())
        || receipt.as_object().is_some_and(|o| o.is_empty())
    {
        return Ok(Outcome::Pending);
    }
    if text(&transaction, "txID")? != tx
        || text(&receipt, "id")? != tx
        || receipt["receipt"]["result"] != "SUCCESS"
        || transaction["ret"]
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| a[0]["contractRet"].as_str())
            != Some("SUCCESS")
    {
        return Err(invalid());
    }
    let raw = crypto::unhex(text(&transaction, "raw_data_hex")?).map_err(|_| invalid())?;
    if raw.is_empty() || raw.len() > 65536 || crypto::sha256_hex(&raw) != tx {
        return Err(invalid());
    }
    let number = receipt["blockNumber"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    let canonical = rpc.call(Method::TronBlock, json!({"num":number})).await?;
    let (hash, n, time) = block(&canonical)?;
    if n != number
        || receipt["blockTimeStamp"].as_u64() != Some(time)
        || time <= i.issued_at
        || time > i.expires_at
        || time > checked
    {
        return Err(invalid());
    }
    let matches = canonical["transactions"]
        .as_array()
        .filter(|a| a.len() <= 10000)
        .ok_or_else(invalid)?;
    let positions = matches
        .iter()
        .enumerate()
        .filter(|(_, v)| v["txID"] == tx)
        .collect::<Vec<_>>();
    if positions.len() != 1 || positions[0].1["raw_data_hex"] != transaction["raw_data_hex"] {
        return Err(invalid());
    }
    let contracts = transaction["raw_data"]["contract"]
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or_else(invalid)?;
    let trigger = &contracts[0];
    if trigger["type"] != "TriggerSmartContract"
        || trigger["parameter"]["type_url"] != "type.googleapis.com/protocol.TriggerSmartContract"
    {
        return Err(invalid());
    }
    let v = &trigger["parameter"]["value"];
    if from_hex(text(v, "owner_address")?)? != i.payer_address
        || from_hex(text(v, "contract_address")?)? != i.asset
    {
        return Err(invalid());
    }
    let logs = receipt["log"]
        .as_array()
        .filter(|a| a.len() <= 1024)
        .ok_or_else(invalid)?;
    let topic = crypto::hex(&super::evm_verify::sha3_digest(
        b"Transfer(address,address,uint256)",
    ));
    let mut found = None;
    for (index, l) in logs.iter().enumerate() {
        if from_hex(text(l, "address")?)? != i.asset {
            continue;
        }
        let topics = l["topics"]
            .as_array()
            .filter(|a| a.len() <= 4)
            .ok_or_else(invalid)?;
        if topics.first().and_then(Value::as_str) != Some(&topic) {
            continue;
        }
        if topics.len() != 3 {
            return Err(invalid());
        }
        let addr = |v: &Value| -> Result<String> {
            let b = crypto::unhex(v.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
            if b.len() != 32 || b[..12].iter().any(|b| *b != 0) {
                return Err(invalid());
            }
            from_hex(&crypto::hex(&b[12..]))
        };
        if addr(&topics[1])? != i.payer_address || addr(&topics[2])? != i.recv_address {
            continue;
        }
        let data = crypto::unhex(text(l, "data")?).map_err(|_| invalid())?;
        if data.len() != 32 {
            return Err(invalid());
        }
        let mut min = [0; 32];
        min[16..].copy_from_slice(
            &i.pay_amount
                .parse::<u128>()
                .map_err(|_| invalid())?
                .to_be_bytes(),
        );
        if data.as_slice() < min.as_slice() {
            continue;
        }
        if found
            .replace((index as u32, super::evm_verify::decimal(&data)))
            .is_some()
        {
            return Err(Error::new(409, "topup_ambiguous_payment"));
        }
    }
    let (li, amount) = found.ok_or_else(invalid)?;
    if rpc.call(Method::TronBlock, json!({"num":number})).await?["blockID"] != hash {
        return Err(invalid());
    }
    let p = Payment {
        tx_hash: tx.into(),
        block_hash: hash,
        block_number: number,
        transaction_index: positions[0].0 as u32,
        log_index: li,
        block_time_ms: time,
        actual_amount: amount,
        wallet_is_contract: false,
        payer_authorization_hash: wallet::signature_hash(sig, false)?,
        checked_at: checked,
        verification_deadline: checked.checked_add(60000).ok_or_else(invalid)?,
    };
    p.require_fresh(clock.now())?;
    Ok(Outcome::Confirmed(p))
}
