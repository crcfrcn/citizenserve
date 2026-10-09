use crate::{
    chain::ports::Rpc,
    shared::{ids, Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Anchor {
    pub number: u64,
    pub hash: String,
    pub parent_hash: String,
}
fn unavailable() -> Error {
    Error::new(503, "identity_projection_unavailable")
}
pub async fn header<R: Rpc>(rpc: &R, hash: &str) -> Result<Anchor> {
    if !ids::hex(hash, 32, true) {
        return Err(Error::new(400, "invalid_block_hash"));
    }
    let h = rpc.call("chain_getHeader", json!([hash])).await?;
    let number = h["number"]
        .as_str()
        .and_then(|n| n.strip_prefix("0x"))
        .and_then(|n| u64::from_str_radix(n, 16).ok())
        .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
        .ok_or_else(unavailable)?;
    let parent = h["parentHash"]
        .as_str()
        .filter(|h| ids::hex(h, 32, true))
        .ok_or_else(unavailable)?;
    Ok(Anchor {
        number,
        hash: hash.into(),
        parent_hash: parent.into(),
    })
}
pub async fn head<R: Rpc>(rpc: &R, genesis: &str) -> Result<Anchor> {
    if rpc.call("chain_getBlockHash", json!([0])).await?.as_str() != Some(genesis) {
        return Err(Error::new(503, "chain_genesis_mismatch"));
    }
    let value = rpc.call("chain_getFinalizedHead", json!([])).await?;
    let anchor = header(rpc, value.as_str().ok_or_else(unavailable)?).await?;
    if rpc
        .call("chain_getBlockHash", json!([anchor.number]))
        .await?
        .as_str()
        != Some(&anchor.hash)
    {
        return Err(unavailable());
    }
    Ok(anchor)
}
pub async fn canonical<R: Rpc>(rpc: &R, hash: &str, finalized: &Anchor) -> Result<Anchor> {
    let target = header(rpc, hash).await?;
    if target.number > finalized.number
        || rpc
            .call("chain_getBlockHash", json!([target.number]))
            .await?
            .as_str()
            != Some(hash)
    {
        return Err(Error::registration(
            409,
            "identity_finalization_pending",
            true,
            "resolve_identity",
        ));
    }
    Ok(target)
}
