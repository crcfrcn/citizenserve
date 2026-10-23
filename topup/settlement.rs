//! 管理端仅授权只读查询；发币状态由内部最终链证明推进。
use crate::shared::{crypto, Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
pub fn authorize(expected: &[u8], authorization: Option<&str>) -> Result<()> {
    if expected.len() < 32 || expected.len() > 4096 {
        return Err(Error::new(503, "topup_settle_unconfigured"));
    }
    let supplied = authorization
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(Error::new(401, "topup_settle_unauthorized"))?;
    if !crypto::equal_secret(expected, supplied.as_bytes()) {
        return Err(Error::new(401, "topup_settle_unauthorized"));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub confirmed_at: u64,
    pub order_id: String,
}
impl Cursor {
    pub fn encode(&self) -> Result<String> {
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|_| super::routes::invalid())?))
    }
    pub fn decode(s: &str) -> Result<Self> {
        if s.len() > 512 {
            return Err(super::routes::invalid());
        }
        let b = super::intent::decode(s)?;
        let v: Self = serde_json::from_slice(&b).map_err(|_| super::routes::invalid())?;
        if v.confirmed_at == 0 || !super::routes::order_id(&v.order_id) || v.encode()? != s {
            return Err(super::routes::invalid());
        }
        Ok(v)
    }
}
