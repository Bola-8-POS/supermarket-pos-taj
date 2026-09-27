\set ON_ERROR_STOP on
-- Assertions: staff lifecycle (active-only role helper, staff activation RPC).
-- Run as postgres: psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-staff-lifecycle.sql
-- Static catalog checks only; behavior lives in
-- src/entities/staff/model/staff-lifecycle.integration.test.ts.
DO $$
DECLARE
  v_fn    regprocedure := 'public.set_staff_active(uuid, boolean, uuid, text)'::regprocedure;
  v_gated text[] := ARRAY['force_pin_change', 'close_tab', 'confirm_transfer_payment',
                          'dispute_transfer_payment', 'caja_open', 'close_caja_session'];
  v_name  text;
  v_bad   text;
BEGIN
  -- 1. The role helper answers for active profiles only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_user_role()'::regprocedure
                 AND prosrc LIKE '%is_active = true%') THEN
    RAISE EXCEPTION 'get_user_role does not require an active profile';
  END IF;

  -- 2. force_pin_change requires an active caller.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'force_pin_change'
                 AND prosrc ~ 'id = auth\.uid\(\)\s+AND role IN \(''manager'', ''admin''\)\s+AND is_active = true') THEN
    RAISE EXCEPTION 'force_pin_change does not require an active caller';
  END IF;

  -- 3. The activation RPC exists once, is service-only, pins search_path,
  --    keeps an active admin and records the change.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_staff_active') <> 1 THEN
    RAISE EXCEPTION 'set_staff_active must exist exactly once';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'set_staff_active privileges are wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                 AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'set_staff_active does not pin search_path to public, pg_temp';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                 AND prosrc LIKE '%LAST_ADMIN%' AND prosrc LIKE '%record_audit(%') THEN
    RAISE EXCEPTION 'set_staff_active does not keep an active admin or record the change';
  END IF;

  -- 4. Every RPC that reads the caller's role straight from profiles requires an active caller.
  FOREACH v_name IN ARRAY v_gated LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND prosrc LIKE '%is_active = true%') THEN
      RAISE EXCEPTION '% does not require an active caller', v_name;
    END IF;
  END LOOP;

  -- 5. No other SECURITY DEFINER function open to signed-in staff gates on the
  --    caller's profile role without also requiring an active profile.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND p.prosrc ~ 'auth\.uid\(\)'
    AND p.prosrc ~ '\mrole\s+(IN\s*\(|NOT IN|=|INTO)'
    AND p.prosrc !~ 'is_active\s*=\s*true';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'role gate without an active-caller check on: %', v_bad;
  END IF;
END $$;
SELECT 'verify-staff-lifecycle: ok' AS result;
