//! Cron只持久安排和有界补派；清理及推送在独立聊天Queue消费。
use super::{config, D1Store};
use citizenserve::tatachat::{Error, Result};
use citizenserve::{membership::limits, server::maintenance::Budget};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{Env, MessageBatch, MessageBuilder, MessageExt, QueueRetryOptionsBuilder};
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
            "INSERT INTO maintenance(slot,state) SELECT ?1,'pending' WHERE NOT EXISTS(SELECT 1 FROM maintenance WHERE state IN('pending','leased')) ON CONFLICT(slot) DO NOTHING",
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
    for row in store.rows("SELECT slot FROM maintenance WHERE state IN('pending','leased') AND lease_until<=?1 ORDER BY slot LIMIT 2",vec![json!(now)]).await?{
        queue.send(MessageBuilder::new(Message{version:1,kind:"maintenance".into(),id:row["slot"].as_u64().ok_or(Error::StorageUnavailable)?.to_string()}).delay_seconds((limits::CLEANUP_PROGRESS_MILLIS/1000) as u32).build()).await.map_err(|_|Error::StorageUnavailable)?;
    }
    Ok(())
}
async fn finish(
    store: &D1Store,
    slot: u64,
    lease: &str,
    state: &str,
    due: u64,
    failures: u64,
) -> Result<bool> {
    let retry = if state == "pending" {
        Value::String(json!({"failures":failures}).to_string())
    } else {
        Value::Null
    };
    let changes = store
        .for_cleanup_commit()
        .changes(vec![(
            CLEANUP_FINISH,
            vec![
                json!(slot),
                json!(lease),
                json!(config::now()),
                json!(state),
                json!(due),
                retry,
            ],
        )])
        .await?;
    Ok(changes.first() == Some(&1))
}
async fn clean(env: &Env, id: &str) -> Result<()> {
    let slot = id.parse::<u64>().map_err(|_| Error::InvalidRequest)?;
    let now = config::now();
    if slot % limits::CLEANUP_UNKNOWN_MILLIS != 0 || slot > now {
        return Err(Error::InvalidRequest);
    }
    let budget = Budget::default();
    let store =
        D1Store::new(env)?.with_cleanup(budget.clone(), now + limits::CLEANUP_WINDOW_MILLIS);
    let nonce = config::random_id()?;
    // 失败次数只存原lease_id内的内部进度；队列载荷、表列和对外协议均不增加。
    let rows = store
        .transaction(vec![(
            CLEANUP_CLAIM,
            vec![
                json!(slot),
                json!(nonce),
                json!(now + limits::CLEANUP_FAILURE_MILLIS),
                json!(now),
            ],
        )])
        .await?;
    let Some(lease) = rows
        .first()
        .and_then(|r| r.first())
        .and_then(|r| r["lease_id"].as_str())
    else {
        return Ok(());
    };
    let value: Value = serde_json::from_str(lease).map_err(|_| Error::StorageUnavailable)?;
    let failures = value["failures"]
        .as_u64()
        .filter(|v| *v < 4)
        .ok_or(Error::StorageUnavailable)?;
    if let Err(error) = crate::repositories::maintenance::reserve_cleanup(
        &env.d1("DB").map_err(|_| Error::StorageUnavailable)?,
        &budget,
        now,
    )
    .await
    {
        if error.code == "cleanup_budget_exceeded" {
            let next = (now / limits::QUOTA_DAY_MILLIS + 1) * limits::QUOTA_DAY_MILLIS;
            // 日顶耗尽持久延期，Cron不再给同一堆积每秒创建新任务。
            finish(&store, slot, lease, "pending", next, 0).await?;
            return Ok(());
        }
        if !finish(
            &store,
            slot,
            lease,
            if failures + 1 >= 4 {
                "failed"
            } else {
                "pending"
            },
            now + limits::CLEANUP_FAILURE_MILLIS,
            failures + 1,
        )
        .await?
        {
            return Ok(());
        }
        return Err(Error::StorageUnavailable);
    }
    let work = async {
        let at = config::now();
        let changed = store
            .changes(vec![
                (CLEANUP_KEYS, vec![json!(at), json!(limits::CLEANUP_ROWS)]),
                (
                    CLEANUP_MESSAGES,
                    vec![json!(at), json!(limits::CLEANUP_ROWS)],
                ),
                (
                    CLEANUP_MESSAGE_RECEIPTS,
                    vec![json!(at), json!(limits::CLEANUP_ROWS)],
                ),
                (
                    CLEANUP_ATTACHMENT_RECEIPTS,
                    vec![json!(at), json!(limits::CLEANUP_ROWS)],
                ),
                (
                    CLEANUP_SLOTS,
                    vec![
                        json!(at.saturating_sub(limits::HISTORY_MILLIS)),
                        json!(limits::CLEANUP_ROWS),
                    ],
                ),
            ])
            .await?;
        let row_progress = changed.iter().any(|n| *n > 0);
        let rows_more = changed.iter().any(|n| *n >= limits::CLEANUP_ROWS);
        let objects = super::attachment::R2Objects::new(env, store.clone())?;
        let result = citizenserve::tatachat::attachment::service::cleanup(
            &store,
            &objects,
            config::now(),
            limits::CLEANUP_ATTACHMENTS,
        )
        .await?;
        // 尚未到期的已领取附件不能被当作“清空”；同一任务续跑到最早持久due。
        let next = store
            .for_cleanup_commit()
            .rows(CLEANUP_NEXT, vec![json!(config::now())])
            .await?
            .first()
            .and_then(|r| r["due"].as_u64());
        Ok::<_, Error>((
            !rows_more && next.is_none(),
            result.progressed || row_progress,
            next,
        ))
    }
    .await;
    let (state, delay, failures) = match work {
        Ok((true, _, _)) => ("completed", 0, 0),
        Ok((false, true, _)) => ("pending", limits::CLEANUP_PROGRESS_MILLIS, 0),
        Ok((false, false, next)) => (
            "pending",
            next.map(|at| {
                at.saturating_sub(config::now())
                    .max(limits::CLEANUP_PROGRESS_MILLIS)
            })
            .unwrap_or(limits::CLEANUP_UNKNOWN_MILLIS),
            0,
        ),
        Err(_) => (
            if failures + 1 >= 4 {
                "failed"
            } else {
                "pending"
            },
            limits::CLEANUP_FAILURE_MILLIS,
            failures + 1,
        ),
    };
    if !finish(
        &store,
        slot,
        lease,
        state,
        if state == "pending" {
            config::now() + delay
        } else {
            0
        },
        failures,
    )
    .await?
    {
        return Ok(());
    }
    if state == "pending" {
        store.for_cleanup_commit().spend_cleanup()?;
        env.queue("TATACHAT_PUSH")
            .map_err(|_| Error::StorageUnavailable)?
            .send(
                MessageBuilder::new(Message {
                    version: 1,
                    kind: "maintenance".into(),
                    id: id.into(),
                })
                .delay_seconds((delay / 1000) as u32)
                .build(),
            )
            .await
            .map_err(|_| Error::StorageUnavailable)?;
    }
    Ok(())
}
pub(crate) async fn consume(
    batch: MessageBatch<serde_json::Value>,
    env: &Env,
) -> worker::Result<()> {
    let mut wake = false;
    for message in batch.messages()? {
        let result = async {
            let value: Message = serde_json::from_value(message.body().clone())
                .map_err(|_| Error::InvalidRequest)?;
            if value.version != 1 || value.id.is_empty() || value.id.len() > 64 {
                return Err(Error::InvalidRequest);
            }
            match value.kind.as_str() {
                "wake" => {
                    wake = true;
                    super::push::drain(env).await
                }
                "maintenance" => clean(env, &value.id).await,
                _ => Err(Error::InvalidRequest),
            }
        }
        .await;
        match result {
            Ok(()) | Err(Error::InvalidRequest) => message.ack(),
            Err(_) => message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds((limits::CLEANUP_FAILURE_MILLIS / 1000) as u32)
                    .build(),
            ),
        }
    }
    // 维护已显式续跑自己的原任务，不再为每批顺带扫描/派发推送。
    if wake {
        let _ = dispatch(env).await;
    }
    Ok(())
}

