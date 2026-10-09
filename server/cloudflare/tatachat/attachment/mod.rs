//! 分块只通过Worker授权入口；持久定位与通用附件端口之间显式转换。
mod objects;
mod store;
use citizenserve::tatachat::{
    attachment::ports::{Upload, Written},
    Error, Result,
};
pub(crate) use objects::R2Objects;
use serde_json::{json, Value};
pub(crate) fn upload_value(u: &Upload) -> Value {
    json!({"attachment_id":u.attachment_id,"generation":u.generation,"attempt_id":u.attempt_id,"object_key":u.object_key,"chunk":u.chunk})
}
pub(crate) fn upload_record(v: &Value) -> Result<Upload> {
    let text = |k: &str| {
        v[k].as_str()
            .map(str::to_owned)
            .ok_or(Error::StorageUnavailable)
    };
    Ok(Upload {
        attachment_id: text("attachment_id")?,
        generation: text("generation")?,
        attempt_id: text("attempt_id")?,
        object_key: text("object_key")?,
        chunk: serde_json::from_value(v["chunk"].clone()).map_err(|_| Error::StorageUnavailable)?,
    })
}
pub(crate) fn written_value(w: &Written) -> Value {
    json!({"upload":upload_value(&w.upload),"object_version":w.object_version,"size":w.size,"sha256":w.sha256})
}
pub(crate) fn written_record(v: &Value) -> Result<Written> {
    Ok(Written {
        upload: upload_record(&v["upload"])?,
        object_version: v["object_version"]
            .as_str()
            .ok_or(Error::StorageUnavailable)?
            .into(),
        size: v["size"].as_u64().ok_or(Error::StorageUnavailable)?,
        sha256: v["sha256"]
            .as_str()
            .ok_or(Error::StorageUnavailable)?
            .into(),
    })
}
pub(crate) async fn http(
    request: &mut worker::Request,
    env: &worker::Env,
    host: &super::Host,
    id: &str,
    index: u32,
) -> Result<worker::Response> {
    let access = super::routes::authorize(request, env, host).await?;
    let store = super::D1Store::new(env)?;
    let objects = R2Objects::new(env, store.clone())?;
    match request.method() {
        worker::Method::Put => {
            let body = crate::body(request, super::config::MAX_CHUNK_BYTES)
                .await
                .map_err(|_| Error::InvalidRequest)?;
            citizenserve::tatachat::attachment::service::upload(
                &store,
                &objects,
                &access,
                id,
                index,
                body,
                super::config::now(),
            )
            .await?;
            worker::Response::empty()
                .map(|r| r.with_status(204))
                .map_err(|_| Error::StorageUnavailable)
        }
        worker::Method::Get => {
            let bytes = citizenserve::tatachat::attachment::service::download(
                &store,
                &objects,
                &access,
                id,
                index,
                super::config::now(),
            )
            .await?;
            let mut response =
                worker::Response::from_bytes(bytes).map_err(|_| Error::StorageUnavailable)?;
            response
                .headers_mut()
                .set("content-type", "application/octet-stream")
                .map_err(|_| Error::StorageUnavailable)?;
            response
                .headers_mut()
                .set("cache-control", "no-store")
                .map_err(|_| Error::StorageUnavailable)?;
            Ok(response)
        }
        _ => Err(Error::InvalidRequest),
    }
}
