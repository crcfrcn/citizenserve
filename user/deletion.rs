//! 注销只清理该CID的云与聊天数据；链身份、钱包和永久金融证据不属于删除目标。
use crate::{
    shared::{crypto, ids, Error, Result},
    user::{identity::Identity, profile_service::Authorization, registration::protocol::Config},
};
use serde::{Deserialize, Serialize};
use std::future::Future;
pub const TTL: u64 = 300_000;
pub const OP_TAG: u8 = 0x1d;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Delete,
    Status,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Challenge {
    pub ok: bool,
    pub purpose: Purpose,
    pub challenge_id: String,
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub chain_scope: String,
    pub service_origin: String,
    pub expires_at_millis: u64,
    pub signing_payload_hex: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subject {
    pub cid_number: String,
    pub account_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    pub challenge_id: String,
    pub signature: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Absent,
    Pending,
    Complete,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub ok: bool,
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub deletion_id: Option<String>,
    pub state: State,
}
impl Receipt {
    pub fn validate(&self, identity: &Identity) -> Result<()> {
        identity.matches(&self.cid_number, &self.account_id, self.binding_revision)?;
        if !self.ok
            || (self.state == State::Absent) != self.deletion_id.is_none()
            || self
                .deletion_id
                .as_ref()
                .is_some_and(|id| !ids::hex(id, 32, false))
        {
            return Err(Error::new(503, "account_deletion_receipt_invalid"));
        }
        Ok(())
    }
}
pub trait Repository {
    fn issue(&self, challenge: &Challenge, now: u64) -> impl Future<Output = Result<()>> + Send;
    fn challenge(&self, id: &str) -> impl Future<Output = Result<Option<Challenge>>> + Send;
    /// nonce消费和冻结/会话撤销在同一事务，必须再次核对MLS授权与当前绑定。
    fn begin(
        &self,
        auth: &Authorization,
        challenge: &Challenge,
    ) -> impl Future<Output = Result<Receipt>> + Send;
    /// 查询只消费status nonce，不能创建、推进或取消删除任务。
    fn status(
        &self,
        challenge: &Challenge,
        now: u64,
    ) -> impl Future<Output = Result<Receipt>> + Send;
}
/// 本地构造完整SCALE合同；服务端和App都不能直接签不透明的任意payload。
pub fn payload(c: &Challenge) -> Result<Vec<u8>> {
    ids::cid(&c.cid_number)?;
    ids::account(&c.account_id)?;
    if !ids::hex(&c.chain_scope, 32, true)
        || !ids::hex(&c.challenge_id, 32, false)
        || !ids::positive(c.binding_revision)
        || !ids::positive(c.expires_at_millis)
    {
        return Err(Error::new(400, "account_deletion_challenge_invalid"));
    }
    let mut out = crypto::scale_string("citizenserve.account_deletion")?;
    out.extend(crypto::scale_string(&c.service_origin)?);
    out.extend(crypto::unhex(&c.chain_scope)?);
    out.extend(crypto::scale_string(&c.cid_number)?);
    out.extend(crypto::unhex(&c.account_id)?);
    out.extend(c.binding_revision.to_le_bytes());
    out.push(if c.purpose == Purpose::Delete { 0 } else { 1 });
    out.extend(crypto::unhex(&c.challenge_id)?);
    out.extend(c.expires_at_millis.to_le_bytes());
    Ok(out)
}
pub async fn issue<R: Repository>(
    repo: &R,
    config: &Config,
    identity: &Identity,
    purpose: Purpose,
    entropy: [u8; 32],
    now: u64,
) -> Result<Challenge> {
    identity.require_current(now)?;
    config.validate()?;
    if identity.chain_scope != config.chain_scope {
        return Err(Error::new(401, "cid_binding_changed"));
    }
    let mut c = Challenge {
        ok: true,
        purpose,
        challenge_id: crypto::hex(&entropy),
        cid_number: identity.cid_number.clone(),
        account_id: identity.account_id.clone(),
        binding_revision: identity.binding_revision,
        chain_scope: config.chain_scope.clone(),
        service_origin: config.service_origin.clone(),
        expires_at_millis: now
            .checked_add(TTL)
            .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
            .ok_or(Error::new(400, "account_deletion_challenge_invalid"))?,
        signing_payload_hex: String::new(),
    };
    c.signing_payload_hex = format!("0x{}", crypto::hex(&payload(&c)?));
    repo.issue(&c, now).await?;
    Ok(c)
}
/// 钱包签名、用途、绑定和期限全部通过后才允许事务消费nonce。
pub async fn verify<R: Repository>(
    repo: &R,
    config: &Config,
    identity: &Identity,
    input: &Signed,
    purpose: Purpose,
    now: u64,
) -> Result<Challenge> {
    identity.require_current(now)?;
    config.validate()?;
    if !ids::hex(&input.challenge_id, 32, false) {
        return Err(Error::new(401, "account_deletion_challenge_invalid"));
    }
    let c = repo
        .challenge(&input.challenge_id)
        .await?
        .ok_or(Error::new(401, "account_deletion_challenge_invalid"))?;
    identity.matches(&c.cid_number, &c.account_id, c.binding_revision)?;
    if !c.ok
        || c.challenge_id != input.challenge_id
        || identity.chain_scope != config.chain_scope
        || c.purpose != purpose
        || c.chain_scope != config.chain_scope
        || c.service_origin != config.service_origin
        || c.expires_at_millis <= now
        || c.expires_at_millis > now.saturating_add(TTL)
    {
        return Err(Error::new(401, "account_deletion_challenge_invalid"));
    }
    let bytes = payload(&c)?;
    if c.signing_payload_hex != format!("0x{}", crypto::hex(&bytes))
        || !crate::user::auth::mls_authentication::verify_wallet(
            &crypto::signing_message(OP_TAG, &bytes),
            &input.signature,
            &c.account_id,
        )
    {
        return Err(Error::new(401, "account_deletion_signature_invalid"));
    }
    Ok(c)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Challenge {
        Challenge {
            ok: true,
            purpose: Purpose::Delete,
            challenge_id: "11".repeat(32),
            cid_number: "CN220-CTZN2-198805200-2026".into(),
            account_id: format!("0x{}", "22".repeat(32)),
            binding_revision: 1,
            chain_scope: format!("0x{}", "33".repeat(32)),
            service_origin: "https://www.crcfrcn.com".into(),
            expires_at_millis: 1800000000000,
            signing_payload_hex: String::new(),
        }
    }
    #[test]
    fn signature_scope_binds_every_subject_and_purpose() {
        let c = sample();
        let original = payload(&c).unwrap();
        let mut variants = Vec::new();
        let mut x = c.clone();
        x.purpose = Purpose::Status;
        variants.push(x);
        let mut x = c.clone();
        x.binding_revision = 2;
        variants.push(x);
        let mut x = c.clone();
        x.cid_number = "OTHER-CID".into();
        variants.push(x);
        let mut x = c.clone();
        x.service_origin = "https://other.test".into();
        variants.push(x);
        let mut x = c.clone();
        x.expires_at_millis += 1;
        variants.push(x);
        for x in variants {
            assert_ne!(original, payload(&x).unwrap());
        }
        assert_ne!(
            crypto::signing_message(OP_TAG, &original),
            crypto::signing_message(0x1c, &original)
        );
    }
    #[test]
    fn payload_rejects_noncanonical_account_nonce_and_revision() {
        let mut c = sample();
        c.account_id = format!("0x{}", "AA".repeat(32));
        assert!(payload(&c).is_err());
        let mut c = sample();
        c.challenge_id = "../other".into();
        assert!(payload(&c).is_err());
        let mut c = sample();
        c.binding_revision = 0;
        assert!(payload(&c).is_err());
    }

    struct Memory(std::sync::Mutex<Option<Challenge>>);
    impl Repository for Memory {
        async fn issue(&self, c: &Challenge, _: u64) -> Result<()> {
            *self.0.lock().unwrap() = Some(c.clone());
            Ok(())
        }
        async fn challenge(&self, id: &str) -> Result<Option<Challenge>> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .as_ref()
                .filter(|c| c.challenge_id == id)
                .cloned())
        }
        async fn begin(&self, _: &Authorization, _: &Challenge) -> Result<Receipt> {
            panic!("verification cannot submit")
        }
        async fn status(&self, _: &Challenge, _: u64) -> Result<Receipt> {
            panic!("verification cannot consume")
        }
    }
    fn run<F: std::future::Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        match f.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(v) => v,
            _ => panic!("memory resolves immediately"),
        }
    }
    #[test]
    fn real_wallet_signature_is_purpose_bound_and_corrupt_payload_never_submits() {
        let wallet = schnorrkel::MiniSecretKey::from_bytes(&[31; 32])
            .unwrap()
            .expand_to_keypair(schnorrkel::ExpansionMode::Ed25519);
        let mut identity: Identity =
            serde_json::from_str(include_str!("../test/contract/finalized_identity.json")).unwrap();
        let now = 1_000_003;
        identity.account_id = format!("0x{}", crypto::hex(&wallet.public.to_bytes()));
        identity.checked_at_millis = now;
        identity.verification_deadline_millis = now + 60000;
        identity.authoritative_current = true;
        let config = Config {
            registration_scope: "citizenserve:fixture".into(),
            service_origin: "https://registration.example.test".into(),
            chain_scope: identity.chain_scope.clone(),
            site_key: "fixture".into(),
        };
        let repo = Memory(std::sync::Mutex::new(None));
        let c = run(issue(
            &repo,
            &config,
            &identity,
            Purpose::Delete,
            [1; 32],
            now,
        ))
        .unwrap();
        let signed = Signed {
            challenge_id: c.challenge_id.clone(),
            signature: format!(
                "0x{}",
                crypto::hex(
                    &wallet
                        .sign_simple(
                            b"substrate",
                            &crypto::signing_message(OP_TAG, &payload(&c).unwrap())
                        )
                        .to_bytes()
                )
            ),
        };
        assert!(run(verify(
            &repo,
            &config,
            &identity,
            &signed,
            Purpose::Delete,
            now
        ))
        .is_ok());
        assert!(run(verify(
            &repo,
            &config,
            &identity,
            &signed,
            Purpose::Status,
            now
        ))
        .is_err());
        repo.0.lock().unwrap().as_mut().unwrap().signing_payload_hex = "0x00".into();
        assert!(run(verify(
            &repo,
            &config,
            &identity,
            &signed,
            Purpose::Delete,
            now
        ))
        .is_err());
        *repo.0.lock().unwrap() = None;
        assert!(run(verify(
            &repo,
            &config,
            &identity,
            &signed,
            Purpose::Delete,
            now
        ))
        .is_err());
    }
}
