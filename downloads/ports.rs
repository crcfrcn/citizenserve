use crate::shared::Result;
use serde_json::Value;
pub trait Releases {
    fn get(&self, product: &str) -> impl std::future::Future<Output = Result<Value>> + Send;
}
