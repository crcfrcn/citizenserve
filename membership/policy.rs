//! 唯一会员业务策略；本人/他人由已核验CID比较，客户端不能声明放行类型。
use crate::{
    server::gate::request::Route,
    shared::{ids, Error, Result},
    square::routes::SquareRoute,
    user::routes::ProtectedUserRoute,
};
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Operation {
    Account,
    Membership,
    CreatorOverview,
    Chat,
    Attachment,
    Profile(String),
    ProfileAsset { target: String, kind: String },
    Card(String),
    CardAvatar(String),
    Square(SquareRoute),
    Media(String),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Requirement {
    Base,
    Member,
}
impl Operation {
    pub fn requirement(&self, actor: &str) -> Requirement {
        match self {
            Self::Profile(target) | Self::ProfileAsset { target, .. } if target != actor => {
                Requirement::Member
            }
            Self::Square(_) | Self::Media(_) | Self::Attachment | Self::CreatorOverview => {
                Requirement::Member
            }
            Self::Profile(_)
            | Self::ProfileAsset { .. }
            | Self::Card(_)
            | Self::CardAvatar(_)
            | Self::Account
            | Self::Membership
            | Self::Chat => Requirement::Base,
        }
    }
    /// 指标由已核验的真实操作决定，调用方不能复用另一类许可写账。
    pub fn meters(&self, metric: &str) -> bool {
        match self {
            Self::Square(SquareRoute::Feed(_) | SquareRoute::Posts) => metric == "browse",
            Self::Square(SquareRoute::Post) => metric == "detail",
            Self::Square(SquareRoute::ConfirmPost) => metric == "published",
            Self::Profile(_) => metric == "profile",
            Self::Media(_) => metric == "delivery_bytes",
            _ => false,
        }
    }
    pub fn denial(&self) -> Error {
        match self {
            Self::Profile(_) | Self::ProfileAsset { .. } => {
                Error::new(403, "profile_membership_required")
            }
            Self::Attachment => Error::new(403, "attachment_membership_required"),
            Self::CreatorOverview => Error::new(403, "membership_required"),
            _ => Error::new(403, "square_membership_required"),
        }
    }
}
/// 只能由真实路由和签名目标选择操作，不接收客户端的isSelf/会员等级/已用量。
pub fn api(route: Route, path: &str) -> Result<Operation> {
    let target = |prefix: &str| -> Result<String> {
        let value = path
            .strip_prefix(prefix)
            .ok_or(Error::new(400, "invalid_api_target"))?;
        ids::cid(value)?;
        Ok(value.into())
    };
    Ok(match route {
        Route::ProtectedUser(ProtectedUserRoute::Card) => {
            Operation::Card(target("/api/user/cards/")?)
        }
        Route::ProtectedUser(ProtectedUserRoute::CardAvatar) => {
            let cid = path
                .strip_prefix("/api/user/cards/")
                .and_then(|p| p.strip_suffix("/avatar"))
                .ok_or(Error::new(400, "invalid_api_target"))?;
            ids::cid(cid)?;
            Operation::CardAvatar(cid.into())
        }
        Route::ProtectedUser(ProtectedUserRoute::Profile) => {
            Operation::Profile(target("/api/user/profiles/")?)
        }
        Route::ProtectedUser(ProtectedUserRoute::Asset) => {
            let (cid, kind) = path
                .strip_prefix("/api/user/profiles/")
                .and_then(|p| p.split_once("/assets/"))
                .ok_or(Error::new(400, "invalid_api_target"))?;
            ids::cid(cid)?;
            Operation::ProfileAsset {
                target: cid.into(),
                kind: kind.into(),
            }
        }
        Route::ProtectedUser(
            ProtectedUserRoute::UpdateProfile
            | ProtectedUserRoute::Contacts
            | ProtectedUserRoute::PrepareAsset
            | ProtectedUserRoute::UploadAsset
            | ProtectedUserRoute::DeletionChallenge
            | ProtectedUserRoute::Delete,
        ) => Operation::Account,
        // 概览需要真实会员许可，不能借会员状态/确认的基础入口绕过同步健康。
        Route::Membership(crate::membership::routes::MembershipRoute::Overview) => {
            Operation::CreatorOverview
        }
        Route::Membership(_) => Operation::Membership,
        Route::TataChat(_) => Operation::Chat,
        Route::Square(route) => Operation::Square(route),
        Route::Notifications(_) => Operation::Account,
        Route::Health | Route::Topup(_) | Route::Chain(_) | Route::User(_) => {
            return Err(Error::new(403, "membership_scope_mismatch"))
        }
    })
}
