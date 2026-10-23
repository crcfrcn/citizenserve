//! R2仅存密文；版本用于读回核对，不把HEAD/DELETE当成条件删除。
use super::super::{config, D1Store};
use citizenserve::shared::crypto;
use citizenserve::tatachat::{
    attachment::ports::{Deletion, DeletionProgress, Objects, Upload, Written},
    Error, Result,
};
use serde_json::json;
use worker::{Bucket, Conditional, Env};
pub(crate) struct R2Objects {
    bucket: Bucket,
    store: D1Store,
    delete_limit: u32,
    object_operations: std::cell::Cell<u32>,
}
impl R2Objects {
    pub(crate) fn new(env: &Env, store: D1Store) -> Result<Self> {
        Ok(Self {
            bucket: env
                .bucket("TATACHAT_ATTACHMENTS")
                .map_err(|_| Error::StorageUnavailable)?,
            store,
            delete_limit: citizenserve::membership::limits::CLEANUP_ATTACHMENTS,
            object_operations: std::cell::Cell::new(0),
        })
    }
    pub(crate) fn with_delete_limit(mut self, limit: u32) -> Self {
        self.delete_limit = limit;
        self
    }
    fn can_delete(&self) -> bool {
        self.store.cleanup_remaining() >= 6
            && (self.store.cleanup.is_some()
                || self.object_operations.get()
                    < citizenserve::membership::limits::CLEANUP_ATTACHMENTS)
    }
    fn deletion_io(&self) -> Result<()> {
        if !self.can_delete() {
            return Err(Error::ResourceLimit);
        }
        self.store.spend_cleanup()?;
        self.object_operations.set(self.object_operations.get() + 1);
        Ok(())
    }
    fn current(deadline: u64) -> Result<()> {
        if config::now() >= deadline {
            Err(Error::Forbidden)
        } else {
            Ok(())
        }
    }
}
impl Objects for R2Objects {
    type UploadBody = Vec<u8>;
    type DownloadBody = Vec<u8>;
    async fn recover(&self, upload: &Upload, deadline: u64) -> Result<Option<Written>> {
        Self::current(deadline)?;
        let Some(object) = self
            .bucket
            .head(&upload.object_key)
            .await
            .map_err(|_| Error::StorageUnavailable)?
        else {
            return Ok(None);
        };
        let sha = object.checksum().sha256.ok_or(Error::StorageUnavailable)?;
        if object.size() != upload.chunk.cipher_byte_size
            || sha.len() != 32
            || !crypto::hex(&sha).eq_ignore_ascii_case(&upload.chunk.cipher_sha256)
            || object.version().is_empty()
        {
            return Err(Error::StorageUnavailable);
        }
        Self::current(deadline)?;
        let written = Written {
            upload: upload.clone(),
            object_version: object.version(),
            size: object.size(),
            sha256: crypto::hex(&sha),
        };
        let condition=format!("EXISTS(SELECT 1 FROM attachments a WHERE a.attachment_id=?3 AND a.generation=?4 AND a.state='pending' AND a.expires_at>{}) AND ?6>{}",D1Store::CLOCK,D1Store::CLOCK);
        let sql=format!("UPDATE attachment_uploads SET state='written',object_version=?5 WHERE attempt_id=?1 AND object_key=?2 AND attachment_id=?3 AND generation=?4 AND state IN('writing','written') AND (object_version IS NULL OR object_version=?5) AND {condition}");
        let rows = self
            .store
            .transaction(vec![
                (
                    sql.as_str(),
                    vec![
                        json!(upload.attempt_id),
                        json!(upload.object_key),
                        json!(upload.attachment_id),
                        json!(upload.generation),
                        json!(written.object_version),
                        json!(deadline),
                    ],
                ),
                ("SELECT changes() AS changed", vec![]),
            ])
            .await?;
        if rows
            .last()
            .and_then(|r| r.first())
            .and_then(|r| r["changed"].as_u64())
            != Some(1)
        {
            return Err(Error::Conflict);
        }
        Ok(Some(written))
    }
    async fn put(&self, upload: &Upload, body: Vec<u8>, deadline: u64) -> Result<Written> {
        if let Err(error) = Self::current(deadline) {
            let _=self.store.transaction(vec![("UPDATE attachment_uploads SET state='reserved' WHERE attempt_id=?1 AND object_key=?2 AND state='writing' AND object_version IS NULL",vec![json!(upload.attempt_id),json!(upload.object_key)])]).await;
            return Err(error);
        }
        if body.len() != upload.chunk.cipher_byte_size as usize
            || body.len() > config::MAX_CHUNK_BYTES
            || crypto::sha256_hex(&body) != upload.chunk.cipher_sha256
        {
            // 长度/摘要在任何R2调用之前失败，已证明没有put，可以复用准确原键。
            let _=self.store.transaction(vec![("UPDATE attachment_uploads SET state='reserved' WHERE attempt_id=?1 AND object_key=?2 AND state='writing' AND object_version IS NULL",vec![json!(upload.attempt_id),json!(upload.object_key)])]).await;
            return Err(Error::InvalidRequest);
        }
        // 独占已由reserve_upload在正文前取得；这里只复核准确尝试，绝不重新获得写入权。
        let guard=format!("INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE u.attempt_id=?1 AND u.object_key=?2 AND u.state='writing' AND a.state='pending' AND a.expires_at>{}) AND ?3>{} THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING",D1Store::CLOCK,D1Store::CLOCK);
        let args = vec![
            json!(upload.attempt_id),
            json!(upload.object_key),
            json!(deadline),
        ];
        self.store
            .transaction(vec![(guard.as_str(), args.clone())])
            .await?;
        if let Err(error) = Self::current(deadline) {
            // 已知尚未调用R2的期限失败可以安全终结本次尝试。
            self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='writing'",args[..2].to_vec())]).await?;
            return Err(error);
        }
        // 每个预留最多一次put；结果未知保持writing，绝不按超时删除定位。
        let object = self
            .bucket
            .put(&upload.object_key, body)
            .only_if(Conditional {
                etag_does_not_match: Some("*".into()),
                ..Default::default()
            })
            .sha256(crypto::unhex(&upload.chunk.cipher_sha256).map_err(|_| Error::InvalidRequest)?)
            .execute()
            .await
            .map_err(|_| Error::StorageUnavailable)?
            .ok_or(Error::Conflict)?;
        let written = Written {
            upload: upload.clone(),
            object_version: object.version(),
            size: object.size(),
            sha256: upload.chunk.cipher_sha256.clone(),
        };
        self.store.transaction(vec![("UPDATE attachment_uploads SET state='written',object_version=?3 WHERE attempt_id=?1 AND object_key=?2 AND state='writing'",vec![json!(upload.attempt_id),json!(upload.object_key),json!(written.object_version)])]).await?;
        Ok(written)
    }
    async fn discard(&self, written: &Written) -> Result<()> {
        // 原持久回执证明准确attempt/key/version；一次性键不可能属于下一次写入。
        let rows=self.store.rows("SELECT 1 AS owned FROM attachment_uploads WHERE attempt_id=?1 AND object_key=?2 AND object_version=?3 AND state IN('written','deleted')",vec![json!(written.upload.attempt_id),json!(written.upload.object_key),json!(written.object_version)]).await?;
        if rows.is_empty() {
            return Err(Error::Conflict);
        }
        self.deletion_io()?;
        self.bucket
            .delete(&written.upload.object_key)
            .await
            .map_err(|_| Error::StorageUnavailable)?;
        self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND object_version=?3",vec![json!(written.upload.attempt_id),json!(written.upload.object_key),json!(written.object_version)])]).await?;
        Ok(())
    }
    async fn open(&self, written: &Written, deadline: u64) -> Result<Vec<u8>> {
        Self::current(deadline)?;
        let object = self
            .bucket
            .get(&written.upload.object_key)
            .execute()
            .await
            .map_err(|_| Error::StorageUnavailable)?
            .ok_or(Error::NotFound)?;
        if object.version() != written.object_version
            || object.size() != written.size
            || written.size > config::MAX_CHUNK_BYTES as u64
        {
            return Err(Error::StorageUnavailable);
        }
        let bytes = object
            .body()
            .ok_or(Error::StorageUnavailable)?
            .bytes()
            .await
            .map_err(|_| Error::StorageUnavailable)?;
        if bytes.len() as u64 != written.size || crypto::sha256_hex(&bytes) != written.sha256 {
            return Err(Error::StorageUnavailable);
        }
        Self::current(deadline)?;
        Ok(bytes)
    }
    async fn delete(&self, deletion: &Deletion) -> Result<DeletionProgress> {
        let args = vec![json!(deletion.attachment_id), json!(deletion.generation)];
        if !self.can_delete() {
            return if self.store.cleanup.is_some() {
                Err(Error::ResourceLimit)
            } else {
                Ok(DeletionProgress::default())
            };
        }
        let rows=self.store.rows("SELECT u.attempt_id,u.object_key,u.state,u.object_version FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE a.attachment_id=?1 AND a.generation=?2 AND a.state='deleting' AND u.state IN('reserved','writing','written') AND (u.state<>'writing' OR u.cleanup_after<=?4) LIMIT ?3",vec![args[0].clone(),args[1].clone(),json!(self.delete_limit),json!(config::now())]).await?;
        let mut progressed = false;
        for row in rows {
            if !self.can_delete() {
                break;
            }
            let attempt = row["attempt_id"]
                .as_str()
                .ok_or(Error::StorageUnavailable)?;
            let key = row["object_key"]
                .as_str()
                .ok_or(Error::StorageUnavailable)?;
            if row["state"] == "reserved" {
                // 与开写CAS串行；只有明确未开始PUT才能不访问R2地终结定位。
                let changed=self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='reserved'",vec![json!(attempt),json!(key)]),("SELECT changes() AS changed",vec![])]).await?;
                progressed |= changed
                    .last()
                    .and_then(|r| r.first())
                    .and_then(|r| r["changed"].as_u64())
                    == Some(1);
                continue;
            }
            let version = if row["state"] == "writing" {
                // 未知结果仍查原键，不能凭缺对象/超时就删除恢复元数据。
                self.deletion_io()?;
                let object = self
                    .bucket
                    .head(key)
                    .await
                    .map_err(|_| Error::StorageUnavailable)?;
                let Some(object) = object else {
                    self.store.transaction(vec![("UPDATE attachment_uploads SET cleanup_after=?3 WHERE attempt_id=?1 AND object_key=?2 AND state='writing'",vec![json!(attempt),json!(key),json!(config::now()+citizenserve::membership::limits::CLEANUP_UNKNOWN_MILLIS)])]).await?;
                    continue;
                };
                // 观察结果持久化，若本次对象预算已尽，下轮可直接DELETE而不重复HEAD。
                let version = object.version();
                if version.is_empty() {
                    return Err(Error::StorageUnavailable);
                }
                self.store.transaction(vec![("UPDATE attachment_uploads SET state='written',object_version=?3 WHERE attempt_id=?1 AND object_key=?2 AND state='writing'",vec![json!(attempt),json!(key),json!(version)])]).await?;
                progressed = true;
                version
            } else if row["state"] == "written" {
                row["object_version"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .ok_or(Error::StorageUnavailable)?
                    .to_owned()
            } else {
                return Err(Error::StorageUnavailable);
            };
            if !self.can_delete() {
                break;
            }
            // 已确认的不可复用键直接DELETE；重复DELETE幂等，不冒充版本CAS。
            self.deletion_io()?;
            self.bucket
                .delete(key)
                .await
                .map_err(|_| Error::StorageUnavailable)?;
            self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='written' AND object_version=?3",vec![json!(attempt),json!(key),json!(version)])]).await?;
            progressed = true;
        }
        let complete=self.store.rows("SELECT 1 AS pending FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND state IN('reserved','writing','written') LIMIT 1",args).await?.is_empty();
        Ok(DeletionProgress {
            complete,
            progressed,
        })
    }
}
