//! 公民宿主许可HTTP与中性再核验装配；通用聊天的CF数据面由B所属模块交付。
use citizenserve::{
    chain::subscription::Current,
    membership::chat::Permissions,
    server::{
        guard::{self, Authority},
        tatachat, tatachat_routes,
    },
    shared::{Error, Result},
    user::{
        auth::session,
        chat_access::Subject,
        ports::{AuthRepository, IdentityRepository},
        registration::protocol::Config,
    },
};
use serde_json::{json, Value};
use worker::Env;

mod attachment;
pub(crate) mod lifecycle;
pub(crate) mod config;
mod key;
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
}
impl D1Store {
    const CLOCK:&'static str="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
    pub(crate) fn new(env: &Env) -> citizenserve::tatachat::Result<Self> {
        Ok(Self {
            db: std::rc::Rc::new(
                env.d1("TATACHAT_DB")
                    .map_err(|_| citizenserve::tatachat::Error::StorageUnavailable)?,
            ),
        })
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
    pub(crate) async fn transaction(
        &self,
        commands: Vec<(&str, Vec<Value>)>,
    ) -> citizenserve::tatachat::Result<Vec<Vec<Value>>> {
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
        let results = self.db.batch(statements).await.map_err(Self::storage)?;
        results
            .into_iter()
            .skip(1)
            .map(|r| {
                if r.success() {
                    r.results().map_err(Self::storage)
                } else {
                    Err(citizenserve::tatachat::Error::StorageUnavailable)
                }
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
        let mut all = vec![(guard.as_str(), vec![json!(access.deadline()),json!(access.actor().user_id)])];
        all.extend(commands);
        all.push((guard.as_str(), vec![json!(access.deadline()),json!(access.actor().user_id)]));
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
}
impl Host {
    pub fn new(env: Env, config: Config) -> Result<Self> {
        config.validate()?;
        Ok(Self { env, config })
    }
    async fn facts(&self, session_hash: &str) -> Result<(Subject, Permissions, u64)> {
        if !citizenserve::shared::ids::hex(session_hash, 32, false) {
            return Err(Error::new(401, "invalid_session"));
        }
        let unavailable = || Error::new(503, "chat_access_unavailable");
        let auth = super::repositories::auth::D1Auth {
            db: self.env.d1("DB").map_err(|_| unavailable())?,
        };
        let original = auth
            .session(session_hash)
            .await?
            .ok_or(Error::new(401, "invalid_session"))?;
        let start = js_sys::Date::now() as u64;
        if original.created_at > start || original.expires_at <= start {
            return Err(Error::new(401, "session_expired"));
        }
        let rpc = super::chain::Chain::configured(&self.env)?;
        let member = citizenserve::chain::subscription::platform(
            &rpc,
            &self.config.chain_scope,
            &original.cid_number,
            &original.account_id,
            start,
        )
        .await?;
        let metadata = citizenserve::chain::identity::metadata(&rpc, &member.anchor).await?;
        let identity = citizenserve::chain::identity::by_cid(
            &rpc,
            &metadata,
            &member.anchor,
            &original.cid_number,
            &self.config.chain_scope,
            js_sys::Date::now() as u64,
        )
        .await?
        .ok_or(Error::new(403, "cid_not_active"))?;
        // 使用已有原子投影撤销规则；不推动全局扫描游标，也不重建真人准入。
        let identities = super::repositories::identity::D1Identities {
            db: self.env.d1("DB").map_err(|_| unavailable())?,
        };
        identities
            .project(std::slice::from_ref(&identity), None, None)
            .await?;
        // 链读取期间可能注销/换绑/撤销，所以不能继续沿用RPC之前的D1对象。
        let s = auth
            .session(session_hash)
            .await?
            .ok_or(Error::new(401, "invalid_session"))?;
        let d = auth
            .device(&s.cid_number, &s.device_id)
            .await?
            .ok_or(Error::new(401, "device_not_registered"))?;
        let a = auth
            .admission(&s.cid_number)
            .await?
            .ok_or(Error::new(403, "registration_required"))?;
        let now = js_sys::Date::now() as u64;
        if now < start {
            return Err(Error::new(503, "chat_clock_changed"));
        }
        let authority = guard::session_authority(&identity, &a, &d, &s, &self.config, now)?;
        lifecycle::admit(&self.env,&s.cid_number,a.human_verified_at_millis).await.map_err(business)?;
        let subject = Subject::verified(&authority, &d, &s, &self.config, now)?;
        let permissions = Permissions::current(&member, &identity, now)?;
        Ok((subject, permissions, d.issued_at))
    }
    async fn require(
        &self,
        subject: &Subject,
        authorization: &tatachat::Authorization,
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
    /// 当前事实生成新的目标许可，供B的authorize_wake使用；不是延长旧WSS凭证。
    pub async fn current_session(&self, session_hash: &str) -> Result<tatachat::Authorization> {
        let (subject, permissions, issued_at) = self.facts(session_hash).await?;
        let permission = tatachat::authorize(&subject, &permissions, js_sys::Date::now() as u64)?;
        self.require(&subject, &permission, issued_at).await?;
        Ok(permission)
    }
}
fn snapshot(permission: &tatachat::Authorization) -> citizenserve::tatachat::auth::HostAccess {
    use citizenserve::tatachat::auth::{Device, HostAccess};
    HostAccess {
        actor: Device {
            user_id: permission.user_id().into(),
            device_id: permission.device_id().into(),
        },
        chat_enabled: permission.chat_enabled(),
        max_attachment_bytes: permission.max_attachment_bytes(),
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
        _ => citizenserve::tatachat::Error::StorageUnavailable,
    }
}
/// 可信当前事实映射到通用端口；公民CID与会员计算仍留在宿主。
impl citizenserve::tatachat::auth::ports::Host for Host {
    fn now_millis(&self) -> u64 {
        js_sys::Date::now() as u64
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
            || current.max_attachment_bytes != previous.max_attachment_bytes
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
    token: &str,
    current: &Current,
    body: &[u8],
) -> Result<Value> {
    tatachat_routes::access_body(body)?;
    let missing = || Error::new(503, "chat_signing_not_configured");
    let pem = env
        .secret("TATACHAT_AUTH_KEY")
        .map_err(|_| missing())?
        .to_string();
    let kid = env
        .var("TATACHAT_AUTH_KID")
        .map_err(|_| missing())?
        .to_string();
    tatachat::key_id(&kid)?;
    let auth = super::repositories::auth::D1Auth {
        db: env.d1("DB").map_err(|_| missing())?,
    };
    let s = auth
        .session(&session::hash(token)?)
        .await?
        .ok_or(Error::new(401, "invalid_session"))?;
    let d = auth
        .device(&s.cid_number, &s.device_id)
        .await?
        .ok_or(Error::new(401, "device_not_registered"))?;
    let now = js_sys::Date::now() as u64;
    let subject = Subject::verified(authority, &d, &s, config, now)?;
    let permissions = Permissions::current(current, subject.identity(), now)?;
    let permission = tatachat::authorize(&subject, &permissions, now)?;
    let unsigned = tatachat::unsigned(&permission, &kid, now)?;
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
