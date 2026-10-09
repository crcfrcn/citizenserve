//! HMAC表示服务器报价能力，付款钱包签名另外证明付款人对该目标的授权。
use super::{
    config::{self, Config},
    quote,
    routes::invalid,
    Token,
};
use crate::shared::{crypto, ids, Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub account_id: String,
    pub token: Token,
    pub package_id: String,
    pub payer_address: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub intent_id: String,
    pub cid_number: Option<String>,
    pub account_id: String,
    pub payer_address: String,
    pub token: Token,
    pub package_id: String,
    pub chain_id: u64,
    pub token_contract: String,
    pub recv_address: String,
    pub pay_amount: String,
    pub coin_fen: String,
    pub issued_at: u64,
    pub expires_at: u64,
}
impl Intent {
    pub fn create(
        c: &Config,
        r: Request,
        cid: Option<String>,
        random: &str,
        now: u64,
    ) -> Result<Self> {
        c.validate()?;
        ids::account(&r.account_id)?;
        if let Some(s) = &cid {
            ids::cid(s)?;
        }
        if !ids::hex(random, 16, false) {
            return Err(config::unconfigured());
        }
        let rail = c.rail(r.token)?;
        let q = quote(&r.package_id)?;
        Ok(Self {
            intent_id: format!("tpi_{random}"),
            cid_number: cid,
            account_id: r.account_id,
            payer_address: config::normalize_address(&r.payer_address)?,
            token: r.token,
            package_id: r.package_id,
            chain_id: rail.chain_id,
            token_contract: rail.token_contract.clone(),
            recv_address: c.recv_address.clone(),
            pay_amount: q.payment_atomic.to_string(),
            coin_fen: q.citizen_coin_fen.to_string(),
            issued_at: now,
            expires_at: now.checked_add(600000).ok_or_else(invalid)?,
        })
    }
    pub fn validate(&self, c: &Config) -> Result<()> {
        let q = quote(&self.package_id)?;
        let r = c.rail(self.token)?;
        ids::account(&self.account_id)?;
        if let Some(cid) = &self.cid_number {
            ids::cid(cid)?
        }
        if !self
            .intent_id
            .strip_prefix("tpi_")
            .is_some_and(|s| ids::hex(s, 16, false))
            || !config::address(&self.payer_address)
            || self.chain_id != r.chain_id
            || self.token_contract != r.token_contract
            || self.recv_address != c.recv_address
            || self.pay_amount != q.payment_atomic.to_string()
            || self.coin_fen != q.citizen_coin_fen.to_string()
            || self.issued_at == 0
            || self.expires_at.checked_sub(self.issued_at) != Some(600000)
        {
            return Err(Error::new(409, "topup_intent_config_changed"));
        }
        Ok(())
    }
    pub fn require_live(&self, now: u64) -> Result<()> {
        if self.issued_at > now || self.expires_at <= now {
            Err(Error::new(409, "topup_intent_expired"))
        } else {
            Ok(())
        }
    }
}
fn key(s: &[u8]) -> Result<()> {
    if s.len() < 32 || s.len() > 4096 {
        return Err(Error::new(503, "topup_intent_unconfigured"));
    }
    Ok(())
}
pub fn sign(i: &Intent, k: &[u8]) -> Result<String> {
    key(k)?;
    let raw = serde_json::to_vec(i).map_err(|_| invalid())?;
    let p = URL_SAFE_NO_PAD.encode(raw);
    Ok(format!(
        "{p}.{}",
        URL_SAFE_NO_PAD.encode(crypto::hmac_sha256(k, p.as_bytes()))
    ))
}
pub fn verify(s: &str, k: &[u8]) -> Result<Intent> {
    key(k)?;
    if s.len() > 8192 {
        return Err(invalid());
    }
    let (p, h) = s.split_once('.').ok_or_else(invalid)?;
    let sig = decode(h)?;
    if sig.len() != 32 || !crypto::equal_secret(&sig, &crypto::hmac_sha256(k, p.as_bytes())) {
        return Err(Error::new(401, "topup_intent_invalid"));
    }
    let raw = decode(p)?;
    let i: Intent = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    if sign(&i, k)? != s {
        return Err(invalid());
    }
    Ok(i)
}
pub fn decode(s: &str) -> Result<Vec<u8>> {
    let b = URL_SAFE_NO_PAD.decode(s).map_err(|_| invalid())?;
    if URL_SAFE_NO_PAD.encode(&b) != s {
        return Err(invalid());
    }
    Ok(b)
}
pub fn message(c: &Config, i: &Intent, token: &str) -> Result<String> {
    i.validate(c)?;
    Ok(format!("CitizenServe Topup v1\nservice_origin={}\nchain_genesis_hash={}\nintent_id={}\nchain_id={}\npayer_address={}\ntoken_contract={}\nrecv_address={}\npay_amount={}\ncoin_fen={}\naccount_id={}\npackage_id={}\nissued_at={}\nexpires_at={}\nintent_sha256={}\n",c.service_origin,c.chain_genesis_hash,i.intent_id,i.chain_id,i.payer_address,i.token_contract,i.recv_address,i.pay_amount,i.coin_fen,i.account_id,i.package_id,i.issued_at,i.expires_at,crypto::sha256_hex(token.as_bytes())))
}

/// 代充目标只记录当前CID双向绑定，不要求目标拥有消费方账户服务的机构类型/MLS会话。
/// RPC未知、反向记录缺失或不一致必须报错；仅真正不存在正向绑定才返回null。
pub async fn target_cid<R: crate::chain::ports::Rpc>(
    rpc: &R,
    m: &crate::chain::scale::Metadata,
    a: &crate::chain::finalized::Anchor,
    account: &str,
) -> Result<Option<String>> {
    use crate::chain::{identity, scale};
    ids::account(account)?;
    let Some(cid) = identity::storage(
        rpc,
        m,
        a,
        "CitizenIdentity",
        "CidByAccountId",
        Some(&crypto::unhex(account)?),
    )
    .await?
    else {
        return Ok(None);
    };
    let cid = scale::cid(&cid)?;
    ids::cid(&cid)?;
    let key = crypto::scale_string(&cid)?;
    let reverse = identity::storage(rpc, m, a, "CitizenIdentity", "AccountIdByCid", Some(&key))
        .await?
        .ok_or_else(scale::invalid)?;
    if format!("0x{}", crypto::hex(&scale::bytes(&reverse, 32)?)) != account {
        return Err(scale::invalid());
    }
    let record = identity::storage(rpc, m, a, "CitizenIdentity", "CidRegistry", Some(&key))
        .await?
        .ok_or_else(scale::invalid)?;
    if scale::variant(scale::field(&record, "status")?)? != "Active"
        || scale::variant(scale::field(&record, "revoked_at")?)? != "None"
    {
        return Err(scale::invalid());
    }
    Ok(Some(cid))
}
