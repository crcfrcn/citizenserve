use crate::shared::Result;
use serde_json::Value;
pub trait Cache {
    fn get(
        &self,
        key: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Option<Value>>> + Send;
    fn put(
        &self,
        key: &str,
        value: &Value,
        now: u64,
        ttl: u32,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}
pub enum BroadcastOutcome {
    Accepted(String),
    Rejected(String),
}
pub trait Broadcaster {
    fn broadcast(
        &self,
        extrinsic: &str,
    ) -> impl std::future::Future<Output = Result<BroadcastOutcome>> + Send;
}
pub trait Ethereum {
    fn call(
        &self,
        request: &super::ethereum_rpc::Request,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}
