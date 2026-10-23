//! 发币网络仅消费本模块公开配置，公共HTTPS传输沿用唯一出口。
use citizenserve::{
    shared::{Error, Result},
    topup::{
        config::Network,
        ports::{Clock, Method, PaymentRpc, Repository},
    },
};
use serde_json::{json, Value};
use worker::{send::SendFuture, Env, Headers};
pub struct Now;
impl Clock for Now {
    fn now(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}
pub struct Payment {
    url: String,
    network: Network,
    repo: super::storage::D1Topup,
}
impl Payment {
    pub fn configured(env: &Env, network: Network) -> Result<Self> {
        let raw = env
            .var("TOPUP_RPCS")
            .map_err(|_| citizenserve::topup::config::unconfigured())?
            .to_string();
        let urls: std::collections::BTreeMap<Network, String> =
            serde_json::from_str(&raw).map_err(|_| citizenserve::topup::config::unconfigured())?;
        if urls.len() != 5 {
            return Err(citizenserve::topup::config::unconfigured());
        }
        for u in urls.values() {
            citizenserve::chain::trusted_rpc_url(u)?;
        }
        Ok(Self {
            url: urls
                .get(&network)
                .ok_or_else(citizenserve::topup::config::unconfigured)?
                .clone(),
            network,
            repo: super::storage::D1Topup::configured(env)?,
        })
    }
}
impl PaymentRpc for Payment {
    fn call(
        &self,
        method: Method,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            let fail = || Error::new(503, "topup_rpc_unavailable");
            let native = matches!(
                method,
                Method::TronGenesis
                    | Method::TronTransaction
                    | Method::TronReceipt
                    | Method::TronBlock
                    | Method::TronBalance
            );
            if native != (self.network == Network::Tron)
                || matches!(
                    method,
                    Method::SolGenesis
                        | Method::SolTransaction
                        | Method::SolBlock
                        | Method::SolAccounts
                ) != (self.network == Network::Solana)
            {
                return Err(fail());
            }
            self.repo.budget(self.network, Now.now()).await?;
            let h = Headers::new();
            h.set("content-type", "application/json")
                .map_err(|_| fail())?;
            let (url, body) = if native {
                (
                    format!("{}/{}", self.url.trim_end_matches('/'), method.name()),
                    params,
                )
            } else {
                (
                    self.url.clone(),
                    json!({"jsonrpc":"2.0","id":1,"method":method.name(),"params":params}),
                )
            };
            let v = crate::network::fetch_json(&url, h, Some(&body), 1024 * 1024).await?;
            if native {
                return Ok(v);
            }
            if v["jsonrpc"] != "2.0" || v["id"] != 1 || v.get("error").is_some() {
                return Err(fail());
            }
            v.get("result").cloned().ok_or_else(fail)
        })
    }
}
