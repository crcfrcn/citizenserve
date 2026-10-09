use crate::{
    shared::{Error, Result},
    user::{
        admission::Admission,
        auth::{device::Device, session::Session},
        identity::Identity,
        registration::protocol::Config,
    },
};
/// 字段不公开；聊天宿主必须拿到经过准入/设备/会话核验的上下文。
#[derive(Clone, Debug)]
pub struct Authority {
    identity: Identity,
    device_id: String,
    session_deadline: u64,
}
impl Authority {
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
        self.identity.verification_deadline_millis
    }
}
pub fn device_authority(
    identity: &Identity,
    admission: &Admission,
    device: &Device,
    config: &Config,
    public: &str,
    now: u64,
) -> Result<()> {
    identity.require_current(now)?;
    admission.require(identity, config)?;
    device.require(identity, public)
}
pub fn session_authority(
    identity: &Identity,
    admission: &Admission,
    device: &Device,
    session: &Session,
    config: &Config,
    now: u64,
) -> Result<Authority> {
    device_authority(identity, admission, device, config, &device.public_key, now)?;
    if session.expires_at <= now
        || session.created_at > now
        || session.cid_number != identity.cid_number
        || session.account_id != identity.account_id
        || session.binding_revision != identity.binding_revision
        || session.device_id != device.device_id
    {
        return Err(Error::new(401, "session_expired"));
    }
    Ok(Authority {
        identity: identity.clone(),
        device_id: device.device_id.clone(),
        session_deadline: session.expires_at,
    })
}

/// 后续业务处理器的统一入口；只接受已解析的当前链事实和实际请求字节。
#[allow(clippy::too_many_arguments)]
pub async fn authenticate<A: crate::user::ports::AuthRepository>(
    auth: &A,
    identity: &Identity,
    config: &Config,
    token: &str,
    proof: &crate::user::auth::mls_authentication::Proof,
    method: &str,
    target: &str,
    body: &[u8],
    now: u64,
) -> Result<Authority> {
    use crate::user::auth::{challenge::Consumption, mls_authentication::Purpose, session};
    let hash = session::hash(token)?;
    let s = auth
        .session(&hash)
        .await?
        .ok_or(Error::new(401, "invalid_session"))?;
    let d = auth
        .device(&identity.cid_number, &s.device_id)
        .await?
        .ok_or(Error::new(401, "device_not_registered"))?;
    let a = auth
        .admission(&identity.cid_number)
        .await?
        .ok_or(Error::new(403, "registration_required"))?;
    let authority = session_authority(identity, &a, &d, &s, config, now)?;
    if proof.device_id != s.device_id || proof.public_key != d.public_key {
        return Err(Error::new(401, "invalid_mls_proof"));
    }
    proof.verify_request(identity, &config.service_origin, method, target, body, now)?;
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
