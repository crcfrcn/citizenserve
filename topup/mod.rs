use crate::shared::{Error, Result};
use serde::{Deserialize, Serialize};
pub const BASE_CHAIN_ID: u64 = 8453;
pub mod config;
pub mod evm_verify;
pub mod intent;
pub mod orders;
pub mod ports;
pub mod routes;
pub mod settlement;
pub mod wallet_authorization;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Token {
    USDC,
    USDT,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Quote {
    pub payment_atomic: u64,
    pub citizen_coin_fen: u64,
}
pub fn quote(package: &str) -> Result<Quote> {
    match package {
        "pkg_15" => Ok(Quote {
            payment_atomic: 15_000_000,
            citizen_coin_fen: 1_000_000,
        }),
        "pkg_1400" => Ok(Quote {
            payment_atomic: 1_400_000_000,
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
/// 结算claim不自动到期释放：旧结算者可能已经付款，必须核实链事实才结束claim。
#[derive(Clone, Debug)]
pub struct Settlement {
    pub state: State,
    pub claim_id: Option<String>,
    pub finalized_transaction: Option<String>,
}
impl Settlement {
    pub fn claim(&mut self, id: &str) -> Result<()> {
        if id.is_empty() || self.state != State::Pending {
            return Err(Error::new(409, "topup_not_pending"));
        }
        if self.claim_id.as_ref().is_some_and(|v| v != id) {
            return Err(Error::new(409, "topup_already_claimed"));
        }
        self.claim_id = Some(id.to_owned());
        Ok(())
    }
    /// 调用此状态变更前，宿主必须核实EVM付款及公民链finalized实际收款方和金额。
    pub fn settle(&mut self, claim: &str, finalized: &str) -> Result<()> {
        if self.claim_id.as_deref() != Some(claim) {
            return Err(Error::new(409, "topup_claim_mismatch"));
        }
        if let Some(old) = &self.finalized_transaction {
            return if old == finalized {
                Ok(())
            } else {
                Err(Error::new(409, "topup_settlement_conflict"))
            };
        }
        if self.state != State::Pending || !crate::shared::ids::hex(finalized, 32, true) {
            return Err(Error::new(409, "topup_not_pending"));
        }
        self.finalized_transaction = Some(finalized.to_owned());
        self.state = State::Paid;
        Ok(())
    }
}
