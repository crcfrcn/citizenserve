use super::{
    network::{Base, Now},
    repositories::topup::D1Topup,
};
use citizenserve::{
    chain::{finalized, identity},
    server::routes,
    shared::{crypto, Error, Result},
    topup::{
        self,
        config::{Config, Rail},
        ports::{Clock, Repository},
        routes::TopupRoute,
        Token,
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
    let c = Config {
        service_origin: var("WEB_ORIGIN")?,
        chain_genesis_hash: var("CHAIN_GENESIS_HASH")?,
        recv_address: topup::config::normalize_address(&var("TOPUP_RECV_ADDRESS")?)?,
        disburse_account: var("TOPUP_DISBURSE_ACCOUNT_ID")?,
        min_confirmations: var("TOPUP_MIN_CONFIRMATIONS")?
            .parse()
            .map_err(|_| topup::config::unconfigured())?,
        rails: vec![
            Rail {
                token: Token::USDC,
                chain_id: 8453,
                token_contract: topup::config::normalize_address(&var("TOPUP_BASE_USDC")?)?,
                token_decimals: 6,
                label: "Base USDC".into(),
            },
            Rail {
                token: Token::USDT,
                chain_id: 8453,
                token_contract: topup::config::normalize_address(&var("TOPUP_BASE_USDT")?)?,
                token_decimals: 6,
                label: "Base Bridged USDT".into(),
            },
        ],
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
) -> Result<Response> {
    route.validate_query(url.query())?;
    let c = configured(env)?;
    let bytes = super::read_body(request, route.body_limit()).await?;
    let repo = D1Topup {
        db: env.d1("DB").map_err(|_| topup::config::unconfigured())?,
    };
    if route.settlement() {
        topup::settlement::authorize(
            secret(env, "SETTLE_TOKEN")?.as_bytes(),
            request
                .headers()
                .get("authorization")
                .map_err(|_| topup::config::unconfigured())?
                .as_deref(),
        )?
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
            let r: topup::intent::Request = routes::parse_json(&bytes, 16384)?;
            citizenserve::shared::ids::account(&r.account_id)?;
            account_limit(&repo, &r.account_id).await?;
            let chain = super::chain::Chain::configured(env)?;
            let a = finalized::head(&chain, &c.chain_genesis_hash).await?;
            let m = identity::metadata(&chain, &a).await?;
            let cid = topup::intent::target_cid(&chain, &m, &a, &r.account_id).await?;
            let i = topup::intent::Intent::create(
                &c,
                r,
                cid,
                &crypto::hex(&super::runtime::random::<16>()?),
                Now.now(),
            )?;
            let token = topup::intent::sign(&i, key.as_bytes())?;
            json!({"ok":true,"payment_intent":token,"wallet_authorization_message":topup::intent::message(&c,&i,&token)?,"intent":i})
        }
        TopupRoute::Confirm => {
            let input: topup::orders::Confirm = routes::parse_json(&bytes, 16384)?;
            let intent = topup::intent::verify(&input.payment_intent, key.as_bytes())?;
            account_limit(&repo, &intent.account_id).await?;
            topup::orders::confirm(
                &repo,
                &Base::configured(env)?,
                &Now,
                &c,
                key.as_bytes(),
                input,
                &crypto::hex(&super::runtime::random::<16>()?),
            )
            .await?
        }
        TopupRoute::Status => {
            topup::orders::status(&repo, key.as_bytes(), routes::parse_json(&bytes, 16384)?).await?
        }
        TopupRoute::Pending | TopupRoute::History => {
            let q = routes::query(url.query())?;
            let limit = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(
                if route == TopupRoute::Pending {
                    50
                } else {
                    100
                },
            );
            let cursor = q
                .get("cursor")
                .map(|s| topup::settlement::Cursor::decode(s))
                .transpose()?;
            let items = repo
                .list(route == TopupRoute::History, limit, cursor.as_ref())
                .await?;
            let next = if route == TopupRoute::History && items.len() == limit as usize {
                items
                    .last()
                    .map(|o| {
                        topup::settlement::Cursor {
                            confirmed_at: o.confirmed_at,
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
        TopupRoute::Claim => {
            let r: topup::settlement::Claim = routes::parse_json(&bytes, 16384)?;
            let claim = r.claim_id.unwrap_or(format!(
                "tpc_{}",
                crypto::hex(&super::runtime::random::<16>()?)
            ));
            topup::settlement::claim_id(&claim)?;
            let o = repo
                .claim(topup::routes::path_order(url.path())?, &claim, Now.now())
                .await?;
            json!({"ok":true,"order":o})
        }
        TopupRoute::Settled => {
            topup::settlement::settled(
                &repo,
                &Base::configured(env)?,
                &super::chain::Chain::configured(env)?,
                &Now,
                &c,
                topup::routes::path_order(url.path())?,
                routes::parse_json(&bytes, 131584)?,
            )
            .await?
        }
        TopupRoute::Exception => {
            let r: topup::settlement::Exception = routes::parse_json(&bytes, 16384)?;
            topup::settlement::claim_id(&r.claim_id)?;
            if r.reason.is_empty()
                || r.reason.len() > 1024
                || r.reason.trim() != r.reason
                || r.reason.chars().any(char::is_control)
            {
                return Err(topup::routes::invalid());
            }
            let o = repo
                .exception(
                    topup::routes::path_order(url.path())?,
                    &r.claim_id,
                    &r.reason,
                    Now.now(),
                )
                .await?;
            json!({"ok":true,"order":o})
        }
    };
    super::json_response(&v, 200)
}

async fn account_limit(repo: &D1Topup, account: &str) -> Result<()> {
    super::repositories::external_batch(&repo.db,json!({"account":account}),r#"-- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) VALUES('topup-account:'||json_extract(?1,'$.account'),1,json_extract(?1,'$.now')+60000) ON CONFLICT(rate_key) DO UPDATE SET request_count=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN 1 ELSE request_count+1 END,expires_at=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN json_extract(?1,'$.now')+60000 ELSE expires_at END;
 -- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'topup-account-assert',NULL,0 WHERE EXISTS(SELECT 1 FROM rate_windows WHERE rate_key='topup-account:'||json_extract(?1,'$.account') AND request_count>10);
 "#,Error::new(429,"topup_write_rate_exceeded")).await?;
    Ok(())
}
