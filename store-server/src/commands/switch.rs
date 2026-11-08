//! `posctl switch plan|run|rollback` (conventions 11.1, 11.2). The cloud credentials arrive on stdin only.
//! `plan` only reads. `run` is Plan 07's runner with a `SwitchWork`: the same prechecks as `plan`, then hold the cloud, copy, verify, swap,
//! mark the cloud `moved`. `rollback` gives the cloud store back and touches nothing local.
use crate::commands::update::{Deps, RealDeps, OPERATION_LOCK_WAIT_SECS};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::ops::hooks;
use crate::ops::journal::{Journal, Step};
use crate::ops::lock::{acquire_for, LockGuard, LockMode};
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::runner::run_operation;
use crate::ops::swap::PsqlAdmin;
use crate::ops::world::{OpCtx, OpWork, R};
use crate::paths::Roots;
use crate::switch::cloud::{valid_op_id, write_pgpass, CloudDb, CloudFence};
use crate::switch::facts::{
    clean_text, collect, evaluate_waived, has_blockers, resolve_waivers_for, CollectCtx, Finding,
    PlanFacts, Waivers,
};
use crate::switch::machine::RealMachine;
use crate::switch::progress::{self, Progress};
use crate::switch::rederive::{check_not_switched, refuse_if_switched};
use crate::switch::source::{check_target, label, parse_stdin, SourceCreds};
use crate::switch::staging::{self, StagingDir};
use crate::switch::store_env::check_inputs;
use crate::switch::work::{loud_cloud_warning, may_release_cloud, SwitchInputs, SwitchWork, MAX_WAIT_MINUTES};
use crate::update::manifest::Manifest;
use crate::update::work::statement_budget_ms;
use crate::update::Env;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// One result of a `switch` subcommand, with the exit code conventions 11.2 gives it.
#[derive(Debug, Clone)]
pub struct SwitchReport {
    pub exit: i32,
    pub name: &'static str,
    pub reason: Option<String>,
    pub message: String,
    pub data: serde_json::Value,
    pub retryable: bool,
}

impl SwitchReport {
    fn make(
        exit: i32,
        name: &'static str,
        reason: Option<&str>,
        message: &str,
        data: serde_json::Value,
        retryable: bool,
    ) -> SwitchReport {
        SwitchReport {
            exit,
            name,
            reason: reason.map(str::to_string),
            message: message.to_string(),
            data,
            retryable,
        }
    }
    pub fn ok(message: &str, data: serde_json::Value) -> SwitchReport {
        Self::make(0, "OK", None, message, data, false)
    }
    pub fn usage(message: &str) -> SwitchReport {
        Self::make(
            2,
            "USAGE",
            Some("USAGE"),
            message,
            serde_json::json!({}),
            false,
        )
    }
    pub fn refused(reason: &str, message: &str, data: serde_json::Value) -> SwitchReport {
        Self::make(40, "SWITCH_REFUSED", Some(reason), message, data, false)
    }
    /// Exit 17: this server is back (or needs `update --recover`), but the cloud store may still be marked moved.
    pub fn recovery_needed(reason: &str, message: &str, data: serde_json::Value) -> SwitchReport {
        Self::make(17, "RECOVERY_NEEDED", Some(reason), message, data, false)
    }
    pub fn failed_rolled_back(
        reason: &str,
        message: &str,
        data: serde_json::Value,
    ) -> SwitchReport {
        Self::make(
            41,
            "SWITCH_FAILED_ROLLED_BACK",
            Some(reason),
            message,
            data,
            false,
        )
    }
    /// An error raised before anything changed: usage, lock and recovery errors keep their codes, everything else is a refusal.
    pub fn before_start(e: &OpError) -> SwitchReport {
        let data = serde_json::json!({});
        match e.code {
            OpCode::LockHeld => {
                Self::make(10, "LOCK_HELD", Some(&e.reason), &e.message, data, true)
            }
            OpCode::Usage => Self::make(2, "USAGE", Some(&e.reason), &e.message, data, false),
            OpCode::RecoveryNeeded => Self::make(
                17,
                "RECOVERY_NEEDED",
                Some(&e.reason),
                &e.message,
                data,
                false,
            ),
            _ => Self::refused(&e.reason, &e.message, data),
        }
    }
    /// An error the runner returned after the run started: the system is back as before (41) unless it says recovery is needed (17).
    pub fn after_start(e: &OpError) -> SwitchReport {
        let data = serde_json::json!({});
        match e.code {
            OpCode::RecoveryNeeded => Self::make(
                17,
                "RECOVERY_NEEDED",
                Some(&e.reason),
                &e.message,
                data,
                false,
            ),
            OpCode::LockHeld => {
                Self::make(10, "LOCK_HELD", Some(&e.reason), &e.message, data, true)
            }
            OpCode::Usage => Self::make(2, "USAGE", Some(&e.reason), &e.message, data, false),
            _ => Self::failed_rolled_back(&e.reason, &e.message, data),
        }
    }
    pub fn from_update_report(r: crate::commands::update::Report) -> SwitchReport {
        let exit = r.code.exit();
        let mut data = r.data;
        if let (Some(reason), Some(o)) = (&r.reason, data.as_object_mut()) {
            o.insert("reason".into(), serde_json::Value::String(reason.clone()));
        }
        SwitchReport {
            exit,
            name: r.code.name(),
            reason: r.reason,
            message: r.message,
            data,
            retryable: r.retryable,
        }
    }
    pub fn envelope(
        &self,
        command: &str,
        started_ms: u64,
        finished_ms: u64,
        posctl_version: &str,
    ) -> serde_json::Value {
        let mut data = self.data.clone();
        if let (Some(reason), Some(o)) = (&self.reason, data.as_object_mut()) {
            o.entry("reason")
                .or_insert_with(|| serde_json::Value::String(reason.clone()));
        }
        serde_json::json!({
            "ok": self.exit == 0, "command": command, "code": self.name, "exit": self.exit, "message": self.message,
            "retryable": self.retryable, "data": data, "journal": serde_json::Value::Null,
            "startedAt": started_ms, "finishedAt": finished_ms, "posctlVersion": posctl_version,
        })
    }
    /// Plan 05's `Outcome` (exit 0) or `PosctlError` (every other code keeps its own exit: 40, 41, 17, 10, 2, ...).
    pub fn into_result(self) -> Result<Outcome, PosctlError> {
        if self.exit == 0 {
            return Ok(Outcome::ok(self.message, self.data));
        }
        let code = Code::ALL
            .into_iter()
            .find(|c| c.exit() == self.exit)
            .unwrap_or(Code::Error);
        let mut data = if self.data.is_object() {
            self.data
        } else {
            serde_json::json!({})
        };
        if let (Some(reason), Some(o)) = (&self.reason, data.as_object_mut()) {
            o.entry("reason")
                .or_insert_with(|| serde_json::Value::String(reason.clone()));
        }
        Err(PosctlError {
            code,
            message: self.message,
            retryable: self.retryable,
            data,
        })
    }
}

pub fn read_stdin_limited(r: &mut dyn Read) -> R<String> {
    let mut buf = Vec::new();
    r.take(64 * 1024 + 1)
        .read_to_end(&mut buf)
        .map_err(|_| OpError::new(OpCode::Usage, "STDIN_UNREADABLE", "stdin could not be read"))?;
    if buf.len() > 64 * 1024 {
        return Err(OpError::new(
            OpCode::Usage,
            "STDIN_TOO_LARGE",
            "stdin is larger than 64 KiB",
        ));
    }
    String::from_utf8(buf)
        .map_err(|_| OpError::new(OpCode::Usage, "STDIN_UNREADABLE", "stdin is not UTF-8 text"))
}

/// Flattened into `cli::Command`, so the words are `posctl switch ...`.
#[derive(clap::Subcommand, Debug)]
pub enum SwitchTop {
    /// Move a cloud store to its own Offline-only server (plan 09).
    #[command(subcommand)]
    Switch(SwitchCmd),
}

#[derive(clap::Args, Debug, Clone)]
pub struct PlanArgs {
    /// Read the cloud credentials as one JSON object on stdin (never on the command line).
    #[arg(long)]
    pub source_db_stdin: bool,
    /// Show the plan as if this till were waived (its install id, or its label when only one till reports it). Repeatable.
    /// Needs --waive-reason. Only the unsent and failed work of that till is waived.
    #[arg(long = "waive-terminal")]
    pub waive_terminal: Vec<String>,
    /// Why the till is waived: free text, trimmed, control characters removed, cut to 200 characters, kept in the result as-is.
    #[arg(long = "waive-reason")]
    pub waive_reason: Option<String>,
}

#[derive(clap::Args, Debug, Clone)]
pub struct RunArgs {
    /// Read the cloud credentials as one JSON object on stdin (never on the command line).
    #[arg(long)]
    pub source_db_stdin: bool,
    /// A till that is known to be off or empty: it is not waited for. Its install id, or its label when only one till reports it. Repeatable.
    /// Needs --waive-reason. Only the unsent and failed work of that till is waived; its last queue depth is written to the journal.
    #[arg(long = "waive-terminal")]
    pub waive_terminal: Vec<String>,
    /// Why the till is waived: free text, trimmed, control characters removed, cut to 200 characters, kept in the result as-is.
    #[arg(long = "waive-reason")]
    pub waive_reason: Option<String>,
    /// How long to wait for every till to send its unsent work after the tills are told to stop: 1 to 120 minutes (default 20).
    /// When the time is up the cloud is given back and nothing has changed.
    #[arg(long = "wait-minutes")]
    pub wait_minutes: Option<u32>,
}

/// The long flags `switch run` documents (the runbook lists exactly these).
#[cfg(test)]
const DOCUMENTED_RUN_FLAGS: [&str; 4] = ["source-db-stdin", "waive-terminal", "waive-reason", "wait-minutes"];

#[derive(clap::Args, Debug, Clone)]
pub struct RollbackArgs {
    /// The operation id to give the cloud back for (a failed run prints it). Without one, the operation recorded on this server is used (the
    /// open journal's, else state\update\switch-progress.json's); with none recorded, only a draining or frozen cloud is released.
    pub op_id: Option<String>,
    /// Read the cloud credentials as one JSON object on stdin (never on the command line).
    #[arg(long)]
    pub source_db_stdin: bool,
}

#[derive(clap::Subcommand, Debug)]
pub enum SwitchCmd {
    /// Read-only prechecks against the cloud source.
    Plan(PlanArgs),
    /// Hold the cloud store, copy it onto this server, verify, swap, and mark the cloud moved. Undone completely on any failure before that.
    Run(RunArgs),
    /// Give the cloud store back (`active`) after a switch that stopped. Changes nothing on this server.
    Rollback(RollbackArgs),
}

/// Why a local source is never available in a release build: a cloud store is never on this network, so the only local
/// "cloud" is a test fixture. The product refuses it unless this is a `test-hooks` build (the Sandbox scenarios; a plain debug build
/// is not enough), and then only when `--dev` or the `allow_local_source` hook asks for it. The pure rule, so every combination is testable.
pub(crate) fn local_source_rule(dev: bool, hook: bool, test_hooks_build: bool) -> bool {
    (dev || hook) && test_hooks_build
}
pub(crate) fn local_source_allowed(dev: bool) -> bool {
    local_source_rule(
        dev,
        hooks::allow_local_source(),
        cfg!(feature = "test-hooks"),
    )
}

/// Everything `plan`, `run` and `rollback` need once the credentials parsed and the local server answered.
pub(crate) struct Opened {
    pub pack: String,
    pub pack_dir: PathBuf,
    pub manifest: Manifest,
    pub admin: PsqlAdmin,
    pub cloud: CloudDb,
    pub creds: SourceCreds,
    /// Private staging (the dump folder and the folder holding the cloud `pgpass`); deleted when `Opened` drops, on every exit path.
    pub _staging: StagingDir,
}

