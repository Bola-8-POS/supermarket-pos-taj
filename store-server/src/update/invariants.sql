SET search_path = pg_catalog;
-- pos_backup is made by the first backup run (backup/run.rs ROLE_SQL), so the role set is accepted with or without it; BACKUP_ROLE lists how it differs from ROLE_SQL (never a verifier).
-- PIN_GRANT asks by role oid (has_column_privilege('public', ..) raises 'role does not exist'); anon and authenticated inherit
-- PUBLIC's grants, so a PUBLIC grant shows as theirs. Absolute facts about the clone that no release may break, whatever the CI reference digest says. One scalar; '' = all hold.
SELECT concat_ws(';',
 (SELECT 'RLS_OFF '||string_agg(t, ',' ORDER BY t) FROM (SELECT n.nspname::text||'.'||c.relname::text t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','pos_lockout') AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) s),
 (SELECT 'PIN_GRANT '||string_agg(g, ',' ORDER BY g) FROM (SELECT ro.rolname::text||':'||p::text g FROM pg_attribute a, pg_roles ro, unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE a.attrelid = to_regclass('public.profiles') AND a.attname = 'pin' AND NOT a.attisdropped AND ro.rolname IN ('anon','authenticated') AND has_column_privilege(ro.oid, a.attrelid, a.attnum, p)) s),
 (SELECT 'SLOTS' WHERE EXISTS (SELECT 1 FROM pg_replication_slots)),
 (SELECT 'ROLE_SET '||l FROM (SELECT string_agg(rolname::text, ',' ORDER BY rolname::text) l FROM pg_roles WHERE rolname !~ '^pg_') s WHERE l NOT IN ('anon,authenticated,authenticator,postgres,service_role,supabase_admin,supabase_auth_admin,supabase_storage_admin', 'anon,authenticated,authenticator,pos_backup,postgres,service_role,supabase_admin,supabase_auth_admin,supabase_storage_admin')),

 (SELECT concat('BACKUP_ROLE ', d) FROM (SELECT concat_ws(' ', CASE WHEN NOT r.rolcanlogin THEN 'NOLOGIN' END, CASE WHEN r.rolsuper THEN 'SUPERUSER' END, CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END, CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
   CASE WHEN r.rolreplication THEN 'REPLICATION' END, CASE WHEN NOT r.rolbypassrls THEN 'NOBYPASSRLS' END,
   CASE WHEN m.l IS DISTINCT FROM 'pg_read_all_data' THEN concat('MEMBER_OF=', m.l) END, CASE WHEN k.l IS NOT NULL THEN concat('MEMBERS=', k.l) END) d
   FROM pg_roles r,
   LATERAL (SELECT string_agg(concat(g.rolname, CASE WHEN am.admin_option THEN '+admin' END), ',' ORDER BY g.rolname::text) l FROM pg_auth_members am JOIN pg_roles g ON g.oid=am.roleid WHERE am.member=r.oid) m,
   LATERAL (SELECT string_agg(g.rolname::text, ',' ORDER BY g.rolname::text) l FROM pg_auth_members am JOIN pg_roles g ON g.oid=am.member WHERE am.roleid=r.oid) k
   WHERE r.rolname = 'pos_backup') s WHERE d <> ''),
 (SELECT 'SUPERUSERS '||l FROM (SELECT string_agg(rolname::text, ',' ORDER BY rolname::text) l FROM pg_roles WHERE rolsuper) s WHERE l <> 'supabase_admin'))
