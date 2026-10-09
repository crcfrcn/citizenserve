#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationRoute {
    Unread,
    Read,
    RegisterEndpoint,
    DeleteEndpoint,
}
impl NotificationRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        match (method, path) {
            ("GET", "/notifications/unread") => Some(Self::Unread),
            ("POST", "/notifications/read") => Some(Self::Read),
            ("PUT", "/notifications/endpoint") => Some(Self::RegisterEndpoint),
            ("DELETE", "/notifications/endpoint") => Some(Self::DeleteEndpoint),
            _ => None,
        }
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Unread => "GET",
            Self::Read => "POST",
            Self::RegisterEndpoint => "PUT",
            Self::DeleteEndpoint => "DELETE",
        }
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Unread | Self::DeleteEndpoint => 0,
            Self::Read | Self::RegisterEndpoint => 16384,
        }
    }
}
