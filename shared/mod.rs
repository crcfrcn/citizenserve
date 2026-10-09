pub mod crypto;
pub mod error;
pub mod ids;
pub use error::{Error, Result};
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const KIB: usize = 1024;
pub const MIB: usize = 1024 * KIB;
