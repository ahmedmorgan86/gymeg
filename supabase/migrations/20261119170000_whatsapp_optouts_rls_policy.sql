-- Explicit RLS policies for whatsapp_optouts and whatsapp_webhook_events
-- Resolves Supabase Security Advisor warnings regarding RLS tables without explicit policies.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'gymos' 
      AND tablename = 'whatsapp_optouts' 
      AND policyname = 'whatsapp_optouts_runtime'
  ) THEN
    CREATE POLICY whatsapp_optouts_runtime ON gymos.whatsapp_optouts
      FOR ALL TO gymos_app
      USING (owner_id = NULLIF(current_setting('app.gym_owner', true), '') OR owner_id IS NULL)
      WITH CHECK (owner_id = NULLIF(current_setting('app.gym_owner', true), '') OR owner_id IS NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'gymos' 
      AND tablename = 'whatsapp_webhook_events' 
      AND policyname = 'whatsapp_webhook_events_runtime'
  ) THEN
    CREATE POLICY whatsapp_webhook_events_runtime ON gymos.whatsapp_webhook_events
      FOR ALL TO gymos_app
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
