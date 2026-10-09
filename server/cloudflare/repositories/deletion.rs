//! D1删除任务保留到真实云清理完成；金融claim和链事实从不进入清理白名单。
use super::{all, first, string, AUTH_ASSERT};
use citizenserve::{
    server::maintenance::Budget,
    square::storage::{Bucket, Storage},
};
use citizenserve::{
    shared::{Error, Result},
    user::{
        deletion::{Challenge, Purpose, Receipt, Repository, State},
        profile_service::Authorization,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{send::SendFuture, D1Database, Env};
fn bad() -> Error {
    Error::new(503, "account_deletion_storage_unavailable")
}
pub struct D1Deletion {
    pub db: D1Database,
}
impl D1Deletion {
    async fn transaction(
        &self,
        mut command: Value,
        sql: &str,
        auth: bool,
    ) -> Result<Vec<worker::D1Result>> {
        let now = js_sys::Date::now() as u64;
        command["now"] = json!(now);
        if auth {
            command["auth"]["now"] = json!(now);
        }
        let raw = string(&command.to_string());
        let mut statements = Vec::new();
        if auth {
            statements.push(
                self.db
                    .prepare(AUTH_ASSERT)
                    .bind(std::slice::from_ref(&raw))
                    .map_err(|_| bad())?,
            );
        }
        for part in sql.split("-- statement").skip(1) {
            statements.push(
                self.db
                    .prepare(part)
                    .bind(std::slice::from_ref(&raw))
                    .map_err(|_| bad())?,
            );
        }
        let rows = self
            .db
            .batch(statements)
            .await
            .map_err(|_| Error::new(409, "account_deletion_conflict"))?;
        if rows.iter().any(|r| !r.success()) {
            return Err(bad());
        }
        Ok(rows)
    }
    async fn receipt(&self, c: &Challenge) -> Result<Receipt> {
        let row:Option<Value>=first(&self.db,"SELECT deletion_id,state,account_id,binding_revision,chain_scope FROM account_deletions WHERE cid_number=?1",&[string(&c.cid_number)]).await?;
        let (deletion_id, state) = match row {
            None => (None, State::Absent),
            Some(v) => {
                if v["account_id"] != c.account_id
                    || v["binding_revision"] != c.binding_revision
                    || v["chain_scope"] != c.chain_scope
                {
                    return Err(Error::new(401, "cid_binding_changed"));
                }
                (
                    Some(v["deletion_id"].as_str().ok_or_else(bad)?.to_owned()),
                    match v["state"].as_str() {
                        Some("pending") => State::Pending,
                        Some("complete") => State::Complete,
                        _ => return Err(bad()),
                    },
                )
            }
        };
        Ok(Receipt {
            ok: true,
            cid_number: c.cid_number.clone(),
            account_id: c.account_id.clone(),
            binding_revision: c.binding_revision,
            deletion_id,
            state,
        })
    }
}
const CURRENT: &str = r#"
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM users u JOIN user_identity_checks i USING(cid_number)
 WHERE u.cid_number=json_extract(?1,'$.challenge.cid_number') AND u.account_id=json_extract(?1,'$.challenge.account_id') AND u.binding_revision=json_extract(?1,'$.challenge.binding_revision') AND u.cid_status='active'
 AND i.account_id=u.account_id AND i.binding_revision=u.binding_revision AND json_extract(i.row_json,'$.authoritative_current')=1 AND json_extract(i.row_json,'$.chain_scope')=json_extract(?1,'$.challenge.chain_scope') AND i.checked_at_millis<=json_extract(?1,'$.now') AND i.verification_deadline_millis>json_extract(?1,'$.now'));
"#;
impl Repository for D1Deletion {
    fn issue(
        &self,
        c: &Challenge,
        now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let sql = format!(
                "{CURRENT}{}",
                r#"
-- statement
DELETE FROM account_deletion_challenges WHERE rowid IN(SELECT rowid FROM account_deletion_challenges WHERE expires_at_millis<=json_extract(?1,'$.now') LIMIT 1000);
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE (SELECT COUNT(*) FROM account_deletion_challenges WHERE cid_number=json_extract(?1,'$.challenge.cid_number'))>=16;
-- statement
INSERT INTO account_deletion_challenges(challenge_id,cid_number,account_id,binding_revision,purpose,expires_at_millis,record_json) VALUES(json_extract(?1,'$.challenge.challenge_id'),json_extract(?1,'$.challenge.cid_number'),json_extract(?1,'$.challenge.account_id'),json_extract(?1,'$.challenge.binding_revision'),json_extract(?1,'$.challenge.purpose'),json_extract(?1,'$.challenge.expires_at_millis'),json_extract(?1,'$.challenge_json'));
"#
            );
            self.transaction(json!({"challenge":c,"challenge_json":serde_json::to_string(c).map_err(|_|bad())?,"now":now}),&sql,false).await?;
            Ok(())
        })
    }
    fn challenge(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Challenge>>> + Send {
        SendFuture::new(async move {
            let v: Option<Value> = first(
                &self.db,
                "SELECT record_json FROM account_deletion_challenges WHERE challenge_id=?1",
                &[string(id)],
            )
            .await?;
            v.map(|v| {
                serde_json::from_str(v["record_json"].as_str().ok_or_else(bad)?).map_err(|_| bad())
            })
            .transpose()
        })
    }
    fn begin(
        &self,
        auth: &Authorization,
        c: &Challenge,
    ) -> impl std::future::Future<Output = Result<Receipt>> + Send {
        SendFuture::new(async move {
            self.transaction(json!({"auth":auth,"challenge":c,"challenge_json":serde_json::to_string(c).map_err(|_|bad())?}),include_str!("../sql/account_deletion.sql"),true).await?;
            self.receipt(c).await
        })
    }
    fn status(
        &self,
        c: &Challenge,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Receipt>> + Send {
        SendFuture::new(async move {
            if c.purpose != Purpose::Status {
                return Err(Error::new(401, "account_deletion_challenge_invalid"));
            }
            let sql = format!(
                "{CURRENT}{}",
                r#"
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM account_deletion_challenges WHERE challenge_id=json_extract(?1,'$.challenge.challenge_id') AND purpose='status' AND record_json=json_extract(?1,'$.challenge_json') AND expires_at_millis>json_extract(?1,'$.now'));
-- statement
DELETE FROM account_deletion_challenges WHERE challenge_id=json_extract(?1,'$.challenge.challenge_id');
"#
            );
            self.transaction(
                json!({"challenge":c,"challenge_json":serde_json::to_string(c).map_err(|_|bad())?}),
                &sql,
                false,
            )
            .await?;
            self.receipt(c).await
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Job {
    deletion_id: String,
    cid_number: String,
    account_id: String,
    binding_revision: u64,
    chain_scope: String,
    enrollment_id: String,
    created_at: u64,
    phase: u32,
    rows_phase: usize,
    keys_json: String,
    public_after: String,
    list_cursor: String,
}
const LEASE: &str = r#"
-- statement
UPDATE account_deletions SET lease_token=json_extract(?1,'$.token'),lease_until=json_extract(?1,'$.now')+60000,updated_at=json_extract(?1,'$.now') WHERE deletion_id=json_extract(?1,'$.id') AND state='pending' AND lease_until<=json_extract(?1,'$.now');
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM account_deletions WHERE deletion_id=json_extract(?1,'$.id') AND lease_token=json_extract(?1,'$.token') AND lease_until>json_extract(?1,'$.now') AND state='pending');
"#;
const LOCK: &str = r#"
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM account_deletions WHERE deletion_id=json_extract(?1,'$.job.deletion_id') AND cid_number=json_extract(?1,'$.job.cid_number') AND lease_token=json_extract(?1,'$.token') AND (lease_until>json_extract(?1,'$.now') OR io_started=1) AND state='pending');
"#;

const ROWS: &[(&str, &str)] = &[
    ("contact_mls_messages", "cid_number"),
    ("contact_mls_operations", "cid_number"),
    ("contact_mls_packages", "cid_number"),
    ("contact_mls_groups", "cid_number"),
    ("notification_deliveries", "cid_number"),
    ("notification_jobs", "cid_number"),
    ("square_follows", "follower_cid_number"),
    ("square_follows", "followed_cid_number"),
    ("square_notify_reads", "cid_number"),
    ("square_browse_days", "cid_number"),
    ("square_posts", "cid_number"),
    ("square_media_assets", "cid_number"),
    ("square_uploads", "cid_number"),
    ("resource_reservations", "cid_number"),
    ("resource_usage", "cid_number"),
    ("resource_totals", "cid_number"),
    ("profile_asset_uploads", "cid_number"),
    ("user_profiles", "cid_number"),
    ("push_endpoints", "cid_number"),
    ("square_sessions", "cid_number"),
    ("mls_authentication_challenges", "cid_number"),
    ("mls_devices", "cid_number"),
];
impl D1Deletion {
    async fn save(&self, job: &Job, token: &str, complete: bool) -> Result<()> {
        // 先清资料与对象，最后同一事务移除准入/原激活凭据并提交完成回执。
        let finalize = if complete { FINALIZE } else { "" };
        let sql = format!(
            "{LOCK}{finalize}{}",
            r#"
-- statement
UPDATE account_deletions SET phase=json_extract(?1,'$.job.phase'),rows_phase=json_extract(?1,'$.job.rows_phase'),
 keys_json=json_extract(?1,'$.job.keys_json'),public_after=json_extract(?1,'$.job.public_after'),list_cursor=json_extract(?1,'$.job.list_cursor'),
 state=CASE WHEN json_extract(?1,'$.complete') THEN 'complete' ELSE 'pending' END,
 io_started=0,lease_token=NULL,lease_until=0,updated_at=json_extract(?1,'$.now') WHERE deletion_id=json_extract(?1,'$.job.deletion_id');
"#
        );
        self.transaction(
            json!({"job":job,"token":token,"complete":complete}),
            &sql,
            false,
        )
        .await?;
        Ok(())
    }
    async fn ack_objects(&self, job: &Job, token: &str) -> Result<()> {
        // 只有对象端口已明确成功才解除IO屏障；CDN失败仍保留键供安全重试。
        let sql = format!(
            "{LOCK}{}",
            r#"
-- statement
UPDATE account_deletions SET io_started=0,lease_until=json_extract(?1,'$.now')+60000 WHERE deletion_id=json_extract(?1,'$.job.deletion_id') AND lease_token=json_extract(?1,'$.token');
"#
        );
        self.transaction(json!({"job":job,"token":token}), &sql, false)
            .await?;
        Ok(())
    }
    async fn snapshot(&self, job: &Job, token: &str) -> Result<()> {
        let sql = format!(
            "{LOCK}{}",
            r#"
-- statement
UPDATE account_deletions SET io_started=1,keys_json=json_extract(?1,'$.job.keys_json') WHERE deletion_id=json_extract(?1,'$.job.deletion_id');
"#
        );
        self.transaction(json!({"job":job,"token":token}), &sql, false)
            .await?;
        Ok(())
    }
}
fn keys(job: &Job) -> Result<Vec<String>> {
    let keys: Vec<String> = serde_json::from_str(&job.keys_json).map_err(|_| bad())?;
    let prefix = if job.phase == 1 {
        format!("profile/{}/", job.cid_number)
    } else {
        format!("square/{}/", job.cid_number)
    };
    if keys.len() > 8
        || keys
            .iter()
            .any(|k| !k.starts_with(&prefix) || k.len() > 1024 || k.contains(".."))
    {
        return Err(bad());
    }
    Ok(keys)
}
/// 每次最多一个8对象批次或100行批次；持久任务不依赖Queue的有限重试次数。
/// 返回Some表示本轮已处理注销任务，None才继续普通存储维护。
pub(crate) async fn advance(env: &Env, budget: &Budget) -> Result<Option<bool>> {
    if budget.remaining() < 25 {
        return Ok(Some(false));
    }
    budget.business(1)?;
    let repo = D1Deletion {
        db: env.d1("DB").map_err(|_| bad())?,
    };
    let pending:Option<Job>=first(&repo.db,"SELECT * FROM account_deletions WHERE state='pending' AND io_started=0 AND lease_until<=?1 ORDER BY updated_at,deletion_id LIMIT 1",&[wasm_bindgen::JsValue::from_f64(js_sys::Date::now())]).await?;
    let Some(mut job) = pending else {
        return Ok(None);
    };
    budget.business(24)?;
    citizenserve::shared::ids::cid(&job.cid_number)?;
    let token = citizenserve::shared::crypto::hex(&crate::runtime::random::<32>()?);
    repo.transaction(json!({"id":job.deletion_id,"token":token}), LEASE, false)
        .await?;
    let objects = crate::media::R2Storage::configured(env)?;
    // 先补齐全部已分配公开对象键，包含尚未产生HEAD结果的直接上传。
    if job.phase == 2 && job.list_cursor.is_empty() && job.keys_json == "[]" {
        let rows:Vec<Value>=all(&repo.db,"SELECT object_key,derivative_object_key FROM square_media_assets WHERE cid_number=?1 AND object_key>?2 ORDER BY object_key LIMIT 4",&[string(&job.cid_number),string(&job.public_after)]).await?;
        if !rows.is_empty() {
            let mut batch = Vec::new();
            for row in &rows {
                for field in ["object_key", "derivative_object_key"] {
                    batch.push(row[field].as_str().ok_or_else(bad)?.to_owned());
                }
            }
            job.keys_json = serde_json::to_string(&batch).map_err(|_| bad())?;
            repo.snapshot(&job, &token).await?;
            let batch = keys(&job)?;
            objects.delete(Bucket::Public, &batch).await?;
            repo.ack_objects(&job, &token).await?;
            objects.purge(&batch).await?;
            job.public_after = rows.last().ok_or_else(bad)?["object_key"]
                .as_str()
                .ok_or_else(bad)?
                .into();
            job.keys_json = "[]".into();
            repo.save(&job, &token, false).await?;
            return Ok(Some(false));
        }
        // 已分配键均封堵后，扫描同一精确CID前缀中的遗漏对象。
        job.list_cursor = "START".into();
    }
    if job.phase == 2 && job.list_cursor == "END" && job.keys_json == "[]" {
        job.phase = 3;
    }
    if job.phase <= 2 {
        let public = job.phase == 2;
        let bucket = env
            .bucket(if public {
                "SQUARE_PUBLIC_MEDIA"
            } else {
                "SQUARE_PRIVATE"
            })
            .map_err(|_| bad())?;
        if job.keys_json != "[]" {
            repo.snapshot(&job, &token).await?;
            let batch = keys(&job)?;
            objects
                .delete(
                    if public {
                        Bucket::Public
                    } else {
                        Bucket::Private
                    },
                    &batch,
                )
                .await?;
            repo.ack_objects(&job, &token).await?;
            if public {
                objects.purge(&batch).await?;
            }
            job.keys_json = "[]".into();
            if public && job.list_cursor == "END" {
                job.phase = 3;
            }
            repo.save(&job, &token, false).await?;
            return Ok(Some(false));
        }
        let prefix = if job.phase == 1 {
            format!("profile/{}/", job.cid_number)
        } else {
            format!("square/{}/", job.cid_number)
        };
        let mut request = bucket.list().prefix(prefix).limit(8);
        if public && job.list_cursor != "START" {
            request = request.cursor(job.list_cursor.clone());
        }
        let listed = request.execute().await.map_err(|_| bad())?;
        let batch: Vec<String> = listed.objects().iter().map(|o| o.key()).collect();
        if public {
            job.list_cursor = if listed.truncated() {
                listed.cursor().ok_or_else(bad)?
            } else {
                "END".into()
            };
            if !listed.truncated() {
                job.phase = 3;
            }
        } else if batch.is_empty() {
            job.phase += 1;
        }
        if !batch.is_empty() {
            // 当前批次和下一页位置一起持久保存；失败不丢对象定位。
            // phase必须仍指向本批次的桶，页结束仅在成功清理后推进。
            let next_phase = job.phase;
            if public {
                job.phase = 2;
            }
            job.keys_json = serde_json::to_string(&batch).map_err(|_| bad())?;
            // snapshot同时保存页游标，避免中断后重新从头扫描永久空对象。
            let sql = format!(
                "{LOCK}{}",
                r#"
-- statement
UPDATE account_deletions SET io_started=1,keys_json=json_extract(?1,'$.job.keys_json'),list_cursor=json_extract(?1,'$.job.list_cursor') WHERE deletion_id=json_extract(?1,'$.job.deletion_id');
"#
            );
            repo.transaction(json!({"job":job,"token":token}), &sql, false)
                .await?;
            let batch = keys(&job)?;
            objects
                .delete(
                    if public {
                        Bucket::Public
                    } else {
                        Bucket::Private
                    },
                    &batch,
                )
                .await?;
            repo.ack_objects(&job, &token).await?;
            if public {
                objects.purge(&batch).await?;
                job.phase = next_phase;
            }
            job.keys_json = "[]".into();
        }
        repo.save(&job, &token, false).await?;
        return Ok(Some(false));
    }
    if job.phase == 3 {
        if crate::tatachat::lifecycle::advance(
            env,
            &job.cid_number,
            &job.deletion_id,
            job.created_at,
        )
        .await
        .map_err(crate::tatachat::business)?
        {
            job.phase = 4;
        }
        repo.save(&job, &token, false).await?;
        return Ok(Some(false));
    }
    if job.phase != 4 || job.rows_phase > ROWS.len() {
        return Err(bad());
    }
    if let Some((table, column)) = ROWS.get(job.rows_phase) {
        // 表名/列名只来自上面的固定白名单，绝不接收请求参数。
        let sql=format!("{LOCK}\n-- statement\nDELETE FROM {table} WHERE rowid IN(SELECT rowid FROM {table} WHERE {column}=json_extract(?1,'$.job.cid_number') LIMIT 100);");
        repo.transaction(json!({"job":job,"token":token}), &sql, false)
            .await?;
        let sql = format!("SELECT 1 AS pending FROM {table} WHERE {column}=?1 LIMIT 1");
        if first::<Value>(&repo.db, &sql, &[string(&job.cid_number)])
            .await?
            .is_none()
        {
            job.rows_phase += 1;
        }
        repo.save(&job, &token, false).await?;
        return Ok(Some(false));
    }
    // 所有白名单行清完才接受完成；永久链事实/金融claim从未进入白名单。
    repo.save(&job, &token, true).await?;
    Ok(Some(true))
}

const FINALIZE: &str = r#"
-- statement
DELETE FROM cid_admissions WHERE cid_number=json_extract(?1,'$.job.cid_number');
-- statement
DELETE FROM registration_enrollments WHERE enrollment_id=json_extract(?1,'$.job.enrollment_id') OR json_extract(row_json,'$.activation.cid_number')=json_extract(?1,'$.job.cid_number');
-- statement
DELETE FROM account_deletion_challenges WHERE cid_number=json_extract(?1,'$.job.cid_number');
"#;
