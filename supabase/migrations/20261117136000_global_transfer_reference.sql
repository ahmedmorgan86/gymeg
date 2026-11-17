-- One payment reference proves one payment, regardless of currency or status.
-- Operator review is required before deployment if legacy duplicates exist.
SET lock_timeout='5s';
DO $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM (
   SELECT upper(regexp_replace(transfer_ref,'[[:space:]]','','g')) AS reference
   FROM gymos.activation_requests WHERE transfer_ref IS NOT NULL
   GROUP BY 1 HAVING count(*)>1
  ) duplicates
 ) THEN
  RAISE EXCEPTION 'Duplicate normalized transfer references: review before making references globally unique';
 END IF;
END $$;
DROP INDEX IF EXISTS gymos.activation_requests_unique_transfer;
CREATE UNIQUE INDEX activation_requests_unique_transfer
 ON gymos.activation_requests(upper(regexp_replace(transfer_ref,'[[:space:]]','','g')))
 WHERE transfer_ref IS NOT NULL;
