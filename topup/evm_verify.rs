//! 付款与合约钱包签名使用同一canonical付款块；最后复核块hash防读取期间换叉。
use super::{
    config::Config,
    intent::Intent,
    ports::{Clock, PaymentRpc},
    wallet_authorization,
};
use crate::shared::{crypto, ids, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Method {
    ChainId,
    Transaction,
    Receipt,
    Block,
    Code,
    Call,
    BlockNumber,
}
impl Method {
    pub const fn name(self) -> &'static str {
        match self {
            Self::ChainId => "eth_chainId",
            Self::Transaction => "eth_getTransactionByHash",
            Self::Receipt => "eth_getTransactionReceipt",
            Self::Block => "eth_getBlockByNumber",
            Self::Code => "eth_getCode",
            Self::Call => "eth_call",
            Self::BlockNumber => "eth_blockNumber",
        }
    }
}
pub fn invalid() -> Error {
    Error::new(503, "topup_evm_evidence_invalid")
}
pub fn data_hex(v: &str) -> Result<Vec<u8>> {
    if !v.starts_with("0x") {
        return Err(invalid());
    }
    crypto::unhex(v).map_err(|_| invalid())
}
pub fn quantity(n: u64) -> String {
    format!("0x{n:x}")
}
pub fn quantity_u64(s: &str) -> Result<u64> {
    let s = s.strip_prefix("0x").ok_or_else(invalid)?;
    if s.is_empty()
        || s.len() > 16
        || s.len() > 1 && s.starts_with('0')
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    u64::from_str_radix(s, 16).map_err(|_| invalid())
}
fn number(v: &Value) -> Result<u64> {
    quantity_u64(v.as_str().ok_or_else(invalid)?)
}
fn hash(v: &Value) -> Result<String> {
    let s = v.as_str().ok_or_else(invalid)?;
    if !ids::hex(s, 32, true) {
        return Err(invalid());
    }
    Ok(s.into())
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payment {
    pub tx_hash: String,
    pub block_hash: String,
    pub block_number: u64,
    pub transaction_index: u32,
    pub log_index: u32,
    pub block_time_ms: u64,
    pub actual_amount: String,
    pub wallet_is_contract: bool,
    pub payer_authorization_hash: String,
    pub checked_at: u64,
    pub verification_deadline: u64,
}
impl Payment {
    pub fn require_fresh(&self, now: u64) -> Result<()> {
        if self.checked_at > now
            || now >= self.verification_deadline
            || self.verification_deadline.checked_sub(self.checked_at) != Some(60000)
        {
            Err(Error::new(503, "topup_verification_expired"))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug)]
pub enum Outcome {
    Pending,
    Confirmed(Payment),
}
pub async fn verify<R: PaymentRpc, C: Clock>(
    rpc: &R,
    clock: &C,
    c: &Config,
    i: &Intent,
    tx: &str,
    authorization: Option<(&str, &[u8])>,
) -> Result<Outcome> {
    c.validate()?;
    i.validate(c)?;
    if !ids::hex(tx, 32, true) {
        return Err(super::routes::invalid());
    }
    let checked = clock.now();
    if number(&rpc.call(Method::ChainId, json!([])).await?)? != i.chain_id {
        return Err(Error::new(409, "topup_wrong_chain"));
    }
    let receipt = rpc.call(Method::Receipt, json!([tx])).await?;
    if receipt.is_null() {
        return Ok(Outcome::Pending);
    }
    if hash(&receipt["transactionHash"])? != tx || number(&receipt["status"])? != 1 {
        return Err(Error::new(409, "topup_payment_invalid"));
    }
    let transaction = rpc.call(Method::Transaction, json!([tx])).await?;
    if transaction.is_null() {
        return Err(invalid());
    }
    let block_number = number(&receipt["blockNumber"])?;
    let block_hash = hash(&receipt["blockHash"])?;
    let index = number(&receipt["transactionIndex"])?;
    if hash(&transaction["hash"])? != tx
        || hash(&transaction["blockHash"])? != block_hash
        || number(&transaction["blockNumber"])? != block_number
        || number(&transaction["transactionIndex"])? != index
    {
        return Err(invalid());
    }
    let block = rpc
        .call(Method::Block, json!([quantity(block_number), false]))
        .await?;
    if block.is_null() {
        return Ok(Outcome::Pending);
    }
    if hash(&block["hash"])? != block_hash || number(&block["number"])? != block_number {
        return Err(Error::new(409, "topup_payment_reorged"));
    }
    let transactions = block["transactions"]
        .as_array()
        .filter(|a| a.len() <= 10000)
        .ok_or_else(invalid)?;
    if transactions.get(index as usize).and_then(Value::as_str) != Some(tx)
        || transactions
            .iter()
            .filter(|s| s.as_str() == Some(tx))
            .count()
            != 1
    {
        return Err(invalid());
    }
    let time = number(&block["timestamp"])?
        .checked_mul(1000)
        .ok_or_else(invalid)?;
    if time <= i.issued_at || time > i.expires_at {
        return Err(Error::new(409, "topup_payment_outside_intent"));
    }
    let head = rpc
        .call(
            Method::Block,
            json!([
                if c.min_confirmations == 0 {
                    "finalized"
                } else {
                    "latest"
                },
                false
            ]),
        )
        .await?;
    if head.is_null() {
        return Ok(Outcome::Pending);
    }
    let head_number = number(&head["number"])?;
    hash(&head["hash"])?;
    let required = block_number
        .checked_add(c.min_confirmations.saturating_sub(1))
        .ok_or_else(invalid)?;
    if head_number < required {
        return Ok(Outcome::Pending);
    }
    let code = rpc
        .call(
            Method::Code,
            json!([i.token_contract, quantity(block_number)]),
        )
        .await?;
    let code = data_hex(code.as_str().ok_or_else(invalid)?)?;
    if code.is_empty() || code.len() > 65536 {
        return Err(invalid());
    }
    let decimals=rpc.call(Method::Call,json!([{"to":i.token_contract,"data":"0x313ce567","gas":"0xc350"},quantity(block_number)])).await?;
    let decimals = data_hex(decimals.as_str().ok_or_else(invalid)?)?;
    if decimals.len() != 32 || decimals[..31].iter().any(|b| *b != 0) || decimals[31] != 6 {
        return Err(Error::new(409, "topup_token_decimals_mismatch"));
    }
    let logs = receipt["logs"]
        .as_array()
        .filter(|l| l.len() <= 1024)
        .ok_or_else(invalid)?;
    let expected = super::quote(&i.package_id)?.payment_atomic;
    let topic = format!(
        "0x{}",
        crypto::hex(&sha3_digest(b"Transfer(address,address,uint256)"))
    );
    let mut payment = None;
    let mut seen = std::collections::BTreeSet::new();
    for log in logs {
        let address = log["address"]
            .as_str()
            .ok_or_else(invalid)?
            .to_ascii_lowercase();
        if !super::config::address(&address) {
            return Err(invalid());
        }
        if address != i.token_contract {
            continue;
        }
        let topics = log["topics"]
            .as_array()
            .filter(|t| t.len() <= 4)
            .ok_or_else(invalid)?;
        if topics.first().and_then(Value::as_str) != Some(topic.as_str()) {
            continue;
        }
        if topics.len() != 3 || log["removed"] != false {
            return Err(invalid());
        }
        let from = topic_address(&topics[1])?;
        let to = topic_address(&topics[2])?;
        if from != i.payer_address || to != i.recv_address {
            continue;
        }
        if hash(&log["transactionHash"])? != tx
            || hash(&log["blockHash"])? != block_hash
            || number(&log["blockNumber"])? != block_number
            || number(&log["transactionIndex"])? != index
        {
            return Err(invalid());
        }
        let li = u32::try_from(number(&log["logIndex"])?).map_err(|_| invalid())?;
        if !seen.insert(li) {
            return Err(invalid());
        }
        let data = data_hex(log["data"].as_str().ok_or_else(invalid)?)?;
        if data.len() != 32 {
            return Err(invalid());
        }
        let mut min = [0; 32];
        min[24..].copy_from_slice(&expected.to_be_bytes());
        if data.as_slice() < min.as_slice() {
            continue;
        }
        if payment.replace((li, decimal(&data))).is_some() {
            return Err(Error::new(409, "topup_ambiguous_payment"));
        }
    }
    let (log_index, actual_amount) = payment.ok_or(Error::new(409, "topup_payment_invalid"))?;
    let (contract, auth_hash) = if let Some((message, signature)) = authorization {
        let contract =
            wallet_authorization::verify(rpc, &i.payer_address, block_number, message, signature)
                .await?;
        (
            contract,
            wallet_authorization::signature_hash(signature, contract)?,
        )
    } else {
        (false, String::new())
    };
    let again = rpc
        .call(Method::Block, json!([quantity(block_number), false]))
        .await?;
    if hash(&again["hash"])? != block_hash || number(&again["number"])? != block_number {
        return Err(Error::new(409, "topup_payment_reorged"));
    }
    let p = Payment {
        tx_hash: tx.into(),
        block_hash,
        block_number,
        transaction_index: u32::try_from(index).map_err(|_| invalid())?,
        log_index,
        block_time_ms: time,
        actual_amount,
        wallet_is_contract: contract,
        payer_authorization_hash: auth_hash,
        checked_at: checked,
        verification_deadline: checked.checked_add(60000).ok_or_else(invalid)?,
    };
    p.require_fresh(clock.now())?;
    Ok(Outcome::Confirmed(p))
}
fn topic_address(v: &Value) -> Result<String> {
    let h = data_hex(v.as_str().ok_or_else(invalid)?)?;
    if h.len() != 32 || h[..12].iter().any(|b| *b != 0) {
        return Err(invalid());
    }
    Ok(format!("0x{}", crypto::hex(&h[12..])))
}
pub fn sha3_digest(bytes: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(bytes).into()
}
pub fn decimal(bytes: &[u8]) -> String {
    let mut digits = vec![0u16];
    for b in bytes {
        let mut carry = *b as u16;
        for d in &mut digits {
            let v = *d * 256 + carry;
            *d = v % 10;
            carry = v / 10
        }
        while carry > 0 {
            digits.push(carry % 10);
            carry /= 10
        }
    }
    digits
        .iter()
        .rev()
        .map(|d| char::from(b'0' + *d as u8))
        .collect()
}
