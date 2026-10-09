use super::{Delivery, Receipt};
use crate::tatachat::{auth::Access, Result};
use std::future::Future;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Commit {
    Inserted,
    Duplicate,
}

/// 完整消息的唯一事务入口，不提供逐设备插入后回读补验的接口。
pub trait Store {
    /// 同一事务核验有效授权，按全局message_id比较完整Receipt，提交全部投递和唤醒outbox。
    /// 任一冲突必须零写入；Duplicate不重建已ACK投递，不延长期限、不重复排队。
    fn commit_message(
        &self,
        access: &Access,
        receipt: &Receipt,
        deliveries: &[Delivery],
    ) -> impl Future<Output = Result<Commit>>;
    /// 同时按条数和完整MessageBatch的字节预算返回稳定前缀，禁止先读取无界密文。
    /// 首条无法容纳时返回ResourceLimit，不能伪装成收件箱为空。
    fn messages(
        &self,
        access: &Access,
        now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> impl Future<Output = Result<Vec<Delivery>>>;
    /// 只删除当前用户设备的密文及待唤醒任务；Receipt保留至其固定期限。
    fn acknowledge_messages(
        &self,
        access: &Access,
        ids: &[String],
        now: u64,
    ) -> impl Future<Output = Result<()>>;
}
