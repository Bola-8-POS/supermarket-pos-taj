//! Facts about the clone that must hold whatever the release's CI digest says (FR5b items 4 and 5): absolute invariants, and
//! row counts that may only shrink where the signed manifest says so.
use crate::update::manifest::{DataChange, DataChangeKind};
use std::collections::BTreeMap;

pub const INVARIANTS_SQL: &str = include_str!("invariants.sql");

/// One line per table, `schema.table|count`, for every public table and auth.users (exact counts: at single-store scale a count
/// costs seconds next to the FILE_COPY clone).
// ponytail: exact count(*); past about 50M rows in one table, use reltuples for that table.
pub const ROWS_SQL: &str = "SELECT n.nspname::text||'.'||c.relname::text||'|'||(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND (n.nspname='public' OR (n.nspname='auth' AND c.relname='users')) ORDER BY 1";

fn parse(out: &str) -> Result<BTreeMap<String, u64>, String> {
    let mut m = BTreeMap::new();
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (t, c) = l.split_once('|').ok_or_else(|| format!("unreadable row-count line `{l}`"))?;
        m.insert(t.to_string(), c.trim().parse::<u64>().map_err(|_| format!("unreadable row count for {t}"))?);
    }
    Ok(m)
}

/// `Ok(None)` = nothing was lost. Growth and clone-only tables are never refused; a table that shrank needs a declared `delete`
/// or `drop`, a table that vanished needs `drop`. The message has table names and counts, never row values.
pub fn rows_lost(live: &str, clone: &str, declared: &[DataChange]) -> Result<Option<String>, String> {
    let (live, clone) = (parse(live)?, parse(clone)?);
    let allows = |t: &str, drop_only: bool| declared.iter().any(|d| d.table == t && (d.kind == DataChangeKind::Drop || (!drop_only && d.kind == DataChangeKind::Delete)));
    let mut lost = vec![];
    for (t, lc) in &live {
        match clone.get(t) {
            None if !allows(t, true) => lost.push(format!("{t} missing")),
            Some(cc) if cc < lc && !allows(t, false) => lost.push(format!("{t} {lc}\u{2192}{cc}")),
            _ => {}
        }
    }
    Ok((!lost.is_empty()).then(|| lost.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_cluster::TestCluster;
    use crate::update::manifest::{DataChange, DataChangeKind};

    #[test]
    fn rows_lost_rules() {
        let live = "auth.users|1\npublic.payments|120";
        assert_eq!(rows_lost(live, live, &[]).unwrap(), None);
        assert_eq!(rows_lost(live, "auth.users|1\npublic.payments|0", &[]).unwrap().unwrap(), "public.payments 120\u{2192}0");
        let del = [DataChange { table: "public.payments".into(), kind: DataChangeKind::Delete }];
        assert_eq!(rows_lost(live, "auth.users|1\npublic.payments|0", &del).unwrap(), None);
        assert_eq!(rows_lost(live, "auth.users|1", &del).unwrap().unwrap(), "public.payments missing");
        assert!(rows_lost(live, "garbage", &[]).is_err());
    }

    // real_ test: compiled here, run only in Windows Sandbox (owner rule); never on the developer PC.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_invariants_catch_each_break() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        // FR14: the throwaway cluster is initdb'ed with supabase_admin as its ONLY role (a provisioned store also has `postgres`, created by the
        // supabase migrations). Create the rest of the known set, or ROLE_SET would fire from the start and prove nothing, and `ALTER ROLE postgres` would fail.
        a.exec("postgres", "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE postgres NOLOGIN;                             CREATE ROLE service_role NOLOGIN; CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE supabase_storage_admin NOLOGIN;                             CREATE TABLE public.profiles(id int, pin varchar(6)); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY").unwrap();
        assert_eq!(a.scalar("postgres", INVARIANTS_SQL).unwrap().trim(), "", "the setup is clean: every invariant holds before the first break");
        let broken = |extra: &str| a.scalar("postgres", INVARIANTS_SQL).unwrap().contains(extra);
        a.exec("postgres", "ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY").unwrap();
        assert!(broken("RLS_OFF public.profiles"));
        a.exec("postgres", "ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; GRANT SELECT (pin) ON public.profiles TO anon").unwrap();
        assert!(broken("PIN_GRANT"));
        a.exec("postgres", "REVOKE SELECT (pin) ON public.profiles FROM anon; GRANT SELECT ON public.profiles TO authenticated").unwrap();
        assert!(broken("PIN_GRANT"));
        a.exec("postgres", "REVOKE SELECT ON public.profiles FROM authenticated; CREATE ROLE x").unwrap();
        assert!(broken("ROLE_SET"));
        a.exec("postgres", "DROP ROLE x; ALTER ROLE postgres SUPERUSER").unwrap();
        assert!(broken("SUPERUSERS"));
        a.exec("postgres", "ALTER ROLE postgres NOSUPERUSER; SELECT pg_create_physical_replication_slot('s')").unwrap();
        assert!(broken("SLOTS"));
    }

    // pos_backup is created lazily by the first backup run (backup/run.rs ensure_backup_role), so a store may or may not have it: both role sets pass,
    // but a pos_backup that differs from what ROLE_SQL creates fires BACKUP_ROLE. Host-runnable: a throwaway cluster, no service, no elevation.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn pg_it_invariants_accept_exactly_the_backup_role_the_backup_code_creates() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        a.exec("postgres", "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE postgres NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE supabase_storage_admin NOLOGIN;                              CREATE TABLE public.profiles(id int, pin varchar(6)); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY").unwrap();
        let inv = || a.scalar("postgres", INVARIANTS_SQL).unwrap();
        assert_eq!(inv().trim(), "", "no pos_backup (backup never set up): clean");
        // the backup code's own statements; the password is a throwaway random value that reaches psql as a \set line on stdin
        let f = c.dir.path().join("role.sql");
        std::fs::write(&f, crate::backup::run::ROLE_SQL).unwrap();
        a.run_file_opts("postgres", &f, &[("pw".to_string(), crate::util::random_uuid_v4().unwrap().replace('-', ""))], false, &[]).unwrap();
        assert_eq!(inv().trim(), "", "pos_backup exactly as ROLE_SQL makes it: clean");
        let tamper = |sql: &str, token: &str| {
            a.exec("postgres", sql).unwrap();
            let out = inv();
            assert!(out.contains(token), "`{sql}` -> {out:?}");
            assert!(!out.contains("PASSWORD") && !out.contains("rolpassword"), "{out:?}");
        };
        for (bad, token, undo) in [
            ("ALTER ROLE pos_backup SUPERUSER", "BACKUP_ROLE", "ALTER ROLE pos_backup NOSUPERUSER"),
            ("ALTER ROLE pos_backup CREATEROLE", "BACKUP_ROLE", "ALTER ROLE pos_backup NOCREATEROLE"),
            ("ALTER ROLE pos_backup CREATEDB", "BACKUP_ROLE", "ALTER ROLE pos_backup NOCREATEDB"),
            ("ALTER ROLE pos_backup REPLICATION", "BACKUP_ROLE", "ALTER ROLE pos_backup NOREPLICATION"),
            ("ALTER ROLE pos_backup NOBYPASSRLS", "BACKUP_ROLE", "ALTER ROLE pos_backup BYPASSRLS"),
            ("ALTER ROLE pos_backup NOLOGIN", "BACKUP_ROLE", "ALTER ROLE pos_backup LOGIN"),
            ("GRANT pg_write_all_data TO pos_backup", "BACKUP_ROLE", "REVOKE pg_write_all_data FROM pos_backup"),
            ("REVOKE pg_read_all_data FROM pos_backup", "BACKUP_ROLE", "GRANT pg_read_all_data TO pos_backup"),
            ("GRANT pg_read_all_data TO pos_backup WITH ADMIN OPTION", "BACKUP_ROLE", "REVOKE ADMIN OPTION FOR pg_read_all_data FROM pos_backup"),
            ("GRANT pos_backup TO anon", "BACKUP_ROLE", "REVOKE pos_backup FROM anon"),
        ] {
            tamper(bad, token);
            a.exec("postgres", undo).unwrap();
            assert_eq!(inv().trim(), "", "after `{undo}` the invariant holds again");
        }
        a.exec("postgres", "CREATE ROLE x").unwrap();
        assert!(inv().contains("ROLE_SET"), "a foreign role still fires ROLE_SET next to pos_backup");
        a.exec("postgres", "DROP ROLE x").unwrap();
        a.exec("postgres", "DROP ROLE pos_backup").unwrap();
        a.exec("postgres", "CREATE ROLE x").unwrap();
        assert!(inv().contains("ROLE_SET"), "and without pos_backup");
    }
}
