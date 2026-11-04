-- Pin search_path to public, pg_temp on every SECURITY DEFINER function in
-- public that does not already carry it. Extension member functions are
-- excluded (pg_depend classid/deptype = 'e') as a hosted-project safety
-- margin; none exist locally today. No function body changes, and nothing is
-- dropped.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND p.prosecdef
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass
                        AND d.objid = p.oid
                        AND d.deptype = 'e')
      AND NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig, '{}')))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.oid::regprocedure);
  END LOOP;
END $$;
