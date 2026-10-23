use super::{batch, fail, first, string};
use citizenserve::{
    shared::{Error, Result},
    user::{
        profile_assets::{Credential, Kind, Repository},
        profile_service::Authorization,
    },
};
use serde_json::json;
use worker::{send::SendFuture, D1Database};
pub struct D1Assets {
    pub db: D1Database,
}
const CLAIM: &str = r#"
-- statement
INSERT INTO profile_asset_uploads(upload_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM profile_asset_uploads a WHERE upload_id=json_extract(?1,'$.id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND generation=(SELECT MAX(generation) FROM profile_asset_uploads WHERE cid_number=a.cid_number AND kind=a.kind) AND ((state='prepared' AND expires_at>json_extract(?1,'$.auth.now')) OR (state IN ('writing','completed') AND started_at<=expires_at)));
-- statement
UPDATE profile_asset_uploads SET state='writing',started_at=json_extract(?1,'$.auth.now') WHERE upload_id=json_extract(?1,'$.id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND state='prepared';
"#;
impl Repository for D1Assets {
    fn reserve(
        &self,
        auth: &Authorization,
        c: &Credential,
    ) -> impl std::future::Future<Output = Result<Credential>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"credential":c}),
                include_str!("../sql/reserve_profile_asset.sql"),
                Error::new(409, "profile_asset_busy"),
            )
            .await?;
            first(
                &self.db,
                "SELECT * FROM profile_asset_uploads WHERE upload_id=?1 AND cid_number=?2",
                &[string(&c.upload_id), string(auth.cid())],
            )
            .await?
            .ok_or_else(fail)
        })
    }
    fn claim(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Credential>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"id":id}),
                CLAIM,
                Error::new(409, "profile_asset_expired_or_superseded"),
            )
            .await?;
            first(
                &self.db,
                "SELECT * FROM profile_asset_uploads WHERE upload_id=?1 AND cid_number=?2",
                &[string(id), string(auth.cid())],
            )
            .await?
            .ok_or_else(fail)
        })
    }
    fn complete(
        &self,
        auth: &Authorization,
        c: &Credential,
        etag: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"credential":c,"etag":etag}),
                include_str!("../sql/complete_profile_asset.sql"),
                Error::new(409, "profile_asset_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn referenced(
        &self,
        _auth: &Authorization,
        cid: &str,
        kind: Kind,
    ) -> impl std::future::Future<Output = Result<Option<String>>> + Send {
        SendFuture::new(async move {
            // 列名只由服务端枚举产生，外部路径不能成为SQL标识符。
            let key = kind.name();
            let sql=format!("SELECT p.{key}_content_hash hash FROM user_profiles p JOIN profile_asset_uploads a ON a.cid_number=p.cid_number AND a.kind=?2 AND a.sha256=p.{key}_content_hash AND a.state='completed' AND a.generation=(SELECT MAX(generation) FROM profile_asset_uploads WHERE cid_number=p.cid_number AND kind=?2 AND state='completed') WHERE p.cid_number=?1 AND p.{key}_object_key='profile/'||p.cid_number||'/'||?2");
            let r: Option<serde_json::Value> =
                first(&self.db, &sql, &[string(cid), string(key)]).await?;
            r.map(|r| r["hash"].as_str().map(str::to_owned).ok_or_else(fail))
                .transpose()
        })
    }
}
