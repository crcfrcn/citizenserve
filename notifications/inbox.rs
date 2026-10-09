use crate::{shared::Result, user::profile_service::Authorization};
use serde::{Deserialize, Serialize};
use std::future::Future;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Square,
    Following,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    pub scope: Scope,
}
#[derive(Deserialize, Serialize)]
pub struct Unread {
    pub square_unread: u64,
    pub following_unread: u64,
}
pub trait Repository {
    fn unread(&self, auth: &Authorization) -> impl Future<Output = Result<Unread>> + Send;
    fn mark(&self, auth: &Authorization, scope: Scope) -> impl Future<Output = Result<u64>> + Send;
}
pub async fn unread<R: Repository>(repo: &R, auth: &Authorization) -> Result<serde_json::Value> {
    let c = repo.unread(auth).await?;
    Ok(
        serde_json::json!({"ok":true,"square_unread":c.square_unread,"following_unread":c.following_unread}),
    )
}
pub async fn mark<R: Repository>(
    repo: &R,
    auth: &Authorization,
    scope: Scope,
) -> Result<serde_json::Value> {
    let now = repo.mark(auth, scope).await?;
    Ok(serde_json::json!({"ok":true,"scope":scope,"last_seen_at":now}))
}
