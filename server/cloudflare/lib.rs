//! Cloudflare唯一入口，装配授权、账户业务、Queue/Cron与聊天平台适配。
mod cache;
mod chain;
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
        gate::{
            self,
            request::{self, Route},
        },
        registration,
    },
    shared::{error::Health, Error as BusinessError},
    user::{
        auth::{challenge, device, mls_authentication, session},
        ports::AuthRepository,
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
fn preflight(entry: &gate::Entry) -> citizenserve::shared::Result<Response> {
    entry.open()?;
    if !entry.preflight() {
        return Err(BusinessError::new(403, "gate_scope_mismatch"));
    }
    let mut r = Response::empty()
        .map_err(|_| unavailable())?
        .with_status(204);
    r.headers_mut()
        .set(
            "access-control-allow-methods",
            &format!("{},OPTIONS", entry.method()),
        )
        .map_err(|_| unavailable())?;
    r.headers_mut()
        .set(
            "access-control-allow-headers",
            &gate::policy::headers(entry.endpoint()).join(","),
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
    // 上游及WebSocket升级响应的头可能不可修改；只复制头，保留正文流和升级连接。
    let headers = response.headers().clone();
    response = response.with_headers(headers);
    response
        .headers_mut()
        .set("x-content-type-options", "nosniff")?;
    response
        .headers_mut()
        .set("referrer-policy", "no-referrer")?;
    let public_network = request::network_url(request.url()?.as_ref());
    if public_network {
        // 公共网络独立采用通配CORS；不再由App的WEB_ORIGIN覆盖同一响应头。
        response
            .headers_mut()
            .set("access-control-allow-origin", "*")?;
    } else if let (Ok(Some(origin)), Ok(allowed)) =
        (request.headers().get("origin"), env.var("WEB_ORIGIN"))
    {
        if origin == allowed.to_string() {
            response
                .headers_mut()
                .set("access-control-allow-origin", &origin)?;
            response.headers_mut().set("vary", "origin")?;
        }
    }
    if public_network && request.method() == Method::Head {
        // HEAD失败也必须为空正文，保留原状态和本地响应头，不公开上游错误。
        response = Response::empty()?
            .with_status(response.status_code())
            .with_headers(response.headers().clone());
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
/// 只从真实请求及服务器声明提取输入；三路分类在任何业务I/O之前完成。
fn gate_entry(request: &Request, env: &Env) -> citizenserve::shared::Result<gate::Entry> {
    let url = request.url().map_err(|_| unavailable())?;
    let method = request.method().to_string();
    let service = env.var("WEB_ORIGIN").ok().map(|v| v.to_string());
    let media = env
        .var("SQUARE_PUBLIC_MEDIA_BASE_URL")
        .ok()
        .map(|v| v.to_string());
    let header = |name| request.headers().get(name).map_err(|_| unavailable());
    let browser = header("origin")?;
    let declared = header("access-control-request-method")?;
    let declared_headers = header("access-control-request-headers")?;
    let length = header("content-length")?;
    let token = header("authorization")?;
    let proof = header("x-mls-proof")?;
    let upgrade = header("upgrade")?;
    let protocol = header("sec-websocket-protocol")?;
    let input = request::Incoming {
        method: &method,
        url: url.as_ref(),
        service_origin: service.as_deref(),
        media_origin: media.as_deref(),
        browser_origin: browser.as_deref(),
        preflight_method: declared.as_deref(),
        preflight_headers: declared_headers.as_deref(),
        content_length: length.as_deref(),
        authorization: token.as_deref(),
        mls_proof: proof.as_deref(),
        upgrade: upgrade.as_deref(),
        websocket_protocol: protocol.as_deref(),
        internal_header: request
            .headers()
            .has("x-tatachat-internal")
            .map_err(|_| unavailable())?,
    };
    match gate::classify(input) {
        gate::Classification::Open(entry) => {
            entry.open()?;
            Ok(entry)
        }
        gate::Classification::Cid(entry) => Ok(entry),
        gate::Classification::Reject(error) => Err(error),
    }
}
async fn handle(request: &mut Request, env: &Env) -> citizenserve::shared::Result<Response> {
    let entry = gate_entry(request, env)?;
    if entry.preflight() {
        entry.open()?;
        return preflight(&entry);
    }
    let method = request.method().to_string();
    let path = request.path();
    match entry.endpoint() {
        request::Endpoint::Network(_) => {
            let scope = entry.open()?;
            return network::handle(request, env, &scope).await;
        }
        request::Endpoint::Chat(_) => {
            entry.require_cid(gate::policy::CidRule::Chat)?;
            // Chat在普通API限流之前返回，须在JWT/DO/正文之前使用同一IP挡板。
            external_rate(
                request,
                env,
                if path == "/api/tatachat/realtime" {
                    "RATE_WRITE"
                } else {
                    "RATE_READ"
                },
            )
            .await?;
            return tatachat::routes::handle(request, env, &entry)
                .await
                .map_err(tatachat::business);
        }
        request::Endpoint::Media(key) => {
            entry.require_cid(gate::policy::CidRule::Media)?;
            return media::serve(request, env, &entry, key).await;
        }
        request::Endpoint::Api(_) => {}
    }
    let route = entry.api()?;
    if matches!(route, Route::Topup(_) | Route::Chain(_)) {
        let scope = entry.open()?;
        let origin = env
            .var("WEB_ORIGIN")
            .map_err(|_| unavailable())?
            .to_string();
        let browser = request.headers().get("origin").map_err(|_| unavailable())?;
        let url = request::validate_request_origin(
            request.url().map_err(|_| unavailable())?.as_ref(),
            &origin,
            browser.as_deref(),
        )?;
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
            Route::Topup(r) => topup::handle(request, env, r, &url, &scope).await,
            Route::Chain(r) => {
                scope.require_api(route)?;
                chain_tool(request, env, r, &url).await
            }
            _ => Err(unavailable()),
        };
    }
    if route == Route::Health {
        entry.open()?.require_api(Route::Health)?;
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
    let url = request::validate_request_origin(
        request.url().map_err(|_| unavailable())?.as_ref(),
        &config.service_origin,
        browser.as_deref(),
    )?;
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
            request::parse_json(bytes, route.body_limit())?;
        if input.purpose == mls_authentication::Purpose::Request {
            Some(request::protected_target(
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
        let gate::policy::Rule::Cid(kind) = route.rule() else {
            return Err(BusinessError::new(403, "gate_scope_mismatch"));
        };
        entry.require_cid(kind)?;
        return protected(request, env, &config, route, &url).await;
    }
    match route.rule() {
        gate::policy::Rule::Open(_) => {
            entry.open()?.require_api(route)?;
        }
        gate::policy::Rule::Cid(kind) => entry.require_cid(kind)?,
        gate::policy::Rule::Reject => return Err(BusinessError::new(404, "route_not_found")),
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
    let checked_proof = if route == UserRoute::Devices {
        Some(gate::identity::prevalidate(
            &config,
            proof.as_ref().ok_or_else(unavailable)?,
            &method,
            &path,
            &bytes,
            js_sys::Date::now() as u64,
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
                gate::open::registration(
                    &entry.open()?,
                    &registrations,
                    &runtime,
                    &config,
                    gate::open::Registration::Prepare(request::parse_registration(
                        &bytes,
                        route.body_limit(),
                    )?),
                )
                .await?
            }
            UserRoute::Verify => {
                gate::open::registration(
                    &entry.open()?,
                    &registrations,
                    &runtime,
                    &config,
                    gate::open::Registration::Verify(request::parse_registration(
                        &bytes,
                        route.body_limit(),
                    )?),
                )
                .await?
            }
            UserRoute::Status => {
                gate::open::registration(
                    &entry.open()?,
                    &registrations,
                    &runtime,
                    &config,
                    gate::open::Registration::Status(request::parse_registration(
                        &bytes,
                        route.body_limit(),
                    )?),
                )
                .await?
            }
            _ => return Err(unavailable()),
        };
        serde_json::to_value(response).map_err(|_| unavailable())?
    } else {
        let identities = repositories::identity::D1Identities {
            db: env.d1("DB").map_err(|_| unavailable())?,
        };
        let auth = repositories::auth::D1Auth { db };
        let checked = js_sys::Date::now() as u64;
        match route {
            UserRoute::Identity => {
                // 本地坏输入不预扣共享RPC名额；合法查链仍须先预扣再发往上游。
                let input: projection::Confirm = request::parse_json(&bytes, route.body_limit())?;
                if !citizenserve::shared::ids::hex(&input.block_hash, 32, true) {
                    return Err(BusinessError::new(400, "invalid_block_hash"));
                }
                let rpc = chain::Chain::configured(env, chain::Purpose::Identity).await?;
                projection::confirm(&rpc, &identities, &input, &config.chain_scope, checked).await?
            }
            UserRoute::Challenges => {
                let input: mls_authentication::ChallengeRequest =
                    request::parse_json(&bytes, route.body_limit())?;
                challenge::target(&input)?;
                let now = js_sys::Date::now() as u64;
                let mut bound_session = None;
                let i = if input.purpose == mls_authentication::Purpose::Registration {
                    let rpc = chain::Chain::configured(env, chain::Purpose::Identity).await?;
                    projection::current(
                        &rpc,
                        &identities,
                        &input.account_id,
                        &config.chain_scope,
                        checked,
                        false,
                    )
                    .await?
                } else {
                    let token = if input.purpose == mls_authentication::Purpose::Request {
                        Some(bearer(request)?)
                    } else {
                        None
                    };
                    let hash = token.as_ref().map(|t| session::hash(t)).transpose()?;
                    let key = if let Some(h) = hash.as_deref() {
                        citizenserve::user::ports::ContextKey::Session(h)
                    } else {
                        citizenserve::user::ports::ContextKey::Device {
                            account: &input.account_id,
                            device: &input.public_key[2..],
                        }
                    };
                    let context = auth
                        .context(key, &config)
                        .await?
                        .ok_or(BusinessError::new(401, "invalid_session"))?;
                    if input.purpose == mls_authentication::Purpose::Request {
                        gate::identity::service_authority(
                            &context,
                            &config,
                            js_sys::Date::now() as u64,
                        )?;
                        bound_session = hash;
                    } else {
                        gate::identity::service_device_authority(
                            &context,
                            &config,
                            js_sys::Date::now() as u64,
                        )?;
                    }
                    if context.identity.account_id != input.account_id
                        || context
                            .device
                            .as_ref()
                            .is_none_or(|d| d.public_key != input.public_key)
                    {
                        return Err(BusinessError::new(401, "invalid_mls_proof"));
                    }
                    context.identity
                };
                let c = challenge::issue(
                    &i,
                    &config.service_origin,
                    &input,
                    runtime::random()?,
                    bound_session,
                    now,
                )?;
                let c = if input.purpose == mls_authentication::Purpose::Session {
                    auth.session_challenge(&c).await?
                } else {
                    if !auth.issue_challenge(&c).await? {
                        return Err(BusinessError::new(429, "mls_challenge_limit_reached"));
                    }
                    c
                };
                serde_json::to_value(c).map_err(|_| unavailable())?
            }
            UserRoute::DeletionStatusChallenge => {
                use citizenserve::user::deletion::{self, Purpose, Subject};
                let input: Subject = request::parse_json(&bytes, route.body_limit())?;
                citizenserve::shared::ids::cid(&input.cid_number)?;
                let context = auth
                    .context(
                        citizenserve::user::ports::ContextKey::Recovery {
                            account: &input.account_id,
                        },
                        &config,
                    )
                    .await?
                    .ok_or(BusinessError::new(409, "identity_finalization_pending"))?;
                let identity_deadline =
                    context.identity_deadline(&config, js_sys::Date::now() as u64)?;
                let i = context.identity;
                if i.cid_number != input.cid_number {
                    return Err(BusinessError::new(401, "cid_binding_changed"));
                }
                let repo = repositories::deletion::D1Deletion {
                    db: env.d1("DB").map_err(|_| unavailable())?,
                };
                serde_json::to_value(
                    deletion::issue(
                        &repo,
                        &config,
                        &i,
                        Purpose::Status,
                        runtime::random()?,
                        js_sys::Date::now() as u64,
                        identity_deadline,
                    )
                    .await?,
                )
                .map_err(|_| unavailable())?
            }
            UserRoute::DeletionStatus => {
                use citizenserve::user::deletion::{self, Purpose, Repository, Signed};
                let input: Signed = request::parse_json(&bytes, route.body_limit())?;
                if !citizenserve::shared::ids::hex(&input.challenge_id, 32, false) {
                    return Err(BusinessError::new(
                        401,
                        "account_deletion_challenge_invalid",
                    ));
                }
                let repo = repositories::deletion::D1Deletion {
                    db: env.d1("DB").map_err(|_| unavailable())?,
                };
                let challenge =
                    repo.challenge(&input.challenge_id)
                        .await?
                        .ok_or(BusinessError::new(
                            401,
                            "account_deletion_challenge_invalid",
                        ))?;
                let context = auth
                    .context(
                        citizenserve::user::ports::ContextKey::Recovery {
                            account: &challenge.account_id,
                        },
                        &config,
                    )
                    .await?
                    .ok_or(BusinessError::new(409, "identity_finalization_pending"))?;
                let identity_deadline =
                    context.identity_deadline(&config, js_sys::Date::now() as u64)?;
                let i = context.identity;
                let c = deletion::verify(
                    &repo,
                    &config,
                    &i,
                    &input,
                    Purpose::Status,
                    js_sys::Date::now() as u64,
                    identity_deadline,
                )
                .await?;
                let receipt = repo.status(&c, js_sys::Date::now() as u64).await?;
                receipt.validate(&i)?;
                serde_json::to_value(receipt).map_err(|_| unavailable())?
            }
            UserRoute::Devices => {
                let input: device::Register = request::parse_json(&bytes, route.body_limit())?;
                let rpc = chain::Chain::configured(env, chain::Purpose::Identity).await?;
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
                        checked_proof.as_ref().ok_or_else(unavailable)?,
                        &bytes,
                        &path,
                        js_sys::Date::now() as u64,
                    )
                    .await?,
                )
                .map_err(|_| unavailable())?
            }
            UserRoute::Sessions => {
                let input: session::Request = request::parse_json(&bytes, route.body_limit())?;
                let proof = proof.as_ref().ok_or_else(unavailable)?;
                let context = auth
                    .context(
                        citizenserve::user::ports::ContextKey::Device {
                            account: &input.account_id,
                            device: &proof.device_id,
                        },
                        &config,
                    )
                    .await?
                    .ok_or(BusinessError::new(401, "device_not_registered"))?;
                serde_json::to_value(
                    session::create(
                        &auth,
                        &config,
                        &context,
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
    if gate::open::system(
        gate::open::SystemOperation::Scheduled,
        "cloudflare.scheduled",
        "cloudflare.scheduled",
    )
    .is_err()
    {
        return;
    }
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
        gate::open::system(
            gate::open::SystemOperation::ChatQueue,
            batch.queue().as_str(),
            expected.as_deref().unwrap_or_default(),
        )
        .map_err(|_| worker::Error::RustError("queue_identity_invalid".into()))?;
        tatachat::maintenance::consume(batch, &env).await
    } else if batch.queue() == "citizenserve" {
        gate::open::system(
            gate::open::SystemOperation::Notifications,
            batch.queue().as_str(),
            "citizenserve",
        )
        .map_err(|_| worker::Error::RustError("queue_identity_invalid".into()))?;
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
        server::gate,
        square::{self, routes::SquareRoute},
        user::{contacts, profile_service, routes::ProtectedUserRoute},
    };
    let target = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    request::protected_target(route.method(), &target)?;
    let query = request::query(url.query())?;
    let token = bearer(request)?;
    let auth = repositories::auth::D1Auth {
        db: env.d1("DB").map_err(|_| unavailable())?,
    };
    let context = auth
        .context(
            citizenserve::user::ports::ContextKey::Session(&session::hash(&token)?),
            config,
        )
        .await?
        .ok_or(BusinessError::new(401, "invalid_session"))?;
    // 仅新名片头像按受保护媒体会话读取；原所有业务及完整资料媒体仍需新鲜MLS证明。
    let card_avatar = route == Route::ProtectedUser(ProtectedUserRoute::CardAvatar);
    let proof = if card_avatar {
        None
    } else {
        Some(mls_authentication::read(
            &request
                .headers()
                .get("x-mls-proof")
                .map_err(|_| unavailable())?
                .ok_or(BusinessError::new(401, "invalid_mls_proof"))?,
        )?)
    };
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
    let authority = if let Some(proof) = proof.as_ref() {
        gate::identity::authenticate(
            &auth,
            &context,
            config,
            &token,
            proof,
            route.method(),
            &target,
            &bytes,
            js_sys::Date::now() as u64,
        )
        .await?
    } else {
        gate::identity::service_authority(&context, config, js_sys::Date::now() as u64)?
    };
    let i = &context.identity;
    let authorization = profile_service::Authorization::new(
        &authority,
        config,
        &token,
        js_sys::Date::now() as u64,
    )?;
    // 统一会员门禁只消费同次D1读取结果，普通请求不构造Chain。
    let operation = citizenserve::membership::policy::api(route, url.path())?;
    let membership = context.membership.as_ref();
    let permit = citizenserve::membership::gate::authorize(
        &authority,
        operation.clone(),
        membership,
        js_sys::Date::now() as u64,
    )?;
    let db = || env.d1("DB").map_err(|_| unavailable());
    let objects = || media::R2Storage::configured(env);
    let member = || Ok::<_, BusinessError>(&permit);
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
            tatachat::access(env, config, &authority, &context, &token, &bytes).await?
        }
        Route::Membership(r) => {
            use citizenserve::membership::{self, ports::Repository, routes::MembershipRoute};
            let repo = repositories::membership::D1Membership { db: db()? };
            let current = membership;
            match r {
                MembershipRoute::Current => {
                    authority.membership_deadline(js_sys::Date::now() as u64)?;
                    let prices =
                        membership_prices(env, &config.chain_scope, js_sys::Date::now() as u64)
                            .await?;
                    membership::service::current(
                        &repo,
                        &authorization,
                        current,
                        prices,
                        current
                            .map(|m| m.finalized_block_hash.as_str())
                            .unwrap_or(&i.finalized_block_hash),
                    )
                    .await?
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
                    // 仅平台确认支持可选快照；旧客户端默认保持准确三字段回执。
                    let (input, include_state) = if r == MembershipRoute::Confirm {
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Confirmation {
                            tx_hash: String,
                            block_hash: String,
                            #[serde(default)]
                            include_state: bool,
                        }
                        let input: Confirmation = request::parse_json(&bytes, route.body_limit())?;
                        (
                            citizenserve::chain::transaction::Confirm {
                                tx_hash: input.tx_hash,
                                block_hash: input.block_hash,
                            },
                            input.include_state,
                        )
                    } else {
                        (request::parse_json(&bytes, route.body_limit())?, false)
                    };
                    if !repo.confirmed(&authorization, &input, r, target).await? {
                        authority.require_current(js_sys::Date::now() as u64)?;
                        let rpc = chain::Chain::configured(env, chain::Purpose::Membership).await?;
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
                    }
                    let mut response = serde_json::json!({"ok":true,"tx_hash":input.tx_hash,"block_hash":input.block_hash});
                    if include_state {
                        // 原交易可能已经完成；快照缺失仍保留回执，重试不再查链或付款。
                        authority.membership_deadline(js_sys::Date::now() as u64)?;
                        let state = repo.current(authorization.cid()).await?;
                        let prices =
                            membership_prices(env, &config.chain_scope, js_sys::Date::now() as u64)
                                .await?;
                        let snapshot_auth = profile_service::Authorization::new(
                            &authority,
                            config,
                            &token,
                            js_sys::Date::now() as u64,
                        )?;
                        response["membership_state"] = membership::service::current(
                            &repo,
                            &snapshot_auth,
                            state.as_ref(),
                            prices,
                            state
                                .as_ref()
                                .map(|m| m.finalized_block_hash.as_str())
                                .unwrap_or(&i.finalized_block_hash),
                        )
                        .await?;
                    }
                    response
                }
                MembershipRoute::Overview => {
                    serde_json::json!({"ok":true,"overview":repo.overview(&authorization,current.ok_or(BusinessError::new(403,"membership_required"))?).await?})
                }
                MembershipRoute::Plans => {
                    let cid = url
                        .path()
                        .strip_prefix("/api/membership/creators/")
                        .and_then(|s| s.strip_suffix("/plans"))
                        .ok_or_else(unavailable)?;
                    authority.membership_deadline(js_sys::Date::now() as u64)?;
                    repo.creator_plans(&authorization, cid).await?
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
                        request::parse_json(&bytes, route.body_limit())?,
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
                ProtectedUserRoute::Asset | ProtectedUserRoute::CardAvatar => {
                    use citizenserve::user::profile_assets::{self, Kind};
                    let (cid, kind) = if r == ProtectedUserRoute::CardAvatar {
                        (
                            url.path()
                                .strip_prefix("/api/user/cards/")
                                .and_then(|s| s.strip_suffix("/avatar"))
                                .ok_or_else(unavailable)?,
                            "avatar",
                        )
                    } else {
                        url.path()
                            .strip_prefix("/api/user/profiles/")
                            .and_then(|s| s.split_once("/assets/"))
                            .ok_or_else(unavailable)?
                    };
                    let kind = if kind == "avatar" {
                        Kind::Avatar
                    } else {
                        Kind::Banner
                    };
                    // CID和现有IP挡板独立；同一batch预留请求/最坏字节，先于引用及R2。
                    subject_rate(env, "RATE_READ", authorization.cid()).await?;
                    repositories::membership::D1Membership { db: db()? }
                        .reserve_profile_read(&authorization, &permit, cid, kind)
                        .await?;
                    let h = |name| request.headers().get(name).map_err(|_| unavailable());
                    let data = profile_assets::read(
                        &repositories::media::D1Assets { db: db()? },
                        &objects()?,
                        &authorization,
                        cid,
                        kind,
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
                    if card_avatar {
                        // R2读取后使用原AUTH_ASSERT和真实提交时钟重查准入/设备/会话/绑定及注销围栏。
                        repositories::batch(
                            &db()?,
                            serde_json::json!({"auth":authorization}),
                            "",
                            BusinessError::new(401, "invalid_session"),
                        )
                        .await?;
                    }
                    permit.require(&authorization, &operation, js_sys::Date::now() as u64)?;
                    authority.require_current(js_sys::Date::now() as u64)?;
                    if authority.session_deadline() <= js_sys::Date::now() as u64 {
                        return Err(BusinessError::new(401, "session_expired"));
                    }
                    return Ok(response);
                }
                ProtectedUserRoute::Card => {
                    profile_service::card(
                        &repo,
                        &authorization,
                        url.path()
                            .strip_prefix("/api/user/cards/")
                            .ok_or_else(unavailable)?,
                    )
                    .await?
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
                        &request::parse_json(&bytes, route.body_limit())?,
                    )
                    .await?
                }
                ProtectedUserRoute::DeletionChallenge => {
                    use citizenserve::user::deletion::{self, Purpose};
                    #[derive(serde::Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Empty {}
                    let _: Empty = request::parse_json(&bytes, route.body_limit())?;
                    let repo = repositories::deletion::D1Deletion { db: db()? };
                    serde_json::to_value(
                        deletion::issue(
                            &repo,
                            config,
                            authority.identity(),
                            Purpose::Delete,
                            runtime::random()?,
                            js_sys::Date::now() as u64,
                            authority.recheck_deadline(),
                        )
                        .await?,
                    )
                    .map_err(|_| unavailable())?
                }
                ProtectedUserRoute::Delete => {
                    use citizenserve::user::deletion::{self, Purpose, Repository};
                    let repo = repositories::deletion::D1Deletion { db: db()? };
                    let input = request::parse_json(&bytes, route.body_limit())?;
                    let c = deletion::verify(
                        &repo,
                        config,
                        authority.identity(),
                        &input,
                        Purpose::Delete,
                        js_sys::Date::now() as u64,
                        authority.recheck_deadline(),
                    )
                    .await?;
                    let receipt = repo.begin(&authorization, &c).await?;
                    receipt.validate(authority.identity())?;
                    return Response::from_json(&receipt)
                        .map(|r| r.with_status(202))
                        .map_err(|_| unavailable());
                }
                ProtectedUserRoute::Contacts => {
                    contacts::handle(
                        &repositories::contacts::D1Contacts { db: db()? },
                        &authorization,
                        request::parse_json(&bytes, route.body_limit())?,
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
                        request::parse_json(&bytes, route.body_limit())?,
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
                        request::parse_json(&bytes, route.body_limit())?,
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
                    let input: square::post_service::ConfirmPost =
                        request::parse_json(&bytes, route.body_limit())?;
                    let repo = posts()?;
                    if let Some(result) =
                        square::post_service::confirmed(&repo, &authorization, &input, member()?)
                            .await?
                    {
                        result
                    } else {
                        authority.require_current(js_sys::Date::now() as u64)?;
                        let rpc = chain::Chain::configured(env, chain::Purpose::Post).await?;
                        square::post_service::confirm(
                            &repo,
                            &objects()?,
                            &rpc,
                            &config.chain_scope,
                            &authorization,
                            input,
                            member()?,
                        )
                        .await?
                    }
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
                        &permit,
                    )
                    .await?
                }
                SquareRoute::Posts => {
                    square::feed::author(
                        &repo,
                        &authorization,
                        &square::posts::Query::read(&query)?,
                        &permit,
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
                        request::parse_json(&bytes, route.body_limit())?;
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
                        request::parse_json(&bytes, route.body_limit())?;
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
                        request::parse_json(&bytes, route.body_limit())?;
                    notifications::inbox::mark(&repo, &authorization, input.scope).await?
                }
            }
        }
        _ => return Err(unavailable()),
    };
    // 有界读取仍可能等待外部I/O；交付前不延长既有60秒身份/会员核验期限。
    let delivery_now = js_sys::Date::now() as u64;
    authority.require_current(delivery_now)?;
    if authority.session_deadline() <= delivery_now {
        return Err(BusinessError::new(401, "session_expired"));
    }
    permit.require(&authorization, &operation, js_sys::Date::now() as u64)?;
    // 普通读取只记汇总；发布沿稳定帖子键幂等，交付前授权复核保持。
    match &operation {
        citizenserve::membership::policy::Operation::Profile(target)
            if target != authorization.cid() =>
        {
            repositories::membership::D1Membership { db: db()? }
                .record_read(&authorization, &permit, "profile", 1)
                .await?;
        }
        citizenserve::membership::policy::Operation::Square(SquareRoute::Post) => {
            repositories::membership::D1Membership { db: db()? }
                .record_read(&authorization, &permit, "detail", 1)
                .await?;
        }
        citizenserve::membership::policy::Operation::Square(SquareRoute::ConfirmPost) => {
            repositories::membership::D1Membership { db: db()? }
                .record_publication(
                    &authorization,
                    &permit,
                    result["post_id"].as_str().ok_or_else(unavailable)?,
                )
                .await?;
        }
        _ => {}
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
/// CID独立于IP计数，不能用组合键让换IP/设备重置同一公民额度。
pub(crate) async fn subject_rate(
    env: &Env,
    name: &str,
    cid: &str,
) -> citizenserve::shared::Result<()> {
    citizenserve::shared::ids::cid(cid)?;
    let secret = env
        .secret("HASH_KEY")
        .map_err(|_| unavailable())?
        .to_string();
    if secret.len() < 32 {
        return Err(unavailable());
    }
    let material = format!("cid:{cid}");
    let hash = citizenserve::shared::crypto::hex(&citizenserve::shared::crypto::hmac_sha256(
        secret.as_bytes(),
        material.as_bytes(),
    ));
    let limiter: RateLimiter = env.get_binding(name).map_err(|_| unavailable())?;
    if !limiter
        .limit(format!("{name}:cid:{hash}"))
        .await
        .map_err(|_| unavailable())?
        .success
    {
        return Err(BusinessError::new(429, "external_rate_limited"));
    }
    Ok(())
}
async fn chain_tool(
    request: &mut Request,
    env: &Env,
    r: request::ChainRoute,
    url: &url::Url,
) -> citizenserve::shared::Result<Response> {
    use citizenserve::chain::{
        bootstrap, constitution, finalized, network_ports::Cache, ports::Rpc, relay,
    };
    use request::ChainRoute;
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
                relay_enabled: enabled && chain::Chain::available(env),
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
            let value = constitution::read(
                &chain::Chain::configured(env, chain::Purpose::Constitution).await?,
                &genesis,
                now,
            )
            .await?;
            let _ = cache.put(&key, &value, now, 300).await;
            json_response(&value, 200)
        }
        ChainRoute::RuntimeTarget => {
            // 只返回固定链身份字段；请求方不能选择RPC方法、参数或区块锚点。
            if !citizenserve::shared::ids::hex(&genesis, 32, true) {
                return Err(BusinessError::new(503, "chain_runtime_target_unavailable"));
            }
            let chain = chain::Chain::configured(env, chain::Purpose::Runtime).await?;
            let anchor = finalized::head(&chain, &genesis).await?;
            let version = chain
                .call(
                    "state_getRuntimeVersion",
                    serde_json::json!([anchor.hash.clone()]),
                )
                .await?;
            let spec_version = version["specVersion"]
                .as_u64()
                .filter(|value| *value <= u32::MAX as u64)
                .ok_or_else(|| BusinessError::new(503, "chain_runtime_target_unavailable"))?;
            if version["specName"].as_str() != Some("citizenchain") {
                return Err(BusinessError::new(503, "chain_runtime_target_unavailable"));
            }
            json_response(
                &serde_json::json!({
                    "genesis_hash": genesis,
                    "finalized_head": anchor.hash,
                    "spec_version": spec_version,
                    "spec_name": "citizenchain",
                }),
                200,
            )
        }
        ChainRoute::Extrinsics => {
            if !enabled {
                return Err(BusinessError::new(503, "chain_relay_disabled"));
            }
            // 十六进制和长度在本地检查；真实签名交易解码仍用原已验证链元数据。
            let input: citizenserve::chain::Relay = request::parse_json(&bytes, 131584)?;
            input.bytes()?;
            let chain = chain::Chain::configured(env, chain::Purpose::Relay).await?;
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
                input,
                &hash,
                &citizenserve::shared::crypto::hex(&runtime::random::<16>()?),
                js_sys::Date::now() as u64,
            )
            .await?;
            json_response(&value, status)
        }
    }
}

/// 展示价格只读原KV；缺失不在用户请求中补查链。
pub(crate) async fn membership_prices(
    env: &Env,
    genesis: &str,
    now: u64,
) -> citizenserve::shared::Result<[u128; 3]> {
    use citizenserve::chain::network_ports::Cache;
    let value = cache::DisplayCache::configured(env)
        .get(&format!("membership:prices:{genesis}"), now)
        .await?
        .ok_or(BusinessError::new(
            503,
            "membership_verification_unavailable",
        ))?;
    let prices = value
        .as_array()
        .filter(|a| a.len() == 3)
        .ok_or_else(unavailable)?;
    Ok([
        prices[0].as_u64().ok_or_else(unavailable)? as u128,
        prices[1].as_u64().ok_or_else(unavailable)? as u128,
        prices[2].as_u64().ok_or_else(unavailable)? as u128,
    ])
}
