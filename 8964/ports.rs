use crate::{
    shared::Result,
    square::{follows, posts, routes::FeedKind},
    user::profile_service::Authorization,
};
use std::future::Future;
pub trait Repository {
    fn browse_count(&self, cid: &str, day: &str) -> impl Future<Output = Result<u32>> + Send;
    fn feed(
        &self,
        auth: &Authorization,
        kind: FeedKind,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<posts::Post>>> + Send;
    fn posts(
        &self,
        auth: &Authorization,
        q: &posts::Query,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<posts::Post>>> + Send;
    /// 查询结束后按实际返回量原子扣量；失败时处理器不得交付已读取的帖子。
    fn charge(
        &self,
        auth: &Authorization,
        day: &str,
        count: u32,
        entitlement: &crate::chain::subscription::Entitlement,
    ) -> impl Future<Output = Result<u32>> + Send;
    fn follows(
        &self,
        auth: &Authorization,
        q: &follows::Query,
    ) -> impl Future<Output = Result<Vec<follows::Entry>>> + Send;
    fn change_follow(
        &self,
        auth: &Authorization,
        target: &str,
        change: &follows::Change,
    ) -> impl Future<Output = Result<()>> + Send;
}

// 端口按业务职责分别实现；平台适配不要求维护第二套用户或聊天身份。
pub use super::post_service::Repository as PostRepository;
pub use super::storage::Storage as ObjectStorage;
pub use super::uploads::Repository as UploadRepository;
