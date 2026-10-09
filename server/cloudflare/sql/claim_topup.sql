-- statement
UPDATE topup_orders SET settlement_claim_id=json_extract(?1,'$.claim'),settlement_claimed_at=json_extract(?1,'$.now') WHERE order_id=json_extract(?1,'$.id') AND status='pending' AND settlement_claim_id IS NULL;
-- statement
INSERT INTO topup_orders(order_id) SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM topup_orders WHERE order_id=json_extract(?1,'$.id') AND status='pending' AND settlement_claim_id=json_extract(?1,'$.claim'));
