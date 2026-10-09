UPDATE registration_enrollments
SET state = ?1, version = ?2, expires_at_millis = ?3, verification_id = ?4, row_json = ?5
WHERE enrollment_id = ?6 AND version = ?7 AND state = ?8 AND context_hash = ?9
 AND state <> 'activated' AND ?1 <> 'activated' AND expires_at_millis > ?10;
