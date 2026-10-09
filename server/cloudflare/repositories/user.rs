use citizenserve::{
    shared::{Error, Result},
    user::registration::{ports::Repository, protocol::Enrollment},
};
use serde::Deserialize;
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Registrations {
    pub db: D1Database,
}
fn unavailable() -> Error {
    Error::registration(503, "registration_unavailable", true, "read_status")
}
fn string(v: &str) -> JsValue {
    JsValue::from_str(v)
}
fn number(v: u64) -> JsValue {
    JsValue::from_f64(v as f64)
}
#[derive(Deserialize)]
struct Row {
    row_json: String,
}
impl D1Registrations {
    async fn lookup(&self, sql: &str, key: &str) -> Result<Option<Enrollment>> {
        let result: Option<Row> = self
            .db
            .prepare(sql)
            .bind(&[string(key)])
            .map_err(|_| unavailable())?
            .first(None)
            .await
            .map_err(|_| unavailable())?;
        result
            .map(|r| serde_json::from_str(&r.row_json).map_err(|_| unavailable()))
            .transpose()
    }
}
impl Repository for D1Registrations {
    fn create(
        &self,
        row: &Enrollment,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            let json = serde_json::to_string(row).map_err(|_| unavailable())?;
            let result = self
                .db
                .prepare(include_str!("../sql/create_registration.sql"))
                .bind(&[
                    string(&row.enrollment_id),
                    string(&row.registration_context_hash),
                    string(row.state.as_str()),
                    number(row.version),
                    number(row.created_at_millis),
                    number(row.expires_at_millis),
                    string(&row.attempt.verification_id),
                    string(&json),
                    number(now),
                ])
                .map_err(|_| unavailable())?
                .run()
                .await
                .map_err(|_| unavailable())?;
            if !result.success() {
                return Err(unavailable());
            }
            Ok(result
                .meta()
                .map_err(|_| unavailable())?
                .and_then(|m| m.changes)
                == Some(1))
        })
    }
    fn read(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Enrollment>>> + Send {
        SendFuture::new(self.lookup(
            "SELECT row_json FROM registration_enrollments WHERE enrollment_id = ?",
            id,
        ))
    }
    fn read_attempt(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Enrollment>>> + Send {
        SendFuture::new(self.lookup(
            "SELECT row_json FROM registration_enrollments WHERE verification_id = ?",
            id,
        ))
    }
    fn compare_and_swap(
        &self,
        before: &Enrollment,
        after: &Enrollment,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            if after.version != before.version + 1
                || before.enrollment_id != after.enrollment_id
                || before.registration_context_hash != after.registration_context_hash
                || before.recovery_hash != after.recovery_hash
                || before.created_at_millis != after.created_at_millis
                || before.account_id != after.account_id
                || before.institution != after.institution
                || before.registration_scope != after.registration_scope
                || before.service_origin != after.service_origin
                || before.chain_scope != after.chain_scope
            {
                return Err(unavailable());
            }
            let json = serde_json::to_string(after).map_err(|_| unavailable())?;
            let result = self
                .db
                .prepare(include_str!("../sql/cas_registration.sql"))
                .bind(&[
                    string(after.state.as_str()),
                    number(after.version),
                    number(after.expires_at_millis),
                    string(&after.attempt.verification_id),
                    string(&json),
                    string(&before.enrollment_id),
                    number(before.version),
                    string(before.state.as_str()),
                    string(&before.registration_context_hash),
                    number(now),
                ])
                .map_err(|_| unavailable())?
                .run()
                .await
                .map_err(|_| unavailable())?;
            if !result.success() {
                return Err(unavailable());
            }
            Ok(result
                .meta()
                .map_err(|_| unavailable())?
                .and_then(|m| m.changes)
                == Some(1))
        })
    }
    fn cleanup(&self, now: u64) -> impl std::future::Future<Output = Result<u64>> + Send {
        SendFuture::new(async move {
            // activated准入事实不能按24小时待登记TTL清理。
            let result = self.db.prepare("DELETE FROM registration_enrollments WHERE enrollment_id IN (SELECT enrollment_id FROM registration_enrollments WHERE state <> 'activated' AND expires_at_millis <= ? LIMIT 1000)")
                .bind(&[number(now)]).map_err(|_| unavailable())?.run().await.map_err(|_| unavailable())?;
            if !result.success() {
                return Err(unavailable());
            }
            Ok(result
                .meta()
                .map_err(|_| unavailable())?
                .and_then(|m| m.changes)
                .unwrap_or(0) as u64)
        })
    }
}
