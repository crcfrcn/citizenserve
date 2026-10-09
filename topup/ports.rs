use crate::shared::Result;
use serde_json::Value;
pub trait Clock {
    fn now(&self) -> u64;
}
pub trait PaymentRpc {
    fn call(
        &self,
        method: super::evm_verify::Method,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}
pub trait Repository {
    fn by_tx(
        &self,
        chain: u64,
        tx: &str,
    ) -> impl std::future::Future<Output = Result<Option<super::orders::Order>>> + Send;
    fn by_id(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<super::orders::Order>>> + Send;
    fn insert(
        &self,
        order: &super::orders::Order,
        proof: &super::evm_verify::Payment,
    ) -> impl std::future::Future<Output = Result<super::orders::Order>> + Send;
    fn consume_rpc_budget(&self, now: u64) -> impl std::future::Future<Output = Result<()>> + Send;
    fn list(
        &self,
        history: bool,
        limit: u32,
        cursor: Option<&super::settlement::Cursor>,
    ) -> impl std::future::Future<Output = Result<Vec<super::orders::Order>>> + Send;
    fn claim(
        &self,
        id: &str,
        claim: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<super::orders::Order>> + Send;
    fn paid(
        &self,
        before: &super::orders::Order,
        proof: &crate::chain::settlement::Proof,
        payment: &super::evm_verify::Payment,
        now: u64,
    ) -> impl std::future::Future<Output = Result<super::orders::Order>> + Send;
    fn exception(
        &self,
        id: &str,
        claim: &str,
        reason: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<super::orders::Order>> + Send;
}
