//! Plan 09 T12: real-database proof and negative controls (cargo feature `fence-db-tests`, run only through
//! tests/support/run-fence-db-tests.ps1). `cloud_src` is the test "cloud", `postgres` the local server.
//!
//! MUTANT TABLE (a control is "pinned" when the test named here goes RED with the mutation armed; `mutants::expect_red` proves it and
//! prints `failed as expected`; the pinned test run unarmed is the GREEN half). Unit-level controls live next to their code.
//!
//! | control_* test (this file unless noted)         | arms (switch/mutants.rs)      | mutation                                                        | pinned test                                                          | red message contains |
//! | control_null_token_blanking_is_pinned           | BlankNullOff                  | verify::fp_blank_null returns []                                | verify_db_tests::null_token_cloud_row_matches_blanked_clone          | NULL tokens and a different password are not a mismatch |
//! | control_volatile_columns_are_pinned             | VolatileEmpty                 | verify::fp_volatile returns []                                  | verify_db_tests::null_token_cloud_row_matches_blanked_clone          | (same) |
//! | control_keep_set_is_pinned                      | KeepSkipOff                   | rederive::apply scrambles with `&[]` instead of `keep`          | rederive_db::kept_accounts_are_untouched_and_an_account_without_...  | keep set row count differs |
//! | control_rederive_script_is_pinned               | ScriptSkipped                 | rederive::apply does not run `admin.script(..)`                 | rederive_db::kept_accounts_are_untouched_and_an_account_without_...  | the orphan has an unknown password |
//! | verify::tests::control_local_only_check_is_pinned| SkipCopyLosesTillSyncReport   | verify_clone's SKIP_COPY loop skips `till_sync_report`          | verify::tests::local_only_tables_not_copied                          | COPIED_LOCAL_ONLY_TABLE |
//! | verify::tests::control_sequence_check_wiring_is_pinned | SequenceCheckDeleted    | verify_clone no longer calls the sequence check                 | verify::tests::verify_clone_reports_a_lagging_sequence               | SEQUENCE_BEHIND |
//! | verify::tests::control_sequence_boundary_is_pinned | SequenceBoundary            | sequence_findings `next <= max` becomes `next < max`            | verify::tests::a_sequence_reset_just_past_the_data_is_fine_and_...   | left: 0 |
//! | rederive::tests::control_refuse_default_arm_is_pinned | RefuseDefaultArmOpen     | refuse_if_switched default arm becomes `{}`                     | rederive::tests::an_unreadable_or_missing_config_refuses_and_never_.. | the fence must not be contacted |
use crate::switch::load::repair_tokens_sql;
use crate::switch::mutants::{expect_red, M};
use crate::switch::rederive::apply;
use crate::switch::testkit::{admin, CLOUD, LOCAL};
use crate::switch::verify::{verify_clone, COPIED_LOCAL_ONLY_TABLE, FINGERPRINT_MISMATCH};
use crate::switch::{rederive_db, verify_db_tests};

#[test]
fn control_null_token_blanking_is_pinned() {
    expect_red(
        M::BlankNullOff,
        "NULL tokens and a different password are not a mismatch",
        verify_db_tests::null_token_cloud_row_matches_blanked_clone,
    );
}

#[test]
fn control_volatile_columns_are_pinned() {
    expect_red(
        M::VolatileEmpty,
        "NULL tokens and a different password are not a mismatch",
        verify_db_tests::null_token_cloud_row_matches_blanked_clone,
    );
}

#[test]
fn control_keep_set_is_pinned() {
    expect_red(
        M::KeepSkipOff,
        "keep set row count differs",
        rederive_db::kept_accounts_are_untouched_and_an_account_without_a_profile_is_scrambled,
    );
}

#[test]
fn control_rederive_script_is_pinned() {
    expect_red(
        M::ScriptSkipped,
        "the orphan has an unknown password",
        rederive_db::kept_accounts_are_untouched_and_an_account_without_a_profile_is_scrambled,
    );
}

const ID: &str = "00000000-0000-4000-8000-0000000c10a1";

