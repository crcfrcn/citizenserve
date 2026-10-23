//! 公民宿主许可HTTP与中性再核验装配；Cloudflare聊天数据面归所属tatachat适配模块。
use citizenserve::{
    membership::chat::Permissions,

        gate::{self, identity::Authority},
        tatachat::access,
    shared::{Error, Result},
    user::{
        auth::session, chat_access::Subject, ports::AuthRepository, registration::protocol::Config,
    },
};
use serde_json::{json, Value};
use worker::Env;

mod attachment;
pub(crate) mod config;
mod key;
pub(crate) mod lifecycle;
mod mailbox;
pub(crate) mod maintenance;
mod push;
pub(crate) mod realtime;
pub(crate) mod routes;

pub(crate) fn host(env: &Env) -> citizenserve::tatachat::Result<Host> {
    Host::new(env.clone(), crate::config(env).map_err(host_error)?).map_err(host_error)
}
pub(crate) fn business(error: citizenserve::tatachat::Error) -> Error {
    use citizenserve::tatachat::Error as E;
    Error::new(
        match error {
            E::InvalidRequest => 400,
            E::Forbidden => 403,
            E::NotFound => 404,
            E::Conflict => 409,
            E::ResourceLimit => 413,
            E::StorageUnavailable => 503,
        },
        error.code(),
    )
}
/// 同一聊天数据库的端口装配；SQL断言与业务写入必须在同一batch。
#[derive(Clone)]
pub(crate) struct D1Store {
    db: std::rc::Rc<worker::D1Database>,
    attachment_resources: Option<citizenserve::membership::limits::ResourceLimits>,
    env: Env,
    cleanup: Option<(citizenserve::maintenance::Budget, u64)>,
    cleanup_commit: bool,
}
impl D1Store {
    const CLOCK:&'static str="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
    pub(crate) fn new(env: &Env) -> citizenserve::tatachat::Result<Self> {
        Ok(Self {
            attachment_resources: None,
            env: env.clone(),
            cleanup: None,
            cleanup_commit: false,
            db: std::rc::Rc::new(
                env.d1("TATACHAT_DB")
                    .map_err(|_| citizenserve::tatachat::Error::StorageUnavailable)?,
            ),
        })
    }
    /// 此值只是资源上限，不授予身份/会员权限；附件仍须通过原Access和主库事务围栏。
    pub(crate) fn with_attachment_resources(
        mut self,
        limits: Option<citizenserve::membership::limits::ResourceLimits>,
    ) -> Self {
        self.attachment_resources = limits;
        self
    }
    /// 维护和注销共用原Budget，克隆不能重置额度；期限只限制本轮新I/O。
    pub(crate) fn with_cleanup(
        mut self,
        budget: citizenserve::maintenance::Budget,
        deadline: u64,
    ) -> Self {
        self.cleanup = Some((budget, deadline));
        self
    }
    pub(crate) fn for_cleanup_commit(&self) -> Self {
        let mut store = self.clone();
        store.cleanup_commit = true;
        store
    }
    pub(crate) fn cleanup_remaining(&self) -> u32 {
        match &self.cleanup {
            Some((budget, deadline)) if config::now() < *deadline => budget.remaining(),
            Some(_) => 0,
            None => u32::MAX,
        }
    }
    pub(crate) fn spend_cleanup(&self) -> citizenserve::tatachat::Result<()> {
        if let Some((budget, deadline)) = &self.cleanup {
            if config::now() >= *deadline {
                return Err(citizenserve::tatachat::Error::ResourceLimit);
            }
            let result = if self.cleanup_commit {
                budget.commit(1)
            } else {
                budget.business(1)
            };
            result.map_err(|_| citizenserve::tatachat::Error::ResourceLimit)?;
        }
        Ok(())
    }
    fn values(args: Vec<Value>) -> citizenserve::tatachat::Result<Vec<wasm_bindgen::JsValue>> {
        use wasm_bindgen::JsValue;
        args.into_iter()
            .map(|v| match v {
                Value::Null => Ok(JsValue::NULL),
                Value::String(s) => Ok(JsValue::from_str(&s)),
                Value::Number(n) => n
                    .as_f64()
                    .filter(|v| {
                        v.is_finite() && v.abs() <= citizenserve::shared::MAX_SAFE_INTEGER as f64
                    })
                    .map(JsValue::from_f64)
                    .ok_or(citizenserve::tatachat::Error::ResourceLimit),
                Value::Bool(b) => Ok(JsValue::from_f64(f64::from(u8::from(b)))),
                _ => Err(citizenserve::tatachat::Error::InvalidRequest),
            })
            .collect()
    }
    fn storage(error: worker::Error) -> citizenserve::tatachat::Error {
        use citizenserve::tatachat::Error as E;
        match error {
            worker::Error::D1(e)
                if e.cause()
                    .contains("NOT NULL constraint failed: attachment_chunks.attachment_id") =>
            {
                E::ResourceLimit
            }
            worker::Error::D1(e)
                if e.cause().contains("constraint failed")
                    || e.cause().contains("chat_conflict") =>
            {
                E::Conflict
            }
            _ => E::StorageUnavailable,
        }
    }
    pub(crate) fn record<T: serde::de::DeserializeOwned>(
        row: &Value,
    ) -> citizenserve::tatachat::Result<T> {
        serde_json::from_str(
            row["record"]
                .as_str()
                .ok_or(citizenserve::tatachat::Error::StorageUnavailable)?,
        )
        .map_err(|_| citizenserve::tatachat::Error::StorageUnavailable)
    }
    pub(crate) async fn rows(
        &self,
        sql: &str,
        args: Vec<Value>,
    ) -> citizenserve::tatachat::Result<Vec<Value>> {
        let rows = self.transaction(vec![(sql, args)]).await?;
        rows.into_iter()
            .last()
            .ok_or(citizenserve::tatachat::Error::StorageUnavailable)
    }
    /// 所有调用共用一次验证/执行，维护从真实meta取删行数，不额外SELECT或返回千行占位。
    async fn batch_results(
        &self,
        commands: Vec<(&str, Vec<Value>)>,
    ) -> citizenserve::tatachat::Result<Vec<worker::D1Result>> {
        if commands.is_empty() || commands.len() > 40 {
            return Err(citizenserve::tatachat::Error::ResourceLimit);
        }
        let frozen="INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM tatachat_module WHERE version=1 AND product='citizenserve' AND frozen=0) THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING";
        let mut statements = vec![self.db.prepare(frozen)];
        for (sql, args) in commands {
            if args.len() > 100
                || sql.len() > 100000
                || args
                    .iter()
                    .any(|v| v.as_str().is_some_and(|s| s.len() > 1_900_000))
            {
                return Err(citizenserve::tatachat::Error::ResourceLimit);
            }
            statements.push(
                self.db
                    .prepare(sql)
                    .bind(&Self::values(args)?)
                    .map_err(Self::storage)?,
            );
        }
        self.spend_cleanup()?;
        let results = self.db.batch(statements).await.map_err(Self::storage)?;
        if results.iter().any(|r| !r.success()) {
            return Err(citizenserve::tatachat::Error::StorageUnavailable);
        }
        Ok(results.into_iter().skip(1).collect())
    }
    pub(crate) async fn transaction(
        &self,
        commands: Vec<(&str, Vec<Value>)>,
    ) -> citizenserve::tatachat::Result<Vec<Vec<Value>>> {
        self.batch_results(commands)
            .await?
            .into_iter()
            .map(|r| r.results().map_err(Self::storage))
            .collect()
    }
    pub(crate) async fn changes(
        &self,
        commands: Vec<(&str, Vec<Value>)>,
    ) -> citizenserve::tatachat::Result<Vec<u64>> {
        self.batch_results(commands)
            .await?
            .into_iter()
            .map(|r| {
                r.meta()
                    .map_err(Self::storage)?
                    .and_then(|m| m.changes)
                    .map(|v| v as u64)
                    .ok_or(citizenserve::tatachat::Error::StorageUnavailable)
            })
            .collect()
    }
    pub(crate) async fn write(
        &self,
        access: &citizenserve::tatachat::auth::Access,
        commands: Vec<(&str, Vec<Value>)>,
    ) -> citizenserve::tatachat::Result<Vec<Vec<Value>>> {
        access.ensure_current(config::now())?;
        let guard=format!("INSERT INTO tatachat_assert VALUES(CASE WHEN ?1>{} AND NOT EXISTS(SELECT 1 FROM account_deletion_fences WHERE user_id=?2) THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING",Self::CLOCK);
        let mut all = vec![(
            guard.as_str(),
            vec![json!(access.deadline()), json!(access.actor().user_id)],
        )];
        all.extend(commands);
        all.push((
            guard.as_str(),
            vec![json!(access.deadline()), json!(access.actor().user_id)],
        ));
        let mut rows = self.transaction(all).await?;
        rows.pop();
        rows.remove(0);
        Ok(rows)
    }
}

