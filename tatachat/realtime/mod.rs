//! 实时协议事件与连接生命周期，WebSocket/DO具体实现由平台驱动提供。
pub mod ports;
pub mod session;
use crate::tatachat::{
    mailbox::Delivery,
    protocol::{self, chat_frame, ChatFrame, MessageAvailable},
    Error, Result,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event(Vec<u8>);
impl Event {
    pub fn message_available(message: &Delivery, now: u64) -> Self {
        Self(protocol::encode_chat_frame(&ChatFrame {
            body: Some(chat_frame::Body::MessageAvailable(MessageAvailable {
                message_id: message.message_id.clone(),
                conversation_id: message.conversation_id.clone(),
                server_time_millis: now,
            })),
        }))
    }
    /// 内部通知只接受MessageAvailable，禁止接受SendMessage等客户端命令。
    pub fn from_bytes(bytes: Vec<u8>, maximum: usize) -> Result<Self> {
        let frame = protocol::decode_chat_frame(&bytes, maximum)?;
        match frame.body {
            Some(chat_frame::Body::MessageAvailable(value))
                if crate::tatachat::valid_identifier(&value.message_id, 128)
                    && crate::tatachat::valid_identifier(&value.conversation_id, 256) =>
            {
                Ok(Self(bytes))
            }
            _ => Err(Error::InvalidRequest),
        }
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
#[cfg(test)]
mod tests;
