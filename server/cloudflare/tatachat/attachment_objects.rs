//! R2仅存密文；版本用于读回核对，不把HEAD/DELETE当成条件删除。
use super::super::{config, D1Store};
use citizenserve::shared::crypto;
use citizenserve::tatachat::{
    attachment::ports::{Deletion, Objects, Upload, Written},
    Error, Result,
};
use serde_json::json;
use worker::{Bucket, Conditional, Env};
pub(crate) struct R2Objects {
    bucket: Bucket,
    store: D1Store,
}
impl R2Objects {
    pub(crate) fn new(env: &Env, store: D1Store) -> Result<Self> {
        Ok(Self {
            bucket: env
                .bucket("TATACHAT_ATTACHMENTS")
                .map_err(|_| Error::StorageUnavailable)?,
            store,
        })
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
    async fn put(&self, upload: &Upload, body: Vec<u8>, deadline: u64) -> Result<Written> {
        Self::current(deadline)?;
        if body.len() != upload.chunk.cipher_byte_size as usize
            || body.len() > config::MAX_CHUNK_BYTES
            || crypto::sha256_hex(&body) != upload.chunk.cipher_sha256
        {
            return Err(Error::InvalidRequest);
        }
        let guard=format!("INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE u.attempt_id=?1 AND u.object_key=?2 AND u.state='reserved' AND a.state='pending' AND a.expires_at>{}) AND ?3>{} THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING",D1Store::CLOCK,D1Store::CLOCK);
        let args = vec![
            json!(upload.attempt_id),
            json!(upload.object_key),
            json!(deadline),
        ];
        self.store.transaction(vec![(guard.as_str(),args.clone()),("UPDATE attachment_uploads SET state='writing' WHERE attempt_id=?1 AND object_key=?2 AND state='reserved'",args[..2].to_vec())]).await?;
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
        if let Some(object) = self
            .bucket
            .head(&written.upload.object_key)
            .await
            .map_err(|_| Error::StorageUnavailable)?
        {
            if object.version() != written.object_version {
                return Err(Error::Conflict);
            }
        }
        // 不可复用键已证明该对象只属于本次尝试；不把HEAD/DELETE冒充版本CAS。
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
    async fn delete(&self, deletion: &Deletion) -> Result<()> {
        let args = vec![json!(deletion.attachment_id), json!(deletion.generation)];
        let rows=self.store.rows("SELECT u.attempt_id,u.object_key,u.state FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE a.attachment_id=?1 AND a.generation=?2 AND a.state='deleting' AND u.state<>'deleted' ORDER BY u.cleanup_after,u.attempt_id LIMIT 8",args.clone()).await?;
        for row in rows {
            let attempt = row["attempt_id"]
                .as_str()
                .ok_or(Error::StorageUnavailable)?;
            let key = row["object_key"]
                .as_str()
                .ok_or(Error::StorageUnavailable)?;
            // 未知写入轮换复查，不能让前八件永久阻塞同附件后续对象清理。
            self.store.transaction(vec![("UPDATE attachment_uploads SET cleanup_after=?3 WHERE attempt_id=?1 AND object_key=?2",vec![json!(attempt),json!(key),json!(config::now())])]).await?;
            if row["state"] == "reserved" {
                // 此CAS阻止尚未开始的put；与put的writing转移串行化。
                self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='reserved'",vec![json!(attempt),json!(key)])]).await?;
                continue;
            }
            let object = self
                .bucket
                .head(key)
                .await
                .map_err(|_| Error::StorageUnavailable)?;
            if row["state"] == "writing" && object.is_none() {
                continue;
            }
            if let Some(object) = object {
                self.bucket
                    .delete(key)
                    .await
                    .map_err(|_| Error::StorageUnavailable)?;
                self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted',object_version=?3 WHERE attempt_id=?1 AND object_key=?2 AND state IN('writing','written')",vec![json!(attempt),json!(key),json!(object.version())])]).await?;
            } else {
                self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='written'",vec![json!(attempt),json!(key)])]).await?;
            }
        }
        if !self.store.rows("SELECT 1 AS pending FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND state<>'deleted' LIMIT 1",args).await?.is_empty(){return Err(Error::StorageUnavailable)}
        Ok(())
    }
}
