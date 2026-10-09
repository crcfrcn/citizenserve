//! 同一D1事务提交完整收件摘要、设备密文与outbox；ACK重试不复活数据。
use super::super::{config, D1Store};
use citizenserve::tatachat::{
    auth::Access,
    mailbox::{
        ports::{Commit, Store},
        Delivery, Receipt,
    },
    protocol, Error, Result,
};
use serde_json::{json, Value};
impl Store for D1Store {
    async fn commit_message(
        &self,
        access: &Access,
        receipt: &Receipt,
        deliveries: &[Delivery],
    ) -> Result<Commit> {
        access.ensure_current(config::now())?;
        if deliveries.is_empty()
            || deliveries.len() > 64
            || Receipt::from_deliveries(deliveries)? != *receipt
        {
            return Err(Error::InvalidRequest);
        }
        let operation = config::random_id()?;
        let context = json!({"message_id":receipt.message_id,"fingerprint":receipt.fingerprint,"operation":operation,"expires_at":receipt.expires_at_millis});
        let sql: Vec<_> = include_str!("mailbox_commit.sql").split("\n-- next\n").collect();
        let mut commands = vec![(sql[0], vec![json!(context.to_string())])];
        let mut group = Vec::<Value>::new();
        let mut size = 0usize;
        for delivery in deliveries {
            if delivery.sender_user_id != access.actor().user_id
                || delivery.sender_device_id != access.actor().device_id
                || delivery.expires_at_millis <= config::now()
            {
                return Err(Error::Forbidden);
            }
            let frame = protocol::message_batch_frame(std::slice::from_ref(delivery))?;
            let entry = json!({"record":delivery,"wire_bytes":protocol::encoded_len(&frame)});
            let n = entry.to_string().len();
            if n > 1_500_000 {
                return Err(Error::ResourceLimit);
            }
            if size + n > 1_500_000 {
                let mut c = context.clone();
                c["records"] = json!(group);
                commands.push((sql[1], vec![json!(c.to_string())]));
                group = Vec::new();
                size = 0;
            }
            size += n;
            group.push(entry);
        }
        if !group.is_empty() {
            let mut c = context.clone();
            c["records"] = json!(group);
            commands.push((sql[1], vec![json!(c.to_string())]));
        }
        commands.push((sql[2], vec![json!(context.to_string())]));
        commands.push((
            "SELECT operation=?2 AS inserted FROM message_receipts WHERE message_id=?1",
            vec![json!(receipt.message_id), json!(operation)],
        ));
        let rows = self.write(access, commands).await?;
        let inserted = rows
            .last()
            .and_then(|r| r.first())
            .and_then(|r| r["inserted"].as_u64())
            .ok_or(Error::StorageUnavailable)?;
        Ok(if inserted == 1 {
            Commit::Inserted
        } else {
            Commit::Duplicate
        })
    }
    async fn messages(
        &self,
        access: &Access,
        _now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> Result<Vec<Delivery>> {
        access.ensure_current(config::now())?;
        let actor = access.actor();
        let at = config::now();
        let metadata=self.rows("SELECT message_id,wire_bytes FROM messages WHERE user_id=?1 AND device_id=?2 AND expires_at>?3 ORDER BY accepted_at,message_id LIMIT ?4",vec![json!(actor.user_id),json!(actor.device_id),json!(at),json!(limit)]).await?;
        let mut ids = Vec::new();
        let mut size = 0usize;
        for r in metadata {
            let n = r["wire_bytes"].as_u64().ok_or(Error::StorageUnavailable)? as usize;
            if size.saturating_add(n) > maximum_bytes {
                if ids.is_empty() {
                    return Err(Error::ResourceLimit);
                }
                break;
            }
            size += n;
            ids.push(
                r["message_id"]
                    .as_str()
                    .ok_or(Error::StorageUnavailable)?
                    .to_owned(),
            );
        }
        if ids.is_empty() {
            access.ensure_current(config::now())?;
            return Ok(Vec::new());
        }
        let rows=self.rows("SELECT record FROM messages WHERE user_id=?1 AND device_id=?2 AND expires_at>?3 AND message_id IN(SELECT value FROM json_each(?4)) ORDER BY accepted_at,message_id",vec![json!(actor.user_id),json!(actor.device_id),json!(config::now()),json!(serde_json::to_string(&ids).map_err(|_|Error::StorageUnavailable)?)]).await?;
        access.ensure_current(config::now())?;
        rows.into_iter().map(|r| D1Store::record(&r)).collect()
    }
    async fn acknowledge_messages(&self, access: &Access, ids: &[String], _now: u64) -> Result<()> {
        let c = json!({"user_id":access.actor().user_id,"device_id":access.actor().device_id,"ids":ids});
        self.write(
            access,
            vec![(include_str!("mailbox_acknowledge.sql"), vec![json!(c.to_string())])],
        )
        .await?;
        Ok(())
    }
}
