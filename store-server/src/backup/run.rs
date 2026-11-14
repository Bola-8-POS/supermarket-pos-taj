//! `backup run`: one dump inside one exported snapshot, fingerprints from the same instant, the photos
//! folder, a local restic snapshot, then a copy to every destination. The tick decides what is due.
//! Plans 07/09 call `run_backup` in process with the update lock already held.
//!
//! The plaintext dump (it holds `profiles.pin` and SCRAM verifiers, S7 I4) only ever exists inside a per-run
//! `PrivateDir` under `backups\tmp\`, and that folder is removed on every exit path: the Drop guard covers errors
//! and panics, `acl::sweep_stale` covers a crash. Nothing read from a dump is logged.
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

use super::acl::{self, PrivateDir};
use super::config::{self, BackupConfig, DestKind};
use super::ctx::BackupCtx;
use super::dest;
use super::dump::{self, DbInfo, Manifest};
use super::fingerprint::{parse_catalog, parse_table_fp, TableFp};
use super::keys;
use super::paths::restic_path;
use super::pg::{self, PgConn, PsqlOpener, SnapshotOpener, SnapshotQueries};
use super::policy::{copy_pending, decide, dest_copy_due, Decision, Observed, DEVICE_COPY_RETRY_SECS, R2_COPY_RETRY_SECS};
pub use super::policy::Reason;
use super::repo::{dest_repo, ensure_local_repo};
use super::maintain::{self, MAINTENANCE_EVERY_SECS};
use super::restic::{self, parse_backup_summary, run_restic, run_restic_with, snapshot_tags};
use super::result::{BResult, BackupError};
use super::state::{BackupState, DestState, PhotosUnreadableRef, SnapRef};
use super::util::{free_bytes, hex, lock_down_file, now_secs, random_bytes, tail, write_atomic, write_atomic_prepared, Exec, RealExec};
use crate::ops::lock::{acquire_for, LockMode};
use crate::ops::outcome::{OpCode, OpError};

/// Everything `run_backup` needs from the outside world; owned so Plan 07's adapter can store it.
pub struct Deps {
    pub exec: Box<dyn Exec>,
    pub opener: Box<dyn SnapshotOpener>,
    pub now: fn() -> i64,
    /// Free bytes on the volume holding a path (a seam so tests can simulate a full disk).
    pub free_bytes: fn(&Path) -> std::io::Result<u64>,
}

impl Deps {
    pub fn real() -> Deps {
        Deps { exec: Box::new(RealExec), opener: Box::new(PsqlOpener), now: now_secs, free_bytes }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockPolicy {
    /// Take `update.lock` shared plus the private `backup.lock` for the whole run (the CLI and the scheduled task).
    Acquire,
    /// The caller (Plan 07 update, Plan 09 switch, restore) already holds `update.lock` exclusively: take no lock.
    /// While it does, no other backup can have started (they need the shared lock), so `backup.lock` adds nothing,
    /// and taking it would deadlock a caller that holds it itself.
    CallerHoldsExclusive,
}

#[derive(Clone, Debug)]
pub struct RunOptions {
    pub reason: Reason,
    pub only_dest: Option<String>,
    pub scheduled: bool,
    pub lock: LockPolicy,
    /// Epoch seconds on the `Deps::now` clock after which the run must have finished (a maintenance window).
    /// The `BackupRunner` adapter (`plan08_backup`) sets `Some((deps.now)() + timeout_ms / 1000)`; `timeout_ms` is relative.
    pub deadline: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestResult {
    pub name: String,
    pub ok: bool,
    pub skipped: bool,
    pub error: Option<String>,
    /// The copy worked but the maintenance after it did not (a warning, never a failure).
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepSecs {
    pub step: String,
    pub secs: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    /// Whole seconds per step of a completed backup (`dump`, `restic`, `copy`): for the local log, not for status.json.
    pub steps: Vec<StepSecs>,
    pub outcome: String,
    pub reason: Option<String>,
    pub snapshot_id: Option<String>,
    pub skip: Option<String>,
    pub dump_bytes: Option<u64>,
    pub seconds: Option<u64>,
    pub destinations: Vec<DestResult>,
    pub warnings: Vec<String>,
}

impl RunReport {
    fn skipped(why: &str) -> Self {
        RunReport { outcome: "skipped".into(), skip: Some(why.into()), ..Default::default() }
    }
}

const HOUR: Duration = Duration::from_secs(3600);
/// A scheduled tick spends at most this long copying to destinations; the next tick resumes.
pub const SCHEDULED_COPY_CAP_SECS: i64 = 30 * 60;
/// The post-copy check and prune start only if at least this much of the scheduled cap is left; a prune that is cut off
/// after a few minutes only wastes the window. Otherwise it is skipped and the drive stays due for the next tick.
const MIN_PRUNE_WINDOW_SECS: i64 = 10 * 60;

/// Assumed throughput of the slowest supported disk for `pg_dump` and `restic backup`: 10 MiB/s, plus a fixed 15 minutes
/// of overhead (repository open, snapshot, photos). The result is clamped to [15 min, 2 h]. Linear in the database size
/// of the previous run; photos are not counted (they are deduplicated and read in the same window).
const ASSUMED_BYTES_PER_SEC: u64 = 10 << 20;
const STEP_OVERHEAD_SECS: u64 = 15 * 60;
const STEP_MIN_SECS: u64 = 15 * 60;
pub(crate) const STEP_MAX_SECS: u64 = 2 * 3600;

/// Timeout for the dump and the restic backup. Unknown size (`last_db_bytes == 0`, the first run) gets the 2 h cap.
pub(crate) fn step_timeout(db_bytes: u64) -> Duration {
    if db_bytes == 0 {
        return Duration::from_secs(STEP_MAX_SECS);
    }
    Duration::from_secs((db_bytes / ASSUMED_BYTES_PER_SEC + STEP_OVERHEAD_SECS).clamp(STEP_MIN_SECS, STEP_MAX_SECS))
}

/// What bounds one run: the caller's window (`deadline`, epoch seconds on the `Deps::now` clock) and, for a scheduled
/// tick, the total time it may spend copying.
#[derive(Clone, Copy, Debug)]
struct Limits {
    deadline: Option<i64>,
    copy_cap_secs: Option<i64>,
}

/// One backup job: why, to which destinations, within which limits.
struct Job<'a> {
    reason: Reason,
    only: Option<&'a str>,
    lim: Limits,
}

fn exceeded(reason: Reason, step: &str) -> BackupError {
    BackupError::backup_failed(format!("{} backup exceeded its time budget before {step}", reason.as_str()))
}

/// A step's timeout: its own, but never more than the time left in the window. Out of time is an error naming the step.
fn capped(deps: &Deps, job: &Job, step: &str, own: Duration) -> BResult<Duration> {
    let Some(dl) = job.lim.deadline else { return Ok(own) };
    let left = dl - (deps.now)();
    if left <= 0 {
        return Err(exceeded(job.reason, step));
    }
    Ok(own.min(Duration::from_secs(left as u64)))
}

/// `capped` for a step after the snapshot exists (a failure there must not fail the backup): `None` when out of time.
fn soft_cap(deps: &Deps, job: &Job, own: Duration) -> Option<Duration> {
    match job.lim.deadline {
        None => Some(own),
        Some(dl) => {
            let left = dl - (deps.now)();
            (left > 0).then(|| own.min(Duration::from_secs(left as u64)))
        }
    }
}

/// A child that timed out after the window closed is a spent budget, not a tool failure.
fn spent(deps: &Deps, job: &Job, step: &str, timed_out: bool) -> Option<BackupError> {
    (timed_out && job.lim.deadline.is_some_and(|d| (deps.now)() >= d)).then(|| exceeded(job.reason, step))
}
/// Free space kept beyond what the dump itself needs (repository growth, restic temp files, the next run).
const FREE_HEADROOM: u64 = 2 << 30;

fn backup_conn(ctx: &BackupCtx) -> PgConn {
    PgConn::local(ctx, "pos_backup", "postgres", ctx.paths.pgpass_backup())
}
pub fn admin_conn(ctx: &BackupCtx, db: &str) -> PgConn {
    PgConn::local(ctx, "supabase_admin", db, ctx.paths.pgpass_admin())
}

struct FileGuard(#[allow(dead_code)] std::fs::File);

fn backup_lock(ctx: &BackupCtx) -> BResult<Option<FileGuard>> {
    let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(ctx.paths.backup_lock()).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            BackupError::precondition("the backups folder does not exist; run provisioning again")
        } else {
            e.into()
        }
    })?;
    match f.try_lock() {
        Ok(()) => Ok(Some(FileGuard(f))),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

pub enum Gate<T> {
    Ran(T),
    Busy(&'static str),
}

fn op_error(e: OpError) -> BackupError {
    if e.code == OpCode::Precondition { BackupError::precondition(e.message) } else { BackupError::error(e.message) }
}

/// Shared `update.lock` (unless the caller holds it exclusively) plus the private `backup.lock` that keeps backup,
/// verify and drill from sharing one stage folder or one restic repository. A scheduled run that finds either
/// busy is `Busy` (quiet, exit 0); a manual one is `LOCK_HELD` (10).
pub fn gated<T>(ctx: &BackupCtx, policy: LockPolicy, scheduled: bool, f: impl FnOnce() -> BResult<T>) -> BResult<Gate<T>> {
    let mut held = None;
    if policy == LockPolicy::Acquire {
        let mut r = [0u8; 4];
        random_bytes(&mut r)?;
        let upd = match acquire_for(ctx.paths.roots(), LockMode::Shared, "backup", &format!("backup-{}", hex(&r)), Duration::from_secs(0)) {
            Ok(g) => g,
            Err(e) if e.code == OpCode::LockHeld => {
                return if scheduled { Ok(Gate::Busy("update-in-progress")) } else { Err(BackupError::lock_held()) };
            }
            Err(e) => return Err(op_error(e)),
        };
        let Some(bk) = backup_lock(ctx)? else {
            return if scheduled { Ok(Gate::Busy("busy")) } else { Err(BackupError::lock_held()) };
        };
        held = Some((upd, bk));
    }
    let out = f();
    drop(held);
    out.map(Gate::Ran)
}

/// Start of every run, under the locks. `acl::sweep_stale` removes a crashed run's plaintext (private run folders,
/// recovery-key temp files, the old stage); restore folders go too (at once when this run holds the locks), loose temp files older than a day.
/// It touches only those paths and NEVER `backups\switch-*` (Plan 09's staging): no directory walk of `backups\` exists.
fn sweep(ctx: &BackupCtx, now: i64, policy: LockPolicy) -> BResult<Vec<String>> {
    // `sweep_stale` removes every `run-*` folder. Under `CallerHoldsExclusive` the caller may be a PrivateDir user that
    // does not hold `backup.lock` (key export, restore), so only a run that owns the locks sweeps them; the next tick does.
    // The roots are judged before anything under them is touched (also under `CallerHoldsExclusive`, where only the age rule runs).
    acl::assert_scratch_roots_private(ctx)?;
    let mut links = Vec::new();
    if policy == LockPolicy::Acquire {
        links = acl::sweep_stale(ctx)?;
    }
    for dir in [ctx.paths.restore_root(), ctx.paths.backups_tmp()] {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        // A run that took the locks (`Acquire`) holds `update.lock` shared and a restore holds it exclusive, so they never overlap:
        // whatever sits in the restore folder is a crashed restore's plaintext and goes at once. Under `CallerHoldsExclusive` the
        // caller may BE a restore, so only the age rule applies there.
        let restore_dir = dir == ctx.paths.restore_root() && policy == LockPolicy::Acquire;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("run-") || name.starts_with("rk-") {
                continue; // `sweep_stale` owns these
            }
            let state = acl::link_state(&e.path());
            if state != Some(false) {
                acl::remove_link(&e.path()); // the link itself, never what it points at; fail closed for an entry that cannot be inspected
                if state == Some(true) {
                    links.push(acl::link_warning(&name));
                }
                continue;
            }
            let old = restore_dir || e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).is_some_and(|d| now - d.as_secs() as i64 > 86_400);
            if old {
                // plaintext goes through the zero-fill like everywhere else; a failure is a warning and the entry is then plain-deleted
                let p = e.path();
                let scrubbed = if p.is_dir() {
                    acl::scrub_tree(&p).map(|inner| links.extend(inner.iter().map(|n| acl::link_warning(n))))
                } else {
                    acl::scrub_and_remove(&p)
                };
                if scrubbed.is_err() {
                    links.push(format!("the scratch entry {name} could not be zero-filled; it was deleted without that, or left in place if it could not be deleted"));
                    let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                }
            }
        }
    }
    Ok(links)
}

fn preflight(ctx: &BackupCtx, deps: &Deps, st: &BackupState) -> BResult<()> {
    if !ctx.paths.conf_file().exists() {
        return Err(BackupError::not_provisioned());
    }
    if !ctx.paths.backups().is_dir() {
        return Err(BackupError::precondition("the backups folder does not exist; run provisioning again"));
    }
    if !ctx.restic_exe().is_file() {
        return Err(BackupError::precondition("restic is missing from the installed pack"));
    }
    acl::assert_private(ctx, &ctx.paths.backups())?;
    free_space_ok(ctx, deps, st)
}

/// The free-space rule of `preflight`, shared with the pre-fence readiness gate (`plan08_backup::readiness`).
pub(crate) fn free_space_ok(ctx: &BackupCtx, deps: &Deps, st: &BackupState) -> BResult<()> {
    let need = (1u64 << 30).max(st.last_db_bytes.saturating_mul(2));
    let free = (deps.free_bytes)(&ctx.paths.backups()).map_err(|e| BackupError::precondition(format!("cannot read free disk space: {e}")))?;
    if free < need {
        return Err(BackupError::precondition(format!("only {} MB free; a backup needs {} MB", free >> 20, need >> 20)));
    }
    Ok(())
}

/// A small secret file: SYSTEM and Administrators only (checked and set for production roots; `--dev` skips it).
fn write_secret(ctx: &BackupCtx, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if ctx.is_dev() { write_atomic(path, bytes) } else { write_atomic_prepared(path, bytes, &lock_down_file) }
}

/// C5/C6 (conventions v1.6): the password reaches psql only as a `\set pw '<value>'` line on stdin (`sql_script_vars`);
/// this text is a constant that references `:'pw'`, never the value.
pub(crate) const ROLE_SQL: &str = "SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET log_min_duration_statement = -1; SET pgaudit.log = 'none'; SET auto_explain.log_min_duration = -1;\nDO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_backup') THEN CREATE ROLE pos_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 4; END IF; END $do$;\nALTER ROLE pos_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 4 PASSWORD :'pw';\nGRANT pg_read_all_data TO pos_backup;\n";

/// The unattended dump runs as `pos_backup` (LOGIN, BYPASSRLS, `pg_read_all_data`, nothing else), created on
/// first use with the superuser credentials only SYSTEM/Administrators can read.
pub fn ensure_backup_role(ctx: &BackupCtx, deps: &Deps) -> BResult<()> {
    let conn = backup_conn(ctx);
    let pw_file = ctx.paths.pos_backup_pw();
    if pg::sql_scalar(&*deps.exec, ctx, &conn, "SELECT 1;", true).is_ok() {
        // 11S: the role works so the file is not needed, but a legacy plaintext copy must still be rewrapped (the read does it).
        // A damaged wrapped file is left alone here; it is only judged when the role has to be recreated.
        let _ = crate::util::read_secret_file(&pw_file);
        return Ok(());
    }
    let pw = match crate::util::read_secret_file(&pw_file) {
        Ok(t) if t.0.len() == 64 && t.0.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => t.0,
        // ponytail: this role password is derived state (ALTER ROLE below resets it), so unlike the other wrapped
        // files a missing or damaged file is regenerated, exactly as before 11S.
        _ => {
            let k = keys::generate_machine_key()?;
            write_secret(ctx, &pw_file, &crate::util::wrap_secret(&k)?)?;
            k
        }
    };
    write_secret(ctx, &ctx.paths.pgpass_backup(), format!("127.0.0.1:{}:*:pos_backup:{pw}\n", ctx.pg_port()).as_bytes())?;
    pg::sql_script_vars(&*deps.exec, ctx, &admin_conn(ctx, "postgres"), ROLE_SQL, &[("pw", pw.as_str())], Duration::from_secs(60))?;
    pg::sql_scalar(&*deps.exec, ctx, &conn, "SELECT 1;", true).map(|_| ())
}

struct Collected {
    db: DbInfo,
    mig_count: i64,
    mig_max: String,
    caja_closed_at: i64,
    tables: Vec<TableFp>,
    catalog: std::collections::BTreeMap<String, String>,
}

fn first<'a>(lines: &'a [String], what: &str) -> BResult<&'a str> {
    lines.iter().map(|l| l.trim()).find(|l| !l.is_empty()).ok_or_else(|| BackupError::backup_failed(format!("the database returned nothing for {what}")))
}

