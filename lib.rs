//! 公民业务核心。平台驱动归 server 下的运行 crate，业务目录直接位于产品根目录。
#![forbid(unsafe_code)]
pub mod chain;
pub mod downloads;
pub mod membership;
pub mod notifications;
pub mod server;
pub mod shared;
#[path = "8964/mod.rs"]
pub mod square;
pub mod tatachat;
pub mod topup;
pub mod user;
