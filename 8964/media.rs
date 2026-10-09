use super::{
    storage::{Bucket, Direct, Storage},
    upload_validation::{self, Kind},
};
use crate::shared::{crypto, Error, Result};
use serde_json::json;
/// R2 的完整校验和与签名元数据是源文件事实；视频只解析前缀，不重新下载整个文件。
pub async fn verify<S: Storage>(
    storage: &S,
    plan: &Direct,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<u32>,
) -> Result<()> {
    let meta = storage
        .head(Bucket::Public, &plan.object_key)
        .await?
        .ok_or(Error::new(409, "media_not_found"))?;
    if meta.key != plan.object_key
        || meta.byte_size != plan.byte_size
        || meta.content_type != plan.content_type
        || meta.sha256 != plan.sha256
        || meta.custom.get("upload_id") != Some(&plan.upload_id)
        || meta.custom.get("media_index") != Some(&plan.media_index.to_string())
        || meta.custom.get("object_role") != Some(&plan.object_role)
    {
        return Err(Error::new(409, "media_object_mismatch"));
    }
    let limit = if plan.content_type == "video/mp4" {
        4 * 1024 * 1024
    } else {
        4_000_000
    };
    if plan.content_type != "video/mp4" && plan.byte_size > limit {
        return Err(upload_validation::invalid());
    }
    let raw = storage
        .read(
            Bucket::Public,
            &plan.object_key,
            0,
            plan.byte_size.min(limit),
        )
        .await?;
    if raw.len() as u64 != plan.byte_size.min(limit) {
        return Err(Error::new(503, "media_read_incomplete"));
    }
    if plan.content_type == "image/webp" {
        if crypto::sha256_hex(&raw) != plan.sha256 {
            return Err(Error::new(409, "media_hash_mismatch"));
        }
        let (w, h) = upload_validation::webp(&raw)?;
        if width.is_some_and(|x| x != w) || height.is_some_and(|x| x != h) {
            return Err(upload_validation::invalid());
        }
        if width.is_none() && (w > 2560 || h > 2560) {
            return Err(upload_validation::invalid());
        }
    } else {
        let fact = upload_validation::hevc(&raw, plan.byte_size)?;
        if width != Some(fact.width)
            || height != Some(fact.height)
            || duration != Some(fact.duration_seconds)
        {
            return Err(upload_validation::invalid());
        }
    }
    Ok(())
}
pub fn plans(upload: &super::uploads::Upload) -> Result<Vec<Direct>> {
    let mut plans = vec![];
    for (index, item) in upload.media_items.iter().enumerate() {
        let (key, derivative) = super::objects::media_keys(
            &upload.cid_number,
            &upload.post_id,
            index as u32,
            item.media_kind == Kind::Video,
        )?;
        plans.push(Direct {
            object_key: key,
            content_type: item.content_type.clone(),
            byte_size: item.byte_size,
            sha256: item.sha256.clone(),
            upload_id: upload.upload_id.clone(),
            media_index: index as u32,
            object_role: "source".into(),
            expires_at: upload.expires_at,
        });
        plans.push(Direct {
            object_key: derivative,
            content_type: item.derivative_content_type.clone(),
            byte_size: item.derivative_byte_size,
            sha256: item.derivative_sha256.clone(),
            upload_id: upload.upload_id.clone(),
            media_index: index as u32,
            object_role: item.derivative_kind.clone(),
            expires_at: upload.expires_at,
        });
    }
    Ok(plans)
}
pub fn public_url(origin: &str, key: &str) -> Result<String> {
    let url = url::Url::parse(origin).map_err(|_| Error::new(503, "media_not_configured"))?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != origin
        || !key.starts_with("square/")
        || key.contains("..")
        || key
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && !matches!(b, b'/' | b'.' | b'_' | b'-'))
    {
        return Err(Error::new(503, "media_not_configured"));
    }
    Ok(format!("{origin}/{key}"))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}
