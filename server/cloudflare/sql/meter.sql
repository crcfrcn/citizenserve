-- 只消费服务器生成的会员许可；batch先执行原AUTH_ASSERT，错误整体回滚。
-- statement
INSERT INTO user_profiles(cid_number,display_name) SELECT '',NULL WHERE COALESCE((
 json_type(?1,'$.membership_checked')='integer' AND json_type(?1,'$.membership_deadline')='integer'
 AND json_extract(?1,'$.membership_checked')<=json_extract(?1,'$.auth.now')
 AND json_extract(?1,'$.auth.now')<json_extract(?1,'$.membership_deadline')
 AND json_extract(?1,'$.membership_deadline')<=json_extract(?1,'$.membership_checked')+60000
 AND json_extract(?1,'$.paid_until')>MAX(json_extract(?1,'$.auth.now'),json_extract(?1,'$.chain_time'))),0)=0;
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE COALESCE((
 json_extract(?1,'$.metric') IN ('browse','detail','profile','delivery_bytes','published')
 AND json_type(?1,'$.amount')='integer' AND json_extract(?1,'$.amount') BETWEEN 0 AND 9007199254740991
 AND json_type(?1,'$.period')='integer' AND json_extract(?1,'$.period') BETWEEN 0 AND 9007199254740991
 AND json_type(?1,'$.operation_id')='text' AND json_type(?1,'$.resource_key')='text'
 AND length(json_extract(?1,'$.operation_id')) BETWEEN 1 AND 160 AND length(json_extract(?1,'$.resource_key'))<=8192),0)=0;
-- statement
INSERT OR IGNORE INTO membership_operations(cid_number,operation_id,metric,resource_key,amount,state,period_start,created_at)
VALUES(json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.operation_id'),json_extract(?1,'$.metric'),json_extract(?1,'$.resource_key'),json_extract(?1,'$.amount'),'reserved',json_extract(?1,'$.period'),json_extract(?1,'$.auth.now'));
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT EXISTS(
 SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id')
 AND metric=json_extract(?1,'$.metric') AND resource_key=json_extract(?1,'$.resource_key') AND amount=json_extract(?1,'$.amount')
 -- 已提交发布是永久业务事件，续费后的同结果重试保留首次周期；其它指标仍严格匹配。
 AND (period_start=json_extract(?1,'$.period') OR (metric='published' AND state='committed')));
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.day'),json_extract(?1,'$.amount'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.metric')='browse' AND json_extract(?1,'$.amount')>0 AND EXISTS(SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved')
ON CONFLICT(cid_number,browse_day) DO UPDATE SET browse_count=square_browse_days.browse_count+excluded.browse_count,updated_at=excluded.updated_at
WHERE square_browse_days.browse_count<=COALESCE(json_extract(?1,'$.browse_limit'),9007199254740991)-excluded.browse_count;
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at) SELECT '', '', NULL, 0
WHERE json_extract(?1,'$.metric')='browse' AND json_extract(?1,'$.amount')>0 AND EXISTS(SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved') AND (changes()<>1 OR json_extract(?1,'$.amount')>COALESCE(json_extract(?1,'$.browse_limit'),9007199254740991));
-- statement
INSERT INTO membership_usage(cid_number,metric,period_start,amount,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.metric'),json_extract(?1,'$.period'),json_extract(?1,'$.amount'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.metric')<>'browse' AND EXISTS(SELECT 1 FROM membership_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved')
ON CONFLICT(cid_number,metric,period_start) DO UPDATE SET amount=membership_usage.amount+excluded.amount,updated_at=excluded.updated_at;
-- statement
UPDATE membership_operations SET state='committed' WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND operation_id=json_extract(?1,'$.operation_id') AND state='reserved';
