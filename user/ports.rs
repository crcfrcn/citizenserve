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
pub trait AuthRepository {
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
