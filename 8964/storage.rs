//! 平台无关对象端口；D1 与对象存储没有共同事务，删除定位由调用方先持久保存。
use crate::shared::Result;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, future::Future};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Bucket {
    Private,
    Public,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub key: String,
    pub byte_size: u64,
    pub content_type: String,
    pub sha256: String,
    pub etag: String,
    pub custom: BTreeMap<String, String>,
}
#[derive(Clone, Debug)]
pub struct Put {
    pub key: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub sha256: String,
    pub custom: BTreeMap<String, String>,
    pub previous_etag: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Direct {
    pub object_key: String,
    pub content_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub upload_id: String,
    pub media_index: u32,
    pub object_role: String,
    pub expires_at: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct SignedPut {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub method: String,
    pub expires_at: u64,
}
pub trait Storage {
    fn head(&self, bucket: Bucket, key: &str) -> impl Future<Output = Result<Option<Meta>>> + Send;
    /// 读取精确有界范围，不能先下载完整视频再截断。
    fn read(
        &self,
        bucket: Bucket,
        key: &str,
        offset: u64,
        length: u64,
    ) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn put(&self, bucket: Bucket, put: Put) -> impl Future<Output = Result<Meta>> + Send;
    fn sign(&self, plan: &Direct, now: u64) -> impl Future<Output = Result<SignedPut>> + Send;
    fn delete(&self, bucket: Bucket, keys: &[String]) -> impl Future<Output = Result<()>> + Send;
    fn purge(&self, keys: &[String]) -> impl Future<Output = Result<()>> + Send;
}
