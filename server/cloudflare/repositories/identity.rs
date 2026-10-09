use citizenserve::{
    chain::finalized::Anchor,
    shared::{Error, Result},
    user::{identity::Identity, ports::IdentityRepository},
};
use serde::Deserialize;
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Identities {
    pub db: D1Database,
}
fn fail() -> Error {
    Error::new(503, "identity_projection_unavailable")
}
#[derive(Deserialize)]
struct Row {
    row_json: String,
}
impl D1Identities {
    async fn lookup(&self, column: &str, value: &str) -> Result<Option<Identity>> {
        let row:Option<Row>=self.db.prepare(format!("SELECT c.row_json FROM user_identity_checks c JOIN users u USING(cid_number) WHERE c.{column}=?1 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision AND json_extract(c.row_json,'$.status')=u.cid_status")).bind(&[JsValue::from_str(value)]).map_err(|_|fail())?.first(None).await.map_err(|_|fail())?;
        row.map(|r| serde_json::from_str(&r.row_json).map_err(|_| fail()))
            .transpose()
    }
}
impl IdentityRepository for D1Identities {
    fn by_account(
        &self,
        a: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send {
        SendFuture::new(self.lookup("account_id", a))
    }
    fn by_cid(
        &self,
        c: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send {
        SendFuture::new(self.lookup("cid_number", c))
    }
    fn claim_refresh(
        &self,
        cid: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            let r=self.db.prepare("UPDATE user_identity_checks SET refresh_lease_until=?2+15000 WHERE cid_number=?1 AND refresh_lease_until<=?2").bind(&[JsValue::from_str(cid),JsValue::from_f64(now as f64)]).map_err(|_|fail())?.run().await.map_err(|_|fail())?;
            Ok(r.success() && r.meta().map_err(|_| fail())?.and_then(|m| m.changes) == Some(1))
        })
    }
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send {
        SendFuture::new(async move {
            #[derive(Deserialize)]
            struct Cursor {
                finalized_block_number: u64,
                finalized_block_hash: String,
            }
            let c:Option<Cursor>=self.db.prepare("SELECT finalized_block_number,finalized_block_hash FROM user_projection_cursor WHERE cursor_id=1").first(None).await.map_err(|_|fail())?;
            Ok(c.map(|c| Anchor {
                number: c.finalized_block_number,
                hash: c.finalized_block_hash,
                parent_hash: String::new(),
            }))
        })
    }
    fn project(
        &self,
        identities: &[Identity],
        cursor: Option<&Anchor>,
        previous: Option<&Anchor>,
    ) -> impl std::future::Future<Output = Result<citizenserve::user::projection::Counts>> + Send
    {
        SendFuture::new(async move {
            let mut stmts = Vec::new();
            let sql: Vec<_> = include_str!("../sql/project_identity.sql")
                .split("-- statement")
                .skip(1)
                .collect();
            if let Some(c) = cursor {
                if previous
                    .map(|p| c.number != p.number + 1 || c.parent_hash != p.hash)
                    .unwrap_or(c.number != 0)
                {
                    return Err(fail());
                }
                let n = previous
                    .map(|p| JsValue::from_f64(p.number as f64))
                    .unwrap_or(JsValue::NULL);
                let h = previous
                    .map(|p| JsValue::from_str(&p.hash))
                    .unwrap_or(JsValue::NULL);
                stmts.push(self.db.prepare(sql[3]).bind(&[n, h]).map_err(|_| fail())?);
            }
            // 必须在整块内先释放所有将变化的账户，否则CID处理顺序可能导致唯一索引冲突。
            for identity in identities {
                identity.validate()?;
                let json = serde_json::to_string(identity).map_err(|_| fail())?;
                stmts.push(
                    self.db
                        .prepare(sql[0])
                        .bind(&[JsValue::from_str(&json)])
                        .map_err(|_| fail())?,
                );
            }
            let mut positions = Vec::new();
            for identity in identities {
                identity.validate()?;
                positions.push((stmts.len(), identity.status));
                let json = serde_json::to_string(identity).map_err(|_| fail())?;
                for sql in &sql[1..3] {
                    let binds = if sql.contains("?2") {
                        vec![
                            JsValue::from_str(&json),
                            JsValue::from_str(&identity.registered_block_hash),
                        ]
                    } else {
                        vec![JsValue::from_str(&json)]
                    };
                    stmts.push(self.db.prepare(*sql).bind(&binds).map_err(|_| fail())?);
                }
            }
            if let Some(c) = cursor {
                stmts.push(
                    self.db
                        .prepare(sql[4])
                        .bind(&[
                            JsValue::from_f64(c.number as f64),
                            JsValue::from_str(&c.hash),
                            JsValue::from_f64(js_sys::Date::now()),
                        ])
                        .map_err(|_| fail())?,
                );
            }
            if stmts.is_empty() {
                return Ok(citizenserve::user::projection::Counts::default());
            }
            let result = self.db.batch(stmts).await.map_err(|_| fail())?;
            if result.iter().any(|r| !r.success()) {
                return Err(fail());
            }
            let mut counts = citizenserve::user::projection::Counts::default();
            for (position, status) in positions {
                if result[position]
                    .meta()
                    .map_err(|_| fail())?
                    .and_then(|m| m.changes)
                    .unwrap_or(0)
                    > 0
                {
                    if status == citizenserve::user::identity::CidStatus::Revoked {
                        counts.revoked += 1;
                    } else {
                        counts.projected += 1;
                    }
                }
            }
            Ok(counts)
        })
    }
}
