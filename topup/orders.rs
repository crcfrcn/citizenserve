//! 订单先于付款落盘；CAS冻结首个付款定位和唯一签名交易，重试不产生第二笔出款。
use super::{
    config::{Config, Network},
    intent::{self, Intent},
    ports::{Clock, PaymentRpc, Repository},
    State,
};
use crate::shared::{crypto, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub payment_intent: String,
    pub payment_txid: String,
    pub payer_signature: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub order_id: String,
    pub payment_intent: String,
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
            return Err(Error::new(503, "topup_payment_evidence_expired"));
        }
        Ok(())
    }
}
pub enum Outcome {
    Pending,
    Confirmed(Payment),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Awaiting,
    Verifying,
    Received,
    Signed,
    Broadcast,
    Paid,
    Exception,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    pub account_id: String,
    pub nonce: u64,
    pub extrinsic: String,
    pub tx_hash: String,
    pub born: u64,
    pub claim: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub order_id: String,
    pub intent: Intent,
    pub intent_hash: String,
    pub message: String,
    pub created_at: u64,
    pub revision: u64,
    pub phase: Phase,
    pub payment_txid: Option<String>,
    pub payer_signature: Option<String>,
    pub payment: Option<Payment>,
    pub signed: Option<Signed>,
    pub legacy: Option<serde_json::Value>,
    pub scan: u64,
    pub gmb: Option<crate::chain::settlement::Proof>,
    pub exception_reason: Option<String>,
}
impl Order {
    pub fn create(c: &Config, i: Intent, token: &str) -> Result<Self> {
        Ok(Self {
            message: intent::message(c, &i, token)?,
            order_id: format!("top_{}", &i.intent_id[4..]),
            created_at: i.issued_at,
            intent: i,
            intent_hash: crypto::sha256_hex(token.as_bytes()),
            revision: 0,
            phase: Phase::Awaiting,
            payment_txid: None,
            payer_signature: None,
            payment: None,
            signed: None,
            legacy: None,
            scan: 0,
            gmb: None,
            exception_reason: None,
        })
    }
    pub fn state(&self) -> State {
        match self.phase {
            Phase::Paid => State::Paid,
            Phase::Exception => State::Exception,
            _ => State::Pending,
        }
    }
    pub fn response(&self, deduplicated: bool) -> serde_json::Value {
        serde_json::json!({"ok":true,"status":self.state(),"phase":self.phase,"status_label":label(self.state()),"order_id":self.order_id,"payment_txid":self.payment_txid,"gmb_tx_hash":self.signed.as_ref().map(|s|&s.tx_hash),"coin_fen":self.intent.coin_fen,"reason":self.exception_reason,"deduplicated":deduplicated})
    }
    pub fn next(&self) -> Self {
        let mut n = self.clone();
        n.revision += 1;
        n
    }
}
pub fn label(s: State) -> &'static str {
    match s {
        State::Pending => "处理中",
        State::Paid => "已到账",
        State::Exception => "异常",
    }
}
pub async fn confirm<R: Repository, C: Clock>(
    repo: &R,
    clock: &C,
    c: &Config,
    key: &[u8],
    r: Confirm,
) -> Result<serde_json::Value> {
    let i = intent::verify(&r.payment_intent, key)?;
    i.validate(c)?;
    if !i.network.txid(&r.payment_txid) {
        return Err(super::routes::invalid());
    }
    // Solana钱包签名使用base58，EVM/Tron使用规范十六进制；真实授权在付款链最终块核对。
    signature(i.network, &r.payer_signature)?;
    let id = format!("top_{}", &i.intent_id[4..]);
    let o = repo
        .by_id(&id)
        .await?
        .ok_or(Error::new(404, "topup_order_not_found"))?;
    if o.intent != i || o.intent_hash != crypto::sha256_hex(r.payment_intent.as_bytes()) {
        return Err(Error::new(404, "topup_order_not_found"));
    }
    if let Some(tx) = &o.payment_txid {
        if tx != &r.payment_txid || o.payer_signature.as_deref() != Some(&r.payer_signature) {
            return Err(Error::new(409, "topup_payment_conflict"));
        }
        return Ok(o.response(true));
    }
    // 报价到期不阻止离线补交原交易；验款仍严格限制真实付款块在原十分钟报价内。
    if i.issued_at > clock.now() {
        return Err(Error::new(409, "topup_intent_expired"));
    }
    let mut n = o.next();
    n.payment_txid = Some(r.payment_txid);
    n.payer_signature = Some(r.payer_signature);
    n.phase = Phase::Verifying;
    Ok(repo.save(&o, &n).await?.response(false))
}
pub fn signature(n: Network, s: &str) -> Result<Vec<u8>> {
    if n == Network::Solana {
        use base58::FromBase58;
        let b = s
            .from_base58()
            .map_err(|_| super::wallet_authorization::bad())?;
        if b.len() != 64 {
            return Err(super::wallet_authorization::bad());
        }
        Ok(b)
    } else {
        super::wallet_authorization::canonical_signature(s)
    }
}
pub async fn verify<R: PaymentRpc, C: Clock>(
    rpc: &R,
    clock: &C,
    c: &Config,
    o: &Order,
) -> Result<Outcome> {
    let tx = o
        .payment_txid
        .as_deref()
        .ok_or_else(super::routes::invalid)?;
    let sig = signature(
        o.intent.network,
        o.payer_signature
            .as_deref()
            .ok_or_else(super::routes::invalid)?,
    )?;
    let msg = &o.message;
    match o.intent.network {
        Network::Tron => super::tron::verify(rpc, clock, c, &o.intent, tx, msg, &sig).await,
        Network::Solana => super::solana::verify(rpc, clock, c, &o.intent, tx, msg, &sig).await,
        _ => super::evm_verify::verify(rpc, clock, c, &o.intent, tx, Some((msg, &sig))).await,
    }
}
/// U链未finalized时只保留原单，不创建或预扣公民链RPC上下文。
pub async fn receive<R: Repository, E: PaymentRpc, C: Clock>(
    repo: &R,
    rpc: &E,
    clock: &C,
    c: &Config,
    id: &str,
) -> Result<Option<Order>> {
    let o = repo
        .by_id(id)
        .await?
        .ok_or(Error::new(404, "topup_order_not_found"))?;
    if o.signed.is_some() || matches!(o.phase, Phase::Paid | Phase::Exception) {
        return Ok(Some(o));
    }
    if o.phase == Phase::Received
        && o.payment
            .as_ref()
            .is_some_and(|p| p.require_fresh(clock.now()).is_ok())
    {
        return Ok(Some(o));
    }
    let proof = match verify(rpc, clock, c, &o).await {
        Ok(Outcome::Pending) => return Ok(None),
        Ok(Outcome::Confirmed(p)) => p,
        Err(e) if matches!(e.status, 400 | 403 | 409) => {
            let mut n = o.next();
            n.phase = Phase::Exception;
            n.exception_reason = Some(e.code.into());
            return Ok(Some(repo.save(&o, &n).await?));
        }
        Err(e) => return Err(e),
    };
    proof.require_fresh(clock.now())?;
    let mut n = o.next();
    n.phase = Phase::Received;
    n.payment = Some(proof);
    n.exception_reason = None;
    Ok(Some(repo.save(&o, &n).await?))
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
    if o.intent != i || o.intent_hash != crypto::sha256_hex(r.payment_intent.as_bytes()) {
        return Err(Error::new(404, "topup_order_not_found"));
    }
    Ok(o.response(false))
}
// 其他既有存储合同使用的严格布尔解码，不接受字符串或任意数字。
pub fn flag<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Bool(b) => Ok(b),
        serde_json::Value::Number(n) if n == 0.into() => Ok(false),
        serde_json::Value::Number(n) if n == 1.into() => Ok(true),
        _ => Err(serde::de::Error::custom("invalid boolean flag")),
    }
}
