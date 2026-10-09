//! 同一finalized交易的调用、实际转账事件、唯一成功phase及完整字节共同证明发币。
use super::{
    ports::Rpc,
    scale::{self, Decoded},
    transaction::{self, Confirm},
};
use crate::{
    shared::{crypto, Error, Result},
    topup::{config::Config, orders::Order},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settled {
    pub claim_id: String,
    pub gmb_tx_hash: String,
    pub gmb_block_hash: String,
    pub gmb_extrinsic_index: u32,
    pub signed_extrinsic_hex: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Proof {
    pub tx_hash: String,
    pub block_hash: String,
    pub block_number: u64,
    pub extrinsic_index: u32,
    pub signer_account_id: String,
    pub beneficiary_account_id: String,
    pub amount: String,
    pub remark: String,
    pub evidence_hash: String,
    pub checked_at: u64,
    pub verification_deadline: u64,
}
fn account(v: &Decoded) -> Result<String> {
    Ok(format!("0x{}", crypto::hex(&scale::bytes(v, 32)?)))
}
pub async fn verify<R: Rpc>(
    rpc: &R,
    c: &Config,
    o: &Order,
    r: &Settled,
    now: u64,
) -> Result<Proof> {
    let bytes = crate::chain::Relay {
        signed_extrinsic_hex: r.signed_extrinsic_hex.clone(),
    }
    .bytes()?;
    if transaction::hash(&bytes) != r.gmb_tx_hash {
        return Err(Error::new(409, "topup_gmb_tx_hash_mismatch"));
    }
    let v = transaction::verify_for(
        rpc,
        &c.chain_genesis_hash,
        None,
        &c.disburse_account,
        &Confirm {
            tx_hash: r.gmb_tx_hash.clone(),
            block_hash: r.gmb_block_hash.clone(),
        },
        now,
        "OnchainTransaction",
    )
    .await?;
    if v.raw != bytes
        || v.evidence.extrinsic_index != r.gmb_extrinsic_index
        || scale::variant(&v.signed.call)? != "transfer_with_remark"
    {
        return Err(Error::new(409, "topup_gmb_call_mismatch"));
    }
    let dest = account(scale::field(&v.signed.call, "beneficiary_account_id")?)?;
    let amount = scale::u128_value(scale::field(&v.signed.call, "amount")?)?.to_string();
    let remark = scale::text(scale::field(&v.signed.call, "remark")?, 128)?;
    if dest != o.account_id || amount != o.coin_fen || remark != format!("topup:{}", o.order_id) {
        return Err(Error::new(409, "topup_gmb_call_mismatch"));
    }
    let events = v
        .events
        .iter()
        .filter(|e| scale::variant(e).ok() == Some("TransferWithRemark"))
        .collect::<Vec<_>>();
    if events.len() != 1 {
        return Err(Error::new(409, "topup_gmb_event_mismatch"));
    }
    let e = events[0];
    if account(scale::field(e, "from_account_id")?)? != c.disburse_account
        || account(scale::field(e, "beneficiary_account_id")?)? != dest
        || scale::u128_value(scale::field(e, "amount")?)?.to_string() != amount
        || scale::text(scale::field(e, "remark")?, 128)? != remark
    {
        return Err(Error::new(409, "topup_gmb_event_mismatch"));
    }
    let raw = serde_json::to_vec(&(
        r.gmb_tx_hash.clone(),
        r.gmb_block_hash.clone(),
        v.anchor.number,
        r.gmb_extrinsic_index,
        c.disburse_account.clone(),
        dest.clone(),
        amount.clone(),
        remark.clone(),
        crypto::sha256_hex(&bytes),
    ))
    .map_err(|_| scale::invalid())?;
    Ok(Proof {
        tx_hash: r.gmb_tx_hash.clone(),
        block_hash: r.gmb_block_hash.clone(),
        block_number: v.anchor.number,
        extrinsic_index: r.gmb_extrinsic_index,
        signer_account_id: c.disburse_account.clone(),
        beneficiary_account_id: dest,
        amount,
        remark,
        evidence_hash: crypto::sha256_hex(&raw),
        checked_at: now,
        verification_deadline: now.checked_add(60000).ok_or_else(scale::invalid)?,
    })
}
