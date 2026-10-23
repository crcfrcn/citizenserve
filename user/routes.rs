//! 用户模块的唯一HTTP声明。路径不携带Cloudflare供应商或页面来源。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserRoute {
    Registration,
    Page,
    Verify,
    Status,
    Identity,
    Challenges,
    Devices,
    Sessions,
    DeletionStatusChallenge,
    DeletionStatus,
}
impl UserRoute {
    pub const ALL: [Self; 10] = [
        Self::Registration,
        Self::Page,
        Self::Verify,
        Self::Status,
        Self::Identity,
        Self::Challenges,
        Self::Devices,
        Self::Sessions,
        Self::DeletionStatusChallenge,
        Self::DeletionStatus,
    ];
    pub const fn path(self) -> &'static str {
        match self {
            Self::Registration => "/user/registration",
            Self::Page => "/user/registration/page",
            Self::Verify => "/user/registration/verify",
            Self::Status => "/user/registration/status",
            Self::Identity => "/user/identity",
            Self::Challenges => "/user/challenges",
            Self::Devices => "/user/devices",
            Self::Sessions => "/user/sessions",
            Self::DeletionStatusChallenge => "/user/deletion/status/challenges",
            Self::DeletionStatus => "/user/deletion/status",
        }
    }
    pub const fn method(self) -> &'static str {
        if matches!(self, Self::Page) {
            "GET"
        } else {
            "POST"
        }
    }
    pub const fn registration(self) -> bool {
        matches!(
            self,
            Self::Registration | Self::Page | Self::Verify | Self::Status
        )
    }
    /// 是否需要请求证明从统一门禁策略派生，不维护第二份权限分类。
    pub const fn requires_mls(self) -> bool {
        crate::gate::policy::requires_mls(crate::gate::policy::api(
            crate::gate::request::Route::User(self)))
    }
    pub const fn body_limit(self) -> usize {
        if self.registration() {
            8 * 1024
        } else {
            16 * 1024
        }
    }
    pub fn external(self) -> String {
        format!("/api{}", self.path())
    }
}

/// 普通账户业务均须通过注册门禁并持有有效会话，不能借预注册能力进入。
/// 仅 CardAvatar 使用既定受保护会话鉴权；其余业务及完整资料媒体仍须一次性 MLS 请求证明。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtectedUserRoute {
    Card,
    CardAvatar,
    Profile,
    UpdateProfile,
    Contacts,
    PrepareAsset,
    UploadAsset,
    Asset,
    DeletionChallenge,
    Delete,
}
impl ProtectedUserRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        match (method, path) {
            ("GET",p) if p.strip_prefix("/user/cards/").and_then(|s|s.strip_suffix("/avatar")).is_some_and(|c|crate::shared::ids::cid(c).is_ok())=>Some(Self::CardAvatar),
            ("GET",p) if p.strip_prefix("/user/cards/").is_some_and(|c|crate::shared::ids::cid(c).is_ok())=>Some(Self::Card),
            ("POST", "/user/deletion/challenges") => Some(Self::DeletionChallenge),
            ("POST", "/user/deletion") => Some(Self::Delete),
            ("POST", "/user/profile/assets") => Some(Self::PrepareAsset),
            ("PUT", p)
                if p.strip_prefix("/user/profile/assets/")
                    .is_some_and(crate::square::routes::identifier) =>
            {
                Some(Self::UploadAsset)
            }
            ("GET", p)
                if p.strip_prefix("/user/profiles/")
                    .and_then(|s| s.split_once("/assets/"))
                    .is_some_and(|(c, k)| {
                        crate::shared::ids::cid(c).is_ok() && matches!(k, "avatar" | "banner")
                    }) =>
            {
                Some(Self::Asset)
            }
            ("PUT", "/user/profile") => Some(Self::UpdateProfile),
            ("POST", "/user/contacts") => Some(Self::Contacts),
            ("GET", p)
                if p.strip_prefix("/user/profiles/")
                    .is_some_and(|cid| crate::shared::ids::cid(cid).is_ok()) =>
            {
                Some(Self::Profile)
            }
            _ => None,
        }
    }
    pub const fn method(self) -> &'static str {
        match self {
            Self::Profile | Self::Asset | Self::Card | Self::CardAvatar => "GET",
            Self::UpdateProfile | Self::UploadAsset => "PUT",
            Self::Contacts | Self::PrepareAsset | Self::DeletionChallenge | Self::Delete => "POST",
        }
    }
    pub const fn body_limit(self) -> usize {
        match self {
            Self::Profile | Self::Asset | Self::Card | Self::CardAvatar => 0,
            Self::UpdateProfile | Self::PrepareAsset | Self::DeletionChallenge | Self::Delete => {
                16384
            }
            Self::UploadAsset => 1536 * 1024,
            Self::Contacts => 262144,
        }
    }
}
