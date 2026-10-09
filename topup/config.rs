use super::{quote, Token, BASE_CHAIN_ID};
use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};
pub const USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// 既有Base桥接USDT轨，不能标成Tether在Base原生发行的新资产。
pub const USDT: &str = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rail {
    pub token: Token,
    pub chain_id: u64,
    pub token_contract: String,
    pub token_decimals: u8,
    pub label: String,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub service_origin: String,
    pub chain_genesis_hash: String,
    pub recv_address: String,
    pub disburse_account: String,
    pub min_confirmations: u64,
    pub rails: Vec<Rail>,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        let u = url::Url::parse(&self.service_origin).map_err(|_| unconfigured())?;
        if u.scheme() != "https"
            || u.origin().ascii_serialization() != self.service_origin
            || !ids::hex(&self.chain_genesis_hash, 32, true)
            || !address(&self.recv_address)
            || !ids::hex(&self.disburse_account, 32, true)
            || self.min_confirmations > 100000
            || self.rails.len() != 2
        {
            return Err(unconfigured());
        }
        let mut seen = std::collections::BTreeSet::new();
        for r in &self.rails {
            if !seen.insert(format!("{:?}", r.token))
                || r.chain_id != BASE_CHAIN_ID
                || r.token_decimals != 6
                || !address(&r.token_contract)
                || r.token_contract
                    != match r.token {
                        Token::USDC => USDC,
                        Token::USDT => USDT,
                    }
                || r.label.is_empty()
                || r.label.len() > 128
            {
                return Err(unconfigured());
            }
        }
        Ok(())
    }
    pub fn rail(&self, t: Token) -> Result<&Rail> {
        self.validate()?;
        self.rails
            .iter()
            .find(|r| r.token == t)
            .ok_or_else(unconfigured)
    }
    pub fn response(&self) -> Result<serde_json::Value> {
        self.validate()?;
        let packages=["pkg_15","pkg_1400"].into_iter().map(|id|{let q=quote(id).expect("static package");serde_json::json!({"package_id":id,"pay_display":if id=="pkg_15"{"15"}else{"1400"},"pay_amount":q.payment_atomic.to_string(),"coin_display":if id=="pkg_15"{"10,000.00"}else{"1,000,000.00"},"coin_fen":q.citizen_coin_fen.to_string()})}).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"ok":true,"network":"mainnet","recv_address":self.recv_address,"rails":self.rails,"packages":packages}),
        )
    }
}
pub fn address(s: &str) -> bool {
    ids::hex(s, 20, true) && s != "0x0000000000000000000000000000000000000000"
}
pub fn normalize_address(s: &str) -> Result<String> {
    let v = s.to_ascii_lowercase();
    if !address(&v) {
        return Err(super::routes::invalid());
    }
    Ok(v)
}
pub fn unconfigured() -> Error {
    Error::new(503, "topup_unconfigured")
}
