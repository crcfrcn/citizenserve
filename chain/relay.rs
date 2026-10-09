use super::{
    finalized, identity,
    network_ports::{BroadcastOutcome, Broadcaster},
    ports::Rpc,
    transaction, Relay,
};
use crate::shared::{crypto, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attempt {
    pub relay_id: String,
    pub extrinsic_sha256: String,
    pub tx_hash: String,
    pub request_ip_hash: String,
    pub byte_size: usize,
    pub relay_status: String,
    pub error_code: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(deserialize_with = "crate::topup::orders::flag")]
    pub active_claim: bool,
}
pub trait Repository {
    fn reserve(
        &self,
        attempt: &Attempt,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Attempt>> + Send;
    fn finish(
        &self,
        attempt: &Attempt,
        status: &str,
        error: Option<&str>,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Attempt>> + Send;
}
#[allow(clippy::too_many_arguments)] // 将独立可信端口与准确请求字段显式传入，不能隐藏授权来源。
pub async fn submit<R: Repository, B: Broadcaster, P: Rpc>(
    repo: &R,
    broadcast: &B,
    rpc: &P,
    genesis: &str,
    input: Relay,
    ip: &str,
    random: &str,
    now: u64,
) -> Result<(u16, serde_json::Value)> {
    let bytes = input.bytes()?;
    if !crate::shared::ids::hex(ip, 32, false) || !crate::shared::ids::hex(random, 16, false) {
        return Err(Error::new(503, "chain_relay_unavailable"));
    }
    let head = finalized::head(rpc, genesis).await?;
    let m = identity::metadata(rpc, &head).await?;
    transaction::decode_signed(&m, &bytes)?;
    let proposed = Attempt {
        relay_id: format!("cer_{random}"),
        extrinsic_sha256: crypto::sha256_hex(&bytes),
        tx_hash: transaction::hash(&bytes),
        request_ip_hash: ip.into(),
        byte_size: bytes.len(),
        relay_status: "submitting".into(),
        error_code: None,
        created_at: now,
        updated_at: now,
        active_claim: true,
    };
    let a = repo.reserve(&proposed, now).await?;
    let dedup = a.relay_id != proposed.relay_id;
    if dedup {
        return Ok(response(&a, true));
    }
    let (status, error) = match broadcast.broadcast(&input.signed_extrinsic_hex).await {
        Ok(BroadcastOutcome::Accepted(hash)) if hash == a.tx_hash => ("broadcast", None),
        Ok(BroadcastOutcome::Rejected(_)) => ("failed", Some("chain_broadcast_rejected")),
        _ => ("unknown", Some("chain_broadcast_outcome_unknown")),
    };
    let result = repo.finish(&a, status, error, now).await?;
    Ok(response(&result, false))
}
fn response(a: &Attempt, deduplicated: bool) -> (u16, serde_json::Value) {
    let status = if a.relay_status == "submitting" {
        "unknown"
    } else {
        a.relay_status.as_str()
    };
    (
        if status == "failed" { 409 } else { 202 },
        serde_json::json!({"ok":status=="broadcast","schema":"citizenapp.chain.extrinsic_relay","relay_id":a.relay_id,"relay_status":status,"deduplicated":deduplicated,"tx_hash":a.tx_hash,"accepted_at":a.created_at,"chain_success_source":"finalized_runtime_storage_or_events"}),
    )
}
