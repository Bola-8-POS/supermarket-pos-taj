//! How long each scheduled update task may run (FR19 item 7), derived from the timeouts the code itself uses, so the Task Scheduler's
//! `ExecutionTimeLimit` cannot silently drift below them. `tasks::all_tasks()` takes its limits from here, and a test
//! (`update_tasks`) fails when a limit is smaller than the sum. Everything is in seconds.
//!
//! A run is bounded in the worst case, not the expected one: every wait below is a cap that is only reached on a wedged machine.
//!
//! * RECOVERY. A journal means the store is already down, so a recovery has no end time; what bounds it is the 10-minute cap per
//!   statement (`statement_budget_ms`) and the three attempts the scheduled tasks get. `recover` decides ONE branch from the journal, so
//!   the worst attempt is the longest branch, not a sum of branches: a journal past the swap RESUMES forward (re-activate the new pack,
//!   repair the collation, start the stack, `verify_live`) and, when that fails, runs the whole rollback after it (a full service cycle:
//!   stop the stack, re-activate the old pack, start the stack, reopen the gateway; plus `ROLLBACK_STATEMENTS` statements at the cap).
//!   Every recovery first fences again and reads the database names. The plain-rollback branch is that rollback alone, so it is shorter
//!   (a compile-time assertion below keeps it so).
//! * UPDATE. Pre-fence: install the bundled pack and fetch the feed's (the two child timeouts), the prechecks
//!   (`PRECHECK_STATEMENTS` psql statements at the Default cap), and the wait for `update.lock`. Then the maintenance budget at the
//!   RUNTIME clamp (`BUDGET_MAX_SECS`, not the 7200 s the config accepts), one statement floor of overshoot (a statement that starts
//!   just before the deadline still gets a minute), and the rollback reserve: a full service cycle plus `ROLLBACK_STATEMENTS`
//!   statements at the floor (after the deadline a statement gets the floor, never more).
//! * UpdateCheck. A run that recovered a journal RETURNS right after the recovery (reason `RECOVERED`, `run_inner`); the next hourly run
//!   does the update. So one run is a recovery OR an update, never both, which is why the limit takes the larger of the two
//!   (`max`), not their sum. The Recover task (`--recover --scheduled`) is one recovery plus the boot lock retries.
//!
//! The two statement counts are estimates from reading the rollback and precheck paths, not measurements: check them against the
//! Sandbox timings, and raise the number here when a path grows past it. The limit is the worst case plus `MARGIN_SECS`, rounded up to whole minutes.
use crate::commands::update::{
    BUDGET_MAX_SECS as RUNTIME_BUDGET_MAX_SECS, OPERATION_LOCK_WAIT_SECS, PACK_FETCH_TIMEOUT_SECS, PACK_INSTALL_TIMEOUT_SECS,
    RECOVER_LOCK_RETRIES, RECOVER_LOCK_RETRY_SECS,
};
use crate::ops::fence::{SC_START_SECS, SC_STOP_SECS, START_ORDER, STOP_ORDER};
use crate::ops::real::{CADDY_ADAPT_SECS, FENCE_RESPONDER_WAIT_SECS, GATEWAY_LIVE_WAIT_SECS, PG_WAIT_SECS, STACK_HEALTH_WAIT_SECS};
use crate::update::work::{STMT_FLOOR_MS, TEN_MIN_MS, VERIFY_PROBE_SECS};

pub const BUDGET_MAX_SECS: u64 = RUNTIME_BUDGET_MAX_SECS;
const FLOOR_SECS: u64 = STMT_FLOOR_MS / 1000;
const STATEMENT_CAP_SECS: u64 = TEN_MIN_MS / 1000;
/// psql statements a rollback or a recovery can run (names, swap back, drop, level/view checks, role logins).
/// An ESTIMATE from reading the code, not measured: to be checked against the Sandbox timings (run 9).
pub const ROLLBACK_STATEMENTS: u64 = 12;
/// psql statements the prechecks run (applied migrations, names, sizes of the live and old databases, slot gate).
/// An ESTIMATE from reading the code, not measured: to be checked against the Sandbox timings (run 9).
pub const PRECHECK_STATEMENTS: u64 = 8;
/// Added to every worst case.
pub const MARGIN_SECS: u64 = 600;

