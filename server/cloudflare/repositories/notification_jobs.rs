//! D1权威outbox；所有系统写入只接受内部构造的租约/证据，不能使用HTTP凭据替代。
use super::{all, first, string};
use citizenserve::{
    notifications::{
        delivery::{AuthorizedEndpoint, Outcome},
        endpoint::Stored,
        fanout::{Follower, Page},
        jobs::{Cursor, Delivery, Disposition, Job, Kind, Lease, Message, Source, State},
        ports::{Jobs, Sender, Verifier},
    },
    server::maintenance::Budget,
    shared::{Error, Result},
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database, Env};
fn bad() -> Error {
    Error::new(503, "notification_storage_unavailable")
}
pub(crate) async fn system_batch(
    db: &D1Database,
    budget: &Budget,
    mut cmd: Value,
    sql: &str,
) -> Result<()> {
    budget.commit(1)?;
    cmd["now"] = json!(js_sys::Date::now() as u64);
    let raw = string(&cmd.to_string());
    let statements = sql
        .split("-- statement")
        .skip(1)
        .map(|s| db.prepare(s).bind(std::slice::from_ref(&raw)))
        .collect::<worker::Result<Vec<_>>>()
        .map_err(|_| bad())?;
    let result = db.batch(statements).await.map_err(|e| match e {
        worker::Error::D1(c) if c.cause().contains("NOT NULL constraint failed") => {
            Error::new(409, "notification_conflict")
        }
        _ => bad(),
    })?;
    if result.iter().any(|r| !r.success()) {
        return Err(bad());
    }
    Ok(())
}
pub struct D1Jobs<'a> {
    pub db: D1Database,
    pub env: &'a Env,
    pub budget: Budget,
}
#[derive(Deserialize)]
struct Claim {
    state: State,
    lease_token: Option<String>,
    lease_expires_at: u64,
    attempts: u8,
    next_attempt_at: u64,
}
impl<'a> D1Jobs<'a> {
    pub fn configured(env: &'a Env, budget: Budget) -> Result<Self> {
        Ok(Self {
            db: env.d1("DB").map_err(|_| bad())?,
            env,
            budget,
        })
    }
    pub(crate) async fn first<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[JsValue],
    ) -> Result<Option<T>> {
        self.budget.business(1)?;
        first(&self.db, sql, args).await
    }
    pub(crate) async fn all<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[JsValue],
    ) -> Result<Vec<T>> {
        self.budget.business(1)?;
        all(&self.db, sql, args).await
    }
    async fn claim_row(&self, m: &Message) -> Result<Option<Claim>> {
        let (t, c) = table(m.kind);
        self.first(&format!("SELECT state,lease_token,lease_expires_at,attempts,next_attempt_at FROM {t} WHERE {c}=?1"),&[string(&m.id)]).await
    }
    pub async fn payload(&self, m: &Message) -> Result<Value> {
        let d = self.delivery(&m.id).await?.ok_or_else(bad)?;
        let job = self.job(&d.job_id).await?.ok_or_else(bad)?;
        let row: Value = if job.source_kind == Source::Post {
            self.first("SELECT p.title,p.excerpt,COALESCE(pr.display_name,'') display_name FROM square_posts p LEFT JOIN user_profiles pr ON pr.cid_number=p.cid_number WHERE p.post_id=?1 AND p.tx_hash=?2 AND p.cid_number=?3",&[string(job.post_id.as_deref().ok_or_else(bad)?),string(job.tx_hash.as_deref().ok_or_else(bad)?),string(&job.cid_number)]).await?.unwrap_or(json!({}))
        } else {
            json!({})
        };
        citizenserve::notifications::delivery::payload(
            &job,
            row["title"].as_str(),
            row["excerpt"].as_str().unwrap_or(""),
            row["display_name"].as_str().unwrap_or(""),
        )
    }
    /// 每30秒续租一次，始终以同一nonce CAS；失去租约后不得继续后台工作。
    pub async fn renew_message(&self, m: &Message, nonce: &str) -> Result<()> {
        let (t, c) = table(m.kind);
        let now = js_sys::Date::now() as u64;
        self.budget.commit(1)?;
        let result=self.db.prepare(format!("UPDATE {t} SET lease_expires_at=?1+120000 WHERE {c}=?2 AND state='leased' AND lease_token=?3 AND lease_expires_at>?1")).bind(&[JsValue::from_f64(now as f64),string(&m.id),string(nonce)]).map_err(|_|bad())?.run().await.map_err(|_|bad())?;
        if result.meta().map_err(|_| bad())?.and_then(|m| m.changes) != Some(1) {
            return Err(Error::new(409, "job_lease_conflict"));
        }
        Ok(())
    }
    pub async fn dispatch(&self) -> Result<()> {
        let now = js_sys::Date::now() as u64;
        // 租约超时才补派；Queue未知结果不会令outbox丢失。四次以上先持久blocked。
        for (t, c, k) in [
            ("notification_jobs", "job_id", Kind::Fanout),
            ("notification_deliveries", "delivery_id", Kind::Delivery),
            ("maintenance_jobs", "job_id", Kind::Maintenance),
        ] {
            if self.budget.remaining() < 4 {
                break;
            }
            self.budget.business(1)?;
            let due:Vec<Value>=all(&self.db,&format!("SELECT {c} id FROM {t} WHERE state IN ('pending','leased') AND next_attempt_at<=?1 AND lease_expires_at<=?1 AND last_dispatched_at<=?1-120000 ORDER BY updated_at,{c} LIMIT 8"),&[JsValue::from_f64(now as f64)]).await?;
            for row in due {
                if self.budget.remaining() < 2 {
                    break;
                }
                let id = row["id"].as_str().ok_or_else(bad)?;
                let m = Message {
                    version: 1,
                    kind: k,
                    id: id.into(),
                };
                m.validate()?;
                self.budget.business(1)?;
                self.env
                    .queue("NOTIFY")
                    .map_err(|_| bad())?
                    .send(m)
                    .await
                    .map_err(|_| bad())?;
                self.budget.commit(1)?;
                self.db.prepare(format!("UPDATE {t} SET last_dispatched_at=?1 WHERE {c}=?2 AND state IN ('pending','leased')")).bind(&[JsValue::from_f64(now as f64),string(id)]).map_err(|_|bad())?.run().await.map_err(|_|bad())?;
            }
        }
        Ok(())
    }
}
fn table(k: Kind) -> (&'static str, &'static str) {
    match k {
        Kind::Fanout => ("notification_jobs", "job_id"),
        Kind::Delivery => ("notification_deliveries", "delivery_id"),
        Kind::Maintenance => ("maintenance_jobs", "job_id"),
    }
}
impl Jobs for D1Jobs<'_> {
    fn claim(
        &self,
        m: &Message,
        nonce: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Option<Lease>>> + Send {
        SendFuture::new(async move {
            m.validate()?;
            let sql = if m.kind == Kind::Maintenance {
                include_str!("../sql/claim_maintenance_job.sql")
            } else {
                include_str!("../sql/claim_notification_job.sql")
            };
            system_batch(
                &self.db,
                &self.budget,
                json!({"kind":m.kind,"id":m.id,"nonce":nonce}),
                sql,
            )
            .await?;
            match self.claim_row(m).await? {
                Some(c)
                    if c.state == State::Leased
                        && c.lease_token.as_deref() == Some(nonce)
                        && c.lease_expires_at > js_sys::Date::now() as u64 =>
                {
                    Ok(Some(Lease::acquired(
                        m.id.clone(),
                        m.kind,
                        nonce.into(),
                        now,
                        c.attempts,
                    )?))
                }
                _ => Ok(None),
            }
        })
    }
    fn disposition(
        &self,
        m: &Message,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Disposition>> + Send {
        SendFuture::new(async move {
            Ok(match self.claim_row(m).await? {
                None => Disposition::Ack,
                Some(c) if c.state.terminal() => Disposition::Ack,
                Some(c) => Disposition::Retry(
                    ((c.next_attempt_at
                        .max(c.lease_expires_at)
                        .saturating_sub(now)
                        / 1000)
                        + 1)
                    .clamp(1, 3600) as u32,
                ),
            })
        })
    }
    fn job(&self, id: &str) -> impl std::future::Future<Output = Result<Option<Job>>> + Send {
        SendFuture::new(async move {
            self.first(
                "SELECT * FROM notification_jobs WHERE job_id=?1",
                &[string(id)],
            )
            .await
        })
    }
    fn delivery(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Delivery>>> + Send {
        SendFuture::new(async move {
            self.first(
                "SELECT * FROM notification_deliveries WHERE delivery_id=?1",
                &[string(id)],
            )
            .await
        })
    }
    fn page(&self, job: &Job, now: u64) -> impl std::future::Future<Output = Result<Page>> + Send {
        SendFuture::new(async move {
            let followers: Vec<Cursor> = if job.source_kind == Source::StorageCleanup {
                vec![Cursor {
                    created_at: job.created_at,
                    cid_number: job.cid_number.clone(),
                }]
            } else {
                let c = job.cursor()?;
                self.all("SELECT created_at,follower_cid_number cid_number FROM square_follows WHERE followed_cid_number=?1 AND notify_enabled=1 AND created_at<=?2 AND (?3 IS NULL OR created_at>?3 OR (created_at=?3 AND follower_cid_number>?4)) ORDER BY created_at,follower_cid_number LIMIT 5",&[string(&job.cid_number),JsValue::from_f64(job.created_at as f64),c.as_ref().map(|c|JsValue::from_f64(c.created_at as f64)).unwrap_or(JsValue::NULL),c.as_ref().map(|c|string(&c.cid_number)).unwrap_or(JsValue::NULL)]).await?
            };
            let complete = job.source_kind == Source::StorageCleanup || followers.len() < 5;
            let encoded =
                serde_json::to_string(&followers.iter().map(|f| &f.cid_number).collect::<Vec<_>>())
                    .map_err(|_| bad())?;
            let endpoints:Vec<Stored>=self.all("SELECT e.* FROM push_endpoints e JOIN users u ON u.cid_number=e.cid_number AND u.account_id=e.account_id AND u.binding_revision=e.binding_revision AND u.cid_status='active' JOIN mls_devices d ON d.cid_number=e.cid_number AND d.device_id=e.device_id AND d.active=1 AND d.account_id=e.account_id AND d.binding_revision=e.binding_revision WHERE e.cid_number IN (SELECT value FROM json_each(?1)) AND e.expires_at>?2 ORDER BY e.cid_number,e.device_id LIMIT 41",&[string(&encoded),JsValue::from_f64(now as f64)]).await?;
            if endpoints.len() > 40 {
                return Err(Error::new(503, "notification_page_too_large"));
            }
            Ok(Page {
                followers: followers
                    .into_iter()
                    .map(|cursor| Follower {
                        endpoints: endpoints
                            .iter()
                            .filter(|e| e.cid_number == cursor.cid_number)
                            .cloned()
                            .collect(),
                        cursor,
                    })
                    .collect(),
                complete,
            })
        })
    }
    fn commit_page(
        &self,
        lease: &Lease,
        job: &Job,
        page: &Page,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            page.validate(job)?;
            system_batch(&self.db,&self.budget,json!({"lease":lease,"job":job,"deliveries":page.deliveries(job),"complete":page.complete,"cursor":page.followers.last().map(|f|&f.cursor)}),include_str!("../sql/commit_fanout.sql")).await
        })
    }
    fn finish(
        &self,
        lease: &Lease,
        outcome: &Outcome,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            if lease.kind() == Kind::Maintenance
                || lease.kind() == Kind::Fanout
                    && matches!(outcome, Outcome::Accepted | Outcome::InvalidEndpoint)
            {
                return Err(bad());
            }
            system_batch(
                &self.db,
                &self.budget,
                json!({"lease":lease,"outcome":outcome}),
                include_str!("../sql/complete_delivery.sql"),
            )
            .await
        })
    }
}
impl Verifier for D1Jobs<'_> {
    fn authorize(
        &self,
        job: &Job,
        d: &Delivery,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Option<AuthorizedEndpoint>>> + Send {
        SendFuture::new(async move {
            use citizenserve::{
                chain::{finalized, identity, subscription},
                user::identity::CidStatus,
            };
            let rpc =
                crate::maintenance::BudgetRpc::configured(self.env, self.budget.clone(), None)?;
            let genesis = self
                .env
                .var("CHAIN_GENESIS_HASH")
                .map_err(|_| bad())?
                .to_string();
            let anchor = finalized::head(&rpc, &genesis).await?;
            let m = identity::metadata(&rpc, &anchor).await?;
            let Some(i) = identity::by_cid(&rpc, &m, &anchor, &d.cid_number, &genesis, now).await?
            else {
                return Ok(None);
            };
            if i.status != CidStatus::Active
                || i.account_id != d.account_id
                || i.binding_revision != d.binding_revision
            {
                return Ok(None);
            }
            let Some(e):Option<Stored>=self.first("SELECT * FROM push_endpoints WHERE cid_number=?1 AND device_id=?2 AND endpoint_revision=?3",&[string(&d.cid_number),string(&d.device_id),JsValue::from_f64(d.endpoint_revision as f64)]).await? else{return Ok(None);};
            let scope = self
                .env
                .var("REGISTRATION_SCOPE")
                .map_err(|_| bad())?
                .to_string();
            let origin = self.env.var("WEB_ORIGIN").map_err(|_| bad())?.to_string();
            let eligible:Option<Value>=self.first("SELECT 1 ok FROM users u JOIN cid_admissions a ON a.cid_number=u.cid_number JOIN mls_devices m ON m.cid_number=u.cid_number WHERE u.cid_number=?1 AND u.account_id=?2 AND u.binding_revision=?3 AND u.cid_status='active' AND m.device_id=?4 AND m.active=1 AND m.account_id=u.account_id AND m.binding_revision=u.binding_revision AND a.registration_scope=?5 AND a.service_origin=?6 AND a.chain_scope=?7",&[string(&d.cid_number),string(&d.account_id),JsValue::from_f64(d.binding_revision as f64),string(&d.device_id),string(&scope),string(&origin),string(&genesis)]).await?;
            let source = if job.source_kind == Source::Post {
                self.first::<Value>("SELECT 1 ok FROM square_posts p JOIN square_follows f ON f.followed_cid_number=p.cid_number WHERE p.post_id=?1 AND p.tx_hash=?2 AND p.cid_number=?3 AND p.post_state='published' AND f.follower_cid_number=?4 AND f.notify_enabled=1",&[string(job.post_id.as_deref().ok_or_else(bad)?),string(job.tx_hash.as_deref().ok_or_else(bad)?),string(&job.cid_number),string(&d.cid_number)]).await?.is_some()
            } else {
                let s = subscription::at(&rpc, &m, &anchor, &d.cid_number, None).await?;
                s.is_some_and(|s|!s.active(js_sys::Date::now() as u64,i.finalized_timestamp_millis)&&Some(s.paid_until)==job.lapse_at)&&self.first::<Value>("SELECT 1 ok FROM square_memberships m JOIN resource_totals t USING(cid_number) WHERE m.cid_number=?1 AND m.storage_cleanup_lapse_at=?2 AND m.storage_cleanup_notified_at=?3 AND t.resource_key='square_storage' AND t.byte_size>100000000000",&[string(&d.cid_number),JsValue::from_f64(job.lapse_at.ok_or_else(bad)? as f64),JsValue::from_f64(job.created_at as f64)]).await?.is_some()
            };
            AuthorizedEndpoint::from_facts(
                &i,
                d,
                e,
                eligible.is_some(),
                source,
                js_sys::Date::now() as u64,
            )
        })
    }
}
impl Sender for D1Jobs<'_> {
    fn send(
        &self,
        e: &AuthorizedEndpoint,
        p: &Value,
        c: &str,
    ) -> impl std::future::Future<Output = Result<Outcome>> + Send {
        SendFuture::new(async move {
            crate::push::Push {
                env: self.env,
                budget: self.budget.clone(),
            }
            .send(e, p, c)
            .await
        })
    }
}
