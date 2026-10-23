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

// 新增资源风控的唯一数值来源；不序列化到原Plan，不改变会员原单文件权益。
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
pub const QUOTA_DAY_MILLIS: u64 = 86_400_000;
pub const CHAT_COMMANDS_DAY: u64 = 20_000;
pub const CHAT_DELIVERIES_DAY: u64 = 10_000;
pub const CHAT_FRAME_BYTES_DAY: u64 = 128 * MIB;
pub const CHAT_CONNECTIONS_DAY: u64 = 512;
pub const GLOBAL_CHAT_COMMANDS_DAY: u64 = 200_000;
pub const GLOBAL_CHAT_DELIVERIES_DAY: u64 = 100_000;
pub const GLOBAL_CHAT_FRAME_BYTES_DAY: u64 = 2 * GIB;
pub const GLOBAL_CHAT_CONNECTIONS_DAY: u64 = 50_000;
pub const DEVICE_FRAMES_MINUTE: u64 = 240;
pub const DEVICE_FRAME_BYTES_MINUTE: u64 = 8 * MIB;
// Ping共用原设备持久分钟窗，不增加主库日额度或放宽总帧预算。
pub const DEVICE_PINGS_MINUTE: u64 = 16;
pub const DEVICE_PING_BYTES: u64 = 64;
// 资料媒体按Kind原最大值预留；请求与字节任一达到CID/全站上限均拒绝。
pub const PROFILE_REQUESTS_DAY: u64 = 1000;
pub const PROFILE_READ_BYTES_DAY: u64 = 64 * MIB;
pub const GLOBAL_PROFILE_REQUESTS_DAY: u64 = 100_000;
pub const GLOBAL_PROFILE_READ_BYTES_DAY: u64 = 10 * GIB;
pub const GLOBAL_ATTACHMENT_BEGINS_DAY: u64 = 5_000;
pub const GLOBAL_ATTACHMENT_COUNT: u64 = 5_000;
pub const GLOBAL_ATTACHMENT_BYTES: u64 = 512 * GIB;
pub const GLOBAL_UPLOAD_BYTES_DAY: u64 = 100 * GIB;
pub const GLOBAL_DELIVERY_BYTES_DAY: u64 = 200 * GIB;
pub const GLOBAL_CHUNK_OPERATIONS_DAY: u64 = 500_000;
pub const GLOBAL_MEDIA_REQUESTS_DAY: u64 = 200_000;
pub const MEDIA_REQUESTS_DAY: u64 = 10_000;

#[derive(Clone, Copy, Debug)]
pub struct ResourceLimits {
    pub pending_attachments: u64,
    pub writing_chunks: u64,
    pub attachment_count: u64,
    pub attachment_bytes: u64,
    pub attachment_begins_day: u64,
    pub upload_bytes_day: u64,
    pub delivery_bytes_day: u64,
    pub chunk_operations_day: u64,
}

pub fn resources(level: Level) -> ResourceLimits {
    let (pending, count, bytes, begins, upload, delivery, operations) = match level {
        Level::Freedom => (1, 8, 32 * MIB, 32, 64 * MIB, 128 * MIB, 512),
        Level::Democracy => (2, 16, 512 * MIB, 128, GIB, 2 * GIB, 4096),
        Level::Spark => (3, 32, 12 * GIB, 256, 12 * GIB, 24 * GIB, 65536),
    };
    ResourceLimits {
        pending_attachments: pending,
        writing_chunks: pending,
        attachment_count: count,
        attachment_bytes: bytes,
        attachment_begins_day: begins,
        upload_bytes_day: upload,
        delivery_bytes_day: delivery,
        chunk_operations_day: operations,
    }
}

// 回收与历史清理的唯一参数；轮内实际I/O继续使用原maintenance::Budget。
pub const CLEANUP_ATTACHMENTS: u32 = 8;
pub const CLEANUP_ROWS: u64 = 1000;
pub const CLEANUP_WINDOW_MILLIS: u64 = 45_000;
pub const CLEANUP_PROGRESS_MILLIS: u64 = 1000;
pub const CLEANUP_FAILURE_MILLIS: u64 = 60_000;
pub const CLEANUP_UNKNOWN_MILLIS: u64 = 300_000;
pub const CLEANUP_IO_DAY: u32 = 1_000_000;
// 这是每轮向日池预扣的名额数，不另建一套轮内计数器，未用不退。
pub const CLEANUP_RESERVE_IO: u32 = 50;
pub const HISTORY_MILLIS: u64 = 7 * QUOTA_DAY_MILLIS;
pub const HISTORY_DAY_OFFSET: u64 = 6 * QUOTA_DAY_MILLIS;
