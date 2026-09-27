\set ON_ERROR_STOP on
-- Assertions: function privileges in schema public.
-- Run as postgres: psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-function-privileges.sql
-- Run with a writable postgres connection: check 4 creates and drops a probe function inside the
-- transaction, so a read-only session fails at that step. The other checks only read the catalog.
DO $$
DECLARE
  v_bad   text;
  v_probe regprocedure;
BEGIN
  -- 1. No function owned by the application is executable by anon or PUBLIC.
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    AND (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'signed-out access present on:%', E'\n' || v_bad;
  END IF;

  -- 2. Signed-in staff keep EXECUTE on every application function except the checkout RPCs.
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prorettype <> 'trigger'::regtype
    AND p.proname NOT IN ('process_payment_atomic', 'process_split_payment_atomic',
                          'process_direct_sale_atomic', 'receive_shipment',
                          'pin_attempt_record', 'pin_attempt_retry_after', 'pin_attempt_begin',
                          'resolve_manager_approval', 'set_staff_active',
                          'rate_limit_hit', 'settings_restore_snapshot')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'signed-in access missing on:%', E'\n' || v_bad;
  END IF;

  -- 3. The checkout RPCs are executable by the service role only.
  IF (SELECT count(DISTINCT proname) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('process_payment_atomic', 'process_split_payment_atomic',
                        'process_direct_sale_atomic')) < 3 THEN
    RAISE EXCEPTION 'checkout RPCs not found';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.proname)
    INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('process_payment_atomic', 'process_split_payment_atomic',
                      'process_direct_sale_atomic')
    AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'checkout RPC privileges wrong on:%', E'\n' || v_bad;
  END IF;

  -- 4. New functions are created without signed-out access, and signed-in staff and the service role keep it.
  CREATE FUNCTION public.zz_privilege_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';
  v_probe := 'public.zz_privilege_probe()'::regprocedure;
  IF has_function_privilege('anon', v_probe, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = v_probe AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'new functions get signed-out access by default';
  END IF;
  IF NOT has_function_privilege('authenticated', v_probe, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_probe, 'EXECUTE') THEN
    RAISE EXCEPTION 'new functions do not get signed-in and service-role access by default';
  END IF;
  DROP FUNCTION public.zz_privilege_probe();
END $$;
SELECT 'verify-function-privileges: ok' AS result;
