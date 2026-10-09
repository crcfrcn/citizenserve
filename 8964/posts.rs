//! 帖子索引与公开作者信号；本步不读取正文manifest或处理发布/删除。
use crate::{
    shared::{ids, Result},
    square::routes,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize)]
pub struct Query {
    pub cid_number: String,
    pub category: String,
    pub post_type: String,
    pub limit: u32,
    pub cursor: Option<u64>,
}
impl Query {
    pub fn read(q: &BTreeMap<String, String>) -> Result<Self> {
        let cid = routes::required(q, "cid_number")?;
        ids::cid(cid)?;
        let category = q.get("category").map(String::as_str).unwrap_or("all");
        let kind = q.get("post_type").map(String::as_str).unwrap_or("all");
        if !["all", "normal", "campaign"].contains(&category)
            || !["all", "document", "article", "video"].contains(&kind)
        {
            return Err(routes::invalid());
        }
        Ok(Self {
            cid_number: cid.into(),
            category: category.into(),
            post_type: kind.into(),
            limit: routes::limit(q)?,
            cursor: routes::cursor(q)?,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Media {
    pub media_kind: String,
    pub object_key: String,
    pub url: String,
    pub asset_state: String,
    pub derivative_kind: String,
    pub derivative_object_key: String,
    pub thumbnail_url: String,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Post {
    pub post_id: String,
    pub cid_number: String,
    pub account_id: String,
    pub post_category: String,
    pub post_type: String,
    pub title: Option<String>,
    pub excerpt: String,
    pub content_hash: String,
    pub storage_receipt_id: String,
    pub chain_block: u64,
    pub chain_block_hash: String,
    pub tx_hash: String,
    pub created_at: u64,
    pub post_state: String,
    pub identity_level: crate::user::identity::IdentityLevel,
    pub membership_level: Option<crate::membership::Level>,
    pub membership_active: bool,
    pub display_name: String,
    pub avatar_object_key: Option<String>,
    #[serde(default)]
    pub media_items: Vec<Media>,
}
