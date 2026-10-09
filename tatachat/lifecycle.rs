//! 宿主已授权的用户退役端口；不从公网或任意消息字段取得删除权限。
use super::{attachment::ports::{Deletion, Objects, Store as AttachmentStore}, Error, Result};
use std::future::Future;
/// 存储先持久冻结用户，再分批移除其邮箱/设备/推送，附件对象删除成功才移除定位。
pub trait Store: AttachmentStore {
    fn freeze(&self, user: &str, deletion_id: &str, started_at: u64) -> impl Future<Output=Result<()>>;
    fn retire(&self, user: &str) -> impl Future<Output=Result<Vec<Deletion>>>;
    fn remaining(&self, user: &str) -> impl Future<Output=Result<bool>>;
}
pub async fn advance<S:Store,O:Objects>(store:&S,objects:&O,user:&str,id:&str,started_at:u64) -> Result<bool> {
    if !super::valid_identity(user) || !crate::shared::ids::hex(id,32,false) || started_at==0 {
        return Err(Error::InvalidRequest);
    }
    store.freeze(user,id,started_at).await?;
    let items=store.retire(user).await?;
    if items.len()>1 {return Err(Error::ResourceLimit);}
    for item in items {
        if item.attachment_id.is_empty() || item.generation.is_empty() {return Err(Error::StorageUnavailable);}
        // 未知写入、对象删除或元数据提交失败保持待处理，不能凭超时报完成。
        objects.delete(&item).await?;
        store.finalize(&item).await?;
    }
    Ok(!store.remaining(user).await?)
}
