//! 两桶适配；视频读取只发 Range。秘密仅在签名/固定Cloudflare API中使用，不进入响应/日志。
use citizenserve::{
    shared::{crypto, Error, Result},
    square::{
        media,
        storage::{Bucket, Direct, Meta, Put, SignedPut, Storage},
    },
};
use serde_json::json;
use std::collections::BTreeMap;
use wasm_bindgen::JsValue;
use worker::{
    send::SendFuture, AbortSignal, Bucket as R2Bucket, Conditional, Env, Fetch, Headers,
    HttpMetadata, Method, Object, Range, Request, RequestInit, RequestRedirect,
};
pub struct R2Storage {
    private: R2Bucket,
    public: R2Bucket,
    account: String,
    access: String,
    secret: String,
    zone: Option<String>,
    purge_token: Option<String>,
    origin: String,
}
fn fail() -> Error {
    Error::new(503, "media_storage_unavailable")
}
impl R2Storage {
    pub fn configured(env: &Env) -> Result<Self> {
        let missing = || Error::new(503, "media_not_configured");
        let value = Self {
            private: env.bucket("SQUARE_PRIVATE").map_err(|_| missing())?,
            public: env.bucket("SQUARE_PUBLIC_MEDIA").map_err(|_| missing())?,
            account: env.var("CF_ACCOUNT_ID").map_err(|_| missing())?.to_string(),
            access: env.secret("R2_KEY").map_err(|_| missing())?.to_string(),
            secret: env.secret("R2_SECRET").map_err(|_| missing())?.to_string(),
            zone: env.var("ZONE_ID").ok().map(|s| s.to_string()),
            purge_token: env.secret("PURGE").ok().map(|s| s.to_string()),
            origin: env
                .var("SQUARE_PUBLIC_MEDIA_BASE_URL")
                .map_err(|_| missing())?
                .to_string(),
        };
        media::public_url(&value.origin, "square/test/posts/test/media/0/source.webp")?;
        Ok(value)
    }
    fn bucket(&self, bucket: Bucket) -> &R2Bucket {
        match bucket {
            Bucket::Private => &self.private,
            Bucket::Public => &self.public,
        }
    }
    fn metadata(object: Object) -> Result<Meta> {
        let checksum = object
            .checksum()
            .sha256
            .filter(|b| b.len() == 32)
            .ok_or_else(fail)?;
        let custom = object
            .custom_metadata()
            .map_err(|_| fail())?
            .into_iter()
            .map(|(k, v)| (k.replace('-', "_"), v))
            .collect::<BTreeMap<_, _>>();
        Ok(Meta {
            key: object.key(),
            byte_size: object.size(),
            content_type: object.http_metadata().content_type.ok_or_else(fail)?,
            sha256: crypto::hex(&checksum),
            etag: object.etag(),
            custom,
        })
    }
}

