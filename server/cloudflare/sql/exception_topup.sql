-- statement
UPDATE topup_orders SET status='exception',exception_reason=json_extract(?1,'$.reason'),settled_at=json_extract(?1,'$.now') WHERE order_id=json_extract(?1,'$.id') AND status='pending' AND settlement_claim_id=json_extract(?1,'$.claim');
-- statement
INSERT INTO topup_orders(order_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM topup_orders WHERE order_id=json_extract(?1,'$.id') AND status='exception' AND settlement_claim_id=json_extract(?1,'$.claim') AND exception_reason=json_extract(?1,'$.reason'));
