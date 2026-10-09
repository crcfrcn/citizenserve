use super::{
    batch, fail,
    square::{D1Square, POST_SELECT},
    string, uploads,
};
use citizenserve::{
    chain::{post::Fact, subscription::Current},
    shared::{Error, Result},
    square::{
        local_copy::Query, manifest::Manifest, post_service::Repository, posts::Post,
        uploads::Upload,
    },
    user::profile_service::Authorization,
};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Posts {
    pub db: D1Database,
    pub square: D1Square,
}
impl D1Posts {
    async fn attach(&self, rows: Vec<Post>) -> Result<Vec<(Post, Upload)>> {
        let mut out = vec![];
        for p in rows {
            let u = uploads::load(
                &self.db,
                "SELECT * FROM square_uploads WHERE post_id=?1",
                &p.post_id,
            )
            .await?
            .ok_or_else(fail)?;
            out.push((p, u));
        }
        Ok(out)
    }
}
impl Repository for D1Posts {
    fn upload_by_post(
        &self,
        _auth: &Authorization,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Upload>>> + Send {
        SendFuture::new(uploads::load(
            &self.db,
            "SELECT * FROM square_uploads WHERE post_id=?1",
            id,
        ))
    }
    fn get(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<(Post, Upload)>>> + Send {
        SendFuture::new(async move {
            let s = &self.square;
            let rows = s
                .indexed(
                    &format!("{POST_SELECT} AND p.post_id=?2 LIMIT 1"),
                    &[JsValue::from_f64(auth.now() as f64), string(id)],
                )
                .await?;
            Ok(self.attach(rows).await?.into_iter().next())
        })
    }
    fn self_posts(
        &self,
        auth: &Authorization,
        q: &Query,
    ) -> impl std::future::Future<Output = Result<Vec<(Post, Upload)>>> + Send {
        SendFuture::new(async move {
            let s = &self.square;
            let cursor = q.cursor.as_ref();
            let rows=s.indexed(&format!("{POST_SELECT} AND p.cid_number=?2 AND (?3 IS NULL OR p.created_at<?3 OR (p.created_at=?3 AND p.post_id<?4)) ORDER BY p.created_at DESC,p.post_id DESC LIMIT ?5"),&[JsValue::from_f64(auth.now() as f64),string(auth.cid()),cursor.map(|c|JsValue::from_f64(c.created_at as f64)).unwrap_or(JsValue::NULL),cursor.map(|c|string(&c.post_id)).unwrap_or(JsValue::NULL),JsValue::from_f64(q.limit as f64)]).await?;
            self.attach(rows).await
        })
    }
    fn confirm(
        &self,
        auth: &Authorization,
        u: &Upload,
        fact: &Fact,
        m: &Manifest,
        current: &Current,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            // confirm_post.sql同事务持久outbox；Queue失败由调度补派，不影响已确认发布。
            let mut cmd = uploads::command(auth, u, current)?;
            cmd["fact"] = json!(fact);
            cmd["title"] = json!(m.title.as_deref().map(str::trim));
            cmd["excerpt"] = json!(m.text.trim().chars().take(300).collect::<String>());
            batch(
                &self.db,
                cmd,
                include_str!("../sql/confirm_post.sql"),
                Error::new(409, "post_confirmation_conflict"),
            )
            .await?;
            Ok(())
        })
    }
}
