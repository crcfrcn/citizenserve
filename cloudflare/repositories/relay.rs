use super::{external_batch, fail, first, string};
use citizenserve::{
    chain::relay::{Attempt, Repository},
    shared::{Error, Result},
};
use serde_json::json;
use worker::{send::SendFuture, D1Database};
pub struct D1Relay {
    pub db: D1Database,
}
impl Repository for D1Relay {
    fn reserve(
        &self,
        a: &Attempt,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Attempt>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"attempt":a}),
                include_str!("../sql/relay_attempt.sql"),
                Error::new(409, "chain_relay_conflict"),
            )
            .await?;
            first(
                &self.db,
                "SELECT * FROM chain_extrinsic_relays WHERE extrinsic_sha256=?1 AND active_claim=1",
                &[string(&a.extrinsic_sha256)],
            )
            .await?
            .ok_or_else(fail)
        })
    }
    fn finish(
        &self,
        a: &Attempt,
        status: &str,
        error: Option<&str>,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Attempt>> + Send {
        SendFuture::new(async move {
            if !matches!(status, "broadcast" | "failed" | "unknown") {
                return Err(fail());
            }
            external_batch(&self.db,json!({"id":a.relay_id,"sha":a.extrinsic_sha256,"hash":a.tx_hash,"status":status,"error":error}),r#"-- statement
 UPDATE chain_extrinsic_relays SET relay_status=json_extract(?1,'$.status'),error_code=json_extract(?1,'$.error'),updated_at=json_extract(?1,'$.now') WHERE relay_id=json_extract(?1,'$.id') AND extrinsic_sha256=json_extract(?1,'$.sha') AND tx_hash=json_extract(?1,'$.hash') AND relay_status='submitting' AND active_claim=1;
 -- statement
 INSERT INTO chain_extrinsic_relays(relay_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM chain_extrinsic_relays WHERE relay_id=json_extract(?1,'$.id') AND relay_status=json_extract(?1,'$.status') AND active_claim=1);
 "#,Error::new(409,"chain_relay_conflict")).await?;
            first(
                &self.db,
                "SELECT * FROM chain_extrinsic_relays WHERE relay_id=?1",
                &[string(&a.relay_id)],
            )
            .await?
            .ok_or_else(fail)
        })
    }
}