/// Removes the fixture from both sides and puts every local credential back, whatever an assertion did.
struct Undo;
impl Undo {
    fn new() -> Undo {
        let a = admin();
        // own fixtures only: nothing here reads data that exists before the test
        let _ = a.exec(
            LOCAL,
            &format!("DELETE FROM public.profiles WHERE id = '{ID}'; DELETE FROM auth.users WHERE id = '{ID}'"),
        );
        let _ = a.exec(
            CLOUD,
            &format!("DELETE FROM public.profiles WHERE id = '{ID}'; DELETE FROM auth.users WHERE id = '{ID}'"),
        );
        a.exec(
            LOCAL,
            "DROP SCHEMA IF EXISTS zz_clone CASCADE; CREATE SCHEMA zz_clone; \
             CREATE TABLE zz_clone.u AS SELECT id, encrypted_password, updated_at FROM auth.users",
        )
        .unwrap();
        Undo
    }
}
impl Drop for Undo {
    fn drop(&mut self) {
        let a = admin();
        let _ = a.exec(
            LOCAL,
            &format!(
                "DELETE FROM public.profiles WHERE id = '{ID}'; DELETE FROM auth.users WHERE id = '{ID}'; \
                 UPDATE auth.users u SET encrypted_password = b.encrypted_password, updated_at = b.updated_at FROM zz_clone.u b WHERE b.id = u.id; \
                 DROP SCHEMA zz_clone CASCADE"
            ),
        );
        let _ = a.exec(
            CLOUD,
            &format!("DELETE FROM public.profiles WHERE id = '{ID}'; DELETE FROM auth.users WHERE id = '{ID}'"),
        );
    }
}

/// The copy step of the switch for the rows of `table` matching `filter` (the pg_dump/pg_restore pipe itself is Sandbox scenario 50):
/// they go from the cloud to the local server through their JSON form, writable columns only (generated and identity columns are
/// left to the server). `replica` copies with triggers and foreign keys off, like `pg_restore --disable-triggers`. No row is fine.
fn copy_where(schema: &str, table: &str, filter: &str, replica: bool) {
    let a = admin();
    let cols = a
        .scalar(
            LOCAL,
            &format!(
                "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) FROM information_schema.columns \
                 WHERE table_schema = '{schema}' AND table_name = '{table}' AND is_generated = 'NEVER' AND is_identity = 'NO'"
            ),
        )
        .unwrap();
    let json = a
        .scalar(
            CLOUD,
            &format!("SELECT jsonb_agg(to_jsonb(t)) FROM {schema}.{table} t WHERE {filter}"),
        )
        .unwrap();
    if !json.starts_with('[') {
        return;
    }
    let mode = if replica { "SET session_replication_role = replica; " } else { "" };
    a.exec(
        LOCAL,
        &format!(
            "{mode}INSERT INTO {schema}.{table} ({cols}) SELECT {cols} FROM jsonb_populate_recordset(null::{schema}.{table}, $zz${json}$zz$::jsonb)"
        ),
    )
    .unwrap();
}

fn copy_row(schema: &str, table: &str) {
    let json = admin().scalar(CLOUD, &format!("SELECT count(*) FROM {schema}.{table} WHERE id = '{ID}'")).unwrap();
    assert_eq!(json.trim(), "1", "the cloud fixture row is there");
    copy_where(schema, table, &format!("id = '{ID}'"), false);
}

/// Narrows the verification's two fingerprint statements to the fixture row (the instance holds other rows on either side).
/// The three local-only tables are emptied, not checked: see the NOTE on `copy_rederive_verify_on_dev2_clone`.
fn scoped(sql: &str) -> String {
    let mut s = sql
        .replace("FROM auth.users t WHERE true", &format!("FROM auth.users t WHERE id = '{ID}'"))
        .replace("FROM public.profiles t WHERE true", &format!("FROM public.profiles t WHERE id = '{ID}'"));
    // The throwaway pair is cloned from one template, so the tables that stay local hold the same seed row on both sides and would
    // read as "copied". This test copies none of them (the local-only check is pinned by the unit control), so they are emptied here.
    for t in ["store_switch_state", "till_sync_report", "pin_attempts"] {
        s = s.replace(&format!("FROM public.{t} t WHERE true"), &format!("FROM public.{t} t WHERE false"));
    }
    s
}

