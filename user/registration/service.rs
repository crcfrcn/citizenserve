use super::protocol::*;
use crate::shared::{crypto, ids, Error, Result};

/// 随机数由平台CSPRNG交付，各用途独立抽取，不从账户/CID/时钟派生。
pub struct Entropy {
    pub enrollment: [u8; 16],
    pub verification: [u8; 16],
    pub recovery: [u8; 32],
    pub page: [u8; 32],
    pub nonce: [u8; 32],
}
pub struct PageEntropy {
    pub verification: [u8; 16],
    pub page: [u8; 32],
    pub nonce: [u8; 32],
}
fn new_attempt(entropy: PageEntropy, now: u64, deadline: u64) -> Result<(Attempt, String)> {
    let page = crypto::base64url(&entropy.page);
    Ok((
        Attempt {
            verification_id: ids::uuid_from_random(entropy.verification),
            page_hash: crypto::secret_hash(&page)?,
            cdata: crypto::hex(&entropy.nonce),
            created_at_millis: now,
            expires_at_millis: timestamp(now, PAGE_TTL)?.min(deadline),
            token_hash: None,
            calls: 0,
            in_flight_until: 0,
            rejected: false,
        },
        page,
    ))
}
fn verification(config: &Config, attempt: &Attempt, page: &str) -> Verification {
    Verification {
        verification_id: attempt.verification_id.clone(),
        page_url: format!(
            "{}/api/user/registration/page?verification_id={}&page_token={}",
            config.service_origin, attempt.verification_id, page
        ),
        page_expires_at_millis: attempt.expires_at_millis,
        action: ACTION.to_owned(),
        hostname: config.hostname(),
    }
}
pub fn prepare(
    config: &Config,
    input: &Prepare,
    entropy: Entropy,
    now: u64,
) -> Result<(Enrollment, Response)> {
    let context = context_bytes(config, input)?;
    let recovery = crypto::base64url(&entropy.recovery);
    let deadline = timestamp(now, PREPARED_TTL)?;
    let (attempt, page) = new_attempt(
        PageEntropy {
            verification: entropy.verification,
            page: entropy.page,
            nonce: entropy.nonce,
        },
        now,
        deadline,
    )?;
    let row = Enrollment {
        enrollment_id: ids::uuid_from_random(entropy.enrollment),
        registration_scope: config.registration_scope.clone(),
        service_origin: config.service_origin.clone(),
        chain_scope: input.chain_scope.clone(),
        account_id: input.account_id.clone(),
        institution: input.institution,
        registration_context_hash: format!("0x{}", crypto::sha256_hex(&context)),
        recovery_hash: crypto::secret_hash(&recovery)?,
        state: State::Prepared,
        version: 0,
        created_at_millis: now,
        expires_at_millis: deadline,
        human_verified_at_millis: None,
        activation: None,
        attempt,
    };
    let mut response = row.response();
    response.recovery_token = Some(recovery);
    response.verification = Some(verification(config, &row.attempt, &page));
    Ok((row, response))
}
pub fn refresh(
    row: &mut Enrollment,
    config: &Config,
    entropy: PageEntropy,
    now: u64,
) -> Result<Response> {
    row.check(config, now)?;
    if row.state != State::Prepared {
        return Err(Error::registration(
            409,
            "registration_already_activated",
            false,
            "read_status",
        ));
    }
    let (attempt, page) = new_attempt(entropy, now, row.expires_at_millis)?;
    row.attempt = attempt;
    row.version += 1;
    let mut response = row.response();
    response.verification = Some(verification(config, &row.attempt, &page));
    Ok(response)
}
pub fn cancel(row: &mut Enrollment, config: &Config, now: u64) -> Result<()> {
    row.check(config, now)?;
    if row.state == State::Activated {
        return Err(Error::registration(
            409,
            "registration_already_activated",
            false,
            "read_status",
        ));
    }
    row.state = State::Cancelled;
    row.version += 1;
    Ok(())
}
pub fn page(row: &Enrollment, config: &Config, page_token: &str, now: u64) -> Result<()> {
    row.check(config, now)?;
    if row.state != State::Prepared || row.attempt.expires_at_millis <= now {
        return Err(Error::new(401, "invalid_verification_capability"));
    }
    let hash = crypto::secret_hash(page_token)
        .map_err(|_| Error::new(401, "invalid_verification_capability"))?;
    if !crypto::equal_secret(hash.as_bytes(), row.attempt.page_hash.as_bytes()) {
        return Err(Error::new(401, "invalid_verification_capability"));
    }
    Ok(())
}

