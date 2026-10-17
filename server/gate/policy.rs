//! 所有访问的唯一准入分类。开放规则和公民号规则均须精确登记，未登记即拒绝。
use super::request::{ChainRoute, Endpoint, Route};
use crate::{topup::routes::TopupRoute, user::routes::UserRoute};

pub const NETWORK_ORIGIN: &str = "https://nrcrpc.crcfrcn.com";
pub const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

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
        Route::Topup(TopupRoute::Confirm | TopupRoute::Status) => Rule::Open(OpenRule::PaymentIntent),
        Route::Topup(TopupRoute::Pending | TopupRoute::History | TopupRoute::Claim
            | TopupRoute::Settled | TopupRoute::Exception) => Rule::Open(OpenRule::Settlement),
        // 链启动、宪法及受控签名交易沿用原公开合同；不是整个模块的匿名旁路。
        Route::Chain(ChainRoute::Bootstrap | ChainRoute::SdkBootstrap | ChainRoute::Constitution
            | ChainRoute::RuntimeTarget | ChainRoute::Extrinsics) => Rule::Open(OpenRule::Public),
        Route::User(UserRoute::Registration | UserRoute::Page | UserRoute::Verify
            | UserRoute::Status | UserRoute::Identity) => Rule::Open(OpenRule::Registration),
        Route::User(UserRoute::Challenges) => Rule::Cid(CidRule::Challenge),
        Route::User(UserRoute::Devices) => Rule::Cid(CidRule::Device),
        Route::User(UserRoute::Sessions) => Rule::Cid(CidRule::Session),
        Route::User(UserRoute::DeletionStatusChallenge | UserRoute::DeletionStatus) => Rule::Cid(CidRule::Recovery),
        Route::Membership(_) | Route::ProtectedUser(_) | Route::Square(_)
            | Route::Notifications(_) | Route::TataChat(_) => Rule::Cid(CidRule::Business),
    }
}
pub fn classify(endpoint: &Endpoint, preflight: bool) -> Rule {
    if preflight {
        return Rule::Open(OpenRule::Preflight);
    }
    match endpoint {
        Endpoint::Api(route) => api(*route),
        Endpoint::Network(_) => Rule::Open(OpenRule::Network),
        Endpoint::Chat(_) => Rule::Cid(CidRule::Chat),
        Endpoint::Media(_) => Rule::Cid(CidRule::Media),
    }
}

pub const fn system(operation: super::open::SystemOperation) -> Rule {
    match operation {
        super::open::SystemOperation::Scheduled | super::open::SystemOperation::Notifications
        | super::open::SystemOperation::ChatQueue | super::open::SystemOperation::ChatNotify => Rule::Open(OpenRule::System),
    }
}
