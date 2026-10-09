//! 上传资源边界采用十进制 MB/GB；MLS 控制面预算另用 KiB。
use super::Level;
use serde::Serialize;
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Limits {
    pub image_bytes: u64,
    pub image_dimension: u32,
    pub storage_bytes: u64,
    pub thumbnail_bytes: u64,
    pub cover_bytes: u64,
}
pub fn limits(level: Level) -> Limits {
    let (image_bytes, image_dimension, storage_bytes) = match level {
        Level::Freedom => (1_000_000, 1280, 100_000_000_000),
        Level::Democracy => (2_000_000, 1920, 1_000_000_000_000),
        Level::Spark => (4_000_000, 2560, 10_000_000_000_000),
    };
    Limits {
        image_bytes,
        image_dimension,
        storage_bytes,
        thumbnail_bytes: 256_000,
        cover_bytes: 512_000,
    }
}
