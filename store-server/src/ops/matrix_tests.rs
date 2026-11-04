use crate::ops::fake::*;
use crate::ops::journal::Journal;
use crate::ops::names::{DbNames, NEXT};
use crate::ops::outcome::{OpCode, OpKind};
use crate::ops::recover::{ctx_from_journal, recover, Recovered};
use crate::ops::runner::{run_operation, Outcome};
use crate::ops::world::{OpCtx, R};
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

fn ctx(budget_ms: u64) -> OpCtx {
    OpCtx {
        op_id: "op".into(), names: DbNames::for_kind(OpKind::Update, T0),
        pack_from: Some("old".into()), pack_to: Some("new".into()), deadline_ms: T0 + budget_ms,
    }
}
fn journal(budget_ms: u64) -> Journal {
    Journal::new(OpKind::Update, "op", T0, T0 + budget_ms, Some("old".into()), Some("new".into()))
}
fn run_with(s: &Shared, budget_ms: u64) -> R<Outcome> {
    let mut w = FakeWorld(s.clone());
    let mut work = FakeWork(s.clone());
    run_operation(&mut w, &mut work, &ctx(budget_ms), journal(budget_ms))
}
fn run(s: &Shared) -> R<Outcome> { run_with(s, 900_000) }

fn recover_state(s: &Shared) -> R<Recovered> {
    let j = s.borrow().journal.clone();
    let Some(mut j) = j else { return Ok(Recovered::Nothing) };
    let (mut w, mut work) = (FakeWorld(s.clone()), FakeWork(s.clone()));
    recover(&mut w, &mut work, &ctx_from_journal(&j), &mut j)
}

/// An independent copy of the world (a dry run of recovery must not disturb the real one).
fn fork(s: &Shared) -> Shared { Rc::new(RefCell::new(s.borrow().clone())) }

/// The injected crash and nothing else: any other panic is a bug in the code under test, and fails the test.
fn crashed<T>(s: &Shared, k: usize, what: &str, f: impl FnOnce() -> T) {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => panic!("{what}: k={k} did not crash"),
        Err(p) => {
            let msg = p.downcast_ref::<&str>().map(|m| m.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
            assert_eq!(msg.as_deref(), Some("CRASH"), "{what}: k={k} panicked with something other than the injected crash");
            assert_eq!(s.borrow().calls, k, "{what}: k={k} crashed at the wrong call");
        }
    }
}

fn swap_seen(s: &Shared) -> bool { s.borrow().dbs.keys().any(|n| n.starts_with("pos_prev_") || n.starts_with("pos_failed_")) }
fn prev_seen(s: &Shared) -> bool { s.borrow().dbs.keys().any(|n| n.starts_with("pos_prev_")) }

/// `level`: the schema level the live database must end on. `swapped`: a swap (or swap back) happened at some point,
/// so exactly one of pos_prev_* (new level) or pos_failed_* (old level) must remain, and nothing else.
fn assert_consistent(s: &Shared, label: &str, level: &str, swapped: bool) {
    let st = s.borrow();
    assert!(st.violations.is_empty(), "{label}: {:?}", st.violations);
    assert!(st.dbs.contains_key("postgres"), "{label}: the live database is missing");
    assert_eq!(st.gateway, Gw::Live, "{label}: gateway");
    assert!(st.roles_login && st.stack_up && !st.recovery_suspended, "{label}: fence not lifted");
    assert!(st.journal.is_none(), "{label}: journal left behind");
    assert!(!st.dbs.contains_key(NEXT), "{label}: clone left behind");
    assert_eq!(st.dbs["postgres"], level, "{label}: live level");
    assert_eq!((st.pack, st.pack_current), (st.dbs["postgres"], st.dbs["postgres"]), "{label}: pack/pointer");
    let prev = st.dbs.keys().filter(|n| n.starts_with("pos_prev_")).count();
    let failed = st.dbs.keys().filter(|n| n.starts_with("pos_failed_")).count();
    match (level, swapped) {
        ("new", _) => assert_eq!((prev, failed), (1, 0), "{label}: a new level keeps exactly the previous database"),
        ("old", true) => assert_eq!((prev, failed), (0, 1), "{label}: a rolled-back swap keeps exactly the failed database"),
        _ => assert_eq!((prev, failed), (0, 0), "{label}: nothing was swapped, nothing may remain"),
    }
    assert_eq!(st.dbs.len(), 1 + prev + failed, "{label}: stray databases {:?}", st.dbs.keys().collect::<Vec<_>>());
    // every sale the till accepted is in the live database; none went into a database that was discarded
    assert_eq!(st.rows.get("postgres").copied().unwrap_or(0), st.accepted, "{label}: accepted sales vs rows in the live database ({:?})", st.rows);
}