/// Stop everything behind the gateway (the gateway itself is the maintenance page and stays).
const STACK_STOP_SECS: u64 = (STOP_ORDER.len() as u64 - 1) * SC_STOP_SECS;
/// Postgres answers, the service roles may log in (a Quick statement), Auth/Rest/Functions start and answer.
const STACK_START_SECS: u64 = PG_WAIT_SECS + FLOOR_SECS + START_ORDER.len() as u64 * SC_START_SECS + STACK_HEALTH_WAIT_SECS;
/// Re-activating a pack (either way): stop the stack and Postgres, wait for Postgres again.
const PACK_ACTIVATE_SECS: u64 = STACK_STOP_SECS + SC_STOP_SECS + PG_WAIT_SECS;
/// Parse the live config, restart the gateway, wait for it to open.
const GATEWAY_REOPEN_SECS: u64 = CADDY_ADAPT_SECS + SC_STOP_SECS + SC_START_SECS + GATEWAY_LIVE_WAIT_SECS;
const SERVICE_CYCLE_SECS: u64 = STACK_STOP_SECS + PACK_ACTIVATE_SECS + STACK_START_SECS + GATEWAY_REOPEN_SECS;

/// What an update that fails after its budget still needs to put the old level back.
pub const ROLLBACK_RESERVE_SECS: u64 = SERVICE_CYCLE_SECS + ROLLBACK_STATEMENTS * FLOOR_SECS;
/// The rollback of a recovery: no end time, a flat cap per statement.
const ROLLBACK_RECOVERY_SECS: u64 = SERVICE_CYCLE_SECS + ROLLBACK_STATEMENTS * STATEMENT_CAP_SECS;
/// `recover` fences again before anything else (the gateway bounce, the responder wait, stopping the stack, Postgres, closing the
/// roles' login: one statement) and then lists the databases (Postgres up, one statement).
const REFENCE_AND_DECIDE_SECS: u64 = SC_STOP_SECS + SC_START_SECS + FENCE_RESPONDER_WAIT_SECS + STACK_STOP_SECS + PG_WAIT_SECS + STATEMENT_CAP_SECS
    + PG_WAIT_SECS + STATEMENT_CAP_SECS;
/// psql statements `after_activate` runs (collation check, repair) and `verify_live` runs (schema level, version view, lockout hook).
/// ESTIMATES from reading the code, not measured: to be checked against the Sandbox timings.
pub const AFTER_ACTIVATE_STATEMENTS: u64 = 2;
pub const VERIFY_LIVE_STATEMENTS: u64 = 3;
/// HTTP probes `verify_live` makes, each at `VERIFY_PROBE_SECS`.
pub const VERIFY_LIVE_PROBES: u64 = 4;
/// `verify_live`: its statements at the cap, its probes, and the lockout canary (the canary is its own `MAX_BUDGET`, 120 s: five
/// back-to-back GoTrue calls bounded by `min(left, MAX_BUDGET)`; a recovery hands it 10 minutes and it takes the smaller).
const VERIFY_LIVE_SECS: u64 = VERIFY_LIVE_STATEMENTS * STATEMENT_CAP_SECS + VERIFY_LIVE_PROBES * VERIFY_PROBE_SECS + crate::canary::MAX_BUDGET.as_secs();
/// A journal past the swap resumes forward and fails in `verify_live`: re-activate the new pack, `after_activate`, start the stack, verify.
const RESUME_FAILED_SECS: u64 = PACK_ACTIVATE_SECS + AFTER_ACTIVATE_STATEMENTS * STATEMENT_CAP_SECS + STACK_START_SECS + VERIFY_LIVE_SECS;
/// One recovery attempt, the longest branch: resume after the swap, fail, and roll back.
pub const RECOVERY_WORST_CASE_SECS: u64 = REFENCE_AND_DECIDE_SECS + RESUME_FAILED_SECS + ROLLBACK_RECOVERY_SECS;
/// One whole update, from resolving the pack to the rollback that follows its worst failure.
pub const UPDATE_WORST_CASE_SECS: u64 = PACK_INSTALL_TIMEOUT_SECS + PACK_FETCH_TIMEOUT_SECS
    + PRECHECK_STATEMENTS * STATEMENT_CAP_SECS + OPERATION_LOCK_WAIT_SECS
    + BUDGET_MAX_SECS + FLOOR_SECS + ROLLBACK_RESERVE_SECS;