/// NOTE: this test does NOT check COPIED_LOCAL_ONLY_TABLE (the local-only tables are emptied in `scoped`); that control is pinned by
/// `verify::tests::control_local_only_check_is_pinned`. The name is the one the plan gives (T12 tests list).
/// The cloud-to-local data path on a fresh throwaway pair, fixtures made here: a staff admin whose cloud row has NULL GoTrue
/// tokens and a cloud-era password is copied, the tokens are repaired, the staff passwords re-derived, the admin signs in with the
/// derived password, and `verify_clone` finds the clone equal to the cloud (a changed clone row is the control).
#[test]
fn copy_rederive_verify_on_dev2_clone() {
    let _undo = Undo::new();
    let a = admin();
    // 1. the cloud-side fixture
    a.exec(CLOUD, &format!("INSERT INTO auth.users (id, email, encrypted_password) VALUES ('{ID}', 'zz-clone@example.invalid', 'cloud-hash')")).unwrap();
    a.exec(CLOUD, &format!("UPDATE auth.users SET confirmation_token = NULL, recovery_token = NULL, email_change_token_new = NULL, email_change_token_current = NULL, email_change = NULL, reauthentication_token = NULL, phone_change_token = NULL WHERE id = '{ID}'")).unwrap();
    a.exec(CLOUD, &format!("INSERT INTO public.profiles (id, name, role, pin) VALUES ('{ID}', 'zz clone admin', 'admin', '654321')")).unwrap();
    // 2. copy (users first: profiles reference them), then the token repair the real load runs
    copy_row("auth", "users");
    copy_row("public", "profiles");
    assert_eq!(
        a.scalar(LOCAL, &format!("SELECT count(*) FROM auth.users WHERE id = '{ID}' AND confirmation_token IS NULL")).unwrap(),
        "1",
        "the control: the copy carries the cloud's NULL tokens"
    );
    a.exec(LOCAL, &repair_tokens_sql()).unwrap();
    assert_eq!(
        a.scalar(LOCAL, &format!("SELECT count(*) FROM auth.users WHERE id = '{ID}' AND confirmation_token = '' AND phone_change_token = ''")).unwrap(),
        "1",
        "the repair blanked the NULL tokens"
    );
    // 3. the staff accounts are prepared: the copied staff credential stays as it is (11H: the cloud pepper is installed, nothing is derived)
    let r = apply(&a, LOCAL, &[]).unwrap();
    assert!(r.rows >= 1, "{r:?}");
    assert_eq!(
        a.scalar(LOCAL, &format!("SELECT encrypted_password FROM auth.users WHERE id = '{ID}'")).unwrap(),
        "cloud-hash",
        "the staff row keeps the cloud's credential"
    );
    // 4. verify: the cloud and the clone hold the same credential and the tokens are blanked: still equal
    let (src, dst) = (
        |sql: &str| admin().scalar(CLOUD, &scoped(sql)),
        |sql: &str| admin().scalar(LOCAL, &scoped(sql)),
    );
    let copy = vec!["auth.users".to_string(), "public.profiles".to_string()];
    let f = verify_clone(&src, &dst, &copy).unwrap();
    let mine: Vec<_> = f
        .iter()
        .filter(|x| x.code == FINGERPRINT_MISMATCH || x.code == COPIED_LOCAL_ONLY_TABLE)
        .collect();
    assert!(mine.is_empty(), "the clone equals the cloud for the fixture rows: {f:?}");
    // 5. the control: a changed clone row is found
    a.exec(LOCAL, &format!("UPDATE auth.users SET email = 'zz-changed@example.invalid' WHERE id = '{ID}'")).unwrap();
    let f = verify_clone(&src, &dst, &copy).unwrap();
    assert!(
        f.iter().any(|x| x.code == FINGERPRINT_MISMATCH && x.detail.contains("auth.users")),
        "a changed clone row is a mismatch: {f:?}"
    );
}

// ---- T12 carried tests: fence hygiene (M18), release after moved, latency

/// Drops the late tables whatever an assertion did.
struct DropTables(&'static [&'static str]);
impl Drop for DropTables {
    fn drop(&mut self) {
        for t in self.0 {
            let _ = admin().exec(CLOUD, &format!("DROP TABLE IF EXISTS public.{t}"));
        }
    }
}

