//! 云副本回收以真实失效周期为依据；不能用陈旧D1会员镜像直接删除。
use crate::{
    chain::subscription::Current,
    shared::{Error, Result},
};
use serde::{Deserialize, Serialize};
pub const GRACE_MILLIS: u64 = 30 * 86_400_000;
pub const NOTICE_MILLIS: u64 = 86_400_000;
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct Notice {
    pub lapse_at: u64,
    pub notified_at: u64,
    pub cleanup_after: u64,
    pub storage_limit_bytes: u64,
}
impl Notice {
    pub fn new(lapse: u64, now: u64) -> Result<Self> {
        Ok(Self {
            lapse_at: lapse,
            notified_at: now,
            cleanup_after: now
                .checked_add(NOTICE_MILLIS)
                .ok_or(Error::new(503, "invalid_cleanup_time"))?,
            storage_limit_bytes: super::limits::limits(super::Level::Freedom).storage_bytes,
        })
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Eligibility {
    cid_number: String,
    account_id: String,
    binding_revision: u64,
    lapse_at: u64,
    checked_at: u64,
    deadline: u64,
    limit: u64,
}
impl Eligibility {
    pub fn verify(
        identity: &crate::user::identity::Identity,
        current: &Current,
        used: u64,
        notice: Option<&Notice>,
        now: u64,
    ) -> Result<Option<Self>> {
        identity.require_current(now)?;
        if now < current.checked_at()
            || now >= current.deadline()
            || identity.finalized_block_hash != current.anchor.hash
        {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        let limit = super::limits::limits(super::Level::Freedom).storage_bytes;
        let Some(state) = current.state.as_ref() else {
            return Ok(None);
        };
        if state.active(now, current.chain_time) || used <= limit {
            return Ok(None);
        }
        let lapse = state.paid_until;
        if now < lapse.saturating_add(GRACE_MILLIS)
            || current.chain_time < lapse.saturating_add(GRACE_MILLIS)
        {
            return Ok(None);
        }
        if let Some(n) = notice {
            if n.lapse_at != lapse
                || n.cleanup_after != n.notified_at.saturating_add(NOTICE_MILLIS)
                || n.storage_limit_bytes != limit
            {
                return Ok(None);
            }
        }
        Ok(Some(Self {
            cid_number: identity.cid_number.clone(),
            account_id: identity.account_id.clone(),
            binding_revision: identity.binding_revision,
            lapse_at: lapse,
            checked_at: current.checked_at().max(identity.checked_at_millis),
            deadline: current
                .deadline()
                .min(identity.verification_deadline_millis),
            limit,
        }))
    }
    pub fn cid(&self) -> &str {
        &self.cid_number
    }
    pub fn lapse(&self) -> u64 {
        self.lapse_at
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        if now < self.checked_at || now >= self.deadline {
            return Err(Error::new(503, "cleanup_verification_expired"));
        }
        Ok(())
    }
    pub fn may_delete(&self, notice: &Notice, now: u64) -> Result<bool> {
        self.require_current(now)?;
        Ok(notice.lapse_at == self.lapse_at
            && notice.cleanup_after <= now
            && notice.cleanup_after == notice.notified_at.saturating_add(NOTICE_MILLIS))
    }
}