fn assert_recovered(r: &Recovered, level: &str, had_journal: bool, label: &str) {
    match (r, level, had_journal) {
        (Recovered::Nothing, "old", false) => {}
        (Recovered::RolledForward, "new", true) => {}
        (Recovered::RolledBack { .. }, "old", true) => {}
        other => panic!("{label}: unexpected recovery result {other:?}"),
    }
}

/// Number of World/OpWork calls of one uninterrupted run.
fn calls_of_a_run(fail_verify: bool) -> usize {
    let s = fresh();
    s.borrow_mut().fail_verify_live = fail_verify;
    let _ = run(&s);
    let n = s.borrow().calls;
    n
}

fn setup(fail_verify: bool, k: usize) -> Shared {
    let s = fresh();
    s.borrow_mut().fail_verify_live = fail_verify;
    s.borrow_mut().crash_at = Some(k);
    s
}

/// Crash at every call; optionally the machine restarts before recovery runs.
fn kill_matrix(fail_verify: bool, reboot_first: bool) -> usize {
    let total = calls_of_a_run(fail_verify);
    for k in 1..=total {
        let s = setup(fail_verify, k);
        crashed(&s, k, "run", || run(&s));
        let swapped = swap_seen(&s);
        let had_journal = s.borrow().journal.is_some();
        s.borrow_mut().crash_at = None;
        if reboot_first { reboot(&s); }
        let level = if fail_verify { "old" } else if prev_seen(&s) { "new" } else { "old" };
        let label = format!("crash k={k} fail_verify={fail_verify} reboot={reboot_first}");
        let r = recover_state(&s).unwrap_or_else(|e| panic!("{label}: recovery failed: {e}"));
        assert_recovered(&r, level, had_journal, &label);
        assert_consistent(&s, &label, level, swapped);
    }
    total
}

/// A second crash at every call of the recovery that follows a crash at every call of the run.
fn double_fault_matrix(fail_verify: bool, reboot_first: bool) -> usize {
    let total = calls_of_a_run(fail_verify);
    let mut runs = 0;
    for k0 in 1..=total {
        let base_world = setup(fail_verify, k0);
        crashed(&base_world, k0, "run", || run(&base_world));
        base_world.borrow_mut().crash_at = None;
        if reboot_first { reboot(&base_world); }
        // dry run: how many calls does this recovery make?
        let dry = fork(&base_world);
        let before = dry.borrow().calls;
        let _ = recover_state(&dry);
        let len = dry.borrow().calls - before;
        for k2 in 1..=len {
            let s = fork(&base_world);
            let base = s.borrow().calls;
            let swapped = swap_seen(&s);
            let had_journal = s.borrow().journal.is_some();
            s.borrow_mut().crash_at = Some(base + k2);
            crashed(&s, base + k2, "recovery", || recover_state(&s));
            s.borrow_mut().crash_at = None;
            if reboot_first { reboot(&s); }
            let level = if fail_verify { "old" } else if prev_seen(&s) || swapped { "new" } else { "old" };
            let label = format!("double fault k0={k0} k2={k2} fail_verify={fail_verify} reboot={reboot_first}");
            let r = recover_state(&s).unwrap_or_else(|e| panic!("{label}: {e}"));
            // the first recovery may already have finished the work, so only the end state is asserted here
            let _ = (&r, had_journal);
            assert_consistent(&s, &label, level, swapped);
            runs += 1;
        }
    }
    runs
}

#[test]
fn a_clean_run_ends_on_the_new_level_with_the_old_database_kept() {
    let s = fresh();
    let out = run(&s).unwrap();
    assert_consistent(&s, "clean", "new", true);
    assert!(s.borrow().dbs.contains_key(&out.prev_db));
}

#[test]
fn the_exact_number_of_calls_per_path_is_pinned() {
    // Deleting a step (or adding one) must be a conscious change: the matrix covers every one of these points.
    assert_eq!(calls_of_a_run(false), 37, "happy path");
    assert_eq!(calls_of_a_run(true), 40, "verification fails, swap back");
}