fn pre(reason: &str, m: &str) -> OpError {
    OpError::new(OpCode::Precondition, reason, m.to_string())
}

pub(crate) fn open(env: &Env, dev: bool, stdin_text: &str) -> R<Opened> {
    open_with(env, dev, stdin_text, true)
}

/// `local_db`: the local database must answer too. `switch rollback` only gives the cloud back, so it does not need it: a server whose
/// database is down can still free the cloud.
fn open_with(env: &Env, dev: bool, stdin_text: &str, local_db: bool) -> R<Opened> {
    let creds = parse_stdin(stdin_text)?;
    let allow_local = local_source_allowed(dev);
    check_target(&creds.pg, allow_local, env.ports.pg())?;
    let cfg = crate::config::PosctlJson::load(&env.roots).ok().flatten().ok_or_else(|| pre("NOT_PROVISIONED", "this server is not provisioned (conf\\posctl.json is missing); run posctl provision first"))?;
    // A server prepared for the switch (`provision --prepare-for-switch`) is in mode `cloud`; `run` and `rollback` check that before they get here.
    let pack = cfg.pack.current;
    let pack_dir = env.pack_dir(&pack);
    let manifest = Manifest::read(&pack_dir)?;
    let psql = pack_dir.join("pg").join("bin").join("psql.exe");
    let admin = PsqlAdmin::new(
        psql.clone(),
        env.ports.pg(),
        env.secrets().join("pgpass.conf"),
    );
    if local_db {
        admin.scalar("postgres", "SELECT 1").map_err(|_| pre("LOCAL_DB_DOWN", "the local database is not running; start the store services (posctl start) and try again"))?;
    }
    // The cloud password reaches the pg tools through a pgpass file in a private folder, never PGPASSWORD.
    let staging = StagingDir::create(&env.roots)?;
    let pgpass = write_pgpass(staging.pgpass_dir(), &creds.pg)?;
    let cloud = CloudDb::new(psql, creds.pg.clone(), pgpass);
    // Only a `test-hooks` build (the Sandbox scenarios) can ever point CloudDb at a local database; no other path sets it.
    #[cfg(feature = "test-hooks")]
    let cloud = if allow_local {
        cloud.allow_local(env.ports.pg())
    } else {
        cloud
    };
    Ok(Opened {
        pack,
        pack_dir,
        manifest,
        admin,
        cloud,
        creds,
        _staging: staging,
    })
}

