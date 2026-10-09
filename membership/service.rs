use crate::{
    chain::subscription::{self, Current},
    shared::{Error, Result},
    user::profile_service::Authorization,
};
use serde_json::{json, Value};
pub async fn current<R: super::ports::Repository>(
    repo: &R,
    auth: &Authorization,
    current: &Current,
) -> Result<Value> {
    if auth.now() < current.checked_at() || auth.now() >= current.deadline() {
        return Err(Error::new(503, "membership_verification_expired"));
    }
    let state = current.state.as_ref();
    let usage = repo
        .usage(auth, state.map(|s| s.last_charged_at).unwrap_or(0))
        .await?;
    let notice = repo.cleanup_notice(auth).await?.filter(|n| {
        state.is_some_and(|s| {
            !s.active(auth.now(), current.chain_time)
                && s.paid_until == n.lapse_at
                && usage.used_bytes > n.storage_limit_bytes
                && n.cleanup_after == n.notified_at.saturating_add(super::cleanup::NOTICE_MILLIS)
        })
    });
    let levels = [
        super::Level::Freedom,
        super::Level::Democracy,
        super::Level::Spark,
    ];
    let plans=levels.iter().zip(current.prices).map(|(l,p)|Ok(json!({"membership_level":l,"price_fen":subscription::safe_price(p)?,"plan":super::plan(*l),"limits":super::limits::limits(*l)}))).collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"ok":true,"membership":state.map(|s|s.wire()).transpose()?,"membership_active":state.is_some_and(|s|s.active(auth.now(),current.chain_time)),"plans":plans,"usage":usage,"storage_cleanup_notice":notice,"finalized_block_hash":current.anchor.hash}),
    )
}
