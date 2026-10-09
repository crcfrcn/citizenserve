//! 公开资料保持CID归属；写端口同时核验授权与旧值，防止遗漏字段被并发更新覆盖。
use crate::{
    server::guard::Authority,
    shared::{ids, Error, Result},
    user::{auth::session, profiles, registration::protocol::Config},
};
use serde::{Deserialize, Serialize};
use std::future::Future;
#[derive(Clone, Debug, Serialize)]
pub struct Authorization {
    cid_number: String,
    account_id: String,
    binding_revision: u64,
    device_id: String,
    session_token_hash: String,
    registration_scope: String,
    service_origin: String,
    chain_scope: String,
    institution: crate::user::registration::protocol::Institution,
    now: u64,
}
impl Authorization {
    pub fn new(authority: &Authority, config: &Config, token: &str, now: u64) -> Result<Self> {
        let i = authority.identity();
        i.require_current(now)?;
        if authority.session_deadline() <= now || i.chain_scope != config.chain_scope {
            return Err(Error::new(401, "invalid_session"));
        }
        Ok(Self {
            cid_number: i.cid_number.clone(),
            account_id: i.account_id.clone(),
            binding_revision: i.binding_revision,
            device_id: authority.device_id().into(),
            session_token_hash: session::hash(token)?,
            registration_scope: config.registration_scope.clone(),
            service_origin: config.service_origin.clone(),
            chain_scope: config.chain_scope.clone(),
            institution: i.institution,
            now,
        })
    }
    pub fn cid(&self) -> &str {
        &self.cid_number
    }
    pub fn device(&self) -> &str {
        &self.device_id
    }
    pub fn account(&self) -> &str {
        &self.account_id
    }
    pub fn revision(&self) -> u64 {
        self.binding_revision
    }
    pub fn now(&self) -> u64 {
        self.now
    }
}
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Field {
    #[default]
    Missing,
    Null,
    Value(String),
}
impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Ok(Option::<String>::deserialize(d)?
            .map(Self::Value)
            .unwrap_or(Self::Null))
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    #[serde(default)]
    pub display_name: Field,
    #[serde(default)]
    pub bio: Field,
    #[serde(default)]
    pub avatar_object_key: Field,
    #[serde(default)]
    pub avatar_content_hash: Field,
    #[serde(default)]
    pub banner_object_key: Field,
    #[serde(default)]
    pub banner_content_hash: Field,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Doc {
    pub cid_number: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_object_key: Option<String>,
    pub avatar_content_hash: Option<String>,
    pub banner_object_key: Option<String>,
    pub banner_content_hash: Option<String>,
    pub updated_at: u64,
}
impl Doc {
    pub fn empty(cid: &str) -> Self {
        Self {
            cid_number: cid.into(),
            display_name: String::new(),
            bio: String::new(),
            avatar_object_key: None,
            avatar_content_hash: None,
            banner_object_key: None,
            banner_content_hash: None,
            updated_at: 0,
        }
    }
    /// 这里只验证资料合同；仓库在同一写事务内核对新媒体哈希的已完成、当前代际事实。
    pub fn apply(&self, update: &Update, now: u64) -> Result<Self> {
        ids::cid(&self.cid_number)?;
        fn text(f: &Field, old: &str, max: usize) -> Result<String> {
            let s = match f {
                Field::Missing => old,
                Field::Null => return Err(Error::new(400, "invalid_profile_field")),
                Field::Value(v) => profiles::trim(v),
            };
            if s.encode_utf16().count() > max {
                return Err(Error::new(400, "profile_field_too_long"));
            }
            Ok(s.into())
        }
        fn asset(f: &Field, old: &Option<String>, expected: &str) -> Result<Option<String>> {
            match f {
                Field::Missing => Ok(old.clone()),
                Field::Null => Ok(None),
                Field::Value(v) if v.is_empty() => Ok(None),
                Field::Value(v) if v == expected => Ok(Some(v.clone())),
                _ => Err(Error::new(400, "invalid_asset_key")),
            }
        }
        fn hash(f: &Field, old: &Option<String>) -> Result<Option<String>> {
            match f {
                Field::Missing => Ok(old.clone()),
                Field::Null => Ok(None),
                Field::Value(v) if v.is_empty() => Ok(None),
                Field::Value(v) if v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()) => {
                    Ok(Some(v.to_ascii_lowercase()))
                }
                _ => Err(Error::new(400, "invalid_profile_content_hash")),
            }
        }
        let next = Self {
            cid_number: self.cid_number.clone(),
            display_name: text(&update.display_name, &self.display_name, 40)?,
            bio: text(&update.bio, &self.bio, 160)?,
            avatar_object_key: asset(
                &update.avatar_object_key,
                &self.avatar_object_key,
                &profiles::asset_key(&self.cid_number, "avatar")?,
            )?,
            avatar_content_hash: hash(&update.avatar_content_hash, &self.avatar_content_hash)?,
            banner_object_key: asset(
                &update.banner_object_key,
                &self.banner_object_key,
                &profiles::asset_key(&self.cid_number, "banner")?,
            )?,
            banner_content_hash: hash(&update.banner_content_hash, &self.banner_content_hash)?,
            updated_at: now,
        };
        if next.avatar_object_key.is_some() != next.avatar_content_hash.is_some()
            || next.banner_object_key.is_some() != next.banner_content_hash.is_some()
        {
            return Err(Error::new(400, "invalid_profile_asset_pair"));
        }
        Ok(next)
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counts {
    pub following: u64,
    pub followers: u64,
    pub mutual_following: u64,
    pub posts: u64,
    pub campaigns: u64,
    pub videos: u64,
    pub articles: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub account_id: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_object_key: Option<String>,
    pub banner_object_key: Option<String>,
    pub cid_number: String,
    pub is_certified: bool,
    pub identity_level: crate::user::identity::IdentityLevel,
    pub membership_level: Option<crate::membership::Level>,
    pub membership_active: bool,
    pub counts: Counts,
    pub is_following: bool,
    pub is_followed_by: bool,
    pub is_notifying: bool,
    pub updated_at: u64,
}
pub trait Repository {
    fn doc(&self, cid: &str) -> impl Future<Output = Result<Option<Doc>>> + Send;
    fn profile(
        &self,
        target: &str,
        viewer: &str,
        now: u64,
    ) -> impl Future<Output = Result<Option<Profile>>> + Send;
    fn write(
        &self,
        auth: &Authorization,
        before: &Doc,
        after: &Doc,
    ) -> impl Future<Output = Result<bool>> + Send;
}
pub async fn read<R: Repository>(
    repo: &R,
    auth: &Authorization,
    target: &str,
) -> Result<serde_json::Value> {
    ids::cid(target)?;
    let p = repo
        .profile(target, auth.cid(), auth.now())
        .await?
        .ok_or(Error::new(404, "user_not_found"))?;
    Ok(serde_json::json!({"ok":true,"profile":p}))
}
pub async fn update<R: Repository>(
    repo: &R,
    auth: &Authorization,
    input: &Update,
) -> Result<serde_json::Value> {
    let before = repo
        .doc(auth.cid())
        .await?
        .unwrap_or_else(|| Doc::empty(auth.cid()));
    let after = before.apply(input, auth.now())?;
    if !repo.write(auth, &before, &after).await? {
        return Err(Error::new(409, "profile_conflict"));
    }
    read(repo, auth, auth.cid()).await
}
