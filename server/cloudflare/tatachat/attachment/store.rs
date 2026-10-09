//! 附件元数据与不可复用尝试定位同库；每次归属/代际检查和转移原子提交。
use super::super::{config, D1Store};
use citizenserve::tatachat::{
    attachment::{
        ports::{Deletion, Operation, State, Store, Stored, Upload, Written},
        Attachment,
    },
    auth::Access,
    Error, Result,
};
use serde_json::{json, Value};
fn assertion(condition: &str) -> String {
    format!("INSERT INTO tatachat_assert VALUES(CASE WHEN {condition} THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING")
}
fn owner() -> &'static str {
    "creator_user=json_extract(?1,'$.user') AND creator_device=json_extract(?1,'$.device')"
}
fn context(a: &Access, id: &str) -> Value {
    json!({"id":id,"user":a.actor().user_id,"device":a.actor().device_id})
}
impl Store for D1Store {
    async fn completed(
        &self,
        access: &Access,
        id: &str,
        operation: Operation,
        _now: u64,
    ) -> Result<bool> {
        access.ensure_current(config::now())?;
        let rows = self
            .rows(
                "SELECT * FROM attachment_receipts WHERE attachment_id=?1 AND expires_at>?2",
                vec![json!(id), json!(config::now())],
            )
            .await?;
        access.ensure_current(config::now())?;
        let Some(r) = rows.first() else {
            return Ok(false);
        };
        let owns = r["creator_user"] == access.actor().user_id
            && r["creator_device"] == access.actor().device_id;
        let contains = |key: &str| -> Result<bool> {
            let values: Vec<String> =
                serde_json::from_str(r[key].as_str().ok_or(Error::StorageUnavailable)?)
                    .map_err(|_| Error::StorageUnavailable)?;
            Ok(values.contains(&access.actor().user_id))
        };
        match operation {
            Operation::Complete if owns => Ok(r["completed"] == 1),
            Operation::Abort if owns => Ok(r["aborted"] == 1),
            Operation::Acknowledge if contains("recipients")? => contains("acknowledged"),
            _ => Err(Error::NotFound),
        }
    }
    async fn begin(&self, access: &Access, attachment: &Attachment) -> Result<()> {
        attachment.validate_stored()?;
        let mut canonical = attachment.clone();
        canonical.accepted_at_millis = 0;
        canonical.expires_at_millis = 0;
        canonical.recipient_user_ids.sort();
        let fingerprint = citizenserve::shared::crypto::sha256_hex(
            serde_json::to_string(&canonical)
                .map_err(|_| Error::StorageUnavailable)?
                .as_bytes(),
        );
        let generation = config::random_id()?;
        let c = json!({"metadata":attachment,"fingerprint":fingerprint,"generation":generation});
        let args = vec![json!(c.to_string())];
        let guard=assertion("NOT EXISTS(SELECT 1 FROM attachment_receipts WHERE attachment_id=json_extract(?1,'$.metadata.attachment_id'))");
        self.write(access,vec![(guard.as_str(),args.clone()),("INSERT INTO attachments(attachment_id,generation,fingerprint,metadata,creator_user,creator_device,state,expires_at) VALUES(json_extract(?1,'$.metadata.attachment_id'),json_extract(?1,'$.generation'),json_extract(?1,'$.fingerprint'),json_extract(?1,'$.metadata'),json_extract(?1,'$.metadata.sender_user_id'),json_extract(?1,'$.metadata.sender_device_id'),'pending',json_extract(?1,'$.metadata.expires_at_millis')) ON CONFLICT(attachment_id) DO UPDATE SET fingerprint=excluded.fingerprint",args.clone()),("INSERT INTO attachment_recipients(attachment_id,user_id) SELECT a.attachment_id,j.value FROM attachments a,json_each(?1,'$.metadata.recipient_user_ids') j WHERE a.generation=json_extract(?1,'$.generation')",args.clone()),("INSERT INTO attachment_chunks(attachment_id,chunk_index,expected) SELECT a.attachment_id,json_extract(j.value,'$.chunk_index'),j.value FROM attachments a,json_each(?1,'$.metadata.chunks') j WHERE a.generation=json_extract(?1,'$.generation')",args)]).await?;
        Ok(())
    }
    async fn attachment(&self, access: &Access, id: &str, _now: u64) -> Result<Stored> {
        access.ensure_current(config::now())?;
        let rows=self.rows("SELECT metadata AS record,state,generation FROM attachments a WHERE attachment_id=?1 AND expires_at>?2 AND (creator_user=?3 OR EXISTS(SELECT 1 FROM attachment_recipients r WHERE r.attachment_id=a.attachment_id AND r.user_id=?3))",vec![json!(id),json!(config::now()),json!(access.actor().user_id)]).await?;
        access.ensure_current(config::now())?;
        let r = rows.first().ok_or(Error::NotFound)?;
        Ok(Stored {
            metadata: D1Store::record(r)?,
            generation: r["generation"]
                .as_str()
                .ok_or(Error::StorageUnavailable)?
                .into(),
            state: match r["state"].as_str() {
                Some("pending") => State::Pending,
                Some("ready") => State::Ready,
                Some("deleting") => State::Deleting,
                _ => return Err(Error::StorageUnavailable),
            },
        })
    }
    async fn reserve_upload(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        _now: u64,
    ) -> Result<Upload> {
        let attempt_id = config::random_id()?;
        let u = Upload {
            attachment_id: stored.metadata.attachment_id.clone(),
            generation: stored.generation.clone(),
            object_key: format!(
                "{}/{}/{}/{}",
                stored.metadata.attachment_id, stored.generation, index, attempt_id
            ),
            attempt_id,
            chunk: stored
                .metadata
                .expected_chunk(index)
                .ok_or(Error::NotFound)?
                .clone(),
        };
        let mut c = context(access, &u.attachment_id);
        c["upload"] = super::upload_value(&u);
        let args = vec![json!(c.to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND generation=json_extract(?1,'$.upload.generation') AND state='pending' AND {} AND expires_at>{})",owner(),D1Store::CLOCK));
        self.write(access,vec![(guard.as_str(),args.clone()),("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES(json_extract(?1,'$.upload.attempt_id'),json_extract(?1,'$.id'),json_extract(?1,'$.upload.generation'),json_extract(?1,'$.upload.object_key'),json_extract(?1,'$.upload'),'reserved')",args)]).await?;
        Ok(u)
    }
    async fn confirm_upload(&self, access: &Access, written: &Written, _now: u64) -> Result<()> {
        let mut c = context(access, &written.upload.attachment_id);
        c["written"] = super::written_value(written);
        let args = vec![json!(c.to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments a JOIN attachment_uploads u ON u.attachment_id=a.attachment_id AND u.generation=a.generation WHERE a.attachment_id=json_extract(?1,'$.id') AND {} AND a.state='pending' AND a.expires_at>{} AND u.attempt_id=json_extract(?1,'$.written.upload.attempt_id') AND u.object_key=json_extract(?1,'$.written.upload.object_key') AND u.state='written' AND u.object_version=json_extract(?1,'$.written.object_version')) AND EXISTS(SELECT 1 FROM attachment_chunks WHERE attachment_id=json_extract(?1,'$.id') AND chunk_index=json_extract(?1,'$.written.upload.chunk.chunk_index') AND (written IS NULL OR json_extract(written,'$.upload.attempt_id')=json_extract(?1,'$.written.upload.attempt_id')))",owner(),D1Store::CLOCK));
        self.write(access,vec![(guard.as_str(),args.clone()),("UPDATE attachment_chunks SET written=json_extract(?1,'$.written') WHERE attachment_id=json_extract(?1,'$.id') AND chunk_index=json_extract(?1,'$.written.upload.chunk.chunk_index')",args)]).await?;
        Ok(())
    }
    async fn downloaded_chunk(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        _now: u64,
    ) -> Result<Written> {
        let _ = self
            .attachment(access, &stored.metadata.attachment_id, config::now())
            .await?;
        let rows=self.rows("SELECT c.written AS record FROM attachment_chunks c JOIN attachments a ON a.attachment_id=c.attachment_id WHERE a.attachment_id=?1 AND a.generation=?2 AND a.state='ready' AND a.expires_at>?3 AND c.chunk_index=?4 AND c.written IS NOT NULL",vec![json!(stored.metadata.attachment_id),json!(stored.generation),json!(config::now()),json!(index)]).await?;
        access.ensure_current(config::now())?;
        super::written_record(&D1Store::record::<Value>(
            rows.first().ok_or(Error::NotFound)?,
        )?)
    }
    async fn complete(&self, access: &Access, id: &str, _now: u64) -> Result<()> {
        let args = vec![json!(context(access, id).to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND {} AND state IN('pending','ready') AND expires_at>{}) AND NOT EXISTS(SELECT 1 FROM attachment_chunks WHERE attachment_id=json_extract(?1,'$.id') AND written IS NULL)",owner(),D1Store::CLOCK));
        self.write(access,vec![(guard.as_str(),args.clone()),("UPDATE attachments SET state='ready',completed=1 WHERE attachment_id=json_extract(?1,'$.id')",args)]).await?;
        Ok(())
    }
    async fn acknowledge(&self, access: &Access, id: &str, _now: u64) -> Result<Option<Deletion>> {
        let args = vec![json!(context(access, id).to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments a JOIN attachment_recipients r ON r.attachment_id=a.attachment_id WHERE a.attachment_id=json_extract(?1,'$.id') AND r.user_id=json_extract(?1,'$.user') AND a.state IN('ready','deleting') AND a.expires_at>{})",D1Store::CLOCK));
        let rows=self.write(access,vec![(guard.as_str(),args.clone()),("UPDATE attachment_recipients SET acknowledged=1 WHERE attachment_id=json_extract(?1,'$.id') AND user_id=json_extract(?1,'$.user')",args.clone()),("UPDATE attachments SET state='deleting' WHERE attachment_id=json_extract(?1,'$.id') AND NOT EXISTS(SELECT 1 FROM attachment_recipients WHERE attachment_id=json_extract(?1,'$.id') AND acknowledged=0)",args.clone()),("SELECT generation FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND state='deleting'",args)]).await?;
        rows.last()
            .and_then(|rs| rs.first())
            .map(|r| {
                Ok(Deletion {
                    attachment_id: id.into(),
                    generation: r["generation"]
                        .as_str()
                        .ok_or(Error::StorageUnavailable)?
                        .into(),
                })
            })
            .transpose()
    }
    async fn abort(&self, access: &Access, id: &str, _now: u64) -> Result<Deletion> {
        let args = vec![json!(context(access, id).to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND {} AND expires_at>{})",owner(),D1Store::CLOCK));
        let rows=self.write(access,vec![(guard.as_str(),args.clone()),("UPDATE attachments SET state='deleting',aborted=1 WHERE attachment_id=json_extract(?1,'$.id')",args.clone()),("SELECT generation FROM attachments WHERE attachment_id=json_extract(?1,'$.id')",args)]).await?;
        Ok(Deletion {
            attachment_id: id.into(),
            generation: rows
                .last()
                .and_then(|r| r.first())
                .and_then(|r| r["generation"].as_str())
                .ok_or(Error::StorageUnavailable)?
                .into(),
        })
    }
    async fn finalize(&self, deletion: &Deletion) -> Result<()> {
        let args = vec![json!(deletion.attachment_id), json!(deletion.generation)];
        let guard=assertion("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=?1 AND generation=?2 AND state='deleting') AND NOT EXISTS(SELECT 1 FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND state<>'deleted')");
        self.transaction(vec![(guard.as_str(),args.clone()),("INSERT INTO attachment_receipts SELECT a.attachment_id,a.fingerprint,a.creator_user,a.creator_device,(SELECT json_group_array(user_id) FROM attachment_recipients WHERE attachment_id=a.attachment_id),(SELECT json_group_array(user_id) FROM attachment_recipients WHERE attachment_id=a.attachment_id AND acknowledged=1),a.completed,a.aborted,a.expires_at FROM attachments a WHERE a.attachment_id=?1 AND a.generation=?2",args.clone()),("DELETE FROM attachments WHERE attachment_id=?1 AND generation=?2 AND state='deleting'",args)]).await?;
        Ok(())
    }
    async fn pending_deletions(&self, _now: u64, limit: u32) -> Result<Vec<Deletion>> {
        let at = config::now();
        self.transaction(vec![("UPDATE attachments SET state='deleting' WHERE attachment_id IN(SELECT attachment_id FROM attachments WHERE expires_at<=?1 AND state<>'deleting' ORDER BY expires_at,attachment_id LIMIT ?2)",vec![json!(at),json!(limit)])]).await?;
        // 先持久安排本批下一次清理时间，未知上传不会永远阻塞其他附件。
        let rows=self.transaction(vec![("UPDATE attachments SET cleanup_after=?1 WHERE attachment_id IN(SELECT attachment_id FROM attachments WHERE state='deleting' AND cleanup_after<=?2 ORDER BY cleanup_after,expires_at,attachment_id LIMIT ?3) RETURNING attachment_id,generation",vec![json!(at+300000),json!(at),json!(limit)])]).await?;
        rows.last()
            .ok_or(Error::StorageUnavailable)?
            .iter()
            .map(|r| {
                Ok(Deletion {
                    attachment_id: r["attachment_id"]
                        .as_str()
                        .ok_or(Error::StorageUnavailable)?
                        .into(),
                    generation: r["generation"]
                        .as_str()
                        .ok_or(Error::StorageUnavailable)?
                        .into(),
                })
            })
            .collect()
    }
}
