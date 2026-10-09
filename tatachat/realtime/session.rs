use crate::tatachat::{
    auth::{ports::Host, Access, HostAccess},
    Error, Result,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLimits {
    started_at: Option<u64>,
    resolve_count: u32,
}
impl SessionLimits {
    pub(crate) fn consume_resolve(&mut self, now: u64) -> Result<()> {
        if self
            .started_at
            .is_none_or(|start| now.saturating_sub(start) >= 60_000)
        {
            self.started_at = Some(now);
            self.resolve_count = 0;
        }
        if self.started_at.is_some_and(|start| now < start) {
            return Err(Error::Forbidden);
        }
        if self.resolve_count >= 120 {
            return Err(Error::ResourceLimit);
        }
        self.resolve_count += 1;
        Ok(())
    }
}

/// 休眠快照是可检查材料，不是授权。restore始终强制重新查询可信宿主。
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub access: HostAccess,
    pub limits: SessionLimits,
    pub closed: bool,
}
pub struct Session {
    access: Access,
    pub(crate) limits: SessionLimits,
    closed: bool,
}
impl Session {
    pub fn new(access: Access) -> Self {
        Self {
            access,
            limits: SessionLimits::default(),
            closed: false,
        }
    }
    pub async fn restore<H: Host>(host: &H, saved: Snapshot) -> Result<Self> {
        if saved.closed {
            return Err(Error::Forbidden);
        }
        let now = host.now_millis();
        saved.access.validate(now, false)?;
        if now >= saved.access.expires_at_millis {
            return Err(Error::Forbidden);
        }
        let fresh = host.recheck(&saved.access).await?;
        if fresh.actor != saved.access.actor
            || fresh.authorization_revision != saved.access.authorization_revision
            || fresh.session_id_digest != saved.access.session_id_digest
            || fresh.max_attachment_bytes != saved.access.max_attachment_bytes
        {
            return Err(Error::Forbidden);
        }
        let mut access = Access::from_host(fresh, host.now_millis())?;
        access.cap_deadline(saved.access.expires_at_millis);
        access.ensure_current(host.now_millis())?;
        Ok(Self {
            access,
            limits: saved.limits,
            closed: false,
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut access = self.access.snapshot().clone();
        access.expires_at_millis = access
            .expires_at_millis
            .min(self.access.credential_deadline());
        Snapshot {
            access,
            limits: self.limits.clone(),
            closed: self.closed,
        }
    }
    pub fn access(&self) -> &Access {
        &self.access
    }
    /// 驱动必须在此截止安排定时器，即使没有任何客户端帧也执行检查。
    pub fn next_check_at(&self) -> u64 {
        self.access.deadline()
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub async fn check<H: Host>(&mut self, host: &H) -> Result<()> {
        if self.closed {
            return Err(Error::Forbidden);
        }
        if let Err(error) = self.access.recheck(host, false).await {
            self.closed = true;
            return Err(error);
        }
        Ok(())
    }
}
