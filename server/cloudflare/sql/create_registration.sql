INSERT INTO registration_enrollments
 (enrollment_id, context_hash, state, version, created_at_millis, expires_at_millis, verification_id, row_json)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
WHERE (SELECT COUNT(*) FROM registration_enrollments
 WHERE context_hash = ?2 AND state IN ('prepared','human_verified') AND expires_at_millis > ?9) < 8
AND (SELECT COUNT(*) FROM registration_enrollments
 WHERE state IN ('prepared','human_verified') AND expires_at_millis > ?9) < 100000;
