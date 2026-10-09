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
