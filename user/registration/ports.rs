use super::protocol::Enrollment;
use crate::shared::Result;

/// 此CAS只管理准备/验证/取消，禁止直接写activated；激活由AuthRepository完整事务提交。
/// 过期即无效，version只增；平台实现可以是D1单语句或未来自建事务。
/// 创建必须原子检查每上下文8条、全环境100000条有效未完成登记。
/// 平台返回false表示竞争失败，调用方重新读取成功结果，不能以本地快照覆盖。
pub trait Repository {
    fn create(
        &self,
        row: &Enrollment,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn read(
        &self,
        enrollment_id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Enrollment>>> + Send;
    fn read_attempt(
        &self,
        verification_id: &str,
    ) -> impl std::future::Future<Output = Result<Option<Enrollment>>> + Send;
    fn compare_and_swap(
        &self,
        before: &Enrollment,
        after: &Enrollment,
        now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send;
    fn cleanup(&self, now: u64) -> impl std::future::Future<Output = Result<u64>> + Send;
}
