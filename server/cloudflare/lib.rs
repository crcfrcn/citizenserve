//! Cloudflare唯一入口。授权、账户业务与第6步Queue/Cron已装配；聊天和App接线待后续验收。
mod cache;
mod chain;
mod downloads;
mod maintenance;
mod media;
mod network;
mod notifications;
mod push;
mod queue;
pub mod repositories;
mod runtime;
mod scheduled;
pub mod tatachat;
pub use tatachat::realtime::device::TataChatDevice;
mod topup;
use citizenserve::{
    server::{
        registration,
        routes::{self, Route},
    },
    shared::{error::Health, Error as BusinessError},
    user::{
        auth::{challenge, device, mls_authentication, session},
        ports::{AuthRepository, IdentityRepository},
        projection,
        registration::protocol::Config,
        routes::UserRoute,
    },
};
use worker::*;
fn config(env: &Env) -> citizenserve::shared::Result<Config> {
    let missing = || BusinessError::registration(503, "registration_not_configured", false, "none");
    let config = Config {
        registration_scope: env
            .var("REGISTRATION_SCOPE")
            .map_err(|_| missing())?
            .to_string(),
        service_origin: env.var("WEB_ORIGIN").map_err(|_| missing())?.to_string(),
        chain_scope: env
            .var("CHAIN_GENESIS_HASH")
            .map_err(|_| missing())?
            .to_string(),
        site_key: env
            .var("TURNSTILE_SITEKEY")
            .map_err(|_| missing())?
            .to_string(),
    };
    config.validate()?;
    Ok(config)
}
fn unavailable() -> BusinessError {
    BusinessError::new(503, "authentication_unavailable")
}
fn configuration_error(registration: bool) -> BusinessError {
    if registration {
        BusinessError::registration(503, "registration_not_configured", false, "none")
    } else {
        unavailable()
    }
}
fn runtime_error(registration: bool) -> BusinessError {
    if registration {
        BusinessError::registration(503, "registration_unavailable", true, "read_status")
    } else {
        unavailable()
    }
}
fn preflight(method: &str) -> citizenserve::shared::Result<Response> {
    let mut r = Response::empty()
        .map_err(|_| unavailable())?
        .with_status(204);
    r.headers_mut()
        .set("access-control-allow-methods", &format!("{method},OPTIONS"))
        .map_err(|_| unavailable())?;
    r.headers_mut()
        .set(
            "access-control-allow-headers",
            "content-type,authorization,x-mls-proof,range,if-none-match,if-range,x-citizenserve-request-time,x-citizenserve-request-nonce,x-citizenserve-request-signature",
        )
        .map_err(|_| unavailable())?;
    r.headers_mut()
        .set("access-control-max-age", "600")
        .map_err(|_| unavailable())?;
    Ok(r)
}
fn error(e: BusinessError, registration: bool) -> Result<Response> {
    let mut r = Response::from_json(&e.body(registration))?.with_status(e.status);
    r.headers_mut().set("cache-control", "no-store")?;
    if e.status == 429 {
        r.headers_mut().set("retry-after", "60")?;
    }
    Ok(r)
}
#[event(fetch)]
pub async fn main(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let registration = UserRoute::ALL
        .into_iter()
        .any(|r| r.registration() && r.external() == request.path());
    let mut response = match handle(&mut request, &env).await {
        Ok(r) => r,
        Err(e) => error(
            if registration && e.code == "authentication_unavailable" {
                runtime_error(true)
            } else {
                e
            },
            registration,
        )?,
    };
    response
        .headers_mut()
        .set("x-content-type-options", "nosniff")?;
    response
        .headers_mut()
        .set("referrer-policy", "no-referrer")?;
    if request.url()?.host_str() == Some("nrcrpc.crcfrcn.com") {
        response
            .headers_mut()
            .set("access-control-allow-origin", "*")?;
    }
    if let (Ok(Some(origin)), Ok(allowed)) =
        (request.headers().get("origin"), env.var("WEB_ORIGIN"))
    {
        if origin == allowed.to_string() {
            response
                .headers_mut()
                .set("access-control-allow-origin", &origin)?;
            response.headers_mut().set("vary", "origin")?;
        }
    }
    Ok(response)
}
pub(crate) async fn body(
    request: &mut Request,
    limit: usize,
) -> citizenserve::shared::Result<Vec<u8>> {
    let declared = request
        .headers()
        .get("content-length")
        .map_err(|_| unavailable())?
        .ok_or(BusinessError::new(411, "content_length_required"))?;
    if declared.is_empty() || !declared.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BusinessError::new(400, "content_length_invalid"));
    }
    let length: usize = declared
        .parse()
        .map_err(|_| BusinessError::new(400, "content_length_invalid"))?;
    if length > limit {
        return Err(BusinessError::new(413, "request_too_large"));
    }
    let mut stream = request
        .stream()
        .map_err(|_| BusinessError::new(400, "invalid_utf8"))?;
    let mut bytes = Vec::with_capacity(length);
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BusinessError::new(400, "invalid_utf8"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(BusinessError::new(413, "request_too_large"));
        }
        bytes.extend(chunk);
    }
    if bytes.len() != length {
        return Err(BusinessError::new(400, "content_length_mismatch"));
    }
    Ok(bytes)
}
async fn handle(request: &mut Request, env: &Env) -> citizenserve::shared::Result<Response> {
    if request.url().map_err(|_| unavailable())?.host_str() == Some("nrcrpc.crcfrcn.com") {
        return network::rpc(request, env).await;
    }
    let method = request.method().to_string();
    let path = request.path();
    if request.url().map_err(|_| unavailable())?.scheme() != "https" {
        return Err(BusinessError::new(400, "https_required"));
    }
    if tatachat::routes::matches(&path) {
        return tatachat::routes::handle(request, env)
            .await
            .map_err(tatachat::business);
    }
    let route = if method == "OPTIONS" {
        let declared = request
            .headers()
            .get("access-control-request-method")
            .map_err(|_| unavailable())?
            .ok_or(BusinessError::new(400, "invalid_registration_request"))?;
        routes::route(&declared, &path)?
    } else {
        routes::route(&method, &path)?
    };
    if route.external_tool() {
        let origin = env
            .var("WEB_ORIGIN")
            .map_err(|_| unavailable())?
            .to_string();
        let browser = request.headers().get("origin").map_err(|_| unavailable())?;
        let url = routes::validate_request_origin(
            request.url().map_err(|_| unavailable())?.as_ref(),
            &origin,
            browser.as_deref(),
        )?;
        if method == "OPTIONS" {
            return preflight(route.method());
        }
        external_rate(
            request,
            env,
            if method == "GET" {
                "RATE_READ"
            } else if matches!(
                route,
                Route::Topup(
                    citizenserve::topup::routes::TopupRoute::Intent
                        | citizenserve::topup::routes::TopupRoute::Confirm
                )
            ) {
                "RATE_AUTH"
            } else {
                "RATE_WRITE"
            },
        )
        .await?;
        return match route {
            Route::Topup(r) => topup::handle(request, env, r, &url).await,
            Route::Downloads(r) => downloads::handle(request, env, r, &url).await,
            Route::Chain(r) => chain_tool(request, env, r, &url).await,
            _ => Err(unavailable()),
        };
    }
    if route == Route::Health {
        if method == "OPTIONS" {
            return preflight("GET");
        }
        return Response::from_json(&Health {
            ok: true,
            product: "CitizenServe",
            implementation: "Rust",
            account_services_ready: false,
        })
        .map_err(|_| unavailable());
    }
    let config = config(env)?;
    let browser = request.headers().get("origin").map_err(|_| unavailable())?;
    let url = routes::validate_request_origin(
        request.url().map_err(|_| unavailable())?.as_ref(),
        &config.service_origin,
        browser.as_deref(),
    )?;
    if method == "OPTIONS" {
        return preflight(route.method());
    }
    let hash_secret = env
        .secret("HASH_KEY")
        .map_err(|_| configuration_error(route.registration()))?
        .to_string();
    if hash_secret.is_empty() {
        return Err(configuration_error(route.registration()));
    }
    let ip = request
        .headers()
        .get("cf-connecting-ip")
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    let ip_key = citizenserve::shared::crypto::hex(&citizenserve::shared::crypto::hmac_sha256(
        hash_secret.as_bytes(),
        ip.as_bytes(),
    ));
    // request挑战按所签业务分档；正文先有界读取一次，不反复读取流。
    let challenge_body = if route == Route::User(UserRoute::Challenges) {
        Some(body(request, route.body_limit()).await?)
    } else {
        None
    };
    let rate_route = if let Some(bytes) = &challenge_body {
        let input: mls_authentication::ChallengeRequest =
            routes::parse_json(bytes, route.body_limit())?;
        if input.purpose == mls_authentication::Purpose::Request {
            Some(routes::protected_target(
                &input.method,
                &input.request_target,
            )?)
        } else {
            None
        }
    } else if route.protected() {
        Some(route)
    } else {
        None
    };
    let rate_name = match rate_route {
        Some(r) if r.method() == "GET" => "RATE_READ",
        Some(_) => "RATE_WRITE",
        None => "RATE_AUTH",
    };
    let limit: RateLimiter = env
        .get_binding(rate_name)
        .map_err(|_| configuration_error(route.registration()))?;
    if !limit
        .limit(format!("{rate_name}:{ip_key}"))
        .await
        .map_err(|_| runtime_error(route.registration()))?
        .success
    {
        return Err(if route.registration() {
            BusinessError::registration(429, "registration_rate_limited", true, "retry")
        } else {
            BusinessError::new(429, "request_rate_limited")
        });
    }
    let db = env
        .d1("DB")
        .map_err(|_| configuration_error(route.registration()))?;
    let registrations = repositories::user::D1Registrations {
        db: env
            .d1("DB")
            .map_err(|_| configuration_error(route.registration()))?,
    };
    if route.protected() {
        return protected(request, env, &config, route, &url).await;
    }
    let Route::User(route) = route else {
        return Err(unavailable());
    };
    if route == UserRoute::Page {
        let pairs: Vec<_> = url.query_pairs().collect();
        if pairs.len() != 2
            || pairs.iter().filter(|(k, _)| k == "verification_id").count() != 1
            || pairs.iter().filter(|(k, _)| k == "page_token").count() != 1
        {
            return Err(BusinessError::new(401, "invalid_verification_capability"));
        }
        let id = pairs
            .iter()
            .find(|(k, _)| k == "verification_id")
            .unwrap()
            .1
            .as_ref();
        let token = pairs
            .iter()
            .find(|(k, _)| k == "page_token")
            .unwrap()
            .1
            .as_ref();
        let row = registration::page(
            &registrations,
            &config,
            id,
            token,
            js_sys::Date::now() as u64,
        )
        .await?;
        let nonce = citizenserve::shared::crypto::hex(&runtime::random::<32>()?);
        let mut r = Response::from_html(registration::page_html(&config, &row, &nonce)?)
            .map_err(|_| unavailable())?;
        r.headers_mut()
            .set("content-security-policy", &registration::page_csp(&nonce))
            .map_err(|_| unavailable())?;
        r.headers_mut()
            .set("cache-control", "no-store")
            .map_err(|_| unavailable())?;
        return Ok(r);
    }
    if url.query().is_some() {
        return Err(BusinessError::new(400, "invalid_api_target"));
    }
    let bytes = match challenge_body {
        Some(bytes) => bytes,
        None => body(request, route.body_limit()).await?,
    };
    // 是否需要MLS证明只由精确路由声明决定，预注册能力接口不进入设备认证。
    let proof = if route.requires_mls() {
        Some(mls_authentication::read(
            &request
                .headers()
                .get("x-mls-proof")
                .map_err(|_| unavailable())?
                .ok_or(BusinessError::new(401, "invalid_mls_proof"))?,
        )?)
    } else {
        None
    };
    let result = if route.registration() {
        let secret = env
            .secret("TURNSTILE_SECRET")
            .map_err(|_| configuration_error(true))?
            .to_string();
        if secret.is_empty() {
            return Err(configuration_error(true));
        }
        let runtime = runtime::CloudflareRuntime {
            turnstile_secret: secret,
        };
        let response = match route {
            UserRoute::Registration => {
                registration::prepare(
                    &registrations,
                    &runtime,
                    &config,
                    routes::parse_registration(&bytes, route.body_limit())?,
                )
                .await?
            }
            UserRoute::Verify => {
                registration::verify(
                    &registrations,
                    &runtime,
                    &config,
                    routes::parse_registration(&bytes, route.body_limit())?,
                )
                .await?
            }
            UserRoute::Status => {
                registration::status(
                    &registrations,
                    &runtime,
                    &config,
                    routes::parse_registration(&bytes, route.body_limit())?,
                )
                .await?
            }
            _ => return Err(unavailable()),
        };
        serde_json::to_value(response).map_err(|_| unavailable())?
    } else {
        let rpc = chain::Chain::configured(env)?;
        let identities = repositories::identity::D1Identities {
            db: env.d1("DB").map_err(|_| unavailable())?,
        };
        let auth = repositories::auth::D1Auth { db };
        let checked = js_sys::Date::now() as u64;
        match route {
            UserRoute::Identity => {
                projection::confirm(
                    &rpc,
                    &identities,
                    &routes::parse_json(&bytes, route.body_limit())?,
                    &config.chain_scope,
                    checked,
                )
                .await?
            }
            UserRoute::Challenges => {
                let input: mls_authentication::ChallengeRequest =
                    routes::parse_json(&bytes, route.body_limit())?;
                challenge::target(&input)?;
                let i = projection::current(
                    &rpc,
                    &identities,
                    &input.account_id,
                    &config.chain_scope,
                    checked,
                    false,
                )
                .await?;
                let now = js_sys::Date::now() as u64;
                if input.purpose == mls_authentication::Purpose::Session {
                    let d = auth
                        .device(&i.cid_number, &input.public_key[2..])
                        .await?
                        .ok_or(BusinessError::new(401, "device_not_registered"))?;
                    let a = auth
                        .admission(&i.cid_number)
                        .await?
                        .ok_or(BusinessError::new(403, "registration_required"))?;
                    citizenserve::server::guard::device_authority(
                        &i,
                        &a,
                        &d,
                        &config,
                        &input.public_key,
                        now,
                    )?;
                }
                let bound_session = if input.purpose == mls_authentication::Purpose::Request {
                    let token = bearer(request)?;
                    let hash = session::hash(&token)?;
                    let current_session = auth
                        .session(&hash)
                        .await?
                        .ok_or(BusinessError::new(401, "invalid_session"))?;
                    let d = auth
                        .device(&i.cid_number, &current_session.device_id)
                        .await?
                        .ok_or(BusinessError::new(401, "device_not_registered"))?;
                    let a = auth
                        .admission(&i.cid_number)
                        .await?
                        .ok_or(BusinessError::new(403, "registration_required"))?;
                    citizenserve::server::guard::session_authority(
                        &i,
                        &a,
                        &d,
                        &current_session,
                        &config,
                        now,
                    )?;
                    if d.public_key != input.public_key {
                        return Err(BusinessError::new(401, "invalid_mls_proof"));
                    }
                    Some(hash)
                } else {
                    None
                };
                let c = challenge::issue(
                    &i,
                    &config.service_origin,
                    &input,
                    runtime::random()?,
                    bound_session,
                    now,
                )?;
                if !auth.issue_challenge(&c).await? {
                    return Err(BusinessError::new(429, "mls_challenge_limit_reached"));
                }
                serde_json::to_value(c).map_err(|_| unavailable())?
            }
            UserRoute::DeletionStatusChallenge => {
                use citizenserve::user::deletion::{self,Subject,Purpose};
                let input:Subject=routes::parse_json(&bytes,route.body_limit())?;
                citizenserve::shared::ids::cid(&input.cid_number)?;
                let i=projection::current(&rpc,&identities,&input.account_id,&config.chain_scope,checked,true).await?;
                if i.cid_number!=input.cid_number{return Err(BusinessError::new(401,"cid_binding_changed"));}
                let repo=repositories::deletion::D1Deletion{db:env.d1("DB").map_err(|_|unavailable())?};
                serde_json::to_value(deletion::issue(&repo,&config,&i,Purpose::Status,runtime::random()?,js_sys::Date::now() as u64).await?).map_err(|_|unavailable())?
            }
            UserRoute::DeletionStatus => {
                use citizenserve::user::deletion::{self,Signed,Purpose,Repository};
                let input:Signed=routes::parse_json(&bytes,route.body_limit())?;
                if !citizenserve::shared::ids::hex(&input.challenge_id,32,false){return Err(BusinessError::new(401,"account_deletion_challenge_invalid"));}
                let repo=repositories::deletion::D1Deletion{db:env.d1("DB").map_err(|_|unavailable())?};
                let challenge=repo.challenge(&input.challenge_id).await?.ok_or(BusinessError::new(401,"account_deletion_challenge_invalid"))?;
                let i=projection::current(&rpc,&identities,&challenge.account_id,&config.chain_scope,checked,true).await?;
                let c=deletion::verify(&repo,&config,&i,&input,Purpose::Status,js_sys::Date::now() as u64).await?;
                let receipt=repo.status(&c,js_sys::Date::now() as u64).await?;receipt.validate(&i)?;
                serde_json::to_value(receipt).map_err(|_|unavailable())?
            }
            UserRoute::Devices => {
                let input: device::Register = routes::parse_json(&bytes, route.body_limit())?;
                let proof = proof.as_ref().ok_or_else(unavailable)?;
                let i = projection::current(
                    &rpc,
                    &identities,
                    &input.account_id,
                    &config.chain_scope,
                    checked,
                    true,
                )
                .await?;
                serde_json::to_value(
                    device::register(
                        &auth,
                        &registrations,
                        &config,
                        &i,
                        &input,
                        proof,
                        &bytes,
                        &path,
                        js_sys::Date::now() as u64,
                    )
                    .await?,
                )
                .map_err(|_| unavailable())?
            }
            UserRoute::Sessions => {
                let input: session::Request = routes::parse_json(&bytes, route.body_limit())?;
                let proof = proof.as_ref().ok_or_else(unavailable)?;
                let i = projection::current(
                    &rpc,
                    &identities,
                    &input.account_id,
                    &config.chain_scope,
                    checked,
                    false,
                )
                .await?;
                serde_json::to_value(
                    session::create(
                        &auth,
                        &config,
                        &i,
                        &input,
                        proof,
                        &bytes,
                        &path,
                        runtime::random()?,
                        js_sys::Date::now() as u64,
                    )
                    .await?,
                )
                .map_err(|_| unavailable())?
            }
            _ => return Err(unavailable()),
        }
    };
    let mut r = Response::from_json(&result)
        .map_err(|_| unavailable())?
        .with_status(if route == UserRoute::Registration {
            201
        } else {
            200
        });
    r.headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| unavailable())?;
    Ok(r)
}
#[event(scheduled)]
pub async fn scheduled(event: ScheduledEvent, env: Env, ctx: ScheduleContext) {
    ctx.wait_until(async move {
        if scheduled::run(&env, event.schedule() as u64).await.is_err() {
            console_error!("scheduled_task_failed");
        }
    });
}
#[event(queue)]
pub async fn queue(
    batch: MessageBatch<serde_json::Value>,
    env: Env,
    _ctx: Context,
) -> worker::Result<()> {
    let expected = env.var("TATACHAT_QUEUE_NAME").ok().map(|v| v.to_string());
    if expected.as_deref() == Some(batch.queue().as_str()) {
        tatachat::maintenance::consume(batch, &env).await
    } else if batch.queue() == "citizenserve" {
        queue::consume(batch, &env).await
    } else {
        Err(worker::Error::RustError("queue_identity_invalid".into()))
    }
}

