DELETE FROM mls_authentication_challenges WHERE challenge=json_extract(?1,'$.proof.challenge') AND purpose=json_extract(?1,'$.purpose')
 AND cid_number=json_extract(?1,'$.proof.user_id') AND device_id=json_extract(?1,'$.proof.device_id')
 AND account_id=json_extract(?1,'$.proof.account_id') AND binding_revision=json_extract(?1,'$.proof.binding_revision')
 AND service_origin=json_extract(?1,'$.proof.service_origin') AND method=json_extract(?1,'$.proof.method')
 AND request_target=json_extract(?1,'$.proof.request_target') AND body_sha256=json_extract(?1,'$.proof.body_sha256')
 AND expires_at_millis=json_extract(?1,'$.proof.expires_at_millis') AND expires_at_millis>json_extract(?1,'$.now')
 AND session_token_hash IS json_extract(?1,'$.session_token_hash')
 AND (purpose<>'request' OR EXISTS(SELECT 1 FROM square_sessions s JOIN mls_devices d USING(cid_number,device_id)
 WHERE s.session_token_hash=mls_authentication_challenges.session_token_hash AND s.expires_at>json_extract(?1,'$.now')
 AND s.account_id=mls_authentication_challenges.account_id AND s.binding_revision=mls_authentication_challenges.binding_revision
 AND s.device_id=mls_authentication_challenges.device_id AND d.account_id=s.account_id AND d.binding_revision=s.binding_revision AND d.active=1))
 AND EXISTS (SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number) WHERE u.cid_number=mls_authentication_challenges.cid_number
 AND u.cid_status='active' AND u.account_id=mls_authentication_challenges.account_id AND u.binding_revision=mls_authentication_challenges.binding_revision
 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=json_extract(?1,'$.now') AND c.verification_deadline_millis>json_extract(?1,'$.now'));