/// The Recover task: one recovery after the boot lock retries.
pub const RECOVER_WORST_CASE_SECS: u64 = RECOVER_LOCK_RETRIES as u64 * RECOVER_LOCK_RETRY_SECS + RECOVERY_WORST_CASE_SECS;
/// The UpdateCheck task: a recovery or a whole update, whichever is longer (a run that recovered returns without updating).
pub const UPDATE_CHECK_WORST_CASE_SECS: u64 = if RECOVERY_WORST_CASE_SECS > UPDATE_WORST_CASE_SECS { RECOVERY_WORST_CASE_SECS } else { UPDATE_WORST_CASE_SECS };

/// `ExecutionTimeLimit` minutes for a worst case: plus the margin, rounded up.
pub const fn limit_minutes(worst_case_secs: u64) -> u32 { (worst_case_secs + MARGIN_SECS).div_ceil(60) as u32 }
pub const RECOVER_LIMIT_MINUTES: u32 = limit_minutes(RECOVER_WORST_CASE_SECS);
pub const UPDATE_CHECK_LIMIT_MINUTES: u32 = limit_minutes(UPDATE_CHECK_WORST_CASE_SECS);

// The limits hold their worst case and the margin; the UpdateCheck limit covers both a recovery and a whole update. Checked when the crate compiles.
const _: () = assert!(RECOVER_LIMIT_MINUTES as u64 * 60 >= RECOVER_WORST_CASE_SECS + MARGIN_SECS);
const _: () = assert!(UPDATE_CHECK_LIMIT_MINUTES as u64 * 60 >= UPDATE_CHECK_WORST_CASE_SECS + MARGIN_SECS);
const _: () = assert!(RECOVERY_WORST_CASE_SECS >= REFENCE_AND_DECIDE_SECS + ROLLBACK_RECOVERY_SECS);
const _: () = assert!(UPDATE_CHECK_WORST_CASE_SECS >= RECOVERY_WORST_CASE_SECS && UPDATE_CHECK_WORST_CASE_SECS >= UPDATE_WORST_CASE_SECS);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_term_is_the_clamp_a_run_really_obeys_not_the_config_maximum() {
        assert_eq!(BUDGET_MAX_SECS, crate::commands::update::budget_seconds(Some(u64::MAX), None));
    }

    #[test]
    fn a_recovery_that_resumes_after_the_swap_and_then_rolls_back_fits_in_the_recovery_limit() {
        // re-fence, find the databases, re-activate the new pack, repair the collation, start the stack, verify live (statements at the
        // cap, four 5 s probes, the canary), then the whole rollback: a service cycle and its statements.
        let fence = SC_STOP_SECS + SC_START_SECS + FENCE_RESPONDER_WAIT_SECS + STACK_STOP_SECS + PG_WAIT_SECS + STATEMENT_CAP_SECS;
        let decide = PG_WAIT_SECS + STATEMENT_CAP_SECS;
        let forward = PACK_ACTIVATE_SECS + 2 * STATEMENT_CAP_SECS + STACK_START_SECS + 3 * STATEMENT_CAP_SECS + VERIFY_LIVE_PROBES * VERIFY_PROBE_SECS + crate::canary::MAX_BUDGET.as_secs();
        let resume_then_rollback = fence + decide + forward + SERVICE_CYCLE_SECS + ROLLBACK_STATEMENTS * STATEMENT_CAP_SECS;
        assert!(RECOVERY_WORST_CASE_SECS >= resume_then_rollback, "{RECOVERY_WORST_CASE_SECS} s is below {resume_then_rollback} s");
        assert!(RECOVER_LIMIT_MINUTES as u64 * 60 >= resume_then_rollback + RECOVER_LOCK_RETRIES as u64 * RECOVER_LOCK_RETRY_SECS + MARGIN_SECS);
    }
}
