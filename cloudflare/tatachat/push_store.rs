//! 租约和端点代际持久串行；旧执行结果不能完成新租约或删除新端点。
use super::super::{config, D1Store};
use citizenserve::tatachat::{
    auth::{Access, Device},
    push::{
        ports::Store, Endpoint, Finish, InvalidEndpoint, Lease, PushPlatform, LEASE_MILLIS,
        MAX_ATTEMPTS,
    },
    Error, Result,
};
use serde_json::{json, Value};
fn lease(row: &Value) -> Result<Lease> {
    let text = |k: &str| {
        row[k]
            .as_str()
            .map(str::to_owned)
            .ok_or(Error::StorageUnavailable)
    };
    Ok(Lease {
        message_id: text("message_id")?,
        recipient: Device {
            user_id: text("user_id")?,
            device_id: text("device_id")?,
        },
        lease_id: text("lease_id")?,
        lease_until_millis: row["lease_until"]
            .as_u64()
            .ok_or(Error::StorageUnavailable)?,
        attempts: row["attempts"]
            .as_u64()
            .ok_or(Error::StorageUnavailable)?
            .try_into()
            .map_err(|_| Error::StorageUnavailable)?,
    })
}
fn args(lease: &Lease) -> Vec<Value> {
    vec![
        json!(lease.message_id),
        json!(lease.recipient.user_id),
        json!(lease.recipient.device_id),
        json!(lease.lease_id),
    ]
}
fn guard() -> String {
    format!("INSERT INTO tatachat_assert VALUES(CASE WHEN EXISTS(SELECT 1 FROM push_jobs j JOIN messages m USING(message_id,user_id,device_id) WHERE j.message_id=?1 AND j.user_id=?2 AND j.device_id=?3 AND j.lease_id=?4 AND j.state='leased' AND j.lease_until>{0} AND m.expires_at>{0}) THEN 1 ELSE 0 END) ON CONFLICT(value) DO NOTHING",D1Store::CLOCK)
}
impl Store for D1Store {
    async fn register(&self, access: &Access, endpoint: &Endpoint) -> Result<()> {
        endpoint.validate()?;
        if &endpoint.access != access.snapshot() {
            return Err(Error::Forbidden);
        }
        let mut endpoint = endpoint.clone();
        if endpoint.platform == PushPlatform::Ios {
            endpoint.token.make_ascii_lowercase();
        }
        let record = serde_json::to_string(&endpoint).map_err(|_| Error::StorageUnavailable)?;
        let args = vec![
            json!(endpoint.access.actor.user_id),
            json!(endpoint.access.actor.device_id),
            json!(endpoint.platform.as_str()),
            json!(endpoint.token),
            json!(record),
        ];
        self.write(access,vec![("INSERT INTO push_generations VALUES(?1,?2,?3,1) ON CONFLICT(user_id,device_id,platform) DO UPDATE SET generation=generation+1",args[..3].to_vec()),("INSERT INTO push_endpoints SELECT ?1,?2,?3,generation,?4,json_set(?5,'$.generation',generation) FROM push_generations WHERE user_id=?1 AND device_id=?2 AND platform=?3 ON CONFLICT(user_id,device_id,platform) DO UPDATE SET generation=excluded.generation,token=excluded.token,record=excluded.record",args)]).await?;
        Ok(())
    }
    async fn remove(&self, access: &Access, platform: PushPlatform) -> Result<()> {
        self.write(
            access,
            vec![(
                "DELETE FROM push_endpoints WHERE user_id=?1 AND device_id=?2 AND platform=?3",
                vec![
                    json!(access.actor().user_id),
                    json!(access.actor().device_id),
                    json!(platform.as_str()),
                ],
            )],
        )
        .await?;
        Ok(())
    }
    async fn claim(&self, _now: u64, limit: u32) -> Result<Vec<Lease>> {
        if !(1..=32).contains(&limit) {
            return Err(Error::InvalidRequest);
        }
        let now = config::now();
        let nonce = config::random_id()?;
        let commands=vec![("UPDATE push_jobs SET state='failed' WHERE rowid IN(SELECT rowid FROM push_jobs WHERE state='leased' AND lease_until<=?1 AND attempts>=?2 ORDER BY due_at,rowid LIMIT ?3)",vec![json!(now),json!(MAX_ATTEMPTS),json!(limit)]),("UPDATE push_jobs SET state='leased',attempts=attempts+1,lease_id=?1||'-'||rowid,lease_until=?2 WHERE rowid IN(SELECT j.rowid FROM push_jobs j JOIN messages m USING(message_id,user_id,device_id) WHERE ((j.state='pending' AND j.due_at<=?3) OR (j.state='leased' AND j.lease_until<=?3)) AND j.attempts<?4 AND m.expires_at>?3 ORDER BY j.due_at,j.rowid LIMIT ?5) RETURNING message_id,user_id,device_id,lease_id,lease_until,attempts",vec![json!(nonce),json!(now+LEASE_MILLIS),json!(now),json!(MAX_ATTEMPTS),json!(limit)])];
        let rows = self.transaction(commands).await?;
        rows.last()
            .ok_or(Error::StorageUnavailable)?
            .iter()
            .map(lease)
            .collect()
    }
    async fn endpoints(&self, device: &Device) -> Result<Vec<Endpoint>> {
        self.rows("SELECT record FROM push_endpoints WHERE user_id=?1 AND device_id=?2 ORDER BY platform LIMIT 2",vec![json!(device.user_id),json!(device.device_id)]).await?.iter().map(D1Store::record).collect()
    }
    async fn renew(&self, lease_value: &Lease, _now: u64) -> Result<Lease> {
        let now = config::now();
        lease_value.validate(now)?;
        let mut values = args(lease_value);
        values.push(json!(now + LEASE_MILLIS));
        values.push(json!(lease_value.attempts));
        let guard = guard();
        let rows=self.transaction(vec![(guard.as_str(),values[..4].to_vec()),("UPDATE push_jobs SET lease_until=?5 WHERE message_id=?1 AND user_id=?2 AND device_id=?3 AND lease_id=?4 AND attempts=?6 RETURNING message_id,user_id,device_id,lease_id,lease_until,attempts",values)]).await?;
        lease(rows.last().and_then(|r| r.first()).ok_or(Error::Conflict)?)
    }
    async fn finish(
        &self,
        lease_value: &Lease,
        finish: Finish,
        invalid: &[InvalidEndpoint],
        _now: u64,
    ) -> Result<()> {
        lease_value.validate(config::now())?;
        let guard = guard();
        let base = args(lease_value);
        let (state, due) = match finish {
            Finish::Completed => ("completed", 0),
            Finish::Failed => ("failed", 0),
            Finish::RetryAt(due) if lease_value.attempts < MAX_ATTEMPTS && due > config::now() => {
                ("pending", due)
            }
            _ => return Err(Error::InvalidRequest),
        };
        let mut values = base.clone();
        values.extend([json!(state), json!(due)]);
        let mut commands=vec![(guard.as_str(),base),("UPDATE push_jobs SET state=?5,due_at=?6,lease_until=0,lease_id=NULL,dispatch_until=0 WHERE message_id=?1 AND user_id=?2 AND device_id=?3 AND lease_id=?4",values)];
        for e in invalid {
            commands.push(("DELETE FROM push_endpoints WHERE user_id=?1 AND device_id=?2 AND platform=?3 AND generation=?4",vec![json!(lease_value.recipient.user_id),json!(lease_value.recipient.device_id),json!(e.platform.as_str()),json!(e.generation)]));
        }
        self.transaction(commands).await?;
        Ok(())
    }
}
