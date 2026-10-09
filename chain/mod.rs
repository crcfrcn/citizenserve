use crate::shared::{crypto, ids, Error, Result};
use serde::{Deserialize, Serialize};
pub mod bootstrap;
pub mod constitution;
pub mod ethereum_rpc;
pub mod finalized;
pub mod identity;
pub mod network_ports;
pub mod ports;
pub mod relay;
pub mod scale;
pub mod settlement;
pub mod subscription;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relay {
    pub signed_extrinsic_hex: String,
}
impl Relay {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        let bytes = crypto::unhex(&self.signed_extrinsic_hex)?;
        if !self.signed_extrinsic_hex.starts_with("0x")
            || bytes.is_empty()
            || bytes.len() > 64 * 1024
        {
            return Err(Error::new(400, "invalid_extrinsic"));
        }
        Ok(bytes)
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct TrustAnchor {
    pub genesis_hash: String,
    pub state_root_hash: String,
    pub ss58_format: u16,
    pub token_decimals: u8,
}
impl TrustAnchor {
    pub fn new(genesis: String, state_root: String) -> Result<Self> {
        if !ids::hex(&genesis, 32, true) || !ids::hex(&state_root, 32, true) {
            return Err(Error::new(503, "chain_bootstrap_not_configured"));
        }
        Ok(Self {
            genesis_hash: genesis,
            state_root_hash: state_root,
            ss58_format: 2027,
            token_decimals: 2,
        })
    }
}
/// 只给后台读取器使用；绝不接受客户端RPC URL或允许把服务端认证头透传出去。
pub fn trusted_rpc_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| Error::new(503, "chain_not_configured"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new(503, "chain_not_configured"));
    }
    Ok(url)
}
pub mod post;
pub mod transaction;
