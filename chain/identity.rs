use crate::{
    chain::{
        finalized::Anchor,
        ports::Rpc,
        scale::{self, Decoded, Metadata},
    },
    shared::{crypto, Error, Result},
    user::{
        identity::{CidStatus, Identity, IdentityLevel},
        registration::protocol::Institution,
    },
};
use serde_json::json;
pub async fn metadata<R: Rpc>(rpc: &R, anchor: &Anchor) -> Result<Metadata> {
    let m = rpc.call("state_getMetadata", json!([anchor.hash])).await?;
    Metadata::read(&crypto::unhex(m.as_str().ok_or_else(scale::invalid)?)?)
}
pub async fn storage<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    anchor: &Anchor,
    pallet: &str,
    name: &str,
    key: Option<&[u8]>,
) -> Result<Option<Decoded>> {
    let ty = m.storage_type(pallet, name, key.is_some())?;
    let key = key
        .map(|k| scale::map_key(pallet, name, k))
        .unwrap_or_else(|| scale::value_key(pallet, name));
    let data = rpc
        .call("state_getStorage", json!([key, anchor.hash]))
        .await?;
    if data.is_null() {
        return Ok(None);
    }
    Ok(Some(m.decode(
        &crypto::unhex(data.as_str().ok_or_else(scale::invalid)?)?,
        ty,
    )?))
}
pub async fn events<R: Rpc>(rpc: &R, m: &Metadata, anchor: &Anchor) -> Result<Vec<String>> {
    let Some(v) = storage(rpc, m, anchor, "System", "Events", None).await? else {
        return if anchor.number == 0 {
            Ok(vec![])
        } else {
            Err(scale::invalid())
        };
    };
    scale::identity_events(&v)
}
/// 机构类型来自真实已占用的CID；只接入个人公民/居民，不开放机构账户。
pub fn institution(cid: &str) -> Result<Institution> {
    match cid
        .split('-')
        .nth(1)
        .filter(|s| s.len() == 5)
        .and_then(|s| s.get(..4))
    {
        Some("CTZN") => Ok(Institution::CTZN),
        Some("NATP") => Ok(Institution::NATP),
        _ => Err(Error::new(403, "unsupported_cid_institution")),
    }
}
pub async fn by_account<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    anchor: &Anchor,
    account: &str,
    genesis: &str,
    checked: u64,
) -> Result<Option<Identity>> {
    crate::shared::ids::account(account)?;
    let cid = storage(
        rpc,
        m,
        anchor,
        "CitizenIdentity",
        "CidByAccountId",
        Some(&crypto::unhex(account)?),
    )
    .await?;
    let Some(cid) = cid else {
        return Ok(None);
    };
    let identity = by_cid(rpc, m, anchor, &scale::cid(&cid)?, genesis, checked).await?;
    if let Some(i) = &identity {
        if i.status == CidStatus::Active && i.account_id != account {
            return Err(scale::invalid());
        }
    }
    Ok(identity)
}
pub async fn by_cid<R: Rpc>(
    rpc: &R,
    m: &Metadata,
    anchor: &Anchor,
    cid: &str,
    genesis: &str,
    checked: u64,
) -> Result<Option<Identity>> {
    let institution = institution(cid)?;
    let key = crypto::scale_string(cid)?;
    let Some(record) =
        storage(rpc, m, anchor, "CitizenIdentity", "CidRegistry", Some(&key)).await?
    else {
        return Ok(None);
    };
    let status = match scale::variant(scale::field(&record, "status")?)? {
        "Active" => CidStatus::Active,
        "Revoked" => CidStatus::Revoked,
        _ => return Err(scale::invalid()),
    };
    let revoked = scale::variant(scale::field(&record, "revoked_at")?)?;
    if (status == CidStatus::Active && revoked != "None")
        || (status == CidStatus::Revoked && revoked != "Some")
    {
        return Err(scale::invalid());
    }
    let account = storage(
        rpc,
        m,
        anchor,
        "CitizenIdentity",
        "AccountIdByCid",
        Some(&key),
    )
    .await?;
    let account = match account {
        Some(v) => {
            let b = scale::bytes(&v, 32)?;
            if b.len() != 32 {
                return Err(scale::invalid());
            }
            format!("0x{}", crypto::hex(&b))
        }
        None if status == CidStatus::Revoked => format!("0x{}", "00".repeat(32)),
        _ => return Err(scale::invalid()),
    };
    if status == CidStatus::Active {
        let back = storage(
            rpc,
            m,
            anchor,
            "CitizenIdentity",
            "CidByAccountId",
            Some(&crypto::unhex(&account)?),
        )
        .await?
        .ok_or_else(scale::invalid)?;
        if scale::cid(&back)? != cid {
            return Err(scale::invalid());
        }
    }
    let revision = scale::integer(
        &storage(
            rpc,
            m,
            anchor,
            "CitizenIdentity",
            "BindingRevisionByCid",
            Some(&key),
        )
        .await?
        .ok_or_else(scale::invalid)?,
    )?;
    let mut level = IdentityLevel::Visitor;
    if status == CidStatus::Active {
        if let Some(v) = storage(
            rpc,
            m,
            anchor,
            "CitizenIdentity",
            "VotingIdentityByCid",
            Some(&key),
        )
        .await?
        {
            let timestamp = storage(rpc, m, anchor, "Timestamp", "Now", None)
                .await?
                .ok_or_else(scale::invalid)?;
            let today = date_int(scale::integer(&timestamp)?);
            if scale::variant(scale::field(&v, "citizen_status")?)? == "Normal"
                && today >= scale::integer(scale::field(&v, "passport_valid_from")?)?
                && today <= scale::integer(scale::field(&v, "passport_valid_until")?)?
            {
                level = if storage(
                    rpc,
                    m,
                    anchor,
                    "CitizenIdentity",
                    "CandidateIdentityByCid",
                    Some(&key),
                )
                .await?
                .is_some()
                {
                    IdentityLevel::Candidate
                } else {
                    IdentityLevel::Voting
                };
            }
        }
    }
    let registered_block_number = scale::integer(scale::field(&record, "registered_at")?)?;
    if registered_block_number > anchor.number {
        return Err(scale::invalid());
    }
    let registered_hash = rpc
        .call("chain_getBlockHash", json!([registered_block_number]))
        .await?;
    let registered_hash = registered_hash
        .as_str()
        .ok_or_else(scale::invalid)?
        .to_owned();
    let finalized_timestamp_millis = timestamp(rpc, m, anchor).await?;
    let registered_at_millis = if registered_block_number == 0 {
        0
    } else if registered_block_number == anchor.number {
        finalized_timestamp_millis
    } else {
        let registration_anchor = crate::chain::finalized::header(rpc, &registered_hash).await?;
        if registration_anchor.number != registered_block_number {
            return Err(scale::invalid());
        }
        timestamp(
            rpc,
            &metadata(rpc, &registration_anchor).await?,
            &registration_anchor,
        )
        .await?
    };
    let identity = Identity {
        cid_number: cid.into(),
        account_id: account,
        binding_revision: revision,
        identity_level: level,
        finalized_block_number: anchor.number,
        finalized_block_hash: anchor.hash.clone(),
        status,
        institution,
        chain_scope: genesis.into(),
        registered_block_number,
        registered_block_hash: registered_hash,
        registered_at_millis,
        finalized_timestamp_millis,
        authoritative_current: true,
        checked_at_millis: checked,
        verification_deadline_millis: checked.checked_add(60_000).ok_or_else(scale::invalid)?,
    };
    identity.validate()?;
    Ok(Some(identity))
}
async fn timestamp<R: Rpc>(rpc: &R, m: &Metadata, anchor: &Anchor) -> Result<u64> {
    match storage(rpc, m, anchor, "Timestamp", "Now", None).await? {
        Some(v) => scale::integer(&v),
        None if anchor.number == 0 => Ok(0),
        _ => Err(scale::invalid()),
    }
}
// 公民身份日期采用UTC+8；算法与链civil_from_days一致，不依赖主机时区。
fn date_int(millis: u64) -> u64 {
    let z = (millis / 86_400_000
        + if millis % 86_400_000 >= 57_600_000 {
            1
        } else {
            0
        }) as i64
        + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    ((y + if m <= 2 { 1 } else { 0 }) * 10000 + m * 100 + d) as u64
}
