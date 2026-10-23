-- 先持久CAS租约/尝试次数，再做外部请求。过期租约不重置尝试次数。
-- statement
UPDATE notification_jobs SET state='blocked',lease_token=NULL,lease_expires_at=0,updated_at=json_extract(?1,'$.now') WHERE json_extract(?1,'$.kind')='fanout' AND job_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND attempts>=4;
-- statement
UPDATE notification_jobs SET state='leased',lease_token=json_extract(?1,'$.nonce'),lease_expires_at=json_extract(?1,'$.now')+120000,attempts=attempts+1,updated_at=json_extract(?1,'$.now') WHERE json_extract(?1,'$.kind')='fanout' AND job_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND next_attempt_at<=json_extract(?1,'$.now') AND attempts<4;
-- statement
UPDATE notification_deliveries SET state='blocked',lease_token=NULL,lease_expires_at=0,updated_at=json_extract(?1,'$.now') WHERE json_extract(?1,'$.kind')='delivery' AND delivery_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND attempts>=4;
-- statement
UPDATE notification_deliveries SET state='leased',lease_token=json_extract(?1,'$.nonce'),lease_expires_at=json_extract(?1,'$.now')+120000,attempts=attempts+1,updated_at=json_extract(?1,'$.now') WHERE json_extract(?1,'$.kind')='delivery' AND delivery_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND next_attempt_at<=json_extract(?1,'$.now') AND attempts<4;
