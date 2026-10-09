use super::{
    challenge::Consumption,
    mls_authentication::{self, Proof, Purpose},
};
use crate::{
    shared::{ids, Error, Result},
    user::{
        admission::Admission,
        identity::Identity,
        ports::AuthRepository,
        registration::{
            ports::Repository,
            protocol::{Activation, Config, Enrollment, State},
        },
    },
};
use serde::{Deserialize, Serialize};
fn required<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::deserialize(d)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub account_id: String,
    pub public_key: String,
    pub issued_at: u64,
    pub binding_signature: String,
    #[serde(deserialize_with = "required")]
    pub enrollment_id: Option<String>,
    #[serde(deserialize_with = "required")]
    pub recovery_token: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Device {
    pub cid_number: String,
    pub device_id: String,
    pub binding_revision: u64,
    pub account_id: String,
    pub public_key: String,
    pub issued_at: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}
impl Device {
    pub fn require(&self, i: &Identity, public: &str) -> Result<()> {
        if !self.active
            || self.cid_number != i.cid_number
            || self.account_id != i.account_id
            || self.binding_revision != i.binding_revision
            || self.public_key != public
            || self.device_id != public.strip_prefix("0x").unwrap_or("")
        {
            return Err(Error::new(401, "device_not_registered"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Commit {
    pub identity: Identity,
    pub device: Device,
    pub config: CommitConfig,
    pub enrollment: Option<Enrollment>,
    pub before_version: Option<u64>,
    pub now: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct CommitConfig {
    pub registration_scope: String,
    pub service_origin: String,
    pub chain_scope: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Registered {
    pub ok: bool,
    pub cid_number: String,
    pub binding_revision: u64,
    pub device_id: String,
}
/// 密码学验证先于挑战消费；消费之后的业务失败不恢复nonce。
#[allow(clippy::too_many_arguments)]
pub async fn register<A: AuthRepository, R: Repository>(
    auth: &A,
    registrations: &R,
    config: &Config,
    identity: &Identity,
    input: &Register,
    proof: &Proof,
    body: &[u8],
    target: &str,
    now: u64,
) -> Result<Registered> {
    identity.require_current(now)?;
    if identity.chain_scope != config.chain_scope
        || input.account_id != identity.account_id
        || proof.public_key != input.public_key
        || proof.account_id != input.account_id
    {
        return Err(Error::new(401, "invalid_mls_proof"));
    }
    if !ids::positive(input.issued_at) || input.issued_at > now.saturating_add(300_000) {
        return Err(Error::new(400, "invalid_device_binding"));
    }
    proof.verify_request(identity, &config.service_origin, "POST", target, body, now)?;
    let message = mls_authentication::device_binding_message(
        &identity.cid_number,
        identity.binding_revision,
        &input.account_id,
        &input.public_key,
        input.issued_at,
    )?;
    if !mls_authentication::verify_wallet(&message, &input.binding_signature, &input.account_id) {
        return Err(Error::new(401, "invalid_binding_signature"));
    }
    let old = auth.device(&identity.cid_number, &proof.device_id).await?;
    if let Some(old) = &old {
        if old.binding_revision > identity.binding_revision
            || (old.binding_revision == identity.binding_revision
                && old.issued_at > input.issued_at)
            || (!old.active
                && old.binding_revision == identity.binding_revision
                && old.issued_at >= input.issued_at)
        {
            return Err(Error::new(409, "stale_device_binding"));
        }
    }
    let activation = Activation {
        cid_number: identity.cid_number.clone(),
        account_id: identity.account_id.clone(),
        binding_revision: identity.binding_revision,
        device_id: proof.device_id.clone(),
        public_key: proof.public_key.clone(),
    };
    let (enrollment, before_version) = match (&input.enrollment_id, &input.recovery_token) {
        (Some(id), Some(token)) => {
            if !ids::uuid(id) {
                return Err(Error::new(401, "invalid_registration_recovery"));
            }
            let mut row = registrations
                .read(id)
                .await?
                .ok_or(Error::new(401, "invalid_registration_recovery"))?;
            row.recover(token)?;
            row.check(config, now)?;
            if row.account_id != identity.account_id || row.institution != identity.institution {
                return Err(Error::registration(
                    403,
                    "registration_context_mismatch",
                    false,
                    "prepare",
                ));
            }
            let version = row.version;
            match row.state {
                State::HumanVerified if row.human_verified_at_millis.is_some() => {
                    row.state = State::Activated;
                    row.activation = Some(activation.clone());
                    row.version += 1;
                }
                State::Activated if row.activation.as_ref() == Some(&activation) => {}
                State::Activated => {
                    return Err(Error::registration(
                        409,
                        "registration_activation_conflict",
                        false,
                        "read_status",
                    ))
                }
                _ => return Err(Error::new(403, "registration_required")),
            }
            (Some(row), Some(version))
        }
        (None, None) => {
            auth.admission(&identity.cid_number)
                .await?
                .ok_or(Error::new(403, "registration_required"))?
                .require(identity, config)?;
            (None, None)
        }
        _ => return Err(Error::new(400, "invalid_registration_request")),
    };
    if !auth
        .consume(&Consumption {
            proof,
            purpose: Purpose::Registration,
            session_token_hash: None,
            now,
        })
        .await?
    {
        return Err(Error::new(401, "invalid_mls_challenge"));
    }
    let device = Device {
        cid_number: identity.cid_number.clone(),
        device_id: proof.device_id.clone(),
        binding_revision: identity.binding_revision,
        account_id: input.account_id.clone(),
        public_key: input.public_key.clone(),
        issued_at: input.issued_at,
        created_at: old.as_ref().map(|d| d.created_at).unwrap_or(now),
        updated_at: now,
        active: true,
    };
    let commit = Commit {
        identity: identity.clone(),
        device,
        config: CommitConfig {
            registration_scope: config.registration_scope.clone(),
            service_origin: config.service_origin.clone(),
            chain_scope: config.chain_scope.clone(),
        },
        enrollment,
        before_version,
        now,
    };
    auth.activate(&commit).await?;
    Ok(Registered {
        ok: true,
        cid_number: activation.cid_number,
        binding_revision: activation.binding_revision,
        device_id: activation.device_id,
    })
}
pub fn admission_for(commit: &Commit) -> Option<Admission> {
    let e = commit.enrollment.as_ref()?;
    Some(Admission {
        cid_number: commit.identity.cid_number.clone(),
        enrollment_id: e.enrollment_id.clone(),
        source: "turnstile".into(),
        human_verified_at_millis: e.human_verified_at_millis?,
        registration_scope: e.registration_scope.clone(),
        service_origin: e.service_origin.clone(),
        chain_scope: e.chain_scope.clone(),
        institution: e.institution,
    })
}
