//! 统一门禁的公民号校验分支；原真人准入、设备、会话及请求证明校验在此执行。
use crate::{
    shared::{Error, Result},
    user::{identity::Identity, registration::protocol::Config},
};
/// 字段不公开；聊天宿主必须拿到经过准入/设备/会话核验的上下文。
#[derive(Clone, Debug)]
pub struct Authority {
    identity: Identity,
    device_id: String,
    session_deadline: u64,
    checked: u64,
    deadline: u64,
    membership_synced_at: Option<u64>,
}
impl Authority {
    /// 异步会员/对象访问前后复核原身份与会话期限，不再次消费一次性挑战。
    pub fn require_current(&self, now: u64) -> Result<()> {
        // Authority字段私有且不可反序列化；绑定只在构造时核验，交付另由D1围栏防撤销。
        if now < self.checked || now >= self.deadline {
            return Err(Error::new(503, "authentication_unavailable"));
        }
        if self.session_deadline <= now {
            return Err(Error::new(401, "session_expired"));
        }
        Ok(())
    }
    pub fn membership_deadline(&self, now: u64) -> Result<u64> {
        crate::user::ports::sync_deadline(
            self.membership_synced_at
                .ok_or(Error::new(503, "membership_verification_unavailable"))?,
            now,
        )
        .map_err(|_| Error::new(503, "membership_verification_unavailable"))
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn session_deadline(&self) -> u64 {
        self.session_deadline
    }
    pub fn recheck_deadline(&self) -> u64 {
        self.deadline
    }
}
/// 既有设备建会话只核验服务端；首次激活在device::register保留原链证据检查。
pub fn service_device_authority(
    context: &crate::user::ports::AuthContext,
    config: &Config,
    now: u64,
) -> Result<u64> {
    let deadline = context.identity_deadline(config, now)?;
    let d = context
        .device
        .as_ref()
        .ok_or(Error::new(401, "device_not_registered"))?;
    context
        .admission
        .as_ref()
        .ok_or(Error::new(403, "registration_required"))?
        .require(&context.identity, config)?;
    d.require(&context.identity, &d.public_key)?;
    Ok(deadline)
}

/// 本次许可另算截止时间，不改写持久的链事实时间或authoritative_current。
pub fn service_authority(
    context: &crate::user::ports::AuthContext,
    config: &Config,
    now: u64,
) -> Result<Authority> {
    let deadline = service_device_authority(context, config, now)?;
    let i = &context.identity;
    let d = context
        .device
        .as_ref()
        .ok_or(Error::new(401, "device_not_registered"))?;
    let s = context
        .session
        .as_ref()
        .ok_or(Error::new(401, "invalid_session"))?;
    if s.created_at > now
        || s.expires_at <= now
        || s.cid_number != i.cid_number
        || s.account_id != i.account_id
        || s.binding_revision != i.binding_revision
        || s.device_id != d.device_id
    {
        return Err(Error::new(401, "invalid_session"));
    }
    Ok(Authority {
        identity: i.clone(),
        device_id: d.device_id.clone(),
        session_deadline: s.expires_at,
        checked: now,
        deadline: deadline
            .min(now.saturating_add(super::policy::SERVICE_AUTH_MILLIS))
            .min(s.expires_at),
        membership_synced_at: context.membership_synced_at,
    })
}
#[allow(clippy::too_many_arguments)]
pub async fn authenticate<A: crate::user::ports::AuthRepository>(
    auth: &A,
    context: &crate::user::ports::AuthContext,
    config: &Config,
    token: &str,
    proof: &crate::user::auth::mls_authentication::Proof,
    method: &str,
    target: &str,
    body: &[u8],
    now: u64,
) -> Result<Authority> {
    use crate::user::auth::{challenge::Consumption, mls_authentication::Purpose, session};
    let authority = service_authority(context, config, now)?;
    let s = context
        .session
        .as_ref()
        .ok_or(Error::new(401, "invalid_session"))?;
    let d = context
        .device
        .as_ref()
        .ok_or(Error::new(401, "device_not_registered"))?;
    let hash = session::hash(token)?;
    if hash != s.session_token_hash
        || proof.device_id != s.device_id
        || proof.public_key != d.public_key
    {
        return Err(Error::new(401, "invalid_mls_proof"));
    }
    // 当前请求只验签一次；原事务仍核对最新绑定并原子消费挑战。
    proof.verify_request(
        &context.identity,
        &config.service_origin,
        method,
        target,
        body,
        now,
    )?;
    if !auth
        .consume(&Consumption {
            proof,
            purpose: Purpose::Request,
            session_token_hash: Some(&hash),
            now,
        })
        .await?
    {
        return Err(Error::new(401, "invalid_mls_challenge"));
    }
    Ok(authority)
}

/// 仅门禁能构造的验签结果；借用阻止证明在查链期间被改写。
pub struct CheckedProof<'a> {
    proof: &'a crate::user::auth::mls_authentication::Proof,
}
impl<'a> CheckedProof<'a> {
    pub fn proof(&self) -> &'a crate::user::auth::mls_authentication::Proof {
        self.proof
    }
    pub fn require(
        &self,
        identity: &Identity,
        config: &Config,
        method: &str,
        target: &str,
        body: &[u8],
        now: u64,
    ) -> Result<()> {
        self.proof
            .verify_fields(&config.service_origin, method, target, body, now)?;
        identity.matches(
            &self.proof.user_id,
            &self.proof.account_id,
            self.proof.binding_revision,
        )
    }
}
/// 首次激活先验签再查链；完成后仍复核请求期限、绑定并原子消费挑战。
pub fn prevalidate<'a>(
    config: &Config,
    proof: &'a crate::user::auth::mls_authentication::Proof,
    method: &str,
    target: &str,
    body: &[u8],
    now: u64,
) -> Result<CheckedProof<'a>> {
    proof.verify_fields(&config.service_origin, method, target, body, now)?;
    proof.verify_signature()?;
    Ok(CheckedProof { proof })
}
