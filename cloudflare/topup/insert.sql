-- statement
INSERT INTO topup_orders(order_id,data) VALUES(json_extract(?1,'$.order.order_id'),json_extract(?1,'$.order')) ON CONFLICT(order_id) DO NOTHING;
-- statement
INSERT INTO topup_orders(order_id,data) SELECT NULL,'{}' WHERE NOT EXISTS(SELECT 1 FROM topup_orders WHERE order_id=json_extract(?1,'$.order.order_id') AND data=json_extract(?1,'$.order'));
