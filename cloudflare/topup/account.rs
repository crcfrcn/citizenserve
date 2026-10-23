//! 管理端只读账户与各链币余额；失败保留状态，绝不把不可读伪装成零。
use super::{network::Now, network::Payment};
use citizenserve::{
    chain::{finalized, identity},
    shared::{crypto, Error, Result},
    topup::{
        self,
        account::Account,
        config::{Config, Network, Rail},
        ports::{Method, PaymentRpc},
    },
};
use serde_json::{json, Value};
use worker::Env;
pub fn key(env: &Env) -> Result<Account> {
    let raw = env
        .secret("TOPUP_DISBURSE_KEY")
        .map_err(|_| topup::config::unconfigured())?
        .to_string();
    Account::owned(raw)
}
pub async fn response(env: &Env, c: &Config) -> Result<Value> {
    let account = key(env);
    let configured = account.is_ok();
    let gmb = match account {
        Ok(key) => {
            let id = key.id();
            let address = key.address();
            let read=async {let chain=crate::chain::Chain::configured(env,crate::chain::Purpose::Topup).await?;let a=finalized::head(&chain,&c.chain_genesis_hash).await?;let m=identity::metadata(&chain,&a).await?;let balance=topup::account::balance(&chain,&m,&a,&id).await?;Ok::<_,Error>(json!({"ok":true,"atomic":balance.free.to_string(),"frozen":balance.frozen.to_string(),"decimals":2,"block_hash":a.hash}))}.await;
            json!({"account_id":id,"public_key":id,"address":address,"balance":result(read)})
        }
        Err(_) => json!({"balance":{"ok":false,"error":"topup_disburse_unconfigured"}}),
    };
    let mut balances = vec![];
    for rail in topup::config::rails() {
        let value = balance(env, c, &rail).await;
        balances.push(json!({"token":rail.token,"network":rail.network,"asset":rail.asset,"address":c.receiver(rail.network),"decimals":rail.decimals,"balance":result(value)}));
    }
    Ok(json!({"ok":true,"configured":configured,"gmb":gmb,"receipts":balances}))
}
fn result(v: Result<Value>) -> Value {
    match v {
        Ok(v) => v,
        Err(e) => json!({"ok":false,"error":e.code}),
    }
}
async fn balance(env: &Env, c: &Config, rail: &Rail) -> Result<Value> {
    let rpc = Payment::configured(env, rail.network)?;
    let fail = || Error::new(503, "topup_balance_unavailable");
    let amount = match rail.network {
        Network::Tron => {
            if rpc.call(Method::TronGenesis, json!({"num":0})).await?["blockID"]
                != topup::tron::GENESIS
            {
                return Err(fail());
            }
            let mut parameter = String::from("000000000000000000000000");
            parameter.push_str(&topup::tron::hex_address(c.receiver(rail.network))?[2..]);
            let body = |function: &str, param: &str| json!({"owner_address":topup::tron::hex_address(c.receiver(rail.network)).ok(),"contract_address":topup::tron::hex_address(&rail.asset).ok(),"function_selector":function,"parameter":param,"visible":false});
            let decimals = rpc
                .call(Method::TronBalance, body("decimals()", ""))
                .await?;
            let parse = |v: &Value| -> Result<Vec<u8>> {
                if v["result"]["result"] != true {
                    return Err(fail());
                }
                let b = crypto::unhex(v["constant_result"][0].as_str().ok_or_else(fail)?)
                    .map_err(|_| fail())?;
                if b.len() != 32 {
                    return Err(fail());
                }
                Ok(b)
            };
            if parse(&decimals)? != [vec![0; 31], vec![rail.decimals]].concat() {
                return Err(fail());
            }
            topup::evm_verify::decimal(&parse(
                &rpc.call(Method::TronBalance, body("balanceOf(address)", &parameter))
                    .await?,
            )?)
        }
        Network::Solana => {
            if rpc.call(Method::SolGenesis, json!([])).await? != topup::solana::GENESIS {
                return Err(fail());
            }
            let v=rpc.call(Method::SolAccounts,json!([c.receiver(rail.network),{"mint":rail.asset},{"encoding":"jsonParsed","commitment":"finalized"}])).await?;
            let accounts = v["value"]
                .as_array()
                .filter(|a| a.len() <= 10000)
                .ok_or_else(fail)?;
            let mut sum = 0u128;
            let mut seen = std::collections::BTreeSet::new();
            for a in accounts {
                let info = &a["account"]["data"]["parsed"]["info"];
                if a["account"]["owner"] != topup::solana::PROGRAM
                    || info["mint"] != rail.asset
                    || info["owner"] != c.receiver(rail.network)
                    || info["tokenAmount"]["decimals"] != 6
                    || !seen.insert(a["pubkey"].as_str().ok_or_else(fail)?)
                {
                    return Err(fail());
                }
                sum = sum
                    .checked_add(
                        info["tokenAmount"]["amount"]
                            .as_str()
                            .ok_or_else(fail)?
                            .parse::<u64>()
                            .map_err(|_| fail())? as u128,
                    )
                    .ok_or_else(fail)?;
            }
            sum.to_string()
        }
        _ => {
            if topup::evm_verify::quantity_u64(
                rpc.call(Method::ChainId, json!([]))
                    .await?
                    .as_str()
                    .ok_or_else(fail)?,
            )? != rail.network.evm_id().ok_or_else(fail)?
            {
                return Err(fail());
            }
            let block = rpc.call(Method::Block, json!(["finalized", false])).await?;
            let hash = block["hash"]
                .as_str()
                .filter(|s| citizenserve::shared::ids::hex(s, 32, true))
                .ok_or_else(fail)?;
            // EIP-1898固定块hash，避免余额读取过程中tag漂移；不支持时明确报错。
            let tag = json!({"blockHash":hash,"requireCanonical":true});
            let decimals = rpc
                .call(
                    Method::Call,
                    json!([{"to":rail.asset,"data":"0x313ce567"},tag]),
                )
                .await?;
            let raw = topup::evm_verify::data_hex(decimals.as_str().ok_or_else(fail)?)?;
            if raw != [vec![0; 31], vec![rail.decimals]].concat() {
                return Err(fail());
            }
            let calldata = format!(
                "0x70a08231000000000000000000000000{}",
                &c.receiver(rail.network)[2..]
            );
            let value = rpc
                .call(Method::Call, json!([{"to":rail.asset,"data":calldata},tag]))
                .await?;
            let b = topup::evm_verify::data_hex(value.as_str().ok_or_else(fail)?)?;
            if b.len() != 32 {
                return Err(fail());
            }
            topup::evm_verify::decimal(&b)
        }
    };
    Ok(json!({"ok":true,"atomic":amount,"checked_at":citizenserve::topup::ports::Clock::now(&Now)}))
}
