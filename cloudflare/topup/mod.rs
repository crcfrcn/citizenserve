//! 发币平台唯一装配入口；管理端只读，执行仅由持久订单队列驱动。
mod account;
mod network;
pub(crate) mod queue;
mod storage;
use self::{network::Now, storage::D1Topup};
use citizenserve::{
    chain::{finalized, identity},
    gate::request,
    shared::{crypto, Error, Result},
    topup::{
        self,
        config::{Config, Receivers},
        ports::{Clock, Repository},
        routes::TopupRoute,
    },
};
use serde_json::json;
use worker::{Env, Request, Response};
fn configured(env: &Env) -> Result<Config> {
    let var = |s| {
        env.var(s)
            .map(|v| v.to_string())
            .map_err(|_| topup::config::unconfigured())
    };
    let receivers: Receivers = serde_json::from_str(&var("TOPUP_RECEIVERS")?)
        .map_err(|_| topup::config::unconfigured())?;
    let c = Config {
        service_origin: var("WEB_ORIGIN")?,
        chain_genesis_hash: var("CHAIN_GENESIS_HASH")?,
        receivers,
    };
    c.validate()?;
    Ok(c)
}
fn secret(env: &Env, name: &str) -> Result<String> {
    let v = env
        .secret(name)
        .map_err(|_| topup::config::unconfigured())?
        .to_string();
    if !(32..=4096).contains(&v.len()) {
        return Err(topup::config::unconfigured());
    }
    Ok(v)
}
pub async fn handle(
    request: &mut Request,
    env: &Env,
    route: TopupRoute,
    url: &url::Url,
    scope: &citizenserve::gate::open::Scope<'_>,
) -> Result<Response> {
    scope.require_api(request::Route::Topup(route))?;
    route.validate_query(url.query())?;
    let c = configured(env)?;
    let bytes = crate::read_body(request, route.body_limit()).await?;
    let repo = D1Topup::configured(env)?;
    if scope.rule() == citizenserve::gate::policy::OpenRule::Settlement {
        citizenserve::gate::open::settlement(
            scope,
            secret(env, "SETTLE_TOKEN")?.as_bytes(),
            request
                .headers()
                .get("authorization")
                .map_err(|_| topup::config::unconfigured())?
                .as_deref(),
        )?;
    }
    let key = if matches!(
        route,
        TopupRoute::Intent | TopupRoute::Confirm | TopupRoute::Status
    ) {
        secret(env, "TOPUP_INTENT_SECRET")?
    } else {
        String::new()
    };
    let v = match route {
        TopupRoute::Config => c.response()?,
        TopupRoute::Intent => {
            let r: topup::intent::Request = request::parse_json(&bytes, 16384)?;
            citizenserve::shared::ids::account(&r.account_id)?;
            c.rail(r.token, r.network)?;
            account_limit(&repo, &r.account_id).await?;
            let chain =
                crate::chain::Chain::configured(env, crate::chain::Purpose::TopupIntent).await?;
            let a = finalized::head(&chain, &c.chain_genesis_hash).await?;
            let m = identity::metadata(&chain, &a).await?;
            let cid = topup::intent::target_cid(&chain, &m, &a, &r.account_id).await?;
            let i = topup::intent::Intent::create(
                &c,
                r,
                cid,
                &crypto::hex(&crate::runtime::random::<16>()?),
                Now.now(),
            )?;
            let token = topup::intent::sign(&i, key.as_bytes())?;
            let o = topup::orders::Order::create(&c, i.clone(), &token)?;
            let o = repo.insert(&o).await?;
            json!({"ok":true,"order_id":o.order_id,"payment_intent":token,"wallet_authorization_message":o.message,"intent":i})
        }
        TopupRoute::Confirm => {
            let input: topup::orders::Confirm = request::parse_json(&bytes, 16384)?;
            let intent =
                citizenserve::gate::open::payment(scope, &input.payment_intent, key.as_bytes())?;
            account_limit(&repo, &intent.account_id).await?;
            let value = topup::orders::confirm(&repo, &Now, &c, key.as_bytes(), input).await?;
            // 派发失败不丢已落盘订单；scheduled按持久phase补派，同一确认可安全重试。
            if let Some(id) = value["order_id"].as_str() {
                let _ = queue::dispatch(env, id).await;
            }
            value
        }
        TopupRoute::Status => {
            topup::orders::status(&repo, key.as_bytes(), request::parse_json(&bytes, 16384)?)
                .await?
        }
        TopupRoute::History => {
            let q = request::query(url.query())?;
            let limit = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100);
            let cursor = q
                .get("cursor")
                .map(|s| topup::settlement::Cursor::decode(s))
                .transpose()?;
            let items = repo.list(limit, cursor.as_ref()).await?;
            let next = if items.len() == limit as usize {
                items
                    .last()
                    .map(|o| {
                        topup::settlement::Cursor {
                            confirmed_at: o.created_at,
                            order_id: o.order_id.clone(),
                        }
                        .encode()
                    })
                    .transpose()?
            } else {
                None
            };
            json!({"ok":true,"orders":items,"next_cursor":next})
        }
        TopupRoute::Account => account::response(env, &c).await?,
    };
    crate::json_response(&v, 200)
}
async fn account_limit(repo: &D1Topup, account: &str) -> Result<()> {
    crate::repositories::external_batch(&repo.db,json!({"account":account}),r#"-- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) VALUES('topup-account:'||json_extract(?1,'$.account'),1,json_extract(?1,'$.now')+60000) ON CONFLICT(rate_key) DO UPDATE SET request_count=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN 1 ELSE request_count+1 END,expires_at=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN json_extract(?1,'$.now')+60000 ELSE expires_at END;
 -- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'topup-account-assert',NULL,0 WHERE EXISTS(SELECT 1 FROM rate_windows WHERE rate_key='topup-account:'||json_extract(?1,'$.account') AND request_count>10);
 "#,Error::new(429,"topup_write_rate_exceeded")).await?;
    Ok(())
}
