//! The hosted fence migration pair (20261025000001 + 20261025000002), exercised on the instance's `cloud_src` database
//! (never on dev2: dev2 is shared). Cargo feature `fence-db-tests`; run through tests/support/run-fence-db-tests.ps1, which
//! provisions the throwaway instance. With the feature on and POS_SWITCH_* missing the tests FAIL (never skip).
use crate::switch::facts::COVERED;
use crate::switch::testkit::{admin, var, Session, CLOUD};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const EXEMPT: [&str; 3] = ["store_switch_state", "till_sync_report", "pin_attempts"];
const PRODUCT: &str = "Haldiram''s Aloo Bhujia 200g";
const U1: &str = "11111111-1111-4111-8111-111111111111";
const U2: &str = "22222222-2222-4222-8222-222222222222";
const U3: &str = "33333333-3333-4333-8333-333333333333";

/// All tests share one state row: they take turns (the runner also passes --test-threads=1).
static SERIAL: Mutex<()> = Mutex::new(());
static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Holds the turn, and puts the state row, the report table and the marker rows back whatever a test did.
struct Fence {
    _turn: MutexGuard<'static, ()>,
}
fn fence() -> Fence {
    var("POS_SWITCH_PORT"); // fails loudly, with the instruction, when the instance variables are missing
    let turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    reset();
    ensure_checkout_fixture();
    Fence { _turn: turn }
}

/// The checkout writer needs an open caja session and an open shift. `cloud_src` is a copy of dev2's data taken when the instance is
/// built, and dev2 is a live shared database whose sessions open and close all day, so a copy may hold neither (the RPC then answers
/// CAJA_CLOSED before it writes anything). This makes sure both exist and changes nothing when they already do. It never depends on
/// what dev2 held.
fn ensure_checkout_fixture() {
    let admin_id = staff_admin();
    sql(&format!(
        "INSERT INTO public.caja_sessions (opened_by, opening_cash, notes) \
           SELECT '{admin_id}', 0, 'zz_fence_fixture' WHERE NOT EXISTS (SELECT 1 FROM public.caja_sessions WHERE status = 'open'); \
         INSERT INTO public.shifts (staff_id) \
           SELECT '{admin_id}' WHERE NOT EXISTS (SELECT 1 FROM public.shifts s JOIN public.profiles p ON p.id = s.staff_id \
             WHERE s.clock_out IS NULL AND p.is_active AND p.role IN ('cashier','manager','admin'))"
    ));
}
fn reset() {
    if std::env::var("POS_SWITCH_PORT").is_err() {
        return; // nothing to clean, and a panic inside Drop while unwinding would abort the whole run
    }
    let a = admin();
    let _ = a.exec(CLOUD, "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING; \
        UPDATE public.store_switch_state SET state = 'active', op_id = NULL, drain_since = NULL, until_at = NULL");
    let _ = a.exec(CLOUD, "DELETE FROM public.till_sync_report; DELETE FROM public.categories WHERE name LIKE 'zz_fence_%'");
    let _ = a.exec(CLOUD, "DROP TABLE IF EXISTS public.zz_fence_part CASCADE");
}
impl Drop for Fence {
    fn drop(&mut self) {
        reset();
    }
}

