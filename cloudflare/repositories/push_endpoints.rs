use super::{batch, fail, first, string};
use citizenserve::{
    notifications::{
        endpoint::{Register, Stored},
        ports::Endpoints,
    },
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde_json::json;
use worker::{send::SendFuture, D1Database};
pub struct D1Endpoints {
    pub db: D1Database,
}
impl Endpoints for D1Endpoints {
    fn register(
        &self,
        auth: &Authorization,
        input: &Register,
    ) -> impl std::future::Future<Output = Result<Stored>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"input":input}),
                include_str!("../sql/register_push_endpoint.sql"),
                Error::new(409, "push_endpoint_conflict"),
            )
            .await?;
            first(
                &self.db,
                "SELECT * FROM push_endpoints WHERE cid_number=?1 AND device_id=?2",
                &[string(auth.cid()), string(auth.device())],
            )
            .await?
            .ok_or_else(fail)
        })
    }
    fn remove(&self, auth: &Authorization) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth}),
                include_str!("../sql/delete_push_endpoint.sql"),
                Error::new(409, "push_endpoint_conflict"),
            )
            .await?;
            Ok(())
        })
    }
}
