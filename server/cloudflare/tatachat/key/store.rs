//! LastResort包按可信用户/设备唯一覆盖；先查索引及帧预算，再读限定公开包。
use super::super::{config, D1Store};
use citizenserve::tatachat::{
    auth::Access,
    key::{ports::Store, Package},
    Error, Result,
};
use serde_json::json;
impl Store for D1Store {
    async fn publish(&self, access: &Access, package: &Package) -> Result<()> {
        package.validate_for(access.actor(), config::now())?;
        self.write(access,vec![("INSERT INTO key_packages VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(user_id,device_id) DO UPDATE SET record=excluded.record,wire_bytes=excluded.wire_bytes,not_before=excluded.not_before,not_after=excluded.not_after",vec![json!(package.user_id),json!(package.device_id),json!(serde_json::to_string(package).map_err(|_|Error::StorageUnavailable)?),json!(super::bytes(package)?),json!(package.not_before),json!(package.not_after)])]).await?;
        Ok(())
    }
    async fn resolve(
        &self,
        user: &str,
        device: Option<&str>,
        _now: u64,
        limit: u32,
        maximum_bytes: usize,
    ) -> Result<Vec<Package>> {
        let at = config::now();
        let rows=self.rows("SELECT device_id,wire_bytes FROM key_packages WHERE user_id=?1 AND (?2 IS NULL OR device_id=?2) AND not_before<=?3 AND not_after>?3 ORDER BY device_id LIMIT ?4",vec![json!(user),json!(device),json!(at),json!(limit)]).await?;
        let mut ids = Vec::new();
        let mut budget = 0usize;
        for row in rows {
            let n = row["wire_bytes"]
                .as_u64()
                .ok_or(Error::StorageUnavailable)? as usize;
            if budget.saturating_add(n) > maximum_bytes {
                if ids.is_empty() {
                    return Err(Error::ResourceLimit);
                }
                break;
            }
            budget += n;
            ids.push(
                row["device_id"]
                    .as_str()
                    .ok_or(Error::StorageUnavailable)?
                    .to_owned(),
            );
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows=self.rows("SELECT record FROM key_packages WHERE user_id=?1 AND device_id IN(SELECT value FROM json_each(?2)) AND not_before<=?3 AND not_after>?3 ORDER BY device_id",vec![json!(user),json!(serde_json::to_string(&ids).map_err(|_|Error::StorageUnavailable)?),json!(config::now())]).await?;
        let result: Vec<Package> = rows
            .into_iter()
            .map(|r| D1Store::record(&r))
            .collect::<Result<_>>()?;
        for package in &result {
            package
                .validate_for(
                    &citizenserve::tatachat::auth::Device {
                        user_id: package.user_id.clone(),
                        device_id: package.device_id.clone(),
                    },
                    config::now(),
                )
                .map_err(|_| Error::StorageUnavailable)?;
        }
        Ok(result)
    }
}
