-- Migration: update notify_waitlist_entry() with project-specific URL fallback
-- Phase 7: Waitlist + WhatsApp
--
-- 2026-09-26: the project URL and anon key literals this file originally hardcoded
-- as COALESCE fallback values were removed from this tracked file; the function
-- now only reads the `app.supabase_url` / `app.supabase_anon_key` database
-- settings, with no literal fallback. notify_waitlist_entry(), its trigger and
-- both waitlist tables were already dropped by
-- 20260810000005_drop_waitlist.sql, so this function does not run in any
-- environment; the file is kept valid SQL (no literal values) because
-- `supabase db reset` re-runs every migration file in order, including this one,
-- before the drop migration removes the function again.

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
    -- Read from DB settings only; NULL when unset, no literal fallback (see header)
    v_url := current_setting('app.supabase_url', true) || '/functions/v1/send-waitlist-notification';

    v_key := current_setting('app.supabase_anon_key', true);

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

-- DOWN:
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.notify_waitlist_entry() CASCADE;
-- COMMIT;
