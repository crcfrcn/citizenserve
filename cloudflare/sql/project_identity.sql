-- statement
-- 整块先释放将变化的旧账户索引，允许同块内先释放再被另一CID绑定。中间态不外露。
UPDATE users SET cid_status='revoked' WHERE cid_number=json_extract(?1,'$.cid_number')
 AND json_extract(?1,'$.binding_revision')>=binding_revision
 AND json_extract(?1,'$.finalized_block_number')>identity_finalized_block_number
 AND (account_id<>json_extract(?1,'$.account_id') OR binding_revision<>json_extract(?1,'$.binding_revision'));
-- statement
INSERT INTO users (cid_number,account_id,binding_revision,identity_level,cid_status,institution,
 registration_finalized_block_number,registration_finalized_block_hash,binding_finalized_block_number,binding_finalized_block_hash,
 identity_finalized_block_number,identity_finalized_block_hash,registered_at,binding_updated_at,identity_updated_at)
SELECT json_extract(?1,'$.cid_number'),json_extract(?1,'$.account_id'),json_extract(?1,'$.binding_revision'),json_extract(?1,'$.identity_level'),json_extract(?1,'$.status'),json_extract(?1,'$.institution'),
 json_extract(?1,'$.registered_block_number'),?2,json_extract(?1,'$.finalized_block_number'),json_extract(?1,'$.finalized_block_hash'),
 json_extract(?1,'$.finalized_block_number'),json_extract(?1,'$.finalized_block_hash'),json_extract(?1,'$.registered_at_millis'),json_extract(?1,'$.finalized_timestamp_millis'),json_extract(?1,'$.finalized_timestamp_millis')
WHERE true
ON CONFLICT(cid_number) DO UPDATE SET account_id=excluded.account_id,binding_revision=excluded.binding_revision,
 identity_level=excluded.identity_level,cid_status=excluded.cid_status,institution=excluded.institution,
 binding_finalized_block_number=excluded.binding_finalized_block_number,binding_finalized_block_hash=excluded.binding_finalized_block_hash,
 identity_finalized_block_number=excluded.identity_finalized_block_number,identity_finalized_block_hash=excluded.identity_finalized_block_hash,
 binding_updated_at=excluded.binding_updated_at,identity_updated_at=excluded.identity_updated_at
WHERE excluded.binding_revision>=users.binding_revision AND excluded.identity_finalized_block_number>=users.identity_finalized_block_number
 AND (excluded.identity_finalized_block_number>users.identity_finalized_block_number OR
 (excluded.binding_revision=users.binding_revision AND excluded.account_id=users.account_id AND excluded.cid_status=users.cid_status AND excluded.identity_finalized_block_hash=users.identity_finalized_block_hash));
-- statement
INSERT INTO user_identity_checks(cid_number,account_id,binding_revision,checked_at_millis,verification_deadline_millis,row_json)
SELECT u.cid_number,u.account_id,u.binding_revision,json_extract(?1,'$.checked_at_millis'),json_extract(?1,'$.verification_deadline_millis'),?1
FROM users u WHERE u.cid_number=json_extract(?1,'$.cid_number') AND u.account_id=json_extract(?1,'$.account_id')
 AND u.binding_revision=json_extract(?1,'$.binding_revision') AND u.cid_status=json_extract(?1,'$.status')
 AND u.identity_finalized_block_number=json_extract(?1,'$.finalized_block_number') AND u.identity_finalized_block_hash=json_extract(?1,'$.finalized_block_hash')
ON CONFLICT(cid_number) DO UPDATE SET account_id=excluded.account_id,binding_revision=excluded.binding_revision,
 checked_at_millis=excluded.checked_at_millis,verification_deadline_millis=excluded.verification_deadline_millis,row_json=excluded.row_json,refresh_lease_until=0
WHERE excluded.checked_at_millis>=user_identity_checks.checked_at_millis;
-- statement
-- 游标断言：零行才是断言通过；失配触发CHECK错误回滚整块。
INSERT INTO user_projection_cursor(cursor_id,finalized_block_number,finalized_block_hash,updated_at)
SELECT 2,0,'',0 WHERE (?1 IS NULL AND EXISTS(SELECT 1 FROM user_projection_cursor))
 OR (?1 IS NOT NULL AND NOT EXISTS(SELECT 1 FROM user_projection_cursor WHERE cursor_id=1 AND finalized_block_number=?1 AND finalized_block_hash=?2));
-- statement
INSERT INTO user_projection_cursor(cursor_id,finalized_block_number,finalized_block_hash,updated_at)
VALUES(1,?1,?2,?3) ON CONFLICT(cursor_id) DO UPDATE SET finalized_block_number=excluded.finalized_block_number,finalized_block_hash=excluded.finalized_block_hash,updated_at=excluded.updated_at;
