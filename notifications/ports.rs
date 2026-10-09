use super::{
    delivery::{AuthorizedEndpoint, Outcome},
    endpoint::{Register, Stored},
    fanout::Page,
    jobs::{Delivery, Disposition, Job, Lease, Message},
};
use crate::{shared::Result, user::profile_service::Authorization};
use std::future::Future;
pub trait Clock {
    fn now(&self) -> u64;
}
pub trait Endpoints {
    fn register(
        &self,
        auth: &Authorization,
        input: &Register,
    ) -> impl Future<Output = Result<Stored>> + Send;
    fn remove(&self, auth: &Authorization) -> impl Future<Output = Result<()>> + Send;
}
pub trait Jobs {
    fn claim(
        &self,
        message: &Message,
        nonce: &str,
        now: u64,
    ) -> impl Future<Output = Result<Option<Lease>>> + Send;
    fn disposition(
        &self,
        message: &Message,
        now: u64,
    ) -> impl Future<Output = Result<Disposition>> + Send;
    fn job(&self, id: &str) -> impl Future<Output = Result<Option<Job>>> + Send;
    fn page(&self, job: &Job, now: u64) -> impl Future<Output = Result<Page>> + Send;
    fn commit_page(
        &self,
        lease: &Lease,
        job: &Job,
        page: &Page,
        now: u64,
    ) -> impl Future<Output = Result<()>> + Send;
    fn delivery(&self, id: &str) -> impl Future<Output = Result<Option<Delivery>>> + Send;
    fn finish(
        &self,
        lease: &Lease,
        outcome: &Outcome,
        now: u64,
    ) -> impl Future<Output = Result<()>> + Send;
}
pub trait Verifier {
    fn authorize(
        &self,
        job: &Job,
        delivery: &Delivery,
        now: u64,
    ) -> impl Future<Output = Result<Option<AuthorizedEndpoint>>> + Send;
}
pub trait Sender {
    fn send(
        &self,
        endpoint: &AuthorizedEndpoint,
        payload: &serde_json::Value,
        collapse: &str,
    ) -> impl Future<Output = Result<Outcome>> + Send;
}
