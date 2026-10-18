//! 统一会员计量：已用、预留和本次申请以检查加法计算，事务端口负责原子提交。
use crate::{
    membership::Plan,
    shared::{Error, Result},
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Usage {
    pub images: u32,
    pub video_seconds: u32,
    pub active_uploads: u8,
}
/// 月额度已使用与已预留必须在同一事务内读取；取消只能释放该reservation的预留。
pub fn reserve(current: Usage, reserved: Usage, request: Usage, plan: Plan) -> Result<Usage> {
    let result = Usage {
        images: current
            .images
            .checked_add(reserved.images)
            .and_then(|n| n.checked_add(request.images))
            .ok_or(Error::new(403, "upload_quota_exceeded"))?,
        video_seconds: current
            .video_seconds
            .checked_add(reserved.video_seconds)
            .and_then(|n| n.checked_add(request.video_seconds))
            .ok_or(Error::new(403, "upload_quota_exceeded"))?,
        active_uploads: current
            .active_uploads
            .checked_add(reserved.active_uploads)
            .and_then(|n| n.checked_add(request.active_uploads))
            .ok_or(Error::new(403, "upload_quota_exceeded"))?,
    };
    if result.images > plan.monthly_images
        || result.video_seconds > plan.monthly_video_seconds
        || result.active_uploads > plan.active_uploads
    {
        return Err(Error::new(403, "upload_quota_exceeded"));
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug)]
pub enum Limit {
    Bounded(u32),
    Unlimited,
}
/// 分页安全顶与额度剩余取较严值；不限额仍按实际返回量记账。
pub fn page_budget(requested: u32, used: u32, limit: Limit) -> Result<u32> {
    if !(1..=50).contains(&requested) {
        return Err(Error::new(400, "invalid_api_target"));
    }
    let left = match limit {
        Limit::Bounded(max) => max.saturating_sub(used),
        Limit::Unlimited => requested,
    };
    if left == 0 {
        return Err(Error::new(429, "browse_limit_reached"));
    }
    Ok(requested.min(left))
}
