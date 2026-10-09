use super::{
    local_copy::Query,
    posts::Post,
    storage::Storage,
    uploads::{self, Upload},
};
use crate::{
    chain::{ports::Rpc, subscription::Current, transaction::Confirm},
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmPost {
    pub post_id: String,
    pub tx_hash: String,
    pub block_hash: String,
}
pub trait Repository {
    fn upload_by_post(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl Future<Output = Result<Option<Upload>>> + Send;
    fn get(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl Future<Output = Result<Option<(Post, Upload)>>> + Send;
    fn self_posts(
        &self,
        auth: &Authorization,
        q: &Query,
    ) -> impl Future<Output = Result<Vec<(Post, Upload)>>> + Send;
    fn confirm(
        &self,
        auth: &Authorization,
        u: &Upload,
        fact: &crate::chain::post::Fact,
        m: &super::manifest::Manifest,
        current: &Current,
    ) -> impl Future<Output = Result<()>> + Send;
}
pub fn anchors(p: &Post, u: &Upload) -> Result<()> {
    if p.post_state != "published"
        || u.status != "published"
        || p.cid_number != u.cid_number
        || p.post_id != u.post_id
        || u.content_hash.as_deref() != Some(p.content_hash.as_str())
        || p.storage_receipt_id != u.storage_receipt_id
        || serde_json::to_value(u.post_type)
            .map_err(|_| Error::new(503, "post_invalid"))?
            .as_str()
            != Some(p.post_type.as_str())
    {
        Err(Error::new(409, "post_anchor_mismatch"))
    } else {
        Ok(())
    }
}
pub async fn detail<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    id: &str,
) -> Result<Value> {
    let (p, u) = repo
        .get(auth, id)
        .await?
        .ok_or(Error::new(404, "post_not_found"))?;
    anchors(&p, &u)?;
    let (m, _) = uploads::read_manifest(storage, &u).await?;
    Ok(json!({"ok":true,"post":p,"manifest":m}))
}
pub async fn confirm<R: Repository, S: Storage, C: Rpc>(
    repo: &R,
    storage: &S,
    rpc: &C,
    genesis: &str,
    auth: &Authorization,
    input: ConfirmPost,
    current: &Current,
) -> Result<Value> {
    if !super::routes::identifier(&input.post_id) {
        return Err(Error::new(400, "invalid_post_id"));
    }
    let u = repo
        .upload_by_post(auth, &input.post_id)
        .await?
        .ok_or(Error::new(404, "upload_not_found"))?;
    u.owner(auth)?;
    if !matches!(u.status.as_str(), "completed" | "published") {
        return Err(Error::new(409, "upload_not_completed"));
    }
    let level = current.level(auth.now())?;
    let (m, _) = uploads::read_manifest(storage, &u).await?;
    super::manifest::validate(&m, &u.media_items, level)?;
    let fact = crate::chain::post::verify(
        rpc,
        genesis,
        auth,
        &u,
        &Confirm {
            tx_hash: input.tx_hash,
            block_hash: input.block_hash,
        },
    )
    .await?;
    repo.confirm(auth, &u, &fact, &m, current).await?;
    Ok(
        json!({"ok":true,"post_id":u.post_id,"content_hash":fact.content_hash,"post_category":fact.post_category}),
    )
}
