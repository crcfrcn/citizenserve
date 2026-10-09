use super::{Error, Result, MAX_SAFE_INTEGER};

pub fn hex(value: &str, bytes: usize, prefix: bool) -> bool {
    let value = if prefix {
        match value.strip_prefix("0x") {
            Some(v) => v,
            None => return false,
        }
    } else {
        value
    };
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn account(value: &str) -> Result<()> {
    if hex(value, 32, true) {
        Ok(())
    } else {
        Err(Error::new(400, "invalid_account_id"))
    }
}
pub fn cid(value: &str) -> Result<()> {
    if !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(())
    } else {
        Err(Error::new(400, "invalid_cid_number"))
    }
}
pub fn positive(value: u64) -> bool {
    value > 0 && value <= MAX_SAFE_INTEGER
}
pub fn uuid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && b.iter().enumerate().all(|(i, &x)| {
            [8, 13, 18, 23].contains(&i) || x.is_ascii_digit() || (b'a'..=b'f').contains(&x)
        })
}
pub fn uuid_from_random(mut bytes: [u8; 16]) -> String {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = super::crypto::hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
/// URL 序列化必须仍等于原始源，阻断默认端口、大小写、凭据及路径歧义。
pub fn origin(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| Error::new(400, "invalid_service_origin"))?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port() == Some(0)
        || !value.is_ascii()
        || url.host_str().is_none()
    {
        return Err(Error::new(400, "invalid_service_origin"));
    }
    if let Some(url::Host::Domain(host)) = url.host() {
        if host.len() > 253
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            return Err(Error::new(400, "invalid_service_origin"));
        }
    }
    Ok(url)
}
