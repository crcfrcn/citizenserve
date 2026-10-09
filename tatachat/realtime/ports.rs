use super::Event;
use crate::tatachat::{auth::Device, Result};
use std::future::Future;

/// 通知是提交后的加速信号，收件箱及持久outbox才是可靠真源。
/// 驱动须按设备定位并检查接收连接当前权限；不得把通知作为客户端命令处理。
pub trait Sink {
    fn notify(&self, recipient: &Device, event: &Event) -> impl Future<Output = Result<()>>;
}
