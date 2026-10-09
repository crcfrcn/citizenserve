use super::{
    challenge::Consumption,
    mls_authentication::{Proof, Purpose},
};
use crate::{
    server::guard,
    shared::{crypto, ids, Error, Result},
    user::{identity::Identity, ports::AuthRepository, registration::protocol::Config},
};
use serde::{Deserialize, Serialize};
pub const TTL: u64 = 86_400_000;
pub const MAX_SESSIONS: u64 = 8;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub account_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub session_token_hash: String,
    pub cid_number: String,
    pub binding_revision: u64,
    pub account_id: String,
    pub device_id: String,
    pub created_at: u64,
    pub expires_at: u64,
}
#[derive(Serialize)]
pub struct Response {
    pub ok: bool,
    pub session_token: String,
    pub cid_number: String,
    pub binding_revision: u64,
    pub account_id: String,
    pub device_id: String,
    pub expires_at: u64,
}
pub fn hash(token: &str) -> Result<String> {
    let value = token
        .strip_prefix("sqs_")
        .ok_or(Error::new(401, "invalid_session"))?;
    if !ids::hex(value, 16, false) {
        return Err(Error::new(401, "invalid_session"));
    }
    Ok(crypto::sha256_hex(token.as_bytes()))
}
#[allow(clippy::too_many_arguments)]
pub async fn create<A: AuthRepository>(
    auth: &A,
    config: &Config,
    identity: &Identity,
    input: &Request,
    proof: &Proof,
    body: &[u8],
    target: &str,
    random: [u8; 16],
    now: u64,
) -> Result<Response> {
    if input.account_id != identity.account_id || proof.account_id != input.account_id {
        return Err(Error::new(401, "invalid_mls_proof"));
    }
    proof.verify_request(identity, &config.service_origin, "POST", target, body, now)?;
    let admission = auth
        .admission(&identity.cid_number)
        .await?
        .ok_or(Error::new(403, "registration_required"))?;
    let device = auth
        .device(&identity.cid_number, &proof.device_id)
        .await?
        .ok_or(Error::new(401, "device_not_registered"))?;
    guard::device_authority(
        identity,
        &admission,
        &device,
        config,
        &proof.public_key,
        now,
    )?;
    if !auth
        .consume(&Consumption {
            proof,
            purpose: Purpose::Session,
            session_token_hash: None,
            now,
        })
        .await?
    {
        return Err(Error::new(401, "invalid_mls_challenge"));
    }
    let token = format!("sqs_{}", crypto::hex(&random));
    let session = Session {
        session_token_hash: hash(&token)?,
        cid_number: identity.cid_number.clone(),
        binding_revision: identity.binding_revision,
        account_id: identity.account_id.clone(),
        device_id: proof.device_id.clone(),
        created_at: now,
        expires_at: now
            .checked_add(TTL)
            .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
            .ok_or(Error::new(503, "session_unavailable"))?,
    };
    auth.issue_session(&session, config, now).await?;
    Ok(Response {
        ok: true,
        session_token: token,
        cid_number: session.cid_number,
        binding_revision: session.binding_revision,
        account_id: session.account_id,
        device_id: session.device_id,
        expires_at: session.expires_at,
    })
}