const CLEANUP_CLAIM:&str="UPDATE maintenance SET state='leased',lease_id=json_object('token',?2,'failures',COALESCE(json_extract(CASE WHEN json_valid(lease_id) THEN lease_id ELSE '{}' END,'$.failures'),0)),lease_until=?3 WHERE slot=?1 AND state IN('pending','leased') AND lease_until<=?4 RETURNING lease_id";
const CLEANUP_KEYS:&str="DELETE FROM key_packages WHERE rowid IN(SELECT rowid FROM key_packages WHERE not_after<=?1 ORDER BY not_after LIMIT ?2)";
const CLEANUP_MESSAGES:&str="DELETE FROM messages WHERE rowid IN(SELECT rowid FROM messages WHERE expires_at<=?1 ORDER BY expires_at LIMIT ?2)";
const CLEANUP_MESSAGE_RECEIPTS:&str="DELETE FROM message_receipts WHERE message_id IN(SELECT message_id FROM message_receipts WHERE expires_at<=?1 AND NOT EXISTS(SELECT 1 FROM messages WHERE messages.message_id=message_receipts.message_id) ORDER BY expires_at LIMIT ?2)";
const CLEANUP_ATTACHMENT_RECEIPTS:&str="DELETE FROM attachment_receipts WHERE attachment_id IN(SELECT attachment_id FROM attachment_receipts WHERE expires_at<=?1 ORDER BY expires_at LIMIT ?2)";
const CLEANUP_SLOTS:&str="DELETE FROM maintenance WHERE slot IN(SELECT slot FROM maintenance WHERE state IN('completed','failed') AND slot<=?1 ORDER BY slot LIMIT ?2)";

const CLEANUP_FINISH:&str="UPDATE maintenance SET state=?4,lease_id=?6,lease_until=?5 WHERE slot=?1 AND lease_id=?2 AND state='leased' AND lease_until>?3";

// 三次现有索引首项查询，避免每轮聚合扫描全部暂存记录。
const CLEANUP_NEXT:&str="SELECT MIN(due) AS due FROM(SELECT MIN(cleanup_after) AS due FROM attachments WHERE state='deleting' UNION ALL SELECT MIN(expires_at) AS due FROM attachments WHERE state='pending' AND expires_at<=?1 UNION ALL SELECT MIN(expires_at) AS due FROM attachments WHERE state='ready' AND expires_at<=?1)";