fn tag() -> String {
    format!(
        "{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    )
}
fn sql(q: &str) {
    admin().exec(CLOUD, q).unwrap();
}
fn one(q: &str) -> String {
    admin().scalar(CLOUD, q).unwrap()
}
fn set_state(state: &str, until: &str) {
    sql(&format!(
        "UPDATE public.store_switch_state SET state = '{state}', op_id = 't', until_at = {until}"
    ));
}
/// The test-only freeze form (the real one is Task 5's): a plain guarded UPDATE. The answer is the row count; anything but 1 is a refusal.
/// A missing row, an uncommitted heal row, an active row or another operation's row all give 0.
fn freeze_sql() -> String {
    "WITH f AS (UPDATE public.store_switch_state SET state = 'frozen', until_at = now() + interval '10 minutes'      WHERE id AND op_id = 't' AND state = 'draining' AND until_at > clock_timestamp() RETURNING 1) SELECT count(*) FROM f"
        .to_string()
}

fn guarded_tables() -> Vec<String> {
    one(&format!(
        "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE {COVERED}"
    ))
    .split(',')
    .map(str::to_string)
    .collect()
}

/// A statement-level trigger fires even when no row matches, so no fixture data is needed.
fn touch(table: &str) -> Result<(), String> {
    admin()
        .exec(CLOUD, &format!("DELETE FROM public.{table} WHERE false"))
        .map_err(|e| e.message)
}

// ---------------------------------------------------------------------------------------------------------------- roles

fn staff_admin() -> String {
    one("SELECT id FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1")
}
/// Statements that make the rest of the transaction run as a signed-in staff member or as the service role.
fn as_role(role: &str, sub: &str) -> String {
    format!(
        "SELECT set_config('request.jwt.claims', '{{\"sub\":\"{sub}\",\"role\":\"{role}\"}}', true); \
         SELECT set_config('request.jwt.claim.sub', '{sub}', true); SET LOCAL ROLE {role}"
    )
}
fn as_authenticated(sub: &str, body: &str) -> String {
    format!("BEGIN; {}; {body}; COMMIT", as_role("authenticated", sub))
}

/// The three real write paths a till has: a signed-in staff member writing a table through RLS, the service role writing
/// a table, and the service role running the checkout RPC (process_direct_sale_atomic is EXECUTE-granted to service_role
/// only, so the edge function is its only caller).
#[derive(Clone, Copy, Debug)]
enum Writer {
    AuthenticatedTable,
    ServiceTable,
    ServiceCheckout,
}
const WRITERS: [Writer; 3] = [
    Writer::AuthenticatedTable,
    Writer::ServiceTable,
    Writer::ServiceCheckout,
];

impl Writer {
    /// Opens a transaction and writes, without committing.
    fn open(self, tag: &str) -> String {
        match self {
            Writer::AuthenticatedTable => format!(
                "BEGIN; {}; INSERT INTO public.categories (name) VALUES ('zz_fence_{tag}')",
                as_role("authenticated", &staff_admin())
            ),
            Writer::ServiceTable => format!(
                "BEGIN; {}; INSERT INTO public.categories (name) VALUES ('zz_fence_{tag}')",
                as_role("service_role", &staff_admin())
            ),
            Writer::ServiceCheckout => format!(
                "BEGIN; {}; {}",
                as_role("service_role", &staff_admin()),
                checkout_sql(tag)
            ),
        }
    }
    /// How many rows of this writer's marker a fresh snapshot sees.
    fn visible(self, tag: &str) -> String {
        match self {
            Writer::ServiceCheckout => format!(
                "SELECT count(*) FROM public.payments WHERE idempotency_key = 'zz-fence-{tag}'"
            ),
            _ => format!("SELECT count(*) FROM public.categories WHERE name = 'zz_fence_{tag}'"),
        }
    }
}
/// One cash sale of one catalog product by the staff member who has an open shift, into the open caja session. The amount is the
/// server's own derived total (tax-inclusive: the price; otherwise price plus rounded tax).
fn checkout_sql(tag: &str) -> String {
    format!(
        "SELECT (public.process_direct_sale_atomic(\
           (SELECT s.staff_id FROM public.shifts s JOIN public.profiles p ON p.id = s.staff_id WHERE s.clock_out IS NULL AND p.is_active AND p.role IN ('cashier','manager','admin') ORDER BY s.id LIMIT 1), \
           (SELECT s.id FROM public.shifts s JOIN public.profiles p ON p.id = s.staff_id WHERE s.clock_out IS NULL AND p.is_active AND p.role IN ('cashier','manager','admin') ORDER BY s.id LIMIT 1), \
           (SELECT id FROM public.caja_sessions WHERE status = 'open' ORDER BY id LIMIT 1), \
           (SELECT jsonb_build_array(jsonb_build_object('product_id', id, 'quantity', 1, 'unit_price', base_price)) FROM public.products WHERE name = '{PRODUCT}'), \
           'zz-fence-{tag}', 'cash', \
           (SELECT CASE WHEN COALESCE((s.value->>'taxInclusive')::boolean, true) THEN p.base_price \
                   ELSE round(p.base_price + round(p.base_price * COALESCE((s.value->>'taxRatePercent')::numeric, 16) / 100, 2), 2) END \
            FROM public.products p LEFT JOIN public.settings s ON s.key = 'billing' WHERE p.name = '{PRODUCT}'), \
           1000))::text"
    )
}

// ------------------------------------------------------------------------------------------------------- base behaviour

#[test]
fn the_state_starts_active_and_anon_can_read_it_but_not_the_table() {
    let _f = fence();
    assert_eq!(
        one("SELECT state FROM public.store_switch_status"),
        "active"
    );
    assert_eq!(
        one("SET ROLE anon; SELECT state FROM public.store_switch_status")
            .lines()
            .last()
            .unwrap(),
        "active"
    );
    let e = admin()
        .exec(
            CLOUD,
            "SET ROLE anon; SELECT * FROM public.store_switch_state",
        )
        .unwrap_err()
        .message;
    assert!(e.contains("permission denied"), "{e}");
}

#[test]
fn a_frozen_cloud_refuses_every_guarded_table_and_keeps_the_exempt_ones_writable() {
    let _f = fence();
    set_state("frozen", "now() + interval '10 minutes'");
    let tables = guarded_tables();
    assert!(
        tables.len() >= 40,
        "found only {} guarded tables",
        tables.len()
    );
    for t in &tables {
        let e = touch(t).expect_err(&format!("{t} accepted a write while frozen"));
        assert!(e.contains("STORE_FROZEN"), "{t}: {e}");
    }
    for t in EXEMPT {
        touch(t).unwrap_or_else(|e| panic!("{t} must stay writable: {e}"));
    }
}

#[test]
fn every_statement_kind_is_guarded_including_truncate() {
    let _f = fence();
    set_state("frozen", "now() + interval '10 minutes'");
    for q in [
        "INSERT INTO public.categories (name) SELECT 'x' WHERE false",
        "UPDATE public.categories SET name = name WHERE false",
        "DELETE FROM public.categories WHERE false",
        "BEGIN; TRUNCATE public.rate_limits; ROLLBACK",
    ] {
        let e = admin().exec(CLOUD, q).expect_err(q).message;
        assert!(e.contains("STORE_FROZEN"), "{q}: {e}");
    }
}

#[test]
fn an_expired_freeze_is_the_dead_man_and_lets_writes_through() {
    let _f = fence();
    set_state("frozen", "now() - interval '1 second'");
    assert_eq!(
        one("SELECT state FROM public.store_switch_status"),
        "active"
    );
    touch("categories").unwrap();
    set_state("frozen", "NULL");
    touch("categories").expect("a frozen row without an expiry is expired");
    set_state("draining", "NULL");
    assert_eq!(
        one("SELECT (SELECT state FROM public.store_switch_effective_state())"),
        "active",
        "a draining row without an expiry is expired"
    );
}

#[test]
fn draining_with_a_past_expiry_reads_as_active() {
    let _f = fence();
    set_state("draining", "now() - interval '1 second'");
    assert_eq!(
        one("SELECT state FROM public.store_switch_status"),
        "active"
    );
    assert_eq!(
        one("SET ROLE anon; SELECT state FROM public.store_switch_status")
            .lines()
            .last()
            .unwrap(),
        "active"
    );
    touch("categories").unwrap();
}

#[test]
fn draining_still_allows_writes_so_the_tills_can_flush_their_queues() {
    let _f = fence();
    set_state("draining", "now() + interval '10 minutes'");
    assert_eq!(
        one("SELECT state FROM public.store_switch_status"),
        "draining"
    );
    touch("categories").unwrap();
}

#[test]
fn moved_is_permanent_and_ignores_the_expiry() {
    let _f = fence();
    set_state("moved", "now() - interval '1 day'");
    assert_eq!(one("SELECT state FROM public.store_switch_status"), "moved");
    let e = touch("categories").unwrap_err();
    assert!(e.contains("STORE_MOVED"), "{e}");
}

/// The coverage query Task 6's detection must reuse: every ordinary or partitioned public table outside the exempt set that has no enabled guard trigger.
fn unguarded_tables() -> String {
    one(&format!(
        "SELECT COALESCE(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace          WHERE {COVERED} AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'store_fence_guard' AND t.tgenabled = 'O')"
    ))
}

#[test]
fn every_non_exempt_public_table_has_an_enabled_guard_trigger() {
    let _f = fence();
    assert_eq!(unguarded_tables(), "");
}

#[test]
fn an_unguarded_partitioned_table_is_reported_by_the_coverage_query() {
    let _f = fence(); // reset() drops the throwaway table, also when an assertion below panics
    sql("CREATE TABLE public.zz_fence_part (id int, k int) PARTITION BY LIST (k);          CREATE TABLE public.zz_fence_part_1 PARTITION OF public.zz_fence_part FOR VALUES IN (1)");
    assert_eq!(unguarded_tables(), "zz_fence_part,zz_fence_part_1");
}

#[test]
fn the_guard_function_catalog_properties_are_pinned() {
    let _f = fence();
    let f = "public.store_fence_guard()";
    assert_eq!(
        one(&format!(
            "SELECT prosecdef FROM pg_proc WHERE oid = '{f}'::regprocedure"
        )),
        "t"
    );
    assert_eq!(
        one(&format!(
            "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = '{f}'::regprocedure"
        )),
        "search_path=pg_catalog, public, pg_temp"
    );
    assert_eq!(
        one(&format!(
            "SELECT p.proowner = c.relowner FROM pg_proc p, pg_class c WHERE p.oid = '{f}'::regprocedure AND c.oid = 'public.store_switch_state'::regclass"
        )),
        "t"
    );
    // aclexplode grantee 0 is PUBLIC; a NULL proacl is the default ACL, which grants PUBLIC execute.
    assert_eq!(
        one(&format!(
            "SELECT NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a              WHERE p.oid = '{f}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')"
        )),
        "t"
    );
}

// ------------------------------------------------------------------------------------------------------ heal

#[test]
fn a_missing_state_row_is_healed_as_active_by_the_first_guarded_write() {
    let _f = fence();
    sql("DELETE FROM public.store_switch_state");
    assert_eq!(
        one("SELECT state FROM public.store_switch_status"),
        "active",
        "the view must say active with no row"
    );
    touch("categories").unwrap();
    assert_eq!(
        one("SELECT state || '|' || coalesce(op_id, '~') || '|' || coalesce(until_at::text, '~') || '|' || coalesce(drain_since::text, '~') FROM public.store_switch_state"),
        "active|~|~|~",
        "the heal may only ever create the default row"
    );
}

#[test]
fn two_first_writers_race_to_heal_a_deleted_row_and_both_commit() {
    let _f = fence();
    sql("DELETE FROM public.store_switch_state");
    let (t1, t2) = (tag(), tag());
    let mut w1 = Session::open(CLOUD);
    let mut w2 = Session::open(CLOUD);
    w1.run(&Writer::AuthenticatedTable.open(&t1))
        .expect("first writer");
    w2.post(&Writer::AuthenticatedTable.open(&t2));
    assert!(
        w2.collect(Duration::from_millis(1500)).is_none(),
        "the second healer must wait for the first one's uncommitted heal row"
    );
    w1.run("COMMIT").expect("first commit");
    w2.collect(Duration::from_secs(15))
        .expect("second writer still blocked")
        .expect("second writer");
    w2.run("COMMIT").expect("second commit");
    assert_eq!(one(&Writer::AuthenticatedTable.visible(&t1)), "1");
    assert_eq!(one(&Writer::AuthenticatedTable.visible(&t2)), "1");
    assert_eq!(
        one("SELECT count(*) || '|' || min(state) FROM public.store_switch_state"),
        "1|active"
    );
    // the store can still be drained and frozen after the heal; an active store is not frozen by the upsert
    assert_eq!(
        one(&freeze_sql()),
        "0",
        "freeze must refuse an active store"
    );
    set_state("draining", "now() + interval '10 minutes'");
    assert_eq!(one(&freeze_sql()), "1");
}

#[test]
fn a_freeze_on_a_truly_missing_row_is_refused_and_creates_nothing() {
    let _f = fence();
    sql("DELETE FROM public.store_switch_state");
    assert_eq!(one(&freeze_sql()), "0", "no row, nothing to freeze");
    assert_eq!(
        one("SELECT count(*) FROM public.store_switch_state"),
        "0",
        "a refused freeze must not leave a (frozen) row behind"
    );
}

#[test]
fn a_freeze_past_an_uncommitted_heal_insert_is_refused_and_the_state_stays_active() {
    let _f = fence();
    sql("DELETE FROM public.store_switch_state");
    let t = tag();
    let mut w = Session::open(CLOUD);
    w.run(&Writer::AuthenticatedTable.open(&t))
        .expect("healing writer");
    // the heal row is not committed, so the freeze cannot see it: 0 rows, a refusal (the caller aborts the run)
    assert_eq!(
        one(&freeze_sql()),
        "0",
        "the freeze must not report success past an uncommitted heal"
    );
    w.run("COMMIT").expect("commit");
    assert_eq!(one("SELECT state FROM public.store_switch_state"), "active");
    assert_eq!(one(&Writer::AuthenticatedTable.visible(&t)), "1");
}

// -------------------------------------------------------------------------------------------------------- barrier

/// The checkout tests need an open caja session and an open shift. `cloud_src` is a copy of dev2's data taken when the instance is
/// built, and dev2 is a live shared database whose caja sessions open and close all day: a copy can hold none. The fixture must make
/// its own, whatever the copy holds.
#[test]
fn the_checkout_fixture_does_not_depend_on_dev2_having_an_open_caja_or_shift() {
    let _f = fence();
    // the app's own version-guard triggers refuse a hand edit (STALE_VERSION): this simulates dev2 holding none, so bypass them here
    sql("SET LOCAL session_replication_role = replica; UPDATE public.caja_sessions SET status = 'closed', closed_at = now(), closed_by = opened_by WHERE status = 'open'; \
         UPDATE public.shifts SET clock_out = now() + interval '1 second' WHERE clock_out IS NULL");
    assert_eq!(
        one("SELECT count(*) FROM public.caja_sessions WHERE status = 'open'"),
        "0",
        "the control: no open caja"
    );
    ensure_checkout_fixture();
    assert_eq!(
        one("SELECT count(*) FROM public.caja_sessions WHERE status = 'open'"),
        "1"
    );
    assert!(
        one("SELECT count(*) FROM public.shifts WHERE clock_out IS NULL")
            .parse::<u32>()
            .unwrap()
            >= 1
    );
    let t = tag();
    let mut w = Session::open(CLOUD);
    let answer = w.run(&Writer::ServiceCheckout.open(&t)).expect("checkout");
    assert!(
        answer.contains("\"ok\": true"),
        "the sale was not accepted: {answer}"
    );
    w.run("ROLLBACK").ok();
    // asking again changes nothing
    ensure_checkout_fixture();
    assert_eq!(
        one("SELECT count(*) FROM public.caja_sessions WHERE status = 'open'"),
        "1"
    );
}

#[test]
fn the_freeze_waits_for_every_write_already_past_the_guard_and_a_post_freeze_snapshot_sees_it() {
    for writer in WRITERS {
        let _f = fence();
        let t = tag();
        set_state("draining", "now() + interval '10 minutes'");
        let mut w = Session::open(CLOUD);
        let mut z = Session::open(CLOUD);
        let opened = w
            .run(&writer.open(&t))
            .unwrap_or_else(|e| panic!("{writer:?}: write while draining refused: {e}"));
        if let Writer::ServiceCheckout = writer {
            assert!(
                opened.contains("\"ok\": true"),
                "{writer:?}: the sale was not accepted: {opened}"
            );
        }
        let app = format!("fence_freeze_{t}");
        z.run(&format!("SET application_name = '{app}'")).unwrap();
        z.post(&freeze_sql());
        assert!(
            z.collect(Duration::from_millis(1500)).is_none(),
            "{writer:?}: the freeze did not wait for an in-flight writer"
        );
        assert_eq!(
            one(&format!("SELECT coalesce(wait_event_type, '~') FROM pg_stat_activity WHERE application_name = '{app}' AND state = 'active'")),
            "Lock",
            "{writer:?}: the freeze is not waiting on a lock"
        );
        w.run("COMMIT")
            .unwrap_or_else(|e| panic!("{writer:?}: commit: {e}"));
        let rows = z
            .collect(Duration::from_secs(15))
            .unwrap_or_else(|| panic!("{writer:?}: freeze still blocked after the commit"))
            .unwrap();
        assert_eq!(rows, "1", "{writer:?}");
        assert_eq!(
            one(&writer.visible(&t)),
            "1",
            "{writer:?}: the write committed before the freeze is not visible to a post-freeze snapshot"
        );
        // and from now on the same path is refused
        // the checkout RPC reports a refused write as {ok:false, message:'STORE_FROZEN: ...'} instead of raising
        let late = match w.run(&writer.open(&tag())) {
            Ok(answer) => answer,
            Err(e) => e,
        };
        assert!(
            late.contains("STORE_FROZEN") && !late.contains("\"ok\": true"),
            "{writer:?}: {late}"
        );
        w.run("ROLLBACK").ok();
    }
}

#[test]
fn a_snapshot_taken_before_the_freeze_cannot_write_after_it() {
    for iso in ["REPEATABLE READ", "SERIALIZABLE"] {
        let _f = fence();
        let t = tag();
        set_state("draining", "now() + interval '10 minutes'");
        let mut w = Session::open(CLOUD);
        w.run(&format!(
            "BEGIN ISOLATION LEVEL {iso}; SELECT count(*) FROM public.store_switch_state"
        ))
        .unwrap();
        assert_eq!(
            one(&freeze_sql()),
            "1",
            "{iso}: nothing holds the row, the freeze must go through"
        );
        let e = w
            .run(&Writer::AuthenticatedTable.open(&t))
            .expect_err("a first write on a pre-freeze snapshot");
        assert!(e.contains("could not serialize access"), "{iso}: {e}");
        w.run("ROLLBACK").ok();
        assert_eq!(
            one(&Writer::AuthenticatedTable.visible(&t)),
            "0",
            "{iso}: the marker row must be absent"
        );
    }
}

#[test]
fn anon_has_no_write_path_while_draining_and_is_fenced_while_frozen() {
    let _f = fence();
    set_state("draining", "now() + interval '10 minutes'");
    let e = admin()
        .exec(
            CLOUD,
            "SET ROLE anon; INSERT INTO public.categories (name) VALUES ('zz_fence_anon')",
        )
        .unwrap_err()
        .message;
    assert!(
        e.contains("row-level security"),
        "anon is stopped by RLS, not by the fence: {e}"
    );
    set_state("frozen", "now() + interval '10 minutes'");
    let e = admin()
        .exec(
            CLOUD,
            "SET ROLE anon; INSERT INTO public.categories (name) VALUES ('zz_fence_anon')",
        )
        .unwrap_err()
        .message;
    assert!(e.contains("STORE_FROZEN"), "{e}");
    assert_eq!(
        one("SELECT count(*) FROM public.categories WHERE name = 'zz_fence_anon'"),
        "0"
    );
}

// --------------------------------------------------------------------------------------------------------- privileges

fn assert_denied(role: &str, q: &str) {
    let e = admin()
        .exec(CLOUD, &format!("SET ROLE {role}; {q}"))
        .expect_err(&format!("{role} must be denied: {q}"))
        .message;
    assert!(e.contains("permission denied"), "{role}: {q}: {e}");
}
fn assert_allowed(role: &str, q: &str) {
    admin()
        .exec(CLOUD, &format!("SET ROLE {role}; {q}"))
        .unwrap_or_else(|e| panic!("{role} must be allowed: {q}: {}", e.message));
}

#[test]
fn service_role_cannot_touch_the_state_table_and_only_reads_and_deletes_the_till_reports() {
    let _f = fence();
    for q in [
        "SELECT * FROM public.store_switch_state",
        "UPDATE public.store_switch_state SET state = 'frozen'",
        "DELETE FROM public.store_switch_state",
        "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, seen_state) VALUES ('x', 'POS-1', 0, 'active')",
        "UPDATE public.till_sync_report SET queue_depth = 0",
    ] {
        assert_denied("service_role", q);
    }
    assert_allowed(
        "service_role",
        "SELECT count(*) FROM public.till_sync_report",
    );
    assert_allowed(
        "service_role",
        "DELETE FROM public.till_sync_report WHERE false",
    );
    assert_allowed(
        "service_role",
        "SELECT state FROM public.store_switch_status",
    );
}

/// The privilege matrix, read from the catalog: a non-updatable view answers "cannot insert into view" before it looks at grants,
/// so refusing a statement proves nothing about the grant.
fn has(role: &str, object: &str, privilege: &str) -> bool {
    one(&format!(
        "SELECT has_table_privilege('{role}', '{object}', '{privilege}')"
    )) == "t"
}
const ALL_PRIVS: [&str; 7] = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
];