const GUARD_TRIGGER: &str = "CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.{t} \
     FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard()";

#[test]
fn reset_fence_resets_role_and_database_defaults() {
    let a = admin();
    let _roles = crate::switch::testkit::ResetFence; // the guard under test runs on this drop
    a.exec(CLOUD, "ALTER ROLE authenticated SET session_replication_role = replica").unwrap();
    a.exec(CLOUD, "ALTER DATABASE cloud_src SET session_replication_role = local").unwrap();
    let both = a.scalar(CLOUD, crate::switch::facts::SQL_DEFAULT_REPLICA).unwrap();
    assert!(
        both.contains("authenticated@") && both.contains("@cloud_src"),
        "the control: `replica` on a role and `local` on the database are both reported: {both}"
    );
    drop(crate::switch::testkit::ResetFence);
    let after = a.scalar(CLOUD, crate::switch::facts::SQL_DEFAULT_REPLICA).unwrap();
    assert!(
        !after.contains("authenticated@") && !after.contains("@cloud_src"),
        "ResetFence resets the role and database defaults: {after}"
    );
}

/// M18: a table created after the plan ran has no guard. The statement the freeze re-check runs (`SQL_UNGUARDED`, via
/// `RealMachine::unguarded_tables`) names it; once it carries the guard it is no longer named. The wiring (a late table stops the run
/// before `freeze`) is the unit test `work::tests::freeze_rechecks_late_tables_without_a_guard`.
#[test]
fn late_table_without_guard_is_caught_at_freeze() {
    let a = admin();
    let _drop = DropTables(&["zz_late_t"]);
    let _r = crate::switch::testkit::ResetFence;
    a.exec(CLOUD, "DROP TABLE IF EXISTS public.zz_late_t; CREATE TABLE public.zz_late_t (id int)").unwrap();
    // an event trigger of the instance may guard new tables by itself: the fixture is explicitly unguarded
    let _ = a.exec(CLOUD, "DROP TRIGGER IF EXISTS store_fence_guard ON public.zz_late_t");
    let unguarded = || crate::switch::testkit::cloud_db().ro(crate::switch::facts::SQL_UNGUARDED).unwrap();
    assert!(unguarded().split(',').any(|t| t.trim() == "zz_late_t"), "{}", unguarded());
    a.exec(CLOUD, &GUARD_TRIGGER.replace("{t}", "zz_late_t")).unwrap();
    assert!(
        !unguarded().split(',').any(|t| t.trim() == "zz_late_t"),
        "the control: a guarded table is not named: {}",
        unguarded()
    );
    // the refusal path: the hold taken for the run is given back and the cloud reads `active`
    let _ = a.exec(CLOUD, "DROP TRIGGER IF EXISTS store_fence_guard ON public.zz_late_t");
    let f = crate::switch::cloud::CloudFence::new(crate::switch::testkit::cloud_db(), "op-t12-late").unwrap();
    drop(crate::switch::testkit::ResetFence); // a clean row first
    f.begin_draining(5).unwrap();
    assert!(unguarded().split(',').any(|t| t.trim() == "zz_late_t"), "named while the cloud is draining: {}", unguarded());
    assert!(f.release_held().unwrap(), "the hold is this operation's, so it is freed");
    assert_eq!(f.state().unwrap(), "active||active", "the cloud is active again after the refusal");
}

/// The real SQL of the fence: once the row is `moved`, only the operation that moved it can release it. No operation id (the
/// unconditional release), the scoped hold release and a foreign operation all leave it `moved`.
#[test]
fn real_rpc_release_after_moved_needs_op_id() {
    use crate::switch::cloud::CloudFence;
    let _r = crate::switch::testkit::ResetFence;
    drop(crate::switch::testkit::ResetFence); // start from a clean row
    let fence = |op: &str| CloudFence::new(crate::switch::testkit::cloud_db(), op).unwrap();
    let (me, other) = (fence("op-t12-a"), fence("op-t12-b"));
    me.begin_draining(5).unwrap();
    me.freeze(5).unwrap();
    me.mark_moved().unwrap();
    assert_eq!(me.state().unwrap(), "moved|op-t12-a|moved");
    assert!(!me.release_unfinished().unwrap(), "no op id: a recorded move is never reverted");
    assert!(!me.release_held().unwrap(), "the scoped hold release never frees a moved row");
    assert_eq!(other.release().unwrap_err().reason, "CLOUD_FENCE_LOST");
    assert_eq!(me.state().unwrap(), "moved|op-t12-a|moved");
    me.release().unwrap();
    assert_eq!(me.state().unwrap(), "active||active", "only the operation that moved it releases it");
}

