-- statement
DELETE FROM contact_mls_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND committed_at IS NOT NULL AND committed_at<json_extract(?1,'$.auth.now')-604800000;
-- statement
INSERT INTO contact_mls_groups(cid_number,group_id,creator_device_id,group_revision,member_device_ids) SELECT '', 'assertion', '', NULL, '[]' WHERE NOT EXISTS(SELECT 1 FROM contact_mls_groups g WHERE g.cid_number=json_extract(?1,'$.auth.cid_number') AND g.group_id=json_extract(?1,'$.group.group_id') AND g.group_revision=json_extract(?1,'$.group.group_revision') AND g.member_device_ids=json_extract(?1,'$.group.member_device_ids') AND g.pending_operation_id IS NULL);
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at) SELECT '', '', NULL, 0 WHERE (SELECT COUNT(*) FROM contact_mls_operations WHERE cid_number=json_extract(?1,'$.auth.cid_number'))>=1024;
-- statement
INSERT INTO contact_mls_operations(cid_number,operation_id,device_id,group_revision,operation_kind,target_device_ids)
VALUES(json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.operation_id'),json_extract(?1,'$.auth.device_id'),json_extract(?1,'$.group.group_revision'),json_extract(?1,'$.operation_kind'),json_extract(?1,'$.target_device_ids'));
-- statement
UPDATE contact_mls_groups SET pending_operation_id=json_extract(?1,'$.operation_id') WHERE cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
INSERT INTO contact_mls_groups(cid_number,group_id,creator_device_id,group_revision,member_device_ids) SELECT '', '', '', NULL, '[]' WHERE EXISTS(SELECT 1 FROM json_each(?1,'$.target_device_ids') t WHERE (json_extract(?1,'$.operation_kind')='add' AND NOT EXISTS(SELECT 1 FROM mls_devices d WHERE d.cid_number=json_extract(?1,'$.auth.cid_number') AND d.device_id=t.value AND d.active=1 AND d.account_id=json_extract(?1,'$.auth.account_id') AND d.binding_revision=json_extract(?1,'$.auth.binding_revision'))) OR (json_extract(?1,'$.operation_kind')='remove' AND EXISTS(SELECT 1 FROM mls_devices d WHERE d.cid_number=json_extract(?1,'$.auth.cid_number') AND d.device_id=t.value AND d.active=1 AND d.account_id=json_extract(?1,'$.auth.account_id') AND d.binding_revision=json_extract(?1,'$.auth.binding_revision'))));
