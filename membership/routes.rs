//! 路由由真实 /api 请求和 MLS 挑战共同使用；路径参数不重复放入正文。
use crate::shared::ids;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MembershipRoute {
    Current,
    Confirm,
    Plans,
    ConfirmPlans,
    Overview,
    ConfirmCreator,
}
impl MembershipRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        match (method, path) {
            ("GET", "/membership") => Some(Self::Current),
            ("POST", "/membership/confirm") => Some(Self::Confirm),
            ("POST", "/membership/creators/plans") => Some(Self::ConfirmPlans),
            ("GET", "/membership/creator/overview") => Some(Self::Overview),
            ("GET", p)
                if p.strip_prefix("/membership/creators/")
                    .and_then(|s| s.strip_suffix("/plans"))
                    .is_some_and(|c| ids::cid(c).is_ok()) =>
            {
                Some(Self::Plans)
            }
            ("POST", p)
                if p.strip_prefix("/membership/creators/")
                    .and_then(|s| s.strip_suffix("/subscription/confirm"))
                    .is_some_and(|c| ids::cid(c).is_ok()) =>
            {
                Some(Self::ConfirmCreator)
            }
            _ => None,
        }
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Current | Self::Plans | Self::Overview => "GET",
            _ => "POST",
        }
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Current | Self::Plans | Self::Overview => 0,
            _ => 16384,
        }
    }
}
