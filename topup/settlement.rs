use super::{
    config::Config,
    evm_verify::{self, Outcome},
    orders::Order,
    ports::{Clock, PaymentRpc, Repository},
    State,
};
use crate::{
    chain::ports::Rpc,
    shared::{crypto, Error, Result},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
pub fn authorize(expected: &[u8], authorization: Option<&str>) -> Result<()> {
    if expected.len() < 32 || expected.len() > 4096 {
        return Err(Error::new(503, "topup_settle_unconfigured"));
    }
    let supplied = authorization
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(Error::new(401, "topup_settle_unauthorized"))?;
    if !crypto::equal_secret(expected, supplied.as_bytes()) {
        return Err(Error::new(401, "topup_settle_unauthorized"));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub confirmed_at: u64,
    pub order_id: String,
}
impl Cursor {
    pub fn encode(&self) -> Result<String> {
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|_| super::routes::invalid())?))
    }
    pub fn decode(s: &str) -> Result<Self> {
        if s.len() > 512 {
            return Err(super::routes::invalid());
        }
        let b = super::intent::decode(s)?;
        let v: Self = serde_json::from_slice(&b).map_err(|_| super::routes::invalid())?;
        if v.confirmed_at == 0 || !super::routes::order_id(&v.order_id) || v.encode()? != s {
            return Err(super::routes::invalid());
        }
        Ok(v)
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub claim_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exception {
    pub claim_id: String,
    pub reason: String,
}
pub fn claim_id(s: &str) -> Result<()> {
    if s.strip_prefix("tpc_")
        .is_some_and(|s| crate::shared::ids::hex(s, 16, false))
    {
        Ok(())
    } else {
        Err(super::routes::invalid())
    }
}
pub async fn order<R: Repository>(repo: &R, id: &str) -> Result<Order> {
    if !super::routes::order_id(id) {
        return Err(super::routes::invalid());
    }
    repo.by_id(id)
        .await?
        .ok_or(Error::new(404, "topup_order_not_found"))
}
pub async fn settled<R: Repository, E: PaymentRpc, S: Rpc, C: Clock>(
    repo: &R,
    evm: &E,
    chain: &S,
    clock: &C,
    c: &Config,
    id: &str,
    r: crate::chain::settlement::Settled,
) -> Result<serde_json::Value> {
    claim_id(&r.claim_id)?;
    let o = order(repo, id).await?;
    if o.settlement_claim_id.as_deref() != Some(&r.claim_id) {
        return Err(Error::new(409, "topup_claim_mismatch"));
    }
    if o.status == State::Exception {
        return Err(Error::new(409, "topup_not_pending"));
    }
    let proof = crate::chain::settlement::verify(chain, c, &o, &r, clock.now()).await?;
    if o.status == State::Paid
        && (o.gmb_tx_hash.as_deref() != Some(&proof.tx_hash)
            || o.gmb_block_hash.as_deref() != Some(&proof.block_hash)
            || o.gmb_extrinsic_index != Some(proof.extrinsic_index)
            || o.gmb_evidence_hash.as_deref() != Some(&proof.evidence_hash))
    {
        return Err(Error::new(409, "topup_settlement_conflict"));
    }
    let payment = match evm_verify::verify(evm, clock, c, &o.intent(), &o.evm_tx_hash, None).await?
    {
        Outcome::Pending => return Err(Error::new(409, "topup_payment_not_final")),
        Outcome::Confirmed(p) => p,
    };
    o.matches_payment(&payment)?;
    payment.require_fresh(clock.now())?;
    let stored = repo.paid(&o, &proof, &payment, clock.now()).await?;
    Ok(stored.response(o.status == State::Paid))
}
