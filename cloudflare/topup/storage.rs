//! D1只持久订单、公开执行占用与待派发时间。业务CAS和账户claim在同批验证。
use crate::repositories::{all, external_batch, fail, first, string};
use citizenserve::{
    shared::{Error, Result},
    topup::{config::Network, orders::Order, ports::Repository, settlement::Cursor},
};
use serde::Deserialize;
use serde_json::{json, Value};
use worker::{send::SendFuture, D1Database, Env};
pub struct D1Topup {
    pub db: D1Database,
}
#[derive(Deserialize)]
struct Row {
    data: String,
}
impl Row {
    fn order(self) -> Result<Order> {
        serde_json::from_str(&self.data).map_err(|_| fail())
    }
}
impl D1Topup {
    pub fn configured(env: &Env) -> Result<Self> {
        Ok(Self {
            db: env.d1("DB").map_err(|_| fail())?,
        })
    }
    pub async fn defer(&self, id: &str, now: u64) -> Result<()> {
        self.db
            .prepare("UPDATE topup_orders SET dispatch_at=?2 WHERE order_id=?1")
            .bind(&[string(id), string(&now.saturating_add(60000).to_string())])
            .map_err(|_| fail())?
            .run()
            .await
            .map_err(|_| fail())?;
        Ok(())
    }
}
impl Repository for D1Topup {
    fn by_id(&self, id: &str) -> impl std::future::Future<Output = Result<Option<Order>>> + Send {
        SendFuture::new(async move {
            first::<Row>(
                &self.db,
                "SELECT data FROM topup_orders WHERE order_id=?1",
                &[string(id)],
            )
            .await?
            .map(Row::order)
            .transpose()
        })
    }
    fn insert(&self, o: &Order) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"order":o}),
                include_str!("insert.sql"),
                Error::new(409, "topup_order_conflict"),
            )
            .await?;
            self.by_id(&o.order_id).await?.ok_or_else(fail)
        })
    }
    fn save(
        &self,
        b: &Order,
        a: &Order,
    ) -> impl std::future::Future<Output = Result<Order>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"before":b,"after":a}),
                include_str!("settle.sql"),
                Error::new(409, "topup_order_conflict"),
            )
            .await?;
            self.by_id(&a.order_id).await?.ok_or_else(fail)
        })
    }
    fn list(
        &self,
        limit: u32,
        cursor: Option<&Cursor>,
    ) -> impl std::future::Future<Output = Result<Vec<Order>>> + Send {
        SendFuture::new(async move {
            let (time, id) = cursor
                .map(|c| (c.confirmed_at, c.order_id.as_str()))
                .unwrap_or((0, ""));
            all::<Row>(&self.db,"SELECT data FROM topup_orders WHERE (?1=0 OR created_at<?1 OR (created_at=?1 AND order_id<?2)) ORDER BY created_at DESC,order_id DESC LIMIT ?3",&[string(&time.to_string()),string(id),string(&limit.to_string())]).await?.into_iter().map(Row::order).collect()
        })
    }
    fn pending(&self, limit: u32) -> impl std::future::Future<Output = Result<Vec<Order>>> + Send {
        SendFuture::new(async move {
            all::<Row>(&self.db,"SELECT data FROM topup_orders WHERE phase NOT IN ('awaiting','paid','exception') AND dispatch_at<=?1 ORDER BY dispatch_at,created_at,order_id LIMIT ?2",&[string(&(js_sys::Date::now() as u64).to_string()),string(&limit.to_string())]).await?.into_iter().map(Row::order).collect()
        })
    }
    fn lock(
        &self,
        o: &Order,
        account: &str,
        claim: &str,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<bool>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"order":o,"account":account,"claim":claim}),
                include_str!("claim.sql"),
                Error::new(409, "topup_account_busy"),
            )
            .await?;
            let row: Option<Value> = first(
                &self.db,
                "SELECT claim FROM topup_accounts WHERE account_id=?1 AND order_id=?2",
                &[string(account), string(&o.order_id)],
            )
            .await?;
            Ok(row.is_some_and(|v| v["claim"] == claim))
        })
    }
    fn unlock(
        &self,
        id: &str,
        account: &str,
        claim: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            external_batch(
                &self.db,
                json!({"id":id,"account":account,"claim":claim}),
                include_str!("exception.sql"),
                Error::new(409, "topup_account_conflict"),
            )
            .await
        })
    }
    fn budget(
        &self,
        network: Network,
        _now: u64,
    ) -> impl std::future::Future<Output = Result<()>> + Send {
        SendFuture::new(async move {
            external_batch(&self.db,json!({"key":format!("topup-rpc:{}",network.name())}),r#"-- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) VALUES(json_extract(?1,'$.key'),1,json_extract(?1,'$.now')+60000) ON CONFLICT(rate_key) DO UPDATE SET request_count=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN 1 ELSE request_count+1 END,expires_at=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN json_extract(?1,'$.now')+60000 ELSE expires_at END;
 -- statement
 INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'topup-rpc-assert',NULL,0 WHERE EXISTS(SELECT 1 FROM rate_windows WHERE rate_key=json_extract(?1,'$.key') AND request_count>300);
 "#,Error::new(429,"topup_rpc_rate_exceeded")).await
        })
    }
}
/// 旧表迁移只生成本功能的原子SQL批，不在HTTP/启动/scheduled中自动执行。
/// 历史凭据完整保留；旧claimed但没有完整签名字节不能猜测补发，必须核实原交易。
#[allow(dead_code)]
pub fn migration(rows: &[Value]) -> Result<Vec<String>> {
    let mut sql = vec!["ALTER TABLE topup_orders RENAME TO topup_previous".into()];
    // ALTER保留索引旧名；先删除本功能索引，其他表和索引不参与迁移。
    for name in [
        "idx_topup_paid_gmb",
        "idx_topup_orders_txhash",
        "idx_topup_orders_status",
        "idx_topup_orders_cid_number",
    ] {
        sql.push(format!("DROP INDEX IF EXISTS {name}"));
    }
    sql.extend(
        include_str!("schema.sql")
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    );
    sql.push(format!("INSERT INTO topup_previous(order_id) SELECT NULL WHERE (SELECT count(*) FROM topup_previous)!={}",rows.len()));
    for old in rows {
        let quote = |v: &str| format!("'{}'", v.replace('\'', "''"));
        let fields = old.as_object().ok_or_else(fail)?;
        if fields
            .keys()
            .any(|k| !k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        {
            return Err(fail());
        }
        let snapshot = quote(&old.to_string());
        let predicates = fields
            .keys()
            .map(|k| format!("{k} IS json_extract({snapshot},'$.{k}')"))
            .collect::<Vec<_>>()
            .join(" AND ");
        sql.push(format!("INSERT INTO topup_previous(order_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM topup_previous WHERE {predicates})"));
        let val = |name: &str| old.get(name).cloned().ok_or_else(fail);
        let intent = json!({"intent_id":val("intent_id")?,"cid_number":val("cid_number")?,"account_id":val("account_id")?,"payer_address":val("payer_address")?,"token":val("token")?,"network":"base","package_id":val("package_id")?,"asset":val("token_contract")?,"recv_address":val("recv_address")?,"pay_amount":val("pay_amount")?,"coin_fen":val("coin_fen")?,"issued_at":val("intent_issued_at")?,"expires_at":val("intent_expires_at")?});
        let data = json!({"order_id":val("order_id")?,"intent":intent,"intent_hash":val("intent_hash")?,"message":"","created_at":val("confirmed_at")?,"revision":0,"phase":if old["status"]=="paid"{"paid"}else{"exception"},"payment_txid":val("evm_tx_hash")?,"payer_signature":null,"payment":null,"signed":null,"legacy":old,"scan":0,"gmb":null,"exception_reason":if old["status"]=="paid"{Value::Null}else{json!("topup_legacy_requires_chain_resolution")}});
        // 通过真实Order解码核对类型，不把畸形历史记录静默丢弃。
        serde_json::from_value::<Order>(data.clone()).map_err(|_| fail())?;
        let quote = |v: &str| format!("'{}'", v.replace('\'', "''"));
        sql.push(format!(
            "INSERT INTO topup_orders(order_id,data) VALUES({},{})",
            quote(data["order_id"].as_str().ok_or_else(fail)?),
            quote(&data.to_string())
        ));
    }
    sql.push("DROP TABLE topup_previous".into());
    Ok(sql)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    #[test]
    fn legacy_migration_is_atomic_and_preserves_other_tables() {
        use std::io::Write;
        let fixture: Value =
            serde_json::from_str(include_str!("../../test/contract/topup.json")).unwrap();
        let mut paid = fixture["legacy"].clone();
        paid["status"] = json!("paid");
        paid["settlement_claim_id"] = json!(format!("tpc_{}", "33".repeat(16)));
        paid["settlement_claimed_at"] = json!(1005000);
        paid["settled_at"] = json!(1006000);
        paid["gmb_tx_hash"] = json!(format!("0x{}", "44".repeat(32)));
        paid["gmb_block_hash"] = json!(format!("0x{}", "55".repeat(32)));
        paid["gmb_extrinsic_index"] = json!(0);
        paid["gmb_evidence_hash"] = json!("66".repeat(32));
        // 已完成的旧Base USDT必须原样保留，但新支持名单不允许据此产生任何新出款。
        paid["token"] = json!("USDT");
        paid["token_contract"] = json!("0xfde4c96c8593536e31f229ea8f37b2ada2699bb2");
        let mut pending = fixture["legacy"].clone();
        pending["order_id"] = json!(format!("top_{}", "77".repeat(16)));
        pending["intent_id"] = json!(format!("tpi_{}", "77".repeat(16)));
        pending["evm_tx_hash"] = json!(format!("0x{}", "77".repeat(32)));
        pending["settlement_claim_id"] = json!(format!("tpc_{}", "77".repeat(16)));
        pending["settlement_claimed_at"] = json!(1005000);
        let rows = vec![paid, pending];
        let statements = migration(&rows).unwrap();
        let input = json!({"schema":fixture["legacy_schema"],"rows":rows,"statements":statements});
        let script = r#"
import sys,json,sqlite3
v=json.load(sys.stdin)
b=sqlite3.connect(':memory:',isolation_level=None)
b.executescript(v['schema'])
b.execute('CREATE TABLE protected_rows(id TEXT PRIMARY KEY,value TEXT)')
b.execute('CREATE INDEX protected_index ON protected_rows(value)')
b.execute('INSERT INTO protected_rows VALUES(?,?)',('untouched','business-row'))
for row in v['rows']:
 b.execute('INSERT INTO topup_orders('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',list(row.values()))
protected=lambda:(b.execute("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'protected_%' ORDER BY name").fetchall(),b.execute('SELECT * FROM protected_rows').fetchall())
original=protected()
# 真实事务中故障必须保留旧表、索引和两条历史行。
b.execute('BEGIN IMMEDIATE')
try:
 for statement in v['statements']:b.execute(statement)
 b.execute("INSERT INTO topup_orders(order_id,data) VALUES(NULL,'{}')")
 raise AssertionError('expected rollback')
except sqlite3.IntegrityError:b.rollback()
assert b.execute('SELECT count(*) FROM topup_orders').fetchone()[0]==2
assert 'chain_id' in [r[1] for r in b.execute('PRAGMA table_info(topup_orders)')]
assert protected()==original
b.execute('BEGIN IMMEDIATE')
for statement in v['statements']:b.execute(statement)
b.commit()
assert protected()==original
assert not b.execute("SELECT name FROM sqlite_master WHERE name='topup_previous'").fetchall()
new=[json.loads(r[0]) for r in b.execute('SELECT data FROM topup_orders ORDER BY order_id')]
assert len(new)==2
assert {r['phase'] for r in new}=={'paid','exception'}
for row in new:
 assert row['legacy'] in v['rows']
 assert row['signed'] is None
 assert row['legacy']['gmb_tx_hash']==(v['rows'][0]['gmb_tx_hash'] if row['phase']=='paid' else None)
assert b.execute('SELECT count(*) FROM topup_accounts').fetchone()[0]==0
assert b.execute("SELECT count(*) FROM topup_orders WHERE phase NOT IN ('paid','exception')").fetchone()[0]==0
"#;
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
