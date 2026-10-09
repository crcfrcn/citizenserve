use crate::{
    chain::{
        self,
        finalized::{self, Anchor},
        ports::Rpc,
    },
    shared::{Error, Result},
    user::{identity::Identity, ports::IdentityRepository},
};
use serde::Deserialize;
use serde_json::json;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub block_hash: String,
}
#[derive(Default, Clone, Debug)]
pub struct Counts {
    pub projected: usize,
    pub revoked: usize,
}
fn pending() -> Error {
    Error::registration(
        409,
        "identity_finalization_pending",
        true,
        "resolve_identity",
    )
}
/// 激活强制刷新；普通调用只在原确认期限内复用，刷新租约不延长授权时间。
pub async fn current<R: Rpc, D: IdentityRepository>(
    rpc: &R,
    repo: &D,
    account: &str,
    genesis: &str,
    checked: u64,
    force: bool,
) -> Result<Identity> {
    let old = repo.by_account(account).await?;
    if let Some(i) = &old {
        if !force && i.chain_scope == genesis && i.require_current(checked).is_ok() {
            return Ok(i.clone());
        }
        if !repo.claim_refresh(&i.cid_number, checked).await? {
            return Err(pending());
        }
    }
    let head = finalized::head(rpc, genesis).await?;
    let m = chain::identity::metadata(rpc, &head).await?;
    // 先按已知CID复核，换绑/吊销即使旧账户的反向映射已经删除仍能传播撤销。
    if let Some(i) = &old {
        let fresh = chain::identity::by_cid(rpc, &m, &head, &i.cid_number, genesis, checked)
            .await?
            .ok_or_else(pending)?;
        repo.project(std::slice::from_ref(&fresh), None, None)
            .await?;
        if fresh.account_id != account {
            return Err(Error::new(401, "cid_binding_changed"));
        }
        fresh.require_current(checked)?;
        return Ok(fresh);
    }
    let i = chain::identity::by_account(rpc, &m, &head, account, genesis, checked)
        .await?
        .ok_or_else(pending)?;
    repo.project(std::slice::from_ref(&i), None, None).await?;
    i.require_current(checked)?;
    Ok(i)
}
async fn at_block<R: Rpc>(
    rpc: &R,
    anchor: &Anchor,
    genesis: &str,
    checked: u64,
) -> Result<(Vec<Identity>, usize)> {
    let m = chain::identity::metadata(rpc, anchor).await?;
    // 区块事件由parent状态的runtime执行；storage由该块post-state的metadata读取。
    let event_m = if anchor.number > 0 {
        chain::identity::metadata(rpc, &finalized::header(rpc, &anchor.parent_hash).await?).await?
    } else {
        chain::identity::metadata(rpc, anchor).await?
    };
    let cids = chain::identity::events(rpc, &event_m, anchor).await?;
    let event_count = cids.len();
    let cids: std::collections::BTreeSet<_> = cids.into_iter().collect();
    if cids.len() > 256 {
        return Err(chain::scale::invalid());
    }
    let mut identities = Vec::new();
    for cid in cids {
        // 机构CID不属于账户接入范围，但不能阻塞全链游标。
        if chain::identity::institution(&cid).is_err() {
            continue;
        }
        identities.push(
            chain::identity::by_cid(rpc, &m, anchor, &cid, genesis, checked)
                .await?
                .ok_or_else(pending)?,
        );
    }
    Ok((identities, event_count))
}
pub async fn confirm<R: Rpc, D: IdentityRepository>(
    rpc: &R,
    repo: &D,
    input: &Confirm,
    genesis: &str,
    checked: u64,
) -> Result<serde_json::Value> {
    let head = finalized::head(rpc, genesis).await?;
    let anchor = finalized::canonical(rpc, &input.block_hash, &head).await?;
    let (identities, event_count) = at_block(rpc, &anchor, genesis, checked).await?;
    // 历史区块只恢复投影，不把该历史绑定称为最近的当前绑定。
    let identities: Vec<_> = identities
        .into_iter()
        .map(|mut i| {
            i.authoritative_current = anchor.hash == head.hash;
            i
        })
        .collect();
    let counts = repo.project(&identities, None, None).await?;
    Ok(
        json!({"ok":true,"projection":{"finalized_block_number":anchor.number,"finalized_block_hash":anchor.hash,"identity_event_count":event_count,"projected_user_count":counts.projected,"revoked_user_count":counts.revoked}}),
    )
}
/// 全局游标只能逐块提交；目标注册确认不调用此分支。
pub async fn catch_up<R: Rpc, D: IdentityRepository>(
    rpc: &R,
    repo: &D,
    genesis: &str,
    checked: u64,
) -> Result<()> {
    let head = finalized::head(rpc, genesis).await?;
    let mut previous = repo.cursor().await?;
    let start = previous.as_ref().map(|a| a.number + 1).unwrap_or(0);
    for n in start..=head.number.min(start.saturating_add(9)) {
        let hash = rpc.call("chain_getBlockHash", json!([n])).await?;
        let anchor = finalized::canonical(rpc, hash.as_str().ok_or_else(pending)?, &head).await?;
        if previous
            .as_ref()
            .is_some_and(|p| anchor.parent_hash != p.hash)
        {
            return Err(Error::new(503, "projection_cursor_conflict"));
        }
        let (mut identities, _) = at_block(rpc, &anchor, genesis, checked).await?;
        if n != head.number {
            for i in &mut identities {
                i.authoritative_current = false;
            }
        }
        repo.project(&identities, Some(&anchor), previous.as_ref())
            .await?;
        previous = Some(anchor);
    }
    Ok(())
}
