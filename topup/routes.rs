//! 精确目录是权限边界；充值能力和结算令牌均不能用来取得普通账户权限。
use crate::{
    server::routes::query,
    shared::{Error, Result},
    square::routes::keys,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopupRoute {
    Config,
    Intent,
    Confirm,
    Status,
    Pending,
    History,
    Claim,
    Settled,
    Exception,
}
impl TopupRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        let r = match path {
            "/topup/config" => Self::Config,
            "/topup/intent" => Self::Intent,
            "/topup/confirm" => Self::Confirm,
            "/topup/status" => Self::Status,
            "/topup/settlement/pending" => Self::Pending,
            "/topup/settlement/history" => Self::History,
            _ => {
                let s = path.strip_prefix("/topup/settlement/")?;
                let (id, action) = s.split_once('/')?;
                if !order_id(id) {
                    return None;
                }
                match action {
                    "claim" => Self::Claim,
                    "settled" => Self::Settled,
                    "exception" => Self::Exception,
                    _ => return None,
                }
            }
        };
        (method == r.method()).then_some(r)
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Config | Self::Pending | Self::History => "GET",
            _ => "POST",
        }
    }
    pub const fn settlement(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::History | Self::Claim | Self::Settled | Self::Exception
        )
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Config | Self::Pending | Self::History => 0,
            Self::Settled => 131584,
            _ => 16384,
        }
    }
    pub fn validate_query(self, raw: Option<&str>) -> Result<()> {
        let q = query(raw)?;
        match self {
            Self::Pending => keys(&q, &["limit"]),
            Self::History => keys(&q, &["limit", "cursor"]),
            _ => keys(&q, &[]),
        }?;
        if let Some(s) = q.get("limit") {
            let max = if self == Self::Pending { 50 } else { 100 };
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
pub fn path_order(path: &str) -> Result<&str> {
    path.strip_prefix("/api/topup/settlement/")
        .and_then(|s| s.split_once('/'))
        .map(|(id, _)| id)
        .filter(|s| order_id(s))
        .ok_or_else(invalid)
}
pub fn invalid() -> Error {
    Error::new(400, "invalid_topup_request")
}
