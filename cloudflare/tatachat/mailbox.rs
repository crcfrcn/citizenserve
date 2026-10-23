//! 实时通知是提交后的加速提示；队列或DO失败不撤销已经接受的密文。
#[path = "mailbox_store.rs"]
mod store;
use citizenserve::tatachat::{service::Notification, Result};
use worker::Env;
pub(crate) async fn notify(env: &Env, notifications: &[Notification]) -> Result<()> {
    for item in notifications {
        let _ = super::realtime::notify(env, &item.recipient, &item.event).await;
    }
    super::maintenance::dispatch(env).await
}
