-- 每个维护阶段的对象结果/游标持久提交；无进展失败不能重置四次尝试上限。
-- statement
INSERT INTO maintenance_jobs(job_id,work_kind,scheduled_at,updated_at) SELECT NULL,'authentication',0,0 WHERE NOT EXISTS(SELECT 1 FROM maintenance_jobs WHERE job_id=json_extract(?1,'$.lease.id') AND state='leased' AND lease_token=json_extract(?1,'$.lease.token') AND lease_expires_at>json_extract(?1,'$.now'));
-- statement
UPDATE maintenance_jobs SET progress_json=json_extract(?1,'$.progress'),state=json_extract(?1,'$.state'),lease_token=NULL,lease_expires_at=0,attempts=CASE WHEN json_extract(?1,'$.progressed') THEN 0 ELSE attempts END,next_attempt_at=json_extract(?1,'$.now')+MIN(3600,MAX(1,json_extract(?1,'$.delay')))*1000,last_dispatched_at=0,updated_at=json_extract(?1,'$.now') WHERE job_id=json_extract(?1,'$.lease.id') AND lease_token=json_extract(?1,'$.lease.token') AND state='leased' AND lease_expires_at>json_extract(?1,'$.now');
