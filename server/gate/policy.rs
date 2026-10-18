//! 所有访问的唯一准入分类。开放规则和公民号规则均须精确登记，未登记即拒绝。
use super::request::{ChainRoute, Endpoint, Route};
use crate::{topup::routes::TopupRoute, user::routes::{UserRoute,ProtectedUserRoute},
    membership::routes::MembershipRoute,notifications::routes::NotificationRoute,
    square::routes::{SquareRoute,FeedKind},server::tatachat_routes::Route as ChatAccessRoute};

pub const NETWORK_ORIGIN: &str = "https://nrcrpc.crcfrcn.com";
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const REQUEST_HEADERS: &[&str] = &[
    "content-type",
    "authorization",
    "x-mls-proof",
    "range",
    "if-none-match",
    "if-range",
    "x-citizenserve-request-time",
    "x-citizenserve-request-nonce",
    "x-citizenserve-request-signature",
];
pub fn headers(endpoint: &Endpoint) -> &'static [&'static str] {
    if matches!(endpoint, Endpoint::Network(_)) {
        &["content-type"]
    } else {
        REQUEST_HEADERS
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenRule {
    Public,
    Registration,
    PaymentIntent,
    Settlement,
    Network,
    Preflight,
    System,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CidRule {
    Business,
    Challenge,
    Device,
    Session,
    Recovery,
    Chat,
    Media,
    Avatar,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rule {
    Open(OpenRule),
    Cid(CidRule),
    Reject,
}

/// 穷尽现有API类型；新增路由必须在这里明确选择访问规则。
pub const fn api(route: Route) -> Rule {
    match route {
        Route::Health => Rule::Open(OpenRule::Public),
        Route::Topup(TopupRoute::Config | TopupRoute::Intent) => Rule::Open(OpenRule::Public),
        Route::Topup(TopupRoute::Confirm | TopupRoute::Status) => {
            Rule::Open(OpenRule::PaymentIntent)
        }
        Route::Topup(
            TopupRoute::Pending
            | TopupRoute::History
            | TopupRoute::Claim
            | TopupRoute::Settled
            | TopupRoute::Exception,
        ) => Rule::Open(OpenRule::Settlement),
        // 链启动、宪法及受控签名交易沿用原公开合同；不是整个模块的匿名旁路。
        Route::Chain(
            ChainRoute::Bootstrap
            | ChainRoute::SdkBootstrap
            | ChainRoute::Constitution
            | ChainRoute::RuntimeTarget
            | ChainRoute::Extrinsics,
        ) => Rule::Open(OpenRule::Public),
        Route::User(
            UserRoute::Registration
            | UserRoute::Page
            | UserRoute::Verify
            | UserRoute::Status
            | UserRoute::Identity,
        ) => Rule::Open(OpenRule::Registration),
        Route::User(UserRoute::Challenges) => Rule::Cid(CidRule::Challenge),
        Route::User(UserRoute::Devices) => Rule::Cid(CidRule::Device),
        Route::User(UserRoute::Sessions) => Rule::Cid(CidRule::Session),
        Route::User(UserRoute::DeletionStatusChallenge | UserRoute::DeletionStatus) => {
            Rule::Cid(CidRule::Recovery)
        }
        Route::ProtectedUser(ProtectedUserRoute::CardAvatar) => Rule::Cid(CidRule::Avatar),
        Route::Membership(MembershipRoute::Current|MembershipRoute::Confirm|MembershipRoute::Plans
            |MembershipRoute::ConfirmPlans|MembershipRoute::Overview|MembershipRoute::ConfirmCreator)
        |Route::ProtectedUser(ProtectedUserRoute::Card|ProtectedUserRoute::Profile|ProtectedUserRoute::UpdateProfile|ProtectedUserRoute::Contacts
            |ProtectedUserRoute::PrepareAsset|ProtectedUserRoute::UploadAsset|ProtectedUserRoute::Asset
            |ProtectedUserRoute::DeletionChallenge|ProtectedUserRoute::Delete)
        |Route::Square(SquareRoute::Feed(FeedKind::Recommended|FeedKind::Following|FeedKind::Campaign)
            |SquareRoute::Posts|SquareRoute::Follows|SquareRoute::Follow|SquareRoute::Unfollow|SquareRoute::Notify
            |SquareRoute::PrepareUpload|SquareRoute::Manifest|SquareRoute::CompleteUpload|SquareRoute::CancelUpload
            |SquareRoute::ConfirmPost|SquareRoute::SelfPosts|SquareRoute::Post|SquareRoute::DeletePost)
        |Route::Notifications(NotificationRoute::Unread|NotificationRoute::Read|NotificationRoute::RegisterEndpoint|NotificationRoute::DeleteEndpoint)
        |Route::TataChat(ChatAccessRoute::Access) => Rule::Cid(CidRule::Business),
    }
}
pub fn classify(endpoint: &Endpoint, preflight: bool) -> Rule {
    if preflight {
        return Rule::Open(OpenRule::Preflight);
    }
    match endpoint {
        Endpoint::Api(route) => api(*route),
        Endpoint::Network(super::request::NetworkRoute::Install|super::request::NetworkRoute::Icon|super::request::NetworkRoute::Rpc) => Rule::Open(OpenRule::Network),
        Endpoint::Chat(super::request::ChatRoute::Realtime|super::request::ChatRoute::Attachment{..}) => Rule::Cid(CidRule::Chat),
        Endpoint::Media(_) => Rule::Cid(CidRule::Media),
    }
}

pub const fn system(operation: super::open::SystemOperation) -> Rule {
    match operation {
        super::open::SystemOperation::Scheduled
        | super::open::SystemOperation::Notifications
        | super::open::SystemOperation::ChatQueue
        | super::open::SystemOperation::ChatNotify
        | super::open::SystemOperation::ChatAlarm => Rule::Open(OpenRule::System),
    }
}

/// 只批准现有十二种客户端命令；服务端响应帧和未知类型直接拒绝。
pub fn chat(frame:&crate::tatachat::protocol::ChatFrame)->Rule {
    use crate::tatachat::protocol::chat_frame::Body;
    match frame.body.as_ref() {
        Some(Body::Ping(_)|Body::PublishKeyPackage(_)|Body::ResolveKeyPackages(_)|Body::SendMessage(_)
            |Body::SyncMessages(_)|Body::AcknowledgeMessages(_)|Body::BeginAttachment(_)
            |Body::CompleteAttachment(_)|Body::AcknowledgeAttachment(_)|Body::AbortAttachment(_)
            |Body::RegisterPush(_)|Body::RemovePush(_))=>Rule::Cid(CidRule::Chat),
        _=>Rule::Reject,
    }
}

/// 凭据条件与三路分类使用同一规则来源，业务模块仅查询该结果。
pub const fn requires_mls(rule:Rule)->bool {
    matches!(rule,Rule::Cid(CidRule::Business|CidRule::Device|CidRule::Session))
}