pub fn range(raw: Option<&str>, size: u64) -> Result<ByteRange> {
    let invalid = || Error::new(416, "invalid_range");
    if size == 0 {
        return Err(invalid());
    }
    let Some(raw) = raw else {
        return Ok(ByteRange {
            offset: 0,
            length: size,
        });
    };
    let (start, end) = raw
        .strip_prefix("bytes=")
        .and_then(|s| s.split_once('-'))
        .filter(|(s, e)| !s.contains(',') && !e.contains(','))
        .ok_or_else(invalid)?;
    fn number(s: &str) -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    }
    let (offset, last) = if start.is_empty() {
        let n = number(end).filter(|n| *n > 0).ok_or_else(invalid)?;
        (size.saturating_sub(n), size - 1)
    } else {
        let s = number(start).filter(|n| *n < size).ok_or_else(invalid)?;
        let e = if end.is_empty() {
            size - 1
        } else {
            number(end).ok_or_else(invalid)?.min(size - 1)
        };
        if e < s {
            return Err(invalid());
        }
        (s, e)
    };
    Ok(ByteRange {
        offset,
        length: last - offset + 1,
    })
}
pub fn deleted(pending: bool) -> serde_json::Value {
    json!({"ok":true,"deleted":!pending,"pending":pending})
}

/// SigV4 的路径、查询和全部约束头都参与签名；完整SHA-256由R2校验，而非信任自定义元数据。
pub fn sign_put(
    account: &str,
    access_key: &str,
    secret: &str,
    stamp: &str,
    plan: &Direct,
    now: u64,
) -> Result<super::storage::SignedPut> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::collections::BTreeMap;
    let fail = || Error::new(503, "r2_upload_signing_not_configured");
    if account.len() != 32
        || !account.bytes().all(|b| b.is_ascii_hexdigit())
        || access_key.is_empty()
        || secret.is_empty()
        || stamp.len() != 16
        || stamp.as_bytes()[8] != b'T'
        || stamp.as_bytes()[15] != b'Z'
        || !stamp
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 8 || i == 15 || b.is_ascii_digit())
        || plan.expires_at <= now
        || plan.expires_at > now.saturating_add(900000)
        || !crate::shared::ids::hex(&plan.sha256, 32, false)
        || plan.byte_size == 0
        || !super::routes::identifier(&plan.upload_id)
    {
        return Err(fail());
    }
    public_url("https://media.crcfrcn.com", &plan.object_key)?;
    fn encode(s: &str, path: bool) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric()
                    || matches!(b, b'-' | b'_' | b'.' | b'~')
                    || path && b == b'/'
                {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }
    let host = format!("{account}.r2.cloudflarestorage.com");
    let path = format!("/citizenserve-media/{}", encode(&plan.object_key, true));
    let mut headers = BTreeMap::from([
        ("host".into(), host.clone()),
        ("content-type".into(), plan.content_type.clone()),
        ("content-length".into(), plan.byte_size.to_string()),
        (
            "cache-control".into(),
            "public, max-age=31536000, immutable".into(),
        ),
        ("if-none-match".into(), "*".into()),
        (
            "x-amz-checksum-sha256".into(),
            STANDARD.encode(crypto::unhex(&plan.sha256)?),
        ),
        ("x-amz-meta-sha256".into(), plan.sha256.clone()),
        ("x-amz-meta-upload-id".into(), plan.upload_id.clone()),
        (
            "x-amz-meta-media-index".into(),
            plan.media_index.to_string(),
        ),
        ("x-amz-meta-object-role".into(), plan.object_role.clone()),
    ]);
    let signed_headers = headers.keys().cloned().collect::<Vec<String>>().join(";");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect::<String>();
    let scope = format!("{}/auto/s3/aws4_request", &stamp[..8]);
    let expires = (plan.expires_at - now).div_ceil(1000).min(900);
    let query = BTreeMap::from([
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_owned()),
        ("X-Amz-Credential", format!("{access_key}/{scope}")),
        ("X-Amz-Date", stamp.into()),
        ("X-Amz-Expires", expires.to_string()),
        ("X-Amz-SignedHeaders", signed_headers.clone()),
    ]);
    let query = query
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k, false), encode(v, false)))
        .collect::<Vec<_>>()
        .join("&");
    let canonical =
        format!("PUT\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\nUNSIGNED-PAYLOAD");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
        crypto::sha256_hex(canonical.as_bytes())
    );
    let date = crypto::hmac_sha256(format!("AWS4{secret}").as_bytes(), &stamp.as_bytes()[..8]);
    let region = crypto::hmac_sha256(&date, b"auto");
    let service = crypto::hmac_sha256(&region, b"s3");
    let key = crypto::hmac_sha256(&service, b"aws4_request");
    let signature = crypto::hex(&crypto::hmac_sha256(&key, to_sign.as_bytes()));
    headers.remove("host");
    Ok(super::storage::SignedPut {
        url: format!("https://{host}{path}?{query}&X-Amz-Signature={signature}"),
        headers,
        method: "PUT".into(),
        expires_at: plan.expires_at,
    })
}
