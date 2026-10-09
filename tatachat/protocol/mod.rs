//! SDK唯一Protobuf生成结果及帧编解码，不维护手写协议副本。
pub mod command;
use prost::Message;

use crate::tatachat::Error;

mod generated {
    include!(concat!(env!("OUT_DIR"), "/chat.protocol.rs"));
}

pub use generated::*;

/// 平台适配共用的唯一Protobuf解码入口。
pub fn decode_chat_frame(bytes: &[u8], maximum: usize) -> Result<ChatFrame, Error> {
    if bytes.is_empty() {
        return Err(Error::InvalidRequest);
    }
    if maximum == 0 || bytes.len() > maximum {
        return Err(Error::ResourceLimit);
    }
    ChatFrame::decode(bytes).map_err(|_| Error::InvalidRequest)
}

/// 平台适配共用的唯一Protobuf编码入口。
pub fn encode_chat_frame(frame: &ChatFrame) -> Vec<u8> {
    frame.encode_to_vec()
}
/// 使用同一Protobuf实现计算出站预算，不手写另一套字段长度规则。
pub fn encoded_len(frame: &ChatFrame) -> usize {
    frame.encoded_len()
}

pub fn ready_frame(server_time_millis: u64) -> ChatFrame {
    ChatFrame {
        body: Some(chat_frame::Body::Ready(Ready { server_time_millis })),
    }
}

pub fn failure_frame(error: Error) -> ChatFrame {
    ChatFrame {
        body: Some(chat_frame::Body::Failure(Failure {
            code: error.code().to_owned(),
            message: String::new(),
        })),
    }
}

pub fn success_frame(kind: &str, ids: Vec<String>) -> ChatFrame {
    ChatFrame {
        body: Some(chat_frame::Body::Success(Success {
            kind: kind.to_owned(),
            ids,
        })),
    }
}

pub fn pong_frame(sent_at_millis: u64, server_time_millis: u64) -> ChatFrame {
    ChatFrame {
        body: Some(chat_frame::Body::Pong(Pong {
            sent_at_millis,
            server_time_millis,
        })),
    }
}

pub fn key_package_batch_frame(
    packages: &[crate::tatachat::key::Package],
) -> Result<ChatFrame, Error> {
    Ok(ChatFrame {
        body: Some(chat_frame::Body::KeyPackageBatch(KeyPackageBatch {
            key_packages: packages
                .iter()
                .map(crate::tatachat::key::Package::to_protocol)
                .collect::<Result<Vec<_>, _>>()?,
        })),
    })
}

pub fn message_batch_frame(
    records: &[crate::tatachat::mailbox::Delivery],
) -> Result<ChatFrame, Error> {
    Ok(ChatFrame {
        body: Some(chat_frame::Body::MessageBatch(MessageBatch {
            messages: records
                .iter()
                .map(crate::tatachat::mailbox::Delivery::to_protocol)
                .collect::<Result<Vec<_>, _>>()?,
        })),
    })
}

pub fn attachment_ready_frame(attachment_id: String) -> ChatFrame {
    ChatFrame {
        body: Some(chat_frame::Body::AttachmentReady(AttachmentReady {
            attachment_id,
        })),
    }
}

#[cfg(test)]
mod tests;
