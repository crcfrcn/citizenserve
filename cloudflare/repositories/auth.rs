use citizenserve::{
    shared::{Error, Result},
    user::{
        admission::Admission,
        auth::{
            challenge::{Challenge, Consumption},
            device::{Commit, Device},
            session::Session,
        },
        ports::{AuthContext, AuthRepository, ContextKey},
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
    /// 同一事务插入或复用Session挑战；复用不写旧行，也不延长其期限。
    pub(crate) async fn session_challenge(&self, proposed: &Challenge) -> Result<Challenge> {
        use citizenserve::user::auth::mls_authentication::Purpose;
        if proposed.purpose != Some(Purpose::Session) || proposed.session_token_hash.is_some() {
            return Err(fail());
        }
        let (insert, read) = include_str!("../sql/issue_mls_challenge.sql")
            .split_once("-- session read")
            .ok_or_else(fail)?;
        let values = [
            json(proposed)?,
            JsValue::from_str("session"),
            JsValue::NULL,
            JsValue::from_f64(proposed.created_at as f64),
            JsValue::from_f64(citizenserve::gate::policy::SYNC_HEALTH_MILLIS as f64),
        ];
        let statements = [insert, read]
            .into_iter()
            .map(|s| self.db.prepare(s).bind(&values))
            .collect::<worker::Result<Vec<_>>>()
            .map_err(|_| fail())?;
        let mut results = self.db.batch(statements).await.map_err(|_| fail())?;
        if results.iter().any(|r| !r.success()) {
            return Err(fail());
        }
        #[derive(Deserialize)]
        struct Row {
            challenge_json: String,
            created_at: u64,
        }
        let mut rows: Vec<Row> = results
            .pop()
            .ok_or_else(fail)?
            .results()
            .map_err(|_| fail())?;
        let row = rows.pop().ok_or(Error::new(401, "invalid_mls_challenge"))?;
        if !rows.is_empty() {
            return Err(fail());
        }
        let mut current: Challenge =
            serde_json::from_str(&row.challenge_json).map_err(|_| fail())?;
        current.purpose = Some(Purpose::Session);
        current.created_at = row.created_at;
        Ok(current)
    }
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
    fn context(
        &self,
        key: ContextKey<'_>,
        _config: &Config,
    ) -> impl std::future::Future<Output = Result<Option<AuthContext>>> + Send {
        SendFuture::new(async move {
            // 此查询不刷新事实、不查链；设备/会话及同步时间在同一D1快照取得。
            let loaded_at = js_sys::Date::now() as u64;
            let recovery = matches!(key, ContextKey::Recovery { .. });
            let deletion_fence = if recovery {
                "1"
            } else {
                "NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.cid_number=u.cid_number AND x.state='pending')"
            };
            let (selector,first,second,session_join,device_join)=match key {
                ContextKey::Session(hash)=>("s.session_token_hash=?1",hash,None,
                    "LEFT JOIN square_sessions s ON s.cid_number=u.cid_number",
                    "LEFT JOIN mls_devices d ON d.cid_number=u.cid_number AND d.device_id=s.device_id"),
                ContextKey::Device{account,device}=>("u.account_id=?1 AND d.device_id=?2",account,Some(device),
                    "LEFT JOIN square_sessions s ON 0",
                    "LEFT JOIN mls_devices d ON d.cid_number=u.cid_number AND d.device_id=?2"),
                ContextKey::Recovery{account}=>("u.account_id=?1",account,None,
                    "LEFT JOIN square_sessions s ON 0","LEFT JOIN mls_devices d ON 0"),
            };
            let sql = format!(
                r#"SELECT c.row_json identity,
              CASE WHEN d.device_id IS NOT NULL THEN json_object('cid_number',d.cid_number,'device_id',d.device_id,'account_id',d.account_id,'binding_revision',d.binding_revision,'public_key',d.public_key,'issued_at',d.issued_at,'created_at',d.created_at,'updated_at',d.updated_at,'active',json(CASE d.active WHEN 1 THEN 'true' ELSE 'false' END)) END device,
              CASE WHEN a.cid_number IS NOT NULL THEN json_object('cid_number',a.cid_number,'enrollment_id',a.enrollment_id,'source',a.source,'human_verified_at_millis',a.human_verified_at_millis,'registration_scope',a.registration_scope,'service_origin',a.service_origin,'chain_scope',a.chain_scope,'institution',a.institution) END admission,
              CASE WHEN s.session_token_hash IS NOT NULL THEN json_object('session_token_hash',s.session_token_hash,'cid_number',s.cid_number,'account_id',s.account_id,'binding_revision',s.binding_revision,'device_id',s.device_id,'created_at',s.created_at,'expires_at',s.expires_at) END session,
              CASE WHEN m.cid_number IS NOT NULL THEN json_object('cid_number',m.cid_number,'membership_level',m.membership_level,'subscription_status',m.subscription_status,'started_at',m.started_at,'last_charged_at',m.last_charged_at,'paid_until',m.paid_until,'last_charged_price_fen',m.last_charged_price_fen,'authorized_price_fen',m.authorized_price_fen,'finalized_block_number',m.finalized_block_number,'finalized_block_hash',m.finalized_block_hash) END membership,
              CASE WHEN cur.finalized_block_number>=h.last_slot THEN COALESCE(h.updated_at,0) ELSE 0 END identity_synced_at, CASE WHEN mc.finalized_block_number>=mh.last_slot THEN mh.updated_at END membership_synced_at
              FROM users u JOIN user_identity_checks c USING(cid_number)
              {session_join} {device_join}
              LEFT JOIN cid_admissions a ON a.cid_number=u.cid_number
              LEFT JOIN square_memberships m ON m.cid_number=u.cid_number
              LEFT JOIN scheduler_leases h ON h.lease_key='sync:identity:'||json_extract(c.row_json,'$.chain_scope')
              LEFT JOIN user_projection_cursor cur ON cur.cursor_id=1
              LEFT JOIN scheduler_leases mh ON mh.lease_key='sync:membership:'||json_extract(c.row_json,'$.chain_scope')
              LEFT JOIN membership_projection_cursor mc ON mc.cursor_id=1
              WHERE {selector} AND u.cid_status='active' AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
              AND json_extract(c.row_json,'$.status')=u.cid_status
              AND {deletion_fence} LIMIT 1"#
            );
            #[derive(Deserialize)]
            struct Row {
                identity: String,
                device: Option<String>,
                admission: Option<String>,
                session: Option<String>,
                membership: Option<String>,
                identity_synced_at: u64,
                membership_synced_at: Option<u64>,
            }
            let mut args = vec![JsValue::from_str(first)];
            if let Some(second) = second {
                args.push(JsValue::from_str(second));
            }
            let row: Option<Row> = self.first(&sql, &args).await?;
            let parse = |s: Option<String>| -> Result<Option<serde_json::Value>> {
                s.map(|s| serde_json::from_str(&s).map_err(|_| fail()))
                    .transpose()
            };
            let Some(r) = row else { return Ok(None) };
            Ok(Some(AuthContext {
                loaded_at,
                identity: serde_json::from_str(&r.identity).map_err(|_| fail())?,
                device: parse(r.device)?
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| fail())?,
                admission: parse(r.admission)?
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| fail())?,
                session: parse(r.session)?
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| fail())?,
                membership: parse(r.membership)?
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| fail())?,
                identity_synced_at: r.identity_synced_at,
                membership_synced_at: r.membership_synced_at,
            }))
        })
    }
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
                include_str!("../sql/issue_mls_challenge.sql")
                    .split_once("-- session read")
                    .ok_or_else(fail)?
                    .0,
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
                    JsValue::from_f64(
                        citizenserve::gate::policy::SYNC_HEALTH_MILLIS as f64,
                    ),
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
            let value = serde_json::json!({"session":s,"config":{"registration_scope":config.registration_scope,"service_origin":config.service_origin,"chain_scope":config.chain_scope,"sync_health_millis":citizenserve::gate::policy::SYNC_HEALTH_MILLIS},"now":now});
            self.transaction(include_str!("../sql/issue_session.sql"), json(&value)?)
                .await?;
            if self.session(&s.session_token_hash).await?.is_none() {
                return Err(fail());
            }
            Ok(())
        })
    }
}
