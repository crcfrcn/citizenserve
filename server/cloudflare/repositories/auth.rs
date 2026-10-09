use citizenserve::{
    shared::{Error, Result},
    user::{
        admission::Admission,
        auth::{
            challenge::{Challenge, Consumption},
            device::{Commit, Device},
            session::Session,
        },
        ports::AuthRepository,
        registration::protocol::Config,
    },
};
use serde::{de::DeserializeOwned, Deserialize};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Auth {
    pub db: D1Database,
}
fn fail() -> Error {
    Error::new(503, "authentication_unavailable")
}
fn json<T: serde::Serialize>(v: &T) -> Result<JsValue> {
    Ok(JsValue::from_str(
        &serde_json::to_string(v).map_err(|_| fail())?,
    ))
}
impl D1Auth {
    async fn first<T: DeserializeOwned>(&self, sql: &str, values: &[JsValue]) -> Result<Option<T>> {
        self.db
            .prepare(sql)
            .bind(values)
            .map_err(|_| fail())?
            .first(None)
            .await
            .map_err(|_| fail())
    }
    async fn one(&self, sql: &str, values: &[JsValue]) -> Result<bool> {
        let result = self
            .db
            .prepare(sql)
            .bind(values)
            .map_err(|_| fail())?
            .run()
            .await
            .map_err(|_| fail())?;
        if !result.success() {
            return Err(fail());
        }
        Ok(result.meta().map_err(|_| fail())?.and_then(|m| m.changes) == Some(1))
    }
    async fn transaction(&self, sql: &str, command: JsValue) -> Result<()> {
        let statements = sql
            .split("-- statement")
            .skip(1)
            .map(|sql| self.db.prepare(sql).bind(std::slice::from_ref(&command)))
            .collect::<worker::Result<Vec<_>>>()
            .map_err(|_| fail())?;
        let results = self.db.batch(statements).await.map_err(|e| {
            // 固定约束断言失败属于并发业务冲突；不展开D1原始异常/命令内容。
            if matches!(&e, worker::Error::D1(cause) if cause.cause().contains("NOT NULL constraint failed: cid_admissions.cid_number")) {
                Error::registration(
                    409,
                    "registration_activation_conflict",
                    false,
                    "read_status",
                )
            } else {
                fail()
            }
        })?;
        if results.iter().any(|r| !r.success()) {
            return Err(fail());
        }
        Ok(())
    }
}
impl AuthRepository for D1Auth {
    fn device(
        &self,
        cid: &str,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Device>>> + Send {
        SendFuture::new(async move {
            #[derive(Deserialize)]
            struct Row {
                row_json: String,
            }
            let row:Option<Row>=self.first("SELECT json_object('cid_number',cid_number,'device_id',device_id,'account_id',account_id,'binding_revision',binding_revision,'public_key',public_key,'issued_at',issued_at,'created_at',created_at,'updated_at',updated_at,'active',json(CASE active WHEN 1 THEN 'true' ELSE 'false' END)) AS row_json FROM mls_devices WHERE cid_number=?1 AND device_id=?2",&[JsValue::from_str(cid),JsValue::from_str(id)]).await?;
            row.map(|r| serde_json::from_str(&r.row_json).map_err(|_| fail()))
                .transpose()
        })
    }
    fn admission(
        &self,
        cid: &str,
    ) -> impl std::future::Future<Output = Result<Option<Admission>>> + Send {
        SendFuture::new(async move {
            self.first(
                "SELECT * FROM cid_admissions WHERE cid_number=?1",
                &[JsValue::from_str(cid)],
            )
            .await
        })
    }
    fn session(
        &self,
        hash: &str,
    ) -> impl std::future::Future<Output = Result<Option<Session>>> + Send {
        SendFuture::new(async move {
            self.first(
                "SELECT * FROM square_sessions WHERE session_token_hash=?1",
                &[JsValue::from_str(hash)],
            )
            .await
        })
    }
    fn issue_challenge(
        &self,
        c: &Challenge,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            let purpose = c.purpose.ok_or_else(fail)?;
            self.one(
                include_str!("../sql/issue_mls_challenge.sql"),
                &[
                    json(c)?,
                    JsValue::from_str(
                        serde_json::to_value(purpose)
                            .map_err(|_| fail())?
                            .as_str()
                            .ok_or_else(fail)?,
                    ),
                    c.session_token_hash
                        .as_ref()
                        .map(|v| JsValue::from_str(v))
                        .unwrap_or(JsValue::NULL),
                    JsValue::from_f64(c.created_at as f64),
                ],
            )
            .await
        })
    }
    fn consume(
        &self,
        c: &Consumption<'_>,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            self.one(
                include_str!("../sql/consume_mls_challenge.sql"),
                &[json(c)?],
            )
            .await
        })
    }
    fn activate(&self, c: &Commit) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            self.transaction(include_str!("../sql/activate_device.sql"), json(c)?)
                .await?;
            let d = self
                .device(&c.identity.cid_number, &c.device.device_id)
                .await?
                .ok_or_else(fail)?;
            d.require(&c.identity, &c.device.public_key)?;
            if d.issued_at != c.device.issued_at {
                return Err(fail());
            }
            let a = self
                .admission(&c.identity.cid_number)
                .await?
                .ok_or_else(fail)?;
            if a.registration_scope != c.config.registration_scope
                || a.service_origin != c.config.service_origin
                || a.chain_scope != c.config.chain_scope
                || a.institution != c.identity.institution
            {
                return Err(fail());
            }
            if let Some(e) = &c.enrollment {
                #[derive(Deserialize)]
                struct Row {
                    row_json: String,
                }
                let stored:Option<Row>=self.first("SELECT row_json FROM registration_enrollments WHERE enrollment_id=?1 AND state='activated'",&[JsValue::from_str(&e.enrollment_id)]).await?;
                let stored: citizenserve::user::registration::protocol::Enrollment =
                    serde_json::from_str(&stored.ok_or_else(fail)?.row_json).map_err(|_| fail())?;
                if stored.activation != e.activation {
                    return Err(fail());
                }
            }
            Ok(())
        })
    }
    fn issue_session(
        &self,
        s: &Session,
        config: &Config,
        now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let value = serde_json::json!({"session":s,"config":{"registration_scope":config.registration_scope,"service_origin":config.service_origin,"chain_scope":config.chain_scope},"now":now});
            self.transaction(include_str!("../sql/issue_session.sql"), json(&value)?)
                .await?;
            if self.session(&s.session_token_hash).await?.is_none() {
                return Err(fail());
            }
            Ok(())
        })
    }
}
