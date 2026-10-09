//! 服务端已验证的证据进入同一原子批；提交时重取真实时钟。
use super::{all, external_batch, fail, first, string};
use citizenserve::{
    chain::settlement::Proof,
    shared::{Error, Result},
    topup::{evm_verify::Payment, orders::Order, ports::Repository, settlement::Cursor},
};
use serde_json::json;
use worker::{send::SendFuture, D1Database};
pub struct D1Topup {
    pub db: D1Database,
}
impl Repository for D1Topup {
    fn by_tx(
        &self,
        chain: u64,
        tx: &str,
    ) -> impl std::future::Future<Output = Result<Option<Order>>> + Send {
        SendFuture::new(async move {
            first(
                &self.db,
                "SELECT * FROM topup_orders WHERE chain_id=?1 AND evm_tx_hash=?2",
                &[string(&chain.to_string()), string(tx)],
            )
            .await
        })
    }
    fn by_id(&self, id: &str) -> impl std::future::Future<Output = Result<Option<Order>>> + Send {
        SendFuture::new(async move {
            first(
                &self.db,
                "SELECT * FROM topup_orders WHERE order_id=?1",
                &[string(id)],
            )
            .await
        })
    }
    fn insert(
        &self,
        o: &Order,
        p: &Payment,
    ) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"order":o,"payment":p}),
                include_str!("../sql/insert_topup.sql"),
                Error::new(409, "topup_txhash_claimed"),
            )
            .await?;
            self.by_tx(o.chain_id, &o.evm_tx_hash)
                .await?
                .ok_or_else(fail)
        })
    }
    fn consume_rpc_budget(
        &self,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            external_batch(&self.db,json!({}),r#"-- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) VALUES('topup-rpc:8453',1,json_extract(?1,'$.now')+60000) ON CONFLICT(rate_key) DO UPDATE SET request_count=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN 1 ELSE request_count+1 END,expires_at=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN json_extract(?1,'$.now')+60000 ELSE expires_at END;
 -- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'topup-rpc-assert',NULL,0 WHERE EXISTS(SELECT 1 FROM rate_windows WHERE rate_key='topup-rpc:8453' AND request_count>300 AND expires_at>json_extract(?1,'$.now'));
 "#,Error::new(429,"topup_rpc_rate_exceeded")).await
        })
    }
    fn list(
        &self,
        history: bool,
        limit: u32,
        cursor: Option<&Cursor>,
    ) -> impl std::future::Future<Output = Result<Vec<Order>>> + Send {
        SendFuture::new(async move {
            let (time, id) = cursor
                .map(|c| (c.confirmed_at, c.order_id.as_str()))
                .unwrap_or((0, ""));
            all(&self.db,if history{"SELECT * FROM topup_orders WHERE (?1=0 OR confirmed_at<?1 OR (confirmed_at=?1 AND order_id<?2)) ORDER BY confirmed_at DESC,order_id DESC LIMIT ?3"}else{"SELECT * FROM topup_orders WHERE status='pending' ORDER BY confirmed_at,order_id LIMIT ?3"},&[string(&time.to_string()),string(id),string(&limit.to_string())]).await
        })
    }
    fn claim(
        &self,
        id: &str,
        claim: &str,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"id":id,"claim":claim}),
                include_str!("../sql/claim_topup.sql"),
                Error::new(409, "topup_claim_mismatch"),
            )
            .await?;
            self.by_id(id).await?.ok_or_else(fail)
        })
    }
    fn paid(
        &self,
        b: &Order,
        p: &Proof,
        payment: &Payment,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"before":b,"proof":p,"payment":payment}),
                include_str!("../sql/settle_topup.sql"),
                Error::new(409, "topup_settlement_conflict"),
            )
            .await?;
            self.by_id(&b.order_id).await?.ok_or_else(fail)
        })
    }
    fn exception(
        &self,
        id: &str,
        claim: &str,
        reason: &str,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"id":id,"claim":claim,"reason":reason}),
                include_str!("../sql/exception_topup.sql"),
                Error::new(409, "topup_exception_conflict"),
            )
            .await?;
            self.by_id(id).await?.ok_or_else(fail)
        })
    }
}
