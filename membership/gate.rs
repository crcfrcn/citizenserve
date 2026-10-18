//! 注册鉴权之后的唯一会员门禁。许可绑定真实操作、CID、账户修订和期限。
use super::{
    policy::{Operation, Requirement},
    Level,
};
use crate::{
    chain::subscription::{Facts, Plan},
    server::gate::identity::Authority,
    shared::{Error, Result},
    user::profile_service::Authorization,
};
#[derive(Clone, Debug)]
pub struct Permit {
    operation: Operation,
    cid: String,
    account: String,
    revision: u64,
    device: String,
    checked: u64,
    deadline: u64,
    member: Option<Member>,
}
#[derive(Clone, Debug)]
struct Member {
    level: Level,
    checked: u64,
    deadline: u64,
    paid_until: u64,
    period_start: u64,
    chain_time: u64,
}
/// 不反序列化许可；只有注册门禁生成的Authority可以进入这里。
pub fn authorize(
    authority: &Authority,
    operation: Operation,
    current: Option<&Facts>,
    now: u64,
) -> Result<Permit> {
    authority.require_current(now)?;
    let i = authority.identity();
    let mut deadline = authority
        .session_deadline()
        .min(authority.recheck_deadline());
    let member = if operation.requirement(&i.cid_number) == Requirement::Member {
        let current = current.ok_or(Error::new(503, "membership_verification_unavailable"))?;
        if current.anchor.hash != i.finalized_block_hash
            || current.anchor.number != i.finalized_block_number
            || current.chain_time != i.finalized_timestamp_millis
        {
            return Err(Error::new(
                409,
                if operation == Operation::Attachment {
                    "chat_authorization_anchor_changed"
                } else {
                    "membership_identity_anchor_changed"
                },
            ));
        }
        if now < current.checked_at() || now >= current.deadline() {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        let state = current.require(now).map_err(|e| {
            if e.code == "membership_required" {
                operation.denial()
            } else {
                e
            }
        })?;
        let Plan::Platform(level) = state.plan else {
            return Err(operation.denial());
        };
        deadline = deadline.min(current.deadline()).min(state.paid_until);
        Some(Member {
            level,
            checked: current.checked_at(),
            deadline: current.deadline(),
            paid_until: state.paid_until,
            period_start: state.last_charged_at,
            chain_time: current.chain_time,
        })
    } else {
        None
    };
    Ok(Permit {
        operation,
        cid: i.cid_number.clone(),
        account: i.account_id.clone(),
        revision: i.binding_revision,
        device: authority.device_id().into(),
        checked: now,
        deadline,
        member,
    })
}
impl Permit {
    pub fn operation(&self) -> &Operation {
        &self.operation
    }
    pub fn deadline(&self) -> u64 {
        self.deadline
    }
    pub fn cid(&self) -> &str {
        &self.cid
    }
    pub fn require_current(&self, now: u64) -> Result<()> {
        if now < self.checked || now >= self.deadline {
            return Err(Error::new(503, "membership_verification_expired"));
        }
        Ok(())
    }
    pub fn require(&self, auth: &Authorization, operation: &Operation, now: u64) -> Result<()> {
        self.require_current(now)?;
        if &self.operation != operation
            || self.cid != auth.cid()
            || self.account != auth.account()
            || self.revision != auth.revision()
            || self.device != auth.device()
        {
            return Err(Error::new(403, "membership_scope_mismatch"));
        }
        Ok(())
    }
    pub fn level(&self, now: u64) -> Result<Level> {
        self.require_current(now)?;
        self.member
            .as_ref()
            .map(|m| m.level)
            .ok_or(Error::new(403, "membership_required"))
    }
    pub fn attachment_limit(&self, now: u64) -> Result<u64> {
        if self.operation != Operation::Attachment {
            return Err(Error::new(403, "membership_scope_mismatch"));
        }
        Ok(super::limits::plan(self.level(now)?).chat_file_max_bytes)
    }
    /// 原SQL金额/时效围栏只消费服务器许可，不能由客户端JSON替代。
    pub fn evidence(&self, now: u64) -> Result<serde_json::Value> {
        self.require_current(now)?;
        let m = self
            .member
            .as_ref()
            .ok_or(Error::new(403, "membership_required"))?;
        Ok(
            serde_json::json!({"membership_checked":m.checked,"membership_deadline":self.deadline.min(m.deadline),
            "paid_until":m.paid_until,"period_start":m.period_start,"chain_time":m.chain_time,
            "limits":super::limits::plan(m.level),"storage_bytes":super::limits::limits(m.level).storage_bytes}),
        )
    }
}
