//! 固定源、有界HTTP；Base不带CitizenChain的Access头，不透传客户端认证。
use citizenserve::{
    chain::{ethereum_rpc, network_ports::Ethereum},
    shared::{Error, Result},
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{
    send::SendFuture, AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect,
};
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

/// 同一公共域分流页面、指定图标和RPC；静态路径不放宽原RPC根路径合同。
pub async fn handle(
    request: &mut worker::Request,
    env: &Env,
    scope: &citizenserve::gate::open::Scope<'_>,
) -> Result<worker::Response> {
    if !matches!(
        scope.endpoint(),
        citizenserve::gate::request::Endpoint::Network(_)
    ) {
        return Err(Error::new(403, "gate_scope_mismatch"));
    }
    let u = request
        .url()
        .map_err(|_| Error::new(400, "rpc_host_invalid"))?;
    if u.scheme() != "https"
        || u.origin().ascii_serialization() != citizenserve::gate::policy::NETWORK_ORIGIN
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
        let bytes = super::chain::Chain::configured(env, super::chain::Purpose::Asset)
            .await?
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
        return rpc(request, env, scope).await;
    }
    Err(Error::new(405, "rpc_method_not_allowed"))
}
async fn rpc(
    request: &mut worker::Request,
    env: &Env,
    scope: &citizenserve::gate::open::Scope<'_>,
) -> Result<worker::Response> {
    let u = request
        .url()
        .map_err(|_| Error::new(400, "rpc_host_invalid"))?;
    ethereum_rpc::target(u.as_str())?;
    if u.scheme() != "https"
        || u.origin().ascii_serialization() != citizenserve::gate::policy::NETWORK_ORIGIN
        || u.path() != "/"
        || u.query().is_some()
    {
        return Err(Error::new(404, "rpc_route_not_found"));
    }
    let mut r = {
        if request.method() != worker::Method::Post {
            return Err(Error::new(405, "rpc_method_not_allowed"));
        }
        let b = super::body(request, 128 * 1024).await?;
        let value = match citizenserve::gate::open::network_rpc(scope, &b) {
            Err(v) => v,
            Ok(batch) => {
                let write = batch.items.iter().flatten().any(|r| r.write());
                super::external_rate(request, env, if write { "RATE_WRITE" } else { "RATE_READ" })
                    .await?;
                let count = batch.items.iter().filter(|r| r.is_ok()).count() as u32;
                if count == 0 {
                    let mut errors = batch
                        .items
                        .into_iter()
                        .filter_map(std::result::Result::err)
                        .collect::<Vec<_>>();
                    if batch.batch {
                        json!(errors)
                    } else {
                        errors.remove(0)
                    }
                } else {
                    let chain = super::chain::Chain::configured(
                        env,
                        super::chain::Purpose::PublicRpc(5 + count),
                    )
                    .await?;
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
