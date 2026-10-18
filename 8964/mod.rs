pub mod feed;
pub mod follows;
pub mod objects;
pub mod ports;
pub mod posts;
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
pub mod local_copy;
pub mod manifest;
pub mod media;
pub mod post_service;
pub mod storage;
pub mod upload_validation;
pub mod uploads;

pub mod maintenance;
