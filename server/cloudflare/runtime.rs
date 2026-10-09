use citizenserve::{
    server::registration::Runtime,
    shared::{Error, Result},
    user::registration::{
        protocol::{Verify, SITEVERIFY},
        service::{Entropy, PageEntropy, SiteverifyResult},
    },
};
use serde::Deserialize;
use wasm_bindgen::{JsCast, JsValue};
use worker::{
    send::SendFuture, AbortSignal, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
};
pub struct CloudflareRuntime {
    pub turnstile_secret: String,
}
fn unavailable() -> Error {
    Error::registration(503, "turnstile_unavailable", true, "read_status")
}
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let global = js_sys::global();
    let crypto: web_sys::Crypto = js_sys::Reflect::get(&global, &JsValue::from_str("crypto"))
        .map_err(|_| unavailable())?
        .dyn_into()
        .map_err(|_| unavailable())?;
    let mut bytes = [0u8; N];
    crypto
        .get_random_values_with_u8_array(&mut bytes)
        .map_err(|_| unavailable())?;
    Ok(bytes)
}
#[derive(Deserialize)]
struct External {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    action: String,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    cdata: String,
    #[serde(default)]
    challenge_ts: String,
}
impl Runtime for CloudflareRuntime {
    fn now(&self) -> u64 {
        js_sys::Date::now() as u64
    }
    fn entropy(&self) -> Result<Entropy> {
        Ok(Entropy {
            enrollment: random()?,
            verification: random()?,
            recovery: random()?,
            page: random()?,
            nonce: random()?,
        })
    }
    fn page_entropy(&self) -> Result<PageEntropy> {
        Ok(PageEntropy {
            verification: random()?,
            page: random()?,
            nonce: random()?,
        })
    }
    fn siteverify(
        &self,
        input: &Verify,
        _cdata: &str,
    ) -> impl std::future::Future<Output = Result<Option<SiteverifyResult>>> + Send {
        SendFuture::new(async move {
            let token = input.turnstile_token.as_ref().ok_or_else(unavailable)?;
            let form = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("secret", &self.turnstile_secret)
                .append_pair("response", token)
                .append_pair("idempotency_key", &input.verification_id)
                .finish();
            let headers = Headers::new();
            headers
                .set("content-type", "application/x-www-form-urlencoded")
                .map_err(|_| unavailable())?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_headers(headers)
                .with_body(Some(JsValue::from_str(&form)))
                .with_redirect(RequestRedirect::Manual);
            let request = Request::new_with_init(SITEVERIFY, &init).map_err(|_| unavailable())?;
            let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10_000).into();
            let mut response = match Fetch::Request(request).send_with_signal(&signal).await {
                Ok(r) => r,
                Err(_) => return Ok(None),
            };
            if response.status_code() != 200 {
                return Ok(None);
            }
            // 不把外部错误正文展开给客户端，也不把畸形成功响应当成人工通过。
            use futures_util::StreamExt;
            let mut stream = response.stream().map_err(|_| unavailable())?;
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| unavailable())?;
                if bytes.len().saturating_add(chunk.len()) > 16 * 1024 {
                    return Ok(None);
                }
                bytes.extend(chunk);
            }
            let result: External = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
            let millis = chrono::DateTime::parse_from_rfc3339(&result.challenge_ts)
                .ok()
                .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
                .unwrap_or(0);
            Ok(Some(SiteverifyResult {
                http_ok: true,
                success: result.success,
                action: result.action,
                hostname: result.hostname,
                cdata: result.cdata,
                challenge_at_millis: millis,
            }))
        })
    }
}

