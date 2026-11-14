//! `posctl update` (conventions 11.1). Order of events: the lock (exclusive) and only then the journal, recovery first,
//! the target pack, prechecks, the idle check, the lock again, `run_operation`, housekeeping, the result file.
//!
//! Everything the command does to the machine goes through `Deps`, so the whole flow is tested against the fake world of
//! `ops::fake`; `RealDeps` is the production wiring (WindowsScm, the FR4 activator, the PGDATA volume, ONE shared deadline
//! for every psql call). Secrets are scrubbed once, in `finalize`, with the full secret set, on the way out.
use crate::envelope::{Code, Outcome, PosctlError};
use crate::ops::journal::{Journal, JournalError, Step};
use crate::ops::lock::{acquire_for, probe_readonly_for, LockMode, LockState};
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::proc::run_with_timeout;
use crate::ops::real::{conf_activate_fn, activator_from, load_all_secrets, scrub, BackupRunner, RealCfg, RealWorld};
use crate::ops::recover::{ctx_from_journal, recover, Recovered};
use crate::ops::runner::run_operation;
use crate::ops::swap::{disk_gate, free_bytes, DiskVerdict, PsqlAdmin, RealDb};
use crate::update::result_file::RolledBack;
use crate::ops::world::{OpCtx, OpWork, World, R};
#[cfg(any(test, feature = "test-hooks"))]
use crate::ops::world::BackupReason;
use crate::update::idle::{parse_idle, verdict, IDLE_SQL};
use crate::update::manifest::{pack_version_key, verify_files, Manifest};
use crate::update::precheck::{check_rules, check_steps, forbid_cluster_changes, pending_migrations, slot_gate};
use crate::update::result_file::UpdateResultFile;
use crate::update::work::{statement_budget_ms, window_open, UpdateWork};
use crate::update::Env;
use std::collections::BTreeSet;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(clap::Args, Debug, Clone)]
pub struct UpdateArgs {
    /// An installed packVersion, or a path to a .pospack file
    #[arg(long, conflicts_with_all = ["if_available", "recover"])]
    pub pack: Option<String>,
    /// Only if the feed offers a newer pack
    #[arg(long, conflicts_with = "recover")]
    pub if_available: bool,
    /// Skip while the store is trading (open caja or a sale in the last 30 minutes)
    #[arg(long, conflicts_with = "recover")]
    pub window_aware: bool,
    /// Check everything, change nothing
    #[arg(long, conflicts_with = "recover")]
    pub dry_run: bool,
    #[arg(long, conflicts_with = "recover")]
    pub max_maintenance_seconds: Option<u64>,
    #[arg(long, conflicts_with = "recover")]
    pub allow_downgrade: bool,
    /// Finish or undo an interrupted operation (runs first on every start)
    #[arg(long)]
    pub recover: bool,
    /// Passed by the scheduled tasks (Recover, UpdateCheck) and by nothing a person types: the run is unattended, so its
    /// recovery attempts are counted against the three the machine may spend. Absent means a person is at the console.
    #[arg(long, hide = true)]
    pub scheduled: bool,
}

impl UpdateArgs {
    /// There is no way to skip the pre-update backup, ever (a test pins that no such flag exists).
    pub fn command_has_no_skip_backup_flag() -> bool {
        use clap::Args;
        let c = UpdateArgs::augment_args(clap::Command::new("update"));
        let found = c.get_arguments().any(|a| { let n = a.get_id().as_str().to_lowercase(); n.contains("backup") || n.contains("skip") });
        !found
    }
}

/// Flattened into `cli::Command`, so the words are `posctl update ...`.
#[derive(clap::Subcommand, Debug)]
pub enum UpdateTop {
    /// Update the backend pack in place, unattended and with a rollback; or finish an interrupted update (`--recover`).
    Update(UpdateArgs),
}

pub struct Report { pub code: OpCode, pub reason: Option<String>, pub message: String, pub data: serde_json::Value, pub retryable: bool, pub journal: Option<String> }

impl Report {
    pub fn new(code: OpCode, reason: Option<&str>, message: &str, data: serde_json::Value, retryable: bool) -> Report {
        Report { code, reason: reason.map(str::to_string), message: message.into(), data, retryable, journal: None }
    }
    pub fn from_error(e: &OpError) -> Report {
        Report { code: e.code, reason: Some(e.reason.clone()), message: e.message.clone(), data: serde_json::json!({ "reason": e.reason }), retryable: e.retryable, journal: None }
    }
    pub fn to_envelope(&self, started_ms: u64, finished_ms: u64, posctl_version: &str) -> serde_json::Value {
        serde_json::json!({
            "ok": self.code == OpCode::Ok, "command": "update", "code": self.code.name(), "exit": self.code.exit(),
            "message": self.message, "retryable": self.retryable, "data": self.data, "journal": self.journal,
            "startedAt": started_ms, "finishedAt": finished_ms, "posctlVersion": posctl_version,
        })
    }
    /// The envelope code with the same exit number (OK 0, ERROR 1, LOCK_HELD 10, ... ROLLED_BACK 16, RECOVERY_NEEDED 17).
    pub fn into_outcome(self) -> Outcome {
        let code = Code::ALL.into_iter().find(|c| c.exit() == self.code.exit()).unwrap_or(Code::Error);
        let mut o = Outcome::with_code(code, self.message, self.data);
        o.retryable = self.retryable;
        o.journal = self.journal;
        o
    }
}

/// Every string of the report, scrubbed with the FULL secret set (pgpass passwords, JWT secret, anon and service-role keys,
/// the PIN pepper, role passwords, optional keys) plus the URL/password/JWT patterns. This is the one place it happens:
/// the journal and the result file carry reason codes only.
/// Codes only: the message is replaced and every string of the data that is not a plain code word is dropped.
fn withhold_text(mut r: Report) -> Report {
    fn keep(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::String(s) if !s.is_empty() && s.len() <= 48 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {}
            serde_json::Value::String(_) => *v = serde_json::Value::Null,
            serde_json::Value::Array(a) => { a.iter_mut().for_each(keep); a.retain(|x| !x.is_null()); }
            serde_json::Value::Object(o) => { o.values_mut().for_each(keep); o.retain(|_, x| !x.is_null()); }
            _ => {}
        }
    }
    r.message = "details withheld: the secret files cannot be read".into();
    keep(&mut r.data);
    if let Some(reason) = &r.reason { if !reason.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { r.reason = None; } }
    r
}

pub(crate) fn finalize(mut r: Report, secrets: &[String]) -> Report {
    fn walk(v: &mut serde_json::Value, secrets: &[String]) {
        match v {
            serde_json::Value::String(s) => *s = scrub(s, secrets),
            serde_json::Value::Array(a) => a.iter_mut().for_each(|x| walk(x, secrets)),
            serde_json::Value::Object(o) => o.values_mut().for_each(|x| walk(x, secrets)),
            _ => {}
        }
    }
    r.message = scrub(&r.message, secrets);
    r.reason = r.reason.map(|x| scrub(&x, secrets));
    walk(&mut r.data, secrets);
    r
}

/// `--max-maintenance-seconds` wins, else conf `maintenance.maxSeconds`, else `BUDGET_DEFAULT_SECS`; always `BUDGET_MIN_SECS..=BUDGET_MAX_SECS`.
pub fn budget_seconds(arg: Option<u64>, conf: Option<u64>) -> u64 { arg.or(conf).unwrap_or(BUDGET_DEFAULT_SECS).clamp(BUDGET_MIN_SECS, BUDGET_MAX_SECS) }
pub const BUDGET_DEFAULT_SECS: u64 = 900;
pub const BUDGET_MIN_SECS: u64 = 60;
/// The runtime ceiling (the config accepts up to 7200, but this clamp is what a run obeys).
pub const BUDGET_MAX_SECS: u64 = 3600;
/// Pre-fence child timeouts: installing a pack from a file / the bundled `backend.pospack`, and fetching one from the feed.
pub const PACK_INSTALL_TIMEOUT_SECS: u64 = 900;
pub const PACK_FETCH_TIMEOUT_SECS: u64 = 1800;
/// How long the update waits for `update.lock` before the fence.
pub const OPERATION_LOCK_WAIT_SECS: u64 = 120;

/// The disk rule at the gate: refuse with the numbers (GiB needed versus free) instead of starting a clone that cannot finish.
/// `Ok(true)` = enough only after the old copies are dropped.
pub fn disk_check(free: u64, db_bytes: u64, droppable: u64) -> R<bool> {
    Ok(disk_gate(free, db_bytes, droppable)? == DiskVerdict::OkAfterDroppingOld)
}

/// Extension point for Plan 09: one arm per operation kind.
pub fn work_for(j: &Journal, env: &Env) -> R<Box<dyn OpWork>> {
    match j.kind {
        // production builds an update's work through `Deps::work` (ONE shared deadline cell); this arm is for tests only
        #[cfg(test)]
        OpKind::Update => Ok(Box::new(UpdateWork::from_journal(j, env)?)),
        #[cfg(not(test))]
        OpKind::Update => Err(OpError::new(OpCode::RecoveryNeeded, "WORK_NEEDS_DEPS", "an update's work is built by the command's deps, not here")),
        // Plan 08: a restore is recovered from what its journal recorded; the backup files are not needed to roll back or finish
        OpKind::Restore => Ok(Box::new(crate::backup::restore_work::RestoreWork::from_journal(j, env)?)),
        // Plan 09: a recovered switch has no credentials and no dump; it can only roll back or finish
        OpKind::Switch => Ok(Box::new(crate::switch::work::SwitchWork::from_journal(j, env)?)),
    }
}