#[test]
fn crash_at_every_call_recovers_to_a_consistent_store() {
    assert_eq!(kill_matrix(false, false), 37);
}

#[test]
fn crash_at_every_call_then_a_reboot_recovers_to_a_consistent_store() {
    assert_eq!(kill_matrix(false, true), 37);
}

#[test]
fn crash_anywhere_with_a_failing_verification_still_ends_on_the_old_level() {
    assert_eq!(kill_matrix(true, false), 40);
}

#[test]
fn crash_anywhere_with_a_failing_verification_then_a_reboot_still_ends_on_the_old_level() {
    assert_eq!(kill_matrix(true, true), 40);
}

#[test]
fn a_crash_during_recovery_is_recovered_again_at_every_call() {
    let runs = double_fault_matrix(false, false);
    assert!(runs > 300, "double-fault matrix too small: {runs}");
}

#[test]
fn a_crash_during_recovery_after_a_reboot_is_recovered_again_at_every_call() {
    let runs = double_fault_matrix(false, true);
    assert!(runs > 300, "double-fault matrix too small: {runs}");
}

#[test]
fn a_crash_during_the_recovery_of_a_failing_verification_is_recovered_again() {
    let runs = double_fault_matrix(true, true);
    assert!(runs > 300, "double-fault matrix too small: {runs}");
}

#[test]
fn the_sales_model_catches_a_fence_that_leaks() {
    let s = fresh();
    s.borrow_mut().fence_leaks = true;
    let _ = run(&s);
    let st = s.borrow();
    assert!(st.violations.iter().any(|v| v.contains("sale accepted")), "a leaking fence must be reported: {:?}", st.violations);
}

#[test]
fn failed_verification_swaps_back_and_keeps_the_failed_database() {
    let s = fresh();
    s.borrow_mut().fail_verify_live = true;
    let e = run(&s).unwrap_err();
    assert_eq!(e.code, OpCode::VerifyFailedRolledBack);
    assert_consistent(&s, "verify failed", "old", true);
}

/// A restore builds `pos_next` itself in `work_on_clone`; the runner must not template a full copy first.
struct NoCloneWork(FakeWork);
impl crate::ops::world::OpWork for NoCloneWork {
    fn kind(&self) -> OpKind { self.0.kind() }
    fn backup_reason(&self) -> crate::ops::world::BackupReason { self.0.backup_reason() }
    fn needs_clone(&self) -> bool { false }
    fn work_on_clone(&mut self, c: &OpCtx) -> R<()> { self.0.work_on_clone(c) }
    fn verify_clone(&mut self, c: &OpCtx) -> R<()> { self.0.verify_clone(c) }
    fn verify_live(&mut self, c: &OpCtx) -> R<()> { self.0.verify_live(c) }
    fn verify_after_rollback(&mut self, c: &OpCtx) -> R<()> { self.0.verify_after_rollback(c) }
    fn on_commit(&mut self, c: &OpCtx) -> R<()> { self.0.on_commit(c) }
}
fn run_no_clone(s: &Shared) -> R<Outcome> {
    let mut w = FakeWorld(s.clone());
    let mut work = NoCloneWork(FakeWork(s.clone()));
    run_operation(&mut w, &mut work, &ctx(900_000), journal(900_000))
}

#[test]
fn an_operation_that_builds_its_own_next_database_skips_the_template_copy() {
    let s = fresh();
    run_no_clone(&s).unwrap();
    assert!(!s.borrow().trace.contains(&"clone"), "no template copy: {:?}", s.borrow().trace);
}

#[test]
fn a_rollback_without_a_clone_still_restores_the_live_database() {
    let s = fresh();
    s.borrow_mut().fail_verify_live = true;
    let e = run_no_clone(&s).unwrap_err();
    assert_eq!(e.code, OpCode::VerifyFailedRolledBack);
    assert!(!s.borrow().trace.contains(&"clone"));
    assert_consistent(&s, "no-clone rollback", "old", true);
}

#[test]
fn migration_failure_drops_the_clone_and_exits_14() {
    let s = fresh();
    s.borrow_mut().fail_work = true;
    let e = run(&s).unwrap_err();
    assert_eq!(e.code, OpCode::MigrationFailed);
    assert_consistent(&s, "migration failed", "old", false);
    assert_eq!(s.borrow().dbs.len(), 1, "no clone, no failed db");
}

