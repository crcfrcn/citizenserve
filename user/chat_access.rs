//! 公民聊天的主体事实由用户模块提取；通用聊天不解释CID、钱包或真人准入。
use crate::{
    server::guard::Authority,
    shared::{crypto, ids, Error, Result},
    user::{
        auth::{device::Device, session::Session},
        identity::Identity,
        registration::protocol::Config,
    },
};

/// 不实现反序列化；只有已核验Authority以及同设备、同会话事实能产生此上下文。
#[derive(Clone, Debug)]
pub struct Subject {
    identity: Identity,
    device_id: String,
    session_hash: String,
    session_deadline: u64,
    service_origin: String,
    revision: String,
}
impl Subject {
    pub fn verified(
        authority: &Authority,
        device: &Device,
        session: &Session,
        config: &Config,
        now: u64,
    ) -> Result<Self> {
        let identity = authority.identity();
        config.validate()?;
        identity.require_current(now)?;
        device.require(identity, &device.public_key)?;
        if identity.chain_scope != config.chain_scope
            || device.device_id != authority.device_id()
            || session.cid_number != identity.cid_number
            || session.account_id != identity.account_id
            || session.binding_revision != identity.binding_revision
            || session.device_id != authority.device_id()
            || session.expires_at != authority.session_deadline()
            || session.created_at > now
            || session.expires_at <= now
            || session.expires_at > crate::shared::MAX_SAFE_INTEGER
            || !ids::hex(&session.session_token_hash, 32, false)
            || !ids::hex(&device.device_id, 32, false)
            || device.issued_at == 0
            || device.issued_at > crate::shared::MAX_SAFE_INTEGER
            || device.issued_at > now.saturating_add(300_000)
        {
            return Err(Error::new(401, "chat_subject_invalid"));
        }
        // 同公钥重新授权的issued_at也进入修订，旧聊天凭证不能跨设备代际复用。
        // 不含链块号或checked_at，正常刷新同一权限不会无故改变不透明修订。
        let material = serde_json::to_vec(&(
            &config.registration_scope,
            &config.service_origin,
            &config.chain_scope,
            &identity.cid_number,
            &identity.account_id,
            identity.binding_revision,
            &device.device_id,
            device.issued_at,
            &session.session_token_hash,
        ))
        .map_err(|_| Error::new(503, "chat_subject_unavailable"))?;
        Ok(Self {
            identity: identity.clone(),
            device_id: device.device_id.clone(),
            session_hash: session.session_token_hash.clone(),
            session_deadline: session.expires_at,
            service_origin: config.service_origin.clone(),
            revision: crypto::sha256_hex(&material),
        })
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        self.identity.require_current(now)?;
        if self.session_deadline <= now {
            return Err(Error::new(401, "session_expired"));
        }
        Ok(())
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn user_id(&self) -> &str {
        &self.identity.cid_number
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn session_hash(&self) -> &str {
        &self.session_hash
    }
    pub fn session_deadline(&self) -> u64 {
        self.session_deadline
    }
    pub fn origin(&self) -> &str {
        &self.service_origin
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn recheck_deadline(&self) -> u64 {
        self.identity.verification_deadline_millis
    }
}
