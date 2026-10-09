use crate::shared::Result;
use serde_json::Value;
/// 平台只负责固定端点的RPC传输，不接收客户端URL；核心判断finalized事实。
pub trait Rpc {
    fn call(
        &self,
        method: &str,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}