#[test]
fn a_failed_backup_aborts_before_any_change() {
    let s = fresh();
    s.borrow_mut().fail_backup = true;
    let e = run(&s).unwrap_err();
    assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED"));
    assert_consistent(&s, "backup failed", "old", false);
}

#[test]
fn an_exhausted_budget_rolls_back() {
    let s = fresh();
    let e = run_with(&s, 4_000).unwrap_err();
    assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "MAINTENANCE_BUDGET"));
    assert_consistent(&s, "budget", "old", false);
}

#[test]
fn an_exhausted_budget_names_the_step_the_rollback_began_from() {
    use crate::ops::journal::Step;
    let mut seen = std::collections::BTreeSet::new();
    for secs in 1..40u64 {
        let s = fresh();
        if let Err(e) = run_with(&s, secs * 1000) {
            if e.reason == "MAINTENANCE_BUDGET" { seen.insert(e.from.expect("a rolled-back error says where it began")); }
        }
    }
    for step in [Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb] { assert!(seen.contains(&step), "{step:?} not seen in {seen:?}"); }
}

#[test]
fn a_budget_used_up_by_verify_live_does_not_undo_a_verified_update() {
    let s = fresh();
    s.borrow_mut().verify_live_takes_ms = 1_000_000;
    run_with(&s, 900_000).expect("verify_live passed, so the update commits");
    assert_consistent(&s, "budget gone after verify_live", "new", true);
}

#[test]
fn the_gateway_reopens_last_on_the_success_path() {
    let s = fresh();
    run(&s).unwrap();
    assert_eq!(s.borrow().order, ["on_commit", "finish_unfence", "reopen_gateway"]);
    assert_consistent(&s, "success order", "new", true);
}

#[test]
fn the_gateway_reopens_last_on_the_rollback_path() {
    let s = fresh();
    s.borrow_mut().fail_verify_live = true;
    run(&s).unwrap_err();
    assert_eq!(s.borrow().order, ["finish_unfence", "reopen_gateway"]);
    assert_consistent(&s, "rollback order", "old", true);
}

#[test]
fn when_rollback_itself_fails_the_fence_stays_and_the_exit_is_17() {
    let s = fresh();
    { let mut st = s.borrow_mut(); st.fail_verify_live = true; st.fail_swap_back = true; }
    let e = run(&s).unwrap_err();
    assert_eq!(e.code, OpCode::RecoveryNeeded);
    let st = s.borrow();
    assert_eq!(st.gateway, Gw::Maintenance, "tills stay fenced");
    assert!(st.journal.is_some(), "journal kept for --recover");
}

#[test]
fn the_source_is_repaired_after_the_backup_and_before_the_clone_so_a_collation_mismatch_no_longer_fails_the_clone() {
    let s = fresh();
    s.borrow_mut().collation_mismatch = true;
    run(&s).expect("a mismatching source must be repaired before the clone, not fail it with CLONE_FAILED");
    assert_eq!(s.borrow().trace, ["backup", "repair_source", "clone"]);
    assert_consistent(&s, "collation repaired before the clone", "new", true);
}

/// Crash at every call of a run on a mismatching source (including between the repair's intent and done): recovery rolls back to
/// a consistent old level, and the next update attempt repairs again (idempotent) and succeeds.
#[test]
fn a_crash_anywhere_around_the_source_repair_recovers_and_the_next_update_succeeds() {
    let total = { let s = fresh(); s.borrow_mut().collation_mismatch = true; run(&s).unwrap(); let n = s.borrow().calls; n };
    for k in 1..=total {
        let s = fresh();
        { let mut st = s.borrow_mut(); st.collation_mismatch = true; st.crash_at = Some(k); }
        crashed(&s, k, "run", || run(&s));
        let (swapped, had_journal) = (swap_seen(&s), s.borrow().journal.is_some());
        s.borrow_mut().crash_at = None;
        let level = if prev_seen(&s) { "new" } else { "old" };
        let label = format!("repair crash k={k}");
        let r = recover_state(&s).unwrap_or_else(|e| panic!("{label}: recovery failed: {e}"));
        assert_recovered(&r, level, had_journal, &label);
        assert_consistent(&s, &label, level, swapped);
        if level == "old" {
            run(&s).unwrap_or_else(|e| panic!("{label}: the next update failed: {e}"));
            assert_eq!(s.borrow().dbs["postgres"], "new", "{label}: next update level");
        }
    }
}