/// The guard's cost per write statement, measured inside one server session (no process start in the loop): the same single-row
/// insert into a guarded and an unguarded table on the same instance, alternating so drift hits both. Each write is timed on its
/// own; the MEDIAN of each series is compared (not one sample, not an average). Budget: the guard adds at most BUDGET_MS to the median.
#[test]
fn guard_adds_a_measured_latency_under_budget() {
    // PM ruling: 2.0 ms on the median difference. Fixed.
    const BUDGET_MS: f64 = 2.0;
    const N: u32 = 400; // timed writes per series (at least 200)
    let a = admin();
    let _drop = DropTables(&["zz_lat_g", "zz_lat_u", "zz_lat_r"]);
    let _r = crate::switch::testkit::ResetFence;
    a.exec(
        CLOUD,
        "DROP TABLE IF EXISTS public.zz_lat_g, public.zz_lat_u, public.zz_lat_r; \
         CREATE TABLE public.zz_lat_g (id int); CREATE TABLE public.zz_lat_u (id int); \
         CREATE TABLE public.zz_lat_r (kind text, ms double precision)",
    )
    .unwrap();
    for t in ["zz_lat_g", "zz_lat_u"] {
        let _ = a.exec(CLOUD, &format!("DROP TRIGGER IF EXISTS store_fence_guard ON public.{t}"));
    }
    a.exec(CLOUD, &GUARD_TRIGGER.replace("{t}", "zz_lat_g")).unwrap();
    // One transaction per write, like production: the DO block COMMITs after every timed insert (PG11+ procedural COMMIT; legal only
    // because this `-c` string is the single top-level statement and PsqlAdmin does not use --single-transaction). Only the insert is
    // timed, so the guard's FOR SHARE on the state row is taken afresh for every write and the commit's fsync stays out of both series.
    a.exec(
        CLOUD,
        &format!(
            "DO $zz$ DECLARE t0 timestamptz; ga double precision[] := '{{}}'; ua double precision[] := '{{}}'; BEGIN \
             FOR i IN 1..50 LOOP INSERT INTO public.zz_lat_g VALUES (i); COMMIT; INSERT INTO public.zz_lat_u VALUES (i); COMMIT; END LOOP; \
             FOR i IN 1..{N} LOOP \
               t0 := clock_timestamp(); INSERT INTO public.zz_lat_g VALUES (i); ga := ga || (extract(epoch FROM clock_timestamp() - t0) * 1000)::double precision; COMMIT; \
               t0 := clock_timestamp(); INSERT INTO public.zz_lat_u VALUES (i); ua := ua || (extract(epoch FROM clock_timestamp() - t0) * 1000)::double precision; COMMIT; \
             END LOOP; \
             INSERT INTO public.zz_lat_r SELECT 'g', x FROM unnest(ga) x; INSERT INTO public.zz_lat_r SELECT 'u', x FROM unnest(ua) x; \
             END $zz$"
        ),
    )
    .unwrap();
    let median = |k: &str| -> f64 {
        a.scalar(CLOUD, &format!("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FROM public.zz_lat_r WHERE kind = '{k}'"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    };
    let n = |k: &str| -> i64 {
        a.scalar(CLOUD, &format!("SELECT count(*) FROM public.zz_lat_r WHERE kind = '{k}'")).unwrap().trim().parse().unwrap()
    };
    assert!(n("g") >= 200 && n("u") >= 200, "the control: at least 200 timed writes per series ({}, {})", n("g"), n("u"));
    let (g, u) = (median("g"), median("u"));
    let diff = g - u;
    println!("guard latency: median guarded {g:.4} ms, median unguarded {u:.4} ms, difference {diff:.4} ms over {N} writes each (budget {BUDGET_MS} ms)");
    assert!(g > 0.0 && u > 0.0, "the control: both series were timed ({g}, {u})");
    assert!(diff < BUDGET_MS, "the guard adds {diff:.4} ms to the median write, over the {BUDGET_MS} ms budget");
}

/// `IS DISTINCT FROM origin`: a setting that is unset (or a different setting) or `origin` is not flagged; `local` and `replica` are.
#[test]
fn default_replica_query_flags_local_and_replica_and_never_unset_or_origin() {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            let _ = admin().exec(CLOUD, "ALTER ROLE authenticated RESET work_mem");
            drop(crate::switch::testkit::ResetFence); // role and database session_replication_role defaults
        }
    }
    let a = admin();
    let _reset = Reset;
    let flagged = || a.scalar(CLOUD, crate::switch::facts::SQL_DEFAULT_REPLICA).unwrap();
    let mine = |s: &str| s.split(',').any(|x| x.trim() == "authenticated@*");
    assert!(!mine(&flagged()), "the control: nothing set: {}", flagged());
    a.exec(CLOUD, "ALTER ROLE authenticated SET work_mem = '8MB'").unwrap();
    assert!(!mine(&flagged()), "a role with only another setting is not flagged: {}", flagged());
    a.exec(CLOUD, "ALTER ROLE authenticated SET session_replication_role = origin").unwrap();
    assert!(!mine(&flagged()), "origin is not flagged: {}", flagged());
    for v in ["local", "replica"] {
        a.exec(CLOUD, &format!("ALTER ROLE authenticated SET session_replication_role = {v}")).unwrap();
        assert!(mine(&flagged()), "{v} is flagged: {}", flagged());
    }
    // the NULL case of the server-level test: a missing setting row reads as origin, never as a difference
    assert_eq!(
        a.scalar(
            CLOUD,
            "SELECT count(*) FROM (SELECT 1 WHERE COALESCE((SELECT reset_val FROM pg_settings WHERE name = 'zz_no_such_setting'), 'origin') IS DISTINCT FROM 'origin') q"
        )
        .unwrap()
        .trim(),
        "0"
    );
}

