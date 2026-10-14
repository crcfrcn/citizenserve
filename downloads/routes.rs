use crate::shared::{Error, Result};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DownloadRoute {
    App,
    Wallet,
}
impl DownloadRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        if method == "GET" {
            match path {
                "/downloads/citizenapp/android" => return Some(Self::App),
                "/downloads/citizenwallet/android" => return Some(Self::Wallet),
                _ => {}
            }
        }
        None
    }
    pub const fn method(self) -> &'static str {
        "GET"
    }
    pub const fn body_limit(self) -> usize {
        0
    }
    pub fn validate_query(self, q: &std::collections::BTreeMap<String, String>) -> Result<()> {
        if q.is_empty() {
            Ok(())
        } else {
            Err(Error::new(400, "invalid_download_request"))
        }
    }
}
