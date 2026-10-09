use crate::shared::{crypto, ids, Error, Result, MAX_SAFE_INTEGER, MIB};
use crate::user::identity::Identity;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
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
    pub signature: String,
}
fn invalid() -> Error {
    Error::new(401, "invalid_mls_proof")
}
pub fn target(method: &str, value: &str) -> Result<()> {
    if !matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) || value.len() > 8192
        || !value.starts_with('/')
        || value.starts_with("//")
        || !value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'#' && b != b'\\')
    {
        return Err(invalid());
    }
    let bytes = value.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(invalid());
        }
    }
    Ok(())
}
impl Proof {
    pub fn validate(&self) -> Result<()> {
        ids::cid(&self.user_id).map_err(|_| invalid())?;
        ids::account(&self.account_id).map_err(|_| invalid())?;
        if !ids::hex(&self.public_key, 32, true)
            || self.device_id != self.public_key[2..]
            || !ids::positive(self.binding_revision)
            || !ids::positive(self.expires_at_millis)
            || !ids::hex(&self.challenge, 32, true)
            || !ids::hex(&self.body_sha256, 32, true)
            || !ids::hex(&self.signature, 64, true)
        {
            return Err(invalid());
        }
        ids::origin(&self.service_origin).map_err(|_| invalid())?;
        target(&self.method, &self.request_target)
    }
    pub fn message(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut content = crypto::tls_vector(self.user_id.as_bytes())?;
        content.extend(crypto::unhex(&self.device_id)?);
        content.extend(crypto::unhex(&self.account_id)?);
        content.extend(self.binding_revision.to_be_bytes());
        content.extend(crypto::tls_vector(self.service_origin.as_bytes())?);
        content.extend(crypto::unhex(&self.challenge)?);
        content.extend(self.expires_at_millis.to_be_bytes());
        content.extend(crypto::tls_vector(self.method.as_bytes())?);
        content.extend(crypto::tls_vector(self.request_target.as_bytes())?);
        content.extend(crypto::unhex(&self.body_sha256)?);
        let mut message = crypto::tls_vector(b"MLS 1.0 TataChatAuthentication")?;
        message.extend(crypto::tls_vector(&content)?);
        Ok(message)
    }
    pub fn verify_signature(&self) -> Result<()> {
        let public: [u8; 32] = crypto::unhex(&self.public_key)?
            .try_into()
            .map_err(|_| invalid())?;
        let sig = Signature::from_slice(&crypto::unhex(&self.signature)?).map_err(|_| invalid())?;
        VerifyingKey::from_bytes(&public)
            .map_err(|_| invalid())?
            .verify_strict(&self.message()?, &sig)
            .map_err(|_| Error::new(401, "invalid_mls_signature"))
    }
    /// 此函数验请求与持钥证明；数据库仍须原子核对当前绑定/设备并一次性消费挑战。
    pub fn verify_request(
        &self,
        identity: &Identity,
        origin: &str,
        method: &str,
        request_target: &str,
        body: &[u8],
        now: u64,
    ) -> Result<()> {
        self.validate()?;
        if self.expires_at_millis <= now || self.expires_at_millis > now.saturating_add(300_000) {
            return Err(Error::new(401, "invalid_mls_challenge"));
        }
        if body.len() > 2 * MIB
            || self.service_origin != origin
            || self.method != method
            || self.request_target != request_target
            || self.body_sha256 != format!("0x{}", crypto::sha256_hex(body))
        {
            return Err(invalid());
        }
        identity.matches(&self.user_id, &self.account_id, self.binding_revision)?;
        self.verify_signature()
    }
}
pub fn read(encoded: &str) -> Result<Proof> {
    let bytes = crypto::unbase64url(encoded, 16 * 1024).map_err(|_| invalid())?;
    // 保留JSON原键序后重编码，接受既有任意字段顺序，拒绝重复键、空白及非规范表示。
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if serde_json::to_vec(&value).map_err(|_| invalid())? != bytes {
        return Err(invalid());
    }
    let proof: Proof = serde_json::from_value(value).map_err(|_| invalid())?;
    proof.validate()?;
    Ok(proof)
}
pub fn device_binding_message(
    cid: &str,
    revision: u64,
    account: &str,
    public_key: &str,
    issued_at: u64,
) -> Result<[u8; 32]> {
    ids::cid(cid)?;
    ids::account(account)?;
    if !ids::positive(revision) || !ids::positive(issued_at) || !ids::hex(public_key, 32, true) {
        return Err(invalid());
    }
    let mut payload = crypto::scale_string(cid)?;
    payload.extend(revision.to_le_bytes());
    payload.extend(crypto::scale_string(account)?);
    payload.extend(crypto::scale_string(public_key)?);
    payload.extend(issued_at.to_le_bytes());
    Ok(crypto::signing_message(0x1c, &payload))
}
pub fn verify_wallet(message: &[u8; 32], signature: &str, account: &str) -> bool {
    // 公民主账户使用Sr25519及Substrate签名上下文，不将MLS公钥用作钱包公钥。
    (|| -> Option<bool> {
        if !ids::hex(signature, 64, true) || !ids::hex(account, 32, true) {
            return None;
        }
        let key = schnorrkel::PublicKey::from_bytes(&crypto::unhex(account).ok()?).ok()?;
        let sig = schnorrkel::Signature::from_bytes(&crypto::unhex(signature).ok()?).ok()?;
        Some(key.verify_simple(b"substrate", message, &sig).is_ok())
    })()
    .unwrap_or(false)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Session,
    Request,
    Registration,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    pub account_id: String,
    pub public_key: String,
    pub purpose: Purpose,
    pub method: String,
    pub request_target: String,
    pub body_sha256: String,
}
impl ChallengeRequest {
    pub fn validate(&self) -> Result<()> {
        ids::account(&self.account_id).map_err(|_| invalid())?;
        if !ids::hex(&self.public_key, 32, true) || !ids::hex(&self.body_sha256, 32, true) {
            return Err(invalid());
        }
        target(&self.method, &self.request_target)
    }
}
pub fn timestamp(value: u64) -> Result<()> {
    if value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(invalid())
    }
}
