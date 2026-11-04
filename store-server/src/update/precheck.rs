//! Pack rules that need no database beyond the applied migration list. Every failure is PACK_INVALID (exit 13).
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::update::manifest::{needs_auth_migrate, pack_version_key, Manifest};
use crate::update::scan::scan_forbidden_stmts;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn bad(reason: &str, msg: impl Into<String>) -> OpError { OpError::new(OpCode::PackInvalid, reason, msg) }

pub fn check_rules(from: &Manifest, to: &Manifest, live_versions: &BTreeSet<String>, pack_versions: &BTreeSet<String>, allow_downgrade: bool) -> R<()> {
    if to.platform != "win-x64" { return Err(bad("PLATFORM_MISMATCH", format!("pack is for {}", to.platform))); }
    let (kf, kt) = (pack_version_key(&from.pack_version), pack_version_key(&to.pack_version));
    if let (Some(kf), Some(kt)) = (kf, kt) {
        if kt <= kf && !allow_downgrade { return Err(bad("PACK_DOWNGRADE", format!("{} is not newer than {}", to.pack_version, from.pack_version))); }
    } else { return Err(bad("PACK_VERSION_UNPARSEABLE", "packVersion must look like 1.2.3-r1")); }
    let live_max = live_versions.iter().next_back().cloned().unwrap_or_default();
    if live_max > to.migrations.max {
        return Err(bad("SCHEMA_OLDER_THAN_LIVE", format!("pack schema {} is older than the database {}", to.migrations.max, live_max)));
    }
    if let Some(missing) = live_versions.iter().find(|v| !pack_versions.contains(*v)) {
        return Err(bad("MISSING_MIGRATIONS", format!("applied migration {missing} is not in the pack (the CLI would refuse; --include-all is never used)")));
    }
    // A hotfix revision must keep the migration set: the app that tills run was built against one fixed level.
    if from.app_version == to.app_version && (from.migrations.count != to.migrations.count || from.migrations.max != to.migrations.max) {
        return Err(bad("MIGRATIONS_CHANGED_WITHOUT_APP_VERSION", "a -rN revision of the same app version may not change migrations"));
    }
    // A pack that changes the GoTrue build must say which GoTrue migration level it ends at: without it the clone's auth schema
    // cannot be proven (a wrong or old auth.exe applies nothing and "no lower than live" would pass).
    if needs_auth_migrate(from, to) && to.gotrue_migrations_max.is_none() {
        return Err(bad("GOTRUE_MIGRATIONS_MAX_MISSING", "the pack changes the GoTrue build but its manifest has no gotrueMigrationsMax"));
    }
    if from.pg_major() != to.pg_major() { return Err(bad("POSTGRES_MAJOR_CHANGED", "a Postgres major upgrade is not an update")); }
    // The bootstrap SQL ran once at provisioning (roles, shim); an update cannot re-run it.
    for f in from.files.iter().filter(|f| f.path.starts_with("sql/0")) {
        if let Some(n) = to.files.iter().find(|n| n.path == f.path) {
            if n.sha256 != f.sha256 { return Err(bad("BOOTSTRAP_SQL_CHANGED", format!("{} changed; this needs a re-provision, not an update", f.path))); }
        }
    }
    Ok(())
}

/// Migration files in the pack that the database has not applied yet, oldest first: (version, path).
pub fn pending_migrations(pack_dir: &Path, applied: &BTreeSet<String>) -> R<Vec<(String, PathBuf)>> {
    let rd = std::fs::read_dir(pack_dir.join("migrations")).map_err(|e| bad("MIGRATIONS_UNREADABLE", e.to_string()))?;
    let mut out = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some((v, _)) = name.split_once('_') {
            if name.ends_with(".sql") && !applied.contains(v) { out.push((v.to_string(), e.path())); }
        }
    }
    out.sort();
    Ok(out)
}

