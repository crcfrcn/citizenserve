//! 控制面状态机：事务预留在先，R2完整核验在前，单次预留转实耗在后。
use super::{
    manifest, media, objects,
    storage::{Bucket, Put, Storage},
    upload_validation::{self, Item, PostType},
};
use crate::{
    chain::subscription::Current,
    shared::{crypto, Error, Result},
    user::profile_service::Authorization,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    pub post_type: PostType,
    pub title_length: usize,
    pub text_length: usize,
    pub manifest_hash: String,
    pub manifest_byte_size: u64,
    pub media_items: Vec<Item>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Upload {
    pub upload_id: String,
    pub post_id: String,
    pub cid_number: String,
    pub account_id: String,
    pub post_type: PostType,
    pub manifest_hash: String,
    pub manifest_byte_size: u64,
    pub content_hash: Option<String>,
    pub storage_receipt_id: String,
    pub estimated_bytes: u64,
    pub status: String,
    pub expires_at: u64,
    pub created_at: u64,
    pub completed_at: Option<u64>,
    pub media_items: Vec<Item>,
}
impl Upload {
    pub fn owner(&self, auth: &Authorization) -> Result<()> {
        if self.cid_number != auth.cid() {
            Err(Error::new(403, "upload_owner_mismatch"))
        } else {
            Ok(())
        }
    }
    pub fn writable(&self, now: u64) -> Result<()> {
        if !matches!(self.status.as_str(), "prepared" | "uploading") || self.expires_at <= now {
            Err(Error::new(409, "upload_not_writable"))
        } else {
            Ok(())
        }
    }
    pub fn keys(&self) -> Result<(Vec<String>, Vec<String>)> {
        Ok((
            vec![objects::manifest_key(&self.cid_number, &self.post_id)?],
            media::plans(self)?
                .iter()
                .map(|p| p.object_key.clone())
                .collect(),
        ))
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Complete {
    pub manifest_hash: String,
    pub content_hash: String,
}
pub trait Repository {
    fn reserve(
        &self,
        auth: &Authorization,
        upload: &Upload,
        current: &Current,
    ) -> impl Future<Output = Result<()>> + Send;
    fn get(
        &self,
        auth: &Authorization,
        id: &str,
    ) -> impl Future<Output = Result<Option<Upload>>> + Send;
    fn manifest_written(
        &self,
        auth: &Authorization,
        upload: &Upload,
    ) -> impl Future<Output = Result<()>> + Send;
    fn complete(
        &self,
        auth: &Authorization,
        upload: &Upload,
        current: &Current,
    ) -> impl Future<Output = Result<()>> + Send;
    fn start_delete(
        &self,
        auth: &Authorization,
        upload: &Upload,
        post: bool,
    ) -> impl Future<Output = Result<()>> + Send;
    fn finish_delete(
        &self,
        auth: &Authorization,
        upload: &Upload,
    ) -> impl Future<Output = Result<()>> + Send;
}
pub async fn get<R: Repository>(repo: &R, auth: &Authorization, id: &str) -> Result<Upload> {
    if !super::routes::identifier(id) {
        return Err(Error::new(400, "invalid_upload_id"));
    }
    let u = repo
        .get(auth, id)
        .await?
        .ok_or(Error::new(404, "upload_not_found"))?;
    u.owner(auth)?;
    Ok(u)
}
pub async fn prepare<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    input: Prepare,
    current: &Current,
    entropy: [u8; 32],
) -> Result<Value> {
    let level = current.level(auth.now())?;
    if !crate::shared::ids::hex(&input.manifest_hash, 32, false)
        || input.manifest_byte_size == 0
        || input.manifest_byte_size > 262144
    {
        return Err(Error::new(400, "invalid_manifest"));
    }
    upload_validation::content(
        input.post_type,
        input.title_length,
        input.text_length,
        &input.media_items,
        level,
    )?;
    let estimated = input
        .media_items
        .iter()
        .try_fold(input.manifest_byte_size, |n, m| {
            n.checked_add(m.byte_size)?
                .checked_add(m.derivative_byte_size)
        })
        .ok_or_else(upload_validation::invalid)?;
    let id = format!("squ_{}", crypto::hex(&entropy[..16]));
    let post_id = format!("sqp_{}", crypto::hex(&entropy[16..]));
    let receipt = format!(
        "sqr_{}",
        crypto::sha256_hex(
            format!("{id}:{post_id}:{}:{}", auth.cid(), input.manifest_hash).as_bytes()
        )
    );
    let upload = Upload {
        upload_id: id,
        post_id,
        cid_number: auth.cid().into(),
        account_id: auth.account().into(),
        post_type: input.post_type,
        manifest_hash: input.manifest_hash,
        manifest_byte_size: input.manifest_byte_size,
        content_hash: None,
        storage_receipt_id: receipt,
        estimated_bytes: estimated,
        status: "prepared".into(),
        expires_at: auth.now().saturating_add(900000),
        created_at: auth.now(),
        completed_at: None,
        media_items: input.media_items,
    };
    repo.reserve(auth, &upload, current).await?;
    // URL签发失败仍保留15分钟预留，可取消/过期回收，不丢失对象依据。
    let mut signed = vec![];
    for p in media::plans(&upload)? {
        signed.push(json!({"object_key":p.object_key,"object_role":p.object_role,"media_index":p.media_index,"upload":storage.sign(&p,auth.now()).await?}));
    }
    Ok(
        json!({"ok":true,"upload_id":upload.upload_id,"post_id":upload.post_id,"storage_receipt_id":upload.storage_receipt_id,"expires_at":upload.expires_at,"estimated_bytes":estimated,"manifest":{"object_key":objects::manifest_key(auth.cid(),&upload.post_id)?,"upload_url":format!("/api/8964/uploads/{}/manifest",upload.upload_id)},"media_uploads":signed}),
    )
}
pub async fn put_manifest<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    id: &str,
    raw: Vec<u8>,
    current: &Current,
) -> Result<Value> {
    let u = get(repo, auth, id).await?;
    u.writable(auth.now())?;
    let m = manifest::read(&raw, auth.cid(), u.post_type, &u.manifest_hash)?;
    if raw.len() as u64 != u.manifest_byte_size {
        return Err(Error::new(409, "manifest_size_mismatch"));
    }
    manifest::validate(&m, &u.media_items, current.level(auth.now())?)?;
    let key = objects::manifest_key(auth.cid(), &u.post_id)?;
    let old = storage.head(Bucket::Private, &key).await?;
    if let Some(old) = &old {
        if old.sha256 != u.manifest_hash {
            return Err(Error::new(409, "manifest_conflict"));
        }
    }
    storage
        .put(
            Bucket::Private,
            Put {
                key,
                bytes: raw,
                content_type: "application/json".into(),
                sha256: u.manifest_hash.clone(),
                custom: BTreeMap::from([("upload_id".into(), u.upload_id.clone())]),
                previous_etag: old.map(|m| m.etag),
            },
        )
        .await?;
    repo.manifest_written(auth, &u).await?;
    Ok(json!({"ok":true,"manifest_hash":u.manifest_hash}))
}
pub async fn read_manifest<S: Storage>(
    storage: &S,
    u: &Upload,
) -> Result<(manifest::Manifest, Vec<u8>)> {
    let key = objects::manifest_key(&u.cid_number, &u.post_id)?;
    let meta = storage
        .head(Bucket::Private, &key)
        .await?
        .ok_or(Error::new(409, "manifest_not_found"))?;
    if meta.byte_size != u.manifest_byte_size
        || meta.sha256 != u.manifest_hash
        || meta.content_type != "application/json"
        || meta.custom.get("upload_id") != Some(&u.upload_id)
    {
        return Err(Error::new(409, "manifest_object_mismatch"));
    }
    let raw = storage
        .read(Bucket::Private, &key, 0, u.manifest_byte_size)
        .await?;
    let m = manifest::read(&raw, &u.cid_number, u.post_type, &u.manifest_hash)?;
    if raw.len() as u64 != u.manifest_byte_size
        || u.content_hash
            .as_ref()
            .is_some_and(|h| *h != crypto::sha256_hex(&raw))
    {
        return Err(Error::new(409, "manifest_hash_mismatch"));
    }
    Ok((m, raw))
}
pub async fn complete<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    id: &str,
    input: Complete,
    current: &Current,
) -> Result<Value> {
    let u = get(repo, auth, id).await?;
    let level = current.level(auth.now())?;
    if input.manifest_hash != u.manifest_hash || input.content_hash != u.manifest_hash {
        return Err(Error::new(409, "manifest_hash_mismatch"));
    }
    if matches!(u.status.as_str(), "completed" | "published") {
        if u.content_hash.as_deref() != Some(input.content_hash.as_str()) {
            return Err(Error::new(409, "upload_conflict"));
        }
        return Ok(
            json!({"ok":true,"upload_id":id,"post_id":u.post_id,"storage_receipt_id":u.storage_receipt_id,"content_hash":input.content_hash}),
        );
    }
    u.writable(auth.now())?;
    let (m, _) = read_manifest(storage, &u).await?;
    manifest::validate(&m, &u.media_items, level)?;
    let plans = media::plans(&u)?;
    for (i, item) in u.media_items.iter().enumerate() {
        media::verify(
            storage,
            &plans[i * 2],
            Some(item.width),
            Some(item.height),
            item.duration_seconds,
        )
        .await?;
        media::verify(storage, &plans[i * 2 + 1], None, None, None).await?;
    }
    repo.complete(auth, &u, current).await?;
    Ok(
        json!({"ok":true,"upload_id":id,"post_id":u.post_id,"storage_receipt_id":u.storage_receipt_id,"content_hash":input.content_hash}),
    )
}
pub async fn remove<R: Repository, S: Storage>(
    repo: &R,
    storage: &S,
    auth: &Authorization,
    u: &Upload,
    post: bool,
) -> Result<Value> {
    u.owner(auth)?;
    if u.status == "deleted" {
        return Ok(media::deleted(false));
    }
    repo.start_delete(auth, u, post).await?;
    let (private, public) = u.keys()?;
    storage.delete(Bucket::Public, &public).await?;
    storage.delete(Bucket::Private, &private).await?;
    storage.purge(&public).await?;
    // 仍有效的直传URL可能再写相同对象；到期前保留删除定位，不能假报彻底删除。
    if auth.now() < u.expires_at {
        return Ok(media::deleted(true));
    }
    repo.finish_delete(auth, u).await?;
    Ok(media::deleted(false))
}
