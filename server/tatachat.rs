//! 公民宿主装配中性聊天许可；消息业务与持久化归tatachat各功能目录。
use crate::tatachat::auth::{
    Claims, CredentialContext, VerifiedCredential, MAX_ACCESS_MILLIS, MAX_RECHECK_MILLIS,
};
use crate::{
    membership::chat::Permissions,
    shared::{crypto, Error, Result},
    user::chat_access::Subject,
};

/// 不能从请求JSON构造。模块只消费这些中性字段，不得到公民Plan或MLS私钥。
#[derive(Clone, Debug)]
pub struct Authorization {
    user_id: String,
    device_id: String,
    authorization_revision: String,
    session_hash: String,
    origin: String,
    max_attachment_bytes: u64,
    issued_at: u64,
    expires_at: u64,
    recheck_at: u64,
}
impl Authorization {
    pub fn require_current(&self, now: u64) -> Result<()> {
        self.require_unexpired(now)?;
        if now >= self.recheck_at {
            return Err(Error::new(401, "chat_recheck_required"));
        }
        Ok(())
    }
    pub fn require_unexpired(&self, now: u64) -> Result<()> {
        if now < self.issued_at || now >= self.expires_at {
            return Err(Error::new(401, "chat_access_expired"));
        }
        Ok(())
    }
    pub fn user_id(&self) -> &str {
        &self.user_id
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn revision(&self) -> &str {
        &self.authorization_revision
    }
    pub fn session_hash(&self) -> &str {
        &self.session_hash
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn chat_enabled(&self) -> bool {
        true
    }
    pub fn max_attachment_bytes(&self) -> u64 {
        self.max_attachment_bytes
    }
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
    pub fn recheck_at(&self) -> u64 {
        self.recheck_at
    }
}

pub fn authorize(subject: &Subject, permissions: &Permissions, now: u64) -> Result<Authorization> {
    subject.require_current(now)?;
    permissions.require_current(now)?;
    if subject.identity().finalized_block_hash != permissions.anchor_hash() {
        return Err(Error::new(409, "chat_authorization_anchor_changed"));
    }
    let expires_at = now
        .saturating_add(MAX_ACCESS_MILLIS)
        .min(subject.session_deadline())
        .min(permissions.paid_until());
    let recheck_at = now
        .saturating_add(MAX_RECHECK_MILLIS)
        .min(subject.recheck_deadline())
        .min(permissions.deadline())
        .min(expires_at);
    if expires_at <= now || recheck_at <= now {
        return Err(Error::new(401, "chat_access_expired"));
    }
    let bytes = serde_json::to_vec(&(subject.revision(), permissions.max_attachment_bytes()))
        .map_err(|_| Error::new(503, "chat_authorization_unavailable"))?;
    Ok(Authorization {
        user_id: subject.user_id().into(),
        device_id: subject.device_id().into(),
        authorization_revision: crypto::sha256_hex(&bytes),
        session_hash: subject.session_hash().into(),
        origin: subject.origin().into(),
        max_attachment_bytes: permissions.max_attachment_bytes(),
        issued_at: now,
        expires_at,
        recheck_at,
    })
}

/// 再核验可以延长确认期限，但不能延长本次签发的15分钟许可或复活旧会话/代际。
pub fn recheck(
    previous: &Authorization,
    subject: &Subject,
    permissions: &Permissions,
    now: u64,
) -> Result<Authorization> {
    previous.require_unexpired(now)?;
    let mut next = authorize(subject, permissions, now)?;
    if previous.user_id != next.user_id
        || previous.device_id != next.device_id
        || previous.authorization_revision != next.authorization_revision
        || previous.origin != next.origin
    {
        return Err(Error::new(401, "chat_authorization_changed"));
    }
    next.issued_at = previous.issued_at;
    next.expires_at = previous.expires_at.min(next.expires_at);
    next.recheck_at = next.recheck_at.min(next.expires_at);
    next.require_current(now)?;
    Ok(next)
}

pub const AUDIENCE: &str = "citizenserve.tatachat";
pub const PURPOSE: &str = "tatachat_access";
fn token_invalid() -> Error {
    Error::new(401, "chat_token_invalid")
}
pub fn key_id(kid: &str) -> Result<()> {
    crate::tatachat::auth::validate_key_id(kid)
        .map_err(|_| Error::new(503, "chat_signing_not_configured"))
}
pub fn unsigned(authorization: &Authorization, kid: &str, now: u64) -> Result<String> {
    key_id(kid)?;
    authorization.require_current(now)?;
    // 标准JWT到期时间以秒向下裁剪；剩余不足一秒时不能返回已经过期的凭证。
    if authorization.expires_at() / 1000 <= now / 1000 {
        return Err(Error::new(401, "chat_access_expired"));
    }
    let claims = Claims {
        version: 1,
        iss: authorization.origin().into(),
        aud: AUDIENCE.into(),
        purpose: PURPOSE.into(),
        sub: authorization.user_id().into(),
        device_id: authorization.device_id().into(),
        authorization_revision: authorization.revision().into(),
        session_hash: authorization.session_hash().into(),
        chat_enabled: true,
        max_attachment_bytes: authorization.max_attachment_bytes(),
        iat: authorization.issued_at() / 1000,
        nbf: authorization.issued_at() / 1000,
        exp: authorization.expires_at() / 1000,
        issued_at_millis: authorization.issued_at(),
        expires_at_millis: authorization.expires_at(),
        recheck_at_millis: authorization.recheck_at(),
    };
    claims.unsigned(kid, now).map_err(|_| token_invalid())
}
/// 通用模块负责唯一验签；宿主只核对自身真实CID/设备/额度合同。
pub fn verify_token(
    token: &str,
    public_key: &[u8; 32],
    kid: &str,
    config: &crate::user::registration::protocol::Config,
    now: u64,
) -> Result<VerifiedCredential> {
    use crate::shared::ids;
    key_id(kid)?;
    config.validate()?;
    let verified = CredentialContext {
        issuer: config.service_origin.clone(),
        audience: AUDIENCE.into(),
        purpose: PURPOSE.into(),
        key_id: kid.into(),
        public_key: *public_key,
    }
    .verify(token, now)
    .map_err(|_| token_invalid())?;
    let c = verified.claims();
    ids::cid(&c.sub).map_err(|_| token_invalid())?;
    if c.max_attachment_bytes > crate::shared::MAX_SAFE_INTEGER
        || c.expires_at_millis > crate::shared::MAX_SAFE_INTEGER
        || !ids::hex(&c.device_id, 32, false)
        || !ids::hex(&c.authorization_revision, 32, false)
        || !ids::hex(&c.session_hash, 32, false)
    {
        return Err(token_invalid());
    }
    Ok(verified)
}

/// 把仍有效的签名上限裁剪到刚重新核实的许可；签名中的recheck期限绝不当作新当前事实。
pub fn from_token(
    token: &VerifiedCredential,
    current: Authorization,
    now: u64,
) -> Result<Authorization> {
    current.require_current(now)?;
    let c = token.claims();
    if c.sub != current.user_id
        || c.device_id != current.device_id
        || c.authorization_revision != current.authorization_revision
        || c.session_hash != current.session_hash
        || c.iss != current.origin
        || c.max_attachment_bytes != current.max_attachment_bytes
    {
        return Err(Error::new(401, "chat_authorization_changed"));
    }
    let mut a = current;
    a.issued_at = c.issued_at_millis;
    a.expires_at = a
        .expires_at
        .min(c.expires_at_millis)
        .min(c.exp.saturating_mul(1000));
    a.recheck_at = a.recheck_at.min(a.expires_at);
    a.require_current(now)?;
    Ok(a)
}
