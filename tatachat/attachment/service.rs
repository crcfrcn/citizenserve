//! 附件状态执行。授权归属先于状态判断，对象删除成功先于元数据清除。
use super::{
    ports::{
        Deletion, DeletionProgress, DeletionRetry, Objects, Operation, Reservation, State, Store,
        Stored, Written,
    },
    Attachment,
};
use crate::tatachat::{
    auth::{ports::ResourceCost, Access},
    valid_identifier, Error, Result,
};
use std::future::Future;

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
// 与当前宿主/客户端单文件能力一致；分块小不代表整份文件仍在当前档位内。
fn check_size(access: &Access, stored: &Stored) -> Result<()> {
    let limit = super::mls_attachment_wire_limit(access.snapshot().attachments.limit()?)?;
    if stored.metadata.cipher_byte_size > limit {
        return Err(Error::ResourceLimit);
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
        > super::mls_attachment_wire_limit(access.snapshot().attachments.limit()?)?
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
    access.snapshot().attachments.limit()?;
    if store
        .completed(access, id, Operation::Complete, now)
        .await?
    {
        return Ok(());
    }
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    owner(access, &stored)?;
    check_size(access, &stored)?;
    if stored.state == State::Deleting {
        return Err(Error::NotFound);
    }
    store.complete(access, id, now).await
}

fn check_written(written: &Written, stored: &Stored, index: u32) -> Result<()> {
    let chunk = stored
        .metadata
        .expected_chunk(index)
        .ok_or(Error::NotFound)?;
    if written.upload.attachment_id != stored.metadata.attachment_id
        || written.upload.generation != stored.generation
        || written.upload.chunk != *chunk
        || written.upload.attempt_id.is_empty()
        || written.upload.object_key.is_empty()
        || written.object_version.is_empty()
        || written.size != chunk.cipher_byte_size
        || !written.sha256.eq_ignore_ascii_case(&chunk.cipher_sha256)
    {
        return Err(Error::StorageUnavailable);
    }
    Ok(())
}

pub async fn upload<S: Store, O: Objects, F, Fut, B, Body>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    index: u32,
    io: (F, B),
    now: u64,
) -> Result<()>
where
    F: FnOnce(ResourceCost) -> Fut,
    Fut: Future<Output = Result<()>>,
    B: FnOnce(u64) -> Body,
    Body: Future<Output = Result<O::UploadBody>>,
{
    access.ensure_current(now)?;
    access.snapshot().attachments.limit()?;
    let stored = store.attachment(access, id, now).await?;
    check_stored(&stored, id, now)?;
    owner(access, &stored)?;
    check_size(access, &stored)?;
    if stored.state == State::Deleting {
        return Err(Error::NotFound);
    }
    let chunk = stored
        .metadata
        .expected_chunk(index)
        .ok_or(Error::NotFound)?;
    let reservation = store.reserve_upload(access, &stored, index, now).await?;
    let (before_io, read_body) = io;
    let (upload, recover) = match reservation {
        Reservation::Complete(written) => {
            check_written(&written, &stored, index)?;
            return Ok(());
        }
        Reservation::Write(upload) => (upload, false),
        Reservation::Recover(upload) => (upload, true),
    };
    if upload.attachment_id != id
        || upload.generation != stored.generation
        || upload.chunk != *chunk
        || upload.attempt_id.is_empty()
        || upload.object_key.is_empty()
    {
        return Err(Error::StorageUnavailable);
    }
    if recover {
        before_io(ResourceCost::AttachmentRecovery).await?;
        let written = objects
            .recover(&upload, access.deadline())
            .await?
            .ok_or(Error::Conflict)?;
        check_written(&written, &stored, index)?;
        if written.upload != upload {
            return Err(Error::StorageUnavailable);
        }
        // 这是旧尝试的恢复结果；确认失败也不删除可能仍在提交的原对象。
        return store.confirm_upload(access, &written, now).await;
    }
    if let Err(error) = before_io(ResourceCost::AttachmentUpload {
        bytes: chunk.cipher_byte_size,
    })
    .await
    {
        let _ = store.release_upload(access, &upload, now).await;
        return Err(error);
    }
    let body = match read_body(chunk.cipher_byte_size).await {
        Ok(body) => body,
        Err(error) => {
            let _ = store.release_upload(access, &upload, now).await;
            return Err(error);
        }
    };
    // 一旦调用put，错误也可能表示结果未知，不能再退回可写状态。
    let written = objects.put(&upload, body, access.deadline()).await?;
    let result = check_written(&written, &stored, index).and_then(|()| {
        if written.upload == upload {
            Ok(())
        } else {
            Err(Error::StorageUnavailable)
        }
    });
    let result = match result {
        Ok(()) => store.confirm_upload(access, &written, now).await,
        Err(error) => Err(error),
    };
    if result.is_err()
        && written.upload.attempt_id == upload.attempt_id
        && written.upload.object_key == upload.object_key
    {
        let _ = objects.discard(&written).await;
    }
    result
}

pub async fn download<S: Store, O: Objects, F, Fut>(
    store: &S,
    objects: &O,
    access: &Access,
    id: &str,
    index: u32,
    before_io: F,
    now: u64,
) -> Result<O::DownloadBody>
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    access.ensure_current(now)?;
    access.snapshot().attachments.limit()?;
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
    check_size(access, &stored)?;
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
    before_io(written.size).await?;
    objects.open(&written, access.deadline()).await
}

async fn delete<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    deletion: &Deletion,
    now: u64,
) -> Result<DeletionProgress> {
    let mut progress = objects.delete(deletion).await?;
    if progress.complete {
        store.finalize(deletion).await?;
        progress.progressed = true;
    } else {
        store
            .defer_deletions(
                std::slice::from_ref(deletion),
                now,
                if progress.progressed {
                    DeletionRetry::Progress
                } else {
                    DeletionRetry::Unknown
                },
            )
            .await?;
    }
    Ok(progress)
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
        delete(store, objects, &deletion, now).await?;
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
    delete(store, objects, &deletion, now).await.map(|_| ())
}

/// 正常部分完成继续其它附件；真实故障保留定位，不能把未删完当作已释放。
pub async fn cleanup<S: Store, O: Objects>(
    store: &S,
    objects: &O,
    now: u64,
    limit: u32,
) -> Result<DeletionProgress> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidRequest);
    }
    let deletions = store.pending_deletions(now, limit).await?;
    if deletions.len() > limit as usize {
        return Err(Error::StorageUnavailable);
    }
    let mut result = DeletionProgress {
        complete: deletions.len() < limit as usize,
        progressed: false,
    };
    for (index, deletion) in deletions.iter().enumerate() {
        if !valid_identifier(&deletion.attachment_id, 128) || deletion.generation.is_empty() {
            return Err(Error::StorageUnavailable);
        }
        let progress = match delete(store, objects, deletion, now).await {
            Ok(progress) => progress,
            // 轮内预算耗尽属于正常续跑，已完成的其它附件进度不能丢失。
            Err(Error::ResourceLimit) => {
                // 尚未处理的同批定位也一次性延期，不能掉回原5分钟瓶颈。
                store
                    .defer_deletions(&deletions[index..], now, DeletionRetry::Progress)
                    .await?;
                result.complete = false;
                break;
            }
            Err(error) => {
                store
                    .defer_deletions(&deletions[index..], now, DeletionRetry::Failure)
                    .await?;
                return Err(error);
            }
        };
        result.complete &= progress.complete;
        result.progressed |= progress.progressed;
    }
    Ok(result)
}
