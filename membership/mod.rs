pub mod chat;
pub mod creator;
pub mod gate;
pub mod limits;
pub mod policy;
pub mod ports;
pub mod projection;
pub mod routes;
pub mod service;
pub mod usage;
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

/// 原会员/创作者投影的一次读取，不持有Rpc，不建立第二份持久状态。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub cid_number: String,
    pub membership_level: Option<Level>,
    pub creator_cid_number: Option<String>,
    pub tier_id: Option<String>,
    pub billing_period: Option<String>,
    pub subscription_status: Status,
    pub started_at: u64,
    pub last_charged_at: u64,
    pub paid_until: u64,
    pub last_charged_price_fen: u64,
    pub authorized_price_fen: Option<u64>,
    pub finalized_block_number: u64,
    pub finalized_block_hash: String,
}
impl Record {
    pub fn active(&self, now: u64) -> bool {
        matches!(self.subscription_status, Status::Active | Status::Cancelled)
            && self.paid_until > now
    }
    pub fn level(&self, now: u64) -> Result<Level> {
        crate::shared::ids::cid(&self.cid_number)?;
        if self.started_at > self.last_charged_at
            || self.last_charged_at > self.paid_until
            || !self.active(now)
        {
            return Err(Error::new(403, "membership_required"));
        }
        self.membership_level
            .ok_or(Error::new(403, "membership_required"))
    }
    pub fn wire(&self) -> Result<serde_json::Value> {
        // 未同步的授权价不能用上次扣款价或零替代；普通权益判断不依赖展示价格。
        let authorized = self
            .authorized_price_fen
            .ok_or(Error::new(503, "membership_verification_unavailable"))?;
        if authorized > crate::shared::MAX_SAFE_INTEGER
            || self.last_charged_price_fen > crate::shared::MAX_SAFE_INTEGER
        {
            return Err(Error::new(503, "chain_price_out_of_range"));
        }
        Ok(
            serde_json::json!({"membership_level":self.membership_level,"tier_id":self.tier_id,
            "billing_period":self.billing_period,"subscription_status":self.subscription_status,
            "started_at":self.started_at,"last_charged_at":self.last_charged_at,"paid_until":self.paid_until,
            "last_charged_price_fen":self.last_charged_price_fen,"authorized_price_fen":authorized}),
        )
    }
}
