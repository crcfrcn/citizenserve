-- statement
DELETE FROM topup_accounts WHERE expires_at<=json_extract(?1,'$.now') AND (order_id=json_extract(?1,'$.order.order_id') OR account_id=json_extract(?1,'$.account')) AND NOT EXISTS(SELECT 1 FROM topup_orders o WHERE o.order_id=topup_accounts.order_id AND json_type(o.data,'$.signed')='object');
-- statement
INSERT INTO topup_accounts(account_id,order_id,claim,expires_at) VALUES(json_extract(?1,'$.account'),json_extract(?1,'$.order.order_id'),json_extract(?1,'$.claim'),json_extract(?1,'$.now')+60000)
ON CONFLICT(account_id) DO UPDATE SET order_id=excluded.order_id,claim=excluded.claim,expires_at=excluded.expires_at
WHERE topup_accounts.expires_at<=json_extract(?1,'$.now') AND NOT EXISTS(SELECT 1 FROM topup_orders o WHERE o.order_id=topup_accounts.order_id AND json_type(o.data,'$.signed')='object');
