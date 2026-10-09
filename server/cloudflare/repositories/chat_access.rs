//! 聊天许可交付前从同一D1快照复核准入/设备/会话；不复制聊天用户或会员表。
use citizenserve::{
    server::tatachat::Authorization,
    shared::{Error, Result},
    user::{chat_access::Subject, registration::protocol::Config},
};
use worker::D1Database;

pub struct D1ChatAccess {
    pub db: D1Database,
}
/// 使用原授权view和当前设备issued_at，换绑/注销/重新授权发生在签名期间也不能交付旧凭证。
pub const CURRENT_SQL: &str = "SELECT a.session_token_hash FROM authorized_business_sessions a JOIN mls_devices d ON d.cid_number=a.cid_number AND d.device_id=a.device_id WHERE a.session_token_hash=?1 AND a.cid_number=?2 AND a.device_id=?3 AND a.account_id=?4 AND a.binding_revision=?5 AND a.registration_scope=?6 AND a.service_origin=?7 AND a.chain_scope=?8 AND a.institution=?9 AND a.created_at<=?10 AND a.expires_at>?10 AND a.checked_at_millis<=?10 AND a.verification_deadline_millis>?10 AND d.issued_at=?11";
impl D1ChatAccess {
    pub async fn require(
        &self,
        config: &Config,
        subject: &Subject,
        authorization: &Authorization,
        issued_at: u64,
    ) -> Result<()> {
        let now = js_sys::Date::now() as u64;
        subject.require_current(now)?;
        authorization.require_current(now)?;
        #[derive(serde::Deserialize)]
        struct Row {
            session_token_hash: String,
        }
        let identity = subject.identity();
        let institution = serde_json::to_value(identity.institution)
            .map_err(|_| Error::new(503, "chat_access_unavailable"))?;
        let args = [
            super::string(subject.session_hash()),
            super::string(subject.user_id()),
            super::string(subject.device_id()),
            super::string(&identity.account_id),
            wasm_bindgen::JsValue::from_f64(identity.binding_revision as f64),
            super::string(&config.registration_scope),
            super::string(&config.service_origin),
            super::string(&config.chain_scope),
            super::string(
                institution
                    .as_str()
                    .ok_or(Error::new(503, "chat_access_unavailable"))?,
            ),
            wasm_bindgen::JsValue::from_f64(now as f64),
            wasm_bindgen::JsValue::from_f64(issued_at as f64),
        ];
        let row: Option<Row> = super::first(&self.db, CURRENT_SQL, &args).await?;
        if row.is_none_or(|r| r.session_token_hash != subject.session_hash()) {
            return Err(Error::new(401, "chat_access_revoked"));
        }
        Ok(())
    }
}