#[test]
fn the_privilege_matrix_of_the_view_and_both_tables() {
    let _f = fence();
    for role in ["anon", "authenticated", "service_role"] {
        for p in ALL_PRIVS {
            assert!(
                !has(role, "public.store_switch_state", p),
                "{role} has {p} on store_switch_state"
            );
            let want_report = role == "service_role" && (p == "SELECT" || p == "DELETE");
            assert_eq!(
                has(role, "public.till_sync_report", p),
                want_report,
                "{role} {p} on till_sync_report"
            );
            let want_view = p == "SELECT";
            assert_eq!(
                has(role, "public.store_switch_status", p),
                want_view,
                "{role} {p} on store_switch_status"
            );
        }
    }
}

#[test]
fn anon_and_authenticated_cannot_write_the_view_or_the_tables_and_a_signed_in_till_reads_the_view()
{
    let _f = fence();
    for role in ["anon", "authenticated"] {
        for q in [
            "SELECT * FROM public.store_switch_state",
            "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING",
            "UPDATE public.store_switch_state SET state = 'frozen'",
            "DELETE FROM public.store_switch_state",
            "SELECT * FROM public.till_sync_report",
            "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, seen_state) VALUES ('x', 'POS-1', 0, 'active')",
            "DELETE FROM public.till_sync_report",
        ] {
            assert_denied(role, q);
        }
        for q in [
            "INSERT INTO public.store_switch_status (state) VALUES ('frozen')",
            "UPDATE public.store_switch_status SET state = 'frozen'",
            "DELETE FROM public.store_switch_status",
        ] {
            admin()
                .exec(CLOUD, &format!("SET ROLE {role}; {q}"))
                .expect_err(&format!("{role} wrote the view: {q}"));
        }
    }
    assert_eq!(
        one("SET ROLE authenticated; SELECT state FROM public.store_switch_status")
            .lines()
            .last()
            .unwrap(),
        "active",
        "a signed-in till reads the state through the view"
    );
}

