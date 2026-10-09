//! 端点归属只来自已验证会话。HTTP正文从不接受CID、账户或设备编号。
use crate::{
    shared::{Error, Result, MAX_SAFE_INTEGER},
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Apns,
    Fcm,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Sandbox,
    Production,
}
fn explicit_null<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Environment>, D::Error> {
    Option::deserialize(d)
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub push_provider: Provider,
    pub push_token: String,
    #[serde(deserialize_with = "explicit_null")]
    pub apns_environment: Option<Environment>,
    pub expires_at: u64,
}
impl Register {
    pub fn canonical(mut self, now: u64) -> Result<Self> {
        let valid = match self.push_provider {
            Provider::Apns => {
                self.push_token.len() == 64
                    && self.push_token.bytes().all(|c| c.is_ascii_hexdigit())
                    && self.apns_environment.is_some()
            }
            Provider::Fcm => {
                (16..=4096).contains(&self.push_token.len())
                    && self.push_token.bytes().all(|c| (0x21..=0x7e).contains(&c))
                    && self.apns_environment.is_none()
            }
        };
        if !valid
            || self.expires_at <= now
            || self.expires_at > MAX_SAFE_INTEGER
            || self.expires_at - now > super::ENDPOINT_TTL_MILLIS
        {
            return Err(Error::new(400, "invalid_push_endpoint"));
        }
        if self.push_provider == Provider::Apns {
            self.push_token.make_ascii_lowercase();
        }
        Ok(self)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stored {
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub device_id: String,
    pub push_provider: Provider,
    pub push_token: String,
    pub apns_environment: Option<Environment>,
    pub expires_at: u64,
    pub endpoint_revision: u64,
    pub updated_at: u64,
}
impl Stored {
    pub fn registration(&self) -> Register {
        Register {
            push_provider: self.push_provider,
            push_token: self.push_token.clone(),
            apns_environment: self.apns_environment,
            expires_at: self.expires_at,
        }
    }
}
pub async fn register<R: super::ports::Endpoints>(
    repo: &R,
    auth: &Authorization,
    input: Register,
) -> Result<serde_json::Value> {
    let input = input.canonical(auth.now())?;
    let row = repo.register(auth, &input).await?;
    if row.cid_number != auth.cid()
        || row.device_id != auth.device()
        || row.account_id != auth.account()
        || row.binding_revision != auth.revision()
        || row.registration() != input
        || row.endpoint_revision == 0
    {
        return Err(Error::new(503, "push_endpoint_storage_unavailable"));
    }
    Ok(
        serde_json::json!({"ok":true,"expires_at":row.expires_at,"endpoint_revision":row.endpoint_revision}),
    )
}
pub async fn remove<R: super::ports::Endpoints>(
    repo: &R,
    auth: &Authorization,
) -> Result<serde_json::Value> {
    repo.remove(auth).await?;
    Ok(serde_json::json!({"ok":true}))
}
