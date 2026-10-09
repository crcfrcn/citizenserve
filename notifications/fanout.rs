//! 每轮只生成收件记录，不在扇出轮次调用40个推送端点。
use super::{
    jobs::{self, Cursor, Delivery, Disposition, Job, Kind, Message, State},
    ports::{Clock, Jobs},
};
use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};
pub const FOLLOWERS_PER_PAGE: usize = 5;
pub const ENDPOINTS_PER_PAGE: usize = 40;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Follower {
    pub cursor: Cursor,
    pub endpoints: Vec<super::endpoint::Stored>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Page {
    pub followers: Vec<Follower>,
    pub complete: bool,
}
impl Page {
    pub fn validate(&self, job: &Job) -> Result<()> {
        if self.followers.len() > FOLLOWERS_PER_PAGE
            || self
                .followers
                .iter()
                .map(|f| f.endpoints.len())
                .sum::<usize>()
                > ENDPOINTS_PER_PAGE
        {
            return Err(Error::new(503, "notification_page_too_large"));
        }
        let mut previous = job.cursor()?;
        for f in &self.followers {
            ids::cid(&f.cursor.cid_number)?;
            if previous.as_ref().is_some_and(|c| !f.cursor.after(c))
                || f.endpoints.len() > 8
                || f.endpoints
                    .iter()
                    .any(|e| e.cid_number != f.cursor.cid_number)
            {
                return Err(Error::new(503, "invalid_notification_page"));
            }
            previous = Some(f.cursor.clone());
        }
        Ok(())
    }
    pub fn deliveries(&self, job: &Job) -> Vec<Delivery> {
        self.followers
            .iter()
            .flat_map(|f| &f.endpoints)
            .map(|e| Delivery {
                delivery_id: jobs::id(
                    Kind::Delivery,
                    &[
                        &job.job_id,
                        &e.cid_number,
                        &e.device_id,
                        &e.endpoint_revision.to_string(),
                    ],
                ),
                job_id: job.job_id.clone(),
                cid_number: e.cid_number.clone(),
                account_id: e.account_id.clone(),
                binding_revision: e.binding_revision,
                device_id: e.device_id.clone(),
                endpoint_revision: e.endpoint_revision,
                state: State::Pending,
                attempts: 0,
            })
            .collect()
    }
}
pub async fn run<R: Jobs, C: Clock>(
    repo: &R,
    clock: &C,
    message: &Message,
    nonce: &str,
) -> Result<Disposition> {
    message.validate()?;
    if message.kind != Kind::Fanout {
        return Err(Error::new(400, "invalid_notification_message"));
    }
    let Some(lease) = repo.claim(message, nonce, clock.now()).await? else {
        return repo.disposition(message, clock.now()).await;
    };
    let Some(job) = repo.job(&message.id).await? else {
        return Err(Error::new(503, "notification_job_missing"));
    };
    if job.expires_at <= clock.now() {
        repo.finish(&lease, &super::delivery::Outcome::Cancelled, clock.now())
            .await?;
        return Ok(Disposition::Ack);
    }
    let page = repo.page(&job, clock.now()).await?;
    page.validate(&job)?;
    lease.valid(clock.now(), 5000)?;
    repo.commit_page(&lease, &job, &page, clock.now()).await?;
    Ok(if page.complete {
        Disposition::Ack
    } else {
        Disposition::Retry(1)
    })
}
