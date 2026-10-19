//! 附件元数据与不可复用尝试定位同库；每次归属/代际检查和转移原子提交。
use super::super::{config, D1Store};
use citizenserve::tatachat::{
    attachment::{
        ports::{
            Deletion, DeletionRetry, Operation, Reservation, State, Store, Stored, Upload, Written,
        },
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
        let limits = self.attachment_resources.ok_or(Error::Forbidden)?;
        let c = json!({"metadata":attachment,"fingerprint":fingerprint,"generation":generation,
            "user":access.actor().user_id,"device":access.actor().device_id,
            "stock":{"pending":limits.pending_attachments,"count":limits.attachment_count,"bytes":limits.attachment_bytes,
                "global_count":citizenserve::membership::limits::GLOBAL_ATTACHMENT_COUNT,"global_bytes":citizenserve::membership::limits::GLOBAL_ATTACHMENT_BYTES}});
        let args = vec![json!(c.to_string())];
        let guard=assertion("json_extract(?1,'$.metadata.sender_user_id')=json_extract(?1,'$.user') AND json_extract(?1,'$.metadata.sender_device_id')=json_extract(?1,'$.device') AND NOT EXISTS(SELECT 1 FROM attachment_receipts WHERE attachment_id=json_extract(?1,'$.metadata.attachment_id')) AND (NOT EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.metadata.attachment_id')) OR EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.metadata.attachment_id') AND creator_user=json_extract(?1,'$.user') AND creator_device=json_extract(?1,'$.device') AND fingerprint=json_extract(?1,'$.fingerprint') AND state IN('pending','ready')))");
        // 只对新ID计存量；既有完整匹配重试不重复占用，deleting仍包含在原表统计中。
        let stock = r#"INSERT INTO attachment_chunks(attachment_id,chunk_index,expected) SELECT NULL,0,'{}'
WHERE NOT EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.metadata.attachment_id')) AND COALESCE((
 (SELECT COUNT(*) FROM attachments)<json_extract(?1,'$.stock.global_count')
 AND (SELECT COALESCE(SUM(CASE WHEN json_type(metadata,'$.cipher_byte_size')='integer' AND json_extract(metadata,'$.cipher_byte_size')>0 THEN json_extract(metadata,'$.cipher_byte_size') ELSE json_extract(?1,'$.stock.global_bytes')+1 END),0) FROM attachments)<=json_extract(?1,'$.stock.global_bytes')-json_extract(?1,'$.metadata.cipher_byte_size')
 AND (SELECT COUNT(*) FROM attachments WHERE creator_user=json_extract(?1,'$.user'))<json_extract(?1,'$.stock.count')
 AND (SELECT COUNT(*) FROM attachments WHERE creator_user=json_extract(?1,'$.user') AND state='pending')<json_extract(?1,'$.stock.pending')
 AND (SELECT COALESCE(SUM(CASE WHEN json_type(metadata,'$.cipher_byte_size')='integer' AND json_extract(metadata,'$.cipher_byte_size')>0 THEN json_extract(metadata,'$.cipher_byte_size') ELSE json_extract(?1,'$.stock.bytes')+1 END),0) FROM attachments WHERE creator_user=json_extract(?1,'$.user'))<=json_extract(?1,'$.stock.bytes')-json_extract(?1,'$.metadata.cipher_byte_size')
),0)=0"#;
        self.write(access,vec![(guard.as_str(),args.clone()),(stock,args.clone()),("INSERT INTO attachments(attachment_id,generation,fingerprint,metadata,creator_user,creator_device,state,expires_at) VALUES(json_extract(?1,'$.metadata.attachment_id'),json_extract(?1,'$.generation'),json_extract(?1,'$.fingerprint'),json_extract(?1,'$.metadata'),json_extract(?1,'$.metadata.sender_user_id'),json_extract(?1,'$.metadata.sender_device_id'),'pending',json_extract(?1,'$.metadata.expires_at_millis')) ON CONFLICT(attachment_id) DO UPDATE SET fingerprint=excluded.fingerprint",args.clone()),("INSERT INTO attachment_recipients(attachment_id,user_id) SELECT a.attachment_id,j.value FROM attachments a,json_each(?1,'$.metadata.recipient_user_ids') j WHERE a.generation=json_extract(?1,'$.generation')",args.clone()),("INSERT INTO attachment_chunks(attachment_id,chunk_index,expected) SELECT a.attachment_id,json_extract(j.value,'$.chunk_index'),j.value FROM attachments a,json_each(?1,'$.metadata.chunks') j WHERE a.generation=json_extract(?1,'$.generation')",args)]).await?;
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
    ) -> Result<Reservation> {
        access.ensure_current(config::now())?;
        let expected = stored
            .metadata
            .expected_chunk(index)
            .ok_or(Error::NotFound)?;
        let rows=self.rows("SELECT c.written AS record FROM attachment_chunks c JOIN attachments a ON a.attachment_id=c.attachment_id WHERE a.attachment_id=?1 AND a.generation=?2 AND c.chunk_index=?3 AND a.creator_user=?4 AND a.creator_device=?5 AND a.state IN('pending','ready') AND a.expires_at>?6",vec![json!(stored.metadata.attachment_id),json!(stored.generation),json!(index),json!(access.actor().user_id),json!(access.actor().device_id),json!(config::now())]).await?;
        access.ensure_current(config::now())?;
        let row = rows.first().ok_or(Error::NotFound)?;
        if !row["record"].is_null() {
            return Ok(Reservation::Complete(super::written_record(
                &D1Store::record::<Value>(row)?,
            )?));
        }
        if stored.state != State::Pending {
            return Err(Error::Conflict);
        }
        let limits = self.attachment_resources.ok_or(Error::Forbidden)?;
        let attempts=self.rows("SELECT upload AS record,state,object_version FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND json_extract(upload,'$.chunk.chunk_index')=?3 AND state IN('reserved','writing','written') ORDER BY CASE state WHEN 'written' THEN 0 WHEN 'writing' THEN 1 ELSE 2 END,attempt_id LIMIT 1",vec![json!(stored.metadata.attachment_id),json!(stored.generation),json!(index)]).await?;
        access.ensure_current(config::now())?;
        let upload = if let Some(row) = attempts.first() {
            let upload = super::upload_record(&D1Store::record::<Value>(row)?)?;
            if upload.attachment_id != stored.metadata.attachment_id
                || upload.generation != stored.generation
                || upload.chunk != *expected
            {
                return Err(Error::StorageUnavailable);
            }
            if row["state"] == "written" {
                let written = Written {
                    upload: upload.clone(),
                    object_version: row["object_version"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(Error::StorageUnavailable)?
                        .into(),
                    size: expected.cipher_byte_size,
                    sha256: expected.cipher_sha256.clone(),
                };
                // 已保存R2成功回执且键不可覆盖，补原确认即可，不再HEAD/PUT或读正文。
                self.confirm_upload(access, &written, config::now()).await?;
                return Ok(Reservation::Complete(written));
            }
            if row["state"] == "writing" {
                return Ok(Reservation::Recover(upload));
            }
            upload
        } else {
            let attempt_id = config::random_id()?;
            Upload {
                attachment_id: stored.metadata.attachment_id.clone(),
                generation: stored.generation.clone(),
                object_key: format!(
                    "{}/{}/{}/{}",
                    stored.metadata.attachment_id, stored.generation, index, attempt_id
                ),
                attempt_id,
                chunk: expected.clone(),
            }
        };
        let mut c = context(access, &upload.attachment_id);
        c["upload"] = super::upload_value(&upload);
        c["writing_limit"] = json!(limits.writing_chunks);
        let args = vec![json!(c.to_string())];
        let guard=assertion(&format!("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND generation=json_extract(?1,'$.upload.generation') AND state='pending' AND {} AND expires_at>{}) AND NOT EXISTS(SELECT 1 FROM attachment_uploads WHERE attachment_id=json_extract(?1,'$.id') AND generation=json_extract(?1,'$.upload.generation') AND json_extract(upload,'$.chunk.chunk_index')=json_extract(?1,'$.upload.chunk.chunk_index') AND state IN('writing','written')) AND (NOT EXISTS(SELECT 1 FROM attachment_uploads WHERE attempt_id=json_extract(?1,'$.upload.attempt_id')) OR EXISTS(SELECT 1 FROM attachment_uploads WHERE attempt_id=json_extract(?1,'$.upload.attempt_id') AND object_key=json_extract(?1,'$.upload.object_key') AND generation=json_extract(?1,'$.upload.generation') AND state='reserved'))",owner(),D1Store::CLOCK));
        let writing = r#"INSERT INTO attachment_chunks(attachment_id,chunk_index,expected) SELECT NULL,0,'{}' WHERE COALESCE((
 (SELECT COUNT(*) FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE a.creator_user=json_extract(?1,'$.user') AND u.state='writing')<json_extract(?1,'$.writing_limit')
),0)=0"#;
        let claimed = assertion("changes()=1");
        self.write(access,vec![(guard.as_str(),args.clone()),(writing,args.clone()),
            ("INSERT INTO attachment_uploads(attempt_id,attachment_id,generation,object_key,upload,state) VALUES(json_extract(?1,'$.upload.attempt_id'),json_extract(?1,'$.id'),json_extract(?1,'$.upload.generation'),json_extract(?1,'$.upload.object_key'),json_extract(?1,'$.upload'),'reserved') ON CONFLICT(attempt_id) DO NOTHING",args.clone()),
            ("UPDATE attachment_uploads SET state='writing' WHERE attempt_id=json_extract(?1,'$.upload.attempt_id') AND object_key=json_extract(?1,'$.upload.object_key') AND state='reserved'",args.clone()),
            (claimed.as_str(),vec![])]).await?;
        Ok(Reservation::Write(upload))
    }
    async fn release_upload(&self, access: &Access, upload: &Upload, _now: u64) -> Result<()> {
        let mut c = context(access, &upload.attachment_id);
        c["upload"] = super::upload_value(upload);
        // 仅Core在预算/正文失败且从未调用put时使用，未知R2结果禁止走此路径。
        self.write(access,vec![("UPDATE attachment_uploads SET state='reserved' WHERE attempt_id=json_extract(?1,'$.upload.attempt_id') AND object_key=json_extract(?1,'$.upload.object_key') AND generation=json_extract(?1,'$.upload.generation') AND state='writing' AND object_version IS NULL AND EXISTS(SELECT 1 FROM attachments WHERE attachment_id=json_extract(?1,'$.id') AND creator_user=json_extract(?1,'$.user') AND creator_device=json_extract(?1,'$.device') AND state='pending')",vec![json!(c.to_string())])]).await?;
        Ok(())
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
        let guard=assertion("EXISTS(SELECT 1 FROM attachments WHERE attachment_id=?1 AND generation=?2 AND state='deleting') AND NOT EXISTS(SELECT 1 FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND state IN('reserved','writing','written'))");
        self.transaction(vec![(guard.as_str(),args.clone()),(format!("INSERT INTO attachment_receipts SELECT a.attachment_id,a.fingerprint,a.creator_user,a.creator_device,(SELECT json_group_array(user_id) FROM attachment_recipients WHERE attachment_id=a.attachment_id),(SELECT json_group_array(user_id) FROM attachment_recipients WHERE attachment_id=a.attachment_id AND acknowledged=1),a.completed,a.aborted,a.expires_at FROM attachments a WHERE a.attachment_id=?1 AND a.generation=?2 AND a.expires_at>{}",Self::CLOCK).as_str(),args.clone()),("DELETE FROM attachments WHERE attachment_id=?1 AND generation=?2 AND state='deleting'",args)]).await?;
        Ok(())
    }
    async fn defer_deletions(
        &self,
        deletions: &[Deletion],
        _now: u64,
        retry: DeletionRetry,
    ) -> Result<()> {
        use citizenserve::membership::limits as l;
        if deletions.is_empty() || deletions.len() > l::CLEANUP_ATTACHMENTS as usize {
            return Err(Error::ResourceLimit);
        }
        let delay = match retry {
            DeletionRetry::Progress => l::CLEANUP_PROGRESS_MILLIS,
            DeletionRetry::Unknown => l::CLEANUP_UNKNOWN_MILLIS,
            DeletionRetry::Failure => l::CLEANUP_FAILURE_MILLIS,
        };
        let due = config::now() + delay;
        let commands=deletions.iter().map(|d|("UPDATE attachments SET cleanup_after=?3 WHERE attachment_id=?1 AND generation=?2 AND state='deleting'",vec![json!(d.attachment_id),json!(d.generation),json!(due)])).collect();
        // 故障后的持久退避属于收尾提交，同批剩余定位只用一次真实D1 batch。
        if retry == DeletionRetry::Failure {
            self.for_cleanup_commit().transaction(commands).await?;
        } else {
            self.transaction(commands).await?;
        }
        if self.cleanup.is_none() {
            super::super::maintenance::schedule(&self.env, config::now()).await?;
        }
        Ok(())
    }
    async fn pending_deletions(&self, _now: u64, limit: u32) -> Result<Vec<Deletion>> {
        let at = config::now();
        self.transaction(vec![("UPDATE attachments SET state='deleting' WHERE attachment_id IN(SELECT attachment_id FROM attachments WHERE expires_at<=?1 AND state IN('pending','ready') ORDER BY expires_at,attachment_id LIMIT ?2)",vec![json!(at),json!(limit)])]).await?;
        // 先持久安排本批下一次清理时间，未知上传不会永远阻塞其他附件。
        let rows=self.transaction(vec![("UPDATE attachments SET cleanup_after=?1 WHERE attachment_id IN(SELECT attachment_id FROM attachments WHERE state='deleting' AND cleanup_after<=?2 ORDER BY cleanup_after,expires_at,attachment_id LIMIT ?3) RETURNING attachment_id,generation",vec![json!(at+citizenserve::membership::limits::CLEANUP_UNKNOWN_MILLIS),json!(at),json!(limit)])]).await?;
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
