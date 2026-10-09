use crate::shared::{ids, Error, Result};
fn prefix(cid: &str, post_id: &str) -> Result<String> {
    ids::cid(cid)?;
    if post_id.is_empty()
        || !post_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::new(400, "invalid_post_id"));
    }
    Ok(format!("square/{cid}/posts/{post_id}"))
}
pub fn manifest_key(cid: &str, post_id: &str) -> Result<String> {
    Ok(format!("{}/manifest.json", prefix(cid, post_id)?))
}
pub fn media_keys(cid: &str, post_id: &str, index: u32, video: bool) -> Result<(String, String)> {
    let base = format!("{}/media/{index}", prefix(cid, post_id)?);
    Ok((
        format!("{base}/source.{}", if video { "mp4" } else { "webp" }),
        format!("{base}/{}.webp", if video { "cover" } else { "thumbnail" }),
    ))
}
