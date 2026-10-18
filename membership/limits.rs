//! 上传资源边界采用十进制 MB/GB；MLS 控制面预算另用 KiB。
use super::{Level, Plan};
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

/// 会员档位及所有业务额度的唯一数值来源；原始字节和周期规则保持。
pub fn plan(level: Level) -> Plan {
    let (
        chat,
        seconds,
        bytes,
        images,
        videos,
        monthly_images,
        monthly_video_seconds,
        active_uploads,
    ) = match level {
        Level::Freedom => (10 * 1024 * 1024, 180, 16_000_000, 50, 1, 300, 18_000, 1),
        Level::Democracy => (
            100 * 1024 * 1024,
            1800,
            300_000_000,
            100,
            3,
            1500,
            60_000,
            2,
        ),
        Level::Spark => (
            5120 * 1024 * 1024u64,
            10800,
            3_000_000_000,
            100,
            10,
            5000,
            600_000,
            3,
        ),
    };
    Plan {
        membership_level: level,
        chat_file_max_bytes: chat,
        video_max_seconds: seconds,
        video_max_bytes: bytes,
        article_max_images: images,
        article_max_videos: videos,
        monthly_images,
        monthly_video_seconds,
        active_uploads,
    }
}
