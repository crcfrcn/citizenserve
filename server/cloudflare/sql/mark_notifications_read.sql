-- statement
INSERT INTO square_notify_reads(cid_number,last_seen_square_at,last_seen_following_at)
VALUES(json_extract(?1,'$.auth.cid_number'),CASE WHEN json_extract(?1,'$.scope')='square' THEN json_extract(?1,'$.auth.now') ELSE 0 END,CASE WHEN json_extract(?1,'$.scope')='following' THEN json_extract(?1,'$.auth.now') ELSE 0 END)
ON CONFLICT(cid_number) DO UPDATE SET last_seen_square_at=MAX(last_seen_square_at,excluded.last_seen_square_at),last_seen_following_at=MAX(last_seen_following_at,excluded.last_seen_following_at);