/// Invariant 7: every fact below is read inside the one open `REPEATABLE READ` snapshot `pg_dump --snapshot` reuses.
///
/// `wait` is asked before every query for how long that query may take (never more than the time left in the caller's
/// window), so six queries cannot add up to six windows.
fn collect(s: &mut dyn SnapshotQueries, wait: &dyn Fn() -> BResult<Duration>) -> BResult<Collected> {
    let bad = |what: &str, e: String| BackupError::backup_failed(format!("cannot read {what}: {e}"));
    let mut q = |sql: &str| -> BResult<Vec<String>> {
        s.set_query_timeout(wait()?);
        s.query(sql)
    };
    let db: DbInfo = serde_json::from_str(first(&q(pg::DBINFO_SQL)?, "database info")?).map_err(|e| bad("database info", e.to_string()))?;
    let mig = q(pg::MIGRATIONS_SQL)?;
    let (c, m) = first(&mig, "migrations")?.split_once('|').ok_or_else(|| bad("migrations", "unexpected format".into()))?;
    let (mig_count, mig_max) = (c.parse::<i64>().map_err(|e| bad("migrations", e.to_string()))?, m.to_string());
    let caja_closed_at = if first(&q(pg::CAJA_PRESENT_SQL)?, "caja")? == "t" {
        let v: serde_json::Value = serde_json::from_str(first(&q(pg::CAJA_SQL)?, "caja")?).map_err(|e| bad("caja", e.to_string()))?;
        v["closed"].as_i64().unwrap_or(0)
    } else {
        0
    };
    let tables = q(pg::TABLES_FP_SQL)?.iter().filter(|l| !l.trim().is_empty()).map(|l| parse_table_fp(l)).collect::<Result<Vec<_>, _>>().map_err(|e| bad("table fingerprints", e))?;
    let catalog = parse_catalog(&q(&pg::catalog_fp_sql())?).map_err(|e| bad("catalog fingerprint", e))?;
    Ok(Collected { db, mig_count, mig_max, caja_closed_at, tables, catalog })
}

/// The files restic could not read, from its `--json` error lines: paths only, never content.
fn unreadable_paths(stdout: &str) -> Vec<String> {
    let mut v: Vec<String> = stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .filter(|j| j["message_type"] == "error")
        .filter_map(|j| j["item"].as_str().map(String::from))
        .collect();
    v.sort();
    v.dedup();
    v
}

fn do_backup(ctx: &BackupCtx, deps: &Deps, cfg: &BackupConfig, st: &mut BackupState, job: &Job) -> BResult<RunReport> {
    let started = (deps.now)();
    // Killed-run detection: a run that dies (power loss, a kill) never reaches its own bookkeeping, so the attempt is
    // recorded as failed up front. A finished run overwrites it; the next tick sees a failed attempt and backs off.
    st.last_attempt_at = started;
    st.last_attempt_ok = false;
    st.last_error = Some("interrupted".into());
    let _ = st.save_in(ctx);
    let result = backup_inner(ctx, deps, cfg, st, job, started);
    if let Err(e) = &result {
        st.last_attempt_at = started;
        st.last_attempt_ok = false;
        st.last_error = Some(tail(&e.message));
        let _ = st.save_in(ctx);
    }
    result
}

fn backup_inner(ctx: &BackupCtx, deps: &Deps, cfg: &BackupConfig, st: &mut BackupState, job: &Job, started: i64) -> BResult<RunReport> {
    let reason = job.reason;
    let mut steps = Vec::new();
    capped(deps, job, "preflight", Duration::ZERO)?;
    preflight(ctx, deps, st)?;
    let local = ensure_local_repo(ctx, &*deps.exec, !cfg.destinations.is_empty())?;
    let t = capped(deps, job, "restic unlock", Duration::from_secs(120))?;
    let _ = run_restic(&*deps.exec, ctx, &local, &restic::unlock_args(), t);
    capped(deps, job, "database role check", Duration::ZERO)?;
    ensure_backup_role(ctx, deps)?;
    let conn = backup_conn(ctx);
    let stage_root = PrivateDir::create(ctx)?;
    // restore finds the staged folder in a snapshot by the suffix `/stage/current`
    let stage = stage_root.path().join("stage").join("current");
    std::fs::create_dir_all(&stage)?;

    let t = capped(deps, job, "database snapshot", pg::QUERY_TIMEOUT)?;
    let mut session = deps.opener.open(ctx, &conn, t)?;
    let collected = collect(&mut *session, &|| capped(deps, job, "database snapshot query", pg::QUERY_TIMEOUT));
    let snap_id = session.snapshot_id();
    let collected = match collected {
        Ok(c) => c,
        Err(e) => {
            session.close();
            return Err(e);
        }
    };

    let free_for = |what: &str, need: u64| -> BResult<()> {
        let free = (deps.free_bytes)(&ctx.paths.backups()).map_err(|e| BackupError::backup_failed(format!("cannot read free disk space: {e}")))?;
        if free < need {
            return Err(BackupError::backup_failed(format!("only {} MB free on the backup disk; {what} needs {} MB", free >> 20, need >> 20)));
        }
        Ok(())
    };
    let dump_timeout = match free_for("the database dump", collected.db.bytes.max(0) as u64 * 2 + FREE_HEADROOM).and_then(|_| capped(deps, job, "pg_dump", step_timeout(st.last_db_bytes))) {
        Ok(t) => t,
        Err(e) => {
            session.close();
            return Err(e);
        }
    };

    // The session stays open until pg_dump has finished with the exported snapshot, then it is closed (bounded).
    let dump_tmp = stage.join(format!("{}.partial", dump::DUMP_FILE));
    let dump_run = deps.exec.run(&ctx.pg_exe("pg_dump.exe"), &dump::pg_dump_args(&conn, &snap_id, &dump_tmp), &conn.env(), None, dump_timeout);
    session.close();
    let out = dump_run.map_err(BackupError::tool)?;
    if !out.ok() {
        if let Some(e) = spent(deps, job, "pg_dump", out.timed_out) {
            return Err(e);
        }
        return Err(BackupError::backup_failed(format!("pg_dump failed ({}): {}", if out.timed_out { "timed out".to_string() } else { out.code.to_string() }, tail(&out.stderr))));
    }
    std::fs::rename(&dump_tmp, stage.join(dump::DUMP_FILE))?;
    let t = capped(deps, job, "pg_dumpall", Duration::from_secs(300))?;
    let globals = deps.exec.run(&ctx.pg_exe("pg_dumpall.exe"), &dump::pg_dumpall_args(&conn, &stage.join(dump::GLOBALS_FILE)), &conn.env(), None, t).map_err(BackupError::tool)?;
    if !globals.ok() {
        return Err(BackupError::backup_failed(format!("pg_dumpall failed: {}", tail(&globals.stderr))));
    }
    let t = capped(deps, job, "pg_dump version", Duration::from_secs(20))?;
    let version = deps.exec.run(&ctx.pg_exe("pg_dump.exe"), &["--version".to_string()], &[], None, t).map(|o| o.stdout.trim().to_string()).unwrap_or_default();
    steps.push(StepSecs { step: "dump".into(), secs: (deps.now)().saturating_sub(started).max(0) as u64 });

    // 11H: PINs are hashed, so the snapshot must bring the pepper the Auth passwords were derived with
    let pepper_fp = if crate::ops::hooks::legacy_snapshot() { None } else { Some(super::pepper::put_in_stage(&ctx.paths.pepper(), &stage)?) };
    let photos = ctx.paths.photos();
    let has_photos = photos.is_dir();
    let manifest = Manifest {
        schema: 1,
        taken_at: started,
        reason: reason.as_str().into(),
        posctl_version: ctx.posctl_version.clone(),
        pack_version: ctx.pack_version.clone(),
        pg_dump_version: version,
        database: collected.db.clone(),
        migrations_count: collected.mig_count,
        migrations_max: collected.mig_max.clone(),
        caja_max_closed_at: collected.caja_closed_at,
        files: dump::file_entries(&stage)?,
        tables: collected.tables,
        catalog: collected.catalog,
        stage_subpath: restic_path(&stage),
        photos_subpath: has_photos.then(|| restic_path(&photos)),
        pepper_sha256: pepper_fp,
    };
    dump::write_manifest(&stage, &manifest)?;
    let dump_bytes = manifest.files.iter().find(|f| f.name == dump::DUMP_FILE).map(|f| f.bytes).unwrap_or(0);

    free_for("the repository copy of the dump", dump_bytes + FREE_HEADROOM)?;
    let tags = snapshot_tags(reason, &collected.mig_max, &ctx.pack_version);
    let t = capped(deps, job, "restic backup", step_timeout(st.last_db_bytes))?;
    let restic_from = (deps.now)();
    let out = run_restic(&*deps.exec, ctx, &local, &restic::backup_args(&stage, has_photos.then_some(photos.as_path()), &tags), t)?;
    let mut photos_unreadable = None;
    let summary = if out.ok() {
        parse_backup_summary(&out.stdout).ok_or_else(|| BackupError::backup_failed("restic did not report a snapshot"))?
    } else {
        if let Some(e) = spent(deps, job, "restic backup", out.timed_out) {
            return Err(e);
        }
        // restic (--json) prints the per-file error lines on stderr, the summary on stdout; read both
        let unreadable = unreadable_paths(&format!("{}\n{}", out.stdout, out.stderr));
        // Exit 3 with every unreadable path inside the photos folder and the staged dump still matching its manifest:
        // the database is safe, so keep the snapshot and surface the photos as a warning.
        let photos_only = out.code == 3
            && !out.timed_out
            && !unreadable.is_empty()
            && unreadable.iter().all(|p| dest::is_inside(Path::new(p), &photos))
            && dump::verify_files(&stage, &manifest).is_ok();
        match (photos_only, parse_backup_summary(&out.stdout)) {
            (true, Some(s)) => {
                // the photos "at" stays the FIRST time it was seen while it stays set (the alert since and escalation clock)
                photos_unreadable = Some(PhotosUnreadableRef { at: st.photos_unreadable.as_ref().map_or(started, |p| p.at), total: unreadable.len(), paths: unreadable.iter().take(20).cloned().collect() });
                s
            }
            _ => {
                let mut msg = format!("restic backup failed: {}", restic::describe_exit(&out));
                if !unreadable.is_empty() {
                    msg.push_str(&format!(" ({} unreadable: {})", unreadable.len(), unreadable.iter().take(20).cloned().collect::<Vec<_>>().join(", ")));
                }
                // restic still wrote a snapshot when it exits 3: remove that incomplete one by id (no prune) so it is never
                // restored, copied or counted as the newest good backup
                if out.code == 3 && !out.timed_out {
                    if let Some(s) = parse_backup_summary(&out.stdout) {
                        let f = run_restic(&*deps.exec, ctx, &local, &restic::forget_snapshot_args(&s.snapshot_id), Duration::from_secs(120));
                        if !f.is_ok_and(|o| o.ok()) {
                            msg.push_str("; the incomplete snapshot could not be removed");
                        }
                    }
                }
                msg.push(' ');
                msg.push_str(&tail(&out.stderr));
                return Err(BackupError::backup_failed(msg));
            }
        }
    };
    drop(stage_root); // the plaintext is gone before any slow copy starts

    let done = (deps.now)();
    steps.push(StepSecs { step: "restic".into(), secs: done.saturating_sub(restic_from).max(0) as u64 });
    st.local = Some(SnapRef { id: summary.snapshot_id.clone(), at: started, reason: reason.as_str().into() });
    // Plain assignment of the value read inside the snapshot (Task 2 ruling): `max()` would keep a watermark that is
    // above reality (clock skew, a deleted newest caja) for ever and make the caja trigger fire on every tick.
    st.caja_close_watermark = collected.caja_closed_at;
    st.last_attempt_at = started;
    st.last_attempt_ok = true;
    st.last_error = None;
    st.last_db_bytes = collected.db.bytes.max(0) as u64;
    st.backup_due_now = false;
    st.photos_unreadable = photos_unreadable.clone();
    let mut warnings = Vec::new();
    if let Some(pu) = &photos_unreadable {
        warnings.push(format!("photos_unreadable: {} photo file(s) could not be read (the database is safe): {}", pu.total, pu.paths.join(", ")));
    }
    let mut state_warned = false;
    // saved now, so a crash during the (possibly hours-long) copy does not forget a good local snapshot
    if st.save_in(ctx).is_err() {
        state_warned = true;
        warnings.push("the backup state file could not be written; the next tick may repeat this backup".to_string());
    }

    // Pre-update, pre-switch and pre-restore snapshots are local only: no retention and no copy inside the maintenance
    // window. The next scheduled tick ships them (the local repository protects against a bad update on its own).
    let mut destinations = Vec::new();
    if !reason.protected() {
        match soft_cap(deps, job, Duration::from_secs(600)) {
            Some(t) => {
                let f = run_restic(&*deps.exec, ctx, &local, &restic::forget_args(false), t);
                if !f.as_ref().is_ok_and(|o| o.ok()) {
                    warnings.push("retention (forget) did not complete; the weekly verify will retry".to_string());
                }
            }
            None => warnings.push("retention (forget) skipped: out of time".to_string()),
        }
        destinations = copy_to_dests(ctx, deps, cfg, st, &CopyScope { maintain: false, only: job.only, due_only: false, now: done }, &job.lim);
        steps.push(StepSecs { step: "copy".into(), secs: (deps.now)().saturating_sub(done).max(0) as u64 });
        if st.save_in(ctx).is_err() && !state_warned {
            warnings.push("the backup state file could not be written after the copy".to_string());
        }
    }
    Ok(RunReport {
        outcome: "completed".into(),
        reason: Some(reason.as_str().into()),
        snapshot_id: Some(summary.snapshot_id),
        dump_bytes: Some(dump_bytes),
        seconds: Some((done - started).max(0) as u64),
        destinations,
        warnings,
        steps,
        ..Default::default()
    })
}

