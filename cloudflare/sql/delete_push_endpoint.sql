-- 只删除已授权当前设备；旧投递代际不会重新附着。
-- statement
DELETE FROM push_endpoints WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND device_id=json_extract(?1,'$.auth.device_id') AND account_id=json_extract(?1,'$.auth.account_id') AND binding_revision=json_extract(?1,'$.auth.binding_revision');