// ---- M3: a sale applied on the CLOUD whose answer was lost replays once on the local server

const SALE_STAFF: &str = "00000000-0000-4000-8000-0000000c20a1";
const SALE_CAT: &str = "00000000-0000-4000-8000-0000000c20b1";
const SALE_PRODUCT: &str = "00000000-0000-4000-8000-0000000c20c1";
const SALE_SHIFT: &str = "00000000-0000-4000-8000-0000000c20d1";
const SALE_CAJA: &str = "00000000-0000-4000-8000-0000000c20e1";
const SALE_TERMINAL: &str = "T12-TILL";
const SALE_START_STOCK: i64 = 10;

/// Removes the sale fixtures from one side (triggers and foreign keys off for the cleanup only: throwaway test data).
fn sale_cleanup(db: &str) {
    let _ = admin().exec(
        db,
        &format!(
            "SET session_replication_role = replica; \
             DELETE FROM public.payments WHERE tab_id IN (SELECT id FROM public.tabs WHERE caja_session_id = '{SALE_CAJA}'); \
             DELETE FROM public.order_items WHERE order_id IN (SELECT o.id FROM public.orders o JOIN public.tabs t ON t.id = o.tab_id WHERE t.caja_session_id = '{SALE_CAJA}'); \
             DELETE FROM public.orders WHERE tab_id IN (SELECT id FROM public.tabs WHERE caja_session_id = '{SALE_CAJA}'); \
             DELETE FROM public.tabs WHERE caja_session_id = '{SALE_CAJA}'; \
             DELETE FROM public.caja_entries WHERE caja_session_id = '{SALE_CAJA}'; \
             DELETE FROM public.stock_movements WHERE product_id = '{SALE_PRODUCT}'; \
             DELETE FROM public.inventory WHERE product_id = '{SALE_PRODUCT}'; \
             DELETE FROM public.products WHERE id = '{SALE_PRODUCT}'; \
             DELETE FROM public.categories WHERE id = '{SALE_CAT}'; \
             DELETE FROM public.caja_sessions WHERE id = '{SALE_CAJA}'; \
             DELETE FROM public.shifts WHERE id = '{SALE_SHIFT}'; \
             DELETE FROM public.profiles WHERE id = '{SALE_STAFF}'; \
             DELETE FROM auth.users WHERE id = '{SALE_STAFF}'"
        ),
    );
}
struct SaleUndo;
impl Drop for SaleUndo {
    fn drop(&mut self) {
        sale_cleanup(LOCAL);
        sale_cleanup(CLOUD);
    }
}

