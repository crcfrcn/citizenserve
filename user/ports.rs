use crate::{
    chain::finalized::Anchor,
    shared::Result,
    user::{
        admission::Admission,
        auth::{
            challenge::{Challenge, Consumption},
            device::{Commit, Device},
            session::Session,
        },
        identity::Identity,
        registration::protocol::Config,
    },
};
/// 事务按业务语义公开，核心不依赖D1、SQLite、Worker或具体部署方式。
/// 可信仓库查询键；HTTP不能自报一个已核验的上下文。
#[derive(Clone, Copy)]
pub enum ContextKey<'a> {
    Session(&'a str),
    Device { account: &'a str, device: &'a str },
    Recovery { account: &'a str },
}
#[derive(Clone, Debug)]
pub struct AuthContext {
    pub loaded_at: u64,
    pub identity: Identity,
    pub device: Option<Device>,
    pub admission: Option<Admission>,
    pub session: Option<Session>,
    pub membership: Option<crate::membership::Record>,
    pub identity_synced_at: u64,
    pub membership_synced_at: Option<u64>,
}
impl AuthContext {
    pub fn identity_deadline(&self, config: &Config, now: u64) -> Result<u64> {
        self.identity.matches(
            &self.identity.cid_number,
            &self.identity.account_id,
            self.identity.binding_revision,
        )?;
        if self.identity.chain_scope != config.chain_scope || self.identity.checked_at_millis > now
        {
            return Err(crate::shared::Error::new(401, "cid_binding_changed"));
        }
        if self.loaded_at > now
            || now
                >= self
                    .loaded_at
                    .saturating_add(crate::server::gate::policy::SERVICE_AUTH_MILLIS)
        {
            return Err(crate::shared::Error::new(503, "authentication_unavailable"));
        }
        Ok(sync_deadline(self.identity_synced_at, now)?.min(
            self.loaded_at
                .saturating_add(crate::server::gate::policy::SERVICE_AUTH_MILLIS),
        ))
    }
}
pub fn sync_deadline(checked: u64, now: u64) -> Result<u64> {
    let deadline = checked
        .checked_add(crate::server::gate::policy::SYNC_HEALTH_MILLIS)
        .ok_or(crate::shared::Error::new(503, "authentication_unavailable"))?;
    if checked == 0 || checked > now || now >= deadline {
        return Err(crate::shared::Error::new(503, "authentication_unavailable"));
    }
    Ok(deadline)
}
pub trait AuthRepository {
    /// 一次读取完整上下文；缺失或失败不得触发查链、写投影或排队补查。
    fn context(
        &self,
        key: ContextKey<'_>,
        config: &Config,
    ) -> impl std::future::Future<Output = Result<Option<AuthContext>>> + Send;

    fn device(
        &self,
        cid: &str,
        device: &str,
    ) -> impl std::future::Future<Output = Result<Option<Device>>> + Send;
    fn admission(
        &self,
        cid: &str,
    ) -> impl std::future::Future<Output = Result<Option<Admission>>> + Send;
    fn session(
        &self,
        hash: &str,
    ) -> impl std::future::Future<Output = Result<Option<Session>>> + Send;
    fn issue_challenge(
        &self,
        challenge: &Challenge,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn consume(
        &self,
        request: &Consumption<'_>,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn activate(&self, commit: &Commit) -> impl std::future::Future<Output = Result<()>> + Send;
    fn issue_session(
        &self,
        session: &Session,
        config: &Config,
        now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}
pub trait IdentityRepository {
    fn by_account(
        &self,
        account: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send;
    fn by_cid(
        &self,
        cid: &str,
    ) -> impl std::future::Future<Output = Result<Option<Identity>>> + Send;
    fn claim_refresh(
        &self,
        cid: &str,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn project(
        &self,
        identities: &[Identity],
        cursor: Option<&Anchor>,
        previous: Option<&Anchor>,
    ) -> impl std::future::Future<Output = Result<crate::user::projection::Counts>> + Send;
    fn cursor(&self) -> impl std::future::Future<Output = Result<Option<Anchor>>> + Send;
}
