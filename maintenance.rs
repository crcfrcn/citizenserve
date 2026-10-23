//! 维护与HTTP授权分开；任务只能由固定调度器创建，预算在所有平台端口间共享。
use crate::{
    notifications::jobs,
    shared::{Error, Result},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
#[derive(Clone, Debug, Default)]
pub struct Budget(Arc<AtomicU32>);
impl Budget {
    pub fn business(&self, n: u32) -> Result<()> {
        self.spend(n, 45)
    }
    pub fn commit(&self, n: u32) -> Result<()> {
        self.spend(n, 50)
    }
    fn spend(&self, n: u32, max: u32) -> Result<()> {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                v.checked_add(n).filter(|v| *v <= max)
            })
            .map(|_| ())
            .map_err(|_| Error::new(503, "maintenance_budget_exhausted"))
    }
    pub fn used(&self) -> u32 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn remaining(&self) -> u32 {
        45u32.saturating_sub(self.used())
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Work {
    Authentication,
    Identity,
    Membership,
    Uploads,
    Storage,
    Audit,
}
impl Work {
    pub fn name(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Identity => "identity",
            Self::Membership => "membership",
            Self::Uploads => "uploads",
            Self::Storage => "storage",
            Self::Audit => "audit",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub job_id: String,
    pub work_kind: Work,
    pub scheduled_at: u64,
    pub state: jobs::State,
    pub progress_json: String,
}
pub fn task_id(work: Work, slot: u64) -> String {
    jobs::id(jobs::Kind::Maintenance, &[work.name(), &slot.to_string()])
}
pub fn five_minute_slot(now: u64) -> u64 {
    now / 300_000 * 300_000
}
/// UTC03:04前今天的日任务还未到期；上次未完成的日期由D1持久游标补齐。
pub fn daily_due(now: u64) -> Option<u64> {
    let day = now / 86_400_000;
    let day = if now % 86_400_000 < 11_040_000 {
        day.checked_sub(1)?
    } else {
        day
    };
    Some(day * 86_400_000 + 11_040_000)
}
pub const WORKS: [Work; 5] = [
    Work::Authentication,
    Work::Identity,
    Work::Membership,
    Work::Uploads,
    Work::Storage,
];
