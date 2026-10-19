//! 私有系统任务存储。对象定位和不可变历史块读取缓存只归所属维护任务，不作当前授权缓存。
use super::{all, first, notification_jobs::system_batch, string};
use citizenserve::{
    notifications::jobs::{Lease, State},
    server::maintenance::{Budget, Task},
    shared::{Error, Result},
    square::maintenance::Locator,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use wasm_bindgen::JsValue;
use worker::D1Database;
fn bad() -> Error {
    Error::new(503, "maintenance_storage_unavailable")
}
pub struct D1Maintenance {
    pub db: D1Database,
    pub budget: Budget,
}
impl D1Maintenance {
    pub async fn first<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[JsValue],
    ) -> Result<Option<T>> {
        self.budget.business(1)?;
        first(&self.db, sql, args).await
    }
    pub async fn all<T: DeserializeOwned>(&self, sql: &str, args: &[JsValue]) -> Result<Vec<T>> {
        self.budget.business(1)?;
        all(&self.db, sql, args).await
    }
    pub async fn execute(&self, sql: &str, args: &[JsValue]) -> Result<u64> {
        self.budget.business(1)?;
        let r = self
            .db
            .prepare(sql)
            .bind(args)
            .map_err(|_| bad())?
            .run()
            .await
            .map_err(|_| bad())?;
        if !r.success() {
            return Err(bad());
        }
        Ok(r.meta()
            .map_err(|_| bad())?
            .and_then(|m| m.changes)
            .unwrap_or(0) as u64)
    }
    pub async fn task(&self, id: &str) -> Result<Task> {
        self.first(
            "SELECT * FROM maintenance_jobs WHERE job_id=?1 AND artifact_owner IS NULL",
            &[string(id)],
        )
        .await?
        .ok_or_else(bad)
    }
    pub async fn progress(
        &self,
        lease: &Lease,
        progress: &Value,
        state: State,
        progressed: bool,
        delay: u32,
    ) -> Result<()> {
        system_batch(&self.db,&self.budget,json!({"lease":lease,"progress":progress.to_string(),"state":state,"progressed":progressed,"delay":delay}),include_str!("../sql/progress_maintenance_job.sql")).await
    }
    pub async fn stage(&self, lease: &Lease, progress: &Value) -> Result<()> {
        self.budget.commit(1)?;
        let now = js_sys::Date::now() as u64;
        let r=self.db.prepare("UPDATE maintenance_jobs SET progress_json=?1,updated_at=?2 WHERE job_id=?3 AND state='leased' AND lease_token=?4 AND lease_expires_at>?2").bind(&[string(&progress.to_string()),JsValue::from_f64(now as f64),string(lease.id()),string(lease.token())]).map_err(|_|bad())?.run().await.map_err(|_|bad())?;
        if r.meta().map_err(|_| bad())?.and_then(|m| m.changes) != Some(1) {
            return Err(Error::new(409, "maintenance_lease_conflict"));
        }
        Ok(())
    }
    pub async fn begin(
        &self,
        lease: &Lease,
        locator: &Locator,
        proof: Option<&citizenserve::membership::cleanup::Eligibility>,
    ) -> Result<()> {
        locator.validate()?;
        system_batch(&self.db,&self.budget,json!({"lease":lease,"locator":locator,"locator_json":serde_json::to_string(locator).map_err(|_|bad())?,"proof":proof}),include_str!("../sql/begin_background_delete.sql")).await
    }
    pub async fn finish(
        &self,
        lease: &Lease,
        locator: &Locator,
        proof: Option<&citizenserve::membership::cleanup::Eligibility>,
    ) -> Result<()> {
        if !locator.ready_to_release() {
            return Err(bad());
        }
        system_batch(
            &self.db,
            &self.budget,
            json!({"lease":lease,"locator":locator,"proof":proof}),
            include_str!("../sql/finish_background_delete.sql"),
        )
        .await
    }
    pub async fn cache(&self, owner: &str) -> Result<BTreeMap<String, Value>> {
        #[derive(Deserialize)]
        struct Row {
            progress_json: String,
        }
        let rows:Vec<Row>=self.all("SELECT progress_json FROM maintenance_jobs WHERE artifact_owner=?1 ORDER BY artifact_seq LIMIT 513",&[string(owner)]).await?;
        if rows.len() > 512 {
            return Err(Error::new(503, "projection_cache_capacity"));
        }
        let mut map = BTreeMap::new();
        let mut size = 0;
        for row in rows {
            size += row.progress_json.len();
            if size > 16 * 1024 * 1024 {
                return Err(Error::new(503, "projection_cache_capacity"));
            }
            let chunk: BTreeMap<String, Value> =
                serde_json::from_str(&row.progress_json).map_err(|_| bad())?;
            for (k, v) in chunk {
                if map.get(&k).is_some_and(|x| x != &v) {
                    return Err(Error::new(503, "projection_cache_conflict"));
                }
                map.insert(k, v);
            }
        }
        Ok(map)
    }
    pub async fn append_cache(
        &self,
        lease: &Lease,
        work: citizenserve::server::maintenance::Work,
        slot: u64,
        delta: &BTreeMap<String, Value>,
    ) -> Result<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let mut chunks = Vec::new();
        let mut chunk = BTreeMap::new();
        let mut size = 0;
        for (k, v) in delta {
            let n = k.len() + v.to_string().len() + 8;
            if size + n > 48000 && !chunk.is_empty() {
                chunks.push(serde_json::to_string(&chunk).map_err(|_| bad())?);
                chunk.clear();
                size = 0;
            }
            chunk.insert(k, v);
            size += n;
        }
        if !chunk.is_empty() {
            chunks.push(serde_json::to_string(&chunk).map_err(|_| bad())?);
        }
        #[derive(Deserialize)]
        struct Seq {
            seq: u64,
        }
        self.budget.commit(1)?;
        let seq:Seq=first(&self.db,"SELECT COALESCE(MAX(artifact_seq),0) seq FROM maintenance_jobs WHERE artifact_owner=?1",&[string(lease.id())]).await?.ok_or_else(bad)?;
        let chunks:Vec<Value>=chunks.into_iter().enumerate().map(|(i,c)|{let n=seq.seq+i as u64+1;json!({"id":citizenserve::notifications::jobs::id(citizenserve::notifications::jobs::Kind::Maintenance,&[lease.id(),"immutable-state",&n.to_string()]),"seq":n,"data":c})}).collect();
        system_batch(
            &self.db,
            &self.budget,
            json!({"lease":lease,"work":work,"slot":slot,"chunks":chunks}),
            CACHE,
        )
        .await
    }
    pub async fn healthy(
        &self,
        lease: &Lease,
        kind: &str,
        genesis: &str,
        height: u64,
        now: u64,
    ) -> Result<()> {
        self.budget.commit(1)?;
        let query="INSERT INTO scheduler_leases(lease_key,last_slot,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM maintenance_jobs WHERE job_id=?4 AND state='leased' AND lease_token=?5 AND lease_expires_at>?3) ON CONFLICT(lease_key) DO UPDATE SET last_slot=excluded.last_slot,updated_at=excluded.updated_at WHERE scheduler_leases.last_slot<=excluded.last_slot AND scheduler_leases.updated_at<=excluded.updated_at";
        let result = self
            .db
            .prepare(query)
            .bind(&[
                string(&format!("sync:{kind}:{genesis}")),
                JsValue::from_f64(height as f64),
                JsValue::from_f64(now as f64),
                string(lease.id()),
                string(lease.token()),
            ])
            .map_err(|_| bad())?
            .run()
            .await
            .map_err(|_| bad())?;
        if result.meta().map_err(|_| bad())?.and_then(|m| m.changes) != Some(1) {
            return Err(bad());
        }
        Ok(())
    }
    pub async fn authentication(&self) -> Result<(u64, bool)> {
        let now = js_sys::Date::now() as u64;
        let mut changed = 0;
        let mut more = false;
        // 固定白名单，绝不以通用TTL扫描金融claim、准入、未知广播或业务资料。
        let sqls=[
   "DELETE FROM rate_windows WHERE rowid IN (SELECT rowid FROM rate_windows WHERE expires_at<=?1 LIMIT 1000)",
   "DELETE FROM scheduler_leases WHERE rowid IN (SELECT l.rowid FROM scheduler_leases l WHERE l.lease_key LIKE 'member-refresh:%' AND l.lease_expires_at<=?1 AND NOT EXISTS(SELECT 1 FROM users u JOIN user_identity_checks i USING(cid_number) JOIN square_memberships m USING(cid_number) WHERE l.lease_key='member-refresh:'||json_extract(i.row_json,'$.chain_scope')||':'||u.cid_number||':'||u.binding_revision||':'||m.paid_until) AND NOT EXISTS(SELECT 1 FROM users u JOIN user_identity_checks i USING(cid_number) JOIN square_creator_subscriptions m ON m.subscriber_cid_number=u.cid_number WHERE l.lease_key='member-refresh:'||json_extract(i.row_json,'$.chain_scope')||':'||u.cid_number||':'||u.binding_revision||':'||m.paid_until) LIMIT 1000)",
   "DELETE FROM mls_authentication_challenges WHERE rowid IN (SELECT rowid FROM mls_authentication_challenges WHERE expires_at_millis<=?1 LIMIT 1000)",
   "DELETE FROM square_sessions WHERE rowid IN (SELECT rowid FROM square_sessions WHERE expires_at<=?1 LIMIT 1000)",
   "DELETE FROM push_endpoints WHERE rowid IN (SELECT e.rowid FROM push_endpoints e WHERE e.expires_at<=?1 OR NOT EXISTS(SELECT 1 FROM users u JOIN mls_devices d ON d.cid_number=u.cid_number WHERE u.cid_number=e.cid_number AND u.account_id=e.account_id AND u.binding_revision=e.binding_revision AND u.cid_status='active' AND d.device_id=e.device_id AND d.account_id=e.account_id AND d.binding_revision=e.binding_revision AND d.active=1) LIMIT 1000)",
   "DELETE FROM registration_enrollments WHERE rowid IN (SELECT rowid FROM registration_enrollments WHERE state<>'activated' AND expires_at_millis<=?1 LIMIT 1000)",
   "DELETE FROM contact_mls_operations WHERE rowid IN (SELECT o.rowid FROM contact_mls_operations o WHERE o.committed_at IS NOT NULL AND o.committed_at<=?1-604800000 AND NOT EXISTS(SELECT 1 FROM contact_mls_messages m WHERE m.operation_id=o.operation_id) LIMIT 1000)",
   "DELETE FROM notification_jobs WHERE rowid IN (SELECT j.rowid FROM notification_jobs j WHERE j.state IN ('done','cancelled') AND j.updated_at<=?1-604800000 AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.job_id=j.job_id AND d.state IN ('pending','leased','blocked')) LIMIT 1000)",
   "DELETE FROM maintenance_jobs WHERE rowid IN (SELECT rowid FROM maintenance_jobs WHERE artifact_owner IS NULL AND state IN ('done','cancelled') AND updated_at<=?1-604800000 LIMIT 1000)",
  ];
        for sql in sqls {
            let count = self.execute(sql, &[JsValue::from_f64(now as f64)]).await?;
            changed += count;
            more |= count >= citizenserve::membership::limits::CLEANUP_ROWS;
        }
        use citizenserve::membership::limits as l;
        let oldest_day =
            (now / l::QUOTA_DAY_MILLIS * l::QUOTA_DAY_MILLIS).saturating_sub(l::HISTORY_DAY_OFFSET);
        for (sql, before) in [
            (
                HISTORY_OPERATIONS,
                JsValue::from_f64(now.saturating_sub(l::HISTORY_MILLIS) as f64),
            ),
            (HISTORY_USAGE, JsValue::from_f64(oldest_day as f64)),
            (
                HISTORY_BROWSE,
                string(&citizenserve::square::feed::utc_day(oldest_day)),
            ),
        ] {
            let count = self
                .execute(sql, &[before, JsValue::from_f64(l::CLEANUP_ROWS as f64)])
                .await?;
            changed += count;
            more |= count >= l::CLEANUP_ROWS;
        }
        Ok((changed, more))
    }
}
const CACHE: &str = r#"
-- statement
INSERT INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) SELECT NULL,'identity',0,0 WHERE NOT EXISTS(SELECT 1 FROM maintenance_jobs WHERE job_id=json_extract(?1,'$.lease.id') AND state='leased' AND lease_token=json_extract(?1,'$.lease.token') AND lease_expires_at>json_extract(?1,'$.now'));
-- statement
INSERT INTO maintenance_jobs(job_id,artifact_owner,artifact_seq,work_kind,scheduled_at,state,progress_json,updated_at) SELECT json_extract(value,'$.id'),json_extract(?1,'$.lease.id'),json_extract(value,'$.seq'),json_extract(?1,'$.work'),json_extract(?1,'$.slot'),'done',json_extract(value,'$.data'),json_extract(?1,'$.now') FROM json_each(?1,'$.chunks');
"#;

