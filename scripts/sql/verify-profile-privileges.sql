\set ON_ERROR_STOP on
-- Assertions: profile privileges (column grants on profiles, retired
-- PIN-change RPC, search_path on definer functions, attempt limit on the
-- PIN holder lookup).
-- Run as postgres: psql -v ON_ERROR_STOP=1 -f scripts/sql/verify-profile-privileges.sql
-- Static catalog checks plus one read as anon; behavior lives in
-- src/entities/staff/model/profile-privileges.integration.test.ts.
DO $$
DECLARE
  v_tbl      regclass := 'public.profiles'::regclass;
  v_selected text[]   := ARRAY['id', 'name', 'role', 'is_active', 'created_at', 'updated_at',
                               'deleted_at', 'must_change_pin', 'locale'];
  v_col      text;
  v_priv     text;
  v_bad      text;
  v_count    bigint;
BEGIN
  -- 1. anon has no access to profiles, at table level or on any column
  --    (DELETE has no column form), and no policy names it.
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', v_tbl, v_priv) THEN
      RAISE EXCEPTION 'anon still holds % on profiles', v_priv;
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF has_any_column_privilege('anon', v_tbl, v_priv) THEN
      RAISE EXCEPTION 'anon still holds % on a profiles column', v_priv;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND 'anon' = ANY (roles)) THEN
    RAISE EXCEPTION 'a profiles policy still names anon';
  END IF;

  -- 2. authenticated reads the listed columns only, writes role and locale
  --    only, and holds no INSERT (table level or any column) or DELETE.
  FOREACH v_col IN ARRAY ARRAY['pin', 'email'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_column_privilege('authenticated', v_tbl, v_col, v_priv) THEN
        RAISE EXCEPTION 'authenticated holds % on profiles.%', v_priv, v_col;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_col IN ARRAY v_selected LOOP
    IF NOT has_column_privilege('authenticated', v_tbl, v_col, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated cannot read profiles.%', v_col;
    END IF;
  END LOOP;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO v_bad
  FROM pg_attribute a
  WHERE a.attrelid = v_tbl AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('authenticated', v_tbl, a.attname, 'UPDATE') <> (a.attname IN ('role', 'locale'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated UPDATE column grants are wrong on: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', v_tbl, 'INSERT') OR has_table_privilege('authenticated', v_tbl, 'DELETE')
     OR has_any_column_privilege('authenticated', v_tbl, 'INSERT') THEN
    RAISE EXCEPTION 'authenticated still holds INSERT or DELETE on profiles';
  END IF;

  -- 3. The PIN-change RPC is gone.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'clear_must_change_pin') THEN
    RAISE EXCEPTION 'clear_must_change_pin still exists';
  END IF;

  -- 4. Every SECURITY DEFINER function in public pins search_path.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions without search_path: %', v_bad;
  END IF;

  -- 5. The PIN holder lookup exists once and counts attempts.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'staff_pin_holder') <> 1 THEN
    RAISE EXCEPTION 'staff_pin_holder must exist exactly once';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'staff_pin_holder'
                 AND prosrc LIKE '%pin_attempt_begin%') THEN
    RAISE EXCEPTION 'staff_pin_holder does not count attempts';
  END IF;

  -- 6. The sign-in list still serves anon after the revoke.
  BEGIN
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_count FROM public.staff_directory;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'anon cannot read staff_directory: %', SQLERRM;
  END;
END $$;
SELECT 'verify-profile-privileges: ok' AS result;