/// 同进程可信状态源。没有对应公网查询入口；通用模块仍须比对原凭证的主体和修订。
pub struct Host {
    env: Env,
    config: Config,
    cached: std::cell::RefCell<Option<(String, u64, citizenserve::user::ports::AuthContext)>>,
}
impl Host {
    pub fn new(env: Env, config: Config) -> Result<Self> {
        config.validate()?;
        Ok(Self {
            env,
            config,
            cached: std::cell::RefCell::new(None),
        })
    }
    async fn facts(&self, session_hash: &str) -> Result<(Subject, Authority, u64)> {
        if !citizenserve::shared::ids::hex(session_hash, 32, false) {
            return Err(Error::new(401, "invalid_session"));
        }
        let now = js_sys::Date::now() as u64;
        let cached = self.cached.borrow().clone();
        let context = if let Some((hash, checked, c)) = cached.filter(|(h, t, _)| {
            h == session_hash && now >= *t && now - *t < gate::policy::SERVICE_AUTH_MILLIS
        }) {
            let _ = (hash, checked);
            c
        } else {
            let auth = super::repositories::auth::D1Auth {
                db: self
                    .env
                    .d1("DB")
                    .map_err(|_| Error::new(503, "chat_access_unavailable"))?,
            };
            let context = auth
                .context(
                    citizenserve::user::ports::ContextKey::Session(session_hash),
                    &self.config,
                )
                .await?
                .ok_or(Error::new(401, "invalid_session"))?;
            *self.cached.borrow_mut() = Some((session_hash.into(), now, context.clone()));
            context
        };
        // I/O后重取时钟；读取前的时间可能早于仓库loaded_at，不能据此误拒合法请求。
        let now = js_sys::Date::now() as u64;
        // 聊天宿主只消费同次服务端上下文，缺失或过期不构造Chain或安排补查。
        let authority = gate::identity::service_authority(&context, &self.config, now)?;
        let d = context
            .device
            .as_ref()
            .ok_or(Error::new(401, "device_not_registered"))?;
        let s = context
            .session
            .as_ref()
            .ok_or(Error::new(401, "invalid_session"))?;
        let subject = Subject::verified(&authority, d, s, &self.config, now)?;
        Ok((subject, authority, d.issued_at))
    }
    async fn require(
        &self,
        subject: &Subject,
        authorization: &access::Authorization,
        issued_at: u64,
    ) -> Result<()> {
        let repo = super::repositories::chat_access::D1ChatAccess {
            db: self
                .env
                .d1("DB")
                .map_err(|_| Error::new(503, "chat_access_unavailable"))?,
        };
        repo.require(&self.config, subject, authorization, issued_at)
            .await
    }
    /// 当前事实生成目标唤醒许可，供通用聊天Host端口使用；不延长原WSS凭证。
    pub async fn current_session(&self, session_hash: &str) -> Result<access::Authorization> {
        let (subject, _authority, _issued_at) = self.facts(session_hash).await?;
        let permission = access::authorize(&subject, js_sys::Date::now() as u64)?;
        Ok(permission)
    }
    fn attachment_resources(&self) -> Option<citizenserve::membership::limits::ResourceLimits> {
        self.cached
            .borrow()
            .as_ref()?
            .2
            .membership
            .as_ref()?
            .level(js_sys::Date::now() as u64)
            .ok()
            .map(citizenserve::membership::limits::resources)
    }
}
fn snapshot(permission: &access::Authorization) -> citizenserve::tatachat::auth::HostAccess {
    use citizenserve::tatachat::auth::{Device, HostAccess};
    HostAccess {
        actor: Device {
            user_id: permission.user_id().into(),
            device_id: permission.device_id().into(),
        },
        chat_enabled: permission.chat_enabled(),
        attachments: citizenserve::tatachat::auth::AttachmentPermission::Disabled,
        authorization_revision: permission.revision().into(),
        session_id_digest: permission.session_hash().into(),
        issued_at_millis: permission.issued_at(),
        expires_at_millis: permission.expires_at(),
        recheck_at_millis: permission.recheck_at(),
    }
}
fn host_error(error: Error) -> citizenserve::tatachat::Error {
    match error.status {
        401 | 403 => citizenserve::tatachat::Error::Forbidden,
        413 | 429 => citizenserve::tatachat::Error::ResourceLimit,
        _ => citizenserve::tatachat::Error::StorageUnavailable,
    }
}
/// 可信当前事实映射到通用端口；公民CID与会员计算仍留在宿主。
impl citizenserve::tatachat::auth::ports::Host for Host {
    fn now_millis(&self) -> u64 {
        js_sys::Date::now() as u64
    }
    async fn consume(
        &self,
        previous: &citizenserve::tatachat::auth::HostAccess,
        cost: citizenserve::tatachat::auth::ports::ResourceCost,
    ) -> citizenserve::tatachat::Result<()> {
        use citizenserve::tatachat::auth::ports::ResourceCost;
        let (subject, authority, _) = self
            .facts(&previous.session_id_digest)
            .await
            .map_err(host_error)?;
        let current = snapshot(
            &access::authorize(&subject, js_sys::Date::now() as u64).map_err(host_error)?,
        );
        if current.actor != previous.actor
            || current.authorization_revision != previous.authorization_revision
            || current.session_id_digest != previous.session_id_digest
        {
            return Err(citizenserve::tatachat::Error::Forbidden);
        }
        // HTTP/升级在原authorize处只计一次CID；持久连接中的命令在这里独立计频率。
        if let ResourceCost::Command { read_only, .. } = cost {
            crate::subject_rate(
                &self.env,
                if read_only { "RATE_READ" } else { "RATE_WRITE" },
                subject.user_id(),
            )
            .await
            .map_err(host_error)?;
        }
        let member = matches!(
            cost,
            ResourceCost::Command {
                begin_attachment: true,
                ..
            } | ResourceCost::AttachmentUpload { .. }
                | ResourceCost::AttachmentDownload { .. }
                | ResourceCost::AttachmentRecovery
        ) || matches!(cost, ResourceCost::Command { .. })
            && matches!(
                previous.attachments,
                citizenserve::tatachat::auth::AttachmentPermission::Allowed { .. }
            );
        let permit = if member {
            let context = self
                .cached
                .borrow()
                .as_ref()
                .map(|(_, _, c)| c.clone())
                .ok_or(citizenserve::tatachat::Error::Forbidden)?;
            Some(
                citizenserve::membership::gate::authorize(
                    &authority,
                    citizenserve::membership::policy::Operation::Attachment,
                    context.membership.as_ref(),
                    js_sys::Date::now() as u64,
                )
                .map_err(host_error)?,
            )
        } else {
            None
        };
        let db = self
            .env
            .d1("DB")
            .map_err(|_| citizenserve::tatachat::Error::StorageUnavailable)?;
        crate::repositories::membership::reserve_chat_resources(
            &db,
            &subject,
            &authority,
            &self.config,
            previous.expires_at_millis,
            permit.as_ref(),
            cost,
        )
        .await
        .map_err(host_error)
    }
    async fn recheck(
        &self,
        previous: &citizenserve::tatachat::auth::HostAccess,
    ) -> citizenserve::tatachat::Result<citizenserve::tatachat::auth::HostAccess> {
        use citizenserve::tatachat::Error;
        let now = self.now_millis();
        if now < previous.issued_at_millis || now >= previous.expires_at_millis {
            return Err(Error::Forbidden);
        }
        let permission = self
            .current_session(&previous.session_id_digest)
            .await
            .map_err(host_error)?;
        let mut current = snapshot(&permission);
        if current.actor != previous.actor
            || current.authorization_revision != previous.authorization_revision
            || current.session_id_digest != previous.session_id_digest
            || current.attachments != previous.attachments
        {
            return Err(Error::Forbidden);
        }
        current.expires_at_millis = current.expires_at_millis.min(previous.expires_at_millis);
        current.recheck_at_millis = current.recheck_at_millis.min(current.expires_at_millis);
        // 通用Access再核验提交时再次读取时钟，并保留独立的原credential_deadline。
        if self.now_millis() >= current.recheck_at_millis {
            return Err(Error::Forbidden);
        }
        Ok(current)
    }
    async fn attachment_limit(
        &self,
        previous: &citizenserve::tatachat::auth::HostAccess,
    ) -> citizenserve::tatachat::Result<citizenserve::tatachat::auth::AttachmentGrant> {
        let (subject, authority, _issued_at) = self
            .facts(&previous.session_id_digest)
            .await
            .map_err(host_error)?;
        if subject.user_id() != previous.actor.user_id
            || subject.device_id() != previous.actor.device_id
        {
            return Err(citizenserve::tatachat::Error::Forbidden);
        }
        let context = self
            .cached
            .borrow()
            .as_ref()
            .map(|(_, _, c)| c.clone())
            .ok_or(citizenserve::tatachat::Error::Forbidden)?;
        let permit = citizenserve::membership::gate::authorize(
            &authority,
            citizenserve::membership::policy::Operation::Attachment,
            context.membership.as_ref(),
            js_sys::Date::now() as u64,
        )
        .map_err(host_error)?;
        let permissions =
            Permissions::from_permit(&permit, subject.identity(), js_sys::Date::now() as u64)
                .map_err(host_error)?;
        let basic =
            access::authorize(&subject, js_sys::Date::now() as u64).map_err(host_error)?;
        if basic.revision() != previous.authorization_revision {
            return Err(citizenserve::tatachat::Error::Forbidden);
        }
        permissions
            .require_current(js_sys::Date::now() as u64)
            .map_err(host_error)?;
        Ok(citizenserve::tatachat::auth::AttachmentGrant {
            max_bytes: permissions.max_attachment_bytes(),
            deadline_millis: permissions.deadline(),
        })
    }
    async fn authorize_wake(
        &self,
        registered: &citizenserve::tatachat::auth::HostAccess,
    ) -> citizenserve::tatachat::Result<citizenserve::tatachat::auth::HostAccess> {
        use citizenserve::tatachat::Error;
        let permission = self
            .current_session(&registered.session_id_digest)
            .await
            .map_err(host_error)?;
        let current = snapshot(&permission);
        if current.actor != registered.actor
            || current.session_id_digest != registered.session_id_digest
        {
            return Err(Error::Forbidden);
        }
        Ok(current)
    }
}

