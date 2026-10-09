-- receipt的operation只在首次插入分配；同摘要重试不修改它。
INSERT INTO message_receipts(message_id,fingerprint,operation,expires_at)
VALUES(json_extract(?1,'$.message_id'),json_extract(?1,'$.fingerprint'),json_extract(?1,'$.operation'),json_extract(?1,'$.expires_at'))
ON CONFLICT(message_id) DO UPDATE SET fingerprint=excluded.fingerprint;
-- next
INSERT INTO messages(message_id,user_id,device_id,record,wire_bytes,accepted_at,expires_at)
SELECT json_extract(?1,'$.message_id'),json_extract(j.value,'$.record.recipient_user_id'),json_extract(j.value,'$.record.recipient_device_id'),json_extract(j.value,'$.record'),json_extract(j.value,'$.wire_bytes'),json_extract(j.value,'$.record.accepted_at_millis'),json_extract(j.value,'$.record.expires_at_millis')
FROM json_each(?1,'$.records') j
WHERE EXISTS(SELECT 1 FROM message_receipts r WHERE r.message_id=json_extract(?1,'$.message_id') AND r.operation=json_extract(?1,'$.operation'));
-- next
INSERT INTO push_jobs(message_id,user_id,device_id,state,due_at)
SELECT m.message_id,m.user_id,m.device_id,'pending',m.accepted_at FROM messages m JOIN message_receipts r ON r.message_id=m.message_id
WHERE r.message_id=json_extract(?1,'$.message_id') AND r.operation=json_extract(?1,'$.operation');
