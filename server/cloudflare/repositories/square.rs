//! 信息流先有界查询索引，再用一次媒体批量查询组装；授权计费成功后才返回结果。
use super::{all, batch, fail, first, string};
use citizenserve::{
    shared::{ids, Error, Result},
    square::{
        follows::{Change, Entry, Kind, Query},
        objects,
        ports::Repository,
        posts::{self, Media, Post},
        routes::FeedKind,
    },
    user::profile_service::Authorization,
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Square {
    pub db: D1Database,
    pub media_origin: Option<String>,
}
pub(crate) const POST_SELECT: &str = r#"SELECT p.*,COALESCE(u.identity_level,'visitor') identity_level,
 m.membership_level,CASE WHEN m.subscription_status IN ('active','cancelled') AND m.paid_until>?1 THEN 1 ELSE 0 END membership_active,
 COALESCE(a.display_name,'') display_name,a.avatar_object_key FROM square_posts p LEFT JOIN users u ON u.cid_number=p.cid_number
 LEFT JOIN square_memberships m ON m.cid_number=p.cid_number LEFT JOIN user_profiles a ON a.cid_number=p.cid_number WHERE p.post_state='published'"#;
const FOLLOW: &str = r#"
-- statement
INSERT INTO square_follows(follower_cid_number,followed_cid_number,created_at,notify_enabled)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.target'),json_extract(?1,'$.auth.now'),1 WHERE json_extract(?1,'$.auth.cid_number')<>json_extract(?1,'$.target')
ON CONFLICT(follower_cid_number,followed_cid_number) DO NOTHING;
"#;
const UNFOLLOW: &str = r#"
-- statement
DELETE FROM square_follows WHERE follower_cid_number=json_extract(?1,'$.auth.cid_number') AND followed_cid_number=json_extract(?1,'$.target');
"#;
const NOTIFY: &str = r#"
-- statement
UPDATE square_follows SET notify_enabled=json_extract(?1,'$.enabled') WHERE follower_cid_number=json_extract(?1,'$.auth.cid_number') AND followed_cid_number=json_extract(?1,'$.target');
"#;
impl D1Square {
    pub(crate) async fn indexed(&self, sql: &str, args: &[JsValue]) -> Result<Vec<Post>> {
        let rows: Vec<Value> = all(&self.db, sql, args).await?;
        let mut posts = rows
            .into_iter()
            .map(|mut r| {
                r["membership_active"] = json!(r["membership_active"].as_u64() == Some(1));
                serde_json::from_value::<Post>(r).map_err(|_| fail())
            })
            .collect::<Result<Vec<_>>>()?;
        if posts.is_empty() {
            return Ok(posts);
        }
        let placeholders = (1..=posts.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let args: Vec<_> = posts.iter().map(|p| string(&p.post_id)).collect();
        let media:Vec<Value>=all(&self.db,&format!("SELECT * FROM square_media_assets WHERE post_id IN ({placeholders}) ORDER BY post_id,media_index"),&args).await?;
        for row in media {
            if row["asset_state"].as_str() != Some("ready") {
                return Err(Error::new(409, "media_asset_not_ready"));
            }
            let p = posts
                .iter_mut()
                .find(|p| row["post_id"].as_str() == Some(&p.post_id))
                .ok_or_else(fail)?;
            let index = row["media_index"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(fail)?;
            if p.post_type == "article" && index != 0 {
                continue;
            }
            let video = match row["media_kind"].as_str() {
                Some("image") => false,
                Some("video") => true,
                _ => return Err(fail()),
            };
            let (source, derivative) =
                objects::media_keys(&p.cid_number, &p.post_id, index, video).map_err(|_| fail())?;
            if row["cid_number"].as_str() != Some(&p.cid_number)
                || row["object_key"].as_str() != Some(&source)
                || row["derivative_object_key"].as_str() != Some(&derivative)
                || row["content_type"].as_str()
                    != Some(if video { "video/mp4" } else { "image/webp" })
                || row["derivative_kind"].as_str()
                    != Some(if video { "cover" } else { "thumbnail" })
            {
                return Err(fail());
            }
            if !ids::hex(row["sha256"].as_str().ok_or_else(fail)?, 32, false) {
                return Err(fail());
            }
            let origin = self
                .media_origin
                .as_deref()
                .ok_or(Error::new(503, "public_media_domain_not_configured"))?;
            let url = url::Url::parse(origin).map_err(|_| fail())?;
            if url.scheme() != "https" || url.origin().ascii_serialization() != origin {
                return Err(fail());
            }
            let mut value = row;
            value["url"] = json!(format!("{origin}/{source}"));
            value["thumbnail_url"] = json!(format!("{origin}/{derivative}"));
            p.media_items
                .push(serde_json::from_value::<Media>(value).map_err(|_| fail())?);
        }
        Ok(posts)
    }
}
impl Repository for D1Square {
    fn browse_count(
        &self,
        cid: &str,
        day: &str,
    ) -> impl std::future::Future<Output = Result<u32>> + Send {
        SendFuture::new(async move {
            let r: Option<Value> = first(
                &self.db,
                "SELECT browse_count FROM square_browse_days WHERE cid_number=?1 AND browse_day=?2",
                &[string(cid), string(day)],
            )
            .await?;
            match r {
                None => Ok(0),
                Some(r) => r["browse_count"]
                    .as_u64()
                    .filter(|n| *n <= 100)
                    .map(|n| n as u32)
                    .ok_or_else(fail),
            }
        })
    }
    fn feed(
        &self,
        auth: &Authorization,
        kind: FeedKind,
        limit: u32,
    ) -> impl std::future::Future<Output = Result<Vec<Post>>> + Send {
        SendFuture::new(async move {
            let filter=match kind{FeedKind::Recommended=>" AND p.post_category='normal'",FeedKind::Campaign=>" AND p.post_category='campaign'",FeedKind::Following=>" AND EXISTS(SELECT 1 FROM square_follows f WHERE f.follower_cid_number=?2 AND f.followed_cid_number=p.cid_number)"};
            self.indexed(
                &format!(
                    "{POST_SELECT}{filter} ORDER BY p.created_at DESC,p.post_id DESC LIMIT ?3"
                ),
                &[
                    JsValue::from_f64(auth.now() as f64),
                    string(auth.cid()),
                    JsValue::from_f64(limit as f64),
                ],
            )
            .await
        })
    }
    fn posts(
        &self,
        auth: &Authorization,
        q: &posts::Query,
        limit: u32,
    ) -> impl std::future::Future<Output = Result<Vec<Post>>> + Send {
        SendFuture::new(async move {
            self.indexed(&format!("{POST_SELECT} AND p.cid_number=?2 AND (?3='all' OR p.post_category=?3) AND (?4='all' OR p.post_type=?4) AND (?5 IS NULL OR p.created_at<?5) ORDER BY p.created_at DESC,p.post_id DESC LIMIT ?6"),&[JsValue::from_f64(auth.now() as f64),string(&q.cid_number),string(&q.category),string(&q.post_type),q.cursor.map(|n|JsValue::from_f64(n as f64)).unwrap_or(JsValue::NULL),JsValue::from_f64(limit as f64)]).await
        })
    }
    fn charge(
        &self,
        auth: &Authorization,
        day: &str,
        count: u32,
        entitlement: &citizenserve::chain::subscription::Entitlement,
    ) -> impl std::future::Future<Output = Result<u32>> + Send {
        SendFuture::new(async move {
            if count > 50 {
                return Err(fail());
            }
            let paid_until = entitlement.paid_until(auth.now())?;
            batch(
                &self.db,
                json!({"auth":auth,"day":day,"count":count,"paid_until":paid_until,"membership_checked":entitlement.checked_at(),"membership_deadline":entitlement.verification_deadline()}),
                include_str!("../sql/charge_browse.sql"),
                if paid_until.is_some() {
                    Error::new(503, "membership_verification_expired")
                } else {
                    Error::new(429, "browse_limit_reached")
                },
            )
            .await?;
            if paid_until.is_some() {
                Ok(0)
            } else {
                self.browse_count(auth.cid(), day).await
            }
        })
    }
    fn follows(
        &self,
        _auth: &Authorization,
        q: &Query,
    ) -> impl std::future::Future<Output = Result<Vec<Entry>>> + Send {
        SendFuture::new(async move {
            let sql = match q.kind {
                Kind::Following => FOLLOWING,
                Kind::Followers => FOLLOWERS,
                Kind::MutualFollowing => MUTUAL,
            };
            all(
                &self.db,
                sql,
                &[
                    string(&q.cid_number),
                    q.cursor
                        .map(|n| JsValue::from_f64(n as f64))
                        .unwrap_or(JsValue::NULL),
                    JsValue::from_f64(q.limit as f64),
                ],
            )
            .await
        })
    }
    fn change_follow(
        &self,
        auth: &Authorization,
        target: &str,
        change: &Change,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let sql = match change {
                Change::Follow => FOLLOW,
                Change::Unfollow => UNFOLLOW,
                Change::Notify(_) => NOTIFY,
            };
            let r=batch(&self.db,json!({"auth":auth,"target":target,"enabled":match change {Change::Notify(b)=>*b,_=>true}}),sql,Error::new(409,"follow_conflict")).await?;
            if matches!(change, Change::Notify(_))
                && r.last()
                    .ok_or_else(fail)?
                    .meta()
                    .map_err(|_| fail())?
                    .and_then(|m| m.changes)
                    != Some(1)
            {
                return Err(Error::new(404, "follow_not_found"));
            }
            Ok(())
        })
    }
}

const FOLLOWING: &str = r#"SELECT followed_cid_number cid_number,created_at FROM square_follows WHERE follower_cid_number=?1 AND (?2 IS NULL OR created_at<?2) ORDER BY created_at DESC,followed_cid_number ASC LIMIT ?3"#;
const FOLLOWERS: &str = r#"SELECT follower_cid_number cid_number,created_at FROM square_follows WHERE followed_cid_number=?1 AND (?2 IS NULL OR created_at<?2) ORDER BY created_at DESC,follower_cid_number ASC LIMIT ?3"#;
// 互关时间为两条关系中较晚的一条，沿用客户端时间戳游标合同。
const MUTUAL: &str = r#"SELECT f.followed_cid_number cid_number,MAX(f.created_at,b.created_at) created_at FROM square_follows f JOIN square_follows b ON b.follower_cid_number=f.followed_cid_number AND b.followed_cid_number=f.follower_cid_number WHERE f.follower_cid_number=?1 AND (?2 IS NULL OR MAX(f.created_at,b.created_at)<?2) ORDER BY created_at DESC,cid_number ASC LIMIT ?3"#;