/// 仅平台层导入PKCS8并签JWT。秘密不进入D1/KV/日志/共同库。
pub(crate) async fn jwt(
    pem: &str,
    ec: bool,
    header: &serde_json::Value,
    claims: &serde_json::Value,
) -> Result<String> {
    use citizenserve::shared::crypto;
    let bad = || Error::new(503, "push_signing_unavailable");
    if pem.len() > 16384
        || !pem.contains("-----BEGIN PRIVATE KEY-----")
        || !pem.contains("-----END PRIVATE KEY-----")
    {
        return Err(bad());
    }
    let encoded = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let der = crypto::unbase64url(
        &encoded
            .trim_end_matches('=')
            .replace('+', "-")
            .replace('/', "_"),
        8192,
    )
    .map_err(|_| bad())?;
    let c: web_sys::Crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| bad())?
        .dyn_into()
        .map_err(|_| bad())?;
    let algo = js_sys::Object::new();
    js_sys::Reflect::set(
        &algo,
        &JsValue::from_str("name"),
        &JsValue::from_str(if ec { "ECDSA" } else { "RSASSA-PKCS1-v1_5" }),
    )
    .map_err(|_| bad())?;
    js_sys::Reflect::set(
        &algo,
        &JsValue::from_str(if ec { "namedCurve" } else { "hash" }),
        &JsValue::from_str(if ec { "P-256" } else { "SHA-256" }),
    )
    .map_err(|_| bad())?;
    let usages = js_sys::Array::new();
    usages.push(&JsValue::from_str("sign"));
    let key: web_sys::CryptoKey = js_sys::futures::JsFuture::from(
        c.subtle()
            .import_key_with_object(
                "pkcs8",
                js_sys::Uint8Array::from(der.as_slice()).as_ref(),
                &algo,
                false,
                usages.as_ref(),
            )
            .map_err(|_| bad())?,
    )
    .await
    .map_err(|_| bad())?
    .dyn_into()
    .map_err(|_| bad())?;
    if ec {
        js_sys::Reflect::set(
            &algo,
            &JsValue::from_str("hash"),
            &JsValue::from_str("SHA-256"),
        )
        .map_err(|_| bad())?;
    }
    let unsigned = format!(
        "{}.{}",
        crypto::base64url(&serde_json::to_vec(header).map_err(|_| bad())?),
        crypto::base64url(&serde_json::to_vec(claims).map_err(|_| bad())?)
    );
    let bytes = js_sys::futures::JsFuture::from(
        c.subtle()
            .sign_with_object_and_u8_array(&algo, &key, unsigned.as_bytes())
            .map_err(|_| bad())?,
    )
    .await
    .map_err(|_| bad())?;
    let sig = js_sys::Uint8Array::new(&bytes).to_vec();
    if (ec && sig.len() != 64) || (!ec && !(256..=1024).contains(&sig.len())) {
        return Err(bad());
    }
    Ok(format!("{unsigned}.{}", crypto::base64url(&sig)))
}
pub(crate) struct Clock;

/// 宿主聊天签名独立于APNs/FCM和设备MLS密钥，PKCS8秘密仅在平台CryptoKey中使用。
pub(crate) async fn chat_signature(pem: &str, unsigned: &str) -> Result<String> {
    use citizenserve::shared::crypto;
    let bad = || Error::new(503, "chat_signing_unavailable");
    if pem.len() > 4096
        || !pem.starts_with("-----BEGIN PRIVATE KEY-----")
        || !pem.contains("-----END PRIVATE KEY-----")
    {
        return Err(bad());
    }
    let raw = pem
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    let der = crypto::unbase64url(
        &raw.trim_end_matches('=')
            .replace('+', "-")
            .replace('/', "_"),
        1024,
    )
    .map_err(|_| bad())?;
    let c: web_sys::Crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| bad())?
        .dyn_into()
        .map_err(|_| bad())?;
    let algo = js_sys::Object::new();
    js_sys::Reflect::set(
        &algo,
        &JsValue::from_str("name"),
        &JsValue::from_str("Ed25519"),
    )
    .map_err(|_| bad())?;
    let usages = js_sys::Array::new();
    usages.push(&JsValue::from_str("sign"));
    let key: web_sys::CryptoKey = js_sys::futures::JsFuture::from(
        c.subtle()
            .import_key_with_object(
                "pkcs8",
                js_sys::Uint8Array::from(der.as_slice()).as_ref(),
                &algo,
                false,
                usages.as_ref(),
            )
            .map_err(|_| bad())?,
    )
    .await
    .map_err(|_| bad())?
    .dyn_into()
    .map_err(|_| bad())?;
    let raw = js_sys::futures::JsFuture::from(
        c.subtle()
            .sign_with_object_and_u8_array(&algo, &key, unsigned.as_bytes())
            .map_err(|_| bad())?,
    )
    .await
    .map_err(|_| bad())?;
    let bytes = js_sys::Uint8Array::new(&raw).to_vec();
    if bytes.len() != 64 {
        return Err(bad());
    }
    Ok(format!("{unsigned}.{}", crypto::base64url(&bytes)))
}
impl citizenserve::notifications::ports::Clock for Clock {
    fn now(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}