fn bearer(request: &Request) -> citizenserve::shared::Result<String> {
    let header = request
        .headers()
        .get("authorization")
        .map_err(|_| unavailable())?
        .ok_or(BusinessError::new(401, "invalid_session"))?;
    let token = header
        .strip_prefix("Bearer ")
        .ok_or(BusinessError::new(401, "invalid_session"))?;
    session::hash(token)?;
    Ok(token.into())
}
async fn protected(
    request: &mut Request,
    env: &Env,
    config: &Config,
    route: Route,
    url: &url::Url,
) -> citizenserve::shared::Result<Response> {
    use citizenserve::{
        notifications::{self, routes::NotificationRoute},
        server::guard,
        square::{self, routes::SquareRoute},
        user::{contacts, profile_service, routes::ProtectedUserRoute},
    };
    let target = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    routes::protected_target(route.method(), &target)?;
    let query = routes::query(url.query())?;
    let token = bearer(request)?;
    let auth = repositories::auth::D1Auth {
        db: env.d1("DB").map_err(|_| unavailable())?,
    };
    let session = auth
        .session(&session::hash(&token)?)
        .await?
        .ok_or(BusinessError::new(401, "invalid_session"))?;
    let proof = mls_authentication::read(
        &request
            .headers()
            .get("x-mls-proof")
            .map_err(|_| unavailable())?
            .ok_or(BusinessError::new(401, "invalid_mls_proof"))?,
    )?;
    let bytes = if route.body_limit() == 0 {
        if request
            .headers()
            .get("content-length")
            .map_err(|_| unavailable())?
            .is_some_and(|v| v != "0")
            || request
                .headers()
                .get("transfer-encoding")
                .map_err(|_| unavailable())?
                .is_some()
        {
            return Err(BusinessError::new(400, "invalid_api_body"));
        }
        // 即使Content-Length缺失，也只逐块验证空正文，不聚合潜在大请求。
        if request.inner().body().is_some() {
            use futures_util::StreamExt;
            let mut stream = request.stream().map_err(|_| unavailable())?;
            while let Some(chunk) = stream.next().await {
                if !chunk.map_err(|_| unavailable())?.is_empty() {
                    return Err(BusinessError::new(400, "invalid_api_body"));
                }
            }
        }
        vec![]
    } else {
        body(request, route.body_limit()).await?
    };
    let rpc = chain::Chain::configured(env)?;
    // 先完成可能耗时的权益RPC，再核验当前身份与会话，避免旧核验时间支撑业务。
    let entitlement = if matches!(
        route,
        Route::Square(SquareRoute::Feed(_) | SquareRoute::Posts)
    ) {
        Some(
            citizenserve::chain::subscription::current(
                &rpc,
                &config.chain_scope,
                &session.cid_number,
                js_sys::Date::now() as u64,
            )
            .await?,
        )
    } else {
        None
    };
    let membership = if matches!(
        route,
        Route::TataChat(_)
            | Route::Membership(_)
            | Route::Square(
                SquareRoute::PrepareUpload
                    | SquareRoute::Manifest
                    | SquareRoute::CompleteUpload
                    | SquareRoute::ConfirmPost
            )
    ) {
        Some(
            citizenserve::chain::subscription::platform(
                &rpc,
                &config.chain_scope,
                &session.cid_number,
                &session.account_id,
                js_sys::Date::now() as u64,
            )
            .await?,
        )
    } else {
        None
    };
    let identities = repositories::identity::D1Identities {
        db: env.d1("DB").map_err(|_| unavailable())?,
    };
    let i = if matches!(route, Route::TataChat(_)) {
        // 许可必须使用会员读取冻结的同一块身份，不把另一个头/缓存身份拼成同块证明。
        let current = membership.as_ref().ok_or_else(unavailable)?;
        let m = citizenserve::chain::identity::metadata(&rpc, &current.anchor).await?;
        let identity = citizenserve::chain::identity::by_cid(
            &rpc,
            &m,
            &current.anchor,
            &session.cid_number,
            &config.chain_scope,
            js_sys::Date::now() as u64,
        )
        .await?
        .ok_or(BusinessError::new(403, "cid_not_active"))?;
        identities
            .project(std::slice::from_ref(&identity), None, None)
            .await?;
        identity
    } else {
        projection::current(
            &rpc,
            &identities,
            &session.account_id,
            &config.chain_scope,
            js_sys::Date::now() as u64,
            false,
        )
        .await?
    };
    let authority = guard::authenticate(
        &auth,
        &i,
        config,
        &token,
        &proof,
        route.method(),
        &target,
        &bytes,
        js_sys::Date::now() as u64,
    )
    .await?;
    let authorization = profile_service::Authorization::new(
        &authority,
        config,
        &token,
        js_sys::Date::now() as u64,
    )?;
    let db = || env.d1("DB").map_err(|_| unavailable());
    let objects = || media::R2Storage::configured(env);
    let member = || membership.as_ref().ok_or_else(unavailable);
    let posts = || {
        Ok::<_, BusinessError>(repositories::posts::D1Posts {
            db: db()?,
            square: repositories::square::D1Square {
                db: db()?,
                media_origin: env
                    .var("SQUARE_PUBLIC_MEDIA_BASE_URL")
                    .ok()
                    .map(|v| v.to_string()),
            },
        })
    };
    let result = match route {
        Route::TataChat(_) => {
            tatachat::access(env, config, &authority, &token, member()?, &bytes).await?
        }
        Route::Membership(r) => {
            use citizenserve::membership::{self, ports::Repository, routes::MembershipRoute};
            let repo = repositories::membership::D1Membership { db: db()? };
            let current = member()?;
            match r {
                MembershipRoute::Current => {
                    membership::service::current(&repo, &authorization, current).await?
                }
                MembershipRoute::Confirm
                | MembershipRoute::ConfirmPlans
                | MembershipRoute::ConfirmCreator => {
                    let target = if r == MembershipRoute::ConfirmCreator {
                        Some(
                            url.path()
                                .strip_prefix("/api/membership/creators/")
                                .and_then(|s| s.strip_suffix("/subscription/confirm"))
                                .ok_or_else(unavailable)?,
                        )
                    } else {
                        None
                    };
                    let input = routes::parse_json(&bytes, route.body_limit())?;
                    let facts = membership::projection::confirm(
                        &rpc,
                        &config.chain_scope,
                        &authorization,
                        &input,
                        r,
                        target,
                    )
                    .await?;
                    repo.project(&authorization, &facts).await?;
                    serde_json::json!({"ok":true,"tx_hash":input.tx_hash,"block_hash":input.block_hash})
                }
                MembershipRoute::Overview => {
                    serde_json::json!({"ok":true,"overview":repo.overview(&authorization,current).await?})
                }
                MembershipRoute::Plans => {
                    let cid = url
                        .path()
                        .strip_prefix("/api/membership/creators/")
                        .and_then(|s| s.strip_suffix("/plans"))
                        .ok_or_else(unavailable)?;
                    let m = citizenserve::chain::identity::metadata(&rpc, &current.anchor).await?;
                    let owner = citizenserve::chain::identity::by_cid(
                        &rpc,
                        &m,
                        &current.anchor,
                        cid,
                        &config.chain_scope,
                        authorization.now(),
                    )
                    .await?
                    .ok_or(BusinessError::new(404, "creator_not_found"))?;
                    let plans = membership::creator::tiers(&rpc, &m, &current.anchor, cid).await?;
                    let subscription = citizenserve::chain::subscription::at(
                        &rpc,
                        &m,
                        &current.anchor,
                        authorization.cid(),
                        Some(cid),
                    )
                    .await?;
                    let creator_membership =
                        citizenserve::chain::subscription::at(&rpc, &m, &current.anchor, cid, None)
                            .await?;
                    if js_sys::Date::now() as u64 >= current.deadline() {
                        return Err(BusinessError::new(503, "membership_verification_expired"));
                    }
                    serde_json::json!({"ok":true,"creator_cid_number":cid,"creator_account_id":owner.account_id,"tiers":plans,"membership_active":creator_membership.is_some_and(|s|s.active(js_sys::Date::now() as u64,current.chain_time)),"subscription":subscription.map(|s|s.wire()).transpose()?})
                }
            }
        }
        Route::ProtectedUser(r) => {
            let repo = repositories::profiles::D1Profiles { db: db()? };
            match r {
                ProtectedUserRoute::PrepareAsset => {
                    citizenserve::user::profile_assets::prepare(
                        &repositories::media::D1Assets { db: db()? },
                        &objects()?,
                        &authorization,
                        routes::parse_json(&bytes, route.body_limit())?,
                        runtime::random()?,
                    )
                    .await?
                }
                ProtectedUserRoute::UploadAsset => {
                    if request
                        .headers()
                        .get("content-type")
                        .map_err(|_| unavailable())?
                        .as_deref()
                        != Some("image/webp")
                    {
                        return Err(BusinessError::new(415, "invalid_profile_asset_type"));
                    }
                    citizenserve::user::profile_assets::upload(
                        &repositories::media::D1Assets { db: db()? },
                        &objects()?,
                        &authorization,
                        url.path()
                            .strip_prefix("/api/user/profile/assets/")
                            .ok_or_else(unavailable)?,
                        bytes,
                    )
                    .await?
                }
                ProtectedUserRoute::Asset => {
                    use citizenserve::user::profile_assets::{self, Kind};
                    let (cid, kind) = url
                        .path()
                        .strip_prefix("/api/user/profiles/")
                        .and_then(|s| s.split_once("/assets/"))
                        .ok_or_else(unavailable)?;
                    let h = |name| request.headers().get(name).map_err(|_| unavailable());
                    let data = profile_assets::read(
                        &repositories::media::D1Assets { db: db()? },
                        &objects()?,
                        &authorization,
                        cid,
                        if kind == "avatar" {
                            Kind::Avatar
                        } else {
                            Kind::Banner
                        },
                        h("range")?.as_deref(),
                        h("if-none-match")?.as_deref(),
                        h("if-range")?.as_deref(),
                    )
                    .await?;
                    let mut response = Response::from_bytes(data.bytes)
                        .map_err(|_| unavailable())?
                        .with_status(data.status);
                    for (name, value) in [
                        ("content-type", "image/webp"),
                        ("cache-control", "private, no-store"),
                        ("accept-ranges", "bytes"),
                        ("etag", data.etag.as_str()),
                    ] {
                        response
                            .headers_mut()
                            .set(name, value)
                            .map_err(|_| unavailable())?;
                    }
                    if let Some(range) = data.content_range {
                        response
                            .headers_mut()
                            .set("content-range", &range)
                            .map_err(|_| unavailable())?;
                    }
                    authority
                        .identity()
                        .require_current(js_sys::Date::now() as u64)?;
                    if authority.session_deadline() <= js_sys::Date::now() as u64 {
                        return Err(BusinessError::new(401, "session_expired"));
                    }
                    return Ok(response);
                }
                ProtectedUserRoute::Profile => {
                    profile_service::read(
                        &repo,
                        &authorization,
                        url.path()
                            .strip_prefix("/api/user/profiles/")
                            .ok_or_else(unavailable)?,
                    )
                    .await?
                }
                ProtectedUserRoute::UpdateProfile => {
                    profile_service::update(
                        &repo,
                        &authorization,
                        &routes::parse_json(&bytes, route.body_limit())?,
                    )
                    .await?
                }
                ProtectedUserRoute::DeletionChallenge => {
                    use citizenserve::user::deletion::{self,Purpose};
                    #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Empty {}
                    let _:Empty=routes::parse_json(&bytes,route.body_limit())?;
                    let repo=repositories::deletion::D1Deletion{db:db()?};
                    serde_json::to_value(deletion::issue(&repo,config,authority.identity(),Purpose::Delete,runtime::random()?,js_sys::Date::now() as u64).await?).map_err(|_|unavailable())?
                }
                ProtectedUserRoute::Delete => {
                    use citizenserve::user::deletion::{self,Purpose,Repository};
                    let repo=repositories::deletion::D1Deletion{db:db()?};
                    let input=routes::parse_json(&bytes,route.body_limit())?;
                    let c=deletion::verify(&repo,config,authority.identity(),&input,Purpose::Delete,js_sys::Date::now() as u64).await?;
                    let receipt=repo.begin(&authorization,&c).await?;receipt.validate(authority.identity())?;
                    return Response::from_json(&receipt).map(|r|r.with_status(202)).map_err(|_|unavailable());
                }
                ProtectedUserRoute::Contacts => {
                    contacts::handle(
                        &repositories::contacts::D1Contacts { db: db()? },
                        &authorization,
                        routes::parse_json(&bytes, route.body_limit())?,
                        runtime::random()?,
                    )
                    .await?
                }
            }
        }
        Route::Square(r) => {
            let repo = repositories::square::D1Square {
                db: db()?,
                media_origin: env
                    .var("SQUARE_PUBLIC_MEDIA_BASE_URL")
                    .ok()
                    .map(|v| v.to_string()),
            };
            match r {
                SquareRoute::PrepareUpload => {
                    square::uploads::prepare(
                        &repositories::uploads::D1Uploads { db: db()? },
                        &objects()?,
                        &authorization,
                        routes::parse_json(&bytes, route.body_limit())?,
                        member()?,
                        runtime::random()?,
                    )
                    .await?
                }
                SquareRoute::Manifest => {
                    if request
                        .headers()
                        .get("content-type")
                        .map_err(|_| unavailable())?
                        .as_deref()
                        != Some("application/json")
                    {
                        return Err(BusinessError::new(415, "invalid_manifest_type"));
                    }
                    let id = url
                        .path()
                        .strip_prefix("/api/8964/uploads/")
                        .and_then(|s| s.strip_suffix("/manifest"))
                        .ok_or_else(unavailable)?;
                    square::uploads::put_manifest(
                        &repositories::uploads::D1Uploads { db: db()? },
                        &objects()?,
                        &authorization,
                        id,
                        bytes,
                        member()?,
                    )
                    .await?
                }
                SquareRoute::CompleteUpload => {
                    let id = url
                        .path()
                        .strip_prefix("/api/8964/uploads/")
                        .and_then(|s| s.strip_suffix("/complete"))
                        .ok_or_else(unavailable)?;
                    square::uploads::complete(
                        &repositories::uploads::D1Uploads { db: db()? },
                        &objects()?,
                        &authorization,
                        id,
                        routes::parse_json(&bytes, route.body_limit())?,
                        member()?,
                    )
                    .await?
                }
                SquareRoute::CancelUpload => {
                    let up = repositories::uploads::D1Uploads { db: db()? };
                    let id = url
                        .path()
                        .strip_prefix("/api/8964/uploads/")
                        .ok_or_else(unavailable)?;
                    let u = square::uploads::get(&up, &authorization, id).await?;
                    square::uploads::remove(&up, &objects()?, &authorization, &u, false).await?
                }
                SquareRoute::ConfirmPost => {
                    square::post_service::confirm(
                        &posts()?,
                        &objects()?,
                        &rpc,
                        &config.chain_scope,
                        &authorization,
                        routes::parse_json(&bytes, route.body_limit())?,
                        member()?,
                    )
                    .await?
                }
                SquareRoute::SelfPosts => {
                    square::local_copy::page(
                        &posts()?,
                        &objects()?,
                        &authorization,
                        &square::local_copy::Query::read(&query)?,
                    )
                    .await?
                }
                SquareRoute::Post => {
                    square::post_service::detail(
                        &posts()?,
                        &objects()?,
                        &authorization,
                        url.path()
                            .strip_prefix("/api/8964/posts/")
                            .ok_or_else(unavailable)?,
                    )
                    .await?
                }
                SquareRoute::DeletePost => {
                    use square::post_service::Repository;
                    let id = url
                        .path()
                        .strip_prefix("/api/8964/posts/")
                        .ok_or_else(unavailable)?;
                    let u = posts()?
                        .upload_by_post(&authorization, id)
                        .await?
                        .ok_or(BusinessError::new(404, "post_not_found"))?;
                    square::uploads::remove(
                        &repositories::uploads::D1Uploads { db: db()? },
                        &objects()?,
                        &authorization,
                        &u,
                        true,
                    )
                    .await?
                }
                SquareRoute::Feed(kind) => {
                    square::feed::feed(
                        &repo,
                        &authorization,
                        kind,
                        square::routes::limit(&query)?,
                        entitlement.as_ref().ok_or_else(unavailable)?,
                    )
                    .await?
                }
                SquareRoute::Posts => {
                    square::feed::author(
                        &repo,
                        &authorization,
                        &square::posts::Query::read(&query)?,
                        entitlement.as_ref().ok_or_else(unavailable)?,
                    )
                    .await?
                }
                SquareRoute::Follows => {
                    square::follows::list(
                        &repo,
                        &authorization,
                        &square::follows::Query::read(&query)?,
                    )
                    .await?
                }
                SquareRoute::Follow => {
                    let input: square::follows::Follow =
                        routes::parse_json(&bytes, route.body_limit())?;
                    square::follows::change(
                        &repo,
                        &authorization,
                        &input.followed_cid_number,
                        square::follows::Change::Follow,
                    )
                    .await?
                }
                SquareRoute::Unfollow => {
                    square::follows::change(
                        &repo,
                        &authorization,
                        url.path()
                            .strip_prefix("/api/8964/follows/")
                            .ok_or_else(unavailable)?,
                        square::follows::Change::Unfollow,
                    )
                    .await?
                }
                SquareRoute::Notify => {
                    let input: square::follows::Notify =
                        routes::parse_json(&bytes, route.body_limit())?;
                    let cid = url
                        .path()
                        .strip_prefix("/api/8964/follows/")
                        .and_then(|s| s.strip_suffix("/notifications"))
                        .ok_or_else(unavailable)?;
                    square::follows::change(
                        &repo,
                        &authorization,
                        cid,
                        square::follows::Change::Notify(input.enabled),
                    )
                    .await?
                }
            }
        }
        Route::Notifications(r) => {
            let repo = repositories::notifications::D1Notifications { db: db()? };
            match r {
                NotificationRoute::Unread => {
                    notifications::inbox::unread(&repo, &authorization).await?
                }
                NotificationRoute::RegisterEndpoint | NotificationRoute::DeleteEndpoint => {
                    crate::notifications::endpoint(db()?, &authorization, r, &bytes).await?
                }
                NotificationRoute::Read => {
                    let input: notifications::inbox::Read =
                        routes::parse_json(&bytes, route.body_limit())?;
                    notifications::inbox::mark(&repo, &authorization, input.scope).await?
                }
            }
        }
        _ => return Err(unavailable()),
    };
    // 有界读取仍可能等待外部I/O；交付前不延长既有60秒身份/会员核验期限。
    let delivery_now = js_sys::Date::now() as u64;
    authority.identity().require_current(delivery_now)?;
    if authority.session_deadline() <= delivery_now {
        return Err(BusinessError::new(401, "session_expired"));
    }
    if membership
        .as_ref()
        .is_some_and(|m| delivery_now >= m.deadline())
    {
        return Err(BusinessError::new(503, "membership_verification_expired"));
    }
    let mut r = Response::from_json(&result).map_err(|_| unavailable())?;
    r.headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| unavailable())?;
    Ok(r)
}

