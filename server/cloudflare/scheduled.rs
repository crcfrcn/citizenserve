//! scheduled只写持久任务并补派outbox；执行发生在Queue，重复/漏触发由槽游标处理。
use crate::repositories::{
    maintenance::D1Maintenance,
    notification_jobs::{system_batch, D1Jobs},
};
use citizenserve::{
    notifications::jobs::Kind,
    server::maintenance::{self, Budget, Work},
    shared::Result,
};
use serde_json::json;
use worker::Env;
pub async fn run(env: &Env, time: u64) -> Result<()> {
    // 分别保留两模块结果；普通维护失败仍允许聊天持久安排，反之亦然。
    let ordinary = ordinary(env, time).await;
    let chat = crate::tatachat::maintenance::schedule(env, time)
        .await
        .map_err(crate::tatachat::business);
    ordinary?;
    chat
}
async fn ordinary(env: &Env, time: u64) -> Result<()> {
    let budget = Budget::default();
    let jobs = D1Jobs::configured(env, budget.clone())?;
    for work in maintenance::WORKS {
        schedule(&jobs, work, maintenance::five_minute_slot(time)).await?;
    }
    if let Some(due) = maintenance::daily_due(time) {
        let repo = D1Maintenance {
            db: env
                .d1("DB")
                .map_err(|_| citizenserve::shared::Error::new(503, "maintenance_unavailable"))?,
            budget: budget.clone(),
        };
        let row: Option<serde_json::Value> = repo
            .first(
                "SELECT last_slot FROM scheduler_leases WHERE lease_key='cron:audit'",
                &[],
            )
            .await?;
        let last = row.and_then(|r| r["last_slot"].as_u64()).unwrap_or(0);
        let slot = if last == 0 {
            due
        } else {
            due.min(last.saturating_add(86400000))
        };
        schedule(&jobs, Work::Audit, slot).await?;
    }
    jobs.dispatch().await
}
async fn schedule(jobs: &D1Jobs<'_>, work: Work, slot: u64) -> Result<()> {
    let nonce = citizenserve::shared::crypto::hex(&crate::runtime::random::<16>()?);
    let id = maintenance::task_id(work, slot);
    citizenserve::notifications::jobs::Message {
        version: 1,
        kind: Kind::Maintenance,
        id: id.clone(),
    }
    .validate()?;
    system_batch(&jobs.db,&jobs.budget,json!({"key":format!("cron:{}",work.name()),"work":work,"slot":slot,"nonce":nonce,"job_id":id}),include_str!("sql/schedule_maintenance.sql")).await
}