/// Refuse a pack whose NEW migrations touch the cluster: dropping the clone cannot undo that (S8 review I5).
/// A file that cannot be read as UTF-8 is refused too: a scan that could not look proves nothing.
pub fn forbid_cluster_changes(pending: &[(String, PathBuf)]) -> R<()> {
    for (v, p) in pending {
        let sql = std::fs::read_to_string(p).map_err(|e| bad("MIGRATIONS_UNREADABLE", format!("{v}: {e}")))?;
        if let Some((label, stmt)) = scan_forbidden_stmts(&sql).first() {
            let name = p.file_name().map_or_else(|| v.clone(), |n| n.to_string_lossy().to_string());
            return Err(bad("FORBIDDEN_MIGRATION_STATEMENT", format!("{name} contains `{label}`: \"{stmt}\"")));
        }
    }
    Ok(())
}


/// The `sql` steps of the NEW run-order.json that an update re-runs (`rerun: every-update`), judged before anything is
/// fenced. A superuser step (`runAs: supabase_admin`) cannot be bounded by scanning (02-shim legitimately has ALTER ROLE), so
/// it is FROZEN: the old pack must have the same step (id, file, runAs) with the same hash. Every other role's file must scan
/// clean. No step may carry a psql meta-command: nothing uses `\set` or `\i` (variables arrive with `-v`).
/// Files and the run-order itself must be listed in the signed manifest, which `verify_files` has just re-hashed.
pub fn check_steps(from_dir: &Path, to_dir: &Path, from: &Manifest, to: &Manifest) -> R<()> {
    use crate::runorder::{self, Rerun, Step};
    let sha = |m: &Manifest, path: &str| m.files.iter().find(|f| f.path == path).map(|f| f.sha256.to_lowercase());
    if sha(to, "sql/run-order.json").is_none() {
        return Err(bad("STEP_FILE_UNPINNED", "sql/run-order.json is not listed in the signed manifest"));
    }
    let to_order = runorder::load(to_dir).map_err(|e| bad("RUN_ORDER", e))?;
    // an unreadable old run-order grandfathers nothing: every superuser step is then "new"
    let from_order = runorder::load(from_dir).ok();
    for st in to_order.steps.iter().filter(|s| s.rerun() == Rerun::EveryUpdate) {
        let Step::Sql { id, file, run_as, .. } = st else { continue };
        let Some(new_hash) = sha(to, file) else {
            return Err(bad("STEP_FILE_UNPINNED", format!("step {id}: {file} is not listed in the signed manifest")));
        };
        let path = to_dir.join(crate::pack::safe_entry_path(file).map_err(|e| bad("RUN_ORDER", e))?);
        let text = std::fs::read_to_string(&path).map_err(|e| bad("STEP_FILE_UNREADABLE", format!("step {id}: {e}")))?;
        let hits = scan_forbidden_stmts(&text);
        if hits.iter().any(|(h, _)| h == "META_COMMAND") {
            return Err(bad("PSQL_META_COMMAND", format!("step {id}: {file} contains a psql meta-command")));
        }
        // psql follows the server's string settings, which a step can flip at run time, so no lexer can say where a `\!` is
        // a comment: a backslash anywhere in an every-update step file is refused
        if text.contains('\\') {
            return Err(bad("BACKSLASH_IN_STEP", format!("step {id}: {file} contains a backslash")));
        }
        if run_as == "supabase_admin" {
            let same_step = from_order.as_ref().is_some_and(|o| o.steps.iter().any(|f| matches!(f, Step::Sql { id: i2, file: f2, run_as: r2, .. } if i2 == id && f2 == file && r2 == run_as)));
            if !same_step || sha(from, file) != Some(new_hash) {
                return Err(bad("SUPERUSER_STEP_CHANGED", format!("step {id}: a superuser step may not be new, moved or changed by an update")));
            }
        } else if let Some((label, stmt)) = hits.first() {
            return Err(bad("FORBIDDEN_STEP_STATEMENT", format!("step {id}: {file} contains `{label}`: \"{stmt}\"")));
        }
    }
    Ok(())
}

