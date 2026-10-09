use super::Package;
use crate::tatachat::{auth::Access, Result};
use std::future::Future;

/// 每用户设备只保存一个LastResort包。写入必须核验Access的有效截止。
pub trait Store {
    fn publish(&self, access: &Access, package: &Package) -> impl Future<Output = Result<()>>;
    /// 解析不消费包，按条数和完整KeyPackageBatch字节预算返回有效公开包的稳定前缀。
    /// 首包无法容纳时返回ResourceLimit，不能伪装成没有公开包。
    fn resolve(
        &self,
        user: &str,
        device: Option<&str>,
        now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> impl Future<Output = Result<Vec<Package>>>;
}
