//! 私有维护入口：共享预算、整块投影、持久对象定位和逐批当前资格复核。
use crate::repositories::{
    identity::D1Identities,
    maintenance::D1Maintenance,
    membership::D1Membership,
    notification_jobs::{system_batch, D1Jobs},
    string,
};
use citizenserve::{
    chain::{
        finalized::{self, Anchor},
        identity,
        ports::Rpc,
        subscription,
    },
    membership::{
        cleanup::{Eligibility, Notice},
        ports::Repository,
    },
    notifications::{
        jobs::{Disposition, Kind, Lease, Message, State},
        ports::Jobs,
    },
    server::maintenance::{Budget, Work},
    shared::{Error, Result},
    square::{
        maintenance::Locator,
        storage::{Bucket, Storage},
    },
    user::{identity::Identity, ports::IdentityRepository},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, Env};
fn now() -> u64 {
    js_sys::Date::now() as u64
}
fn bad() -> Error {
    Error::new(503, "maintenance_unavailable")
}
/// 只缓存已指定完整块哈希的不可变storage结果；当前head/资格/网络错误永不缓存。
pub(crate) struct BudgetRpc {
    inner: crate::chain::Chain,
    budget: Budget,
    cap: Option<Anchor>,
    started: u64,
    cache: Arc<Mutex<BTreeMap<String, Value>>>,
    initial: BTreeMap<String, Value>,
}
impl BudgetRpc {
    pub fn configured(env: &Env, budget: Budget, cap: Option<Anchor>) -> Result<Self> {
        Ok(Self {
            inner: crate::chain::Chain::configured(env)?,
            budget,
            cap,
            started: now(),
            cache: Arc::default(),
            initial: BTreeMap::new(),
        })
    }
    fn restored(mut self, data: BTreeMap<String, Value>) -> Self {
        self.initial = data.clone();
        self.cache = Arc::new(Mutex::new(data));
        self
    }
    fn delta(&self) -> Result<BTreeMap<String, Value>> {
        Ok(self
            .cache
            .lock()
            .map_err(|_| bad())?
            .iter()
            .filter(|(k, _)| !self.initial.contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect())
    }
}
impl Rpc for BudgetRpc {
    fn call(
        &self,
        method: &str,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            if now().saturating_sub(self.started) >= 45000 {
                return Err(Error::new(503, "maintenance_budget_exhausted"));
            }
            if method == "chain_getFinalizedHead" {
                if let Some(cap) = &self.cap {
                    return Ok(json!(cap.hash));
                }
            }
            let immutable = method == "state_getStorage"
                && params.as_array().is_some_and(|p| {
                    p.len() == 2
                        && p[1].as_str().is_some_and(|h| {
                            h.len() == 66
                                && h.starts_with("0x")
                                && h[2..].bytes().all(|b| b.is_ascii_hexdigit())
                        })
                });
            let key = json!([method, params]).to_string();
            if immutable {
                if let Some(v) = self.cache.lock().map_err(|_| bad())?.get(&key) {
                    return Ok(v.clone());
                }
            }
            self.budget.business(1)?;
            let v = self.inner.call(method, params).await?;
            if immutable && (v.is_null() || v.as_str().is_some_and(|s| s.len() <= 4096)) {
                self.cache.lock().map_err(|_| bad())?.insert(key, v.clone());
            }
            Ok(v)
        })
    }
}
struct Identities {
    inner: D1Identities,
    budget: Budget,
}
impl IdentityRepository for Identities {
    fn by_account(
        &self,
        a: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.by_account(a).await
        })
    }
    fn by_cid(
        &self,
        c: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.by_cid(c).await
        })
    }
    fn claim_refresh(
        &self,
        c: &str,
        n: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.claim_refresh(c, n).await
        })
    }
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.cursor().await
        })
    }
    fn project(
        &self,
        i: &[Identity],
        c: Option<&Anchor>,
        p: Option<&Anchor>,
    ) -> impl std::future::Future<Output = Result<citizenserve::user::projection::Counts>> + Send
    {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.project(i, c, p).await
        })
    }
}
struct Membership {
    inner: D1Membership,
    budget: Budget,
}
impl Repository for Membership {
    fn cleanup_notice(
        &self,
        a: &citizenserve::user::profile_service::Authorization,
    ) -> impl std::future::Future<Output = Result<Option<Notice>>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.cleanup_notice(a).await
        })
    }
    fn usage(
        &self,
        a: &citizenserve::user::profile_service::Authorization,
        p: u64,
    ) -> impl std::future::Future<Output = Result<citizenserve::membership::ports::Usage>> + Send
    {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.usage(a, p).await
        })
    }
    fn project(
        &self,
        a: &citizenserve::user::profile_service::Authorization,
        p: &citizenserve::membership::projection::Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.project(a, p).await
        })
    }
    fn overview(
        &self,
        a: &citizenserve::user::profile_service::Authorization,
        c: &subscription::Current,
    ) -> impl std::future::Future<Output = Result<citizenserve::membership::creator::Overview>> + Send
    {
        SendFuture::new(async move {
            self.budget.business(2)?;
            self.inner.overview(a, c).await
        })
    }
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.cursor().await
        })
    }
    fn commit_block(
        &self,
        e: Option<&Anchor>,
        p: &citizenserve::membership::projection::Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            self.budget.business(1)?;
            self.inner.commit_block(e, p).await
        })
    }
}
#[derive(Serialize, Deserialize, Default)]
struct Progress {
    #[serde(default)]
    cursor: String,
    #[serde(default)]
    active_cid: Option<String>,
    #[serde(default)]
    locator: Option<Locator>,
    #[serde(default)]
    chain_scope: Option<String>,
    #[serde(default)]
    audit_bucket: u8,
    #[serde(default)]
    audit_cursor: Option<String>,
    #[serde(default)]
    examined: u64,
    #[serde(default)]
    findings: Vec<Value>,
    #[serde(default)]
    projection_cursor: Option<Anchor>,
    #[serde(default)]
    error: Option<String>,
}
async fn save(repo: &D1Maintenance, l: &Lease, p: &Progress) -> Result<()> {
    repo.stage(l, &serde_json::to_value(p).map_err(|_| bad())?)
        .await
}
/// 每轮最多一个对象批次；调用者有界重复，外部未知结果先保留deletion_started与定位。
async fn delete(
    env: &Env,
    repo: &D1Maintenance,
    l: &Lease,
    p: &mut Progress,
    proof: Option<&Eligibility>,
) -> Result<()> {
    let mut loc = p.locator.clone().ok_or_else(bad)?;
    loc.validate()?;
    l.valid(now(), 15000)?;
    if let Some(pr) = proof {
        pr.require_current(now())?;
    }
    let storage = crate::media::R2Storage::configured(env)?;
    if loc.reason == "profile_staging" {
        repo.budget.business(1)?;
        let object = storage.head(Bucket::Private, &loc.private_keys[0]).await?;
        if object
            .as_ref()
            .is_some_and(|o| Some(&o.etag) != loc.object_etag.as_ref())
        {
            return Err(Error::new(409, "profile_generation_changed"));
        }
    }
    loc.deletion_started = true;
    p.locator = Some(loc.clone());
    save(repo, l, p).await?;
    if !loc.private_done {
        if let Some(pr) = proof {
            pr.require_current(now())?;
        }
        repo.budget
            .business(u32::from(!loc.private_keys.is_empty()))?;
        storage.delete(Bucket::Private, &loc.private_keys).await?;
        loc.private_done = true;
        p.locator = Some(loc.clone());
        save(repo, l, p).await?;
    }
    if !loc.public_done {
        if let Some(pr) = proof {
            pr.require_current(now())?;
        }
        repo.budget
            .business(u32::from(!loc.public_keys.is_empty()))?;
        storage.delete(Bucket::Public, &loc.public_keys).await?;
        loc.public_done = true;
        p.locator = Some(loc.clone());
        save(repo, l, p).await?;
    }
    if !loc.purge_done {
        if let Some(pr) = proof {
            pr.require_current(now())?;
        }
        repo.budget
            .business(loc.public_keys.len().div_ceil(100) as u32)?;
        storage.purge(&loc.public_keys).await?;
        loc.purge_done = true;
        p.locator = Some(loc.clone());
        save(repo, l, p).await?;
    }
    repo.finish(l, &loc, proof).await?;
    p.locator = None;
    p.examined += 1;
    Ok(())
}
#[derive(Deserialize)]
struct Upload {
    upload_id: String,
    post_id: String,
    cid_number: String,
    status: String,
    byte_size: u64,
    video_seconds: u64,
}
async fn locate(
    repo: &D1Maintenance,
    u: Upload,
    reason: &str,
    lapse: Option<u64>,
) -> Result<Locator> {
    #[derive(Deserialize)]
    struct Asset {
        object_key: String,
        derivative_object_key: String,
    }
    let assets:Vec<Asset>=repo.all("SELECT object_key,derivative_object_key FROM square_media_assets WHERE upload_id=?1 ORDER BY media_index LIMIT 111",&[string(&u.upload_id)]).await?;
    if assets.len() > 110 {
        return Err(bad());
    }
    let object_count = 1 + assets.len() as u64 * 2;
    let loc = Locator {
        private_keys: vec![format!(
            "square/{}/posts/{}/manifest.json",
            u.cid_number, u.post_id
        )],
        public_keys: assets
            .into_iter()
            .flat_map(|a| [a.object_key, a.derivative_object_key])
            .collect(),
        cid_number: u.cid_number,
        upload_id: u.upload_id,
        post_id: u.post_id,
        byte_size: u.byte_size,
        object_count,
        video_seconds: u.video_seconds,
        reason: reason.into(),
        lapse_at: lapse,
        profile_generation: None,
        object_etag: None,
        prior_status: u.status,
        deletion_started: false,
        private_done: false,
        public_done: false,
        purge_done: false,
    };
    loc.validate()?;
    Ok(loc)
}
const UPLOAD_COLUMNS:&str="u.upload_id,u.post_id,u.cid_number,u.status,COALESCE(r.byte_size,u.estimated_bytes) byte_size,COALESCE(r.video_seconds,0) video_seconds";
async fn uploads(env: &Env, repo: &D1Maintenance, l: &Lease, p: &mut Progress) -> Result<bool> {
    if p.locator.is_some() {
        delete(env, repo, l, p, None).await?;
        return Ok(false);
    }
    system_batch(
        &repo.db,
        &repo.budget,
        json!({"lease":l}),
        include_str!("sql/release_expired_upload.sql"),
    )
    .await?;
    let sql=format!("SELECT {UPLOAD_COLUMNS} FROM square_uploads u LEFT JOIN resource_reservations r ON r.reservation_id=u.upload_id WHERE u.expires_at+120000<=?1 AND u.status IN ('prepared','completed','expired') AND NOT EXISTS(SELECT 1 FROM square_posts s WHERE s.post_id=u.post_id) AND (u.status='completed' OR EXISTS(SELECT 1 FROM square_media_assets a WHERE a.upload_id=u.upload_id AND a.asset_state IN ('uploading','ready','error'))) ORDER BY u.created_at,u.upload_id LIMIT 1");
    if let Some(u) = repo
        .first::<Upload>(&sql, &[JsValue::from_f64(now() as f64)])
        .await?
    {
        let loc = locate(repo, u, "expired_upload", None).await?;
        repo.begin(l, &loc, None).await?;
        p.locator = Some(loc);
        delete(env, repo, l, p, None).await?;
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct Profile {
        upload_id: String,
        cid_number: String,
        kind: String,
        object_key: String,
        byte_size: u64,
        sha256: String,
        generation: u64,
        state: String,
        object_etag: Option<String>,
    }
    let rows:Vec<Profile>=repo.all("SELECT p.* FROM profile_asset_uploads p WHERE expires_at+120000<=?1 AND state IN ('prepared','writing','completed') AND NOT EXISTS(SELECT 1 FROM profile_asset_uploads n WHERE n.cid_number=p.cid_number AND n.kind=p.kind AND n.generation>p.generation) ORDER BY created_at,upload_id LIMIT 4",&[JsValue::from_f64(now() as f64)]).await?;
    for row in rows {
        if row.state == "prepared" {
            repo.execute("UPDATE profile_asset_uploads SET state='superseded' WHERE upload_id=?1 AND state='prepared'",&[string(&row.upload_id)]).await?;
            p.examined += 1;
            continue;
        }
        let storage = crate::media::R2Storage::configured(env)?;
        repo.budget.business(1)?;
        let object = storage.head(Bucket::Private, &row.object_key).await?;
        if row.state == "writing" {
            if let Some(o) = object.as_ref().filter(|o| {
                o.sha256 == row.sha256
                    && o.byte_size == row.byte_size
                    && o.custom
                        .get("generation")
                        .is_some_and(|g| g == &row.generation.to_string())
            }) {
                repo.execute("UPDATE profile_asset_uploads SET state='completed',object_etag=?1,completed_at=?2 WHERE upload_id=?3 AND state='writing'",&[string(&o.etag),JsValue::from_f64(now() as f64),string(&row.upload_id)]).await?;
            } else {
                // HEAD缺失/旧ETag不能证明在途写入结束，保留writing与代际定位。
                return Err(Error::new(409, "profile_object_unresolved"));
            }
            p.examined += 1;
            return Ok(false);
        }
        let referenced:Option<Value>=repo.first("SELECT 1 ok FROM user_profiles WHERE cid_number=?1 AND CASE ?2 WHEN 'avatar' THEN avatar_content_hash ELSE banner_content_hash END=?3",&[string(&row.cid_number),string(&row.kind),string(&row.sha256)]).await?;
        if referenced.is_some() {
            continue;
        }
        if object
            .as_ref()
            .is_some_and(|o| Some(&o.etag) != row.object_etag.as_ref())
        {
            return Err(Error::new(409, "profile_generation_changed"));
        }
        let loc = Locator {
            cid_number: row.cid_number,
            upload_id: row.upload_id,
            post_id: String::new(),
            private_keys: vec![row.object_key],
            public_keys: vec![],
            byte_size: row.byte_size,
            object_count: 1,
            video_seconds: 0,
            reason: "profile_staging".into(),
            lapse_at: None,
            profile_generation: Some(row.generation),
            object_etag: row.object_etag,
            prior_status: row.state,
            deletion_started: false,
            private_done: false,
            public_done: false,
            purge_done: false,
        };
        repo.begin(l, &loc, None).await?;
        p.locator = Some(loc);
        delete(env, repo, l, p, None).await?;
        return Ok(false);
    }
    Ok(true)
}
async fn qualification(
    env: &Env,
    repo: &D1Maintenance,
    cid: &str,
) -> Result<(Option<Eligibility>, Option<Notice>)> {
    #[derive(Deserialize)]
    struct Owner {
        account_id: String,
        used: u64,
    }
    let Some(owner):Option<Owner>=repo.first("SELECT u.account_id,COALESCE(t.byte_size,0) used FROM users u LEFT JOIN resource_totals t ON t.cid_number=u.cid_number AND t.resource_key='square_storage' WHERE u.cid_number=?1 AND u.cid_status='active'",&[string(cid)]).await? else{return Ok((None,None));};
    let rpc = BudgetRpc::configured(env, repo.budget.clone(), None)?;
    let genesis = env
        .var("CHAIN_GENESIS_HASH")
        .map_err(|_| bad())?
        .to_string();
    let checked = now();
    let current = subscription::platform(&rpc, &genesis, cid, &owner.account_id, checked).await?;
    let m = identity::metadata(&rpc, &current.anchor).await?;
    let Some(i) = identity::by_cid(&rpc, &m, &current.anchor, cid, &genesis, checked).await? else {
        return Ok((None, None));
    };
    let notice:Option<Notice>=repo.first("SELECT storage_cleanup_lapse_at lapse_at,storage_cleanup_notified_at notified_at,storage_cleanup_notified_at+86400000 cleanup_after,100000000000 storage_limit_bytes FROM square_memberships WHERE cid_number=?1 AND storage_cleanup_lapse_at IS NOT NULL AND storage_cleanup_notified_at IS NOT NULL",&[string(cid)]).await?;
    let proof = Eligibility::verify(&i, &current, owner.used, notice.as_ref(), now())?;
    if proof.is_none() {
        repo.execute("UPDATE square_memberships SET storage_cleanup_lapse_at=NULL,storage_cleanup_notified_at=NULL WHERE cid_number=?1 AND account_id=?2",&[string(cid),string(&i.account_id)]).await?;
    }
    Ok((proof, notice))
}
async fn storage(env: &Env, repo: &D1Maintenance, l: &Lease, p: &mut Progress) -> Result<bool> {
    for _ in 0..3 {
        if repo.budget.remaining() < 25 {
            return Ok(false);
        }
        let cid = if let Some(loc) = &p.locator {
            loc.cid_number.clone()
        } else if let Some(cid) = &p.active_cid {
            cid.clone()
        } else {
            let row:Option<Value>=repo.first("SELECT m.cid_number FROM square_memberships m JOIN resource_totals t USING(cid_number) WHERE m.cid_number>?1 AND t.resource_key='square_storage' AND (t.byte_size>100000000000 OR m.storage_cleanup_lapse_at IS NOT NULL) ORDER BY m.cid_number LIMIT 1",&[string(&p.cursor)]).await?;
            let Some(row) = row else {
                return Ok(true);
            };
            row["cid_number"].as_str().ok_or_else(bad)?.to_string()
        };
        let (proof, notice) = qualification(env, repo, &cid).await?;
        if let Some(loc) = p.locator.as_ref() {
            if proof
                .as_ref()
                .zip(notice.as_ref())
                .is_none_or(|(pr, n)| loc.require_membership(pr, n, now()).is_err())
            {
                if loc.deletion_started {
                    p.error = Some("qualification_changed_after_cloud_delete".into());
                    return Err(Error::new(409, "cleanup_qualification_changed"));
                }
                repo.execute(
                    "UPDATE square_uploads SET status=?1 WHERE upload_id=?2 AND status='deleting'",
                    &[string(&loc.prior_status), string(&loc.upload_id)],
                )
                .await?;
                repo.execute("UPDATE square_posts SET post_state='published' WHERE post_id=?1 AND post_state='deleting'",&[string(&loc.post_id)]).await?;
                p.locator = None;
            } else {
                delete(env, repo, l, p, proof.as_ref()).await?;
                return Ok(false);
            }
        }
        if let Some(pr) = proof {
            if notice.is_none() {
                system_batch(&repo.db,&repo.budget,json!({"lease":l,"proof":pr,"job_id":citizenserve::notifications::jobs::id(Kind::Fanout,&["storage",&cid,&pr.lapse().to_string()])}),include_str!("sql/enqueue_notification.sql")).await?;
            } else if pr.may_delete(notice.as_ref().ok_or_else(bad)?, now())? {
                let sql=format!("SELECT {UPLOAD_COLUMNS} FROM square_uploads u JOIN square_posts s ON s.post_id=u.post_id LEFT JOIN resource_reservations r ON r.reservation_id=u.upload_id WHERE u.cid_number=?1 AND u.status IN ('published','completed') AND s.post_state='published' ORDER BY s.created_at,s.post_id LIMIT 1");
                if let Some(u) = repo.first::<Upload>(&sql, &[string(&cid)]).await? {
                    let loc = locate(repo, u, "expired_membership", Some(pr.lapse())).await?;
                    repo.begin(l, &loc, Some(&pr)).await?;
                    p.locator = Some(loc);
                    p.active_cid = Some(cid);
                    delete(env, repo, l, p, Some(&pr)).await?;
                    return Ok(false);
                }
            }
        }
        p.cursor = cid;
        p.active_cid = None;
        p.examined += 1;
        save(repo, l, p).await?;
    }
    Ok(false)
}
/// 审计只记录不能证明安全删除的对象。R2列表cursor和当天任务定位持久保存。
async fn audit(env: &Env, repo: &D1Maintenance, p: &mut Progress) -> Result<bool> {
    if p.audit_bucket >= 3 {
        return Ok(true);
    }
    if p.audit_bucket == 0 {
        // 先按D1权威定位分页检查缺失对象，再列R2检查无可证明引用的对象；只留诊断。
        let rows:Vec<Value>=repo.all("SELECT key,bucket FROM (SELECT object_key key,'public' bucket FROM square_media_assets UNION ALL SELECT derivative_object_key,'public' FROM square_media_assets UNION ALL SELECT 'square/'||cid_number||'/posts/'||post_id||'/manifest.json','private' FROM square_uploads WHERE status IN ('completed','published','deleting') UNION SELECT object_key,'private' FROM profile_asset_uploads WHERE state='completed') WHERE key>?1 ORDER BY key LIMIT 4",&[string(&p.cursor)]).await?;
        for row in &rows {
            let key = row["key"].as_str().ok_or_else(bad)?;
            let bucket = env
                .bucket(if row["bucket"] == "private" {
                    "SQUARE_PRIVATE"
                } else {
                    "SQUARE_PUBLIC_MEDIA"
                })
                .map_err(|_| bad())?;
            repo.budget.business(1)?;
            if bucket.head(key).await.map_err(|_| bad())?.is_none() {
                p.findings.push(
                    json!({"kind":"missing_referenced_object","key":key,"action":"diagnosed"}),
                );
            }
            p.cursor = key.into();
            p.examined += 1;
        }
        if rows.len() < 4 {
            p.audit_bucket = 1;
            p.cursor.clear();
        }
    } else {
        let bucket = env
            .bucket(if p.audit_bucket == 1 {
                "SQUARE_PRIVATE"
            } else {
                "SQUARE_PUBLIC_MEDIA"
            })
            .map_err(|_| bad())?;
        repo.budget.business(1)?;
        let mut list = bucket.list().limit(20);
        if let Some(c) = &p.audit_cursor {
            list = list.cursor(c.clone());
        }
        let page = list.execute().await.map_err(|_| bad())?;
        for object in page.objects() {
            let key = object.key();
            if !key.starts_with("square/") && !key.starts_with("profile/") {
                continue;
            }
            let known:Option<Value>=repo.first("SELECT 1 ok WHERE EXISTS(SELECT 1 FROM square_media_assets WHERE object_key=?1 OR derivative_object_key=?1) OR EXISTS(SELECT 1 FROM square_uploads WHERE 'square/'||cid_number||'/posts/'||post_id||'/manifest.json'=?1 AND status<>'deleted') OR EXISTS(SELECT 1 FROM profile_asset_uploads WHERE object_key=?1 AND state IN ('writing','completed'))",&[string(&key)]).await?;
            p.examined += 1;
            if known.is_none() {
                p.findings
                    .push(json!({"kind":"unproven_object","key":key,"action":"retained"}));
            }
        }
        p.audit_cursor = page.cursor();
        if !page.truncated() {
            p.audit_bucket += 1;
            p.audit_cursor = None;
        }
    }
    if p.findings.len() > 64 {
        p.findings.drain(..p.findings.len() - 64);
    }
    Ok(p.audit_bucket >= 3)
}
pub async fn consume(env: &Env, m: &Message, budget: Budget, nonce: &str) -> Result<Disposition> {
    let jobs = D1Jobs::configured(env, budget.clone())?;
    let Some(lease) = jobs.claim(m, nonce, now()).await? else {
        return jobs.disposition(m, now()).await;
    };
    let repo = D1Maintenance {
        db: env.d1("DB").map_err(|_| bad())?,
        budget: budget.clone(),
    };
    let task = repo.task(&m.id).await?;
    let mut p: Progress = serde_json::from_str(&task.progress_json).map_err(|_| bad())?;
    let before = serde_json::to_value(&p).map_err(|_| bad())?;
    let result: Result<bool> = async {
        match task.work_kind {
            Work::Authentication => {
                repo.authentication().await?;
                Ok(true)
            }
            Work::Uploads => uploads(env, &repo, &lease, &mut p).await,
            Work::Storage => {
                if crate::repositories::deletion::advance(env, &budget)
                    .await?
                    .is_some()
                {
                    // 当前slot只执行一个有界注销批次；下一slot从独立持久任务继续。
                    Ok(true)
                } else {
                    storage(env, &repo, &lease, &mut p).await
                }
            }
            Work::Audit => audit(env, &repo, &mut p).await,
            Work::Identity | Work::Membership => {
                let genesis = env
                    .var("CHAIN_GENESIS_HASH")
                    .map_err(|_| bad())?
                    .to_string();
                if p.chain_scope.as_ref().is_some_and(|g| g != &genesis) {
                    return Err(Error::new(409, "projection_scope_changed"));
                }
                p.chain_scope = Some(genesis.clone());
                let ids = Identities {
                    inner: D1Identities {
                        db: env.d1("DB").map_err(|_| bad())?,
                    },
                    budget: budget.clone(),
                };
                let cache = repo.cache(&m.id).await?;
                let mut rpc = BudgetRpc::configured(env, budget.clone(), None)?.restored(cache);
                let projection = if task.work_kind == Work::Identity {
                    citizenserve::user::projection::catch_up(&rpc, &ids, &genesis, now()).await
                } else {
                    let cap = ids.cursor().await?.ok_or_else(bad)?;
                    let head = finalized::head(&rpc, &genesis).await?;
                    let verified = finalized::canonical(&rpc, &cap.hash, &head).await?;
                    if verified.number != cap.number {
                        return Err(bad());
                    }
                    rpc.cap = Some(verified);
                    let members = Membership {
                        inner: D1Membership {
                            db: env.d1("DB").map_err(|_| bad())?,
                        },
                        budget: budget.clone(),
                    };
                    citizenserve::membership::projection::catch_up(
                        &rpc,
                        &members,
                        &genesis,
                        now(),
                        10,
                    )
                    .await
                    .map(|_| ())
                };
                let delta = rpc.delta()?;
                repo.append_cache(&lease, task.work_kind, task.scheduled_at, &delta)
                    .await?;
                p.examined += delta.len() as u64;
                // 读取已提交游标在保留的提交预算内完成，避免耗尽业务预算后丢掉已完成整块事实。
                budget.commit(1)?;
                p.projection_cursor = if task.work_kind == Work::Identity {
                    D1Identities {
                        db: env.d1("DB").map_err(|_| bad())?,
                    }
                    .cursor()
                    .await?
                } else {
                    D1Membership {
                        db: env.d1("DB").map_err(|_| bad())?,
                    }
                    .cursor()
                    .await?
                };
                match projection {
                    Ok(()) => Ok(true),
                    Err(e) if e.code == "maintenance_budget_exhausted" => Ok(false),
                    Err(e) => Err(e),
                }
            }
        }
    }
    .await;
    let mut value = serde_json::to_value(&p).map_err(|_| bad())?;
    let progressed = before != value;
    let (state, delay) = match result {
        Ok(true) => (State::Done, 1),
        Ok(false) => (State::Pending, 1),
        Err(e) => {
            value["error"] = json!(e.code);
            (
                if lease.attempts() >= 4
                    || p.error.as_deref() == Some("qualification_changed_after_cloud_delete")
                {
                    State::Blocked
                } else {
                    State::Pending
                },
                60,
            )
        }
    };
    repo.progress(&lease, &value, state, progressed, delay)
        .await?;
    Ok(if state.terminal() {
        Disposition::Ack
    } else {
        Disposition::Retry(delay)
    })
}
