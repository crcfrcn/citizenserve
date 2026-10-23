-- 最新会员行和独立同步健康在原写事务复核；旧许可不能跨越降档、撤销或续费。
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT EXISTS(
 SELECT 1 FROM square_memberships m
 JOIN scheduler_leases h ON h.lease_key='sync:membership:'||json_extract(?1,'$.auth.chain_scope')
 JOIN membership_projection_cursor c ON c.cursor_id=1 AND c.finalized_block_number>=h.last_slot
 WHERE m.cid_number=json_extract(?1,'$.auth.cid_number')
 AND m.membership_level=json_extract(?1,'$.membership_level')
 AND m.subscription_status=json_extract(?1,'$.membership_status') AND m.subscription_status IN ('active','cancelled')
 AND m.paid_until=json_extract(?1,'$.paid_until') AND m.paid_until>json_extract(?1,'$.auth.now')
 AND m.last_charged_at=json_extract(?1,'$.period_start') AND m.finalized_block_number=json_extract(?1,'$.membership_block')
 AND h.updated_at>0 AND h.updated_at<=json_extract(?1,'$.auth.now')
 AND h.updated_at+json_extract(?1,'$.auth.sync_health_millis')>json_extract(?1,'$.auth.now'));
-- statement
-- 只消费服务器生成的会员许可；batch先执行原AUTH_ASSERT，错误整体回滚。
INSERT INTO user_profiles(cid_number,display_name) SELECT '',NULL WHERE COALESCE((
 json_type(?1,'$.membership_checked')='integer' AND json_type(?1,'$.membership_deadline')='integer'
 AND json_extract(?1,'$.membership_checked')<=json_extract(?1,'$.auth.now')
 AND json_extract(?1,'$.auth.now')<json_extract(?1,'$.membership_deadline')
 AND json_extract(?1,'$.membership_deadline')<=json_extract(?1,'$.membership_checked')+60000
 AND json_extract(?1,'$.paid_until')>MAX(json_extract(?1,'$.auth.now'),json_extract(?1,'$.chain_time'))),0)=0;
-- statement
-- 普通读取只有汇总；稳定发布才消费原幂等回执。整数安全边界仍由同事务断言。
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE COALESCE((
 json_extract(?1,'$.metric') IN ('browse','detail','profile','published')
 AND json_type(?1,'$.amount')='integer' AND json_extract(?1,'$.amount') BETWEEN 0 AND 9007199254740991
 AND json_type(?1,'$.period')='integer' AND json_extract(?1,'$.period') BETWEEN 0 AND 9007199254740991
 AND (json_extract(?1,'$.metric')<>'published' OR (
  json_type(?1,'$.operation_id')='text' AND json_type(?1,'$.resource_key')='text'
  AND length(json_extract(?1,'$.operation_id')) BETWEEN 1 AND 160 AND length(json_extract(?1,'$.resource_key'))<=8192))),0)=0;
