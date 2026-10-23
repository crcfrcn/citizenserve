//! 复用现有Queue通道，消息只携带订单定位；订单即持久outbox，与通知表无关。
use citizenserve::{
    shared::{Error, Result},
    topup::{
        self,
        ports::{Clock, Repository},
    },
};
use serde::{Deserialize, Serialize};
use worker::Env;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    version: u8,
    kind: String,
    id: String,
}
pub fn matches(v: &serde_json::Value) -> bool {
    v["kind"] == "topup"
}
pub async fn dispatch(env: &Env, id: &str) -> Result<()> {
    dispatch_after(env, id, 0).await
}
async fn dispatch_after(env: &Env, id: &str, delay: u32) -> Result<()> {
    if !topup::routes::order_id(id) {
        return Err(topup::routes::invalid());
    }
    let repo = super::storage::D1Topup::configured(env)?;
    repo.defer(id, super::network::Now.now()).await?;
    env.queue("NOTIFY")
        .map_err(|_| Error::new(503, "topup_queue_unavailable"))?
        .send(
            worker::MessageBuilder::new(Message {
                version: 1,
                kind: "topup".into(),
                id: id.into(),
            })
            .delay_seconds(delay)
            .build(),
        )
        .await
        .map_err(|_| Error::new(503, "topup_queue_unavailable"))
}
pub async fn recover(env: &Env) -> Result<()> {
    let repo = super::storage::D1Topup::configured(env)?;
    for o in repo.pending(50).await? {
        dispatch(env, &o.order_id).await?;
    }
    Ok(())
}
pub async fn consume(env: &Env, v: &serde_json::Value) -> Result<bool> {
    let message: Message =
        serde_json::from_value(v.clone()).map_err(|_| topup::routes::invalid())?;
    if message.version != 1 || message.kind != "topup" || !topup::routes::order_id(&message.id) {
        return Err(topup::routes::invalid());
    }
    let repo = super::storage::D1Topup::configured(env)?;
    let Some(mut o) = repo.by_id(&message.id).await? else {
        return Ok(true);
    };
    if matches!(
        o.phase,
        topup::orders::Phase::Awaiting
            | topup::orders::Phase::Paid
            | topup::orders::Phase::Exception
    ) {
        return Ok(true);
    }
    let result = async {
        let c = super::configured(env)?;
        if o.signed.is_none() {
            let rpc = super::network::Payment::configured(env, o.intent.network)?;
            let Some(received) =
                topup::orders::receive(&repo, &rpc, &super::network::Now, &c, &message.id).await?
            else {
                return Ok(false);
            };
            if received.phase == topup::orders::Phase::Exception {
                return Ok(true);
            }
            o = received;
        }
        let account = super::account::key(env).ok();
        if o.signed.is_none() && account.is_none() {
            return Err(topup::config::unconfigured());
        }
        let claim = format!(
            "tpc_{}",
            citizenserve::shared::crypto::hex(&crate::runtime::random::<16>()?)
        );
        if o.signed.is_none() {
            let key = account.as_ref().ok_or_else(topup::config::unconfigured)?;
            if !repo
                .lock(&o, &key.id(), &claim, super::network::Now.now())
                .await?
            {
                return Ok(false);
            }
        }
        // 只有已签交易或取得同账户排他claim者才领取确认池；核心在签名前复核同一claim。
        let chain = crate::chain::Chain::configured(env, crate::chain::Purpose::Topup).await?;
        topup::disburse::run(
            &repo,
            &chain,
            &super::network::Now,
            &c,
            account.as_ref(),
            &message.id,
            &claim,
        )
        .await
    }
    .await;
    match result {
        Ok(true) => Ok(true),
        outcome => {
            // 正常等待不消耗通用队列的五次异常重试；续查新消息成功后才能ack本条。
            dispatch_after(env, &message.id, if outcome.is_ok() { 10 } else { 60 }).await?;
            Ok(true)
        }
    }
}
