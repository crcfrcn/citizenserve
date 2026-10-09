use super::{
    publication::{Row, Update},
    routes::Platform,
};
use crate::shared::Result;
use serde_json::Value;
pub trait Releases {
    fn commit(
        &self,
        product: &str,
        tag: &str,
    ) -> impl std::future::Future<Output = Result<String>> + Send;
    fn get(
        &self,
        product: &str,
        tag: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}
pub trait Repository {
    fn read(&self, p: Platform) -> impl std::future::Future<Output = Result<Row>> + Send;
    fn publish(
        &self,
        p: Platform,
        input: &Update,
        now: u64,
    ) -> impl std::future::Future<Output = Result<Row>> + Send;
}
