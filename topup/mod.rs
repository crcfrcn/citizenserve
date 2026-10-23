use crate::shared::{Error, Result};
use serde::{Deserialize, Serialize};
pub mod account;
pub mod config;
pub mod disburse;
pub mod evm_verify;
pub mod intent;
pub mod orders;
pub mod ports;
pub mod routes;
pub mod settlement;
pub mod solana;
pub mod tron;
pub mod wallet_authorization;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Token {
    USDC,
    USDT,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Quote {
    pub payment_atomic: u128,
    pub citizen_coin_fen: u64,
}
pub fn quote(package: &str, decimals: u8) -> Result<Quote> {
    if ![6, 18].contains(&decimals) {
        return Err(Error::new(400, "invalid_topup_precision"));
    }
    let unit = 10u128.pow(decimals.into());
    match package {
        "pkg_15" => Ok(Quote {
            payment_atomic: 15 * unit,
            citizen_coin_fen: 1_000_000,
        }),
        "pkg_1400" => Ok(Quote {
            payment_atomic: 1400 * unit,
            citizen_coin_fen: 100_000_000,
        }),
        _ => Err(Error::new(400, "invalid_topup_package")),
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Pending,
    Paid,
    Exception,
}