/// The only backup runner production wires: the in-process backup service, for the pack that is running now (its
/// `pg_dump` matches the server). A `test-hooks` build can swap in `TestBackup` (env `POSCTL_TEST_HOOKS` `backup`).
pub fn production_backup(env: &Env, pack: &str) -> Box<dyn BackupRunner> {
    #[cfg(feature = "test-hooks")]
    if let Some(mode) = crate::ops::hooks::backup_mode() { return Box::new(TestBackup(mode)); }
    Box::new(crate::backup::plan08_backup::Plan08Backup {
        ctx: crate::backup::plan08_backup::ctx_from_env(env, pack),
        deps: crate::backup::Deps::real(),
        window_start: window_start_now(env),
    })
}
/// The start of the maintenance window this moment belongs to (Plan 07's window and clock, no second definition).
fn window_start_now(env: &Env) -> i64 {
    use crate::update::window::{os_local_minute_of_day, window_from, window_start_unix};
    let w = window_from(posctl_cfg(env).and_then(|c| c.maintenance.window).as_ref());
    window_start_unix(crate::util::now_unix() as i64, os_local_minute_of_day(), w)
}
/// The precheck twin of `production_backup`: refuse before anything is fenced when the pack has no backup tooling.
fn backup_gate(env: &Env, pack: &str, scheduled: bool) -> R<()> {
    #[cfg(feature = "test-hooks")]
    if crate::ops::hooks::backup_mode().is_some() { return Ok(()); }
    let ctx = crate::backup::plan08_backup::ctx_from_env(env, pack);
    for exe in [ctx.restic_exe(), ctx.pg_exe("pg_dump.exe")] {
        if !exe.is_file() {
            return Err(OpError::new(OpCode::Precondition, "BACKUP_UNAVAILABLE", format!("{} is missing from pack {pack}; refusing to update without a backup", exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())));
        }
    }
    // the store itself must be able to take one (folder, privacy, space, and not already failed tonight): before any fence
    crate::backup::plan08_backup::readiness(&ctx, &crate::backup::Deps::real(), window_start_now(env), scheduled)
        .map_err(|why| OpError::new(OpCode::Precondition, "BACKUP_NOT_READY", format!("{why}; run `posctl backup run`, then retry")))
}
#[cfg(feature = "test-hooks")]
struct TestBackup(String);
#[cfg(feature = "test-hooks")]
impl BackupRunner for TestBackup {
    fn run(&mut self, _r: BackupReason, _t: u64) -> R<()> {
        if self.0 == "ok" { Ok(()) } else { Err(OpError::new(OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED", "injected")) }
    }
}

#[derive(Debug)]
pub struct Facts { pub db_bytes: u64, pub free: u64, pub need_drop_old: bool, pub pending: Vec<String> }

/// Everything `run` does to the machine.
pub trait Deps {
    fn now_ms(&self) -> u64;
    /// THE operation deadline (`u64::MAX` = recovery): shared with every psql wrapper this machine builds.
    fn deadline_cell(&self) -> Arc<AtomicU64>;
    fn current_pack(&self, env: &Env) -> R<String>;
    fn resolve_target(&self, args: &UpdateArgs, env: &Env, current: &str) -> R<Option<String>>;
    fn manifests(&self, env: &Env, from: &str, to: &str) -> R<(Manifest, Manifest)>;
    fn precheck(&self, env: &Env, from_pack: &str, from: &Manifest, to: &Manifest, allow_downgrade: bool) -> R<Facts>;
    fn idle(&self, env: &Env, from_pack: &str) -> R<Option<&'static str>>;
    fn world(&self, env: &Env, from_pack: &str, to_pack: &str) -> R<Box<dyn World>>;
    fn work(&self, j: &Journal, env: &Env) -> R<Box<dyn OpWork>>;
    /// Drops old databases. The CALLER holds `update.lock` exclusive and has read the journal; `protected` are the databases
    /// of the operation in flight (empty when the journal is known to be absent).
    fn housekeeping(&self, env: &Env, from_pack: &str, all_old: bool, protected: &BTreeSet<String>);
    /// A fence sidecar with no journal: restore the recorded start types and policy, then delete the sidecar.
    fn restore_leftover_fence(&self, _env: &Env) -> R<()> { Ok(()) }
    /// Minutes after LOCAL midnight right now (the OS clock with the offset in force at this instant, DST included).
    fn local_minute_of_day(&self) -> u32;
    fn sleep(&self, d: Duration) { std::thread::sleep(d) }
    /// The newest pack the feed offers, if newer than `current`: a plain GET of the feed document, no download, no install.
    fn peek_latest(&self, env: &Env, current: &str) -> Option<String>;
    /// Can this machine take the mandatory pre-update backup? Asked before the lock, so a refusal changes nothing.
    fn backup_available(&self, env: &Env, scheduled: bool) -> R<()>;
    fn secrets(&self, env: &Env) -> R<Vec<String>>;
    /// Keeps the machine awake until the returned guard drops (the Windows execution state is per thread: hold it on the thread that works).
    fn keep_awake(&self) -> Box<dyn std::any::Any>;
}

/// The shared deadline cell during a recovery: the recovery flag and nothing else. There is no end time: a store whose journal is open
/// is already down, so the clock never holds a recovery back. What bounds it is the per-statement cap (10 minutes, `statement_budget_ms`)
/// and the three attempts the scheduled tasks get.
pub(crate) fn recovery_cell() -> u64 { crate::update::work::RECOVERY_FLAG }

/// The context a recovery runs with: its `deadline_ms` IS the recovery cell, so `arm()` of every OpWork call re-stores the same
/// value instead of an operation deadline, and the runner's own checks (which compare it with now) never trip.
pub(crate) fn recovery_ctx(j: &Journal) -> OpCtx {
    let mut c = ctx_from_journal(j);
    c.deadline_ms = recovery_cell();
    c
}

/// After this many failed unattended recoveries the scheduled tasks stop trying and a person must take over.
pub const MAX_UNATTENDED_ATTEMPTS: usize = 3;
/// The boot Recover task retries LOCK_HELD this many times, 10 s apart.
pub const RECOVER_LOCK_RETRIES: usize = 5;
/// ... this many seconds apart.
pub const RECOVER_LOCK_RETRY_SECS: u64 = 10;

fn journal_error(e: JournalError) -> Report {
    match e {
        JournalError::Corrupt(m) => recovery_failed(OpCode::RecoveryNeeded, "JOURNAL_CORRUPT", &format!("the journal is unreadable: {m}; the tills stay fenced")),
        JournalError::TooNew(v) => recovery_failed(OpCode::RecoveryNeeded, "JOURNAL_TOO_NEW", &format!("journal schema {v} is newer than this posctl")),
        JournalError::Io(m) => recovery_failed(OpCode::RecoveryNeeded, "JOURNAL_IO", &m),
    }
}

/// FR19 fail closed, asked before anything else: can the update state (the journal and the fence marker in `state\update\`) be
/// read at all? Only NotFound means "nothing there". Anything else (the folder is SYSTEM + Administrators only: a caller that is
/// not elevated gets "access denied") is "state unknown", and the answer is RECOVERY_NEEDED (exit 17) with the way out in it.
fn state_gate_via(env: &Env, read: crate::ops::journal::ReadFn, exists: &dyn Fn(&std::path::Path) -> std::io::Result<bool>) -> Result<(), Report> {
    if let Err(JournalError::Io(m)) = Journal::read_roots_via(&env.roots, read) {
        return Err(journal_error(JournalError::Io(m)));
    }
    for p in [env.roots.fence_start_types(), env.roots.legacy_of(&env.roots.fence_start_types())] {
        if let Err(e) = exists(&p) {
            return Err(recovery_failed(OpCode::RecoveryNeeded, "STATE_UNREADABLE",
                &format!("cannot tell whether a previous operation left its service fence behind ({}: {e}); {}", p.display(), crate::ops::journal::NEEDS_ELEVATION)));
        }
    }
    Ok(())
}

/// A dry run reports an interrupted operation instead of recovering it, and starts nothing. It is not a pure read: it takes the
/// exclusive `update.lock` first, which may migrate legacy state files and re-apply the update folder's DACL (accepted behaviour).
fn dry_run_gate(env: &Env) -> Result<(), Report> {
    match Journal::read(&env.update_dir()) {
        Ok(None) => Ok(()),
        Err(e) => Err(journal_error(e)),
        Ok(Some(j)) => {
            let mut r = Report::new(OpCode::RecoveryNeeded, Some("RECOVERY_PENDING"),
                "dry run: an interrupted operation must be recovered first (`posctl update --recover`); nothing was changed",
                serde_json::json!({ "reason": "RECOVERY_PENDING", "dryRun": true, "recoveryPending": true, "kind": format!("{:?}", j.kind) }), false);
            r.journal = Some(crate::ops::journal::path(&env.update_dir()).display().to_string());
            Err(r)
        }
    }
}

fn recovery_failed(code: OpCode, reason: &str, msg: &str) -> Report { Report::new(code, Some(reason), msg, serde_json::json!({ "reason": reason }), false) }

/// A previous operation left its gateway or service fence behind: `state\update\fence-start-types.json` or `conf\Caddyfile.live`. Shared by
/// `update` and `switch run`, which both refuse to start on top of it (`update --recover` is the way out).
pub(crate) fn leftover_state_present(env: &Env) -> bool {
    env.roots.fence_start_types().try_exists().unwrap_or(true) || env.conf().join("Caddyfile.live").exists()
}
pub(crate) fn leftover_state_error() -> OpError {
    OpError::new(OpCode::Precondition, "LEFTOVER_STATE", "a previous operation left its gateway or service fence behind (state\\update\\fence-start-types.json or conf\\Caddyfile.live); run `posctl update --recover`")
}

/// What a recovery reports: the note, the recorded attempts, and a LOUD report when it rolled a switch back but the cloud store may be
/// marked moved (exit 17 with the exact `switch rollback` command; the caller returns it after the leftover-fence check).
/// The fourth element is what the recovered work noticed and survived (its warning codes): a quiet recovery reports them too.
type Recovery = (Option<String>, Vec<serde_json::Value>, Option<Report>, Vec<String>);

/// A switch that was rolled back here while its work warns the cloud may be moved. The warnings decide, not the reason: a rollback begun
/// at the live check keeps the stored reason, and a failure while re-activating carries that failure's reason.
fn loud_switch_report(j: &Journal, rolled_back: &str, warnings: &[String]) -> Option<Report> {
    if j.kind != OpKind::Switch { return None; }
    let w = crate::switch::work::loud_cloud_warning(warnings)?;
    let fix = format!("posctl switch rollback {}", j.op_id);
    Some(Report::new(OpCode::RecoveryNeeded, Some(w),
        &format!("the interrupted switch was rolled back on this server, but the cloud store may be marked moved: run `{fix}` with the cloud credentials to give it back"),
        serde_json::json!({ "reason": w, "rolledBackBecause": rolled_back, "opId": j.op_id, "fix": fix, "warnings": warnings }), false))
}

/// With the lock HELD: read the journal (never `peek`: it maps a corrupt or too-new journal to "none") and finish or undo it.
/// Returns the note and the recorded attempts; every failure carries the attempts in its data.
fn recover_locked(env: &Env, deps: &dyn Deps, by_hand: bool, guard: &crate::ops::lock::LockGuard) -> Result<Recovery, Report> {
    match Journal::read(&env.update_dir()) {
        Ok(None) => Ok((None, vec![], None, vec![])),
        Err(e) => Err(journal_error(e)),
        Ok(Some(mut j)) => {
            let journal_file = crate::ops::journal::path(&env.update_dir()).display().to_string();
            // Every attempt that really starts is written down (time and who). The scheduled tasks give up after three of their own
            // and change nothing more; a person at the console can always go on, and does not reset the count.
            let mut attempts = j.extra.get("recoverAttempts").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
            let with_attempts = |mut r: Report, at: &[serde_json::Value]| -> Report {
                if let Some(o) = r.data.as_object_mut() { o.insert("recoverAttempts".into(), serde_json::Value::Array(at.to_vec())); }
                r
            };
            if !by_hand && attempts.iter().filter(|a| a["by"] == "unattended").count() >= MAX_UNATTENDED_ATTEMPTS {
                let mut r = recovery_failed(OpCode::RecoveryNeeded, "RECOVERY_ATTEMPTS_EXHAUSTED", &format!("{MAX_UNATTENDED_ATTEMPTS} automatic recoveries failed; the tills stay fenced and nothing more will be tried automatically. Call support, or run `posctl update --recover` as an administrator"));
                r.journal = Some(journal_file);
                return Err(with_attempts(r, &attempts));
            }
            // The machine stays awake for the whole recovery (released on every way out, panic included). Same thread: the state is per thread.
            let _awake = deps.keep_awake();
            let mut work = work_for_deps(deps, &j, env).map_err(|e| with_attempts(Report::from_error(&e), &attempts))?;
            let from = j.pack_from.clone().unwrap_or_default();
            let to = j.pack_to.clone().unwrap_or_else(|| from.clone());
            deps.deadline_cell().store(recovery_cell(), Ordering::Relaxed);
            let mut w = deps.world(env, &from, &to).map_err(|e| with_attempts(Report::from_error(&e), &attempts))?;
            // Every gate has passed: only now does this run count. The attempt (time and who) is written down BEFORE the work starts,
            // so a run that dies in the middle of it is still counted.
            attempts.push(serde_json::json!({ "atMs": deps.now_ms(), "by": if by_hand { "hand" } else { "unattended" } }));
            if !j.extra.is_object() { j.extra = serde_json::json!({}); }
            j.extra["recoverAttempts"] = serde_json::Value::Array(attempts.clone());
            j.write(&env.update_dir()).map_err(|e| with_attempts(recovery_failed(OpCode::RecoveryNeeded, "JOURNAL_IO", &e.to_string()), &attempts))?;
            let mut rec = match recover(w.as_mut(), work.as_mut(), &recovery_ctx(&j), &mut j) {
                Ok(Recovered::Nothing) => (None, attempts.clone(), None, vec![]),
                Ok(Recovered::RolledBack { reason }) => {
                    record_recovery(env, deps, &j, &from, &to, Some(&reason));
                    let loud = loud_switch_report(&j, &reason, &work.warnings()).map(|r| with_attempts(r, &attempts));
                    (Some(format!("an interrupted operation was rolled back ({reason})")), attempts.clone(), loud, work.warnings())
                }
                Ok(Recovered::RolledForward) => {
                    record_recovery(env, deps, &j, &from, &to, None);
                    (Some("an interrupted operation was completed".into()), attempts.clone(), None, work.warnings())
                }
                // the journal stays open: the next recovery purges
                Err(e) => { let mut r = Report::from_error(&e); r.journal = Some(journal_file.clone()); return Err(with_attempts(r, &attempts)); }
            };
            // A killed switch never ran `StagingDir::drop`: its cloud password folder and cloud dump are still on disk. The lock is held
            // EXCLUSIVE, so no live switch owns them. A failed purge is LOUD (exit 17 with the path), never swallowed.
            if j.kind == OpKind::Switch {
                if let Err(e) = crate::switch::staging::purge(&env.roots, guard, None) {
                    rec.2 = Some(with_attempts(staging_purge_failed(rec.2.take(), &e), &attempts));
                }
            }
            Ok(rec)
        }
    }
}

/// A recovered switch whose cloud-password folder or cloud dump could not be removed. It holds the cloud database password, so it is exit 17
/// with the path. An existing loud report (the cloud may be moved) keeps its code and gains the staging failure; the journal is archived
/// by now, so `posctl status` (`SWITCH_STAGING_LEFTOVER`) keeps naming what is left until it is removed by hand.
fn staging_purge_failed(loud: Option<Report>, e: &OpError) -> Report {
    let note = format!("the switch's staging (the cloud password and the cloud dump) could not be removed: {}. Run `posctl update --recover` again as an administrator; if `posctl status` still shows SWITCH_STAGING_LEFTOVER, delete the named path by hand (the journal is archived, so --recover does nothing more)", e.message);
    match loud {
        Some(mut r) => {
            r.message = format!("{} Also: {note}", r.message);
            if let Some(o) = r.data.as_object_mut() { o.insert("stagingPurgeFailed".into(), serde_json::Value::String(e.message.clone())); }
            r
        }
        None => Report::new(OpCode::RecoveryNeeded, Some("SWITCH_STAGING_PURGE_FAILED"), &note,
            serde_json::json!({ "reason": "SWITCH_STAGING_PURGE_FAILED", "stagingPurgeFailed": e.message }), false),
    }
}
/// What the finished recovery did, in the same `update-result.json` a normal run writes (the lock is held). Rolled forward: the
/// update is `updated`, and the pending pack is cleared only when it is the one that was just installed. Rolled back: `rolled_back`
/// with the reason, and the pack stays pending.
fn record_recovery(env: &Env, deps: &dyn Deps, j: &Journal, from: &str, to: &str, rolled_back: Option<&str>) {
    // A restore is not an update event: writing it here would fake one and overwrite `last_code` (T10's UPDATE_BLOCKED reads it).
    // It records its own outcome in the backup state.
    if j.kind == OpKind::Restore {
        crate::backup::restore_work::record_recovered(env, j, rolled_back, (deps.now_ms() / 1000) as i64);
        return;
    }
    // Nor is a switch: its outcome is the journal archive, `switch-progress.json` and the mode in posctl.json. `last_code` here would
    // make a recovered switch read as an update that was rolled back or applied (and the pack pointers are the same pack twice).
    if j.kind == OpKind::Switch { return; }
    let state = env.update_dir();
    let mut res = UpdateResultFile::read(&state);
    res.last_at_ms = deps.now_ms();
    res.pack_from = Some(from.into());
    res.pack_to = Some(to.into());
    match rolled_back {
        None => {
            res.last_result = "updated".into(); res.last_code = "OK".into(); res.last_reason = None; res.last_message = None;
            if res.pending.as_ref().is_some_and(|p| p.pack_version == to) { res.clear_pending(); }
            if j.kind == OpKind::Update { RolledBack::clear(&env.roots.rolled_back_record()); } // the version went in after all
        }
        Some(reason) => {
            let code = code_for_reason(reason);
            res.last_result = "rolled_back".into(); res.last_code = code.name().into();
            res.last_reason = Some(reason.into()); res.last_message = Some(format!("an interrupted operation was rolled back ({reason})"));
            if j.kind == OpKind::Update && parks_version(code, reason, j.rollback_from) {
                let _ = RolledBack { pack_version: to.into(), since_ms: res.last_at_ms, code: code.name().into(), reason: Some(reason.into()) }.write(&env.roots.rolled_back_record());
            }
        }
    }
    let _ = res.write(&state);
}

/// Only a failure that the VERSION causes parks it (the scheduled check then skips it until a newer pack): a migration or verification
/// that failed, or the budget run out or a crash/kill after the backup (the same rule for both: the version's own work was under way).
/// A fence or backup failure, a failed clone, a precondition or the window say nothing about the version and are retried at the next window.
/// `began_from` is the journal step the rollback began from: `OpError::from` in the process that ran the update, `rollback_from` in a recovery.
fn parks_version(code: OpCode, reason: &str, began_from: Option<Step>) -> bool {
    match code {
        OpCode::MigrationFailed | OpCode::VerifyFailedRolledBack => true,
        OpCode::RolledBack => matches!(reason, "MAINTENANCE_BUDGET" | "RECOVERED_AFTER_INTERRUPTION") && began_from.is_some_and(|s| s >= Step::RepairCollation),
        _ => false,
    }
}

/// The journal keeps the REASON a rollback began with, not its code; this gives back the code that reason had (the exit code of the
/// run that failed). The reasons come from `update::work`'s own lists; any other reason is a plain ROLLED_BACK (16), which never parks.
fn code_for_reason(reason: &str) -> OpCode {
    use crate::update::work::{MIGRATION_REASONS, VERIFY_REASONS};
    if VERIFY_REASONS.contains(&reason) { OpCode::VerifyFailedRolledBack } else if MIGRATION_REASONS.contains(&reason) { OpCode::MigrationFailed } else { OpCode::RolledBack }
}
fn work_for_deps(deps: &dyn Deps, j: &Journal, env: &Env) -> R<Box<dyn OpWork>> {
    match j.kind {
        OpKind::Update => deps.work(j, env),
        _ => work_for(j, env),
    }
}

pub fn run(args: &UpdateArgs, env: &Env, deps: &dyn Deps) -> Report {
    // No scrubbing without the secrets, and no fallback to the pattern-only scrub. A command that changes things refuses before it
    // touches anything. `--recover` goes on (a store fenced for ever is worse than an unscrubbed recovery) and then says nothing
    // but codes: every string of its outcome is withheld.
    match deps.secrets(env) {
        Ok(secrets) => finalize(run_inner(args, env, deps, &secrets), &secrets),
        Err(_) if args.recover => withhold_text(run_inner(args, env, deps, &[])),
        Err(_) => Report::from_error(&OpError::new(OpCode::Precondition, "SECRETS_UNREADABLE", "the secret files cannot be read, so error text could not be scrubbed; nothing was changed")),
    }
}

/// Housekeeping outside any operation: the same door as `pack prune` (lock, then journal, then act). Another holder means
/// LOCK_HELD and nothing is dropped.
fn housekeeping_locked(env: &Env, deps: &dyn Deps, current: &str) -> R<()> {
    crate::update::prune::locked(env, "housekeeping", |j| {
        deps.housekeeping(env, current, false, &crate::update::prune::journal_names(j.map(|j| &j.db)));
        Ok(())
    })
}

fn op_id() -> String { crate::util::random_uuid_v4().unwrap_or_else(|_| "op".into()) }

/// Whether the lock's state can be told at all. Read-only: it creates nothing and deletes no holder's `.info`; the lock itself is
/// taken (and stale info cleaned) only by `acquire_for` right after.
fn lock_state_unknown(env: &Env) -> Option<String> {
    match probe_readonly_for(&env.roots) { LockState::Unknown(m) => Some(m), _ => None }
}

fn remember_pending_outside_window(env: &Env, deps: &dyn Deps) {
    let Ok(current) = deps.current_pack(env) else { return };
    let Some(latest) = deps.peek_latest(env, &current) else { return };
    let state = env.update_dir();
    // under the lock, journal read: never over a running operation's result file
    let _ = crate::update::prune::locked(env, "pending", |_| {
        let mut res = UpdateResultFile::read(&state);
        res.note_pending(&latest, "OUTSIDE_WINDOW", deps.now_ms(), false); // the feed document is unsigned
        let _ = res.write(&state);
        Ok(())
    });
}

fn hhmm(m: u32) -> String { format!("{:02}:{:02}", m / 60, m % 60) }

/// `Some(refusal)` when the local clock is outside the maintenance window right now. The window bounds when the FENCE starts, so
/// this is asked at the start of a scheduled run and again just before the operation lock (resolving and downloading take time).
fn outside_window(env: &Env, deps: &dyn Deps) -> Option<Report> {
    let w = crate::update::window::window_from(posctl_cfg(env).and_then(|c| c.maintenance.window).as_ref());
    let now = deps.local_minute_of_day();
    if crate::update::window::in_window(now, w) { return None; }
    Some(Report::new(OpCode::Precondition, Some("OUTSIDE_WINDOW"),
        &format!("outside the maintenance window ({}-{} local time, now {}); nothing was changed, the next scheduled run tries again", hhmm(w.0), hhmm(w.1), hhmm(now)),
        serde_json::json!({ "reason": "OUTSIDE_WINDOW", "windowStart": hhmm(w.0), "windowEnd": hhmm(w.1), "localTime": hhmm(now) }), true))
}

fn run_inner(args: &UpdateArgs, env: &Env, deps: &dyn Deps, secrets: &[String]) -> Report {
    let state = env.update_dir();
    // FR19 fail closed, before anything else: an update state that cannot be read is "in progress / unknown" (exit 17), never "idle".
    if let Err(r) = state_gate_via(env, &crate::ops::journal::fs_read, &|p: &std::path::Path| p.try_exists()) { return r; }
    // 0. the hard local-time window bounds when the FENCE may start: a PC that was off at 02:30 and boots at 09:00 must not fence the
    // tills as staff arrive. Only the scheduled, window-aware run is bound by it; a person who types `update` chose the moment. It never
    // holds a RECOVERY back: an open journal means the store is already down, so recovery (step 1) runs first, window or not, and only
    // then does a closed window refuse the update itself.
    let mut outside = if args.window_aware { outside_window(env, deps) } else { None };
    if let Some(r) = outside.take() {
        if matches!(Journal::read_roots(&env.roots), Ok(None)) {
            // The hourly check still LOOKS at the feed (a plain GET, nothing installed) and remembers a newer pack, so that
            // PACK_UPDATE_AVAILABLE ages from the first sighting even when the store is never inside its window at check time.
            if !args.dry_run { remember_pending_outside_window(env, deps); }
            return r;
        }
        outside = Some(r);
    }
    // A lock whose state cannot be read is NOT free.
    if let Some(m) = lock_state_unknown(env) {
        return Report::from_error(&OpError::new(OpCode::Precondition, "LOCK_STATE_UNKNOWN", format!("cannot tell whether another operation runs: {m}")));
    }
    // 1. recovery first: take the lock EXCLUSIVE, and only then read the journal
    // The boot Recover task retries a held lock (the status writer or a prune may hold it for an instant): 5 times, 10 s apart.
    let mut retries = 0;
    let guard = loop {
        match acquire_for(&env.roots, LockMode::Exclusive, "update", &op_id(), Duration::from_secs(0)) {
            Ok(g) => break g,
            Err(e) if e.code == OpCode::LockHeld && args.recover && args.scheduled && retries < RECOVER_LOCK_RETRIES => {
                retries += 1;
                deps.sleep(Duration::from_secs(RECOVER_LOCK_RETRY_SECS));
            }
            Err(e) => return Report::from_error(&e),
        }
    };
    let (note, attempts, loud, rwarn) = if args.dry_run {
        match dry_run_gate(env) { Ok(()) => (None, vec![], None, vec![]), Err(r) => return r }
    } else {
        match recover_locked(env, deps, !args.scheduled, &guard) { Ok(n) => n, Err(r) => return r }
    };
    // No journal now (none, or recovery just finished it). A fence sidecar or a set-aside live Caddyfile that is still here means a
    // prior operation ended uncleanly: another update would record the fence's own `demand` as the original start types, or stay in
    // maintenance for ever. `--recover` is the way out: it restores both, and only then are the files deleted.
    if leftover_state_present(env) {
        // a loud switch report (exit 17, the cloud may be moved) is never lost to a leftover fence: it wins, and carries the leftover's reason
        let with_leftover = |mut r: Report, why: &str| -> Report {
            if let Some(o) = r.data.as_object_mut() { o.insert("leftoverState".into(), serde_json::Value::String(why.to_string())); }
            r
        };
        if !args.recover {
            let e = leftover_state_error();
            return match loud { Some(r) => with_leftover(r, &e.reason), None => Report::from_error(&e) };
        }
        if let Err(e) = deps.restore_leftover_fence(env) {
            return match loud { Some(r) => with_leftover(r, &e.reason), None => Report::from_error(&e) };
        }
    }
    drop(guard);
    // a switch rolled back here whose cloud store may be moved: loud (17), and nothing else runs on top of it
    if let Some(r) = loud { return r; }
    if let Some(mut r) = outside {
        // a recovery (if there was one) is done; the update itself waits for the window
        if !args.dry_run { remember_pending_outside_window(env, deps); }
        // a scheduled run that recovered reports RECOVERED below (exit 0) whatever the hour; anything else is refused
        if !(args.scheduled && note.is_some()) {
            if let (Some(n), Some(o)) = (&note, r.data.as_object_mut()) { o.insert("recoveryNote".into(), serde_json::Value::String(n.clone())); }
            return r;
        }
    }
    if args.recover {
        return Report::new(OpCode::Ok, None, note.as_deref().unwrap_or("nothing to recover"), serde_json::json!({ "recovered": note.is_some(), "recoverAttempts": attempts, "recoveryWarnings": rwarn }), false);
    }
    // A SCHEDULED run that just recovered a journal stops here: the next hourly run resolves and applies the update, so one task run is
    // never a recovery plus a whole update (the UpdateCheck time limit relies on it, `update::limits`). A hand `posctl update` that
    // meets a journal recovers it and then goes on to update in the same run, as before; a hand `--recover` returned above.
    if let (true, Some(n)) = (args.scheduled, &note) {
        return Report::new(OpCode::Ok, Some("RECOVERED"), n, serde_json::json!({
            "updated": false, "reason": "RECOVERED", "recovered": true, "recoveryNote": n, "recoverAttempts": attempts, "recoveryWarnings": rwarn,
        }), false);
    }
    let result = (|| -> Result<Report, OpError> {
        let current = deps.current_pack(env)?;
        let mut res = UpdateResultFile::read(&state);

        // 2. which pack
        let Some(target) = deps.resolve_target(args, env, &current)? else {
            // nothing to install: a plain `update` says so; `--if-available` is the "only if" form and succeeds
            if !args.if_available {
                return Err(OpError::new(OpCode::Precondition, "NO_PACK", "there is no pack to install (none given, none bundled, none newer in the feed); `--if-available` treats this as success"));
            }
            // old databases are dropped only inside the window and while the store is idle, like the update itself
            if !args.dry_run {
                let idle_ok = !args.window_aware || matches!(deps.idle(env, &current), Ok(None));
                if idle_ok { let _ = housekeeping_locked(env, deps, &current); }
            }
            return Ok(Report::new(OpCode::Ok, None, "no newer pack", serde_json::json!({ "updated": false, "reason": "NO_UPDATE", "packCurrent": current }), false));
        };
        // A version that rolled back is not tried again by the scheduled check (hourly in the window, every night): it would fence the
        // tills for nothing, over and over. A newer pack is a different version and goes ahead; a person typing `update` may retry.
        if args.scheduled && RolledBack::read(&env.roots.rolled_back_record()).is_some_and(|r| r.pack_version == target) {
            return Ok(Report::new(OpCode::Ok, Some("SKIPPED_ROLLED_BACK"), "skipped: this version already rolled back; waiting for a newer pack (`posctl update` retries it by hand)",
                serde_json::json!({ "updated": false, "skipped": true, "reason": "SKIPPED_ROLLED_BACK", "packTo": target }), false));
        }
        let (from, to) = deps.manifests(env, &current, &target)?;

        // 3. prechecks (nothing is changed yet); a refusal is recorded unless this is a dry run
        // the backup check is part of the prechecks: it must refuse BEFORE the lock, the journal and the fence
        let facts = match deps.precheck(env, &current, &from, &to, args.allow_downgrade).and_then(|f| deps.backup_available(env, args.scheduled).map(|()| f)) {
            Ok(f) => f,
            Err(e) => {
                if !args.dry_run {
                    res.last_at_ms = deps.now_ms(); res.last_result = "refused".into(); res.last_code = e.code.name().into();
                    res.last_reason = Some(e.reason.clone()); res.last_message = Some(scrub(&e.message, secrets));
                    res.pack_from = Some(current.clone()); res.pack_to = Some(target.clone());
                    let _ = res.write(&state);
                }
                return Err(e);
            }
        };

        // 4. is the store idle?
        let idle = if args.window_aware {
            match deps.idle(env, &current) {
                Ok(v) => v.map(str::to_string),
                Err(_) => Some("DB_UNREACHABLE".to_string()), // can't tell: don't gamble
            }
        } else { None };
        if let Some(reason) = idle {
            // resolve_target fetched/installed this pack through the signature check
            if !args.dry_run { res.note_pending(&target, &reason, deps.now_ms(), true); let _ = res.write(&state); }
            return Ok(Report::new(OpCode::Ok, None, "update deferred: the store is trading", serde_json::json!({ "updated": false, "skipped": true, "reason": reason, "packTo": target }), false));
        }

        // 5. dry run stops here: nothing was fenced, written or connected for writing
        let budget_s = budget_seconds(args.max_maintenance_seconds, conf_max_seconds(env));
        if args.dry_run {
            return Ok(Report::new(OpCode::Ok, None, "dry run: nothing was changed", serde_json::json!({
                "updated": false, "dryRun": true, "wouldUpdate": true, "packFrom": current, "packTo": target,
                "pendingMigrations": facts.pending, "dbBytes": facts.db_bytes, "freeBytes": facts.free,
                "dropsOldCopiesFirst": facts.need_drop_old, "maintenanceBudgetSeconds": budget_s,
                "steps": ["fence", "backup", "repair-collation", "clone", "migrate", "verify-clone", "swap", "activate", "verify-live", "reopen"],
            }), false));
        }

        // 6. the operation: the lock again (exclusive), and a journal that is still absent
        let _lock = acquire_for(&env.roots, LockMode::Exclusive, "update", &op_id(), Duration::from_secs(OPERATION_LOCK_WAIT_SECS))?;
        if Journal::read(&state).map_err(|e| OpError::new(OpCode::RecoveryNeeded, "JOURNAL_UNREADABLE", format!("{e:?}")))?.is_some() {
            return Err(OpError::new(OpCode::Precondition, "LEFTOVER_STATE", "another operation left a journal behind; run `posctl update --recover`"));
        }
        // From here to the end of the operation the machine may not sleep: taken right after the lock, before anything is fenced, and
        // dropped on every exit, error and panic unwind included, BEFORE `_lock` (locals drop in reverse order of declaration and `_lock`
        // was declared first), so the lock is the last thing released. The execution state is per thread, and the whole operation runs on this one.
        let _awake = deps.keep_awake();
        // The prechecks ran without the lock: the window may have closed while the pack was resolved and downloaded (it stays
        // installed for the next window), and another operation may have switched the pack. Nothing is journalled for either.
        if args.window_aware { if let Some(r) = outside_window(env, deps) { return Ok(r); } }
        if deps.current_pack(env)? != current {
            let mut e = OpError::new(OpCode::Precondition, "PACK_CHANGED", "the installed pack changed while the update was being prepared; nothing was changed, run it again");
            e.retryable = true;
            return Err(e);
        }
        let t0 = deps.now_ms();
        let deadline = t0 + budget_s * 1000;
        if facts.need_drop_old { deps.housekeeping(env, &current, true, &protected_by_journal(&state)); } // lock held
        window_open(deadline, deps.now_ms())?;
        let op = op_id();
        let journal = Journal::new(OpKind::Update, &op, t0, deadline, Some(current.clone()), Some(target.clone()));
        let ctx = OpCtx { op_id: op, names: journal.db.clone(), pack_from: journal.pack_from.clone(), pack_to: journal.pack_to.clone(), deadline_ms: deadline };
        deps.deadline_cell().store(deadline, Ordering::Relaxed);
        let mut work = deps.work(&journal, env)?;
        let mut w = deps.world(env, &current, &target)?;
        let out = run_operation(w.as_mut(), work.as_mut(), &ctx, journal);
        let ws: Vec<String> = [work.warnings(), w.warnings()].concat();
        match out {
            Ok(o) => {
                deps.housekeeping(env, &current, false, &crate::update::prune::journal_names(Some(&ctx.names))); // lock held; the runner archived the journal, so the op's own databases are named from its context
                res = UpdateResultFile { last_at_ms: deps.now_ms(), last_result: "updated".into(), last_code: "OK".into(), pack_from: Some(current.clone()), pack_to: Some(target.clone()), ..Default::default() };
                let _ = res.write(&state);
                RolledBack::clear(&env.roots.rolled_back_record());
                Ok(Report::new(OpCode::Ok, None, "updated", serde_json::json!({
                    "updated": true, "packFrom": current, "packTo": target, "prevDb": o.prev_db,
                    "warnings": ws, "timingsMs": o.timings.items, "fencedMs": deps.now_ms().saturating_sub(t0), "dbBytes": facts.db_bytes,
                }), false))
            }
            Err(e) => {
                res.last_at_ms = deps.now_ms();
                res.last_result = if e.code == OpCode::RecoveryNeeded { "failed" } else { "rolled_back" }.into();
                res.last_code = e.code.name().into(); res.last_reason = Some(e.reason.clone());
                res.last_message = Some(scrub(&e.message, secrets));
                if parks_version(e.code, &e.reason, e.from) {
                    // a clean rollback caused by the version; a failed one is the journal's business (recovery), and a fence/backup/clone failure is retried
                    let _ = RolledBack { pack_version: target.clone(), since_ms: res.last_at_ms, code: e.code.name().into(), reason: Some(e.reason.clone()) }.write(&env.roots.rolled_back_record());
                }
                res.pack_from = Some(current); res.pack_to = Some(target);
                let _ = res.write(&state);
                let mut r = Report::from_error(&e);
                r.data = serde_json::json!({ "updated": false, "reason": e.reason, "warnings": ws });
                if e.code == OpCode::RecoveryNeeded { r.journal = Some(crate::ops::journal::path(&state).display().to_string()); }
                Ok(r)
            }
        }
    })();
    let mut rep = match result { Ok(r) => r, Err(e) => Report::from_error(&e) };
    // the recovery that ran first is part of this run's story, and so are its attempts
    if let Some(o) = rep.data.as_object_mut() {
        if let Some(n) = &note { o.insert("recoveryNote".into(), serde_json::Value::String(n.clone())); }
        if !rwarn.is_empty() { o.insert("recoveryWarnings".into(), serde_json::json!(rwarn)); }
        if !attempts.is_empty() { o.insert("recoverAttempts".into(), serde_json::Value::Array(attempts)); }
    }
    rep
}

/// The databases the journal on disk names (empty when there is none or it cannot be read): never a free-for-all drop.
fn protected_by_journal(state: &std::path::Path) -> BTreeSet<String> {
    match Journal::read(state) { Ok(Some(j)) => crate::update::prune::journal_names(Some(&j.db)), _ => BTreeSet::new() }
}

fn posctl_cfg(env: &Env) -> Option<crate::config::PosctlJson> { crate::config::PosctlJson::load(&env.roots).ok().flatten() }
fn conf_max_seconds(env: &Env) -> Option<u64> { posctl_cfg(env).map(|c| u64::from(c.maintenance.max_seconds)) }

// ---- production ----

/// What `posctl update` runs on: WindowsScm, the FR4 activator, SERVICE_DB_ROLES, the PGDATA volume, one deadline atomic.
pub struct RealDeps {
    deadline: Arc<AtomicU64>,
    /// Tests: a fake psql instead of the pack's.
    #[cfg(test)]
    pub(crate) psql_override: Option<std::path::PathBuf>,
}
impl RealDeps {
    pub fn new() -> RealDeps {
        RealDeps { deadline: Arc::new(AtomicU64::new(u64::MAX)), #[cfg(test)] psql_override: None }
    }
}
impl Default for RealDeps { fn default() -> Self { Self::new() } }

/// `cli-<verb>-<verb>` only: a path or URL argument is data, never a file name (`C:\...` made sub-folders File::create could not open).
fn child_log_prefix(logs: &std::path::Path, args: &[&str]) -> std::path::PathBuf {
    let word = |s: Option<&&str>| -> String { s.map(|a| a.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()).unwrap_or_default() };
    logs.join(format!("cli-{}-{}", word(args.first()), word(args.get(1))))
}

/// A failed child keeps its own result code (a child's LOCK_HELD is a LOCK_HELD, retryable); one this build does not know, or a
/// timeout, stays a pack problem.
fn child_failure(v: &serde_json::Value, timed_out: bool) -> OpError {
    let reason = v["data"]["reason"].as_str().or(v["code"].as_str()).unwrap_or("CLI_FAILED").to_string();
    let message = v["message"].as_str().unwrap_or("").to_string();
    let known = [OpCode::LockHeld, OpCode::Precondition, OpCode::PackInvalid, OpCode::MigrationFailed, OpCode::VerifyFailedRolledBack, OpCode::RolledBack, OpCode::RecoveryNeeded];
    let code = v["exit"].as_i64().filter(|_| !timed_out).and_then(|e| known.into_iter().find(|c| i64::from(c.exit()) == e)).unwrap_or(OpCode::PackInvalid);
    OpError::new(code, &reason, message)
}

fn now_wall_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

impl RealDeps {
    /// EVERY psql wrapper of this process reads the same deadline cell, through the per-class statement caps.
    fn admin(&self, env: &Env, from_pack: &str) -> PsqlAdmin {
        let d = self.deadline.clone();
        let psql = env.pack_dir(from_pack).join("pg").join("bin").join("psql.exe");
        #[cfg(test)]
        let psql = self.psql_override.clone().unwrap_or(psql);
        PsqlAdmin::new(psql, env.ports.pg(), env.secrets().join("pgpass.conf"))
            .with_budget(move |class| statement_budget_ms(class, d.load(Ordering::Relaxed), now_wall_ms()))
    }
    fn db(&self, env: &Env, from_pack: &str) -> RealDb { RealDb { admin: self.admin(env, from_pack) } }
    fn cli_json(&self, env: &Env, args: &[&str], secs: u64) -> R<serde_json::Value> {
        let mut c = Command::new(&env.posctl_exe);
        c.args(cli_args(env, args));
        let prefix = child_log_prefix(&env.logs_ops(), args);
        let r = run_with_timeout(c, &prefix, Duration::from_secs(secs))?;
        let out = std::fs::read_to_string(prefix.with_extension("out.log")).unwrap_or_default();
        let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|_| OpError::err("CLI_OUTPUT", format!("`posctl {}` printed no JSON", args.join(" "))))?;
        if r.timed_out || r.code != Some(0) { return Err(child_failure(&v, r.timed_out)); }
        Ok(v)
    }
}

/// The argument list of a posctl child: the subcommand, then the global flags that point it at this process's store (roots only under `--dev`).
fn cli_args(env: &Env, args: &[&str]) -> Vec<String> {
    let mut a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    a.extend(crate::switch::photos::global_args(&env.data, &env.program, env.roots.dev));
    a
}

/// The feed branch of `resolve_target`. `pack fetch` downloads the whole pack (~250 MB) BEFORE it looks at what is installed, and an
/// in-window run that ends deferred comes back every hour, so peek first (one small GET): when the feed's version is the running one,
/// or is already installed and verified, there is nothing to download. A failed peek falls through to the fetch, as before.
fn resolve_from_feed(current: &str, installed: &[(String, bool)], peek: &dyn Fn() -> Option<String>, fetch: &dyn Fn() -> R<String>) -> R<Option<String>> {
    if let Some(latest) = peek() {
        if latest == current { return Ok(None); }
        if installed.iter().any(|(v, ok)| *ok && *v == latest) { return Ok(Some(latest)); }
    }
    let latest = fetch()?;
    Ok(if latest == current { None } else { Some(latest) })
}

/// The bundle-then-feed order of `resolve_target`. `skip` is the version the scheduled run must not take again (the rolled-back one);
/// a skipped bundle is NOT installed, the feed is consulted, and when nothing else is newer `Some(skip)` comes back so `run` answers
/// SKIPPED_ROLLED_BACK. With a skip set, a missing feed URL counts as "no candidate" (a hand run keeps the NO_FEED error).
fn resolve_bundle_then_feed(current: &str, skip: Option<&str>, bundle_version: Option<&str>, install_bundle: &dyn Fn() -> R<()>, feed: &dyn Fn() -> R<Option<String>>) -> R<Option<String>> {
    let mut parked = None;
    if let (Some(bv), Some(kc)) = (bundle_version, pack_version_key(current)) {
        if pack_version_key(bv).is_some_and(|kb| kb > kc) {
            if skip != Some(bv) { install_bundle()?; return Ok(Some(bv.to_string())); }
            parked = Some(bv.to_string());
        }
    }
    match feed() {
        Err(e) if skip.is_some() && e.reason == "NO_FEED" => Ok(parked),
        Err(e) => Err(e),
        Ok(None) => Ok(parked),
        Ok(Some(v)) => Ok(Some(v)),
    }
}

impl Deps for RealDeps {
    fn now_ms(&self) -> u64 { now_wall_ms() }
    fn deadline_cell(&self) -> Arc<AtomicU64> { self.deadline.clone() }
    fn current_pack(&self, env: &Env) -> R<String> {
        posctl_cfg(env).map(|c| c.pack.current).ok_or_else(|| OpError::new(OpCode::Precondition, "NOT_PROVISIONED", "conf\\posctl.json has no pack.current"))
    }
    fn resolve_target(&self, args: &UpdateArgs, env: &Env, current: &str) -> R<Option<String>> {
        if args.dry_run {
            // a dry run installs and fetches nothing: only what is already installed (and valid) can be the target
            if let Some(p) = &args.pack {
                if p.ends_with(".pospack") || p.contains('\\') || p.contains('/') {
                    return Err(OpError::new(OpCode::Precondition, "DRY_RUN_NEEDS_INSTALLED_PACK", "dry run: a pack file is not installed in a dry run; run `posctl pack install` first or drop --dry-run"));
                }
                return Ok(Some(p.clone()));
            }
            let cur = pack_version_key(current);
            return Ok(crate::packcmd::list(&env.roots).into_iter().filter(|(_, ok)| *ok).map(|(v, _)| v)
                .filter(|v| pack_version_key(v).zip(cur).is_some_and(|(a, b)| a > b))
                .max_by_key(|v| pack_version_key(v)));
        }
        if let Some(p) = &args.pack {
            if p.ends_with(".pospack") || p.contains('\\') || p.contains('/') {
                let v = self.cli_json(env, &["pack", "install", "--file", p], PACK_INSTALL_TIMEOUT_SECS)?;
                return Ok(v["data"]["packVersion"].as_str().map(str::to_string));
            }
            return Ok(Some(p.clone()));
        }
        // The installer bundles the pack of an app update at `<program>\backend.pospack`: read it FIRST; only when it is not
        // newer than the running pack fall through to the feed (which stays for -rN hotfixes).
        let bundled = env.program.join("backend.pospack");
        // The version is read from the VERIFIED pack (signature against the updater key and every file hash; nothing installed or extracted):
        // an unreadable or unsigned bundle is no candidate. It is installed only when it is the one chosen.
        let bundle_version = if bundled.exists() { crate::packcmd::process_zip(&bundled, &crate::packcmd::updater_pubkey(), None).ok().map(|m| m.pack_version) } else { None };
        // a scheduled run does not take the version that already rolled back again (a newer pack from the feed is a different version)
        let skip = if args.scheduled { RolledBack::read(&env.roots.rolled_back_record()).map(|r| r.pack_version) } else { None };
        resolve_bundle_then_feed(
            current,
            skip.as_deref(),
            bundle_version.as_deref(),
            &|| self.cli_json(env, &["pack", "install", "--file", &bundled.to_string_lossy()], PACK_INSTALL_TIMEOUT_SECS).map(|_| ()),
            &|| {
                let feed = posctl_cfg(env).and_then(|c| c.pack.feed_url)
                    .ok_or_else(|| OpError::new(OpCode::Precondition, "NO_FEED", "pack.feedUrl is not set"))?;
                resolve_from_feed(
                    current,
                    &crate::packcmd::list(&env.roots),
                    &|| crate::packcmd::peek_latest(&env.roots, &feed).ok(),
                    &|| {
                        let v = self.cli_json(env, &["pack", "fetch", "--feed", &feed], PACK_FETCH_TIMEOUT_SECS)?;
                        Ok(v["data"]["latest"].as_str().unwrap_or(current).to_string())
                    },
                )
            },
        )
    }
    fn manifests(&self, env: &Env, from: &str, to: &str) -> R<(Manifest, Manifest)> {
        Ok((Manifest::read(&env.pack_dir(from))?, Manifest::read(&env.pack_dir(to))?))
    }
    fn precheck(&self, env: &Env, from_pack: &str, from: &Manifest, to: &Manifest, allow_downgrade: bool) -> R<Facts> {
        let db = self.db(env, from_pack);
        let to_dir = env.pack_dir(&to.pack_version);
        let applied: BTreeSet<String> = db.admin.scalar("postgres", crate::update::precheck::APPLIED_SQL)?
            .lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        let in_pack: BTreeSet<String> = std::fs::read_dir(to_dir.join("migrations")).map_err(|e| OpError::new(OpCode::PackInvalid, "MIGRATIONS_UNREADABLE", e.to_string()))?
            .flatten().filter_map(|e| e.file_name().to_string_lossy().split_once('_').map(|(v, _)| v.to_string())).collect();
        check_rules(from, to, &applied, &in_pack, allow_downgrade)?;
        verify_files(&to_dir, to, &["migrations/", "sql/", "tools/supabase.exe", "bin/auth.exe"])?;
        let pending = pending_migrations(&to_dir, &applied)?;
        forbid_cluster_changes(&pending)?;
        let pre = |what: &str, m: String| OpError::new(OpCode::Precondition, what, m);
        if !env.conf().join("Caddyfile.maintenance").exists() { return Err(pre("MAINTENANCE_CADDYFILE_MISSING", "conf\\Caddyfile.maintenance is missing".into())); }
        let names = db.names()?;
        if env.conf().join("Caddyfile.live").exists() || names.contains(crate::ops::names::NEXT) {
            return Err(pre("LEFTOVER_STATE", "a previous operation left state behind; run `posctl update --recover`".into()));
        }
        let db_bytes = db.size_bytes("postgres")?;
        let droppable: u64 = names.iter().filter(|n| (n.starts_with("pos_prev_") || n.starts_with("pos_failed_")) && crate::ops::names::valid_ident(n)).filter_map(|n| db.size_bytes(n).ok()).sum();
        let free = free_bytes(&env.roots.pgdata())?; // the volume that holds the data, never the exe's or the cwd's
        let need_drop_old = disk_check(free, db_bytes, droppable)?;
        // the run-order steps this update re-runs: pinned, superuser ones frozen, no meta-commands (FR5b item 3)
        check_steps(&env.pack_dir(from_pack), &to_dir, from, to)?;
        // a replication slot keeps WAL for ever and can make the rollback's DROP refuse: no update while one exists
        slot_gate(&db.admin.scalar_class("template1", crate::update::precheck::SLOT_COUNT_SQL, crate::ops::swap::StmtClass::Quick)?)?;
        Ok(Facts { db_bytes, free, need_drop_old, pending: pending.into_iter().map(|(v, _)| v).collect() })
    }
    fn idle(&self, env: &Env, from_pack: &str) -> R<Option<&'static str>> {
        Ok(verdict(&parse_idle(&self.db(env, from_pack).admin.scalar("postgres", IDLE_SQL)?)?))
    }
    fn world(&self, env: &Env, from_pack: &str, to_pack: &str) -> R<Box<dyn World>> {
        Ok(crate::ops::hooked::wrap(RealWorld::new(self.cfg_for(env, from_pack, to_pack), production_backup(env, from_pack))))
    }
    fn work(&self, j: &Journal, env: &Env) -> R<Box<dyn OpWork>> {
        Ok(Box::new(UpdateWork::from_journal_with(j, env, self.deadline.clone())?))
    }
    fn housekeeping(&self, env: &Env, from_pack: &str, all_old: bool, protected: &BTreeSet<String>) {
        let _ = crate::update::prune::drop_old_dbs(&RealPrune { db: self.db(env, from_pack) }, protected, all_old); // best effort; `pack prune` reports
    }
    fn restore_leftover_fence(&self, env: &Env) -> R<()> {
        let current = posctl_cfg(env).map(|c| c.pack.current).ok_or_else(|| OpError::new(OpCode::Precondition, "NOT_PROVISIONED", "conf\\posctl.json has no pack.current"))?;
        crate::ops::fence::complete_unfence(&RealLeftover { d: self, env, current })
    }
    fn backup_available(&self, env: &Env, scheduled: bool) -> R<()> {
        let pack = self.current_pack(env).map_err(|e| OpError::new(OpCode::Precondition, "BACKUP_UNAVAILABLE", e.message))?;
        backup_gate(env, &pack, scheduled)
    }
    fn peek_latest(&self, env: &Env, current: &str) -> Option<String> {
        let feed = posctl_cfg(env).and_then(|c| c.pack.feed_url)?;
        let latest = crate::packcmd::peek_latest(&env.roots, &feed).ok()?;
        pack_version_key(&latest).zip(pack_version_key(current)).is_some_and(|(a, b)| a > b).then_some(latest)
    }
    fn keep_awake(&self) -> Box<dyn std::any::Any> { Box::new(crate::awake::KeepAwake::new()) }
    fn local_minute_of_day(&self) -> u32 { crate::update::window::os_local_minute_of_day() }
    fn secrets(&self, env: &Env) -> R<Vec<String>> {
        load_all_secrets(&env.roots, &env.secrets().join("pgpass.conf"))
    }
}

/// Finishing a fence that no journal explains (the operation finalized; only its unfence died): the real machine behind
/// `ops::fence::complete_unfence`. The live database is the final one, so the stack is started and probed BEFORE the gateway goes live.
struct RealLeftover<'a> { d: &'a RealDeps, env: &'a Env, current: String }
impl RealLeftover<'_> {
    fn scm(&self) -> crate::ops::fence::WindowsScm { crate::ops::fence::WindowsScm }
    fn sidecar(&self) -> std::path::PathBuf { self.env.roots.fence_start_types() }
    fn wait(&self, what: &str, secs: u64, mut ok: impl FnMut() -> bool) -> R<()> {
        let t = std::time::Instant::now();
        while t.elapsed() < Duration::from_secs(secs) { if ok() { return Ok(()); } std::thread::sleep(Duration::from_millis(500)); }
        Err(OpError::err("WAIT_TIMEOUT", format!("{what} not ready after {secs} s")))
    }
}
impl crate::ops::fence::LeftoverSteps for RealLeftover<'_> {
    fn roles_login(&self) -> R<()> {
        use crate::ops::fence::Scm;
        self.scm().start(crate::services::Component::Postgres)?;
        let db = self.d.db(self.env, &self.current);
        self.wait("postgres", 120, || db.admin.scalar("template1", "SELECT 1").is_ok())?;
        let roles: Vec<String> = crate::ops::fence::SERVICE_DB_ROLES.iter().map(|r| r.to_string()).collect();
        db.set_login(&roles, true)
    }
    fn start_stack(&self) -> R<()> {
        use crate::ops::fence::Scm;
        for c in crate::ops::fence::START_ORDER { self.scm().start(c)?; }
        Ok(())
    }
    fn probe_stack(&self) -> R<()> { self.wait("Auth, Rest and Functions", 90, || crate::ops::real::stack_healthy_on(&self.env.ports)) }
    fn gateway_live(&self) -> R<()> {
        let (act, roots, cur) = (self.env.activate.clone(), self.env.roots.clone(), self.current.clone());
        // a torn live file is re-rendered with the same activation the update uses, never restored as it is
        crate::ops::fence::restore_leftover_gateway(&self.env.conf(), &self.scm(), &|| act(&roots, &cur, false))
    }
    fn restore_policy(&self) -> R<()> { crate::ops::fence::scm_unfence_keep(&self.scm(), &self.sidecar()).map(|_| ()) }
    fn delete_markers(&self) -> R<()> {
        match std::fs::remove_file(self.sidecar()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(OpError::err("FENCE_TYPES_IO", e.to_string())),
            _ => {}
        }
        crate::ops::fence::CaddyFiles { conf: self.env.conf() }.drop_marker()
    }
}

