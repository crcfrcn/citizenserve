-- 本模块只拥有充值订单和公开账户执行占用；不含种子，不触及其他业务表。
CREATE TABLE IF NOT EXISTS topup_orders (
 order_id TEXT PRIMARY KEY NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 dispatch_at INTEGER NOT NULL DEFAULT 0,
 intent_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.intent.intent_id')) STORED NOT NULL,
 network TEXT GENERATED ALWAYS AS (json_extract(data,'$.intent.network')) STORED NOT NULL,
 token TEXT GENERATED ALWAYS AS (json_extract(data,'$.intent.token')) STORED NOT NULL,
 payment_txid TEXT GENERATED ALWAYS AS (json_extract(data,'$.payment_txid')) STORED,
 phase TEXT GENERATED ALWAYS AS (json_extract(data,'$.phase')) STORED NOT NULL,
 created_at INTEGER GENERATED ALWAYS AS (json_extract(data,'$.created_at')) STORED NOT NULL,
 gmb_tx_hash TEXT GENERATED ALWAYS AS (coalesce(json_extract(data,'$.signed.tx_hash'),json_extract(data,'$.legacy.gmb_tx_hash'))) STORED,
 CHECK(order_id=json_extract(data,'$.order_id') AND length(order_id)=36 AND substr(order_id,1,4)='top_' AND substr(order_id,5) NOT GLOB '*[^0-9a-f]*'),
 CHECK(json_type(data,'$.revision')='integer' AND json_extract(data,'$.revision')>=0),
 CHECK(phase IN ('awaiting','verifying','received','signed','broadcast','paid','exception')),
 CHECK((json_type(data,'$.legacy')='object' AND phase IN ('paid','exception') AND json_type(data,'$.signed')='null') OR (
 json_type(data,'$.legacy')='null' AND (
  (token='USDC' AND network='ethereum' AND json_extract(data,'$.intent.asset')='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') OR
  (token='USDC' AND network='base' AND json_extract(data,'$.intent.asset')='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') OR
  (token='USDC' AND network='solana' AND json_extract(data,'$.intent.asset')='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') OR
  (token='USDT' AND network='ethereum' AND json_extract(data,'$.intent.asset')='0xdac17f958d2ee523a2206206994597c13d831ec7') OR
  (token='USDT' AND network='tron' AND json_extract(data,'$.intent.asset')='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') OR
  (token='USDT' AND network='bnb' AND json_extract(data,'$.intent.asset')='0x55d398326f99059ff775485246999027b3197955')))),
 CHECK(json_extract(data,'$.intent.expires_at')=json_extract(data,'$.intent.issued_at')+600000),
 CHECK((json_extract(data,'$.intent.package_id')='pkg_15' AND json_extract(data,'$.intent.coin_fen')='1000000' AND json_extract(data,'$.intent.pay_amount')=CASE WHEN network='bnb' THEN '15000000000000000000' ELSE '15000000' END) OR
 (json_extract(data,'$.intent.package_id')='pkg_1400' AND json_extract(data,'$.intent.coin_fen')='100000000' AND json_extract(data,'$.intent.pay_amount')=CASE WHEN network='bnb' THEN '1400000000000000000000' ELSE '1400000000' END)),
 CHECK(phase IN ('awaiting','exception') OR payment_txid IS NOT NULL),
 CHECK(phase NOT IN ('signed','broadcast') OR (json_type(data,'$.signed')='object' AND json_type(data,'$.payment')='object')),
 CHECK(phase!='paid' OR json_type(data,'$.gmb')='object' OR json_type(data,'$.legacy')='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_intent ON topup_orders(intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_payment ON topup_orders(network,payment_txid) WHERE payment_txid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_gmb ON topup_orders(gmb_tx_hash) WHERE gmb_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topup_pending ON topup_orders(phase,dispatch_at,created_at,order_id);
CREATE INDEX IF NOT EXISTS idx_topup_history ON topup_orders(created_at DESC,order_id DESC);
CREATE TABLE IF NOT EXISTS topup_accounts (
 account_id TEXT PRIMARY KEY NOT NULL,
 order_id TEXT NOT NULL UNIQUE,
 claim TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
