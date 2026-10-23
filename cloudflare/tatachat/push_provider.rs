//! 签名复用宿主WebCrypto原语；负载只消费通用核心，机密不实现Debug。
use citizenserve::tatachat::{
    auth::Access,
    push::{self, ports::Provider, Endpoint, Outcome, PushPlatform},
    Error, Result,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use wasm_bindgen::JsValue;
use worker::{AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect};
pub(crate) struct Push {
    env: Env,
    fcm: RefCell<Option<push::ProviderToken>>,
}
impl Push {
    pub(crate) fn new(env: Env) -> Self {
        Self {
            env,
            fcm: RefCell::new(None),
        }
    }
    fn var(&self, name: &str) -> Result<String> {
        let v = self
            .env
            .var(name)
            .map_err(|_| Error::Forbidden)?
            .to_string();
        if v.is_empty() || v.len() > 256 || v.bytes().any(|b| !b.is_ascii_graphic()) {
            return Err(Error::Forbidden);
        }
        Ok(v)
    }
    async fn request(
        url: &str,
        headers: Headers,
        body: String,
        signal: &AbortSignal,
    ) -> Result<(u16, Vec<u8>)> {
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(JsValue::from_str(&body)))
            .with_redirect(RequestRedirect::Manual);
        let req = Request::new_with_init(url, &init).map_err(|_| Error::StorageUnavailable)?;
        let mut response = Fetch::Request(req)
            .send_with_signal(signal)
            .await
            .map_err(|_| Error::StorageUnavailable)?;
        let status = response.status_code();
        // APNS成功可以没有正文；不把合法空响应误当成网络失败。
        match response.body() {
            worker::ResponseBody::Empty => return Ok((status, Vec::new())),
            worker::ResponseBody::Body(bytes) => {
                if bytes.len() > 16384 {
                    return Err(Error::StorageUnavailable);
                }
                return Ok((status, bytes.clone()));
            }
            worker::ResponseBody::Stream(_) => {}
        }
        use futures_util::StreamExt;
        let mut stream = response.stream().map_err(|_| Error::StorageUnavailable)?;
        let mut bytes = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| Error::StorageUnavailable)?;
            if bytes.len().saturating_add(part.len()) > 16384 {
                return Err(Error::StorageUnavailable);
            }
            bytes.extend(part);
        }
        Ok((status, bytes))
    }
    fn current(endpoint: &Endpoint) -> Result<()> {
        // 复用公开可信构造入口，保持凭证终期与再核验窗口的严格检查。
        Access::from_host(endpoint.access.clone(), super::super::config::now()).map(|_| ())
    }
    async fn execute(&self, endpoint: &Endpoint, payload: &Value, now: u64) -> Result<Outcome> {
        endpoint.validate()?;
        Self::current(endpoint)?;
        let started = super::super::config::now();
        let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10000).into();
        let headers = Headers::new();
        let url = match endpoint.platform {
            PushPlatform::Ios => {
                let kid = self.var("APNS_KID")?;
                let team = self.var("APNS_TEAM")?;
                let topic = self.var("APNS_TOPIC")?;
                if kid.len() != 10
                    || team.len() != 10
                    || !kid
                        .bytes()
                        .chain(team.bytes())
                        .all(|b| b.is_ascii_alphanumeric())
                    || topic != endpoint.app_id
                {
                    return Ok(Outcome::Blocked);
                }
                let key = self
                    .env
                    .secret("APNS_KEY")
                    .map_err(|_| Error::Forbidden)?
                    .to_string();
                let jwt = crate::runtime::jwt(
                    &key,
                    true,
                    &json!({"alg":"ES256","kid":kid}),
                    &json!({"iss":team,"iat":now}),
                )
                .await
                .map_err(|_| Error::Forbidden)?;
                let collapse = citizenserve::shared::crypto::sha256_hex(
                    serde_json::to_string(&(
                        &endpoint.access.actor.user_id,
                        &endpoint.access.actor.device_id,
                    ))
                    .map_err(|_| Error::Forbidden)?
                    .as_bytes(),
                );
                for (k, v) in [
                    ("authorization", format!("bearer {jwt}")),
                    ("apns-topic", topic.clone()),
                    ("apns-push-type", "alert".into()),
                    ("apns-collapse-id", collapse),
                    (
                        "apns-expiration",
                        (endpoint.access.expires_at_millis / 1000).to_string(),
                    ),
                ] {
                    headers.set(k, &v).map_err(|_| Error::Forbidden)?;
                }
                push::apns_url(endpoint, &[topic], false)?
            }
            PushPlatform::Android => {
                let project = self.var("FCM_PROJECT")?;
                let url = push::fcm_url(&project)?;
                if endpoint.app_id != project {
                    return Ok(Outcome::Blocked);
                }
                let cached = self
                    .fcm
                    .borrow()
                    .as_ref()
                    .and_then(|v| v.reusable_value(now))
                    .map(str::to_owned);
                let token = if let Some(token) = cached {
                    token
                } else {
                    let email = self.var("FCM_EMAIL")?;
                    let key = self
                        .env
                        .secret("FCM_KEY")
                        .map_err(|_| Error::Forbidden)?
                        .to_string();
                    let jwt=crate::runtime::jwt(&key,false,&json!({"alg":"RS256","typ":"JWT"}),&json!({"iss":email,"scope":"https://www.googleapis.com/auth/firebase.messaging","aud":push::FCM_TOKEN_URL,"iat":now,"exp":now+3600})).await.map_err(|_|Error::Forbidden)?;
                    let h = Headers::new();
                    h.set("content-type", "application/x-www-form-urlencoded")
                        .map_err(|_| Error::Forbidden)?;
                    let body = url::form_urlencoded::Serializer::new(String::new())
                        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
                        .append_pair("assertion", &jwt)
                        .finish();
                    Self::current(endpoint)?;
                    let (status, bytes) =
                        Self::request(push::FCM_TOKEN_URL, h, body, &signal).await?;
                    if status == 429 || status >= 500 {
                        return Ok(Outcome::Retryable);
                    }
                    if status != 200 {
                        return Ok(Outcome::Blocked);
                    }
                    let cached = push::ProviderToken::from_oauth(
                        &bytes,
                        super::super::config::now() / 1000,
                    )?;
                    let token = cached
                        .reusable_value(super::super::config::now() / 1000)
                        .ok_or(Error::Forbidden)?
                        .to_owned();
                    self.fcm.replace(Some(cached));
                    token
                };
                headers
                    .set("authorization", &format!("Bearer {token}"))
                    .map_err(|_| Error::Forbidden)?;
                url
            }
        };
        headers
            .set("content-type", "application/json")
            .map_err(|_| Error::Forbidden)?;
        Self::current(endpoint)?;
        if super::super::config::now().saturating_sub(started) >= 10000 {
            return Ok(Outcome::Retryable);
        }
        let (status, bytes) = Self::request(&url, headers, payload.to_string(), &signal).await?;
        if (200..300).contains(&status) {
            return Ok(Outcome::Accepted);
        }
        if status == 429 || status >= 500 {
            return Ok(Outcome::Retryable);
        }
        let response: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let invalid = match endpoint.platform {
            PushPlatform::Ios => {
                status == 410
                    || status == 400
                        && matches!(
                            response["reason"].as_str(),
                            Some("BadDeviceToken" | "DeviceTokenNotForTopic")
                        )
            }
            PushPlatform::Android => {
                status == 404
                    && response["error"]["details"]
                        .as_array()
                        .is_some_and(|details| {
                            details.iter().any(|d| {
                                d["@type"] == "type.googleapis.com/google.firebase.fcm.v1.FcmError"
                                    && d["errorCode"] == "UNREGISTERED"
                            })
                        })
            }
        };
        Ok(if invalid {
            Outcome::InvalidEndpoint
        } else {
            Outcome::Blocked
        })
    }
}
impl Provider for Push {
    async fn send(&self, endpoint: &Endpoint, payload: &Value, now: u64) -> Result<Outcome> {
        match self.execute(endpoint, payload, now).await {
            Err(Error::Forbidden | Error::InvalidRequest) => Ok(Outcome::Blocked),
            other => other,
        }
    }
}
