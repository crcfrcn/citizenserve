//! 服务端固定RPC及Access认证。禁止重定向、客户端URL和认证头外泄。
use citizenserve::{
    chain::{ports::Rpc, trusted_rpc_url},
    shared::{Error, Result},
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{
    send::SendFuture, AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect,
};
pub struct Chain {
    url: String,
    client_id: String,
    client_secret: String,
    purpose: Purpose,
    remaining: std::cell::Cell<u32>,
}
/// 可信入口选择用途，客户端不能声明；聊天和普通鉴权没有查链用途。
#[derive(Clone, Copy, Debug)]
pub(crate) enum Purpose {
    Identity,
    Membership,
    Post,
    Topup,
    TopupIntent,
    Relay,
    StorageCleanup,
    Maintenance,
    PublicRpc(u32),
    Constitution,
    Runtime,
    Asset,
}
impl Purpose {
    fn budget(self) -> (&'static str, u32, u32, u32) {
        match self {
            Self::Maintenance => ("background", 45, 5000, 1000000),
            Self::PublicRpc(n) => ("public", n, 1000, 100000),
            Self::Constitution => ("public", 16, 1000, 100000),
            Self::Runtime => ("public", 5, 1000, 100000),
            Self::Asset => ("public", 1, 1000, 100000),
            // 匿名入口共用既有公共池，不得抢占已认证确认/结算，也不新开总额度。
            Self::Identity | Self::Relay | Self::TopupIntent => ("public", 64, 1000, 100000),
            Self::Membership | Self::Post | Self::Topup | Self::StorageCleanup => {
                ("confirmation", 64, 1000, 100000)
            }
        }
    }
}
/// 公共网络仅交付这两项资源；调用方不能提供任意上游路径或地址。
#[derive(Clone, Copy)]
pub(crate) enum NetworkAsset {
    Install,
    Icon,
}
impl NetworkAsset {
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::Install => "/",
            Self::Icon => "/icons/gmb.png",
        }
    }
    pub(crate) fn media_type(self) -> &'static str {
        match self {
            Self::Install => "text/html",
            Self::Icon => "image/png",
        }
    }
}
impl Chain {
    pub fn available(env: &Env) -> bool {
        env.var("CHAIN_URL").ok().is_some_and(|v| {
            trusted_rpc_url(&v.to_string())
                .is_ok_and(|url| url.path() == "/" && url.query().is_none())
        }) && env
            .var("CF_ACCESS_CLIENT_ID")
            .ok()
            .is_some_and(|v| !v.to_string().is_empty())
            && env
                .secret("CHAIN_SECRET")
                .ok()
                .is_some_and(|v| !v.to_string().is_empty())
    }
    fn take(&self, method: &str) -> Result<()> {
        let allowed = match self.purpose {
            Purpose::Asset => method == "asset",
            Purpose::Runtime => matches!(
                method,
                "chain_getBlockHash"
                    | "chain_getFinalizedHead"
                    | "chain_getHeader"
                    | "state_getRuntimeVersion"
            ),
            Purpose::PublicRpc(_) => {
                citizenserve::chain::ethereum_rpc::METHODS.contains(&method)
                    || matches!(
                        method,
                        "chain_getBlockHash" | "chain_getFinalizedHead" | "chain_getHeader"
                    )
            }
            // 结算仍可广播已由原SETTLE_TOKEN/订单校验的转账；不扩大普通RPC代理。
            Purpose::Topup => matches!(
                method,
                "author_submitExtrinsic"
                    | "chain_getBlockHash"
                    | "chain_getFinalizedHead"
                    | "chain_getHeader"
                    | "chain_getBlock"
                    | "state_getRuntimeVersion"
                    | "state_getMetadata"
                    | "state_getStorage"
            ),
            Purpose::Relay => {
                method == "author_submitExtrinsic"
                    || matches!(
                        method,
                        "chain_getBlockHash"
                            | "chain_getFinalizedHead"
                            | "chain_getHeader"
                            | "state_getMetadata"
                            | "state_getStorage"
                    )
            }
            _ => matches!(
                method,
                "chain_getBlockHash"
                    | "chain_getFinalizedHead"
                    | "chain_getHeader"
                    | "chain_getBlock"
                    | "state_getRuntimeVersion"
                    | "state_getMetadata"
                    | "state_getStorage"
            ),
        };
        if !allowed {
            return Err(Error::new(403, "chain_rpc_scope_mismatch"));
        }
        let left = self
            .remaining
            .get()
            .checked_sub(1)
            .ok_or(Error::new(429, "chain_rpc_budget_exceeded"))?;
        self.remaining.set(left);
        Ok(())
    }
    /// 从已有受保护源读取资源；总超时覆盖响应头和正文，凭据不进入公开响应。
    pub(crate) async fn network_asset(&self, asset: NetworkAsset) -> Result<Vec<u8>> {
        let fail = || Error::new(503, "chain_resource_unavailable");
        let source = trusted_rpc_url(&self.url)?;
        let url = format!("{}{}", source.origin().ascii_serialization(), asset.path());
        let headers = Headers::new();
        for (name, value) in [
            ("CF-Access-Client-Id", self.client_id.as_str()),
            ("CF-Access-Client-Secret", self.client_secret.as_str()),
        ] {
            headers.set(name, value).map_err(|_| fail())?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Get)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual);
        let request = Request::new_with_init(&url, &init).map_err(|_| fail())?;
        self.take("asset")?;
        let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(3_000).into();
        let mut response = Fetch::Request(request)
            .send_with_signal(&signal)
            .await
            .map_err(|_| fail())?;
        if response.status_code() != 200 {
            return Err(fail());
        }
        let content_type = response
            .headers()
            .get("content-type")
            .map_err(|_| fail())?
            .ok_or_else(fail)?;
        if !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case(asset.media_type()))
        {
            return Err(fail());
        }
        use futures_util::StreamExt;
        let mut stream = response.stream().map_err(|_| fail())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| fail())?;
            // 不信任上游Content-Length；按实际收到的分块执行128KiB硬上限。
            if bytes.len().saturating_add(chunk.len()) > 128 * 1024 {
                return Err(fail());
            }
            bytes.extend(chunk);
        }
        if signal.aborted() {
            return Err(fail());
        }
        if matches!(asset, NetworkAsset::Install) {
            std::str::from_utf8(&bytes).map_err(|_| fail())?;
        }
        Ok(bytes)
    }
    pub(crate) async fn external_call(
        &self,
        method: &str,
        params: Value,
        id: Value,
    ) -> Result<Value> {
        let fail = || Error::new(503, "chain_network_unavailable");
        if method != "author_submitExtrinsic"
            && !citizenserve::chain::ethereum_rpc::METHODS.contains(&method)
        {
            return Err(fail());
        }
        let h = Headers::new();
        for (k, v) in [
            ("content-type", "application/json"),
            ("CF-Access-Client-Id", self.client_id.as_str()),
            ("CF-Access-Client-Secret", self.client_secret.as_str()),
        ] {
            h.set(k, v).map_err(|_| fail())?
        }
        let limit = if method == "author_submitExtrinsic" {
            16384
        } else {
            1024 * 1024
        };
        self.take(method)?;
        super::network::fetch_json(
            &self.url,
            h,
            Some(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})),
            limit,
        )
        .await
    }
    pub async fn configured(env: &Env, purpose: Purpose) -> Result<Self> {
        let missing = || Error::new(503, "chain_not_configured");
        let url = env.var("CHAIN_URL").map_err(|_| missing())?.to_string();
        // Node的RPC和静态资源共用HTTPS根端点，拒绝已失配的旧子路径配置。
        let target = trusted_rpc_url(&url)?;
        if target.path() != "/" || target.query().is_some() {
            return Err(missing());
        }
        let client_id = env
            .var("CF_ACCESS_CLIENT_ID")
            .map_err(|_| missing())?
            .to_string();
        let client_secret = env
            .secret("CHAIN_SECRET")
            .map_err(|_| missing())?
            .to_string();
        if client_id.is_empty() || client_secret.is_empty() {
            return Err(missing());
        }
        let (pool, amount, minute, day) = purpose.budget();
        if matches!(purpose,Purpose::PublicRpc(n) if !(6..=25).contains(&n)) {
            return Err(missing());
        }
        let genesis = env
            .var("CHAIN_GENESIS_HASH")
            .map_err(|_| missing())?
            .to_string();
        super::repositories::maintenance::reserve_rpc(
            &env.d1("DB").map_err(|_| missing())?,
            &format!("{genesis}:{pool}"),
            amount,
            minute,
            day,
            js_sys::Date::now() as u64,
        )
        .await?;
        Ok(Self {
            purpose,
            remaining: std::cell::Cell::new(amount),
            url,
            client_id,
            client_secret,
        })
    }
}
impl citizenserve::chain::network_ports::Broadcaster for Chain {
    fn broadcast(
        &self,
        extrinsic: &str,
    ) -> impl std::future::Future<
        Output = Result<citizenserve::chain::network_ports::BroadcastOutcome>,
    > + Send {
        SendFuture::new(async move {
            use citizenserve::chain::network_ports::BroadcastOutcome;
            let v = self
                .external_call("author_submitExtrinsic", json!([extrinsic]), json!(1))
                .await?;
            if v["jsonrpc"] != "2.0"
                || v["id"] != 1
                || v.get("error").is_some() == v.get("result").is_some()
            {
                return Err(Error::new(503, "chain_network_unavailable"));
            }
            if let Some(e) = v.get("error") {
                let code = e["code"]
                    .as_i64()
                    .ok_or(Error::new(503, "chain_network_unavailable"))?;
                // 只有明确InvalidTransaction记failed；AlreadyImported/未知池状态仍保留不确定占用。
                return if code == 1010 {
                    Ok(BroadcastOutcome::Rejected(code.to_string()))
                } else {
                    Err(Error::new(503, "chain_network_unavailable"))
                };
            }
            Ok(BroadcastOutcome::Accepted(
                v["result"]
                    .as_str()
                    .ok_or(Error::new(503, "chain_network_unavailable"))?
                    .into(),
            ))
        })
    }
}
impl Rpc for Chain {
    fn call(
        &self,
        method: &str,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            let fail = || Error::new(503, "identity_projection_unavailable");
            if !matches!(
                method,
                "chain_getBlockHash"
                    | "chain_getFinalizedHead"
                    | "chain_getHeader"
                    | "chain_getBlock"
                    | "state_getRuntimeVersion"
                    | "state_getMetadata"
                    | "state_getStorage"
            ) {
                return Err(fail());
            }
            let headers = Headers::new();
            for (name, value) in [
                ("content-type", "application/json"),
                ("CF-Access-Client-Id", self.client_id.as_str()),
                ("CF-Access-Client-Secret", self.client_secret.as_str()),
            ] {
                headers.set(name, value).map_err(|_| fail())?;
            }
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_headers(headers)
                .with_body(Some(JsValue::from_str(
                    &json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
                )))
                .with_redirect(RequestRedirect::Manual);
            let req = Request::new_with_init(&self.url, &init).map_err(|_| fail())?;
            self.take(method)?;
            let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10_000).into();
            let mut response = Fetch::Request(req)
                .send_with_signal(&signal)
                .await
                .map_err(|_| fail())?;
            if response.status_code() != 200 {
                return Err(fail());
            }
            use futures_util::StreamExt;
            let mut stream = response.stream().map_err(|_| fail())?;
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| fail())?;
                if bytes.len().saturating_add(chunk.len()) > 8 * 1024 * 1024 {
                    return Err(fail());
                }
                bytes.extend(chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
            if value["id"] != 1 || value["jsonrpc"] != "2.0" || value.get("error").is_some() {
                return Err(fail());
            }
            value.get("result").cloned().ok_or_else(fail)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chain(purpose: Purpose) -> Chain {
        let (_, n, _, _) = purpose.budget();
        Chain {
            url: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            purpose,
            remaining: std::cell::Cell::new(n),
        }
    }
    #[test]
    fn closed_pools_and_actual_send_limit_do_not_depend_on_http_retry() {
        assert_eq!(
            Purpose::Maintenance.budget(),
            ("background", 45, 5000, 1000000)
        );
        assert_eq!(
            Purpose::Membership.budget(),
            ("confirmation", 64, 1000, 100000)
        );
        assert_eq!(
            Purpose::PublicRpc(25).budget(),
            ("public", 25, 1000, 100000)
        );
        for purpose in [Purpose::Identity, Purpose::Relay, Purpose::TopupIntent] {
            assert_eq!(purpose.budget(), ("public", 64, 1000, 100000));
        }
        for purpose in [Purpose::Post, Purpose::Topup, Purpose::StorageCleanup] {
            assert_eq!(purpose.budget(), ("confirmation", 64, 1000, 100000));
        }
        let rpc = chain(Purpose::Membership);
        assert_eq!(rpc.take("author_submitExtrinsic").unwrap_err().status, 403);
        assert_eq!(rpc.remaining.get(), 64);
        for _ in 0..64 {
            rpc.take("chain_getBlockHash").unwrap();
        }
        assert_eq!(rpc.take("chain_getBlockHash").unwrap_err().status, 429);
        assert_eq!(rpc.remaining.get(), 0);
    }
    #[test]
    fn settlement_broadcast_and_public_methods_keep_original_scope() {
        chain(Purpose::Topup)
            .take("author_submitExtrinsic")
            .unwrap();
        chain(Purpose::Relay)
            .take("author_submitExtrinsic")
            .unwrap();
        assert!(chain(Purpose::PublicRpc(6))
            .take("author_submitExtrinsic")
            .is_err());
        let intent = chain(Purpose::TopupIntent);
        assert_eq!(
            intent.take("author_submitExtrinsic").unwrap_err().status,
            403
        );
        assert_eq!(intent.remaining.get(), 64);
        for method in [
            "chain_getFinalizedHead",
            "state_getMetadata",
            "state_getStorage",
        ] {
            intent.take(method).unwrap();
        }
        assert!(chain(Purpose::Runtime).take("state_getStorage").is_err());
        assert!(chain(Purpose::Asset).take("chain_getBlockHash").is_err());
    }
}
