-- 不盲清writing/ready或退款已消费月用量；对象删除定位另行保存。
-- statement
UPDATE resource_reservations SET reservation_state='released' WHERE reservation_state='reserved' AND expires_at<=json_extract(?1,'$.now') AND reservation_id IN (SELECT u.upload_id FROM square_uploads u WHERE u.expires_at<=json_extract(?1,'$.now') AND u.status='prepared' AND NOT EXISTS(SELECT 1 FROM square_media_assets m WHERE m.upload_id=u.upload_id AND m.asset_state IN ('uploading','ready')) LIMIT 1000);
-- statement
UPDATE square_uploads SET status='expired' WHERE status='prepared' AND expires_at<=json_extract(?1,'$.now') AND EXISTS(SELECT 1 FROM resource_reservations r WHERE r.reservation_id=square_uploads.upload_id AND r.reservation_state='released') AND NOT EXISTS(SELECT 1 FROM square_media_assets m WHERE m.upload_id=square_uploads.upload_id AND m.asset_state IN ('uploading','ready'));
