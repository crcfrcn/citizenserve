//! ERC-191字节长度与Keccak，不能替换成SHA3-256；ERC-1271必须读取准确付款块。
use super::{
    evm_verify::{quantity, Method},
    ports::PaymentRpc,
};
use crate::shared::{crypto, Error, Result};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde_json::json;
use sha3::{Digest, Keccak256};
pub fn digest(message: &str) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(format!("\x19Ethereum Signed Message:\n{}", message.len()).as_bytes());
    h.update(message.as_bytes());
    h.finalize().into()
}
pub fn canonical_signature(raw: &str) -> Result<Vec<u8>> {
    let b = crypto::unhex(raw).map_err(|_| bad())?;
    if !raw.starts_with("0x") || b.is_empty() || b.len() > 4096 {
        return Err(bad());
    }
    Ok(b)
}
pub fn signature_hash(bytes: &[u8], contract: bool) -> Result<String> {
    let mut b = bytes.to_vec();
    if !contract {
        if b.len() != 65 {
            return Err(bad());
        }
        b[64] = match b[64] {
            0 | 1 => b[64],
            27 | 28 => b[64] - 27,
            _ => return Err(bad()),
        }
    }
    Ok(crypto::sha256_hex(&b))
}
pub fn recover(digest: &[u8; 32], b: &[u8]) -> Result<String> {
    if b.len() != 65 {
        return Err(bad());
    }
    let s = Signature::from_slice(&b[..64]).map_err(|_| bad())?;
    if s.normalize_s().is_some() {
        return Err(bad());
    }
    let v = match b[64] {
        0 | 1 => b[64],
        27 | 28 => b[64] - 27,
        _ => return Err(bad()),
    };
    let id = RecoveryId::try_from(v).map_err(|_| bad())?;
    let k = VerifyingKey::recover_from_prehash(digest, &s, id).map_err(|_| bad())?;
    let p = k.to_encoded_point(false);
    let hash = Keccak256::digest(&p.as_bytes()[1..]);
    Ok(format!("0x{}", crypto::hex(&hash[12..])))
}
pub async fn verify<R: PaymentRpc>(
    rpc: &R,
    payer: &str,
    block: u64,
    message: &str,
    bytes: &[u8],
) -> Result<bool> {
    let tag = quantity(block);
    let code = rpc.call(Method::Code, json!([payer, tag])).await?;
    let code = code.as_str().ok_or_else(bad)?;
    let b = super::evm_verify::data_hex(code).map_err(|_| bad())?;
    if b.len() > 65536 {
        return Err(bad());
    }
    let d = digest(message);
    if b.is_empty() {
        if recover(&d, bytes)? != payer {
            return Err(bad());
        }
        return Ok(false);
    }
    // isValidSignature(bytes32,bytes)标准ABI；不接受调用者自定义calldata/to或gas。
    let mut data = vec![0x16, 0x26, 0xba, 0x7e];
    data.extend(d);
    let mut offset = [0; 32];
    offset[31] = 64;
    data.extend(offset);
    let mut length = [0; 32];
    length[24..].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
    data.extend(length);
    data.extend(bytes);
    data.resize(4 + 96 + bytes.len().div_ceil(32) * 32, 0);
    let v=rpc.call(Method::Call,json!([{"to":payer,"data":format!("0x{}",crypto::hex(&data)),"gas":"0x7a120"},quantity(block)])).await?;
    let out = super::evm_verify::data_hex(v.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
    if out.len() != 32 || out[..4] != [0x16, 0x26, 0xba, 0x7e] || out[4..].iter().any(|x| *x != 0) {
        return Err(bad());
    }
    Ok(true)
}
pub fn bad() -> Error {
    Error::new(403, "topup_payer_authorization_invalid")
}
