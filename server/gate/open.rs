//! 开放分支只交付已登记路径的受限范围，支付/注册/服务凭据不能换成账户授权。
use super::{
    policy::{OpenRule, Rule},
    request::{Endpoint, Route},
    Entry,
};
use crate::shared::{Error, Result};

/// 只能由统一门禁生成；范围绑定实际请求，不能反序列化客户端自报的放行结论。
#[derive(Debug)]
pub struct Scope<'a> {
    entry: &'a Entry,
    rule: OpenRule,
}
impl Scope<'_> {
    pub fn rule(&self) -> OpenRule {
        self.rule
    }
    pub fn endpoint(&self) -> &Endpoint {
        self.entry.endpoint()
    }
    pub fn require_api(&self, expected: Route) -> Result<()> {
        if self.entry.preflight() || expected.rule() != Rule::Open(self.rule) || self.endpoint() != &Endpoint::Api(expected) {
            return Err(Error::new(403, "gate_scope_mismatch"));
        }
        Ok(())
    }
}
pub(super) fn validate(entry: &Entry) -> Result<Scope<'_>> {
    let Rule::Open(rule) = entry.rule() else {
        return Err(Error::new(403, "gate_scope_mismatch"));
    };
    // 具体能力仍由原注册/付款/结算校验器核验并原子消费；不重复挑战或真人调用。
    // 这里固定它们只能进入所登记开放路径，不得作为普通账户Authority使用。
    match (rule, entry.endpoint()) {
        (OpenRule::Preflight, _) if entry.preflight() => {}
        (OpenRule::Network, Endpoint::Network(_)) => {}
        (
            OpenRule::Public
            | OpenRule::Registration
            | OpenRule::PaymentIntent
            | OpenRule::Settlement,
            Endpoint::Api(route),
        ) if route.rule() == Rule::Open(rule) => {}
        _ => return Err(Error::new(403, "gate_scope_mismatch")),
    }
    Ok(Scope { entry, rule })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemOperation {
    Scheduled,
    Notifications,
    ChatQueue,
    ChatNotify,
    ChatAlarm,
}
/// 平台事件从所属可信入口显式交付来源；HTTP请求不能解析成此类型。
pub fn system(operation: SystemOperation, actual: &str, expected: &str) -> Result<SystemOperation> {
    if super::policy::system(operation) != Rule::Open(OpenRule::System)
        || expected.is_empty()
        || actual != expected
    {
        return Err(Error::new(403, "gate_system_source_invalid"));
    }
    Ok(operation)
}

/// 支付意图由所属产品原HMAC校验器验证；Scope只能用于本次confirm/status开放路径。
pub fn payment(scope: &Scope<'_>, value: &str, key: &[u8]) -> Result<crate::topup::intent::Intent> {
    if scope.rule() != OpenRule::PaymentIntent {
        return Err(Error::new(403, "gate_scope_mismatch"));
    }
    crate::topup::intent::verify(value, key)
}
pub fn settlement(scope: &Scope<'_>, key: &[u8], header: Option<&str>) -> Result<()> {
    if scope.rule() != OpenRule::Settlement {
        return Err(Error::new(403, "gate_scope_mismatch"));
    }
    crate::topup::settlement::authorize(key, header)
}
/// 公共RPC只调用原协议的精确方法与参数校验，不允许借开放类型转发其它RPC。
pub fn network_rpc(
    scope: &Scope<'_>,
    body: &[u8],
) -> std::result::Result<crate::chain::ethereum_rpc::Batch, serde_json::Value> {
    if scope.rule() != OpenRule::Network || scope.endpoint() != &Endpoint::Network(super::request::NetworkRoute::Rpc) {
        return Err(
            serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}),
        );
    }
    let batch=crate::chain::ethereum_rpc::parse(body)?;
    // 全部子请求均不属于允许方法/参数时直接返回原协议错误，不再探测上游链。
    if batch.items.iter().all(|item|item.is_err()) {
        let mut errors:Vec<_>=batch.items.iter().filter_map(|item|item.as_ref().err().cloned()).collect();
        return Err(if batch.batch {serde_json::Value::Array(errors)} else {errors.remove(0)});
    }
    Ok(batch)
}

pub enum Registration {
    Prepare(crate::user::registration::protocol::Prepare),
    Verify(crate::user::registration::protocol::Verify),
    Status(crate::user::registration::protocol::Status),
}
/// 开放的注册路径统一选择原状态机；不新建真人记录，不重复Siteverify或挑战消费。
pub async fn registration<
    R: crate::user::registration::ports::Repository,
    T: crate::server::registration::Runtime,
>(
    scope: &Scope<'_>,
    repo: &R,
    runtime: &T,
    config: &crate::user::registration::protocol::Config,
    input: Registration,
) -> Result<crate::user::registration::protocol::Response> {
    use crate::user::routes::UserRoute;
    match input {
        Registration::Prepare(value) => {
            scope.require_api(Route::User(UserRoute::Registration))?;
            crate::server::registration::prepare(repo, runtime, config, value).await
        }
        Registration::Verify(value) => {
            scope.require_api(Route::User(UserRoute::Verify))?;
            crate::server::registration::verify(repo, runtime, config, value).await
        }
        Registration::Status(value) => {
            scope.require_api(Route::User(UserRoute::Status))?;
            crate::server::registration::status(repo, runtime, config, value).await
        }
    }
}