/// A replication slot keeps WAL for ever (the disk fills) and a logical slot on the clone makes the rollback's DROP refuse:
/// an update does not start while any exists. `count` is `SELECT count(*) FROM pg_replication_slots`.
pub const SLOT_COUNT_SQL: &str = "SELECT count(*)::text FROM pg_replication_slots";
pub const APPLIED_SQL: &str = "SELECT version::text FROM supabase_migrations.schema_migrations";
pub fn slot_gate(count: &str) -> R<()> {
    match count.trim().parse::<u64>() {
        Ok(0) => Ok(()),
        Ok(n) => Err(OpError::new(OpCode::Precondition, "REPLICATION_SLOT_PRESENT", format!("{n} replication slot(s) exist; remove them before updating"))),
        Err(_) => Err(OpError::new(OpCode::Precondition, "REPLICATION_SLOT_UNREADABLE", "could not read the replication slots; refusing to update")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::manifest::Manifest;

    fn m(pv: &str, av: &str, count: u32, max: &str) -> Manifest { Manifest::for_test(pv, av, count, max) }
    fn set(v: &[&str]) -> BTreeSet<String> { v.iter().map(|s| s.to_string()).collect() }
    fn reason(r: R<()>) -> String { r.unwrap_err().reason }

    #[test]
    fn a_normal_upgrade_passes() {
        let (f, t) = (m("1.0.0-r1", "1.0.0", 2, "20260102000000"), m("1.0.1-r1", "1.0.1", 3, "20260103000000"));
        check_rules(&f, &t, &set(&["20260101000000", "20260102000000"]), &set(&["20260101000000", "20260102000000", "20260103000000"]), false).unwrap();
    }
    #[test]
    fn a_lower_pack_needs_the_flag_and_never_goes_below_the_live_schema() {
        let (f, t) = (m("1.0.1-r1", "1.0.1", 3, "20260103000000"), m("1.0.0-r1", "1.0.0", 2, "20260102000000"));
        let live = set(&["20260101000000", "20260102000000", "20260103000000"]);
        let packs = set(&["20260101000000", "20260102000000"]);
        assert_eq!(reason(check_rules(&f, &t, &live, &packs, false)), "PACK_DOWNGRADE");
        assert_eq!(reason(check_rules(&f, &t, &live, &packs, true)), "SCHEMA_OLDER_THAN_LIVE");
    }
    #[test]
    fn a_pack_missing_an_applied_migration_is_refused() {
        let (f, t) = (m("1.0.0-r1", "1.0.0", 2, "20260102000000"), m("1.0.1-r1", "1.0.1", 2, "20260103000000"));
        assert_eq!(reason(check_rules(&f, &t, &set(&["20260101000000", "20260102000000"]), &set(&["20260101000000", "20260103000000"]), false)), "MISSING_MIGRATIONS");
    }
    #[test]
    fn a_hotfix_revision_may_not_change_the_migration_set() {
        // No app release can match such a pack, so every till would be locked out.
        let (f, t) = (m("1.0.0-r1", "1.0.0", 2, "20260102000000"), m("1.0.0-r2", "1.0.0", 3, "20260103000000"));
        let live = set(&["20260101000000", "20260102000000"]);
        assert_eq!(reason(check_rules(&f, &t, &live, &set(&["20260101000000", "20260102000000", "20260103000000"]), false)), "MIGRATIONS_CHANGED_WITHOUT_APP_VERSION");
    }
    #[test]
    fn a_postgres_major_change_and_changed_bootstrap_sql_are_refused() {
        let mut f = m("1.0.0-r1", "1.0.0", 1, "20260101000000"); f.set_component("postgres", "17.10");
        let mut t = m("1.0.1-r1", "1.0.1", 1, "20260101000000"); t.set_component("postgres", "18.1");
        let live = set(&["20260101000000"]);
        assert_eq!(reason(check_rules(&f, &t, &live, &live, false)), "POSTGRES_MAJOR_CHANGED");
        let mut t2 = m("1.0.1-r1", "1.0.1", 1, "20260101000000"); t2.set_component("postgres", "17.11");
        f.add_file("sql/02-shim-after-gotrue.sql", "aa"); t2.add_file("sql/02-shim-after-gotrue.sql", "bb");
        assert_eq!(reason(check_rules(&f, &t2, &live, &live, false)), "BOOTSTRAP_SQL_CHANGED");
    }

    #[test]
    fn a_pack_that_changes_gotrue_must_declare_its_gotrue_migration_level() {
        let live = set(&["20260101000000"]);
        let mut f = m("1.0.0-r1", "1.0.0", 1, "20260101000000"); f.set_component("gotrue", "2.196.0");
        let mut t = m("1.0.1-r1", "1.0.1", 1, "20260101000000"); t.set_component("gotrue", "2.197.0");
        assert_eq!(reason(check_rules(&f, &t, &live, &live, false)), "GOTRUE_MIGRATIONS_MAX_MISSING");
        t.gotrue_migrations_max = Some("20260301000000".into());
        check_rules(&f, &t, &live, &live, false).unwrap();
        // GoTrue unchanged: nothing to declare
        let mut t2 = m("1.0.1-r1", "1.0.1", 1, "20260101000000"); t2.set_component("gotrue", "2.196.0");
        check_rules(&f, &t2, &live, &live, false).unwrap();
    }
}

#[cfg(test)]
mod pending_tests {
    use super::*;
    #[test]
    fn only_unapplied_files_are_scanned_and_a_cluster_change_is_refused() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("migrations")).unwrap();
        std::fs::write(d.path().join("migrations/20260101000000_old.sql"), "ALTER ROLE x SET a = 1;").unwrap(); // already applied: ignored
        std::fs::write(d.path().join("migrations/20260102000000_ok.sql"), "CREATE TABLE t(a int);").unwrap();
        let applied: BTreeSet<String> = ["20260101000000".to_string()].into();
        let p = pending_migrations(d.path(), &applied).unwrap();
        assert_eq!(p.len(), 1);
        forbid_cluster_changes(&p).unwrap();
        std::fs::write(d.path().join("migrations/20260103000000_bad.sql"), "alter database postgres set a = 1;").unwrap();
        let p = pending_migrations(d.path(), &applied).unwrap();
        assert_eq!(forbid_cluster_changes(&p).unwrap_err().reason, "FORBIDDEN_MIGRATION_STATEMENT");
    }
    #[test]
    fn the_runtime_scan_has_no_extension_exemption_for_the_two_historical_migrations() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("supabase").join("migrations");
        for name in ["20260506000002_agent_rag_schema.sql", "20260807000001_pool_session_atomic_rpcs.sql"] {
            let d = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(d.path().join("migrations")).unwrap();
            std::fs::copy(repo.join(name), d.path().join("migrations").join(name)).unwrap();
            let p = pending_migrations(d.path(), &BTreeSet::new()).unwrap();
            let e = forbid_cluster_changes(&p).unwrap_err();
            assert_eq!(e.reason, "FORBIDDEN_MIGRATION_STATEMENT", "{name}");
            assert!(e.to_string().contains("CREATE EXTENSION") || format!("{e:?}").contains("CREATE EXTENSION"), "{name}: {e:?}");
        }
    }
    fn refusal(name: &str, sql: &str) -> String {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("migrations")).unwrap();
        std::fs::write(d.path().join("migrations").join(name), sql).unwrap();
        let p = pending_migrations(d.path(), &BTreeSet::new()).unwrap();
        forbid_cluster_changes(&p).unwrap_err().message
    }
    #[test]
    fn a_migration_refusal_names_the_full_file_the_label_and_the_statement() {
        let m = refusal("20990101000001_comment.sql", "CREATE TABLE t(a int);\nCOMMENT ON TABLE t IS 'copy to the warehouse';\n");
        assert!(m.contains("20990101000001_comment.sql contains `COPY .. FILE`: \"COMMENT ON TABLE t IS 'copy to the warehouse'\""), "{m}");
    }
    #[test]
    fn a_long_statement_is_whitespace_collapsed_and_truncated() {
        let m = refusal("20990101000002_long.sql", &format!("ALTER\tROLE\n  anon   SET search_path = {};", "a".repeat(100)));
        let want = format!("`ALTER ROLE`: \"ALTER ROLE anon SET search_path = {}...\"", "a".repeat(80 - "ALTER ROLE anon SET search_path = ".len()));
        assert!(m.contains(&want), "{m}");
        assert!(!m.contains('\t') && !m.contains('\n'), "{m:?}");
    }
    #[test]
    fn a_migration_file_that_is_not_valid_utf8_fails_closed() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("migrations")).unwrap();
        std::fs::write(d.path().join("migrations/20260102000000_x.sql"), [0x41u8, 0xff, 0xfe, 0x20]).unwrap();
        let p = pending_migrations(d.path(), &BTreeSet::new()).unwrap();
        assert_eq!(forbid_cluster_changes(&p).unwrap_err().reason, "MIGRATIONS_UNREADABLE");
    }
}

