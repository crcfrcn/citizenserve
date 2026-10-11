use crate::shared::{Error, Result};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Route {
    Health,
    Topup(crate::topup::routes::TopupRoute),
    Downloads(crate::downloads::routes::DownloadRoute),
    Chain(ChainRoute),
    Membership(crate::membership::routes::MembershipRoute),
    User(crate::user::routes::UserRoute),
    ProtectedUser(crate::user::routes::ProtectedUserRoute),
    Square(crate::square::routes::SquareRoute),
    Notifications(crate::notifications::routes::NotificationRoute),
    TataChat(crate::server::tatachat_routes::Route),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChainRoute {
    Bootstrap,
    SdkBootstrap,
    Constitution,
    RuntimeTarget,
    Extrinsics,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Permission {
    Account,
    Registration,
    Public,
    PaymentIntent,
    Settlement,
    Publication,
}
impl Route {
    pub const fn permission(self) -> Permission {
        match self {
            Self::Topup(r) if r.settlement() => Permission::Settlement,
            Self::Topup(
                crate::topup::routes::TopupRoute::Confirm
                | crate::topup::routes::TopupRoute::Status,
            ) => Permission::PaymentIntent,
            Self::Downloads(r) if r.publication() => Permission::Publication,
            Self::Topup(_) | Self::Downloads(_) | Self::Chain(_) | Self::Health => {
                Permission::Public
            }
            Self::User(
                crate::user::routes::UserRoute::DeletionStatusChallenge
                | crate::user::routes::UserRoute::DeletionStatus,
            ) => Permission::Account,
            Self::User(_) => Permission::Registration,
            _ => Permission::Account,
        }
    }
    pub const fn external_tool(self) -> bool {
        matches!(self, Self::Topup(_) | Self::Downloads(_) | Self::Chain(_))
    }
    pub const fn protected(self) -> bool {
        matches!(
            self,
            Self::ProtectedUser(_)
                | Self::Square(_)
                | Self::Notifications(_)
                | Self::Membership(_)
                | Self::TataChat(_)
        )
    }
    pub const fn registration(self) -> bool {
        matches!(self,Self::User(r) if r.registration())
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Health => "GET",
            Self::Topup(r) => r.method(),
            Self::Downloads(r) => r.method(),
            Self::Chain(ChainRoute::Extrinsics) => "POST",
            Self::Chain(_) => "GET",
            Self::Membership(r) => r.method(),
            Self::User(r) => r.method(),
            Self::ProtectedUser(r) => r.method(),
            Self::Square(r) => r.method(),
            Self::Notifications(r) => r.method(),
            Self::TataChat(r) => r.method(),
        }
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Health => 0,
            Self::Topup(r) => r.body_limit(),
            Self::Downloads(r) => r.body_limit(),
            Self::Chain(ChainRoute::Extrinsics) => 131584,
            Self::Chain(_) => 0,
            Self::Membership(r) => r.body_limit(),
            Self::User(r) => r.body_limit(),
            Self::ProtectedUser(r) => r.body_limit(),
            Self::Square(r) => r.body_limit(),
            Self::Notifications(r) => r.body_limit(),
            Self::TataChat(r) => r.body_limit(),
        }
    }
}
/// 生产只有/api前缀，未知路径不能利用guard白名单获得账户服务。
pub fn route(method: &str, path: &str) -> Result<Route> {
    // 外部只接受唯一/api前缀，不接收内部路径或重定向别名。
    let path = path
        .strip_prefix("/api")
        .ok_or(Error::new(404, "route_not_found"))?;
    if method == "GET" && path == "/health" {
        return Ok(Route::Health);
    }
    if let Some(r) = crate::topup::routes::TopupRoute::resolve(method, path) {
        return Ok(Route::Topup(r));
    }
    if let Some(r) = crate::downloads::routes::DownloadRoute::resolve(method, path) {
        return Ok(Route::Downloads(r));
    }
    if let Some(r) = match (method, path) {
        ("GET", "/chain/bootstrap") => Some(ChainRoute::Bootstrap),
        ("GET", "/chain/citizensdk/bootstrap") => Some(ChainRoute::SdkBootstrap),
        ("GET", "/chain/constitution") => Some(ChainRoute::Constitution),
        ("GET", "/chain/runtime-target") => Some(ChainRoute::RuntimeTarget),
        ("POST", "/chain/extrinsics") => Some(ChainRoute::Extrinsics),
        _ => None,
    } {
        return Ok(Route::Chain(r));
    }
    if let Some(r) = crate::membership::routes::MembershipRoute::resolve(method, path) {
        return Ok(Route::Membership(r));
    }
    if let Some(r) = crate::user::routes::ProtectedUserRoute::resolve(method, path) {
        return Ok(Route::ProtectedUser(r));
    }
    if let Some(r) = crate::square::routes::SquareRoute::resolve(method, path) {
        return Ok(Route::Square(r));
    }
    if let Some(r) = crate::notifications::routes::NotificationRoute::resolve(method, path) {
        return Ok(Route::Notifications(r));
    }
    if let Some(r) = crate::server::tatachat_routes::Route::resolve(method, path) {
        return Ok(Route::TataChat(r));
    }
    crate::user::routes::UserRoute::ALL
        .into_iter()
        .find(|r| r.path() == path && r.method() == method)
        .map(Route::User)
        .ok_or(Error::new(404, "route_not_found"))
}
/// 精确目录和查询校验共用于挑战签发与真实处理，不把URL重新编码后拿去验签。
// 通知端点PUT/DELETE也从同一精确路由解析，签名目标包含实际/api前缀。
pub fn protected_target(method: &str, target: &str) -> Result<Route> {
    crate::user::auth::mls_authentication::target(method, target)?;
    let (path, raw) = target
        .split_once('?')
        .map(|(p, q)| (p, Some(q)))
        .unwrap_or((target, None));
    let r = route(method, path)?;
    if !r.protected() {
        return Err(crate::square::routes::invalid());
    }
    let q = query(raw)?;
    match r {
        Route::Square(s) => s.validate_query(&q)?,
        _ => crate::square::routes::keys(&q, &[])?,
    }
    Ok(r)
}
pub fn query(raw: Option<&str>) -> Result<std::collections::BTreeMap<String, String>> {
    let mut map = std::collections::BTreeMap::new();
    if let Some(raw) = raw {
        if raw.is_empty() {
            return Err(crate::square::routes::invalid());
        }
        for part in raw.split('&') {
            let (key, _) = part
                .split_once('=')
                .ok_or_else(crate::square::routes::invalid)?;
            if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
                return Err(crate::square::routes::invalid());
            }
        }
        for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
            if map.insert(k.into_owned(), v.into_owned()).is_some() {
                return Err(crate::square::routes::invalid());
            }
        }
    }
    Ok(map)
}
pub fn validate_request_origin(
    request_url: &str,
    allowed: &str,
    browser_origin: Option<&str>,
) -> Result<url::Url> {
    let url = url::Url::parse(request_url).map_err(|_| Error::new(400, "https_required"))?;
    if url.scheme() != "https" {
        return Err(Error::new(400, "https_required"));
    }
    if url.origin().ascii_serialization() != allowed || browser_origin.is_some_and(|o| o != allowed)
    {
        return Err(Error::new(403, "origin_forbidden"));
    }
    Ok(url)
}
pub fn parse_json<T: serde::de::DeserializeOwned>(body: &[u8], max: usize) -> Result<T> {
    if body.len() > max {
        return Err(Error::new(413, "request_too_large"));
    }
    std::str::from_utf8(body).map_err(|_| Error::new(400, "invalid_utf8"))?;
    // 直接反序列化typed结构，serde拒绝重复字段；不能先Value再丢掉重复键。
    serde_json::from_slice(body).map_err(|_| Error::new(400, "invalid_json"))
}
pub fn parse_registration<T: serde::de::DeserializeOwned>(body: &[u8], max: usize) -> Result<T> {
    if body.len() > max {
        return Err(Error::new(413, "request_too_large"));
    }
    std::str::from_utf8(body).map_err(|_| Error::new(400, "invalid_utf8"))?;
    serde_json::from_slice(body).map_err(|e| {
        Error::new(
            400,
            if e.is_data() {
                "invalid_registration_request"
            } else {
                "invalid_json"
            },
        )
    })
}
