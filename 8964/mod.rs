pub mod feed;
pub mod follows;
pub mod objects;
pub mod ports;
pub mod posts;
pub mod quota;
pub mod routes;
use crate::shared::{Error, Result};

pub fn feed_page_size(value: Option<u32>) -> Result<u32> {
    let n = value.unwrap_or(20);
    if (1..=50).contains(&n) {
        Ok(n)
    } else {
        Err(Error::new(400, "invalid_page_size"))
    }
}
pub fn guest_browse_remaining(returned_today: u32) -> u32 {
    100u32.saturating_sub(returned_today)
}
/// 游客额度按实际返回帖数原子扣减；这个函数只是计算，不能替代存储原子操作。
pub fn charged_items(requested: u32, actual: u32, returned_today: u32, paid: bool) -> u32 {
    actual.min(requested).min(if paid {
        u32::MAX
    } else {
        guest_browse_remaining(returned_today)
    })
}
pub mod local_copy;
pub mod manifest;
pub mod media;
pub mod post_service;
pub mod storage;
pub mod upload_validation;
pub mod uploads;

pub mod maintenance;
