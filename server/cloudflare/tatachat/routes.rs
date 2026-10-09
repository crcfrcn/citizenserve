//! 公开入口只有WSS和分块；内部DO通知不从客户端路由暴露。
use super::{config, Host};
use citizenserve::tatachat::{auth::Access, Error, Result};
use wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Request, Response};
pub(crate) fn matches(path: &str) -> bool {
    path == "/api/tatachat/realtime" || path.starts_with("/api/tatachat/attachments/")
}
async fn public_key(env: &Env) -> Result<[u8; 32]> {
    let pem = env
        .secret("TATACHAT_AUTH_KEY")
        .map_err(|_| Error::StorageUnavailable)?
        .to_string();
    if pem.len() > 4096
        || !pem.starts_with("-----BEGIN PRIVATE KEY-----")
        || !pem.contains("-----END PRIVATE KEY-----")
    {
        return Err(Error::StorageUnavailable);
    }
    let raw = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let der = citizenserve::shared::crypto::unbase64url(
        &raw.trim_end_matches('=')
            .replace('+', "-")
            .replace('/', "_"),
        1024,
    )
    .map_err(|_| Error::StorageUnavailable)?;
    let crypto: web_sys::Crypto =
        js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))
            .map_err(|_| Error::StorageUnavailable)?
            .dyn_into()
            .map_err(|_| Error::StorageUnavailable)?;
    let algorithm = js_sys::Object::new();
    js_sys::Reflect::set(
        &algorithm,
        &JsValue::from_str("name"),
        &JsValue::from_str("Ed25519"),
    )
    .map_err(|_| Error::StorageUnavailable)?;
    let usages = js_sys::Array::new();
    usages.push(&JsValue::from_str("sign"));
    let key: web_sys::CryptoKey = js_sys::futures::JsFuture::from(
        crypto
            .subtle()
            .import_key_with_object(
                "pkcs8",
                js_sys::Uint8Array::from(der.as_slice()).as_ref(),
                &algorithm,
                true,
                usages.as_ref(),
            )
            .map_err(|_| Error::StorageUnavailable)?,
    )
    .await
    .map_err(|_| Error::StorageUnavailable)?
    .dyn_into()
    .map_err(|_| Error::StorageUnavailable)?;
    // JWK仅在内存提取公开x；禁止序列化或输出私钥材料。
    let jwk = js_sys::futures::JsFuture::from(
        crypto
            .subtle()
            .export_key("jwk", &key)
            .map_err(|_| Error::StorageUnavailable)?,
    )
    .await
    .map_err(|_| Error::StorageUnavailable)?;
    let x = js_sys::Reflect::get(&jwk, &JsValue::from_str("x"))
        .map_err(|_| Error::StorageUnavailable)?
        .as_string()
        .ok_or(Error::StorageUnavailable)?;
    citizenserve::shared::crypto::unbase64url(&x, 32)
        .map_err(|_| Error::StorageUnavailable)?
        .try_into()
        .map_err(|_| Error::StorageUnavailable)
}
pub(crate) async fn authorize(request: &Request, env: &Env, host: &Host) -> Result<Access> {
    let header = request
        .headers()
        .get("authorization")
        .map_err(|_| Error::Forbidden)?
        .ok_or(Error::Forbidden)?;
    let token = header.strip_prefix("Bearer ").ok_or(Error::Forbidden)?;
    let kid = env
        .var("TATACHAT_AUTH_KID")
        .map_err(|_| Error::StorageUnavailable)?
        .to_string();
    let verified = citizenserve::server::tatachat::verify_token(
        token,
        &public_key(env).await?,
        &kid,
        &host.config,
        config::now(),
    )
    .map_err(super::host_error)?;
    verified.authorize(host).await
}
pub(crate) async fn handle(request: &mut Request, env: &Env) -> Result<Response> {
    if !config::available(env) {
        return Err(Error::StorageUnavailable);
    }
    let url = request.url().map_err(|_| Error::InvalidRequest)?;
    let host = super::host(env)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != host.config.service_origin
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidRequest);
    }
    if let Some(origin) = request
        .headers()
        .get("origin")
        .map_err(|_| Error::InvalidRequest)?
    {
        if origin != host.config.service_origin {
            return Err(Error::Forbidden);
        }
    }
    // 外部客户端不能借内部头走私DO通知。
    if request
        .headers()
        .has("x-tatachat-internal")
        .map_err(|_| Error::InvalidRequest)?
    {
        return Err(Error::InvalidRequest);
    }
    if request.method() == worker::Method::Options {
        let declared = request
            .headers()
            .get("access-control-request-method")
            .map_err(|_| Error::InvalidRequest)?
            .ok_or(Error::InvalidRequest)?;
        if !matches!(declared.as_str(), "GET" | "PUT") {
            return Err(Error::InvalidRequest);
        }
        return crate::preflight(&declared).map_err(|_| Error::InvalidRequest);
    }
    if url.path() == "/api/tatachat/realtime" {
        return super::realtime::upgrade(request, env, &host).await;
    }
    let pieces: Vec<_> = url.path().split('/').collect();
    if pieces.len() != 7
        || pieces[..4] != ["", "api", "tatachat", "attachments"]
        || pieces[5] != "chunks"
        || pieces[4].is_empty()
        || pieces[4].len() > 128
        || !pieces[4]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        || pieces[6].is_empty()
        || !pieces[6].bytes().all(|b| b.is_ascii_digit())
        || pieces[6].len() > 1 && pieces[6].starts_with('0')
    {
        return Err(Error::InvalidRequest);
    }
    let index = pieces[6]
        .parse::<u32>()
        .map_err(|_| Error::InvalidRequest)?;
    super::attachment::http(request, env, &host, pieces[4], index).await
}
