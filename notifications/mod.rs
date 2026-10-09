pub mod delivery;
pub mod endpoint;
pub mod fanout;
pub mod inbox;
pub mod jobs;
pub mod ports;
pub mod routes;
pub const ENDPOINTS_PER_CID: u8 = 8;
pub const ENDPOINT_TTL_MILLIS: u64 = 90 * 24 * 60 * 60 * 1000;
pub fn validate_payload(payload: &[u8]) -> crate::shared::Result<()> {
    if payload.len() > 4096 {
        Err(crate::shared::Error::new(413, "push_payload_too_large"))
    } else {
        Ok(())
    }
}
