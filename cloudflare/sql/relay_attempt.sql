-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at) VALUES('relay:'||json_extract(?1,'$.attempt.request_ip_hash'),1,json_extract(?1,'$.now')+60000) ON CONFLICT(rate_key) DO UPDATE SET request_count=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN 1 ELSE request_count+1 END,expires_at=CASE WHEN expires_at<=json_extract(?1,'$.now') THEN json_extract(?1,'$.now')+60000 ELSE expires_at END;
-- statement
INSERT INTO rate_windows(rate_key,request_count,expires_at) SELECT 'relay-assert',NULL,0 WHERE EXISTS(SELECT 1 FROM rate_windows WHERE rate_key='relay:'||json_extract(?1,'$.attempt.request_ip_hash') AND request_count>20);
-- statement
UPDATE chain_extrinsic_relays SET active_claim=0 WHERE extrinsic_sha256=json_extract(?1,'$.attempt.extrinsic_sha256') AND active_claim=1 AND relay_status IN ('broadcast','failed') AND updated_at<=json_extract(?1,'$.now')-600000;
-- statement
INSERT OR IGNORE INTO chain_extrinsic_relays(relay_id,extrinsic_sha256,tx_hash,request_ip_hash,byte_size,relay_status,error_code,created_at,updated_at,active_claim) VALUES(json_extract(?1,'$.attempt.relay_id'),json_extract(?1,'$.attempt.extrinsic_sha256'),json_extract(?1,'$.attempt.tx_hash'),json_extract(?1,'$.attempt.request_ip_hash'),json_extract(?1,'$.attempt.byte_size'),'submitting',NULL,json_extract(?1,'$.now'),json_extract(?1,'$.now'),1);
-- statement
INSERT INTO chain_extrinsic_relays(relay_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM chain_extrinsic_relays WHERE extrinsic_sha256=json_extract(?1,'$.attempt.extrinsic_sha256') AND tx_hash=json_extract(?1,'$.attempt.tx_hash') AND active_claim=1);
