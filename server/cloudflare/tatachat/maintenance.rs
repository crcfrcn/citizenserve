//! Cron只持久安排和有界补派；清理及推送在独立聊天Queue消费。
use super::{config, D1Store};
use citizenserve::tatachat::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::{Env, MessageBatch, MessageBuilder, MessageExt};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Message {
    version: u8,
    kind: String,
    id: String,
}
pub(crate) async fn schedule(env: &Env, time: u64) -> Result<()> {
    let store = D1Store::new(env)?;
    let slot = time / 300000 * 300000;
    store
        .transaction(vec![(
            "INSERT INTO maintenance(slot,state) VALUES(?1,'pending') ON CONFLICT(slot) DO NOTHING",
            vec![json!(slot)],
        )])
        .await?;
    dispatch(env).await
}
pub(crate) async fn dispatch(env: &Env) -> Result<()> {
    let store = D1Store::new(env)?;
    let queue = env
        .queue("TATACHAT_PUSH")
        .map_err(|_| Error::StorageUnavailable)?;
    let now = config::now();
    let jobs=store.rows("SELECT rowid AS id,state,due_at,lease_until,dispatch_until FROM push_jobs WHERE (state='pending' OR state='leased') AND dispatch_until<=?1 ORDER BY CASE state WHEN 'pending' THEN due_at ELSE lease_until END,rowid LIMIT 16",vec![json!(now)]).await?;
    for row in jobs {
        let due = if row["state"] == "pending" {
            row["due_at"].as_u64()
        } else {
            row["lease_until"].as_u64()
        }
        .ok_or(Error::StorageUnavailable)?;
        let seconds = due.saturating_sub(now).div_ceil(1000).min(43200) as u32;
        queue
            .send(
                MessageBuilder::new(Message {
                    version: 1,
                    kind: "wake".into(),
                    id: config::random_id()?,
                })
                .delay_seconds(seconds)
                .build(),
            )
            .await
            .map_err(|_| Error::StorageUnavailable)?;
        // 每件成功发送后只标记原快照；并发完成、续租或重试不会被旧补派覆盖。
        store.transaction(vec![("UPDATE push_jobs SET dispatch_until=?6 WHERE rowid=?1 AND state=?2 AND due_at=?3 AND lease_until=?4 AND dispatch_until=?5",vec![row["id"].clone(),row["state"].clone(),row["due_at"].clone(),row["lease_until"].clone(),row["dispatch_until"].clone(),json!(now+u64::from(seconds)*1000+30000)])]).await?;
    }
    for row in store.rows("SELECT slot FROM maintenance WHERE state='pending' OR (state='leased' AND lease_until<=?1) ORDER BY slot LIMIT 2",vec![json!(now)]).await?{
        queue.send(&Message{version:1,kind:"maintenance".into(),id:row["slot"].as_u64().ok_or(Error::StorageUnavailable)?.to_string()}).await.map_err(|_|Error::StorageUnavailable)?;
    }
    Ok(())
}
async fn clean(env: &Env, id: &str) -> Result<()> {
    let slot = id.parse::<u64>().map_err(|_| Error::InvalidRequest)?;
    if slot % 300000 != 0 || slot > config::now() {
        return Err(Error::InvalidRequest);
    }
    let store = D1Store::new(env)?;
    let now = config::now();
    let nonce = config::random_id()?;
    let rows=store.transaction(vec![("UPDATE maintenance SET state='leased',lease_id=?2,lease_until=?3 WHERE slot=?1 AND (state='pending' OR (state='leased' AND lease_until<=?4)) RETURNING slot",vec![json!(slot),json!(nonce),json!(now+60000),json!(now)])]).await?;
    if rows.first().is_none_or(|r| r.is_empty()) {
        return Ok(());
    }
    // 大表按固定索引和LIMIT逐批清理，失败不丢附件对象定位。
    store.transaction(vec![("DELETE FROM key_packages WHERE rowid IN(SELECT rowid FROM key_packages WHERE not_after<=?1 ORDER BY not_after LIMIT 100)",vec![json!(now)]),("DELETE FROM messages WHERE rowid IN(SELECT rowid FROM messages WHERE expires_at<=?1 ORDER BY expires_at LIMIT 100)",vec![json!(now)]),("DELETE FROM message_receipts WHERE message_id IN(SELECT message_id FROM message_receipts WHERE expires_at<=?1 ORDER BY expires_at LIMIT 100)",vec![json!(now)]),("DELETE FROM attachment_receipts WHERE attachment_id IN(SELECT attachment_id FROM attachment_receipts WHERE expires_at<=?1 ORDER BY expires_at LIMIT 100)",vec![json!(now)])]).await?;
    let objects = super::attachment::R2Objects::new(env, store.clone())?;
    let cleaned =
        citizenserve::tatachat::attachment::service::cleanup(&store, &objects, config::now(), 1)
            .await;
    // 失败保留附件定位并记录失败槽；下一Cron继续清理，避免旧槽永久占住派发前缀。
    store.transaction(vec![("UPDATE maintenance SET state=?4,lease_id=NULL,lease_until=0 WHERE slot=?1 AND lease_id=?2 AND state='leased' AND lease_until>?3",vec![json!(slot),json!(nonce),json!(config::now()),json!(if cleaned.is_ok(){"completed"}else{"failed"})])]).await?;
    cleaned.map(|_| ())
}
pub(crate) async fn consume(
    batch: MessageBatch<serde_json::Value>,
    env: &Env,
) -> worker::Result<()> {
    for message in batch.messages()? {
        let result = async {
            let value: Message = serde_json::from_value(message.body().clone())
                .map_err(|_| Error::InvalidRequest)?;
            if value.version != 1 || value.id.is_empty() || value.id.len() > 64 {
                return Err(Error::InvalidRequest);
            }
            match value.kind.as_str() {
                "wake" => super::push::drain(env).await,
                "maintenance" => clean(env, &value.id).await,
                _ => Err(Error::InvalidRequest),
            }
        }
        .await;
        match result {
            Ok(()) => message.ack(),
            Err(Error::InvalidRequest) => message.ack(),
            Err(_) => message.retry(),
        };
    }
    // 一个wake仅领取一个任务；剩余任务继续派发，发送失败仍由Cron恢复。
    let _ = dispatch(env).await;
    Ok(())
}
