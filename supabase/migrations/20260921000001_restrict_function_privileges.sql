-- Restrict function privileges in schema public.
--
-- EXECUTE on the application's functions is held by signed-in staff and the
-- service role only, and functions created from now on follow the same default.
-- The three checkout RPCs are executable by the service role only: the
-- edge functions process-payment, process-split-payment and
-- process-direct-sale are their only callers.
--
-- Access for signed-in staff and for the service role is preserved on every
-- other function by granting it explicitly before the revoke.
--
-- The migration stops when a function in the schema is owned by a role other
-- than the migration role: ownership has to be aligned first, then the
-- migration re-run. scripts/sql/verify-function-privileges.sql checks the
-- resulting state.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig, pg_get_userbyid(p.proowner) AS owner_name
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF r.owner_name <> current_user THEN
      RAISE EXCEPTION 'cannot change privileges on %: owned by %, migration role is %', r.sig, r.owner_name, current_user;
    END IF;

    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('process_payment_atomic', 'process_split_payment_atomic',
                        'process_direct_sale_atomic')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- Default privileges for functions created by this role.
-- The first statement is global for the role (it has no schema): it removes the
-- built-in PUBLIC execute default everywhere, and a schema-qualified statement
-- cannot do that. Functions this role creates outside schema public (including
-- through CREATE EXTENSION) therefore get no anon, authenticated or service_role
-- EXECUTE and need an explicit grant. In schema public the per-schema default
-- grants EXECUTE to authenticated and service_role; the second statement
-- keeps anon out of it.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
