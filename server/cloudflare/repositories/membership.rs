use super::{all, batch, fail, first, string};
use citizenserve::{
    chain::{finalized::Anchor, subscription::Current},
    membership::{
        creator::Overview,
        ports::{Repository, Usage},
        projection::Batch,
    },
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use worker::{send::SendFuture, D1Database};
pub struct D1Membership {
    pub db: D1Database,
}
const PROJECT: &str = include_str!("../sql/project_subscription.sql");
impl Repository for D1Membership {
    fn cleanup_notice(
        &self,
        auth: &Authorization,
    ) -> impl std::future::Future<Output = Result<Option<citizenserve::membership::cleanup::Notice>>>
           + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT storage_cleanup_lapse_at lapse_at,storage_cleanup_notified_at notified_at,storage_cleanup_notified_at+86400000 cleanup_after,100000000000 storage_limit_bytes FROM square_memberships WHERE cid_number=?1 AND storage_cleanup_lapse_at IS NOT NULL AND storage_cleanup_notified_at IS NOT NULL",&[string(auth.cid())]).await
        })
    }

    fn usage(
        &self,
        auth: &Authorization,
        start: u64,
    ) -> impl std::future::Future<Output = Result<Usage>> + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT COALESCE((SELECT byte_size FROM resource_totals WHERE cid_number=?1 AND resource_key='square_storage'),0) used_bytes,COALESCE(SUM(byte_size),0) reserved_bytes,COALESCE((SELECT image_count FROM resource_usage WHERE cid_number=?1 AND resource_key='square_upload' AND period_start=?2),0) used_images,COALESCE(SUM(CASE WHEN period_start=?2 THEN image_count ELSE 0 END),0) reserved_images,COALESCE((SELECT video_seconds FROM resource_usage WHERE cid_number=?1 AND resource_key='square_upload' AND period_start=?2),0) used_video_seconds,COALESCE(SUM(CASE WHEN period_start=?2 THEN video_seconds ELSE 0 END),0) reserved_video_seconds,COUNT(*) active_uploads FROM resource_reservations WHERE cid_number=?1 AND resource_key='square_upload' AND reservation_state='reserved' AND expires_at>?3",&[string(auth.cid()),JsValue::from_f64(start as f64),JsValue::from_f64(auth.now() as f64)]).await?.ok_or_else(fail)
        })
    }
    fn project(
        &self,
        auth: &Authorization,
        projection: &Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"projection":projection}),
                PROJECT,
                Error::new(409, "subscription_confirmation_conflict"),
            )
            .await?;
            Ok(())
        })
    }
    fn overview(
        &self,
        auth: &Authorization,
        current: &Current,
    ) -> impl std::future::Future<Output = Result<Overview>> + Send {
        SendFuture::new(async move {
            current.require(js_sys::Date::now() as u64)?;
            let rows:Vec<Value>=all(&self.db,"SELECT s.tier_id,s.billing_period,s.last_charged_price_fen FROM square_creator_subscriptions s WHERE s.creator_cid_number=?1 AND s.subscription_status IN ('active','cancelled') AND s.paid_until>?2 LIMIT 100001",&[string(auth.cid()),JsValue::from_f64(auth.now().max(current.chain_time) as f64)]).await?;
            if rows.len() > 100000 {
                return Err(Error::new(503, "creator_overview_unavailable"));
            }
            let mut monthly = 0u128;
            for r in &rows {
                let p = r["last_charged_price_fen"].as_u64().ok_or_else(fail)? as u128;
                let n = match r["billing_period"].as_str() {
                    Some("monthly") => 1,
                    Some("quarterly") => 3,
                    Some("yearly") => 12,
                    _ => return Err(fail()),
                };
                monthly = monthly.checked_add(p / n).ok_or_else(fail)?;
            }
            let count: Option<Value> = first(
                &self.db,
                "SELECT COUNT(*) n FROM square_creator_tiers WHERE creator_cid_number=?1",
                &[string(auth.cid())],
            )
            .await?;
            Ok(Overview {
                subscriber_count: rows.len() as u64,
                monthly_income_fen: citizenserve::chain::subscription::safe_price(monthly)?,
                tier_count: count.and_then(|r| r["n"].as_u64()).ok_or_else(fail)?,
            })
        })
    }
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send {
        SendFuture::new(async move {
            first(&self.db,"SELECT finalized_block_number number,finalized_block_hash hash,'' parent_hash FROM membership_projection_cursor WHERE cursor_id=1",&[]).await
        })
    }
    fn commit_block(
        &self,
        expected: Option<&Anchor>,
        projection: &Batch,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let command = json!({"auth":{"now":js_sys::Date::now() as u64},"background":true,"expected":expected,"projection":projection});
            let raw = string(&command.to_string());
            let queries = PROJECT
                .split("-- statement")
                .skip(1)
                .map(|s| self.db.prepare(s).bind(std::slice::from_ref(&raw)))
                .collect::<worker::Result<Vec<_>>>()
                .map_err(|_| fail())?;
            let results = self
                .db
                .batch(queries)
                .await
                .map_err(|_| Error::new(409, "membership_projection_conflict"))?;
            if results.iter().any(|r| !r.success()) {
                return Err(fail());
            }
            Ok(())
        })
    }
}
