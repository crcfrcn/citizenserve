use crate::{
    shared::{Error, Result},
    user::{
        identity::Identity,
        registration::protocol::{Config, Institution},
    },
};
use serde::{Deserialize, Serialize};
/// 此步骤只允许真实turnstile来源；不自动导入旧设备或将链上投影视为真人事实。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Admission {
    pub cid_number: String,
    pub enrollment_id: String,
    pub source: String,
    pub human_verified_at_millis: u64,
    pub registration_scope: String,
    pub service_origin: String,
    pub chain_scope: String,
    pub institution: Institution,
}
impl Admission {
    pub fn require(&self, identity: &Identity, config: &Config) -> Result<()> {
        if self.source != "turnstile"
            || self.human_verified_at_millis == 0
            || self.cid_number != identity.cid_number
            || self.institution != identity.institution
            || self.registration_scope != config.registration_scope
            || self.service_origin != config.service_origin
            || self.chain_scope != config.chain_scope
            || identity.chain_scope != config.chain_scope
        {
            return Err(Error::new(403, "registration_required"));
        }
        Ok(())
    }
}