/// `pack prune` and housekeeping against the real server.
pub struct RealPrune { pub db: RealDb }
impl crate::update::prune::PruneDeps for RealPrune {
    fn now_ms(&self) -> u64 { now_wall_ms() }
    fn db_names(&self) -> R<BTreeSet<String>> { self.db.names() }
    fn drop_db(&self, name: &str) -> R<()> { self.db.drop_db(name) }
    fn pack_pointers(&self, env: &Env) -> R<BTreeSet<String>> {
        let c = posctl_cfg(env).ok_or_else(|| OpError::new(OpCode::Precondition, "NOT_PROVISIONED", "conf\\posctl.json has no pack pointers; nothing is pruned"))?;
        Ok([Some(c.pack.current), c.pack.previous].into_iter().flatten().collect())
    }
}

impl RealDeps {
    /// The production RealCfg: WindowsScm, the FR4 activator (the one `on_commit` also uses), SERVICE_DB_ROLES, and a db
    /// admin on the SHARED deadline like every other psql wrapper.
    pub(crate) fn cfg_for(&self, env: &Env, from_pack: &str, to_pack: &str) -> RealCfg {
        RealCfg {
            roots: env.roots.clone(),
            activate: activator_from(env.activate.clone()),
            scm: Box::new(crate::ops::fence::WindowsScm),
            caddy_exe: env.pack_dir(to_pack).join("bin").join("caddy.exe"),
            ports: env.ports,
            db: self.db(env, from_pack),
            fence_roles: crate::ops::fence::SERVICE_DB_ROLES.iter().map(|s| s.to_string()).collect(),
            free_bytes,
        }
    }
}

