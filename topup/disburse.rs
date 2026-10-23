//! 签名在真实metadata与finalized账户上下文中构造；保存完整字节后才允许广播。
use super::{
    account::{self, Account},
    config::Config,
    orders::{Order, Phase, Signed},
    ports::{Clock, Repository},
};
use crate::{
    chain::{
        finalized, identity,
        network_ports::{BroadcastOutcome, Broadcaster},
        ports::Rpc,
        scale::{self, Metadata},
        transaction,
    },
    shared::{crypto, Error, Result},
};
use parity_scale_codec::{Compact, Encode};
use scale_value::Value;
use serde_json::json;
fn encode(m: &Metadata, ty: u32, v: Value) -> Result<Vec<u8>> {
    let mut b = vec![];
    scale_value::scale::encode_as_type(&v, ty, &m.types, &mut b).map_err(|_| scale::invalid())?;
    m.decode(&b, ty)?;
    Ok(b)
}
/// 原生v4、sr25519、零tip、immortal；所有索引和扩展类型来自真实metadata。
#[allow(clippy::too_many_arguments)] // 显式保留独立metadata、签名域与订单输入，不引入包装上下文。
pub fn build(
    m: &Metadata,
    key: &Account,
    genesis: &str,
    spec: u32,
    version: u32,
    nonce: u32,
    o: &Order,
    claim: &str,
    born: u64,
) -> Result<Signed> {
    let x = m
        .extrinsic
        .as_ref()
        .filter(|x| x.versions.contains(&4))
        .ok_or_else(scale::invalid)?;
    let call = Value::unnamed_variant(
        "OnchainTransaction",
        [Value::named_variant(
            "transfer_with_remark",
            [
                (
                    "beneficiary_account_id",
                    Value::from_bytes(crypto::unhex(&o.intent.account_id)?),
                ),
                (
                    "amount",
                    Value::u128(o.intent.coin_fen.parse().map_err(|_| scale::invalid())?),
                ),
                (
                    "remark",
                    Value::from_bytes(format!("topup:{}", o.order_id).as_bytes()),
                ),
            ],
        )],
    );
    let call = encode(m, x.call, call)?;
    let mut extra = vec![];
    let mut implicit = vec![];
    if x.extensions.len() != x.identifiers.len() || x.extensions.len() != x.implicits.len() {
        return Err(scale::invalid());
    }
    let mut seen = std::collections::BTreeSet::new();
    for ((name, ty), ity) in x.identifiers.iter().zip(&x.extensions).zip(&x.implicits) {
        if !seen.insert(name) {
            return Err(scale::invalid());
        }
        let (e, i) = match name.as_str() {
            "CheckSpecVersion" => (vec![], spec.encode()),
            "CheckTxVersion" => (vec![], version.encode()),
            "CheckGenesis" => (vec![], crypto::unhex(genesis)?),
            "CheckMortality" | "CheckEra" => (vec![0], crypto::unhex(genesis)?),
            "CheckNonce" => (Compact(nonce).encode(), vec![]),
            "ChargeTransactionPayment" => (Compact(0u128).encode(), vec![]),
            "CheckMetadataHash" => (vec![0], vec![0]),
            "AuthorizeCall"
            | "CheckNonZeroSender"
            | "CheckNonStakeSender"
            | "CheckWeight"
            | "SetOrigin"
            | "WeightReclaim" => (vec![], vec![]),
            _ => return Err(Error::new(503, "topup_runtime_extension_unsupported")),
        };
        m.decode(&e, *ty)?;
        m.decode(&i, *ity)?;
        extra.extend(e);
        implicit.extend(i);
    }
    // 必须有nonce，未知runtime不得静默采用空签名扩展。
    if !seen.contains(&"CheckNonce".to_owned()) {
        return Err(scale::invalid());
    }
    let mut payload = call.clone();
    payload.extend(&extra);
    payload.extend(implicit);
    let signing = if payload.len() > 256 {
        crypto::unhex(&transaction::hash(&payload))?
    } else {
        payload
    };
    let sig = key.sign(&signing);
    let mut body = vec![0x84];
    body.extend(encode(
        m,
        x.address,
        Value::unnamed_variant("Id", [Value::from_bytes(key.public())]),
    )?);
    body.extend(encode(
        m,
        x.signature,
        Value::unnamed_variant("Sr25519", [Value::from_bytes(sig)]),
    )?);
    body.extend(extra);
    body.extend(call);
    let mut raw = Compact(u32::try_from(body.len()).map_err(|_| scale::invalid())?).encode();
    raw.extend(body);
    let decoded = transaction::decode_for(m, &raw, "OnchainTransaction")?;
    if decoded.account != key.id() || scale::variant(&decoded.call)? != "transfer_with_remark" {
        return Err(scale::invalid());
    }
    Ok(Signed {
        account_id: key.id(),
        nonce: nonce.into(),
        extrinsic: format!("0x{}", crypto::hex(&raw)),
        tx_hash: transaction::hash(&raw),
        born,
        claim: claim.into(),
    })
}
/// 每次只处理有限finalized块，重试从持久游标继续；广播未知永不重签。
pub async fn run<R: Repository, S: Rpc + Broadcaster, C: Clock>(
    repo: &R,
    chain: &S,
    clock: &C,
    c: &Config,
    key: Option<&Account>,
    id: &str,
    claim: &str,
) -> Result<bool> {
    let Some(mut o) = repo.by_id(id).await? else {
        return Ok(true);
    };
    if matches!(o.phase, Phase::Awaiting | Phase::Paid | Phase::Exception) {
        if (o.phase == Phase::Paid
            || o.exception_reason.as_deref() == Some("topup_gmb_finalized_failed"))
            && o.signed.is_some()
        {
            let s = o.signed.as_ref().ok_or_else(scale::invalid)?;
            repo.unlock(&o.order_id, &s.account_id, &s.claim).await?;
        }
        return Ok(true);
    }
    if o.signed.is_none() {
        let key = key.ok_or_else(super::config::unconfigured)?;
        if o.phase != Phase::Received {
            return Err(Error::new(409, "topup_payment_not_final"));
        }
        o.payment
            .as_ref()
            .ok_or_else(scale::invalid)?
            .require_fresh(clock.now())?;
        if !repo.lock(&o, &key.id(), claim, clock.now()).await? {
            return Ok(false);
        }
        let a = finalized::head(chain, &c.chain_genesis_hash).await?;
        let m = identity::metadata(chain, &a).await?;
        let balance = account::balance(chain, &m, &a, &key.id()).await?;
        if balance.free.saturating_sub(balance.frozen)
            < o.intent
                .coin_fen
                .parse::<u128>()
                .map_err(|_| scale::invalid())?
        {
            let mut n = o.next();
            n.exception_reason = Some("topup_disburse_insufficient_balance".into());
            repo.save(&o, &n).await?;
            return Ok(false);
        }
        let version = chain
            .call("state_getRuntimeVersion", json!([a.hash]))
            .await?;
        let spec = u32::try_from(version["specVersion"].as_u64().ok_or_else(scale::invalid)?)
            .map_err(|_| scale::invalid())?;
        let tx = u32::try_from(
            version["transactionVersion"]
                .as_u64()
                .ok_or_else(scale::invalid)?,
        )
        .map_err(|_| scale::invalid())?;
        o.payment
            .as_ref()
            .ok_or_else(scale::invalid)?
            .require_fresh(clock.now())?;
        let signed = build(
            &m,
            key,
            &c.chain_genesis_hash,
            spec,
            tx,
            balance.nonce,
            &o,
            claim,
            a.number,
        )?;
        let mut n = o.next();
        n.signed = Some(signed);
        n.phase = Phase::Signed;
        n.scan = a.number;
        n.exception_reason = None;
        // 存储层同时核对活动账户claim、CAS及签名不可变；失败时绝不广播本地字节。
        o = repo.save(&o, &n).await?;
    }
    let signed = o.signed.clone().ok_or_else(scale::invalid)?;
    let head = finalized::head(chain, &c.chain_genesis_hash).await?;
    let end = head.number.min(o.scan.saturating_add(6));
    for number in o.scan.saturating_add(1)..=end {
        let hash = chain.call("chain_getBlockHash", json!([number])).await?;
        let hash = hash.as_str().ok_or_else(scale::invalid)?;
        let block = chain.call("chain_getBlock", json!([hash])).await?;
        let extrinsics = block["block"]["extrinsics"]
            .as_array()
            .filter(|a| a.len() <= 10000)
            .ok_or_else(scale::invalid)?;
        for (index, extrinsic) in extrinsics.iter().enumerate() {
            let raw = crypto::unhex(extrinsic.as_str().ok_or_else(scale::invalid)?)?;
            if transaction::hash(&raw) != signed.tx_hash {
                continue;
            }
            let request = crate::chain::settlement::Settled {
                gmb_tx_hash: signed.tx_hash.clone(),
                gmb_block_hash: hash.into(),
                gmb_extrinsic_index: index as u32,
                signed_extrinsic_hex: signed.extrinsic.clone(),
            };
            let proof =
                match crate::chain::settlement::verify(chain, c, &o, &request, clock.now()).await {
                    Ok(p) => p,
                    Err(e) if e.code == "transaction_failed" => {
                        let mut n = o.next();
                        n.phase = Phase::Exception;
                        n.exception_reason = Some("topup_gmb_finalized_failed".into());
                        repo.save(&o, &n).await?;
                        repo.unlock(&o.order_id, &signed.account_id, &signed.claim)
                            .await?;
                        return Ok(true);
                    }
                    Err(e) => return Err(e),
                };
            let mut n = o.next();
            n.phase = Phase::Paid;
            n.gmb = Some(proof);
            n.scan = number;
            n.exception_reason = None;
            repo.save(&o, &n).await?;
            repo.unlock(&o.order_id, &signed.account_id, &signed.claim)
                .await?;
            return Ok(true);
        }
    }
    if end > o.scan {
        let mut n = o.next();
        n.scan = end;
        o = repo.save(&o, &n).await?;
    }
    // 未扫完已经finalized的历史时先继续追踪，不对旧nonce重新签名。
    if o.scan < head.number {
        return Ok(false);
    }
    let mut n = o.next();
    n.phase = Phase::Broadcast;
    n.exception_reason = match chain.broadcast(&signed.extrinsic).await {
        Ok(BroadcastOutcome::Accepted(h)) if h == signed.tx_hash => None,
        Ok(BroadcastOutcome::Rejected(_)) => {
            Some("topup_broadcast_rejected_requires_resolution".into())
        }
        _ => Some("topup_broadcast_outcome_unknown".into()),
    };
    repo.save(&o, &n).await?;
    Ok(false)
}
