//! 持久推送任务的租约执行。提供方接受不等于跨系统恰好一次。
use super::{
    ports::{Provider, Store},
    *,
};
use crate::tatachat::{
    auth::{ports::Host, Access},
    Error, Result,
};

pub async fn register<S: Store>(
    store: &S,
    access: &Access,
    config: &Config,
    platform: PushPlatform,
    token: String,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    let endpoint = Endpoint {
        access: access.snapshot().clone(),
        platform,
        token,
        app_id: config.app_id(platform).to_owned(),
        generation: 0,
        updated_at_millis: now,
    };
    endpoint.validate()?;
    store.register(access, &endpoint).await
}
pub async fn remove<S: Store>(
    store: &S,
    access: &Access,
    platform: PushPlatform,
    now: u64,
) -> Result<()> {
    access.ensure_current(now)?;
    store.remove(access, platform).await
}

async fn renew<S: Store, H: Host>(store: &S, host: &H, lease: &Lease) -> Result<Lease> {
    let now = host.now_millis();
    lease.validate(now)?;
    let fresh = store.renew(lease, now).await?;
    if fresh.lease_id != lease.lease_id
        || fresh.message_id != lease.message_id
        || fresh.recipient != lease.recipient
        || fresh.attempts != lease.attempts
    {
        return Err(Error::Conflict);
    }
    fresh.validate(host.now_millis())?;
    Ok(fresh)
}

pub async fn drain<S: Store, H: Host, P: Provider>(
    store: &S,
    host: &H,
    provider: &P,
    config: &Config,
    limit: u32,
) -> Result<()> {
    if !(1..=32).contains(&limit) {
        return Err(Error::InvalidRequest);
    }
    let jobs = store.claim(host.now_millis(), limit).await?;
    if jobs.len() > limit as usize {
        return Err(Error::StorageUnavailable);
    }
    for mut lease in jobs {
        lease.validate(host.now_millis())?;
        let endpoints = store.endpoints(&lease.recipient).await?;
        if endpoints.len() > 2
            || endpoints.len() == 2 && endpoints[0].platform == endpoints[1].platform
        {
            return Err(Error::StorageUnavailable);
        }
        let mut invalid = Vec::new();
        let mut retry = false;
        let mut blocked = false;
        for mut endpoint in endpoints {
            endpoint.validate().map_err(|_| Error::StorageUnavailable)?;
            if endpoint.access.actor != lease.recipient || endpoint.generation == 0 {
                return Err(Error::StorageUnavailable);
            }
            lease = renew(store, host, &lease).await?;
            let current = match host.authorize_wake(&endpoint.access).await {
                Ok(current) => current,
                // 未知链/存储状态有界重试；明确无权限则不投递，不删除设备端点。
                Err(Error::StorageUnavailable) => {
                    retry = true;
                    continue;
                }
                Err(_) => continue,
            };
            let access = match Access::from_host(current, host.now_millis()) {
                Ok(access) => access,
                Err(_) => continue,
            };
            if access.actor() != &lease.recipient
                || access.snapshot().session_id_digest != endpoint.access.session_id_digest
            {
                continue;
            }
            if endpoint.app_id != config.app_id(endpoint.platform) {
                blocked = true;
                continue;
            }
            lease = renew(store, host, &lease).await?;
            access.ensure_current(host.now_millis())?;
            endpoint.access = access.snapshot().clone();
            let payload = match endpoint.platform {
                PushPlatform::Ios => apns_wake_payload(),
                PushPlatform::Android => fcm_wake_payload(&endpoint),
            };
            match provider
                .send(&endpoint, &payload, host.now_millis() / 1000)
                .await
            {
                Ok(Outcome::Accepted) => {}
                Ok(Outcome::InvalidEndpoint) => invalid.push(InvalidEndpoint {
                    platform: endpoint.platform,
                    generation: endpoint.generation,
                }),
                Ok(Outcome::Blocked) => blocked = true,
                Ok(Outcome::Retryable) | Err(_) => retry = true,
            }
        }
        lease = renew(store, host, &lease).await?;
        let now = host.now_millis();
        let finish = if blocked || retry && lease.attempts >= MAX_ATTEMPTS {
            Finish::Failed
        } else if retry {
            Finish::RetryAt(now.saturating_add(30_000 * u64::from(lease.attempts)))
        } else {
            Finish::Completed
        };
        store.finish(&lease, finish, &invalid, now).await?;
    }
    Ok(())
}
