//! 聊天唤醒、端点和提供方签名材料。私钥及HTTPS执行只属于平台驱动。
pub mod ports;
pub mod service;
use crate::tatachat::{
    auth::{Device, HostAccess},
    Error, Result,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const FCM_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const LEASE_MILLIS: u64 = 60_000;
pub const MAX_ATTEMPTS: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushPlatform {
    Ios,
    Android,
}
impl PushPlatform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "ios" => Ok(Self::Ios),
            "android" => Ok(Self::Android),
            _ => Err(Error::InvalidRequest),
        }
    }
}

/// 不实现Debug，避免日志输出推送令牌。generation由存储端单调分配，不能由客户端指定。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub access: HostAccess,
    pub platform: PushPlatform,
    pub token: String,
    pub app_id: String,
    pub generation: u64,
    pub updated_at_millis: u64,
}
impl Endpoint {
    pub fn validate(&self) -> Result<()> {
        self.access.actor.validate()?;
        if self.token.is_empty()
            || self.token.len() > 4096
            || self
                .token
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
            || self.app_id.is_empty()
            || self.app_id.len() > 256
            || self
                .app_id
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(Error::InvalidRequest);
        }
        if self.platform == PushPlatform::Ios
            && (self.token.len() != 64 || !self.token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub ios_app_id: String,
    pub android_app_id: String,
}
impl Config {
    pub fn app_id(&self, platform: PushPlatform) -> &str {
        match platform {
            PushPlatform::Ios => &self.ios_app_id,
            PushPlatform::Android => &self.android_app_id,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub message_id: String,
    pub recipient: Device,
    pub lease_id: String,
    pub lease_until_millis: u64,
    pub attempts: u32,
}
impl Lease {
    pub fn validate(&self, now: u64) -> Result<()> {
        self.recipient
            .validate()
            .map_err(|_| Error::StorageUnavailable)?;
        if !crate::tatachat::valid_identifier(&self.message_id, 128)
            || self.lease_id.is_empty()
            || self.lease_until_millis <= now
            || self.lease_until_millis - now > LEASE_MILLIS
            || !(1..=MAX_ATTEMPTS).contains(&self.attempts)
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Accepted,
    InvalidEndpoint,
    Retryable,
    Blocked,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finish {
    Completed,
    RetryAt(u64),
    Failed,
}
#[derive(Clone, Debug)]
pub struct InvalidEndpoint {
    pub platform: PushPlatform,
    pub generation: u64,
}

pub fn apns_wake_payload() -> Value {
    json!({"aps":{"alert":{"title":"Chat","body":"New message"},"sound":"default","content-available":1},"event":"chat_wake"})
}
pub fn fcm_wake_payload(endpoint: &Endpoint) -> Value {
    json!({"message":{"token":endpoint.token,"notification":{"title":"Chat","body":"New message"},
        "data":{"event":"chat_wake"},"android":{"priority":"HIGH"}}})
}
pub fn apns_url(endpoint: &Endpoint, topics: &[String], sandbox: bool) -> Result<String> {
    endpoint.validate()?;
    if endpoint.platform != PushPlatform::Ios || !topics.contains(&endpoint.app_id) {
        return Err(Error::Forbidden);
    }
    let host = if sandbox {
        "api.sandbox.push.apple.com"
    } else {
        "api.push.apple.com"
    };
    Ok(format!("https://{host}/3/device/{}", endpoint.token))
}
pub fn fcm_url(project: &str) -> Result<String> {
    if !(6..=30).contains(&project.len())
        || !project.as_bytes()[0].is_ascii_lowercase()
        || !project.as_bytes()[project.len() - 1].is_ascii_alphanumeric()
        || !project
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(Error::InvalidRequest);
    }
    Ok(format!(
        "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Es256,
    Rs256,
}
/// 签名原文不包含私钥；驱动按algorithm调用实际密码学实现，禁止自行改写声明。
pub struct SigningInput {
    pub algorithm: Algorithm,
    pub bytes: Vec<u8>,
}
impl SigningInput {
    fn new(algorithm: Algorithm, kid: Option<&str>, claims: Value) -> Result<Self> {
        let name = match algorithm {
            Algorithm::Es256 => "ES256",
            Algorithm::Rs256 => "RS256",
        };
        let mut header = json!({"alg":name,"typ":"JWT"});
        if let Some(kid) = kid {
            if kid.is_empty() || kid.len() > 256 || kid.chars().any(char::is_whitespace) {
                return Err(Error::InvalidRequest);
            }
            header["kid"] = Value::String(kid.to_owned());
        }
        Ok(Self {
            algorithm,
            bytes: format!(
                "{}.{}",
                URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&header).map_err(|_| Error::InvalidRequest)?),
                URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&claims).map_err(|_| Error::InvalidRequest)?)
            )
            .into_bytes(),
        })
    }
    pub fn finish(&self, signature: &[u8]) -> Result<String> {
        if signature.is_empty()
            || signature.len() > 1024
            || self.algorithm == Algorithm::Es256 && signature.len() != 64
        {
            return Err(Error::Forbidden);
        }
        Ok(format!(
            "{}.{}",
            std::str::from_utf8(&self.bytes).map_err(|_| Error::InvalidRequest)?,
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }
}
pub fn apns_signing_input(team: &str, key: &str, now_seconds: u64) -> Result<SigningInput> {
    if team.is_empty() || team.len() > 256 || team.chars().any(char::is_whitespace) {
        return Err(Error::InvalidRequest);
    }
    SigningInput::new(
        Algorithm::Es256,
        Some(key),
        json!({"iss":team,"iat":now_seconds}),
    )
}
pub fn fcm_signing_input(email: &str, key: Option<&str>, now_seconds: u64) -> Result<SigningInput> {
    if email.is_empty()
        || email.len() > 320
        || !email.contains('@')
        || email.chars().any(char::is_whitespace)
    {
        return Err(Error::InvalidRequest);
    }
    SigningInput::new(
        Algorithm::Rs256,
        key,
        json!({"iss":email,
        "scope":"https://www.googleapis.com/auth/firebase.messaging", "aud":FCM_TOKEN_URL,
        "iat":now_seconds,"exp":now_seconds.checked_add(3600).ok_or(Error::InvalidRequest)?}),
    )
}

/// 令牌无Debug/Serialize，不参与持久任务或异常正文；提前60秒停止复用。
pub struct ProviderToken {
    value: String,
    expires_at: u64,
}
impl ProviderToken {
    pub fn apns(value: String, now: u64) -> Result<Self> {
        Self::new(value, now, 3000)
    }
    fn new(value: String, now: u64, duration: u64) -> Result<Self> {
        if value.is_empty()
            || value.len() > 16 * 1024
            || duration <= 60
            || duration > 3600
            || value.bytes().any(|b| !(33..=126).contains(&b))
        {
            return Err(Error::Forbidden);
        }
        Ok(Self {
            value,
            expires_at: now.checked_add(duration).ok_or(Error::Forbidden)?,
        })
    }
    pub fn from_oauth(bytes: &[u8], now: u64) -> Result<Self> {
        if bytes.len() > 16 * 1024 {
            return Err(Error::Forbidden);
        }
        #[derive(Deserialize)]
        struct Token {
            access_token: String,
            expires_in: u64,
            token_type: String,
        }
        let token: Token = serde_json::from_slice(bytes).map_err(|_| Error::Forbidden)?;
        if !token.token_type.eq_ignore_ascii_case("bearer") {
            return Err(Error::Forbidden);
        }
        Self::new(token.access_token, now, token.expires_in)
    }
    pub fn reusable_value(&self, now: u64) -> Option<&str> {
        (self.expires_at > now.saturating_add(60)).then_some(self.value.as_str())
    }
}
#[cfg(test)]
mod tests;
