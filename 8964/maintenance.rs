//! 删除定位先持久化；删除结果未知时保留索引/账务与定位，禁止先释放存储。
use crate::{
    membership::cleanup::{Eligibility, Notice},
    shared::{ids, Error, Result},
};
use serde::{Deserialize, Serialize};
pub const MAX_IDENTITIES: usize = 3;
pub const MAX_CONTENT: usize = 4;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Locator {
    pub cid_number: String,
    pub upload_id: String,
    pub post_id: String,
    pub private_keys: Vec<String>,
    pub public_keys: Vec<String>,
    pub byte_size: u64,
    pub object_count: u64,
    pub video_seconds: u64,
    pub reason: String,
    pub lapse_at: Option<u64>,
    #[serde(default)]
    pub profile_generation: Option<u64>,
    #[serde(default)]
    pub object_etag: Option<String>,
    #[serde(default)]
    pub prior_status: String,
    #[serde(default)]
    pub deletion_started: bool,
    pub private_done: bool,
    pub public_done: bool,
    pub purge_done: bool,
}
impl Locator {
    pub fn validate(&self) -> Result<()> {
        ids::cid(&self.cid_number)?;
        if self.private_keys.len() + self.public_keys.len() > 221
            || !matches!(
                self.reason.as_str(),
                "expired_upload" | "expired_membership" | "profile_staging"
            )
            || self.private_keys.iter().chain(&self.public_keys).any(|k| {
                k.len() > 1024
                    || k.contains("..")
                    || !k.starts_with(&format!("square/{}/", self.cid_number))
                        && !k.starts_with(&format!("profile/{}/", self.cid_number))
            })
        {
            return Err(Error::new(503, "invalid_cleanup_locator"));
        }
        Ok(())
    }
    pub fn ready_to_release(&self) -> bool {
        self.private_done && self.public_done && self.purge_done
    }
    pub fn require_membership(&self, proof: &Eligibility, notice: &Notice, now: u64) -> Result<()> {
        if self.reason != "expired_membership"
            || proof.cid() != self.cid_number
            || self.lapse_at != Some(proof.lapse())
            || !proof.may_delete(notice, now)?
        {
            return Err(Error::new(409, "cleanup_qualification_changed"));
        }
        Ok(())
    }
}
