-- 保留deleted上传墓碑供重试；已消费的resource_usage永不冲销。
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT (EXISTS(SELECT 1 FROM square_uploads u WHERE u.upload_id=json_extract(?1,'$.upload.upload_id') AND u.cid_number=json_extract(?1,'$.auth.cid_number') AND u.post_id=json_extract(?1,'$.upload.post_id') AND u.manifest_hash=json_extract(?1,'$.upload.manifest_hash') AND (status='deleted' OR (status='deleting' AND expires_at<=json_extract(?1,'$.auth.now')))));
-- statement
INSERT INTO square_uploads(upload_id) SELECT NULL WHERE NOT (NOT EXISTS(SELECT 1 FROM resource_reservations r WHERE r.reservation_id=json_extract(?1,'$.upload.upload_id') AND r.cid_number=json_extract(?1,'$.auth.cid_number') AND r.reservation_state='used') OR EXISTS(SELECT 1 FROM resource_totals t JOIN resource_reservations r ON r.cid_number=t.cid_number WHERE r.reservation_id=json_extract(?1,'$.upload.upload_id') AND r.cid_number=json_extract(?1,'$.auth.cid_number') AND r.reservation_state='used' AND t.resource_key='square_storage' AND t.byte_size>=r.byte_size AND t.object_count>=1+2*(SELECT COUNT(*) FROM square_media_assets WHERE upload_id=r.reservation_id) AND t.video_seconds>=r.video_seconds));
-- statement
UPDATE resource_totals SET byte_size=byte_size-(SELECT r.byte_size FROM resource_reservations r WHERE r.reservation_id=json_extract(?1,'$.upload.upload_id') AND r.cid_number=json_extract(?1,'$.auth.cid_number') AND r.reservation_state='used'),object_count=object_count-1-2*(SELECT COUNT(*) FROM square_media_assets WHERE upload_id=json_extract(?1,'$.upload.upload_id')),video_seconds=video_seconds-(SELECT r.video_seconds FROM resource_reservations r WHERE r.reservation_id=json_extract(?1,'$.upload.upload_id') AND r.cid_number=json_extract(?1,'$.auth.cid_number') AND r.reservation_state='used'),updated_at=json_extract(?1,'$.auth.now') WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND resource_key='square_storage' AND EXISTS(SELECT 1 FROM resource_reservations r WHERE r.reservation_id=json_extract(?1,'$.upload.upload_id') AND r.cid_number=json_extract(?1,'$.auth.cid_number') AND r.reservation_state='used');
-- statement
UPDATE resource_reservations SET reservation_state=CASE reservation_state WHEN 'used' THEN 'released_consumed' ELSE 'released' END WHERE reservation_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND reservation_state IN ('used','reserved');
-- statement
DELETE FROM square_posts WHERE post_id=json_extract(?1,'$.upload.post_id') AND cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
DELETE FROM square_media_assets WHERE upload_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
UPDATE square_uploads SET status='deleted' WHERE upload_id=json_extract(?1,'$.upload.upload_id') AND cid_number=json_extract(?1,'$.auth.cid_number') AND status='deleting';
