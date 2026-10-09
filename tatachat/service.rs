//! 十二类命令的唯一通用执行入口，返回提交后的响应和可丢失实时加速事件。
use super::{
    attachment,
    auth::{ports::Host, Device},
    key, mailbox,
    protocol::{
        self,
        command::{parse_control_command, Command},
    },
    push,
    realtime::{session::Session, Event},
    Limits, Result,
};

pub struct Notification {
    pub recipient: Device,
    pub event: Event,
}
pub struct Executed {
    pub frame: protocol::ChatFrame,
    pub notifications: Vec<Notification>,
}

/// 平台装配同一存储实现的功能端口；不会启动独立运行包或维护第二套路由。
pub struct Service<'a, H, S, O> {
    pub host: &'a H,
    pub store: &'a S,
    pub objects: &'a O,
    pub push_config: &'a push::Config,
    pub limits: Limits,
}
impl<H, S, O> Service<'_, H, S, O>
where
    H: Host,
    S: key::ports::Store + mailbox::ports::Store + attachment::ports::Store + push::ports::Store,
    O: attachment::ports::Objects,
{
    /// 驱动发送frame后可调度notifications；通知丢失由设备同步和持久推送outbox补足。
    pub async fn execute(&self, session: &mut Session, bytes: &[u8]) -> Result<Executed> {
        self.limits.validate()?;
        session.check(self.host).await?;
        let now = self.host.now_millis();
        let actor = session.access().actor().clone();
        let maximum = session
            .access()
            .effective_max_attachment_bytes(self.limits.max_attachment_bytes)?;
        let command = parse_control_command(
            protocol::decode_chat_frame(bytes, self.limits.max_frame_bytes)?,
            &actor,
            now,
            maximum,
            &mut session.limits,
        )?;
        let access = session.access();
        let mut notifications = Vec::new();
        let frame = match command {
            Command::Ping { sent_at_millis } => protocol::pong_frame(sent_at_millis, now),
            Command::PublishKeyPackage(package) => {
                key::publish(self.store, access, &package, now).await?;
                protocol::success_frame("key_package.published", vec![package.key_package_ref])
            }
            Command::ResolveKeyPackages {
                user_id,
                device_id,
                limit,
            } => {
                let packages = key::resolve(
                    self.store,
                    &user_id,
                    device_id.as_deref(),
                    now,
                    limit,
                    self.limits.max_frame_bytes,
                )
                .await?;
                protocol::key_package_batch_frame(&packages)?
            }
            Command::SendMessage(message) => {
                let accepted = mailbox::service::send(self.store, access, &message, now).await?;
                if accepted.commit == mailbox::ports::Commit::Inserted {
                    notifications = accepted
                        .deliveries
                        .iter()
                        .map(|delivery| Notification {
                            recipient: Device {
                                user_id: delivery.recipient_user_id.clone(),
                                device_id: delivery.recipient_device_id.clone(),
                            },
                            event: Event::message_available(delivery, now),
                        })
                        .collect();
                }
                protocol::success_frame("message.accepted", vec![message.message_id])
            }
            Command::SyncMessages { limit } => {
                let records = mailbox::service::sync(
                    self.store,
                    access,
                    now,
                    limit,
                    self.limits.max_frame_bytes,
                )
                .await?;
                protocol::message_batch_frame(&records)?
            }
            Command::AcknowledgeMessages { message_ids } => {
                mailbox::service::acknowledge(self.store, access, &message_ids, now).await?;
                protocol::success_frame("messages.acknowledged", message_ids)
            }
            Command::BeginAttachment(metadata) => {
                attachment::service::begin(self.store, access, &metadata, now).await?;
                protocol::success_frame("attachment.begun", vec![metadata.attachment_id])
            }
            Command::CompleteAttachment { attachment_id } => {
                attachment::service::complete(self.store, access, &attachment_id, now).await?;
                protocol::attachment_ready_frame(attachment_id)
            }
            Command::AcknowledgeAttachment { attachment_id } => {
                attachment::service::acknowledge(
                    self.store,
                    self.objects,
                    access,
                    &attachment_id,
                    now,
                )
                .await?;
                protocol::success_frame("attachment.acknowledged", vec![attachment_id])
            }
            Command::AbortAttachment { attachment_id } => {
                attachment::service::abort(self.store, self.objects, access, &attachment_id, now)
                    .await?;
                protocol::success_frame("attachment.aborted", vec![attachment_id])
            }
            Command::RegisterPush { platform, token } => {
                push::service::register(self.store, access, self.push_config, platform, token, now)
                    .await?;
                protocol::success_frame("push.registered", Vec::new())
            }
            Command::RemovePush { platform } => {
                push::service::remove(self.store, access, platform, now).await?;
                protocol::success_frame("push.removed", Vec::new())
            }
        };
        if protocol::encoded_len(&frame) > self.limits.max_frame_bytes {
            return Err(super::Error::ResourceLimit);
        }
        // 等待存储期间可能越过再核验/凭证期限，禁止直接把旧权限当成持续有效。
        session.check(self.host).await?;
        Ok(Executed {
            frame,
            notifications,
        })
    }
}
