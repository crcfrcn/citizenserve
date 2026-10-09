-- 维护任务租约排他，崩溃保留对象定位和已完成阶段。
-- statement
UPDATE maintenance_jobs SET state='blocked',lease_token=NULL,lease_expires_at=0,updated_at=json_extract(?1,'$.now') WHERE job_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND attempts>=4;
-- statement
UPDATE maintenance_jobs SET state='leased',lease_token=json_extract(?1,'$.nonce'),lease_expires_at=json_extract(?1,'$.now')+120000,attempts=attempts+1,updated_at=json_extract(?1,'$.now') WHERE job_id=json_extract(?1,'$.id') AND state IN ('pending','leased') AND lease_expires_at<=json_extract(?1,'$.now') AND next_attempt_at<=json_extract(?1,'$.now') AND attempts<4;
