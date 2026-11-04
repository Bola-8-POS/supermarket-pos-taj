//! The seam between Plan 07/09's operation runner and the backup service. In process, with the lock the
//! caller already holds exclusively: running `posctl backup run` as a child would wait on that very lock.
use super::acl;
use super::ctx::BackupCtx;
use super::run::{free_space_ok, run_backup, Deps, LockPolicy, Reason, RunOptions};
use super::state::BackupState;
use super::util::tail;
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::real::BackupRunner;
use crate::ops::world::{BackupReason, R};
use crate::update::Env;

pub struct Plan08Backup {
    pub ctx: BackupCtx,
    pub deps: Deps,
    /// Start of the maintenance window this operation runs in (`update::window::window_start_unix`).
    pub window_start: i64,
}

/// The backup context of the pack that is current (or about to be) on this machine.
pub fn ctx_from_env(env: &Env, pack: &str) -> BackupCtx {
    BackupCtx::new(&env.roots, env.pack_dir(pack), env.ports, pack.to_string(), env!("CARGO_PKG_VERSION").to_string())
}

/// The newest local snapshot is older than `PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS` (or there is none).
pub fn is_stale(st: &BackupState, now: i64) -> bool {
    st.local.as_ref().is_none_or(|s| now - s.at > PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS)
}

/// A pre-update backup is only trusted to work if the newest local snapshot is younger than this. An older one does not
/// refuse the update (it may be the very update that fixes the scheduled backup) but it gets ONE fenced attempt per window.
pub const PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS: i64 = 26 * 3600;
/// How far a stored window marker may be from the current window key and still count as "this window". Covers the two
/// clock reads (adapter and gate) landing in different minutes and DST nights. Markers only ever grow and the next night's
/// key is 24 h later, so 2 h can never mistake yesterday for tonight.
pub const MARKER_TOLERANCE_SECS: i64 = 2 * 3600;

/// Whether a backup can be expected to work, checked BEFORE the store is fenced. `Err` carries the cause for humans.
/// A failed last attempt alone is not a reason to refuse (transient failures still get their pre-update try).
///
/// Structural problems (not provisioned, `backups\` missing or not private, no free space) always refuse. A stale or
/// missing snapshot does not: the update may be the very thing that fixes the scheduled backup. It gets ONE fenced
/// attempt per maintenance window (`window_start`); once that attempt has failed, the rest of the window refuses.
/// The per-window refusal applies to SCHEDULED runs only: a person at the console still gets their own fenced attempt.
pub fn readiness(ctx: &BackupCtx, deps: &Deps, window_start: i64, scheduled: bool) -> Result<(), String> {
    if !ctx.paths.conf_file().exists() {
        return Err("this PC is not provisioned for backup".into());
    }
    if !ctx.paths.backups().is_dir() {
        return Err("the backups folder does not exist; run provisioning again".into());
    }
    acl::assert_private(ctx, &ctx.paths.backups()).map_err(|e| e.message)?;
    let now = (deps.now)();
    let st = BackupState::load_in(&ctx.paths, now).map_err(|e| e.message)?;
    free_space_ok(ctx, deps, &st).map_err(|e| e.message)?;
    if scheduled && is_stale(&st, now) && window_start != 0 && st.pre_update_failed_window >= window_start - MARKER_TOLERANCE_SECS {
        let hours = PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS / 3600;
        let cause = st.last_error.as_deref().unwrap_or("no failed attempt is recorded");
        return Err(format!("no backup in the last {hours} h and this window's pre-update attempt already failed: {cause}"));
    }
    Ok(())
}

