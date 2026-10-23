use super::{batch, fail, first, string};
use citizenserve::{
    notifications::inbox::{Repository, Scope, Unread},
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde_json::{json, Value};
use worker::{send::SendFuture, D1Database};
pub struct D1Notifications {
    pub db: D1Database,
}
const UNREAD: &str = r#"SELECT COALESCE(SUM(p.created_at>COALESCE(r.last_seen_square_at,0)),0) square_unread,COALESCE(SUM(p.created_at>COALESCE(r.last_seen_following_at,0)),0) following_unread
FROM square_posts p JOIN square_follows f ON f.followed_cid_number=p.cid_number AND f.follower_cid_number=?1 AND f.notify_enabled=1
LEFT JOIN square_notify_reads r ON r.cid_number=?1 WHERE p.post_state='published'"#;
impl Repository for D1Notifications {
    fn unread(
        &self,
        auth: &Authorization,
    ) -> impl std::future::Future<Output = Result<Unread>> + Send {
        SendFuture::new(async move {
            first(&self.db, UNREAD, &[string(auth.cid())])
                .await?
                .ok_or_else(fail)
        })
    }
    fn mark(
        &self,
        auth: &Authorization,
        scope: Scope,
    ) -> impl std::future::Future<Output = Result<u64>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"scope":scope}),
                include_str!("../sql/mark_notifications_read.sql"),
                Error::new(409, "notification_conflict"),
            )
            .await?;
            let col = match scope {
                Scope::Square => "last_seen_square_at",
                Scope::Following => "last_seen_following_at",
            };
            let r: Value = first(
                &self.db,
                &format!("SELECT {col} seen FROM square_notify_reads WHERE cid_number=?1"),
                &[string(auth.cid())],
            )
            .await?
            .ok_or_else(fail)?;
            r["seen"].as_u64().ok_or_else(fail)
        })
    }
}
