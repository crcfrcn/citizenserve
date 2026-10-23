//! 精确目录是权限边界；充值能力和结算令牌均不能用来取得普通账户权限。
use crate::{
    gate::request::query,
    shared::{Error, Result},
    square::routes::keys,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopupRoute {
    Config,
    Intent,
    Confirm,
    Status,
    History,
    Account,
}
impl TopupRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        let r = match path {
            "/topup/config" => Self::Config,
            "/topup/intent" => Self::Intent,
            "/topup/confirm" => Self::Confirm,
            "/topup/status" => Self::Status,
            "/topup/settlement/history" => Self::History,
            "/topup/account" => Self::Account,
            _ => return None,
        };
        (method == r.method()).then_some(r)
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Config | Self::Account | Self::History => "GET",
            _ => "POST",
        }
    }
    pub const fn settlement(self) -> bool {
        matches!(
            crate::gate::policy::api(crate::gate::request::Route::Topup(self)),
            crate::gate::policy::Rule::Open(crate::gate::policy::OpenRule::Settlement)
        )
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Config | Self::Account | Self::History => 0,
            _ => 16384,
        }
    }
    pub fn validate_query(self, raw: Option<&str>) -> Result<()> {
        let q = query(raw)?;
        match self {
            Self::History => keys(&q, &["limit", "cursor"]),
            _ => keys(&q, &[]),
        }?;
        if let Some(s) = q.get("limit") {
            let max = 100;
            if s.parse::<u32>()
                .ok()
                .filter(|n| *n > 0 && *n <= max)
                .is_none()
                || s.starts_with('0')
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
pub fn order_id(s: &str) -> bool {
    s.strip_prefix("top_").is_some_and(|s| {
        s.len() == 32
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn invalid() -> Error {
    Error::new(400, "invalid_topup_request")
}
