use super::{config::Network, orders::Order, settlement::Cursor};
use crate::shared::Result;
use serde_json::Value;
pub trait Clock {
    fn now(&self) -> u64;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    ChainId,
    Transaction,
    Receipt,
    Block,
    Code,
    Call,
    TronGenesis,
    TronTransaction,
    TronReceipt,
    TronBlock,
    TronBalance,
    SolGenesis,
    SolTransaction,
    SolBlock,
    SolAccounts,
}
impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Self::ChainId => "eth_chainId",
            Self::Transaction => "eth_getTransactionByHash",
            Self::Receipt => "eth_getTransactionReceipt",
            Self::Block => "eth_getBlockByNumber",
            Self::Code => "eth_getCode",
            Self::Call => "eth_call",
            Self::TronGenesis | Self::TronBlock => "walletsolidity/getblockbynum",
            Self::TronTransaction => "walletsolidity/gettransactionbyid",
            Self::TronBalance => "walletsolidity/triggerconstantcontract",
            Self::TronReceipt => "walletsolidity/gettransactioninfobyid",
            Self::SolGenesis => "getGenesisHash",
            Self::SolTransaction => "getTransaction",
            Self::SolBlock => "getBlock",
            Self::SolAccounts => "getTokenAccountsByOwner",
        }
    }
}
pub trait PaymentRpc {
    fn call(
        &self,
        method: Method,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}
pub trait Repository {
    fn by_id(&self, id: &str) -> impl std::future::Future<Output = Result<Option<Order>>> + Send;
    fn insert(&self, order: &Order) -> impl std::future::Future<Output = Result<Order>> + Send;
    fn save(
        &self,
        before: &Order,
        after: &Order,
    ) -> impl std::future::Future<Output = Result<Order>> + Send;
    fn list(
        &self,
        limit: u32,
        cursor: Option<&Cursor>,
    ) -> impl std::future::Future<Output = Result<Vec<Order>>> + Send;
    fn pending(&self, limit: u32) -> impl std::future::Future<Output = Result<Vec<Order>>> + Send;
    fn lock(
        &self,
        order: &Order,
        account: &str,
        claim: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn unlock(
        &self,
        order: &str,
        account: &str,
        claim: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn budget(
        &self,
        network: Network,
        now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}
