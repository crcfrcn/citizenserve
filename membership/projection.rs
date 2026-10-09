//! finalized 事实按整块投影；确认请求不改写链状态，也不能用较旧交易回退较新事实。
use crate::{
    chain::{
        finalized::{self, Anchor},
        identity,
        ports::Rpc,
        scale::{self, Decoded, Metadata},
        subscription::{self, Plan},
        transaction::{self, Confirm, Evidence},
    },
    shared::{crypto, Error, Result},
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TierSet {
    pub creator_cid_number: String,
    pub creator_account_id: String,
    pub tiers: Vec<super::creator::Tier>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Batch {
    pub anchor: Anchor,
    pub checked_at: u64,
    pub verification_deadline: u64,
    pub chain_time: u64,
    pub platform: Vec<Value>,
    pub creators: Vec<Value>,
    pub tiers: Vec<TierSet>,
    pub evidence: Option<Evidence>,
}
fn issuer(v: &Decoded) -> Result<Option<String>> {
    Ok(match scale::variant(v)? {
        "Platform" => None,
        "Creator" => Some(scale::cid(scale::one(v)?)?),
        _ => return Err(scale::invalid()),
    })
}
async fn row<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    a: &Anchor,
    genesis: &str,
    cid: &str,
    target: Option<&str>,
    checked: u64,
) -> Result<Value> {
    let owner = identity::by_cid(rpc, m, a, cid, genesis, checked)
        .await?
        .ok_or_else(scale::invalid)?;
    let state = subscription::at(rpc, m, a, cid, target)
        .await?
        .ok_or_else(scale::invalid)?;
    let mut value = state.wire()?;
    value["cid_number"] = json!(cid);
    value["account_id"] = json!(owner.account_id);
    if let Some(c) = target {
        let creator = identity::by_cid(rpc, m, a, c, genesis, checked)
            .await?
            .ok_or_else(scale::invalid)?;
        value["creator_cid_number"] = json!(c);
        value["creator_account_id"] = json!(creator.account_id);
    }
    Ok(value)
}
pub async fn confirm<R: Rpc>(
    rpc: &R,
    genesis: &str,
    auth: &Authorization,
    request: &Confirm,
    route: super::routes::MembershipRoute,
    target: Option<&str>,
) -> Result<Batch> {
    let mut verified = transaction::verify(
        rpc,
        genesis,
        auth.cid(),
        auth.account(),
        request,
        auth.now(),
    )
    .await?;
    let action = scale::variant(&verified.signed.call)?;
    let mut batch = Batch {
        anchor: verified.anchor.clone(),
        checked_at: auth.now(),
        verification_deadline: auth.now().saturating_add(60000),
        chain_time: verified.evidence.chain_timestamp,
        platform: vec![],
        creators: vec![],
        tiers: vec![],
        evidence: None,
    };
    use super::routes::MembershipRoute;
    if route == MembershipRoute::ConfirmPlans {
        if !matches!(action, "set_creator_plans" | "update_creator_tier_name") {
            return Err(Error::new(409, "transaction_action_mismatch"));
        }
        let expected = if action == "set_creator_plans" {
            "CreatorPlansSet"
        } else {
            "CreatorTierNameUpdated"
        };
        let event = verified
            .events
            .iter()
            .find(|e| scale::variant(e).ok() == Some(expected))
            .ok_or(Error::new(409, "transaction_event_mismatch"))?;
        if scale::cid(scale::field(event, "creator_cid_number")?)? != auth.cid() {
            return Err(scale::invalid());
        }
        if crypto::hex(&scale::bytes(
            scale::field(event, "signer_account_id")?,
            32,
        )?) != auth.account()[2..]
        {
            return Err(scale::invalid());
        }
        let tiers =
            super::creator::tiers(rpc, &verified.metadata, &verified.anchor, auth.cid()).await?;
        if action == "set_creator_plans" {
            let scale_value::ValueDef::Composite(call_tiers) =
                &scale::field(&verified.signed.call, "tiers")?.value
            else {
                return Err(scale::invalid());
            };
            if call_tiers.len() != tiers.len() {
                return Err(scale::invalid());
            }
            for (input, t) in call_tiers.values().zip(&tiers) {
                if scale::text(scale::field(input, "tier_id")?, 32)? != t.tier_id
                    || scale::text(scale::field(input, "tier_name")?, 80)? != t.tier_name
                {
                    return Err(scale::invalid());
                }
                let scale_value::ValueDef::Composite(prices) =
                    &scale::field(input, "prices_fen")?.value
                else {
                    return Err(scale::invalid());
                };
                let mut checked = BTreeSet::new();
                for p in prices.values() {
                    let period = subscription::period(scale::field(p, "billing_period")?)?;
                    if !checked.insert(period.clone()) {
                        return Err(scale::invalid());
                    }
                    let expected = match period.as_str() {
                        "monthly" => t.monthly_price_fen,
                        "quarterly" => t.quarterly_price_fen,
                        "yearly" => t.yearly_price_fen,
                        _ => None,
                    };
                    if expected
                        != Some(subscription::safe_price(scale::u128_value(scale::field(
                            p,
                            "price_fen",
                        )?)?)?)
                    {
                        return Err(scale::invalid());
                    }
                }
                if checked.len()
                    != [
                        t.monthly_price_fen,
                        t.quarterly_price_fen,
                        t.yearly_price_fen,
                    ]
                    .iter()
                    .filter(|p| p.is_some())
                    .count()
                {
                    return Err(scale::invalid());
                }
            }
        } else {
            let id = scale::text(scale::field(&verified.signed.call, "tier_id")?, 32)?;
            let n = scale::text(scale::field(&verified.signed.call, "tier_name")?, 80)?;
            if !tiers.iter().any(|t| t.tier_id == id && t.tier_name == n) {
                return Err(scale::invalid());
            }
        }
        batch.platform.push(
            row(
                rpc,
                &verified.metadata,
                &verified.anchor,
                genesis,
                auth.cid(),
                None,
                auth.now(),
            )
            .await?,
        );
        batch.tiers.push(TierSet {
            creator_cid_number: auth.cid().into(),
            creator_account_id: auth.account().into(),
            tiers,
        });
    } else {
        if !matches!(action, "subscribe" | "cancel" | "change_subscription_plan") {
            return Err(Error::new(409, "transaction_action_mismatch"));
        }
        let actual = issuer(scale::field(&verified.signed.call, "issuer")?)?;
        if actual.as_deref() != target
            || (route == MembershipRoute::Confirm && actual.is_some())
            || (route == MembershipRoute::ConfirmCreator && actual.is_none())
        {
            return Err(Error::new(409, "transaction_action_mismatch"));
        }
        if let Some(c) = target {
            super::creator::require_target(auth.cid(), c)?;
        }
        let state = subscription::at(
            rpc,
            &verified.metadata,
            &verified.anchor,
            auth.cid(),
            target,
        )
        .await?
        .ok_or_else(scale::invalid)?;
        if action == "cancel" {
            if state.status != super::Status::Cancelled {
                return Err(scale::invalid());
            }
        } else {
            let call_plan = scale::field(
                &verified.signed.call,
                if action == "subscribe" {
                    "plan"
                } else {
                    "new_plan"
                },
            )?;
            match (&state.plan, target) {
                (Plan::Platform(l), None)
                    if scale::variant(call_plan)? == "Platform"
                        && subscription::level(scale::field(call_plan, "membership_level")?)?
                            == *l => {}
                (
                    Plan::Creator {
                        tier_id,
                        billing_period,
                    },
                    Some(_),
                ) if scale::variant(call_plan)? == "Creator"
                    && scale::text(scale::field(call_plan, "tier_id")?, 32)? == *tier_id
                    && subscription::period(scale::field(call_plan, "billing_period")?)?
                        == *billing_period => {}
                _ => return Err(scale::invalid()),
            }
            if scale::u128_value(scale::field(&verified.signed.call, "expected_price_fen")?)?
                != state.authorized_price_fen
            {
                return Err(scale::invalid());
            }
        }
        let names: &[&str] = match action {
            "cancel" => &["SubscriptionCancelled"],
            "change_subscription_plan" => &["SubscriptionPlanChanged"],
            _ => &[
                "SubscriptionCharged",
                "SubscriptionResumed",
                "SubscriptionReconsented",
            ],
        };
        let mut matching = false;
        for event in &verified.events {
            if names.contains(&scale::variant(event)?)
                && scale::cid(scale::field(event, "subscriber_cid_number")?)? == auth.cid()
                && issuer(scale::field(event, "issuer")?)?.as_deref() == target
            {
                matching = true;
            }
        }
        if !matching {
            return Err(Error::new(409, "transaction_event_mismatch"));
        }
        let r = row(
            rpc,
            &verified.metadata,
            &verified.anchor,
            genesis,
            auth.cid(),
            target,
            auth.now(),
        )
        .await?;
        if target.is_some() {
            batch.creators.push(r);
        } else {
            batch.platform.push(r);
        }
    }
    // 请求哈希只包含规范链事实，不包含重试时间或客户端字段顺序。
    verified.evidence.request_hash = crypto::sha256_hex(
        &serde_json::to_vec(
            &json!({"platform":batch.platform,"creators":batch.creators,"tiers":batch.tiers}),
        )
        .map_err(|_| scale::invalid())?,
    );
    batch.evidence = Some(verified.evidence);
    Ok(batch)
}
/// 这里只恢复有界 catch-up 核心；调度器在第6步装配。一次最多十个完整区块。
pub async fn catch_up<R: Rpc, S: super::ports::Repository>(
    rpc: &R,
    repo: &S,
    genesis: &str,
    checked: u64,
    max_blocks: u8,
) -> Result<u8> {
    if max_blocks == 0 || max_blocks > 10 {
        return Err(Error::new(400, "invalid_projection_budget"));
    }
    let head = finalized::head(rpc, genesis).await?;
    let mut cursor = repo.cursor().await?;
    let mut count = 0;
    while count < max_blocks {
        let number = cursor.as_ref().map(|a| a.number + 1).unwrap_or(0);
        if number > head.number {
            break;
        }
        let hash = rpc.call("chain_getBlockHash", json!([number])).await?;
        let anchor =
            finalized::canonical(rpc, hash.as_str().ok_or_else(scale::invalid)?, &head).await?;
        if cursor
            .as_ref()
            .is_some_and(|p| anchor.parent_hash != p.hash)
        {
            return Err(scale::invalid());
        }
        let m = identity::metadata(rpc, &anchor).await?;
        let time = identity::storage(rpc, &m, &anchor, "Timestamp", "Now", None)
            .await?
            .as_ref()
            .map(scale::integer)
            .transpose()?
            .ok_or_else(scale::invalid)?;
        let events = identity::storage(rpc, &m, &anchor, "System", "Events", None)
            .await?
            .ok_or_else(scale::invalid)?;
        let scale_value::ValueDef::Composite(events) = &events.value else {
            return Err(scale::invalid());
        };
        if events.len() > 10000 {
            return Err(scale::invalid());
        }
        let mut relationships = BTreeSet::new();
        let mut creators = BTreeSet::new();
        for r in events.values() {
            let e = scale::field(r, "event")?;
            if scale::variant(e)? != "SquarePost" {
                continue;
            }
            let e = scale::one(e)?;
            match scale::variant(e)? {
                "CreatorPlansSet" | "CreatorTierNameUpdated" => {
                    creators.insert(scale::cid(scale::field(e, "creator_cid_number")?)?);
                }
                "SubscriptionCharged"
                | "SubscriptionResumed"
                | "SubscriptionSuspended"
                | "SubscriptionReconsented"
                | "SubscriptionIssuerPaused"
                | "SubscriptionTerminated"
                | "SubscriptionCancelled"
                | "SubscriptionPlanChanged" => {
                    relationships.insert((
                        scale::cid(scale::field(e, "subscriber_cid_number")?)?,
                        issuer(scale::field(e, "issuer")?)?,
                    ));
                }
                _ => {}
            }
        }
        let mut b = Batch {
            anchor: anchor.clone(),
            checked_at: checked,
            verification_deadline: checked.saturating_add(60000),
            chain_time: time,
            platform: vec![],
            creators: vec![],
            tiers: vec![],
            evidence: None,
        };
        for (cid, target) in relationships {
            let r = row(rpc, &m, &anchor, genesis, &cid, target.as_deref(), checked).await?;
            if target.is_some() {
                b.creators.push(r)
            } else {
                b.platform.push(r)
            }
        }
        for c in creators {
            if !b
                .platform
                .iter()
                .any(|r| r["cid_number"].as_str() == Some(&c))
            {
                b.platform
                    .push(row(rpc, &m, &anchor, genesis, &c, None, checked).await?);
            }
            let owner = identity::by_cid(rpc, &m, &anchor, &c, genesis, checked)
                .await?
                .ok_or_else(scale::invalid)?;
            b.tiers.push(TierSet {
                creator_cid_number: c.clone(),
                creator_account_id: owner.account_id,
                tiers: super::creator::tiers(rpc, &m, &anchor, &c).await?,
            });
        }
        repo.commit_block(cursor.as_ref(), &b).await?;
        cursor = Some(anchor);
        count += 1;
    }
    Ok(count)
}
