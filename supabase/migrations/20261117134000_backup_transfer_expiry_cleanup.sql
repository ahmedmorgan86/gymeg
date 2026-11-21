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
-- Supabase does not grant the migration role direct cron.job access; install
-- through the supported scheduling API, always inactive until activation.
DO $$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
 PERFORM gymos.cron_install_disabled('gymos-backup-transfer-cleanup','*/15 * * * *','SELECT gymos.cleanup_expired_backup_transfers()');
END $$;
