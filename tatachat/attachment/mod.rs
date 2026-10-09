//! 密文附件模型。创建设备是内部属主字段，不改变SDK的收件用户协议。
pub mod ports;
pub mod service;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::tatachat::{auth::Device, mailbox::server_expiry, protocol, valid_identity, Error};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    pub chunk_index: u32,
    pub cipher_byte_size: u64,
    pub cipher_sha256: String,
}

/// 客户端已经完成端到端加密的附件元数据。服务端永远看不到明文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub attachment_id: String,
    pub sender_user_id: String,
    pub sender_device_id: String,
    pub recipient_user_ids: Vec<String>,
    pub chunks: Vec<Chunk>,
    pub cipher_byte_size: u64,
    pub cipher_sha256: String,
    pub created_at_millis: u64,
    pub accepted_at_millis: u64,
    pub expires_at_millis: u64,
}

/// 授权值始终是明文字节额度；MLS协议每1MiB块仅允许4KiB总开销。
/// 计算只使用服务端有效额度，拒绝零额度和任意算术溢出。
pub fn mls_attachment_wire_limit(plain_limit: u64) -> Result<u64, Error> {
    if plain_limit == 0 {
        return Err(Error::ResourceLimit);
    }
    let blocks = plain_limit / (1024 * 1024) + u64::from(!plain_limit.is_multiple_of(1024 * 1024));
    let overhead = blocks.checked_mul(4 * 1024).ok_or(Error::ResourceLimit)?;
    plain_limit
        .checked_add(overhead)
        .ok_or(Error::ResourceLimit)
}

impl Attachment {
    /// 统一校验分块清单，并使用服务端接收时间生成最终期限。
    pub fn from_protocol(
        attachment: &protocol::AttachmentMetadata,
        actor: &Device,
        now_millis: u64,
        max_plain_bytes: u64,
    ) -> Result<Self, Error> {
        actor.validate()?;
        let max_cipher_bytes = mls_attachment_wire_limit(max_plain_bytes)?;
        if attachment.sender_user_id != actor.user_id
            || !valid_attachment_id(&attachment.attachment_id)
            || attachment.recipient_user_ids.is_empty()
            || attachment.recipient_user_ids.len() > 256
            || attachment.chunks.is_empty()
            || attachment.chunks.len() > 10_000
            || attachment.cipher_byte_size == 0
            || attachment.cipher_byte_size > max_cipher_bytes
            || !valid_sha256(&attachment.cipher_sha256)
        {
            return Err(Error::InvalidRequest);
        }

        let mut total = 0_u64;
        let chunks = attachment
            .chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                if chunk.chunk_index != index as u32
                    || chunk.cipher_byte_size == 0
                    || chunk.cipher_byte_size > max_cipher_bytes
                    || chunk.cipher_byte_size > 4 * 1024 * 1024
                    || !valid_sha256(&chunk.cipher_sha256)
                {
                    return Err(Error::InvalidRequest);
                }
                total = total
                    .checked_add(chunk.cipher_byte_size)
                    .ok_or(Error::ResourceLimit)?;
                Ok(Chunk {
                    chunk_index: chunk.chunk_index,
                    cipher_byte_size: chunk.cipher_byte_size,
                    cipher_sha256: chunk.cipher_sha256.to_ascii_lowercase(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if total != attachment.cipher_byte_size || total > max_cipher_bytes {
            return Err(Error::InvalidRequest);
        }

        let mut recipients = HashSet::with_capacity(attachment.recipient_user_ids.len());
        for recipient in &attachment.recipient_user_ids {
            if !valid_identity(recipient) || !recipients.insert(recipient.clone()) {
                return Err(Error::InvalidRequest);
            }
        }
        Ok(Self {
            attachment_id: attachment.attachment_id.clone(),
            sender_user_id: attachment.sender_user_id.clone(),
            sender_device_id: actor.device_id.clone(),
            recipient_user_ids: attachment.recipient_user_ids.clone(),
            chunks,
            cipher_byte_size: attachment.cipher_byte_size,
            cipher_sha256: attachment.cipher_sha256.to_ascii_lowercase(),
            created_at_millis: attachment.created_at_millis,
            accepted_at_millis: now_millis,
            expires_at_millis: server_expiry(attachment.created_at_millis, now_millis)?,
        })
    }

    pub fn expected_chunk(&self, chunk_index: u32) -> Option<&Chunk> {
        self.chunks
            .get(chunk_index as usize)
            .filter(|chunk| chunk.chunk_index == chunk_index)
    }

    pub fn validate_stored(&self) -> Result<(), Error> {
        if !valid_attachment_id(&self.attachment_id)
            || !valid_identity(&self.sender_user_id)
            || !valid_identity(&self.sender_device_id)
            || self.recipient_user_ids.is_empty()
            || self.recipient_user_ids.len() > 256
            || self.chunks.is_empty()
            || self.chunks.len() > 10_000
            || self.cipher_byte_size == 0
            || self.expires_at_millis <= self.accepted_at_millis
            || server_expiry(self.created_at_millis, self.accepted_at_millis)?
                != self.expires_at_millis
            || !valid_sha256(&self.cipher_sha256)
        {
            return Err(Error::InvalidRequest);
        }
        let mut recipients = HashSet::with_capacity(self.recipient_user_ids.len());
        if self
            .recipient_user_ids
            .iter()
            .any(|recipient| !valid_identity(recipient) || !recipients.insert(recipient))
        {
            return Err(Error::InvalidRequest);
        }
        let mut total = 0_u64;
        for (index, chunk) in self.chunks.iter().enumerate() {
            if chunk.chunk_index != index as u32
                || chunk.cipher_byte_size == 0
                || chunk.cipher_byte_size > 4 * 1024 * 1024
                || !valid_sha256(&chunk.cipher_sha256)
            {
                return Err(Error::InvalidRequest);
            }
            total = total
                .checked_add(chunk.cipher_byte_size)
                .ok_or(Error::InvalidRequest)?;
        }
        if total != self.cipher_byte_size {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
}

fn valid_attachment_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests;
