//! 发布签实际/api路径及原始正文。revision CAS防覆盖；只存公开发布指针。
use super::routes::{DownloadRoute, Platform};
use crate::shared::{crypto, ids, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub version_tag: String,
    pub source_sha: String,
    pub asset_name: String,
    pub asset_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Row {
    pub platform: String,
    pub version_tag: Option<String>,
    pub source_sha: Option<String>,
    pub asset_name: Option<String>,
    pub asset_sha256: Option<String>,
    pub revision: u64,
    pub published_at: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub expected_revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub publication: Option<Publication>,
}
pub fn version(s: &str) -> bool {
    let p = s.split('.').collect::<Vec<_>>();
    p.len() == 3
        && p.iter().enumerate().all(|(i, s)| {
            !s.is_empty()
                && s.len() <= if i == 0 { 9 } else { 2 }
                && s.bytes().all(|b| b.is_ascii_digit())
        })
}
impl Publication {
    pub fn validate(&self, p: Platform) -> Result<()> {
        let prefix = format!("citizenchain-{}-v", p.name());
        let v = self.version_tag.strip_prefix(&prefix).ok_or_else(invalid)?;
        let (a, e) = p.asset();
        if !version(v)
            || self.asset_name != format!("citizenchain-node-{a}-v{v}.{e}")
            || !ids::hex(&self.source_sha, 20, false)
            || !ids::hex(&self.asset_sha256, 32, false)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
impl Row {
    pub fn value(&self, p: Platform) -> Result<Option<Publication>> {
        if self.platform != p.name() || self.revision > 9_007_199_254_740_991 {
            return Err(invalid());
        }
        match (
            &self.version_tag,
            &self.source_sha,
            &self.asset_name,
            &self.asset_sha256,
            self.published_at,
        ) {
            (None, None, None, None, None) => Ok(None),
            (Some(t), Some(s), Some(a), Some(h), Some(n)) if n > 0 => {
                let v = Publication {
                    version_tag: t.clone(),
                    source_sha: s.clone(),
                    asset_name: a.clone(),
                    asset_sha256: h.clone(),
                };
                v.validate(p)?;
                Ok(Some(v))
            }
            _ => Err(invalid()),
        }
    }
}
pub fn invalid() -> Error {
    Error::new(400, "publication_identity_invalid")
}
pub fn canonical(method: &str, path: &str, time: &str, nonce: &str, body: &[u8]) -> Result<String> {
    if !DownloadRoute::resolve(method, path.strip_prefix("/api").ok_or_else(invalid)?)
        .is_some_and(|r| r.publication())
        || !ids::hex(nonce, 16, false)
        || time.is_empty()
        || time.len() > 16
        || !time.bytes().all(|b| b.is_ascii_digit())
        || time.starts_with('0')
        || body.len() > 16384
        || method == "GET" && !body.is_empty()
    {
        return Err(invalid());
    }
    Ok(format!(
        "{method}\n{path}\n{time}\n{nonce}\n{}",
        crypto::sha256_hex(body)
    ))
}
#[allow(clippy::too_many_arguments)] // 将独立可信端口与准确请求字段显式传入，不能隐藏授权来源。
pub fn authorize(
    key: &[u8],
    method: &str,
    path: &str,
    time: &str,
    nonce: &str,
    signature: &str,
    body: &[u8],
    now: u64,
) -> Result<()> {
    if !(32..=4096).contains(&key.len()) {
        return Err(Error::new(503, "publication_auth_unavailable"));
    }
    let bad = || Error::new(401, "publication_signature_invalid");
    let message = canonical(method, path, time, nonce, body).map_err(|_| bad())?;
    let t = time.parse::<u64>().map_err(|_| bad())?;
    if t > 9_007_199_254_740_991
        || now.abs_diff(t) > 300000
        || !ids::hex(signature, 32, false)
        || !crypto::equal_secret(
            &crypto::hmac_sha256(key, message.as_bytes()),
            &crypto::unhex(signature).map_err(|_| bad())?,
        )
    {
        return Err(bad());
    }
    Ok(())
}
