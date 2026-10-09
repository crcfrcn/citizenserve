//! 会员名称与档位只在宿主计算；通用聊天只接收可用性、字节额度与期限。
use crate::{
    chain::subscription::Current,
    shared::{Error, Result},
    user::identity::Identity,
};

#[derive(Clone, Debug)]
pub struct Permissions {
    max_attachment_bytes: u64,
    paid_until: u64,
    checked_at: u64,
    deadline: u64,
    anchor_hash: String,
}
impl Permissions {
    /// 必须是同一个canonical finalized块的身份与平台会员，不能拿历史投影签发许可。
    pub fn current(current: &Current, identity: &Identity, now: u64) -> Result<Self> {
        identity.require_current(now)?;
        if current.anchor.hash != identity.finalized_block_hash
            || current.anchor.number != identity.finalized_block_number
            || current.chain_time != identity.finalized_timestamp_millis
        {
            return Err(Error::new(409, "chat_authorization_anchor_changed"));
        }
        let state = current.require(now)?;
        let level = current.level(now)?;
        Ok(Self {
            max_attachment_bytes: super::plan(level).chat_file_max_bytes,
            paid_until: state.paid_until,
            checked_at: current.checked_at(),
            deadline: current.deadline(),
            anchor_hash: current.anchor.hash.clone(),
        })
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        if now < self.checked_at || now >= self.deadline {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        if now >= self.paid_until {
            return Err(Error::new(403, "membership_required"));
        }
        Ok(())
    }
    pub fn max_attachment_bytes(&self) -> u64 {
        self.max_attachment_bytes
    }
    pub fn paid_until(&self) -> u64 {
        self.paid_until
    }
    pub fn deadline(&self) -> u64 {
        self.deadline
    }
    pub fn anchor_hash(&self) -> &str {
        &self.anchor_hash
    }
}
