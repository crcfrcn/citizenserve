//! 信息流只读取当前 finalized 平台权益；RPC/metadata 异常不得降级为免费用户。
use super::{
    finalized, identity,
    ports::Rpc,
    scale::{self, Decoded, Metadata},
};
use crate::shared::{crypto, ids, Error, Result};
use frame_metadata::{
    v14::{StorageEntryType, StorageHasher},
    RuntimeMetadata, RuntimeMetadataPrefixed,
};
use parity_scale_codec::Decode;
use scale_info::TypeDef;
use serde_json::json;

#[derive(Clone, Debug)]
pub struct Entitlement {
    paid_until: Option<u64>,
    checked: u64,
    chain_time: u64,
}
impl Entitlement {
    pub fn checked_at(&self) -> u64 {
        self.checked
    }
    pub fn verification_deadline(&self) -> u64 {
        self.checked.saturating_add(60_000)
    }
    pub fn paid_until(&self, now: u64) -> Result<Option<u64>> {
        if now < self.checked || now - self.checked >= 60_000 {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        Ok(self
            .paid_until
            .filter(|end| *end > now.max(self.chain_time)))
    }
}
fn platform_key(raw: &[u8], m: &Metadata, cid: &str) -> Result<Vec<u8>> {
    let mut input = raw;
    let metadata = RuntimeMetadataPrefixed::decode(&mut input).map_err(|_| scale::invalid())?;
    macro_rules! find {
        ($meta:expr) => {{
            let mut key = None;
            for p in $meta.pallets {
                if let Some(s) = p.storage {
                    if s.prefix == "SquarePost" {
                        for e in s.entries {
                            if e.name == "Subscriptions" {
                                if let StorageEntryType::Map {
                                    hashers, key: k, ..
                                } = e.ty
                                {
                                    if hashers == [StorageHasher::Blake2_128Concat] {
                                        key = Some(k.id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            key
        }};
    }
    let ty = match metadata.1 {
        RuntimeMetadata::V14(x) => find!(x),
        RuntimeMetadata::V15(x) => find!(x),
        RuntimeMetadata::V16(x) => find!(x),
        _ => None,
    }
    .ok_or_else(scale::invalid)?;
    let TypeDef::Tuple(tuple) = &m.types.resolve(ty).ok_or_else(scale::invalid)?.type_def else {
        return Err(scale::invalid());
    };
    if tuple.fields.len() != 2 {
        return Err(scale::invalid());
    }
    let TypeDef::Variant(issuer) = &m
        .types
        .resolve(tuple.fields[1].id)
        .ok_or_else(scale::invalid)?
        .type_def
    else {
        return Err(scale::invalid());
    };
    let variant = issuer
        .variants
        .iter()
        .find(|v| v.name == "Platform" && v.fields.is_empty())
        .ok_or_else(scale::invalid)?;
    let mut key = crypto::scale_string(cid)?;
    key.push(variant.index);
    let decoded = m.decode(&key, ty)?;
    let scale_value::ValueDef::Composite(parts) = &decoded.value else {
        return Err(scale::invalid());
    };
    let values: Vec<_> = parts.values().collect();
    if values.len() != 2
        || scale::cid(values[0])? != cid
        || scale::variant(values[1])? != "Platform"
    {
        return Err(scale::invalid());
    }
    Ok(key)
}
pub fn decode(value: &Decoded) -> Result<Option<u64>> {
    let plan = scale::field(value, "plan")?;
    if scale::variant(plan)? != "Platform"
        || !matches!(
            scale::variant(scale::field(plan, "membership_level")?)?,
            "Freedom" | "Democracy" | "Spark"
        )
    {
        return Err(scale::invalid());
    }
    let started = scale::integer(scale::field(value, "started_at")?)?;
    let charged = scale::integer(scale::field(value, "last_charged_at")?)?;
    let end = scale::integer(scale::field(value, "paid_until")?)?;
    if started > charged || charged > end {
        return Err(scale::invalid());
    }
    for field in ["last_charged_price_fen", "authorized_price_fen"] {
        if scale::field(value, field)?.as_u128().is_none() {
            return Err(scale::invalid());
        }
    }
    let status = scale::variant(scale::field(value, "subscription_status")?)?;
    if !matches!(
        status,
        "Active" | "Cancelled" | "Terminated" | "Suspended" | "IssuerPaused"
    ) {
        return Err(scale::invalid());
    }
    let reason = scale::field(value, "suspend_reason")?;
    match (status, &reason.value) {
        ("Suspended", scale_value::ValueDef::Variant(v))
            if v.name == "Some" && v.values.len() == 1 =>
        {
            let r = v.values.values().next().ok_or_else(scale::invalid)?;
            if !matches!(
                scale::variant(r)?,
                "NeedReconsent" | "InsufficientBalance" | "IdentityBindingUnavailable"
            ) {
                return Err(scale::invalid());
            }
        }
        (_, scale_value::ValueDef::Variant(v))
            if status != "Suspended" && v.name == "None" && v.values.is_empty() => {}
        _ => return Err(scale::invalid()),
    }
    Ok(matches!(status, "Active" | "Cancelled").then_some(end))
}
pub async fn current<R: Rpc>(
    rpc: &R,
    genesis: &str,
    cid: &str,
    checked: u64,
) -> Result<Entitlement> {
    ids::cid(cid)?;
    let head = finalized::head(rpc, genesis).await?;
    let raw = rpc.call("state_getMetadata", json!([head.hash])).await?;
    let raw = crypto::unhex(raw.as_str().ok_or_else(scale::invalid)?)?;
    let metadata = Metadata::read(&raw)?;
    let key = platform_key(&raw, &metadata, cid)?;
    let value = identity::storage(
        rpc,
        &metadata,
        &head,
        "SquarePost",
        "Subscriptions",
        Some(&key),
    )
    .await?;
    let paid_until = value.as_ref().map(decode).transpose()?.flatten();
    let chain_time = identity::storage(rpc, &metadata, &head, "Timestamp", "Now", None)
        .await?
        .as_ref()
        .map(scale::integer)
        .transpose()?
        .ok_or_else(scale::invalid)?;
    Ok(Entitlement {
        paid_until,
        checked,
        chain_time,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Platform(crate::membership::Level),
    Creator {
        tier_id: String,
        billing_period: String,
    },
}
#[derive(Clone, Debug)]
pub struct State {
    pub plan: Plan,
    pub status: crate::membership::Status,
    pub started_at: u64,
    pub last_charged_at: u64,
    pub paid_until: u64,
    pub last_charged_price_fen: u128,
    pub authorized_price_fen: u128,
}
impl State {
    pub fn active(&self, now: u64, chain_time: u64) -> bool {
        matches!(
            self.status,
            crate::membership::Status::Active | crate::membership::Status::Cancelled
        ) && self.paid_until > now.max(chain_time)
    }
    /// D1/HTTP 沿用安全整数合同，内部完整 u128 不能先转浮点或截断。
    pub fn wire(&self) -> Result<serde_json::Value> {
        let (level, tier, period) = match &self.plan {
            Plan::Platform(l) => (Some(*l), None, None),
            Plan::Creator {
                tier_id,
                billing_period,
            } => (None, Some(tier_id), Some(billing_period)),
        };
        Ok(
            json!({"membership_level":level,"tier_id":tier,"billing_period":period,"subscription_status":self.status,"started_at":self.started_at,"last_charged_at":self.last_charged_at,"paid_until":self.paid_until,"last_charged_price_fen":safe_price(self.last_charged_price_fen)?,"authorized_price_fen":safe_price(self.authorized_price_fen)?}),
        )
    }
}
pub fn safe_price(n: u128) -> Result<u64> {
    u64::try_from(n)
        .ok()
        .filter(|n| *n <= crate::shared::MAX_SAFE_INTEGER)
        .ok_or(Error::new(503, "chain_price_out_of_range"))
}
pub fn period(v: &Decoded) -> Result<String> {
    Ok(match scale::variant(v)? {
        "Monthly" => "monthly",
        "Quarterly" => "quarterly",
        "Yearly" => "yearly",
        _ => return Err(scale::invalid()),
    }
    .into())
}
pub fn level(v: &Decoded) -> Result<crate::membership::Level> {
    use crate::membership::Level;
    Ok(match scale::variant(v)? {
        "Freedom" => Level::Freedom,
        "Democracy" => Level::Democracy,
        "Spark" => Level::Spark,
        _ => return Err(scale::invalid()),
    })
}
pub fn state(v: &Decoded) -> Result<State> {
    let p = scale::field(v, "plan")?;
    let plan = match scale::variant(p)? {
        "Platform" => Plan::Platform(level(scale::field(p, "membership_level")?)?),
        "Creator" => Plan::Creator {
            tier_id: scale::text(scale::field(p, "tier_id")?, 32)?,
            billing_period: period(scale::field(p, "billing_period")?)?,
        },
        _ => return Err(scale::invalid()),
    };
    let started_at = scale::integer(scale::field(v, "started_at")?)?;
    let last_charged_at = scale::integer(scale::field(v, "last_charged_at")?)?;
    let paid_until = scale::integer(scale::field(v, "paid_until")?)?;
    if started_at > last_charged_at || last_charged_at > paid_until {
        return Err(scale::invalid());
    }
    use crate::membership::Status;
    let status = match scale::variant(scale::field(v, "subscription_status")?)? {
        "Active" => Status::Active,
        "Cancelled" => Status::Cancelled,
        "Terminated" => Status::Terminated,
        "Suspended" => Status::Suspended,
        "IssuerPaused" => Status::IssuerPaused,
        _ => return Err(scale::invalid()),
    };
    let reason = scale::field(v, "suspend_reason")?;
    if status == Status::Suspended {
        if scale::variant(reason)? != "Some"
            || !matches!(
                scale::variant(scale::one(reason)?)?,
                "NeedReconsent" | "InsufficientBalance" | "IdentityBindingUnavailable"
            )
        {
            return Err(scale::invalid());
        }
    } else if scale::variant(reason)? != "None" {
        return Err(scale::invalid());
    }
    Ok(State {
        plan,
        status,
        started_at,
        last_charged_at,
        paid_until,
        last_charged_price_fen: scale::u128_value(scale::field(v, "last_charged_price_fen")?)?,
        authorized_price_fen: scale::u128_value(scale::field(v, "authorized_price_fen")?)?,
    })
}
fn enum_index(m: &Metadata, ty: u32, name: &str) -> Result<u8> {
    let TypeDef::Variant(v) = &m.types.resolve(ty).ok_or_else(scale::invalid)?.type_def else {
        return Err(scale::invalid());
    };
    v.variants
        .iter()
        .find(|v| v.name == name)
        .map(|v| v.index)
        .ok_or_else(scale::invalid)
}
pub fn key(m: &Metadata, cid: &str, creator: Option<&str>) -> Result<Vec<u8>> {
    ids::cid(cid)?;
    let (ty, _, _) = m.map_types("SquarePost", "Subscriptions")?;
    let TypeDef::Tuple(t) = &m.types.resolve(ty).ok_or_else(scale::invalid)?.type_def else {
        return Err(scale::invalid());
    };
    if t.fields.len() != 2 {
        return Err(scale::invalid());
    }
    let mut out = crypto::scale_string(cid)?;
    out.push(enum_index(
        m,
        t.fields[1].id,
        if creator.is_some() {
            "Creator"
        } else {
            "Platform"
        },
    )?);
    if let Some(c) = creator {
        ids::cid(c)?;
        out.extend(crypto::scale_string(c)?);
    }
    m.decode(&out, ty)?;
    Ok(out)
}
pub async fn at<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    anchor: &finalized::Anchor,
    cid: &str,
    creator: Option<&str>,
) -> Result<Option<State>> {
    let k = key(m, cid, creator)?;
    let value = identity::storage(rpc, m, anchor, "SquarePost", "Subscriptions", Some(&k)).await?;
    let result = value.as_ref().map(state).transpose()?;
    if result.as_ref().is_some_and(|s| {
        !matches!(
            (&s.plan, creator),
            (Plan::Platform(_), None) | (Plan::Creator { .. }, Some(_))
        )
    }) {
        return Err(scale::invalid());
    }
    Ok(result)
}
pub async fn price<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    anchor: &finalized::Anchor,
    level_name: &str,
) -> Result<u128> {
    let (ty, _, _) = m.map_types("SquarePost", "PlatformPrice")?;
    let b = vec![enum_index(m, ty, level_name)?];
    let (key, ty) = m.storage_key("SquarePost", "PlatformPrice", &[b])?;
    let raw = rpc
        .call("state_getStorage", json!([key, anchor.hash]))
        .await?;
    let raw = crypto::unhex(raw.as_str().ok_or_else(scale::invalid)?)?;
    scale::u128_value(&m.decode(&raw, ty)?)
}
/// 本对象只能通过当前 finalized 读取构造，历史投影不能伪造当前付费许可。
pub struct Current {
    pub anchor: finalized::Anchor,
    pub state: Option<State>,
    pub prices: [u128; 3],
    checked: u64,
    pub chain_time: u64,
}
impl Current {
    pub fn checked_at(&self) -> u64 {
        self.checked
    }
    pub fn deadline(&self) -> u64 {
        self.checked.saturating_add(60000)
    }
    pub fn require(&self, now: u64) -> Result<&State> {
        if now < self.checked || now >= self.deadline() {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        self.state
            .as_ref()
            .filter(|s| s.active(now, self.chain_time))
            .ok_or(Error::new(403, "membership_required"))
    }
    pub fn level(&self, now: u64) -> Result<crate::membership::Level> {
        match self.require(now)?.plan {
            Plan::Platform(l) => Ok(l),
            _ => Err(scale::invalid()),
        }
    }
}
pub async fn platform<R: Rpc>(
    rpc: &R,
    genesis: &str,
    cid: &str,
    account: &str,
    checked: u64,
) -> Result<Current> {
    let anchor = finalized::head(rpc, genesis).await?;
    let m = identity::metadata(rpc, &anchor).await?;
    let owner = identity::by_cid(rpc, &m, &anchor, cid, genesis, checked)
        .await?
        .ok_or(Error::new(403, "cid_not_active"))?;
    owner.matches(cid, account, owner.binding_revision)?;
    owner.require_current(checked)?;
    let state = at(rpc, &m, &anchor, cid, None).await?;
    let chain_time = identity::storage(rpc, &m, &anchor, "Timestamp", "Now", None)
        .await?
        .as_ref()
        .map(scale::integer)
        .transpose()?
        .ok_or_else(scale::invalid)?;
    let prices = [
        price(rpc, &m, &anchor, "Freedom").await?,
        price(rpc, &m, &anchor, "Democracy").await?,
        price(rpc, &m, &anchor, "Spark").await?,
    ];
    Ok(Current {
        anchor,
        state,
        prices,
        checked,
        chain_time,
    })
}
