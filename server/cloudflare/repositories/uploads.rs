use super::{all, batch, fail, first, string};
use citizenserve::{
    chain::subscription::Current,
    shared::{Error, Result},
    square::{
        media,
        upload_validation::Kind,
        uploads::{Repository, Upload},
    },
    user::profile_service::Authorization,
};
use serde_json::{json, Value};
use worker::{send::SendFuture, D1Database};
pub struct D1Uploads {
    pub db: D1Database,
}
pub(crate) async fn load(db: &D1Database, sql: &str, id: &str) -> Result<Option<Upload>> {
    let row: Option<Value> = first(db, sql, &[string(id)]).await?;
    let Some(mut row) = row else { return Ok(None) };
    let id = row["upload_id"].as_str().ok_or_else(fail)?.to_owned();
    let items:Vec<Value>=all(db,"SELECT media_kind,content_type,byte_size,sha256,width,height,duration_seconds,derivative_kind,derivative_content_type,derivative_byte_size,derivative_sha256 FROM square_media_assets WHERE upload_id=?1 ORDER BY media_index LIMIT 111",&[string(&id)]).await?;
    if items.len() > 110 {
        return Err(fail());
    }
    row["media_items"] = json!(items);
    serde_json::from_value(row).map(Some).map_err(|_| fail())
}
pub(crate) fn membership(current: &Current, now: u64) -> Result<Value> {
    let s = current.require(now)?;
    let level = current.level(now)?;
    let mut limits =
        serde_json::to_value(citizenserve::membership::plan(level)).map_err(|_| fail())?;
    limits["storage_bytes"] = json!(citizenserve::membership::limits::limits(level).storage_bytes);
    Ok(
        json!({"membership_checked":current.checked_at(),"membership_deadline":current.deadline(),"paid_until":s.paid_until,"period_start":s.last_charged_at,"chain_time":current.chain_time,"limits":limits}),
    )
}
pub(crate) fn command(auth: &Authorization, u: &Upload, current: &Current) -> Result<Value> {
    let mut cmd = membership(current, auth.now())?;
    cmd["auth"] = json!(auth);
    cmd["upload"] = json!(u);
    Ok(cmd)
}
const MANIFEST: &str = r#"
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM square_uploads WHERE upload_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND status IN ('prepared','uploading') AND expires_at>json_extract(?1,'$.auth.now'));
-- statement
UPDATE square_uploads SET status='uploading' WHERE upload_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number');
"#;
const DELETE: &str = r#"
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM square_uploads u WHERE u.upload_id=json_extract(?1,'$.upload.upload_id') AND u.cid_number=json_extract(?1,'$.auth.cid_number') AND ((json_extract(?1,'$.post')=1 AND (u.status IN ('deleting','deleted') OR EXISTS(SELECT 1 FROM square_posts p WHERE p.post_id=u.post_id AND p.cid_number=u.cid_number AND p.post_state='published'))) OR (json_extract(?1,'$.post')=0 AND NOT EXISTS(SELECT 1 FROM square_posts p WHERE p.post_id=u.post_id) AND u.status IN ('prepared','uploading','completed','deleting','deleted'))));
-- statement
UPDATE square_uploads SET status='deleting' WHERE upload_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND status<>'deleted';
-- statement
UPDATE square_posts SET post_state='deleting' WHERE post_id=json_extract(?1,'$.upload.post_id') AND cid_number=json_extract(?1,'$.auth.cid_number');
"#;
impl Repository for D1Uploads {
    fn reserve(
        &self,
        auth: &Authorization,
        u: &Upload,
        current: &Current,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let mut cmd = command(auth, u, current)?;
            cmd["image_count"] = json!(u
                .media_items
                .iter()
                .filter(|i| i.media_kind == Kind::Image)
                .count());
            cmd["video_seconds"] = json!(u
                .media_items
                .iter()
                .map(|i| i.duration_seconds.unwrap_or(0) as u64)
                .sum::<u64>());
            let level = serde_json::to_value(current.level(auth.now())?).map_err(|_| fail())?;
            let level = level.as_str().ok_or_else(fail)?;
            let plans = media::plans(u)?;
            let mut assets = vec![];
            for (index, item) in u.media_items.iter().enumerate() {
                let mut value = serde_json::to_value(item).map_err(|_| fail())?;
                for (k, v) in [
                    ("upload_id", json!(u.upload_id)),
                    ("post_id", json!(u.post_id)),
                    ("cid_number", json!(u.cid_number)),
                    ("account_id", json!(u.account_id)),
                    ("media_index", json!(index)),
                    ("object_key", json!(plans[index * 2].object_key)),
                    (
                        "derivative_object_key",
                        json!(plans[index * 2 + 1].object_key),
                    ),
                    ("upload_method", json!("r2_put")),
                    (
                        "resource_key",
                        json!(format!(
                            "square_{}_{}",
                            if item.media_kind == Kind::Image {
                                "image"
                            } else {
                                "video"
                            },
                            level
                        )),
                    ),
                    ("asset_state", json!("prepared")),
                    ("created_at", json!(auth.now())),
                    ("updated_at", json!(auth.now())),
                ] {
                    value[k] = v;
                }
                assets.push(value);
            }
            cmd["assets"] = json!(assets);
            batch(
                &self.db,
                cmd,
                include_str!("../sql/reserve_upload.sql"),
                Error::new(409, "upload_quota_exceeded"),
            )
            .await?;
            Ok(())
        })
    }
    fn get(
        &self,
        _auth: &Authorization,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Upload>>> + Send {
        SendFuture::new(load(
            &self.db,
            "SELECT * FROM square_uploads WHERE upload_id=?1",
            id,
        ))
    }
    fn manifest_written(
        &self,
        auth: &Authorization,
        u: &Upload,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"upload":u}),
                MANIFEST,
                Error::new(409, "upload_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn complete(
        &self,
        auth: &Authorization,
        u: &Upload,
        current: &Current,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                command(auth, u, current)?,
                include_str!("../sql/complete_upload.sql"),
                Error::new(409, "upload_completion_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn start_delete(
        &self,
        auth: &Authorization,
        u: &Upload,
        post: bool,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"upload":u,"post":post}),
                DELETE,
                Error::new(409, "content_delete_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn finish_delete(
        &self,
        auth: &Authorization,
        u: &Upload,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"upload":u}),
                include_str!("../sql/release_content.sql"),
                Error::new(409, "content_delete_conflict"),
            )
            .await?;
            Ok(())
        })
    }
}
