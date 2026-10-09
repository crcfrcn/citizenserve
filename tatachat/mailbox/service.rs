//! 密文投递的执行规则。事务成功才产生可供协调器发出的实时唤醒。
use super::{
    ports::{Commit, Store},
    Delivery, Receipt,
};
use crate::tatachat::{auth::Access, protocol, valid_identifier, Error, Result};

pub struct Accepted {
    pub deliveries: Vec<Delivery>,
    pub commit: Commit,
}
pub async fn send<S: Store>(
    store: &S,
    access: &Access,
    message: &protocol::EncryptedMessage,
    now: u64,
) -> Result<Accepted> {
    access.ensure_current(now)?;
    let deliveries = Delivery::from_message(message, access.actor(), now)?;
    let receipt = Receipt::from_deliveries(&deliveries)?;
    let commit = store.commit_message(access, &receipt, &deliveries).await?;
    Ok(Accepted { deliveries, commit })
}

pub async fn sync<S: Store>(
    store: &S,
    access: &Access,
    now: u64,
    limit: u32,
    maximum_bytes: usize,
) -> Result<Vec<Delivery>> {
    access.ensure_current(now)?;
    if !(1..=100).contains(&limit) || maximum_bytes == 0 {
        return Err(Error::InvalidRequest);
    }
    let records = store.messages(access, now, limit, maximum_bytes).await?;
    if records.len() > limit as usize
        || records.iter().any(|record| {
            record.recipient_user_id != access.actor().user_id
                || record.recipient_device_id != access.actor().device_id
                || record.expires_at_millis <= now
                || record.accepted_at_millis > now
        })
    {
        return Err(Error::StorageUnavailable);
    }
    for record in &records {
        record.to_protocol()?;
    }
    if protocol::encoded_len(&protocol::message_batch_frame(&records)?) > maximum_bytes {
        return Err(Error::StorageUnavailable);
    }
    Ok(records)
}

pub async fn acknowledge<S: Store>(
    store: &S,
    access: &Access,
    ids: &[String],
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    if ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| !valid_identifier(id, 128)) {
        return Err(Error::InvalidRequest);
    }
    store.acknowledge_messages(access, ids, now).await
}
