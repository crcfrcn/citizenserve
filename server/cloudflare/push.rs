//! 固定供应商源；HTTP错误正文/私钥/token绝不展开到日志。一次消费只发一个端点。
use citizenserve::{
    notifications::{
        delivery::{AuthorizedEndpoint, Outcome},
        endpoint::{Environment, Provider},
        ports::Sender,
    },
    server::maintenance::Budget,
    shared::{Error, Result},
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{
    send::SendFuture, AbortSignal, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect,
};
pub struct Push<'a> {
    pub env: &'a Env,
    pub budget: Budget,
}
fn bad() -> Error {
    Error::new(503, "push_not_configured")
}
fn var(env: &Env, name: &str) -> Result<String> {
    let v = env.var(name).map_err(|_| bad())?.to_string();
    if v.is_empty() || v.len() > 256 || !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(bad());
    }
    Ok(v)
}
async fn request(
    url: &str,
    headers: Headers,
    body: String,
    budget: &Budget,
) -> Result<(u16, Value, Option<u32>)> {
    budget.business(1)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)))
        .with_redirect(RequestRedirect::Manual);
    let req = Request::new_with_init(url, &init).map_err(|_| bad())?;
    let signal: AbortSignal = web_sys::AbortSignal::timeout_with_u32(10000).into();
    let mut resp = Fetch::Request(req)
        .send_with_signal(&signal)
        .await
        .map_err(|_| Error::new(502, "push_transport_unknown"))?;
    let code = resp.status_code();
    let after = resp
        .headers()
        .get("retry-after")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u32>().ok());
    use futures_util::StreamExt;
    let mut stream = resp.stream().map_err(|_| bad())?;
    let mut bytes = Vec::new();
    while let Some(c) = stream.next().await {
        let c = c.map_err(|_| bad())?;
        if bytes.len() + c.len() > 16384 {
            return Err(Error::new(502, "push_response_too_large"));
        }
        bytes.extend(c);
    }
    let value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|_| Error::new(502, "invalid_push_response"))?
    };
    Ok((code, value, after))
}
impl Sender for Push<'_> {
    fn send(
        &self,
        proof: &AuthorizedEndpoint,
        payload: &Value,
        collapse: &str,
    ) -> impl std::future::Future<Output = Result<Outcome>> + Send {
        SendFuture::new(async move {
            let e = proof.endpoint();
            proof.require_current(js_sys::Date::now() as u64)?;
            let title = payload["title"].as_str().unwrap_or("存储清理提醒");
            let body = payload["body"]
                .as_str()
                .unwrap_or("会员权益已到期，超额云存储将在提醒期限后回收。");
            // APNs collapse-id最多64字节；从持久delivery定位符导出，所有重投保持相同。
            let collapse = citizenserve::shared::crypto::sha256_hex(collapse.as_bytes());
            let now = (js_sys::Date::now() / 1000.0) as u64;
            let (url, h, wire) = match e.push_provider {
                Provider::Apns => {
                    let kid = var(self.env, "APNS_KID")?;
                    let team = var(self.env, "APNS_TEAM")?;
                    let topic = var(self.env, "APNS_TOPIC")?;
                    if kid.len() != 10
                        || team.len() != 10
                        || !kid
                            .bytes()
                            .chain(team.bytes())
                            .all(|b| b.is_ascii_alphanumeric())
                        || !topic
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
                    {
                        return Err(bad());
                    }
                    let key = self.env.secret("APNS_KEY").map_err(|_| bad())?.to_string();
                    let jwt = super::runtime::jwt(
                        &key,
                        true,
                        &json!({"alg":"ES256","kid":kid}),
                        &json!({"iss":team,"iat":now}),
                    )
                    .await?;
                    let host = match e.apns_environment {
                        Some(Environment::Sandbox) => "api.sandbox.push.apple.com",
                        Some(Environment::Production) => "api.push.apple.com",
                        None => return Err(bad()),
                    };
                    let h = Headers::new();
                    for (k, v) in [
                        ("authorization", format!("bearer {jwt}")),
                        ("apns-topic", topic),
                        ("apns-push-type", "alert".into()),
                        ("apns-collapse-id", collapse.clone()),
                        ("apns-expiration", (e.expires_at / 1000).to_string()),
                        ("content-type", "application/json".into()),
                    ] {
                        h.set(k, &v).map_err(|_| bad())?;
                    }
                    (
                        format!("https://{host}/3/device/{}", e.push_token),
                        h,
                        json!({"aps":{"alert":{"title":title,"body":body},"sound":"default"},"citizen":payload}),
                    )
                }
                Provider::Fcm => {
                    let email = var(self.env, "FCM_EMAIL")?;
                    let project = var(self.env, "FCM_PROJECT")?;
                    if !email.ends_with(".iam.gserviceaccount.com")
                        || !email.contains('@')
                        || !project
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    {
                        return Err(bad());
                    }
                    let key = self.env.secret("FCM_KEY").map_err(|_| bad())?.to_string();
                    let jwt=super::runtime::jwt(&key,false,&json!({"alg":"RS256","typ":"JWT"}),&json!({"iss":email,"scope":"https://www.googleapis.com/auth/firebase.messaging","aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now+3600})).await?;
                    let h = Headers::new();
                    h.set("content-type", "application/x-www-form-urlencoded")
                        .map_err(|_| bad())?;
                    let form = url::form_urlencoded::Serializer::new(String::new())
                        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
                        .append_pair("assertion", &jwt)
                        .finish();
                    let (status, token, _) =
                        request("https://oauth2.googleapis.com/token", h, form, &self.budget)
                            .await?;
                    if status != 200 {
                        return Ok(if status == 429 || status >= 500 {
                            Outcome::Retry { delay_seconds: 60 }
                        } else {
                            Outcome::Blocked
                        });
                    }
                    let access = token["access_token"]
                        .as_str()
                        .filter(|s| {
                            s.len() <= 4096
                                && !s.is_empty()
                                && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
                        })
                        .ok_or_else(bad)?;
                    if token["token_type"].as_str() != Some("Bearer")
                        || !token["expires_in"]
                            .as_u64()
                            .is_some_and(|n| (1..=3600).contains(&n))
                    {
                        return Err(bad());
                    }
                    let h = Headers::new();
                    h.set("authorization", &format!("Bearer {access}"))
                        .map_err(|_| bad())?;
                    h.set("content-type", "application/json")
                        .map_err(|_| bad())?;
                    (
                        format!("https://fcm.googleapis.com/v1/projects/{project}/messages:send"),
                        h,
                        json!({"message":{"token":e.push_token,"notification":{"title":title,"body":body},"data":{"citizen":payload.to_string()},"android":{"notification":{"tag":collapse}}}}),
                    )
                }
            };
            let wire = serde_json::to_string(&wire).map_err(|_| bad())?;
            citizenserve::notifications::validate_payload(wire.as_bytes())?;
            // JWT/OAuth等待之后再次核实60秒资格期限，不能沿用开始时的授权。
            proof.require_current(js_sys::Date::now() as u64)?;
            let (status, value, after) = request(&url, h, wire, &self.budget).await?;
            Ok(citizenserve::notifications::delivery::classify(
                e.push_provider,
                status,
                &value,
                after,
                1,
            ))
        })
    }
}
