//! 通用主体和权限。内部Access不能从外部JSON直接反序列化。
pub mod ports;
use crate::tatachat::{valid_identity, Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const MAX_ACCESS_MILLIS: u64 = 900_000;
pub const MAX_RECHECK_MILLIS: u64 = 60_000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

/// 签发和验签共用同一公开密钥标识规则；不读取或持有签名私钥。
pub fn validate_key_id(key_id: &str) -> Result<()> {
    if key_id.is_empty()
        || key_id.len() > 64
        || !key_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::Forbidden);
    }
    Ok(())
}

fn context(issuer: &str, audience: &str, purpose: &str, key_id: &str) -> Result<()> {
    let origin = url::Url::parse(issuer).map_err(|_| Error::Forbidden)?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || audience.is_empty()
        || purpose.is_empty()
    {
        return Err(Error::Forbidden);
    }
    validate_key_id(key_id)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub user_id: String,
    pub device_id: String,
}
impl Device {
    pub fn validate(&self) -> Result<()> {
        if valid_identity(&self.user_id) && valid_identity(&self.device_id) {
            Ok(())
        } else {
            Err(Error::InvalidRequest)
        }
    }
}

/// 仅供验真的宿主返回或可信休眠状态使用；反序列化这个快照不产生处理权限。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostAccess {
    pub actor: Device,
    pub chat_enabled: bool,
    pub max_attachment_bytes: u64,
    pub authorization_revision: String,
    pub session_id_digest: String,
    pub issued_at_millis: u64,
    pub expires_at_millis: u64,
    pub recheck_at_millis: u64,
}
impl HostAccess {
    pub(crate) fn validate(&self, now: u64, require_fresh: bool) -> Result<()> {
        self.actor.validate().map_err(|_| Error::Forbidden)?;
        if !self.chat_enabled
            || self.max_attachment_bytes == 0
            || !valid_identity(&self.authorization_revision)
            || self.session_id_digest.len() != 64
            || !self
                .session_id_digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || self.issued_at_millis > now
            || self.expires_at_millis <= now
            || self.expires_at_millis <= self.issued_at_millis
            || self.expires_at_millis - self.issued_at_millis > MAX_ACCESS_MILLIS
            || self.recheck_at_millis <= self.issued_at_millis
            || self.recheck_at_millis > self.expires_at_millis
            || require_fresh
                && (self.recheck_at_millis <= now
                    || self.recheck_at_millis - now > MAX_RECHECK_MILLIS)
        {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
}

/// 经过可信构造的权限，字段私有；权限再核验不会延长原凭证期限。
#[derive(Clone)]
pub struct Access {
    snapshot: HostAccess,
    credential_deadline: u64,
    checked_at: u64,
    invalidated: bool,
}
impl Access {
    pub fn from_host(snapshot: HostAccess, now: u64) -> Result<Self> {
        snapshot.validate(now, true)?;
        if snapshot.recheck_at_millis <= now {
            return Err(Error::Forbidden);
        }
        Ok(Self {
            credential_deadline: snapshot.expires_at_millis,
            snapshot,
            checked_at: now,
            invalidated: false,
        })
    }
    pub fn actor(&self) -> &Device {
        &self.snapshot.actor
    }
    pub fn snapshot(&self) -> &HostAccess {
        &self.snapshot
    }
    pub(crate) fn credential_deadline(&self) -> u64 {
        self.credential_deadline
    }
    pub(crate) fn cap_deadline(&mut self, deadline: u64) {
        self.credential_deadline = self.credential_deadline.min(deadline);
    }
    pub fn deadline(&self) -> u64 {
        self.credential_deadline
            .min(self.snapshot.expires_at_millis)
            .min(self.snapshot.recheck_at_millis)
    }
    pub fn ensure_current(&self, now: u64) -> Result<()> {
        if self.invalidated || now < self.checked_at || now >= self.deadline() {
            Err(Error::Forbidden)
        } else {
            Ok(())
        }
    }
    pub fn effective_max_attachment_bytes(&self, deployment_limit: u64) -> Result<u64> {
        if deployment_limit == 0 {
            return Err(Error::ResourceLimit);
        }
        Ok(deployment_limit.min(self.snapshot.max_attachment_bytes))
    }
    /// 定时器和命令共用此入口；失败后调用方必须关闭连接，不能继续沿用旧许可。
    pub async fn recheck<H: ports::Host>(&mut self, host: &H, force: bool) -> Result<()> {
        let now = host.now_millis();
        if self.invalidated
            || now < self.checked_at
            || now >= self.credential_deadline
            || now >= self.snapshot.expires_at_millis
        {
            return Err(Error::Forbidden);
        }
        if force || now >= self.snapshot.recheck_at_millis {
            // 先撤销旧处理权限；异步失败、取消或修订不符都不能重新使用旧Access。
            self.invalidated = true;
            let fresh = host.recheck(&self.snapshot).await?;
            let completed = host.now_millis();
            fresh.validate(completed, true)?;
            if fresh.actor != self.snapshot.actor
                || fresh.authorization_revision != self.snapshot.authorization_revision
                || fresh.session_id_digest != self.snapshot.session_id_digest
                || fresh.max_attachment_bytes != self.snapshot.max_attachment_bytes
                || fresh.recheck_at_millis <= completed
                || completed < now
                || completed >= self.credential_deadline
            {
                return Err(Error::Forbidden);
            }
            self.snapshot = fresh;
            self.checked_at = completed;
            self.invalidated = false;
        }
        self.ensure_current(host.now_millis())
    }
}

/// 与宿主实际签发合同一致。所有用户标识保持不透明，通用层不解析业务身份。
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub version: u8,
    pub iss: String,
    pub aud: String,
    pub purpose: String,
    pub sub: String,
    pub device_id: String,
    pub authorization_revision: String,
    pub session_hash: String,
    pub chat_enabled: bool,
    pub max_attachment_bytes: u64,
    pub iat: u64,
    pub nbf: u64,
    pub exp: u64,
    pub issued_at_millis: u64,
    pub expires_at_millis: u64,
    pub recheck_at_millis: u64,
}
impl Claims {
    /// 返回唯一JWT签名输入，宿主只负责使用自身安全执行器签名这些字节。
    pub fn unsigned(&self, key_id: &str, now: u64) -> Result<String> {
        context(&self.iss, &self.aud, &self.purpose, key_id)?;
        self.validate(now)?;
        self.snapshot().validate(now, true)?;
        let header = Header {
            alg: "EdDSA".into(),
            typ: "JWT".into(),
            kid: key_id.into(),
        };
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|_| Error::Forbidden)?),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|_| Error::Forbidden)?)
        );
        if input.len() > 16 * 1024 - 87 {
            return Err(Error::Forbidden);
        }
        Ok(input)
    }

    fn validate(&self, now: u64) -> Result<()> {
        if self.version != 1
            || self.iat != self.issued_at_millis / 1000
            || self.nbf != self.iat
            || self.exp != self.expires_at_millis / 1000
            || now / 1000 < self.nbf
            || now / 1000 >= self.exp
        {
            return Err(Error::Forbidden);
        }
        self.snapshot().validate(now, false)?;
        // JWT的初次再核验窗口固定；后续新事实只能由可信宿主提供。
        if self.recheck_at_millis - self.issued_at_millis > MAX_RECHECK_MILLIS {
            return Err(Error::Forbidden);
        }
        Ok(())
    }

    fn snapshot(&self) -> HostAccess {
        HostAccess {
            actor: Device {
                user_id: self.sub.clone(),
                device_id: self.device_id.clone(),
            },
            chat_enabled: self.chat_enabled,
            max_attachment_bytes: self.max_attachment_bytes,
            authorization_revision: self.authorization_revision.clone(),
            session_id_digest: self.session_hash.clone(),
            issued_at_millis: self.issued_at_millis,
            expires_at_millis: self.expires_at_millis,
            recheck_at_millis: self.recheck_at_millis,
        }
    }
}
pub struct CredentialContext {
    pub issuer: String,
    pub audience: String,
    pub purpose: String,
    pub key_id: String,
    pub public_key: [u8; 32],
}
/// 验签结果不产生当前处理权限，也不实现反序列化或Debug。
pub struct VerifiedCredential(Claims);
impl VerifiedCredential {
    pub fn claims(&self) -> &Claims {
        &self.0
    }
    /// 初次recheck时间已过但凭证未到期时仍先查询宿主；旧快照不能直接变成Access。
    pub async fn authorize<H: ports::Host>(&self, host: &H) -> Result<Access> {
        let previous = self.0.snapshot();
        let deadline = self.0.exp.checked_mul(1000).ok_or(Error::Forbidden)?;
        if host.now_millis() >= deadline {
            return Err(Error::Forbidden);
        }
        let fresh = host.recheck(&previous).await?;
        if fresh.actor != previous.actor
            || fresh.authorization_revision != previous.authorization_revision
            || fresh.session_id_digest != previous.session_id_digest
            || fresh.max_attachment_bytes != previous.max_attachment_bytes
        {
            return Err(Error::Forbidden);
        }
        let mut access = Access::from_host(fresh, host.now_millis())?;
        access.cap_deadline(deadline.min(previous.expires_at_millis));
        access.ensure_current(host.now_millis())?;
        Ok(access)
    }
}
impl CredentialContext {
    pub fn verify(&self, token: &str, now: u64) -> Result<VerifiedCredential> {
        context(&self.issuer, &self.audience, &self.purpose, &self.key_id)?;
        if token.is_empty() || token.len() > 16 * 1024 {
            return Err(Error::Forbidden);
        }
        let parts: Vec<_> = token.split('.').collect();
        if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
            return Err(Error::Forbidden);
        }
        let header: Header = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(parts[0])
                .map_err(|_| Error::Forbidden)?,
        )
        .map_err(|_| Error::Forbidden)?;
        if header.alg != "EdDSA" || header.typ != "JWT" || header.kid != self.key_id {
            return Err(Error::Forbidden);
        }
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(parts[2])
                .map_err(|_| Error::Forbidden)?,
        )
        .map_err(|_| Error::Forbidden)?;
        VerifyingKey::from_bytes(&self.public_key)
            .map_err(|_| Error::Forbidden)?
            .verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .map_err(|_| Error::Forbidden)?;
        let claims: Claims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(parts[1])
                .map_err(|_| Error::Forbidden)?,
        )
        .map_err(|_| Error::Forbidden)?;
        if claims.iss != self.issuer
            || claims.aud != self.audience
            || claims.purpose != self.purpose
        {
            return Err(Error::Forbidden);
        }
        claims.validate(now)?;
        Ok(VerifiedCredential(claims))
    }
}

#[cfg(test)]
mod tests;
