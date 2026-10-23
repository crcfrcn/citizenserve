-- 只删除当前已验证设备的密文，外键同时取消它的推送任务。
DELETE FROM messages WHERE user_id=json_extract(?1,'$.user_id') AND device_id=json_extract(?1,'$.device_id') AND message_id IN(SELECT value FROM json_each(?1,'$.ids'));
