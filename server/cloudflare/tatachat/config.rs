//! 配置来自当前产品绑定；运行上限不扩大宿主许可。
use citizenserve::tatachat::{push, Error, Limits, Result};
use worker::Env;
pub const MAX_CONNECTIONS: usize = 4;
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const LIMITS: Limits = Limits {
    max_frame_bytes: 2 * 1024 * 1024,
    max_attachment_bytes: citizenserve::shared::MAX_SAFE_INTEGER,
};
pub fn push_config(env: &Env) -> push::Config {
    push::Config {
        ios_app_id: env
            .var("APNS_TOPIC")
            .map(|v| v.to_string())
            .unwrap_or_default(),
        android_app_id: env
            .var("FCM_PROJECT")
            .map(|v| v.to_string())
            .unwrap_or_default(),
    }
}
pub fn now() -> u64 {
    js_sys::Date::now() as u64
}
pub fn random_id() -> Result<String> {
    crate::runtime::random::<16>()
        .map(|v| citizenserve::shared::crypto::hex(&v))
        .map_err(|_| Error::StorageUnavailable)
}
pub fn available(env: &Env) -> bool {
    env.d1("TATACHAT_DB").is_ok()
        && env.bucket("TATACHAT_ATTACHMENTS").is_ok()
        && env.durable_object("TATACHAT_DEVICES").is_ok()
        && env.queue("TATACHAT_PUSH").is_ok()
}