-- statement
INSERT OR IGNORE INTO membership_operations(cid_number,operation_id,metric,resource_key,amount,state,period_start,created_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.operation_id'),'published',json_extract(?1,'$.resource_key'),json_extract(?1,'$.amount'),'reserved',json_extract(?1,'$.period'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.metric')='published';
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE json_extract(?1,'$.metric')='published' AND NOT EXISTS(
 SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id')
 AND metric='published' AND resource_key=json_extract(?1,'$.resource_key') AND amount=json_extract(?1,'$.amount')
 AND (period_start=json_extract(?1,'$.period') OR state='committed'));
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.day'),json_extract(?1,'$.amount'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.metric')='browse' AND json_extract(?1,'$.amount')>0
ON CONFLICT(cid_number,browse_day) DO UPDATE SET browse_count=square_browse_days.browse_count+excluded.browse_count,updated_at=excluded.updated_at
WHERE square_browse_days.browse_count<=COALESCE(json_extract(?1,'$.browse_limit'),9007199254740991)-excluded.browse_count;
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at) SELECT '', '', NULL, 0
WHERE json_extract(?1,'$.metric')='browse' AND json_extract(?1,'$.amount')>0 AND (changes()<>1 OR json_extract(?1,'$.amount')>COALESCE(json_extract(?1,'$.browse_limit'),9007199254740991));
-- statement
INSERT INTO membership_usage(cid_number,metric,period_start,amount,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.metric'),json_extract(?1,'$.period'),json_extract(?1,'$.amount'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.metric') IN ('detail','profile') OR (json_extract(?1,'$.metric')='published' AND EXISTS(SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved'))
ON CONFLICT(cid_number,metric,period_start) DO UPDATE SET amount=membership_usage.amount+excluded.amount,updated_at=excluded.updated_at
WHERE membership_usage.amount<=9007199254740991-excluded.amount;
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE (json_extract(?1,'$.metric') IN ('detail','profile') OR (json_extract(?1,'$.metric')='published' AND EXISTS(SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved'))) AND changes()<>1;
-- statement
UPDATE membership_operations SET state='committed' WHERE json_extract(?1,'$.metric')='published' AND cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved';

-- resource budget
-- 原汇总表按服务器UTC日预扣；AUTH_ASSERT始终由同一batch先执行，不新增随机访问流水。
-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'quota:assert',NULL,0
WHERE json_type(?1,'$.quota') IS NOT NULL AND COALESCE((
 json_type(?1,'$.quota.member') IN ('true','false') AND json_type(?1,'$.quota.day_millis')='integer'
 AND json_extract(?1,'$.quota.day_millis')>0 AND json_type(?1,'$.quota.charges')='array'
 AND json_array_length(?1,'$.quota.charges') BETWEEN 1 AND 8
 AND NOT EXISTS(SELECT 1 FROM json_each(?1,'$.quota.charges') j WHERE COALESCE((
  json_type(j.value,'$.metric')='text' AND json_extract(j.value,'$.metric') IN ('chat_connections','chat_commands','chat_frame_bytes','chat_deliveries','attachment_begins','chat_chunk_operations','upload_bytes','delivery_bytes','media_requests','profile_requests','profile_read_bytes')
  AND json_type(j.value,'$.amount')='integer' AND json_extract(j.value,'$.amount') BETWEEN 1 AND 9007199254740991
  AND json_type(j.value,'$.cid_limit')='integer' AND json_extract(j.value,'$.cid_limit') BETWEEN 1 AND 9007199254740991
  AND json_type(j.value,'$.global_limit')='integer' AND json_extract(j.value,'$.global_limit') BETWEEN 1 AND 9007199254740991
  AND json_extract(j.value,'$.amount')<=json_extract(j.value,'$.cid_limit') AND json_extract(j.value,'$.amount')<=json_extract(j.value,'$.global_limit')),0)=0)
 AND (SELECT COUNT(DISTINCT json_extract(value,'$.metric')) FROM json_each(?1,'$.quota.charges'))=json_array_length(?1,'$.quota.charges')
 AND (json_extract(?1,'$.quota.member')=1 OR NOT EXISTS(SELECT 1 FROM json_each(?1,'$.quota.charges') WHERE json_extract(value,'$.metric') IN ('attachment_begins','chat_chunk_operations','upload_bytes','delivery_bytes','media_requests')))
),0)=0;
-- statement
-- 会员对象操作继续复核真实行/版本/健康；基础聊天及获准基础资料媒体仍需原公民会话。
INSERT INTO user_profiles(cid_number,display_name) SELECT '',NULL
WHERE json_extract(?1,'$.quota.member')=1 AND (NOT EXISTS(
 SELECT 1 FROM square_memberships m
 JOIN scheduler_leases h ON h.lease_key='sync:membership:'||json_extract(?1,'$.auth.chain_scope')
 JOIN membership_projection_cursor c ON c.cursor_id=1 AND c.finalized_block_number>=h.last_slot
 WHERE m.cid_number=json_extract(?1,'$.auth.cid_number')
 AND m.membership_level=json_extract(?1,'$.membership_level') AND m.subscription_status=json_extract(?1,'$.membership_status') AND m.subscription_status IN ('active','cancelled')
 AND m.paid_until=json_extract(?1,'$.paid_until') AND m.paid_until>json_extract(?1,'$.auth.now')
 AND m.last_charged_at=json_extract(?1,'$.period_start') AND m.finalized_block_number=json_extract(?1,'$.membership_block')
 AND h.updated_at>0 AND h.updated_at<=json_extract(?1,'$.auth.now') AND h.updated_at+json_extract(?1,'$.auth.sync_health_millis')>json_extract(?1,'$.auth.now'))
 OR COALESCE(json_extract(?1,'$.membership_checked')<=json_extract(?1,'$.auth.now') AND json_extract(?1,'$.auth.now')<json_extract(?1,'$.membership_deadline')
 AND json_extract(?1,'$.membership_deadline')<=json_extract(?1,'$.membership_checked')+60000
 AND json_extract(?1,'$.paid_until')>MAX(json_extract(?1,'$.auth.now'),json_extract(?1,'$.chain_time')),0)=0);
-- statement
INSERT INTO membership_usage(cid_number,metric,period_start,amount,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(j.value,'$.metric'),
 CAST(json_extract(?1,'$.auth.now')/json_extract(?1,'$.quota.day_millis') AS INTEGER)*json_extract(?1,'$.quota.day_millis'),
 json_extract(j.value,'$.amount'),json_extract(?1,'$.auth.now') FROM json_each(?1,'$.quota.charges') j
-- 同事务先检查整组两侧余量，预期超额时不制造稍后回滚的计数写入成本。
WHERE NOT EXISTS(
 SELECT 1 FROM json_each(?1,'$.quota.charges') q
 LEFT JOIN membership_usage u ON u.cid_number=json_extract(?1,'$.auth.cid_number') AND u.metric=json_extract(q.value,'$.metric')
 AND u.period_start=CAST(json_extract(?1,'$.auth.now')/json_extract(?1,'$.quota.day_millis') AS INTEGER)*json_extract(?1,'$.quota.day_millis')
 LEFT JOIN rate_windows g ON g.rate_key='quota:global:'||CAST(CAST(json_extract(?1,'$.auth.now')/json_extract(?1,'$.quota.day_millis') AS INTEGER) AS TEXT)||':'||json_extract(q.value,'$.metric')
 WHERE COALESCE(u.amount,0)>json_extract(q.value,'$.cid_limit')-json_extract(q.value,'$.amount')
 OR COALESCE(g.request_count,0)>json_extract(q.value,'$.global_limit')-json_extract(q.value,'$.amount') OR COALESCE(g.request_count,0)<0)
ON CONFLICT(cid_number,metric,period_start) DO UPDATE SET amount=membership_usage.amount+excluded.amount,updated_at=excluded.updated_at;
-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'quota:assert',NULL,0
WHERE json_type(?1,'$.quota') IS NOT NULL AND changes()<>json_array_length(?1,'$.quota.charges');
-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at)
SELECT 'quota:global:'||CAST(CAST(json_extract(?1,'$.auth.now')/json_extract(?1,'$.quota.day_millis') AS INTEGER) AS TEXT)||':'||json_extract(j.value,'$.metric'),
 json_extract(j.value,'$.amount'),(CAST(json_extract(?1,'$.auth.now')/json_extract(?1,'$.quota.day_millis') AS INTEGER)+1)*json_extract(?1,'$.quota.day_millis')
FROM json_each(?1,'$.quota.charges') j WHERE 1
ON CONFLICT(rate_key) DO UPDATE SET request_count=rate_windows.request_count+excluded.request_count;
-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'quota:assert',NULL,0
WHERE json_type(?1,'$.quota') IS NOT NULL AND changes()<>json_array_length(?1,'$.quota.charges');
