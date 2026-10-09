//! 引导只给出冻结链身份与P2P提示，轻客户端的checkpoint只来自签名安装包。
use crate::shared::{ids, Error, Result};
use serde_json::{json, Value};
pub struct Config {
    pub origin: String,
    pub genesis_hash: String,
    pub state_root: String,
    pub bootnodes: String,
    pub media_origin: String,
    pub relay_enabled: bool,
    pub ttl: u32,
}
impl Config {
    pub fn response(&self, now: u64, sdk: bool) -> Result<Value> {
        if !ids::hex(&self.genesis_hash, 32, true)
            || !ids::hex(&self.state_root, 32, true)
            || !(1..=300).contains(&self.ttl)
        {
            return Err(Error::new(503, "chain_bootstrap_not_configured"));
        }
        for s in [&self.origin, &self.media_origin] {
            let u = url::Url::parse(s)
                .map_err(|_| Error::new(503, "chain_bootstrap_not_configured"))?;
            if u.scheme() != "https" || u.origin().ascii_serialization() != *s {
                return Err(Error::new(503, "chain_bootstrap_not_configured"));
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        let nodes = self
            .bootnodes
            .split(['\n', ',', ';'])
            .map(str::trim)
            .filter(|s| s.starts_with('/') && s.contains("/p2p/") && s.len() <= 256 && s.is_ascii())
            .filter(|s| seen.insert(s.to_string()))
            .take(32)
            .collect::<Vec<_>>();
        let mut chain = json!({"chain_id":"citizenchain","protocol_id":"citizenchain","genesis_hash":self.genesis_hash,"state_root":self.state_root,"ss58_format":2027,"token_symbol":"GMB","token_decimals":2});
        let mut p2p = json!({"bootnodes":nodes,"min_peer_count_hint":1});
        let mut value = json!({"ok":true,"schema":if sdk{"citizensdk.chain.bootstrap"}else{"citizenapp.chain.bootstrap"},"generated_at":now,"cache_ttl_seconds":self.ttl,"chain":chain,"light_client":{"mode":"smoldot","truth_source":"p2p_finalized_storage","api_is_truth":false,"bundled_assets_required":["assets/chainspec.json","assets/light_sync_state.json"]},"p2p":p2p,"security":{"exposes_rpc_url":false,"rpc_proxy":false,"exposes_private_key_material":false,"validator_rpc_public":false}});
        if !sdk {
            chain["chain_name"] = json!("CitizenChain");
            chain["chain_type"] = json!("Live");
            p2p["bootnodes_source"] = json!(if nodes.is_empty() {
                "bundled_chainspec"
            } else {
                "worker_config"
            });
            value["chain"] = chain;
            value["p2p"] = p2p;
            value["services"] = json!({"square_base_url":format!("{}/api/8964",self.origin),"media_base_url":self.media_origin,"signed_extrinsic_relay":{"enabled":self.relay_enabled,"path":if self.relay_enabled{Some("/api/chain/extrinsics")}else{None}}});
            value["degradation"] = json!({"p2p_unavailable":"services_continue_chain_state_degraded","chain_success_source":"finalized_runtime_storage_or_events"});
        }
        Ok(value)
    }
}
