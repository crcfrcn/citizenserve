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
 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
 AND ((mls_authentication_challenges.purpose='registration' AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=json_extract(?1,'$.now') AND c.verification_deadline_millis>json_extract(?1,'$.now'))
 OR (mls_authentication_challenges.purpose IN('session','request') AND EXISTS(SELECT 1 FROM scheduler_leases h JOIN user_projection_cursor cur ON cur.cursor_id=1 AND cur.finalized_block_number>=h.last_slot
 WHERE h.lease_key='sync:identity:'||json_extract(c.row_json,'$.chain_scope') AND h.updated_at>0 AND h.updated_at<=json_extract(?1,'$.now') AND h.updated_at+json_extract(?1,'$.sync_health_millis')>json_extract(?1,'$.now'))
 AND EXISTS(SELECT 1 FROM cid_admissions a JOIN mls_devices d USING(cid_number) WHERE a.cid_number=u.cid_number AND a.source='turnstile' AND a.chain_scope=json_extract(c.row_json,'$.chain_scope') AND a.service_origin=mls_authentication_challenges.service_origin
 AND d.device_id=mls_authentication_challenges.device_id AND d.account_id=u.account_id AND d.binding_revision=u.binding_revision AND d.active=1))));
