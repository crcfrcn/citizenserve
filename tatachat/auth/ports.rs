use super::HostAccess;
use crate::tatachat::Result;
use std::future::Future;

/// 宿主返回当前身份、设备、会话和权益的可信结果；未知状态必须返回错误。
/// 修订须覆盖影响授权的全部事实，时钟来自服务器，禁止使用客户端时间。
pub trait Host {
    fn now_millis(&self) -> u64;
    fn recheck(&self, previous: &HostAccess) -> impl Future<Output = Result<HostAccess>>;
    /// 推送目标根据登记的会话引用核实当前宿主事实，签发新的中性目标许可。
    /// 普通会话、准入或设备失效必须拒绝；不能照抄登记时已过期的短期权限。
    fn authorize_wake(&self, registered: &HostAccess) -> impl Future<Output = Result<HostAccess>>;
}
