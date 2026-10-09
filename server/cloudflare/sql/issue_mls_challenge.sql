INSERT INTO mls_authentication_challenges(challenge,purpose,cid_number,device_id,binding_revision,account_id,service_origin,method,request_target,body_sha256,session_token_hash,created_at,expires_at_millis)
SELECT json_extract(?1,'$.challenge'),?2,json_extract(?1,'$.user_id'),json_extract(?1,'$.device_id'),json_extract(?1,'$.binding_revision'),json_extract(?1,'$.account_id'),json_extract(?1,'$.service_origin'),json_extract(?1,'$.method'),json_extract(?1,'$.request_target'),json_extract(?1,'$.body_sha256'),?3,?4,json_extract(?1,'$.expires_at_millis')
WHERE (SELECT COUNT(*) FROM mls_authentication_challenges WHERE cid_number=json_extract(?1,'$.user_id') AND purpose=?2 AND expires_at_millis>?4)<64
 AND EXISTS (SELECT 1 FROM users u JOIN user_identity_checks c USING(cid_number) WHERE u.cid_number=json_extract(?1,'$.user_id')
 AND u.cid_status='active' AND u.account_id=json_extract(?1,'$.account_id') AND u.binding_revision=json_extract(?1,'$.binding_revision')
 AND c.account_id=u.account_id AND c.binding_revision=u.binding_revision AND json_extract(c.row_json,'$.authoritative_current')=1 AND c.checked_at_millis<=?4 AND c.verification_deadline_millis>?4);
