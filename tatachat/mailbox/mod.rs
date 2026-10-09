//! 每设备密文模型、期限和完整收件集合幂等校验。
pub mod ports;
pub mod service;
use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::tatachat::{auth::Device, protocol, valid_identifier, valid_identity, Error};

pub const MESSAGE_RETENTION_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_FUTURE_SKEW_MILLIS: u64 = 5 * 60 * 1000;
const MAX_DELIVERIES: usize = 64;
const MAX_CIPHERTEXT_BYTES: usize = 1024 * 1024;

/// 一条按接收设备路由的不透明 RFC 9420 Message。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Delivery {
    pub message_id: String,
    pub conversation_id: String,
    pub sender_user_id: String,
    pub sender_device_id: String,
    pub recipient_user_id: String,
    pub recipient_device_id: String,
    pub openmls_ciphertext: String,
    pub created_at_millis: u64,
    pub accepted_at_millis: u64,
    pub expires_at_millis: u64,
}

impl Delivery {
    /// 把一条逻辑消息拆成按接收设备存储的密文记录，期限只由服务端计算。
    pub fn from_message(
        message: &protocol::EncryptedMessage,
        actor: &Device,
        now_millis: u64,
    ) -> Result<Vec<Self>, Error> {
        actor.validate()?;
        if message.sender_user_id != actor.user_id
            || message.sender_device_id != actor.device_id
            || !valid_identifier(&message.message_id, 128)
            || !valid_identifier(&message.conversation_id, 256)
            || message.deliveries.is_empty()
            || message.deliveries.len() > MAX_DELIVERIES
        {
            return Err(Error::InvalidRequest);
        }
        let expires_at_millis = server_expiry(message.created_at_millis, now_millis)?;
        let mut recipients = HashSet::with_capacity(message.deliveries.len());
        message
            .deliveries
            .iter()
            .map(|delivery| {
                let recipient = delivery.recipient.as_ref().ok_or(Error::InvalidRequest)?;
                if !valid_identity(&recipient.user_id)
                    || !valid_identity(&recipient.device_id)
                    || delivery.openmls_ciphertext.is_empty()
                    || delivery.openmls_ciphertext.len() > MAX_CIPHERTEXT_BYTES
                    || !recipients.insert((recipient.user_id.clone(), recipient.device_id.clone()))
                {
                    return Err(Error::InvalidRequest);
                }
                Ok(Self {
                    message_id: message.message_id.clone(),
                    conversation_id: message.conversation_id.clone(),
                    sender_user_id: message.sender_user_id.clone(),
                    sender_device_id: message.sender_device_id.clone(),
                    recipient_user_id: recipient.user_id.clone(),
                    recipient_device_id: recipient.device_id.clone(),
                    openmls_ciphertext: STANDARD.encode(&delivery.openmls_ciphertext),
                    created_at_millis: message.created_at_millis,
                    accepted_at_millis: now_millis,
                    expires_at_millis,
                })
            })
            .collect()
    }

    pub fn to_protocol(&self) -> Result<protocol::EncryptedMessage, Error> {
        let ciphertext = STANDARD
            .decode(&self.openmls_ciphertext)
            .map_err(|_| Error::StorageUnavailable)?;
        if !valid_identifier(&self.message_id, 128)
            || !valid_identifier(&self.conversation_id, 256)
            || !valid_identity(&self.sender_user_id)
            || !valid_identity(&self.sender_device_id)
            || !valid_identity(&self.recipient_user_id)
            || !valid_identity(&self.recipient_device_id)
            || ciphertext.is_empty()
            || ciphertext.len() > MAX_CIPHERTEXT_BYTES
            || server_expiry(self.created_at_millis, self.accepted_at_millis)
                .map_err(|_| Error::StorageUnavailable)?
                != self.expires_at_millis
        {
            return Err(Error::StorageUnavailable);
        }
        Ok(protocol::EncryptedMessage {
            message_id: self.message_id.clone(),
            conversation_id: self.conversation_id.clone(),
            sender_user_id: self.sender_user_id.clone(),
            sender_device_id: self.sender_device_id.clone(),
            deliveries: vec![protocol::EncryptedDelivery {
                recipient: Some(protocol::Recipient {
                    user_id: self.recipient_user_id.clone(),
                    device_id: self.recipient_device_id.clone(),
                }),
                openmls_ciphertext: ciphertext,
            }],
            created_at_millis: self.created_at_millis,
        })
    }
}

pub fn server_expiry(created_at_millis: u64, accepted_at_millis: u64) -> Result<u64, Error> {
    if created_at_millis == 0
        || created_at_millis > accepted_at_millis.saturating_add(MAX_FUTURE_SKEW_MILLIS)
    {
        return Err(Error::InvalidRequest);
    }
    let created_expiry = created_at_millis
        .checked_add(MESSAGE_RETENTION_MILLIS)
        .ok_or(Error::InvalidRequest)?;
    if created_expiry <= accepted_at_millis {
        return Err(Error::InvalidRequest);
    }
    Ok(created_expiry.min(accepted_at_millis.saturating_add(MESSAGE_RETENTION_MILLIS)))
}

/// ACK后的紧凑幂等凭据。摘要含完整不可变收件集合和各设备密文，顺序不影响语义。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub message_id: String,
    pub fingerprint: String,
    pub expires_at_millis: u64,
}
impl Receipt {
    pub fn from_deliveries(records: &[Delivery]) -> Result<Self, Error> {
        use sha2::{Digest, Sha256};
        let first = records.first().ok_or(Error::InvalidRequest)?;
        let mut sorted: Vec<_> = records.iter().collect();
        sorted.sort_by(|a, b| {
            (&a.recipient_user_id, &a.recipient_device_id)
                .cmp(&(&b.recipient_user_id, &b.recipient_device_id))
        });
        let mut digest = Sha256::new();
        let mut append = |value: &[u8]| {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value);
        };
        for value in [
            &first.message_id,
            &first.conversation_id,
            &first.sender_user_id,
            &first.sender_device_id,
        ] {
            append(value.as_bytes());
        }
        append(&first.created_at_millis.to_be_bytes());
        for (index, item) in sorted.iter().enumerate() {
            if item.message_id != first.message_id
                || item.conversation_id != first.conversation_id
                || item.sender_user_id != first.sender_user_id
                || item.sender_device_id != first.sender_device_id
                || item.created_at_millis != first.created_at_millis
                || index > 0
                    && item.recipient_user_id == sorted[index - 1].recipient_user_id
                    && item.recipient_device_id == sorted[index - 1].recipient_device_id
            {
                return Err(Error::InvalidRequest);
            }
            append(item.recipient_user_id.as_bytes());
            append(item.recipient_device_id.as_bytes());
            append(
                &STANDARD
                    .decode(&item.openmls_ciphertext)
                    .map_err(|_| Error::InvalidRequest)?,
            );
        }
        let fingerprint = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self {
            message_id: first.message_id.clone(),
            fingerprint,
            expires_at_millis: first.expires_at_millis,
        })
    }
}

#[cfg(test)]
mod tests;
