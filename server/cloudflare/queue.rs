//! Queue只接受数据库定位，终态持久化后ack；供应商成功不等于设备接收。
use citizenserve::{
    notifications::{
        jobs::{Disposition, Kind, Message},
        ports::Jobs,
    },
    server::maintenance::Budget,
};
use worker::{Env, MessageBatch, MessageExt, QueueRetryOptionsBuilder};
pub async fn consume(batch: MessageBatch<serde_json::Value>, env: &Env) -> worker::Result<()> {
    for message in batch.messages()? {
        // 按真实队列身份分流后恢复原通知类型，公开负载合同保持不变。
        let parsed: Message = serde_json::from_value(message.body().clone())
            .map_err(|_| worker::Error::RustError("notification_message_invalid".into()))?;
        let body = &parsed;
        let budget = Budget::default();
        let nonce = citizenserve::shared::crypto::hex(
            &crate::runtime::random::<16>()
                .map_err(|_| worker::Error::RustError("queue_entropy_unavailable".into()))?,
        );
        let job_future = async {
            body.validate()?;

            let jobs =
                crate::repositories::notification_jobs::D1Jobs::configured(env, budget.clone())?;
            match body.kind {
                Kind::Fanout => {
                    citizenserve::notifications::fanout::run(
                        &jobs,
                        &crate::runtime::Clock,
                        body,
                        &nonce,
                    )
                    .await
                }
                Kind::Delivery => {
                    if jobs.disposition(body, js_sys::Date::now() as u64).await? == Disposition::Ack
                    {
                        return Ok(Disposition::Ack);
                    }
                    let payload = jobs.payload(body).await?;
                    citizenserve::notifications::delivery::run(
                        &jobs,
                        &crate::runtime::Clock,
                        body,
                        &nonce,
                        &payload,
                    )
                    .await
                }
                Kind::Maintenance => {
                    crate::maintenance::consume(env, body, budget.clone(), &nonce).await
                }
            }
        };
        futures_util::pin_mut!(job_future);
        let renewer =
            crate::repositories::notification_jobs::D1Jobs::configured(env, budget.clone())
                .map_err(|_| worker::Error::RustError("queue_storage_unavailable".into()))?;
        let result = loop {
            let tick = worker::Delay::from(std::time::Duration::from_secs(30));
            match futures_util::future::select(job_future.as_mut(), tick).await {
                futures_util::future::Either::Left((result, _)) => break result,
                futures_util::future::Either::Right((_, _)) => {
                    if let Err(error) = renewer.renew_message(body, &nonce).await {
                        break Err(error);
                    }
                }
            }
        };
        match result {
            Ok(Disposition::Ack) => message.ack(),
            Ok(Disposition::Retry(delay)) => message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds(delay)
                    .build(),
            ),
            Err(_) => message.retry_with_options(
                &QueueRetryOptionsBuilder::new()
                    .with_delay_seconds(120)
                    .build(),
            ),
        };
    }
    Ok(())
}