fn count_on(db: &str, sql: &str) -> i64 {
    admin().scalar(db, sql).unwrap().trim().parse().unwrap()
}

/// The till's call as the replayer makes it: the stored idempotency key, the stored lines, the till's terminal. `role`: the DB role
/// the call runs as (the edge function `process-direct-sale` calls the RPC as `service_role`; `None` is the superuser).
fn replay(db: &str, role: Option<&str>, key: &str, payment_args: &str) -> serde_json::Value {
    let items = format!(r#"[{{"product_id":"{SALE_PRODUCT}","quantity":2,"unit_price":50.00}}]"#);
    let set_role = role.map(|r| format!("SET ROLE {r}; ")).unwrap_or_default();
    let out = admin()
        .scalar(
            db,
            &format!(
                "{set_role}SELECT public.process_direct_sale_atomic(p_staff_id := '{SALE_STAFF}', p_shift_id := '{SALE_SHIFT}', \
                 p_caja_session_id := '{SALE_CAJA}', p_items := '{items}'::jsonb, p_idempotency_key := '{key}', \
                 p_terminal_id := '{SALE_TERMINAL}', {payment_args})::text"
            ),
        )
        .unwrap();
    serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not json ({e}): {out}"))
}

/// M3 "no queued sale lost, none doubled" (plan T12). The sale was rung while the store ran on the cloud, the cloud APPLIED it and the
/// answer never reached the till, so the till still holds it queued. The switch copied the cloud's data (the idempotency rows with it);
/// after the switch the replayer sends the same key to the LOCAL server: it is answered as already applied, nothing is recorded again
/// and the stock does not move again. Own fixtures on both sides (a fresh pair holds its own open caja: the closed-caja lesson).
/// The first replay runs as `service_role`, the role the edge function uses (grants/RLS); the rest run as the superuser.
#[test]
fn queued_cloud_era_sale_replays_once_on_local() {
    let a = admin();
    sale_cleanup(LOCAL);
    sale_cleanup(CLOUD);
    let _undo = SaleUndo;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let (key_cash, key_split) = (format!("zz-t12-cash-{nanos}"), format!("zz-t12-split-{nanos}"));
    // 1. the cloud era: fixtures on the cloud, both sales applied there
    a.exec(
        CLOUD,
        &format!(
            "INSERT INTO auth.users (id, email, encrypted_password) VALUES ('{SALE_STAFF}', 'zz-sale@example.invalid', 'x'); \
             INSERT INTO public.profiles (id, name, role, pin) VALUES ('{SALE_STAFF}', 'zz sale cashier', 'cashier', '246810'); \
             INSERT INTO public.shifts (id, staff_id, opening_cash) VALUES ('{SALE_SHIFT}', '{SALE_STAFF}', 0); \
             INSERT INTO public.caja_sessions (id, opened_by, opening_cash, terminal_id) VALUES ('{SALE_CAJA}', '{SALE_STAFF}', 100, '{SALE_TERMINAL}'); \
             INSERT INTO public.categories (id, name) VALUES ('{SALE_CAT}', 'zz_t12_sale'); \
             INSERT INTO public.products (id, name, category_id, base_price) VALUES ('{SALE_PRODUCT}', 'zz t12 sale item', '{SALE_CAT}', 50.00); \
             INSERT INTO public.inventory (product_id, quantity_on_hand) VALUES ('{SALE_PRODUCT}', {SALE_START_STOCK})"
        ),
    )
    .unwrap();
    let cash = "p_method := 'cash', p_amount := 100, p_tendered_amount := 100";
    let legs = r#"p_legs := '[{"method":"cash","amount":60,"tenderedAmount":60},{"method":"card","amount":40,"referenceNumber":"AP-T12-1"}]'::jsonb, p_expected_total := 100"#;
    let first = replay(CLOUD, None, &key_cash, cash);
    assert_eq!(first["ok"], true, "the cloud applied the cash sale: {first}");
    let split = replay(CLOUD, None, &key_split, legs);
    assert_eq!(split["ok"], true, "the cloud applied the split sale: {split}");
    let cloud_stock = count_on(CLOUD, &format!("SELECT quantity_on_hand FROM public.inventory WHERE product_id = '{SALE_PRODUCT}'"));
    assert_eq!(cloud_stock, SALE_START_STOCK - 4, "the cloud took the stock for both sales");

    // 2. the switch copied the cloud's data: staff, shift, caja, catalog, stock AFTER the sales, and the sales with their payments
    let by_caja = format!("caja_session_id = '{SALE_CAJA}'");
    let by_tab = format!("tab_id IN (SELECT id FROM public.tabs WHERE {by_caja})");
    let by_order = format!("order_id IN (SELECT o.id FROM public.orders o JOIN public.tabs t ON t.id = o.tab_id WHERE t.{by_caja})");
    copy_where("auth", "users", &format!("id = '{SALE_STAFF}'"), true);
    copy_where("public", "profiles", &format!("id = '{SALE_STAFF}'"), true);
    copy_where("public", "shifts", &format!("id = '{SALE_SHIFT}'"), true);
    copy_where("public", "caja_sessions", &format!("id = '{SALE_CAJA}'"), true);
    copy_where("public", "categories", &format!("id = '{SALE_CAT}'"), true);
    copy_where("public", "products", &format!("id = '{SALE_PRODUCT}'"), true);
    copy_where("public", "inventory", &format!("product_id = '{SALE_PRODUCT}'"), true);
    copy_where("public", "stock_movements", &format!("product_id = '{SALE_PRODUCT}'"), true);
    copy_where("public", "tabs", &by_caja, true);
    copy_where("public", "orders", &by_tab, true);
    copy_where("public", "order_items", &by_order, true);
    copy_where("public", "payments", &by_tab, true);

    let stock = || count_on(LOCAL, &format!("SELECT quantity_on_hand FROM public.inventory WHERE product_id = '{SALE_PRODUCT}'"));
    let moves = || count_on(LOCAL, &format!("SELECT count(*) FROM public.stock_movements WHERE product_id = '{SALE_PRODUCT}' AND reason = 'sale'"));
    let sales = || count_on(LOCAL, &format!("SELECT count(*) FROM public.tabs WHERE {by_caja}"));
    let lines = || count_on(LOCAL, &format!("SELECT count(*) FROM public.order_items WHERE {by_order}"));
    let paid = |k: &str| count_on(LOCAL, &format!("SELECT count(*) FROM public.payments WHERE idempotency_key LIKE '{k}%'"));
    let before = (sales(), lines(), moves(), stock());
    assert_eq!(before, (2, 2, 2, SALE_START_STOCK - 4), "the control: the local server holds the cloud's two sales and its stock");

    // 3. the till replays the cash key on LOCAL, as service_role: answered as already applied, the cloud's sale, nothing recorded again
    let again = replay(LOCAL, Some("service_role"), &key_cash, cash);
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(again["idempotent"], true, "answered from the copied payment, not recorded again: {again}");
    assert_eq!(again["tabId"], first["tabId"], "the cloud's sale is answered");
    assert_eq!((sales(), lines(), moves(), stock()), before, "no second sale, line or stock movement; the stock did not move again");
    assert_eq!(paid(&key_cash), 1);
    // 4. the split key, replayed twice: still the cloud's two legs
    for _ in 0..2 {
        let again = replay(LOCAL, None, &key_split, legs);
        assert_eq!(again["idempotent"], true, "{again}");
        assert_eq!(again["tabId"], split["tabId"]);
        assert_eq!((sales(), lines(), moves(), stock(), paid(&key_split)), (before.0, before.1, before.2, before.3, 2));
    }
    // 5. the control: a DIFFERENT key is a new sale on the local server and only it moves the stock
    let other = replay(LOCAL, None, &format!("{key_cash}-b"), cash);
    assert_eq!(other["ok"], true, "{other}");
    assert_ne!(other["idempotent"], true, "{other}");
    assert_eq!((sales(), moves(), stock()), (3, 3, SALE_START_STOCK - 6), "the control: a new key is recorded and takes stock once");
}
