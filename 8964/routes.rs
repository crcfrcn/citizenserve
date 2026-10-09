//! 广场路由与规范查询；查询用于业务解析，MLS证明仍签原始请求目标。
use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedKind {
    Recommended,
    Following,
    Campaign,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SquareRoute {
    Feed(FeedKind),
    Posts,
    Follows,
    Follow,
    Unfollow,
    Notify,
    PrepareUpload,
    Manifest,
    CompleteUpload,
    CancelUpload,
    ConfirmPost,
    SelfPosts,
    Post,
    DeletePost,
}
impl SquareRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        match (method, path) {
            ("POST", "/8964/uploads") => Some(Self::PrepareUpload),
            ("POST", "/8964/posts/confirm") => Some(Self::ConfirmPost),
            ("GET", "/8964/posts/self") => Some(Self::SelfPosts),
            ("PUT", p) if content_id(p, "/8964/uploads/", "/manifest") => Some(Self::Manifest),
            ("POST", p) if content_id(p, "/8964/uploads/", "/complete") => {
                Some(Self::CompleteUpload)
            }
            ("DELETE", p) if content_id(p, "/8964/uploads/", "") => Some(Self::CancelUpload),
            ("GET", p) if content_id(p, "/8964/posts/", "") => Some(Self::Post),
            ("DELETE", p) if content_id(p, "/8964/posts/", "") => Some(Self::DeletePost),
            ("GET", "/8964/feed/recommended") => Some(Self::Feed(FeedKind::Recommended)),
            ("GET", "/8964/feed/following") => Some(Self::Feed(FeedKind::Following)),
            ("GET", "/8964/feed/campaign") => Some(Self::Feed(FeedKind::Campaign)),
            ("GET", "/8964/posts") => Some(Self::Posts),
            ("GET", "/8964/follows") => Some(Self::Follows),
            ("POST", "/8964/follows") => Some(Self::Follow),
            ("DELETE", p)
                if p.strip_prefix("/8964/follows/")
                    .is_some_and(|cid| ids::cid(cid).is_ok()) =>
            {
                Some(Self::Unfollow)
            }
            ("PUT", p)
                if p.strip_prefix("/8964/follows/")
                    .and_then(|s| s.strip_suffix("/notifications"))
                    .is_some_and(|cid| ids::cid(cid).is_ok()) =>
            {
                Some(Self::Notify)
            }
            _ => None,
        }
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Feed(_) | Self::Posts | Self::Follows | Self::SelfPosts | Self::Post => "GET",
            Self::Follow | Self::PrepareUpload | Self::CompleteUpload | Self::ConfirmPost => "POST",
            Self::Unfollow | Self::CancelUpload | Self::DeletePost => "DELETE",
            Self::Notify | Self::Manifest => "PUT",
        }
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Follow | Self::Notify | Self::CompleteUpload | Self::ConfirmPost => 16384,
            Self::PrepareUpload => 131072,
            Self::Manifest => 262144,
            _ => 0,
        }
    }
    pub fn validate_query(self, q: &BTreeMap<String, String>) -> Result<()> {
        match self {
            Self::SelfPosts => {
                keys(q, &["limit", "cursor"])?;
                crate::square::local_copy::Query::read(q)?;
            }
            Self::Feed(_) => {
                keys(q, &["limit"])?;
                limit(q)?;
            }
            Self::Posts => {
                keys(
                    q,
                    &["cid_number", "category", "post_type", "limit", "cursor"],
                )?;
                crate::square::posts::Query::read(q)?;
            }
            Self::Follows => {
                keys(q, &["cid_number", "type", "limit", "cursor"])?;
                crate::square::follows::Query::read(q)?;
            }
            _ => keys(q, &[])?,
        }
        Ok(())
    }
}
pub fn invalid() -> Error {
    Error::new(400, "invalid_api_target")
}
pub fn keys(q: &BTreeMap<String, String>, allowed: &[&str]) -> Result<()> {
    if q.keys().any(|k| !allowed.contains(&k.as_str())) {
        Err(invalid())
    } else {
        Ok(())
    }
}
pub fn required<'a>(q: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str> {
    q.get(key).map(String::as_str).ok_or_else(invalid)
}
pub fn number(s: &str) -> Result<u64> {
    if s.is_empty() || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    s.parse::<u64>()
        .ok()
        .filter(|v| *v <= crate::shared::MAX_SAFE_INTEGER)
        .ok_or_else(invalid)
}
pub fn limit(q: &BTreeMap<String, String>) -> Result<u32> {
    let n = q.get("limit").map(|s| number(s)).transpose()?.unwrap_or(20);
    u32::try_from(n)
        .ok()
        .filter(|n| (1..=50).contains(n))
        .ok_or_else(invalid)
}
pub fn cursor(q: &BTreeMap<String, String>) -> Result<Option<u64>> {
    q.get("cursor").map(|s| number(s)).transpose()
}

pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !matches!(s, "self" | "confirm")
}
fn content_id(p: &str, prefix: &str, suffix: &str) -> bool {
    p.strip_prefix(prefix)
        .and_then(|s| s.strip_suffix(suffix))
        .is_some_and(identifier)
}