/// 业务媒体在统一门禁的CID分支内读取；HEAD/Range/条件请求同样先验身份，禁止裸域直出。
/// 正文直接交给运行时流式交付，不把整段视频读入Rust内存。
pub(crate) async fn serve(
    request: &worker::Request, env: &worker::Env,
    entry: &citizenserve::server::gate::Entry, key: &str,
) -> Result<worker::Response> {
    use citizenserve::{
        server::gate,
        user::{auth::session, ports::AuthRepository, profile_service, projection},
    };
    entry.require_cid(gate::policy::CidRule::Media)?;
    if entry.endpoint() != &gate::request::Endpoint::Media(key.into()) {
        return Err(Error::new(403,"gate_scope_mismatch"));
    }
    crate::external_rate(request,env,"RATE_READ").await?;
    let token = crate::bearer(request)?;
    let hash = session::hash(&token)?;
    let db = env.d1("DB").map_err(|_|fail())?;
    let auth = crate::repositories::auth::D1Auth { db:env.d1("DB").map_err(|_|fail())? };
    let current = auth.session(&hash).await?.ok_or(Error::new(401,"invalid_session"))?;
    let config = crate::config(env)?;
    let rpc = crate::chain::Chain::configured(env)?;
    let identities = crate::repositories::identity::D1Identities { db:env.d1("DB").map_err(|_|fail())? };
    let identity = projection::current(&rpc,&identities,&current.account_id,&config.chain_scope,js_sys::Date::now() as u64,false).await?;
    let device = auth.device(&identity.cid_number,&current.device_id).await?.ok_or(Error::new(401,"device_not_registered"))?;
    let admission = auth.admission(&identity.cid_number).await?.ok_or(Error::new(403,"registration_required"))?;
    let authority = gate::identity::session_authority(&identity,&admission,&device,&current,&config,js_sys::Date::now() as u64)?;
    let authorization = profile_service::Authorization::new(&authority,&config,&token,js_sys::Date::now() as u64)?;
    let facts=citizenserve::chain::subscription::for_authority(&rpc,&authority,js_sys::Date::now() as u64).await?;
    let operation=citizenserve::membership::policy::Operation::Media(key.into());
    let permit=citizenserve::membership::gate::authorize(&authority,operation.clone(),Some(&facts),js_sys::Date::now() as u64)?;
    let parts:Vec<_>=key.split('/').collect();
    #[derive(serde::Deserialize)] struct Published { post_id:String }
    let post:Option<Published> = crate::repositories::first(&db,
        "SELECT post_id FROM square_posts WHERE cid_number=?1 AND post_id=?2 AND post_state='published'",
        &[JsValue::from_str(parts[1]),JsValue::from_str(parts[3])]).await?;
    if post.is_none_or(|p|p.post_id!=parts[3]) { return Err(Error::new(404,"post_not_found")); }
    let bucket = env.bucket("SQUARE_PUBLIC_MEDIA").map_err(|_|fail())?;
    let meta = bucket.head(key).await.map_err(|_|fail())?.ok_or(Error::new(404,"media_not_found"))?;
    if meta.size()==0 {return Err(Error::new(404,"media_not_found"));}
    let content_type=meta.http_metadata().content_type.ok_or_else(fail)?;
    if content_type != if key.ends_with(".mp4") {"video/mp4"} else {"image/webp"} {return Err(fail());}
    let etag=meta.http_etag();
    let header=|name|request.headers().get(name).map_err(|_|fail());
    let if_range=header("if-range")?;
    let raw_range=header("range")?;
    let partial=raw_range.is_some()&&if_range.as_deref().is_none_or(|v|v==etag);
    let range=media::range(if partial {raw_range.as_deref()} else {None},meta.size())?;
    let unchanged=header("if-none-match")?.is_some_and(|v|v.split(',').any(|s|s.trim()==etag||s.trim()=="*"));
    let mut response=if unchanged {worker::Response::empty().map_err(|_|fail())?.with_status(304)}
        else if request.method()==Method::Head {worker::Response::empty().map_err(|_|fail())?}
        else {
            let mut get=bucket.get(key);
            if partial {get=get.range(Range::OffsetWithLength{offset:range.offset,length:range.length});}
            let object=get.execute().await.map_err(|_|fail())?.ok_or(Error::new(404,"media_not_found"))?;
            if object.etag()!=meta.etag() {return Err(Error::new(409,"media_object_changed"));}
            worker::Response::from_body(object.body().ok_or_else(fail)?.response_body().map_err(|_|fail())?).map_err(|_|fail())?
        };
    // 对象I/O期间仍可能注销或换绑；使用原授权view在交付前复核当前事实。
    let now=js_sys::Date::now() as u64;
    identity.require_current(now)?;
    let institution=serde_json::to_value(identity.institution).map_err(|_|fail())?;
    #[derive(serde::Deserialize)] struct Live { session_token_hash:String }
    let live:Option<Live>=crate::repositories::first(&db,
        "SELECT session_token_hash FROM authorized_business_sessions WHERE session_token_hash=?1 AND cid_number=?2 AND account_id=?3 AND binding_revision=?4 AND device_id=?5 AND registration_scope=?6 AND service_origin=?7 AND chain_scope=?8 AND institution=?9 AND created_at<=?10 AND expires_at>?10 AND checked_at_millis<=?10 AND verification_deadline_millis>?10",
        &[JsValue::from_str(&hash),JsValue::from_str(authorization.cid()),JsValue::from_str(authorization.account()),
        JsValue::from_f64(authorization.revision() as f64),JsValue::from_str(authorization.device()),
        JsValue::from_str(&config.registration_scope),JsValue::from_str(&config.service_origin),JsValue::from_str(&config.chain_scope),
        JsValue::from_str(institution.as_str().ok_or_else(fail)?),JsValue::from_f64(now as f64)]).await?;
    if live.is_none_or(|v|v.session_token_hash!=hash) {return Err(Error::new(401,"invalid_session"));}
    permit.require(&authorization,&operation,js_sys::Date::now() as u64)?;
    if !unchanged && request.method()!=Method::Head {
        let id=crypto::hex(&crate::runtime::random::<16>()?);
        crate::repositories::membership::D1Membership{db:env.d1("DB").map_err(|_|fail())?}.meter(&authorization,&permit,"delivery_bytes",range.length,key,&id).await?;
    }
    if partial&&!unchanged {response=response.with_status(206);}
    for (name,value) in [("content-type",content_type),("etag",etag),("accept-ranges","bytes".into()),("cache-control","private, no-store".into())] {
        response.headers_mut().set(name,&value).map_err(|_|fail())?;
    }
    if !unchanged {
        response.headers_mut().set("content-length",&range.length.to_string()).map_err(|_|fail())?;
        if partial {response.headers_mut().set("content-range",&format!("bytes {}-{}/{}",range.offset,range.offset+range.length-1,meta.size())).map_err(|_|fail())?;}
    }
    Ok(response)
}
impl Storage for R2Storage {
    fn head(
        &self,
        bucket: Bucket,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Option<Meta>>> + Send {
        SendFuture::new(async move {
            self.bucket(bucket)
                .head(key)
                .await
                .map_err(|_| fail())?
                .map(Self::metadata)
                .transpose()
        })
    }
    fn read(
        &self,
        bucket: Bucket,
        key: &str,
        offset: u64,
        length: u64,
    ) -> impl std::future::Future<Output = Result<Vec<u8>>> + Send {
        SendFuture::new(async move {
            if length == 0
                || length > 4 * 1024 * 1024
                || offset > citizenserve::shared::MAX_SAFE_INTEGER
                || offset.saturating_add(length) > citizenserve::shared::MAX_SAFE_INTEGER
            {
                return Err(fail());
            }
            let object = self
                .bucket(bucket)
                .get(key)
                .range(Range::OffsetWithLength { offset, length })
                .execute()
                .await
                .map_err(|_| fail())?
                .ok_or(Error::new(409, "media_not_found"))?;
            let mut stream = object
                .body()
                .ok_or_else(fail)?
                .stream()
                .map_err(|_| fail())?;
            use futures_util::StreamExt;
            let mut bytes = Vec::with_capacity(length as usize);
            while let Some(chunk) = stream.next().await {
                let c = chunk.map_err(|_| fail())?;
                if bytes.len().saturating_add(c.len()) > length as usize {
                    return Err(fail());
                }
                bytes.extend(c);
            }
            if bytes.len() as u64 != length {
                return Err(fail());
            }
            Ok(bytes)
        })
    }
    fn put(
        &self,
        bucket: Bucket,
        put: Put,
    ) -> impl std::future::Future<Output = Result<Meta>> + Send {
        SendFuture::new(async move {
            if bucket != Bucket::Private
                || put.bytes.len() > 1536 * 1024
                || crypto::sha256_hex(&put.bytes) != put.sha256
            {
                return Err(fail());
            }
            let condition = match put.previous_etag {
                Some(etag) => Conditional {
                    etag_matches: Some(etag),
                    ..Default::default()
                },
                None => Conditional {
                    etag_does_not_match: Some("*".into()),
                    ..Default::default()
                },
            };
            let mut custom = put
                .custom
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>();
            custom.insert("sha256".into(), put.sha256.clone());
            let object = self
                .private
                .put(&put.key, put.bytes)
                .only_if(condition)
                .http_metadata(HttpMetadata {
                    content_type: Some(put.content_type),
                    cache_control: Some("private, no-store".into()),
                    ..Default::default()
                })
                .custom_metadata(custom)
                .sha256(crypto::unhex(&put.sha256)?)
                .execute()
                .await
                .map_err(|_| fail())?
                .ok_or(Error::new(409, "object_version_conflict"))?;
            Self::metadata(object)
        })
    }
    fn sign(
        &self,
        plan: &Direct,
        now: u64,
    ) -> impl std::future::Future<Output = Result<SignedPut>> + Send {
        SendFuture::new(async move {
            let date =
                chrono::DateTime::from_timestamp_millis(i64::try_from(now).map_err(|_| fail())?)
                    .ok_or_else(fail)?;
            media::sign_put(
                &self.account,
                &self.access,
                &self.secret,
                &date.format("%Y%m%dT%H%M%SZ").to_string(),
                plan,
                now,
            )
        })
    }
    fn delete(
        &self,
        bucket: Bucket,
        keys: &[String],
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            if keys.len() > 221 {
                return Err(fail());
            }
            if bucket == Bucket::Public {
                // 空对象永远保留：旧If-None-Match:*直传即便仍在途也不能重建已删内容。
                // 所有公开删除共用此入口，普通维护不能再次移除这个封堵对象。
                for key in keys {
                    if !key.starts_with("square/") || key.contains("..") {
                        return Err(fail());
                    }
                    self.public
                        .put(key, Vec::<u8>::new())
                        .http_metadata(HttpMetadata {
                            content_type: Some("application/octet-stream".into()),
                            cache_control: Some("no-store".into()),
                            ..Default::default()
                        })
                        .execute()
                        .await
                        .map_err(|_| fail())?
                        .ok_or_else(fail)?;
                }
                return Ok(());
            }
            if !keys.is_empty() {
                self.bucket(bucket)
                    .delete_multiple(keys.to_vec())
                    .await
                    .map_err(|_| fail())?;
            }
            Ok(())
        })
    }
    fn purge(&self, keys: &[String]) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            if keys.is_empty() {
                return Ok(());
            }
            if keys.len() > 220 {
                return Err(fail());
            }
            let zone = self
                .zone
                .as_deref()
                .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or(Error::new(503, "cache_purge_not_configured"))?;
            let token = self
                .purge_token
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or(Error::new(503, "cache_purge_not_configured"))?;
            for chunk in keys.chunks(100) {
                let files = chunk
                    .iter()
                    .map(|k| media::public_url(&self.origin, k))
                    .collect::<Result<Vec<_>>>()?;
                let headers = Headers::new();
                headers
                    .set("authorization", &format!("Bearer {token}"))
                    .map_err(|_| fail())?;
                headers
                    .set("content-type", "application/json")
                    .map_err(|_| fail())?;
                let mut init = RequestInit::new();
                init.with_method(Method::Post)
                    .with_headers(headers)
                    .with_body(Some(JsValue::from_str(&json!({"files":files}).to_string())))
                    .with_redirect(RequestRedirect::Manual);
                let req = Request::new_with_init(
                    &format!("https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache"),
                    &init,
                )
                .map_err(|_| fail())?;
                let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10000).into();
                let mut response = Fetch::Request(req)
                    .send_with_signal(&signal)
                    .await
                    .map_err(|_| Error::new(502, "cache_purge_failed"))?;
                if response.status_code() != 200 {
                    return Err(Error::new(502, "cache_purge_failed"));
                }
                use futures_util::StreamExt;
                let mut stream = response.stream().map_err(|_| fail())?;
                let mut raw = vec![];
                while let Some(c) = stream.next().await {
                    let c = c.map_err(|_| fail())?;
                    if raw.len() + c.len() > 65536 {
                        return Err(fail());
                    }
                    raw.extend(c);
                }
                let result: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| fail())?;
                if result["success"] != true {
                    return Err(Error::new(502, "cache_purge_failed"));
                }
            }
            Ok(())
        })
    }
}
