//! 六条主网币轨是唯一资产名单；RPC和收款地址是部署输入，客户端不能替换。
use super::{quote, Token};
use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Ethereum,
    Base,
    Solana,
    Tron,
    Bnb,
}
impl Network {
    pub fn evm_id(self) -> Option<u64> {
        match self {
            Self::Ethereum => Some(1),
            Self::Base => Some(8453),
            Self::Bnb => Some(56),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Ethereum => "ethereum",
            Self::Base => "base",
            Self::Solana => "solana",
            Self::Tron => "tron",
            Self::Bnb => "bnb",
        }
    }
    pub fn normalize(self, s: &str) -> Result<String> {
        match self {
            Self::Tron => {
                if !super::tron::address(s) {
                    return Err(super::routes::invalid());
                }
                Ok(s.into())
            }
            Self::Solana => {
                if !super::solana::address(s) {
                    return Err(super::routes::invalid());
                }
                Ok(s.into())
            }
            _ => normalize_address(s),
        }
    }
    pub fn txid(self, s: &str) -> bool {
        match self {
            Self::Solana => {
                use base58::FromBase58;
                s.from_base58().is_ok_and(|b| b.len() == 64)
            }
            Self::Tron => ids::hex(s, 32, false),
            _ => ids::hex(s, 32, true),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rail {
    pub token: Token,
    pub network: Network,
    pub asset: String,
    pub decimals: u8,
}
pub fn rails() -> Vec<Rail> {
    use Network::*;
    use Token::*;
    [
        (
            USDC,
            Ethereum,
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            6,
        ),
        (USDC, Base, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6),
        (
            USDC,
            Solana,
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            6,
        ),
        (
            USDT,
            Ethereum,
            "0xdac17f958d2ee523a2206206994597c13d831ec7",
            6,
        ),
        (USDT, Tron, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 6),
        (USDT, Bnb, "0x55d398326f99059ff775485246999027b3197955", 18),
    ]
    .into_iter()
    .map(|(token, network, asset, decimals)| Rail {
        token,
        network,
        asset: asset.into(),
        decimals,
    })
    .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receivers {
    pub evm: String,
    pub tron: String,
    pub solana: String,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub service_origin: String,
    pub chain_genesis_hash: String,
    pub receivers: Receivers,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        let u = url::Url::parse(&self.service_origin).map_err(|_| unconfigured())?;
        if u.scheme() != "https"
            || u.origin().ascii_serialization() != self.service_origin
            || !ids::hex(&self.chain_genesis_hash, 32, true)
        {
            return Err(unconfigured());
        }
        if normalize_address(&self.receivers.evm)? != self.receivers.evm
            || !super::tron::address(&self.receivers.tron)
            || !super::solana::address(&self.receivers.solana)
        {
            return Err(unconfigured());
        }
        Ok(())
    }
    pub fn rail(&self, t: Token, n: Network) -> Result<Rail> {
        rails()
            .into_iter()
            .find(|r| r.token == t && r.network == n)
            .ok_or(Error::new(400, "topup_asset_not_supported"))
    }
    pub fn receiver(&self, n: Network) -> &str {
        match n {
            Network::Tron => &self.receivers.tron,
            Network::Solana => &self.receivers.solana,
            _ => &self.receivers.evm,
        }
    }
    pub fn response(&self) -> Result<serde_json::Value> {
        self.validate()?;
        let packages=["pkg_15","pkg_1400"].into_iter().map(|id|{let q=quote(id,6)?;Ok(serde_json::json!({"package_id":id,"pay_display":if id=="pkg_15"{"15"}else{"1400"},"coin_display":if id=="pkg_15"{"10,000.00"}else{"1,000,000.00"},"coin_fen":q.citizen_coin_fen.to_string(),"payments":rails().iter().map(|r|Ok(serde_json::json!({"token":r.token,"network":r.network,"pay_amount":quote(id,r.decimals)?.payment_atomic.to_string()}))).collect::<Result<Vec<_>>>()?}))}).collect::<Result<Vec<_>>>()?;
        Ok(
            serde_json::json!({"ok":true,"rails":rails().iter().map(|r|serde_json::json!({"token":r.token,"network":r.network,"asset":r.asset,"decimals":r.decimals,"recv_address":self.receiver(r.network)})).collect::<Vec<_>>(),"packages":packages}),
        )
    }
}
pub fn address(s: &str) -> bool {
    ids::hex(s, 20, true) && s != "0x0000000000000000000000000000000000000000"
}
pub fn normalize_address(s: &str) -> Result<String> {
    let s = s.to_ascii_lowercase();
    if address(&s) {
        Ok(s)
    } else {
        Err(super::routes::invalid())
    }
}
pub fn unconfigured() -> Error {
    Error::new(503, "topup_unconfigured")
}