pub(crate) async fn read_body(
    request: &mut Request,
    limit: usize,
) -> citizenserve::shared::Result<Vec<u8>> {
    if limit == 0 {
        if let Some(v) = request
            .headers()
            .get("content-length")
            .map_err(|_| unavailable())?
        {
            if v != "0" {
                return Err(BusinessError::new(400, "unexpected_request_body"));
            }
            return body(request, 0).await;
        }
        return Ok(vec![]);
    }
    body(request, limit).await
}
pub(crate) fn json_response(
    value: &serde_json::Value,
    status: u16,
) -> citizenserve::shared::Result<Response> {
    let mut r = Response::from_json(value)
        .map_err(|_| unavailable())?
        .with_status(status);
    r.headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| unavailable())?;
    Ok(r)
}
pub(crate) async fn external_rate(
    request: &Request,
    env: &Env,
    name: &str,
) -> citizenserve::shared::Result<String> {
    let secret = env
        .secret("HASH_KEY")
        .map_err(|_| unavailable())?
        .to_string();
    if secret.len() < 32 {
        return Err(unavailable());
    }
    let ip = request
        .headers()
        .get("cf-connecting-ip")
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    let hash = citizenserve::shared::crypto::hex(&citizenserve::shared::crypto::hmac_sha256(
        secret.as_bytes(),
        ip.as_bytes(),
    ));
    let limiter: RateLimiter = env.get_binding(name).map_err(|_| unavailable())?;
    if !limiter
        .limit(format!("{name}:{hash}"))
        .await
        .map_err(|_| unavailable())?
        .success
    {
        return Err(BusinessError::new(429, "external_rate_limited"));
    }
    Ok(hash)
}
async fn chain_tool(
    request: &mut Request,
    env: &Env,
    r: routes::ChainRoute,
    url: &url::Url,
) -> citizenserve::shared::Result<Response> {
    use citizenserve::chain::{bootstrap, constitution, network_ports::Cache, relay};
    use routes::ChainRoute;
    if url.query().is_some() {
        return Err(BusinessError::new(400, "invalid_chain_request"));
    }
    let bytes = read_body(
        request,
        if r == ChainRoute::Extrinsics {
            131584
        } else {
            0
        },
    )
    .await?;
    let var = |s| {
        env.var(s)
            .map(|v| v.to_string())
            .map_err(|_| BusinessError::new(503, "chain_bootstrap_not_configured"))
    };
    let genesis = var("CHAIN_GENESIS_HASH")?;
    let enabled = env
        .var("RELAY_ENABLED")
        .ok()
        .is_some_and(|v| v.to_string() == "1");
    match r {
        ChainRoute::Bootstrap | ChainRoute::SdkBootstrap => json_response(
            &bootstrap::Config {
                origin: var("WEB_ORIGIN")?,
                genesis_hash: genesis,
                state_root: var("CHAIN_STATE_ROOT")?,
                bootnodes: env
                    .var("CHAIN_BOOTNODES")
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                media_origin: var("SQUARE_PUBLIC_MEDIA_BASE_URL")?,
                relay_enabled: enabled && chain::Chain::configured(env).is_ok(),
                ttl: 300,
            }
            .response(js_sys::Date::now() as u64, r == ChainRoute::SdkBootstrap)?,
            200,
        ),
        ChainRoute::Constitution => {
            let cache = cache::DisplayCache::configured(env);
            let key = format!("constitution:v2:{genesis}");
            let now = js_sys::Date::now() as u64;
            if let Ok(Some(v)) = cache.get(&key, now).await {
                return json_response(&v, 200);
            }
            let value = constitution::read(&chain::Chain::configured(env)?, &genesis, now).await?;
            let _ = cache.put(&key, &value, now, 300).await;
            json_response(&value, 200)
        }
        ChainRoute::Extrinsics => {
            if !enabled {
                return Err(BusinessError::new(503, "chain_relay_disabled"));
            }
            let chain = chain::Chain::configured(env)?;
            let secret = env
                .secret("HASH_KEY")
                .map_err(|_| unavailable())?
                .to_string();
            let ip = request
                .headers()
                .get("cf-connecting-ip")
                .map_err(|_| unavailable())?
                .ok_or_else(unavailable)?;
            let hash = citizenserve::shared::crypto::hex(
                &citizenserve::shared::crypto::hmac_sha256(secret.as_bytes(), ip.as_bytes()),
            );
            let (status, value) = relay::submit(
                &repositories::relay::D1Relay {
                    db: env.d1("DB").map_err(|_| unavailable())?,
                },
                &chain,
                &chain,
                &genesis,
                routes::parse_json(&bytes, 131584)?,
                &hash,
                &citizenserve::shared::crypto::hex(&runtime::random::<16>()?),
                js_sys::Date::now() as u64,
            )
            .await?;
            json_response(&value, status)
        }
    }
}
