-- statement
INSERT INTO cid_admissions(cid_number,source,enrollment_id,human_verified_at_millis,registration_scope,service_origin,chain_scope,institution)
SELECT NULL,'turnstile','assertion',1,'assertion','assertion','assertion','CTZN'
WHERE NOT EXISTS(SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number) JOIN cid_admissions a USING(cid_number) JOIN mls_devices d USING(cid_number)
 WHERE u.cid_number=json_extract(?1,'$.session.cid_number') AND u.cid_status='active' AND u.account_id=json_extract(?1,'$.session.account_id')
 AND u.binding_revision=json_extract(?1,'$.session.binding_revision') AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
 AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=json_extract(?1,'$.now') AND c.verification_deadline_millis>json_extract(?1,'$.now')
 AND a.source='turnstile' AND a.registration_scope=json_extract(?1,'$.config.registration_scope') AND a.service_origin=json_extract(?1,'$.config.service_origin')
 AND a.chain_scope=json_extract(?1,'$.config.chain_scope') AND a.institution=u.institution AND json_extract(c.row_json,'$.chain_scope')=a.chain_scope
 AND d.device_id=json_extract(?1,'$.session.device_id') AND d.account_id=u.account_id AND d.binding_revision=u.binding_revision AND d.active=1);
-- statement
INSERT INTO square_sessions(session_token_hash,cid_number,binding_revision,account_id,device_id,created_at,expires_at)
SELECT json_extract(?1,'$.session.session_token_hash'),json_extract(?1,'$.session.cid_number'),json_extract(?1,'$.session.binding_revision'),json_extract(?1,'$.session.account_id'),json_extract(?1,'$.session.device_id'),json_extract(?1,'$.session.created_at'),json_extract(?1,'$.session.expires_at');
-- statement
DELETE FROM square_sessions WHERE cid_number=json_extract(?1,'$.session.cid_number') AND session_token_hash NOT IN
 (SELECT session_token_hash FROM square_sessions WHERE cid_number=json_extract(?1,'$.session.cid_number')
 ORDER BY (session_token_hash=json_extract(?1,'$.session.session_token_hash')) DESC,created_at DESC,session_token_hash DESC LIMIT 8);
