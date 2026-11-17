-- Retention minimization: expired backup-transfer chunks can contain member data.
-- The runtime role cannot delete other tenants' rows under FORCE RLS, so a narrow
-- definer function removes only rows whose 30-minute TTL has already elapsed.
SET lock_timeout='5s';
CREATE OR REPLACE FUNCTION gymos.cleanup_expired_backup_transfers() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
DECLARE removed integer;
BEGIN
 WITH expired AS (DELETE FROM gymos.gym_backup_transfers WHERE expires_at<now() RETURNING 1)
 SELECT count(*) INTO removed FROM expired;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION gymos.cleanup_expired_backup_transfers() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.cleanup_expired_backup_transfers() TO gymos_app;
-- Install disabled. Enable only after the matching application release is deployed.
DO $$
BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='gymos-backup-transfer-cleanup') THEN
   PERFORM cron.schedule('gymos-backup-transfer-cleanup','*/15 * * * *','SELECT gymos.cleanup_expired_backup_transfers()');
  END IF;
  UPDATE cron.job SET active=false WHERE jobname='gymos-backup-transfer-cleanup';
 END IF;
END $$;
