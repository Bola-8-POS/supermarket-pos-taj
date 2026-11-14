-- Migration: pg_net trigger for waitlist notification
-- Phase 7: Waitlist + WhatsApp
--
-- OPERATOR SETUP REQUIRED:
-- Before applying this migration, set the following DB settings so the trigger
-- can reach the edge function. Run in the Supabase SQL editor (or as a separate migration):
--
--   ALTER DATABASE postgres SET app.supabase_url = 'https://YOUR_PROJECT_REF.supabase.co';
--   ALTER DATABASE postgres SET app.supabase_anon_key = 'YOUR_ANON_KEY';
--
-- Find these at: https://supabase.com/dashboard/project/<ref>/settings/api
--
-- If DB settings are not configured, the trigger falls back to the placeholder values
-- below and will fail silently (net.http_post returns a request ID but the edge function
-- will receive an invalid URL/key). Configure the DB settings before going to production.
--
-- pg_net is pre-enabled on Supabase hosted — no CREATE EXTENSION needed.

CREATE OR REPLACE FUNCTION public.notify_waitlist_entry()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_url  text;
  v_key  text;
BEGIN
  -- Only fire when status transitions TO 'notified' (not on repeated updates)
  IF NEW.status = 'notified' AND (OLD.status IS DISTINCT FROM 'notified') THEN
    -- Use DB settings if configured; fall back to hardcoded placeholder values
    v_url := COALESCE(
      current_setting('app.supabase_url', true),
      'https://YOUR_PROJECT_REF.supabase.co'
    ) || '/functions/v1/send-waitlist-notification';

    v_key := COALESCE(
      current_setting('app.supabase_anon_key', true),
      'YOUR_ANON_KEY'
    );

    PERFORM net.http_post(
      url     := v_url,
      body    := jsonb_build_object('entryId', NEW.id::text),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Idempotent trigger creation
DROP TRIGGER IF EXISTS trg_waitlist_notify ON public.waitlist_entries;

CREATE TRIGGER trg_waitlist_notify
  AFTER UPDATE OF status ON public.waitlist_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_waitlist_entry();

-- DOWN:
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_waitlist_notify ON waitlist_entries;
-- DROP FUNCTION IF EXISTS fn_waitlist_notify();
-- COMMIT;
