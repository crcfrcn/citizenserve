use crate::{chain::subscription::Current, shared::Result, user::profile_service::Authorization};
use serde::{Deserialize, Serialize};
use std::future::Future;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub used_bytes: u64,
    pub reserved_bytes: u64,
    pub used_images: u32,
    pub reserved_images: u32,
    pub used_video_seconds: u32,
    pub reserved_video_seconds: u32,
    pub active_uploads: u32,
}
pub trait Repository {
    fn cleanup_notice(
        &self,
        auth: &Authorization,
    ) -> impl Future<Output = Result<Option<super::cleanup::Notice>>> + Send;
    fn usage(
        &self,
        auth: &Authorization,
        period_start: u64,
    ) -> impl Future<Output = Result<Usage>> + Send;
    fn project(
        &self,
        auth: &Authorization,
        projection: &super::projection::Batch,
    ) -> impl Future<Output = Result<()>> + Send;
    fn overview(
        &self,
        auth: &Authorization,
        current: &Current,
    ) -> impl Future<Output = Result<super::creator::Overview>> + Send;
    fn cursor(
        &self,
    ) -> impl Future<Output = Result<Option<crate::chain::finalized::Anchor>>> + Send;
    /// 后台整块提交不经过用户会话；独立游标必须 CAS 前块锚点。
    fn commit_block(
        &self,
        expected: Option<&crate::chain::finalized::Anchor>,
        batch: &super::projection::Batch,
    ) -> impl Future<Output = Result<()>> + Send;
}
