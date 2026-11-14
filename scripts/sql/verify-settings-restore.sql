\set ON_ERROR_STOP on
-- Assertions: settings_restore_snapshot and rate_limit_hit.
-- Run as the migration role:
--   psql -v ON_ERROR_STOP=1 < scripts/sql/verify-settings-restore.sql
-- Static catalog checks only; behavior lives in the settings-restore
-- integration test and this file's own manual smoke test (see the wave 3b
-- task 1 report for the transactional run against seeded data).
DO $$
BEGIN
  -- 1. settings_restore_snapshot: two args (p_backup_id, p_actor), not a
  --    caller-supplied snapshot -- see the migration header for why.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'settings_restore_snapshot') <> 1 THEN
    RAISE EXCEPTION 'settings_restore_snapshot must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'settings_restore_snapshot'
      AND pg_get_function_identity_arguments(oid) = 'p_backup_id uuid, p_actor uuid'
  ) THEN
    RAISE EXCEPTION 'settings_restore_snapshot does not have the two-argument (p_backup_id uuid, p_actor uuid) signature';
  END IF;

  -- 2. settings_restore_snapshot: definer, search_path pinned, NULL-guarded
  --    role check, reads the snapshot FOR UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'settings_restore_snapshot'
      AND prosecdef
      AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
      AND prosrc LIKE '%v_role IS NULL OR%'
      AND prosrc LIKE '%FOR UPDATE%'
  ) THEN
    RAISE EXCEPTION 'settings_restore_snapshot is missing the definer/search_path/NULL-guard/FOR UPDATE shape';
  END IF;

  -- 3. settings_restore_snapshot: service_role only, refused to anon and authenticated.
  IF has_function_privilege('anon', 'public.settings_restore_snapshot(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.settings_restore_snapshot(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.settings_restore_snapshot(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'settings_restore_snapshot privileges are wrong';
  END IF;

  -- 4. rate_limit_hit: exists, definer, search_path pinned, advisory lock,
  --    does not increment on a refusal (checked by the decrement in source).
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rate_limit_hit') <> 1 THEN
    RAISE EXCEPTION 'rate_limit_hit must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'rate_limit_hit'
      AND prosecdef
      AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
      AND prosrc LIKE '%pg_advisory_xact_lock%'
      AND prosrc LIKE '%hit_count = hit_count - 1%'
  ) THEN
    RAISE EXCEPTION 'rate_limit_hit is missing the lock, or does not undo the increment on a refusal';
  END IF;

  -- 5. rate_limit_hit: service_role only.
  IF has_function_privilege('anon', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rate_limit_hit(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rate_limit_hit privileges are wrong';
  END IF;

  -- 6. rate_limits table: RLS on, no direct grants to PUBLIC/anon/authenticated
  --    on any statement type -- only rate_limit_hit (service_role, SECURITY
  --    DEFINER) touches this table.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = 'rate_limits' AND relnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'rate_limits does not have row level security enabled';
  END IF;
  IF has_table_privilege('anon', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('anon', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('anon', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('anon', 'public.rate_limits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'DELETE') THEN
    RAISE EXCEPTION 'rate_limits is directly writable or readable by anon or authenticated';
  END IF;

  -- 7. Behavioral smoke test: allow up to the limit, then refuse without
  --    incrementing further. Commits (this DO block is not a savepoint), so
  --    the test row is deleted explicitly at the end instead of relying on
  --    a rollback.
  DECLARE
    v_key text := 'zz_verify_rate_limit_' || gen_random_uuid()::text;
    v1 integer; v2 integer; v3 integer; v_count integer;
  BEGIN
    v1 := rate_limit_hit(v_key, 2, 60);
    v2 := rate_limit_hit(v_key, 2, 60);
    v3 := rate_limit_hit(v_key, 2, 60);
    IF v1 <> 0 OR v2 <> 0 THEN RAISE EXCEPTION 'rate_limit_hit refused an allowed call (v1=%, v2=%)', v1, v2; END IF;
    IF v3 = 0 THEN RAISE EXCEPTION 'rate_limit_hit allowed a call past the limit'; END IF;
    SELECT hit_count INTO v_count FROM rate_limits WHERE rate_key = v_key;
    IF v_count <> 2 THEN RAISE EXCEPTION 'rate_limit_hit incremented hit_count on a refusal (got %)', v_count; END IF;
    DELETE FROM rate_limits WHERE rate_key = v_key;
  END;

  -- 8. rate_limit_hit rejects a bad argument (p_limit < 1) with INVALID_ARGUMENT.
  DECLARE
    v_raised text;
  BEGIN
    BEGIN
      PERFORM rate_limit_hit('zz_verify_bad_args', 0, 60);
      v_raised := NULL;
    EXCEPTION WHEN OTHERS THEN
      v_raised := SQLERRM;
    END;
    IF v_raised IS DISTINCT FROM 'INVALID_ARGUMENT' THEN
      RAISE EXCEPTION 'rate_limit_hit(p_limit=0) did not raise INVALID_ARGUMENT (got %)', COALESCE(v_raised, '<no error>');
    END IF;
  END;
END $$;
SELECT 'verify-settings-restore: ok' AS result;
