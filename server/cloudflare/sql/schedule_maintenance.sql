-- 准确固定调度槽，只在任务确已持久化后推进last_slot；旧日任务未完成就不丢掉下一日期。
-- statement
INSERT OR IGNORE INTO scheduler_leases(lease_key,updated_at) VALUES(json_extract(?1,'$.key'),json_extract(?1,'$.now'));
-- statement
UPDATE scheduler_leases SET lease_token=json_extract(?1,'$.nonce'),lease_expires_at=json_extract(?1,'$.now')+120000,updated_at=json_extract(?1,'$.now') WHERE lease_key=json_extract(?1,'$.key') AND lease_expires_at<=json_extract(?1,'$.now') AND last_slot<json_extract(?1,'$.slot');
-- statement
INSERT OR IGNORE INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) SELECT json_extract(?1,'$.job_id'),json_extract(?1,'$.work'),json_extract(?1,'$.slot'),json_extract(?1,'$.now') WHERE EXISTS(SELECT 1 FROM scheduler_leases WHERE lease_key=json_extract(?1,'$.key') AND lease_token=json_extract(?1,'$.nonce') AND lease_expires_at>json_extract(?1,'$.now'));
-- statement
UPDATE scheduler_leases SET last_slot=json_extract(?1,'$.slot'),lease_token=NULL,lease_expires_at=0,updated_at=json_extract(?1,'$.now') WHERE lease_key=json_extract(?1,'$.key') AND lease_token=json_extract(?1,'$.nonce') AND EXISTS(SELECT 1 FROM maintenance_jobs WHERE job_id=json_extract(?1,'$.job_id'));
