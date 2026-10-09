use citizenserve::{
    shared::{Error, Result},
    user::profile_service::{Authorization, Doc, Profile, Repository},
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Profiles {
    pub db: D1Database,
}
use super::{batch, fail, first, string};
// 成员徽标仅为显示信号，付费授权另从当前链状态取得。
const PROFILE: &str = r#"SELECT u.account_id,u.cid_number,u.identity_level,
 CASE WHEN u.identity_level IN ('voting','candidate') THEN 1 ELSE 0 END AS is_certified,
 COALESCE(p.display_name,'') display_name,COALESCE(p.bio,'') bio,p.avatar_object_key,p.banner_object_key,COALESCE(p.updated_at,0) updated_at,
 m.membership_level,CASE WHEN m.subscription_status IN ('active','cancelled') AND m.paid_until>?3 THEN 1 ELSE 0 END AS membership_active,
 EXISTS(SELECT 1 FROM square_follows f WHERE f.follower_cid_number=?2 AND f.followed_cid_number=u.cid_number) is_following,
 EXISTS(SELECT 1 FROM square_follows f WHERE f.followed_cid_number=?2 AND f.follower_cid_number=u.cid_number) is_followed_by,
 EXISTS(SELECT 1 FROM square_follows f WHERE f.follower_cid_number=?2 AND f.followed_cid_number=u.cid_number AND f.notify_enabled=1) is_notifying,
 json_object('following',(SELECT COUNT(*) FROM square_follows WHERE follower_cid_number=u.cid_number),
 'followers',(SELECT COUNT(*) FROM square_follows WHERE followed_cid_number=u.cid_number),
 'mutual_following',(SELECT COUNT(*) FROM square_follows f JOIN square_follows b ON b.follower_cid_number=f.followed_cid_number AND b.followed_cid_number=f.follower_cid_number WHERE f.follower_cid_number=u.cid_number),
 'posts',(SELECT COUNT(*) FROM square_posts WHERE cid_number=u.cid_number AND post_state='published' AND post_category='normal' AND post_type='document'),
 'campaigns',(SELECT COUNT(*) FROM square_posts WHERE cid_number=u.cid_number AND post_state='published' AND post_category='campaign'),
 'videos',(SELECT COUNT(*) FROM square_posts WHERE cid_number=u.cid_number AND post_state='published' AND post_category='normal' AND post_type='video'),
 'articles',(SELECT COUNT(*) FROM square_posts WHERE cid_number=u.cid_number AND post_state='published' AND post_category='normal' AND post_type='article')) counts
 FROM users u LEFT JOIN user_profiles p ON p.cid_number=u.cid_number LEFT JOIN square_memberships m ON m.cid_number=u.cid_number WHERE u.cid_number=?1"#;
const WRITE: &str = r#"
-- statement
INSERT INTO user_profiles(cid_number,display_name,bio,avatar_object_key,avatar_content_hash,banner_object_key,banner_content_hash,updated_at)
SELECT json_extract(?1,'$.after.cid_number'),json_extract(?1,'$.after.display_name'),json_extract(?1,'$.after.bio'),json_extract(?1,'$.after.avatar_object_key'),json_extract(?1,'$.after.avatar_content_hash'),json_extract(?1,'$.after.banner_object_key'),json_extract(?1,'$.after.banner_content_hash'),json_extract(?1,'$.after.updated_at')
WHERE json_extract(?1,'$.after.cid_number')=json_extract(?1,'$.auth.cid_number') AND
 (json_extract(?1,'$.after.avatar_content_hash') IS NULL OR json_extract(?1,'$.after.avatar_content_hash') IS json_extract(?1,'$.before.avatar_content_hash') OR EXISTS(SELECT 1 FROM profile_asset_uploads WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND kind='avatar' AND state='completed' AND sha256=json_extract(?1,'$.after.avatar_content_hash') AND generation=(SELECT MAX(generation) FROM profile_asset_uploads WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND kind='avatar' AND state='completed'))) AND
 (json_extract(?1,'$.after.banner_content_hash') IS NULL OR json_extract(?1,'$.after.banner_content_hash') IS json_extract(?1,'$.before.banner_content_hash') OR EXISTS(SELECT 1 FROM profile_asset_uploads WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND kind='banner' AND state='completed' AND sha256=json_extract(?1,'$.after.banner_content_hash') AND generation=(SELECT MAX(generation) FROM profile_asset_uploads WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND kind='banner' AND state='completed'))) AND
 (NOT EXISTS(SELECT 1 FROM user_profiles WHERE cid_number=json_extract(?1,'$.auth.cid_number')) OR EXISTS(
 SELECT 1 FROM user_profiles WHERE cid_number=json_extract(?1,'$.auth.cid_number')
 AND display_name=json_extract(?1,'$.before.display_name') AND bio=json_extract(?1,'$.before.bio')
 AND avatar_object_key IS json_extract(?1,'$.before.avatar_object_key') AND avatar_content_hash IS json_extract(?1,'$.before.avatar_content_hash')
 AND banner_object_key IS json_extract(?1,'$.before.banner_object_key') AND banner_content_hash IS json_extract(?1,'$.before.banner_content_hash')
 AND updated_at=json_extract(?1,'$.before.updated_at')))
ON CONFLICT(cid_number) DO UPDATE SET display_name=excluded.display_name,bio=excluded.bio,avatar_object_key=excluded.avatar_object_key,avatar_content_hash=excluded.avatar_content_hash,banner_object_key=excluded.banner_object_key,banner_content_hash=excluded.banner_content_hash,updated_at=excluded.updated_at;
"#;
impl Repository for D1Profiles {
    fn doc(&self, cid: &str) -> impl std::future::Future<Output = Result<Option<Doc>>> + Send {
        SendFuture::new(async move {
            first(
                &self.db,
                "SELECT * FROM user_profiles WHERE cid_number=?1",
                &[string(cid)],
            )
            .await
        })
    }
    fn profile(
        &self,
        target: &str,
        viewer: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Option<Profile>>> + Send {
        SendFuture::new(async move {
            let row: Option<Value> = first(
                &self.db,
                PROFILE,
                &[
                    string(target),
                    string(viewer),
                    JsValue::from_f64(now as f64),
                ],
            )
            .await?;
            row.map(|mut r| {
                for k in [
                    "is_certified",
                    "membership_active",
                    "is_following",
                    "is_followed_by",
                    "is_notifying",
                ] {
                    r[k] = json!(r[k].as_u64() == Some(1));
                }
                r["counts"] = serde_json::from_str(r["counts"].as_str().ok_or_else(fail)?)
                    .map_err(|_| fail())?;
                serde_json::from_value(r).map_err(|_| fail())
            })
            .transpose()
        })
    }
    fn write(
        &self,
        auth: &Authorization,
        before: &Doc,
        after: &Doc,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            let r = batch(
                &self.db,
                json!({"auth":auth,"before":before,"after":after}),
                WRITE,
                Error::new(409, "profile_conflict"),
            )
            .await?;
            Ok(r.last()
                .ok_or_else(fail)?
                .meta()
                .map_err(|_| fail())?
                .and_then(|m| m.changes)
                == Some(1))
        })
    }
}
