pub mod gate;
pub mod policy;
pub mod usage;
pub mod chat;
pub mod creator;
pub mod limits;
pub mod ports;
pub mod projection;
pub mod routes;
pub mod service;
use crate::shared::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Freedom,
    Democracy,
    Spark,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Cancelled,
    Expired,
    Terminated,
    Suspended,
    #[serde(rename = "issuerPaused")]
    IssuerPaused,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Membership {
    pub level: Level,
    pub status: Status,
    pub paid_until_millis: u64,
}
impl Membership {
    pub fn active(&self, now: u64) -> bool {
        matches!(self.status, Status::Active | Status::Cancelled) && self.paid_until_millis > now
    }
    pub fn require(&self, now: u64) -> Result<Plan> {
        if self.active(now) {
            Ok(limits::plan(self.level))
        } else {
            Err(Error::new(403, "membership_required"))
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Plan {
    pub membership_level: Level,
    pub chat_file_max_bytes: u64,
    pub video_max_seconds: u32,
    pub video_max_bytes: u64,
    pub article_max_images: u16,
    pub article_max_videos: u8,
    pub monthly_images: u32,
    pub monthly_video_seconds: u32,
    pub active_uploads: u8,
}

pub mod cleanup;