/// Conventions 11.1: `photos import-from-cloud` is Plan 10's. `--help` exits 0 only if the subcommand exists.
fn photo_import_available(env: &Env) -> bool {
    Command::new(&env.posctl_exe)
        .args(["photos", "import-from-cloud", "--help"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Shared by `plan` and `run`: the facts. (The findings are `evaluate_waived` on them, with whatever waivers apply.)
pub(crate) fn gather(env: &Env, dev: bool, o: &Opened) -> R<PlanFacts> {
    let local_inputs_missing = check_inputs(env, dev);
    let free_path = env.roots.pgdata();
    collect(&CollectCtx {
        local: &o.admin,
        local_db: "postgres",
        cloud: &o.cloud,
        pack_dir: &o.pack_dir,
        pack_pg_major: o.manifest.pg_major().unwrap_or(17),
        free_path: &free_path,
        has_storage_creds: o.creds.storage.is_some(),
        photo_import_available: photo_import_available(env),
        local_inputs_missing,
    })
}

pub fn plan(args: &PlanArgs, env: &Env, dev: bool, stdin_text: &str) -> SwitchReport {
    if !args.source_db_stdin {
        return SwitchReport::usage("--source-db-stdin is required: the cloud credentials are never accepted on the command line");
    }
    match plan_inner(args, env, dev, stdin_text) {
        Ok(r) => r,
        Err(e) => SwitchReport::before_start(&e),
    }
}

fn plan_inner(args: &PlanArgs, env: &Env, dev: bool, stdin_text: &str) -> R<SwitchReport> {
    // the waiver flags are checked before the cloud is opened: a usage error never costs a connection
    let waivers = Waivers::parse(&args.waive_terminal, args.waive_reason.as_deref())?;
    let o = open(env, dev, stdin_text)?;
    let (facts, findings, waived) = evaluate_for(env, dev, &o, &waivers)?;
    Ok(report_for(&label(&o.creds.pg), &o.pack, &facts, findings, &waivers, &waived))
}

/// The facts and the findings with the waivers applied: `plan` and `run` judge a store the same way (the PLAN10_REQUIRED block included).
fn evaluate_for(
    env: &Env,
    dev: bool,
    o: &Opened,
    waivers: &Option<Waivers>,
) -> R<(PlanFacts, Vec<Finding>, BTreeSet<String>)> {
    let facts = gather(env, dev, o)?;
    let waived: BTreeSet<String> = match waivers {
        Some(w) => resolve_waivers_for(&facts, &w.terminals)?,
        None => BTreeSet::new(),
    };
    let findings = evaluate_waived(&facts, &waived);
    Ok((facts, findings, waived))
}

fn report_for(
    source: &str,
    pack: &str,
    facts: &PlanFacts,
    findings: Vec<Finding>,
    waivers: &Option<Waivers>,
    waived: &BTreeSet<String>,
) -> SwitchReport {
    let can = !has_blockers(&findings);
    let waived_tills: Vec<serde_json::Value> = facts.tills.iter().filter(|t| waived.contains(&t.terminal_uuid.to_lowercase()))
        .map(|t| serde_json::json!({ "uuid": clean_text(&t.terminal_uuid), "label": clean_text(&t.terminal_label) })).collect();
    let data = serde_json::json!({
        "canSwitch": can,
        "source": source,
        "pack": pack,
        "findings": findings,
        "waived": waived_tills,
        "waiveReason": waivers.as_ref().map(|w| w.reason.as_str()),
        "summary": {
            "copyTables": facts.copy_tables.len(), "staff": facts.staff.len(), "tillsReporting": facts.tills.len(),
            "storageObjects": facts.storage_objects, "sourceBytes": facts.source_bytes, "freeBytes": facts.free_bytes,
        },
    });
    if can {
        SwitchReport::ok("the switch can run", data)
    } else {
        SwitchReport::refused(
            "PLAN_BLOCKED",
            "the switch cannot run yet: see the findings",
            data,
        )
    }
}

// ---- run -------------------------------------------------------------------------------------------------------------

/// Minutes to wait for the tills to flush when `--wait-minutes` is not given (the most it may be is `work::MAX_WAIT_MINUTES`).
pub const DEFAULT_WAIT_MINUTES: u32 = 20;
/// How long the cloud stays frozen after the last extension (the dead-man window; a keepalive extends it every minute while we run).
pub const FREEZE_MINUTES: u32 = 30;
/// The maintenance budget after the wait: pre-switch backup, clone, copy, re-derive, both fingerprints, swap, activate, live check, photos.
/// The operation deadline is `t0 + wait + WORK_BUDGET_SECS`, where `t0` is read once the lock is held, the prechecks passed and the dump
/// folder exists (not at process start). What the code does BEFORE THE POINT OF NO RETURN (from Reopen on the run rolls forward and the
/// cloud stays moved), stated exactly:
/// - the runner starts no phase after the deadline, and the verification of the copy refuses to start after it;
/// - every child process of the data move (`pg_dump`, `pg_restore`, the photo importer and checker) is killed at it (`machine::capped`);
/// - every LOCAL psql statement of the machine is capped to what is left of it (`budgeted`, one-minute floor plus the kill margin);
/// - the cloud-side reads of the verification (and `default_replica`) are NOT capped to the deadline: each is bounded by its own fixed
///   600 s server-side statement timeout, with no client-side backstop; the deadline is only checked BEFORE each read of both sides
///   (`machine::within_budget`), not during it;
/// - a rollback stops renewing the cloud freeze FIRST (`OpWork::rollback_started`, before its journal write) and does not wait for a
///   renewal that is stuck on the network (the keepalive thread is detached); a late renewal after the release is refused by the cloud
///   guard (PS001) and never freezes it again;
/// - the renewal has a limit of its own, a monotonic instant fixed once at the start: the deadline plus `SQL_OVERSHOOT_SECS`, whatever the
///   process is doing; `mark_moved` refuses an expired freeze (the switch then rolls back).
///
/// FREEZE BOUND, UNVERIFIED until the T13 execute-level run passes: the cloud is frozen at most the deadline, plus the overshoot (32
/// minutes), plus `FREEZE_MINUTES` (30 minutes): wait + 2 h + about 1 h 2 min from `t0`; normally minutes after a failure.
/// A cloud that is already `moved` is not covered by the dead-man. A hung posctl still holds the exclusive lock, so `switch rollback` and
/// `update --recover` answer exit 10 LOCK_HELD until it is stopped. `status` raises OPERATION_HUNG (alert only, it frees and kills
/// nothing) for any operation holder older than `RUN_CEILING_MS`, naming its PID: confirm that PID is posctl.exe (`tasklist /FI "PID eq
/// N"`), stop THAT PID (never by image name) or restart the server, then run `posctl update --recover`; if it ends with exit 17, run the
/// `switch rollback <op>` it prints. Once the Reopen intent is on disk `switch rollback` refuses PAST_POINT_OF_NO_RETURN and
/// `update --recover` finishes the switch (the cloud stays moved); a rollback that began after that point is never undone by recovery
/// (UNRESOLVABLE). PROVISIONAL until measured.
pub const WORK_BUDGET_SECS: u64 = 7200;
/// One overshoot past the deadline: a single SQL statement already running (at most 30 minutes) or the canary (120 s).
pub const SQL_OVERSHOOT_SECS: u64 = 30 * 60 + 120;

fn wait_minutes(arg: Option<u32>) -> R<u32> {
    let m = arg.unwrap_or(DEFAULT_WAIT_MINUTES);
    if !(1..=MAX_WAIT_MINUTES).contains(&m) {
        return Err(OpError::new(
            OpCode::Usage,
            "WAIT_MINUTES_INVALID",
            format!("--wait-minutes takes 1 to {MAX_WAIT_MINUTES}"),
        ));
    }
    Ok(m)
}

/// How long to wait for the operation lock. A busy lock is `LOCK_HELD` (exit 10, retryable), never a pass and never a refusal about the
/// store; a test does not wait.
fn lock_wait() -> Duration {
    if cfg!(test) {
        Duration::ZERO
    } else {
        Duration::from_secs(OPERATION_LOCK_WAIT_SECS)
    }
}

fn new_op_id() -> R<String> {
    crate::util::random_uuid_v4().map_err(|e| OpError::err("OP_ID_FAILED", e))
}

/// ALREADY_SWITCHED, decided from posctl.json alone: only a server prepared for the switch (mode `cloud`) may switch; Offline-only, any
/// other mode and an unreadable file all refuse. Decided UNDER the operation lock.
fn check_mode(env: &Env) -> R<()> {
    let mode = crate::config::PosctlJson::load(&env.roots)
        .ok()
        .flatten()
        .map(|c| c.mode)
        .unwrap_or_default();
    refuse_if_switched(&mode, None)
}

/// `switch run` refuses while a previous switch left the cloud possibly marked moved: only `switch rollback` clears it.
fn refuse_while_unknown(env: &Env) -> R<()> {
    match progress::read(&env.update_dir()) {
        Some(p) if p.cloud == "unknown" => Err(pre(
            "CLOUD_STATE_UNKNOWN",
            &format!(
                "a previous switch may have left the cloud store marked moved while this server is not switched; run `posctl switch rollback {}` with the cloud credentials first",
                p.op_id.as_deref().unwrap_or("<op id>")
            ),
        )),
        _ => Ok(()),
    }
}

/// The operation holding the cloud RIGHT NOW (`state|op|effective` reads draining or frozen, and the hold has not expired), if any.
pub(crate) fn held_by_other(row: &str) -> Option<String> {
    let mut p = row.split('|');
    let (state, op, effective) = (p.next()?, p.next()?, p.next()?);
    (matches!(state, "draining" | "frozen") && matches!(effective, "draining" | "frozen") && !op.is_empty())
        .then(|| op.to_string())
}

/// An earlier run that stopped without giving the cloud back still holds it: the new run would fail at `begin_draining`, after the local
/// side had already been fenced and backed up. Refuse at the precheck, naming the old operation and the command that clears it.
fn refuse_if_held_by_other(fence: &CloudFence) -> R<()> {
    held_refusal(&fence.state()?)
}

pub(crate) fn held_refusal(row: &str) -> R<()> {
    match held_by_other(row) {
        Some(old) => Err(pre(
            "CLOUD_HELD_BY_ANOTHER_OPERATION",
            &format!("the cloud store is still held by an earlier switch ({old}); give it back first: run `posctl switch rollback {old}` with the cloud credentials"),
        )),
        None => Ok(()),
    }
}

// ---- one scrubber: update's -------------------------------------------------------------------------------------------

/// The local secrets, exactly as `update` reads them. A run or rollback that cannot read them refuses: its error text could not be scrubbed.
fn local_secrets(env: &Env) -> R<Vec<String>> {
    crate::ops::real::load_all_secrets(&env.roots, &env.secrets().join("pgpass.conf"))
}

/// The cloud password and service key, when the stdin text parses (a text that does not parse has nothing to leak).
fn cloud_secrets(stdin_text: &str) -> Vec<String> {
    let Ok(c) = parse_stdin(stdin_text) else { return vec![] };
    let mut v = vec![c.pg.password.expose().to_string()];
    if let Some(s) = &c.storage {
        v.push(s.service_role_key.expose().to_string());
    }
    v
}

/// `update`'s own `finalize` walk (message, reason, every string of the data) on a switch report: there is no second scrubber.
pub(crate) fn finalize_report(mut r: SwitchReport, secrets: &[String]) -> SwitchReport {
    let u = crate::commands::update::finalize(
        crate::commands::update::Report::new(OpCode::Ok, r.reason.as_deref(), &r.message, r.data.clone(), r.retryable),
        secrets,
    );
    r.message = u.message;
    r.reason = u.reason;
    r.data = u.data;
    r
}

type SecretsFn<'a> = &'a dyn Fn(&Env) -> R<Vec<String>>;

/// Every report of `run` and `rollback`, the refusals before the run started included, goes through `finalize_report`.
fn scrub_all(
    env: &Env,
    stdin_text: &str,
    secrets: SecretsFn,
    f: impl FnOnce() -> R<SwitchReport>,
) -> SwitchReport {
    let mut s = match secrets(env) {
        Ok(s) => s,
        Err(e) => return SwitchReport::before_start(&e),
    };
    s.extend(cloud_secrets(stdin_text));
    let report = f().unwrap_or_else(|e| SwitchReport::before_start(&e));
    // the typed pepper and PIN (and what was derived from them) are registered as they are entered; masked, then forgotten
    s.extend(crate::switch::prompt::take_registered());
    let masked = finalize_report(report, &s);
    crate::switch::prompt::zero_strings(&mut s);
    masked
}

pub fn run(args: &RunArgs, env: &Env, dev: bool, stdin_text: &str) -> SwitchReport {
    run_with(args, env, dev, stdin_text, &local_secrets, &|| {})
}

/// `before_lock` runs right before the operation lock is taken (a test flips the world there: every refusal must be decided AFTER it).
pub(crate) fn run_with(
    args: &RunArgs,
    env: &Env,
    dev: bool,
    stdin_text: &str,
    secrets: SecretsFn,
    before_lock: &dyn Fn(),
) -> SwitchReport {
    if !args.source_db_stdin {
        return SwitchReport::usage("--source-db-stdin is required: the cloud credentials are never accepted on the command line");
    }
    scrub_all(env, stdin_text, secrets, || run_inner(args, env, dev, stdin_text, before_lock))
}

/// Order: usage errors, then THE LOCK, then every refusal (the mode, an unknown cloud, an open journal, a leftover fence, the credentials,
/// a cloud that moved or is still held by an earlier switch, the plan's own prechecks), and only then the cloud is touched, inside
/// `run_operation` (`begin_draining`). A refusal is authoritative only under the lock: whatever was true before it may have changed
/// while another operation held it. An error returned by `?` before `execute` is a refusal; afterwards every outcome is built by
/// `failure_report` or is OK.
fn run_inner(args: &RunArgs, env: &Env, dev: bool, stdin_text: &str, before_lock: &dyn Fn()) -> R<SwitchReport> {
    let waivers = Waivers::parse(&args.waive_terminal, args.waive_reason.as_deref())?;
    let wait = wait_minutes(args.wait_minutes)?;
    let op = new_op_id()?;
    before_lock();
    let lock = acquire_for(
        &env.roots,
        LockMode::Exclusive,
        "switch",
        &op,
        lock_wait(),
    )?;
    check_mode(env)?;
    refuse_while_unknown(env)?;
    // a journal on disk is an interrupted operation: it is finished or undone first, never run on top of
    match Journal::read(&env.update_dir()) {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err(OpError::new(
                OpCode::RecoveryNeeded,
                "OPERATION_INCOMPLETE",
                "an interrupted operation is waiting; run `posctl update --recover` first",
            ))
        }
        Err(e) => {
            return Err(OpError::new(
                OpCode::RecoveryNeeded,
                "JOURNAL_UNREADABLE",
                format!("the operation journal cannot be read ({e:?}); run `posctl update --recover`"),
            ))
        }
    }
    // the same check `update` makes (one function): a fence or set-aside Caddyfile left behind by an operation that ended uncleanly
    if crate::commands::update::leftover_state_present(env) {
        return Err(crate::commands::update::leftover_state_error());
    }
    let deps = RealDeps::new();
    // the machine stays awake from here to the end of the run; declared after the lock, so it is released first
    let _awake = deps.keep_awake();
    let o = open(env, dev, stdin_text)?;
    // a crashed run's dump and credential folders go; this run's own are kept
    staging::purge(&env.roots, &lock, Some(&o._staging))?;
    let fence = Arc::new(CloudFence::new(o.cloud.clone(), &op)?);
    check_not_switched(env, &fence)?;
    refuse_if_held_by_other(&fence)?;
    let (facts, findings, waived) = evaluate_for(env, dev, &o, &waivers)?;
    let precheck = report_for(&label(&o.creds.pg), &o.pack, &facts, findings, &waivers, &waived);
    gate_precheck(precheck, || execute(env, dev, o, &facts, &waivers, waived, &op, wait, fence, &lock, &deps))
}

/// A precheck that says no is the answer (exit 40, the cloud only READ): `start`, which holds the first thing that touches the cloud, is
/// never called.
fn gate_precheck(precheck: SwitchReport, start: impl FnOnce() -> R<SwitchReport>) -> R<SwitchReport> {
    if precheck.exit != 0 {
        return Ok(precheck);
    }
    start()
}

fn wall_ms() -> u64 {
    crate::util::now_unix() * 1000
}

/// Tie every psql call of `admin` to the operation's remaining budget: the per-class statement caps of an update
/// (`statement_budget_ms`), read from the deadline cell on each call. `now` is injected so a test can move the clock.
pub(crate) fn budgeted(admin: PsqlAdmin, deadline: Arc<std::sync::atomic::AtomicU64>, now: fn() -> u64) -> PsqlAdmin {
    admin.with_budget(move |class| statement_budget_ms(class, deadline.load(Ordering::Relaxed), now()))
}

/// The operation itself: build the work and the journal, run Plan 07's runner, report.
#[allow(clippy::too_many_arguments)]
fn execute(
    env: &Env,
    dev: bool,
    o: Opened,
    facts: &PlanFacts,
    waivers: &Option<Waivers>,
    waived: BTreeSet<String>,
    op: &str,
    wait: u32,
    fence: Arc<CloudFence>,
    lock: &LockGuard,
    deps: &RealDeps,
) -> R<SwitchReport> {
    let inputs = SwitchInputs::from_facts(facts, waivers.as_ref(), o.creds.clone(), op, wait, FREEZE_MINUTES, dev)?;
    let Opened { pack, pack_dir, admin, cloud, creds, _staging: mut stage, .. } = o;
    // 11H (Q1): BEFORE the dump folder, the fence or any write, the console asks for the cloud pepper and one administrator's PIN
    // (hidden, never argv, env or a file) and proves them against the cloud's own rows. A refusal here changed nothing anywhere.
    let rows = crate::switch::rederive::fetch_admin_rows(&cloud, &inputs.keep_ids)?;
    let mut console = crate::switch::prompt::console();
    let proof = Arc::new(crate::switch::rederive::admin_proof(&mut *console, &mut |pepper, pin| {
        crate::switch::rederive::check_pin(&admin, &rows, pepper, pin)
    })?);
    drop(rows);
    stage.ensure_dump(&env.roots, lock)?;
    let extra = inputs.journal_extra(&stage);
    // every statement of the machine (truncate, token repair, re-derive, sign-in check, the clone-side verification) is capped to what is
    // left of the deadline, read from the cell `execute` stores below
    let admin = budgeted(admin, deps.deadline_cell(), wall_ms);
    let machine = Box::new(RealMachine::new(env.clone(), pack_dir, cloud, admin).with_proof(proof.clone()));
    let mut work = SwitchWork::new(env.clone(), inputs, fence, stage, machine).with_proof(proof);
    let t0 = deps.now_ms();
    let deadline = t0 + (u64::from(wait) * 60 + WORK_BUDGET_SECS) * 1000;
    let mut journal = Journal::new(OpKind::Switch, op, t0, deadline, Some(pack.clone()), Some(pack.clone()));
    journal.extra = extra;
    let ctx = OpCtx {
        op_id: op.to_string(),
        names: journal.db.clone(),
        pack_from: journal.pack_from.clone(),
        pack_to: journal.pack_to.clone(),
        deadline_ms: deadline,
    };
    deps.deadline_cell().store(deadline, Ordering::Relaxed);
    let mut world = deps.world(env, &pack, &pack)?;
    let out = run_operation(world.as_mut(), &mut work, &ctx, journal);
    let warnings = [work.warnings(), world.warnings()].concat();
    Ok(match out {
        Ok(done) => {
            deps.housekeeping(env, &pack, false, &crate::update::prune::journal_names(Some(&ctx.names)));
            let mut data = serde_json::json!({
                "switched": true, "opId": op, "source": label(&creds.pg), "previousDatabase": done.prev_db,
                "waived": waived, "warnings": warnings,
                "rederive": work.rederive_report.as_ref().map(|r| serde_json::json!({
                    "rows": r.rows, "skipped": r.skipped, "scrambled": r.scrambled, "withoutValidPin": r.without_valid_pin,
                })),
                "nextSteps": [
                    "Pair every till with this server.",
                    "Staff keep the PINs they had in the cloud. Reset the PIN of every staff member counted under rederive.skipped or rederive.withoutValidPin (they had no usable sign-in).",
                    "Keep the cloud project until the retention period in the runbook has passed: it is the archive.",
                ],
            });
            if let (Some(o), serde_json::Value::Object(t)) = (data.as_object_mut(), timing_fields(&done.timings.items, work.phase_ms())) {
                o.extend(t);
            }
            SwitchReport::ok("the store now runs on its own server", data)
        }
        Err(e) => failure_report(&e, &warnings, op, progress_says_unknown(env, op)),
    })
}

/// The three timing fields of the success report, built from the runner's laps and the work's own phases: `timingsMs`, `phaseMs`,
/// `elapsedSeconds`. The report takes exactly this object.
pub(crate) fn timing_fields(items: &[(String, u64)], phase_ms: &BTreeMap<String, u64>) -> serde_json::Value {
    serde_json::json!({
        "timingsMs": timings_object(items),
        "phaseMs": phase_ms,
        "elapsedSeconds": elapsed_seconds(items, phase_ms),
    })
}

/// `{phase: ms}` from the runner's laps (fence, backup, repair_collation, clone, work, verify_clone, swap, activate, verify_live, reopen).
pub(crate) fn timings_object(items: &[(String, u64)]) -> serde_json::Value {
    items.iter().map(|(k, ms)| (k.clone(), serde_json::json!(ms))).collect::<serde_json::Map<_, _>>().into()
}

/// Whole seconds per phase from both sources, the runner's laps and the work's own (`drain`, `copy` = dump + load, `rederive`): what the
/// runbook records and the owner's plan sizes a store from.
pub(crate) fn elapsed_seconds(items: &[(String, u64)], phase_ms: &BTreeMap<String, u64>) -> serde_json::Value {
    let secs = |ms: u64| serde_json::json!((ms + 500) / 1000);
    let mut m: serde_json::Map<String, serde_json::Value> = items.iter().map(|(k, ms)| (k.clone(), secs(*ms))).collect();
    for (k, ms) in phase_ms {
        m.insert(k.clone(), secs(*ms));
    }
    m.into()
}

/// The progress record of THIS operation reads `unknown` (display only; the warnings are the primary signal).
fn progress_says_unknown(env: &Env, op: &str) -> bool {
    progress::read(&env.update_dir()).is_some_and(|p| p.op_id.as_deref() == Some(op) && p.cloud == "unknown")
}

/// What a run that failed after it started reports. Exit 17 keys on the WARNINGS (`CLOUD_MAY_BE_MOVED`, `CLOUD_STILL_MOVED`,
/// `CLOUD_STATE_UNKNOWN`) or the progress record, not on the reason: a rollback begun at the live check keeps the stored reason and a
/// failure while re-activating carries its own. Otherwise 41 (the system is as before), or 17 when the runner itself asks for recovery.
pub(crate) fn failure_report(e: &OpError, warnings: &[String], op: &str, progress_unknown: bool) -> SwitchReport {
    let Some(w) = loud_cloud_warning(warnings).or(progress_unknown.then_some("CLOUD_STATE_UNKNOWN")) else {
        return SwitchReport::after_start(e);
    };
    let fix = format!("posctl switch rollback {op}");
    let what = if e.code == OpCode::RecoveryNeeded {
        "the switch needs `posctl update --recover`, and the cloud store may be marked moved: afterwards run"
    } else {
        "the switch was rolled back on this server, but the cloud store may be marked moved: run"
    };
    SwitchReport::recovery_needed(
        w,
        &format!("{what} `{fix}` with the cloud credentials to give it back"),
        serde_json::json!({ "reason": w, "rolledBackBecause": e.reason, "opId": op, "fix": fix, "warnings": warnings }),
    )
}

// ---- rollback --------------------------------------------------------------------------------------------------------

pub fn rollback(args: &RollbackArgs, env: &Env, dev: bool, stdin_text: &str) -> SwitchReport {
    rollback_with(args, env, dev, stdin_text, &local_secrets, &|| {})
}

pub(crate) fn rollback_with(
    args: &RollbackArgs,
    env: &Env,
    dev: bool,
    stdin_text: &str,
    secrets: SecretsFn,
    before_lock: &dyn Fn(),
) -> SwitchReport {
    if !args.source_db_stdin {
        return SwitchReport::usage("--source-db-stdin is required: the cloud credentials are never accepted on the command line");
    }
    scrub_all(env, stdin_text, secrets, || rollback_inner(args, env, dev, stdin_text, before_lock))
}

/// An open journal decides what `rollback` may do: another operation's, or a switch at the `Reopen` step or later (this server is
/// being switched FORWARD; freeing the cloud now would run two stores), refuses. A switch journal before that point leaves the local
/// side to `update --recover`, which never touches the cloud.
pub(crate) fn rollback_gate(j: Option<&Journal>) -> R<()> {
    let Some(j) = j else { return Ok(()) };
    if j.kind != OpKind::Switch {
        return Err(pre("OTHER_OPERATION", "a different operation is waiting for recovery; run `posctl update --recover` first"));
    }
    if !may_release_cloud(j) {
        // a journal already at `Rollback` began it after the point of no return, and recovery does NOT undo that (`recover::decide` answers
        // UNRESOLVABLE: the commit is final); only the journal at `Reopen` or later is finished
        let m = if j.step == Step::Rollback {
            "this server's switch began a rollback after its point of no return, and recovery will not undo it (UNRESOLVABLE): the cloud store stays moved and this server is not given back. Contact support".to_string()
        } else {
            "this server's switch is past its point of no return: run `posctl update --recover` to finish it. The cloud store stays moved".to_string()
        };
        return Err(pre("PAST_POINT_OF_NO_RETURN", &m));
    }
    Ok(())
}

/// With a switch journal open (before Reopen), a cloud row that reads `moved` is NOT released: the local side is still to be undone or
/// finished by `update --recover`, and freeing a moved cloud under it is the split-brain. Only a rolled-back journal (`Step::Rollback`,
/// the local side already undone) allows it. A held or frozen row may be released (nothing was moved). `row` is `state|op|effective`.
pub(crate) fn rollback_cloud_gate(j: Option<&Journal>, row: &str) -> R<()> {
    let Some(j) = j else { return Ok(()) };
    if row.split('|').next() == Some("moved") && j.step != Step::Rollback {
        return Err(pre("OPEN_JOURNAL_CLOUD_MOVED", "the cloud store is marked moved and this server's switch is still open: run `posctl update --recover` first, then run `posctl switch rollback` again"));
    }
    Ok(())
}

/// posctl.json is the commit record (`on_commit` flips the mode): a server that is not in mode `cloud` already runs the store's data,
/// so giving the cloud back would run two stores.
fn rollback_mode_gate(env: &Env) -> R<()> {
    check_mode(env).map_err(|_| pre("ALREADY_COMMITTED", "this server already runs the store's own data (or is not prepared for a switch); the cloud store stays moved. There is no way back in this version"))
}

/// The operation to give back: the one named on the command line, else the open journal's, else the progress record's. All of them are
/// read UNDER the lock, after the mode gate. `None` means only a draining or frozen cloud is released, never a recorded move.
pub(crate) fn rollback_op(arg: Option<&str>, journal: Option<&Journal>, progress: Option<&Progress>) -> Option<String> {
    arg.map(str::to_string)
        .or_else(|| journal.map(|j| j.op_id.clone()))
        .or_else(|| progress.and_then(|p| p.op_id.clone()))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Rows freed, or the cloud row reads `active`.
    Released,
    StillMoved,
    HeldByAnother,
    Unreadable,
}

/// `freed`: the release statement changed a row. `row`: the state line read AFTER it (`state|op|effective`).
pub(crate) fn rollback_verdict(freed: bool, row: &str) -> Verdict {
    if freed {
        return Verdict::Released;
    }
    match row.split('|').next().unwrap_or("") {
        "active" => Verdict::Released,
        "moved" => Verdict::StillMoved,
        "draining" | "frozen" => Verdict::HeldByAnother,
        _ => Verdict::Unreadable,
    }
}

/// Only a VERIFIED release clears the progress record, and it is written directly: the display path (`SwitchWork::show`) refuses to
/// downgrade a same-operation `unknown`/`moved` record, which is exactly what is wanted here. A record of another operation is left alone.
pub(crate) fn settle_progress(update_dir: &std::path::Path, op: Option<&str>, v: &Verdict, now_ms: u64) {
    if *v != Verdict::Released {
        return;
    }
    let Some(p) = progress::read(update_dir) else { return };
    if p.op_id.is_some() && p.op_id.as_deref() != op {
        return;
    }
    let _ = progress::write(
        update_dir,
        &Progress { phase: "rolled back".into(), cloud: "released".into(), updated_ms: now_ms, op_id: p.op_id.clone().or_else(|| op.map(str::to_string)) },
    );
}

/// Every gate is decided under the exclusive lock, after `before_lock`: the mode, the open journal, the progress record the operation
/// id comes from, and the cloud row. A run or recovery that was rolling forward while this waited for the lock has committed by then.
fn rollback_inner(args: &RollbackArgs, env: &Env, dev: bool, stdin_text: &str, before_lock: &dyn Fn()) -> R<SwitchReport> {
    if let Some(op) = &args.op_id {
        if !valid_op_id(op) {
            return Err(OpError::new(OpCode::Usage, "OP_ID_INVALID", "the operation id has an unsafe shape"));
        }
    }
    before_lock();
    let lock = acquire_for(
        &env.roots,
        LockMode::Exclusive,
        "switch-rollback",
        args.op_id.as_deref().unwrap_or("rollback"),
        lock_wait(),
    )?;
    rollback_mode_gate(env)?;
    let journal = Journal::read(&env.update_dir()).map_err(|e| {
        OpError::new(OpCode::RecoveryNeeded, "JOURNAL_UNREADABLE", format!("the operation journal cannot be read ({e:?}); run `posctl update --recover`"))
    })?;
    rollback_gate(journal.as_ref())?;
    let recorded = progress::read(&env.update_dir());
    let op = rollback_op(args.op_id.as_deref(), journal.as_ref(), recorded.as_ref());
    // only the cloud is needed: a local database that is down must not keep the cloud frozen
    let o = open_with(env, dev, stdin_text, false)?;
    let _ = staging::purge(&env.roots, &lock, Some(&o._staging));
    let fence = CloudFence::new(o.cloud.clone(), op.as_deref().unwrap_or("rollback"))?;
    // with a journal open the row decides whether to go on
    if journal.is_some() {
        let row = fence.state().map_err(|_| pre("CLOUD_STATE_UNKNOWN", "the cloud store state cannot be read, and this server's switch is still open: nothing was released"))?;
        rollback_cloud_gate(journal.as_ref(), &row)?;
    }
    let freed = match op.as_deref() {
        // a refusal means this operation holds nothing (any more): the row below says whether that is `active`
        Some(_) => match fence.release() {
            Ok(()) => true,
            Err(e) if e.reason == "CLOUD_FENCE_LOST" => false,
            Err(e) => return Err(e),
        },
        None => fence.release_unfinished()?,
    };
    let row = fence.state().unwrap_or_default();
    let verdict = rollback_verdict(freed, &row);
    settle_progress(&env.update_dir(), op.as_deref(), &verdict, crate::util::now_unix() * 1000);
    let data = serde_json::json!({ "opId": op, "cloudReleased": freed, "cloudState": row, "journalOpen": journal.is_some() });
    Ok(match verdict {
        Verdict::Released => SwitchReport::ok(
            if journal.is_some() {
                "the cloud store is active again; this server's own interrupted switch still needs `posctl update --recover`"
            } else {
                "the cloud store is active again and this server is as it was before the switch"
            },
            data,
        ),
        Verdict::StillMoved => SwitchReport::refused(
            "CLOUD_STILL_MOVED",
            if op.is_some() {
                "the cloud says the store moved, but not by this operation: contact support before doing anything else"
            } else {
                "the cloud says the store moved but no record of an operation was found here: contact support before doing anything else"
            },
            data,
        ),
        Verdict::HeldByAnother => SwitchReport::refused("CLOUD_HELD_BY_ANOTHER_OPERATION", "the cloud store is held by another operation, not this one; nothing was released", data),
        Verdict::Unreadable => SwitchReport::refused("CLOUD_STATE_UNKNOWN", "the cloud store state could not be read after the release; run the command again", data),
    })
}

/// The CLI entry (works on a `--dev` root; the real services are never touched). Not elevated -> exit 3, not provisioned -> exit 4.
pub fn run_cli(
    roots: &Roots,
    dev: bool,
    cmd: &SwitchCmd,
    stdin: &mut dyn Read,
) -> Result<Outcome, PosctlError> {
    run_cli_as(roots, dev, cmd, stdin, crate::sys::is_elevated())
}

fn run_cli_as(
    roots: &Roots,
    dev: bool,
    cmd: &SwitchCmd,
    stdin: &mut dyn Read,
    elevated: bool,
) -> Result<Outcome, PosctlError> {
    if !roots.dev && !elevated {
        return Err(PosctlError::new(
            Code::NotElevated,
            "this command must run as an administrator",
        ));
    }
    if !roots.provisioned_json().exists() {
        return Err(PosctlError::new(
            Code::NotProvisioned,
            "this PC is not provisioned",
        ));
    }
    // the usage errors that need no machine come first, and stdin is only read when asked for
    let read = |wanted: bool, stdin: &mut dyn Read| -> Result<String, SwitchReport> {
        if !wanted {
            return Ok(String::new());
        }
        read_stdin_limited(stdin).map_err(|e| SwitchReport::before_start(&e))
    };
    match cmd {
        SwitchCmd::Plan(a) => {
            let text = match read(a.source_db_stdin, stdin) {
                Ok(t) => t,
                Err(r) => return r.into_result(),
            };
            let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
            plan(a, &env, dev, &text).into_result()
        }
        SwitchCmd::Run(a) => {
            // like `update`: a run stops services and swaps databases, so a `--dev` root is never allowed to reach the real ones
            if dev {
                return Err(PosctlError::new(Code::Usage, "switch run registers services and swaps databases and cannot run with --dev"));
            }
            let text = match read(a.source_db_stdin, stdin) {
                Ok(t) => t,
                Err(r) => return r.into_result(),
            };
            let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
            run(a, &env, dev, &text).into_result()
        }
        SwitchCmd::Rollback(a) => {
            let text = match read(a.source_db_stdin, stdin) {
                Ok(t) => t,
                Err(r) => return r.into_result(),
            };
            let env = Env::production(roots, std::rc::Rc::new(crate::runtime::WindowsServices))?;
            rollback(a, &env, dev, &text).into_result()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::{OpCode, OpError};

    #[test]
    fn exit_codes_follow_conventions_11_2() {
        assert_eq!(
            (
                SwitchReport::refused("X", "m", serde_json::json!({})).exit,
                SwitchReport::refused("X", "m", serde_json::json!({})).name
            ),
            (40, "SWITCH_REFUSED")
        );
        let f = SwitchReport::failed_rolled_back("X", "m", serde_json::json!({}));
        assert_eq!((f.exit, f.name), (41, "SWITCH_FAILED_ROLLED_BACK"));
        assert_eq!(SwitchReport::ok("m", serde_json::json!({})).exit, 0);
        assert_eq!(SwitchReport::usage("m").exit, 2);
    }

    #[test]
    fn errors_before_the_run_started_refuse_and_errors_after_it_started_mean_rolled_back_unless_recovery_is_needed(
    ) {
        let pre = OpError::new(OpCode::Precondition, "DISK_LOW", "x");
        assert_eq!(SwitchReport::before_start(&pre).exit, 40);
        assert_eq!(
            SwitchReport::before_start(&OpError::new(OpCode::LockHeld, "LOCK_HELD", "x")).exit,
            10
        );
        assert_eq!(
            SwitchReport::before_start(&OpError::new(OpCode::Usage, "U", "x")).exit,
            2
        );
        let rb = OpError::new(OpCode::RolledBack, "SWITCH_WORK", "x");
        assert_eq!(SwitchReport::after_start(&rb).exit, 41);
        assert_eq!(
            SwitchReport::after_start(&OpError::new(OpCode::VerifyFailedRolledBack, "V", "x")).exit,
            41
        );
        assert_eq!(
            SwitchReport::after_start(&OpError::new(
                OpCode::RecoveryNeeded,
                "ROLLBACK_FAILED",
                "x"
            ))
            .exit,
            17
        );
        assert_ne!(
            SwitchReport::after_start(&rb).exit,
            0,
            "ERROR and ROLLED_BACK never exit 0"
        );
    }

    #[test]
    fn the_envelope_has_the_conventions_shape_and_never_a_secret() {
        let r = SwitchReport::refused(
            "NO_VALID_ADMIN",
            "no admin",
            serde_json::json!({ "canSwitch": false }),
        );
        let e = r.envelope("switch plan", 1, 2, "9.9.9");
        assert_eq!(
            (
                e["ok"].clone(),
                e["code"].clone(),
                e["exit"].clone(),
                e["command"].clone()
            ),
            (
                false.into(),
                "SWITCH_REFUSED".into(),
                40.into(),
                "switch plan".into()
            )
        );
        assert_eq!(e["data"]["reason"], "NO_VALID_ADMIN");
        assert_eq!(
            (
                e["startedAt"].clone(),
                e["finishedAt"].clone(),
                e["posctlVersion"].clone()
            ),
            (1.into(), 2.into(), "9.9.9".into())
        );
    }

    #[test]
    fn stdin_is_read_up_to_a_limit() {
        let mut ok = std::io::Cursor::new(b"{\"v\":1}".to_vec());
        assert_eq!(read_stdin_limited(&mut ok).unwrap(), "{\"v\":1}");
        let mut big = std::io::Cursor::new(vec![b'x'; 70_000]);
        assert_eq!(
            read_stdin_limited(&mut big).unwrap_err().reason,
            "STDIN_TOO_LARGE"
        );
        let mut bad = std::io::Cursor::new(vec![0xff, 0xfe, 0xfd]);
        assert_eq!(
            read_stdin_limited(&mut bad).unwrap_err().reason,
            "STDIN_UNREADABLE"
        );
    }

    #[test]
    fn a_report_keeps_its_exit_code_and_data_when_it_becomes_a_cli_result() {
        let ok = SwitchReport::ok("fine", serde_json::json!({ "canSwitch": true }))
            .into_result()
            .unwrap();
        assert_eq!((ok.code, ok.message.as_str()), (Code::Ok, "fine"));
        for (r, code) in [
            (
                SwitchReport::refused("PLAN_BLOCKED", "m", serde_json::json!({ "findings": [] })),
                Code::SwitchRefused,
            ),
            (
                SwitchReport::failed_rolled_back("X", "m", serde_json::json!({})),
                Code::SwitchFailedRolledBack,
            ),
            (
                SwitchReport::before_start(&OpError::new(OpCode::LockHeld, "LOCK_HELD", "m")),
                Code::LockHeld,
            ),
            (
                SwitchReport::after_start(&OpError::new(
                    OpCode::RecoveryNeeded,
                    "ROLLBACK_FAILED",
                    "m",
                )),
                Code::RecoveryNeeded,
            ),
            (SwitchReport::usage("m"), Code::Usage),
        ] {
            let e = r.into_result().unwrap_err();
            assert_eq!(e.code, code);
            assert!(e.data["reason"].is_string(), "{:?}", e.data);
        }
        let e = SwitchReport::refused("PLAN_BLOCKED", "m", serde_json::json!({ "findings": [1] }))
            .into_result()
            .unwrap_err();
        assert_eq!(
            e.data["findings"][0], 1,
            "the findings travel with the refusal"
        );
    }

    // ---- binding 8: a local source exists only in a test-hooks build -------------------------------------------

    #[test]
    fn only_a_test_hooks_build_allows_a_local_source() {
        // without test-hooks (release OR plain debug) nothing asks it into existence
        for (dev, hook) in [(false, false), (true, false), (false, true), (true, true)] {
            assert!(
                !local_source_rule(dev, hook, false),
                "dev={dev} hook={hook}"
            );
        }
        // a test-hooks build still needs --dev or the hook
        assert!(!local_source_rule(false, false, true));
        assert!(local_source_rule(true, false, true) && local_source_rule(false, true, true));
    }

    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn the_hook_is_a_constant_false_without_the_test_hooks_feature() {
        assert!(!hooks::allow_local_source() && !hooks::skip_staging_acl());
    }

    #[test]
    fn the_cloud_target_stays_a_cloud_target_whatever_dev_says_unless_a_hooks_build_asks() {
        // no production path calls CloudDb::allow_local: it is behind the test-hooks feature in `open`, and the constructor never sets it
        let call = concat!(".allow", "_local(");
        let src = include_str!("switch.rs");
        let open_fn = &src[src.find("pub(crate) fn open(").unwrap()
            ..src.find("fn photo_import_available").unwrap()];
        let at = open_fn.find(call).expect("open() is the only caller");
        assert!(
            open_fn[..at]
                .rfind("#[cfg(feature = \"test-hooks\")]")
                .is_some(),
            "allow_local must sit under the test-hooks feature"
        );
        let before_tests = &src[..src
            .find(
                "#[cfg(test)]
mod tests",
            )
            .unwrap()];
        assert_eq!(
            before_tests.matches(call).count(),
            1,
            "no other production code sets allow_local"
        );
        let cloud = include_str!("../switch/cloud.rs");
        let decl = &cloud[..cloud
            .find(&format!("pub(crate) fn {}", "allow_local"))
            .unwrap()];
        assert!(
            decl.trim_end().ends_with(
                "#[cfg(any(all(test, feature = \"fence-db-tests\"), feature = \"test-hooks\"))]"
            ),
            "the setter is test-only"
        );
    }

    // ---- the plan command's own usage rules -----------------------------------------------------------------------------

    fn store() -> (tempfile::TempDir, Env) {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("data"), d.path().join("prog"));
        let roots = Roots::custom(data.clone(), prog.clone());
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        let env = Env {
            data,
            program: prog,
            posctl_exe: d.path().join("posctl.exe"),
            ports: crate::ports::Ports::new(47300).unwrap(),
            roots,
            activate: std::rc::Rc::new(|_, _, _| Ok(())),
        };
        (d, env)
    }
    fn args(waive: &[&str], reason: Option<&str>) -> PlanArgs {
        PlanArgs {
            source_db_stdin: true,
            waive_terminal: waive.iter().map(|s| s.to_string()).collect(),
            waive_reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn credentials_never_come_from_the_command_line_and_waiver_mistakes_are_usage_errors_before_any_connection(
    ) {
        let (_d, env) = store();
        let no_stdin = PlanArgs {
            source_db_stdin: false,
            ..args(&[], None)
        };
        assert_eq!(plan(&no_stdin, &env, false, "").exit, 2);
        // none of these reach the cloud or the machine: stdin is never even parsed (it is garbage)
        for (a, reason) in [
            (args(&["POS-1"], None), "WAIVE_REASON_REQUIRED"),
            (args(&["POS-1"], Some("  \n ")), "WAIVE_REASON_REQUIRED"),
            (args(&[], Some("why")), "WAIVE_REASON_WITHOUT_TERMINAL"),
            (args(&["POS\n1"], Some("why")), "WAIVE_TERMINAL_INVALID"),
        ] {
            let r = plan(&a, &env, false, "not json at all");
            assert_eq!((r.exit, r.reason.as_deref()), (2, Some(reason)), "{a:?}");
        }
        // with valid flags the next failure is the credentials, not the waivers
        let r = plan(
            &args(&["POS-1"], Some("off for repair")),
            &env,
            false,
            "not json at all",
        );
        assert_ne!(r.reason.as_deref(), Some("WAIVE_REASON_REQUIRED"));
    }

    #[test]
    fn the_cloud_pgpass_folder_is_removed_when_it_drops() {
        let (_d, env) = store();
        let path = {
            let dir = StagingDir::create(&env.roots).unwrap();
            assert!(dir.pgpass_dir().is_dir() && dir.pgpass_dir().starts_with(env.update_dir()));
            std::fs::write(dir.pgpass_dir().join("pgpass"), "x").unwrap();
            dir.pgpass_dir().to_path_buf()
        };
        assert!(!path.exists());
    }

    #[test]
    fn the_cli_words_are_switch_plan_with_repeatable_waivers() {
        use clap::Parser;
        #[derive(Parser, Debug)]
        struct T {
            #[command(subcommand)]
            c: SwitchTop,
        }
        let t = T::try_parse_from([
            "t",
            "switch",
            "plan",
            "--source-db-stdin",
            "--waive-terminal",
            "POS-1",
            "--waive-terminal",
            "POS-2",
            "--waive-reason",
            "off",
        ])
        .unwrap();
        let SwitchTop::Switch(SwitchCmd::Plan(a)) = t.c else {
            panic!("switch plan parses as Plan");
        };
        assert_eq!(
            (
                a.source_db_stdin,
                a.waive_terminal,
                a.waive_reason.as_deref()
            ),
            (
                true,
                vec!["POS-1".to_string(), "POS-2".to_string()],
                Some("off")
            )
        );
        assert!(
            T::try_parse_from(["t", "switch", "plan", "--source-db", "postgres://x"]).is_err(),
            "no credentials on the command line"
        );
    }
    #[test]
    fn through_the_real_cli_an_unprovisioned_pc_is_exit_4_a_bad_word_is_exit_2_and_the_envelope_is_one_json_object(
    ) {
        use crate::cli::run_cli_with;
        use std::ffi::OsString;
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (
            d.path().join("data").display().to_string(),
            d.path().join("prog").display().to_string(),
        );
        let run = |rest: &[&str]| {
            let mut a: Vec<OsString> = [
                "posctl",
                "--dev",
                "--data-root",
                &data,
                "--program-root",
                &prog,
            ]
            .iter()
            .map(OsString::from)
            .collect();
            a.extend(rest.iter().map(OsString::from));
            let mut out = Vec::new();
            let code = run_cli_with(a, &mut std::io::empty(), &mut out, false);
            (code, String::from_utf8(out).unwrap())
        };
        let (code, out) = run(&["switch", "plan", "--source-db-stdin"]);
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(
            (code, v["code"].as_str(), v["ok"].as_bool()),
            (4, Some("NOT_PROVISIONED"), Some(false)),
            "{out}"
        );
        for bad in [
            &["switch", "frobnicate"][..],
            &[
                "switch",
                "plan",
                "--source-db",
                concat!("postgres:", "//u:p@h/db"),
            ][..],
        ] {
            assert_eq!(run(bad).0, 2, "{bad:?}");
        }
    }

    // ---- Plan 09 T11: `switch run` and `switch rollback` -------------------------------------------------------------------

    use crate::ops::journal::Step;
    use crate::switch::facts::tests::clean;

    #[derive(clap::Parser, Debug)]
    struct W {
        #[command(subcommand)]
        c: SwitchCmd,
    }
    fn parse(args: &[&str]) -> Result<W, clap::Error> {
        <W as clap::Parser>::try_parse_from(std::iter::once("t").chain(args.iter().copied()))
    }
    fn store_in_mode(mode: &str) -> (tempfile::TempDir, Env) {
        let (d, env) = store();
        std::fs::create_dir_all(env.roots.conf()).unwrap();
        crate::config::PosctlJson::new(mode, "id", 47300, "shop", "1.0.0-r1")
            .save(&env.roots)
            .unwrap();
        (d, env)
    }
    fn run_args() -> RunArgs {
        RunArgs {
            source_db_stdin: true,
            waive_terminal: vec![],
            waive_reason: None,
            wait_minutes: None,
        }
    }
    fn rollback_args(op: Option<&str>) -> RollbackArgs {
        RollbackArgs {
            op_id: op.map(str::to_string),
            source_db_stdin: true,
        }
    }
    fn ws(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }
    fn unknown(op: &str) -> Progress {
        Progress {
            phase: "rolled back, the cloud may be moved".into(),
            cloud: "unknown".into(),
            updated_ms: 1,
            op_id: Some(op.into()),
        }
    }
    fn switch_journal(step: Step, from: Option<Step>) -> Journal {
        let mut j = Journal::new(OpKind::Switch, "op", 1, 2, Some("p".into()), Some("p".into()));
        j.step = step;
        j.rollback_from = from;
        j
    }

    #[test]
    fn run_and_rollback_take_the_documented_flags_and_waives_repeat() {
        let w = parse(&[
            "run", "--source-db-stdin", "--waive-terminal", "POS-2", "--waive-terminal", "POS-3",
            "--waive-reason", "off for repair", "--wait-minutes", "5",
        ])
        .unwrap();
        match w.c {
            SwitchCmd::Run(a) => {
                assert!(a.source_db_stdin);
                assert_eq!(a.waive_terminal, vec!["POS-2".to_string(), "POS-3".to_string()]);
                assert_eq!((a.waive_reason.as_deref(), a.wait_minutes), (Some("off for repair"), Some(5)));
            }
            other => panic!("{other:?}"),
        }
        match parse(&["rollback", "op-1", "--source-db-stdin"]).unwrap().c {
            SwitchCmd::Rollback(a) => assert_eq!((a.op_id.as_deref(), a.source_db_stdin), (Some("op-1"), true)),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse(&["rollback", "--source-db-stdin"]).unwrap().c, SwitchCmd::Rollback(a) if a.op_id.is_none()));
    }

    #[test]
    fn there_is_no_way_to_pass_credentials_on_the_command_line() {
        for bad in [
            vec!["run", "--source-db", "postgres://u@h/d"],
            vec!["run", "--source-db-stdin=postgres://u@h/d"],
            vec!["run", "--password", "x"],
            vec!["rollback", "--service-key", "x"],
            vec!["rollback", "--source-db", "postgres://u@h/d"],
        ] {
            assert!(parse(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn help_text_lists_every_documented_flag() {
        use clap::CommandFactory;
        let cmd = W::command();
        let run = cmd.find_subcommand("run").expect("switch run exists").clone();
        let mut longs: Vec<String> = run
            .get_arguments()
            .filter_map(|a| a.get_long())
            .filter(|l| *l != "help")
            .map(str::to_string)
            .collect();
        longs.sort();
        let mut want: Vec<String> = DOCUMENTED_RUN_FLAGS.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(longs, want, "the runbook flag list and the command agree, no undocumented flag");
        let help = run.clone().render_long_help().to_string();
        for f in DOCUMENTED_RUN_FLAGS {
            assert!(help.contains(&format!("--{f}")), "--{f} missing from the help: {help}");
        }
    }

    #[test]
    fn run_without_waive_reason_exits_2_and_a_bad_wait_is_a_usage_error_before_any_connection() {
        let (_d, env) = store_in_mode("cloud");
        let mut a = run_args();
        a.waive_terminal = vec!["POS-1".into()];
        let r = run_t(&a, &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (2, Some("WAIVE_REASON_REQUIRED")));
        a.waive_reason = Some("off for repair".into());
        for m in [0, 121] {
            a.wait_minutes = Some(m);
            let r = run_t(&a, &env, false, "not json at all");
            assert_eq!((r.exit, r.reason.as_deref()), (2, Some("WAIT_MINUTES_INVALID")), "{m}");
        }
        let no_stdin = RunArgs { source_db_stdin: false, ..run_args() };
        assert_eq!(run_t(&no_stdin, &env, false, "").exit, 2);
        assert_eq!(rb_t(&RollbackArgs { source_db_stdin: false, ..rollback_args(None) }, &env, false, "").exit, 2);
        let r = rb_t(&rollback_args(Some("a'b")), &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (2, Some("OP_ID_INVALID")));
    }

    #[test]
    fn run_and_rollback_exit_3_when_not_elevated_before_they_are_exit_4_when_not_provisioned() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false; // no provisioned.json: what a standard user sees
        for cmd in [SwitchCmd::Run(run_args()), SwitchCmd::Rollback(rollback_args(None))] {
            let e = run_cli_as(&roots, false, &cmd, &mut std::io::empty(), false).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::NotElevated, 3), "{cmd:?}");
            let e = run_cli_as(&roots, false, &cmd, &mut std::io::empty(), true).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::NotProvisioned, 4), "{cmd:?}");
        }
        // provisioned and elevated, but `--dev`: a run never reaches the real services of a developer PC
        std::fs::create_dir_all(roots.provisioned_json().parent().unwrap()).unwrap();
        std::fs::write(roots.provisioned_json(), b"{}").unwrap();
        let e = run_cli_as(&roots, true, &SwitchCmd::Run(run_args()), &mut std::io::empty(), true).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::Usage, 2));
    }

    #[test]
    fn already_switched_refuses_run() {
        // offline-only, any other mode and a missing config all refuse BEFORE stdin is parsed and before any connection:
        // garbage stdin would otherwise be a different reason
        for env in [store_in_mode("offline-only"), store_in_mode("weird"), store()] {
            let r = run_t(&run_args(), &env.1, false, "not json at all");
            assert_eq!((r.exit, r.reason.as_deref()), (40, Some("ALREADY_SWITCHED")));
        }
        // a cloud already marked moved refuses too (the cloud marker is read by `check_not_switched`)
        let e = refuse_if_switched("cloud", Some("moved|op|moved")).unwrap_err();
        assert_eq!(e.reason, "ALREADY_SWITCHED");
        // a server prepared for the switch passes the mode gate: the next failure is the credentials
        let (_d, env) = store_in_mode("cloud");
        let r = run_t(&run_args(), &env, false, "not json at all");
        assert!(r.reason.is_some() && r.reason.as_deref() != Some("ALREADY_SWITCHED"), "{r:?}");
    }

    #[test]
    fn the_run_report_and_the_journal_carry_per_phase_elapsed_fields() {
        // injected numbers, no clock: the runner's laps and the work's own phases
        let laps: Vec<(String, u64)> = [("fence", 400), ("backup", 61_000), ("clone", 90_499), ("work", 300_000), ("verify_clone", 2_500), ("verify_live", 7_000)]
            .iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let phases = BTreeMap::from([("drain".to_string(), 1_500u64), ("copy".to_string(), 240_000), ("rederive".to_string(), 4_000)]);
        let t = timings_object(&laps);
        assert_eq!((t["backup"].as_u64(), t["clone"].as_u64()), (Some(61_000), Some(90_499)));
        let e = elapsed_seconds(&laps, &phases);
        for (k, secs) in [("fence", 0), ("backup", 61), ("clone", 90), ("work", 300), ("verify_clone", 3), ("verify_live", 7), ("drain", 2), ("copy", 240), ("rederive", 4)] {
            assert_eq!(e[k].as_u64(), Some(secs), "{k}: {e}");
        }
        // the success report takes exactly this object (`timing_fields`), and the journal gets the same numbers from the runner
        // (`timingsMs`) and the work (`phaseMs`): see `ops::matrix_tests` and `switch::work::tests` for the journal side
        let f = timing_fields(&laps, &phases);
        assert_eq!(f["timingsMs"], t);
        assert_eq!(f["phaseMs"], serde_json::json!({ "drain": 1_500, "copy": 240_000, "rederive": 4_000 }));
        assert_eq!(f["elapsedSeconds"], e);
        assert_eq!(f.as_object().map(|o| o.len()), Some(3));
    }

    #[test]
    fn every_statement_of_the_machine_is_capped_to_the_time_left_of_the_deadline_cell() {
        use crate::ops::swap::StmtClass::{Default as Dflt, Heavy, Quick};
        use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
        static NOW: AtomicU64 = AtomicU64::new(0);
        let admin = PsqlAdmin::new("psql.exe".into(), 1, "pgpass".into());
        assert!(admin.remaining.is_none(), "unbudgeted by itself: the wiring is `budgeted`");
        let cell = Arc::new(AtomicU64::new(0));
        let admin = budgeted(admin, cell.clone(), || NOW.load(SeqCst));
        let left = |c| (admin.remaining.as_ref().unwrap().0)(c);
        NOW.store(1_000_000, SeqCst);
        cell.store(1_000_000 + 5 * 60_000, SeqCst);
        assert_eq!((left(Heavy), left(Dflt), left(Quick)), (300_000, 300_000, 60_000), "five minutes left: no statement may take longer");
        cell.store(1_000_000 + 3 * 3_600_000, SeqCst);
        assert_eq!((left(Heavy), left(Dflt)), (7_200_000, 600_000), "plenty left: the class caps apply");
        cell.store(1_000_000 - 5_000, SeqCst);
        assert_eq!((left(Heavy), left(Dflt)), (60_000, 60_000), "gone: the one-minute floor, never more");
        // the cell is read on every call, not when the admin is built
        cell.store(1_000_000 + 120_000, SeqCst);
        assert_eq!(left(Dflt), 120_000);
    }

    #[test]
    fn run_refuses_while_the_cloud_reads_moved_by_any_operation() {
        use crate::switch::rederive::check_with;
        for row in ["moved|other-op|moved", "moved||moved"] {
            let e = check_with(|| Ok(Some("cloud".into())), || Ok(row.to_string())).unwrap_err();
            assert_eq!(e.reason, "ALREADY_SWITCHED", "{row}");
        }
        // an active row is for the plan's own findings to judge
        assert!(check_with(|| Ok(Some("cloud".into())), || Ok("active||active".to_string())).is_ok());
    }

    #[test]
    fn run_refuses_while_progress_reads_unknown_and_while_a_journal_is_open() {
        let (_d, env) = store_in_mode("cloud");
        progress::write(&env.update_dir(), &unknown("op-5")).unwrap();
        let r = run_t(&run_args(), &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("CLOUD_STATE_UNKNOWN")));
        assert!(r.message.contains("posctl switch rollback op-5"), "{}", r.message);
        // a held or released record does not refuse; a journal does, as RECOVERY_NEEDED (17)
        let mut held = unknown("op-5");
        held.cloud = "released".into();
        progress::write(&env.update_dir(), &held).unwrap();
        Journal::new(OpKind::Switch, "op-6", 1, 2, Some("p".into()), Some("p".into())).write(&env.update_dir()).unwrap();
        let r = run_t(&run_args(), &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (17, Some("OPERATION_INCOMPLETE")));
    }

    #[test]
    fn plan10_missing_blocks_run_with_exit_40_and_a_store_without_files_is_not_blocked() {
        let none = BTreeSet::new();
        // Plan 10 is a hard prerequisite (D2-a): blocked whether or not storage credentials exist
        for creds in [true, false] {
            let mut f = clean();
            f.storage_objects = 3;
            f.has_storage_creds = creds;
            f.photo_import_available = false;
            let r = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
            assert_eq!((r.exit, r.reason.as_deref()), (40, Some("PLAN_BLOCKED")), "creds={creds}");
            assert!(r.data["findings"].as_array().unwrap().iter().any(|x| x["code"] == "PLAN10_REQUIRED" && x["level"] == "block"), "creds={creds}: {}", r.data);
        }
        let mut f = clean();
        f.photo_import_available = false;
        f.storage_objects = 0;
        assert_eq!(report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none).exit, 0);
        // the probe is the real command's `--help`: a posctl that does not exist, or has no such command, is "absent"
        let (_d, env) = store();
        assert!(!photo_import_available(&env));
    }

    #[test]
    fn till_queued_blocks_run_only_before_begin_draining() {
        let none = BTreeSet::new();
        let mut f = clean();
        // a fresh queue at the pre-check: exit 40 with the cloud only read (no fence call is possible before `report_for` says OK)
        f.tills[0].queue_depth = 2;
        f.tills[0].age_s = 60;
        let r = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("PLAN_BLOCKED")));
        // a queue older than a day is only a warning
        f.tills[0].age_s = 90_000;
        let r = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
        assert_eq!(r.exit, 0);
        assert!(r.data["findings"].as_array().unwrap().iter().any(|x| x["code"] == "TILL_QUEUED_STALE"));
        // a waived till is not judged
        f.tills[0].age_s = 60;
        let id = f.tills[0].terminal_uuid.to_lowercase();
        let waived: BTreeSet<String> = [id].into();
        assert_eq!(report_for("src", "pack", &f, evaluate_waived(&f, &waived), &None, &waived).exit, 0);
        // after `begin_draining` the pre-check is never repeated: a queue that appears later is the drain's business, and ends in DRAIN_TIMEOUT
        // (41, the cloud released; `work::tests::a_till_that_never_drains_times_out_and_the_cloud_is_returned` pins the release)
        let timeout = OpError::err("DRAIN_TIMEOUT", "x");
        assert_eq!(failure_report(&timeout, &[], "op-1", false).exit, 41);
    }

    #[test]
    fn a_loud_cloud_warning_is_exit_17_not_41_whatever_the_reason_and_names_the_command() {
        let rb = OpError::new(OpCode::RolledBack, "SWITCH_WORK", "x");
        for w in ["CLOUD_MAY_BE_MOVED", "CLOUD_STILL_MOVED", "CLOUD_STATE_UNKNOWN"] {
            for reason in ["SWITCH_WORK", "RECOVERED_AFTER_INTERRUPTION", "ACTIVATE_FAILED"] {
                let e = OpError::new(OpCode::RolledBack, reason, "x");
                let r = failure_report(&e, &ws(&["CLOUD_RELEASE_FAILED", w]), "op-1", false);
                assert_eq!((r.exit, r.name, r.reason.as_deref()), (17, "RECOVERY_NEEDED", Some(w)), "{w} {reason}");
                assert!(r.message.contains("posctl switch rollback op-1"), "{}", r.message);
                assert_eq!(r.data["rolledBackBecause"], reason);
            }
        }
        // the progress record alone is enough
        let r = failure_report(&rb, &[], "op-1", true);
        assert_eq!((r.exit, r.reason.as_deref()), (17, Some("CLOUD_STATE_UNKNOWN")));
        // the runner itself asks for recovery: still 17, and the message says recover first
        let need = OpError::new(OpCode::RecoveryNeeded, "ROLLBACK_FAILED", "x");
        let r = failure_report(&need, &ws(&["CLOUD_MAY_BE_MOVED"]), "op-1", false);
        assert!(r.exit == 17 && r.message.contains("update --recover") && r.message.contains("switch rollback op-1"), "{}", r.message);
        // a quiet failure stays 41, and so does a release that failed on a hold that was never moved (the `held` alert covers it)
        assert_eq!(failure_report(&rb, &[], "op-1", false).exit, 41);
        assert_eq!(failure_report(&rb, &ws(&["CLOUD_RELEASE_FAILED"]), "op-1", false).exit, 41);
    }

    #[test]
    fn rollback_with_a_journal_present_never_returns_cloud_only() {
        // Reopen or later: this server is being switched forward, the cloud is not freed
        for step in [Step::Reopen, Step::Finalize] {
            let e = rollback_gate(Some(&switch_journal(step, None))).unwrap_err();
            assert_eq!(e.reason, "PAST_POINT_OF_NO_RETURN", "{step:?}");
            assert!(e.message.contains("to finish it") && e.message.contains("stays moved"), "rolling forward: recovery finishes the switch: {}", e.message);
        }
        let e = rollback_gate(Some(&switch_journal(Step::Rollback, Some(Step::Reopen)))).unwrap_err();
        assert_eq!(e.reason, "PAST_POINT_OF_NO_RETURN");
        assert!(
            !e.message.contains("finish it") && e.message.contains("will not undo it") && e.message.contains("UNRESOLVABLE") && e.message.contains("stays moved"),
            "a rollback that began after the point of no return is not undone by recovery (recover::decide: UNRESOLVABLE): {}",
            e.message
        );
        // before that, a held cloud may be given back (the local side is `update --recover`'s)
        for step in [Step::Started, Step::Work, Step::Swap, Step::VerifyLive] {
            let j = switch_journal(step, None);
            assert!(rollback_gate(Some(&j)).is_ok(), "{step:?}");
            assert!(rollback_cloud_gate(Some(&j), "frozen|op|frozen").is_ok() && rollback_cloud_gate(Some(&j), "draining|op|draining").is_ok(), "{step:?} frozen");
            let e = rollback_cloud_gate(Some(&j), "moved|op|moved").unwrap_err();
            assert_eq!(e.reason, "OPEN_JOURNAL_CLOUD_MOVED", "{step:?}: a moved cloud under an open journal is refused");
            assert!(e.message.contains("posctl update --recover"), "{}", e.message);
        }
        // a rolled-back journal (the local side is already undone) may release a moved cloud; no journal at all too
        let rolled = switch_journal(Step::Rollback, Some(Step::Swap));
        assert!(rollback_gate(Some(&rolled)).is_ok() && rollback_cloud_gate(Some(&rolled), "moved|op|moved").is_ok());
        assert!(rollback_cloud_gate(None, "moved|op|moved").is_ok());
        assert!(rollback_gate(Some(&switch_journal(Step::Rollback, Some(Step::Swap)))).is_ok());
        assert!(rollback_gate(None).is_ok());
        let up = Journal::new(OpKind::Update, "op", 1, 2, Some("a".into()), Some("b".into()));
        assert_eq!(rollback_gate(Some(&up)).unwrap_err().reason, "OTHER_OPERATION");
        // end to end: the refusal comes before stdin is parsed, so the cloud is never opened
        let (_d, env) = store_in_mode("cloud");
        switch_journal(Step::Reopen, None).write(&env.update_dir()).unwrap();
        let r = rb_t(&rollback_args(Some("op")), &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("PAST_POINT_OF_NO_RETURN")));
        // a committed server (posctl.json says it runs its own data) never gives the cloud back, journal or not
        let (_d, env) = store_in_mode("offline-only");
        let r = rb_t(&rollback_args(Some("op")), &env, false, "not json at all");
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("ALREADY_COMMITTED")));
    }

    #[test]
    fn rollback_op_prefers_the_argument_then_the_journal_then_the_progress_record_and_none_means_unfinished_only() {
        let j = switch_journal(Step::Swap, None);
        let p = unknown("from-progress");
        assert_eq!(rollback_op(None, None, None), None, "no operation id anywhere: only the unfinished release runs");
        assert_eq!(rollback_op(None, None, Some(&p)).as_deref(), Some("from-progress"));
        assert_eq!(rollback_op(None, Some(&j), Some(&p)).as_deref(), Some("op"));
        assert_eq!(rollback_op(Some("typed"), Some(&j), Some(&p)).as_deref(), Some("typed"));
        // the unfinished release never touches a recorded move, and a row that still says moved is never called released
        let sql = crate::switch::cloud::sql_release_unfinished();
        assert!(sql.contains("state IN ('draining','frozen')") && !sql.contains("moved"), "{sql}");
        assert_eq!(rollback_verdict(false, "moved||moved"), Verdict::StillMoved);
    }

    #[test]
    fn the_verdict_follows_the_row_read_after_the_release() {
        assert_eq!(rollback_verdict(true, ""), Verdict::Released, "rows freed");
        assert_eq!(rollback_verdict(false, "active||active"), Verdict::Released, "nothing to free, already active");
        assert_eq!(rollback_verdict(false, "moved|op|moved"), Verdict::StillMoved);
        assert_eq!(rollback_verdict(false, "frozen|other|frozen"), Verdict::HeldByAnother);
        assert_eq!(rollback_verdict(false, "draining|other|draining"), Verdict::HeldByAnother);
        assert_eq!(rollback_verdict(false, ""), Verdict::Unreadable);
    }

    #[test]
    fn rollback_clears_an_unknown_record_only_when_the_cloud_reads_active() {
        let d = tempfile::tempdir().unwrap();
        let read = || progress::read(d.path()).unwrap();
        // cloud reads active: cleared, written directly, the operation id kept
        progress::write(d.path(), &unknown("op-5")).unwrap();
        settle_progress(d.path(), Some("op-5"), &rollback_verdict(false, "active||active"), 9);
        let p = read();
        assert_eq!((p.cloud.as_str(), p.op_id.as_deref(), p.updated_ms), ("released", Some("op-5"), 9));
        assert!(progress::status_alert(d.path(), false, false).is_none(), "the alert is gone");
        // negative cases: the record stays `unknown`
        for row in ["moved|op-5|moved", "frozen|other|frozen", "", "garbage"] {
            progress::write(d.path(), &unknown("op-5")).unwrap();
            settle_progress(d.path(), Some("op-5"), &rollback_verdict(false, row), 9);
            assert_eq!(read().cloud, "unknown", "row {row:?}");
        }
        // another operation's record is not ours to clear; no record means nothing is written
        progress::write(d.path(), &unknown("op-5")).unwrap();
        settle_progress(d.path(), Some("op-6"), &Verdict::Released, 9);
        assert_eq!(read().cloud, "unknown");
        let e = tempfile::tempdir().unwrap();
        settle_progress(e.path(), Some("op-5"), &Verdict::Released, 9);
        assert!(progress::read(e.path()).is_none());
    }

    // ---- review fixes: gates under the lock, one scrubber, queue gate, held-by-another ----------------------------------------

    fn run_t(a: &RunArgs, env: &Env, dev: bool, s: &str) -> SwitchReport {
        run_with(a, env, dev, s, &|_| Ok(vec![]), &|| {})
    }
    fn rb_t(a: &RollbackArgs, env: &Env, dev: bool, s: &str) -> SwitchReport {
        rollback_with(a, env, dev, s, &|_| Ok(vec![]), &|| {})
    }
    fn set_mode(env: &Env, mode: &str) {
        crate::config::PosctlJson::new(mode, "id", 47300, "shop", "1.0.0-r1")
            .save(&env.roots)
            .unwrap();
    }
    fn forget(env: &Env) {
        for p in [progress::path(&env.update_dir()), crate::ops::journal::path(&env.update_dir()), env.roots.fence_start_types()] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn run_and_rollback_decide_every_refusal_under_the_lock_not_before_it() {
        // `before_lock` is where the world changes: another operation committed, crashed or left state while this one waited for the lock.
        // The stdin is garbage, so a refusal that is NOT decided after the hook would be a different reason (the credentials).
        let none = |_: &Env| Ok(vec![]);
        let (_d, env) = store_in_mode("cloud");
        // a switch committed in between: rollback must not free the cloud it moved (two stores), run must not start
        let commit = || set_mode(&env, "offline-only");
        let r = rollback_with(&rollback_args(Some("op-9")), &env, false, "not json at all", &none, &commit);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("ALREADY_COMMITTED")), "{r:?}");
        set_mode(&env, "cloud");
        let r = run_with(&run_args(), &env, false, "not json at all", &none, &commit);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("ALREADY_SWITCHED")), "{r:?}");
        // an earlier run left the cloud possibly moved
        set_mode(&env, "cloud");
        let mark_unknown = || progress::write(&env.update_dir(), &unknown("op-5")).unwrap();
        let r = run_with(&run_args(), &env, false, "not json at all", &none, &mark_unknown);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("CLOUD_STATE_UNKNOWN")), "{r:?}");
        forget(&env);
        // an operation crashed and left its journal
        let leave_journal = || switch_journal(Step::Work, None).write(&env.update_dir()).unwrap();
        let r = run_with(&run_args(), &env, false, "not json at all", &none, &leave_journal);
        assert_eq!((r.exit, r.reason.as_deref()), (17, Some("OPERATION_INCOMPLETE")), "{r:?}");
        forget(&env);
        // a recovery rolling this server forward: rollback must refuse
        let roll_forward = || switch_journal(Step::Reopen, None).write(&env.update_dir()).unwrap();
        let r = rollback_with(&rollback_args(Some("op")), &env, false, "not json at all", &none, &roll_forward);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("PAST_POINT_OF_NO_RETURN")), "{r:?}");
        forget(&env);
        // a fence left behind by an operation that ended uncleanly
        let leave_fence = || {
            std::fs::create_dir_all(env.roots.fence_start_types().parent().unwrap()).unwrap();
            std::fs::write(env.roots.fence_start_types(), b"{}").unwrap();
        };
        let r = run_with(&run_args(), &env, false, "not json at all", &none, &leave_fence);
        assert_eq!((r.exit, r.reason.as_deref()), (40, Some("LEFTOVER_STATE")), "{r:?}");
        assert!(crate::commands::update::leftover_state_present(&env), "the same function `update` uses");
    }

    #[test]
    fn a_blocked_precheck_never_reaches_the_cloud_end_to_end_through_a_counting_fence() {
        use std::cell::Cell;
        // everything `start` holds (begin_draining, SwitchWork::new, run_operation) is behind this counter
        let calls = Cell::new(0u32);
        let start = || {
            calls.set(calls.get() + 1);
            Ok(SwitchReport::ok("started", serde_json::json!({})))
        };
        let none = BTreeSet::new();
        let mut f = clean();
        f.tills[0].queue_depth = 2;
        f.tills[0].age_s = 60;
        let blocked = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
        let r = gate_precheck(blocked, start).unwrap();
        assert_eq!((r.exit, r.reason.as_deref(), calls.get()), (40, Some("PLAN_BLOCKED"), 0), "a fresh queue: exit 40, no fence call");
        // any other blocker is the same
        let mut f = clean();
        f.storage_objects = 3;
        f.photo_import_available = false;
        let blocked = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
        assert_eq!(gate_precheck(blocked, start).unwrap().exit, 40);
        assert_eq!(calls.get(), 0);
        // a clean store goes on, once
        let f = clean();
        let ok = report_for("src", "pack", &f, evaluate_waived(&f, &none), &None, &none);
        let r = gate_precheck(ok, start).unwrap();
        assert_eq!((r.exit, r.message.as_str(), calls.get()), (0, "started", 1));
    }

    #[test]
    fn a_cloud_still_held_by_an_earlier_switch_is_refused_naming_it_and_its_rollback_clears_it() {
        assert_eq!(held_by_other("frozen|old-op|frozen").as_deref(), Some("old-op"));
        assert_eq!(held_by_other("draining|old-op|draining").as_deref(), Some("old-op"));
        // an expired hold reads active: `begin_draining` takes it over, nothing to refuse; not held by an operation: no refusal
        for row in ["frozen|old-op|active", "active||active", "moved|old-op|moved", "draining||draining", ""] {
            assert_eq!(held_by_other(row), None, "{row:?}");
            assert!(held_refusal(row).is_ok(), "{row:?}");
        }
        let e = held_refusal("frozen|old-op|frozen").unwrap_err();
        assert_eq!(e.reason, "CLOUD_HELD_BY_ANOTHER_OPERATION");
        assert!(e.message.contains("posctl switch rollback old-op"), "{}", e.message);
        // the way out exists: that operation's rollback releases a draining or frozen row, and then the row reads active and run goes on
        let sql = crate::switch::cloud::sql_release("old-op").unwrap();
        assert!(sql.contains("op_id = 'old-op'") && sql.contains("state IN ('draining','frozen','moved')"), "{sql}");
        assert_eq!(rollback_verdict(true, "active||active"), Verdict::Released);
        assert!(held_refusal("active||active").is_ok());
        // and the old op id is found without typing it: the progress record of that run
        let mut p = unknown("old-op");
        p.cloud = "held".into();
        assert_eq!(rollback_op(None, None, Some(&p)).as_deref(), Some("old-op"));
    }

    #[test]
    fn every_report_of_run_and_rollback_is_scrubbed_with_updates_walk_on_every_path() {
        // 1. the refusals before the run started: the message AND the reason go through the walk (the injected local secrets are words
        //    the fixed texts contain, so a path that skipped the walk would show them)
        let (_d, env) = store_in_mode("weird");
        let local = |_: &Env| Ok(vec!["not prepared".to_string(), "ALREADY".to_string()]);
        let r = run_with(&run_args(), &env, false, "x", &local, &|| {});
        assert!(r.message.contains("***") && !r.message.contains("not prepared"), "{}", r.message);
        assert!(r.reason.as_deref().is_some_and(|x| x.starts_with("***")), "{:?}", r.reason);
        // 2. the walk covers the local pgpass password, the service key and the cloud password, in the message, the reason and nested data,
        //    for every constructor of a report
        let secrets = vec!["LOCALPW".to_string(), "SVCKEY".to_string(), "CLOUDPW".to_string()];
        let text = "psql said: password LOCALPW key SVCKEY cloud CLOUDPW";
        let rb = OpError::err("R", text);
        let reports = [
            SwitchReport::before_start(&OpError::new(OpCode::Precondition, "R", text)),
            SwitchReport::after_start(&rb),
            SwitchReport::refused("R", text, serde_json::json!({ "nested": { "a": [text] } })),
            failure_report(&rb, &ws(&["CLOUD_STILL_MOVED"]), "op", false),
            SwitchReport::ok(text, serde_json::json!({ "x": text })),
        ];
        for r in reports {
            let f = finalize_report(r, &secrets);
            let all = format!("{} {:?} {}", f.message, f.reason, f.data);
            for s in ["LOCALPW", "SVCKEY", "CLOUDPW"] {
                assert!(!all.contains(s), "{s} leaked: {all}");
            }
        }
        // 3. the cloud password comes from the stdin text
        let pw = "CLOUDPW9";
        let url = format!("postgresql://u:{pw}@db.example.invalid/postgres");
        let stdin = serde_json::json!({ "v": 1, "db": { "url": url } }).to_string();
        assert!(cloud_secrets(&stdin).contains(&pw.to_string()));
        assert!(cloud_secrets("not json").is_empty());
        // 4. a run or rollback that cannot read the local secrets refuses, on every entry
        let bad = |_: &Env| -> R<Vec<String>> { Err(OpError::err("SCRUB_SECRETS_UNREADABLE", "cannot read the pgpass file to scrub error text")) };
        let (_d2, env2) = store_in_mode("cloud");
        for r in [run_with(&run_args(), &env2, false, "x", &bad, &|| {}), rollback_with(&rollback_args(None), &env2, false, "x", &bad, &|| {})] {
            assert_eq!((r.exit, r.reason.as_deref()), (40, Some("SCRUB_SECRETS_UNREADABLE")));
        }
        // and the real loader fails closed in a store that has no secret files
        assert_eq!(run(&run_args(), &env2, false, "x").reason.as_deref(), Some("SCRUB_SECRETS_UNREADABLE"));
        assert_eq!(rollback(&rollback_args(None), &env2, false, "x").reason.as_deref(), Some("SCRUB_SECRETS_UNREADABLE"));
    }

    #[test]
    fn a_busy_lock_is_lock_held_exit_10_for_run_and_rollback_never_a_pass_and_never_already_switched() {
        // a mode that would otherwise refuse (and a cloud-mode one): the answer is the same, the lock decides first
        for mode in ["cloud", "offline-only"] {
            let (_d, env) = store_in_mode(mode);
            let _held = acquire_for(&env.roots, LockMode::Exclusive, "update", "someone-else", Duration::ZERO).unwrap();
            let r = run_t(&run_args(), &env, false, "not json at all");
            assert_eq!((r.exit, r.name, r.reason.as_deref(), r.retryable), (10, "LOCK_HELD", Some("LOCK_HELD"), true), "run, mode {mode}: {r:?}");
            let r = rb_t(&rollback_args(Some("op-1")), &env, false, "not json at all");
            assert_eq!((r.exit, r.name, r.reason.as_deref(), r.retryable), (10, "LOCK_HELD", Some("LOCK_HELD"), true), "rollback, mode {mode}: {r:?}");
            assert_ne!(r.reason.as_deref(), Some("ALREADY_SWITCHED"));
        }
        // and it is not a pass: once the lock is free the same call gets its real answer
        let (_d, env) = store_in_mode("offline-only");
        assert_eq!(run_t(&run_args(), &env, false, "not json at all").reason.as_deref(), Some("ALREADY_SWITCHED"));
    }
}
