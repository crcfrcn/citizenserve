//! 种子仅短时驻留受清除保护的内存，不实现Debug/Serialize，不持久化或记录秘密。
use crate::{
    chain::{
        finalized::Anchor,
        identity,
        ports::Rpc,
        scale::{self, Metadata},
    },
    shared::{crypto, Result},
};
use base58::ToBase58;
use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey};
use zeroize::Zeroizing;
pub struct Account {
    pair: Keypair,
}
impl Account {
    pub fn owned(raw: String) -> Result<Self> {
        let raw = Zeroizing::new(raw);
        Self::read(&raw)
    }
    pub fn read(raw: &str) -> Result<Self> {
        let b = Zeroizing::new(crypto::unhex(raw).map_err(|_| super::config::unconfigured())?);
        if b.len() != 32 || !raw.starts_with("0x") {
            return Err(super::config::unconfigured());
        }
        let key = MiniSecretKey::from_bytes(&b).map_err(|_| super::config::unconfigured())?;
        Ok(Self {
            pair: key.expand_to_keypair(ExpansionMode::Ed25519),
        })
    }
    pub fn public(&self) -> [u8; 32] {
        self.pair.public.to_bytes()
    }
    pub fn id(&self) -> String {
        format!("0x{}", crypto::hex(&self.public()))
    }
    pub fn sign(&self, bytes: &[u8]) -> [u8; 64] {
        self.pair.sign_simple(b"substrate", bytes).to_bytes()
    }
    pub fn address(&self) -> String {
        use blake2::{Blake2b512, Digest};
        let prefix = 2027u16;
        let mut b = vec![
            ((prefix & 0xfc) >> 2) as u8 | 0x40,
            ((prefix >> 8) as u8) | (((prefix & 3) as u8) << 6),
        ];
        b.extend(self.public());
        let mut h = Blake2b512::new();
        h.update(b"SS58PRE");
        h.update(&b);
        b.extend(&h.finalize()[..2]);
        b.to_base58()
    }
}
#[derive(Clone, Debug)]
pub struct Balance {
    pub free: u128,
    pub frozen: u128,
    pub nonce: u32,
}
pub async fn balance<R: Rpc>(rpc: &R, m: &Metadata, a: &Anchor, account: &str) -> Result<Balance> {
    let key = crypto::unhex(account)?;
    let v = identity::storage(rpc, m, a, "System", "Account", Some(&key)).await?;
    let Some(v) = v else {
        return Ok(Balance {
            free: 0,
            frozen: 0,
            nonce: 0,
        });
    };
    let data = scale::field(&v, "data")?;
    Ok(Balance {
        free: scale::u128_value(scale::field(data, "free")?)?,
        frozen: scale::u128_value(scale::field(data, "frozen")?)?,
        nonce: u32::try_from(scale::integer(scale::field(&v, "nonce")?)?)
            .map_err(|_| scale::invalid())?,
    })
}