/// 原rate_windows中一次预扣本次有界动作；分钟/日同时成功才可发出RPC。
pub async fn reserve_rpc(
    db: &worker::D1Database,
    key: &str,
    amount: u32,
    minute: u32,
    day: u32,
    now: u64,
) -> citizenserve::shared::Result<()> {
    if amount == 0 || amount > minute || amount > day {
        return Err(citizenserve::shared::Error::new(
            429,
            "chain_rpc_budget_exceeded",
        ));
    }
    let mut statements = Vec::new();
    for (period, limit, span) in [("minute", minute, 60000u64), ("day", day, 86400000u64)] {
        let window = now / span;
        let key = format!("rpc:{key}:{period}:{window}");
        statements.push(
            db.prepare(RPC_RESERVE)
                .bind(&[
                    wasm_bindgen::JsValue::from_str(&key),
                    wasm_bindgen::JsValue::from_f64(amount as f64),
                    wasm_bindgen::JsValue::from_f64(((window + 1) * span) as f64),
                    wasm_bindgen::JsValue::from_f64(limit as f64),
                ])
                .map_err(|_| {
                    citizenserve::shared::Error::new(503, "chain_rpc_budget_unavailable")
                })?,
        );
        statements.push(db.prepare(RPC_ASSERT));
    }
    let results = db.batch(statements).await.map_err(|e| match e {
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: rate_windows.request_count") =>
        {
            citizenserve::shared::Error::new(429, "chain_rpc_budget_exceeded")
        }
        _ => citizenserve::shared::Error::new(503, "chain_rpc_budget_unavailable"),
    })?;
    if results.iter().any(|r| !r.success()) {
        return Err(citizenserve::shared::Error::new(
            503,
            "chain_rpc_budget_unavailable",
        ));
    }
    Ok(())
}

