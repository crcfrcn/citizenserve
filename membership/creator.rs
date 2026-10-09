//! 档位名与价格分别从同一个 finalized 锚点取回；最多十档，不默默忽略缺失名称。
use crate::{
    chain::{
        finalized::Anchor,
        identity,
        ports::Rpc,
        scale::{self, Metadata},
        subscription,
    },
    shared::{crypto, ids, Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tier {
    pub tier_id: String,
    pub tier_name: String,
    pub tier_order: u32,
    pub monthly_price_fen: Option<u64>,
    pub quarterly_price_fen: Option<u64>,
    pub yearly_price_fen: Option<u64>,
}
pub fn name(s: &str) -> Result<()> {
    if s.is_empty() || s.chars().count() > 20 || s.len() > 80 || s.trim() != s {
        Err(scale::invalid())
    } else {
        Ok(())
    }
}
pub async fn tiers<R: Rpc>(rpc: &R, m: &Metadata, a: &Anchor, cid: &str) -> Result<Vec<Tier>> {
    ids::cid(cid)?;
    let value = identity::storage(
        rpc,
        m,
        a,
        "SquarePost",
        "CreatorPlans",
        Some(&crypto::scale_string(cid)?),
    )
    .await?;
    let Some(v) = value else { return Ok(vec![]) };
    let scale_value::ValueDef::Composite(items) = &v.value else {
        return Err(scale::invalid());
    };
    if items.len() > 10 {
        return Err(scale::invalid());
    }
    let mut out = vec![];
    for (order, item) in items.values().enumerate() {
        let tier_id = scale::text(scale::field(item, "tier_id")?, 32)?;
        if tier_id.is_empty() || out.iter().any(|t: &Tier| t.tier_id == tier_id) {
            return Err(scale::invalid());
        }
        let (key, ty) = m.storage_key(
            "SquarePost",
            "CreatorTierNames",
            &[crypto::scale_string(cid)?, crypto::scale_string(&tier_id)?],
        )?;
        let raw = rpc.call("state_getStorage", json!([key, a.hash])).await?;
        let decoded = m.decode(
            &crypto::unhex(raw.as_str().ok_or_else(scale::invalid)?)?,
            ty,
        )?;
        let tier_name = scale::text(&decoded, 80)?;
        name(&tier_name)?;
        let scale_value::ValueDef::Composite(prices) = &scale::field(item, "prices_fen")?.value
        else {
            return Err(scale::invalid());
        };
        if prices.is_empty() || prices.len() > 3 {
            return Err(scale::invalid());
        }
        let mut t = Tier {
            tier_id,
            tier_name,
            tier_order: order as u32,
            monthly_price_fen: None,
            quarterly_price_fen: None,
            yearly_price_fen: None,
        };
        for p in prices.values() {
            let price =
                subscription::safe_price(scale::u128_value(scale::field(p, "price_fen")?)?)?;
            if price == 0 {
                return Err(scale::invalid());
            }
            let field = match subscription::period(scale::field(p, "billing_period")?)?.as_str() {
                "monthly" => &mut t.monthly_price_fen,
                "quarterly" => &mut t.quarterly_price_fen,
                "yearly" => &mut t.yearly_price_fen,
                _ => return Err(scale::invalid()),
            };
            if field.replace(price).is_some() {
                return Err(scale::invalid());
            }
        }
        out.push(t);
    }
    Ok(out)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Overview {
    pub subscriber_count: u64,
    pub monthly_income_fen: u64,
    pub tier_count: u64,
}
pub fn require_target(cid: &str, target: &str) -> Result<()> {
    ids::cid(target)?;
    if cid == target {
        Err(Error::new(400, "cannot_subscribe_self"))
    } else {
        Ok(())
    }
}
