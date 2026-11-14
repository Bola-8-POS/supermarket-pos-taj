SET search_path = pg_catalog;
-- One sha256 (64 hex, like pack-manifest.schema.json's catalog.digest) over what a migration can silently break: function bodies
-- and ACLs, table ACLs and RLS flags, column grants, policies (with restrictive/permissive), triggers (with enabled state) and schema
-- ACLs of public and pos_lockout, plus every function body and ACL of schema auth (auth.uid() and auth.jwt() underpin every RLS
-- policy). State-based, so a database built from scratch and one migrated step by step agree. The same file is the single source
-- for CI (Proposed convention addition B). Every non-text operand of || is cast with ::text: name and "char" operands are
-- ambiguous under search_path = pg_catalog ("Could not choose a best candidate operator"), which only a real Postgres shows. Role attributes, memberships and settings are the cluster digest's job.
-- Row boundaries: the rows are joined with a real newline, so a row must never contain one (a policy or function definition can). Each row is
-- escaped here, in this ONE place (catalog.rs reuses this text for the sections and lines diagnostics): backslash -> \\ FIRST, then
-- newline -> \n, then carriage return -> \r. Backslash must come first, otherwise the backslashes added for \n and \r would be doubled.
SELECT encode(sha256(convert_to(string_agg(x, E'\n' ORDER BY x), 'UTF8')), 'hex') FROM (
 SELECT replace(replace(replace(u.x, E'\\', E'\\\\'), E'\n', E'\\n'), E'\r', E'\\r') AS x FROM (
  SELECT 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) AS x
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'pos_lockout') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'fnacl:' || p.oid::regprocedure::text || ':' || COALESCE(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'pos_lockout') AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'authfn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, '')    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth' AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'rel:' || n.nspname::text || '.' || c.relkind::text || ':' || c.relname::text || ':' || COALESCE(c.relacl::text, '') || ':' || c.relrowsecurity::text || c.relforcerowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'pos_lockout') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'colacl:' || n.nspname::text || '.' || c.relname::text || '.' || a.attname::text || ':' || a.attacl::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'pos_lockout') AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  SELECT 'pol:' || schemaname::text || ':' || tablename::text || ':' || policyname::text || ':' || permissive::text || ':' || cmd::text || ':' || COALESCE(qual, '') || ':' || COALESCE(with_check, '') || ':' || roles::text
    FROM pg_policies WHERE schemaname IN ('public', 'pos_lockout')
  UNION ALL
  SELECT 'trg:' || n.nspname::text || ':' || c.relname::text || ':' || t.tgname::text || ':' || t.tgenabled::text || ':' || md5(pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname IN ('public', 'pos_lockout')
  UNION ALL
  SELECT 'ns:' || nspname::text || ':' || COALESCE(nspacl::text, '') FROM pg_namespace WHERE nspname IN ('public', 'pos_lockout')
 ) u
) q
