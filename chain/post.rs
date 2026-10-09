//! 同一 finalized 块的调用、成功事件、存储和身份四方匹配，分类只读该块身份。
use super::{
    identity,
    ports::Rpc,
    scale::{self, Decoded},
    transaction::{self, Confirm, Evidence},
};
use crate::{
    shared::{crypto, Error, Result},
    square::uploads::Upload,
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fact {
    pub post_id: String,
    pub cid_number: String,
    pub account_id: String,
    pub post_type: String,
    pub post_category: String,
    pub content_hash: String,
    pub storage_receipt_id: String,
    pub storage_until: u64,
    pub created_block: u64,
    pub created_at: u64,
    pub evidence: Evidence,
}
fn text(v: &Decoded, f: &str, n: usize) -> Result<String> {
    scale::text(scale::field(v, f)?, n)
}
pub async fn verify<R: Rpc>(
    rpc: &R,
    genesis: &str,
    auth: &Authorization,
    u: &Upload,
    request: &Confirm,
) -> Result<Fact> {
    let v = transaction::verify(
        rpc,
        genesis,
        auth.cid(),
        auth.account(),
        request,
        auth.now(),
    )
    .await?;
    if scale::variant(&v.signed.call)? != "publish_post"
        || text(&v.signed.call, "post_id", 64)? != u.post_id
    {
        return Err(Error::new(409, "transaction_action_mismatch"));
    }
    let post = identity::storage(
        rpc,
        &v.metadata,
        &v.anchor,
        "SquarePost",
        "SquarePosts",
        Some(&crypto::scale_string(&u.post_id)?),
    )
    .await?
    .ok_or_else(scale::invalid)?;
    let event = v
        .events
        .iter()
        .find(|e| {
            scale::variant(e).ok() == Some("SquarePostPublished")
                && text(e, "post_id", 64).ok().as_deref() == Some(u.post_id.as_str())
        })
        .ok_or(Error::new(409, "transaction_event_mismatch"))?;
    let cid = scale::cid(scale::field(&post, "cid_number")?)?;
    let account = format!(
        "0x{}",
        crypto::hex(&scale::bytes(
            scale::field(&post, "signer_account_id")?,
            32
        )?)
    );
    let post_type = match scale::variant(scale::field(&post, "post_type")?)? {
        "Document" => "document",
        "Article" => "article",
        "Video" => "video",
        _ => return Err(scale::invalid()),
    }
    .to_owned();
    let post_category = match scale::variant(scale::field(&post, "post_category")?)? {
        "Normal" => "normal",
        "Campaign" => "campaign",
        _ => return Err(scale::invalid()),
    }
    .to_owned();
    let hash = crypto::hex(&scale::bytes(scale::field(&post, "content_hash")?, 32)?);
    let receipt = text(&post, "storage_receipt_id", 96)?;
    let block = scale::integer(scale::field(&post, "created_block")?)?;
    let until = scale::integer(scale::field(&post, "storage_until")?)?;
    fn same(left: &Decoded, right: &Decoded, name: &str) -> Result<bool> {
        let l = scale::field(left, name)?;
        let r = scale::field(right, name)?;
        Ok(match name {
            "post_id" | "cid_number" | "storage_receipt_id" => {
                scale::text(l, 96)? == scale::text(r, 96)?
            }
            "signer_account_id" | "content_hash" => scale::bytes(l, 32)? == scale::bytes(r, 32)?,
            "post_type" | "post_category" => scale::variant(l)? == scale::variant(r)?,
            "storage_until" | "created_block" => scale::integer(l)? == scale::integer(r)?,
            _ => return Err(scale::invalid()),
        })
    }
    for f in [
        "post_id",
        "cid_number",
        "signer_account_id",
        "post_type",
        "post_category",
        "content_hash",
        "storage_receipt_id",
        "storage_until",
        "created_block",
    ] {
        if !same(event, &post, f)? {
            return Err(scale::invalid());
        }
    }
    // Vec和BoundedVec可能在metadata中有不同包装，比较完整语义值而非TypeId/包装层。
    for f in ["post_id", "post_type", "content_hash", "storage_receipt_id"] {
        if !same(&v.signed.call, &post, f)? {
            return Err(scale::invalid());
        }
    }
    let owner = identity::by_cid(rpc, &v.metadata, &v.anchor, &cid, genesis, auth.now())
        .await?
        .ok_or_else(scale::invalid)?;
    let category = if owner.identity_level == crate::user::identity::IdentityLevel::Candidate {
        "campaign"
    } else {
        "normal"
    };
    if cid != auth.cid()
        || cid != u.cid_number
        || account != auth.account()
        || account != u.account_id
        || post_category != category
        || block != v.anchor.number
        || Some(hash.as_str()) != u.content_hash.as_deref()
        || receipt != u.storage_receipt_id
        || serde_json::to_value(u.post_type)
            .map_err(|_| scale::invalid())?
            .as_str()
            != Some(post_type.as_str())
        || until <= v.evidence.chain_timestamp
    {
        return Err(Error::new(409, "post_anchor_mismatch"));
    }
    let mut evidence = v.evidence;
    evidence.request_hash=crypto::sha256_hex(&serde_json::to_vec(&serde_json::json!({"post_id":u.post_id,"content_hash":hash,"storage_receipt_id":receipt,"post_type":post_type,"post_category":post_category})).map_err(|_|scale::invalid())?);
    Ok(Fact {
        post_id: u.post_id.clone(),
        cid_number: cid,
        account_id: account,
        post_type,
        post_category,
        content_hash: hash,
        storage_receipt_id: receipt,
        storage_until: until,
        created_block: block,
        created_at: evidence.chain_timestamp,
        evidence,
    })
}
