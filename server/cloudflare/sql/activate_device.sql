-- 第一条是数据库断言。失败必须触发NOT NULL约束错误，使整个D1 batch回滚。
-- 零行在此表示断言通过，不是把零行CAS当作业务成功。最终结果还须核对设备/准入/登记。
-- statement
INSERT INTO cid_admissions(cid_number,source,enrollment_id,human_verified_at_millis,registration_scope,service_origin,chain_scope,institution)
SELECT NULL,'turnstile','assertion',1,'assertion','assertion','assertion','CTZN'
WHERE NOT COALESCE((
 json_extract(?1,'$.device.cid_number')=json_extract(?1,'$.identity.cid_number')
 AND json_extract(?1,'$.device.account_id')=json_extract(?1,'$.identity.account_id')
 AND json_extract(?1,'$.device.binding_revision')=json_extract(?1,'$.identity.binding_revision')
 AND json_extract(?1,'$.device.device_id')=substr(json_extract(?1,'$.device.public_key'),3)
 AND
 EXISTS(SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number)
 WHERE u.cid_number=json_extract(?1,'$.identity.cid_number') AND u.cid_status='active'
 AND u.account_id=json_extract(?1,'$.identity.account_id') AND u.binding_revision=json_extract(?1,'$.identity.binding_revision')
 AND u.institution=json_extract(?1,'$.identity.institution') AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
 AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=json_extract(?1,'$.now') AND c.verification_deadline_millis>json_extract(?1,'$.now')
 AND json_extract(c.row_json,'$.chain_scope')=json_extract(?1,'$.config.chain_scope'))
 AND NOT EXISTS(SELECT 1 FROM mls_devices d WHERE d.cid_number=json_extract(?1,'$.identity.cid_number') AND d.device_id=json_extract(?1,'$.device.device_id')
 AND (d.binding_revision>json_extract(?1,'$.device.binding_revision') OR (d.binding_revision=json_extract(?1,'$.device.binding_revision') AND
 (d.issued_at>json_extract(?1,'$.device.issued_at') OR (d.active=0 AND d.issued_at>=json_extract(?1,'$.device.issued_at'))))))
 AND NOT EXISTS(SELECT 1 FROM cid_admissions a WHERE a.cid_number=json_extract(?1,'$.identity.cid_number') AND
 (a.registration_scope<>json_extract(?1,'$.config.registration_scope') OR a.service_origin<>json_extract(?1,'$.config.service_origin') OR a.chain_scope<>json_extract(?1,'$.config.chain_scope') OR a.institution<>json_extract(?1,'$.identity.institution')))
 AND (
 (json_extract(?1,'$.enrollment') IS NULL AND EXISTS(SELECT 1 FROM cid_admissions a WHERE a.cid_number=json_extract(?1,'$.identity.cid_number')
 AND a.source='turnstile' AND a.registration_scope=json_extract(?1,'$.config.registration_scope') AND a.service_origin=json_extract(?1,'$.config.service_origin')
 AND a.chain_scope=json_extract(?1,'$.config.chain_scope') AND a.institution=json_extract(?1,'$.identity.institution')))
 OR EXISTS(SELECT 1 FROM registration_enrollments e WHERE e.enrollment_id=json_extract(?1,'$.enrollment.enrollment_id')
 AND e.version=json_extract(?1,'$.before_version') AND json_extract(e.row_json,'$.recovery_hash')=json_extract(?1,'$.enrollment.recovery_hash')
 AND json_extract(e.row_json,'$.account_id')=json_extract(?1,'$.identity.account_id') AND json_extract(e.row_json,'$.institution')=json_extract(?1,'$.identity.institution')
 AND json_extract(e.row_json,'$.registration_scope')=json_extract(?1,'$.config.registration_scope') AND json_extract(e.row_json,'$.service_origin')=json_extract(?1,'$.config.service_origin')
 AND json_extract(e.row_json,'$.chain_scope')=json_extract(?1,'$.config.chain_scope') AND json_extract(e.row_json,'$.human_verified_at_millis')>0
 AND ((e.state='human_verified' AND e.expires_at_millis>json_extract(?1,'$.now')) OR
 (e.state='activated' AND json_extract(e.row_json,'$.activation')=json_extract(?1,'$.enrollment.activation'))))
 )),0);
-- statement
INSERT INTO mls_devices(cid_number,device_id,binding_revision,account_id,public_key,issued_at,created_at,updated_at,active)
SELECT json_extract(?1,'$.device.cid_number'),json_extract(?1,'$.device.device_id'),json_extract(?1,'$.device.binding_revision'),json_extract(?1,'$.device.account_id'),json_extract(?1,'$.device.public_key'),json_extract(?1,'$.device.issued_at'),json_extract(?1,'$.device.created_at'),json_extract(?1,'$.device.updated_at'),1
WHERE true ON CONFLICT(cid_number,device_id) DO UPDATE SET binding_revision=excluded.binding_revision,account_id=excluded.account_id,public_key=excluded.public_key,issued_at=excluded.issued_at,updated_at=excluded.updated_at,active=1;
-- statement
INSERT INTO cid_admissions(cid_number,source,enrollment_id,human_verified_at_millis,registration_scope,service_origin,chain_scope,institution)
SELECT json_extract(?1,'$.identity.cid_number'),'turnstile',json_extract(?1,'$.enrollment.enrollment_id'),json_extract(?1,'$.enrollment.human_verified_at_millis'),json_extract(?1,'$.config.registration_scope'),json_extract(?1,'$.config.service_origin'),json_extract(?1,'$.config.chain_scope'),json_extract(?1,'$.identity.institution')
WHERE json_extract(?1,'$.enrollment') IS NOT NULL ON CONFLICT(cid_number) DO NOTHING;
-- statement
UPDATE registration_enrollments SET state='activated',version=json_extract(?1,'$.enrollment.version'),row_json=json_extract(?1,'$.enrollment')
WHERE enrollment_id=json_extract(?1,'$.enrollment.enrollment_id') AND state='human_verified' AND version=json_extract(?1,'$.before_version');
