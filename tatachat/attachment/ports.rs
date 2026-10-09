use super::{Attachment, Chunk};
use crate::tatachat::{auth::Access, Result};
use std::future::Future;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Ready,
    Deleting,
}
#[derive(Clone, Debug)]
pub struct Stored {
    pub metadata: Attachment,
    pub state: State,
    pub generation: String,
}

/// 对象定位由一次持久上传预留产生，不复用其他尝试的可写对象键。
#[derive(Clone, Debug)]
pub struct Upload {
    pub attachment_id: String,
    pub generation: String,
    pub attempt_id: String,
    pub object_key: String,
    pub chunk: Chunk,
}
#[derive(Clone, Debug)]
pub struct Written {
    pub upload: Upload,
    pub object_version: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug)]
pub struct Deletion {
    pub attachment_id: String,
    pub generation: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Complete,
    Acknowledge,
    Abort,
}

pub trait Store {
    /// 删除后的紧凑凭据按真实创建设备/收件用户核验操作范围和原期限。
    /// 未完成返回false；明确没有归属返回NotFound，不能只按attachment_id返回成功。
    fn completed(
        &self,
        access: &Access,
        id: &str,
        operation: Operation,
        now: u64,
    ) -> impl Future<Output = Result<bool>>;
    /// 整体创建元数据/收件用户/分块；同ID仅允许相同创建设备与完整不可变内容。
    /// 重试不改接收/过期时间，不复活已删除附件；保留到原期限的完成凭据。
    fn begin(&self, access: &Access, attachment: &Attachment) -> impl Future<Output = Result<()>>;
    fn attachment(
        &self,
        access: &Access,
        id: &str,
        now: u64,
    ) -> impl Future<Output = Result<Stored>>;
    /// 持久登记专属于本次尝试的对象键，失败对象仍可被后续清理定位。
    fn reserve_upload(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        now: u64,
    ) -> impl Future<Output = Result<Upload>>;
    /// CAS核验创建用户/设备、生命周期代际、attempt_id、pending和授权截止后标记完成。
    /// 失败不能删除成功者；旧尝试定位须保留到条件删除完成。
    fn confirm_upload(
        &self,
        access: &Access,
        written: &Written,
        now: u64,
    ) -> impl Future<Output = Result<()>>;
    fn downloaded_chunk(
        &self,
        access: &Access,
        stored: &Stored,
        index: u32,
        now: u64,
    ) -> impl Future<Output = Result<Written>>;
    /// 原子检查创建用户设备及全部分块完成；已ready也须先验属主。
    fn complete(&self, access: &Access, id: &str, now: u64) -> impl Future<Output = Result<()>>;
    /// ACK按真实收件用户聚合；重复ACK保留原归属判断，全员ACK才进入deleting。
    fn acknowledge(
        &self,
        access: &Access,
        id: &str,
        now: u64,
    ) -> impl Future<Output = Result<Option<Deletion>>>;
    /// 原子核实创建用户设备再进入deleting，禁止无权限的已deleting状态旁路。
    fn abort(&self, access: &Access, id: &str, now: u64) -> impl Future<Output = Result<Deletion>>;
    /// 必须在对象删除完成后，以相同代际移除元数据；保留必要幂等凭据。
    fn finalize(&self, deletion: &Deletion) -> impl Future<Output = Result<()>>;
    /// 有界地持久标记过期附件并重取失败的删除定位，包括全部上传尝试。
    fn pending_deletions(
        &self,
        now: u64,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Deletion>>>;
}

/// 流类型由平台提供。平台必须验证实际长度和SHA-256，不能信任客户端头。
pub trait Objects {
    type UploadBody;
    type DownloadBody;
    fn put(
        &self,
        upload: &Upload,
        body: Self::UploadBody,
        permission_deadline: u64,
    ) -> impl Future<Output = Result<Written>>;
    /// 仅删除相同attempt_id/object_key/object_version；失败保留持久预留供清理。
    fn discard(&self, written: &Written) -> impl Future<Output = Result<()>>;
    fn open(
        &self,
        written: &Written,
        permission_deadline: u64,
    ) -> impl Future<Output = Result<Self::DownloadBody>>;
    /// 删除定位代际下全部对象和未完成尝试；必须可重复并有界执行。
    fn delete(&self, deletion: &Deletion) -> impl Future<Output = Result<()>>;
}
