use crate::tatachat::{
    attachment::Attachment,
    auth::Device,
    key::Package,
    mailbox::Delivery,
    protocol::{chat_frame, ChatFrame},
    push::PushPlatform,
    realtime::session::SessionLimits,
    valid_identifier, valid_identity, Error,
};

pub enum Command {
    Ping {
        sent_at_millis: u64,
    },
    PublishKeyPackage(Package),
    ResolveKeyPackages {
        user_id: String,
        device_id: Option<String>,
        limit: u32,
    },
    SendMessage(crate::tatachat::protocol::EncryptedMessage),
    SyncMessages {
        limit: u32,
    },
    AcknowledgeMessages {
        message_ids: Vec<String>,
    },
    BeginAttachment(Attachment),
    CompleteAttachment {
        attachment_id: String,
    },
    AcknowledgeAttachment {
        attachment_id: String,
    },
    AbortAttachment {
        attachment_id: String,
    },
    RegisterPush {
        platform: PushPlatform,
        token: String,
    },
    RemovePush {
        platform: PushPlatform,
    },
}

/// 客户端命令的唯一通用解析入口。
pub fn parse_control_command(
    frame: ChatFrame,
    actor: &Device,
    now_millis: u64,
    max_attachment_bytes: u64,
    limits: &mut SessionLimits,
) -> Result<Command, Error> {
    actor.validate()?;
    match frame.body.ok_or(Error::InvalidRequest)? {
        chat_frame::Body::Ping(value) => Ok(Command::Ping {
            sent_at_millis: value.sent_at_millis,
        }),
        chat_frame::Body::PublishKeyPackage(value) => {
            let package = value.key_package.as_ref().ok_or(Error::InvalidRequest)?;
            Ok(Command::PublishKeyPackage(Package::from_protocol(
                package, actor, now_millis,
            )?))
        }
        chat_frame::Body::ResolveKeyPackages(value) => {
            limits.consume_resolve(now_millis)?;
            if !valid_identity(&value.user_id)
                || !value.device_id.is_empty() && !valid_identity(&value.device_id)
            {
                return Err(Error::InvalidRequest);
            }
            Ok(Command::ResolveKeyPackages {
                user_id: value.user_id,
                device_id: (!value.device_id.is_empty()).then_some(value.device_id),
                limit: default_limit(value.limit, 32, 100),
            })
        }
        chat_frame::Body::SendMessage(value) => {
            let message = value.message.ok_or(Error::InvalidRequest)?;
            Delivery::from_message(&message, actor, now_millis)?;
            Ok(Command::SendMessage(message))
        }
        chat_frame::Body::SyncMessages(value) => Ok(Command::SyncMessages {
            limit: default_limit(value.limit, 100, 100),
        }),
        chat_frame::Body::AcknowledgeMessages(value) => {
            if value.message_ids.is_empty()
                || value.message_ids.len() > 100
                || value
                    .message_ids
                    .iter()
                    .any(|id| !valid_identifier(id, 128))
            {
                return Err(Error::InvalidRequest);
            }
            Ok(Command::AcknowledgeMessages {
                message_ids: value.message_ids,
            })
        }
        chat_frame::Body::BeginAttachment(value) => {
            let attachment = value.attachment.ok_or(Error::InvalidRequest)?;
            Ok(Command::BeginAttachment(Attachment::from_protocol(
                &attachment,
                actor,
                now_millis,
                max_attachment_bytes,
            )?))
        }
        chat_frame::Body::CompleteAttachment(value) => Ok(Command::CompleteAttachment {
            attachment_id: checked_attachment_id(value.attachment_id)?,
        }),
        chat_frame::Body::AcknowledgeAttachment(value) => Ok(Command::AcknowledgeAttachment {
            attachment_id: checked_attachment_id(value.attachment_id)?,
        }),
        chat_frame::Body::AbortAttachment(value) => Ok(Command::AbortAttachment {
            attachment_id: checked_attachment_id(value.attachment_id)?,
        }),
        chat_frame::Body::RegisterPush(value) => {
            let platform = PushPlatform::parse(&value.platform)?;
            if value.token.is_empty()
                || value.token.len() > 4096
                || value.token.bytes().any(|byte| byte.is_ascii_whitespace())
            {
                return Err(Error::InvalidRequest);
            }
            Ok(Command::RegisterPush {
                platform,
                token: value.token,
            })
        }
        chat_frame::Body::RemovePush(value) => Ok(Command::RemovePush {
            platform: PushPlatform::parse(&value.platform)?,
        }),
        _ => Err(Error::InvalidRequest),
    }
}

fn default_limit(value: u32, default: u32, maximum: u32) -> u32 {
    if value == 0 {
        default
    } else {
        value.min(maximum)
    }
}

fn checked_attachment_id(value: String) -> Result<String, Error> {
    if valid_identifier(&value, 128) {
        Ok(value)
    } else {
        Err(Error::InvalidRequest)
    }
}