// ------------------------------------------------------------------------------------------------- report_till_sync

fn report(
    uuid: &str,
    label: &str,
    depth: i32,
    seen: &str,
    version: &str,
    sub: &str,
) -> Result<String, String> {
    admin()
        .scalar(
            CLOUD,
            &as_authenticated(sub, &format!("SELECT public.report_till_sync('{uuid}', '{label}', {depth}, 1, '{seen}', {version})")),
        )
        .map_err(|e| e.message)
}

#[test]
fn report_till_sync_needs_a_signed_in_caller_and_a_second_report_overwrites_the_first() {
    let _f = fence();
    let first = report(U1, "POS-9", 2, "draining", "'1.0.0'", U2).unwrap();
    assert_eq!(
        first.lines().last().unwrap(),
        "active",
        "the answer is the effective state"
    );
    let state = |what: &str| {
        one(&format!(
            "SELECT {what} FROM public.till_sync_report WHERE terminal_uuid = '{U1}'"
        ))
    };
    assert_eq!(state("count(*) || '|' || max(queue_depth) || '|' || max(seen_state) || '|' || max(terminal_label)"), "1|2|draining|POS-9");
    // a second call with a DIFFERENT state, depth, label and caller updates the same row
    report(U1, "POS-8", 0, "frozen", "'1.0.1'", U1).unwrap();
    assert_eq!(
        state("count(*) || '|' || max(queue_depth) || '|' || max(seen_state) || '|' || max(terminal_label) || '|' || max(app_version) || '|' || max(reported_by::text)"),
        format!("1|0|frozen|POS-8|1.0.1|{U1}")
    );
    let anon = admin()
        .exec(CLOUD, &format!("SET ROLE anon; SELECT public.report_till_sync('{U2}', 'POS-9', 0, 0, 'active', '1')"))
        .unwrap_err()
        .message;
    assert!(anon.contains("permission denied"), "{anon}");
    let no_user = admin()
        .exec(CLOUD, &format!("BEGIN; SET LOCAL ROLE authenticated; SELECT public.report_till_sync('{U2}', 'POS-9', 0, 0, 'active', '1'); COMMIT"))
        .unwrap_err()
        .message;
    assert!(no_user.contains("AUTH_REQUIRED"), "{no_user}");
}

