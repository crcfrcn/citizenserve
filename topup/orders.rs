use super::{
    config::Config,
    evm_verify::{self, Outcome, Payment},
    intent::{self, Intent},
    ports::{Clock, PaymentRpc, Repository},
    wallet_authorization as wallet, State,
};
use crate::shared::{crypto, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub payment_intent: String,
    pub evm_tx_hash: String,
    pub payer_signature: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub order_id: String,
    pub payment_intent: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub order_id: String,
    pub intent_id: String,
    pub chain_id: u64,
    pub token: super::Token,
    pub token_contract: String,
    pub evm_tx_hash: String,
    pub payer_address: String,
    pub recv_address: String,
    pub pay_amount: String,
    pub cid_number: Option<String>,
    pub account_id: String,
    pub coin_fen: String,
    pub package_id: String,
    pub status: State,
    pub settlement_claim_id: Option<String>,
    pub settlement_claimed_at: Option<u64>,
    pub gmb_tx_hash: Option<String>,
    pub gmb_block_hash: Option<String>,
    pub gmb_extrinsic_index: Option<u32>,
    pub exception_reason: Option<String>,
    pub confirmed_at: u64,
    pub settled_at: Option<u64>,
    pub intent_hash: String,
    pub intent_issued_at: u64,
    pub intent_expires_at: u64,
    pub payer_authorization_hash: String,
    #[serde(deserialize_with = "flag")]
    pub wallet_is_contract: bool,
    pub evm_block_hash: String,
    pub evm_block_number: u64,
    pub evm_transaction_index: u32,
    pub evm_log_index: u32,
    pub evm_block_time_ms: u64,
    pub evm_actual_amount: String,
    pub gmb_evidence_hash: Option<String>,
}
impl Order {
    pub fn intent(&self) -> Intent {
        Intent {
            intent_id: self.intent_id.clone(),
            cid_number: self.cid_number.clone(),
            account_id: self.account_id.clone(),
            payer_address: self.payer_address.clone(),
            token: self.token,
            package_id: self.package_id.clone(),
            chain_id: self.chain_id,
            token_contract: self.token_contract.clone(),
            recv_address: self.recv_address.clone(),
            pay_amount: self.pay_amount.clone(),
            coin_fen: self.coin_fen.clone(),
            issued_at: self.intent_issued_at,
            expires_at: self.intent_expires_at,
        }
    }
    pub fn response(&self, deduplicated: bool) -> serde_json::Value {
        serde_json::json!({"ok":true,"status":self.status,"status_label":label(self.status),"order_id":self.order_id,"gmb_tx_hash":self.gmb_tx_hash,"coin_fen":self.coin_fen,"deduplicated":deduplicated})
    }
    pub fn matches_payment(&self, p: &Payment) -> Result<()> {
        if self.evm_tx_hash != p.tx_hash
            || self.evm_block_hash != p.block_hash
            || self.evm_block_number != p.block_number
            || self.evm_transaction_index != p.transaction_index
            || self.evm_log_index != p.log_index
            || self.evm_block_time_ms != p.block_time_ms
            || self.evm_actual_amount != p.actual_amount
        {
            return Err(Error::new(409, "topup_payment_evidence_conflict"));
        }
        Ok(())
    }
}
pub fn label(s: State) -> &'static str {
    match s {
        State::Pending => "待支付",
        State::Paid => "已支付",
        State::Exception => "异常",
    }
}
pub async fn confirm<R: Repository, E: PaymentRpc, C: Clock>(
    repo: &R,
    rpc: &E,
    clock: &C,
    c: &Config,
    key: &[u8],
    request: Confirm,
    random: &str,
) -> Result<serde_json::Value> {
    if !crate::shared::ids::hex(&request.evm_tx_hash, 32, true) {
        return Err(super::routes::invalid());
    }
    let i = intent::verify(&request.payment_intent, key)?;
    i.validate(c)?;
    i.require_live(clock.now())?;
    let sig = wallet::canonical_signature(&request.payer_signature)?;
    let msg = intent::message(c, &i, &request.payment_intent)?;
    let ih = crypto::sha256_hex(request.payment_intent.as_bytes());
    if let Some(old) = repo.by_tx(i.chain_id, &request.evm_tx_hash).await? {
        if old.intent() != i
            || old.intent_hash != ih
            || old.payer_authorization_hash != wallet::signature_hash(&sig, old.wallet_is_contract)?
        {
            return Err(Error::new(409, "topup_txhash_claimed"));
        }
        if !old.wallet_is_contract
            && wallet::recover(&wallet::digest(&msg), &sig)? != i.payer_address
        {
            return Err(wallet::bad());
        }
        return Ok(old.response(true));
    }
    let p = match evm_verify::verify(rpc, clock, c, &i, &request.evm_tx_hash, Some((&msg, &sig)))
        .await?
    {
        Outcome::Pending => return Ok(serde_json::json!({"ok":true,"status":"confirming"})),
        Outcome::Confirmed(p) => p,
    };
    i.require_live(clock.now())?;
    if !crate::shared::ids::hex(random, 16, false) {
        return Err(evm_verify::invalid());
    }
    let o = Order {
        order_id: format!("top_{random}"),
        intent_id: i.intent_id,
        chain_id: i.chain_id,
        token: i.token,
        token_contract: i.token_contract,
        evm_tx_hash: p.tx_hash.clone(),
        payer_address: i.payer_address,
        recv_address: i.recv_address,
        pay_amount: i.pay_amount,
        cid_number: i.cid_number,
        account_id: i.account_id,
        coin_fen: i.coin_fen,
        package_id: i.package_id,
        status: State::Pending,
        settlement_claim_id: None,
        settlement_claimed_at: None,
        gmb_tx_hash: None,
        gmb_block_hash: None,
        gmb_extrinsic_index: None,
        exception_reason: None,
        confirmed_at: clock.now(),
        settled_at: None,
        intent_hash: ih,
        intent_issued_at: i.issued_at,
        intent_expires_at: i.expires_at,
        payer_authorization_hash: p.payer_authorization_hash.clone(),
        wallet_is_contract: p.wallet_is_contract,
        evm_block_hash: p.block_hash.clone(),
        evm_block_number: p.block_number,
        evm_transaction_index: p.transaction_index,
        evm_log_index: p.log_index,
        evm_block_time_ms: p.block_time_ms,
        evm_actual_amount: p.actual_amount.clone(),
        gmb_evidence_hash: None,
    };
    let stored = repo.insert(&o, &p).await?;
    Ok(stored.response(stored.order_id != o.order_id))
}
pub fn flag<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Bool(b) => Ok(b),
        serde_json::Value::Number(n) if n == 0.into() => Ok(false),
        serde_json::Value::Number(n) if n == 1.into() => Ok(true),
        _ => Err(serde::de::Error::custom("invalid boolean flag")),
    }
}
pub async fn status<R: Repository>(repo: &R, key: &[u8], r: Status) -> Result<serde_json::Value> {
    if !super::routes::order_id(&r.order_id) {
        return Err(super::routes::invalid());
    }
    let i = intent::verify(&r.payment_intent, key)?;
    let o = repo
        .by_id(&r.order_id)
        .await?
        .ok_or(Error::new(404, "topup_order_not_found"))?;
    if o.intent() != i || o.intent_hash != crypto::sha256_hex(r.payment_intent.as_bytes()) {
        return Err(Error::new(404, "topup_order_not_found"));
    }
    Ok(o.response(false))
}