const RPC_RESERVE: &str = r#"INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT ?1,?2,?3 WHERE ?2<=?4 ON CONFLICT(rate_key) DO UPDATE SET request_count=rate_windows.request_count+excluded.request_count WHERE rate_windows.request_count<=?4-excluded.request_count"#;
const RPC_ASSERT: &str = r#"INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'rpc-budget-assert',NULL,0 WHERE changes()<>1"#;

// 只清普通访问和已结束UTC日，发布/财务及现行上传周期不属于历史白名单。
const HISTORY_OPERATIONS: &str = r#"DELETE FROM membership_operations WHERE rowid IN(SELECT rowid FROM membership_operations WHERE metric IN('browse','detail','profile','delivery_bytes') AND state='committed' AND created_at<=?1 ORDER BY metric,created_at LIMIT ?2)"#;
const HISTORY_USAGE: &str = r#"DELETE FROM membership_usage WHERE rowid IN(SELECT rowid FROM membership_usage WHERE metric IN('browse','detail','profile','delivery_bytes','chat_connections','chat_commands','chat_frame_bytes','chat_deliveries','attachment_begins','chat_chunk_operations','upload_bytes','media_requests','profile_requests','profile_read_bytes') AND period_start<?1 ORDER BY metric,period_start LIMIT ?2)"#;
const HISTORY_BROWSE: &str = r#"DELETE FROM square_browse_days WHERE rowid IN(SELECT rowid FROM square_browse_days WHERE browse_day<?1 ORDER BY browse_day LIMIT ?2)"#;

