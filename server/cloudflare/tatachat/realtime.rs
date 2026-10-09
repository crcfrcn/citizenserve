//! DO定位只由已验证actor生成；客户端没有内部通知入口。
#[path = "realtime_device.rs"]
pub mod device;
use citizenserve::tatachat::{auth::Device, realtime::Event, Error, Result};
use worker::{Env, Headers, Method, Request, RequestInit, Response};
pub(crate) fn name(actor: &Device) -> Result<String> {
    actor.validate()?;
    serde_json::to_string(&(&actor.user_id, &actor.device_id))
        .map_err(|_| Error::StorageUnavailable)
}
pub(crate) async fn upgrade(request: &Request, env: &Env, host: &super::Host) -> Result<Response> {
    if request.method() != Method::Get
        || request
            .headers()
            .get("upgrade")
            .map_err(|_| Error::InvalidRequest)?
            .as_deref()
            != Some("websocket")
    {
        return Err(Error::InvalidRequest);
    }
    let protocols = request
        .headers()
        .get("sec-websocket-protocol")
        .map_err(|_| Error::InvalidRequest)?
        .ok_or(Error::InvalidRequest)?;
    if !protocols.split(',').any(|p| p.trim() == "tatachat") {
        return Err(Error::InvalidRequest);
    }
    let access = super::routes::authorize(request, env, host).await?;
    let namespace = env
        .durable_object("TATACHAT_DEVICES")
        .map_err(|_| Error::StorageUnavailable)?;
    namespace
        .id_from_name(&name(access.actor())?)
        .map_err(|_| Error::StorageUnavailable)?
        .get_stub()
        .map_err(|_| Error::StorageUnavailable)?
        .fetch_with_request(request.clone().map_err(|_| Error::StorageUnavailable)?)
        .await
        .map_err(|_| Error::StorageUnavailable)
}
pub(crate) async fn notify(env: &Env, actor: &Device, event: &Event) -> Result<()> {
    let namespace = env
        .durable_object("TATACHAT_DEVICES")
        .map_err(|_| Error::StorageUnavailable)?;
    let headers = Headers::new();
    headers
        .set("content-type", "application/octet-stream")
        .map_err(|_| Error::StorageUnavailable)?;
    headers
        .set("content-length", &event.as_bytes().len().to_string())
        .map_err(|_| Error::StorageUnavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(js_sys::Uint8Array::from(event.as_bytes()).into()));
    // 此URL只供命名空间stub使用，Worker公开路由永远不接受它。
    let request = Request::new_with_init("https://tatachat.internal/notify", &init)
        .map_err(|_| Error::StorageUnavailable)?;
    let response = namespace
        .id_from_name(&name(actor)?)
        .map_err(|_| Error::StorageUnavailable)?
        .get_stub()
        .map_err(|_| Error::StorageUnavailable)?
        .fetch_with_request(request)
        .await
        .map_err(|_| Error::StorageUnavailable)?;
    if response.status_code() != 204 {
        return Err(Error::StorageUnavailable);
    }
    Ok(())
}
