//! 固定源、有界HTTP；Base不带CitizenChain的Access头，不透传客户端认证。
use citizenserve::{
    chain::{ethereum_rpc, network_ports::Ethereum},
    shared::{Error, Result},
    topup::{
        evm_verify::Method as PaymentMethod,
        ports::{Clock, PaymentRpc, Repository},
    },
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{
    send::SendFuture, AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect,
};
pub struct Now;
impl Clock for Now {
    fn now(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}
pub async fn fetch_json(
    url: &str,
    headers: Headers,
    body: Option<&Value>,
    max: usize,
) -> Result<Value> {
    let fail = || Error::new(503, "external_source_unavailable");
    let mut init = RequestInit::new();
    init.with_method(if body.is_some() {
        Method::Post
    } else {
        Method::Get
    })
    .with_headers(headers)
    .with_redirect(RequestRedirect::Manual);
    if let Some(v) = body {
        init.with_body(Some(JsValue::from_str(&v.to_string())));
    }
    let request = Request::new_with_init(url, &init).map_err(|_| fail())?;
    let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10000).into();
    let mut r = Fetch::Request(request)
        .send_with_signal(&signal)
        .await
        .map_err(|_| fail())?;
    if r.status_code() != 200 {
        return Err(fail());
    }
    use futures_util::StreamExt;
    let mut stream = r.stream().map_err(|_| fail())?;
    let mut bytes = vec![];
    while let Some(c) = stream.next().await {
        let c = c.map_err(|_| fail())?;
        if bytes.len().saturating_add(c.len()) > max {
            return Err(fail());
        }
        bytes.extend(c)
    }
    serde_json::from_slice(&bytes).map_err(|_| fail())
}
pub struct Base {
    url: String,
    repo: super::repositories::topup::D1Topup,
}
impl Base {
    pub fn configured(env: &Env) -> Result<Self> {
        let url = env
            .var("TOPUP_BASE_RPC_URL")
            .map_err(|_| Error::new(503, "topup_unconfigured"))?
            .to_string();
        citizenserve::chain::trusted_rpc_url(&url)?;
        Ok(Self {
            url,
            repo: super::repositories::topup::D1Topup {
                db: env
                    .d1("DB")
                    .map_err(|_| Error::new(503, "topup_unconfigured"))?,
            },
        })
    }
}
impl PaymentRpc for Base {
    fn call(
        &self,
        method: PaymentMethod,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            self.repo.consume_rpc_budget(Now.now()).await?;
            let h = Headers::new();
            h.set("content-type", "application/json")
                .map_err(|_| Error::new(503, "topup_rpc_unavailable"))?;
            let v = fetch_json(
                &self.url,
                h,
                Some(&json!({"jsonrpc":"2.0","id":1,"method":method.name(),"params":params})),
                1024 * 1024,
            )
            .await?;
            if v["jsonrpc"] != "2.0" || v["id"] != 1 || v.get("error").is_some() {
                return Err(Error::new(503, "topup_rpc_unavailable"));
            }
            v.get("result")
                .cloned()
                .ok_or(Error::new(503, "topup_rpc_unavailable"))
        })
    }
}
/// 同一公共域分流页面、指定图标和RPC；静态路径不放宽原RPC根路径合同。
pub async fn handle(request: &mut worker::Request, env: &Env) -> Result<worker::Response> {
    let u = request
        .url()
        .map_err(|_| Error::new(400, "rpc_host_invalid"))?;
    if u.scheme() != "https"
        || u.origin().ascii_serialization() != "https://nrcrpc.crcfrcn.com"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(Error::new(404, "rpc_route_not_found"));
    }
    use super::chain::NetworkAsset;
    let asset = match u.path() {
        "/" => NetworkAsset::Install,
        "/icons/gmb.png" => NetworkAsset::Icon,
        _ => return Err(Error::new(404, "rpc_route_not_found")),
    };
    if matches!(request.method(), Method::Get | Method::Head) {
        super::external_rate(request, env, "RATE_READ").await?;
        // HEAD同样读取并核验完整资源，随后丢弃正文，避免漏验大小或媒体类型。
        let bytes = super::chain::Chain::configured(env)?
            .network_asset(asset)
            .await?;
        let mut response = if request.method() == Method::Head {
            worker::Response::empty()
        } else {
            worker::Response::from_bytes(bytes)
        }
        .map_err(|_| Error::new(503, "chain_resource_unavailable"))?;
        let content_type = match asset {
            NetworkAsset::Install => "text/html; charset=utf-8",
            NetworkAsset::Icon => "image/png",
        };
        for (name, value) in [
            ("content-type", content_type),
            ("cache-control", "no-store"),
        ] {
            response
                .headers_mut()
                .set(name, value)
                .map_err(|_| Error::new(503, "chain_resource_unavailable"))?;
        }
        return Ok(response);
    }
    if matches!(asset, NetworkAsset::Install) {
        return rpc(request, env).await;
    }
    Err(Error::new(405, "rpc_method_not_allowed"))
}
async fn rpc(request: &mut worker::Request, env: &Env) -> Result<worker::Response> {
    let u = request
        .url()
        .map_err(|_| Error::new(400, "rpc_host_invalid"))?;
    ethereum_rpc::target(u.as_str())?;
    if u.scheme() != "https"
        || u.origin().ascii_serialization() != "https://nrcrpc.crcfrcn.com"
        || u.path() != "/"
        || u.query().is_some()
    {
        return Err(Error::new(404, "rpc_route_not_found"));
    }
    let mut r = if request.method() == worker::Method::Options {
        let mut r = worker::Response::empty()
            .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?
            .with_status(204);
        r.headers_mut()
            .set("access-control-allow-methods", "POST,OPTIONS")
            .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?;
        r.headers_mut()
            .set("access-control-allow-headers", "content-type")
            .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?;
        r
    } else {
        if request.method() != worker::Method::Post {
            return Err(Error::new(405, "rpc_method_not_allowed"));
        }
        let b = super::body(request, 128 * 1024).await?;
        let value = match ethereum_rpc::parse(&b) {
            Err(v) => v,
            Ok(batch) => {
                let write = batch.items.iter().flatten().any(|r| r.write());
                super::external_rate(request, env, if write { "RATE_WRITE" } else { "RATE_READ" })
                    .await?;
                let chain = super::chain::Chain::configured(env)?;
                let genesis = env
                    .var("CHAIN_GENESIS_HASH")
                    .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?
                    .to_string();
                citizenserve::chain::finalized::head(&chain, &genesis).await?;
                let probe = ethereum_rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!("citizenserve-network-check"),
                    method: "eth_chainId".into(),
                    params: json!([]),
                };
                probe.reply(chain.call(&probe).await?)?;
                ethereum_rpc::execute(&chain, batch).await
            }
        };
        worker::Response::from_json(&value)
            .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?
    };
    for (k, v) in [
        ("access-control-allow-origin", "*"),
        ("cache-control", "no-store"),
    ] {
        r.headers_mut()
            .set(k, v)
            .map_err(|_| Error::new(503, "ethereum_rpc_unavailable"))?
    }
    Ok(r)
}
impl Ethereum for super::chain::Chain {
    fn call(
        &self,
        r: &ethereum_rpc::Request,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            r.validate()
                .map_err(|_| Error::new(400, "invalid_ethereum_request"))?;
            self.external_call(&r.method, r.params.clone(), r.id.clone())
                .await
        })
    }
}
