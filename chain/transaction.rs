//! finalized 区块已经由 runtime 验签；服务端逐字节解码整个签名 extrinsic 并绑定成功 phase。
use super::{
    finalized::{self, Anchor},
    identity,
    ports::Rpc,
    scale::{self, Decoded, Metadata},
};
use crate::shared::{crypto, ids, Error, Result};
use parity_scale_codec::{Compact, Decode, Encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub tx_hash: String,
    pub block_hash: String,
}
impl Confirm {
    pub fn validate(&self) -> Result<()> {
        if ids::hex(&self.tx_hash, 32, true) && ids::hex(&self.block_hash, 32, true) {
            Ok(())
        } else {
            Err(Error::new(400, "invalid_transaction_anchor"))
        }
    }
}
pub fn hash(bytes: &[u8]) -> String {
    use blake2::{digest::consts::U32, Blake2b, Digest};
    format!("0x{}", crypto::hex(&Blake2b::<U32>::digest(bytes)))
}
#[derive(Clone, Debug)]
pub struct Signed {
    pub account: String,
    pub call: Decoded,
}
pub fn decode(m: &Metadata, raw: &[u8]) -> Result<Signed> {
    decode_for(m, raw, "SquarePost")
}
/// pallet由服务端业务包装器指定，不能从HTTP请求接受；完整envelope解码规则共用。
pub fn decode_for(m: &Metadata, raw: &[u8], pallet: &str) -> Result<Signed> {
    let mut signed = decode_signed(m, raw)?;
    if scale::variant(&signed.call)? != pallet {
        return Err(Error::new(409, "transaction_action_mismatch"));
    }
    signed.call = scale::one(&signed.call)?.clone();
    Ok(signed)
}
pub fn decode_signed(m: &Metadata, raw: &[u8]) -> Result<Signed> {
    if raw.len() > 65536 {
        return Err(scale::invalid());
    }
    let mut input = raw;
    let length = Compact::<u32>::decode(&mut input).map_err(|_| scale::invalid())?;
    if length.0 as usize != input.len() || length.encode() != raw[..raw.len() - input.len()] {
        return Err(scale::invalid());
    }
    let version = u8::decode(&mut input).map_err(|_| scale::invalid())?;
    let x = m.extrinsic.as_ref().ok_or_else(scale::invalid)?;
    // 当前钱包为 v4 signed；v5 general 没有此钱包签名 envelope，不能当成同一证明。
    if version != 0x84 || !x.versions.contains(&4) {
        return Err(scale::invalid());
    }
    let address = m.prefix(&mut input, x.address)?;
    if scale::variant(&address)? != "Id" {
        return Err(scale::invalid());
    }
    let account = scale::bytes(scale::one(&address)?, 32)?;
    if account.len() != 32 {
        return Err(scale::invalid());
    }
    let signature = m.prefix(&mut input, x.signature)?;
    let size = match scale::variant(&signature)? {
        "Sr25519" | "Ed25519" => 64,
        "Ecdsa" => 65,
        _ => return Err(scale::invalid()),
    };
    if scale::bytes(scale::one(&signature)?, size)?.len() != size {
        return Err(scale::invalid());
    }
    for &ty in &x.extensions {
        m.prefix(&mut input, ty)?;
    }
    let call = m.prefix(&mut input, x.call)?;
    if !input.is_empty() {
        return Err(scale::invalid());
    }
    Ok(Signed {
        account: format!("0x{}", crypto::hex(&account)),
        call,
    })
}
/// 只允许唯一成功结果；同 phase 的失败/重复结果/未知 phase 不可确认。
pub fn successful(events: &Decoded, index: u32) -> Result<Vec<Decoded>> {
    successful_for(events, index, "SquarePost")
}
pub fn successful_for(events: &Decoded, index: u32, pallet: &str) -> Result<Vec<Decoded>> {
    let scale_value::ValueDef::Composite(records) = &events.value else {
        return Err(scale::invalid());
    };
    if records.len() > 10000 {
        return Err(scale::invalid());
    }
    let mut succeeded = 0;
    let mut business = vec![];
    for r in records.values() {
        let phase = scale::field(r, "phase")?;
        match scale::variant(phase)? {
            "ApplyExtrinsic" => {
                if scale::integer(scale::one(phase)?)? != index as u64 {
                    continue;
                }
            }
            "Initialization" | "Finalization" => continue,
            _ => return Err(scale::invalid()),
        }
        let event = scale::field(r, "event")?;
        match scale::variant(event)? {
            "System" => match scale::variant(scale::one(event)?)? {
                "ExtrinsicSuccess" => succeeded += 1,
                "ExtrinsicFailed" => return Err(Error::new(409, "transaction_failed")),
                _ => {}
            },
            name if name == pallet => business.push(scale::one(event)?.clone()),
            _ => {}
        }
    }
    if succeeded != 1 {
        return Err(Error::new(409, "transaction_success_missing"));
    }
    Ok(business)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub tx_hash: String,
    pub cid_number: String,
    pub account_id: String,
    pub block_hash: String,
    pub block_number: u64,
    pub extrinsic_index: u32,
    pub action_kind: String,
    pub request_hash: String,
    pub chain_timestamp: u64,
}
pub struct Verified {
    pub raw: Vec<u8>,
    pub anchor: Anchor,
    pub metadata: Metadata,
    pub signed: Signed,
    pub events: Vec<Decoded>,
    pub evidence: Evidence,
}
pub async fn verify<R: Rpc>(
    rpc: &R,
    genesis: &str,
    cid: &str,
    account: &str,
    request: &Confirm,
    now: u64,
) -> Result<Verified> {
    ids::cid(cid)?;
    verify_for(rpc, genesis, Some(cid), account, request, now, "SquarePost").await
}
/// 历史finalized交易证明与当前账户服务身份无关；会员包装器仍强制相同CID双向绑定。
pub async fn verify_for<R: Rpc>(
    rpc: &R,
    genesis: &str,
    cid: Option<&str>,
    account: &str,
    request: &Confirm,
    now: u64,
    pallet: &str,
) -> Result<Verified> {
    request.validate()?;
    ids::account(account)?;
    let head = finalized::head(rpc, genesis).await?;
    let anchor = finalized::canonical(rpc, &request.block_hash, &head).await?;
    let metadata = identity::metadata(rpc, &anchor).await?;
    // 区块执行用parent runtime；升级块post-state的metadata可能已更换调用/事件索引。
    let execution_anchor = Anchor {
        number: anchor.number.checked_sub(1).ok_or_else(scale::invalid)?,
        hash: anchor.parent_hash.clone(),
        parent_hash: String::new(),
    };
    let execution_metadata = identity::metadata(rpc, &execution_anchor).await?;
    let block = rpc.call("chain_getBlock", json!([anchor.hash])).await?;
    let expected_header = rpc.call("chain_getHeader", json!([anchor.hash])).await?;
    if block["block"]["header"] != expected_header {
        return Err(scale::invalid());
    }
    let extrinsics = block["block"]["extrinsics"]
        .as_array()
        .filter(|v| v.len() <= 10000)
        .ok_or_else(scale::invalid)?;
    let mut matching = None;
    for (i, e) in extrinsics.iter().enumerate() {
        let b = crypto::unhex(e.as_str().ok_or_else(scale::invalid)?)?;
        if hash(&b) == request.tx_hash {
            if matching.is_some() {
                return Err(scale::invalid());
            }
            matching = Some((i as u32, b));
        }
    }
    let (index, bytes) = matching.ok_or(Error::new(409, "transaction_not_found"))?;
    let signed = decode_for(&execution_metadata, &bytes, pallet)?;
    if signed.account != account {
        return Err(Error::new(403, "transaction_signer_mismatch"));
    }
    if let Some(cid) = cid {
        let owner = identity::by_account(rpc, &metadata, &anchor, account, genesis, now)
            .await?
            .ok_or(Error::new(403, "transaction_cid_mismatch"))?;
        owner.matches(cid, account, owner.binding_revision)?;
        owner.require_current(now)?;
    }
    let events = identity::storage(rpc, &execution_metadata, &anchor, "System", "Events", None)
        .await?
        .ok_or_else(scale::invalid)?;
    let events = successful_for(&events, index, pallet)?;
    let time = identity::storage(rpc, &metadata, &anchor, "Timestamp", "Now", None)
        .await?
        .as_ref()
        .map(scale::integer)
        .transpose()?
        .ok_or_else(scale::invalid)?;
    let action = scale::variant(&signed.call)?.to_owned();
    Ok(Verified {
        raw: bytes,
        anchor: anchor.clone(),
        metadata,
        signed,
        events,
        evidence: Evidence {
            tx_hash: request.tx_hash.clone(),
            cid_number: cid.unwrap_or("").into(),
            account_id: account.into(),
            block_hash: anchor.hash,
            block_number: anchor.number,
            extrinsic_index: index,
            action_kind: action,
            request_hash: String::new(),
            chain_timestamp: time,
        },
    })
}
