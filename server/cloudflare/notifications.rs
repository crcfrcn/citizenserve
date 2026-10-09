//! 已由共同入口完成Bearer/MLS/当前身份校验，只处理端点typed正文。
use citizenserve::{
    notifications::{endpoint, routes::NotificationRoute},
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use worker::D1Database;
pub async fn endpoint(
    db: D1Database,
    auth: &Authorization,
    route: NotificationRoute,
    bytes: &[u8],
) -> Result<serde_json::Value> {
    let repo = super::repositories::push_endpoints::D1Endpoints { db };
    match route {
        NotificationRoute::RegisterEndpoint => {
            endpoint::register(
                &repo,
                auth,
                citizenserve::server::routes::parse_json(bytes, 16384)?,
            )
            .await
        }
        NotificationRoute::DeleteEndpoint if bytes.is_empty() => {
            endpoint::remove(&repo, auth).await
        }
        _ => Err(Error::new(400, "invalid_push_endpoint_request")),
    }
}