impl BackupRunner for Plan08Backup {
    /// Pre-update and pre-switch backups are never skipped: any failure is an `Err`, the runner rolls back and the
    /// operation does not start. A pre-restore backup is best effort (the reason to restore is often a damaged live
    /// database, and a backup of it failing must not make the restore impossible): the failure is recorded in
    /// `state\backup.json` for status and the restore proceeds.
    fn run(&mut self, reason: BackupReason, timeout_ms: u64) -> R<()> {
        let (r, best_effort, label) = match reason {
            BackupReason::PreUpdate => (Reason::PreUpdate, false, "PRE_UPDATE_BACKUP_FAILED"),
            BackupReason::PreSwitch => (Reason::PreSwitch, false, "PRE_SWITCH_BACKUP_FAILED"),
            BackupReason::PreRestore => (Reason::PreRestore, true, "PRE_RESTORE_BACKUP_FAILED"),
        };
        // `timeout_ms` is the runner's share of the maintenance window, relative to now.
        let left = i64::try_from(timeout_ms / 1000).unwrap_or(i64::MAX / 2);
        let opts = RunOptions {
            reason: r,
            only_dest: None,
            scheduled: false,
            lock: LockPolicy::CallerHoldsExclusive,
            deadline: Some((self.deps.now)().saturating_add(left)),
        };
        match run_backup(&self.ctx, &self.deps, &opts) {
            Ok(_) => Ok(()),
            Err(e) if best_effort => {
                self.record_skipped(&e.message);
                eprintln!("{{\"warn\":\"{label}\",\"message\":{}}}", serde_json::to_string(&e.message).unwrap_or_default());
                Ok(())
            }
            Err(e) => {
                self.mark_window_if_stale();
                Err(OpError::new(OpCode::RolledBack, label, e.message))
            }
        }
    }
}

impl Plan08Backup {
    /// A failed pre-update/pre-switch backup of a store whose newest snapshot is already stale: remember the window, so the
    /// gate does not fence the tills again tonight (one fenced attempt per window).
    fn mark_window_if_stale(&self) {
        let now = (self.deps.now)();
        if let Ok(mut st) = BackupState::load_in(&self.ctx.paths, now) {
            if is_stale(&st, now) {
                st.pre_update_failed_window = self.window_start;
                let _ = st.save_in(&self.ctx);
            }
        }
    }

