-- statement
-- 权益证据不得在查询/计费等待期间无限延长；错误不是“免费用户”。
INSERT INTO user_profiles(cid_number,display_name) SELECT '',NULL WHERE
 json_extract(?1,'$.membership_checked') IS NULL OR json_extract(?1,'$.membership_deadline') IS NULL
 OR json_extract(?1,'$.membership_checked')>json_extract(?1,'$.auth.now')
 OR json_extract(?1,'$.membership_deadline')<=json_extract(?1,'$.auth.now')
 OR json_extract(?1,'$.membership_deadline')>json_extract(?1,'$.membership_checked')+60000;
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at)
SELECT json_extract(?1,'$.auth.cid_number'),json_extract(?1,'$.day'),json_extract(?1,'$.count'),json_extract(?1,'$.auth.now')
WHERE json_extract(?1,'$.paid_until') IS NULL AND json_extract(?1,'$.count')>0 AND json_extract(?1,'$.count')<=100
ON CONFLICT(cid_number,browse_day) DO UPDATE SET browse_count=browse_count+excluded.browse_count,updated_at=excluded.updated_at WHERE browse_count+excluded.browse_count<=100;
-- statement
INSERT INTO square_browse_days(cid_number,browse_day,browse_count,updated_at) SELECT '', '', NULL, 0
WHERE (json_extract(?1,'$.paid_until') IS NULL AND json_extract(?1,'$.count')>0 AND changes()<>1) OR (json_extract(?1,'$.paid_until') IS NOT NULL AND json_extract(?1,'$.paid_until')<=json_extract(?1,'$.auth.now'));
