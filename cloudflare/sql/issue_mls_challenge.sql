INSERT INTO mls_authentication_challenges(challenge,purpose,cid_number,device_id,binding_revision,account_id,service_origin,method,request_target,body_sha256,session_token_hash,created_at,expires_at_millis)
SELECT json_extract(?1,'$.challenge'),?2,json_extract(?1,'$.user_id'),json_extract(?1,'$.device_id'),json_extract(?1,'$.binding_revision'),json_extract(?1,'$.account_id'),json_extract(?1,'$.service_origin'),json_extract(?1,'$.method'),json_extract(?1,'$.request_target'),json_extract(?1,'$.body_sha256'),?3,?4,json_extract(?1,'$.expires_at_millis')
-- Session每个已登记设备只占一个准确请求；重复领取不得替换nonce或续期。
WHERE ((?2='session' AND NOT EXISTS(
 SELECT 1 FROM mls_authentication_challenges x WHERE x.purpose='session'
 AND x.cid_number=json_extract(?1,'$.user_id') AND x.device_id=json_extract(?1,'$.device_id')
 AND x.account_id=json_extract(?1,'$.account_id') AND x.binding_revision=json_extract(?1,'$.binding_revision')
 AND x.service_origin=json_extract(?1,'$.service_origin') AND x.method=json_extract(?1,'$.method')
 AND x.request_target=json_extract(?1,'$.request_target') AND x.body_sha256=json_extract(?1,'$.body_sha256')
 AND x.session_token_hash IS NULL AND x.created_at>0 AND x.created_at<=?4 AND x.expires_at_millis>?4
 AND x.expires_at_millis<=x.created_at+json_extract(?1,'$.expires_at_millis')-?4))
 OR (?2<>'session' AND (SELECT COUNT(*) FROM mls_authentication_challenges WHERE cid_number=json_extract(?1,'$.user_id') AND purpose=?2 AND expires_at_millis>?4)<64))
 AND EXISTS (SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number) WHERE u.cid_number=json_extract(?1,'$.user_id')
 AND u.cid_status='active' AND u.account_id=json_extract(?1,'$.account_id') AND u.binding_revision=json_extract(?1,'$.binding_revision')
 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
 AND ((?2='registration' AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=?4 AND c.verification_deadline_millis>?4)
 OR (?2 IN('session','request') AND EXISTS(SELECT 1 FROM scheduler_leases h JOIN user_projection_cursor cur ON cur.cursor_id=1 AND cur.finalized_block_number>=h.last_slot
 WHERE h.lease_key='sync:identity:'||json_extract(c.row_json,'$.chain_scope') AND h.updated_at>0 AND h.updated_at<=?4 AND h.updated_at+?5>?4)
 AND EXISTS(SELECT 1 FROM mls_devices d JOIN cid_admissions a USING(cid_number) WHERE d.cid_number=u.cid_number AND d.device_id=json_extract(?1,'$.device_id') AND d.account_id=u.account_id AND d.binding_revision=u.binding_revision AND d.active=1
 AND a.source='turnstile' AND a.chain_scope=json_extract(c.row_json,'$.chain_scope') AND a.service_origin=json_extract(?1,'$.service_origin'))
 AND (?2<>'request' OR EXISTS(SELECT 1 FROM authorized_business_sessions s WHERE s.session_token_hash=?3 AND s.cid_number=u.cid_number AND s.device_id=json_extract(?1,'$.device_id') AND s.created_at<=?4 AND s.expires_at>?4)))));

-- session read
-- 插入零行也必须重查当前设备/准入/健康，不能交付撤销前遗留的nonce。
SELECT json_object('ok',json('true'),'user_id',x.cid_number,'device_id',x.device_id,'public_key','0x'||x.device_id,
 'account_id',x.account_id,'binding_revision',x.binding_revision,'service_origin',x.service_origin,
 'challenge',x.challenge,'expires_at_millis',x.expires_at_millis,'method',x.method,
 'request_target',x.request_target,'body_sha256',x.body_sha256) challenge_json,x.created_at
FROM mls_authentication_challenges x
WHERE ?2='session' AND x.purpose=?2 AND x.session_token_hash IS ?3
 AND x.cid_number=json_extract(?1,'$.user_id') AND x.device_id=json_extract(?1,'$.device_id')
 AND x.account_id=json_extract(?1,'$.account_id') AND x.binding_revision=json_extract(?1,'$.binding_revision')
 AND x.service_origin=json_extract(?1,'$.service_origin') AND x.method=json_extract(?1,'$.method')
 AND x.request_target=json_extract(?1,'$.request_target') AND x.body_sha256=json_extract(?1,'$.body_sha256')
 AND x.created_at>0 AND x.created_at<=?4 AND x.expires_at_millis>?4
 AND x.expires_at_millis<=x.created_at+json_extract(?1,'$.expires_at_millis')-?4
 AND EXISTS(SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number)
 JOIN mls_devices d ON d.cid_number=u.cid_number AND d.device_id=x.device_id
 JOIN cid_admissions a ON a.cid_number=u.cid_number
 JOIN scheduler_leases h ON h.lease_key='sync:identity:'||json_extract(c.row_json,'$.chain_scope')
 JOIN user_projection_cursor cur ON cur.cursor_id=1 AND cur.finalized_block_number>=h.last_slot
 WHERE u.cid_number=x.cid_number AND u.cid_status='active' AND u.account_id=x.account_id AND u.binding_revision=x.binding_revision
 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision
 AND d.account_id=u.account_id AND d.binding_revision=u.binding_revision AND d.active=1
 AND a.source='turnstile' AND a.chain_scope=json_extract(c.row_json,'$.chain_scope') AND a.service_origin=x.service_origin
 AND h.updated_at>0 AND h.updated_at<=?4 AND h.updated_at+?5>?4
 AND NOT EXISTS(SELECT 1 FROM account_deletions z WHERE z.cid_number=u.cid_number AND z.state='pending'))
ORDER BY x.created_at,x.challenge LIMIT 1;
