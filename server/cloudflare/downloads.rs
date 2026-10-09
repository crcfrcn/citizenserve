use citizenserve::{
    chain::network_ports::Cache,
    downloads::{
        self,
        ports::{Releases, Repository},
        publication,
        routes::DownloadRoute,
    },
    shared::{Error, Result},
};
use serde_json::{json, Value};
use worker::{send::SendFuture, Env, Headers, Request, Response};
pub struct Github {
    cache: super::cache::DisplayCache,
    use_cache: bool,
}
impl Releases for Github {
    fn commit(
        &self,
        product: &str,
        tag: &str,
    ) -> impl std::future::Future<Output = Result<String>> + Send {
        SendFuture::new(async move {
            if product != "citizenchain"
                || tag.len() > 128
                || !tag
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
            {
                return Err(downloads::release::missing());
            }
            let request =
                |suffix: &str| format!("https://api.github.com/repos/crcfrcn/{product}/{suffix}");
            let headers = || {
                let h = Headers::new();
                h.set("user-agent", "CitizenServe")
                    .map_err(|_| downloads::release::missing())?;
                h.set("accept", "application/vnd.github+json")
                    .map_err(|_| downloads::release::missing())?;
                Ok::<_, Error>(h)
            };
            let mut v = super::network::fetch_json(
                &request(&format!("git/ref/tags/{tag}")),
                headers()?,
                None,
                16384,
            )
            .await?;
            for _ in 0..4 {
                let sha = v["object"]["sha"]
                    .as_str()
                    .filter(|s| citizenserve::shared::ids::hex(s, 20, false))
                    .ok_or_else(downloads::release::missing)?;
                match v["object"]["type"].as_str() {
                    Some("commit") => return Ok(sha.into()),
                    Some("tag") => {
                        v = super::network::fetch_json(
                            &request(&format!("git/tags/{sha}")),
                            headers()?,
                            None,
                            16384,
                        )
                        .await?
                    }
                    _ => return Err(downloads::release::missing()),
                }
            }
            Err(downloads::release::missing())
        })
    }
    fn get(
        &self,
        product: &str,
        tag: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        SendFuture::new(async move {
            if !matches!(product, "citizenapp" | "citizenwallet" | "citizenchain")
                || tag.is_some_and(|t| {
                    t.len() > 128
                        || !t
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
                })
            {
                return Err(downloads::release::missing());
            }
            let key = format!("release:v1:{product}:{}", tag.unwrap_or("android"));
            let now = js_sys::Date::now() as u64;
            if self.use_cache {
                if let Ok(Some(v)) = self.cache.get(&key, now).await {
                    return Ok(v);
                }
            }
            let url = format!(
                "https://api.github.com/repos/crcfrcn/{product}/{}",
                tag.map(|t| format!("releases/tags/{t}"))
                    .unwrap_or("releases?per_page=100".into())
            );
            let h = Headers::new();
            for (k, v) in [
                ("user-agent", "CitizenServe"),
                ("accept", "application/vnd.github+json"),
                ("x-github-api-version", "2022-11-28"),
            ] {
                h.set(k, v).map_err(|_| downloads::release::missing())?
            }
            let v = super::network::fetch_json(&url, h, None, 4 * 1024 * 1024).await?;
            if self.use_cache {
                let _ = self.cache.put(&key, &v, now, 300).await;
            }
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
    let bytes = super::read_body(request, r.body_limit()).await?;
    let repo = super::repositories::downloads::D1Downloads {
        db: env
            .d1("CITIZENCHAIN_DOWNLOAD_DB")
            .map_err(|_| Error::new(503, "publication_state_unavailable"))?,
    };
    if let DownloadRoute::Publication(p, put) = r {
        let h = request.headers();
        let get = |n| {
            h.get(n)
                .map_err(|_| Error::new(401, "publication_signature_invalid"))?
                .ok_or(Error::new(401, "publication_signature_invalid"))
        };
        let key = env
            .secret("CITIZENCHAIN_DOWNLOAD_PUBLISH_SECRET")
            .map_err(|_| Error::new(503, "publication_auth_unavailable"))?
            .to_string();
        publication::authorize(
            key.as_bytes(),
            r.method(),
            url.path(),
            &get("x-citizenserve-request-time")?,
            &get("x-citizenserve-request-nonce")?,
            &get("x-citizenserve-request-signature")?,
            &bytes,
            js_sys::Date::now() as u64,
        )?;
        let row = if put {
            let i: publication::Update = citizenserve::server::routes::parse_json(&bytes, 16384)?;
            if let Some(value) = &i.publication {
                value.validate(p)?;
                let github = Github {
                    cache: super::cache::DisplayCache::configured(env),
                    use_cache: false,
                };
                if github.commit("citizenchain", &value.version_tag).await? != value.source_sha {
                    return Err(downloads::release::missing());
                }
                downloads::release::asset(
                    &github.get("citizenchain", Some(&value.version_tag)).await?,
                    "citizenchain",
                    &value.version_tag,
                    &value.asset_name,
                    Some(&value.asset_sha256),
                )?;
            }
            repo.publish(p, &i, js_sys::Date::now() as u64).await?
        } else {
            repo.read(p).await?
        };
        return super::json_response(&json!({"ok":true,"publication":row}), 200);
    }
    let target = downloads::service::target(
        &repo,
        &Github {
            cache: super::cache::DisplayCache::configured(env),
            use_cache: true,
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
