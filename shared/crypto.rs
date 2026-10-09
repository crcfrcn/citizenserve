use super::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use blake2::{digest::consts::U32, Blake2b};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex(value: &str) -> Result<Vec<u8>> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::new(400, "invalid_hex"));
    }
    (0..value.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| Error::new(400, "invalid_hex"))
        })
        .collect()
}
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&sha256(bytes))
}
pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn unbase64url(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.is_empty()
        || value.len() > limit.div_ceil(3) * 4
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::new(400, "invalid_base64url"));
    }
    let out = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::new(400, "invalid_base64url"))?;
    if out.len() > limit || base64url(&out) != value {
        return Err(Error::new(400, "invalid_base64url"));
    }
    Ok(out)
}
pub fn secret_hash(value: &str) -> Result<String> {
    if unbase64url(value, 32)?.len() != 32 {
        return Err(Error::new(400, "invalid_secret"));
    }
    Ok(sha256_hex(value.as_bytes()))
}
pub fn equal_secret(left: &[u8], right: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    bool::from(left.ct_eq(right))
}
pub fn hmac_sha256(secret: &[u8], bytes: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("HMAC supports every key length");
    mac.update(bytes);
    mac.finalize().into_bytes().into()
}
/// 与 CitizenChain 唯一 GMB 原语相同，不能换成普通字符串签名域。
pub fn signing_message(tag: u8, payload: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(b"GMB");
    hasher.update([tag]);
    hasher.update(payload);
    hasher.finalize().into()
}
pub fn scale_compact(value: u32) -> Result<Vec<u8>> {
    Ok(if value < 64 {
        vec![(value as u8) << 2]
    } else if value < 16384 {
        ((value << 2 | 1) as u16).to_le_bytes().to_vec()
    } else if value < 1 << 30 {
        (value << 2 | 2).to_le_bytes().to_vec()
    } else {
        return Err(Error::new(400, "scale_length_exceeded"));
    })
}
pub fn scale_string(value: &str) -> Result<Vec<u8>> {
    let mut out = scale_compact(
        value
            .len()
            .try_into()
            .map_err(|_| Error::new(400, "scale_length_exceeded"))?,
    )?;
    out.extend_from_slice(value.as_bytes());
    Ok(out)
}
pub fn tls_vector(value: &[u8]) -> Result<Vec<u8>> {
    let n = value.len();
    let mut out = if n < 64 {
        vec![n as u8]
    } else if n < 16384 {
        vec![0x40 | (n >> 8) as u8, n as u8]
    } else if n < 1 << 30 {
        ((n as u32) | 0x8000_0000).to_be_bytes().to_vec()
    } else {
        return Err(Error::new(400, "tls_length_exceeded"));
    };
    out.extend_from_slice(value);
    Ok(out)
}
