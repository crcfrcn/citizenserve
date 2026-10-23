-- statement
DELETE FROM topup_accounts WHERE account_id=json_extract(?1,'$.account') AND order_id=json_extract(?1,'$.id') AND claim=json_extract(?1,'$.claim')
AND EXISTS(SELECT 1 FROM topup_orders WHERE order_id=json_extract(?1,'$.id') AND (phase='paid' OR json_extract(data,'$.exception_reason')='topup_gmb_finalized_failed'));
