//! 精确请求识别及原始签名目标解析；此层不访问数据库、链或对象存储。
use super::policy::{self, CidRule, Rule};
use crate::shared::{Error, Result};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Route {
    Health,
    Topup(crate::topup::routes::TopupRoute),
    Chain(ChainRoute),
    Membership(crate::membership::routes::MembershipRoute),
    User(crate::user::routes::UserRoute),
    ProtectedUser(crate::user::routes::ProtectedUserRoute),
    Square(crate::square::routes::SquareRoute),
    Notifications(crate::notifications::routes::NotificationRoute),
    TataChat(crate::tatachat::routes::Route),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChainRoute {
    Bootstrap,
    SdkBootstrap,
    Constitution,
    RuntimeTarget,
    Extrinsics,
}
impl Route {
    pub const fn rule(self) -> Rule {
        policy::api(self)
    }
    pub const fn protected(self) -> bool {
        matches!(self.rule(), Rule::Cid(CidRule::Business|CidRule::Avatar))
    }
    pub const fn registration(self) -> bool {
        matches!(self,Self::User(r) if r.registration())
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Health => "GET",
            Self::Topup(r) => r.method(),
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
/// API只接受/api前缀；未知路径不能借门禁的开放策略取得账户服务。
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
    if let Some(r) = crate::tatachat::routes::Route::resolve(method, path) {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkRoute {
    Install,
    Icon,
    Rpc,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatRoute {
    Realtime,
    Attachment { id: String, chunk: u32 },
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Endpoint {
    Api(Route),
    Network(NetworkRoute),
    Chat(ChatRoute),
    Media(String),
}
pub struct Incoming<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub service_origin: Option<&'a str>,
    pub media_origin: Option<&'a str>,
    pub browser_origin: Option<&'a str>,
    pub preflight_method: Option<&'a str>,
    pub preflight_headers: Option<&'a str>,
    pub content_length: Option<&'a str>,
    pub authorization: Option<&'a str>,
    pub mls_proof: Option<&'a str>,
    pub internal_header: bool,
    pub upgrade: Option<&'a str>,
    pub websocket_protocol: Option<&'a str>,
}
pub(super) struct Recognized {
    pub endpoint: Endpoint,
    pub method: String,
    pub target: String,
    pub preflight: bool,
}
pub fn network_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| u.origin().ascii_serialization() == policy::NETWORK_ORIGIN)
}

/// 资源键必须由现有对象规则重新推导，不能把任意桶对象挂成受保护业务媒体。
pub fn media_key(path: &str) -> Result<String> {
    let key = path
        .strip_prefix('/')
        .ok_or(Error::new(404, "route_not_found"))?;
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 7
        || parts[0] != "square"
        || parts[2] != "posts"
        || parts[4] != "media"
        || crate::shared::ids::cid(parts[1]).is_err()
        || !crate::square::routes::identifier(parts[3])
        || parts[5].is_empty()
        || (parts[5].len() > 1 && parts[5].starts_with('0'))
        || !parts[5].bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::new(404, "route_not_found"));
    }
    let index: u32 = parts[5]
        .parse()
        .map_err(|_| Error::new(404, "route_not_found"))?;
    let video = matches!(parts[6], "source.mp4" | "cover.webp");
    let (source, derivative) =
        crate::square::objects::media_keys(parts[1], parts[3], index, video)?;
    if key != source && key != derivative {
        return Err(Error::new(404, "route_not_found"));
    }
    Ok(key.to_owned())
}

pub(super) fn recognize(input: &Incoming<'_>) -> Result<Recognized> {
    if input.internal_header {
        // 保持原聊天外部请求的无效形状合同，拒绝仍发生在任何业务I/O之前。
        return Err(Error::new(400, "invalid_request"));
    }
    if input.url.len() > 8192
        || input
            .url
            .bytes()
            .any(|b| b.is_ascii_control() || b == b' ' || b == b'\\')
    {
        return Err(Error::new(404, "route_not_found"));
    }
    let url = url::Url::parse(input.url).map_err(|_| Error::new(400, "https_required"))?;
    let network_host = url.host_str() == url::Url::parse(policy::NETWORK_ORIGIN).ok().as_ref().and_then(|u|u.host_str());
    let network = url.origin().ascii_serialization() == policy::NETWORK_ORIGIN;
    if network_host && !network {return Err(Error::new(404,"rpc_route_not_found"));}
    if url.scheme() != "https" {
        return Err(Error::new(400, "https_required"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::new(404, "route_not_found"));
    }
    let preflight = input.method == "OPTIONS";
    let method = if preflight {
        input
            .preflight_method
            .ok_or(Error::new(400, "invalid_registration_request"))?
    } else {
        input.method
    };
    let target = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    // Url会折叠点路径；有签名用途的目标不能用重编码/归一化替换实际输入。
    let tail = input
        .url
        .split_once("://")
        .ok_or(Error::new(404, "route_not_found"))?
        .1;
    let raw = tail.find('/').map(|i| &tail[i..]).unwrap_or("/");
    if raw != target {
        return Err(Error::new(404, "route_not_found"));
    }
    let endpoint = if network {
        if url.query().is_some() {
            return Err(Error::new(404, "rpc_route_not_found"));
        }
        Endpoint::Network(match (method, url.path()) {
            ("GET" | "HEAD", "/") => NetworkRoute::Install,
            ("GET" | "HEAD", "/icons/gmb.png") => NetworkRoute::Icon,
            ("POST", "/") => NetworkRoute::Rpc,
                (_,"/"|"/icons/gmb.png") => return Err(Error::new(405, "rpc_method_not_allowed")),
                _ => return Err(Error::new(404, "rpc_route_not_found")),
        })
    } else if input
        .media_origin
        .is_some_and(|o| o == url.origin().ascii_serialization())
        && url.path().starts_with("/square/")
    {
        if !matches!(method, "GET" | "HEAD") || url.query().is_some() {
            return Err(Error::new(404, "route_not_found"));
        }
        Endpoint::Media(media_key(url.path())?)
    } else {
        let origin = input
            .service_origin
            .ok_or(Error::new(503, "registration_not_configured"))?;
        validate_request_origin(input.url, origin, input.browser_origin)?;
        if url.path() == "/api/tatachat/realtime" {
            if method != "GET" || url.query().is_some() {
                return Err(Error::new(400, "invalid_request"));
            }
            Endpoint::Chat(ChatRoute::Realtime)
        } else if url.path().starts_with("/api/tatachat/attachments/") {
            if !matches!(method, "GET" | "PUT") || url.query().is_some() {
                return Err(Error::new(400, "invalid_request"));
            }
            let p: Vec<_> = url.path().split('/').collect();
            if p.len() != 7
                || p[5] != "chunks"
                || p[4].is_empty()
                || p[4].len() > 128
                || !p[4]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                || p[6].is_empty()
                || !p[6].bytes().all(|b| b.is_ascii_digit())
                || p[6].len() > 1 && p[6].starts_with('0')
            {
                return Err(Error::new(400, "invalid_request"));
            }
            Endpoint::Chat(ChatRoute::Attachment {
                id: p[4].into(),
                chunk: p[6]
                    .parse()
                    .map_err(|_| Error::new(400, "invalid_request"))?,
            })
        } else {
            let route = route(method, url.path())?;
            match route {
                Route::Topup(r) => r.validate_query(url.query())?,
                Route::Square(r) => r.validate_query(&query(url.query())?)?,
                Route::User(crate::user::routes::UserRoute::Page) => crate::square::routes::keys(
                    &query(url.query())?,
                    &["verification_id", "page_token"],
                )?,
                _ => crate::square::routes::keys(&query(url.query())?, &[])?,
            }
            Endpoint::Api(route)
        }
    };
    let media = matches!(&endpoint, Endpoint::Media(_));
    if !network
        && input.browser_origin.is_some_and(|o| {
            o != url.origin().ascii_serialization() && !(media && input.service_origin == Some(o))
        })
    {
        return Err(Error::new(403, "origin_forbidden"));
    }
    Ok(Recognized {
        endpoint,
        method: method.into(),
        target,
        preflight,
    })
}

pub(super) fn cheap_checks(input: &Incoming<'_>, request: &Recognized, rule: Rule) -> Result<()> {
    if request.preflight {
        if input.content_length.is_some_and(|v|v.parse::<usize>().ok()!=Some(0)) {
            return Err(Error::new(400,"invalid_api_body"));
        }
        if let Some(headers) = input.preflight_headers {
            if headers.len() > 4096
                || headers.split(',').any(|name| {
                    !policy::headers(&request.endpoint)
                        .contains(&name.trim().to_ascii_lowercase().as_str())
                })
            {
                return Err(Error::new(400, "invalid_preflight_headers"));
            }
        }
    }
    let limit = match &request.endpoint {
        Endpoint::Api(r) => r.body_limit(),
        Endpoint::Network(NetworkRoute::Rpc) => 128 * 1024,
        Endpoint::Network(_) | Endpoint::Media(_) | Endpoint::Chat(ChatRoute::Realtime) => 0,
        Endpoint::Chat(ChatRoute::Attachment { .. }) if request.method == "PUT" => {
            policy::MAX_CHUNK_BYTES
        }
        Endpoint::Chat(ChatRoute::Attachment { .. }) => 0,
    };
    if !request.preflight {
        // 真实升级形状先于凭据校验，保留原400；合法升级缺凭据仍由下方拒绝403。
        if matches!(&request.endpoint,Endpoint::Chat(ChatRoute::Realtime))
            && (input.upgrade!=Some("websocket")
                || !input.websocket_protocol.is_some_and(|v|v.split(',').any(|p|p.trim()=="tatachat"))) {
            return Err(Error::new(400,"invalid_request"));
        }
        if let Some(raw) = input.content_length {
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Error::new(400, "content_length_invalid"));
            }
            let length: usize = raw
                .parse()
                .map_err(|_| Error::new(400, "content_length_invalid"))?;
            if length > limit {
                return Err(if limit==0 {Error::new(400,"invalid_api_body")} else {Error::new(413,"request_too_large")});
            }
        }
        if let Rule::Cid(CidRule::Business | CidRule::Media | CidRule::Avatar) = rule {
            let token = input
                .authorization
                .and_then(|v| v.strip_prefix("Bearer "))
                .ok_or(Error::new(401, "invalid_session"))?;
            crate::user::auth::session::hash(token)?;
        }
        if policy::requires_mls(rule) && input.mls_proof.is_none()
        {
            return Err(Error::new(401, "invalid_mls_proof"));
        }
        if rule == Rule::Cid(CidRule::Chat)
            && input
                .authorization
                .and_then(|v| v.strip_prefix("Bearer "))
                .is_none_or(|v| v.is_empty() || v.len() > 8192)
        {
            return Err(Error::new(403, "forbidden"));
        }
    }
    Ok(())
}
