use super::{all, batch, fail, first, string};
use citizenserve::{
    shared::{Error, Result},
    user::{
        contacts::{
            self, Commit, Delivery, Group, MessageType, Operation, Package, Repository,
            Reservation, Snapshot,
        },
        profile_service::Authorization,
    },
};
use serde_json::{json, Value};
use worker::{send::SendFuture, D1Database};
pub struct D1Contacts {
    pub db: D1Database,
}
const PUBLISH: &str = r#"
-- statement
INSERT INTO contact_mls_groups(cid_number,group_id,creator_device_id,group_revision,member_device_ids)
SELECT '', '', '', NULL, '[]' WHERE (SELECT COUNT(*) FROM mls_devices WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND active=1 AND account_id=json_extract(?1,'$.auth.account_id') AND binding_revision=json_extract(?1,'$.auth.binding_revision'))>32;
-- statement
INSERT INTO contact_mls_packages(cid_number,device_id,key_package,updated_at) VALUES(json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.auth.device_id'),json_extract(?1,'$.package'),json_extract(?1,'$.auth.now')) ON CONFLICT(cid_number,device_id) DO UPDATE SET key_package=excluded.key_package,updated_at=excluded.updated_at;
-- statement
INSERT INTO contact_mls_groups(cid_number,group_id,creator_device_id,group_revision,member_device_ids) VALUES(json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.group_id'),json_extract(?1,'$.auth.device_id'),0,'[]') ON CONFLICT(cid_number) DO NOTHING;
"#;
const ACK: &str = r#"
-- statement
DELETE FROM contact_mls_messages WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND device_id=json_extract(?1,'$.auth.device_id') AND operation_id=json_extract(?1,'$.id') AND message_type=json_extract(?1,'$.kind');
"#;
fn group(mut value: Value) -> Result<Group> {
    value["member_device_ids"] =
        serde_json::from_str(value["member_device_ids"].as_str().ok_or_else(fail)?)
            .map_err(|_| fail())?;
    serde_json::from_value(value).map_err(|_| fail())
}
fn operation(mut value: Value) -> Result<Operation> {
    value["target_device_ids"] =
        serde_json::from_str(value["target_device_ids"].as_str().ok_or_else(fail)?)
            .map_err(|_| fail())?;
    serde_json::from_value(value).map_err(|_| fail())
}
impl D1Contacts {
    async fn op(&self, cid: &str, id: &str) -> Result<Option<Operation>> {
        first::<Value>(
            &self.db,
            "SELECT * FROM contact_mls_operations WHERE cid_number=?1 AND operation_id=?2",
            &[string(cid), string(id)],
        )
        .await?
        .map(operation)
        .transpose()
    }
}
impl Repository for D1Contacts {
    fn snapshot(
        &self,
        auth: &Authorization,
        id: Option<&str>,
        delivery: bool,
    ) -> impl std::future::Future<Output = Result<Snapshot>> + Send {
        SendFuture::new(async move {
            let rows:Vec<Value>=all(&self.db,"SELECT device_id FROM mls_devices WHERE cid_number=?1 AND account_id=?2 AND binding_revision=?3 AND active=1 ORDER BY device_id",&[string(auth.cid()),string(auth.account()),wasm_bindgen::JsValue::from_f64(auth.revision() as f64)]).await?;
            let eligible = rows
                .into_iter()
                .map(|r| r["device_id"].as_str().map(str::to_owned).ok_or_else(fail))
                .collect::<Result<Vec<_>>>()?;
            let g = first::<Value>(
                &self.db,
                "SELECT * FROM contact_mls_groups WHERE cid_number=?1",
                &[string(auth.cid())],
            )
            .await?
            .map(group)
            .transpose()?;
            let pending =
                if let Some(id) = g.as_ref().and_then(|g| g.pending_operation_id.as_deref()) {
                    self.op(auth.cid(), id).await?
                } else {
                    None
                };
            let selected = if let Some(id) = id {
                self.op(auth.cid(), id).await?
            } else {
                None
            };
            let (packages, messages) = if delivery {
                let packages:Vec<Package>=all(&self.db,"SELECT p.device_id,p.key_package FROM contact_mls_packages p JOIN mls_devices d ON d.cid_number=p.cid_number AND d.device_id=p.device_id WHERE p.cid_number=?1 AND d.active=1 AND d.account_id=?2 AND d.binding_revision=?3 ORDER BY p.device_id",&[string(auth.cid()),string(auth.account()),wasm_bindgen::JsValue::from_f64(auth.revision() as f64)]).await?;
                let messages:Vec<Delivery>=all(&self.db,"SELECT operation_id,sequence,message_type,mls_message,sender_device_id FROM contact_mls_messages WHERE cid_number=?1 AND device_id=?2 ORDER BY sequence LIMIT 100",&[string(auth.cid()),string(auth.device())]).await?;
                (packages, messages)
            } else {
                (vec![], vec![])
            };
            Ok(Snapshot {
                eligible,
                group: g,
                pending,
                operation: selected,
                packages,
                messages,
            })
        })
    }
    fn publish(
        &self,
        auth: &Authorization,
        package: &str,
        id: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"package":package,"group_id":id}),
                PUBLISH,
                Error::new(429, "contact_mls_devices_full"),
            )
            .await?;
            Ok(())
        })
    }
    fn reserve(
        &self,
        auth: &Authorization,
        r: &Reservation,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let mut command = serde_json::to_value(r).map_err(|_| fail())?;
            command["auth"] = json!(auth);
            batch(
                &self.db,
                command,
                include_str!("../sql/reserve_contact.sql"),
                contacts::conflict(),
            )
            .await?;
            Ok(())
        })
    }
    fn commit(
        &self,
        auth: &Authorization,
        c: &Commit,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            let mut command = serde_json::to_value(c).map_err(|_| fail())?;
            command["auth"] = json!(auth);
            batch(
                &self.db,
                command,
                include_str!("../sql/commit_contact.sql"),
                contacts::conflict(),
            )
            .await?;
            Ok(())
        })
    }
    fn ack(
        &self,
        auth: &Authorization,
        id: &str,
        kind: MessageType,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            batch(
                &self.db,
                json!({"auth":auth,"id":id,"kind":kind}),
                ACK,
                contacts::conflict(),
            )
            .await?;
            Ok(())
        })
    }
}
