use super::mls_authentication::{ChallengeRequest, Proof, Purpose};
use crate::{
    shared::{crypto, Error, Result},
    user::{identity::Identity, routes::UserRoute},
};
use serde::{Deserialize, Serialize};
pub const TTL: u64 = 300_000;
pub const MAX_PENDING: u64 = 64;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Challenge {
    pub ok: bool,
    pub user_id: String,
    pub device_id: String,
    pub public_key: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub service_origin: String,
    pub challenge: String,
    pub expires_at_millis: u64,
    pub method: String,
    pub request_target: String,
    pub body_sha256: String,
    #[serde(skip)]
    pub purpose: Option<Purpose>,
    #[serde(skip)]
    pub session_token_hash: Option<String>,
    #[serde(skip)]
    pub created_at: u64,
}
pub fn target(request: &ChallengeRequest) -> Result<()> {
    request.validate()?;
    match request.purpose {
        Purpose::Registration
            if request.method == "POST"
                && request.request_target == UserRoute::Devices.external() =>
        {
            Ok(())
        }
        Purpose::Session
            if request.method == "POST"
                && request.request_target == UserRoute::Sessions.external() =>
        {
            Ok(())
        }
        Purpose::Request => {
            crate::server::routes::protected_target(&request.method, &request.request_target)
                .map_err(|_| Error::new(400, "invalid_mls_target"))?;
            if matches!(request.method.as_str(), "GET" | "DELETE")
                && request.body_sha256 != format!("0x{}", crypto::sha256_hex(b""))
            {
                return Err(Error::new(400, "invalid_mls_target"));
            }
            Ok(())
        }
        _ => Err(Error::new(400, "invalid_mls_target")),
    }
}
pub fn issue(
    identity: &Identity,
    origin: &str,
    request: &ChallengeRequest,
    random: [u8; 32],
    session_hash: Option<String>,
    now: u64,
) -> Result<Challenge> {
    identity.require_current(now)?;
    target(request)?;
    if request.account_id != identity.account_id {
        return Err(Error::new(401, "cid_binding_changed"));
    }
    if (request.purpose == Purpose::Request) != session_hash.is_some() {
        return Err(Error::new(401, "invalid_session"));
    }
    Ok(Challenge {
        ok: true,
        user_id: identity.cid_number.clone(),
        device_id: request.public_key[2..].into(),
        public_key: request.public_key.clone(),
        account_id: identity.account_id.clone(),
        binding_revision: identity.binding_revision,
        service_origin: origin.into(),
        challenge: format!("0x{}", crypto::hex(&random)),
        expires_at_millis: now
            .checked_add(TTL)
            .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
            .ok_or(Error::new(400, "invalid_mls_challenge"))?,
        method: request.method.clone(),
        request_target: request.request_target.clone(),
        body_sha256: request.body_sha256.clone(),
        purpose: Some(request.purpose),
        session_token_hash: session_hash,
        created_at: now,
    })
}
#[derive(Clone, Debug, Serialize)]
pub struct Consumption<'a> {
    pub proof: &'a Proof,
    pub purpose: Purpose,
    pub session_token_hash: Option<&'a str>,
    pub now: u64,
}
