//! 不透明的公开MLS KeyPackage与LastResort发布、解析规则。
pub mod ports;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::tatachat::{auth::Device, protocol, Error};

/// 服务端保存的不透明 RFC 9420 Last Resort KeyPackage。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Package {
    pub user_id: String,
    pub device_id: String,
    pub key_package_ref: String,
    pub key_package: String,
    pub cipher_suite: String,
    pub not_before: u64,
    pub not_after: u64,
    pub last_resort: bool,
}

impl Package {
    pub fn from_protocol(
        package: &protocol::KeyPackage,
        actor: &Device,
        now_millis: u64,
    ) -> Result<Self, Error> {
        let package = Self {
            user_id: package.user_id.clone(),
            device_id: package.device_id.clone(),
            key_package_ref: package.key_package_ref.clone(),
            key_package: STANDARD.encode(&package.key_package),
            cipher_suite: package.cipher_suite.clone(),
            not_before: package.not_before,
            not_after: package.not_after,
            last_resort: package.last_resort,
        };
        package.validate_for(actor, now_millis)?;
        Ok(package)
    }

    pub fn to_protocol(&self) -> Result<protocol::KeyPackage, Error> {
        Ok(protocol::KeyPackage {
            user_id: self.user_id.clone(),
            device_id: self.device_id.clone(),
            key_package_ref: self.key_package_ref.clone(),
            key_package: STANDARD
                .decode(&self.key_package)
                .map_err(|_| Error::StorageUnavailable)?,
            cipher_suite: self.cipher_suite.clone(),
            not_before: self.not_before,
            not_after: self.not_after,
            last_resort: self.last_resort,
        })
    }

    pub fn validate_for(&self, actor: &Device, now_millis: u64) -> Result<(), Error> {
        actor.validate()?;
        if self.user_id != actor.user_id
            || self.device_id != actor.device_id
            || !self.last_resort
            || self.key_package.is_empty()
            || self.key_package.len() > 174_764
            || self.cipher_suite.is_empty()
            || self.cipher_suite.len() > 128
            || self.not_before >= self.not_after
            || self.not_before > now_millis.saturating_add(5 * 60 * 1000)
            || self.not_after <= now_millis
            || self.key_package_ref.len() < 32
            || self.key_package_ref.len() > 128
            || !self
                .key_package_ref
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
}

/// 发布执行使用可信设备，客户端声明不能改变包的归属。
pub async fn publish<S: ports::Store>(
    store: &S,
    access: &crate::tatachat::auth::Access,
    package: &Package,
    now: u64,
) -> crate::tatachat::Result<()> {
    access.ensure_current(now)?;
    package.validate_for(access.actor(), now)?;
    store.publish(access, package).await
}

pub async fn resolve<S: ports::Store>(
    store: &S,
    user: &str,
    device: Option<&str>,
    now: u64,
    limit: u32,
    maximum_bytes: usize,
) -> crate::tatachat::Result<Vec<Package>> {
    if !crate::tatachat::valid_identity(user)
        || device.is_some_and(|id| !crate::tatachat::valid_identity(id))
        || !(1..=100).contains(&limit)
        || maximum_bytes == 0
    {
        return Err(Error::InvalidRequest);
    }
    let packages = store
        .resolve(user, device, now, limit, maximum_bytes)
        .await?;
    if packages.len() > limit as usize {
        return Err(Error::StorageUnavailable);
    }
    for package in &packages {
        if package.user_id != user
            || device.is_some_and(|id| package.device_id != id)
            || package.not_before > now
        {
            return Err(Error::StorageUnavailable);
        }
        package
            .validate_for(
                &Device {
                    user_id: package.user_id.clone(),
                    device_id: package.device_id.clone(),
                },
                now,
            )
            .map_err(|_| Error::StorageUnavailable)?;
        package.to_protocol()?;
    }
    if protocol::encoded_len(&protocol::key_package_batch_frame(&packages)?) > maximum_bytes {
        return Err(Error::StorageUnavailable);
    }
    Ok(packages)
}

#[cfg(test)]
mod tests;