#[test]
fn report_till_sync_records_the_caller_as_reported_by() {
    let _f = fence();
    report(U1, "POS-9", 0, "active", "NULL", U2).unwrap();
    assert_eq!(
        one(&format!(
            "SELECT reported_by::text FROM public.till_sync_report WHERE terminal_uuid = '{U1}'"
        )),
        U2
    );
}

#[test]
fn report_till_sync_refuses_anything_but_a_uuid_terminal_and_a_plain_label_and_version() {
    let _f = fence();
    let bad = |uuid: &str, label: &str, version: &str| {
        let e = report(uuid, label, 0, "active", version, U2)
            .expect_err(&format!("accepted {uuid} {label} {version}"));
        assert!(
            e.contains("VALIDATION_ERROR"),
            "{uuid} {label} {version}: {e}"
        );
    };
    bad("zz-test-0001", "POS-9", "'1'");
    bad(&format!("{U1}x"), "POS-9", "'1'");
    bad("11111111-1111-4111-8111-11111111111", "POS-9", "'1'");
    bad("11111111111141118111111111111111", "POS-9", "'1'");
    bad(U1, "bad label", "'1'");
    bad(U1, "POS-9", "'1 2'");
    bad(U1, "POS-9", "'1;x'");
    bad(U1, "POS-9", "''");
    bad(U1, "POS-9", &format!("'{}'", "1".repeat(33)));
    // a trailing newline, and leading or trailing spaces, are not a UUID
    bad(&format!("{U1}\n"), "POS-9", "'1'");
    bad(&format!(" {U1}"), "POS-9", "'1'");
    bad(&format!("{U1} "), "POS-9", "'1'");
    // accepted: an upper-case UUID, the longest version, a typical build string, and no version at all
    report(
        &U1.replace('1', "A"),
        "POS-9",
        0,
        "active",
        &format!("'{}'", "1".repeat(32)),
        U2,
    )
    .unwrap();
    report(U2, "POS-9", 0, "active", "'1.2.3-rc.1+build_5'", U2).unwrap();
    report(U3, "POS-9", 0, "active", "NULL", U2).unwrap();
}

