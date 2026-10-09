//! 用户清理仍复用同一聊天存储与R2对象端口；永久冻结记录由新真人准入解除。
use super::{attachment::R2Objects,D1Store};
use citizenserve::tatachat::{attachment::ports::{Deletion,Objects,Upload,Written},lifecycle::Store,Error,Result};
use serde_json::json;
use worker::Env;
impl Store for D1Store {
    async fn freeze(&self,user:&str,id:&str,started_at:u64)->Result<()> {
        self.transaction(vec![("INSERT INTO account_deletion_fences(user_id,deletion_id,started_at) VALUES(?1,?2,?3) ON CONFLICT(user_id) DO UPDATE SET deletion_id=excluded.deletion_id,started_at=excluded.started_at WHERE account_deletion_fences.started_at<=excluded.started_at",vec![json!(user),json!(id),json!(started_at)]),
          ("INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM account_deletion_fences WHERE user_id=?1 AND deletion_id=?2) THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING",vec![json!(user),json!(id)])]).await?;
        Ok(())
    }
    async fn retire(&self,user:&str)->Result<Vec<Deletion>> {
        // 只删除该CID收件箱；其它接收者的消息与幂等回执不因同一个发送者退出而删除。
        let sqls=[
            "DELETE FROM messages WHERE rowid IN(SELECT rowid FROM messages WHERE user_id=?1 LIMIT 100)",
            "DELETE FROM key_packages WHERE rowid IN(SELECT rowid FROM key_packages WHERE user_id=?1 LIMIT 100)",
            "DELETE FROM push_endpoints WHERE rowid IN(SELECT rowid FROM push_endpoints WHERE user_id=?1 LIMIT 100)",
            "DELETE FROM push_generations WHERE rowid IN(SELECT rowid FROM push_generations WHERE user_id=?1 LIMIT 100)",
            "DELETE FROM attachment_recipients WHERE rowid IN(SELECT rowid FROM attachment_recipients WHERE user_id=?1 LIMIT 100)",
            "DELETE FROM attachment_receipts WHERE rowid IN(SELECT rowid FROM attachment_receipts WHERE creator_user=?1 LIMIT 100)",
            "UPDATE attachments SET state='deleting',aborted=1 WHERE attachment_id IN(SELECT attachment_id FROM attachments WHERE creator_user=?1 AND state<>'deleting' LIMIT 1)",
        ];
        self.transaction(sqls.into_iter().map(|sql|(sql,vec![json!(user)])).collect()).await?;
        let rows=self.rows("SELECT attachment_id,generation FROM attachments WHERE creator_user=?1 AND state='deleting' ORDER BY cleanup_after,attachment_id LIMIT 1",vec![json!(user)]).await?;
        rows.into_iter().map(|v|Ok(Deletion{attachment_id:v["attachment_id"].as_str().ok_or(citizenserve::tatachat::Error::StorageUnavailable)?.into(),generation:v["generation"].as_str().ok_or(citizenserve::tatachat::Error::StorageUnavailable)?.into()})).collect()
    }
    async fn remaining(&self,user:&str)->Result<bool> {
        Ok(!self.rows("SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM messages WHERE user_id=?1) OR EXISTS(SELECT 1 FROM key_packages WHERE user_id=?1) OR EXISTS(SELECT 1 FROM push_endpoints WHERE user_id=?1) OR EXISTS(SELECT 1 FROM push_generations WHERE user_id=?1) OR EXISTS(SELECT 1 FROM attachment_recipients WHERE user_id=?1) OR EXISTS(SELECT 1 FROM attachment_receipts WHERE creator_user=?1) OR EXISTS(SELECT 1 FROM attachments WHERE creator_user=?1)",vec![json!(user)]).await?.is_empty())
    }
}
pub(crate) async fn advance(env:&Env,user:&str,id:&str,started_at:u64)->Result<bool> {
    let store=D1Store::new(env)?;
    let objects=LifecycleObjects{inner:R2Objects::new(env,store.clone())?,store:store.clone(),
        bucket:env.bucket("TATACHAT_ATTACHMENTS").map_err(|_|Error::StorageUnavailable)?};
    citizenserve::tatachat::lifecycle::advance(&store,&objects,user,id,started_at).await
}
/// 仅供宿主从DB核验新真人准入后调用；旧会话/旧准入不能解除冻结。
pub(crate) async fn admit(env:&Env,user:&str,human_verified_at:u64)->Result<()> {
    let store=D1Store::new(env)?;
    store.transaction(vec![("DELETE FROM account_deletion_fences WHERE user_id=?1 AND started_at<?2",vec![json!(user),json!(human_verified_at)])]).await?;Ok(())
}

/// 与正常附件共用one-shot上传账本，注销每轮仅清一件对象以守住宿主预算。
struct LifecycleObjects {inner:R2Objects,store:D1Store,bucket:worker::Bucket}
impl Objects for LifecycleObjects {
    type UploadBody=Vec<u8>;type DownloadBody=Vec<u8>;
    async fn put(&self,u:&Upload,b:Vec<u8>,deadline:u64)->Result<Written>{self.inner.put(u,b,deadline).await}
    async fn discard(&self,w:&Written)->Result<()>{self.inner.discard(w).await}
    async fn open(&self,w:&Written,deadline:u64)->Result<Vec<u8>>{self.inner.open(w,deadline).await}
    async fn delete(&self,d:&Deletion)->Result<()> {
        let args=vec![json!(d.attachment_id),json!(d.generation)];
        let rows=self.store.rows("SELECT u.attempt_id,u.object_key,u.state FROM attachment_uploads u JOIN attachments a ON a.attachment_id=u.attachment_id AND a.generation=u.generation WHERE a.attachment_id=?1 AND a.generation=?2 AND a.state='deleting' AND u.state<>'deleted' ORDER BY u.cleanup_after,u.attempt_id LIMIT 1",args.clone()).await?;
        if let Some(row)=rows.first() {
            let attempt=row["attempt_id"].as_str().ok_or(Error::StorageUnavailable)?;
            let key=row["object_key"].as_str().ok_or(Error::StorageUnavailable)?;
            self.store.transaction(vec![("UPDATE attachment_uploads SET cleanup_after=?3 WHERE attempt_id=?1 AND object_key=?2",vec![json!(attempt),json!(key),json!(super::config::now())])]).await?;
            if row["state"]=="reserved" {
                self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='reserved'",vec![json!(attempt),json!(key)])]).await?;
            }else{
                let object=self.bucket.head(key).await.map_err(|_|Error::StorageUnavailable)?;
                if row["state"]=="writing" && object.is_none(){return Err(Error::StorageUnavailable);}
                if let Some(object)=object {
                    self.bucket.delete(key).await.map_err(|_|Error::StorageUnavailable)?;
                    self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted',object_version=?3 WHERE attempt_id=?1 AND object_key=?2 AND state IN('writing','written')",vec![json!(attempt),json!(key),json!(object.version())])]).await?;
                }else{
                    self.store.transaction(vec![("UPDATE attachment_uploads SET state='deleted' WHERE attempt_id=?1 AND object_key=?2 AND state='written'",vec![json!(attempt),json!(key)])]).await?;
                }
            }
        }
        if !self.store.rows("SELECT 1 pending FROM attachment_uploads WHERE attachment_id=?1 AND generation=?2 AND state<>'deleted' LIMIT 1",args).await?.is_empty(){return Err(Error::StorageUnavailable);}
        Ok(())
    }
}
