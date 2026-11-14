//! `collect` + `evaluate` against the real fixture: `postgres` is the "local server", `cloud_src` the "cloud" with dev2 data.
//! Needs the native test instance (feature `fence-db-tests`, run ONLY through tests/support/run-fence-db-tests.ps1).
//! These are not #[ignore]d: with the feature on and the env missing they fail loudly (testkit::var).
use crate::ops::swap::PsqlAdmin;
use crate::switch::facts::{
    collect, evaluate, evaluate_waived, has_blockers, resolve_waivers, CollectCtx, Level,
    FENCE_MIGRATIONS,
};
use crate::switch::testkit::{admin, cloud_db, ResetFence, CLOUD, LOCAL};
use std::path::PathBuf;

/// Runs the statements in reverse on drop, so a failed assertion never leaves the fixture mutated.
struct Undo(Vec<(&'static str, String)>);
impl Undo {
    fn new() -> Undo {
        Undo(vec![])
    }
    fn run(&mut self, db: &'static str, apply: &str, undo: &str) {
        admin().exec(db, apply).unwrap();
        self.0.push((db, undo.to_string()));
    }
}
impl Drop for Undo {
    fn drop(&mut self) {
        for (db, sql) in self.0.iter().rev() {
            let _ = admin().exec(db, sql);
        }
    }
}

fn facts(storage_creds: bool) -> crate::switch::facts::PlanFacts {
    let pack = PathBuf::from(crate::switch::testkit::var("POS_PACK_DIR"));
    let local: PsqlAdmin = admin();
    let cloud = cloud_db();
    collect(&CollectCtx {
        local: &local,
        local_db: LOCAL,
        cloud: &cloud,
        pack_dir: &pack,
        pack_pg_major: 17,
        free_path: &std::env::temp_dir(),
        has_storage_creds: storage_creds,
        photo_import_available: true,
        local_inputs_missing: vec![],
    })
    .unwrap()
}
fn blocking(f: &crate::switch::facts::PlanFacts) -> Vec<String> {
    evaluate(f)
        .into_iter()
        .filter(|x| x.level == Level::Block)
        .map(|x| x.code)
        .collect()
}
fn one(db: &str, sql: &str) -> String {
    admin().scalar(db, sql).unwrap()
}
const REPORTER: &str = "00000000-0000-4000-8000-000000000001";
fn report_sql(uuid: &str, label: &str, queue: i32, dead: i32) -> String {
    format!(
        "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, reported_by) \
         VALUES ('{uuid}', '{label}', {queue}, {dead}, 'active', '{REPORTER}')"
    )
}

#[test]
fn a_dump_of_dev2_in_a_fresh_local_server_has_no_blocker() {
    let _r = ResetFence;
    let f = facts(false);
    let out = evaluate(&f);
    assert!(!has_blockers(&out), "{out:?}");
    assert!(f.copy_tables.len() >= 43, "{}", f.copy_tables.len());
    assert!(f.staff.iter().any(|s| s.admin_ok()));
    assert!(
        f.closure_unexpected.is_empty(),
        "{:?}",
        f.closure_unexpected
    );
    // the fixture carries the pair of fence migrations, both recognised, and the instance owner may set session_replication_role
    assert!(f.fence_present && !f.fence_outdated && f.fence_disabled.is_empty());
    for v in FENCE_MIGRATIONS {
        assert!(
            f.source_migrations.contains(v),
            "the cloud fixture lacks {v}"
        );
    }
    assert!(
        f.role_can_bypass,
        "supabase_admin may SET session_replication_role"
    );
    assert!(out
        .iter()
        .any(|x| x.code == "FENCE_BYPASS_POSSIBLE" && x.level == Level::Warn));
    // The value on this fixture (a pg_dump of dev2 into a stock supabase image): no writer role may skip the guard.
    assert!(
        f.writer_roles_can_bypass.is_empty(),
        "anon/authenticated/service_role may SET session_replication_role: {:?}",
        f.writer_roles_can_bypass
    );
}

#[test]
fn negative_controls_each_make_the_plan_refuse_and_the_fixture_is_restored() {
    let _r = ResetFence;
    let mut u = Undo::new();

    u.run(CLOUD, "DROP TRIGGER store_fence_guard ON public.categories", "CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.categories FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard()");
    assert!(blocking(&facts(false)).contains(&"FENCE_TABLES_UNGUARDED".to_string()));
    drop(u);
    let mut u = Undo::new();

    u.run(
        CLOUD,
        &report_sql("zz-test-q", "POS-7", 2, 0),
        "DELETE FROM public.till_sync_report WHERE terminal_uuid = 'zz-test-q'",
    );
    assert!(blocking(&facts(false)).contains(&"TILL_QUEUED".to_string()));
    drop(u);
    let mut u = Undo::new();

    u.run(
        CLOUD,
        "UPDATE public.profiles SET is_active = false WHERE role = 'admin'",
        "UPDATE public.profiles SET is_active = true WHERE role = 'admin'",
    );
    assert!(blocking(&facts(false)).contains(&"NO_VALID_ADMIN".to_string()));
    drop(u);
    let mut u = Undo::new();

    // Delete the hardening migration's row and put the SAME row back: both use the constant the unit tests prove is a real file name.
    let (v, v_sql) = (FENCE_MIGRATIONS[1], format!("'{}'", FENCE_MIGRATIONS[1]));
    assert_eq!(one(CLOUD, &format!("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = {v_sql}")), "1", "the cloud fixture must carry {v}");
    u.run(
        CLOUD,
        &format!("DELETE FROM supabase_migrations.schema_migrations WHERE version = {v_sql}"),
        &format!("INSERT INTO supabase_migrations.schema_migrations (version) SELECT {v_sql} WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = {v_sql})"),
    );
    assert!(blocking(&facts(false)).contains(&"SCHEMA_LEVEL_BEHIND".to_string()));
    drop(u);
    assert_eq!(one(CLOUD, &format!("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = {v_sql}")), "1", "the undo must have put {v} back");
    let mut u = Undo::new();

    u.run(
        CLOUD,
        "ALTER TABLE public.categories ADD COLUMN zz_probe text",
        "ALTER TABLE public.categories DROP COLUMN IF EXISTS zz_probe",
    );
    assert!(blocking(&facts(false)).contains(&"SCHEMA_SHAPE_MISMATCH".to_string()));
    drop(u);
    let mut u = Undo::new();

    // A NOT VALID check with a legacy row (S3 REVIEW I1): present on both sides, violated only in the cloud data.
    u.run(
        CLOUD,
        "INSERT INTO public.categories (name) VALUES ('zzviolator'); ALTER TABLE public.categories ADD CONSTRAINT zz_probe_check CHECK (name <> 'zzviolator') NOT VALID",
        "ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS zz_probe_check; DELETE FROM public.categories WHERE name = 'zzviolator'",
    );
    u.run(LOCAL, "ALTER TABLE public.categories ADD CONSTRAINT zz_probe_check CHECK (name <> 'zzviolator') NOT VALID", "ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS zz_probe_check");
    let f = facts(false);
    assert!(
        blocking(&f).contains(&"CHECK_VIOLATIONS".to_string()),
        "{:?}",
        evaluate(&f)
    );
    assert!(
        f.check_violations
            .iter()
            .any(|(n, c)| n.contains("zz_probe_check") && *c == 1),
        "{:?}",
        f.check_violations
    );
    drop(u);
    let mut u = Undo::new();

    // A session default that puts every session of a writer role (or the whole database) in replica mode skips the guard without any privilege check seeing it.
    u.run(
        CLOUD,
        "ALTER ROLE authenticated SET session_replication_role = replica",
        "ALTER ROLE authenticated RESET session_replication_role",
    );
    let f = facts(false);
    assert!(
        blocking(&f).contains(&"FENCE_DEFAULT_REPLICA".to_string()),
        "{:?}",
        evaluate(&f)
    );
    assert!(
        f.default_replica
            .iter()
            .any(|x| x.starts_with("authenticated@")),
        "{:?}",
        f.default_replica
    );
    drop(u);
    assert!(
        !blocking(&facts(false)).contains(&"FENCE_DEFAULT_REPLICA".to_string()),
        "the role default must be reset"
    );
    let mut u = Undo::new();

    u.run(
        CLOUD,
        "ALTER DATABASE cloud_src SET session_replication_role = replica",
        "ALTER DATABASE cloud_src RESET session_replication_role",
    );
    assert!(blocking(&facts(false)).contains(&"FENCE_DEFAULT_REPLICA".to_string()));
    drop(u);
    assert!(
        !blocking(&facts(false)).contains(&"FENCE_DEFAULT_REPLICA".to_string()),
        "the database default must be reset"
    );
    let mut u = Undo::new();

    u.run(CLOUD, "UPDATE public.store_switch_state SET state = 'frozen', op_id = 'x', until_at = now() + interval '5 minutes'", "UPDATE public.store_switch_state SET state = 'active', op_id = NULL, until_at = NULL");
    assert!(blocking(&facts(false)).contains(&"CLOUD_NOT_ACTIVE".to_string()));
    drop(u);
    let mut u = Undo::new();

    u.run(
        CLOUD,
        "INSERT INTO storage.objects (bucket_id, name) VALUES ('product-photos', 'zz-test/p.jpg')",
        "DELETE FROM storage.objects WHERE name = 'zz-test/p.jpg'",
    );
    assert!(blocking(&facts(false)).contains(&"STORAGE_CREDENTIALS_NEEDED".to_string()));
    assert!(!blocking(&facts(true)).contains(&"STORAGE_CREDENTIALS_NEEDED".to_string()));
    drop(u);

    assert!(
        !has_blockers(&evaluate(&facts(false))),
        "the fixture must be back to clean"
    );
}

#[test]
fn the_fence_objects_without_the_barrier_the_disabled_guard_and_the_partitioned_table_are_each_refused(
) {
    let _r = ResetFence;

    // 000001 only: the guard is not a barrier (no FOR SHARE). Rebuild the function from its own definition minus the lock.
    let def = one(
        CLOUD,
        "SELECT pg_get_functiondef('public.store_fence_guard()'::regprocedure)",
    );
    assert!(
        def.contains("FOR SHARE"),
        "the fixture's guard must be the hardened one"
    );
    let mut u = Undo::new();
    u.run(CLOUD, &def.replace("FOR SHARE", "FOR KEY SHARE"), &def);
    let f = facts(false);
    assert!(f.fence_present && f.fence_outdated);
    assert!(
        blocking(&f).contains(&"FENCE_OUTDATED".to_string()),
        "{:?}",
        evaluate(&f)
    );
    drop(u);
    assert!(
        !facts(false).fence_outdated,
        "the undo must have restored the hardened guard"
    );

    // a disabled or replica-only guard trigger: reported by name with its state letter, and as unguarded
    for (apply, letter) in [("DISABLE TRIGGER", "D"), ("ENABLE REPLICA TRIGGER", "R")] {
        let mut u = Undo::new();
        u.run(
            CLOUD,
            &format!("ALTER TABLE public.categories {apply} store_fence_guard"),
            "ALTER TABLE public.categories ENABLE TRIGGER store_fence_guard",
        );
        let f = facts(false);
        assert!(
            f.fence_disabled.contains(&format!("categories ({letter})")),
            "{letter}: {:?}",
            f.fence_disabled
        );
        let b = blocking(&f);
        assert!(
            b.contains(&"FENCE_GUARD_DISABLED".to_string())
                && b.contains(&"FENCE_TABLES_UNGUARDED".to_string()),
            "{letter}: {b:?}"
        );
        drop(u);
    }
    assert!(facts(false).fence_disabled.is_empty());

    // a partitioned public table with no guard (relkind 'p'): the old relkind = 'r' query could not see it
    let mut u = Undo::new();
    u.run(
        CLOUD,
        "CREATE TABLE public.zz_probe_part (id int) PARTITION BY RANGE (id)",
        "DROP TABLE IF EXISTS public.zz_probe_part",
    );
    let f = facts(false);
    assert!(
        f.fence_missing_tables
            .contains(&"zz_probe_part".to_string()),
        "{:?}",
        f.fence_missing_tables
    );
    assert!(blocking(&f).contains(&"FENCE_TABLES_UNGUARDED".to_string()));
    drop(u);
    assert!(
        !has_blockers(&evaluate(&facts(false))),
        "the fixture must be back to clean"
    );
}

#[test]
fn failed_offline_work_blocks_and_a_waiver_clears_only_its_own_till() {
    let _r = ResetFence;
    let (a, b) = ("zz-test-dl-a", "zz-test-dl-b");
    let mut u = Undo::new();
    u.run(
        CLOUD,
        &report_sql(a, "POS-DL-A", 0, 3),
        &format!("DELETE FROM public.till_sync_report WHERE terminal_uuid = '{a}'"),
    );
    u.run(
        CLOUD,
        &report_sql(b, "POS-DL-B", 2, 0),
        &format!("DELETE FROM public.till_sync_report WHERE terminal_uuid = '{b}'"),
    );
    let f = facts(false);
    let out = evaluate(&f);
    let dl = out
        .iter()
        .find(|x| x.code == "TILL_DEAD_LETTERS")
        .expect("dead letters are reported");
    assert_eq!(dl.level, Level::Block, "PM ruling D-a");
    assert_eq!(
        dl.tills
            .iter()
            .map(|t| (t.uuid.as_str(), t.label.as_str()))
            .collect::<Vec<_>>(),
        vec![(a, "POS-DL-A")]
    );
    // by label, by id: the same till; the other till still blocks
    for term in ["POS-DL-A", a] {
        let ids = resolve_waivers(&f.tills, &f.expected_labels, &[term.to_string()]).unwrap();
        let after = evaluate_waived(&f, &ids);
        assert!(
            !after.iter().any(|x| x.code == "TILL_DEAD_LETTERS"),
            "{term}: {after:?}"
        );
        assert!(
            after
                .iter()
                .any(|x| x.code == "TILL_QUEUED" && x.tills.iter().any(|t| t.uuid == b)),
            "{term}: the other till still blocks"
        );
    }
    let both = resolve_waivers(
        &f.tills,
        &f.expected_labels,
        &["POS-DL-A".to_string(), "POS-DL-B".to_string()],
    )
    .unwrap();
    let cleared = blocking_of(&evaluate_waived(&f, &both));
    assert!(
        !cleared.contains(&"TILL_DEAD_LETTERS".to_string())
            && !cleared.contains(&"TILL_QUEUED".to_string()),
        "{cleared:?}"
    );
    drop(u);
}
fn blocking_of(f: &[crate::switch::facts::Finding]) -> Vec<String> {
    f.iter()
        .filter(|x| x.level == Level::Block)
        .map(|x| x.code.clone())
        .collect()
}

// ---- Plan 09 T14: the carried DB tests and the five deferred fence controls (mutants.rs seam; a control arms one mutant, runs the
// pin that must go red, and the same pin unarmed is the green half). ----

const GUARD_DROP: &str = "DROP TRIGGER store_fence_guard ON public.categories; ";
const GUARD_RESTORE: &str = "DROP TRIGGER IF EXISTS store_fence_guard ON public.categories; CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.categories FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard()";

/// A guard-shaped trigger that is NOT the guard (`events` / `when` differ) must leave `categories` reported as unguarded.
fn pin_lookalike_guard_is_unguarded(events: &str, when: &str) {
    let _r = ResetFence;
    let mut u = Undo::new();
    u.run(
        CLOUD,
        &format!("{GUARD_DROP}CREATE TRIGGER store_fence_guard BEFORE {events} ON public.categories FOR EACH STATEMENT {when} EXECUTE FUNCTION public.store_fence_guard()"),
        GUARD_RESTORE,
    );
    let f = facts(false);
    assert!(
        f.fence_missing_tables.contains(&"categories".to_string()),
        "lookalike guard ({events} {when}) counted as a guard: {:?}",
        f.fence_missing_tables
    );
    assert!(blocking(&f).contains(&"FENCE_TABLES_UNGUARDED".to_string()));
    drop(u);
    assert!(
        !has_blockers(&evaluate(&facts(false))),
        "the fixture must be back to clean"
    );
}
fn pin_tgtype() {
    pin_lookalike_guard_is_unguarded("INSERT OR UPDATE OR DELETE", ""); // no TRUNCATE: tgtype 54
}
fn pin_tgqual() {
    pin_lookalike_guard_is_unguarded("INSERT OR UPDATE OR DELETE OR TRUNCATE", "WHEN (true)");
}
fn pin_tgattr() {
    pin_lookalike_guard_is_unguarded("INSERT OR UPDATE OF name OR DELETE OR TRUNCATE", "");
}
fn pin_partitioned() {
    let _r = ResetFence;
    let mut u = Undo::new();
    u.run(
        CLOUD,
        "CREATE TABLE public.zz_probe_part (id int) PARTITION BY RANGE (id)",
        "DROP TABLE IF EXISTS public.zz_probe_part",
    );
    let f = facts(false);
    assert!(
        f.fence_missing_tables
            .contains(&"zz_probe_part".to_string()),
        "partitioned table not seen: {:?}",
        f.fence_missing_tables
    );
}
/// A default set on the checking session's own database is read back through `pg_settings.reset_val`: the `system` entry.
fn pin_system_default() {
    let _r = ResetFence;
    let mut u = Undo::new();
    u.run(
        CLOUD,
        "ALTER DATABASE cloud_src SET session_replication_role = replica",
        "ALTER DATABASE cloud_src RESET session_replication_role",
    );
    let f = facts(false);
    assert!(
        f.default_replica.contains(&"system".to_string()),
        "no system entry: {:?}",
        f.default_replica
    );
}

#[test]
fn a_lookalike_guard_a_partitioned_table_and_a_session_default_are_each_seen() {
    pin_tgtype();
    pin_tgqual();
    pin_tgattr();
    pin_partitioned();
    pin_system_default();
    assert!(
        !has_blockers(&evaluate(&facts(false))),
        "the fixture must be back to clean"
    );
}

#[test]
fn t14_fence_controls_each_go_red_when_their_clause_is_weakened() {
    use crate::switch::mutants::{expect_red, M};
    expect_red(
        M::GuardNoTgtype,
        "lookalike guard (INSERT OR UPDATE OR DELETE ) counted",
        pin_tgtype,
    );
    expect_red(M::GuardNoTgqual, "WHEN (true)) counted", pin_tgqual);
    expect_red(M::GuardNoTgattr, "UPDATE OF name", pin_tgattr);
    expect_red(
        M::CoveredOrdinaryOnly,
        "partitioned table not seen",
        pin_partitioned,
    );
    expect_red(
        M::DefaultReplicaNoSystem,
        "no system entry",
        pin_system_default,
    );
    assert!(
        !has_blockers(&evaluate(&facts(false))),
        "the fixture must be back to clean"
    );
}

#[test]
fn writer_bypass_role_level_grant_blocks() {
    let _r = ResetFence;
    let mut u = Undo::new();
    u.run(
        CLOUD,
        "GRANT SET ON PARAMETER session_replication_role TO authenticated",
        "REVOKE SET ON PARAMETER session_replication_role FROM authenticated",
    );
    let f = facts(false);
    assert!(
        f.writer_roles_can_bypass
            .contains(&"authenticated".to_string()),
        "{:?}",
        f.writer_roles_can_bypass
    );
    assert!(
        blocking(&f).contains(&"FENCE_WRITER_BYPASS".to_string()),
        "{:?}",
        evaluate(&f)
    );
    drop(u);
    let f = facts(false);
    assert!(
        !blocking(&f).contains(&"FENCE_WRITER_BYPASS".to_string()),
        "the revoke must clear it: {:?}",
        evaluate(&f)
    );
}
