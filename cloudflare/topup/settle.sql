-- statement
UPDATE topup_orders SET data=json_extract(?1,'$.after'),dispatch_at=0
WHERE order_id=json_extract(?1,'$.before.order_id') AND data=json_extract(?1,'$.before')
 AND json_extract(?1,'$.after.revision')=json_extract(data,'$.revision')+1
 AND json_extract(?1,'$.after.order_id')=order_id
 AND json_extract(?1,'$.after.intent')=json_extract(data,'$.intent')
 AND json_extract(?1,'$.after.intent_hash')=json_extract(data,'$.intent_hash')
 AND json_extract(?1,'$.after.message')=json_extract(data,'$.message')
 AND json_extract(?1,'$.after.created_at')=created_at
 AND json_extract(?1,'$.after.legacy') IS json_extract(data,'$.legacy')
 AND ((phase='awaiting' AND json_extract(?1,'$.after.phase')='verifying')
 OR (phase IN ('verifying','received') AND json_extract(?1,'$.after.phase') IN ('received','exception'))
 OR (phase='received' AND json_extract(?1,'$.after.phase')='signed')
 OR (phase IN ('signed','broadcast') AND json_extract(?1,'$.after.phase') IN ('signed','broadcast','paid','exception')))
 AND json_extract(?1,'$.after.scan')>=json_extract(data,'$.scan')
 AND (payment_txid IS NULL OR (json_extract(?1,'$.after.payment_txid')=payment_txid AND json_extract(?1,'$.after.payer_signature')=json_extract(data,'$.payer_signature')))
 AND (json_type(data,'$.signed')='null' OR (json_extract(?1,'$.after.signed')=json_extract(data,'$.signed') AND json_extract(?1,'$.after.payment')=json_extract(data,'$.payment')))
 AND (json_type(?1,'$.after.signed')='null' OR json_type(data,'$.signed')='object' OR EXISTS(SELECT 1 FROM topup_accounts a WHERE a.account_id=json_extract(?1,'$.after.signed.account_id') AND a.order_id=topup_orders.order_id AND a.claim=json_extract(?1,'$.after.signed.claim') AND a.expires_at>json_extract(?1,'$.now')))
 AND (json_type(?1,'$.after.signed')='null' OR json_type(data,'$.signed')='object' OR (json_extract(?1,'$.after.payment.checked_at')<=json_extract(?1,'$.now') AND json_extract(?1,'$.after.payment.verification_deadline')>json_extract(?1,'$.now') AND json_extract(?1,'$.after.payment.verification_deadline')=json_extract(?1,'$.after.payment.checked_at')+60000))
 AND (json_extract(?1,'$.after.phase')!='paid' OR (
 json_extract(?1,'$.after.gmb.tx_hash')=json_extract(?1,'$.after.signed.tx_hash')
 AND json_extract(?1,'$.after.gmb.signer_account_id')=json_extract(?1,'$.after.signed.account_id')
 AND json_extract(?1,'$.after.gmb.beneficiary_account_id')=json_extract(data,'$.intent.account_id')
 AND json_extract(?1,'$.after.gmb.amount')=json_extract(data,'$.intent.coin_fen')
 AND json_extract(?1,'$.after.gmb.remark')='topup:'||order_id
 AND json_extract(?1,'$.after.gmb.checked_at')<=json_extract(?1,'$.now') AND json_extract(?1,'$.after.gmb.verification_deadline')>json_extract(?1,'$.now') AND json_extract(?1,'$.after.gmb.verification_deadline')=json_extract(?1,'$.after.gmb.checked_at')+60000));
-- statement
INSERT INTO topup_orders(order_id,data) SELECT NULL,'{}' WHERE NOT EXISTS(SELECT 1 FROM topup_orders WHERE order_id=json_extract(?1,'$.after.order_id') AND data=json_extract(?1,'$.after'));
-- statement
DELETE FROM topup_accounts WHERE order_id=json_extract(?1,'$.after.order_id') AND account_id=json_extract(?1,'$.after.signed.account_id') AND claim=json_extract(?1,'$.after.signed.claim') AND (json_extract(?1,'$.after.phase')='paid' OR json_extract(?1,'$.after.exception_reason')='topup_gmb_finalized_failed');
