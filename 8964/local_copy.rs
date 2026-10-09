//! 同一时间戳按 post_id 排序；整页先校验所有原始字节，再交付一页。
use crate::shared::{crypto, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub created_at: u64,
    pub post_id: String,
}
impl Cursor {
    pub fn encode(&self) -> Result<String> {
        Ok(crypto::base64url(
            &serde_json::to_vec(self).map_err(|_| super::routes::invalid())?,
        ))
    }
    pub fn read(raw: &str) -> Result<Self> {
        let bytes = crypto::unbase64url(raw, 256)?;
        let c: Self = crate::server::routes::parse_json(&bytes, 256)?;
        if !super::routes::identifier(&c.post_id)
            || c.created_at > crate::shared::MAX_SAFE_INTEGER
            || c.encode()? != raw
        {
            return Err(super::routes::invalid());
        }
        Ok(c)
    }
}
#[derive(Clone, Debug)]
pub struct Query {
    pub limit: u32,
    pub cursor: Option<Cursor>,
}
impl Query {
    pub fn read(q: &BTreeMap<String, String>) -> Result<Self> {
        super::routes::keys(q, &["limit", "cursor"])?;
        let n = q
            .get("limit")
            .map(|s| super::routes::number(s))
            .transpose()?
            .unwrap_or(5);
        if !(1..=5).contains(&n) {
            return Err(super::routes::invalid());
        }
        Ok(Self {
            limit: n as u32,
            cursor: q.get("cursor").map(|s| Cursor::read(s)).transpose()?,
        })
    }
}
pub async fn page<R: super::post_service::Repository, S: super::storage::Storage>(
    repo: &R,
    storage: &S,
    auth: &crate::user::profile_service::Authorization,
    query: &Query,
) -> Result<serde_json::Value> {
    let rows = repo.self_posts(auth, query).await?;
    if rows.len() > query.limit as usize {
        return Err(Error::new(503, "post_page_invalid"));
    }
    let mut out = vec![];
    for (p, u) in &rows {
        super::post_service::anchors(p, u)?;
        if p.cid_number != auth.cid() {
            return Err(Error::new(403, "post_owner_mismatch"));
        }
        let (_, raw) = super::uploads::read_manifest(storage, u).await?;
        out.push(serde_json::json!({"post":p,"manifest_bytes_base64url":crypto::base64url(&raw),"content_hash":u.content_hash}));
    }
    let next = if rows.len() == query.limit as usize {
        rows.last()
            .map(|(p, _)| {
                Cursor {
                    created_at: p.created_at,
                    post_id: p.post_id.clone(),
                }
                .encode()
            })
            .transpose()?
    } else {
        None
    };
    Ok(serde_json::json!({"ok":true,"posts":out,"next_cursor":next}))
}
