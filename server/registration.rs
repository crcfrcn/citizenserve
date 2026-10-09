use crate::{
    shared::{ids, Error, Result},
    user::registration::{ports::Repository, protocol::*, service},
};

pub trait Runtime {
    fn now(&self) -> u64;
    fn entropy(&self) -> Result<service::Entropy>;
    fn page_entropy(&self) -> Result<service::PageEntropy>;
    fn siteverify(
        &self,
        input: &Verify,
        cdata: &str,
    ) -> impl std::future::Future<Output = Result<Option<service::SiteverifyResult>>> + Send;
}
fn unavailable() -> Error {
    Error::registration(503, "registration_unavailable", true, "read_status")
}
async fn recover<R: Repository>(
    repo: &R,
    config: &Config,
    id: &str,
    token: &str,
    now: u64,
) -> Result<Enrollment> {
    if !ids::uuid(id) {
        return Err(Error::new(400, "invalid_registration_request"));
    }
    let row = repo
        .read(id)
        .await?
        .ok_or(Error::new(401, "invalid_registration_recovery"))?;
    row.recover(token)?;
    row.check(config, now)?;
    Ok(row)
}
pub async fn prepare<R: Repository, T: Runtime>(
    repo: &R,
    runtime: &T,
    config: &Config,
    input: Prepare,
) -> Result<Response> {
    let now = runtime.now();
    let (row, response) = service::prepare(config, &input, runtime.entropy()?, now)?;
    if !repo.create(&row, now).await? {
        return Err(Error::registration(
            429,
            "registration_capacity_exceeded",
            true,
            "retry",
        ));
    }
    Ok(response)
}
pub async fn status<R: Repository, T: Runtime>(
    repo: &R,
    runtime: &T,
    config: &Config,
    input: Status,
) -> Result<Response> {
    version(input.protocol_version)?;
    let now = runtime.now();
    let before = recover(
        repo,
        config,
        &input.enrollment_id,
        &input.recovery_token,
        now,
    )
    .await?;
    let mut after = before.clone();
    let response = match input.operation {
        Operation::Read => return Ok(before.response()),
        Operation::Cancel => {
            service::cancel(&mut after, config, now)?;
            after.response()
        }
        Operation::RefreshVerification => {
            service::refresh(&mut after, config, runtime.page_entropy()?, now)?
        }
    };
    if !repo.compare_and_swap(&before, &after, now).await? {
        return Err(Error::registration(
            409,
            "verification_in_progress",
            true,
            "read_status",
        ));
    }
    Ok(response)
}
pub async fn verify<R: Repository, T: Runtime>(
    repo: &R,
    runtime: &T,
    config: &Config,
    input: Verify,
) -> Result<Response> {
    version(input.protocol_version)?;
    let now = runtime.now();
    let before = recover(
        repo,
        config,
        &input.enrollment_id,
        &input.recovery_token,
        now,
    )
    .await?;
    let mut claimed = before.clone();
    if !service::claim(&mut claimed, config, &input, now)? {
        return Ok(claimed.response());
    }
    if !repo.compare_and_swap(&before, &claimed, now).await? {
        return read_concurrent_success(repo, config, &input, runtime.now()).await;
    }
    let external = runtime
        .siteverify(&input, &claimed.attempt.cdata)
        .await
        .unwrap_or(None);
    let finish_at = runtime.now();
    let current = recover(
        repo,
        config,
        &input.enrollment_id,
        &input.recovery_token,
        finish_at,
    )
    .await?;
    // 旧调用在刷新后的结果一律丢弃；不能覆盖新的页面能力或另一个调用的领取。
    if current.attempt.verification_id != claimed.attempt.verification_id
        || current.version != claimed.version
    {
        return read_concurrent_success(repo, config, &input, finish_at).await;
    }
    let mut after = current.clone();
    let result = service::save_verification(&mut after, config, external.as_ref(), finish_at);
    if !repo.compare_and_swap(&current, &after, finish_at).await? {
        return read_concurrent_success(repo, config, &input, runtime.now()).await;
    }
    result?;
    Ok(after.response())
}
async fn read_concurrent_success<R: Repository>(
    repo: &R,
    config: &Config,
    input: &Verify,
    now: u64,
) -> Result<Response> {
    let row = recover(
        repo,
        config,
        &input.enrollment_id,
        &input.recovery_token,
        now,
    )
    .await?;
    if row.attempt.verification_id == input.verification_id
        && matches!(row.state, State::HumanVerified | State::Activated)
    {
        Ok(row.response())
    } else {
        Err(Error::registration(
            409,
            "verification_in_progress",
            true,
            "read_status",
        ))
    }
}
pub async fn page<R: Repository>(
    repo: &R,
    config: &Config,
    verification_id: &str,
    token: &str,
    now: u64,
) -> Result<Enrollment> {
    if !ids::uuid(verification_id) {
        return Err(Error::new(401, "invalid_verification_capability"));
    }
    let row = repo
        .read_attempt(verification_id)
        .await?
        .ok_or(Error::new(401, "invalid_verification_capability"))?;
    service::page(&row, config, token, now)?;
    Ok(row)
}
/// 页面能力与恢复能力分离，页面只发送token及attempt ID，不获得账户授权。
pub fn page_html(config: &Config, row: &Enrollment, script_nonce: &str) -> Result<String> {
    if !ids::hex(script_nonce, 32, false) {
        return Err(unavailable());
    }
    let site = serde_json::to_string(&config.site_key).map_err(|_| unavailable())?;
    let cdata = serde_json::to_string(&row.attempt.cdata).map_err(|_| unavailable())?;
    let id = serde_json::to_string(&row.attempt.verification_id).map_err(|_| unavailable())?;
    Ok(format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公民注册验证</title></head><body><div id="challenge"></div><script nonce="{script_nonce}">function ready(){{turnstile.render('#challenge',{{sitekey:{site},action:'cid_register',cData:{cdata},callback:function(token){{if(window.Turnstile)window.Turnstile.postMessage(JSON.stringify({{verification_id:{id},token:token}}));}}}});}}</script><script nonce="{script_nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&amp;render=explicit" async defer></script></body></html>"#
    ))
}
pub fn page_csp(nonce: &str) -> String {
    format!("default-src 'none'; script-src 'nonce-{nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'none'; connect-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
}
