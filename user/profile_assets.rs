//! 固定本人键使用持久代际和 R2 条件写；写入中禁止签发下一代，失败保留凭据供重试。
use crate::{
    shared::{crypto, Error, Result},
    square::{
        media,
        storage::{Bucket, Put, Storage},
        upload_validation,
    },
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future};
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Avatar,
    Banner,
}
impl Kind {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Avatar => "avatar",
            Self::Banner => "banner",
        }
    }
    pub const fn limit(self) -> usize {
        match self {
            Self::Avatar => 512 * 1024,
            Self::Banner => 1536 * 1024,
        }
    }
    pub fn key(self, cid: &str) -> Result<String> {
        crate::shared::ids::cid(cid)?;
        Ok(format!("profile/{cid}/{}", self.name()))
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    pub kind: Kind,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Credential {
    pub upload_id: String,
    pub cid_number: String,
    pub kind: Kind,
    pub object_key: String,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub generation: u64,
    pub prior_etag: Option<String>,
    pub object_etag: Option<String>,
    pub state: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
}
pub trait Repository {
    fn reserve(
        &self,
        auth: &Authorization,
        credential: &Credential,
    ) -> impl Future<Output = Result<Credential>> + Send;
    fn claim(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl Future<Output = Result<Credential>> + Send;
    fn complete(
        &self,
        auth: &Authorization,
        credential: &Credential,
        etag: &str,
    ) -> impl Future<Output = Result<()>> + Send;
    fn referenced(
        &self,
        auth: &Authorization,
        cid: &str,
        kind: Kind,
    ) -> impl Future<Output = Result<Option<String>>> + Send;
}
pub async fn prepare<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    input: Prepare,
    entropy: [u8; 16],
) -> Result<Value> {
    if input.content_type != "image/webp"
        || input.byte_size == 0
        || input.byte_size > input.kind.limit() as u64
        || !crate::shared::ids::hex(&input.sha256, 32, false)
    {
        return Err(Error::new(400, "invalid_profile_asset"));
    }
    let key = input.kind.key(auth.cid())?;
    let old = storage.head(Bucket::Private, &key).await?;
    let c = Credential {
        upload_id: format!("spa_{}", crypto::hex(&entropy)),
        cid_number: auth.cid().into(),
        kind: input.kind,
        object_key: key,
        content_type: input.content_type,
        byte_size: input.byte_size,
        sha256: input.sha256,
        generation: 0,
        prior_etag: old.map(|o| o.etag),
        object_etag: None,
        state: "prepared".into(),
        created_at: auth.now(),
        expires_at: auth.now().saturating_add(900000),
        started_at: None,
        completed_at: None,
    };
    let c = repo.reserve(auth, &c).await?;
    Ok(
        json!({"ok":true,"upload_id":c.upload_id,"object_key":c.object_key,"expires_at":c.expires_at,"upload_url":format!("/api/user/profile/assets/{}",c.upload_id),"method":"PUT"}),
    )
}
pub async fn upload<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    id: &str,
    raw: Vec<u8>,
) -> Result<Value> {
    let c = repo.claim(auth, id).await?;
    if c.cid_number != auth.cid()
        || raw.len() as u64 != c.byte_size
        || raw.len() > c.kind.limit()
        || crypto::sha256_hex(&raw) != c.sha256
    {
        return Err(Error::new(409, "profile_asset_mismatch"));
    }
    let (w, h) = upload_validation::webp(&raw)?;
    let (maxw, maxh) = match c.kind {
        Kind::Avatar => (1024, 1024),
        Kind::Banner => (1920, 720),
    };
    if w > maxw || h > maxh {
        return Err(Error::new(400, "invalid_profile_asset_dimensions"));
    }
    let old = storage.head(Bucket::Private, &c.object_key).await?;
    let same = old.as_ref().filter(|o| {
        o.sha256 == c.sha256
            && o.custom.get("upload_id") == Some(&c.upload_id)
            && o.custom.get("generation") == Some(&c.generation.to_string())
    });
    let etag = if let Some(old) = same {
        old.etag.clone()
    } else {
        if old.as_ref().map(|o| &o.etag) != c.prior_etag.as_ref() {
            return Err(Error::new(409, "profile_asset_conflict"));
        }
        storage
            .put(
                Bucket::Private,
                Put {
                    key: c.object_key.clone(),
                    bytes: raw,
                    content_type: c.content_type.clone(),
                    sha256: c.sha256.clone(),
                    custom: BTreeMap::from([
                        ("upload_id".into(), c.upload_id.clone()),
                        ("generation".into(), c.generation.to_string()),
                    ]),
                    previous_etag: c.prior_etag.clone(),
                },
            )
            .await?
            .etag
    };
    repo.complete(auth, &c, &etag).await?;
    Ok(json!({"ok":true,"object_key":c.object_key,"content_hash":c.sha256,"byte_size":c.byte_size}))
}
pub struct Read {
    pub bytes: Vec<u8>,
    pub status: u16,
    pub etag: String,
    pub content_range: Option<String>,
}
// HTTP三个条件头分别处理，不能合并后改变Range/ETag语义。
#[allow(clippy::too_many_arguments)]
pub async fn read<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    cid: &str,
    kind: Kind,
    range: Option<&str>,
    if_none: Option<&str>,
    if_range: Option<&str>,
) -> Result<Read> {
    crate::shared::ids::cid(cid)?;
    let hash = repo
        .referenced(auth, cid, kind)
        .await?
        .ok_or(Error::new(404, "profile_asset_not_found"))?;
    let key = kind.key(cid)?;
    let meta = storage
        .head(Bucket::Private, &key)
        .await?
        .ok_or(Error::new(404, "profile_asset_not_found"))?;
    if meta.sha256 != hash
        || meta.content_type != "image/webp"
        || meta.byte_size == 0
        || meta.byte_size > kind.limit() as u64
    {
        return Err(Error::new(409, "profile_asset_reference_mismatch"));
    }
    let etag = format!("\"{hash}\"");
    if if_none.is_some_and(|e| e == etag || e == "*") {
        return Ok(Read {
            bytes: vec![],
            status: 304,
            etag,
            content_range: None,
        });
    }
    let range = range.filter(|_| if_range.is_none_or(|e| e == etag));
    let selected = media::range(range, meta.byte_size)?;
    // 私有头像/背景最多1536KiB：完整哈希通过后再做 Range，避免交付未经验证的片段。
    let bytes = storage
        .read(Bucket::Private, &key, 0, meta.byte_size)
        .await?;
    if bytes.len() as u64 != meta.byte_size || crypto::sha256_hex(&bytes) != hash {
        return Err(Error::new(409, "profile_asset_hash_mismatch"));
    }
    upload_validation::webp(&bytes)?;
    Ok(Read {
        bytes: bytes[selected.offset as usize..(selected.offset + selected.length) as usize]
            .to_vec(),
        status: if range.is_some() { 206 } else { 200 },
        etag,
        content_range: range.map(|_| {
            format!(
                "bytes {}-{}/{}",
                selected.offset,
                selected.offset + selected.length - 1,
                meta.byte_size
            )
        }),
    })
}
