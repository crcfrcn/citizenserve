use crate::shared::{Error, Result};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Macos,
    Windows,
    LinuxArm,
    LinuxAmd,
}
impl Platform {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "macos" => Some(Self::Macos),
            "windows" => Some(Self::Windows),
            "linux-arm" => Some(Self::LinuxArm),
            "linux-amd" => Some(Self::LinuxAmd),
            _ => None,
        }
    }
    pub const fn name(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::LinuxArm => "linux-arm",
            Self::LinuxAmd => "linux-amd",
        }
    }
    pub const fn asset(self) -> (&'static str, &'static str) {
        match self {
            Self::Macos => ("macOS", "dmg"),
            Self::Windows => ("Windows", "exe"),
            Self::LinuxArm => ("LinuxARM", "deb"),
            Self::LinuxAmd => ("LinuxAMD", "deb"),
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DownloadRoute {
    App,
    Wallet,
    Chain(Platform),
    Updater,
    Publication(Platform, bool),
}
impl DownloadRoute {
    pub fn resolve(method: &str, path: &str) -> Option<Self> {
        if method == "GET" {
            match path {
                "/downloads/citizenapp/android" => return Some(Self::App),
                "/downloads/citizenwallet/android" => return Some(Self::Wallet),
                "/downloads/citizenchain/macos/updater" => return Some(Self::Updater),
                _ => {}
            }
        }
        let s = path.strip_prefix("/downloads/citizenchain/")?;
        if let Some(p) = s.strip_suffix("/publication").and_then(Platform::parse) {
            return match method {
                "GET" => Some(Self::Publication(p, false)),
                "PUT" => Some(Self::Publication(p, true)),
                _ => None,
            };
        }
        if method == "GET" {
            Platform::parse(s).map(Self::Chain)
        } else {
            None
        }
    }
    pub const fn method(self) -> &'static str {
        if matches!(self, Self::Publication(_, true)) {
            "PUT"
        } else {
            "GET"
        }
    }
    pub const fn body_limit(self) -> usize {
        if matches!(self, Self::Publication(_, true)) {
            16384
        } else {
            0
        }
    }
    pub const fn publication(self) -> bool {
        matches!(self, Self::Publication(..))
    }
    pub fn validate_query(self, q: &std::collections::BTreeMap<String, String>) -> Result<()> {
        if q.is_empty() {
            Ok(())
        } else {
            Err(Error::new(400, "invalid_download_request"))
        }
    }
}
