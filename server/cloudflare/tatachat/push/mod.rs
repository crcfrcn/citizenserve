//! 平台执行唯一核心的唤醒服务，普通通知协议和端点表保持独立。
mod provider;
mod store;
use citizenserve::tatachat::Result;
use worker::Env;
pub(crate) async fn drain(env: &Env) -> Result<()> {
    let host = super::host(env)?;
    let store = super::D1Store::new(env)?;
    let provider = provider::Push::new(env.clone());
    citizenserve::tatachat::push::service::drain(
        &store,
        &host,
        &provider,
        &super::config::push_config(env),
        1,
    )
    .await
}
