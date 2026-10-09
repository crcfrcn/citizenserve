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
}
impl Chain {
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
        super::network::fetch_json(
            &self.url,
            h,
            Some(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})),
            limit,
        )
        .await
    }
    pub fn configured(env: &Env) -> Result<Self> {
        let missing = || Error::new(503, "chain_not_configured");
        let url = env.var("CHAIN_URL").map_err(|_| missing())?.to_string();
        trusted_rpc_url(&url)?;
        let client_id = env.secret("CHAIN_ID").map_err(|_| missing())?.to_string();
        let client_secret = env
            .secret("CHAIN_SECRET")
            .map_err(|_| missing())?
            .to_string();
        if client_id.is_empty() || client_secret.is_empty() {
            return Err(missing());
        }
        Ok(Self {
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
