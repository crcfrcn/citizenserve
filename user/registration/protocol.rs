use crate::shared::{crypto, ids, Error, Result, MAX_SAFE_INTEGER};
use serde::{Deserialize, Serialize};

pub const PREPARED_TTL: u64 = 600_000;
pub const VERIFIED_TTL: u64 = 86_400_000;
pub const PAGE_TTL: u64 = 300_000;
pub const ACTION: &str = "cid_register";
pub const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

#[derive(Clone, Debug)]
pub struct Config {
    pub registration_scope: String,
    pub service_origin: String,
    pub chain_scope: String,
    pub site_key: String,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        let env = self
            .registration_scope
            .strip_prefix("citizenserve:")
            .unwrap_or("");
        if env.is_empty()
            || env.len() > 32
            || !env.as_bytes()[0].is_ascii_alphanumeric()
            || !env
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || ids::origin(&self.service_origin).is_err()
            || !ids::hex(&self.chain_scope, 32, true)
            || self.site_key.is_empty()
            || !self
                .site_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::registration(
                503,
                "registration_not_configured",
                false,
                "none",
            ));
        }
        Ok(())
    }
    pub fn hostname(&self) -> String {
        url::Url::parse(&self.service_origin)
            .expect("validated configuration")
            .host_str()
            .unwrap()
            .to_owned()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    pub protocol_version: u8,
    pub chain_scope: String,
    pub account_id: String,
    pub institution: Institution,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub enum Institution {
    CTZN,
    NATP,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Verify {
    pub protocol_version: u8,
    pub enrollment_id: String,
    pub recovery_token: String,
    pub verification_id: String,
    #[serde(deserialize_with = "required_option")]
    pub turnstile_token: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub protocol_version: u8,
    pub enrollment_id: String,
    pub recovery_token: String,
    pub operation: Operation,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Read,
    RefreshVerification,
    Cancel,
}
fn required_option<'de, D: serde::Deserializer<'de>>(
    de: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(de)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Prepared,
    HumanVerified,
    Activated,
    Expired,
    Cancelled,
}
impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::HumanVerified => "human_verified",
            Self::Activated => "activated",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Activation {
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub device_id: String,
    pub public_key: String,
}

/// 此持久记录没有恢复秘密、页面秘密、Cloudflare原始token或任何MLS私钥。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Enrollment {
    pub enrollment_id: String,
    pub registration_scope: String,
    pub service_origin: String,
    pub chain_scope: String,
    pub account_id: String,
    pub institution: Institution,
    pub registration_context_hash: String,
    pub recovery_hash: String,
    pub state: State,
    pub version: u64,
    pub created_at_millis: u64,
    pub expires_at_millis: u64,
    pub human_verified_at_millis: Option<u64>,
    pub activation: Option<Activation>,
    pub attempt: Attempt,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Attempt {
    pub verification_id: String,
    pub page_hash: String,
    pub cdata: String,
    pub created_at_millis: u64,
    pub expires_at_millis: u64,
    pub token_hash: Option<String>,
    pub calls: u8,
    pub in_flight_until: u64,
    pub rejected: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Verification {
    pub verification_id: String,
    pub page_url: String,
    pub page_expires_at_millis: u64,
    pub action: String,
    pub hostname: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    pub protocol_version: u8,
    pub enrollment_id: String,
    pub registration_scope: String,
    pub service_origin: String,
    pub registration_context_hash: String,
    pub state: State,
    pub created_at_millis: u64,
    pub expires_at_millis: u64,
    pub human_verified_at_millis: Option<u64>,
    pub activation: Option<Activation>,
    pub verification: Option<Verification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_token: Option<String>,
}
pub fn version(v: u8) -> Result<()> {
    if v == 1 {
        Ok(())
    } else {
        Err(Error::new(400, "unsupported_registration_version"))
    }
}
pub fn context_bytes(config: &Config, input: &Prepare) -> Result<Vec<u8>> {
    config.validate()?;
    version(input.protocol_version)?;
    if !ids::hex(&input.chain_scope, 32, true) || !ids::hex(&input.account_id, 32, true) {
        return Err(Error::new(400, "invalid_registration_context"));
    }
    if input.chain_scope != config.chain_scope {
        return Err(Error::registration(
            403,
            "registration_context_mismatch",
            false,
            "prepare",
        ));
    }
    serde_json::to_vec(&serde_json::json!([
        1,
        "CitizenCidRegistration",
        config.registration_scope,
        config.service_origin,
        input.chain_scope,
        input.account_id,
        input.institution
    ]))
    .map_err(|_| Error::new(400, "invalid_registration_context"))
}
pub fn timestamp(now: u64, ttl: u64) -> Result<u64> {
    now.checked_add(ttl)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or(Error::new(400, "invalid_registration_request"))
}
impl Enrollment {
    pub fn check(&self, config: &Config, now: u64) -> Result<()> {
        if self.registration_scope != config.registration_scope
            || self.service_origin != config.service_origin
            || self.chain_scope != config.chain_scope
        {
            return Err(Error::registration(
                403,
                "registration_scope_mismatch",
                false,
                "prepare",
            ));
        }
        match self.state {
            State::Cancelled => Err(Error::registration(
                410,
                "registration_cancelled",
                false,
                "prepare",
            )),
            State::Expired => Err(Error::registration(
                410,
                "registration_expired",
                false,
                "prepare",
            )),
            State::Activated => Ok(()),
            _ if self.expires_at_millis <= now => Err(Error::registration(
                410,
                "registration_expired",
                false,
                "prepare",
            )),
            _ => Ok(()),
        }
    }
    pub fn recover(&self, token: &str) -> Result<()> {
        let hash = crypto::secret_hash(token)
            .map_err(|_| Error::new(401, "invalid_registration_recovery"))?;
        if crypto::equal_secret(hash.as_bytes(), self.recovery_hash.as_bytes()) {
            Ok(())
        } else {
            Err(Error::new(401, "invalid_registration_recovery"))
        }
    }
    pub fn response(&self) -> Response {
        Response {
            ok: true,
            protocol_version: 1,
            enrollment_id: self.enrollment_id.clone(),
            registration_scope: self.registration_scope.clone(),
            service_origin: self.service_origin.clone(),
            registration_context_hash: self.registration_context_hash.clone(),
            state: self.state,
            created_at_millis: self.created_at_millis,
            expires_at_millis: self.expires_at_millis,
            human_verified_at_millis: self.human_verified_at_millis,
            activation: self.activation.clone(),
            verification: None,
            recovery_token: None,
        }
    }
}