/// Records what a probe saw and says whether a copy may be attempted. A drive that comes back after being away
/// gets its retry window reset, so re-insertion copies at once; a foreign drive is remembered as such.
fn refresh_reach(ds: &mut DestState, r: dest::Reach, now: i64) -> bool {
    match r {
        dest::Reach::Up => {
            if !ds.reachable {
                ds.next_copy_attempt_at = 0;
            }
            ds.reachable = true;
            ds.foreign = false;
            ds.down_since = None;
            true
        }
        dest::Reach::Down | dest::Reach::Foreign => {
            if ds.reachable || ds.down_since.is_none() {
                ds.down_since = Some(now);
            }
            ds.reachable = false;
            ds.ok = false;
            ds.foreign = r == dest::Reach::Foreign;
            if ds.foreign {
                ds.last_error = Some(dest::DEVICE_REFUSED_MSG.into());
            }
            false
        }
    }
}

struct CopyScope<'a> {
    /// The copy-only tick also maintains a destination it just copied to (check, then prune) when its own prune is due.
    maintain: bool,
    only: Option<&'a str>,
    /// The copy-only tick honours each destination's own retry window; a new backup tries them all.
    due_only: bool,
    now: i64,
}

/// Copies every snapshot a destination lacks from the local repository. Never fails the caller: a
/// destination problem is recorded in state (and becomes an alert), not an error. restic exit 3 is a failure.
/// A scheduled tick spends at most `SCHEDULED_COPY_CAP_SECS` here (and never past the caller's deadline); what is
/// left stays pending for the next tick and is not a failure.
fn copy_to_dests(ctx: &BackupCtx, deps: &Deps, cfg: &BackupConfig, st: &mut BackupState, scope: &CopyScope, lim: &Limits) -> Vec<DestResult> {
    let Some(local_snap) = st.local.clone() else { return Vec::new() };
    let now = scope.now;
    let copy_started = (deps.now)();
    let mut results = Vec::new();
    for d in cfg.destinations.iter().filter(|d| scope.only.is_none_or(|n| n == d.name)) {
        if scope.due_only && !dest_copy_due(st, d, now) {
            continue;
        }
        let at = (deps.now)();
        let mut left: Option<i64> = lim.copy_cap_secs.map(|cap| cap - (at - copy_started));
        if let Some(dl) = lim.deadline {
            left = Some(left.map_or(dl - at, |l| l.min(dl - at)));
        }
        if left.is_some_and(|l| l <= 0) {
            break;
        }
        let ds = st.destinations.entry(d.name.clone()).or_default();
        let mut r = DestResult { name: d.name.clone(), ..Default::default() };
        if d.kind == DestKind::Device {
            let reach = dest::probe(d);
            if !refresh_reach(ds, reach, now) {
                r.skipped = true;
                r.error = Some(if reach == dest::Reach::Foreign { dest::DEVICE_REFUSED_MSG } else { "the drive is not connected" }.into());
                results.push(r);
                continue;
            }
        } else {
            ds.reachable = true;
            ds.down_since = None;
        }
        let own = if d.kind == DestKind::R2 { 3 * HOUR } else { 2 * HOUR };
        let timeout = left.map_or(own, |l| own.min(Duration::from_secs(l as u64)));
        let cap_limited = timeout < own;
        let outcome = (|| -> Result<(), (String, bool)> {
            let repo = dest_repo(ctx, d).map_err(|e| (e.message, false))?;
            let _ = run_restic(&*deps.exec, ctx, &repo, &restic::unlock_args(), Duration::from_secs(120).min(timeout));
            let out = run_restic(&*deps.exec, ctx, &repo, &restic::copy_args(&ctx.paths.repo().to_string_lossy(), &ctx.paths.machine_key()), timeout).map_err(|e| (e.message, false))?;
            if out.ok() { Ok(()) } else { Err((format!("{} {}", restic::describe_exit(&out), tail(&out.stderr)), out.timed_out && cap_limited)) }
        })();
        match outcome {
            Ok(()) => {
                ds.ok = true;
                ds.last_error = None;
                ds.failing_since = None;
                // restic copy gives the copy its own id; what matters is that THIS source snapshot is there
                ds.last_success = Some(local_snap.clone());
                ds.next_copy_attempt_at = 0;
                r.ok = true;
                if scope.maintain && !(0..MAINTENANCE_EVERY_SECS).contains(&(now - ds.pruned_at)) {
                    r.warning = prune_after_copy(ctx, deps, d, ds, copy_started, lim, now);
                }
            }
            Err((e, resumes)) => {
                ds.ok = false;
                if resumes {
                    // cut off by the time cap, not broken: the next tick resumes at once
                    ds.last_error = Some("copy time cap reached; resumes on the next tick".into());
                    ds.next_copy_attempt_at = 0;
                } else {
                    ds.last_error = Some(tail(&e));
                    ds.failing_since.get_or_insert(now);
                    ds.next_copy_attempt_at = now + if d.kind == DestKind::R2 { R2_COPY_RETRY_SECS } else { DEVICE_COPY_RETRY_SECS };
                }
                r.error = Some(tail(&e));
            }
        }
        results.push(r);
    }
    results
}

/// A drive that was away is only maintained when it comes back, and then it has just been copied to: check its metadata,
/// then `forget --prune` it, inside whatever is left of the scheduled copy cap. Never a failure: a prune that is cut off
/// resumes the next time (its `pruned_at` stays old, so it is due again), and a drive with a bad check is left alone.
/// Returns the warning to report, if any.
fn prune_after_copy(ctx: &BackupCtx, deps: &Deps, d: &config::Destination, ds: &mut DestState, copy_started: i64, lim: &Limits, now: i64) -> Option<String> {
    let left = |deps: &Deps| -> Option<Duration> {
        let at = (deps.now)();
        let mut left = lim.copy_cap_secs.map(|cap| cap - (at - copy_started));
        if let Some(dl) = lim.deadline {
            left = Some(left.map_or(dl - at, |l| l.min(dl - at)));
        }
        match left {
            Some(l) if l <= 0 => None,
            Some(l) => Some(Duration::from_secs(l as u64)),
            None => Some(Duration::from_secs(u64::MAX / 4)),
        }
    };
    let repo = match dest_repo(ctx, d) {
        Ok(r) => r,
        Err(e) => return Some(format!("maintenance skipped: {}", e.message)),
    };
    let below = crate::exec::Priority::BelowNormal;
    if left(deps)? < Duration::from_secs(MIN_PRUNE_WINDOW_SECS as u64) {
        return None;
    }
    let check_t = left(deps)?.min(maintain::CHECK_TIMEOUT);
    match run_restic_with(&*deps.exec, ctx, &repo, &restic::check_args(restic::ReadData::No), check_t, below) {
        Ok(o) if o.ok() => {}
        Ok(o) => return Some(format!("no prune: the metadata check failed ({} {})", restic::describe_exit(&o), tail(&o.stderr))),
        Err(e) => return Some(format!("no prune: {}", e.message)),
    }
    let prune_t = left(deps)?.min(maintain::PRUNE_TIMEOUT);
    match run_restic_with(&*deps.exec, ctx, &repo, &restic::forget_args(true), prune_t, below) {
        Ok(o) if o.ok() => {
            ds.pruned_at = now;
            None
        }
        Ok(o) if o.timed_out => Some("the prune ran out of time and resumes the next time the drive is maintained".into()),
        Ok(o) => Some(format!("the prune failed ({} {}); it is retried at the next maintenance", restic::describe_exit(&o), tail(&o.stderr))),
        Err(e) => Some(format!("the prune could not run: {}", e.message)),
    }
}

fn observe(ctx: &BackupCtx, deps: &Deps, now: i64) -> Observed {
    let down = Observed { now, db_reachable: false, caja_open: false, max_caja_closed_at: 0 };
    if ensure_backup_role(ctx, deps).is_err() {
        return down;
    }
    let conn = backup_conn(ctx);
    match pg::sql_scalar(&*deps.exec, ctx, &conn, pg::CAJA_PRESENT_SQL, true) {
        Err(_) => down,
        Ok(t) if t != "t" => Observed { db_reachable: true, ..down },
        Ok(_) => match pg::sql_scalar(&*deps.exec, ctx, &conn, pg::CAJA_SQL, true).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
            Some(v) => Observed { now, db_reachable: true, caja_open: v["open"].as_bool().unwrap_or(false), max_caja_closed_at: v["closed"].as_i64().unwrap_or(0) },
            None => down,
        },
    }
}

fn tick(ctx: &BackupCtx, deps: &Deps, lim: Limits) -> BResult<RunReport> {
    let cfg = config::load(&ctx.paths.conf_file())?;
    if !cfg.enabled {
        return Ok(RunReport::skipped("disabled"));
    }
    let now = (deps.now)();
    // a non-missing read error aborts here without saving anything; a corrupt file loads as unknown history
    let mut st = BackupState::load_in(&ctx.paths, now)?;
    for d in cfg.destinations.iter().filter(|d| d.kind == DestKind::Device) {
        let ds = st.destinations.entry(d.name.clone()).or_default();
        refresh_reach(ds, dest::probe(d), now);
    }
    let obs = observe(ctx, deps, now);
    let pending = copy_pending(&st, &cfg, now);
    match decide(&st, &obs, pending) {
        Decision::Backup(r) => do_backup(ctx, deps, &cfg, &mut st, &Job { reason: r, only: None, lim }),
        Decision::CopyOnly => {
            let local = ensure_local_repo(ctx, &*deps.exec, !cfg.destinations.is_empty())?;
            let _ = run_restic(&*deps.exec, ctx, &local, &restic::unlock_args(), Duration::from_secs(120));
            let destinations = copy_to_dests(ctx, deps, &cfg, &mut st, &CopyScope { maintain: true, only: None, due_only: true, now }, &lim);
            st.save_in(ctx)?;
            Ok(RunReport { outcome: "copied".into(), destinations, ..Default::default() })
        }
        Decision::Skip(why) => {
            st.save_in(ctx)?;
            Ok(RunReport::skipped(why))
        }
    }
}