    /// Make a best-effort failure visible in `status.backup`. `run_backup` already records the failures that happen
    /// once a backup has started; this covers the ones that stop it earlier (no lock is held: the caller holds it).
    fn record_skipped(&self, message: &str) {
        if !self.ctx.paths.conf_file().exists() {
            return; // not provisioned: nothing to report on
        }
        let now = (self.deps.now)();
        if let Ok(mut st) = BackupState::load_in(&self.ctx.paths, now) {
            st.last_attempt_at = now;
            st.last_attempt_ok = false;
            st.last_error = Some(tail(&format!("pre-restore backup failed: {message}")));
            let _ = st.save_in(&self.ctx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::pg::{PgConn, SnapshotOpener, SnapshotQueries};
    use crate::backup::result::BResult;
    use crate::backup::state::BackupState;
    use crate::backup::util::fake::{temp_ctx, FakeExec};
    use crate::ops::outcome::OpCode;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    const NOW: i64 = 1_790_000_100;
    const WINDOW: i64 = NOW - 600;
    const PREV_WINDOW: i64 = WINDOW - 86_400;

    /// Every timeout the session was given: the one for `open`, then one per query.
    type Seen = Rc<RefCell<Vec<Duration>>>;

    struct Snap(Seen);
    impl SnapshotQueries for Snap {
        fn snapshot_id(&self) -> String { "00000003-0000001B-1".into() }
        fn query(&mut self, sql: &str) -> BResult<Vec<String>> {
            Ok(if sql.contains("pg_policies") { vec!["functions|aa".into(), "policies|bb".into()] }
               else if sql.contains("schema_migrations") { vec!["3|20260930000001".into()] }
               else if sql.contains("to_regclass") { vec!["f".into()] }
               else if sql.contains("datlocprovider") { vec![r#"{"name":"postgres","owner":"postgres","encoding":"UTF8","provider":"i","locale":"es-MX","collate":"C","ctype":"C","collversion":"1","bytes":4096,"settings":[]}"#.into()] }
               else { vec![] })
        }
        fn set_query_timeout(&mut self, d: Duration) { self.0.borrow_mut().push(d); }
        fn close(&mut self) {}
    }
    struct Opener(Seen);
    impl SnapshotOpener for Opener {
        fn open(&self, _c: &BackupCtx, _p: &PgConn, timeout: Duration) -> BResult<Box<dyn SnapshotQueries>> {
            self.0.borrow_mut().push(timeout);
            Ok(Box::new(Snap(self.0.clone())))
        }
    }

    fn write_arg_file(args: &[String]) {
        let i = args.iter().position(|a| a == "-f").unwrap();
        std::fs::write(&args[i + 1], b"bytes").unwrap();
    }

    fn adapter(exec: Rc<FakeExec>) -> (tempfile::TempDir, Plan08Backup, Seen) {
        let (d, ctx) = temp_ctx();
        let seen = Seen::default();
        let deps = Deps { exec: Box::new(exec), opener: Box::new(Opener(seen.clone())), now: || NOW, free_bytes: |_| Ok(1 << 40) };
        (d, Plan08Backup { ctx, deps, window_start: WINDOW }, seen)
    }

    fn healthy() -> FakeExec {
        FakeExec::default()
            .on("pg_dump.exe --version", 0, "pg_dump 17")
            .on_with("pg_dumpall.exe", 0, "", write_arg_file)
            .on_with("pg_dump.exe", 0, "", write_arg_file)
            .on("backup --json", 0, "{\"message_type\":\"summary\",\"snapshot_id\":\"cafebabe\",\"total_bytes_processed\":1,\"data_added\":1}\n")
    }
    /// pg_dump itself fails: the backup is attempted and does not happen.
    fn broken() -> FakeExec { FakeExec::default().on("pg_dump.exe --version", 0, "x").on("pg_dump.exe", 1, "") }
    fn ready_ctx() -> (tempfile::TempDir, Plan08Backup) {
        let (d, a, _) = adapter(Rc::new(healthy()));
        set_state(&a, |st| st.local = Some(crate::backup::state::SnapRef { id: "cafebabe".into(), at: NOW - 3600, reason: "hourly".into() }));
        (d, a)
    }
    fn set_state(a: &Plan08Backup, f: impl FnOnce(&mut BackupState)) {
        let mut st = BackupState::load(&a.ctx.paths.state_file(), NOW).unwrap();
        f(&mut st);
        st.save_in(&a.ctx).unwrap();
    }
    fn ready(a: &Plan08Backup) -> Result<(), String> { readiness(&a.ctx, &a.deps, WINDOW, true) }
    fn ready_by_hand(a: &Plan08Backup) -> Result<(), String> { readiness(&a.ctx, &a.deps, WINDOW, false) }
    fn stale(a: &Plan08Backup) {
        set_state(a, |st| { st.local.as_mut().unwrap().at = NOW - PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS - 1; st.last_error = Some("destination offline".into()); });
    }

    #[test]
    fn a_store_with_a_recent_snapshot_is_ready_even_if_the_last_attempt_failed() {
        let (_d, a) = ready_ctx();
        ready(&a).unwrap();
        set_state(&a, |st| { st.last_attempt_ok = false; st.last_error = Some("transient".into()); });
        ready(&a).expect("a transient failure still gets its pre-update try");
    }

    #[test]
    fn a_store_that_is_not_provisioned_for_backup_is_not_ready() {
        let (_d, a) = ready_ctx();
        std::fs::remove_dir_all(a.ctx.paths.backups()).unwrap();
        assert!(ready(&a).unwrap_err().contains("backups folder"));
        std::fs::remove_file(a.ctx.paths.conf_file()).unwrap();
        assert!(ready(&a).unwrap_err().contains("not provisioned"));
    }

    #[test]
    fn a_backups_folder_that_is_not_private_is_not_ready() {
        // a production (non-dev) context over a plain temp folder: its owner and ACL are not SYSTEM/Administrators only
        let (d, a) = ready_ctx();
        let roots = crate::paths::Roots { dev: false, ..crate::paths::Roots::custom(d.path().join("data"), d.path().join("program")) };
        let ctx = BackupCtx::new(&roots, a.ctx.pack_dir.clone(), a.ctx.ports, "t".into(), "t".into());
        let e = readiness(&ctx, &a.deps, WINDOW, false).unwrap_err();
        assert!(e.contains("not private") || e.contains("cannot read the permissions"), "{e}");
    }

    #[test]
    fn a_full_backup_disk_is_not_ready() {
        let (_d, mut a) = ready_ctx();
        a.deps.free_bytes = |_| Ok(1 << 20);
        assert!(ready(&a).unwrap_err().contains("MB free"));
    }

    #[test]
    fn a_stale_store_with_no_attempt_in_this_window_gets_its_one_fenced_attempt() {
        let (_d, a) = ready_ctx();
        stale(&a);
        ready(&a).expect("stale alone must not block the update that may fix the backup");
        set_state(&a, |st| st.local = None);
        ready(&a).expect("a store that never took a backup gets its attempt too");
        set_state(&a, |st| st.pre_update_failed_window = 0);
        ready(&a).unwrap();
    }

    #[test]
    fn a_stale_store_whose_attempt_already_failed_in_this_window_is_refused_with_the_cause() {
        let (_d, a) = ready_ctx();
        stale(&a);
        set_state(&a, |st| st.pre_update_failed_window = WINDOW);
        let e = ready(&a).unwrap_err();
        assert!(e.contains("no backup in the last 26 h") && e.contains("destination offline"), "{e}");
    }

    #[test]
    fn a_person_at_the_console_still_gets_their_own_attempt_but_structural_refusals_apply_to_everyone() {
        let (_d, mut a) = ready_ctx();
        stale(&a);
        set_state(&a, |st| st.pre_update_failed_window = WINDOW);
        assert!(ready(&a).is_err(), "the scheduled run is refused");
        ready_by_hand(&a).expect("a manual run is not");
        a.deps.free_bytes = |_| Ok(1 << 20);
        assert!(ready_by_hand(&a).unwrap_err().contains("MB free"), "structural problems refuse manual runs too");
    }

    #[test]
    fn the_marker_is_compared_with_a_tolerance_and_only_yesterdays_window_passes() {
        let (_d, a) = ready_ctx();
        stale(&a);
        for off in [-60, -3600, 0, 600] {
            set_state(&a, |st| st.pre_update_failed_window = WINDOW + off);
            assert!(ready(&a).is_err(), "marker {off} s off the key still refuses");
        }
        set_state(&a, |st| st.pre_update_failed_window = WINDOW - 86_400);
        ready(&a).expect("yesterday's marker is a night old");
        set_state(&a, |st| st.pre_update_failed_window = WINDOW - MARKER_TOLERANCE_SECS - 1);
        ready(&a).expect("just past the tolerance");
    }

    #[test]
    fn a_failure_in_the_previous_window_does_not_count() {
        let (_d, a) = ready_ctx();
        stale(&a);
        set_state(&a, |st| st.pre_update_failed_window = PREV_WINDOW);
        ready(&a).expect("tonight is a new window");
    }

    #[test]
    fn a_fresh_snapshot_ignores_the_window_marker_and_26_hours_exactly_is_still_fresh() {
        let (_d, a) = ready_ctx();
        set_state(&a, |st| st.pre_update_failed_window = WINDOW);
        ready(&a).unwrap();
        set_state(&a, |st| st.local.as_mut().unwrap().at = NOW - PRE_UPDATE_MAX_SNAPSHOT_AGE_SECS);
        ready(&a).unwrap();
    }

    #[test]
    fn a_pre_update_or_pre_switch_failure_while_stale_marks_the_window_and_a_fresh_one_does_not() {
        let (_d, mut a) = {
            let (d, a, _) = adapter(Rc::new(broken()));
            set_state(&a, |st| st.local = Some(crate::backup::state::SnapRef { id: "c".into(), at: NOW - 3600, reason: "hourly".into() }));
            (d, a)
        };
        a.run(BackupReason::PreUpdate, 60_000).unwrap_err();
        assert_eq!(state(&a).pre_update_failed_window, 0, "fresh snapshot: the marker is not needed");
        stale(&a);
        a.run(BackupReason::PreUpdate, 60_000).unwrap_err();
        assert_eq!(state(&a).pre_update_failed_window, WINDOW);
        set_state(&a, |st| st.pre_update_failed_window = 0);
        a.run(BackupReason::PreSwitch, 60_000).unwrap_err();
        assert_eq!(state(&a).pre_update_failed_window, WINDOW);
        set_state(&a, |st| st.pre_update_failed_window = 0);
        a.run(BackupReason::PreRestore, 60_000).unwrap();
        assert_eq!(state(&a).pre_update_failed_window, 0, "a restore backup never feeds the update gate");
    }

    fn state(a: &Plan08Backup) -> BackupState { BackupState::load(&a.ctx.paths.state_file(), 0).unwrap() }

    #[test]
    fn a_pre_update_run_takes_a_protected_snapshot_tagged_with_its_reason() {
        let exec = Rc::new(healthy());
        let (_d, mut a, _) = adapter(exec.clone());
        a.run(BackupReason::PreUpdate, 60_000).unwrap();
        let line = exec.calls.borrow().iter().find(|l| l.contains("backup --json")).cloned().expect("restic backup ran");
        assert!(line.contains("--tag reason:pre-update") && line.contains("--tag protect"), "{line}");
    }

    #[test]
    fn a_pre_switch_run_is_tagged_pre_switch() {
        let exec = Rc::new(healthy());
        let (_d, mut a, _) = adapter(exec.clone());
        a.run(BackupReason::PreSwitch, 60_000).unwrap();
        assert!(exec.calls.borrow().iter().any(|l| l.contains("--tag reason:pre-switch")));
    }

    #[test]
    fn a_failed_pre_update_backup_stops_the_update() {
        let (_d, mut a, _) = adapter(Rc::new(broken()));
        let e = a.run(BackupReason::PreUpdate, 60_000).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED"));
    }

    #[test]
    fn a_failed_pre_switch_backup_stops_the_switch() {
        let (_d, mut a, _) = adapter(Rc::new(broken()));
        let e = a.run(BackupReason::PreSwitch, 60_000).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "PRE_SWITCH_BACKUP_FAILED"));
    }

    #[test]
    fn a_failed_backup_before_a_restore_does_not_block_it_but_status_shows_the_failure() {
        let (_d, mut a, _) = adapter(Rc::new(broken()));
        a.run(BackupReason::PreRestore, 60_000).expect("best effort: the restore proceeds");
        let st = state(&a);
        assert!(!st.last_attempt_ok, "{st:?}");
        assert!(st.last_error.as_deref().is_some_and(|m| m.to_lowercase().contains("pre-restore")), "{st:?}");
    }

    #[test]
    fn a_pre_restore_backup_with_no_budget_is_skipped_not_fatal() {
        let exec = Rc::new(healthy());
        let (_d, mut a, _) = adapter(exec.clone());
        a.run(BackupReason::PreRestore, 0).expect("best effort");
        assert!(exec.calls.borrow().is_empty(), "no tool ran");
        assert!(state(&a).last_error.as_deref().is_some_and(|m| m.contains("exceeded")));
    }

    #[test]
    fn a_pre_restore_backup_on_a_machine_that_is_not_provisioned_writes_nothing() {
        let (_d, mut a, _) = adapter(Rc::new(healthy()));
        std::fs::remove_file(a.ctx.paths.conf_file()).unwrap();
        a.run(BackupReason::PreRestore, 60_000).unwrap();
        assert!(!a.ctx.paths.state_file().exists());
    }

    #[test]
    fn the_adapter_never_waits_on_the_lock_its_caller_holds() {
        let (_d, mut a, _) = adapter(Rc::new(healthy()));
        a.run(BackupReason::PreUpdate, 60_000).unwrap();
        assert!(!a.ctx.paths.update_lock().exists() && !a.ctx.paths.backup_lock().exists());
    }

    #[test]
    fn the_runner_budget_bounds_every_child_and_every_snapshot_query() {
        let exec = Rc::new(healthy());
        let (_d, mut a, seen) = adapter(exec.clone());
        a.run(BackupReason::PreUpdate, 60_000).unwrap();
        let limit = Duration::from_secs(60);
        for needle in ["pg_dump.exe -h", "pg_dumpall.exe", "backup --json"] {
            assert!(exec.timeout_of(needle) <= limit, "{needle}: {:?}", exec.timeout_of(needle));
        }
        let seen = seen.borrow();
        assert!(seen.len() >= 6, "open plus the five collect queries (no caja table here): {seen:?}");
        assert!(seen.iter().all(|t| *t <= limit), "a session query may outlive the window: {seen:?}");
    }

    #[test]
    fn a_pre_update_backup_that_has_no_time_is_an_error_and_is_recorded_for_status() {
        let exec = Rc::new(healthy());
        let (_d, mut a, _) = adapter(exec.clone());
        let e = a.run(BackupReason::PreUpdate, 999).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED"));
        assert!(e.message.contains("exceeded"), "{}", e.message);
        assert!(exec.calls.borrow().is_empty(), "no tool ran");
        let st = state(&a);
        assert!(!st.last_attempt_ok && st.last_error.as_deref().is_some_and(|m| m.contains("pre-update backup exceeded")), "{st:?}");
    }
}
