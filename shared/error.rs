use serde::Serialize;
pub type Result<T> = std::result::Result<T, Error>;

/// 错误只包含固定产品代码；平台异常及第三方正文不得进入公开响应。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Error {
    pub status: u16,
    pub code: &'static str,
    pub retryable: bool,
    pub next_action: &'static str,
}
impl Error {
    pub const fn new(status: u16, code: &'static str) -> Self {
        Self {
            status,
            code,
            retryable: false,
            next_action: "none",
        }
    }
    pub const fn registration(
        status: u16,
        code: &'static str,
        retryable: bool,
        next_action: &'static str,
    ) -> Self {
        Self {
            status,
            code,
            retryable,
            next_action,
        }
    }
    pub fn body(&self, registration: bool) -> serde_json::Value {
        if registration {
            serde_json::json!({"ok":false,"protocol_version":1,"error":self.code,
                "retryable":self.retryable,"next_action":self.next_action})
        } else {
            serde_json::json!({"ok":false,"error":self.code})
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for Error {}

#[derive(Serialize)]
pub struct Health {
    pub ok: bool,
    pub product: &'static str,
    pub implementation: &'static str,
    pub account_services_ready: bool,
}
