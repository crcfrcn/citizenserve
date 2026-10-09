use crate::{
    shared::{ids, Error, Result},
    square::{ports::Repository, routes},
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Following,
    Followers,
    MutualFollowing,
}
#[derive(Clone, Debug, Serialize)]
pub struct Query {
    pub cid_number: String,
    pub kind: Kind,
    pub limit: u32,
    pub cursor: Option<u64>,
}
impl Query {
    pub fn read(q: &BTreeMap<String, String>) -> Result<Self> {
        let cid = routes::required(q, "cid_number")?;
        ids::cid(cid)?;
        let kind = match routes::required(q, "type")? {
            "following" => Kind::Following,
            "followers" => Kind::Followers,
            "mutual_following" => Kind::MutualFollowing,
            _ => return Err(routes::invalid()),
        };
        Ok(Self {
            cid_number: cid.into(),
            kind,
            limit: routes::limit(q)?,
            cursor: routes::cursor(q)?,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub cid_number: String,
    pub created_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Follow {
    pub followed_cid_number: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notify {
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize)]
pub enum Change {
    Follow,
    Unfollow,
    Notify(bool),
}
pub async fn change<R: Repository>(
    repo: &R,
    auth: &Authorization,
    target: &str,
    change: Change,
) -> Result<serde_json::Value> {
    ids::cid(target).map_err(|_| Error::new(400, "invalid_followed_cid_number"))?;
    if matches!(change, Change::Follow) && auth.cid() == target {
        return Err(Error::new(400, "self_follow_forbidden"));
    }
    repo.change_follow(auth, target, &change).await?;
    Ok(match change {
        Change::Notify(enabled) => {
            serde_json::json!({"ok":true,"followed_cid_number":target,"notify_enabled":enabled})
        }
        _ => serde_json::json!({"ok":true,"followed_cid_number":target}),
    })
}
pub async fn list<R: Repository>(
    repo: &R,
    auth: &Authorization,
    q: &Query,
) -> Result<serde_json::Value> {
    let entries = repo.follows(auth, q).await?;
    let cursor = if entries.len() >= q.limit as usize {
        entries.last().map(|p| p.created_at)
    } else {
        None
    };
    Ok(serde_json::json!({"ok":true,"type":q.kind,"entries":entries,"next_cursor":cursor}))
}
