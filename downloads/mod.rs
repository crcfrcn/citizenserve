use crate::shared::{Error, Result};
pub mod ports;
pub mod publication;
pub mod release;
pub mod routes;
pub mod service;
pub fn installer_target(path: &str) -> Result<(&'static str, &'static str, &'static str)> {
    match path {
        "/downloads/citizenapp/android" => Ok((
            "citizenapp",
            "citizenapp-release-android-v",
            "citizenapp.apk",
        )),
        "/downloads/citizenwallet/android" => Ok((
            "citizenwallet",
            "citizenwallet-release-android-v",
            "citizenwallet.apk",
        )),
        _ => Err(Error::new(404, "download_not_found")),
    }
}
pub fn asset_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| Error::new(502, "release_download_url_invalid"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::new(502, "release_download_url_invalid"));
    }
    Ok(url)
}
