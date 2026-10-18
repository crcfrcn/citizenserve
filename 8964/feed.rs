use crate::{
    membership::{gate::Permit,policy::Operation},
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
/// 单次分页安全边界与会员等级无关；未订阅者在统一会员门禁已被拒绝。
pub fn budget(requested:u32)->Result<u32> {
    crate::membership::usage::page_budget(requested,0,crate::membership::usage::Limit::Unlimited)
}
async fn finish<R: Repository>(
    repo: &R,
    auth: &Authorization,
    day: &str,
    posts: &[posts::Post],
    permit: &Permit,
) -> Result<Browse> {
    permit.require(auth,permit.operation(),auth.now())?;
    let count=repo.charge(auth,day,posts.len() as u32,permit).await?;
    Ok(Browse {browse_day:day.into(),browse_count:count,browse_limit:None,browse_left:None})
}
pub async fn feed<R: Repository>(
    repo: &R,
    auth: &Authorization,
    kind: FeedKind,
    requested: u32,
    permit: &Permit,
) -> Result<serde_json::Value> {
    let day = utc_day(auth.now());
    permit.require(auth,&Operation::Square(crate::square::routes::SquareRoute::Feed(kind)),auth.now())?;
    let limit=budget(requested)?;
    let posts = repo.feed(auth, kind, limit).await?;
    if posts.len() > limit as usize {
        return Err(Error::new(503, "feed_index_invalid"));
    }
    let b = finish(repo, auth, &day, &posts, permit).await?;
    Ok(
        serde_json::json!({"ok":true,"feed_kind":kind,"posts":posts,"browse_day":b.browse_day,"browse_count":b.browse_count,"browse_limit":b.browse_limit,"browse_left":b.browse_left}),
    )
}
pub async fn author<R: Repository>(
    repo: &R,
    auth: &Authorization,
    q: &posts::Query,
    permit: &Permit,
) -> Result<serde_json::Value> {
    let day = utc_day(auth.now());
    permit.require(auth,&Operation::Square(crate::square::routes::SquareRoute::Posts),auth.now())?;
    let limit=budget(q.limit)?;
    let posts = repo.posts(auth, q, limit).await?;
    if posts.len() > limit as usize {
        return Err(Error::new(503, "feed_index_invalid"));
    }
    let next = if posts.len() >= limit as usize {
        posts.last().map(|p| p.created_at)
    } else {
        None
    };
    let b = finish(repo, auth, &day, &posts, permit).await?;
    Ok(
        serde_json::json!({"ok":true,"cid_number":q.cid_number,"category":q.category,"post_type":q.post_type,"posts":posts,"next_cursor":next,"browse_day":b.browse_day,"browse_count":b.browse_count,"browse_limit":b.browse_limit,"browse_left":b.browse_left}),
    )
}
