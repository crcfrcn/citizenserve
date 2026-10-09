//! 平台无关的通用聊天服务。公开协议来自SDK，身份与权益只消费可信宿主结果。
//! 所有携带Access的写入/对象端口必须在实际执行时核验服务器时钟与deadline；
//! 协调器传入的now只用于业务时间计算，不能代替驱动提交时的授权截止检查。
pub mod attachment;
pub mod auth;
pub mod key;
pub mod lifecycle;
pub mod mailbox;
pub mod protocol;
pub mod push;
pub mod realtime;
pub mod service;

pub type Result<T> = std::result::Result<T, Error>;

/// 对外只暴露稳定错误码，平台驱动不得回传数据库、密钥或提供方异常正文。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    Forbidden,
    NotFound,
    Conflict,
    ResourceLimit,
    StorageUnavailable,
}
impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::ResourceLimit => "resource_limit",
            Self::StorageUnavailable => "storage_unavailable",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for Error {}

/// 部署上限与宿主额度同时生效；帧预算必须在解码之前应用。
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_attachment_bytes: u64,
    pub max_frame_bytes: usize,
}
impl Limits {
    pub fn validate(self) -> Result<Self> {
        if self.max_attachment_bytes == 0 || self.max_frame_bytes == 0 {
            return Err(Error::ResourceLimit);
        }
        Ok(self)
    }
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value
            .bytes()
            .any(|byte| byte == b':' || byte.is_ascii_control())
}
pub(crate) fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests;
