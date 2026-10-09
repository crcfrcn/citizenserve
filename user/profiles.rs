use crate::shared::{ids, Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    pub display_name: String,
    pub bio: String,
}
impl ProfileInput {
    pub fn validate(&self) -> Result<()> {
        // JS旧实现按UTF-16长度限额；Rust chars计数会放宽emoji配额，必须保持代码单元规则。
        if self.display_name.encode_utf16().count() > 40 || self.bio.encode_utf16().count() > 160 {
            return Err(Error::new(400, "profile_invalid"));
        }
        Ok(())
    }
}
/// 与旧JavaScript trim相同的空白集合；不能因Rust额外识别NEL而改变资料内容。
pub fn trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn asset_key(cid: &str, kind: &str) -> Result<String> {
    ids::cid(cid)?;
    if !matches!(kind, "avatar" | "banner") {
        return Err(Error::new(400, "profile_asset_invalid"));
    }
    Ok(format!("profile/{cid}/{kind}"))
}
