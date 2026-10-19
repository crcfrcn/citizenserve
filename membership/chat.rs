//! 附件权限消费统一会员门禁许可；基础聊天不查询或持有会员资格。
use crate::{
    shared::{Error, Result},
    user::identity::Identity,
};
#[derive(Clone, Debug)]
pub struct Permissions {
    max_attachment_bytes: u64,
    deadline: u64,
    checked: u64,
}
impl Permissions {
    pub fn from_permit(
        permit: &super::gate::Permit,
        identity: &Identity,
        now: u64,
    ) -> Result<Self> {
        identity.matches(
            &identity.cid_number,
            &identity.account_id,
            identity.binding_revision,
        )?;
        if permit.cid() != identity.cid_number {
            return Err(Error::new(403, "membership_scope_mismatch"));
        }
        Ok(Self {
            max_attachment_bytes: permit.attachment_limit(now)?,
            deadline: permit.deadline(),
            checked: now,
        })
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        if now < self.checked || now >= self.deadline {
            return Err(Error::new(403, "attachment_membership_required"));
        }
        Ok(())
    }
    pub fn max_attachment_bytes(&self) -> u64 {
        self.max_attachment_bytes
    }
    pub fn deadline(&self) -> u64 {
        self.deadline
    }
}
