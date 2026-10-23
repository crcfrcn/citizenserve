use super::{
    challenge::Consumption,
    mls_authentication::{Proof, Purpose},
};
use crate::{
    gate,
    shared::{crypto, ids, Error, Result},
    user::{ports::AuthRepository, registration::protocol::Config},
};
use serde::{Deserialize, Serialize};
pub const TTL: u64 = 86_400_000;
pub const MAX_SESSIONS: u64 = 8;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub account_id: String,
}
/// Session挑战只使用当前App已有的单字段紧凑正文；验签仍针对实际原始字节。
pub(super) fn canonical_body(account: &str) -> Result<Vec<u8>> {
    ids::account(account)?;
    serde_json::to_vec(&serde_json::json!({"account_id":account}))
        .map_err(|_| Error::new(400, "invalid_mls_target"))
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
    context: &crate::user::ports::AuthContext,
    input: &Request,
    proof: &Proof,
    body: &[u8],
    target: &str,
    random: [u8; 16],
    now: u64,
) -> Result<Response> {
    let identity = &context.identity;
    gate::identity::service_device_authority(context, config, now)?;
    let device = context
        .device
        .as_ref()
        .ok_or(Error::new(401, "device_not_registered"))?;
    if proof.device_id != device.device_id
        || proof.public_key != device.public_key
        || input.account_id != identity.account_id
        || proof.account_id != input.account_id
    {
        return Err(Error::new(401, "invalid_mls_proof"));
    }
    proof.verify_request(identity, &config.service_origin, "POST", target, body, now)?;
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
