//! 公民业务核心。平台驱动归根目录 cloudflare 运行 crate，业务目录直接位于产品根目录。
#![forbid(unsafe_code)]
pub mod chain;
pub mod membership;
pub mod notifications;
pub mod gate;
pub mod maintenance;
pub mod shared;
#[path = "8964/mod.rs"]
pub mod square;
pub mod tatachat;
pub mod topup;
pub mod user;