#[test]
fn report_till_sync_keys_a_terminal_by_its_lower_case_uuid() {
    let _f = fence();
    let upper = U1.replace('1', "A");
    report(&upper, "POS-9", 1, "active", "NULL", U2).unwrap();
    report(&upper.to_lowercase(), "POS-9", 2, "active", "NULL", U2).unwrap();
    assert_eq!(
        one("SELECT count(*) || '|' || max(terminal_uuid) || '|' || max(queue_depth) FROM public.till_sync_report"),
        format!("1|{}|2", upper.to_lowercase()),
        "upper- and lower-case forms of one UUID must be ONE row, stored lower-case"
    );
}

#[test]
fn report_till_sync_stops_accepting_new_terminals_at_200_rows_but_still_updates_a_known_one() {
    let _f = fence();
    sql(&format!(
        "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, seen_state, reported_by)          SELECT CASE WHEN g = 1 THEN '{U3}' ELSE gen_random_uuid()::text END, 'cap', 0, 'active', gen_random_uuid()          FROM generate_series(1, 200) g"
    ));
    assert_eq!(one("SELECT count(*) FROM public.till_sync_report"), "200");
    let e = report(U1, "POS-9", 0, "active", "NULL", U2).expect_err("the 201st terminal");
    assert!(
        e.contains("VALIDATION_ERROR") && e.contains("too many"),
        "{e}"
    );
    report(U3, "POS-9", 5, "draining", "NULL", U2)
        .expect("a known terminal still reports at the cap");
    assert_eq!(
        one(&format!("SELECT queue_depth || '|' || seen_state FROM public.till_sync_report WHERE terminal_uuid = '{U3}'")),
        "5|draining"
    );
    assert_eq!(one("SELECT count(*) FROM public.till_sync_report"), "200");
}

#[test]
fn release_held_frees_only_this_operations_draining_or_frozen_row() {
    let _f = fence();
    set_state("frozen", "now() + interval '10 minutes'"); // op_id 't'
    let released = |op: &str| one(&crate::switch::cloud::sql_release_held(op).unwrap());
    assert_eq!(released("another-op"), "0");
    assert_eq!(
        one("SELECT state FROM public.store_switch_state"),
        "frozen",
        "another operation's hold survives"
    );
    set_state("moved", "NULL");
    assert_eq!(
        released("t"),
        "0",
        "a moved row is never released by the scoped release"
    );
    assert_eq!(one("SELECT state FROM public.store_switch_state"), "moved");
    // our own draining row and our own expired frozen row are freed too
    set_state("draining", "now() + interval '10 minutes'");
    assert_eq!(released("t"), "1");
    set_state("frozen", "now() - interval '1 minute'");
    assert_eq!(released("t"), "1", "an expired hold is still ours to free");
    set_state("frozen", "now() + interval '10 minutes'");
    assert_eq!(released("t"), "1");
    assert_eq!(
        one("SELECT state || '|' || coalesce(op_id, '') FROM public.store_switch_state"),
        "active|"
    );
}