pub async fn access(
    env: &Env,
    config: &Config,
    authority: &Authority,
    context: &citizenserve::user::ports::AuthContext,
    token: &str,
    body: &[u8],
) -> Result<Value> {
    citizenserve::tatachat::routes::access_body(body)?;
    let missing = || Error::new(503, "chat_signing_not_configured");
    let pem = env
        .secret("TATACHAT_AUTH_KEY")
        .map_err(|_| missing())?
        .to_string();
    let kid = env
        .var("TATACHAT_AUTH_KID")
        .map_err(|_| missing())?
        .to_string();
    access::key_id(&kid)?;
    let s = context
        .session
        .as_ref()
        .ok_or(Error::new(401, "invalid_session"))?;
    let d = context
        .device
        .as_ref()
        .ok_or(Error::new(401, "device_not_registered"))?;
    if s.session_token_hash != session::hash(token)? {
        return Err(Error::new(401, "invalid_session"));
    }
    let admission = context
        .admission
        .as_ref()
        .ok_or(Error::new(403, "registration_required"))?;
    lifecycle::admit(env, &s.cid_number, admission.human_verified_at_millis)
        .await
        .map_err(business)?;
    let now = js_sys::Date::now() as u64;
    let subject = Subject::verified(authority, d, s, config, now)?;
    citizenserve::membership::gate::authorize(
        authority,
        citizenserve::membership::policy::Operation::Chat,
        None,
        now,
    )?;
    let permission = access::authorize(&subject, now)?;
    let unsigned = access::unsigned(&permission, &kid, now)?;
    let signed = super::runtime::chat_signature(&pem, &unsigned).await?;
    // 密码学异步完成后再查当前D1快照，避免签名期间注销/撤销仍返回旧令牌。
    Host::new(env.clone(), config.clone())?
        .require(&subject, &permission, d.issued_at)
        .await?;
    Ok(
        json!({"ok":true,"access_token":signed,"expires_at":permission.expires_at(),
        "recheck_at":permission.recheck_at(),
        "realtime_url":format!("{}/api/tatachat/realtime",config.service_origin.replacen("https://","wss://",1))}),
    )
}
