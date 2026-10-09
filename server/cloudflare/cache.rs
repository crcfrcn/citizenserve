//! KV只缓存公开展示，不缓存准入/财务核验结果。缓存中保留服务端期限并在读取时校验。
use citizenserve::{
    chain::network_ports::Cache,
    shared::{Error, Result},
};
use serde_json::{json, Value};
use worker::{send::SendFuture, Env};
pub struct DisplayCache {
    env: Env,
}
impl DisplayCache {
    pub fn configured(env: &Env) -> Self {
        Self { env: env.clone() }
    }
}
impl Cache for DisplayCache {
    fn get(
        &self,
        key: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Option<Value>>> + Send {
        SendFuture::new(async move {
            let Ok(kv) = self.env.kv("SQUARE_CACHE") else {
                return Ok(None);
            };
            let text = kv
                .get(key)
                .text()
                .await
                .map_err(|_| Error::new(503, "display_cache_unavailable"))?;
            let Some(text) = text else { return Ok(None) };
            if text.len() > 4 * 1024 * 1024 {
                return Ok(None);
            }
            let v: Option<Value> = serde_json::from_str(&text).ok();
            Ok(v.filter(|v| {
                v["created"].as_u64().is_some_and(|n| n <= now)
                    && v["deadline"]
                        .as_u64()
                        .is_some_and(|n| n > now && n <= now.saturating_add(300000))
            })
            .and_then(|v| v.get("value").cloned()))
        })
    }
    fn put(
        &self,
        key: &str,
        value: &Value,
        now: u64,
        ttl: u32,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            if !(60..=300).contains(&ttl) {
                return Err(Error::new(503, "display_cache_invalid"));
            }
            let Ok(kv) = self.env.kv("SQUARE_CACHE") else {
                return Ok(());
            };
            let text =
                json!({"created":now,"deadline":now+u64::from(ttl)*1000,"value":value}).to_string();
            if text.len() > 4 * 1024 * 1024 {
                return Ok(());
            }
            kv.put(key, text)
                .map_err(|_| Error::new(503, "display_cache_unavailable"))?
                .expiration_ttl(u64::from(ttl))
                .execute()
                .await
                .map_err(|_| Error::new(503, "display_cache_unavailable"))
        })
    }
}
