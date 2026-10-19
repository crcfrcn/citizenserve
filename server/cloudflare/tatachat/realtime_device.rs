//! 设备DO存储完整快照，连接attachment只保存小型随机定位，恢复强制查宿主。
use super::super::{attachment::R2Objects, config, D1Store};
use citizenserve::tatachat::auth::ports::{Host as _, ResourceCost};
use citizenserve::tatachat::{
    protocol,
    realtime::{
        session::{Session, Snapshot},
        Event,
    },
    service::Service,
    Error as ChatError,
};
use serde::{Deserialize, Serialize};
use worker::*;
#[derive(Serialize, Deserialize)]
struct Locator {
    version: u8,
    id: String,
}
#[derive(Default, Serialize, Deserialize)]
struct ResourceWindow {
    minute: u64,
    frames: u64,
    bytes: u64,
    // 既有固定键缺新字段时只将Ping次数视为0，其余原字段仍严格解码。
    #[serde(default)]
    pings: u64,
}
// 有界分类的结果直接交给原事件路径；未知帧保留原协议错误，不读取宿主。
enum FrameCheck {
    Ready(Vec<u8>),
    Invalid,
    Limited,
}
#[durable_object]
pub struct TataChatDevice {
    state: State,
    env: Env,
    gate: futures_util::lock::Mutex<()>,
}
impl TataChatDevice {
    /// 总帧、字节与Ping共用一次持久窗读取/写入；先于宿主、快照恢复和主库。
    async fn consume_frame(&self, message: WebSocketIncomingMessage) -> worker::Result<FrameCheck> {
        use citizenserve::membership::limits::{
            DEVICE_FRAMES_MINUTE, DEVICE_FRAME_BYTES_MINUTE, DEVICE_PINGS_MINUTE, DEVICE_PING_BYTES,
        };
        let size = match &message {
            WebSocketIncomingMessage::Binary(bytes) => bytes.len(),
            WebSocketIncomingMessage::String(text) => text.len(),
        } as u64;
        let minute = config::now() / 60_000;
        let mut window = self
            .state
            .storage()
            .get::<ResourceWindow>("resource:minute")
            .await?
            .unwrap_or_default();
        if minute < window.minute {
            return Ok(FrameCheck::Limited);
        }
        if minute > window.minute {
            window = ResourceWindow {
                minute,
                ..Default::default()
            };
        }
        let frames = window.frames.checked_add(1).ok_or(Self::failure())?;
        let total = window.bytes.checked_add(size).ok_or(Self::failure())?;
        let mut pings = window.pings;
        let mut result = FrameCheck::Limited;
        if frames <= DEVICE_FRAMES_MINUTE && total <= DEVICE_FRAME_BYTES_MINUTE {
            if let WebSocketIncomingMessage::Binary(bytes) = message {
                if bytes.len() <= config::LIMITS.max_frame_bytes {
                    result = match citizenserve::server::gate::classify_chat(
                        &bytes,
                        config::LIMITS.max_frame_bytes,
                    ) {
                        Ok(frame) => {
                            if matches!(frame.body, Some(protocol::chat_frame::Body::Ping(_))) {
                                pings = pings.checked_add(1).ok_or(Self::failure())?;
                                if size > DEVICE_PING_BYTES || pings > DEVICE_PINGS_MINUTE {
                                    FrameCheck::Limited
                                } else {
                                    FrameCheck::Ready(bytes)
                                }
                            } else {
                                FrameCheck::Ready(bytes)
                            }
                        }
                        Err(_) => FrameCheck::Invalid,
                    };
                }
            }
        }
        // 拒绝也计原总量；Ping超额只封住Ping子量，不给重连或休眠重置窗口。
        let next = (
            frames.min(DEVICE_FRAMES_MINUTE),
            total.min(DEVICE_FRAME_BYTES_MINUTE),
            pings.min(DEVICE_PINGS_MINUTE),
        );
        if next != (window.frames, window.bytes, window.pings) {
            window.frames = next.0;
            window.bytes = next.1;
            window.pings = next.2;
            self.state.storage().put("resource:minute", window).await?;
        }
        Ok(result)
    }
    fn failure() -> worker::Error {
        worker::Error::RustError("tatachat_runtime_unavailable".into())
    }
    fn id(ws: &WebSocket) -> worker::Result<String> {
        let value: Locator = ws.deserialize_attachment()?.ok_or(Self::failure())?;
        if value.version != 1
            || value.id.len() != 32
            || !value.id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Self::failure());
        }
        Ok(value.id)
    }
    async fn close(&self, ws: &WebSocket) -> worker::Result<()> {
        let _ = ws.close(Some(1008), Some("chat_access_unavailable"));
        if let Ok(id) = Self::id(ws) {
            self.state
                .storage()
                .delete(&format!("connection:{id}"))
                .await?;
        }
        Ok(())
    }
    async fn restore(
        &self,
        ws: &WebSocket,
        host: &super::super::Host,
    ) -> citizenserve::tatachat::Result<Session> {
        let id = Self::id(ws).map_err(|_| ChatError::Forbidden)?;
        let snapshot: Snapshot = self
            .state
            .storage()
            .get(&format!("connection:{id}"))
            .await
            .map_err(|_| ChatError::StorageUnavailable)?
            .ok_or(ChatError::Forbidden)?;
        let namespace = self
            .env
            .durable_object("TATACHAT_DEVICES")
            .map_err(|_| ChatError::StorageUnavailable)?;
        if namespace
            .id_from_name(&super::name(&snapshot.access.actor)?)
            .map_err(|_| ChatError::StorageUnavailable)?
            .to_string()
            != self.state.id().to_string()
        {
            return Err(ChatError::Forbidden);
        }
        Session::restore(host, snapshot).await
    }
    async fn save(&self, ws: &WebSocket, session: &Session) -> worker::Result<()> {
        self.state
            .storage()
            .put(&format!("connection:{}", Self::id(ws)?), session.snapshot())
            .await
    }
    async fn arm(&self) -> worker::Result<()> {
        if let Err(error) = self.arm_inner().await {
            // 定时再核验无法安排时关闭连接；禁止让静默连接持续使用旧权限。
            for ws in self.state.get_websockets() {
                let _ = self.close(&ws).await;
            }
            return Err(error);
        }
        Ok(())
    }
    async fn arm_inner(&self) -> worker::Result<()> {
        let mut earliest = None::<u64>;
        for ws in self.state.get_websockets() {
            let snapshot = match Self::id(&ws) {
                Ok(id) => {
                    self.state
                        .storage()
                        .get::<Snapshot>(&format!("connection:{id}"))
                        .await?
                }
                Err(_) => None,
            };
            if let Some(snapshot) = snapshot {
                let deadline = snapshot
                    .access
                    .recheck_at_millis
                    .min(snapshot.access.expires_at_millis);
                earliest = Some(earliest.map_or(deadline, |value| value.min(deadline)));
            } else {
                self.close(&ws).await?;
            }
        }
        if let Some(at) = earliest {
            self.state
                .storage()
                .set_alarm(
                    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(at as i64)
                        .ok_or(Self::failure())?,
                )
                .await?;
        } else {
            self.state.storage().delete_alarm().await?;
        }
        Ok(())
    }
}
impl DurableObject for TataChatDevice {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            gate: futures_util::lock::Mutex::new(()),
        }
    }
    async fn fetch(&self, mut request: Request) -> worker::Result<Response> {
        let _gate = self.gate.lock().await;
        if request.url()?.as_str() == "https://tatachat.internal/notify"
            && request.method() == Method::Post
        {
            // 此入口仅由平台命名空间stub交付；公网请求不能识别成内部开放类型。
            citizenserve::server::gate::open::system(
                citizenserve::server::gate::open::SystemOperation::ChatNotify,
                request.url()?.as_str(),
                "https://tatachat.internal/notify",
            )
            .map_err(|_| Self::failure())?;
            let bytes = crate::body(&mut request, 4096)
                .await
                .map_err(|_| Self::failure())?;
            let event = Event::from_bytes(bytes, 4096).map_err(|_| Self::failure())?;
            let host = super::super::host(&self.env).map_err(|_| Self::failure())?;
            for ws in self.state.get_websockets() {
                match self.restore(&ws, &host).await {
                    Ok(session) => {
                        self.save(&ws, &session).await?;
                        if ws.send_with_bytes(event.as_bytes()).is_err() {
                            self.close(&ws).await?
                        }
                    }
                    Err(_) => self.close(&ws).await?,
                }
            }
            self.arm().await?;
            return Ok(Response::empty()?.with_status(204));
        }
        let entry = match crate::gate_entry(&request, &self.env) {
            Ok(entry) => entry,
            Err(_) => return Response::error("forbidden", 403),
        };
        if entry
            .require_cid(citizenserve::server::gate::policy::CidRule::Chat)
            .is_err()
        {
            return Response::error("forbidden", 403);
        }
        let host = super::super::host(&self.env).map_err(|_| Self::failure())?;
        if request.path() != "/api/tatachat/realtime"
            || request.method() != Method::Get
            || request.url()?.origin().ascii_serialization() != host.config.service_origin
        {
            return Response::error("invalid_request", 400);
        }
        let access = match super::super::routes::authorize(&request, &self.env, &host).await {
            Ok(a) => a,
            Err(ChatError::ResourceLimit) => return Response::error("resource_limit", 429),
            Err(_) => return Response::error("forbidden", 403),
        };
        let namespace = self.env.durable_object("TATACHAT_DEVICES")?;
        if namespace
            .id_from_name(&super::name(access.actor()).map_err(|_| Self::failure())?)?
            .to_string()
            != self.state.id().to_string()
        {
            return Response::error("forbidden", 403);
        }
        if let Err(error) = host
            .consume(access.snapshot(), ResourceCost::Connection)
            .await
        {
            return Response::error(
                error.code(),
                match error {
                    ChatError::ResourceLimit => 429,
                    ChatError::Forbidden => 403,
                    _ => 503,
                },
            );
        }
        if self.state.get_websockets().len() >= config::MAX_CONNECTIONS {
            return Response::error("resource_limit", 429);
        }
        // DO仍独立核验升级合同，不能仅信任Worker传来的头。
        if request.headers().get("upgrade")?.as_deref() != Some("websocket")
            || !request
                .headers()
                .get("sec-websocket-protocol")?
                .unwrap_or_default()
                .split(',')
                .any(|p| p.trim() == "tatachat")
        {
            return Response::error("invalid_request", 400);
        }
        let pair = WebSocketPair::new()?;
        let id = config::random_id().map_err(|_| Self::failure())?;
        let session = Session::new(access);
        pair.server
            .serialize_attachment(Locator { version: 1, id })?;
        self.save(&pair.server, &session).await?;
        self.state.accept_web_socket(&pair.server);
        self.arm().await?;
        pair.server
            .send_with_bytes(protocol::encode_chat_frame(&protocol::ready_frame(
                config::now(),
            )))?;
        let mut response = Response::from_websocket(pair.client)?;
        response
            .headers_mut()
            .set("sec-websocket-protocol", "tatachat")?;
        Ok(response)
    }
    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> worker::Result<()> {
        let gate = self.gate.lock().await;
        let bytes = match self.consume_frame(message).await? {
            FrameCheck::Ready(bytes) => bytes,
            FrameCheck::Limited => {
                self.close(&ws).await?;
                self.arm().await?;
                return Ok(());
            }
            FrameCheck::Invalid => {
                // 保留原协议失败帧，不读取/延长会话，也不重排既有到期闹钟。
                ws.send_with_bytes(protocol::encode_chat_frame(&protocol::failure_frame(
                    ChatError::InvalidRequest,
                )))?;
                return Ok(());
            }
        };
        let host = super::super::host(&self.env).map_err(|_| Self::failure())?;
        let mut session = match self.restore(&ws, &host).await {
            Ok(session) => session,
            Err(_) => {
                self.close(&ws).await?;
                self.arm().await?;
                return Ok(());
            }
        };
        let store = D1Store::new(&self.env)
            .map_err(|_| Self::failure())?
            .with_attachment_resources(host.attachment_resources());
        let objects = R2Objects::new(&self.env, store.clone()).map_err(|_| Self::failure())?;
        let push_config = config::push_config(&self.env);
        let result = Service {
            host: &host,
            store: &store,
            objects: &objects,
            push_config: &push_config,
            limits: config::LIMITS,
        }
        .execute(&mut session, &bytes)
        .await;
        let notifications = match result {
            Ok(executed) => {
                self.save(&ws, &session).await?;
                ws.send_with_bytes(protocol::encode_chat_frame(&executed.frame))?;
                executed.notifications
            }
            Err(error) => {
                self.save(&ws, &session).await?;
                ws.send_with_bytes(protocol::encode_chat_frame(&protocol::failure_frame(error)))?;
                if session.is_closed() {
                    self.close(&ws).await?;
                }
                Vec::new()
            }
        };
        self.arm().await?;
        drop(gate);
        // 提交完成并释放设备事件锁后再调用其他DO，避免跨设备通知互相等待。
        let _ = super::super::mailbox::notify(&self.env, &notifications).await;
        Ok(())
    }
    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> worker::Result<()> {
        let _gate = self.gate.lock().await;
        self.close(&ws).await?;
        self.arm().await
    }
    async fn websocket_error(&self, ws: WebSocket, _error: worker::Error) -> worker::Result<()> {
        let _gate = self.gate.lock().await;
        self.close(&ws).await?;
        self.arm().await
    }
    async fn alarm(&self) -> worker::Result<Response> {
        // 只有平台闹钟回调可选此内部类型；统一门禁之后仍逐个执行原会话恢复与权限复核。
        citizenserve::server::gate::open::system(
            citizenserve::server::gate::open::SystemOperation::ChatAlarm,
            "cloudflare.tatachat.alarm",
            "cloudflare.tatachat.alarm",
        )
        .map_err(|_| Self::failure())?;
        let _gate = self.gate.lock().await;
        let host = super::super::host(&self.env).map_err(|_| Self::failure())?;
        for ws in self.state.get_websockets() {
            match self.restore(&ws, &host).await {
                Ok(session) => self.save(&ws, &session).await?,
                Err(_) => self.close(&ws).await?,
            }
        }
        self.arm().await?;
        Response::empty()
    }
}
