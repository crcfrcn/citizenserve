use citizenserve::{
    chain::network_ports::Cache,
    downloads::{self, ports::Releases, routes::DownloadRoute},
    shared::Result,
};
use serde_json::Value;
use worker::{send::SendFuture, Env, Headers, Request, Response};
pub struct Github {
    cache: super::cache::DisplayCache,
}
impl Releases for Github {
    fn get(&self, product: &str) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            if !matches!(product, "citizenapp" | "citizenwallet") {
                return Err(downloads::release::missing());
            }
            let key = format!("release:v1:{product}:android");
            let now = js_sys::Date::now() as u64;
            if let Ok(Some(v)) = self.cache.get(&key, now).await {
                return Ok(v);
            }
            let url = format!("https://api.github.com/repos/crcfrcn/{product}/releases?per_page=100");
            let h = Headers::new();
            for (k, v) in [
                ("user-agent", "CitizenServe"),
                ("accept", "application/vnd.github+json"),
                ("x-github-api-version", "2022-11-28"),
            ] {
                h.set(k, v).map_err(|_| downloads::release::missing())?
            }
            let v = super::network::fetch_json(&url, h, None, 4 * 1024 * 1024).await?;
            let _ = self.cache.put(&key, &v, now, 300).await;
            Ok(v)
        })
    }
}
pub async fn handle(
    request: &mut Request,
    env: &Env,
    r: DownloadRoute,
    url: &url::Url,
) -> Result<Response> {
    r.validate_query(&citizenserve::server::routes::query(url.query())?)?;
    super::read_body(request, r.body_limit()).await?;
    let target = downloads::service::target(
        &Github {
            cache: super::cache::DisplayCache::configured(env),
        },
        r,
    )
    .await?;
    let mut response = Response::empty()
        .map_err(|_| downloads::release::missing())?
        .with_status(302);
    for (k, v) in [("location", target.as_str()), ("cache-control", "no-store")] {
        response
            .headers_mut()
            .set(k, v)
            .map_err(|_| downloads::release::missing())?
    }
    Ok(response)
}