/// With `opts.scheduled` this is the 5-minute tick (decides what is due, may do nothing); otherwise it takes a
/// backup now for `opts.reason`. An `Err` means "no backup": the caller must not proceed.
pub fn run_backup(ctx: &BackupCtx, deps: &Deps, opts: &RunOptions) -> BResult<RunReport> {
    if !ctx.paths.conf_file().exists() {
        return Err(BackupError::not_provisioned());
    }
    match gated(ctx, opts.lock, opts.scheduled, || {
        let links = sweep(ctx, (deps.now)(), opts.lock)?;
        let lim = Limits { deadline: opts.deadline, copy_cap_secs: opts.scheduled.then_some(SCHEDULED_COPY_CAP_SECS) };
        let mut report = if opts.scheduled {
            tick(ctx, deps, lim)?
        } else {
            let cfg = config::load(&ctx.paths.conf_file())?;
            let mut st = BackupState::load_in(&ctx.paths, (deps.now)())?;
            do_backup(ctx, deps, &cfg, &mut st, &Job { reason: opts.reason, only: opts.only_dest.as_deref(), lim })?
        };
        report.warnings.extend(links);
        // Best-effort, after a real dump (so the database is up and nothing early-exits into a tool call) and still under the
        // locks: a scratch database a killed drill left behind. A failure is a warning, never a failed backup.
        if report.outcome == "completed" {
            if let Err(e) = super::drill::sweep_scratch(ctx, &super::restore::Rx::new(deps)) {
                report.warnings.push(format!("a leftover scratch database from a restore drill could not be cleaned up: {}", e.message));
            }
        }
        Ok(report)
    })? {
        Gate::Ran(r) => Ok(r),
        Gate::Busy(why) => Ok(RunReport::skipped(why)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{self, BackupConfig, DestKind, Destination};
    use crate::backup::pg::{PgConn, SnapshotOpener, SnapshotQueries};
    use crate::backup::state::{BackupState, SnapRef};
    use crate::backup::util::fake::FakeExec;
    use crate::envelope::Code;
    use crate::ops::lock::{LockMode, LockState};
    use crate::paths::Roots;
    use crate::ports::Ports;
    use std::cell::{Cell, RefCell};
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    const NOW: i64 = 1_790_000_100;
    const SNAP: &str = "00000003-0000001B-1";
    const CAJA_AT: i64 = 1_790_000_000;
    const DBJSON: &str = r#"{"name":"postgres","owner":"postgres","encoding":"UTF8","provider":"i","locale":"es-MX","collate":"C","ctype":"C","collversion":"1","bytes":4096,"settings":[]}"#;
    const SUMMARY: &str = "{\"message_type\":\"summary\",\"snapshot_id\":\"cafebabe\",\"total_bytes_processed\":10,\"data_added\":5}\n";

    /// Everything the fake snapshot session and the fake tools did, in order: `open`, `query`, `dump`, `close`.
    type Log = Rc<RefCell<Vec<String>>>;

    struct FakeSnap {
        log: Log,
        fail_on: Option<&'static str>,
        timeouts: Rc<RefCell<Vec<Duration>>>,
        on_mig: Option<fn()>,
    }
    impl SnapshotQueries for FakeSnap {
        fn snapshot_id(&self) -> String { SNAP.into() }
        fn query(&mut self, sql: &str) -> BResult<Vec<String>> {
            self.log.borrow_mut().push("query".into());
            if let Some(f) = self.on_mig.filter(|_| sql.contains("schema_migrations")) {
                f();
            }
            if self.fail_on.is_some_and(|n| sql.contains(n)) {
                return Err(BackupError::backup_failed("simulated read failure"));
            }
            Ok(if sql.contains("\\gexec") { vec!["public.items|3|123".into()] }
               else if sql.contains("pg_policies") { vec!["functions|aa".into(), "policies|bb".into()] }
               else if sql.contains("schema_migrations") { vec!["3|20260930000001".into()] }
               else if sql.contains("to_regclass") { vec!["t".into()] }
               else if sql.contains("'open'") { vec![format!(r#"{{"open":true,"closed":{CAJA_AT}}}"#)] }
               else if sql.contains("datlocprovider") { vec![DBJSON.into()] }
               else { vec![] })
        }
        fn set_query_timeout(&mut self, d: Duration) { self.timeouts.borrow_mut().push(d); }
        fn close(&mut self) { self.log.borrow_mut().push("close".into()); }
    }
    struct FakeOpener {
        log: Log,
        fail_on: Option<&'static str>,
        timeouts: Rc<RefCell<Vec<Duration>>>,
        on_mig: Option<fn()>,
    }
    impl SnapshotOpener for FakeOpener {
        fn open(&self, _c: &BackupCtx, _p: &PgConn, timeout: Duration) -> BResult<Box<dyn SnapshotQueries>> {
            self.log.borrow_mut().push("open".into());
            self.timeouts.borrow_mut().push(timeout);
            Ok(Box::new(FakeSnap { log: self.log.clone(), fail_on: self.fail_on, timeouts: self.timeouts.clone(), on_mig: self.on_mig }))
        }
    }

    fn deps_with(exec: Rc<FakeExec>, log: &Log, fail_on: Option<&'static str>) -> Deps {
        Deps { exec: Box::new(exec), opener: Box::new(FakeOpener { log: log.clone(), fail_on, timeouts: Default::default(), on_mig: None }), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }
    fn deps(exec: Rc<FakeExec>) -> Deps { deps_with(exec, &Log::default(), None) }
    /// Deps whose fake session records every timeout it is given (the one for `open`, then one per query).
    fn deps_seen(exec: Rc<FakeExec>, on_mig: Option<fn()>) -> (Deps, Rc<RefCell<Vec<Duration>>>) {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let opener = FakeOpener { log: Log::default(), fail_on: None, timeouts: seen.clone(), on_mig };
        (Deps { opener: Box::new(opener), ..deps(exec) }, seen)
    }

    fn write_arg_file(args: &[String]) {
        let i = args.iter().position(|a| a == "-f").unwrap();
        std::fs::write(&args[i + 1], b"bytes").unwrap();
    }

    fn base_exec_logged(log: &Log) -> FakeExec {
        let l = log.clone();
        FakeExec::default()
            .on("pg_dump.exe --version", 0, "pg_dump (PostgreSQL) 17.10")
            .on_with("pg_dumpall.exe", 0, "", write_arg_file)
            .on_with("pg_dump.exe", 0, "", move |a| {
                write_arg_file(a);
                l.borrow_mut().push("dump".into());
            })
            .on("backup --json", 0, SUMMARY)
    }
    fn base_exec() -> FakeExec { base_exec_logged(&Log::default()) }

    fn dest(name: &str, dir: &Path) -> Destination {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("config"), b"x").unwrap();
        Destination { name: name.into(), kind: DestKind::Device, path: Some(dir.to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() }
    }

    /// A provisioned dev store: folders, a restic stub, an initialised local repository, a machine key.
    fn fixture_with(dev: bool, dests: Vec<Destination>) -> (tempfile::TempDir, BackupCtx) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots { dev, ..Roots::custom(d.path().join("data"), d.path().join("program")) };
        let c = BackupCtx::new(&roots, d.path().join("pack"), Ports::new(47300).unwrap(), "1.11.0-r1".into(), "t".into());
        for p in [c.paths.secrets(), c.paths.backups(), c.paths.state_dir(), c.paths.photos(), c.paths.conf_file().parent().unwrap().to_path_buf(), c.pack_dir.join("bin"), c.paths.repo()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(c.restic_exe(), b"x").unwrap();
        std::fs::write(c.paths.repo().join("config"), b"x").unwrap();
        std::fs::write(c.paths.machine_key(), crate::backup::keys::generate_machine_key().unwrap()).unwrap();
        std::fs::write(c.paths.conf_file(), r#"{"schema":1}"#).unwrap();
        crate::util::write_secret_file(&c.paths.pepper(), &crate::backup::util::fake::rand_pepper()).unwrap();
        if !dests.is_empty() {
            config::save(&c.paths.conf_file(), &BackupConfig { destinations: dests, ..Default::default() }).unwrap();
        }
        (d, c)
    }
    fn fixture(dests: Vec<Destination>) -> (tempfile::TempDir, BackupCtx) { fixture_with(true, dests) }

    fn opts(reason: Reason) -> RunOptions {
        RunOptions { reason, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None }
    }
    fn sched() -> RunOptions { RunOptions { scheduled: true, ..opts(Reason::Hourly) } }
    fn load(c: &BackupCtx) -> BackupState { BackupState::load(&c.paths.state_file(), 0).unwrap() }

    /// Anything that looks like a leftover of the plaintext stage under `backups\`.
    fn plaintext_left(c: &BackupCtx) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let (p, n) = (e.path(), e.file_name().to_string_lossy().into_owned());
                if n.starts_with("pos.dump") || n == "globals.sql" || n == "backup-manifest.json" || (n.starts_with("run-") && p.is_dir()) {
                    out.push(p.clone());
                }
                if p.is_dir() {
                    walk(&p, out);
                }
            }
        }
        let mut v = Vec::new();
        walk(&c.paths.backups(), &mut v);
        v
    }

    fn line(exec: &FakeExec, needle: &str) -> String {
        exec.calls.borrow().iter().find(|l| l.contains(needle)).cloned().unwrap_or_else(|| panic!("no call containing {needle:?}"))
    }

    #[test]
    fn a_successful_run_unlocks_first_dumps_from_the_exported_snapshot_without_compression_and_removes_the_stage() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert_eq!(rep.snapshot_id.as_deref(), Some("cafebabe"));
        assert!(exec.index_of(" unlock").unwrap() < exec.index_of("backup --json").unwrap(), "S7 I5: unlock before anything else");
        let dump = line(&exec, "pg_dump.exe -h");
        assert!(dump.contains(&format!("--snapshot {SNAP}")) && dump.contains("-Z0") && dump.contains("-Fc"));
        assert!(dump.contains("-U pos_backup"), "the unattended dump uses the least-privilege role");
        assert!(line(&exec, "pg_dumpall.exe").contains("--no-role-passwords"));
        assert!(plaintext_left(&c).is_empty(), "the plaintext dump must not outlive the run: {:?}", plaintext_left(&c));
        let st = load(&c);
        assert_eq!(st.local.as_ref().unwrap().id, "cafebabe");
        assert_eq!(st.caja_close_watermark, CAJA_AT, "the watermark is the value read inside the snapshot");
        assert!(st.last_attempt_ok && st.last_error.is_none());
    }

    #[test]
    fn the_snapshot_carries_the_pepper_and_its_fingerprint_and_a_machine_without_one_cannot_back_up() {
        let (_d, c) = fixture(vec![]);
        let seen: Rc<RefCell<Option<(String, crate::backup::dump::Manifest)>>> = Rc::new(RefCell::new(None));
        let s2 = seen.clone();
        let exec = Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "pg_dump (PostgreSQL) 17.10").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", write_arg_file).on_with("backup --json", 0, SUMMARY, move |a| {
            // the staged folder is the argument ending in `current`
            let stage = std::path::PathBuf::from(a.iter().find(|x| x.ends_with("current")).unwrap());
            let pepper = std::fs::read_to_string(stage.join(crate::backup::pepper::STAGE_FILE)).unwrap();
            *s2.borrow_mut() = Some((pepper, crate::backup::dump::read_manifest(&stage).unwrap()));
        }));
        run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        let (pepper, m) = seen.borrow().clone().expect("restic saw the stage");
        assert_eq!(pepper, crate::util::read_secret_file(&c.paths.pepper()).unwrap().expose(), "the stage holds the machine's pepper as plain text");
        assert_eq!(m.pepper_sha256.as_deref(), Some(crate::backup::pepper::fingerprint(&pepper).as_str()));
        assert!(m.files.iter().all(|f| f.name != crate::backup::pepper::STAGE_FILE), "the dump/globals list is unchanged: the pepper is proved by its own fingerprint");
        assert!(plaintext_left(&c).is_empty());
        // no pepper: the backup fails visibly and restic is never reached
        std::fs::remove_file(c.paths.pepper()).unwrap();
        let exec2 = Rc::new(base_exec());
        let e = run_backup(&c, &deps(exec2.clone()), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(exec2.index_of("backup --json").is_none());
        assert!(plaintext_left(&c).is_empty());
    }

    #[test]
    fn everything_is_read_in_one_snapshot_that_stays_open_until_pg_dump_has_finished() {
        let (_d, c) = fixture(vec![]);
        let log = Log::default();
        let exec = Rc::new(base_exec_logged(&log));
        run_backup(&c, &deps_with(exec, &log, None), &opts(Reason::Manual)).unwrap();
        let ev = log.borrow().clone();
        assert_eq!(ev.iter().filter(|e| *e == "open").count(), 1, "one session, not one per query");
        assert_eq!(ev[0], "open");
        let dump_at = ev.iter().position(|e| e == "dump").unwrap();
        let close_at = ev.iter().position(|e| e == "close").unwrap();
        assert_eq!(close_at, dump_at + 1, "the session closes right after pg_dump returns, never before");
        assert_eq!(ev.iter().filter(|e| *e == "close").count(), 1);
        assert!(ev[1..dump_at].iter().all(|e| e == "query") && dump_at - 1 == 6, "db info, migrations, caja (2), row and catalog fingerprints, all before the dump: {ev:?}");
    }

    #[test]
    fn a_failing_dump_never_reaches_restic_closes_the_session_and_is_recorded_as_a_failed_attempt() {
        let (_d, c) = fixture(vec![]);
        let log = Log::default();
        let exec = Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "pg_dump 17").on("pg_dump.exe", 1, ""));
        let e = run_backup(&c, &deps_with(exec.clone(), &log, None), &opts(Reason::Manual)).unwrap_err();
        assert_eq!((e.code, e.exit()), (Code::BackupFailed, 30));
        assert!(exec.index_of("backup --json").is_none());
        assert_eq!(log.borrow().iter().filter(|e| *e == "close").count(), 1, "the snapshot session is closed on the failure path too");
        assert!(plaintext_left(&c).is_empty());
        let st = load(&c);
        assert!(!st.last_attempt_ok && st.last_error.is_some() && st.local.is_none());
    }

    #[test]
    fn a_snapshot_read_failure_closes_the_session_and_never_starts_pg_dump() {
        let (_d, c) = fixture(vec![]);
        let log = Log::default();
        let exec = Rc::new(base_exec_logged(&log));
        let e = run_backup(&c, &deps_with(exec.clone(), &log, Some("datlocprovider")), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(exec.index_of("pg_dump.exe -h").is_none() && exec.index_of("backup --json").is_none());
        assert_eq!(log.borrow().iter().filter(|e| *e == "close").count(), 1);
        assert!(plaintext_left(&c).is_empty());
    }

    #[test]
    fn restic_reporting_unreadable_source_files_is_a_failure_not_a_success() {
        let (_d, c) = fixture(vec![]);
        let exec3 = Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "x").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", write_arg_file).on("backup --json", 3, ""));
        let e = run_backup(&c, &deps(exec3), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(e.message.contains("incomplete"), "{}", e.message);
        assert!(plaintext_left(&c).is_empty());
        assert!(load(&c).local.is_none(), "an incomplete snapshot is not recorded as the newest good one");
    }

    #[test]
    fn the_manifest_inside_the_snapshot_carries_what_was_read_in_the_one_snapshot() {
        let (_d, c) = fixture(vec![]);
        type Seen = Option<(dump::Manifest, bool, Vec<String>)>;
        let seen: Rc<RefCell<Seen>> = Rc::default();
        let s2 = seen.clone();
        let exec = Rc::new(
            FakeExec::default()
                .on("pg_dump.exe --version", 0, "pg_dump (PostgreSQL) 17.10")
                .on_with("pg_dumpall.exe", 0, "", write_arg_file)
                .on_with("pg_dump.exe", 0, "", write_arg_file)
                .on_with("backup --json", 0, SUMMARY, move |args| {
                    let i = args.iter().position(|a| a == ".tmp").unwrap();
                    let stage = PathBuf::from(&args[i + 1]);
                    let m = dump::read_manifest(&stage).unwrap();
                    let verified = dump::verify_files(&stage, &m).is_ok();
                    *s2.borrow_mut() = Some((m, verified, args.to_vec()));
                }),
        );
        run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        let (m, verified, args) = seen.borrow_mut().take().unwrap();
        assert!(verified, "the staged files match the manifest's checksums at the moment restic reads them");
        assert_eq!((m.migrations_count, m.migrations_max.as_str(), m.caja_max_closed_at), (3, "20260930000001", CAJA_AT));
        assert_eq!((m.tables.len(), m.tables[0].name.as_str(), m.tables[0].count), (1, "public.items", 3));
        assert!(m.catalog.contains_key("functions") && m.catalog.contains_key("policies"));
        assert_eq!(m.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["pos.dump", "globals.sql"]);
        assert_eq!((m.reason.as_str(), m.pack_version.as_str(), m.pg_dump_version.as_str()), ("manual", "1.11.0-r1", "pg_dump (PostgreSQL) 17.10"));
        assert!(m.stage_subpath.ends_with("/stage/current"), "restore finds the staged folder by this suffix: {}", m.stage_subpath);
        assert!(m.photos_subpath.as_deref().is_some_and(|p| p.ends_with("/photos")));
        assert!(args.iter().any(|a| a == &c.paths.photos().to_string_lossy()), "the photos folder is part of the snapshot");
        assert!(args.windows(2).any(|w| w[0] == "--tag" && w[1] == "schema:20260930000001"));
    }

    #[test]
    fn protected_reasons_are_tagged_and_retention_keeps_the_protect_tag() {
        for (reason, protected) in [(Reason::PreUpdate, true), (Reason::PreSwitch, true), (Reason::PreRestore, true), (Reason::Hourly, false), (Reason::CajaClose, false), (Reason::Manual, false)] {
            let (_d, c) = fixture(vec![]);
            let exec = Rc::new(base_exec());
            run_backup(&c, &deps(exec.clone()), &opts(reason)).unwrap();
            let b = line(&exec, "backup --json");
            assert!(b.contains(&format!("--tag reason:{}", reason.as_str())), "{b}");
            assert_eq!(b.contains("--tag protect"), protected, "{reason:?}: {b}");
            if protected {
                assert_eq!(exec.count_of(" forget "), 0, "{reason:?} is local only: retention waits for a scheduled run");
                continue;
            }
            let f = line(&exec, " forget ");
            assert!(f.contains("--group-by host --keep-hourly 24 --keep-daily 30 --keep-monthly 12") && f.contains("--keep-tag protect"), "{f}");
            assert!(!f.contains("--prune"), "pruning is the weekly verify's job");
        }
    }

    #[test]
    fn a_failed_forget_is_a_warning_not_a_failed_backup() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec().on(" forget ", 1, ""));
        let rep = run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert!(rep.warnings.iter().any(|w| w.contains("retention")));
        assert!(load(&c).last_attempt_ok);
    }

    #[test]
    fn a_backup_run_drops_the_scratch_databases_a_killed_drill_left_and_only_those() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec().on("datname ~", 0, "pos_drill_20250101000000\npostgres\npos_drill_x\n"));
        let rep = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert!(exec.index_of("DROP DATABASE IF EXISTS \"pos_drill_20250101000000\" WITH (FORCE)").is_some());
        assert!(exec.calls.borrow().iter().all(|l| !(l.contains("DROP DATABASE") && (l.contains("pos_drill_x") || l.contains("\"postgres\"")))));
        assert!(rep.warnings.iter().all(|w| !w.contains("scratch")), "{:?}", rep.warnings);
    }

    #[test]
    fn a_failing_scratch_sweep_is_a_warning_and_never_a_failed_backup() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec().on_stderr("datname ~", 2, "boom"));
        let rep = run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert!(rep.warnings.iter().any(|w| w.contains("scratch")), "{:?}", rep.warnings);
        assert!(load(&c).last_attempt_ok);
        let exec = Rc::new(base_exec().on("datname ~", 0, "pos_drill_20250101000000\n").on_stderr("DROP DATABASE", 2, "boom"));
        let rep = run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert!(rep.warnings.iter().any(|w| w.contains("scratch")), "{:?}", rep.warnings);
    }

    #[test]
    fn one_unreachable_or_failing_destination_does_not_fail_the_backup() {
        let d = tempfile::tempdir().unwrap();
        let usb = d.path().join("usb");
        let (_d, c) = fixture(vec![dest("usb-e", &usb)]);
        let exec = Rc::new(base_exec().on("copy --from-repo", 1, ""));
        let rep = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert_eq!(rep.destinations.len(), 1);
        assert!(!rep.destinations[0].ok && rep.destinations[0].error.is_some());
        let st = load(&c);
        assert!(st.local.is_some());
        assert!(st.destinations["usb-e"].last_success.is_none(), "a failed copy must not look like a success");

        std::fs::remove_file(usb.join("config")).unwrap(); // the drive is "unplugged"
        let exec2 = Rc::new(base_exec());
        let rep2 = run_backup(&c, &deps(exec2.clone()), &opts(Reason::Manual)).unwrap();
        assert!(rep2.destinations[0].skipped);
        assert!(exec2.index_of("copy --from-repo").is_none());
        let st2 = load(&c);
        assert!(!st2.destinations["usb-e"].reachable && st2.destinations["usb-e"].down_since.is_some());
    }

    #[test]
    fn a_destination_that_exits_3_counts_as_failed_and_another_destination_still_gets_its_copy() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-a", &d.path().join("usb-a")), dest("usb-b", &d.path().join("usb-b"))]);
        let exec = Rc::new(base_exec().on_n("copy --from-repo", 1, 3, ""));
        let rep = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!((rep.destinations[0].ok, rep.destinations[1].ok), (false, true));
        assert!(rep.destinations[0].error.as_deref().unwrap().contains("incomplete"));
        assert_eq!(exec.count_of("copy --from-repo"), 2);
    }

    #[test]
    fn a_successful_copy_records_the_source_snapshot_id_as_the_destinations_newest() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::Manual)).unwrap();
        let st = load(&c);
        assert_eq!(st.destinations["usb-e"].last_success.as_ref().unwrap().id, "cafebabe");
        assert!(st.destinations["usb-e"].ok);
    }

    #[test]
    fn a_completed_run_reports_how_long_each_step_took_by_name() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.steps.iter().map(|s| s.step.as_str()).collect::<Vec<_>>(), ["dump", "restic", "copy"]);
        let (_d2, c2) = fixture(vec![]);
        let local = run_backup(&c2, &deps(Rc::new(base_exec())), &opts(Reason::PreUpdate)).unwrap();
        assert_eq!(local.steps.iter().map(|s| s.step.as_str()).collect::<Vec<_>>(), ["dump", "restic"], "a protected snapshot is local only: no copy step");
    }

    #[test]
    fn a_pc_without_the_backups_folder_is_told_so_not_given_an_io_error() {
        for scheduled in [false, true] {
            let (_d, c) = fixture(vec![]);
            std::fs::remove_dir_all(c.paths.backups()).unwrap();
            std::fs::create_dir_all(c.paths.update_lock().parent().unwrap()).unwrap();
            let opts = RunOptions { lock: LockPolicy::Acquire, ..if scheduled { sched() } else { opts(Reason::Manual) } };
            let e = run_backup(&c, &deps(Rc::new(base_exec())), &opts).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "scheduled={scheduled}: {}", e.message);
            assert!(e.message.contains("backups folder"), "{}", e.message);
        }
    }

    #[test]
    fn only_dest_copies_to_that_destination_alone() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-a", &d.path().join("usb-a")), dest("usb-b", &d.path().join("usb-b"))]);
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &RunOptions { only_dest: Some("usb-b".into()), ..opts(Reason::Manual) }).unwrap();
        assert_eq!(rep.destinations.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["usb-b"]);
        assert_eq!(exec.count_of("copy --from-repo"), 1);
        assert!(line(&exec, "copy --from-repo").contains("usb-b"));
    }

    #[test]
    fn the_scheduled_tick_does_nothing_when_nothing_is_due_and_a_reinserted_drive_only_copies() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        // first tick: the first run is due
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &sched()).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.reason.as_deref()), ("completed", Some("hourly")));
        // second tick a moment later: not due, drive present and up to date
        let exec2 = Rc::new(base_exec());
        let rep2 = run_backup(&c, &deps(exec2.clone()), &sched()).unwrap();
        assert_eq!((rep2.outcome.as_str(), rep2.skip.as_deref()), ("skipped", Some("not-due")));
        assert!(exec2.index_of("pg_dump.exe -h").is_none());
        // the local repository now holds a snapshot the drive lacks (compared by id, not by time)
        let mut st = load(&c);
        st.local.as_mut().unwrap().id = "deadbeef".into();
        st.save_in(&c).unwrap();
        let exec3 = Rc::new(base_exec());
        let rep3 = run_backup(&c, &deps(exec3.clone()), &sched()).unwrap();
        assert_eq!(rep3.outcome, "copied");
        assert!(exec3.index_of("pg_dump.exe -h").is_none() && exec3.index_of("copy --from-repo").is_some());
    }

    #[test]
    fn a_disabled_service_skips_every_tick() {
        let (_d, c) = fixture(vec![]);
        config::save(&c.paths.conf_file(), &BackupConfig { enabled: false, ..Default::default() }).unwrap();
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.skip.as_deref()), ("skipped", Some("disabled")));
        assert!(exec.calls.borrow().is_empty());
    }

    /// CARRY from Task 2: with `max()` the stored watermark stays above the observed value for ever, so the caja
    /// trigger fires on every tick (clock skew, or the newest caja was deleted). Plain assignment settles it.
    #[test]
    fn a_watermark_above_the_observed_value_fires_the_caja_trigger_once_and_then_settles() {
        let (_d, c) = fixture(vec![]);
        let st = BackupState {
            first_seen_at: NOW - 86_400,
            local: Some(SnapRef { id: "0ldsnap0".into(), at: NOW - 60, reason: "hourly".into() }),
            caja_close_watermark: 9_999_999_999,
            last_attempt_at: NOW - 60,
            last_attempt_ok: true,
            ..Default::default()
        };
        st.save_in(&c).unwrap();
        let observing = || base_exec().on("to_regclass", 0, "t").on("'open'", 0, &format!(r#"{{"open":false,"closed":{CAJA_AT}}}"#));

        let e1 = Rc::new(observing());
        let r1 = run_backup(&c, &deps(e1.clone()), &sched()).unwrap();
        assert_eq!((r1.outcome.as_str(), r1.reason.as_deref()), ("completed", Some("caja-close")));
        assert_eq!(e1.count_of("pg_dump.exe -h"), 1);
        assert_eq!(load(&c).caja_close_watermark, CAJA_AT, "plain assignment of the value read in the snapshot, not max()");

        let e2 = Rc::new(observing());
        let r2 = run_backup(&c, &deps(e2.clone()), &sched()).unwrap();
        assert_eq!((r2.outcome.as_str(), r2.skip.as_deref()), ("skipped", Some("not-due")), "the trigger must have settled");
        assert_eq!(e2.count_of("pg_dump.exe -h"), 0, "no full backup on the next tick");
    }

    /// A restore whose bounded post-restore backup did not finish flags the state; the next scheduled tick takes the
    /// backup (policy honours the flag) and a completed backup clears it.
    #[test]
    fn the_due_now_flag_makes_the_next_tick_back_up_and_a_completed_backup_clears_it() {
        let (_d, c) = fixture(vec![]);
        let st = BackupState {
            first_seen_at: NOW - 86_400,
            local: Some(SnapRef { id: "0ldsnap0".into(), at: NOW - 60, reason: "hourly".into() }),
            last_attempt_at: NOW - 60,
            last_attempt_ok: true,
            backup_due_now: true,
            ..Default::default()
        };
        st.save_in(&c).unwrap();
        let e = Rc::new(base_exec().on("to_regclass", 0, "t").on("'open'", 0, r#"{"open":false,"closed":0}"#));
        let r = run_backup(&c, &deps(e.clone()), &sched()).unwrap();
        assert_eq!(r.outcome, "completed");
        assert!(!load(&c).backup_due_now);
        let e2 = Rc::new(base_exec().on("to_regclass", 0, "t").on("'open'", 0, r#"{"open":false,"closed":0}"#));
        assert_eq!(run_backup(&c, &deps(e2), &sched()).unwrap().skip.as_deref(), Some("not-due"));
    }

    #[test]
    fn a_manual_run_without_provisioning_is_not_provisioned_whatever_the_lock_policy() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("program"));
        let c = BackupCtx::new(&roots, d.path().join("pack"), Ports::new(47300).unwrap(), "t".into(), "t".into());
        for lock in [LockPolicy::CallerHoldsExclusive, LockPolicy::Acquire] {
            let e = run_backup(&c, &deps(Rc::new(FakeExec::default())), &RunOptions { lock, ..opts(Reason::Manual) }).unwrap_err();
            assert_eq!((e.code, e.exit()), (Code::NotProvisioned, 4));
        }
    }

    #[test]
    fn an_unreadable_state_file_aborts_the_run_before_any_tool_and_is_not_overwritten() {
        let (_d, c) = fixture(vec![]);
        std::fs::create_dir_all(c.paths.state_file()).unwrap(); // reading a folder as a file: an error that is not "missing"
        let exec = Rc::new(base_exec());
        let e = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::Error);
        assert!(exec.calls.borrow().is_empty(), "no tool may run on top of unknown history");
        assert!(c.paths.state_file().is_dir(), "nothing was written over it");
    }

    #[test]
    fn a_corrupt_state_file_is_set_aside_and_the_history_is_unknown_not_fresh() {
        let (_d, c) = fixture(vec![]);
        std::fs::write(c.paths.state_file(), b"{ not json").unwrap();
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        let aside = std::fs::read_dir(c.paths.state_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("backup.json.corrupt-")).count();
        assert_eq!(aside, 1, "the corrupt file is kept as evidence");
        assert_eq!(load(&c).first_seen_at, 0, "unknown history stays unknown");
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stdout));
    }

    #[cfg(windows)]
    #[test]
    fn the_sweep_never_follows_a_junction_planted_in_the_scratch_folders() {
        let (_d, c) = fixture(vec![]);
        let victim = tempfile::tempdir().unwrap();
        std::fs::write(victim.path().join("keep.txt"), b"precious").unwrap();
        std::fs::create_dir_all(c.paths.backups_tmp()).unwrap();
        std::fs::create_dir_all(c.paths.restore_root()).unwrap();
        junction(&c.paths.backups_tmp().join("run-x"), victim.path()); // sweep_stale's `run-*`
        junction(&c.paths.backups_tmp().join("other-x"), victim.path()); // a non run-/rk- entry
        junction(&c.paths.restore_root().join("evil"), victim.path()); // removed at once for a locked run
        let links = sweep(&c, NOW + 3 * 86_400, LockPolicy::Acquire).unwrap();
        assert_eq!(std::fs::read(victim.path().join("keep.txt")).unwrap(), b"precious", "the target's file was zeroed or deleted through a junction");
        assert!(links.len() == 3, "the links are reported: {links:?}");
        for p in [c.paths.backups_tmp().join("run-x"), c.paths.backups_tmp().join("other-x"), c.paths.restore_root().join("evil")] {
            assert!(std::fs::symlink_metadata(&p).is_err(), "the link itself is removed: {}", p.display());
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_scratch_folder_that_is_not_private_refuses_the_run_before_anything_is_swept() {
        let (_d, c) = fixture_with(false, vec![]); // a real (non-dev) context: the folder inherits the user's DACL
        std::fs::create_dir_all(c.paths.backups_tmp().join("run-dead")).unwrap();
        let e = sweep(&c, NOW, LockPolicy::Acquire).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(c.paths.backups_tmp().join("run-dead").exists(), "nothing was removed");
    }

    #[cfg(windows)]
    #[test]
    fn a_dump_left_in_the_restore_folder_is_zero_filled_at_run_start_and_a_failure_warns() {
        use std::io::Read;
        use std::os::windows::fs::OpenOptionsExt;
        let (_d, c) = fixture(vec![]);
        let root = c.paths.restore_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("pos.dump"), b"admin pin 123456").unwrap();
        std::fs::write(root.join("sub").join("nested.dump"), b"admin pin 123456").unwrap();
        let mut a = std::fs::File::open(root.join("pos.dump")).unwrap();
        let mut b = std::fs::File::open(root.join("sub").join("nested.dump")).unwrap();
        let warnings = sweep(&c, NOW, LockPolicy::Acquire).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!root.join("pos.dump").exists() && !root.join("sub").exists());
        for h in [&mut a, &mut b] {
            let mut seen = Vec::new();
            h.read_to_end(&mut seen).unwrap();
            assert!(seen.len() == 16 && seen.iter().all(|x| *x == 0), "deleted without zero-fill: {seen:?}");
        }
        // a dump that cannot be zero-filled is still removed if it can be, but the run says so
        std::fs::write(root.join("stuck.dump"), b"admin pin").unwrap();
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(root.join("stuck.dump")).unwrap();
        let warnings = sweep(&c, NOW, LockPolicy::Acquire).unwrap();
        assert!(warnings.iter().any(|w| w.contains("stuck.dump")), "{warnings:?}");
    }

    #[test]
    fn a_run_starts_by_sweeping_leftovers_but_never_touches_switch_staging() {
        let (_d, c) = fixture(vec![]);
        let mk = |p: PathBuf, f: &str| {
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join(f), b"plaintext").unwrap();
        };
        mk(c.paths.backups_tmp().join("run-dead"), "pos.dump"); // a crashed run's private folder
        mk(c.paths.backups_tmp().join("run-dead2").join("stage"), "pos.dump"); // a killed restore's nested stage, however young
        mk(c.paths.stage(), "pos.dump"); // the pre-PrivateDir stage location
        mk(c.paths.backups().join("switch-x"), "f"); // Plan 09's staging
        std::fs::create_dir_all(c.paths.restore_root()).unwrap();
        let (old, fresh) = (c.paths.restore_root().join("old.bin"), c.paths.restore_root().join("fresh.bin"));
        for (p, at) in [(&old, NOW - 2 * 86_400), (&fresh, NOW - 60)] {
            let f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(p).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(at as u64)).unwrap();
        }
        run_backup(&c, &deps(Rc::new(base_exec())), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap();
        assert!(!c.paths.backups_tmp().join("run-dead").exists() && !c.paths.backups_tmp().join("run-dead2").exists() && !c.paths.stage().exists(), "stale plaintext is gone");
        assert!(c.paths.backups().join("switch-x").join("f").exists(), "Plan 09's switch staging survives a backup and its sweep");
        assert!(!old.exists() && !fresh.exists(), "the tick holds update.lock shared and a restore holds it exclusive, so a restore folder it finds is a crashed one: gone at once");
    }

    #[test]
    fn the_backups_folder_must_be_private_before_anything_is_staged() {
        let (_d, c) = fixture_with(false, vec![]); // production roots: the temp folder is not SYSTEM/Administrators-only
        let exec = Rc::new(base_exec());
        let log = Log::default();
        let e = run_backup(&c, &deps_with(exec.clone(), &log, None), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::Precondition, "{}", e.message);
        assert!(exec.calls.borrow().is_empty() && log.borrow().is_empty(), "no tool and no database session before the check");
        assert!(plaintext_left(&c).is_empty());
    }

    struct PanicAtGlobals {
        inner: FakeExec,
        backups: PathBuf,
        dump_existed: Rc<Cell<bool>>,
    }
    impl Exec for PanicAtGlobals {
        fn run(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration) -> std::io::Result<crate::backup::util::RunOutput> {
            if program.file_name().is_some_and(|n| n == "pg_dumpall.exe") {
                self.dump_existed.set(self.backups.join("tmp").read_dir().into_iter().flatten().flatten().any(|e| e.path().join("stage").join("current").join("pos.dump").is_file()));
                panic!("simulated crash after the dump was written");
            }
            self.inner.run(program, args, env, stdin, timeout)
        }
    }

    #[test]
    fn a_panic_after_the_dump_was_written_still_removes_the_plaintext() {
        let (_d, c) = fixture(vec![]);
        let existed = Rc::new(Cell::new(false));
        let exec = PanicAtGlobals { inner: base_exec(), backups: c.paths.backups(), dump_existed: existed.clone() };
        let log = Log::default();
        let d = Deps { exec: Box::new(exec), opener: Box::new(FakeOpener { log, fail_on: None, timeouts: Default::default(), on_mig: None }), now: || NOW, free_bytes: |_| Ok(1 << 40) };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_backup(&c, &d, &opts(Reason::Manual))));
        assert!(r.is_err(), "the simulated crash must propagate");
        assert!(existed.get(), "the test is only meaningful if the dump existed when the crash happened");
        assert!(plaintext_left(&c).is_empty(), "the Drop guard removes the stage: {:?}", plaintext_left(&c));
    }

    #[test]
    fn secrets_travel_in_the_environment_never_on_a_command_line() {
        let (_d, c) = fixture(vec![]);
        let key = std::fs::read_to_string(c.paths.machine_key()).unwrap();
        let exec = Rc::new(base_exec());
        run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert!(!exec.calls.borrow().iter().any(|l| l.contains(key.trim())), "the machine key must not be an argument");
        let env_of = |needle: &str| exec.envs.borrow()[exec.index_of(needle).unwrap()].clone();
        assert!(env_of("backup --json").contains(&"RESTIC_PASSWORD_FILE".to_string()));
        assert!(env_of("pg_dump.exe -h").contains(&"PGPASSFILE".to_string()));
        assert!(env_of("pg_dumpall.exe").contains(&"PGPASSFILE".to_string()));
    }

    #[test]
    fn a_scheduled_run_skips_quietly_while_an_update_holds_the_lock_and_a_manual_run_is_lock_held() {
        let (_d, c) = fixture(vec![]);
        let held = crate::ops::lock::acquire_for(c.paths.roots(), LockMode::Exclusive, "update", "op-1", Duration::from_secs(0)).unwrap();
        let (exec_s, exec_m) = (Rc::new(base_exec()), Rc::new(base_exec()));
        let rep = run_backup(&c, &deps(exec_s.clone()), &RunOptions { lock: LockPolicy::Acquire, ..sched() }).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.skip.as_deref()), ("skipped", Some("update-in-progress")));
        let e = run_backup(&c, &deps(exec_m.clone()), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap_err();
        assert_eq!((e.code, e.exit()), (Code::LockHeld, 10));
        assert!(exec_s.calls.borrow().is_empty() && exec_m.calls.borrow().is_empty());
        // the in-process caller (update, switch, restore) already holds it exclusively and takes no lock itself
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::PreUpdate)).unwrap();
        assert_eq!(rep.outcome, "completed");
        drop(held);
    }

    #[test]
    fn a_free_update_lock_is_taken_shared_for_the_run_and_released_after_it() {
        let (_d, c) = fixture(vec![]);
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert_eq!(crate::ops::lock::probe_for(c.paths.roots()), LockState::Free);
    }

    #[test]
    fn a_second_backup_run_is_busy_scheduled_and_lock_held_manual() {
        let (_d, c) = fixture(vec![]);
        let _other = backup_lock(&c).unwrap().expect("the lock is free");
        let rep = run_backup(&c, &deps(Rc::new(base_exec())), &RunOptions { lock: LockPolicy::Acquire, ..sched() }).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.skip.as_deref()), ("skipped", Some("busy")));
        let e = run_backup(&c, &deps(Rc::new(base_exec())), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap_err();
        assert_eq!(e.code, Code::LockHeld);
    }

    #[test]
    fn reason_is_reexported_from_the_run_module() {
        let r: crate::backup::run::Reason = crate::backup::policy::Reason::PreUpdate;
        assert_eq!(r.as_str(), "pre-update");
    }

    // ---- Added test (C5/C6, conventions v1.6) ----
    #[test]
    fn the_backup_role_password_reaches_psql_only_as_a_set_line_on_stdin() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(FakeExec::default().on_n("-U pos_backup", 1, 2, "")); // the first probe fails: the role does not exist yet
        ensure_backup_role(&c, &deps(exec.clone())).unwrap();
        let pw = crate::util::read_secret_file(&c.paths.pos_backup_pw()).unwrap().0;
        let pw = pw.trim();
        assert!(pw.len() == 64 && pw.bytes().all(|b| b.is_ascii_hexdigit()), "a generated 64-hex password");

        let calls = exec.calls.borrow().clone();
        let scripts: Vec<&String> = calls.iter().filter(|l| l.contains(" <<")).collect();
        assert_eq!(scripts.len(), 1, "one psql script");
        let (argv, script) = scripts[0].split_once(" <<").unwrap();
        assert!(argv.contains("-U supabase_admin"), "the role is created with the superuser connection");
        // As built, `sql_script` puts its standard_conforming_strings prelude first; the `\set` line follows it, then ROLE_SQL.
        assert_eq!(script, format!("{}\\set pw '{pw}'\n{ROLE_SQL}", pg::SCRIPT_PRELUDE));
        // (a) the password appears in no argv, and in no script line other than the `\set` line
        assert!(!calls.iter().any(|l| l.split(" <<").next().unwrap().contains(pw)));
        assert_eq!(script.lines().filter(|l| l.contains(pw)).count(), 1);
        assert!(script.lines().find(|l| l.contains(pw)).unwrap().starts_with("\\set pw '"));
        // ROLE_SQL itself: a variable reference, no literal secret
        assert!(ROLE_SQL.contains(":'pw'") && !ROLE_SQL.contains("PASSWORD '"));
        assert!(ROLE_SQL.split(|ch: char| !ch.is_ascii_hexdigit()).map(str::len).max().unwrap() < 32, "no hex run that could be a secret");
        // (b) no .sql file anywhere the run writes
        for dir in [c.paths.backups_tmp(), c.paths.state_dir(), c.paths.secrets()] {
            let sql = std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| e.path().extension().is_some_and(|x| x == "sql"));
            assert!(!sql, "a script file would leave the password on disk");
        }
        // (c) the variable helper refuses a value that could break out of the quotes
        let conn = PgConn::local(&c, "supabase_admin", "postgres", c.paths.pgpass_admin());
        for bad in ["a'b", "a\nb", "a b", ""] {
            let e = pg::sql_script_vars(&exec, &c, &conn, "SELECT 1;", &[("pw", bad)], Duration::from_secs(5)).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "{bad:?}");
        }
        // an existing role is normalised too: the ALTER re-asserts every attribute, and statement logging is off first
        assert!(ROLE_SQL.starts_with("SET log_statement = 'none'; SET log_min_error_statement = 'panic';"));
        let first_line = ROLE_SQL.lines().next().unwrap();
        assert!(first_line.contains("SET log_min_duration_statement = -1;") && first_line.contains("SET pgaudit.log = 'none';") && first_line.contains("SET auto_explain.log_min_duration = -1;"), "{first_line}");
        let alter = ROLE_SQL.lines().find(|l| l.starts_with("ALTER ROLE pos_backup")).unwrap();
        for attr in ["LOGIN", "NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION", "BYPASSRLS", "CONNECTION LIMIT 4", "PASSWORD :'pw'"] {
            assert!(alter.contains(attr), "{attr} missing from {alter}");
        }
    }

    // ---- batch 1 (review round) ----
    const LOWER_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn the_backup_role_password_file_is_regenerated_unless_it_is_exactly_64_lowercase_hex() {
        for (content, kept) in [("short".to_string(), false), ("0123456789ABCDEF".repeat(4), false), (format!("{LOWER_HEX}\n"), false), (LOWER_HEX.to_string(), true)] {
            let (_d, c) = fixture(vec![]);
            std::fs::write(c.paths.pos_backup_pw(), &content).unwrap();
            let exec = Rc::new(FakeExec::default().on_n("-U pos_backup", 1, 2, ""));
            ensure_backup_role(&c, &deps(exec.clone())).unwrap();
            let now = crate::util::read_secret_file(&c.paths.pos_backup_pw()).unwrap().0;
            assert_eq!(now == content, kept, "{content:?} -> {now:?}");
            assert!(now.len() == 64 && now.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert!(exec.calls.borrow().iter().any(|l| l.contains(&format!("\\set pw '{now}'"))));
        }
    }

    #[test]
    fn the_backup_role_password_file_always_ends_wrapped() {
        let wrapped = |c: &BackupCtx| std::fs::read(c.paths.pos_backup_pw()).unwrap().starts_with(crate::dpapi::MAGIC);
        // fresh: no file, the role does not exist yet
        let (_d, c) = fixture(vec![]);
        ensure_backup_role(&c, &deps(Rc::new(FakeExec::default().on_n("-U pos_backup", 1, 2, "")))).unwrap();
        assert!(wrapped(&c), "freshly generated");
        // regenerated: damaged plaintext, the probe fails
        let (_d, c) = fixture(vec![]);
        std::fs::write(c.paths.pos_backup_pw(), "short").unwrap();
        ensure_backup_role(&c, &deps(Rc::new(FakeExec::default().on_n("-U pos_backup", 1, 2, "")))).unwrap();
        assert!(wrapped(&c), "regenerated after invalid");
        // legacy plaintext, valid, the probe fails (the role is recreated with the same password)
        let (_d, c) = fixture(vec![]);
        std::fs::write(c.paths.pos_backup_pw(), LOWER_HEX).unwrap();
        ensure_backup_role(&c, &deps(Rc::new(FakeExec::default().on_n("-U pos_backup", 1, 2, "")))).unwrap();
        assert!(wrapped(&c), "legacy rewrapped (probe failed)");
        assert_eq!(crate::util::read_secret_file(&c.paths.pos_backup_pw()).unwrap().0, LOWER_HEX);
        // legacy plaintext, the probe already succeeds (update, backup and restore runs): still rewrapped, value kept
        let (_d, c) = fixture(vec![]);
        std::fs::write(c.paths.pos_backup_pw(), LOWER_HEX).unwrap();
        ensure_backup_role(&c, &deps(Rc::new(FakeExec::default()))).unwrap();
        assert!(wrapped(&c), "legacy rewrapped (probe succeeded)");
        assert_eq!(crate::util::read_secret_file(&c.paths.pos_backup_pw()).unwrap().0, LOWER_HEX);
        // a damaged wrapped file with a working role is left byte for byte (never regenerated)
        let (_d, c) = fixture(vec![]);
        std::fs::write(c.paths.pos_backup_pw(), b"POSDPAPI1
not a blob").unwrap();
        ensure_backup_role(&c, &deps(Rc::new(FakeExec::default()))).unwrap();
        assert_eq!(std::fs::read(c.paths.pos_backup_pw()).unwrap(), b"POSDPAPI1
not a blob");
    }

    fn r2(name: &str) -> Destination {
        Destination { name: name.into(), kind: DestKind::R2, path: None, repo: Some("s3:https://h/b/f".into()), volume_serial: None, added_at: 0, extra: Default::default() }
    }
    fn seed(c: &BackupCtx, st: BackupState) { st.save_in(c).unwrap(); }
    fn with_local(destinations: std::collections::BTreeMap<String, crate::backup::state::DestState>) -> BackupState {
        BackupState {
            first_seen_at: NOW - 86_400,
            local: Some(SnapRef { id: "0ldsnap0".into(), at: NOW - 60, reason: "hourly".into() }),
            last_attempt_at: NOW - 60,
            last_attempt_ok: true,
            destinations,
            ..Default::default()
        }
    }
    fn write_r2_env(c: &BackupCtx) { std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=ak-test\nAWS_SECRET_ACCESS_KEY=sk-test\n").unwrap(); }

    fn incomplete_stdout() -> String {
        format!("{}\n{SUMMARY}", r#"{"message_type":"error","error":{"message":"read failed"},"during":"archival","item":"C:\\other\\locked.bin"}"#)
    }

    #[test]
    fn an_incomplete_backup_is_forgotten_by_id_names_the_unreadable_paths_and_does_not_advance_local() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "x").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", write_arg_file).on("backup --json", 3, &incomplete_stdout()));
        let e = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(e.message.contains(r"C:\other\locked.bin"), "{}", e.message);
        assert_eq!(exec.count_of(" forget cafebabe"), 1, "the incomplete snapshot is forgotten by id");
        assert!(!line(&exec, " forget cafebabe").contains("--prune"));
        assert!(load(&c).local.is_none(), "st.local is not advanced");
    }

    #[test]
    fn a_killed_run_leaves_a_failed_attempt_behind_and_the_next_tick_backs_off() {
        let (_d, c) = fixture(vec![]);
        let exec = PanicAtGlobals { inner: base_exec(), backups: c.paths.backups(), dump_existed: Rc::new(Cell::new(false)) };
        let d = Deps { exec: Box::new(exec), opener: Box::new(FakeOpener { log: Log::default(), fail_on: None, timeouts: Default::default(), on_mig: None }), now: || NOW, free_bytes: |_| Ok(1 << 40) };
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_backup(&c, &d, &opts(Reason::Manual)))).is_err());
        let st = load(&c);
        assert!(!st.last_attempt_ok && st.last_attempt_at == NOW);
        assert_eq!(st.last_error.as_deref(), Some("interrupted"));
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.skip.as_deref()), ("skipped", Some("backoff")));
        assert_eq!(exec.count_of("pg_dump.exe -h"), 0);
    }

    #[test]
    fn copy_only_leaves_a_destination_in_backoff_alone_and_a_failed_drive_backs_off_too() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb")), r2("cloud")]);
        write_r2_env(&c);
        let cloud = crate::backup::state::DestState { reachable: true, next_copy_attempt_at: NOW + crate::backup::policy::R2_COPY_RETRY_SECS / 3, ..Default::default() };
        seed(&c, with_local([("cloud".to_string(), cloud)].into()));
        let exec = Rc::new(base_exec().on("copy --from-repo", 1, ""));
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!(rep.outcome, "copied");
        assert_eq!(rep.destinations.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["usb-e"]);
        assert!(!exec.calls.borrow().iter().any(|l| l.contains("s3:https")), "the R2 destination is inside its retry window");
        assert_eq!(load(&c).destinations["usb-e"].next_copy_attempt_at, NOW + crate::backup::policy::DEVICE_COPY_RETRY_SECS);
        // the next tick: both are in backoff, so nothing is copied
        let exec2 = Rc::new(base_exec());
        let rep2 = run_backup(&c, &deps(exec2.clone()), &sched()).unwrap();
        assert_eq!((rep2.outcome.as_str(), rep2.skip.as_deref()), ("skipped", Some("not-due")));
        assert_eq!(exec2.count_of("copy --from-repo"), 0);
    }

    // ---- Plan 08 Task 10: stored times that the owner alerts are derived from ----

    #[test]
    fn a_copy_that_keeps_failing_remembers_when_it_started_and_a_good_copy_forgets_it() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        seed(&c, with_local([].into()));
        run_backup(&c, &deps(Rc::new(base_exec().on("copy --from-repo", 1, ""))), &sched()).unwrap();
        let first = load(&c).destinations["usb-e"].failing_since;
        assert_eq!(first, Some(NOW), "the first failure is stamped");
        // a later failure (the retry window passed) keeps the ORIGINAL time: the alert's since must not move
        let mut st = load(&c);
        st.destinations.get_mut("usb-e").unwrap().next_copy_attempt_at = 0;
        st.destinations.get_mut("usb-e").unwrap().failing_since = Some(NOW - 7 * 3600);
        seed(&c, st);
        run_backup(&c, &deps(Rc::new(base_exec().on("copy --from-repo", 1, ""))), &sched()).unwrap();
        assert_eq!(load(&c).destinations["usb-e"].failing_since, Some(NOW - 7 * 3600));
        let mut st = load(&c);
        st.destinations.get_mut("usb-e").unwrap().next_copy_attempt_at = 0;
        seed(&c, st);
        run_backup(&c, &deps(Rc::new(base_exec())), &sched()).unwrap();
        let ds = load(&c).destinations["usb-e"].clone();
        assert!(ds.ok && ds.failing_since.is_none(), "{ds:?}");
    }

    #[test]
    fn an_unreadable_photo_keeps_the_time_it_was_first_seen_across_backups() {
        let (_d, c) = fixture(vec![]);
        let mut st = BackupState { first_seen_at: NOW - 86_400, ..Default::default() };
        st.photos_unreadable = Some(PhotosUnreadableRef { at: NOW - 5 * 3600, total: 1, paths: vec![photo(&c, "a.jpg")] });
        seed(&c, st);
        run_backup(&c, &deps(exit3_exec(&[err_line(&photo(&c, "a.jpg")), err_line(&photo(&c, "b.jpg"))])), &opts(Reason::Manual)).unwrap();
        let pu = load(&c).photos_unreadable.unwrap();
        assert_eq!((pu.total, pu.at), (2, NOW - 5 * 3600), "the count is current, the first-seen time is not reset");
    }
    #[test]
    fn a_reinserted_drive_is_copied_at_once_despite_an_earlier_backoff() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        let usb = crate::backup::state::DestState { reachable: false, down_since: Some(NOW - 5000), next_copy_attempt_at: NOW + 1500, ..Default::default() };
        seed(&c, with_local([("usb-e".to_string(), usb)].into()));
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!(rep.outcome, "copied");
        assert_eq!(exec.count_of("copy --from-repo"), 1);
    }

    // ---- batch 2 (C): a re-inserted drive is maintained after its copy ----

    fn copy_pending_usb(c: &BackupCtx, pruned_at: i64) {
        let usb = crate::backup::state::DestState { reachable: false, down_since: Some(NOW - 5000), pruned_at, ..Default::default() };
        seed(c, with_local([("usb-e".to_string(), usb)].into()));
    }

    #[test]
    fn a_reinserted_drive_with_a_week_old_prune_gets_the_copy_then_a_check_then_the_prune() {
        use crate::exec::Priority;
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        copy_pending_usb(&c, NOW - 7 * 86_400);
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!(rep.outcome, "copied");
        let usb_s = d.path().join("usb").to_string_lossy().to_string();
        let at = |what: &str| exec.index_of(&format!("--repo {usb_s} {what}")).unwrap_or_else(|| panic!("no {what}"));
        assert!(at("copy --from-repo") < at("check") && at("check") < at("forget"));
        let f = exec.calls.borrow().iter().find(|l| l.contains(&format!("--repo {usb_s} forget"))).cloned().unwrap();
        for need in ["--prune", "--keep-tag protect", "--group-by host", "--keep-hourly 24"] {
            assert!(f.contains(need), "{need} in {f}");
        }
        assert!(!exec.calls.borrow().iter().any(|l| l.contains(&format!("--repo {usb_s} check --read-data"))), "metadata check only");
        for (l, p) in exec.calls.borrow().iter().zip(exec.prios.borrow().iter()) {
            if l.contains("forget") || l.contains(" check") {
                assert_eq!(*p, Priority::BelowNormal, "{l}");
            }
        }
        assert_eq!(load(&c).destinations["usb-e"].pruned_at, NOW);
        assert!(rep.destinations[0].ok && rep.destinations[0].warning.is_none());
    }

    #[test]
    fn a_drive_pruned_yesterday_gets_the_copy_only() {
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        copy_pending_usb(&c, NOW - 86_400);
        let exec = Rc::new(base_exec());
        run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!(exec.count_of("copy --from-repo"), 1);
        assert!(exec.index_of("forget").is_none() && exec.index_of(" check").is_none());
        assert_eq!(load(&c).destinations["usb-e"].pruned_at, NOW - 86_400);
    }

    #[test]
    fn a_failed_check_skips_the_prune_and_a_prune_that_fails_or_times_out_is_a_warning_with_the_clock_kept() {
        use crate::backup::util::RunOutput;
        for case in ["check fails", "prune exits 1", "prune times out"] {
            let d = tempfile::tempdir().unwrap();
            let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
            copy_pending_usb(&c, NOW - 7 * 86_400);
            let mut exec = base_exec();
            match case {
                "check fails" => exec = exec.on(" check", 1, ""),
                "prune exits 1" => exec = exec.on("--prune", 1, ""),
                _ => exec.rules.insert(0, crate::backup::util::fake::Rule { needle: "--prune".into(), out: RunOutput { code: -1, timed_out: true, ..Default::default() }, effect: None, limit: None, used: Default::default() }),
            }
            let exec = Rc::new(exec);
            let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
            assert_eq!(rep.outcome, "copied", "{case}");
            assert!(rep.destinations[0].ok, "{case}: the copy succeeded, so the destination is not failed");
            assert!(rep.destinations[0].warning.is_some(), "{case}");
            assert_eq!(load(&c).destinations["usb-e"].pruned_at, NOW - 7 * 86_400, "{case}");
            assert!(load(&c).destinations["usb-e"].ok, "{case}");
            if case == "check fails" {
                assert!(exec.index_of("forget").is_none(), "no prune on a repository whose check failed");
            }
        }
    }

    #[test]
    fn the_prune_after_a_copy_does_not_start_once_the_scheduled_copy_cap_is_used_up() {
        use std::sync::atomic::{AtomicI64, Ordering};
        static CLOCK_M: AtomicI64 = AtomicI64::new(NOW);
        CLOCK_M.store(NOW, Ordering::SeqCst);
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
        copy_pending_usb(&c, NOW - 7 * 86_400);
        let exec = Rc::new(base_exec().on_with("copy --from-repo", 0, "", |_| {
            CLOCK_M.fetch_add(SCHEDULED_COPY_CAP_SECS + 60, Ordering::SeqCst);
        }));
        let dp = Deps { exec: Box::new(exec.clone()), opener: Box::new(FakeOpener { log: Log::default(), fail_on: None, timeouts: Default::default(), on_mig: None }), now: || CLOCK_M.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) };
        let rep = run_backup(&c, &dp, &sched()).unwrap();
        assert_eq!(rep.outcome, "copied");
        assert!(exec.index_of("forget").is_none() && rep.destinations[0].ok);
        assert_eq!(load(&c).destinations["usb-e"].pruned_at, NOW - 7 * 86_400, "still due: the next tick resumes");
    }

    #[test]
    fn the_prune_after_a_copy_needs_ten_minutes_of_the_cap_left_and_otherwise_keeps_the_clock() {
        use std::sync::atomic::{AtomicI64, Ordering};
        static CLOCK_N: AtomicI64 = AtomicI64::new(NOW);
        for (left_secs, runs) in [(2 * 60, false), (MIN_PRUNE_WINDOW_SECS + 60, true)] {
            CLOCK_N.store(NOW, Ordering::SeqCst);
            let d = tempfile::tempdir().unwrap();
            let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
            copy_pending_usb(&c, NOW - 7 * 86_400);
            // the copy uses up all of the 30 minute cap but `left_secs`
            let exec = Rc::new(base_exec().on_with("copy --from-repo", 0, "", move |_| {
                CLOCK_N.fetch_add(SCHEDULED_COPY_CAP_SECS - left_secs, Ordering::SeqCst);
            }));
            let dp = Deps { exec: Box::new(exec.clone()), opener: Box::new(FakeOpener { log: Log::default(), fail_on: None, timeouts: Default::default(), on_mig: None }), now: || CLOCK_N.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) };
            let rep = run_backup(&c, &dp, &sched()).unwrap();
            assert_eq!(rep.outcome, "copied");
            assert!(rep.destinations[0].ok);
            assert_eq!(exec.index_of("forget").is_some(), runs, "{left_secs}s left");
            assert_eq!(exec.index_of(" check").is_some(), runs, "{left_secs}s left");
            if !runs {
                assert_eq!(load(&c).destinations["usb-e"].pruned_at, NOW - 7 * 86_400, "still due next time");
            }
        }
    }

    #[test]
    fn a_foreign_drive_is_never_written_and_is_reported_distinctly() {
        let d = tempfile::tempdir().unwrap();
        let mut foreign = dest("usb-e", &d.path().join("usb"));
        foreign.volume_serial = Some("0000-0000".into()); // the drive that was set up; whatever sits here now is another one
        let (_d, c) = fixture(vec![foreign]);
        seed(&c, with_local(Default::default()));
        let exec = Rc::new(base_exec());
        let rep = run_backup(&c, &deps(exec.clone()), &sched()).unwrap();
        assert_eq!(rep.outcome, "skipped");
        let st = load(&c);
        let ds = &st.destinations["usb-e"];
        assert!(ds.foreign && !ds.reachable && ds.last_error.as_deref() == Some(dest::DEVICE_REFUSED_MSG), "{ds:?}");
        // a manual backup reports it per destination and still writes nothing to it
        let exec2 = Rc::new(base_exec());
        let rep2 = run_backup(&c, &deps(exec2.clone()), &opts(Reason::Manual)).unwrap();
        assert!(rep2.destinations[0].skipped && rep2.destinations[0].error.as_deref().unwrap().contains("different drive"));
        assert_eq!(exec2.count_of("copy --from-repo"), 0);
    }

    fn deps_free(exec: Rc<FakeExec>, free_bytes: fn(&Path) -> std::io::Result<u64>) -> Deps {
        Deps { free_bytes, ..deps(exec) }
    }

    #[test]
    fn too_little_free_space_for_the_dump_fails_before_pg_dump_and_writes_nothing() {
        let (_d, c) = fixture(vec![]);
        let log = Log::default();
        let exec = Rc::new(base_exec_logged(&log));
        let d = Deps { free_bytes: |_| Ok(2 << 30), ..deps_with(exec.clone(), &log, None) }; // 2 GiB is not 2 x 4096 + 2 GiB
        let e = run_backup(&c, &d, &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(e.message.contains("free"), "{}", e.message);
        assert!(exec.index_of("pg_dump.exe -h").is_none() && exec.index_of("backup --json").is_none());
        assert_eq!(log.borrow().iter().filter(|e| *e == "close").count(), 1, "the session is closed");
        assert!(plaintext_left(&c).is_empty());
    }

    #[test]
    fn too_little_free_space_for_the_repository_after_the_dump_fails_before_restic_backup() {
        let (_d, c) = fixture(vec![]);
        let big = |a: &[String]| {
            let i = a.iter().position(|x| x == "-f").unwrap();
            std::fs::write(&a[i + 1], vec![0u8; 10_000]).unwrap();
        };
        let exec = Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "x").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", big).on("backup --json", 0, SUMMARY));
        // passes 2 x 4096 + 2 GiB for the dump, fails 10_000 + 2 GiB for the repository
        let e = run_backup(&c, &deps_free(exec.clone(), |_| Ok((2 << 30) + 9_000)), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(e.message.contains("free"), "{}", e.message);
        assert!(exec.index_of("pg_dump.exe -h").is_some() && exec.index_of("backup --json").is_none());
        assert!(plaintext_left(&c).is_empty());
    }

    #[test]
    fn a_caller_that_holds_the_lock_does_not_sweep_live_private_folders_but_a_locked_run_does() {
        let (_d, c) = fixture(vec![]);
        let live = c.paths.backups_tmp().join("run-live");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("rk-1.tmp"), b"k").unwrap();
        run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::PreUpdate)).unwrap();
        assert!(live.join("rk-1.tmp").exists(), "another PrivateDir user may be alive; the next tick sweeps");
        run_backup(&c, &deps(Rc::new(base_exec())), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap();
        assert!(!live.exists());
    }

    #[test]
    fn update_lock_is_held_shared_while_restic_backs_up() {
        let (_d, c) = fixture(vec![]);
        let seen: Rc<RefCell<Option<LockState>>> = Rc::default();
        let (s2, roots) = (seen.clone(), c.paths.roots().clone());
        let exec = Rc::new(
            FakeExec::default()
                .on("pg_dump.exe --version", 0, "x")
                .on_with("pg_dumpall.exe", 0, "", write_arg_file)
                .on_with("pg_dump.exe", 0, "", write_arg_file)
                .on_with("backup --json", 0, SUMMARY, move |_| *s2.borrow_mut() = Some(crate::ops::lock::probe_for(&roots))),
        );
        run_backup(&c, &deps(exec), &RunOptions { lock: LockPolicy::Acquire, ..opts(Reason::Manual) }).unwrap();
        assert_eq!(seen.borrow().clone(), Some(LockState::SharedHeld));
    }

    #[test]
    fn the_r2_retry_time_is_set_on_a_failed_copy_and_reset_by_a_successful_one() {
        let (_d, c) = fixture(vec![r2("cloud")]);
        write_r2_env(&c);
        let exec = Rc::new(base_exec().on_n("copy --from-repo", 1, 1, ""));
        run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        let st = load(&c);
        assert_eq!(st.destinations["cloud"].next_copy_attempt_at, NOW + crate::backup::policy::R2_COPY_RETRY_SECS);
        assert!(st.destinations["cloud"].last_success.is_none());
        run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::Manual)).unwrap();
        let st = load(&c);
        assert_eq!(st.destinations["cloud"].next_copy_attempt_at, 0);
        assert!(st.destinations["cloud"].last_success.is_some());
    }

    #[test]
    fn a_state_save_failure_after_the_snapshot_is_only_a_warning() {
        let (_d, c) = fixture(vec![]);
        let state_file = c.paths.state_file();
        let exec = Rc::new(
            FakeExec::default()
                .on("pg_dump.exe --version", 0, "x")
                .on_with("pg_dumpall.exe", 0, "", write_arg_file)
                .on_with("pg_dump.exe", 0, "", write_arg_file)
                // the state file becomes a folder: the atomic rename onto it fails
                .on_with("backup --json", 0, SUMMARY, move |_| {
                    let _ = std::fs::remove_file(&state_file);
                    std::fs::create_dir_all(&state_file).unwrap();
                }),
        );
        let rep = run_backup(&c, &deps(exec), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.outcome, "completed");
        assert_eq!(rep.snapshot_id.as_deref(), Some("cafebabe"));
        assert!(rep.warnings.iter().any(|w| w.contains("state file")), "{:?}", rep.warnings);
        assert_eq!(rep.warnings.iter().filter(|w| w.contains("state file")).count(), 1, "one warning, not one per save");
    }

    // ---- batch 2 (PM rulings): deadline, timeouts, copy cap, exit 3 on photos ----
    use std::sync::atomic::{AtomicI64, Ordering};

    fn all_timeouts(exec: &FakeExec, needle: &str) -> Vec<Duration> {
        exec.calls.borrow().iter().zip(exec.timeouts.borrow().iter()).filter(|(l, _)| l.contains(needle)).map(|(_, t)| *t).collect()
    }
    fn secs(n: u64) -> Duration { Duration::from_secs(n) }

    #[test]
    fn dump_and_backup_timeouts_scale_with_the_database_size_and_clamp() {
        assert_eq!(step_timeout(0), 2 * HOUR, "unknown size (first run) uses the 2 h cap");
        assert_eq!(step_timeout(1 << 20), secs(900), "small: the 15 min floor");
        assert_eq!(step_timeout(10 << 30), secs(1024 + 900), "mid: 10 GiB at 10 MiB/s plus 15 min");
        assert_eq!(step_timeout(1 << 40), 2 * HOUR, "huge: the 2 h cap");
        assert!(step_timeout(20 << 30) > step_timeout(10 << 30), "linear between the clamps");
    }

    #[test]
    fn the_run_uses_the_size_of_the_last_database_for_its_dump_and_backup_timeouts() {
        let (_d, c) = fixture(vec![]);
        seed(&c, BackupState { first_seen_at: NOW - 1, last_db_bytes: 10 << 30, ..Default::default() });
        let exec = Rc::new(base_exec());
        run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(exec.timeout_of("pg_dump.exe -h"), step_timeout(10 << 30));
        assert_eq!(exec.timeout_of("backup --json"), step_timeout(10 << 30));
        let (_d2, c2) = fixture(vec![]);
        let exec2 = Rc::new(base_exec());
        run_backup(&c2, &deps(exec2.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(exec2.timeout_of("pg_dump.exe -h"), 2 * HOUR, "first run: size unknown");
    }

    #[test]
    fn pre_update_pre_switch_and_pre_restore_backups_stay_local_and_the_next_tick_ships_them() {
        for reason in [Reason::PreUpdate, Reason::PreSwitch, Reason::PreRestore] {
            let d = tempfile::tempdir().unwrap();
            let (_d, c) = fixture(vec![dest("usb-e", &d.path().join("usb"))]);
            let exec = Rc::new(base_exec());
            let rep = run_backup(&c, &deps(exec.clone()), &opts(reason)).unwrap();
            assert_eq!(rep.outcome, "completed");
            assert!(rep.destinations.is_empty(), "{reason:?}: no copy inside the maintenance window");
            assert_eq!((exec.count_of(" forget "), exec.count_of("copy --from-repo")), (0, 0), "{reason:?}: no forget, no copy");
            let st = load(&c);
            assert_eq!(st.local.as_ref().unwrap().id, "cafebabe");
            assert!(st.destinations.get("usb-e").and_then(|d| d.last_success.as_ref()).is_none());
            let exec2 = Rc::new(base_exec());
            let rep2 = run_backup(&c, &deps(exec2.clone()), &sched()).unwrap();
            assert_eq!(rep2.outcome, "copied", "{reason:?}");
            assert_eq!(exec2.count_of("copy --from-repo"), 1);
        }
    }

    #[test]
    fn a_spent_budget_fails_before_any_tool_runs_and_is_recorded_in_state() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec());
        let e = run_backup(&c, &deps(exec.clone()), &RunOptions { deadline: Some(NOW), ..opts(Reason::PreUpdate) }).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert!(e.message.contains("pre-update") && e.message.contains("exceeded"), "{}", e.message);
        assert!(exec.calls.borrow().is_empty());
        let st = load(&c);
        assert!(!st.last_attempt_ok && st.last_error.as_deref().is_some_and(|m| m.contains("exceeded")), "{st:?}");
    }

    #[test]
    fn the_snapshot_session_never_waits_longer_than_the_time_left_in_the_window() {
        let (_d, c) = fixture(vec![]);
        let (d, seen) = deps_seen(Rc::new(base_exec()), None);
        run_backup(&c, &d, &RunOptions { deadline: Some(NOW + 100), ..opts(Reason::PreUpdate) }).unwrap();
        let seen = seen.borrow();
        assert!(seen.len() >= 7, "open plus the six collect queries: {seen:?}");
        assert!(seen.iter().all(|t| *t <= secs(100)), "{seen:?}");
    }

    #[test]
    fn without_a_deadline_every_snapshot_query_keeps_the_15_minute_wait() {
        let (_d, c) = fixture(vec![]);
        let (d, seen) = deps_seen(Rc::new(base_exec()), None);
        run_backup(&c, &d, &opts(Reason::PreUpdate)).unwrap();
        assert!(seen.borrow().iter().all(|t| *t == secs(900)), "{:?}", seen.borrow());
    }

    static CLOCK_QUERY: AtomicI64 = AtomicI64::new(NOW);

    #[test]
    fn a_window_that_closes_between_two_snapshot_queries_stops_the_collection() {
        CLOCK_QUERY.store(NOW, Ordering::SeqCst);
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec());
        let (d, seen) = deps_seen(exec.clone(), Some(|| CLOCK_QUERY.store(NOW + 500, Ordering::SeqCst)));
        let d = Deps { now: || CLOCK_QUERY.load(Ordering::SeqCst), ..d };
        let e = run_backup(&c, &d, &RunOptions { deadline: Some(NOW + 300), ..opts(Reason::PreUpdate) }).unwrap_err();
        assert!(e.message.contains("exceeded") && e.message.contains("snapshot query"), "{}", e.message);
        assert!(exec.index_of("pg_dump.exe -h").is_none(), "the dump never started");
        assert!(seen.borrow().len() < 7, "the remaining queries were not sent: {:?}", seen.borrow());
        assert!(load(&c).last_error.as_deref().is_some_and(|m| m.contains("exceeded")));
    }

    static CLOCK_BUDGET: AtomicI64 = AtomicI64::new(NOW);

    #[test]
    fn a_budget_spent_during_the_dump_names_the_step_it_stopped_before_and_leaves_no_plaintext() {
        CLOCK_BUDGET.store(NOW, Ordering::SeqCst);
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(
            FakeExec::default()
                .on_with("pg_dump.exe --version", 0, "x", |_| CLOCK_BUDGET.store(NOW + 500, Ordering::SeqCst))
                .on_with("pg_dumpall.exe", 0, "", write_arg_file)
                .on_with("pg_dump.exe", 0, "", write_arg_file)
                .on("backup --json", 0, SUMMARY),
        );
        let d = Deps { now: || CLOCK_BUDGET.load(Ordering::SeqCst), ..deps(exec.clone()) };
        let e = run_backup(&c, &d, &RunOptions { deadline: Some(NOW + 300), ..opts(Reason::PreUpdate) }).unwrap_err();
        assert!(e.message.contains("exceeded") && e.message.contains("restic backup"), "{}", e.message);
        assert!(exec.index_of("backup --json").is_none());
        assert!(plaintext_left(&c).is_empty());
        assert!(load(&c).last_error.as_deref().is_some_and(|m| m.contains("exceeded")));
    }

    #[test]
    fn every_child_timeout_is_capped_by_the_time_left_in_the_window() {
        let (_d, c) = fixture(vec![]);
        let exec = Rc::new(base_exec());
        run_backup(&c, &deps(exec.clone()), &RunOptions { deadline: Some(NOW + 100), ..opts(Reason::PreUpdate) }).unwrap();
        for needle in [" unlock", "pg_dump.exe -h", "pg_dumpall.exe", "pg_dump.exe --version", "backup --json"] {
            assert!(exec.timeout_of(needle) <= secs(100), "{needle}: {:?}", exec.timeout_of(needle));
        }
        let (_d2, c2) = fixture(vec![]);
        let exec2 = Rc::new(base_exec());
        run_backup(&c2, &deps(exec2.clone()), &opts(Reason::PreUpdate)).unwrap();
        assert_eq!(exec2.timeout_of(" unlock"), secs(120), "without a deadline a step keeps its own timeout");
    }

    static CLOCK_COPY: AtomicI64 = AtomicI64::new(NOW);

    #[test]
    fn a_scheduled_tick_stops_copying_after_30_minutes_and_the_rest_waits_for_the_next_tick() {
        CLOCK_COPY.store(NOW, Ordering::SeqCst);
        let d = tempfile::tempdir().unwrap();
        let (_d, c) = fixture(vec![dest("usb-a", &d.path().join("a")), dest("usb-b", &d.path().join("b")), dest("usb-c", &d.path().join("c"))]);
        seed(&c, with_local(Default::default()));
        // each copy "takes" 20 minutes on the shared clock
        let exec = Rc::new(base_exec().on_with("copy --from-repo", 0, "", |_| { CLOCK_COPY.fetch_add(1200, Ordering::SeqCst); }));
        let dp = Deps { now: || CLOCK_COPY.load(Ordering::SeqCst), ..deps(exec.clone()) };
        let rep = run_backup(&c, &dp, &sched()).unwrap();
        assert_eq!(rep.destinations.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["usb-a", "usb-b"], "the third is not started");
        assert_eq!(all_timeouts(&exec, "copy --from-repo"), [secs(1800), secs(600)], "each copy gets what is left of the 30 minutes");
        let st = load(&c);
        assert!(st.destinations["usb-c"].last_success.is_none() && st.destinations["usb-c"].next_copy_attempt_at == 0, "left pending, not failed");
        // a manual run is not capped
        let (_d2, c2) = fixture(vec![dest("usb-a", &d.path().join("a2"))]);
        let exec2 = Rc::new(base_exec());
        run_backup(&c2, &deps(exec2.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!(exec2.timeout_of("copy --from-repo"), 2 * HOUR);
    }

    fn err_line(path: &str) -> String {
        serde_json::json!({"message_type": "error", "error": {"message": "read failed"}, "during": "archival", "item": path}).to_string()
    }
    fn exit3_exec(items: &[String]) -> Rc<FakeExec> {
        let out = format!("{}\n{SUMMARY}", items.join("\n"));
        Rc::new(FakeExec::default().on("pg_dump.exe --version", 0, "x").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", write_arg_file).on("backup --json", 3, &out))
    }
    fn photo(c: &BackupCtx, name: &str) -> String { c.paths.photos().join(name).to_string_lossy().into_owned() }

    #[test]
    fn unreadable_photos_alone_keep_the_snapshot_record_a_warning_and_a_clean_run_clears_it() {
        let (_d, c) = fixture(vec![]);
        let items = [err_line(&photo(&c, "a.jpg")), err_line(&photo(&c, "sub\\b.jpg"))];
        let exec = exit3_exec(&items);
        let rep = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap();
        assert_eq!((rep.outcome.as_str(), rep.snapshot_id.as_deref()), ("completed", Some("cafebabe")));
        assert!(rep.warnings.iter().any(|w| w.starts_with("photos_unreadable") && w.contains("a.jpg") && w.contains("b.jpg")), "{:?}", rep.warnings);
        assert_eq!(exec.count_of(" forget cafebabe"), 0, "the snapshot is kept");
        let st = load(&c);
        assert_eq!(st.local.as_ref().unwrap().id, "cafebabe");
        assert!(st.last_attempt_ok);
        let pu = st.photos_unreadable.expect("persisted for the status task");
        assert_eq!((pu.total, pu.paths.len(), pu.at), (2, 2, NOW));
        run_backup(&c, &deps(Rc::new(base_exec())), &opts(Reason::Manual)).unwrap();
        assert!(load(&c).photos_unreadable.is_none(), "a clean backup clears it");
    }

    #[test]
    fn restic_reports_unreadable_files_on_stderr_in_json_mode_and_that_counts_too() {
        // real restic (this pack): with --json the per-file error lines arrive on stderr, the summary on stdout
        let (_d, c) = fixture(vec![]);
        let mut exec = FakeExec::default().on("pg_dump.exe --version", 0, "x").on_with("pg_dumpall.exe", 0, "", write_arg_file).on_with("pg_dump.exe", 0, "", write_arg_file).on("backup --json", 3, SUMMARY);
        exec.rules.last_mut().unwrap().out.stderr = format!("{}\n", err_line(&photo(&c, "a.jpg")));
        let rep = run_backup(&c, &deps(Rc::new(exec)), &opts(Reason::Manual)).unwrap();
        assert_eq!(rep.snapshot_id.as_deref(), Some("cafebabe"));
        assert!(rep.warnings.iter().any(|w| w.starts_with("photos_unreadable") && w.contains("a.jpg")), "{:?}", rep.warnings);
    }

    #[test]
    fn the_photo_warning_lists_the_first_20_paths_and_counts_them_all() {
        let (_d, c) = fixture(vec![]);
        let items: Vec<String> = (0..25).map(|i| err_line(&photo(&c, &format!("p{i:02}.jpg")))).collect();
        let rep = run_backup(&c, &deps(exit3_exec(&items)), &opts(Reason::Manual)).unwrap();
        let pu = load(&c).photos_unreadable.unwrap();
        assert_eq!((pu.total, pu.paths.len()), (25, 20));
        let w = rep.warnings.iter().find(|w| w.starts_with("photos_unreadable")).unwrap();
        assert!(w.contains("25") && w.contains("p00.jpg") && w.contains("p19.jpg") && !w.contains("p20.jpg"), "{w}");
    }

    #[test]
    fn a_photo_and_a_non_photo_path_together_are_a_failure_and_the_snapshot_is_forgotten() {
        let (_d, c) = fixture(vec![]);
        let exec = exit3_exec(&[err_line(&photo(&c, "a.jpg")), err_line(r"C:\other\locked.bin")]);
        let e = run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        assert_eq!(exec.count_of(" forget cafebabe"), 1);
        let st = load(&c);
        assert!(st.local.is_none() && st.photos_unreadable.is_none() && !st.last_attempt_ok);
    }

    #[test]
    fn a_sibling_folder_with_the_photos_prefix_is_not_the_photos_folder() {
        let (_d, c) = fixture(vec![]);
        let sibling = format!("{}-old\\x.jpg", c.paths.photos().to_string_lossy());
        let exec = exit3_exec(&[err_line(&sibling)]);
        assert!(run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).is_err());
        assert_eq!(exec.count_of(" forget cafebabe"), 1);
    }

    #[test]
    fn unreadable_photos_do_not_save_a_snapshot_whose_dump_no_longer_matches_its_manifest() {
        let (_d, c) = fixture(vec![]);
        let out = format!("{}\n{SUMMARY}", err_line(&photo(&c, "a.jpg")));
        let exec = Rc::new(
            FakeExec::default()
                .on("pg_dump.exe --version", 0, "x")
                .on_with("pg_dumpall.exe", 0, "", write_arg_file)
                .on_with("pg_dump.exe", 0, "", write_arg_file)
                .on_with("backup --json", 3, &out, |args| {
                    let i = args.iter().position(|a| a == ".tmp").unwrap();
                    std::fs::write(PathBuf::from(&args[i + 1]).join("pos.dump"), b"changed after the manifest").unwrap();
                }),
        );
        assert!(run_backup(&c, &deps(exec.clone()), &opts(Reason::Manual)).is_err());
        assert_eq!(exec.count_of(" forget cafebabe"), 1);
        assert!(load(&c).local.is_none());
    }
}
