SET search_path = pg_catalog;
-- Five lines `section|sha256` over what a migration can change OUTSIDE the clone and that dropping the clone cannot undo:
-- role attributes and verifiers (md5 of the verifier only, never a value), memberships, per-database and per-role settings,
-- the databases themselves, and replication slots. Run as supabase_admin on template1 before and after the work.
-- The clone is left out of `databases` only (it exists on both sides and 03c changes its ACL on purpose); its per-database
-- settings are in, because a migration's ALTER DATABASE .. SET on the clone would survive the rename into live; its slots too.
SELECT v.s || '|' || encode(sha256(convert_to(coalesce(string_agg(q.x, E'\n' ORDER BY q.x), ''), 'UTF8')), 'hex')
FROM (VALUES ('databases'),('members'),('roles'),('settings'),('slots')) v(s) LEFT JOIN (
  SELECT 'roles' s, a.rolname::text||':'||a.rolsuper::text||a.rolinherit::text||a.rolcreaterole::text||a.rolcreatedb::text||a.rolcanlogin::text||a.rolreplication::text||a.rolbypassrls::text||':'||a.rolconnlimit::text||':'||coalesce(a.rolvaliduntil::text,'')||':'||md5(coalesce(a.rolpassword,'')) x FROM pg_authid a
  UNION ALL SELECT 'members', r.rolname::text||'>'||m.rolname::text||':'||g.rolname::text||':'||am.admin_option::text||am.inherit_option::text||am.set_option::text FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.roleid JOIN pg_roles m ON m.oid=am.member JOIN pg_roles g ON g.oid=am.grantor
  UNION ALL SELECT 'settings', coalesce(d.datname::text,'*')||':'||coalesce(r.rolname::text,'*')||':'||array_to_string(ARRAY(SELECT c FROM unnest(s.setconfig) c ORDER BY c), ',') FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole
  UNION ALL SELECT 'databases', d.datname::text||':'||d.datconnlimit::text||':'||d.datallowconn::text||d.datistemplate::text||':'||pg_get_userbyid(d.datdba)::text||':'||coalesce(d.datacl::text,'') FROM pg_database d WHERE d.datname <> 'pos_next'
  UNION ALL SELECT 'slots', slot_name::text||':'||slot_type::text||':'||coalesce(database::text,'') FROM pg_replication_slots
) q ON q.s = v.s GROUP BY v.s ORDER BY v.s
