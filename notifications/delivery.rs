//! 供应商accepted不等于设备收到；外部成功后DB失败可能重投，不能声称exactly-once。
use super::{
    endpoint::Stored,
    jobs::{Delivery, Disposition, Kind, Message, Source},
    ports::{Clock, Jobs, Sender, Verifier},
};
use crate::{
    shared::{Error, Result},
    user::identity::Identity,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Accepted,
    Cancelled,
    InvalidEndpoint,
    Blocked,
    Retry { delay_seconds: u32 },
}
#[derive(Clone, Debug)]
pub struct AuthorizedEndpoint {
    endpoint: Stored,
    checked_at: u64,
    deadline: u64,
}
impl AuthorizedEndpoint {
    pub fn from_facts(
        identity: &Identity,
        delivery: &Delivery,
        endpoint: Stored,
        admission_and_device: bool,
        source_current: bool,
        now: u64,
    ) -> Result<Option<Self>> {
        identity.require_current(now)?;
        if !admission_and_device
            || !source_current
            || identity.cid_number != delivery.cid_number
            || identity.account_id != delivery.account_id
            || identity.binding_revision != delivery.binding_revision
            || endpoint.cid_number != delivery.cid_number
            || endpoint.account_id != delivery.account_id
            || endpoint.binding_revision != delivery.binding_revision
            || endpoint.device_id != delivery.device_id
            || endpoint.endpoint_revision != delivery.endpoint_revision
            || endpoint.expires_at <= now
        {
            return Ok(None);
        }
        endpoint.registration().canonical(now)?;
        Ok(Some(Self {
            endpoint,
            checked_at: identity.checked_at_millis,
            deadline: identity.verification_deadline_millis,
        }))
    }
    pub fn endpoint(&self) -> &Stored {
        &self.endpoint
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        if now < self.checked_at || now >= self.deadline || now >= self.endpoint.expires_at {
            return Err(Error::new(503, "notification_authorization_expired"));
        }
        Ok(())
    }
}
pub fn classify(
    provider: super::endpoint::Provider,
    status: u16,
    body: &serde_json::Value,
    retry_after: Option<u32>,
    attempt: u8,
) -> Outcome {
    use super::endpoint::Provider;
    if (200..300).contains(&status) {
        return match provider {
            Provider::Apns => Outcome::Accepted,
            Provider::Fcm
                if body["name"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("projects/") && s.contains("/messages/")) =>
            {
                Outcome::Accepted
            }
            _ => Outcome::Retry {
                delay_seconds: super::jobs::retry_delay(attempt, None),
            },
        };
    }
    let invalid = match provider {
        Provider::Apns => {
            status == 410
                || status == 400 && matches!(body["reason"].as_str(), Some("BadDeviceToken"))
        }
        Provider::Fcm => {
            status == 404
                && body["error"]["details"].as_array().is_some_and(|a| {
                    a.iter().any(|v| {
                        v["@type"] == "type.googleapis.com/google.firebase.fcm.v1.FcmError"
                            && v["errorCode"] == "UNREGISTERED"
                    })
                })
        }
    };
    if invalid {
        return Outcome::InvalidEndpoint;
    }
    if status == 429 || status >= 500 {
        return Outcome::Retry {
            delay_seconds: super::jobs::retry_delay(attempt, retry_after),
        };
    }
    // 权限/密钥/Topic错误保留端点，不能当作设备失效。
    Outcome::Blocked
}
pub fn payload(
    job: &super::jobs::Job,
    title: Option<&str>,
    excerpt: &str,
    display_name: &str,
) -> Result<serde_json::Value> {
    let v = match job.source_kind {
        Source::Post => {
            serde_json::json!({"kind":"square_post","post_id":job.post_id,"author_cid_number":job.cid_number,"title":title.unwrap_or("新帖子"),"body":format!("{}：{}",display_name.chars().take(40).collect::<String>(),excerpt.chars().take(300).collect::<String>())})
        }
        Source::StorageCleanup => {
            serde_json::json!({"kind":"storage_cleanup","notified_at":job.created_at,"cleanup_after":job.created_at+crate::membership::cleanup::NOTICE_MILLIS,"storage_limit_bytes":crate::membership::limits::limits(crate::membership::Level::Freedom).storage_bytes})
        }
    };
    super::validate_payload(
        &serde_json::to_vec(&v).map_err(|_| Error::new(503, "invalid_notification_payload"))?,
    )?;
    Ok(v)
}
pub async fn run<R: Jobs + Verifier + Sender, C: Clock>(
    repo: &R,
    clock: &C,
    message: &Message,
    nonce: &str,
    payload: &serde_json::Value,
) -> Result<Disposition> {
    message.validate()?;
    if message.kind != Kind::Delivery {
        return Err(Error::new(400, "invalid_notification_message"));
    }
    let Some(lease) = repo.claim(message, nonce, clock.now()).await? else {
        return repo.disposition(message, clock.now()).await;
    };
    let d = repo
        .delivery(&message.id)
        .await?
        .ok_or(Error::new(503, "notification_delivery_missing"))?;
    let job = repo
        .job(&d.job_id)
        .await?
        .ok_or(Error::new(503, "notification_job_missing"))?;
    let endpoint = if job.expires_at > clock.now() {
        repo.authorize(&job, &d, clock.now()).await?
    } else {
        None
    };
    let outcome = match endpoint {
        None => Outcome::Cancelled,
        Some(e) => {
            lease.valid(clock.now(), 15_000)?;
            e.require_current(clock.now())?;
            match repo.send(&e, payload, &d.delivery_id).await {
                Ok(x) => x,
                Err(_) => Outcome::Retry {
                    delay_seconds: super::jobs::retry_delay(lease.attempts(), None),
                },
            }
        }
    };
    let outcome = match outcome {
        Outcome::Retry { .. } if lease.attempts() >= super::jobs::MAX_ATTEMPTS => Outcome::Blocked,
        x => x,
    };
    let disposition = match outcome {
        Outcome::Retry { delay_seconds } => Disposition::Retry(delay_seconds),
        _ => Disposition::Ack,
    };
    repo.finish(&lease, &outcome, clock.now()).await?;
    Ok(disposition)
}
