//! 只接受主网finalized的原SPL Token转账；账户mint和双方owner必须来自同笔交易。
use super::{
    config::Config,
    intent::Intent,
    orders::{Outcome, Payment},
    ports::{Clock, Method, PaymentRpc},
};
use crate::shared::{crypto, Error, Result};
use base58::{FromBase58, ToBase58};
use serde_json::{json, Value};
pub const GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
pub const PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
fn invalid() -> Error {
    Error::new(409, "topup_solana_evidence_invalid")
}
pub fn address(s: &str) -> bool {
    s.from_base58()
        .is_ok_and(|b| b.len() == 32 && b.to_base58() == s)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(invalid)
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
    if i.network != super::config::Network::Solana || !i.network.txid(tx) {
        return Err(invalid());
    }
    let checked = clock.now();
    if rpc.call(Method::SolGenesis, json!([])).await? != GENESIS {
        return Err(Error::new(409, "topup_wrong_chain"));
    }
    let key: [u8; 32] = i
        .payer_address
        .from_base58()
        .map_err(|_| invalid())?
        .try_into()
        .map_err(|_| invalid())?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| invalid())?;
    let signature = ed25519_dalek::Signature::from_slice(sig)
        .map_err(|_| super::wallet_authorization::bad())?;
    key.verify_strict(message.as_bytes(), &signature)
        .map_err(|_| super::wallet_authorization::bad())?;
    let v=rpc.call(Method::SolTransaction,json!([tx,{"commitment":"finalized","encoding":"jsonParsed","maxSupportedTransactionVersion":0}])).await?;
    if v.is_null() {
        return Ok(Outcome::Pending);
    }
    if v["meta"].is_null()
        || v["meta"].get("err") != Some(&Value::Null)
        || !(v["version"] == "legacy" || v["version"] == 0)
        || v["transaction"]["signatures"][0] != tx
    {
        return Err(invalid());
    }
    let slot = v["slot"].as_u64().ok_or_else(invalid)?;
    let time = v["blockTime"]
        .as_u64()
        .and_then(|t| t.checked_mul(1000))
        .ok_or_else(invalid)?;
    if time <= i.issued_at || time > i.expires_at || time > checked {
        return Err(invalid());
    }
    let message = &v["transaction"]["message"];
    let keys = message["accountKeys"]
        .as_array()
        .filter(|a| a.len() <= 256)
        .ok_or_else(invalid)?;
    // jsonParsed同时展开地址表；使用真实accountIndex，不能把mint与账户位置混用。
    let balances = v["meta"]["preTokenBalances"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .chain(
            v["meta"]["postTokenBalances"]
                .as_array()
                .ok_or_else(invalid)?,
        );
    let mut owners = std::collections::BTreeMap::new();
    let mut facts = std::collections::BTreeMap::new();
    for b in balances {
        let index = b["accountIndex"].as_u64().ok_or_else(invalid)?;
        let fact = (text(b, "mint")?, text(b, "owner")?, text(b, "programId")?);
        if facts.insert(index, fact).is_some_and(|old| old != fact) {
            return Err(invalid());
        }
        if b["mint"] != i.asset {
            continue;
        }
        if b["programId"] != PROGRAM || b["uiTokenAmount"]["decimals"] != 6 {
            return Err(invalid());
        }
        let index = b["accountIndex"].as_u64().ok_or_else(invalid)? as usize;
        let account = text(keys.get(index).ok_or_else(invalid)?, "pubkey")?;
        let owner = text(b, "owner")?;
        if !address(account)
            || !address(owner)
            || owners
                .insert(account, owner)
                .is_some_and(|old| old != owner)
        {
            return Err(invalid());
        }
    }
    let mut instructions = message["instructions"]
        .as_array()
        .filter(|a| a.len() <= 1024)
        .ok_or_else(invalid)?
        .iter()
        .collect::<Vec<_>>();
    let inner = v["meta"]["innerInstructions"]
        .as_array()
        .filter(|a| a.len() <= 1024)
        .ok_or_else(invalid)?;
    let mut seen = std::collections::BTreeSet::new();
    for group in inner {
        let index = group["index"].as_u64().ok_or_else(invalid)?;
        if index
            >= message["instructions"]
                .as_array()
                .ok_or_else(invalid)?
                .len() as u64
            || !seen.insert(index)
        {
            return Err(invalid());
        }
        instructions.extend(
            group["instructions"]
                .as_array()
                .filter(|a| a.len() <= 1024)
                .ok_or_else(invalid)?,
        );
    }
    if instructions.len() > 2048 {
        return Err(invalid());
    }
    let mut found = None;
    for (index, ins) in instructions.iter().enumerate() {
        if ins["programId"] != PROGRAM {
            continue;
        }
        let parsed = &ins["parsed"];
        let kind = text(parsed, "type")?;
        if kind != "transfer" && kind != "transferChecked" {
            continue;
        }
        let info = &parsed["info"];
        let source = text(info, "source")?;
        let dest = text(info, "destination")?;
        if owners.get(source) != Some(&i.payer_address.as_str())
            || owners.get(dest) != Some(&i.recv_address.as_str())
        {
            continue;
        }
        let amount = if kind == "transferChecked" {
            if info["mint"] != i.asset || info["tokenAmount"]["decimals"] != 6 {
                return Err(invalid());
            }
            text(&info["tokenAmount"], "amount")?
        } else {
            text(info, "amount")?
        };
        if amount.is_empty()
            || amount.len() > 20
            || amount.bytes().any(|b| !b.is_ascii_digit())
            || amount.starts_with('0')
        {
            return Err(invalid());
        }
        let n = amount.parse::<u64>().map_err(|_| invalid())?;
        if u128::from(n) < i.pay_amount.parse::<u128>().map_err(|_| invalid())? {
            continue;
        }
        if found.replace((index as u32, amount.to_owned())).is_some() {
            return Err(Error::new(409, "topup_ambiguous_payment"));
        }
    }
    let (index, amount) = found.ok_or_else(invalid)?;
    let block=rpc.call(Method::SolBlock,json!([slot,{"commitment":"finalized","transactionDetails":"signatures","rewards":false,"maxSupportedTransactionVersion":0}])).await?;
    let bh = text(&block, "blockhash")?;
    if !address(bh)
        || block["blockTime"]
            .as_u64()
            .and_then(|n| n.checked_mul(1000))
            != Some(time)
    {
        return Err(invalid());
    }
    let signatures = block["signatures"]
        .as_array()
        .filter(|a| a.len() <= 10000)
        .ok_or_else(invalid)?;
    let positions = signatures
        .iter()
        .enumerate()
        .filter(|(_, v)| v.as_str() == Some(tx))
        .collect::<Vec<_>>();
    if positions.len() != 1 {
        return Err(invalid());
    }

    let p = Payment {
        tx_hash: tx.into(),
        block_hash: bh.into(),
        block_number: slot,
        transaction_index: positions[0].0 as u32,
        log_index: index,
        block_time_ms: time,
        actual_amount: amount,
        wallet_is_contract: false,
        payer_authorization_hash: crypto::sha256_hex(sig),
        checked_at: checked,
        verification_deadline: checked.checked_add(60000).ok_or_else(invalid)?,
    };
    p.require_fresh(clock.now())?;
    Ok(Outcome::Confirmed(p))
}
