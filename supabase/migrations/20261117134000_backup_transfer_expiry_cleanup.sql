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
DECLARE job_id bigint;
BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='gymos-backup-transfer-cleanup') THEN
   PERFORM cron.schedule('gymos-backup-transfer-cleanup','*/15 * * * *','SELECT gymos.cleanup_expired_backup_transfers()');
  END IF;
  -- Supabase does not grant the dashboard role UPDATE on cron.job. The
  -- supported scheduling API must be used to install the job disabled.
  SELECT jobid INTO job_id FROM cron.job WHERE jobname='gymos-backup-transfer-cleanup';
  IF job_id IS NOT NULL THEN PERFORM cron.alter_job(job_id,active=>false); END IF;
 END IF;
END $$;