#[cfg(test)]
mod step_tests {
    use super::*;
    use crate::update::manifest::hex;
    use sha2::{Digest, Sha256};

    /// The real pack sql folder, copied into a temp pack with a manifest that lists every file (the signed manifest, in effect).
    struct Pack { _d: tempfile::TempDir, dir: PathBuf, m: Manifest }
    fn copy_tree(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for e in std::fs::read_dir(src).unwrap().flatten() {
            let (s, d) = (e.path(), dst.join(e.file_name()));
            if s.is_dir() { copy_tree(&s, &d); } else { std::fs::copy(&s, &d).unwrap(); }
        }
    }
    fn shipped() -> Pack {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("pack");
        copy_tree(&Path::new(env!("CARGO_MANIFEST_DIR")).join("pack").join("sql"), &dir.join("sql"));
        // the pack builder places the stub extensions under sql/stub-extensions
        copy_tree(&Path::new(env!("CARGO_MANIFEST_DIR")).join("pack").join("stub-extensions"), &dir.join("sql").join("stub-extensions"));
        let mut p = Pack { _d: d, dir, m: Manifest::for_test("1.0.0-r1", "1.0.0", 1, "1") };
        p.relist();
        p
    }
    impl Pack {
        fn relist(&mut self) {
            self.m.files.clear();
            fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
                for e in std::fs::read_dir(dir).unwrap().flatten() {
                    let p = e.path();
                    if p.is_dir() { walk(base, &p, out); } else {
                        let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                        out.push((rel, hex(&Sha256::digest(std::fs::read(&p).unwrap()))));
                    }
                }
            }
            let mut v = vec![];
            walk(&self.dir, &self.dir.join("sql"), &mut v);
            for (p, h) in v { self.m.add_file(&p, &h); }
        }
        fn order(&self) -> serde_json::Value { serde_json::from_str(&std::fs::read_to_string(self.dir.join("sql/run-order.json")).unwrap()).unwrap() }
        fn set_order(&mut self, v: &serde_json::Value) { std::fs::write(self.dir.join("sql/run-order.json"), v.to_string()).unwrap(); self.relist(); }
        fn write(&mut self, rel: &str, text: &str) { std::fs::write(self.dir.join(rel), text).unwrap(); self.relist(); }
    }
    fn reason(from: &Pack, to: &Pack) -> String { check_steps(&from.dir, &to.dir, &from.m, &to.m).unwrap_err().reason }

    #[test]
    fn the_shipped_pack_passes() {
        let (a, b) = (shipped(), shipped());
        check_steps(&a.dir, &b.dir, &a.m, &b.m).unwrap();
    }
    #[test]
    fn a_new_superuser_step_is_refused() {
        let a = shipped();
        let mut b = shipped();
        let mut o = b.order();
        o["steps"].as_array_mut().unwrap().push(serde_json::json!({"id":"50-extra","kind":"sql","file":"sql/50-extra.sql","runAs":"supabase_admin","vars":[],"singleTransaction":true,"rerun":"every-update"}));
        b.write("sql/50-extra.sql", "select 1;");
        b.set_order(&o);
        assert_eq!(reason(&a, &b), "SUPERUSER_STEP_CHANGED");
    }
    #[test]
    fn a_step_moved_to_supabase_admin_is_refused() {
        let a = shipped();
        let mut b = shipped();
        let mut o = b.order();
        for s in o["steps"].as_array_mut().unwrap() { if s["id"] == "20-pos-lockout-hook" { s["runAs"] = serde_json::json!("supabase_admin"); } }
        b.set_order(&o);
        assert_eq!(reason(&a, &b), "SUPERUSER_STEP_CHANGED");
    }
    #[test]
    fn a_changed_superuser_file_outside_sql0_is_refused() {
        let mut a = shipped();
        let mut o = a.order();
        o["steps"].as_array_mut().unwrap().push(serde_json::json!({"id":"50-extra","kind":"sql","file":"sql/50-extra.sql","runAs":"supabase_admin","vars":[],"singleTransaction":true,"rerun":"every-update"}));
        a.write("sql/50-extra.sql", "select 1;");
        a.set_order(&o);
        let mut b = shipped();
        b.write("sql/50-extra.sql", "select 1;");
        b.set_order(&o);
        check_steps(&a.dir, &b.dir, &a.m, &b.m).unwrap(); // identical in both: frozen, allowed
        b.write("sql/50-extra.sql", "select 2;");
        assert_eq!(reason(&a, &b), "SUPERUSER_STEP_CHANGED");
    }
    #[test]
    fn a_postgres_step_with_alter_role_is_refused() {
        let a = shipped();
        let mut b = shipped();
        let old = std::fs::read_to_string(b.dir.join("sql/30-store-schema-version.sql")).unwrap();
        b.write("sql/30-store-schema-version.sql", &format!("{old}\nALTER ROLE anon NOLOGIN;\n"));
        assert_eq!(reason(&a, &b), "FORBIDDEN_STEP_STATEMENT");
    }
    #[test]
    fn a_step_refusal_names_the_step_the_file_the_label_and_the_statement() {
        let a = shipped();
        let mut b = shipped();
        let old = std::fs::read_to_string(b.dir.join("sql/30-store-schema-version.sql")).unwrap();
        b.write("sql/30-store-schema-version.sql", &format!("{old}\nALTER ROLE anon\n  NOLOGIN;\n"));
        let m = check_steps(&a.dir, &b.dir, &a.m, &b.m).unwrap_err().message;
        assert!(m.starts_with("step 30-store-schema-version: sql/30-store-schema-version.sql contains `ALTER ROLE`: \"ALTER ROLE anon NOLOGIN\""), "{m}");
    }
    #[test]
    fn a_mid_line_meta_command_is_refused() {
        let a = shipped();
        let mut b = shipped();
        let old = std::fs::read_to_string(b.dir.join("sql/30-store-schema-version.sql")).unwrap();
        b.write("sql/30-store-schema-version.sql", &format!("{old}\nSELECT 1; \\! calc\n"));
        assert_eq!(reason(&a, &b), "PSQL_META_COMMAND");
    }
    #[test]
    fn a_backslash_hidden_behind_a_runtime_string_setting_is_refused() {
        let a = shipped();
        let mut b = shipped();
        let old = std::fs::read_to_string(b.dir.join("sql/30-store-schema-version.sql")).unwrap();
        let sneaky = "SELECT set_config('standard'||'_conforming_strings','off',false);\nSELECT 'x\\' -- '; \\! calc\n";
        b.write("sql/30-store-schema-version.sql", &format!("{old}\n{sneaky}"));
        assert_eq!(reason(&a, &b), "BACKSLASH_IN_STEP");
        let mut c = shipped();
        c.write("sql/30-store-schema-version.sql", &format!("{old}\nSELECT 'a\\b';\n"));
        assert_eq!(reason(&a, &c), "BACKSLASH_IN_STEP");
    }
    #[test]
    fn the_shipped_every_update_steps_contain_no_backslash() {
        let s = shipped();
        for f in ["03c-database-grants", "02-shim-after-gotrue", "04-nonsuper-fixups", "20-pos-lockout-hook", "30-store-schema-version"] {
            assert!(!std::fs::read_to_string(s.dir.join(format!("sql/{f}.sql"))).unwrap().contains('\\'), "{f}");
        }
    }
    #[test]
    fn a_meta_command_in_a_frozen_superuser_file_is_refused_too() {
        let mut a = shipped();
        let old = std::fs::read_to_string(a.dir.join("sql/02-shim-after-gotrue.sql")).unwrap();
        a.write("sql/02-shim-after-gotrue.sql", &format!("{old}\n\\set x 1\n"));
        let b = shipped();
        let mut b2 = b;
        b2.write("sql/02-shim-after-gotrue.sql", &format!("{old}\n\\set x 1\n")); // identical in both packs
        assert_eq!(reason(&a, &b2), "PSQL_META_COMMAND");
    }
    #[test]
    fn an_unlisted_step_file_is_refused() {
        let a = shipped();
        let mut b = shipped();
        b.m.files.retain(|f| f.path != "sql/30-store-schema-version.sql");
        assert_eq!(reason(&a, &b), "STEP_FILE_UNPINNED");
    }
}
