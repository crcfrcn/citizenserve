//! Queue只携带定位符；任务内容与目标从数据库复读，不能从消息中指定URL/token。
use crate::shared::{crypto, ids, Error, Result};
use serde::{Deserialize, Serialize};
pub const MAX_ATTEMPTS: u8 = 4;
pub const LEASE_MILLIS: u64 = 120_000;
pub const RENEW_MILLIS: u64 = 45_000;
pub const RETENTION_MILLIS: u64 = 7 * 86_400_000;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Fanout,
    Delivery,
    Maintenance,
}
impl Kind {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Fanout => "nj_",
            Self::Delivery => "nd_",
            Self::Maintenance => "mt_",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub version: u8,
    pub kind: Kind,
    pub id: String,
}
impl Message {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !self
                .id
                .strip_prefix(self.kind.prefix())
                .is_some_and(|s| ids::hex(s, 32, false))
        {
            return Err(Error::new(400, "invalid_notification_message"));
        }
        Ok(())
    }
}
pub fn id(kind: Kind, fields: &[&str]) -> String {
    let bytes = serde_json::to_vec(fields).expect("strings serialize");
    format!("{}{}", kind.prefix(), crypto::hex(&crypto::sha256(&bytes)))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Post,
    StorageCleanup,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Leased,
    Done,
    Accepted,
    Cancelled,
    Blocked,
}
impl State {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Accepted | Self::Cancelled | Self::Blocked
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub created_at: u64,
    pub cid_number: String,
}
impl Cursor {
    pub fn after(&self, before: &Self) -> bool {
        (self.created_at, &self.cid_number) > (before.created_at, &before.cid_number)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub job_id: String,
    pub source_kind: Source,
    pub source_key: String,
    pub cid_number: String,
    pub post_id: Option<String>,
    pub tx_hash: Option<String>,
    pub lapse_at: Option<u64>,
    pub created_at: u64,
    pub expires_at: u64,
    pub state: State,
    pub cursor_created_at: Option<u64>,
    pub cursor_cid_number: Option<String>,
}
impl Job {
    pub fn cursor(&self) -> Result<Option<Cursor>> {
        match (&self.cursor_created_at, &self.cursor_cid_number) {
            (None, None) => Ok(None),
            (Some(t), Some(c)) => {
                ids::cid(c)?;
                Ok(Some(Cursor {
                    created_at: *t,
                    cid_number: c.clone(),
                }))
            }
            _ => Err(Error::new(503, "invalid_notification_cursor")),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    pub delivery_id: String,
    pub job_id: String,
    pub cid_number: String,
    pub account_id: String,
    pub binding_revision: u64,
    pub device_id: String,
    pub endpoint_revision: u64,
    pub state: State,
    pub attempts: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lease {
    id: String,
    kind: Kind,
    token: String,
    acquired_at: u64,
    expires_at: u64,
    attempts: u8,
}
impl Lease {
    pub fn acquired(id: String, kind: Kind, token: String, now: u64, attempts: u8) -> Result<Self> {
        Message {
            version: 1,
            kind,
            id: id.clone(),
        }
        .validate()?;
        if !ids::hex(&token, 16, false) || attempts == 0 || attempts > MAX_ATTEMPTS {
            return Err(Error::new(503, "invalid_job_lease"));
        }
        Ok(Self {
            id,
            kind,
            token,
            acquired_at: now,
            expires_at: now
                .checked_add(LEASE_MILLIS)
                .ok_or(Error::new(503, "invalid_job_lease"))?,
            attempts,
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn kind(&self) -> Kind {
        self.kind
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn attempts(&self) -> u8 {
        self.attempts
    }
    pub fn acquired_at(&self) -> u64 {
        self.acquired_at
    }
    pub fn valid(&self, now: u64, reserve: u64) -> Result<()> {
        if now < self.acquired_at || now.saturating_add(reserve) >= self.expires_at {
            return Err(Error::new(503, "job_lease_expired"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Disposition {
    Ack,
    Retry(u32),
}
pub fn retry_delay(attempt: u8, retry_after: Option<u32>) -> u32 {
    retry_after
        .unwrap_or(30u32.saturating_mul(1u32 << attempt.min(6)))
        .clamp(1, 3600)
}
