//! 密钥包Cloudflare适配；校验和协议预算使用唯一通用核心。
mod store;
pub(crate) fn bytes(
    package: &citizenserve::tatachat::key::Package,
) -> citizenserve::tatachat::Result<usize> {
    citizenserve::tatachat::protocol::key_package_batch_frame(std::slice::from_ref(package))
        .map(|f| citizenserve::tatachat::protocol::encoded_len(&f))
}
