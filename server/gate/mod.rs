//! CitizenServe所有入口的统一注册门禁：开放校验、公民号校验、直接拒绝。
//! 分类与低成本检查先于数据库、链、媒体和业务访问；领域校验器保留原子安全断言。
pub mod identity;
pub mod open;
pub mod policy;
pub mod request;

use crate::shared::{Error, Result};
use policy::{CidRule, Rule};
use request::{Endpoint, Incoming, Recognized};

#[derive(Debug)]
pub enum Classification {
    Open(Entry),
    Cid(Entry),
    Reject(Error),
}
/// 记录识别结果，不冒充已完成真人、设备或会话验证的Authority。
pub struct Entry {
    recognized: Recognized,
    rule: Rule,
}
impl std::fmt::Debug for Entry {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        // 页面能力可能位于查询参数；诊断只输出固定分类和方法，不能输出请求目标或凭据。
        f.debug_struct("Entry").field("rule",&self.rule).field("method",&self.recognized.method).finish_non_exhaustive()
    }
}
impl Entry {
    pub fn endpoint(&self) -> &Endpoint {
        &self.recognized.endpoint
    }
    pub fn rule(&self) -> Rule {
        self.rule
    }
    pub fn preflight(&self) -> bool {
        self.recognized.preflight
    }
    pub fn method(&self) -> &str {
        &self.recognized.method
    }
    pub fn target(&self) -> &str {
        &self.recognized.target
    }
    pub fn open(&self) -> Result<open::Scope<'_>> {
        open::validate(self)
    }
    pub fn require_cid(&self, expected: CidRule) -> Result<()> {
        if self.rule != Rule::Cid(expected) {
            return Err(Error::new(403, "gate_scope_mismatch"));
        }
        Ok(())
    }
    pub fn api(&self) -> Result<request::Route> {
        if let Endpoint::Api(route) = self.endpoint() {
            return Ok(*route);
        }
        Err(Error::new(403, "gate_scope_mismatch"))
    }
}

/// 唯一外部请求分类入口。输入只取真实请求，不接收客户端声明的权限或开放类型。
pub fn classify(input: Incoming<'_>) -> Classification {
    let recognized = match request::recognize(&input) {
        Ok(value) => value,
        Err(error) => return Classification::Reject(error),
    };
    let rule = policy::classify(&recognized.endpoint, recognized.preflight);
    if let Err(error) = request::cheap_checks(&input, &recognized, rule) {
        return Classification::Reject(error);
    }
    let entry = Entry { recognized, rule };
    match rule {
        Rule::Open(_) => Classification::Open(entry),
        Rule::Cid(_) => Classification::Cid(entry),
        Rule::Reject => Classification::Reject(Error::new(404, "route_not_found")),
    }
}

/// 已建连消息仍先做有界类型识别；未知消息不触发宿主恢复、数据库或链复核。
pub fn classify_chat(bytes:&[u8],maximum:usize)->Result<()> {
    let frame=crate::tatachat::protocol::decode_chat_frame(bytes,maximum)
        .map_err(|_|Error::new(400,"invalid_chat_request"))?;
    if policy::chat(&frame)!=Rule::Cid(CidRule::Chat) {return Err(Error::new(400,"invalid_chat_request"));}
    Ok(())
}