/// 后台附件回收独立日池，原系统租约领取后预扣整轮名额；不占RPC或用户额度。
pub(crate) async fn reserve_cleanup(db: &D1Database, budget: &Budget, now: u64) -> Result<()> {
    use citizenserve::membership::limits as l;
    budget.business(1)?;
    let day = now / l::QUOTA_DAY_MILLIS;
    let statement = db
        .prepare(CLEANUP_RESERVE)
        .bind(&[
            string(&format!("cleanup:day:{day}")),
            JsValue::from_f64(l::CLEANUP_RESERVE_IO as f64),
            JsValue::from_f64(((day + 1) * l::QUOTA_DAY_MILLIS) as f64),
            JsValue::from_f64(l::CLEANUP_IO_DAY as f64),
        ])
        .map_err(|_| bad())?;
    let results = db
        .batch(vec![statement, db.prepare(CLEANUP_ASSERT)])
        .await
        .map_err(|e| match e {
            worker::Error::D1(c)
                if c.cause()
                    .contains("NOT NULL constraint failed: rate_windows.request_count") =>
            {
                Error::new(429, "cleanup_budget_exceeded")
            }
            _ => bad(),
        })?;
    if results.iter().any(|r| !r.success()) {
        return Err(bad());
    }
    Ok(())
}
const CLEANUP_RESERVE: &str = r#"INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT ?1,?2,?3 WHERE ?2<=?4 ON CONFLICT(rate_key) DO UPDATE SET request_count=rate_windows.request_count+excluded.request_count WHERE rate_windows.request_count>=0 AND rate_windows.request_count<=?4-excluded.request_count"#;
const CLEANUP_ASSERT: &str = r#"INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'cleanup:assert',NULL,0 WHERE changes()<>1"#;
