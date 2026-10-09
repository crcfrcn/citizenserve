use crate::{
    chain::subscription::Entitlement,
    shared::{Error, Result},
    square::{ports::Repository, posts, routes::FeedKind},
    user::profile_service::Authorization,
};
use serde::Serialize;
#[derive(Debug, Serialize)]
pub struct Browse {
    pub browse_day: String,
    pub browse_count: u32,
    pub browse_limit: Option<u32>,
    pub browse_left: Option<u32>,
}
/// 只按UTC日计量，与主机时区、CID年份和链身份档位无关。
pub fn utc_day(now: u64) -> String {
    let z = (now / 86_400_000) as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    format!("{:04}-{:02}-{:02}", y + if m <= 2 { 1 } else { 0 }, m, d)
}
pub fn budget(requested: u32, used: u32, paid: bool) -> Result<u32> {
    if !(1..=50).contains(&requested) {
        return Err(super::routes::invalid());
    }
    let remaining = if paid {
        50
    } else {
        100u32.saturating_sub(used)
    };
    if remaining == 0 {
        return Err(Error::new(429, "browse_limit_reached"));
    }
    Ok(requested.min(50).min(remaining))
}
async fn finish<R: Repository>(
    repo: &R,
    auth: &Authorization,
    day: &str,
    posts: &[posts::Post],
    entitlement: &Entitlement,
) -> Result<Browse> {
    let paid_until = entitlement.paid_until(auth.now())?;
    let count = repo
        .charge(auth, day, posts.len() as u32, entitlement)
        .await?;
    Ok(Browse {
        browse_day: day.into(),
        browse_count: if paid_until.is_some() { 0 } else { count },
        browse_limit: if paid_until.is_some() {
            None
        } else {
            Some(100)
        },
        browse_left: if paid_until.is_some() {
            None
        } else {
            Some(100 - count)
        },
    })
}
pub async fn feed<R: Repository>(
    repo: &R,
    auth: &Authorization,
    kind: FeedKind,
    requested: u32,
    entitlement: &Entitlement,
) -> Result<serde_json::Value> {
    let day = utc_day(auth.now());
    let paid = entitlement.paid_until(auth.now())?.is_some();
    let used = if paid {
        0
    } else {
        repo.browse_count(auth.cid(), &day).await?
    };
    let limit = budget(requested, used, paid)?;
    let posts = repo.feed(auth, kind, limit).await?;
    if posts.len() > limit as usize {
        return Err(Error::new(503, "feed_index_invalid"));
    }
    let b = finish(repo, auth, &day, &posts, entitlement).await?;
    Ok(
        serde_json::json!({"ok":true,"feed_kind":kind,"posts":posts,"browse_day":b.browse_day,"browse_count":b.browse_count,"browse_limit":b.browse_limit,"browse_left":b.browse_left}),
    )
}
pub async fn author<R: Repository>(
    repo: &R,
    auth: &Authorization,
    q: &posts::Query,
    entitlement: &Entitlement,
) -> Result<serde_json::Value> {
    let day = utc_day(auth.now());
    let paid = entitlement.paid_until(auth.now())?.is_some();
    let used = if paid {
        0
    } else {
        repo.browse_count(auth.cid(), &day).await?
    };
    let limit = budget(q.limit, used, paid)?;
    let posts = repo.posts(auth, q, limit).await?;
    if posts.len() > limit as usize {
        return Err(Error::new(503, "feed_index_invalid"));
    }
    let next = if posts.len() >= limit as usize {
        posts.last().map(|p| p.created_at)
    } else {
        None
    };
    let b = finish(repo, auth, &day, &posts, entitlement).await?;
    Ok(
        serde_json::json!({"ok":true,"cid_number":q.cid_number,"category":q.category,"post_type":q.post_type,"posts":posts,"next_cursor":next,"browse_day":b.browse_day,"browse_count":b.browse_count,"browse_limit":b.browse_limit,"browse_left":b.browse_left}),
    )
}
