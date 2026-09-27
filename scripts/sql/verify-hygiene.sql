\set ON_ERROR_STOP on
-- Assertions: tracked-document/migration hygiene checks.
-- Run as postgres: psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-hygiene.sql
-- Static catalog checks only, exercised against the historical
-- 20260501000004_waitlist_trigger_url.sql edit that removed its hardcoded
-- fallback URL/key literals; this file is carried forward for later waves to
-- extend with the same shape.
DO $$
DECLARE
  v_bad text;
BEGIN
  -- 1. notify_waitlist_entry() was dropped by 20260810000005_drop_waitlist.sql
  --    and must not exist in any environment this runs against.
  IF to_regproc('public.notify_waitlist_entry') IS NOT NULL THEN
    RAISE EXCEPTION 'public.notify_waitlist_entry still exists';
  END IF;

  -- 2. No function body in public carries a hardcoded Supabase host or a JWT-shaped literal.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND (p.prosrc LIKE '%supabase.co%' OR p.prosrc LIKE '%eyJ%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'function body carries a project host or key literal: %', v_bad;
  END IF;

  -- 3. Every SECURITY DEFINER function in public pins its search_path.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prosecdef
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER function without a pinned search_path: %', v_bad;
  END IF;
END $$;
SELECT 'verify-hygiene: ok' AS result;
