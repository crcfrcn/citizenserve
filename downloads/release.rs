//! 固定产品仓、正式Tag、唯一资产及官方HTTPS下载路径共同决定302目标。
use crate::shared::{Error, Result};
use serde_json::Value;
pub fn missing() -> Error {
    Error::new(404, "release_asset_not_found")
}
pub fn asset(
    release: &Value,
    product: &str,
    tag: &str,
    name: &str,
    digest: Option<&str>,
) -> Result<String> {
    if !matches!(product, "citizenapp" | "citizenwallet" | "citizenchain")
        || release["tag_name"] != tag
        || release["draft"] != false
        || release["prerelease"] != false
    {
        return Err(missing());
    }
    let a = release["assets"]
        .as_array()
        .filter(|a| a.len() <= 256)
        .ok_or_else(missing)?
        .iter()
        .filter(|a| a["name"] == name)
        .collect::<Vec<_>>();
    if a.len() != 1 || a[0]["state"] != "uploaded" || !a[0]["size"].as_u64().is_some_and(|n| n > 0)
    {
        return Err(missing());
    }
    if let Some(d) = digest {
        if a[0]["digest"] != format!("sha256:{d}") {
            return Err(missing());
        }
    }
    let expected = format!("https://github.com/crcfrcn/{product}/releases/download/{tag}/{name}");
    if a[0]["browser_download_url"] != expected {
        return Err(missing());
    }
    super::asset_url(&expected)?;
    Ok(expected)
}
pub fn android(releases: &Value, product: &str) -> Result<String> {
    let (_, prefix, name) = super::installer_target(&format!("/downloads/{product}/android"))?;
    let items = releases
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(missing)?;
    for r in items {
        if let Some(tag) = r["tag_name"].as_str() {
            if tag
                .strip_prefix(prefix)
                .is_some_and(super::publication::version)
                && r["draft"] == false
                && r["prerelease"] == false
            {
                if let Ok(url) = asset(r, product, tag, name, None) {
                    return Ok(url);
                }
            }
        }
    }
    Err(missing())
}
