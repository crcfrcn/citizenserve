use crate::{chain::subscription, shared::Result, user::profile_service::Authorization};
use serde_json::{json, Value};
pub async fn current<R: super::ports::Repository>(
    repo: &R,
    auth: &Authorization,
    state: Option<&super::Record>,
    prices: [u128; 3],
    anchor: &str,
) -> Result<Value> {
    let usage = repo
        .usage(auth, state.map(|s| s.last_charged_at).unwrap_or(0))
        .await?;
    let notice = repo.cleanup_notice(auth).await?.filter(|n| {
        state.is_some_and(|s| {
            !s.active(auth.now())
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
    let plans=levels.iter().zip(prices).map(|(l,p)|Ok(json!({"membership_level":l,"price_fen":subscription::safe_price(p)?,"plan":super::limits::plan(*l),"limits":super::limits::limits(*l)}))).collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"ok":true,"membership":state.map(|s|s.wire()).transpose()?,"membership_active":state.is_some_and(|s|s.active(auth.now())),"plans":plans,"usage":usage,"storage_cleanup_notice":notice,"finalized_block_hash":anchor}),
    )
}
