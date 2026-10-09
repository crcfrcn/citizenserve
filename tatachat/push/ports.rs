use super::{Endpoint, Finish, InvalidEndpoint, Lease, Outcome, PushPlatform};
use crate::tatachat::{
    auth::{Access, Device},
    Result,
};
use serde_json::Value;
use std::future::Future;

pub trait Store {
    /// 原子分配单调端点代际，禁止同令牌抢占其他当前设备；删除后代际不归零。
    fn register(&self, access: &Access, endpoint: &Endpoint) -> impl Future<Output = Result<()>>;
    fn remove(&self, access: &Access, platform: PushPlatform) -> impl Future<Output = Result<()>>;
    /// 只领取仍有未ACK/未过期密文的任务；原子增加attempts并生成唯一lease_id。
    fn claim(&self, now: u64, limit: u32) -> impl Future<Output = Result<Vec<Lease>>>;
    fn endpoints(&self, device: &Device) -> impl Future<Output = Result<Vec<Endpoint>>>;
    /// 只有未到期的相同租约、仍有未ACK/未过期密文才可续期；重新领取不能复用旧lease_id。
    fn renew(&self, lease: &Lease, now: u64) -> impl Future<Output = Result<Lease>>;
    /// 同事务检查当前租约、设置终态并按平台/端点代际条件移除失效端点。
    /// Failed保持诊断终态，Cron不能重置尝试次数；旧租约完成必须失败。
    fn finish(
        &self,
        lease: &Lease,
        finish: Finish,
        invalid: &[InvalidEndpoint],
        now: u64,
    ) -> impl Future<Output = Result<()>>;
}

/// 平台只执行提供方签名、令牌缓存和有界HTTPS；负载由通用模块生成。
/// 固定官方目标，网络最长10秒、响应最多16KiB；配置/鉴权错误返回Blocked，
/// 429/5xx返回Retryable，只有确证设备令牌失效才返回InvalidEndpoint。
/// 实际发送前还须按服务器时钟核验endpoint.access的到期与再核验截止。
pub trait Provider {
    fn send(
        &self,
        endpoint: &Endpoint,
        payload: &Value,
        now_seconds: u64,
    ) -> impl Future<Output = Result<Outcome>>;
}