impl Env {
    /// The machine as `posctl.json` describes it. The activation function is the one the world's `activate_pack` uses.
    pub fn production(roots: &crate::paths::Roots, rt: std::rc::Rc<dyn crate::runtime::Runtime>) -> Result<Env, PosctlError> {
        let cfg = crate::config::PosctlJson::load(roots).map_err(PosctlError::error)?
            .ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
        let ports = crate::ports::Ports::new(cfg.ports.base).map_err(PosctlError::error)?;
        let posctl_exe = std::env::current_exe().map_err(|e| PosctlError::error(format!("cannot locate posctl.exe: {e}")))?;
        Ok(Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe, ports, roots: roots.clone(), activate: conf_activate_fn(rt) })
    }
}

/// First check of every machine-touching CLI entry: an Administrator (a `--dev` root is exempt), then a provisioned PC. A standard
/// user cannot see ProgramData, so the provisioned file always looks missing to them: elevation has to answer first.
pub(crate) fn gate(roots: &crate::paths::Roots, elevated: bool) -> Result<(), PosctlError> {
    if !roots.dev && !elevated {
        return Err(PosctlError::new(Code::NotElevated, "this command must run as an administrator"));
    }
    if !roots.provisioned_json().exists() {
        return Err(PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"));
    }
    Ok(())
}

/// The CLI entry: not elevated -> exit 3, then not provisioned -> exit 4 (a dev root skips the elevation check); a dev root never reaches the real Windows services.
pub fn run_cli(roots: &crate::paths::Roots, dev: bool, a: &UpdateArgs) -> Result<Outcome, PosctlError> {
    run_cli_as(roots, dev, a, crate::sys::is_elevated())
}

fn run_cli_as(roots: &crate::paths::Roots, dev: bool, a: &UpdateArgs, elevated: bool) -> Result<Outcome, PosctlError> {
    gate(roots, elevated)?;
    if dev {
        return Err(PosctlError::new(Code::Usage, "update registers services and swaps databases and cannot run with --dev"));
    }
    let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
    Ok(run(a, &env, &RealDeps::new()).into_outcome())
}

/// `posctl dev sql-smoke` (test-hooks builds only): the product's own SQL against this PC's live cluster, one JSON result per statement.
#[cfg(feature = "test-hooks")]
pub fn sql_smoke_cli(roots: &crate::paths::Roots) -> Result<Outcome, PosctlError> {
    sql_smoke_cli_as(roots, crate::sys::is_elevated())
}

#[cfg(feature = "test-hooks")]
fn sql_smoke_cli_as(roots: &crate::paths::Roots, elevated: bool) -> Result<Outcome, PosctlError> {
    gate(roots, elevated)?;
    let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
    let cur = posctl_cfg(&env).map(|c| c.pack.current).unwrap_or_default();
    let results = crate::update::smoke::run(&RealDeps::new().admin(&env, &cur));
    Ok(Outcome::ok("sql smoke", crate::update::smoke::to_json(&results)))
}

/// `posctl pack prune [--keep n]`: old packs and old databases, behind the lock and the journal; the outcome is scrubbed with the
/// full secret set like every other.
pub fn run_prune_cli(roots: &crate::paths::Roots, keep: usize) -> Result<Outcome, PosctlError> {
    run_prune_cli_as(roots, keep, crate::sys::is_elevated())
}

fn run_prune_cli_as(roots: &crate::paths::Roots, keep: usize, elevated: bool) -> Result<Outcome, PosctlError> {
    gate(roots, elevated)?;
    if roots.dev {
        return Err(PosctlError::new(Code::Usage, "pack prune drops databases of the real server and cannot run with --dev"));
    }
    let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
    let deps = RealDeps::new();
    // no scrub without the secrets: refuse before anything is removed or dropped
    let Ok(secrets) = deps.secrets(&env) else {
        return Ok(Report::from_error(&OpError::new(OpCode::Precondition, "SECRETS_UNREADABLE", "the secret files cannot be read; nothing was changed")).into_outcome());
    };
    let cur = posctl_cfg(&env).map(|c| c.pack.current).unwrap_or_default();
    let r = crate::update::prune::run(&env, keep, &RealPrune { db: deps.db(&env, &cur) });
    Ok(finalize(r, &secrets).into_outcome())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::fake::{fresh, FakeWork, FakeWorld, Shared, T0};
    use crate::ops::lock::{acquire, LockMode};
    use clap::Parser;
    use std::cell::{Cell, RefCell};

    #[derive(Parser)]
    struct Cli { #[command(flatten)] a: UpdateArgs }
    fn parse(a: &[&str]) -> Result<UpdateArgs, clap::Error> {
        Cli::try_parse_from(std::iter::once("posctl").chain(a.iter().copied())).map(|c| c.a)
    }

    #[test]
    fn the_flags_of_conventions_11_1_parse() {
        let a = parse(&["--if-available", "--window-aware", "--max-maintenance-seconds", "600"]).unwrap();
        assert!(a.if_available && a.window_aware && a.max_maintenance_seconds == Some(600) && !a.dry_run && !a.recover);
        assert_eq!(parse(&["--pack", "1.2.0-r1", "--allow-downgrade", "--dry-run"]).unwrap().pack.as_deref(), Some("1.2.0-r1"));
    }
    #[test]
    fn recover_excludes_everything_else_and_a_pack_excludes_if_available() {
        assert!(parse(&["--recover", "--dry-run"]).is_err());
        assert!(parse(&["--recover", "--pack", "x"]).is_err());
        assert!(parse(&["--pack", "x", "--if-available"]).is_err());
        assert!(parse(&["--recover"]).is_ok());
    }

    // ---- a store on disk (state folder, lock) with a fake machine behind it ----
    struct Store { _d: tempfile::TempDir, env: Env }
    fn store() -> Store {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("data"), d.path().join("prog"));
        let roots = crate::paths::Roots::custom(data.clone(), prog.clone());
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let env = Env { data, program: prog, posctl_exe: d.path().join("posctl.exe"), ports: crate::ports::Ports::new(47300).unwrap(),
            roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
        Store { _d: d, env }
    }
    fn env() -> Env { store().env }

    // ---- elevation before the provisioned file: a standard user cannot see ProgramData ----
    fn standard_user_roots() -> (tempfile::TempDir, crate::paths::Roots) {
        let d = tempfile::tempdir().unwrap();
        let mut roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false; // no provisioned.json: what a standard user sees
        (d, roots)
    }
    fn assert_gate(f: &dyn Fn(&crate::paths::Roots, bool) -> Result<Outcome, PosctlError>) {
        let (_d, roots) = standard_user_roots();
        let e = f(&roots, false).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::NotElevated, 3));
        let e = f(&roots, true).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::NotProvisioned, 4));
    }
    #[test]
    fn update_is_not_elevated_before_it_is_not_provisioned() { assert_gate(&|r, el| run_cli_as(r, false, &parse(&[]).unwrap(), el)); }
    #[test]
    fn pack_prune_is_not_elevated_before_it_is_not_provisioned() { assert_gate(&|r, el| run_prune_cli_as(r, 2, el)); }
    #[cfg(feature = "test-hooks")]
    #[test]
    fn sql_smoke_is_not_elevated_before_it_is_not_provisioned() { assert_gate(&sql_smoke_cli_as); }

    struct FakeDeps {
        s: Shared,
        target: Option<String>,
        precheck_err: RefCell<Option<OpError>>,
        idle: Option<&'static str>,
        secrets: Vec<String>,
        housekeeping_advances_clock_ms: u64,
        resolved_at_call: Cell<Option<usize>>,
        deadline: Arc<AtomicU64>,
        all_old_dropped: Cell<bool>,
        housekeeping_calls: Cell<u32>,
        fence_restored: Cell<bool>,
        fail_restore: bool,
        backup_missing: bool,
        backup_not_ready: bool,
        secrets_err: bool,
        /// `world()` refuses (a precondition before the recovery starts).
        fail_world: bool,
        local_minute: u32,
        peek: Option<String>,
        peeked: Cell<u32>,
        sleeps: RefCell<Vec<Duration>>,
        release_after: Cell<usize>,
        holder: RefCell<Option<crate::ops::lock::LockGuard>>,
        protected_seen: RefCell<Vec<BTreeSet<String>>>,
        /// The next answers of `current_pack`; "old" once they are used up.
        packs: RefCell<std::collections::VecDeque<String>>,
        /// The next answers of `local_minute_of_day`; `local_minute` once they are used up.
        minutes: RefCell<std::collections::VecDeque<u32>>,
    }
    fn deps(s: &Shared) -> FakeDeps {
        FakeDeps { s: s.clone(), target: Some("new".into()), precheck_err: RefCell::new(None), idle: None, secrets: vec![],
            housekeeping_advances_clock_ms: 0, resolved_at_call: Cell::new(None), deadline: Arc::new(AtomicU64::new(u64::MAX)), all_old_dropped: Cell::new(false), housekeeping_calls: Cell::new(0), fence_restored: Cell::new(false), fail_restore: false, backup_missing: false, backup_not_ready: false, secrets_err: false, fail_world: false, local_minute: 150, peek: None, peeked: Cell::new(0), sleeps: RefCell::new(vec![]), release_after: Cell::new(usize::MAX), holder: RefCell::new(None), protected_seen: RefCell::new(vec![]), packs: RefCell::new(Default::default()), minutes: RefCell::new(Default::default()) }
    }
    impl Deps for FakeDeps {
        fn now_ms(&self) -> u64 { self.s.borrow().now }
        fn deadline_cell(&self) -> Arc<AtomicU64> { self.deadline.clone() }
        fn current_pack(&self, _: &Env) -> R<String> { Ok(self.packs.borrow_mut().pop_front().unwrap_or_else(|| "old".into())) }
        fn resolve_target(&self, _: &UpdateArgs, e: &Env, _: &str) -> R<Option<String>> {
            self.resolved_at_call.set(Some(self.s.borrow().calls));
            // the real recovery archives the journal FILE; the fake world only clears its in-memory copy
            if self.s.borrow().journal.is_none() { let _ = std::fs::remove_file(crate::ops::journal::path(&e.update_dir())); }
            Ok(self.target.clone())
        }
        fn manifests(&self, _: &Env, _: &str, _: &str) -> R<(Manifest, Manifest)> {
            Ok((Manifest::for_test("old", "1.0.0", 1, "20260101"), Manifest::for_test("new", "1.0.1", 2, "20260102")))
        }
        fn precheck(&self, _: &Env, _: &str, _: &Manifest, _: &Manifest, _: bool) -> R<Facts> {
            if let Some(e) = self.precheck_err.borrow_mut().take() { return Err(e); }
            Ok(Facts { db_bytes: 1000, free: 1 << 40, need_drop_old: self.housekeeping_advances_clock_ms > 0, pending: vec!["20260102".into()] })
        }
        fn idle(&self, _: &Env, _: &str) -> R<Option<&'static str>> { Ok(self.idle) }
        fn world(&self, _: &Env, _: &str, _: &str) -> R<Box<dyn World>> {
            if self.fail_world { return Err(OpError::new(OpCode::Precondition, "WORLD_UNAVAILABLE", "the machine cannot be reached")); }
            Ok(Box::new(FakeWorld(self.s.clone())))
        }
        fn work(&self, _: &Journal, _: &Env) -> R<Box<dyn OpWork>> { Ok(Box::new(FakeWork(self.s.clone()))) }
        fn local_minute_of_day(&self) -> u32 { self.minutes.borrow_mut().pop_front().unwrap_or(self.local_minute) }
        fn peek_latest(&self, _: &Env, _: &str) -> Option<String> { self.peeked.set(self.peeked.get() + 1); self.peek.clone() }
        fn sleep(&self, d: Duration) {
            self.sleeps.borrow_mut().push(d);
            if self.sleeps.borrow().len() >= self.release_after.get() { self.holder.borrow_mut().take(); }
        }
        fn housekeeping(&self, _: &Env, _: &str, all_old: bool, p: &BTreeSet<String>) {
            self.protected_seen.borrow_mut().push(p.clone());
            self.housekeeping_calls.set(self.housekeeping_calls.get() + 1);
            if all_old { self.all_old_dropped.set(true); self.s.borrow_mut().now += self.housekeeping_advances_clock_ms; }
        }
        fn secrets(&self, _: &Env) -> R<Vec<String>> {
            if self.secrets_err { return Err(OpError::err("SCRUB_SECRETS_UNREADABLE", "cannot read the secrets folder")); }
            Ok(self.secrets.clone())
        }
        fn backup_available(&self, _: &Env, _: bool) -> R<()> {
            if self.backup_missing { return Err(OpError::new(OpCode::Precondition, "BACKUP_UNAVAILABLE", "no backup")); }
            if self.backup_not_ready { return Err(OpError::new(OpCode::Precondition, "BACKUP_NOT_READY", "no backup in the last 26 h: test")); }
            Ok(())
        }
        fn keep_awake(&self) -> Box<dyn std::any::Any> { self.s.borrow_mut().events.push("awake"); Box::new(Awake(self.s.clone())) }
        fn restore_leftover_fence(&self, e: &Env) -> R<()> { if self.fail_restore { return Err(OpError::err("SC_FAILED", "sc failed")); } self.fence_restored.set(true); let _ = std::fs::remove_file(e.update_dir().join("fence-start-types.json")); let _ = std::fs::remove_file(e.conf().join("Caddyfile.live")); Ok(()) }
    }
    /// The fake machine's keep-awake guard: acquiring and releasing it are events of the run.
    struct Awake(Shared);
    impl Drop for Awake { fn drop(&mut self) { self.0.borrow_mut().events.push("asleep"); } }
    fn args(a: &[&str]) -> UpdateArgs { parse(a).unwrap() }
    fn state_files(e: &Env) -> Vec<String> {
        std::fs::read_dir(e.update_dir()).unwrap().flatten().map(|x| x.file_name().to_string_lossy().into_owned()).filter(|n| n != "provisioned.json" && !n.starts_with("update.lock")).collect()
    }

    #[test]
    fn a_recovered_restore_records_last_restore_and_never_touches_the_update_result() {
        let st = store();
        let d = deps(&fresh());
        let before = UpdateResultFile { last_result: "refused".into(), last_code: "PRECONDITION".into(), last_reason: Some("BACKUP_NOT_READY".into()), ..Default::default() };
        before.write(&st.env.update_dir()).unwrap();
        let bytes = std::fs::read(st.env.update_dir().join("update-result.json")).unwrap();
        let mut j = Journal::new(OpKind::Restore, "restore-1", 1, 2, Some("p".into()), Some("p".into()));
        j.extra = crate::backup::restore_work::restore_journal_extra("aaaa1111bbbb", 3, "20260930000001", "local");
        let ctx = crate::backup::plan08_backup::ctx_from_env(&st.env, "p");
        record_recovery(&st.env, &d, &j, "p", "p", None);
        let lr = crate::backup::state::BackupState::load(&ctx.paths.state_file(), 0).unwrap().last_restore.expect("recorded");
        assert_eq!((lr.result.as_str(), lr.snapshot.as_str(), lr.reason.as_deref()), ("restored", "aaaa1111bbbb", None));
        record_recovery(&st.env, &d, &j, "p", "p", Some("RECOVERED_AFTER_INTERRUPTION"));
        let lr = crate::backup::state::BackupState::load(&ctx.paths.state_file(), 0).unwrap().last_restore.unwrap();
        assert_eq!((lr.result.as_str(), lr.reason.as_deref()), ("rolled_back", Some("RECOVERED_AFTER_INTERRUPTION")));
        assert_eq!(std::fs::read(st.env.update_dir().join("update-result.json")).unwrap(), bytes, "a restore is not an update event: T10's UPDATE_BLOCKED keeps its last_code");
        assert!(RolledBack::read(&st.env.roots.rolled_back_record()).is_none());
    }

    fn killed_restore_journal(st: &Store) -> Journal {
        let mut j = Journal::new(OpKind::Restore, "restore-1", 1, 2, Some("p".into()), Some("p".into()));
        j.extra = crate::backup::restore_work::restore_journal_extra("aaaa1111bbbb", 3, "20260930000001", "local");
        j.write(&st.env.update_dir()).unwrap();
        j
    }

    #[test]
    fn a_recovered_restore_leaves_no_decrypted_dump_in_the_scratch_folders() {
        let st = store();
        let d = deps(&fresh());
        let j = killed_restore_journal(&st);
        let ctx = crate::backup::plan08_backup::ctx_from_env(&st.env, "p");
        let stage = ctx.paths.backups_tmp().join("run-0123456789ab").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("pos.dump"), b"admin pin").unwrap();
        std::fs::create_dir_all(ctx.paths.restore_root()).unwrap();
        std::fs::write(ctx.paths.restore_root().join("pos.dump"), b"admin pin").unwrap();
        record_recovery(&st.env, &d, &j, "p", "p", Some("RECOVERED_AFTER_INTERRUPTION"));
        assert!(!ctx.paths.backups_tmp().join("run-0123456789ab").exists(), "the dead restore's run folder is scrubbed");
        assert!(!ctx.paths.restore_root().join("pos.dump").exists(), "the restore folder is scrubbed");
        let lr = crate::backup::state::BackupState::load(&ctx.paths.state_file(), 0).unwrap().last_restore.unwrap();
        assert!(lr.warnings.is_empty(), "{:?}", lr.warnings);
    }

    #[cfg(windows)]
    #[test]
    fn a_scrub_that_fails_after_recovery_still_ends_recovered_with_a_fixed_warning_and_keeps_the_scratch() {
        use std::os::windows::fs::OpenOptionsExt;
        let st = store();
        let d = deps(&fresh());
        let j = killed_restore_journal(&st);
        std::fs::create_dir_all(st.env.roots.posctl_logs()).unwrap();
        let ctx = crate::backup::plan08_backup::ctx_from_env(&st.env, "p");
        let stage = ctx.paths.backups_tmp().join("run-0123456789ab").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("pos.dump"), b"admin pin").unwrap();
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(stage.join("pos.dump")).unwrap(); // cannot be opened for writing or removed
        record_recovery(&st.env, &d, &j, "p", "p", Some("RECOVERED_AFTER_INTERRUPTION"));
        let lr = crate::backup::state::BackupState::load(&ctx.paths.state_file(), 0).unwrap().last_restore.expect("the restore is recorded as recovered anyway");
        assert_eq!((lr.result.as_str(), lr.warnings.as_slice()), ("rolled_back", ["RECOVERY_SCRATCH_LEFT".to_string()].as_slice()));
        assert!(stage.join("pos.dump").exists(), "the scratch is kept for the next run-start sweep or restore-start scrub");
        let log: String = std::fs::read_dir(st.env.roots.posctl_logs()).map(|r| r.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).collect()).unwrap_or_default();
        assert!(log.contains("RECOVERY_SCRATCH_LEFT") && !log.contains("pos.dump") && !log.contains("run-0123"), "a fixed line, no paths: {log}");
    }

    #[test]
    fn a_recovered_switch_in_the_move_window_is_exit_17_with_the_rollback_command_and_a_leftover_fence_never_hides_it() {
        let (st, s) = swapped_store();
        edit_journal(&st, |j| { j.kind = OpKind::Switch; j.op_id = "sw-1".into(); j.step = crate::ops::journal::Step::VerifyLive; });
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!((r.code.exit(), r.reason.as_deref()), (17, Some("CLOUD_MAY_BE_MOVED")), "{}", r.message);
        assert!(r.message.contains("posctl switch rollback sw-1"), "{}", r.message);
        // the same crash with a fence left behind and a plain `update`: the update refuses on the leftover, the loud report still wins
        let (st, s) = swapped_store();
        edit_journal(&st, |j| { j.kind = OpKind::Switch; j.op_id = "sw-2".into(); j.step = crate::ops::journal::Step::VerifyLive; });
        std::fs::create_dir_all(st.env.roots.fence_start_types().parent().unwrap()).unwrap();
        std::fs::write(st.env.roots.fence_start_types(), b"{}").unwrap();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code.exit(), r.reason.as_deref()), (17, Some("CLOUD_MAY_BE_MOVED")), "{}", r.message);
        assert_eq!(r.data["leftoverState"].as_str(), Some("LEFTOVER_STATE"), "{:?}", r.data);
    }

    #[test]
    fn a_recovered_switch_never_touches_the_update_result() {
        let st = store();
        let d = deps(&fresh());
        let before = UpdateResultFile { last_result: "refused".into(), last_code: "PRECONDITION".into(), last_reason: Some("BACKUP_NOT_READY".into()), ..Default::default() };
        before.write(&st.env.update_dir()).unwrap();
        let bytes = std::fs::read(st.env.update_dir().join("update-result.json")).unwrap();
        let j = Journal::new(OpKind::Switch, "switch-1", 1, 2, Some("p".into()), Some("p".into()));
        record_recovery(&st.env, &d, &j, "p", "p", None);
        record_recovery(&st.env, &d, &j, "p", "p", Some("RECOVERED_AFTER_INTERRUPTION"));
        assert_eq!(std::fs::read(st.env.update_dir().join("update-result.json")).unwrap(), bytes, "a switch is not an update event");
        assert!(RolledBack::read(&st.env.roots.rolled_back_record()).is_none());
    }

    /// A killed switch's staging: the cloud password folder and the cloud dump folder, each with a file in it.
    fn killed_switch_staging(e: &Env) -> [std::path::PathBuf; 2] {
        let (pg, dump) = (e.roots.update_dir().join("cloud-pgpass-dead"), e.roots.backups().join("switch-dead"));
        for p in [&pg, &dump] { std::fs::create_dir_all(p).unwrap(); std::fs::write(p.join("f"), "cloud secret").unwrap(); }
        [pg, dump]
    }

    #[test]
    fn recovering_a_killed_switch_removes_its_cloud_password_folder_and_its_cloud_dump() {
        for step in [crate::ops::journal::Step::CloneDb, crate::ops::journal::Step::Work] {
            let (st, s) = crashed_in(step);
            edit_journal(&st, |j| j.kind = OpKind::Switch);
            let left = killed_switch_staging(&st.env);
            let r = run(&args(&["--recover"]), &st.env, &deps(&s));
            assert_eq!(r.code.exit(), 0, "{step:?}: {}", r.message);
            assert!(left.iter().all(|p| !p.exists()), "{step:?}: staging still on disk: {left:?}");
            assert!(crate::switch::staging::leftovers(&st.env.roots).is_empty());
        }
    }

    #[test]
    fn a_no_op_recovery_leaves_the_staging_and_status_still_names_every_path() {
        let st = store();
        let left = killed_switch_staging(&st.env);
        let r = run(&args(&["--recover"]), &st.env, &deps(&fresh()));
        assert_eq!((r.code.exit(), r.data["recovered"].as_bool()), (0, Some(false)), "{}", r.message);
        assert!(left.iter().all(|p| p.exists()), "no journal: nothing proves the folders are dead");
        let paths = crate::status::staging_leftover_paths(&st.env.roots, &crate::ops::lock::LockState::Free, 1);
        assert_eq!(paths.len(), 2);
        let m = crate::status::staging_leftover_message(&paths);
        assert!(left.iter().all(|p| m.contains(&p.display().to_string())), "{m}");
    }

    #[test]
    fn recovering_an_update_never_purges_switch_staging() {
        let (st, s) = crashed_in(crate::ops::journal::Step::Work);
        let left = killed_switch_staging(&st.env);
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.code.exit(), 0, "{}", r.message);
        assert!(left.iter().all(|p| p.exists()), "a plan or run may own those folders; only a switch journal proves they are dead");
    }

    #[test]
    fn a_failed_purge_after_a_switch_recovery_is_loud_with_the_path() {
        let (st, s) = crashed_in(crate::ops::journal::Step::Work);
        edit_journal(&st, |j| j.kind = OpKind::Switch);
        // `backups` is a FILE: reading it as a folder fails with something other than "not found"
        std::fs::write(st.env.roots.backups(), "not a folder").unwrap();
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!((r.code.exit(), r.reason.as_deref()), (17, Some("SWITCH_STAGING_PURGE_FAILED")), "{}", r.message);
        let path = st.env.roots.backups().display().to_string();
        assert!(r.message.contains(&path) && r.data["stagingPurgeFailed"].as_str().is_some_and(|m| m.contains(&path)), "{} {:?}", r.message, r.data);
    }

    #[test]
    fn a_failed_purge_keeps_the_cloud_may_be_moved_report_and_adds_the_staging_failure() {
        let e = OpError::new(OpCode::Error, "STAGING_PURGE_FAILED", "C:\\x\\cloud-pgpass-a: PermissionDenied");
        let sw = Journal::new(OpKind::Switch, "op-7", 1, 2, Some("p".into()), Some("p".into()));
        let loud = loud_switch_report(&sw, "X", &["CLOUD_MAY_BE_MOVED".to_string()]);
        let r = staging_purge_failed(loud, &e);
        assert_eq!((r.code.exit(), r.reason.as_deref()), (17, Some("CLOUD_MAY_BE_MOVED")));
        assert!(r.message.contains("posctl switch rollback op-7") && r.message.contains("cloud-pgpass-a"), "{}", r.message);
        assert_eq!(r.data["fix"].as_str(), Some("posctl switch rollback op-7"));
        assert!(r.data["stagingPurgeFailed"].as_str().is_some());
    }

    #[test]
    fn a_recovered_switch_that_never_began_draining_writes_released_but_one_that_may_have_holds() {
        use crate::ops::journal::Step;
        for (step, may_have_drained) in [(Step::Started, false), (Step::Fence, false), (Step::Backup, false), (Step::RepairCollation, false), (Step::CloneDb, false),
                                         (Step::Work, true), (Step::VerifyClone, true)] {
            let (st, s) = crashed_in(step);
            edit_journal(&st, |j| j.kind = OpKind::Switch);
            let r = run(&args(&["--recover"]), &st.env, &deps(&s));
            assert_eq!(r.code.exit(), 0, "{step:?}: {}", r.message);
            let dir = st.env.update_dir();
            let p = crate::switch::progress::read(&dir).unwrap_or_else(|| panic!("{step:?}: progress must be written"));
            if may_have_drained {
                assert_eq!(p.cloud, "held", "{step:?}");
            } else {
                assert_eq!((p.phase.as_str(), p.cloud.as_str()), ("rolled back", "released"), "{step:?}");
                assert!(crate::switch::progress::status_alert(&dir, false, false).is_none(), "{step:?}: no SWITCH_CLOUD_NOT_RELEASED");
            }
        }
    }

    #[test]
    fn a_rolled_back_switch_with_a_loud_cloud_warning_is_exit_17_with_the_exact_command_whatever_its_reason() {
        let sw = Journal::new(OpKind::Switch, "op-7", 1, 2, Some("p".into()), Some("p".into()));
        let ws = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for w in ["CLOUD_MAY_BE_MOVED", "CLOUD_STILL_MOVED", "CLOUD_STATE_UNKNOWN"] {
            // the reason is not what decides: a rollback begun at the live check keeps RECOVERED_AFTER_INTERRUPTION, a failed re-activation its own
            for reason in ["RECOVERED_AFTER_INTERRUPTION", "ACTIVATE_FAILED"] {
                let r = loud_switch_report(&sw, reason, &ws(&["CLOUD_RELEASE_FAILED", w])).expect(w);
                assert_eq!((r.code.exit(), r.reason.as_deref()), (17, Some(w)));
                assert!(r.message.contains("posctl switch rollback op-7"), "{}", r.message);
                assert_eq!((r.data["fix"].as_str(), r.data["rolledBackBecause"].as_str()), (Some("posctl switch rollback op-7"), Some(reason)));
            }
        }
        assert!(loud_switch_report(&sw, "X", &ws(&["CLOUD_RELEASE_FAILED"])).is_none(), "a failed release of a never-moved hold is the held alert, not exit 17");
        let up = Journal::new(OpKind::Update, "op-8", 1, 2, Some("a".into()), Some("b".into()));
        assert!(loud_switch_report(&up, "X", &ws(&["CLOUD_MAY_BE_MOVED"])).is_none(), "only a switch");
    }

    #[test]
    fn a_switch_journal_is_recovered_by_plan_09s_work_which_never_resumes_a_copy() {
        let j = Journal::new(OpKind::Switch, "op", 0, 0, None, None);
        let mut w = work_for(&j, &env()).unwrap();
        assert_eq!(w.kind(), OpKind::Switch);
        let ctx = crate::ops::recover::ctx_from_journal(&j);
        assert_eq!(w.work_on_clone(&ctx).unwrap_err().reason, "SWITCH_NOT_RESUMABLE");
    }

    #[test]
    fn the_envelope_has_the_shape_of_conventions_11() {
        let r = Report::new(OpCode::LockHeld, Some("LOCK_HELD"), "another update runs", serde_json::json!({}), true);
        let o = r.into_outcome();
        let v = serde_json::to_value(crate::envelope::Envelope::from_outcome("update", "1", "2", &o)).unwrap();
        assert_eq!((v["ok"].as_bool(), v["code"].as_str(), v["exit"].as_i64(), v["retryable"].as_bool()), (Some(false), Some("LOCK_HELD"), Some(10), Some(true)));
        for k in ["command", "message", "data", "journal", "startedAt", "finishedAt", "posctlVersion"] { assert!(v.get(k).is_some(), "{k}"); }
    }

    #[test]
    fn the_maintenance_budget_is_clamped() {
        assert_eq!(budget_seconds(None, Some(900)), 900);
        assert_eq!(budget_seconds(Some(5), None), 60);
        assert_eq!(budget_seconds(Some(999_999), None), 3600);
        assert_eq!(budget_seconds(None, None), 900);
    }

    #[test]
    fn only_a_clean_run_exits_zero_and_error_and_rolled_back_are_different_non_zero_codes() {
        for c in [OpCode::Error, OpCode::RolledBack, OpCode::VerifyFailedRolledBack, OpCode::MigrationFailed, OpCode::Precondition, OpCode::RecoveryNeeded, OpCode::LockHeld] {
            let o = Report::new(c, Some("X"), "m", serde_json::json!({}), false).into_outcome();
            let v = serde_json::to_value(crate::envelope::Envelope::from_outcome("update", "0", "0", &o)).unwrap();
            assert_ne!(v["exit"].as_i64(), Some(0), "{c:?}");
            assert_eq!(v["ok"].as_bool(), Some(false));
        }
        assert_ne!(OpCode::Error.exit(), OpCode::RolledBack.exit());
        let o = Report::new(OpCode::RolledBack, Some("MAINTENANCE_BUDGET"), "m", serde_json::json!({}), false).into_outcome();
        assert_eq!((o.code.exit(), o.code.name()), (16, "ROLLED_BACK"));
    }

    #[test]
    fn a_clean_run_updates_and_writes_the_result_file() {
        let st = store();
        let s = fresh();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.data["updated"].as_bool()), (OpCode::Ok, Some(true)), "{}", r.message);
        assert!(s.borrow().journal.is_none());
        let res = UpdateResultFile::read(&st.env.update_dir());
        assert_eq!((res.last_result.as_str(), res.last_code.as_str(), res.pack_to.as_deref()), ("updated", "OK", Some("new")));
        assert_eq!(crate::ops::lock::probe_for(&st.env.roots), crate::ops::lock::LockState::Free, "the lock is released");
    }

    #[test]
    fn a_failed_verification_is_reported_as_rolled_back_never_as_success() {
        let st = store();
        let s = fresh();
        s.borrow_mut().fail_verify_live = true;
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.code.exit()), (OpCode::VerifyFailedRolledBack, 15));
        assert_eq!(UpdateResultFile::read(&st.env.update_dir()).last_result, "rolled_back");
    }

    // ---- FR19 item 7: the machine stays awake for the whole operation, on every way out ----
    fn count(s: &Shared, e: &str) -> usize { s.borrow().events.iter().filter(|x| **x == e).count() }
    fn assert_balanced(s: &Shared) {
        let ev = s.borrow().events.clone();
        assert_eq!(count(s, "awake"), count(s, "asleep"), "{ev:?}");
        let mut held = 0i32;
        for e in &ev { match *e { "awake" => held += 1, "asleep" => held -= 1, _ => assert!(held > 0, "{e} ran with the machine free to sleep: {ev:?}") } }
        assert_eq!(held, 0, "{ev:?}");
    }
    #[test]
    fn the_machine_is_kept_awake_from_before_the_fence_to_after_a_clean_update() {
        let st = store();
        let s = fresh();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!(r.data["updated"].as_bool(), Some(true), "{}", r.message);
        assert_eq!(s.borrow().events, ["awake", "fence", "asleep"]);
    }
    #[test]
    fn the_machine_is_kept_awake_through_a_rollback() {
        let st = store();
        let s = fresh();
        s.borrow_mut().fail_verify_live = true;
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::VerifyFailedRolledBack, "{}", r.message);
        assert_eq!(s.borrow().events, ["awake", "fence", "asleep"]);
    }
    #[test]
    fn the_machine_is_kept_awake_through_a_failed_migration_and_released_after_it() {
        let st = store();
        let s = fresh();
        s.borrow_mut().fail_work = true;
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::MigrationFailed, "{}", r.message);
        assert_eq!(s.borrow().events, ["awake", "fence", "asleep"]);
    }
    #[test]
    fn the_machine_is_released_when_the_operation_panics() {
        let st = store();
        let s = fresh();
        s.borrow_mut().crash_at = Some(3);
        let d = deps(&s);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&args(&[]), &st.env, &d)));
        assert!(caught.is_err(), "the injected crash must unwind");
        assert_balanced(&s);
        assert_eq!(count(&s, "awake"), 1);
    }
    #[test]
    fn a_hand_recovery_keeps_the_machine_awake() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.data["recovered"].as_bool(), Some(true), "{}", r.message);
        assert_balanced(&s);
        assert_eq!(count(&s, "awake"), 1);
    }
    #[test]
    fn a_scheduled_recovery_keeps_the_machine_awake() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let r = run(&args(&["--recover", "--scheduled"]), &st.env, &deps(&s));
        assert_eq!(r.data["recovered"].as_bool(), Some(true), "{}", r.message);
        assert_balanced(&s);
        assert_eq!(count(&s, "awake"), 1);
    }
    #[test]
    fn a_run_that_changes_nothing_never_holds_the_machine_awake() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.target = None;
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert!(s.borrow().events.is_empty(), "{:?}", s.borrow().events);
    }
    /// A scheduled run that recovered a journal returns right after the recovery (reason RECOVERED); the NEXT hourly run does the update.
    /// So one task run is a recovery or an update, never both, and the UpdateCheck limit is the larger of the two (`update::limits`).
    #[test]
    fn a_scheduled_check_that_recovers_a_journal_returns_without_updating() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let d = deps(&s);
        let r = run(&scheduled_check(), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Ok, Some("RECOVERED")), "{}", r.message);
        assert_eq!((r.data["updated"].as_bool(), r.data["reason"].as_str(), r.data["recovered"].as_bool()), (Some(false), Some("RECOVERED"), Some(true)), "{:?}", r.data);
        assert_eq!(r.data["recoverAttempts"].as_array().map(Vec::len), Some(1), "{:?}", r.data);
        assert!(d.resolved_at_call.get().is_none(), "no pack was resolved in the run that recovered");
        assert_eq!(UpdateResultFile::read(&st.env.update_dir()).last_result, "rolled_back", "only the recovery was recorded; nothing was applied");
        assert_balanced(&s);
        assert_eq!(count(&s, "awake"), 1, "exactly one guard pair: the recovery's, and no update's");
        assert_eq!(s.borrow().events.last().copied(), Some("asleep"), "nothing ran after the guard was released: {:?}", s.borrow().events);
    }
    /// A hand `posctl update` that meets a journal recovers it and goes on to update in the same run.
    #[test]
    fn a_hand_update_that_recovers_a_journal_goes_on_to_update_in_the_same_run() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.data["updated"].as_bool()), (OpCode::Ok, Some(true)), "{}", r.message);
        assert_eq!(r.data["recoverAttempts"].as_array().map(Vec::len), Some(1), "{:?}", r.data);
        assert_eq!(count(&s, "awake"), 2);
    }

    // ---- FR19 item 4: a version that rolled back is not retried by the scheduled check ----
    fn rolled_back_record(st: &Store) -> Option<crate::update::result_file::RolledBack> { crate::update::result_file::RolledBack::read(&st.env.roots.rolled_back_record()) }
    fn scheduled_check() -> UpdateArgs { args(&["--if-available", "--window-aware", "--scheduled"]) }
    fn roll_back_new(st: &Store, s: &Shared) {
        s.borrow_mut().fail_verify_live = true;
        let r = run(&args(&[]), &st.env, &deps(s));
        assert_eq!(r.code, OpCode::VerifyFailedRolledBack, "{}", r.message);
        s.borrow_mut().fail_verify_live = false;
    }

    #[test]
    fn a_rollback_records_the_version_it_rolled_back_from() {
        let st = store();
        let s = fresh();
        assert!(rolled_back_record(&st).is_none());
        roll_back_new(&st, &s);
        let rec = rolled_back_record(&st).expect("the record is written");
        assert_eq!((rec.pack_version.as_str(), rec.code.as_str(), rec.reason.as_deref()), ("new", "VERIFY_FAILED_ROLLED_BACK", Some("VERIFY_FAILED")));
    }

    #[test]
    fn the_next_scheduled_run_skips_a_rolled_back_version_without_fencing_or_an_attempt() {
        let st = store();
        let s = fresh();
        roll_back_new(&st, &s);
        let calls = s.borrow().calls;
        let r = run(&scheduled_check(), &st.env, &deps(&s));
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Ok, 0, Some("SKIPPED_ROLLED_BACK")), "{}", r.message);
        assert_eq!((r.data["updated"].as_bool(), r.data["skipped"].as_bool(), r.data["packTo"].as_str()), (Some(false), Some(true), Some("new")), "{:?}", r.data);
        assert_eq!(s.borrow().calls, calls, "not one World call: nothing was fenced or touched");
        assert!(r.data.get("recoverAttempts").is_none() && !crate::ops::journal::path(&st.env.update_dir()).exists(), "no attempt, no journal");
        assert!(rolled_back_record(&st).is_some(), "the record stays while it is still the newest");
        assert_eq!(UpdateResultFile::read(&st.env.update_dir()).last_result, "rolled_back", "the skip does not overwrite the last real result");
    }

    #[test]
    fn a_newer_version_is_taken_by_the_scheduled_run_and_the_record_is_cleared() {
        let st = store();
        let s = fresh();
        roll_back_new(&st, &s);
        let mut d = deps(&s);
        d.target = Some("newer".into());
        let r = run(&scheduled_check(), &st.env, &d);
        assert_eq!((r.code, r.data["updated"].as_bool()), (OpCode::Ok, Some(true)), "{}", r.message);
        assert!(rolled_back_record(&st).is_none(), "a success clears the record");
    }

    #[test]
    fn a_newer_version_that_also_rolls_back_replaces_the_record() {
        let st = store();
        let s = fresh();
        roll_back_new(&st, &s);
        s.borrow_mut().fail_verify_live = true;
        let mut d = deps(&s);
        d.target = Some("newer".into());
        let r = run(&scheduled_check(), &st.env, &d);
        assert_eq!(r.code, OpCode::VerifyFailedRolledBack, "{}", r.message);
        assert_eq!(rolled_back_record(&st).map(|x| x.pack_version), Some("newer".to_string()));
    }

    #[test]
    fn a_hand_run_retries_the_rolled_back_version_and_a_success_clears_the_record() {
        let st = store();
        let s = fresh();
        roll_back_new(&st, &s);
        let r = run(&args(&["--if-available"]), &st.env, &deps(&s)); // a person: no --scheduled
        assert_eq!((r.code, r.data["updated"].as_bool()), (OpCode::Ok, Some(true)), "{}", r.message);
        assert!(rolled_back_record(&st).is_none());
        // and it is no longer skipped
        let r = run(&scheduled_check(), &st.env, &deps(&s));
        assert_ne!(r.reason.as_deref(), Some("SKIPPED_ROLLED_BACK"));
    }

    #[test]
    fn a_failed_recovery_is_not_recorded_as_a_rollback() {
        let st = store();
        let s = fresh();
        s.borrow_mut().fail_verify_live = true;
        s.borrow_mut().fail_swap_back = true; // the rollback itself fails: RecoveryNeeded, the journal stays
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::RecoveryNeeded, "{}", r.message);
        assert!(rolled_back_record(&st).is_none(), "the store is down and recovery owns it; this is not a clean rollback");
    }

    // ---- FR19 commit 14: which failures park a version, recovery included ----
    fn edit_journal(st: &Store, f: impl FnOnce(&mut Journal)) {
        let mut j = Journal::read(&st.env.update_dir()).unwrap().unwrap();
        f(&mut j);
        j.write(&st.env.update_dir()).unwrap();
    }
    fn crashed_in(step: crate::ops::journal::Step) -> (Store, Shared) {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        edit_journal(&st, |j| j.step = step);
        (st, s)
    }

    #[test]
    fn a_recovery_that_rolls_back_a_crash_in_the_versions_own_work_parks_it() {
        let (st, s) = crashed_in(crate::ops::journal::Step::Work);
        let r = run(&scheduled_check(), &st.env, &deps(&s));
        assert_eq!(r.reason.as_deref(), Some("RECOVERED"), "{}", r.message);
        let rec = rolled_back_record(&st).expect("the version the crash happened in is parked");
        assert_eq!((rec.pack_version.as_str(), rec.code.as_str(), rec.reason.as_deref()), ("new", "ROLLED_BACK", Some("RECOVERED_AFTER_INTERRUPTION")));
        // so the next scheduled run does not fence for it again, while a person may retry
        let _ = std::fs::remove_file(crate::ops::journal::path(&st.env.update_dir())); // the fake world archives the journal in memory only
        let calls = s.borrow().calls;
        let r = run(&scheduled_check(), &st.env, &deps(&s));
        assert_eq!(r.reason.as_deref(), Some("SKIPPED_ROLLED_BACK"), "{}", r.message);
        assert_eq!(s.borrow().calls, calls);
        let r = run(&args(&["--if-available"]), &st.env, &deps(&s));
        assert_eq!(r.data["updated"].as_bool(), Some(true), "{}", r.message);
        assert!(rolled_back_record(&st).is_none());
    }

    #[test]
    fn a_recovery_of_a_crash_before_the_versions_own_work_does_not_park_it() {
        use crate::ops::journal::Step;
        for step in [Step::Started, Step::Fence, Step::Backup] {
            let (st, s) = crashed_in(step);
            let r = run(&scheduled_check(), &st.env, &deps(&s));
            assert_eq!(r.reason.as_deref(), Some("RECOVERED"), "{step:?}: {}", r.message);
            assert!(rolled_back_record(&st).is_none(), "{step:?}: not the version's fault");
        }
    }

    #[test]
    fn a_recovery_stores_the_real_code_of_the_reason_the_rollback_began_with() {
        for (reason, name, exit, parks) in [("VERIFY_FAILED", "VERIFY_FAILED_ROLLED_BACK", 15, true), ("MIGRATION_FAILED", "MIGRATION_FAILED", 14, true), ("CLONE_FAILED", "ROLLED_BACK", 16, false)] {
            let (st, s) = crashed_store(T0, T0 + 60_000);
            edit_journal(&st, |j| { j.step = crate::ops::journal::Step::Rollback; j.rollback_from = Some(crate::ops::journal::Step::Work); j.rollback_reason = Some(reason.into()); });
            let r = run(&scheduled_check(), &st.env, &deps(&s));
            assert_eq!(r.reason.as_deref(), Some("RECOVERED"), "{reason}: {}", r.message);
            let res = UpdateResultFile::read(&st.env.update_dir());
            assert_eq!((res.last_code.as_str(), res.last_reason.as_deref(), OpCode::exit_for_name(&res.last_code)), (name, Some(reason), Some(exit)), "{reason}");
            assert_eq!(rolled_back_record(&st).map(|x| x.code), parks.then(|| name.to_string()), "{reason}");
        }
    }

    #[test]
    fn a_scheduled_recovery_outside_the_window_reports_recovered_not_outside_window() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut d = deps(&s);
        d.local_minute = 9 * 60;
        let r = run(&scheduled_check(), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Ok, 0, Some("RECOVERED")), "{}", r.message);
        assert!(r.data["recoveryNote"].as_str().is_some() && r.data["recovered"].as_bool() == Some(true), "{:?}", r.data);
        assert!(d.resolved_at_call.get().is_none(), "the update itself still waits for the window");
    }

    #[test]
    fn a_recovery_that_rolls_forward_clears_the_rolled_back_record() {
        let (st, s) = swapped_store();
        crate::update::result_file::RolledBack { pack_version: "new".into(), since_ms: 1, code: "ROLLED_BACK".into(), reason: None }.write(&st.env.roots.rolled_back_record()).unwrap();
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.data["recovered"].as_bool(), Some(true), "{}", r.message);
        assert!(rolled_back_record(&st).is_none(), "the version went in after all");
    }

    #[test]
    fn the_parking_rule_table() {
        use crate::ops::journal::Step::*;
        let crash = "RECOVERED_AFTER_INTERRUPTION";
        for (code, reason, step, parks) in [
            (OpCode::MigrationFailed, "MIGRATION_FAILED", None, true),
            (OpCode::VerifyFailedRolledBack, "VERIFY_FAILED", None, true),
            (OpCode::RolledBack, "MAINTENANCE_BUDGET", Some(Fence), false),
            (OpCode::RolledBack, "MAINTENANCE_BUDGET", Some(Backup), false),
            (OpCode::RolledBack, "MAINTENANCE_BUDGET", Some(RepairCollation), true),
            (OpCode::RolledBack, "MAINTENANCE_BUDGET", Some(Work), true),
            (OpCode::RolledBack, "MAINTENANCE_BUDGET", None, false),
            (OpCode::RolledBack, crash, Some(Work), true),
            (OpCode::RolledBack, crash, Some(CloneDb), true),
            (OpCode::RolledBack, crash, Some(VerifyLive), true),
            (OpCode::RolledBack, crash, Some(Fence), false),
            (OpCode::RolledBack, crash, Some(Backup), false),
            (OpCode::RolledBack, crash, Some(Started), false),
            (OpCode::RolledBack, crash, None, false),
            (OpCode::RolledBack, "FENCE_FAILED", None, false),
            (OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED", None, false),
            (OpCode::RolledBack, "CLONE_FAILED", None, false),
            (OpCode::Precondition, "OUTSIDE_WINDOW", None, false),
            (OpCode::RecoveryNeeded, "ROLLBACK_FAILED", None, false),
        ] {
            assert_eq!(parks_version(code, reason, step), parks, "{code:?} {reason} {step:?}");
        }
        use crate::update::work::{MIGRATION_REASONS, VERIFY_REASONS};
        for r in MIGRATION_REASONS { assert_eq!(code_for_reason(r), OpCode::MigrationFailed, "{r}"); assert!(!VERIFY_REASONS.contains(r), "{r} is in both lists"); }
        for r in VERIFY_REASONS { assert_eq!(code_for_reason(r), OpCode::VerifyFailedRolledBack, "{r}"); }
        for r in ["CLONE_FAILED", "FENCE_FAILED", "MAINTENANCE_BUDGET", "RECOVERED_AFTER_INTERRUPTION", "PSQL_FAILED", "NOT_A_REASON"] {
            assert_eq!(code_for_reason(r), OpCode::RolledBack, "{r}");
        }
    }

    #[test]
    fn a_budget_that_runs_out_before_the_versions_own_work_parks_nothing_in_process() {
        // the clock leaps past the whole budget at call n: a later n runs the budget out at a later step. Parking must follow the step.
        let mut parked = vec![];
        for n in 1..40usize {
            let st = store();
            let s = fresh();
            s.borrow_mut().jump_at = Some((n, 3_600_000));
            let r = run(&args(&[]), &st.env, &deps(&s));
            if r.reason.as_deref() == Some("MAINTENANCE_BUDGET") { parked.push(rolled_back_record(&st).is_some()); }
        }
        assert!(parked.contains(&false) && parked.contains(&true), "{parked:?}");
        assert!(parked.windows(2).all(|w| w[0] <= w[1]), "{parked:?}");
    }

    #[test]
    fn a_recovery_of_a_budget_overrun_parks_only_after_the_backup() {
        use crate::ops::journal::Step;
        for (step, parks) in [(Step::Fence, false), (Step::Backup, false), (Step::RepairCollation, true), (Step::Work, true)] {
            let (st, s) = crashed_store(T0, T0 + 60_000);
            edit_journal(&st, |j| { j.step = Step::Rollback; j.rollback_from = Some(step); j.rollback_reason = Some("MAINTENANCE_BUDGET".into()); });
            let r = run(&scheduled_check(), &st.env, &deps(&s));
            assert_eq!(r.reason.as_deref(), Some("RECOVERED"), "{step:?}: {}", r.message);
            assert_eq!(rolled_back_record(&st).is_some(), parks, "{step:?}");
        }
    }

    #[test]
    fn only_a_failure_of_the_version_parks_it_in_process_too() {
        for (what, expect) in [("backup", None), ("migrate", Some("MIGRATION_FAILED")), ("verify", Some("VERIFY_FAILED_ROLLED_BACK"))] {
            let st = store();
            let s = fresh();
            match what {
                "backup" => s.borrow_mut().fail_backup = true,
                "migrate" => s.borrow_mut().fail_work = true,
                _ => s.borrow_mut().fail_verify_live = true,
            }
            let r = run(&args(&[]), &st.env, &deps(&s));
            assert_ne!(r.code, OpCode::Ok, "{what}: {}", r.message);
            assert_eq!(rolled_back_record(&st).map(|x| x.code), expect.map(String::from), "{what}");
        }
    }

    #[test]
    fn a_dry_run_changes_nothing_at_all() {
        let st = store();
        let s = fresh();
        let before = state_files(&st.env);
        let r = run(&args(&["--dry-run"]), &st.env, &deps(&s));
        assert_eq!((r.code, r.data["dryRun"].as_bool(), r.data["wouldUpdate"].as_bool()), (OpCode::Ok, Some(true), Some(true)), "{}", r.message);
        let c = s.borrow();
        assert_eq!(c.calls, 0, "a dry run must not call the world at all (no fence, no clone, no journal write)");
        assert!(c.journal.is_none() && c.gateway == crate::ops::fake::Gw::Live && c.roles_login && c.stack_up && !c.recovery_suspended);
        drop(c);
        assert_eq!(state_files(&st.env), before, "no journal, no result file, no sidecar");
        assert_eq!(crate::ops::lock::probe_for(&st.env.roots), crate::ops::lock::LockState::Free);
    }

    #[test]
    fn a_second_update_while_one_runs_is_lock_held_and_retryable() {
        let st = store();
        let _held = acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap();
        let s = fresh();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.code.exit(), r.retryable), (OpCode::LockHeld, 10, true));
        assert_eq!(s.borrow().calls, 0);
        assert!(!state_files(&st.env).iter().any(|n| n.contains("journal")), "the journal is untouched");
    }

    #[test]
    fn a_lock_whose_state_cannot_be_read_counts_as_held_and_the_update_is_refused() {
        let st = store();
        std::fs::create_dir_all(st.env.update_dir().join("update.lock")).unwrap(); // a folder where the lock file should be
        let s = fresh();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("LOCK_STATE_UNKNOWN")), "{}", r.message);
        assert_eq!(s.borrow().calls, 0);
    }

    #[test]
    fn the_journal_is_read_after_the_lock_is_taken() {
        // a corrupt journal AND a held lock: taking the lock first means the answer is LOCK_HELD; reading first would say JOURNAL_CORRUPT
        let st = store();
        std::fs::write(crate::ops::journal::path(&st.env.update_dir()), b"{ torn").unwrap();
        let _held = acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap();
        let s = fresh();
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::LockHeld, "{}", r.message);
    }

    // ---- FR19: fail closed on an update state that cannot be read ----
    fn denied<T>(_: &std::path::Path) -> std::io::Result<T> { Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) }

    #[test]
    fn an_unreadable_update_state_refuses_with_exit_17_and_says_to_run_elevated() {
        let st = store();
        let present = |p: &std::path::Path| p.try_exists();
        assert!(state_gate_via(&st.env, &crate::ops::journal::fs_read, &present).is_ok(), "readable and empty: fine");
        for (what, r) in [
            ("journal", state_gate_via(&st.env, &denied, &present)),
            ("fence marker", state_gate_via(&st.env, &crate::ops::journal::fs_read, &denied)),
        ] {
            let r = r.unwrap_err();
            assert_eq!((r.code, r.code.exit()), (OpCode::RecoveryNeeded, 17), "{what}");
            assert!(r.message.contains("elevated"), "{what}: {}", r.message);
        }
    }

    #[test]
    fn update_and_recover_refuse_with_17_when_the_journal_cannot_be_opened() {
        // a folder where journal.json should be: Windows answers "access denied", other systems "is a directory"; neither is NotFound
        for a in [&[][..], &["--recover"][..]] {
            let st = store();
            std::fs::create_dir_all(crate::ops::journal::path(&st.env.update_dir())).unwrap();
            let s = fresh();
            let r = run(&args(a), &st.env, &deps(&s));
            assert_eq!((r.code, r.code.exit()), (OpCode::RecoveryNeeded, 17), "{a:?}: {}", r.message);
            assert!(r.message.contains("elevated"), "{}", r.message);
            assert_eq!(s.borrow().calls, 0, "nothing was touched");
        }
    }

    #[test]
    fn an_unreadable_journal_is_never_treated_as_absent() {
        let st = store();
        std::fs::write(crate::ops::journal::path(&st.env.update_dir()), b"{ torn").unwrap();
        let s = fresh();
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RecoveryNeeded, Some("JOURNAL_CORRUPT")));
        let mut j = Journal::new(OpKind::Update, "op", T0, T0, Some("a".into()), Some("b".into()));
        j.schema = crate::ops::journal::JOURNAL_SCHEMA + 1;
        j.write(&st.env.update_dir()).unwrap();
        let r = run(&args(&[]), &st.env, &deps(&s));
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RecoveryNeeded, Some("JOURNAL_TOO_NEW")));
        assert_eq!(s.borrow().calls, 0, "nothing is touched while the journal cannot be understood");
    }

    #[test]
    fn recover_with_no_journal_is_a_clean_nothing_to_do() {
        let st = store();
        let r = run(&args(&["--recover"]), &st.env, &deps(&fresh()));
        assert_eq!((r.code, r.message.as_str()), (OpCode::Ok, "nothing to recover"));
    }

    #[test]
    fn recovery_runs_first_on_every_start_before_the_target_is_resolved() {
        let st = store();
        let s = fresh();
        // a run that died after the clone existed
        { let mut x = s.borrow_mut(); x.dbs.insert("pos_next".into(), "old"); x.gateway = crate::ops::fake::Gw::Maintenance; x.recovery_suspended = true; x.stack_up = false; x.roles_login = false; }
        let mut j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("old".into()), Some("new".into()));
        j.step = crate::ops::journal::Step::CloneDb;
        j.phase = crate::ops::journal::Phase::Done;
        j.write(&st.env.update_dir()).unwrap();
        s.borrow_mut().journal = Some(j.clone());
        let d = deps(&s);
        let mut d = d;
        d.idle = Some("TRADING"); // stop after the target is known, before a second operation could start
        let r = run(&args(&["--window-aware"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert!(d.resolved_at_call.get().unwrap() > 0, "the target was resolved before the world was touched by recovery");
        assert!(!s.borrow().dbs.contains_key("pos_next"), "the interrupted clone was cleaned up");
    }

    #[test]
    fn if_available_without_a_newer_pack_is_ok_and_leaves_nothing_behind() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.target = None;
        let before = state_files(&st.env);
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!((r.code, r.data["updated"].as_bool(), r.data["reason"].as_str()), (OpCode::Ok, Some(false), Some("NO_UPDATE")));
        assert_eq!(state_files(&st.env), before);
        assert_eq!(s.borrow().calls, 0);
    }

    #[test]
    fn window_aware_defers_while_the_store_trades_and_remembers_when_it_first_saw_the_pack() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.idle = Some("OPEN_CAJA");
        let r = run(&args(&["--window-aware"]), &st.env, &d);
        assert_eq!((r.code, r.data["skipped"].as_bool(), r.data["reason"].as_str()), (OpCode::Ok, Some(true), Some("OPEN_CAJA")));
        let first = UpdateResultFile::read(&st.env.update_dir()).pending.unwrap().since_ms;
        s.borrow_mut().now += 50_000;
        d.idle = Some("RECENT_SALE");
        run(&args(&["--window-aware"]), &st.env, &d);
        let p = UpdateResultFile::read(&st.env.update_dir()).pending.unwrap();
        assert_eq!((p.since_ms, p.deferred_reason.as_str()), (first, "RECENT_SALE"));
        assert!(p.verified, "a deferral after resolve_target (fetch/install, signature checked) is a verified pack");
        assert_eq!(s.borrow().calls, 0);
        assert_eq!(crate::ops::lock::probe_for(&st.env.roots), crate::ops::lock::LockState::Free);
    }

    #[test]
    fn a_short_disk_refuses_with_the_numbers_and_records_it_in_the_result_file() {
        let gib = 1u64 << 30;
        let e = disk_check(5 * gib, 10 * gib, 0).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "DISK_SHORT"));
        assert!(e.message.contains("32 GiB needed") && e.message.contains("5 GiB free"), "{}", e.message);
        assert!(!disk_check(40 * gib, 10 * gib, 0).unwrap());
        assert!(disk_check(20 * gib, 10 * gib, 20 * gib).unwrap());
        // through the whole command
        let st = store();
        let s = fresh();
        let d = deps(&s);
        *d.precheck_err.borrow_mut() = Some(disk_check(5 * gib, 10 * gib, 0).unwrap_err());
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Precondition, 12, Some("DISK_SHORT")));
        let res = UpdateResultFile::read(&st.env.update_dir());
        assert_eq!((res.last_result.as_str(), res.last_reason.as_deref()), ("refused", Some("DISK_SHORT")));
        assert!(res.last_message.unwrap().contains("32 GiB needed"));
        assert_eq!(s.borrow().calls, 0);
    }

    #[test]
    fn a_maintenance_window_that_is_already_over_is_a_budget_failure_not_a_floor_run() {
        assert!(window_open(1000, 999).is_ok());
        for (deadline, now) in [(1000u64, 1000u64), (1000, 1001)] {
            let e = window_open(deadline, now).unwrap_err();
            assert_eq!((e.code, e.reason.as_str(), e.code.exit()), (OpCode::RolledBack, "MAINTENANCE_BUDGET", 16));
        }
        // through the whole command: dropping the old copies took longer than the whole budget
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.housekeeping_advances_clock_ms = 10_000_000;
        let r = run(&args(&["--max-maintenance-seconds", "60"]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RolledBack, Some("MAINTENANCE_BUDGET")), "{}", r.message);
        assert_eq!(s.borrow().calls, 0, "no fence, no clone: nothing was started");
        assert!(!state_files(&st.env).iter().any(|n| n.contains("journal")));
    }

    #[test]
    fn the_production_backup_runner_is_the_real_adapter_not_the_refusing_stub_and_no_skip_exists() {
        let st = store(); // not provisioned: the adapter says so, where MissingBackup would say BACKUP_UNAVAILABLE
        let e = production_backup(&st.env, "old").run(BackupReason::PreUpdate, 1000).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED"));
        let e = production_backup(&st.env, "old").run(BackupReason::PreSwitch, 1000).unwrap_err();
        assert_eq!(e.reason, "PRE_SWITCH_BACKUP_FAILED");
        assert!(UpdateArgs::command_has_no_skip_backup_flag());
    }

    #[test]
    fn the_backup_gate_passes_only_when_the_current_pack_has_the_backup_tools() {
        let st = store();
        let e = backup_gate(&st.env, "old", true).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "BACKUP_UNAVAILABLE"));
        let ctx = crate::backup::plan08_backup::ctx_from_env(&st.env, "old");
        for exe in [ctx.restic_exe(), ctx.pg_exe("pg_dump.exe")] {
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(exe, b"x").unwrap();
        }
        // tools alone are not enough: the store is not provisioned for backup
        let e = backup_gate(&st.env, "old", true).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "BACKUP_NOT_READY"), "{}", e.message);
        assert!(e.message.ends_with("run `posctl backup run`, then retry"), "{}", e.message);
        std::fs::create_dir_all(ctx.paths.backups()).unwrap();
        std::fs::create_dir_all(ctx.paths.state_dir()).unwrap();
        std::fs::create_dir_all(ctx.paths.conf_file().parent().unwrap()).unwrap();
        std::fs::write(ctx.paths.conf_file(), "{}").unwrap();
        let now = crate::util::now_unix() as i64;
        let mut bs = crate::backup::state::BackupState::load(&ctx.paths.state_file(), now).unwrap();
        bs.local = Some(crate::backup::state::SnapRef { id: "cafebabe".into(), at: now, reason: "hourly".into() });
        bs.save_in(&ctx).unwrap();
        backup_gate(&st.env, "old", true).unwrap();
        // stale, and tonight's attempt already failed: refused with the cause, before any fence
        bs.local.as_mut().unwrap().at = now - 30 * 3600;
        bs.last_error = Some("destination offline".into());
        bs.pre_update_failed_window = window_start_now(&st.env);
        bs.save_in(&ctx).unwrap();
        let e = backup_gate(&st.env, "old", true).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "BACKUP_NOT_READY"));
        assert!(e.message.contains("destination offline"), "{}", e.message);
        backup_gate(&st.env, "old", false).expect("a person at the console gets their own attempt");
        // stale with no failure this window: the one fenced attempt is allowed
        bs.pre_update_failed_window = 0;
        bs.save_in(&ctx).unwrap();
        backup_gate(&st.env, "old", true).unwrap();
    }

    #[test]
    fn a_secret_in_any_error_never_reaches_the_report() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.secrets = vec!["s3cr3t-token".into()];
        *d.precheck_err.borrow_mut() = Some(OpError::new(OpCode::PackInvalid, "PACK_X", "bad thing near s3cr3t-token and postgres://u:pw1@h/db"));
        let r = run(&args(&[]), &st.env, &d);
        let env = serde_json::to_string(&crate::envelope::Envelope::from_outcome("update", "0", "0", &Report { code: r.code, reason: r.reason.clone(), message: r.message.clone(), data: r.data.clone(), retryable: r.retryable, journal: None }.into_outcome())).unwrap();
        let all = format!("{} {} {:?} {}", r.message, r.reason.clone().unwrap_or_default(), r.data, env);
        assert!(!all.contains("s3cr3t-token") && !all.contains("pw1"), "{all}");
        assert_eq!(r.code, OpCode::PackInvalid);
    }

    // ---- the PM addendum: one budget for every psql wrapper, and no time cap on recovery (attempts bound it) ----
    #[test]
    fn the_production_world_and_every_psql_wrapper_share_one_budget() {
        let st = store();
        let d = RealDeps::new();
        let cfg = d.cfg_for(&st.env, "old", "new");
        assert!(cfg.db.admin.remaining.is_some(), "RealCfg.db.admin must be budgeted");
        assert!(d.admin(&st.env, "old").remaining.is_some());
        let psql = st._d.path().join("psql.cmd");
        std::fs::write(&psql, "@echo off\r\necho %PGOPTIONS%>\"%~dp0opts.txt\"\r\necho x\r\n").unwrap();
        let mut a = cfg.db.admin.clone();
        a.psql = psql;
        let opts = || std::fs::read_to_string(st._d.path().join("opts.txt")).unwrap();
        d.deadline_cell().store(u64::MAX, Ordering::Relaxed); // recovery
        a.exec_class("template1", "SELECT 1", crate::ops::swap::StmtClass::Quick).unwrap();
        assert!(opts().contains("statement_timeout=60000"), "{}", opts());
        a.scalar("template1", "SELECT 1").unwrap();
        assert!(opts().contains("statement_timeout=600000"), "{}", opts());
        // the same cell the update work reads: a normal run with two minutes left
        d.deadline_cell().store(now_wall_ms() + 120_000, Ordering::Relaxed);
        a.scalar("template1", "SELECT 1").unwrap();
        let ms: u64 = opts().split("statement_timeout=").nth(1).unwrap().trim().parse().unwrap();
        assert!((60_000..=120_000).contains(&ms), "{ms}");
    }

    /// A store that died mid-update: the journal on disk, the tills fenced, a clone lying around.
    fn crashed_store(started_ms: u64, now_ms: u64) -> (Store, Shared) {
        let st = store();
        let s = fresh();
        {
            let mut x = s.borrow_mut();
            x.now = now_ms;
            x.dbs.insert("pos_next".into(), "old");
            x.gateway = crate::ops::fake::Gw::Maintenance; x.recovery_suspended = true; x.stack_up = false; x.roles_login = false;
        }
        let mut j = Journal::new(OpKind::Update, "op", started_ms, started_ms + 900_000, Some("old".into()), Some("new".into()));
        j.step = crate::ops::journal::Step::CloneDb;
        j.phase = crate::ops::journal::Phase::Done;
        j.write(&st.env.update_dir()).unwrap();
        s.borrow_mut().journal = Some(j);
        (st, s)
    }
    /// A crash recovery cannot resolve (a swap was intended, neither database is there): every attempt really starts and fails.
    fn unresolvable_store() -> (Store, Shared) {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut j = Journal::read(&st.env.update_dir()).unwrap().unwrap();
        j.step = crate::ops::journal::Step::Swap;
        j.phase = crate::ops::journal::Phase::Intent;
        j.write(&st.env.update_dir()).unwrap();
        s.borrow_mut().dbs.remove("pos_next");
        (st, s)
    }
    fn recorded_attempts(st: &Store) -> Vec<serde_json::Value> {
        let j = Journal::read(&st.env.update_dir()).unwrap().unwrap();
        j.extra.get("recoverAttempts").and_then(serde_json::Value::as_array).cloned().unwrap_or_default()
    }
    fn write_attempts(st: &Store, by: &str, n: usize) {
        let mut j = Journal::read(&st.env.update_dir()).unwrap().unwrap();
        j.extra = serde_json::json!({ "recoverAttempts": (0..n).map(|i| serde_json::json!({ "atMs": T0 + i as u64, "by": by })).collect::<Vec<_>>() });
        j.write(&st.env.update_dir()).unwrap();
    }

    // ---- Task 9 ----
    fn sidecar(e: &Env) -> std::path::PathBuf { e.update_dir().join("fence-start-types.json") }

    #[test]
    fn a_fence_sidecar_with_no_journal_refuses_the_next_update_and_points_to_recover() {
        let st = store();
        let s = fresh();
        std::fs::write(sidecar(&st.env), "{}").unwrap();
        let d = deps(&s);
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("LEFTOVER_STATE")), "{}", r.message);
        assert!(r.message.contains("--recover"));
        assert!(sidecar(&st.env).exists(), "never deleted outside the unfence path");
        assert!(!d.fence_restored.get());
    }

    #[test]
    fn recover_restores_the_recorded_types_and_only_then_the_sidecar_goes() {
        let st = store();
        let s = fresh();
        std::fs::write(sidecar(&st.env), "{}").unwrap();
        let d = deps(&s);
        let r = run(&args(&["--recover"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert!(d.fence_restored.get() && !sidecar(&st.env).exists());
    }

    #[test]
    fn a_failed_restore_keeps_the_sidecar() {
        let st = store();
        std::fs::write(sidecar(&st.env), "{}").unwrap();
        let s = fresh();
        let mut d = deps(&s);
        d.fail_restore = true;
        let r = run(&args(&["--recover"]), &st.env, &d);
        assert_ne!(r.code, OpCode::Ok);
        assert!(sidecar(&st.env).exists());
    }

    #[test]
    fn housekeeping_outside_an_operation_goes_through_the_lock_and_does_nothing_when_it_is_held() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        let _other = acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "x", Duration::from_secs(0)).unwrap();
        let e = housekeeping_locked(&st.env, &d, "old").unwrap_err();
        assert_eq!(e.code, OpCode::LockHeld);
        assert_eq!(d.housekeeping_calls.get(), 0, "zero drops while another holder has the lock");
    }

    #[test]
    fn housekeeping_with_the_lock_free_runs_once_and_passes_the_journal_databases() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        housekeeping_locked(&st.env, &d, "old").unwrap();
        assert_eq!(d.housekeeping_calls.get(), 1);
    }

    #[test]
    fn housekeeping_refuses_on_an_unreadable_journal() {
        let st = store();
        std::fs::write(st.env.update_dir().join("journal.json"), "{ nope").unwrap();
        let s = fresh();
        let d = deps(&s);
        let e = housekeeping_locked(&st.env, &d, "old").unwrap_err();
        assert_eq!(e.code, OpCode::RecoveryNeeded);
        assert_eq!(d.housekeeping_calls.get(), 0);
    }

    // ---- FR6 ----
    fn marker(e: &Env) -> std::path::PathBuf { e.conf().join("Caddyfile.live") }

    #[test]
    fn h1_a_path_or_url_argument_never_becomes_part_of_the_child_log_name() {
        let d = tempfile::tempdir().unwrap();
        for a in [
            vec!["pack", "install", "--file", r"C:\Users\Shop Admin\AppData\Local\Temp\backend 1.2.0.pospack"],
            vec!["pack", "fetch", "--feed", "https://updates.example.com/feeds/stable.json?x=1&y=2"],
        ] {
            let prefix = child_log_prefix(&d.path().join("logs"), &a);
            let name = prefix.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.starts_with("cli-pack-") && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{name}");
            assert_eq!(prefix.parent().unwrap(), d.path().join("logs"), "no subfolder is made from an argument");
            std::fs::create_dir_all(prefix.parent().unwrap()).unwrap();
            std::fs::File::create(prefix.with_extension("out.log")).unwrap(); // what run_with_timeout does
        }
    }

    #[test]
    fn h2_a_missing_backup_refuses_before_the_lock_the_fence_and_the_journal() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.backup_missing = true;
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Precondition, 12, Some("BACKUP_UNAVAILABLE")), "{}", r.message);
        assert_eq!(s.borrow().calls, 0, "not one World call: nothing was fenced, so nothing was rolled back");
        assert!(!crate::ops::journal::path(&st.env.update_dir()).exists(), "no journal was written");
        assert_eq!(crate::ops::lock::probe_for(&st.env.roots), crate::ops::lock::LockState::Free);
        let res = UpdateResultFile::read(&st.env.update_dir());
        assert_eq!((res.last_result.as_str(), res.last_code.as_str()), ("refused", "PRECONDITION"), "recorded as a refusal, not a rollback");
    }

    #[test]
    fn h2b_a_backup_that_is_not_ready_refuses_before_the_lock_the_fence_and_the_journal() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.backup_not_ready = true;
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Precondition, 12, Some("BACKUP_NOT_READY")), "{}", r.message);
        assert_eq!(s.borrow().calls, 0, "nothing was fenced");
        assert!(!crate::ops::journal::path(&st.env.update_dir()).exists());
        assert_eq!(crate::ops::lock::probe_for(&st.env.roots), crate::ops::lock::LockState::Free);
        assert!(r.message.contains("no backup in the last 26 h"), "status shows the cause: {}", r.message);
    }

    #[test]
    fn m1_unattended_recovery_stops_trying_after_three_attempts_and_a_person_still_can() {
        let (st, s) = unresolvable_store();
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        for n in 1..=3 {
            let r = run(&a, &st.env, &deps(&s));
            assert_eq!(r.reason.as_deref(), Some("UNRESOLVABLE"), "attempt {n}: {}", r.message);
            let at = recorded_attempts(&st);
            assert_eq!(at.len(), n, "attempt {n} is recorded with its time");
            assert!(at[n - 1]["atMs"].as_u64().is_some());
        }
        let before = std::fs::read(crate::ops::journal::path(&st.env.update_dir())).unwrap();
        let calls = s.borrow().calls;
        let r = run(&a, &st.env, &deps(&s));
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RecoveryNeeded, Some("RECOVERY_ATTEMPTS_EXHAUSTED")), "{}", r.message);
        assert!(r.message.contains("support"), "{}", r.message);
        assert_eq!(s.borrow().calls, calls, "no further mutation");
        assert_eq!(std::fs::read(crate::ops::journal::path(&st.env.update_dir())).unwrap(), before, "and the journal is not touched");
        // a person at the console can still try (and it is written down as theirs, not the machine's)
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.reason.as_deref(), Some("UNRESOLVABLE"), "a hand run really attempts: {}", r.message);
        let at = recorded_attempts(&st);
        assert_eq!((at.len(), at[3]["by"].as_str()), (4, Some("hand")));
        assert_eq!(at.iter().filter(|x| x["by"] == "unattended").count(), 3, "a hand attempt neither adds to nor resets the machine's count");
    }

    #[test]
    fn a_run_without_the_scheduled_flag_is_by_hand_and_the_count_never_holds_it_back() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        write_attempts(&st, "unattended", 3);
        let r = run(&args(&[]), &st.env, &deps(&s)); // a plain `posctl update` that meets the journal
        assert_ne!(r.reason.as_deref(), Some("RECOVERY_ATTEMPTS_EXHAUSTED"), "{}", r.message);
        let at = r.data["recoverAttempts"].as_array().cloned().unwrap_or_default();
        assert_eq!(at.last().map(|x| x["by"].clone()), Some(serde_json::json!("hand")), "{:?}", r.data);
    }

    #[test]
    fn the_scheduled_flag_is_what_marks_a_run_unattended() {
        assert!(parse(&["--recover", "--scheduled"]).unwrap().scheduled && !parse(&["--recover"]).unwrap().scheduled);
        let (st, s) = crashed_store(T0, T0 + 60_000);
        write_attempts(&st, "unattended", 3);
        let r = run(&args(&["--recover", "--scheduled"]), &st.env, &deps(&s));
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RecoveryNeeded, Some("RECOVERY_ATTEMPTS_EXHAUSTED")), "{}", r.message);
        // the hourly check carries the same flag
        let r = run(&args(&["--if-available", "--window-aware", "--scheduled"]), &st.env, &deps(&s));
        assert_eq!(r.reason.as_deref(), Some("RECOVERY_ATTEMPTS_EXHAUSTED"), "{}", r.message);
    }

    #[test]
    fn a_recovery_refused_before_it_starts_is_not_an_attempt() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut d = deps(&s);
        d.fail_world = true;
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &d);
        assert_eq!(r.reason.as_deref(), Some("WORLD_UNAVAILABLE"), "{}", r.message);
        assert!(recorded_attempts(&st).is_empty(), "a gated-out run never burns an attempt");
        assert_eq!(s.borrow().calls, 0);
    }

    #[test]
    fn an_unattended_recovery_runs_however_long_ago_the_update_started() {
        let (st, s) = crashed_store(T0, T0 + 2 * 60 * 60_000); // the journal is two hours old: a power cut, a weekend
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::Ok, "time never holds a recovery back while the store is down: {}", r.message);
        let x = s.borrow();
        assert_eq!(x.gateway, crate::ops::fake::Gw::Live);
        assert!(!x.dbs.contains_key("pos_next"));
    }

    #[test]
    fn the_hourly_check_outside_the_window_still_recovers_first() {
        let (st, s) = crashed_store(T0, T0 + 2 * 60 * 60_000);
        let mut d = deps(&s);
        d.local_minute = 12 * 60; // noon: outside 01:00-05:00
        let r = run(&args(&["--if-available", "--window-aware", "--scheduled"]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Ok, Some("RECOVERED")), "a scheduled run that recovered reports it, exit 0, whatever the hour: {}", r.message);
        let x = s.borrow();
        assert_eq!(x.gateway, crate::ops::fake::Gw::Live, "the store is up again");
        assert!(!x.dbs.contains_key("pos_next") && x.journal.is_none(), "and the interrupted update was undone");
        assert!(r.data["recoveryNote"].as_str().is_some_and(|n| n.contains("rolled back")), "{:?}", r.data);
    }

    #[test]
    fn the_hourly_check_outside_the_window_with_no_journal_touches_nothing() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 12 * 60;
        let r = run(&args(&["--if-available", "--window-aware", "--scheduled"]), &st.env, &d);
        assert_eq!(r.reason.as_deref(), Some("OUTSIDE_WINDOW"), "{}", r.message);
        assert_eq!(s.borrow().calls, 0);
        assert!(state_files(&st.env).is_empty(), "no journal, no lock file left over");
    }

    #[test]
    fn a_scheduled_run_that_finds_the_lock_held_is_not_an_attempt() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let d = deps(&s);
        *d.holder.borrow_mut() = Some(acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap());
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &d);
        assert_eq!(r.code, OpCode::LockHeld, "{}", r.message);
        d.holder.borrow_mut().take();
        assert!(recorded_attempts(&st).is_empty());
    }

    #[test]
    fn a_hand_recover_after_the_machine_gave_up_is_allowed_and_works() {
        let (st, s) = crashed_store(T0, T0 + 2 * 60 * 60_000);
        write_attempts(&st, "unattended", 3);
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        assert_eq!(run(&a, &st.env, &deps(&s)).reason.as_deref(), Some("RECOVERY_ATTEMPTS_EXHAUSTED"));
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert_eq!(s.borrow().gateway, crate::ops::fake::Gw::Live);
    }

    #[test]
    fn a_run_that_finds_no_journal_leaves_nothing_behind_to_count() {
        let st = store();
        let s = fresh();
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &deps(&s));
        assert_eq!((r.code, r.message.as_str()), (OpCode::Ok, "nothing to recover"));
        assert!(!crate::ops::journal::path(&st.env.update_dir()).exists());
    }

    #[test]
    fn m2_the_recovery_cell_has_no_time_end_and_the_statement_cap_is_ten_minutes_flat() {
        let cell = recovery_cell();
        for class in [crate::ops::swap::StmtClass::Default, crate::ops::swap::StmtClass::Heavy] {
            assert_eq!(crate::update::work::statement_budget_ms(class, cell, now_wall_ms()), 600_000, "{class:?}");
            assert_eq!(crate::update::work::statement_budget_ms(class, cell, u64::MAX / 4), 600_000, "{class:?}: however late the clock says it is");
        }
        // and through the real psql wrapper the production deps build: the server is told ten minutes
        let st = store();
        let d = RealDeps::new();
        d.deadline_cell().store(cell, Ordering::Relaxed);
        let mut a = d.admin(&st.env, "old");
        std::fs::write(st.env.data.join("psql.cmd"), "@echo off
echo %PGOPTIONS%>\"%~dp0env.txt\"
").unwrap();
        std::fs::write(st.env.data.join("pgpass.conf"), "x").unwrap();
        a.psql = st.env.data.join("psql.cmd");
        a.pgpass = st.env.data.join("pgpass.conf");
        a.exec("postgres", "SELECT 1").unwrap();
        let env = std::fs::read_to_string(st.env.data.join("env.txt")).unwrap();
        let t: u64 = env.split("statement_timeout=").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap();
        assert_eq!(t, 600_000, "{env}");
    }

    #[test]
    fn m2_recovery_stores_the_recovery_flag_in_the_shared_cell() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let d = deps(&s);
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let _ = run(&a, &st.env, &d);
        assert_eq!(d.deadline.load(Ordering::Relaxed), recovery_cell(), "the flag and no end time");
    }

    #[test]
    fn m3_unreadable_secrets_refuse_before_anything_is_touched() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.secrets_err = true;
        for a in [args(&[]), args(&["--dry-run"])] {
            let r = run(&a, &st.env, &d);
            assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("SECRETS_UNREADABLE")), "{}", r.message);
        }
        assert_eq!(s.borrow().calls, 0);
        assert!(state_files(&st.env).is_empty(), "no journal, no result file");
    }

    #[test]
    fn m4_a_dry_run_reports_an_interrupted_operation_instead_of_recovering_it() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let d = deps(&s);
        let before = std::fs::read(crate::ops::journal::path(&st.env.update_dir())).unwrap();
        let calls = s.borrow().calls;
        let r = run(&args(&["--dry-run"]), &st.env, &d);
        assert_eq!((r.code, r.data["recoveryPending"].as_bool()), (OpCode::RecoveryNeeded, Some(true)), "{}", r.message);
        assert_eq!(s.borrow().calls, calls, "zero mutations");
        assert_eq!(d.resolved_at_call.get(), None, "the pending pack was not even resolved (no install, no fetch)");
        assert_eq!(std::fs::read(crate::ops::journal::path(&st.env.update_dir())).unwrap(), before);
        assert!(s.borrow().dbs.contains_key("pos_next"), "the interrupted clone is still there");
    }

    #[test]
    fn m4_resolving_the_target_in_a_dry_run_spawns_no_child() {
        // posctl.exe does not exist in this store: a child spawn would be an error
        let st = store();
        for v in ["1.0.0-r1", "1.1.0-r1"] { std::fs::create_dir_all(st.env.program.join("packs").join(v)).unwrap(); }
        let d = RealDeps::new();
        let t = d.resolve_target(&args(&["--dry-run", "--if-available"]), &st.env, "1.0.0-r1").unwrap();
        assert_eq!(t, None, "nothing valid and newer is installed, and the feed is not fetched in a dry run");
        let t = d.resolve_target(&args(&["--dry-run", "--pack", "1.1.0-r1"]), &st.env, "1.0.0-r1").unwrap();
        assert_eq!(t.as_deref(), Some("1.1.0-r1"));
        let e = d.resolve_target(&args(&["--dry-run", "--pack", r"C:\x\y.pospack"]), &st.env, "1.0.0-r1").unwrap_err();
        assert!(e.message.contains("dry run"), "a file cannot be installed in a dry run: {}", e.message);
    }

    #[test]
    fn t_the_journal_is_read_after_the_lock_on_the_normal_path_too() {
        let st = store();
        std::fs::write(crate::ops::journal::path(&st.env.update_dir()), b"{ torn").unwrap();
        let _held = acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap();
        let s = fresh();
        let r = run(&args(&["--if-available"]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::LockHeld, "{}", r.message);
    }

    #[test]
    fn t_a_secret_in_an_error_never_reaches_the_result_file() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.secrets = vec!["s3cr3t-token-value".into()];
        *d.precheck_err.borrow_mut() = Some(OpError::new(OpCode::Precondition, "X", "failed with s3cr3t-token-value inside"));
        let r = run(&args(&[]), &st.env, &d);
        assert!(!r.message.contains("s3cr3t-token-value"));
        let text = std::fs::read_to_string(st.env.update_dir().join("update-result.json")).unwrap();
        assert!(text.contains("refused") && !text.contains("s3cr3t-token-value"), "{text}");
    }

    #[test]
    fn x1_a_leftover_live_caddyfile_with_no_journal_is_refused_and_cleared_by_recover() {
        let st = store();
        std::fs::create_dir_all(st.env.conf()).unwrap();
        std::fs::write(marker(&st.env), "LIVE").unwrap();
        let s = fresh();
        let d = deps(&s);
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("LEFTOVER_STATE")), "{}", r.message);
        assert!(r.message.contains("--recover") && marker(&st.env).exists());
        let r = run(&args(&["--recover"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert!(d.fence_restored.get() && !marker(&st.env).exists());
    }

    // ---- FR7 ----
    fn write_window(st: &Store, w: Option<(&str, &str)>) {
        std::fs::create_dir_all(st.env.conf()).unwrap();
        let mut c = crate::config::PosctlJson::new("offline-only", "store", 47300, "shop-pc", "old");
        c.maintenance.window = w.map(|(s, e)| crate::config::MaintenanceWindow { start: s.into(), end: e.into() });
        c.save(&st.env.roots).unwrap();
    }

    #[test]
    fn w_outside_the_window_refuses_before_anything_is_touched() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 9 * 60; // the PC was off at 02:30 and booted at 09:00
        let r = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref(), r.retryable), (OpCode::Precondition, 12, Some("OUTSIDE_WINDOW"), true), "{}", r.message);
        assert_eq!(s.borrow().calls, 0);
        assert_eq!(d.resolved_at_call.get(), None, "no pack was resolved: nothing installed or fetched");
        assert_eq!(d.housekeeping_calls.get(), 0, "and no database was dropped");
        assert!(state_files(&st.env).is_empty(), "no journal, no result file");
    }

    #[test]
    fn w_inside_the_default_window_the_update_goes_on() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 2 * 60 + 30;
        let r = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert_eq!(r.data["updated"].as_bool(), Some(true));
    }

    #[test]
    fn w_the_window_comes_from_posctl_json_and_may_wrap_midnight() {
        let st = store();
        write_window(&st, Some(("22:00", "06:00")));
        for (minute, ok) in [(23 * 60, true), (2 * 60, true), (12 * 60, false), (6 * 60, false)] {
            let s = fresh();
            let mut d = deps(&s);
            d.local_minute = minute;
            let r = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
            assert_eq!(r.reason.as_deref() != Some("OUTSIDE_WINDOW"), ok, "minute {minute}: {}", r.message);
            let _ = std::fs::remove_file(st.env.update_dir().join("update-result.json"));
        }
    }

    #[test]
    fn w_a_run_that_is_not_window_aware_does_not_consult_the_clock() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 9 * 60;
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
    }

    #[test]
    fn a_pack_change_between_the_prechecks_and_the_operation_lock_refuses_pack_changed() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        // the first read (before the prechecks) says "old"; another operation switched the pack before the final lock
        *d.packs.borrow_mut() = ["old", "switched"].map(String::from).into();
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref(), r.retryable), (OpCode::Precondition, 12, Some("PACK_CHANGED"), true), "{}", r.message);
        assert_eq!(s.borrow().calls, 0, "the machine was not touched");
        assert!(Journal::read(&st.env.update_dir()).unwrap().is_none(), "no journal was written");
    }

    #[test]
    fn a_run_that_drifts_out_of_the_window_during_the_prechecks_refuses_outside_window_before_the_fence() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        *d.minutes.borrow_mut() = [2 * 60 + 59, 5 * 60 + 1].into(); // in at the start, over by the time the lock is held
        let r = run(&args(&["--window-aware"]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref(), r.retryable), (OpCode::Precondition, 12, Some("OUTSIDE_WINDOW"), true), "{}", r.message);
        assert!(d.resolved_at_call.get().is_some(), "the pack was resolved (and stays installed for the next window)");
        assert_eq!(s.borrow().calls, 0, "the tills were never fenced");
        assert!(Journal::read(&st.env.update_dir()).unwrap().is_none(), "nothing was journalled");
    }

    #[test]
    fn w_housekeeping_waits_for_the_window_and_the_idle_check() {
        for (idle, minute, want) in [(Some("OPEN_CAJA"), 150, 0), (None, 540, 0), (None, 150, 1)] {
            let st = store();
            let s = fresh();
            let mut d = deps(&s);
            d.target = None;
            d.idle = idle;
            d.local_minute = minute;
            let _ = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
            assert_eq!(d.housekeeping_calls.get(), want, "idle {idle:?} at minute {minute}");
        }
    }

    #[test]
    fn p_the_boot_recover_task_retries_a_held_lock_five_times_ten_seconds_apart() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        // released after the second sleep
        let d = deps(&s);
        *d.holder.borrow_mut() = Some(acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap());
        d.release_after.set(2);
        let r = run(&a, &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert_eq!(*d.sleeps.borrow(), [Duration::from_secs(10), Duration::from_secs(10)]);
        // never released: five sleeps, then LOCK_HELD
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let d = deps(&s);
        *d.holder.borrow_mut() = Some(acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap());
        let r = run(&a, &st.env, &d);
        assert_eq!(r.code, OpCode::LockHeld, "{}", r.message);
        assert_eq!(d.sleeps.borrow().len(), 5);
    }

    #[test]
    fn p_a_hand_run_does_not_retry_a_held_lock() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        *d.holder.borrow_mut() = Some(acquire(&st.env.update_dir(), LockMode::Exclusive, "update", "other", Duration::from_secs(0)).unwrap());
        let r = run(&args(&["--recover"]), &st.env, &d);
        assert_eq!(r.code, OpCode::LockHeld);
        assert!(d.sleeps.borrow().is_empty());
    }

    #[test]
    fn la_the_housekeeping_after_an_update_protects_the_databases_the_operation_just_made() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        let prev = r.data["prevDb"].as_str().unwrap().to_string();
        let seen = d.protected_seen.borrow();
        assert!(seen.last().is_some_and(|p| p.contains(&prev)), "the post-update drop must not be free to take {prev}: {seen:?}");
    }

    #[test]
    fn l2_a_plain_update_with_nothing_to_install_is_an_error_and_if_available_is_not() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.target = None;
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.code.exit(), r.reason.as_deref()), (OpCode::Precondition, 12, Some("NO_PACK")), "{}", r.message);
        assert_eq!(d.housekeeping_calls.get(), 0);
        let r = run(&args(&["--if-available"]), &st.env, &d);
        assert_eq!((r.code, r.data["reason"].as_str()), (OpCode::Ok, Some("NO_UPDATE")));
    }

    #[test]
    fn l4_a_childs_own_exit_code_is_passed_through() {
        let v = serde_json::json!({"code": "LOCK_HELD", "exit": 10, "message": "another operation holds the lock", "data": {"reason": "LOCK_HELD"}});
        let e = child_failure(&v, false);
        assert_eq!((e.code, e.retryable, e.reason.as_str()), (OpCode::LockHeld, true, "LOCK_HELD"));
        assert_eq!(child_failure(&serde_json::json!({"exit": 13, "message": "bad signature", "data": {"reason": "MANIFEST_SIGNATURE"}}), false).code, OpCode::PackInvalid);
        assert_eq!(child_failure(&serde_json::json!({"exit": 12, "message": "disk"}), false).code, OpCode::Precondition);
        assert_eq!(child_failure(&serde_json::json!({"exit": 77}), false).code, OpCode::PackInvalid, "an exit this build does not know stays a pack problem");
        assert_eq!(child_failure(&serde_json::json!({"exit": 0}), true).code, OpCode::PackInvalid, "a timeout is not a success");
    }

    /// A crash after the swap (the reopen was reached): recovery rolls FORWARD to the new pack.
    fn swapped_store() -> (Store, Shared) {
        let st = store();
        let s = fresh();
        let mut j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("old".into()), Some("new".into()));
        j.step = crate::ops::journal::Step::Reopen;
        j.phase = crate::ops::journal::Phase::Done;
        {
            let mut x = s.borrow_mut();
            x.now = T0 + 60_000;
            x.dbs.insert(j.db.prev.clone(), "old");
            x.gateway = crate::ops::fake::Gw::Maintenance; x.recovery_suspended = true; x.stack_up = false; x.roles_login = false;
        }
        j.write(&st.env.update_dir()).unwrap();
        s.borrow_mut().journal = Some(j);
        (st, s)
    }
    fn pending_pack(st: &Store, pack: &str) {
        let mut res = UpdateResultFile::default();
        res.note_pending(pack, "OPEN_CAJA", T0, true);
        res.write(&st.env.update_dir()).unwrap();
    }

    #[test]
    fn a_recovery_that_rolls_forward_records_updated_and_clears_the_pending_pack() {
        for (pending, cleared) in [("new", true), ("newer", false)] {
            let (st, s) = swapped_store();
            pending_pack(&st, pending);
            let r = run(&args(&["--recover"]), &st.env, &deps(&s));
            assert_eq!(r.code, OpCode::Ok, "{}", r.message);
            assert!(r.data["recovered"].as_bool() == Some(true), "{:?}", r.data);
            let res = UpdateResultFile::read(&st.env.update_dir());
            assert_eq!((res.last_result.as_str(), res.last_code.as_str()), ("updated", "OK"), "{res:?}");
            assert_eq!((res.pack_from.as_deref(), res.pack_to.as_deref()), (Some("old"), Some("new")));
            assert!(res.last_at_ms >= T0 + 60_000, "{res:?}");
            assert_eq!(res.pending.is_none(), cleared, "pending {pending}: {res:?}");
        }
    }

    #[test]
    fn a_recovery_that_rolls_back_records_rolled_back_with_the_reason_and_keeps_the_pending_pack() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        pending_pack(&st, "new");
        let r = run(&args(&["--recover"]), &st.env, &deps(&s));
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        let res = UpdateResultFile::read(&st.env.update_dir());
        assert_eq!((res.last_result.as_str(), res.last_code.as_str(), res.last_reason.as_deref()), ("rolled_back", "ROLLED_BACK", Some("RECOVERED_AFTER_INTERRUPTION")), "{res:?}");
        assert_eq!((res.pack_from.as_deref(), res.pack_to.as_deref()), (Some("old"), Some("new")));
        assert!(res.pending.is_some(), "a rolled-back update leaves the pack pending");
    }

    #[test]
    fn l5_a_recovery_that_ran_first_is_reported_with_the_normal_run() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut d = deps(&s);
        d.idle = Some("TRADING");
        let r = run(&args(&["--window-aware"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert!(r.data["recoveryNote"].as_str().is_some_and(|n| n.contains("rolled back")), "{:?}", r.data);
    }

    #[test]
    fn l1_the_envelope_is_built_from_the_outcome_like_every_other_command() {
        let r = Report::new(OpCode::LockHeld, Some("LOCK_HELD"), "another update runs", serde_json::json!({}), true);
        let o = r.into_outcome();
        let e = crate::envelope::Envelope::from_outcome("update", "2026-10-02T00:00:00Z", "2026-10-02T00:00:01Z", &o);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!((v["ok"].as_bool(), v["code"].as_str(), v["exit"].as_i64(), v["retryable"].as_bool()), (Some(false), Some("LOCK_HELD"), Some(10), Some(true)), "{v}");
    }

    #[test]
    fn d_a_database_too_big_for_the_disk_is_refused_by_precheck_itself_with_the_numbers() {
        let st = store();
        let prog = &st.env.program;
        for v in ["1.0.0-r1", "1.0.1-r1"] { std::fs::create_dir_all(prog.join("packs").join(v).join("migrations")).unwrap(); }
        for f in ["20260101_a.sql", "20260102_b.sql"] { std::fs::write(prog.join("packs").join("1.0.1-r1").join("migrations").join(f), "select 1;").unwrap(); }
        std::fs::create_dir_all(st.env.conf()).unwrap();
        std::fs::write(st.env.conf().join("Caddyfile.maintenance"), "MAINT").unwrap();
        std::fs::create_dir_all(st.env.roots.pgdata()).unwrap();
        let dir = st.env.data.join("fake");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("m.txt"), "20260101").unwrap();
        std::fs::write(dir.join("n.txt"), "postgres").unwrap();
        std::fs::write(dir.join("s.txt"), "9000000000000000").unwrap(); // 9 petabytes
        std::fs::write(dir.join("psql.cmd"), "@echo off\r\necho %* | findstr /C:\"schema_migrations\" >nul && (type \"%~dp0m.txt\" & exit /b 0)\r\necho %* | findstr /C:\"pg_database_size\" >nul && (type \"%~dp0s.txt\" & exit /b 0)\r\ntype \"%~dp0n.txt\"\r\n").unwrap();
        std::fs::write(dir.join("pgpass.conf"), "x").unwrap();
        let mut d = RealDeps::new();
        d.psql_override = Some(dir.join("psql.cmd"));
        let from = Manifest::for_test("1.0.0-r1", "1.0.0", 1, "20260101");
        let to = Manifest::for_test("1.0.1-r1", "1.0.1", 2, "20260102");
        let e = d.precheck(&st.env, "1.0.0-r1", &from, &to, false).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "DISK_SHORT"), "{e:?}");
        assert!(e.message.contains("GiB needed") && e.message.contains("free"), "{}", e.message);
    }

    // ---- FR7 addendum ----
    #[test]
    fn a3_a_recovery_goes_on_without_the_secrets_but_says_nothing_but_codes() {
        let (st, s) = crashed_store(T0, T0 + 60_000);
        let mut d = deps(&s);
        d.secrets_err = true;
        let r = run(&args(&["--recover"]), &st.env, &d);
        assert_eq!(r.code, OpCode::Ok, "fenced for ever is worse than an unscrubbed recovery: {}", r.message);
        assert!(r.message.contains("withheld"), "{}", r.message);
        assert_eq!(r.data["recovered"].as_bool(), Some(true), "numbers and flags survive");
        assert!(!s.borrow().dbs.contains_key("pos_next"), "and the recovery really ran");
    }

    #[test]
    fn a3_a_failing_recovery_without_secrets_reports_its_code_and_no_text() {
        let (st, s) = unresolvable_store();
        let mut d = deps(&s);
        d.secrets_err = true;
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::RecoveryNeeded, Some("UNRESOLVABLE")));
        assert!(r.message.contains("withheld"), "{}", r.message);
        fn strings(v: &serde_json::Value, out: &mut Vec<String>) {
            match v { serde_json::Value::String(s) => out.push(s.clone()), serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)), serde_json::Value::Object(o) => o.values().for_each(|x| strings(x, out)), _ => {} }
        }
        let mut all = vec![]; strings(&r.data, &mut all);
        assert!(all.iter().all(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')), "only code words in data: {all:?}");
    }

    #[test]
    fn a4_the_production_deps_refuse_the_backup_explicitly() {
        let st = store();
        let e = RealDeps::new().backup_available(&st.env, true).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "BACKUP_UNAVAILABLE"));
    }

    #[test]
    fn a6_the_recovery_attempts_are_in_the_outcome_data() {
        let (st, s) = unresolvable_store();
        let mut a = args(&["--recover"]);
        a.scheduled = true;
        let r = run(&a, &st.env, &deps(&s));
        let at = r.data["recoverAttempts"].as_array().cloned().unwrap_or_default();
        assert_eq!(at.len(), 1, "{:?}", r.data);
        assert!(at[0]["atMs"].as_u64().is_some() && at[0]["by"] == "unattended");
        for _ in 0..2 { let _ = run(&a, &st.env, &deps(&s)); }
        let r = run(&a, &st.env, &deps(&s));
        assert_eq!(r.reason.as_deref(), Some("RECOVERY_ATTEMPTS_EXHAUSTED"));
        assert_eq!(r.data["recoverAttempts"].as_array().map(|x| x.len()), Some(3), "{:?}", r.data);
    }

    #[test]
    fn precheck_refuses_a_replication_slot_before_fencing() {
        let st = store();
        let s = fresh();
        let d = deps(&s);
        *d.precheck_err.borrow_mut() = Some(crate::update::precheck::slot_gate("1").unwrap_err());
        let r = run(&args(&[]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("REPLICATION_SLOT_PRESENT")), "{}", r.message);
        assert_eq!(s.borrow().calls, 0, "the world was never called: nothing was fenced");
        assert!(crate::update::precheck::slot_gate("0").is_ok());
        assert_eq!(crate::update::precheck::slot_gate("x").unwrap_err().reason, "REPLICATION_SLOT_UNREADABLE");
    }

    // ---- FR9 item 7: no re-download of a pack that is already here ----
    #[test]
    fn a_deferred_hourly_run_does_not_fetch_a_pack_that_is_already_installed() {
        let fetches = std::cell::Cell::new(0);
        let fetch = || -> R<String> { fetches.set(fetches.get() + 1); Ok("1.1.0-r1".to_string()) };
        let installed = vec![("1.0.0-r1".to_string(), true), ("1.1.0-r1".to_string(), true)];
        let peek = || Some("1.1.0-r1".to_string());
        // the pack the feed names is installed and verified: the same answer as the fetch would give, with ZERO downloads
        assert_eq!(resolve_from_feed("1.0.0-r1", &installed, &peek, &fetch).unwrap().as_deref(), Some("1.1.0-r1"));
        assert_eq!(fetches.get(), 0);
        // the feed names the running pack: nothing to do, still no download
        assert_eq!(resolve_from_feed("1.1.0-r1", &installed, &peek, &fetch).unwrap(), None);
        assert_eq!(fetches.get(), 0);
    }

    #[test]
    fn the_feed_is_fetched_when_the_pack_is_missing_unverified_or_the_peek_fails() {
        let fetches = std::cell::Cell::new(0);
        let fetch = || -> R<String> { fetches.set(fetches.get() + 1); Ok("1.1.0-r1".to_string()) };
        let peek = || Some("1.1.0-r1".to_string());
        let not_there = vec![("1.0.0-r1".to_string(), true)];
        assert_eq!(resolve_from_feed("1.0.0-r1", &not_there, &peek, &fetch).unwrap().as_deref(), Some("1.1.0-r1"));
        let broken = vec![("1.0.0-r1".to_string(), true), ("1.1.0-r1".to_string(), false)];
        assert_eq!(resolve_from_feed("1.0.0-r1", &broken, &peek, &fetch).unwrap().as_deref(), Some("1.1.0-r1"));
        assert_eq!(resolve_from_feed("1.0.0-r1", &not_there, &|| None, &fetch).unwrap().as_deref(), Some("1.1.0-r1"));
        assert_eq!(fetches.get(), 3, "each of the three ran the fetch once");
    }

    // ---- FR20 item 2: a rolled-back bundle must not shadow a newer pack on the feed ----
    // `resolve_bundle_then_feed(current, skip, bundle_version, install_bundle, feed)`: `skip` is the rolled-back version on a scheduled run (None on a hand run);
    // `bundle_version` is read from the verified pack file WITHOUT installing it; `install_bundle` runs only for the candidate that is chosen.
    // When every candidate is the skipped version it returns Some(skip), so `run` answers SKIPPED_ROLLED_BACK exactly as it does today.
    fn bundle_vs_feed(current: &str, skip: Option<&str>, bundle: Option<&str>, feed: Option<&str>) -> (Option<String>, u32, u32) {
        let (installs, feeds) = (std::cell::Cell::new(0u32), std::cell::Cell::new(0u32));
        let install = || -> R<()> { installs.set(installs.get() + 1); Ok(()) };
        let feed_fn = || -> R<Option<String>> { feeds.set(feeds.get() + 1); Ok(feed.map(str::to_string)) };
        let got = resolve_bundle_then_feed(current, skip, bundle, &install, &feed_fn).unwrap();
        (got, installs.get(), feeds.get())
    }

    #[test]
    fn a_rolled_back_bundle_is_skipped_for_a_newer_pack_on_the_feed_and_not_installed() {
        let (got, installs, _) = bundle_vs_feed("1.0.0-r1", Some("1.1.0-r1"), Some("1.1.0-r1"), Some("1.1.1-r1"));
        assert_eq!(got.as_deref(), Some("1.1.1-r1"), "the fixed pack on the feed is reached");
        assert_eq!(installs, 0, "the bundle that is being skipped is not installed again");
    }

    #[test]
    fn a_rolled_back_bundle_with_nothing_newer_on_the_feed_is_still_skipped_rolled_back_and_not_installed() {
        // the feed has nothing newer than the running pack
        let (got, installs, feeds) = bundle_vs_feed("1.0.0-r1", Some("1.1.0-r1"), Some("1.1.0-r1"), None);
        assert_eq!(got.as_deref(), Some("1.1.0-r1"), "the rolled-back version comes back, so `run` reports SKIPPED_ROLLED_BACK");
        assert_eq!((installs, feeds), (0, 1), "the feed was consulted, the bundle was not installed");
        // the feed only offers the very version that rolled back
        let (got, installs, _) = bundle_vs_feed("1.0.0-r1", Some("1.1.0-r1"), Some("1.1.0-r1"), Some("1.1.0-r1"));
        assert_eq!((got.as_deref(), installs), (Some("1.1.0-r1"), 0));
    }

    #[test]
    fn a_hand_run_still_picks_the_rolled_back_bundle() {
        // no skip (a person typed `update`): today's behaviour, bundle first, installed, feed untouched
        let (got, installs, feeds) = bundle_vs_feed("1.0.0-r1", None, Some("1.1.0-r1"), Some("1.1.1-r1"));
        assert_eq!(got.as_deref(), Some("1.1.0-r1"));
        assert_eq!((installs, feeds), (1, 0));
    }

    #[test]
    fn a_rolled_back_bundle_does_not_need_a_feed_but_a_plain_run_still_does() {
        let no_feed = || -> R<Option<String>> { Err(OpError::new(OpCode::Precondition, "NO_FEED", "pack.feedUrl is not set")) };
        let install = || -> R<()> { Ok(()) };
        // scheduled, the bundle is the rolled-back version, no feed configured: no candidate, so the caller reports SKIPPED_ROLLED_BACK
        let got = resolve_bundle_then_feed("1.0.0-r1", Some("1.1.0-r1"), Some("1.1.0-r1"), &install, &no_feed).unwrap();
        assert_eq!(got.as_deref(), Some("1.1.0-r1"));
        // no skip and no usable bundle: the missing feed is still the error it always was
        let e = resolve_bundle_then_feed("1.0.0-r1", None, None, &install, &no_feed).unwrap_err();
        assert_eq!(e.reason, "NO_FEED");
        // any other feed failure is never swallowed, skip or not
        let boom = || -> R<Option<String>> { Err(OpError::err("FEED_DOWN", "x")) };
        assert!(resolve_bundle_then_feed("1.0.0-r1", Some("1.1.0-r1"), Some("1.1.0-r1"), &install, &boom).is_err());
    }

    // ---- FR8 ----
    #[test]
    fn f1_outside_the_window_a_newer_pack_is_still_recorded_as_pending() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 9 * 60;
        d.peek = Some("new".into());
        let r = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
        assert_eq!((r.code, r.reason.as_deref()), (OpCode::Precondition, Some("OUTSIDE_WINDOW")));
        assert_eq!(s.borrow().calls, 0, "still no World call");
        assert_eq!(d.resolved_at_call.get(), None, "nothing installed or fetched");
        assert_eq!(d.housekeeping_calls.get(), 0);
        let res = UpdateResultFile::read(&st.env.update_dir());
        let p = res.pending.expect("pending recorded");
        assert_eq!((p.pack_version.as_str(), p.deferred_reason.as_str()), ("new", "OUTSIDE_WINDOW"));
        assert!(!p.verified, "the hourly peek reads an unsigned feed: nothing is verified yet");
        // a later run keeps the first-seen time, so PACK_UPDATE_AVAILABLE ages from the first night
        let first = p.since_ms;
        s.borrow_mut().now += 3_600_000;
        let _ = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
        assert_eq!(UpdateResultFile::read(&st.env.update_dir()).pending.unwrap().since_ms, first);
    }

    #[test]
    fn f1_no_newer_pack_and_a_run_inside_the_window_leave_the_pending_alone() {
        let st = store();
        let s = fresh();
        let mut d = deps(&s);
        d.local_minute = 9 * 60;
        let _ = run(&args(&["--if-available", "--window-aware"]), &st.env, &d); // nothing newer in the feed
        assert!(state_files(&st.env).is_empty(), "nothing to remember, nothing written");
        d.local_minute = 150;
        d.peek = Some("new".into());
        let _ = run(&args(&["--if-available", "--window-aware"]), &st.env, &d);
        assert_eq!(d.peeked.get(), 1, "the feed is only peeked at when the run is refused");
    }

    #[test]
    fn f5_the_lock_probe_creates_no_lock_file_and_deletes_no_holder_info() {
        let st = store();
        let state = st.env.update_dir();
        assert_eq!(lock_state_unknown(&st.env), None);
        assert!(!state.join("update.lock").exists(), "a probe must not create the lock file");
        std::fs::write(state.join("update.lock"), "").unwrap();
        std::fs::write(state.join("update.lock.info"), br#"{"pid":1,"op_id":"x","kind":"update","started_ms":1}"#).unwrap();
        assert_eq!(lock_state_unknown(&st.env), None);
        assert!(state.join("update.lock.info").exists(), "and must not delete .info");
    }

    #[test]
    fn a_posctl_child_gets_the_roots_only_under_dev() {
        let mut e = env();
        e.roots.dev = false;
        let a = cli_args(&e, &["pack", "install"]);
        assert_eq!(a, ["pack", "install", "--json"], "{a:?}");
        e.roots.dev = true;
        let a = cli_args(&e, &["pack", "install"]);
        for flag in ["--dev", "--data-root", "--program-root"] {
            assert!(a.iter().any(|x| x == flag), "{flag} missing: {a:?}");
        }
    }
}

