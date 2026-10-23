-- 只由通过MLS和钱包签名的注销提交消费；AUTH_ASSERT由仓库先放入同一batch。
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(
 SELECT 1 FROM account_deletion_challenges c WHERE c.challenge_id=json_extract(?1,'$.challenge.challenge_id')
 AND c.purpose='delete' AND c.cid_number=json_extract(?1,'$.auth.cid_number')
 AND c.account_id=json_extract(?1,'$.auth.account_id') AND c.binding_revision=json_extract(?1,'$.auth.binding_revision')
 AND c.record_json=json_extract(?1,'$.challenge_json') AND c.expires_at_millis>json_extract(?1,'$.now'));
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM account_deletions WHERE cid_number=json_extract(?1,'$.auth.cid_number'));
-- 未知私有写入、未完成上传和已有维护定位必须先解决；有效公开PUT由空对象封堵。
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE
 EXISTS(SELECT 1 FROM profile_asset_uploads WHERE cid_number=json_extract(?1,'$.auth.cid_number') AND state='writing')
 OR EXISTS(SELECT 1 FROM square_uploads u WHERE u.cid_number=json_extract(?1,'$.auth.cid_number')
   AND u.status IN('prepared','uploading','deleting'))
 OR EXISTS(SELECT 1 FROM maintenance_jobs WHERE artifact_owner IS NULL AND json_extract(progress_json,'$.locator.cid_number')=json_extract(?1,'$.auth.cid_number'));
-- statement
INSERT INTO account_deletions(deletion_id,cid_number,account_id,binding_revision,chain_scope,enrollment_id,created_at,updated_at)
SELECT json_extract(?1,'$.challenge.challenge_id'),a.cid_number,json_extract(?1,'$.auth.account_id'),json_extract(?1,'$.auth.binding_revision'),a.chain_scope,a.enrollment_id,json_extract(?1,'$.now'),json_extract(?1,'$.now')
FROM cid_admissions a WHERE a.cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
INSERT INTO account_deletion_assert(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM account_deletions WHERE deletion_id=json_extract(?1,'$.challenge.challenge_id'));
-- statement
DELETE FROM account_deletion_challenges WHERE cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
UPDATE mls_devices SET active=0 WHERE cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
DELETE FROM square_sessions WHERE cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
DELETE FROM mls_authentication_challenges WHERE cid_number=json_extract(?1,'$.auth.cid_number');
-- statement
DELETE FROM push_endpoints WHERE cid_number=json_extract(?1,'$.auth.cid_number');