/// 平台必须先持久CAS此变更，再调用Siteverify；并发请求不能同时领取一次外部调用。
pub fn claim(row: &mut Enrollment, config: &Config, input: &Verify, now: u64) -> Result<bool> {
    version(input.protocol_version)?;
    row.recover(&input.recovery_token)?;
    row.check(config, now)?;
    if row.attempt.verification_id != input.verification_id {
        return Err(Error::registration(
            403,
            "registration_context_mismatch",
            false,
            "prepare",
        ));
    }
    if matches!(row.state, State::HumanVerified | State::Activated) {
        return Ok(false);
    }
    if row.attempt.rejected || row.attempt.calls >= 3 || row.attempt.expires_at_millis <= now {
        return Err(Error::registration(
            403,
            "turnstile_failed",
            true,
            "refresh_verification",
        ));
    }
    if row.attempt.in_flight_until > now {
        return Err(Error::registration(
            409,
            "verification_in_progress",
            true,
            "read_status",
        ));
    }
    let token = input
        .turnstile_token
        .as_ref()
        .filter(|s| !s.is_empty() && s.len() <= 2048)
        .ok_or(Error::new(400, "invalid_registration_request"))?;
    let hash = crypto::sha256_hex(token.as_bytes());
    if row
        .attempt
        .token_hash
        .as_ref()
        .is_some_and(|old| old != &hash)
    {
        return Err(Error::registration(
            403,
            "turnstile_failed",
            true,
            "refresh_verification",
        ));
    }
    row.attempt.token_hash = Some(hash);
    row.attempt.calls += 1;
    // 网络超时10秒，保留额外1秒给调用取消及结果落库，租约不延长页面或登记期限。
    row.attempt.in_flight_until = timestamp(now, 11_000)?;
    row.version += 1;
    Ok(true)
}
#[derive(Clone, Debug)]
pub struct SiteverifyResult {
    pub http_ok: bool,
    pub success: bool,
    pub action: String,
    pub hostname: String,
    pub cdata: String,
    pub challenge_at_millis: u64,
}
pub fn save_verification(
    row: &mut Enrollment,
    config: &Config,
    result: Option<&SiteverifyResult>,
    now: u64,
) -> Result<()> {
    row.check(config, now)?;
    if row.state != State::Prepared {
        return Ok(());
    }
    row.attempt.in_flight_until = 0;
    row.version += 1;
    let Some(result) = result else {
        return Err(Error::registration(
            503,
            "turnstile_unavailable",
            true,
            "read_status",
        ));
    };
    let valid = result.http_ok
        && result.success
        && result.action == ACTION
        && result.hostname == config.hostname()
        && result.cdata == row.attempt.cdata
        && result.challenge_at_millis <= now.saturating_add(30_000)
        && result.challenge_at_millis.saturating_add(30_000) >= row.attempt.created_at_millis
        && result.challenge_at_millis < row.expires_at_millis
        && now < row.attempt.expires_at_millis;
    if !valid {
        row.attempt.rejected = true;
        return Err(Error::registration(
            403,
            "turnstile_failed",
            true,
            "refresh_verification",
        ));
    }
    row.state = State::HumanVerified;
    row.human_verified_at_millis = Some(now);
    row.expires_at_millis = timestamp(row.created_at_millis, VERIFIED_TTL)?;
    Ok(())
}
