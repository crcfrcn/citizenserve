pub mod auth;
pub mod chat_access;
pub mod contacts;
pub mod deletion;
pub mod downloads;
pub mod identity;
pub mod media;
pub mod membership;
pub mod notifications;
pub mod posts;
pub mod profiles;
pub mod relay;
pub mod square;
pub mod topup;
pub mod uploads;
pub mod user;
use citizenserve::shared::{Error, Result};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::D1Database;
pub(crate) fn fail() -> Error {
    Error::new(503, "community_storage_unavailable")
}
// 固定断言失败强制回滚整批。不要把身份核验移到 batch 之外。
pub(crate) const AUTH_ASSERT: &str = r#"
INSERT INTO cid_admissions(cid_number,source,institution,registration_scope,service_origin,chain_scope,human_verified_at_millis,enrollment_id)
SELECT NULL,'turnstile','CTZN','','','',1,''
WHERE NOT EXISTS(SELECT 1 FROM authorized_business_sessions a
 WHERE a.session_token_hash=json_extract(?1,'$.auth.session_token_hash') AND a.cid_number=json_extract(?1,'$.auth.cid_number')
 AND a.account_id=json_extract(?1,'$.auth.account_id') AND a.binding_revision=json_extract(?1,'$.auth.binding_revision')
 AND a.device_id=json_extract(?1,'$.auth.device_id') AND a.registration_scope=json_extract(?1,'$.auth.registration_scope')
 AND a.service_origin=json_extract(?1,'$.auth.service_origin') AND a.chain_scope=json_extract(?1,'$.auth.chain_scope')
 AND a.institution=json_extract(?1,'$.auth.institution') AND a.created_at<=json_extract(?1,'$.auth.now')
 AND a.expires_at>json_extract(?1,'$.auth.now') AND a.checked_at_millis<=json_extract(?1,'$.auth.now')
 AND a.verification_deadline_millis>json_extract(?1,'$.auth.now')
 AND NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.cid_number=a.cid_number AND x.state='pending'));
"#;
pub(crate) async fn first<T: DeserializeOwned>(
    db: &D1Database,
    sql: &str,
    args: &[JsValue],
) -> Result<Option<T>> {
    db.prepare(sql)
        .bind(args)
        .map_err(|_| fail())?
        .first(None)
        .await
        .map_err(|_| fail())
}
pub(crate) async fn all<T: DeserializeOwned>(
    db: &D1Database,
    sql: &str,
    args: &[JsValue],
) -> Result<Vec<T>> {
    let r = db
        .prepare(sql)
        .bind(args)
        .map_err(|_| fail())?
        .all()
        .await
        .map_err(|_| fail())?;
    if !r.success() {
        return Err(fail());
    }
    r.results().map_err(|_| fail())
}
pub(crate) async fn batch(
    db: &D1Database,
    mut command: Value,
    sql: &str,
    conflict: Error,
) -> Result<Vec<worker::D1Result>> {
    // now 使用提交事务的服务器时间，避免等待 RPC/查询后以旧时间授权写入。
    command["auth"]["now"] = json!(js_sys::Date::now() as u64);
    let raw = JsValue::from_str(&serde_json::to_string(&command).map_err(|_| fail())?);
    let statements = std::iter::once(AUTH_ASSERT)
        .chain(sql.split("-- statement").skip(1))
        .map(|s| db.prepare(s).bind(std::slice::from_ref(&raw)))
        .collect::<worker::Result<Vec<_>>>()
        .map_err(|_| fail())?;
    let results = db.batch(statements).await.map_err(|e| match &e {
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: cid_admissions.cid_number") =>
        {
            Error::new(401, "invalid_session")
        }
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: contact_mls_groups.group_revision") =>
        {
            conflict
        }
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: square_browse_days.browse_count") =>
        {
            if conflict.code == "contact_mls_conflict" {
                Error::new(429, "contact_mls_queue_full")
            } else {
                conflict
            }
        }
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: user_profiles.display_name") =>
        {
            Error::new(503, "membership_verification_expired")
        }
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: rate_windows.request_count") =>
        {
            Error::new(429, "upload_rate_exceeded")
        }
        worker::Error::D1(c)
            if c.cause()
                .contains("NOT NULL constraint failed: square_uploads.upload_id")
                || c.cause()
                    .contains("NOT NULL constraint failed: profile_asset_uploads.upload_id") =>
        {
            conflict
        }
        _ => fail(),
    })?;
    if results.iter().any(|r| !r.success()) {
        return Err(fail());
    }
    Ok(results)
}
pub(crate) fn string(v: &str) -> JsValue {
    JsValue::from_str(v)
}
/// 非账户权限事务独立装配，不能将资金/发布凭据塞进AUTH_ASSERT。
pub(crate) async fn external_batch(
    db: &D1Database,
    mut command: Value,
    sql: &str,
    conflict: Error,
) -> Result<()> {
    command["now"] = json!(js_sys::Date::now() as u64);
    let raw = string(&command.to_string());
    let s = sql
        .split("-- statement")
        .skip(1)
        .map(|s| db.prepare(s).bind(std::slice::from_ref(&raw)))
        .collect::<worker::Result<Vec<_>>>()
        .map_err(|_| fail())?;
    let results = db.batch(s).await.map_err(|e| match &e {
        worker::Error::D1(c) if c.cause().contains("rate_windows.request_count") => {
            Error::new(429, "external_rate_limited")
        }
        worker::Error::D1(c)
            if c.cause().contains("topup_orders.order_id")
                || c.cause().contains("topup_orders.gmb_tx_hash")
                || c.cause()
                    .contains("citizenchain_download_publications.platform")
                || c.cause().contains("chain_extrinsic_relays.relay_id") =>
        {
            conflict
        }
        _ => fail(),
    })?;
    if results.iter().any(|r| !r.success()) {
        return Err(fail());
    }
    Ok(())
}

pub mod maintenance;
pub mod notification_jobs;
pub mod push_endpoints;
