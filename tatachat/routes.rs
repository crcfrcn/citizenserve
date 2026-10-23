//! 宿主许可是普通MLS账户接口；WSS/附件的数据面按模块凭证处理，不能签普通挑战。
use crate::shared::{Error, Result};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Route {
    Access,
}
impl Route {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        (method == "POST" && path == "/tatachat/access").then_some(Self::Access)
    }
    pub const fn method(self) -> &'static str {
        "POST"
    }
    pub const fn body_limit(self) -> usize {
        1024
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessRequest {}
pub fn access_body(bytes: &[u8]) -> Result<()> {
    if bytes.len() > 1024 {
        return Err(Error::new(413, "request_too_large"));
    }
    let value = std::str::from_utf8(bytes).map_err(|_| Error::new(400, "invalid_utf8"))?;
    // serde的零字段结构也可能接收空数组，额外固定对象形状，禁止[]/null冒充{}。
    if !value.trim_start().starts_with('{') {
        return Err(Error::new(400, "invalid_chat_access"));
    }
    let _: AccessRequest =
        serde_json::from_slice(bytes).map_err(|_| Error::new(400, "invalid_chat_access"))?;
    Ok(())
}
