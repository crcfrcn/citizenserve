//! 附件状态执行。授权归属先于状态判断，对象删除成功先于元数据清除。
use super::{
    ports::{Deletion, Objects, Operation, State, Store, Stored, Written},
    Attachment,
};
use crate::tatachat::{auth::Access, valid_identifier, Error, Result};

fn check_stored(stored: &Stored, id: &str, now: u64) -> Result<()> {
    stored
        .metadata
        .validate_stored()
        .map_err(|_| Error::StorageUnavailable)?;
    if stored.metadata.attachment_id != id || stored.generation.is_empty() {
        return Err(Error::StorageUnavailable);
    }
    if stored.metadata.expires_at_millis <= now {
        return Err(Error::NotFound);
    }
    Ok(())
}
fn owner(access: &Access, stored: &Stored) -> Result<()> {
    if stored.metadata.sender_user_id != access.actor().user_id
        || stored.metadata.sender_device_id != access.actor().device_id
    {
        return Err(Error::NotFound);
    }
    Ok(())
}
fn check_deletion(deletion: &Deletion, id: &str) -> Result<()> {
    if deletion.attachment_id != id || deletion.generation.is_empty() {
        return Err(Error::StorageUnavailable);
    }
    Ok(())
}

pub async fn begin<S: Store>(
    store: &S,
    access: &Access,
    metadata: &Attachment,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    metadata.validate_stored()?;
    if metadata.cipher_byte_size
        > super::mls_attachment_wire_limit(access.snapshot().max_attachment_bytes)?
    {
        return Err(Error::ResourceLimit);
    }
    if metadata.sender_user_id != access.actor().user_id
        || metadata.sender_device_id != access.actor().device_id
        || metadata.expires_at_millis <= now
    {
        return Err(Error::Forbidden);
    }
    store.begin(access, metadata).await
}

pub async fn complete<S: Store>(store: &S, access: &Access, id: &str, now: u64) -> Result<()> {
    access.ensure_current(now)?;
    if store
        .completed(access, id, Operation::Complete, now)
        .await?
    {
        return Ok(());
    }
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    owner(access, &stored)?;
    if stored.state == State::Deleting {
        return Err(Error::NotFound);
    }
    store.complete(access, id, now).await
}

pub async fn upload<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    index: u32,
    body: O::UploadBody,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    owner(access, &stored)?;
    if stored.state != State::Pending {
        return Err(Error::Conflict);
    }
    let chunk = stored
        .metadata
        .expected_chunk(index)
        .ok_or(Error::NotFound)?;
    let upload = store.reserve_upload(access, &stored, index, now).await?;
    if upload.attachment_id != id
        || upload.generation != stored.generation
        || upload.chunk != *chunk
        || upload.attempt_id.is_empty()
        || upload.object_key.is_empty()
    {
        return Err(Error::StorageUnavailable);
    }
    let written = objects.put(&upload, body, access.deadline()).await?;
    let result = if written.upload.attachment_id != upload.attachment_id
        || written.upload.generation != upload.generation
        || written.upload.attempt_id != upload.attempt_id
        || written.upload.object_key != upload.object_key
        || written.upload.chunk != upload.chunk
        || written.object_version.is_empty()
        || written.size != chunk.cipher_byte_size
        || !written.sha256.eq_ignore_ascii_case(&chunk.cipher_sha256)
    {
        Err(Error::StorageUnavailable)
    } else {
        store.confirm_upload(access, &written, now).await
    };
    if result.is_err() {
        // 只补偿本次写入；补偿失败的定位仍在持久预留，后续清理继续处理。
        if written.upload.attempt_id == upload.attempt_id
            && written.upload.object_key == upload.object_key
        {
            let _ = objects.discard(&written).await;
        }
    }
    result
}

pub async fn download<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    index: u32,
    now: u64,
) -> Result<O::DownloadBody> {
    access.ensure_current(now)?;
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    if stored.metadata.sender_user_id != access.actor().user_id
        && !stored
            .metadata
            .recipient_user_ids
            .contains(&access.actor().user_id)
    {
        return Err(Error::NotFound);
    }
    if stored.state != State::Ready {
        return Err(Error::NotFound);
    }
    let expected = stored
        .metadata
        .expected_chunk(index)
        .ok_or(Error::NotFound)?;
    let written: Written = store.downloaded_chunk(access, &stored, index, now).await?;
    if written.upload.attachment_id != id
        || written.upload.generation != stored.generation
        || written.upload.chunk != *expected
        || written.size != expected.cipher_byte_size
        || !written.sha256.eq_ignore_ascii_case(&expected.cipher_sha256)
        || written.object_version.is_empty()
        || written.upload.object_key.is_empty()
    {
        return Err(Error::StorageUnavailable);
    }
    objects.open(&written, access.deadline()).await
}

async fn delete<S: Store, O: Objects>(store: &S, objects: &O, deletion: &Deletion) -> Result<()> {
    objects.delete(deletion).await?;
    store.finalize(deletion).await
}

pub async fn acknowledge<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    if store
        .completed(access, id, Operation::Acknowledge, now)
        .await?
    {
        return Ok(());
    }
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    if !stored
        .metadata
        .recipient_user_ids
        .contains(&access.actor().user_id)
    {
        return Err(Error::NotFound);
    }
    if stored.state == State::Pending {
        return Err(Error::Conflict);
    }
    if let Some(deletion) = store.acknowledge(access, id, now).await? {
        check_deletion(&deletion, id)?;
        delete(store, objects, &deletion).await?;
    }
    Ok(())
}

pub async fn abort<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    if store.completed(access, id, Operation::Abort, now).await? {
        return Ok(());
    }
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    owner(access, &stored)?;
    let deletion = store.abort(access, id, now).await?;
    check_deletion(&deletion, id)?;
    delete(store, objects, &deletion).await
}

/// 定时清理只消费已持久标记的删除任务，失败保留定位，单批最多100件。
pub async fn cleanup<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    now: u64,
    limit: u32,
) -> Result<()> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidRequest);
    }
    let deletions = store.pending_deletions(now, limit).await?;
    if deletions.len() > limit as usize {
        return Err(Error::StorageUnavailable);
    }
    for deletion in &deletions {
        if !valid_identifier(&deletion.attachment_id, 128) || deletion.generation.is_empty() {
            return Err(Error::StorageUnavailable);
        }
        delete(store, objects, deletion).await?;
    }
    Ok(())
}
