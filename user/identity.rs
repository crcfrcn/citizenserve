use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub identity_level: IdentityLevel,
    pub finalized_block_number: u64,
    pub finalized_block_hash: String,
    pub status: CidStatus,
    pub institution: crate::user::registration::protocol::Institution,
    pub chain_scope: String,
    pub registered_block_number: u64,
    pub registered_block_hash: String,
    pub registered_at_millis: u64,
    pub finalized_timestamp_millis: u64,
    pub authoritative_current: bool,
    pub checked_at_millis: u64,
    pub verification_deadline_millis: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CidStatus {
    Active,
    Revoked,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityLevel {
    Visitor,
    Voting,
    Candidate,
}
impl Identity {
    pub fn validate(&self) -> Result<()> {
        ids::cid(&self.cid_number)?;
        ids::account(&self.account_id)?;
        if !ids::positive(self.binding_revision)
            || !ids::hex(&self.finalized_block_hash, 32, true)
            || !ids::hex(&self.chain_scope, 32, true)
            || !ids::hex(&self.registered_block_hash, 32, true)
            || self.registered_block_number > self.finalized_block_number
            || self.verification_deadline_millis <= self.checked_at_millis
            || self.verification_deadline_millis > self.checked_at_millis.saturating_add(60_000)
            || self.verification_deadline_millis > crate::shared::MAX_SAFE_INTEGER
        {
            return Err(Error::new(503, "identity_projection_invalid"));
        }
        Ok(())
    }
    pub fn matches(&self, cid: &str, account: &str, revision: u64) -> Result<()> {
        self.validate()?;
        if self.status != CidStatus::Active
            || self.cid_number != cid
            || self.account_id != account
            || self.binding_revision != revision
        {
            return Err(Error::new(401, "cid_binding_changed"));
        }
        Ok(())
    }
    /// 缓存读取不能延长此期限；只有成功读取权威finalized storage才能更新时间。
    pub fn require_current(&self, now: u64) -> Result<()> {
        self.validate()?;
        if self.status != CidStatus::Active {
            return Err(Error::new(403, "cid_not_bound"));
        }
        if !self.authoritative_current
            || self.checked_at_millis > now
            || self.verification_deadline_millis <= now
        {
            return Err(Error::registration(
                409,
                "identity_finalization_pending",
                true,
                "resolve_identity",
            ));
        }
        Ok(())
    }
}
