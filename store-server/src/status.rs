//! `status.json` (conventions 8.2) and the `status` / `health` commands.
//!
//! `build_status` is pure: it turns what was measured into the documented shape and the alert
//! list, and `health_code` turns that into the exit code the Task Scheduler and the app branch
//! on. The measuring (`collect`) goes through `Env` and the canary through `Canary`, so every
//! test runs against fakes; the real services and HTTP are proven in the Windows Sandbox.
//! Sections owned by later plans (`backup`, `update`, `pki`) are filled by their own function
//! in `sections`. The file holds no secret, path or address.
//!
//! Boot gate: on a reboot the SCM starts Auth and the Gateway without `posctl`'s hook-variable
//! check, so `health --write` (the scheduled path) gates the sign-in stack (manual start + stopped) when the
//! lockout hook variables are missing, when this run's canary positively fails (the hook is off, or it answers
//! an error), or when the last recorded canary did, and exits CANARY_FAILED (22). The variable check and the
//! stop come FIRST: they need no `load_installed`, no `update.lock` and no readiness wait, because the stop is
//! the safe direction. A canary that only could not be judged (timeout, 5xx) is exit 20, never a gate; a canary
//! that is missing or over 26 h old is the CANARY_STALE alert (exit 21), never a gate.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::canary;
use crate::envelope::{Code, Outcome, PosctlError, POSCTL_VERSION};
use crate::lifecycle::{self, Installed};
use crate::net;
use crate::ops::lock::{acquire_for, LockMode};
use crate::paths::Roots;
use crate::pg::{PgTools, Psql};
use crate::probe;
use crate::render;
use crate::runtime::Runtime;
use crate::services::{self, Component, ServiceState};
use crate::sys;
use crate::tasks;
use crate::util::{now_rfc3339, random_uuid_v4, write_atomic};

pub const DISK_WARN_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const DISK_CRITICAL_BYTES: u64 = 1024 * 1024 * 1024;
/// How long a canary waits for Postgres, Auth and the Gateway to answer before it gives up (UNHEALTHY, not
/// CANARY_FAILED). Below the Canary task's 10 minute limit.
pub const CANARY_READY_WAIT: Duration = Duration::from_secs(120);
const CANARY_POLL: Duration = Duration::from_secs(2);
/// Every `code` that can appear in `status.json` `alerts` (this file plus `backup/status.rs`). The app's catalog
/// `src/shared/lib/store-alert-catalog.json` must name exactly these (`alert_catalog_matches_status_codes`); a plan
/// that adds an alert adds its code here and in the catalog together.
pub const ALERT_CODES: &[&str] = &[
    "AUTH_HOOK_ERROR",
    "BACKUP_DEST_DOWN",
    "BACKUP_DEST_FAILING",
    "BACKUP_DEST_FOREIGN",
    "BACKUP_DEST_NO_RECOVERY_KEY",
    "BACKUP_KEY_NOT_EXPORTED",
    "BACKUP_PHOTOS_UNREADABLE",
    "BACKUP_RESTORE_WARNING",
    "BACKUP_STALE_24H",
    "BACKUP_STALE_72H",
    "BACKUP_STATE_UNKNOWN",
    "BACKUP_VERIFY_FAILED",
    "BACKUP_VERIFY_OVERDUE",
    "CANARY_STALE",
    "CERT_EXPIRING",
    "DISK_LOW",
    "LOCKOUT_HOOK_INACTIVE",
    "MAINTENANCE_WINDOW_INVALID",
    "NETWORK_PROFILE_PUBLIC",
    "PACK_INVALID",
    "PACK_UPDATE_AVAILABLE",
    "RECOVERY_NEEDED",
    "RECOVERY_SUPPORT_NEEDED",
    "SCHEMA_MISMATCH",
    "STATUS_STALE",
    "TASKS_MISSING",
    "TASKS_STALE",
    "UPDATE_BLOCKED",
    "UPDATE_ROLLED_BACK",
    "UPDATE_STATE_UNKNOWN",
];

/// A canary older than this raises CANARY_STALE and is re-run by `health --write` (the Canary task is daily).
const CANARY_STALE_SECS: u64 = 26 * 3600;
/// `status.json` is rewritten every minute by the Health task: older than this, nothing is writing it.
const STATUS_STALE_SECS: u64 = 300;

/// True when a `status.json` that exists has no readable `generatedAt` or it is over 5 minutes old at `now`.
pub fn status_file_stale(generated_at: Option<&str>, now: u64) -> bool {
    generated_at.and_then(parse_rfc3339_utc).is_none_or(|t| now.saturating_sub(t) > STATUS_STALE_SECS)
}

/// `YYYY-MM-DDTHH:MM:SSZ` (what `util::rfc3339_utc` writes) as Unix seconds.
fn parse_rfc3339_utc(t: &str) -> Option<u64> {
    let b = t.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| -> Option<i64> { t.get(r).filter(|x| x.bytes().all(|c| c.is_ascii_digit()))?.parse().ok() };
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Howard Hinnant's days-from-civil, the inverse of util::rfc3339_utc
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

#[derive(Debug, Clone)]
pub struct ServiceStatus {
    pub component: Component,
    pub state: String,
    pub healthy: bool,
}

#[derive(Debug, Clone)]
pub struct Inputs {
    pub generated_at: String,
    pub pack_version: String,
    pub services: Vec<ServiceStatus>,
    /// `(max_version, applied)` read from `public.store_schema_version`, if Postgres answered.
    pub schema_live: Option<(String, u32)>,
    pub schema_expected: (String, u32),
    pub hook_env_ok: bool,
    pub canary_ok: Option<bool>,
    pub canary_at: Option<String>,
    pub disk_free_bytes: u64,
    pub data_bytes: u64,
    pub public_network: bool,
    pub network_profile: String,
    pub firewall_rule_ok: bool,
    /// `(task name, registered)`; `None` when the scheduler could not be read.
    pub tasks: Option<Vec<(String, bool)>>,
    /// `(task name, its action carries --scheduled)` for the tasks that must; a missing task is `false`. `None` = could not be read.
    pub task_flags: Option<Vec<(String, bool)>>,
    pub provisioning: bool,
    /// `(code, level, since)` of the alerts in the previous `status.json` (empty when there is none or it is
    /// unreadable); see `build_alerts`.
    pub previous_alerts: Vec<(String, String, String)>,
    /// True when the last 64 KiB of the newest log under `logs\SupermarketPOS-Auth\` contain `Hook errored out`.
    pub auth_hook_error_seen: bool,
    /// Why the installed pack failed its LIGHT verification (signature, sizes, unlisted files), if it did. Nothing is run
    /// from such a pack on its account; it raises `PACK_INVALID`.
    pub pack_error: Option<String>,
    /// `status` found a `status.json` nothing has refreshed for over 5 minutes (see `status_file_stale`); `health` never sets it.
    pub status_stale: bool,
    /// The store's certificates; `None` when it serves no TLS or its authority does not exist yet.
    pub pki: Option<crate::pki::PkiFacts>,
    /// What the shared operation lock and the journal say is happening (see `op_phase`).
    pub op: OpPhase,
    /// The scheduled recovery gave up after its attempts (journal `recoverAttempts`): only a person can go on.
    pub recovery_exhausted: bool,
    /// `(atMs, by)` of every recovery attempt recorded in the journal.
    pub recover_attempts: Vec<(u64, String)>,
    /// `maintenance.window` in posctl.json is present but unusable (the default 01:00-05:00 is in force).
    pub window_invalid: bool,
    /// `state\update\update-result.json`: the last update and the pack that waits for a quiet moment.
    pub update_result: crate::update::result_file::UpdateResultFile,
    /// `state\update\update-rolled-back.json`: the pack the last update rolled back from, until a newer one or a success replaces it.
    pub rolled_back: Option<crate::update::result_file::RolledBack>,
    /// Plan 08: the `status.backup` block and the backup alerts, read from the backup state (`backup::status::read`: config, state and
    /// one lock probe; no restic, no psql, no writes).
    pub backup: crate::backup::status::Computed,
    /// Plan 09: `(code, message, since_ms)` of the cloud-switch alert (`switch::progress::status_alert`), if there is one.
    pub switch_alert: Option<(String, String, u64)>,
    /// `(code, message, since_ms)` of `OPERATION_HUNG` (`operation_hung_alert`): an operation holds the lock for longer than any legal run.
    pub hung_alert: Option<(String, String, u64)>,
    /// `SWITCH_STAGING_LEFTOVER`: paths of a dead switch's `cloud-pgpass-*` / `backups\switch-*` folders (`staging_leftover_paths`; empty while an operation runs).
    pub staging_leftover: Vec<String>,
}

/// What an operation of the shared API (update, switch, restore) is doing right now, from the lock and the journal alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpPhase { None, Updating, Switching, Restoring, RecoveryNeeded, Unknown }

/// The journal and the shared lock decide, before any service does. The journal is read with `Journal::read` (never `peek`,
/// which maps a corrupt or too-new journal to "none"): an unreadable journal means recovery is needed, even while a lock
/// is held, because a live operation writes it atomically. A running operation is named by its lock kind; a journal with
/// no operation holding the lock means one died. A backup (shared lock) or an unrelated exclusive holder (prune) is not an
/// operation, and a lock whose state cannot be read adds nothing: only the journal can prove a problem.
pub fn op_phase(roots: &Roots) -> OpPhase { op_phase_via(roots, &crate::ops::journal::fs_read, &|p: &std::path::Path| p.try_exists()) }

/// `op_phase` with the two filesystem questions injected (the test seam for an access-denied update folder).
pub fn op_phase_via(roots: &Roots, read: crate::ops::journal::ReadFn, exists: &dyn Fn(&std::path::Path) -> std::io::Result<bool>) -> OpPhase {
    use crate::ops::journal::{Journal, JournalError};
    use crate::ops::lock::{probe_readonly_for, LockState};
    let journal = Journal::read_roots_via(roots, read);
    match &journal {
        // FR19 fail closed: the journal lives in `state\update\` (SYSTEM + Administrators). A reader that cannot look in does NOT
        // know that nothing is happening.
        Err(JournalError::Io(_)) => return OpPhase::Unknown,
        Err(_) => return OpPhase::RecoveryNeeded,
        Ok(_) => {}
    }
    // read-only: the Health task runs every minute and must not take the lock, create it or delete the holder's info
    if let LockState::ExclusiveHeld(info) = probe_readonly_for(roots) {
        return match info.kind.as_str() {
            "update" | "recover" => OpPhase::Updating,
            "switch" | "switch-rollback" => OpPhase::Switching,
            "restore" => OpPhase::Restoring,
            _ => OpPhase::None,
        };
    }
    if matches!(journal, Ok(Some(_))) {
        return OpPhase::RecoveryNeeded;
    }
    // No journal and nobody holding the lock, yet a fence marker is still here: the operation finalized and only its unfence
    // died (or a recovery could not finish it). The tills are still fenced, so this must be visible.
    let (mut present, mut unknown) = (false, false);
    for p in [roots.fence_start_types(), roots.legacy_of(&roots.fence_start_types()), crate::conf::caddyfile_live_copy(roots)] {
        match exists(&p) { Ok(true) => present = true, Ok(false) => {}, Err(_) => unknown = true }
    }
    if present { OpPhase::RecoveryNeeded } else if unknown { OpPhase::Unknown } else { OpPhase::None }
}

/// Is an operation running RIGHT NOW? Only a live exclusive lock holder says so (a held lock is proof; a journal or a leftover file is
/// not). Anything else, an unreadable lock included, is "not running", so a switch alert is never hidden by a doubt (D2-c).
/// The holder must be one of the operations `op_phase_via` knows (update, recover, switch, switch-rollback, restore): a housekeeping, prune
/// or backup holder, or a kind nobody knows, is NOT a running switch and must not hide its alert.
///
/// A holder older than `RUN_CEILING_MS` is a hung process, not a running operation: its deadline, one overshoot and the rollback are long
/// over, and a live-looking holder must not hide the alert for ever. The ceiling is alert-only: it never frees a lock. The alert then
/// names that holder's process id (`hung_holder`): the hung `posctl.exe` is stopped BY PID (never by image name) or the server is
/// restarted; only then do `update --recover` and `switch rollback` get past exit 10 LOCK_HELD.
pub fn lock_is_live(state: &crate::ops::lock::LockState, now_ms: u64) -> bool {
    matches!(state, crate::ops::lock::LockState::ExclusiveHeld(info)
        if is_operation_kind(&info.kind) && now_ms.saturating_sub(info.started_ms) <= RUN_CEILING_MS)
}

fn is_operation_kind(kind: &str) -> bool {
    matches!(kind, "update" | "recover" | "switch" | "switch-rollback" | "restore")
}

/// Who to tell the operator to stop when the alert shows with a journal open and `lock_is_live` is false. An operation holder older
/// than the ceiling is hung: its process id (from the lock info) is named, so it can be stopped by id, never by image name. A holder
/// that is not an operation (a backup, housekeeping) is not hung and not named, and neither is a shared holder (a backup). A lock that
/// cannot be probed says so.
pub fn hung_holder(state: &crate::ops::lock::LockState, now_ms: u64) -> crate::switch::progress::Holder {
    use crate::ops::lock::LockState as L;
    use crate::switch::progress::Holder as H;
    match state {
        L::ExclusiveHeld(i) if is_operation_kind(&i.kind) && !lock_is_live(state, now_ms) => H::Pid(i.pid),
        L::Unknown(_) => H::Unreadable,
        _ => H::Nobody,
    }
}

/// `OPERATION_HUNG`: an operation holder (update, recover, switch, switch-rollback, restore) older than `RUN_CEILING_MS`, whatever the
/// progress file or the journal say. A run hung before the move (the keepalive stops at its limit and the cloud frees itself, the tills
/// trade on the cloud again) shows "switching" for ever otherwise, and `update --recover` and `switch run` answer exit 10 with no pointer
/// to the process. ALERT ONLY: it names the process, it frees nothing and kills nothing. `(code, message, since_ms)`.
pub fn operation_hung_alert(state: &crate::ops::lock::LockState, now_ms: u64) -> Option<(String, String, u64)> {
    let crate::ops::lock::LockState::ExclusiveHeld(i) = state else { return None };
    if !is_operation_kind(&i.kind) || lock_is_live(state, now_ms) {
        return None;
    }
    let stop = crate::switch::progress::stop_text(crate::switch::progress::Holder::Pid(i.pid));
    let after = if i.kind.starts_with("switch") { "; if it ends with exit 17, run the `posctl switch rollback <op>` it prints" } else { "" };
    Some((
        "OPERATION_HUNG".into(),
        format!(
            "the {} operation {} has held the operation lock for longer than any legal run: it is hung, and `posctl update --recover` and a new switch answer exit 10 until it is stopped. Nothing is freed automatically. {stop}run `posctl update --recover`{after}",
            i.kind, i.op_id
        ),
        i.started_ms,
    ))
}

/// What a dead switch left on disk (`switch::staging::leftovers`), unless something may legitimately own it right now: a live operation
/// (a running switch has its own pgpass and dump) or a shared holder (`switch plan` holds its pgpass folder under a shared lock). A lock
/// that cannot be read, or a hung holder, does not hide it. Read-only; the folders hold the cloud database password and cloud data.
pub fn staging_leftover_paths(roots: &Roots, lock: &crate::ops::lock::LockState, now_ms: u64) -> Vec<String> {
    if matches!(lock, crate::ops::lock::LockState::SharedHeld) || lock_is_live(lock, now_ms) {
        return vec![];
    }
    crate::switch::staging::leftovers(roots).iter().map(|p| p.display().to_string()).collect()
}

/// Paths named in the `SWITCH_STAGING_LEFTOVER` message before "+N more".
pub const LEFTOVER_PATHS_SHOWN: usize = 5;

/// Count, every path up to `LEFTOVER_PATHS_SHOWN` (then "+N more"), and the way out: `--recover` first, then delete by hand (with no
/// journal, a kill before `Started` or a purge that failed after the archive, `--recover` does nothing).
pub fn staging_leftover_message(paths: &[String]) -> String {
    let mut named = paths.iter().take(LEFTOVER_PATHS_SHOWN).cloned().collect::<Vec<_>>().join("; ");
    if paths.len() > LEFTOVER_PATHS_SHOWN {
        named.push_str(&format!("; +{} more", paths.len() - LEFTOVER_PATHS_SHOWN));
    }
    format!("{} folder(s) left by a switch that died hold the cloud database password or a dump of the cloud data: {named}. Run `posctl update --recover` as an administrator; if this alert remains, delete the named path(s) by hand (with no open journal `--recover` does nothing)", paths.len())
}

/// SWITCH-specific: the longest a switch may legitimately hold the lock, from the same constants as its budget: the longest wait and its
/// grace, the work budget, one overshoot, and the freeze dead-man window. The one hour of margin absorbs what those do not count: the time
/// from taking the lock to `t0` (the prechecks and `ensure_dump`), the duration of a rollback, and the steps after `Reopen` (which run
/// forward, past the deadline). (About 6 h 7 min.) An update or a restore is judged by the same figure, only for the alert: it is far
/// above their own budgets.
pub const RUN_CEILING_MS: u64 = (((crate::switch::work::MAX_WAIT_MINUTES + crate::switch::work::DRAIN_GRACE_MINUTES + crate::commands::switch::FREEZE_MINUTES) as u64) * 60
    + crate::commands::switch::WORK_BUDGET_SECS + crate::commands::switch::SQL_OVERSHOOT_SECS + 3600) * 1000;

/// An open journal that belongs to a SWITCH (the only kind that explains a held cloud). An unreadable journal counts as open: a doubt
/// never hides the alert. Another operation's journal does not.
pub fn switch_journal_open(read: Result<Option<crate::ops::journal::Journal>, crate::ops::journal::JournalError>) -> bool {
    match read {
        Ok(None) => false,
        Ok(Some(j)) => j.kind == crate::ops::outcome::OpKind::Switch,
        Err(_) => true,
    }
}

/// Pure text check on a log tail.
pub fn log_tail_has_hook_error(tail: &str) -> bool {
    tail.contains("Hook errored out")
}

/// Last 64 KiB of the newest `*.log` file under `logs\SupermarketPOS-Auth\`; false when there is none.
fn auth_log_has_hook_error(roots: &Roots) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let dir = roots.logs_for(Component::Auth.service_name());
    let newest = std::fs::read_dir(&dir).ok().and_then(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false)).max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok()));
    let Some(f) = newest else { return false };
    let Ok(mut file) = std::fs::File::open(f.path()) else { return false };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)));
    let mut buf = Vec::new();
    let _ = file.read_to_end(&mut buf);
    log_tail_has_hook_error(&String::from_utf8_lossy(&buf))
}

/// Whole days until the authority's root expires (negative once it has), judged at `generated_at`.
pub fn root_days_left(f: &crate::pki::PkiFacts, generated_at: &str) -> Option<i64> {
    let now = i64::try_from(parse_rfc3339_utc(generated_at)?).ok()?;
    Some((f.root_not_after_unix - now).div_euclid(86_400))
}

pub fn build_alerts(i: &Inputs) -> Vec<Value> {
    let mut a = Vec::new();
    // `since` is the FIRST-SEEN time: an alert with the same code AND level as in the previous file keeps its
    // old `since`, anything else is stamped `generated_at` (Plan 12's e-mail de-duplication keys on it).
    let mut push = |code: &str, level: &str| {
        let since = i.previous_alerts.iter().find(|(c, l, _)| c == code && l == level).map(|(_, _, s)| s.clone()).unwrap_or_else(|| i.generated_at.clone());
        let mut alert = json!({"code": code, "level": level, "since": since});
        if code == "STATUS_STALE" {
            alert["message"] = json!("status.json has not been refreshed for over 5 minutes; the Health task may be missing: run `posctl tasks install` as an administrator");
        }
        if let (Some(r), "UPDATE_ROLLED_BACK") = (&i.rolled_back, code) {
            alert["message"] = json!(format!("the update to {} rolled back; the scheduled check will not retry it. A newer pack is taken automatically, or run `posctl update` to retry by hand", r.pack_version));
        }
        if code == "UPDATE_STATE_UNKNOWN" {
            alert["message"] = json!("the update state (state\\update\\) cannot be read, so it is not reported as idle; run posctl status as an administrator (needs elevation)");
        }
        if code == "TASKS_STALE" {
            alert["message"] = json!("a scheduled update task is missing or out of date: run posctl tasks install as an administrator");
        }
        // Plan 08: a lockout hook that is off within a week of a restore that warned about its canary is the restore's doing
        if let ("LOCKOUT_HOOK_INACTIVE", Some(at), Some(now)) = (code, i.backup.restore_canary_warned_at, parse_rfc3339_utc(&i.generated_at)) {
            if (0..crate::backup::status::RESTORE_WARNING_SHOW_SECS).contains(&(now as i64 - at)) {
                alert["cause"] = json!("after-restore");
                alert["message"] = json!("sign-in is blocked until the lockout protection works; call support");
            }
        }
        if code == "SWITCH_STAGING_LEFTOVER" {
            alert["message"] = json!(staging_leftover_message(&i.staging_leftover));
        }
        if code == "TASKS_MISSING" {
            alert["message"] = json!("the store server health tasks are not scheduled; run `posctl tasks install` as an administrator");
        }
        a.push(alert)
    };
    if i.public_network {
        push("NETWORK_PROFILE_PUBLIC", "warn");
    }
    if i.disk_free_bytes < DISK_CRITICAL_BYTES {
        push("DISK_LOW", "critical");
    } else if i.disk_free_bytes < DISK_WARN_BYTES {
        push("DISK_LOW", "warn");
    }
    if let Some(live) = &i.schema_live {
        if *live != i.schema_expected {
            push("SCHEMA_MISMATCH", "critical");
        }
    }
    if !i.hook_env_ok || i.canary_ok == Some(false) {
        push("LOCKOUT_HOOK_INACTIVE", "critical");
    }
    // No successful canary on record, or the last one is over 26 h old. A failed one is the alert above instead.
    // A warning (exit 21), never a gate: only positive evidence that the hook is off stops sign-in.
    let age = match (parse_rfc3339_utc(&i.generated_at), i.canary_at.as_deref().and_then(parse_rfc3339_utc)) {
        (Some(now), Some(at)) => Some(now.saturating_sub(at)),
        _ => None,
    };
    if i.canary_ok != Some(false) && !(i.canary_ok == Some(true) && age.is_some_and(|a| a <= CANARY_STALE_SECS)) {
        push("CANARY_STALE", "warn");
    }
    // Provisioned, yet a scheduled task is gone: the boot gate and the canary no longer run. An installer that died
    // between `tasks remove` and `tasks install` leaves exactly this. (`None` = the scheduler could not be read.)
    if !i.provisioning && i.tasks.as_ref().is_some_and(|t| t.iter().any(|(_, registered)| !registered)) {
        push("TASKS_MISSING", "warn");
    }
    // A scheduled task missing, or installed by an older posctl without `--scheduled`: the unattended runs would be taken for a person's.
    // (`None` = the scheduler could not be read: that is unknown, not stale.)
    if !i.provisioning && i.task_flags.as_ref().is_some_and(|t| t.iter().any(|(_, ok)| !ok)) {
        push("TASKS_STALE", "warn");
    }
    if i.status_stale && !i.provisioning {
        push("STATUS_STALE", "warn");
    }
    if i.pack_error.is_some() {
        push("PACK_INVALID", "critical"); // the installed pack does not verify; `posctl start` will refuse it too
    }
    if let Some(f) = &i.pki {
        let now = parse_rfc3339_utc(&i.generated_at).and_then(|t| i64::try_from(t).ok());
        match root_days_left(f, &i.generated_at) {
            Some(d) if d < 7 => push("CERT_EXPIRING", "critical"),
            // first warning at 90 days: time to plan the re-pair of every till before the root ends
            Some(d) if d < 90 => push("CERT_EXPIRING", "warn"),
            // a leaf is only 12 h long: a running Gateway whose leaf is already past notAfter is not renewing it
            _ if now.zip(f.leaf_not_after_unix).is_some_and(|(n, l)| l < n) && i.services.iter().any(|s| s.component == Component::Gateway && s.healthy) => push("CERT_EXPIRING", "warn"),
            _ => {}
        }
    }
    if i.auth_hook_error_seen {
        push("AUTH_HOOK_ERROR", "critical"); // GoTrue's `Hook errored out` line; password sign-in is failing closed
    }
    if i.window_invalid {
        push("MAINTENANCE_WINDOW_INVALID", "warn"); // the default window is in force; fix maintenance.window in posctl.json
    }
    if i.op == OpPhase::RecoveryNeeded && i.recovery_exhausted {
        push("RECOVERY_SUPPORT_NEEDED", "critical"); // three unattended recoveries failed: no further automatic attempt; call support
    }
    if i.op == OpPhase::RecoveryNeeded {
        push("RECOVERY_NEEDED", "critical"); // an interrupted update, switch or restore: the tills stay fenced until `posctl update --recover`
    }
    if i.op == OpPhase::Unknown {
        push("UPDATE_STATE_UNKNOWN", "warn");
    }
    if i.rolled_back.is_some() {
        push("UPDATE_ROLLED_BACK", "warn"); // the scheduled check is not retrying that version; see `RolledBack`
    }
    if !i.staging_leftover.is_empty() {
        push("SWITCH_STAGING_LEFTOVER", "critical"); // alert only: names the path, removes nothing
    }
    // Plan 09: the cloud may be moved while this server is not switched, or a switch stopped holding the cloud. `since` is the first-seen
    // time when this alert was in the previous file, else the moment the switch recorded it.
    if let Some((code, message, since_ms)) = &i.switch_alert {
        let since = i.previous_alerts.iter().find(|(c, l, _)| c == code && l == "critical").map(|(_, _, s)| s.clone()).unwrap_or_else(|| crate::util::rfc3339_utc(since_ms / 1000));
        a.push(json!({"code": code, "level": "critical", "since": since, "message": message}));
    }
    // A hung operation (alert only): named by its process id, whatever the progress record says.
    if let Some((code, message, since_ms)) = &i.hung_alert {
        let since = i.previous_alerts.iter().find(|(c, l, _)| c == code && l == "critical").map(|(_, _, s)| s.clone()).unwrap_or_else(|| crate::util::rfc3339_utc(since_ms / 1000));
        a.push(json!({"code": code, "level": "critical", "since": since, "message": message}));
    }
    // A newer pack that keeps being deferred (the store is always trading): warn after 7 days, critical after 14. `since` is the
    // persisted first-seen time of that pack, so it never moves with the writes.
    if let Some(p) = &i.update_result.pending {
        let age_days = parse_rfc3339_utc(&i.generated_at).map(|now| (now * 1000).saturating_sub(p.since_ms) / 86_400_000);
        // critical only for a pack whose signature has been verified: the feed document is unsigned, so a version that was only
        // peeked at could otherwise escalate a bogus claim to critical
        let level = match age_days { Some(d) if d >= 14 && p.verified => Some("critical"), Some(d) if d >= 7 => Some("warn"), _ => None };
        if let Some(level) = level {
            a.push(json!({"code": "PACK_UPDATE_AVAILABLE", "level": level, "since": crate::util::rfc3339_utc(p.since_ms / 1000)}));
        }
    }
    // Plan 08, appended last. The backup service computes its own alerts from stored times; one with no stored time carries a null
    // `since`, which is stamped here with the same first-seen rule as every alert above (never the clock of this minute, never 1970).
    let lockout_on = !i.hook_env_ok || i.canary_ok == Some(false);
    let now_secs = parse_rfc3339_utc(&i.generated_at);
    for b in &i.backup.alerts {
        let mut b = b.clone();
        let code = b["code"].as_str().unwrap_or("").to_string();
        // LOCKOUT_HOOK_INACTIVE already says it: the canary note leaves the restore warning while that alert is up
        if code == "BACKUP_RESTORE_WARNING" && lockout_on {
            let kept: Vec<Value> = b["warnings"].as_array().cloned().unwrap_or_default().into_iter().filter(|w| w != "CANARY_AFTER_RESTORE").collect();
            if kept.is_empty() {
                continue;
            }
            b["warnings"] = json!(kept);
        }
        if b["since"].is_null() {
            let level = b["level"].as_str().unwrap_or("").to_string();
            // BACKUP_STATE_UNKNOWN changes level while it persists: its first-seen time is found by code alone
            let first_seen = i.previous_alerts.iter().find(|(c, l, _)| *c == code && (*l == level || code == "BACKUP_STATE_UNKNOWN")).map(|(_, _, s)| s.clone()).unwrap_or_else(|| i.generated_at.clone());
            b["since"] = json!(first_seen);
        }
        // an unreadable backup state that has stayed unreadable for a day is no longer a mere warning
        if let (true, Some(now), Some(since)) = (code == "BACKUP_STATE_UNKNOWN", now_secs, b["since"].as_str().and_then(parse_rfc3339_utc)) {
            if now.saturating_sub(since) >= BACKUP_STATE_UNKNOWN_CRITICAL_SECS {
                b["level"] = json!("critical");
            }
        }
        a.push(b);
    }
    // A newer pack has waited three nights and the last update was refused or rolled back because the backup before it could not be
    // taken: the store is not getting updates until the backup works. `since` is the pack's first-seen time, as for PACK_UPDATE_AVAILABLE.
    if let (Some(p), Some(reason)) = (&i.update_result.pending, i.update_result.last_reason.as_deref()) {
        let nights = parse_rfc3339_utc(&i.generated_at).map(|now| (now * 1000).saturating_sub(p.since_ms) / 86_400_000);
        if matches!(reason, "BACKUP_NOT_READY" | "PRE_UPDATE_BACKUP_FAILED") && nights.is_some_and(|n| n >= UPDATE_BLOCKED_AFTER_NIGHTS) {
            let mut alert = json!({"code": "UPDATE_BLOCKED", "level": "warn", "since": crate::util::rfc3339_utc(p.since_ms / 1000), "reason": reason,
                "message": "updates are waiting because the backup that must come before an update cannot be taken; fix the backup (see status.backup), then the update goes ahead"});
            if let Some(kind) = i.backup.last_error_kind {
                alert["error"] = json!(kind);
            }
            // the broken backup is the cause only if the backup itself is also alerting as stale
            if i.backup.alerts.iter().any(|b| b["code"].as_str().is_some_and(|c| c.starts_with("BACKUP_STALE"))) {
                alert["cause"] = json!("backup");
            }
            a.push(alert);
        }
    }
    a
}

/// How long an unreadable backup state may stay a warning before it turns critical.
const BACKUP_STATE_UNKNOWN_CRITICAL_SECS: u64 = 24 * 3600;

/// Nights a newer pack must have been waiting before a broken backup is named as the reason (`UPDATE_BLOCKED`).
const UPDATE_BLOCKED_AFTER_NIGHTS: u64 = 3;

/// The scheduled recovery tried three times and failed (`journal.extra.recoverAttempts`): only a person can go on.
/// `(atMs, by)` of every recovery attempt the journal records, oldest first.
pub fn recovery_attempts(roots: &Roots) -> Vec<(u64, String)> {
    let Ok(Some(j)) = crate::ops::journal::Journal::read_roots(roots) else { return vec![] };
    j.extra.get("recoverAttempts").and_then(Value::as_array).map(|a| {
        a.iter().filter_map(|x| Some((x["atMs"].as_u64()?, x["by"].as_str()?.to_string()))).collect()
    }).unwrap_or_default()
}

pub fn window_invalid(roots: &Roots) -> bool {
    let w = crate::config::PosctlJson::load(roots).ok().flatten().and_then(|c| c.maintenance.window);
    crate::update::window::window_problem(w.as_ref())
}

pub fn recovery_attempts_exhausted(roots: &Roots) -> bool {
    recovery_attempts(roots).iter().filter(|(_, by)| by == "unattended").count() >= crate::commands::update::MAX_UNATTENDED_ATTEMPTS
}

pub fn derive_state(i: &Inputs) -> &'static str {
    // an operation fences the tills and stops the stack on purpose: that is never "degraded" or "stopped"
    match i.op {
        OpPhase::Updating => return "updating",
        OpPhase::Switching => return "switching",
        OpPhase::Restoring => return "restoring",
        OpPhase::RecoveryNeeded => return "recovery-needed",
        OpPhase::Unknown => return "unknown",
        OpPhase::None => {}
    }
    if i.provisioning {
        "provisioning"
    } else if i.services.iter().all(|s| s.state == "stopped" || s.state == "not-installed") {
        "stopped"
    } else if i.services.iter().all(|s| s.healthy) {
        "running"
    } else {
        "degraded"
    }
}

/// The `backup` section; its `alert` follows the escalation that `build_alerts` applies after the backup service computed it.
fn backup_block(i: &Inputs, alerts: &[Value]) -> Value {
    let mut b = sections::backup(&i.backup.block);
    if alerts.iter().any(|a| a["code"] == "BACKUP_STATE_UNKNOWN" && a["level"] == "critical") {
        b["alert"] = json!("critical");
    }
    b
}

pub fn build_status(i: &Inputs) -> Value {
    let alerts = build_alerts(i);
    let mut services = serde_json::Map::new();
    for s in &i.services {
        services.insert(s.component.short().to_string(), json!({"state": s.state, "healthy": s.healthy}));
    }
    let (max, applied) = i.schema_live.clone().unwrap_or((String::new(), 0));
    let tasks = match &i.tasks {
        Some(t) => Value::Object(t.iter().map(|(n, ok)| (n.clone(), json!(ok))).collect()),
        None => Value::Null,
    };
    // Conventions 8.2 uses the key `schema` twice (file version 1 and the database level). The file
    // version keeps `schema`; the database level is `database`.
    json!({
        "schema": 1,
        "generatedAt": i.generated_at,
        "mode": "offline-only",
        "state": derive_state(i),
        "packVersion": i.pack_version,
        "posctlVersion": POSCTL_VERSION,
        "services": Value::Object(services),
        "database": {"maxVersion": max, "applied": applied, "expected": {"maxVersion": i.schema_expected.0, "applied": i.schema_expected.1}},
        "lockoutHook": {"envOk": i.hook_env_ok, "canaryOk": i.canary_ok, "canaryAt": i.canary_at},
        "backup": backup_block(i, &alerts),
        "disk": {"freeBytes": i.disk_free_bytes, "dataBytes": i.data_bytes},
        "network": {"profile": i.network_profile, "firewallRule": i.firewall_rule_ok},
        "tasks": tasks,
        // true: every scheduled task carries `--scheduled`; false: one is missing or stale; null: could not be read
        "tasksCurrent": i.task_flags.as_ref().map(|t| t.iter().all(|(_, ok)| *ok)),
        "pki": sections::pki(i.pki.as_ref(), &i.generated_at),
        "update": sections::update(&i.update_result, &i.recover_attempts, i.rolled_back.as_ref()),
        "alerts": Value::Array(alerts),
    })
}

/// Sections owned by later plans. Each plan replaces its function body.
pub mod sections {
    use serde_json::{json, Value};
    /// Plan 08: the block `backup::status` computed from the backup state (a quiet block when backups are not configured).
    pub fn backup(block: &Value) -> Value {
        block.clone()
    }
    /// Plan 06. `driftedHosts` is null: comparing the names with this PC's addresses runs PowerShell, which the per-minute
    /// Health task does not do; `posctl pki status` reports it.
    pub fn pki(f: Option<&crate::pki::PkiFacts>, generated_at: &str) -> Value {
        let Some(f) = f else {
            return json!({"rootSha256": null, "leafNotAfter": null, "daysLeft": null, "hosts": [], "driftedHosts": null});
        };
        let rfc = |t: i64| time::OffsetDateTime::from_unix_timestamp(t).ok().and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok());
        json!({
            "rootSha256": f.root_sha256,
            "rootNotAfter": rfc(f.root_not_after_unix),
            "leafNotAfter": f.leaf_not_after_unix.and_then(rfc),
            "daysLeft": super::root_days_left(f, generated_at),
            "hosts": f.hosts,
            "driftedHosts": null,
        })
    }
    /// Plan 07. Reason codes and times only: the result file's free text never reaches `status.json`.
    pub fn update(r: &crate::update::result_file::UpdateResultFile, attempts: &[(u64, String)], rolled_back: Option<&crate::update::result_file::RolledBack>) -> Value {
        let rfc = |ms: u64| crate::util::rfc3339_utc(ms / 1000);
        json!({
            "lastAt": (r.last_at_ms > 0).then(|| rfc(r.last_at_ms)),
            "lastResult": (!r.last_result.is_empty() && r.last_result != "none").then(|| r.last_result.clone()),
            // the exit code of the last result (the file keeps the name) and its reason; never the free-text message
            "lastCode": (r.last_at_ms > 0).then(|| crate::ops::outcome::OpCode::exit_for_name(&r.last_code)).flatten(),
            "lastReason": r.last_reason,
            // the version the scheduled check is not retrying (see `RolledBack`)
            "rolledBackVersion": rolled_back.map(|x| x.pack_version.clone()),
            "pending": r.pending.as_ref().map(|p| json!({"packVersion": p.pack_version, "since": rfc(p.since_ms), "reason": p.deferred_reason})),
            // the scheduled recovery gives up after three of its own; this is how an operator sees how far it got
            "recoverAttempts": {
                "count": attempts.len(),
                "unattended": attempts.iter().filter(|(_, by)| by == "unattended").count(),
                "lastAt": attempts.iter().map(|(at, _)| *at).max().map(rfc),
            },
        })
    }
}

/// Exit code of `posctl health`. `canary_failed` outranks everything (a security control is off), then a
/// service that is not healthy, then any alert.
pub fn health_code(status: &Value, canary_failed: bool) -> Code {
    if canary_failed {
        return Code::CanaryFailed;
    }
    // The Health task only reports. While an operation fences the tills it has stopped the stack on purpose, so "unhealthy" would
    // be a false alarm every minute: the exit code names the operation instead.
    match status["state"].as_str() {
        Some("updating" | "switching" | "restoring") => return Code::Ok,
        Some("recovery-needed") => return Code::RecoveryNeeded,
        _ => {}
    }
    let unhealthy = status["services"].as_object().map(|m| m.values().any(|s| s["healthy"] != json!(true))).unwrap_or(true);
    if unhealthy {
        return Code::Unhealthy;
    }
    if status["alerts"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        return Code::Degraded;
    }
    Code::Ok
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

fn state_word(s: &ServiceState) -> String {
    match s {
        ServiceState::NotInstalled => "not-installed",
        ServiceState::Stopped => "stopped",
        ServiceState::StartPending => "starting",
        ServiceState::StopPending => "stopping",
        ServiceState::Running => "running",
        ServiceState::Other(_) => "unknown",
    }
    .to_string()
}

type SchemaFn<'a> = Box<dyn Fn(&Roots, &Installed) -> Option<(String, u32)> + 'a>;
type ProfilesFn<'a> = Box<dyn Fn() -> Result<Vec<net::Profile>, String> + 'a>;
type RuleFn<'a> = Box<dyn Fn() -> Result<Vec<net::FirewallRule>, String> + 'a>;
type TasksFn<'a> = Box<dyn Fn() -> Result<Vec<(String, bool)>, String> + 'a>;
type HealthyFn<'a> = Box<dyn Fn(Component, &Installed) -> bool + 'a>;
type CanaryFn<'a> = Box<dyn Fn(&Roots, &Installed) -> Result<(), PosctlError> + 'a>;

/// Everything `collect` and `health` ask of the machine. `Env::real` is the production set.
pub struct Env<'a> {
    pub state: Box<dyn Fn(Component) -> ServiceState + 'a>,
    /// The component's own health answer (never "the service says RUNNING").
    pub healthy: HealthyFn<'a>,
    pub schema: SchemaFn<'a>,
    pub profiles: ProfilesFn<'a>,
    pub rule: RuleFn<'a>,
    pub tasks: TasksFn<'a>,
    pub task_flags: TasksFn<'a>,
    /// Seconds since boot, when known.
    pub uptime: Box<dyn Fn() -> Option<u64> + 'a>,
}

impl<'a> Env<'a> {
    pub fn real(state: &'a dyn Fn(Component) -> ServiceState) -> Env<'a> {
        Env {
            state: Box::new(state),
            healthy: Box::new(|c, inst| probe::check(&probe::gate_for(c, &inst.ports), &PgTools::for_pack(&inst.pack.dir))),
            schema: Box::new(|roots, inst| {
                let psql = Psql { tools: PgTools::for_pack(&inst.pack.dir), port: inst.ports.pg(), pgpass: roots.pgpass() };
                psql.scalar("postgres", "postgres", "select coalesce(max_version,'') || '|' || applied from public.store_schema_version;")
                    .ok()
                    .and_then(|v| v.split_once('|').and_then(|(m, n)| Some((m.to_string(), n.parse().ok()?))))
            }),
            profiles: Box::new(net::read_profiles),
            rule: Box::new(net::read_rule),
            tasks: Box::new(tasks::status),
            task_flags: Box::new(tasks::scheduled_flag),
            uptime: Box::new(sys::uptime_secs),
        }
    }
}

/// A provisioned machine as the status commands see it: the pack verified at the LIGHT tier, or, when it does not
/// verify, everything except the pack. Nothing is probed through a pack that failed (the probes run `pg_isready.exe`).
pub struct Loaded {
    pub inst: Option<Installed>,
    pub ports: crate::ports::Ports,
    pub pack_version: String,
    pub pack_error: Option<String>,
}

fn load_for_report(roots: &Roots) -> Result<Loaded, PosctlError> {
    let (ports, cfg) = lifecycle::provisioned(roots)?;
    match lifecycle::load_installed_light(roots) {
        Ok(inst) => Ok(Loaded { pack_version: inst.pack.manifest.pack_version.clone(), ports: inst.ports, inst: Some(inst), pack_error: None }),
        Err(e) if e.code == Code::PackInvalid => Ok(Loaded { inst: None, ports, pack_version: cfg.pack.current, pack_error: Some(e.message) }),
        Err(e) => Err(e),
    }
}

/// Measure everything.
pub fn collect(roots: &Roots, inst: &Installed, env: &Env) -> Inputs {
    measure(roots, &Loaded { inst: None, ports: inst.ports, pack_version: inst.pack.manifest.pack_version.clone(), pack_error: None }, Some(inst), env)
}

fn measure(roots: &Roots, loaded: &Loaded, inst: Option<&Installed>, env: &Env) -> Inputs {
    let services: Vec<ServiceStatus> = Component::ALL
        .iter()
        .map(|c| {
            let st = (env.state)(*c);
            let healthy = st == ServiceState::Running && inst.is_some_and(|i| (env.healthy)(*c, i));
            ServiceStatus { component: *c, state: state_word(&st), healthy }
        })
        .collect();
    let schema_live = inst.filter(|_| services[0].healthy).and_then(|i| (env.schema)(roots, i));
    let profiles = (env.profiles)().unwrap_or_default();
    let rule_ok = (env.rule)().map(|r| net::rule_ok(&r, &loaded.ports)).unwrap_or(false);
    let canary: Option<Value> = std::fs::read_to_string(roots.canary_json()).ok().and_then(|t| serde_json::from_str(&t).ok());
    let hook_env_ok = hook_env_verdict(std::fs::read_to_string(roots.gotrue_env()), false);
    let op = op_phase(roots);
    // an unreadable journal counts as open (fail closed), exactly like `op_phase` does
    let journal_open = switch_journal_open(crate::ops::journal::Journal::read_roots(roots));
    Inputs {
        generated_at: now_rfc3339(),
        pack_version: loaded.pack_version.clone(),
        services,
        schema_live,
        schema_expected: inst.map(|i| (i.pack.manifest.migrations.max.clone(), i.pack.manifest.migrations.count)).unwrap_or_default(),
        hook_env_ok,
        canary_ok: canary.as_ref().and_then(|c| c.get("lastOk")).and_then(Value::as_bool),
        canary_at: canary.as_ref().and_then(|c| c.get("lastRunAt")).and_then(Value::as_str).map(String::from),
        disk_free_bytes: sys::free_disk_bytes(&roots.data).unwrap_or(u64::MAX),
        data_bytes: dir_size(&roots.pgdata()),
        public_network: net::any_public(&profiles),
        network_profile: if profiles.is_empty() { "unknown".into() } else if net::any_public(&profiles) { "Public".into() } else { "Private".into() },
        firewall_rule_ok: rule_ok,
        tasks: (env.tasks)().ok(),
        task_flags: (env.task_flags)().ok(),
        provisioning: roots.provision_journal().exists() && !roots.provisioned_json().exists(),
        auth_hook_error_seen: auth_log_has_hook_error(roots),
        pack_error: loaded.pack_error.clone(),
        status_stale: false,
        pki: crate::pki::facts(roots),
        op,
        recovery_exhausted: recovery_attempts_exhausted(roots),
        recover_attempts: recovery_attempts(roots),
        window_invalid: window_invalid(roots),
        update_result: crate::update::result_file::UpdateResultFile::read_roots(roots),
        rolled_back: crate::update::result_file::RolledBack::read(&roots.read_path(&roots.rolled_back_record())),
        backup: crate::backup::status::read(&crate::backup::paths::BackupPaths::from_roots(roots), crate::util::now_unix() as i64),
        switch_alert: {
            let (lock, now) = (crate::ops::lock::probe_readonly_for(roots), crate::util::now_unix() * 1000);
            crate::switch::progress::status_alert_for(&roots.update_dir(), journal_open, lock_is_live(&lock, now), hung_holder(&lock, now))
        },
        hung_alert: operation_hung_alert(&crate::ops::lock::probe_readonly_for(roots), crate::util::now_unix() * 1000),
        staging_leftover: staging_leftover_paths(roots, &crate::ops::lock::probe_readonly_for(roots), crate::util::now_unix() * 1000),
        previous_alerts: std::fs::read_to_string(roots.status_json())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("alerts").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|a| Some((a.get("code")?.as_str()?.to_string(), a.get("level")?.as_str()?.to_string(), a.get("since")?.as_str()?.to_string())))
            .collect(),
    }
}

/// How `health --canary` proves the lockout and how long it waits for its services.
pub struct Canary<'a> {
    pub run: CanaryFn<'a>,
    pub ready_wait: Duration,
    pub poll: Duration,
}

impl Canary<'static> {
    pub fn real() -> Self {
        Canary {
            run: Box::new(|roots, inst| {
                let s = crate::secrets::load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
                let psql = Psql { tools: PgTools::for_pack(&inst.pack.dir), port: inst.ports.pg(), pgpass: roots.pgpass() };
                let ep = crate::firstadmin::Endpoint { internal_url: format!("http://127.0.0.1:{}", inst.ports.gateway_internal()), anon_key: s.anon_key.clone(), service_key: s.service_role_key.clone() };
                canary::run(roots, &inst.ports, &psql, &ep, std::time::Duration::from_secs(120))
            }),
            ready_wait: CANARY_READY_WAIT,
            poll: CANARY_POLL,
        }
    }
}

/// The three services the canary talks to (the account is created through the Gateway's internal listener and
/// the grants go straight to Auth; both need the database).
const CANARY_NEEDS: [Component; 3] = [Component::Postgres, Component::Auth, Component::Gateway];

/// True once all three answer their own health probe.
fn canary_services_ready(env: &Env, inst: &Installed) -> bool {
    CANARY_NEEDS.iter().all(|c| (env.state)(*c) == ServiceState::Running && (env.healthy)(*c, inst))
}

/// Waits for the canary's services. A slow boot is not a failed lockout: `false` means "not ready by the
/// deadline" and the caller reports UNHEALTHY. Gives up at once when none of the three is running or starting
/// (a stack that was stopped on purpose is not coming up).
fn wait_for_canary_services(env: &Env, inst: &Installed, c: &Canary) -> bool {
    let start = Instant::now();
    loop {
        if canary_services_ready(env, inst) {
            return true;
        }
        let coming_up = CANARY_NEEDS.iter().any(|x| matches!((env.state)(*x), ServiceState::Running | ServiceState::StartPending));
        if !coming_up || start.elapsed() >= c.ready_wait {
            return false;
        }
        std::thread::sleep(c.poll);
    }
}

/// Does `gotrue.env` (read result) carry the lockout hook variables? A file this account may not read says nothing
/// when only reporting; the scheduled (writing) run is SYSTEM and can always read it, so a denial there is bad.
fn hook_env_verdict(read: std::io::Result<String>, write: bool) -> bool {
    match read {
        Ok(t) => render::gotrue_hook_env_ok(&t),
        Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied && !write,
    }
}

pub fn health(roots: &Roots, write: bool, run_canary: bool, state: &dyn Fn(Component) -> ServiceState, rt: &dyn Runtime) -> Result<Outcome, PosctlError> {
    health_with(roots, write, run_canary, rt, &Env::real(state), &Canary::real())
}

/// True when `health --write` should run the canary on its own: none recorded, the last run is over 26 h old, or
/// it ran before this boot (a reboot may have brought the stack up without the hook).
fn canary_due(roots: &Roots, env: &Env) -> bool {
    let last = std::fs::read_to_string(roots.canary_json())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| parse_rfc3339_utc(v.get("lastRunAt")?.as_str()?));
    let Some(last) = last else { return true };
    let age = crate::util::now_unix().saturating_sub(last);
    age > CANARY_STALE_SECS || (env.uptime)().is_some_and(|up| age > up)
}

/// Gate the sign-in stack and say what happened. `notes` get one sentence; the report says which stops failed.
fn gate(rt: &dyn Runtime, env: &Env, notes: &mut Vec<String>) -> lifecycle::StackStop {
    let report = lifecycle::gate_sign_in_stack(rt, &*env.state);
    let failed = report.notes();
    if failed.is_empty() {
        notes.push("the gateway, functions and auth services were stopped and set to manual start".into());
    }
    notes.extend(failed);
    report
}

pub fn health_with(roots: &Roots, write: bool, run_canary: bool, rt: &dyn Runtime, env: &Env, canary: &Canary) -> Result<Outcome, PosctlError> {
    let mut notes: Vec<String> = Vec::new();
    let mut report: Option<lifecycle::StackStop> = None;
    // Boot gate, first: it needs no load_installed, no update.lock and no readiness wait (a stop is the safe direction).
    let hook_ok = hook_env_verdict(std::fs::read_to_string(roots.gotrue_env()), write);
    if !hook_ok {
        notes.push("gotrue.env lacks the PIN lockout hook variables".into());
        if write {
            report = Some(gate(rt, env, &mut notes));
        }
    }
    let loaded = load_for_report(roots)?;
    if let Some(e) = &loaded.pack_error {
        notes.push(format!("the installed pack does not verify: {e}"));
    }
    let mut canary_failed = !hook_ok;
    let mut canary_errored = false;
    let mut ran_canary: Option<Result<(), PosctlError>> = None;
    // The canary creates an Auth user: a database write. While an update, switch or restore is in progress or was interrupted
    // (journal.json, or the live gateway config set aside by the fence) that write could land in a database a rollback discards.
    // fail closed (FR19): a journal that cannot be looked for counts as one
    let op_in_progress = crate::config::guard_no_operation(roots).is_err() || crate::conf::caddyfile_live_copy(roots).exists();
    let canary_wanted = hook_ok && !op_in_progress && (run_canary || (write && canary_due(roots, env)));
    if op_in_progress && hook_ok && run_canary {
        notes.push("the canary did not run: update in progress (finish or recover it first)".into());
    }
    if canary_wanted && loaded.inst.is_none() {
        notes.push("the canary did not run: the installed pack does not verify".into());
    }
    if let (true, Some(inst)) = (canary_wanted, &loaded.inst) {
        // The canary writes `canary.json` and an Auth user: one at a time, and never inside an update.
        match acquire_for(roots, LockMode::Exclusive, "health", &random_uuid_v4().map_err(PosctlError::error)?, Duration::from_secs(0)) {
            Ok(_lock) => {
                if wait_for_canary_services(env, inst, canary) {
                    ran_canary = Some((canary.run)(roots, inst));
                } else {
                    notes.push("the canary did not run: postgres, auth and the gateway were not ready in time".into());
                }
            }
            Err(e) if e.code.exit() == Code::LockHeld.exit() => notes.push("the canary did not run: another operation holds update.lock".into()),
            Err(e) => notes.push(format!("the canary did not run: {}", e.message)),
        }
    }
    let mut inputs = measure(roots, &loaded, loaded.inst.as_ref(), env);
    inputs.hook_env_ok = hook_ok;
    match &ran_canary {
        Some(Ok(())) => {
            inputs.canary_ok = Some(true);
            inputs.canary_at = Some(now_rfc3339());
        }
        Some(Err(e)) if e.code == Code::CanaryFailed => {
            notes.insert(0, e.message.clone());
            inputs.canary_ok = Some(false);
            inputs.canary_at = Some(now_rfc3339());
        }
        Some(Err(e)) => {
            // Could not be judged (timeout, 5xx, unreadable answer): not evidence about the hook, so no gate.
            canary_errored = true;
            notes.insert(0, format!("the canary could not be judged: {}", e.message));
        }
        None => {}
    }
    if inputs.canary_ok == Some(false) {
        // this run's failure, or the last recorded one: the stack stays gated until `start --canary` proves the lockout
        if !matches!(&ran_canary, Some(Err(e)) if e.code == Code::CanaryFailed) {
            notes.insert(0, "the last PIN lockout canary failed".into());
        }
        canary_failed = true;
    }
    // the updater owns service state during an operation: a Health tick never gates mid-operation (an earlier
    // recorded failure still gates once the operation has ended)
    // the updater owns service state during an operation: a Health tick never gates mid-operation (an earlier
    // recorded failure still gates once the operation has ended)
    if write && canary_failed && !op_in_progress && report.is_none() {
        report = Some(gate(rt, env, &mut notes));
    }
    if let Some(r) = &report {
        // what the gate stopped is reported stopped; what refused to stop keeps its state
        let stack = services::with_dependents(Component::Auth);
        for s in inputs.services.iter_mut().filter(|s| stack.contains(&s.component) && s.state != "not-installed" && !r.stop_failed.iter().any(|(c, _)| *c == s.component)) {
            s.state = "stopped".into();
            s.healthy = false;
        }
    }
    let status = build_status(&inputs);
    if write {
        write_atomic(&roots.status_json(), serde_json::to_string_pretty(&status)?.as_bytes())?;
        // a LAN pairing offer is fetchable only while it lives: expired (or unreadable) offers go every minute
        crate::pairing::sweep_expired_offers(&roots.pairing_offers(), crate::util::now_unix() as i64);
    }
    let mut code = health_code(&status, canary_failed);
    if canary_errored && matches!(code, Code::Ok | Code::Degraded) {
        code = Code::Unhealthy;
    }
    if matches!(inputs.op, OpPhase::Updating | OpPhase::Switching | OpPhase::Restoring) {
        notes.push("an update, switch or restore is in progress; the stack is stopped on purpose".into());
    }
    let message = match (code, notes.is_empty()) {
        (Code::Ok, true) => "healthy".to_string(),
        (Code::Ok, false) => format!("healthy; {}", notes.join("; ")),
        (_, false) => notes.join("; "),
        (c, true) => c.name().to_lowercase().replace('_', " "),
    };
    Ok(Outcome::with_code(code, message, status))
}

/// `status`: the last written file when it is fresh, else measure now. `--refresh` always measures.
pub fn status(roots: &Roots, refresh: bool, state: &dyn Fn(Component) -> ServiceState) -> Result<Outcome, PosctlError> {
    status_with(roots, refresh, &Env::real(state))
}

pub fn status_with(roots: &Roots, refresh: bool, env: &Env) -> Result<Outcome, PosctlError> {
    let loaded = load_for_report(roots)?;
    // CR-I2: a file nothing has refreshed (the Health task is gone) is never served as current, and says so in the measured answer
    let mut stale = false;
    if let Ok(text) = std::fs::read_to_string(roots.status_json()) {
        let prev = serde_json::from_str::<Value>(&text).ok();
        stale = status_file_stale(prev.as_ref().and_then(|v| v.get("generatedAt")).and_then(Value::as_str), crate::util::now_unix());
        if !refresh && !stale {
            let fresh = std::fs::metadata(roots.status_json()).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|age| age < Duration::from_secs(180)).unwrap_or(false);
            if let (true, Some(v)) = (fresh, prev) {
                return Ok(Outcome::ok("status (from the last health run)", v));
            }
        }
    }
    let mut inputs = measure(roots, &loaded, loaded.inst.as_ref(), env);
    inputs.status_stale = stale;
    let v = build_status(&inputs);
    // the file is a cache: a standard user who cannot write `state\` still gets the answer
    let _ = write_atomic(&roots.status_json(), serde_json::to_string_pretty(&v)?.as_bytes());
    Ok(Outcome::ok("status", v))
}

pub fn scm_state(c: Component) -> ServiceState {
    services::query_state(c).unwrap_or(ServiceState::Other("unknown".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PosctlJson;
    use crate::lifecycle::test_support::Scm;
    use std::cell::{Cell, RefCell};

    fn inputs() -> Inputs {
        Inputs {
            generated_at: "2026-10-02T12:00:00Z".into(),
            pack_version: "1.0.0-r1".into(),
            services: Component::ALL.iter().map(|c| ServiceStatus { component: *c, state: "running".into(), healthy: true }).collect(),
            schema_live: Some(("20260101000002".into(), 2)),
            schema_expected: ("20260101000002".into(), 2),
            hook_env_ok: true,
            canary_ok: Some(true),
            canary_at: Some("2026-10-02T03:00:00Z".into()),
            disk_free_bytes: 50 * 1024 * 1024 * 1024,
            data_bytes: 1000,
            public_network: false,
            network_profile: "Private".into(),
            firewall_rule_ok: true,
            tasks: Some(vec![("Health".into(), true), ("Canary".into(), true)]),
            task_flags: Some(vec![("Recover".into(), true), ("UpdateCheck".into(), true)]),
            provisioning: false,
            status_stale: false,
            previous_alerts: vec![],
            auth_hook_error_seen: false,
            pack_error: None,
            pki: None,
            op: OpPhase::None,
            recovery_exhausted: false,
            recover_attempts: vec![],
            window_invalid: false,
            update_result: Default::default(),
            rolled_back: None,
            backup: crate::backup::status::Computed::quiet(),
            switch_alert: None,
            hung_alert: None,
            staging_leftover: vec![],
        }
    }

    #[test]
    fn only_a_live_exclusive_lock_holder_counts_as_a_running_operation() {
        use crate::ops::lock::{acquire_for, probe_readonly_for, LockMode, LockState};
        assert!(!lock_is_live(&LockState::Free, 1) && !lock_is_live(&LockState::SharedHeld, 1));
        assert!(!lock_is_live(&LockState::Unknown("denied".into()), 1), "liveness undeterminable: not running, so the alert shows");
        let held = |kind: &str| LockState::ExclusiveHeld(crate::ops::lock::LockInfo { pid: 1, op_id: "x".into(), kind: kind.into(), started_ms: 1 });
        for k in ["switch", "switch-rollback", "update", "recover", "restore"] {
            assert!(lock_is_live(&held(k), 1_000), "{k}");
        }
        for k in ["housekeeping", "backup", "prune", "", "something-new"] {
            assert!(!lock_is_live(&held(k), 1_000), "{k:?}: a holder that is not an operation (or unknown) never hides the alert");
        }
        // a holder that has held the lock longer than any legal run is hung: it does not hide the alert
        // (the held() holder started at 1 ms) older than the ceiling: not live; at or under it: live
        assert!(lock_is_live(&held("switch"), 1 + RUN_CEILING_MS) && !lock_is_live(&held("switch"), 1 + RUN_CEILING_MS + 1));
        // derived, through the behaviour: a switch that began as early as possible and took the longest legal time is still live, with an
        // hour of margin (the longest wait and its drain grace, the work budget, one overshoot, the freeze window that bounds a rollback)
        let longest_legal_ms = ((crate::switch::work::MAX_WAIT_MINUTES + crate::switch::work::DRAIN_GRACE_MINUTES + crate::commands::switch::FREEZE_MINUTES) as u64 * 60
            + crate::commands::switch::WORK_BUDGET_SECS + crate::commands::switch::SQL_OVERSHOOT_SECS) * 1000;
        assert!(lock_is_live(&held("switch"), 1 + longest_legal_ms), "the longest legal run is never taken for a hung one");
        assert!(lock_is_live(&held("switch"), 1 + longest_legal_ms + 3_599_000), "and an hour later it is still live");
        assert!(!lock_is_live(&held("switch"), 1 + longest_legal_ms + 3_600_000 + 1), "past the margin it is hung");
        assert_eq!(RUN_CEILING_MS, longest_legal_ms + 3_600_000, "the ceiling is the longest legal run plus one hour");
        // the alert, with an injected clock: a stuck-in-moved switch whose lock holder is hung (older than the ceiling) alerts; a younger one does not
        let dir = tempfile::tempdir().unwrap();
        crate::switch::progress::write(dir.path(), &crate::switch::progress::Progress { phase: "committed".into(), cloud: "moved".into(), updated_ms: 1, op_id: Some("op-1".into()) }).unwrap();
        let at = |now: u64| crate::switch::progress::status_alert(dir.path(), true, lock_is_live(&held("switch"), now));
        assert!(at(1_000).is_none(), "a young holder is a run in progress");
        assert_eq!(at(1 + RUN_CEILING_MS + 1).unwrap().0, "SWITCH_CLOUD_MAY_BE_MOVED", "a holder older than any legal run is hung: alert");
        // a holder start time that cannot be read is no holder at all (SharedHeld): not live, alert
        assert!(!lock_is_live(&LockState::SharedHeld, 1_000));
        use crate::ops::{journal::{Journal as J, JournalError}, outcome::OpKind as K};
        let jk = |k| Ok(Some(J::new(k, "op", 1, 2, None, None)));
        assert!(switch_journal_open(jk(K::Switch)) && !switch_journal_open(jk(K::Update)) && !switch_journal_open(jk(K::Restore)) && !switch_journal_open(Ok(None)));
        assert!(switch_journal_open(Err(JournalError::Io("denied".into()))), "unreadable: counts as open");
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        // a stuck-in-moved run: journal open, progress moved, nobody holds the lock => alert
        crate::switch::progress::write(&roots.update_dir(), &crate::switch::progress::Progress { phase: "committed".into(), cloud: "moved".into(), updated_ms: 5, op_id: Some("op-1".into()) }).unwrap();
        crate::ops::journal::Journal::new(crate::ops::outcome::OpKind::Switch, "op-1", 1, 2, Some("a".into()), Some("a".into())).write(&roots.update_dir()).unwrap();
        let alert = |r: &Roots| crate::switch::progress::status_alert(&r.update_dir(), true, lock_is_live(&probe_readonly_for(r), crate::util::now_unix() * 1000));
        assert_eq!(alert(&roots).unwrap().0, "SWITCH_CLOUD_MAY_BE_MOVED", "open journal, no holder, moved");
        let _g = acquire_for(&roots, LockMode::Exclusive, "switch", "op-1", std::time::Duration::ZERO).unwrap();
        assert!(alert(&roots).is_none(), "a live holder: the run is in progress");
    }

    #[test]
    fn the_stuck_in_moved_alert_names_the_hung_holders_pid_and_the_update_recover_step() {
        use crate::ops::lock::{LockInfo, LockState};
        use crate::switch::progress::{status_alert_for, Holder};
        let held = |kind: &str, pid: u32| LockState::ExclusiveHeld(LockInfo { pid, op_id: "op-1".into(), kind: kind.into(), started_ms: 1 });
        let late = 1 + RUN_CEILING_MS + 1;
        assert_eq!(hung_holder(&held("switch", 4242), 1_000), Holder::Nobody, "a young holder is a run in progress: nothing to stop");
        assert_eq!(hung_holder(&held("switch", 4242), late), Holder::Pid(4242));
        assert_eq!(hung_holder(&held("backup", 7), late), Holder::Nobody, "a backup is not a hung switch");
        assert_eq!(hung_holder(&LockState::Free, late), Holder::Nobody);
        assert_eq!(hung_holder(&LockState::SharedHeld, late), Holder::Nobody, "a shared holder is a backup: no PID advice");
        assert_eq!(hung_holder(&LockState::Unknown("denied".into()), late), Holder::Unreadable);
        let dir = tempfile::tempdir().unwrap();
        crate::switch::progress::write(dir.path(), &crate::switch::progress::Progress { phase: "committed".into(), cloud: "moved".into(), updated_ms: 1, op_id: Some("op-1".into()) }).unwrap();
        let alert = |l: &LockState, now: u64| status_alert_for(dir.path(), true, lock_is_live(l, now), hung_holder(l, now));
        let (code, msg, _) = alert(&held("switch", 4242), late).unwrap();
        assert_eq!(code, "SWITCH_CLOUD_MAY_BE_MOVED");
        assert!(msg.contains("process id 4242") && msg.contains("never by image name"), "{msg}");
        assert!(msg.contains("posctl update --recover") && msg.contains("exit 17") && msg.contains("`posctl switch rollback op-1`"), "{msg}");
        assert!(msg.contains("confirm that PID is posctl.exe") && msg.contains("tasklist"), "{msg}");
        let (_, msg, _) = alert(&LockState::Unknown("denied".into()), late).unwrap();
        assert!(msg.contains("update.lock.info") && !msg.contains("process id 4242") && msg.contains("update --recover"), "{msg}");
        let (_, msg, _) = alert(&LockState::Free, late).unwrap();
        assert!(!msg.contains("process id") && msg.contains("update --recover"), "a dead process holds nothing: {msg}");
    }

    #[test]
    fn a_hung_operation_raises_operation_hung_with_its_pid_whatever_the_progress_says_and_frees_nothing() {
        use crate::ops::lock::{acquire_for, probe_readonly_for, LockInfo, LockMode, LockState};
        let held = |kind: &str, pid: u32| LockState::ExclusiveHeld(LockInfo { pid, op_id: "op-1".into(), kind: kind.into(), started_ms: 1 });
        let late = 1 + RUN_CEILING_MS + 1;
        // a run hung before the move: progress `held`, journal open. The in-move alert says nothing about it; OPERATION_HUNG does.
        let dir = tempfile::tempdir().unwrap();
        crate::switch::progress::write(dir.path(), &crate::switch::progress::Progress { phase: "verifying".into(), cloud: "held".into(), updated_ms: 1, op_id: Some("op-1".into()) }).unwrap();
        let l = held("switch", 4242);
        assert!(crate::switch::progress::status_alert_for(dir.path(), true, lock_is_live(&l, late), hung_holder(&l, late)).is_none());
        let (code, msg, since) = operation_hung_alert(&l, late).expect("an ancient switch holder is hung");
        assert_eq!((code.as_str(), since), ("OPERATION_HUNG", 1));
        for needle in ["process id 4242", "never by image name", "tasklist /FI \"PID eq 4242\"", "posctl update --recover", "Nothing is freed automatically", "switch rollback"] {
            assert!(msg.contains(needle), "{needle}: {msg}");
        }
        // an update has no switch rollback to run
        assert!(!operation_hung_alert(&held("update", 9), late).unwrap().1.contains("switch rollback"));
        // a young holder is a run in progress; a backup, a shared holder, a free or unreadable lock are not a hung operation
        assert!(operation_hung_alert(&l, 1_000).is_none() && operation_hung_alert(&l, 1 + RUN_CEILING_MS).is_none());
        for s in [held("backup", 7), held("housekeeping", 7), LockState::SharedHeld, LockState::Free, LockState::Unknown("denied".into())] {
            assert!(operation_hung_alert(&s, late).is_none(), "not an operation holder");
        }
        // it reaches the alert list, critical
        let mut i = inputs();
        i.hung_alert = operation_hung_alert(&l, late);
        let a = build_alerts(&i);
        assert_eq!(a.iter().find(|a| a["code"] == "OPERATION_HUNG").expect("in the list")["level"], "critical");
        // alert only: computing it frees nothing and kills nothing; the real lock is still held afterwards
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        let _g = acquire_for(&roots, LockMode::Exclusive, "switch", "op-1", std::time::Duration::ZERO).unwrap();
        assert!(operation_hung_alert(&probe_readonly_for(&roots), u64::MAX / 2).is_some());
        assert!(matches!(probe_readonly_for(&roots), LockState::ExclusiveHeld(_)), "the holder is still there");
        assert!(acquire_for(&roots, LockMode::Exclusive, "update", "x", std::time::Duration::ZERO).is_err(), "and the lock is still not free");
    }

    #[test]
    fn leftover_switch_staging_raises_a_critical_alert_naming_the_path_and_nothing_otherwise() {
        use crate::ops::lock::{LockInfo, LockState};
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::create_dir_all(roots.backups()).unwrap();
        let free = LockState::Free;
        // absent: no alert
        let mut i = inputs();
        i.staging_leftover = staging_leftover_paths(&roots, &free, 1);
        assert!(i.staging_leftover.is_empty());
        assert!(!build_alerts(&i).iter().any(|a| a["code"] == "SWITCH_STAGING_LEFTOVER"));
        // look-alikes only: still none (the progress file, the bare prefixes, the other folder's name)
        std::fs::write(roots.update_dir().join("switch-progress.json"), "{}").unwrap();
        std::fs::create_dir(roots.update_dir().join("cloud-pgpass-")).unwrap();
        std::fs::create_dir(roots.backups().join("cloud-pgpass-x")).unwrap();
        assert!(staging_leftover_paths(&roots, &free, 1).is_empty());
        // present: critical, names the path and the command, keeps its first-seen time
        let pg = roots.update_dir().join("cloud-pgpass-dead");
        std::fs::create_dir(&pg).unwrap();
        std::fs::create_dir(roots.backups().join("switch-dead")).unwrap();
        i.staging_leftover = staging_leftover_paths(&roots, &free, 1);
        assert_eq!(i.staging_leftover.len(), 2);
        i.previous_alerts = vec![("SWITCH_STAGING_LEFTOVER".into(), "critical".into(), "2026-10-01T00:00:00Z".into())];
        let a = build_alerts(&i);
        let x = a.iter().find(|a| a["code"] == "SWITCH_STAGING_LEFTOVER").expect("raised");
        assert_eq!((x["level"].as_str(), x["since"].as_str()), (Some("critical"), Some("2026-10-01T00:00:00Z")));
        let m = x["message"].as_str().unwrap();
        assert!(m.contains("posctl update --recover") && (m.contains("cloud-pgpass-dead") || m.contains("switch-dead")), "{m}");
        assert!(m.contains('2'), "the count is named: {m}");
        // alert only: it removed nothing
        assert!(pg.exists());
        // a live operation (or a shared holder) owns its own staging: no alert then; a hung holder or an unreadable lock does not hide it
        let held = |started_ms: u64| LockState::ExclusiveHeld(LockInfo { pid: 7, op_id: "op".into(), kind: "switch".into(), started_ms });
        let now = RUN_CEILING_MS * 2;
        assert!(staging_leftover_paths(&roots, &held(now - 10), now).is_empty(), "a running switch");
        assert!(staging_leftover_paths(&roots, &LockState::SharedHeld, now).is_empty(), "a plan");
        assert_eq!(staging_leftover_paths(&roots, &LockState::Unknown("denied".into()), now).len(), 2);
        assert_eq!(staging_leftover_paths(&roots, &held(1), now).len(), 2, "a hung holder");
    }

    #[test]
    fn the_leftover_alert_names_every_path_up_to_the_cap_then_a_more_tail_and_the_way_out() {
        let paths = |n: usize| (0..n).map(|k| format!("C:\\d\\cloud-pgpass-{k}")).collect::<Vec<_>>();
        let m = staging_leftover_message(&paths(LEFTOVER_PATHS_SHOWN));
        assert!(paths(LEFTOVER_PATHS_SHOWN).iter().all(|p| m.contains(p)) && !m.contains("more"), "{m}");
        let m = staging_leftover_message(&paths(LEFTOVER_PATHS_SHOWN + 3));
        assert!(m.starts_with(&format!("{} folder(s)", LEFTOVER_PATHS_SHOWN + 3)), "{m}");
        assert!(paths(LEFTOVER_PATHS_SHOWN).iter().all(|p| m.contains(p)), "{m}");
        assert!(!m.contains(&format!("cloud-pgpass-{LEFTOVER_PATHS_SHOWN}")) && m.contains("+3 more"), "{m}");
        for needle in ["posctl update --recover", "delete the named path(s) by hand", "cloud database password"] { assert!(m.contains(needle), "{needle}: {m}"); }
        // through build_alerts, and still there with the same list after a recovery that found no journal (nothing removes it)
        let mut i = inputs();
        i.staging_leftover = paths(7);
        let a = build_alerts(&i);
        assert_eq!(a.iter().find(|a| a["code"] == "SWITCH_STAGING_LEFTOVER").unwrap()["message"].as_str(), Some(staging_leftover_message(&paths(7)).as_str()));
    }

    #[test]
    fn status_alert_reaches_build_alerts() {
        let mut i = inputs();
        assert!(!build_alerts(&i).iter().any(|a| a["code"].as_str().is_some_and(|c| c.starts_with("SWITCH_"))));
        i.switch_alert = Some(("SWITCH_CLOUD_MAY_BE_MOVED".into(), "run `posctl switch rollback op-9`".into(), 1_790_908_215_000));
        let a = build_alerts(&i);
        let x = a.iter().find(|a| a["code"] == "SWITCH_CLOUD_MAY_BE_MOVED").expect("the alert is in the list");
        assert_eq!(x["level"], "critical");
        assert_eq!(x["since"], crate::util::rfc3339_utc(1_790_908_215), "first seen: the moment the switch recorded it");
        assert!(x["message"].as_str().unwrap().contains("op-9"));
        // an alert that was already in the previous file keeps its first-seen time
        i.previous_alerts = vec![("SWITCH_CLOUD_MAY_BE_MOVED".into(), "critical".into(), "2026-10-01T00:00:00Z".into())];
        let a = build_alerts(&i);
        assert_eq!(a.iter().find(|a| a["code"] == "SWITCH_CLOUD_MAY_BE_MOVED").unwrap()["since"], "2026-10-01T00:00:00Z");
    }

    #[test]
    fn the_held_alert_follows_the_journal_file_on_disk() {
        use crate::ops::journal::Journal;
        use crate::ops::outcome::OpKind;
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        crate::switch::progress::write(&roots.update_dir(), &crate::switch::progress::Progress { phase: "draining".into(), cloud: "held".into(), updated_ms: 5, op_id: Some("op-1".into()) }).unwrap();
        // the `measure` rule, spelled out: a held cloud with the journal open is a run, not an alert
        let open = |r: &Roots| !matches!(Journal::read_roots(r), Ok(None));
        assert!(!open(&roots));
        assert!(crate::switch::progress::status_alert(&roots.update_dir(), open(&roots), false).is_some());
        Journal::new(OpKind::Switch, "op-1", 1, 2, Some("a".into()), Some("a".into())).write(&roots.update_dir()).unwrap();
        assert!(open(&roots));
        assert!(crate::switch::progress::status_alert(&roots.update_dir(), open(&roots), false).is_none());
    }

    fn with_root_days_left(days: i64) -> Inputs {
        let mut i = inputs();
        let now = i64::try_from(parse_rfc3339_utc(&i.generated_at).unwrap()).unwrap();
        i.pki = Some(crate::pki::PkiFacts { root_sha256: "ab".repeat(32), root_not_after_unix: now + days * 86_400 + 3600, leaf_not_after_unix: Some(now + 3600), hosts: vec!["shop".into()] });
        i
    }

    fn cert_alerts(i: &Inputs) -> Vec<Value> {
        build_alerts(i).into_iter().filter(|a| a["code"] == "CERT_EXPIRING").collect()
    }

    #[test]
    fn four_months_left_fills_the_pki_section_and_raises_nothing() {
        let i = with_root_days_left(120);
        assert!(cert_alerts(&i).is_empty());
        let s = build_status(&i);
        assert_eq!(s["pki"]["daysLeft"], 120);
        assert_eq!(s["pki"]["hosts"], json!(["shop"]));
        assert!(s["pki"]["rootSha256"].is_string() && s["pki"]["leafNotAfter"].is_string());
    }

    #[test]
    fn twenty_days_left_warns_and_keeps_the_first_seen_since() {
        let mut i = with_root_days_left(20);
        let first = cert_alerts(&i);
        assert_eq!((first[0]["level"].clone(), first[0]["since"].clone()), (json!("warn"), json!("2026-10-02T12:00:00Z")));
        i.generated_at = "2026-10-03T12:00:00Z".into();
        i.pki.as_mut().unwrap().root_not_after_unix += 86_400;
        i.previous_alerts = vec![("CERT_EXPIRING".into(), "warn".into(), "2026-10-02T12:00:00Z".into())];
        assert_eq!(cert_alerts(&i)[0]["since"], json!("2026-10-02T12:00:00Z"));
    }

    #[test]
    fn eighty_days_left_is_the_first_warning() {
        assert_eq!(cert_alerts(&with_root_days_left(80))[0]["level"], json!("warn"));
        assert!(cert_alerts(&with_root_days_left(100)).is_empty());
    }

    #[test]
    fn five_days_left_is_critical() {
        assert_eq!(cert_alerts(&with_root_days_left(5))[0]["level"], json!("critical"));
    }

    #[test]
    fn a_leaf_past_its_end_on_a_running_gateway_warns_but_a_stopped_gateway_does_not() {
        let mut i = with_root_days_left(400);
        i.pki.as_mut().unwrap().leaf_not_after_unix = Some(0);
        assert_eq!(cert_alerts(&i)[0]["level"], json!("warn"));
        for s in i.services.iter_mut().filter(|s| s.component == Component::Gateway) {
            s.healthy = false;
        }
        assert!(cert_alerts(&i).is_empty());
    }

    #[test]
    fn no_tls_means_a_null_pki_section_and_no_certificate_alert() {
        let i = inputs();
        assert!(cert_alerts(&i).is_empty());
        assert!(build_status(&i)["pki"]["rootSha256"].is_null());
    }

    #[test]
    fn a_hook_error_in_the_auth_log_raises_auth_hook_error() {
        let mut i = inputs();
        i.auth_hook_error_seen = true;
        let a = build_alerts(&i);
        assert_eq!((a[0]["code"].clone(), a[0]["level"].clone()), (json!("AUTH_HOOK_ERROR"), json!("critical")));
        assert!(log_tail_has_hook_error("{\"level\":\"error\",\"msg\":\"Hook errored out\"}\n"));
        assert!(!log_tail_has_hook_error("{\"level\":\"info\",\"msg\":\"request completed\"}\n"));
    }

    #[test]
    fn an_alert_keeps_its_first_seen_since_while_it_persists() {
        let mut first = inputs();
        first.public_network = true;
        let a1 = build_alerts(&first);
        assert_eq!(a1[0]["since"], "2026-10-02T12:00:00Z");
        let mut later = first.clone();
        later.generated_at = "2026-10-02T12:07:00Z".into();
        later.previous_alerts = a1.iter().map(|a| (a["code"].as_str().unwrap().into(), a["level"].as_str().unwrap().into(), a["since"].as_str().unwrap().into())).collect();
        assert_eq!(build_alerts(&later)[0]["since"], "2026-10-02T12:00:00Z", "same code and level keeps the old since");
        // a level change is a new event; a cleared and re-raised alert starts over
        later.disk_free_bytes = 100;
        later.previous_alerts = vec![("DISK_LOW".into(), "warn".into(), "2026-10-02T11:00:00Z".into())];
        let disk = build_alerts(&later).into_iter().find(|a| a["code"] == "DISK_LOW").unwrap();
        assert_eq!((disk["level"].clone(), disk["since"].clone()), (json!("critical"), json!("2026-10-02T12:07:00Z")));
        later.previous_alerts = vec![];
        assert_eq!(build_alerts(&later)[0]["since"], "2026-10-02T12:07:00Z");
    }

    #[test]
    fn a_healthy_machine_has_the_documented_shape_and_exits_ok() {
        let s = build_status(&inputs());
        for k in ["schema", "generatedAt", "mode", "state", "packVersion", "posctlVersion", "services", "database", "lockoutHook", "backup", "disk", "network", "tasks", "pki", "update", "alerts"] {
            assert!(s.get(k).is_some(), "missing {k}");
        }
        assert_eq!((s["schema"].clone(), s["state"].clone(), s["mode"].clone()), (json!(1), json!("running"), json!("offline-only")));
        for c in ["Postgres", "Auth", "Rest", "Functions", "Gateway"] {
            assert_eq!(s["services"][c]["healthy"], true, "{c}");
        }
        assert_eq!(s["database"], json!({"maxVersion": "20260101000002", "applied": 2, "expected": {"maxVersion": "20260101000002", "applied": 2}}));
        assert_eq!(s["lockoutHook"], json!({"envOk": true, "canaryOk": true, "canaryAt": "2026-10-02T03:00:00Z"}));
        assert_eq!(s["tasks"], json!({"Health": true, "Canary": true}));
        assert_eq!(s["backup"]["alert"], "none");
        assert_eq!(s["alerts"], json!([]));
        assert_eq!(health_code(&s, false), Code::Ok);
    }

    #[test]
    fn alert_catalog_matches_status_codes() {
        let catalog: Value = serde_json::from_str(include_str!("../../src/shared/lib/store-alert-catalog.json")).unwrap();
        let mut in_catalog: Vec<&str> = catalog.as_object().unwrap().keys().map(String::as_str).collect();
        in_catalog.sort_unstable();
        let mut in_code: Vec<&str> = ALERT_CODES.to_vec();
        in_code.sort_unstable();
        assert_eq!(in_catalog, in_code, "the app catalog and ALERT_CODES must list the same codes");
    }

    #[test]
    fn every_alert_the_tests_can_raise_is_a_listed_code() {
        let mut i = inputs();
        i.public_network = true;
        i.disk_free_bytes = 100;
        i.hook_env_ok = false;
        i.schema_live = Some(("20260101000001".into(), 1));
        i.tasks = Some(vec![("Health".into(), false)]);
        for a in build_alerts(&i) {
            let code = a["code"].as_str().unwrap();
            assert!(ALERT_CODES.contains(&code), "{code} is not in ALERT_CODES");
        }
    }

    /// The page and the banner parse exactly this file in Vitest (`store-status.test.ts`). Regenerate with
    /// `UPDATE_GOLDEN=1 cargo test --lib golden_status_json`.
    #[test]
    fn golden_status_json_matches_the_committed_fixture() {
        let mut i = inputs();
        i.public_network = true;
        i.disk_free_bytes = 2 * 1024 * 1024 * 1024;
        let text = serde_json::to_string_pretty(&build_status(&i)).unwrap() + "\n";
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/shared/lib/store-status.golden.json");
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::write(path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap().replace("\r\n", "\n"), text);
    }

    #[test]
    fn the_status_file_never_contains_a_secret_a_path_or_an_address() {
        let text = build_status(&inputs()).to_string();
        for bad in ["C:\\", "127.0.0.1", "192.168.", "password", "secret", "service_role", "eyJ"] {
            assert!(!text.contains(bad), "{bad}");
        }
    }

    #[test]
    fn each_condition_raises_its_alert() {
        let code = |f: &dyn Fn(&mut Inputs)| {
            let mut i = inputs();
            f(&mut i);
            build_alerts(&i).iter().map(|a| a["code"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(code(&|i| i.public_network = true), ["NETWORK_PROFILE_PUBLIC"]);
        assert_eq!(code(&|i| i.disk_free_bytes = 2 * 1024 * 1024 * 1024), ["DISK_LOW"]);
        assert_eq!(code(&|i| i.disk_free_bytes = 100), ["DISK_LOW"]);
        assert_eq!(code(&|i| i.schema_live = Some(("20260101000001".into(), 1))), ["SCHEMA_MISMATCH"]);
        assert_eq!(code(&|i| i.hook_env_ok = false), ["LOCKOUT_HOOK_INACTIVE"]);
        assert_eq!(code(&|i| i.canary_ok = Some(false)), ["LOCKOUT_HOOK_INACTIVE"]);
        // provisioned but a scheduled task is gone (an installer that died between `tasks remove` and `tasks install`)
        assert_eq!(code(&|i| i.tasks = Some(vec![("Health".into(), false), ("Canary".into(), false)])), ["TASKS_MISSING"]);
        assert!(code(&|i| i.tasks = None).is_empty(), "an unreadable scheduler is not a missing task");
        assert!(code(&|i| {
            i.tasks = Some(vec![("Health".into(), false)]);
            i.provisioning = true;
        })
        .is_empty(), "a provision in flight has not scheduled them yet");
        let mut t = inputs();
        t.tasks = Some(vec![("Health".into(), false)]);
        assert!(build_alerts(&t)[0]["message"].as_str().unwrap().contains("posctl tasks install"));
        assert!(code(&|i| i.schema_live = None).is_empty(), "an unreadable database is a service problem, not a schema alert");
        let mut crit = inputs();
        crit.disk_free_bytes = 100;
        assert_eq!(build_alerts(&crit)[0]["level"], "critical");
    }

    #[test]
    fn the_exit_code_follows_the_worst_condition() {
        let ok = build_status(&inputs());
        assert_eq!(health_code(&ok, true), Code::CanaryFailed);
        let mut down = inputs();
        down.services[2].healthy = false;
        down.services[2].state = "stopped".into();
        let s = build_status(&down);
        assert_eq!((s["state"].clone(), health_code(&s, false)), (json!("degraded"), Code::Unhealthy));
        assert_eq!(health_code(&s, true), Code::CanaryFailed, "22 outranks 20");
        let mut warn = inputs();
        warn.public_network = true;
        assert_eq!(health_code(&build_status(&warn), false), Code::Degraded);
        let mut both = down.clone();
        both.public_network = true;
        assert_eq!(health_code(&build_status(&both), false), Code::Unhealthy, "20 outranks 21");
    }

    #[test]
    fn state_words() {
        let mut i = inputs();
        i.provisioning = true;
        assert_eq!(derive_state(&i), "provisioning");
        let mut stopped = inputs();
        for s in &mut stopped.services {
            s.healthy = false;
            s.state = "stopped".into();
        }
        assert_eq!(derive_state(&stopped), "stopped");
    }

    // ---- health against a provisioned dev root with fakes

    fn provisioned(d: &tempfile::TempDir, hook_ok: bool) -> Roots {
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::create_dir_all(roots.conf()).unwrap();
        std::fs::create_dir_all(roots.secrets()).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let p = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&p).unwrap();
        crate::pack::make_fake_pack(&p, "1.0.0-r1");
        PosctlJson::new("offline-only", "id", 47990, "shop", "1.0.0-r1").save(&roots).unwrap();
        let env = if hook_ok { format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true
GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}
", render::HOOK_URI) } else { "OTHER=1\n".to_string() };
        std::fs::write(roots.gotrue_env(), env).unwrap();
        roots
    }

    fn fake_env<'a>(state: &'a dyn Fn(Component) -> ServiceState, healthy: &'a dyn Fn(Component) -> bool) -> Env<'a> {
        Env {
            state: Box::new(state),
            healthy: Box::new(move |c, _| healthy(c)),
            schema: Box::new(|_, _| Some(("20260101000002".into(), 2))),
            profiles: Box::new(|| Ok(vec![])),
            rule: Box::new(|| Ok(vec![])),
            tasks: Box::new(|| Ok(vec![("Health".into(), true)])),
            task_flags: Box::new(|| Ok(vec![("Recover".into(), true), ("UpdateCheck".into(), true)])),
            uptime: Box::new(|| None),
        }
    }

    fn canary_of<'a>(f: impl Fn() -> Result<(), PosctlError> + 'a) -> Canary<'a> {
        Canary { run: Box::new(move |_, _| f()), ready_wait: Duration::ZERO, poll: Duration::from_millis(1) }
    }

    fn running(_: Component) -> ServiceState {
        ServiceState::Running
    }

    #[test]
    fn health_write_removes_expired_pairing_offers_and_keeps_live_ones() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let offers = roots.pairing_offers();
        std::fs::create_dir_all(&offers).unwrap();
        let rec = |exp: &str| format!(r#"{{"v":1,"mode":"offline-only","serverHost":"s","serverPort":47304,"anonKey":"a.b.c","rootCertPem":"","rootSha256":"","issuedAt":"","expiresAt":"{exp}"}}"#);
        std::fs::write(offers.join("AAAAAAAA.pospair"), rec("2099-01-01T00:00:00Z")).unwrap();
        std::fs::write(offers.join("BBBBBBBB.pospair"), rec("2020-01-01T00:00:00Z")).unwrap();
        let scm = Scm::all_running();
        let st = |_: Component| ServiceState::Stopped;
        let ok = |_: Component| true;
        health_with(&roots, true, false, &scm, &fake_env(&st, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(offers.join("AAAAAAAA.pospair").exists() && !offers.join("BBBBBBBB.pospair").exists());
        // a read-only health (no --write) sweeps nothing
        std::fs::write(offers.join("CCCCCCCC.pospair"), rec("2020-01-01T00:00:00Z")).unwrap();
        health_with(&roots, false, false, &scm, &fake_env(&st, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(offers.join("CCCCCCCC.pospair").exists());
    }

    #[test]
    fn health_write_replaces_the_status_file_atomically_on_a_provisioned_dev_root() {
        // Services are reported stopped, so the exit is UNHEALTHY, but the file is still written.
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let st = |_: Component| ServiceState::Stopped;
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&st, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::Unhealthy);
        let written: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert_eq!(written["state"], "stopped");
        assert_eq!(written["packVersion"], "1.0.0-r1");
        assert!(scm.calls.borrow().is_empty(), "stopped services with good hook variables are left alone");
        let leftovers = std::fs::read_dir(roots.state()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_healthy_stack_with_a_passing_canary_exits_ok_and_stops_nothing() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, true, true, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        // a real dev machine may report low disk; only the stop behaviour and the canary record are pinned here
        assert_ne!(out.code, Code::CanaryFailed);
        assert!(scm.calls.borrow().is_empty());
        assert_eq!(out.data["lockoutHook"]["canaryOk"], json!(true));
    }

    #[test]
    fn missing_hook_variables_stop_gateway_functions_then_auth_and_record_exit_22() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert_eq!(*scm.calls.borrow(), vec!["stop Gateway", "stop Functions", "stop Auth"]);
        let written: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert_eq!(written["lockoutHook"]["envOk"], json!(false));
        assert_eq!(written["services"]["Gateway"]["state"], "stopped");
        assert_eq!(written["services"]["Postgres"]["state"], "running", "only the sign-in stack is stopped");
        assert!(written["alerts"].as_array().unwrap().iter().any(|a| a["code"] == "LOCKOUT_HOOK_INACTIVE"));
    }

    #[test]
    fn without_write_nothing_is_stopped_but_the_code_is_still_22() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, false, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert!(scm.calls.borrow().is_empty());
        assert!(!roots.status_json().exists());
    }

    #[test]
    fn a_failing_canary_stops_the_stack_and_exits_22() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let canary = canary_of(|| Err(PosctlError::new(Code::CanaryFailed, "the PIN lockout hook is not active")));
        let out = health_with(&roots, true, true, &scm, &fake_env(&running, &ok), &canary).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert!(out.message.contains("not active") && out.message.contains("were stopped"), "{}", out.message);
        assert_eq!(*scm.calls.borrow(), vec!["stop Gateway", "stop Functions", "stop Auth"]);
        let written: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert_eq!(written["lockoutHook"]["canaryOk"], json!(false));
    }

    #[test]
    fn a_stop_that_fails_is_reported_and_the_other_services_are_still_stopped() {
        struct Refuses(Scm);
        impl Runtime for Refuses {
            fn name(&self) -> &'static str { "refuses" }
            fn prepare(&self, r: &Roots, p: &Path, c: Component) -> Result<(), String> { self.0.prepare(r, p, c) }
            fn run_script_as_postgres(&self, r: &Roots, p: &Path, s: &Path, t: Duration) -> Result<(), String> { self.0.run_script_as_postgres(r, p, s, t) }
            fn start(&self, r: &Roots, p: &Path, c: Component) -> Result<(), String> { self.0.start(r, p, c) }
            fn stop(&self, c: Component) -> Result<(), String> {
                if c == Component::Functions { Err("access denied".into()) } else { self.0.stop(c) }
            }
            fn set_functions_env(&self, r: &Roots, e: &[String]) -> Result<(), String> { self.0.set_functions_env(r, e) }
            fn unregister(&self, c: Component) -> Result<(), String> { self.0.unregister(c) }
            fn protect_file(&self, p: &Path, g: &[crate::acl::Grant]) -> Result<(), String> { self.0.protect_file(p, g) }
        }
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let rt = Refuses(Scm::all_running());
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &rt, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert!(out.message.contains("AND Functions could not be stopped: access denied"), "{}", out.message);
        assert_eq!(*rt.0.calls.borrow(), vec!["stop Gateway", "stop Auth"]);
    }

    // Task 2 CARRY: a slow boot must not stop the Gateway
    #[test]
    fn the_canary_waits_for_its_services_and_judges_only_once_they_answer() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let polls = Cell::new(0);
        let healthy = |_: Component| {
            polls.set(polls.get() + 1);
            polls.get() > 9 // the first rounds of probes say "not yet"
        };
        let ran = Cell::new(false);
        let polls_when_judged = Cell::new(0);
        let mut canary = canary_of(|| {
            ran.set(true);
            polls_when_judged.set(polls.get());
            Ok(())
        });
        canary.ready_wait = Duration::from_secs(10);
        let out = health_with(&roots, true, true, &scm, &fake_env(&running, &healthy), &canary).unwrap();
        assert!(ran.get(), "the canary ran once the services answered");
        assert!(polls_when_judged.get() > 9, "judged after {} probes: the readiness polls had not answered yet", polls_when_judged.get());
        assert_ne!(out.code, Code::CanaryFailed);
        assert!(scm.calls.borrow().is_empty());
    }

    #[test]
    fn services_not_ready_by_the_deadline_is_unhealthy_not_canary_failed_and_stops_nothing() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let never = |_: Component| false;
        let ran = RefCell::new(false);
        let canary = canary_of(|| {
            *ran.borrow_mut() = true;
            Err(PosctlError::new(Code::CanaryFailed, "would have failed"))
        });
        let out = health_with(&roots, true, true, &scm, &fake_env(&running, &never), &canary).unwrap();
        assert!(!*ran.borrow());
        assert_eq!(out.code, Code::Unhealthy);
        assert!(out.message.contains("not ready in time"), "{}", out.message);
        assert!(scm.calls.borrow().is_empty());
    }

    #[test]
    fn a_stack_that_is_stopped_does_not_make_the_canary_wait() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let st = |_: Component| ServiceState::Stopped;
        let ok = |_: Component| true;
        let mut canary = canary_of(|| Ok(()));
        canary.ready_wait = Duration::from_secs(3600); // would hang the test if the wait did not give up
        let out = health_with(&roots, false, true, &scm, &fake_env(&st, &ok), &canary).unwrap();
        assert_eq!(out.code, Code::Unhealthy);
    }

    #[test]
    fn the_canary_is_skipped_while_another_operation_holds_update_lock() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let _held = acquire_for(&roots, LockMode::Exclusive, "update", "op-1", Duration::from_secs(0)).unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let ran = Cell::new(false);
        let canary = canary_of(|| {
            ran.set(true);
            Ok(())
        });
        let out = health_with(&roots, false, true, &scm, &fake_env(&running, &ok), &canary).unwrap();
        assert!(!ran.get());
        assert_ne!(out.code, Code::CanaryFailed);
        assert!(out.message.contains("update.lock"), "{}", out.message);
    }

    // CR-I2: an installer that died between `tasks remove` and `tasks install` leaves no writer of status.json
    fn alert_codes(v: &Value) -> Vec<String> {
        v["alerts"].as_array().unwrap().iter().map(|a| a["code"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn status_raises_status_stale_when_the_file_it_found_is_old_or_has_no_timestamp() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let ok = |_: Component| true;
        let env = fake_env(&running, &ok);
        let now = crate::util::now_unix();
        let old = json!({"state": "cached", "generatedAt": crate::util::rfc3339_utc(now - 600), "alerts": []});
        std::fs::write(roots.status_json(), old.to_string()).unwrap();
        let out = status_with(&roots, false, &env).unwrap();
        assert!(alert_codes(&out.data).contains(&"STATUS_STALE".to_string()), "a file written 10 minutes ago: {:?}", out.data["alerts"]);
        assert_eq!(out.code, Code::Ok, "status keeps exit 0");
        std::fs::write(roots.status_json(), json!({"state": "cached", "alerts": []}).to_string()).unwrap();
        let out = status_with(&roots, false, &env).unwrap();
        assert!(alert_codes(&out.data).contains(&"STATUS_STALE".to_string()), "a file with no generatedAt");
        std::fs::write(roots.status_json(), json!({"state": "cached", "generatedAt": crate::util::rfc3339_utc(now - 30), "alerts": []}).to_string()).unwrap();
        let out = status_with(&roots, false, &env).unwrap();
        assert_eq!(out.data["state"], "cached", "a 30 s old file is served");
        assert!(!alert_codes(&out.data).contains(&"STATUS_STALE".to_string()));
        std::fs::remove_file(roots.status_json()).unwrap();
        let out = status_with(&roots, false, &env).unwrap();
        assert!(!alert_codes(&out.data).contains(&"STATUS_STALE".to_string()), "no file at all is a first run, not a stale writer");
    }

    #[test]
    fn status_file_stale_is_over_five_minutes_or_unreadable() {
        let now = 1_790_000_000;
        assert!(!status_file_stale(Some(&crate::util::rfc3339_utc(now - 300)), now));
        assert!(status_file_stale(Some(&crate::util::rfc3339_utc(now - 301)), now));
        assert!(!status_file_stale(Some(&crate::util::rfc3339_utc(now + 60)), now), "a clock step forward is not stale");
        assert!(status_file_stale(None, now) && status_file_stale(Some("yesterday"), now));
        let mut i = inputs();
        i.status_stale = true;
        assert!(build_alerts(&i).iter().any(|a| a["code"] == "STATUS_STALE" && a["level"] == "warn"));
        i.provisioning = true;
        assert!(!build_alerts(&i).iter().any(|a| a["code"] == "STATUS_STALE"), "no writer exists yet during provisioning");
    }

    #[test]
    fn status_serves_a_fresh_file_and_measures_on_refresh() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let ok = |_: Component| true;
        let env = fake_env(&running, &ok);
        std::fs::write(roots.status_json(), json!({"state": "cached", "generatedAt": crate::util::now_rfc3339()}).to_string()).unwrap();
        assert_eq!(status_with(&roots, false, &env).unwrap().data["state"], "cached");
        let fresh = status_with(&roots, true, &env).unwrap();
        assert_eq!(fresh.data["state"], "running");
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert_eq!(on_disk["state"], "running");
    }

    // ---- F3 (strict TDD): boot gate order, canary evidence, stale canary, start type

    const STACK_STOPS: [&str; 3] = ["stop Gateway", "stop Functions", "stop Auth"];
    const STACK_DEMAND: [&str; 3] = ["Gateway=demand", "Functions=demand", "Auth=demand"];

    fn put_canary(roots: &Roots, last_ok: Option<bool>, age_secs: u64) {
        let mut v = json!({"userId": "00000000-0000-4000-8000-0000000000aa", "email": "x@barpos.local"});
        if let Some(ok) = last_ok {
            v["lastOk"] = json!(ok);
            v["lastRunAt"] = json!(crate::util::rfc3339_utc(crate::util::now_unix() - age_secs));
        }
        std::fs::write(roots.canary_json(), v.to_string()).unwrap();
    }

    fn written(roots: &Roots) -> Value {
        serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap()
    }

    // T1
    #[test]
    fn a_missing_gotrue_env_exits_22_and_stops_the_sign_in_stack() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        std::fs::remove_file(roots.gotrue_env()).unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert_eq!(*scm.calls.borrow(), STACK_STOPS);
        assert_eq!(written(&roots)["lockoutHook"]["envOk"], json!(false));
    }

    // T2: the gate must not wait for the lock or for readiness
    #[test]
    fn missing_hook_variables_stop_the_stack_even_when_update_lock_is_held_or_services_are_not_ready() {
        for (held, ready) in [(true, true), (false, false), (true, false)] {
            let d = tempfile::tempdir().unwrap();
            let roots = provisioned(&d, false);
            let _lock = if held { Some(acquire_for(&roots, LockMode::Exclusive, "update", "op-1", Duration::from_secs(0)).unwrap()) } else { None };
            let scm = Scm::all_running();
            let healthy = move |_: Component| ready;
            let out = health_with(&roots, true, true, &scm, &fake_env(&running, &healthy), &canary_of(|| Ok(()))).unwrap();
            assert_eq!(out.code, Code::CanaryFailed, "held={held} ready={ready}");
            assert_eq!(*scm.calls.borrow(), STACK_STOPS, "held={held} ready={ready}");
        }
    }

    // T3 + I4: stopped services still must not come back at the next boot
    #[test]
    fn stopped_services_with_missing_variables_exit_22_stop_nothing_and_are_set_to_manual_start() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let scm = Scm::all_running();
        let st = |_: Component| ServiceState::Stopped;
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&st, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert!(scm.calls.borrow().is_empty());
        assert_eq!(*scm.start_types.borrow(), STACK_DEMAND);
    }

    // I4
    #[test]
    fn gating_sets_the_sign_in_stack_to_manual_start_before_stopping_it() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert_eq!(*scm.start_types.borrow(), STACK_DEMAND);
        assert_eq!(*scm.calls.borrow(), STACK_STOPS);
        // reporting without write changes nothing
        let scm = Scm::all_running();
        health_with(&roots, false, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(scm.start_types.borrow().is_empty());
    }

    // I1
    #[test]
    fn a_load_installed_error_still_gates_a_missing_hook_and_an_uninstalled_stack_is_left_alone() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        std::fs::remove_file(roots.posctl_json()).unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        assert!(health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).is_err());
        assert_eq!(*scm.calls.borrow(), STACK_STOPS, "the gate does not depend on load_installed");
        let scm = Scm::all_running();
        let none = |_: Component| ServiceState::NotInstalled;
        assert!(health_with(&roots, true, false, &scm, &fake_env(&none, &ok), &canary_of(|| Ok(()))).is_err());
        assert!(scm.calls.borrow().is_empty() && scm.start_types.borrow().is_empty(), "nothing installed, nothing to touch");
    }

    // T5
    #[test]
    fn a_canary_error_that_is_not_a_verdict_exits_20_and_gates_nothing() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let canary = canary_of(|| Err(PosctlError::error("gateway timed out")));
        let out = health_with(&roots, true, true, &scm, &fake_env(&running, &ok), &canary).unwrap();
        assert_eq!(out.code, Code::Unhealthy);
        assert!(out.message.contains("gateway timed out"), "{}", out.message);
        assert!(scm.calls.borrow().is_empty() && scm.start_types.borrow().is_empty());
        assert_eq!(written(&roots)["lockoutHook"]["canaryOk"], Value::Null);
    }

    // FR4 F3: the boot canary POSTs an Auth user; during an update that is a write into a database a rollback may discard
    #[test]
    fn the_canary_does_not_run_while_an_operation_is_in_progress_or_the_gateway_is_fenced() {
        for rel in [("update", "journal.json"), ("conf", "Caddyfile.live")] {
            let d = tempfile::tempdir().unwrap();
            let roots = provisioned(&d, true);
            let dir = if rel.0 == "update" { roots.update_dir() } else { roots.conf() };
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(rel.1), "x").unwrap();
            let scm = Scm::all_running();
            let ok = |_: Component| true;
            let out = health_with(&roots, true, true, &scm, &fake_env(&running, &ok), &canary_of(|| panic!("a database write before --recover"))).unwrap();
            assert_ne!(out.code, Code::CanaryFailed, "{}", out.message);
            assert!(out.message.contains("update in progress"), "{}: {}", rel.1, out.message);
            assert_eq!(written(&roots)["lockoutHook"]["canaryOk"], Value::Null);
        }
    }

    // T5 + I2
    #[test]
    fn a_persisted_failed_canary_exits_22_and_gates_on_the_next_run_even_without_running_the_canary() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        put_canary(&roots, Some(false), 60);
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| panic!("not due: it ran a minute ago"))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed);
        assert_eq!(*scm.calls.borrow(), STACK_STOPS);
        assert_eq!(*scm.start_types.borrow(), STACK_DEMAND);
    }

    // FR17: the updater owns service state during an operation; a recorded failure gates only once it has ended
    #[test]
    fn a_recorded_canary_failure_does_not_gate_while_an_operation_is_in_progress() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        put_canary(&roots, Some(false), 60);
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(roots.journal(), "x").unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| panic!("no canary during an operation"))).unwrap();
        assert_eq!(out.code, Code::CanaryFailed, "the record still reads as failed: {}", out.message);
        assert!(scm.calls.borrow().is_empty(), "nothing is stopped mid-operation: {:?}", scm.calls.borrow());
        assert!(scm.start_types.borrow().is_empty(), "{:?}", scm.start_types.borrow());
    }

    // T5: Functions refused to stop; the file must still say it is running
    #[test]
    fn a_service_that_refused_to_stop_stays_running_in_status_json() {
        struct Refuses(Scm);
        impl Runtime for Refuses {
            fn name(&self) -> &'static str { "refuses" }
            fn prepare(&self, r: &Roots, p: &Path, c: Component) -> Result<(), String> { self.0.prepare(r, p, c) }
            fn run_script_as_postgres(&self, r: &Roots, p: &Path, s: &Path, t: Duration) -> Result<(), String> { self.0.run_script_as_postgres(r, p, s, t) }
            fn start(&self, r: &Roots, p: &Path, c: Component) -> Result<(), String> { self.0.start(r, p, c) }
            fn stop(&self, c: Component) -> Result<(), String> { if c == Component::Functions { Err("access denied".into()) } else { self.0.stop(c) } }
            fn set_functions_env(&self, r: &Roots, e: &[String]) -> Result<(), String> { self.0.set_functions_env(r, e) }
            fn unregister(&self, c: Component) -> Result<(), String> { self.0.unregister(c) }
            fn protect_file(&self, p: &Path, g: &[crate::acl::Grant]) -> Result<(), String> { self.0.protect_file(p, g) }
            fn set_auto_start(&self, c: Component, a: bool) -> Result<(), String> { self.0.set_auto_start(c, a) }
        }
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, false);
        let rt = Refuses(Scm::all_running());
        let ok = |_: Component| true;
        health_with(&roots, true, false, &rt, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        let w = written(&roots);
        assert_eq!(w["services"]["Functions"]["state"], "running");
        assert_eq!(w["services"]["Gateway"]["state"], "stopped");
    }

    // I3
    #[test]
    fn a_canary_that_never_succeeded_or_is_over_26_hours_old_raises_canary_stale_not_the_gate() {
        let alerts = |f: &dyn Fn(&mut Inputs)| {
            let mut i = inputs();
            f(&mut i);
            build_alerts(&i).iter().map(|a| a["code"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(alerts(&|i| i.canary_at = Some("2026-10-01T09:00:00Z".into())), ["CANARY_STALE"], "27 h");
        assert!(alerts(&|i| i.canary_at = Some("2026-10-01T11:00:00Z".into())).is_empty(), "25 h");
        assert_eq!(alerts(&|i| {
            i.canary_ok = None;
            i.canary_at = None
        }), ["CANARY_STALE"]);
        assert_eq!(alerts(&|i| i.canary_at = Some("not a time".into())), ["CANARY_STALE"]);
        assert_eq!(alerts(&|i| i.canary_ok = Some(false)), ["LOCKOUT_HOOK_INACTIVE"], "a failed canary is the hook alert, not also stale");
        let mut old = inputs();
        old.canary_at = Some("2026-10-01T09:00:00Z".into());
        assert_eq!(health_code(&build_status(&old), false), Code::Degraded, "21, never 22");
    }

    #[test]
    fn health_write_retries_a_canary_that_is_missing_over_26_hours_old_or_older_than_the_boot() {
        let ran_with = |last: Option<(bool, u64)>, uptime: Option<u64>, write: bool| {
            let d = tempfile::tempdir().unwrap();
            let roots = provisioned(&d, true);
            put_canary(&roots, last.map(|l| l.0), last.map(|l| l.1).unwrap_or(0));
            let scm = Scm::all_running();
            let ok = |_: Component| true;
            let ran = Cell::new(false);
            let canary = canary_of(|| {
                ran.set(true);
                Ok(())
            });
            let mut env = fake_env(&running, &ok);
            env.uptime = Box::new(move || uptime);
            health_with(&roots, write, false, &scm, &env, &canary).unwrap();
            ran.get()
        };
        let h = 3600;
        assert!(ran_with(None, None, true), "never ran");
        assert!(ran_with(Some((true, 27 * h)), None, true), "over 26 h");
        assert!(!ran_with(Some((true, 2 * h)), None, true), "fresh");
        assert!(ran_with(Some((true, 5 * h)), Some(h), true), "last ran before this boot");
        assert!(!ran_with(Some((true, 2 * h)), Some(10 * h), true), "ran since the boot");
        assert!(!ran_with(None, None, false), "a reader never runs the canary");
    }

    #[test]
    fn permission_denied_on_gotrue_env_is_unknown_for_a_reader_and_bad_for_the_scheduled_run() {
        let denied = || Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(hook_env_verdict(denied(), false));
        assert!(!hook_env_verdict(denied(), true));
        assert!(!hook_env_verdict(Err(std::io::Error::from(std::io::ErrorKind::NotFound)), false));
        assert!(!hook_env_verdict(Ok("OTHER=1".into()), false));
        assert!(hook_env_verdict(Ok(format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true\nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}\n", render::HOOK_URI)), true));
    }

    #[test]
    fn hostile_inputs_never_reach_the_status_file() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let mut env_text = std::fs::read_to_string(roots.gotrue_env()).unwrap();
        // the scheme is a format arg: a literal connection URL here trips `npm run lint:secrets`
        env_text.push_str(&format!("GOTRUE_JWT_SECRET=hunter2hunter2hunter2\nDATABASE_URL={}://u:p4ssw0rd@127.0.0.1/db\n", "postgres"));
        std::fs::write(roots.gotrue_env(), env_text).unwrap();
        let log_dir = roots.logs_for(Component::Auth.service_name());
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join("a.log"), "Hook errored out token=eyJhbGciOi.secret C:\\Users\\boss\\secret.txt 192.168.1.5").unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        let canary = canary_of(|| Err(PosctlError::new(Code::CanaryFailed, "lockout failed at C:\\ProgramData\\x with hunter2hunter2hunter2 on 192.168.1.5")));
        health_with(&roots, true, true, &scm, &fake_env(&running, &ok), &canary).unwrap();
        let text = std::fs::read_to_string(roots.status_json()).unwrap();
        for bad in ["hunter2", "p4ssw0rd", "eyJ", "C:\\", "192.168.", "127.0.0.1", "boss", "ProgramData", &d.path().display().to_string()] {
            assert!(!text.contains(bad), "{bad} leaked into status.json");
        }
    }

    #[test]
    fn health_and_status_report_a_corrupted_pack_as_an_alert_without_stopping_anything() {
        let d = tempfile::tempdir().unwrap();
        let roots = crate::packcmd::fixtures::signed_root(&d, true);
        let auth = roots.pack_dir("1.0.0-r1").unwrap().join("bin").join("auth.exe");
        let ok = |_: Component| true;
        let alerts = |v: &Value| v["alerts"].as_array().unwrap().iter().map(|a| a["code"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        // a same-size flip is a Full-tier finding: Light (status, health) does not see it, the next start does
        let mut b = std::fs::read(&auth).unwrap();
        b[0] ^= 1;
        std::fs::write(&auth, &b).unwrap();
        let scm = Scm::all_running();
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(!alerts(&out.data).contains(&"PACK_INVALID".to_string()));
        // a size change is visible to a stat
        std::fs::write(&auth, b"truncated").unwrap();
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(alerts(&out.data).contains(&"PACK_INVALID".to_string()), "{:?}", out.data["alerts"]);
        assert_ne!(out.code, Code::CanaryFailed);
        assert_eq!(out.data["packVersion"], "1.0.0-r1");
        assert!(scm.calls.borrow().is_empty(), "health only reports: nothing is stopped");
        let written: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert!(alerts(&written).contains(&"PACK_INVALID".to_string()));
        let critical = written["alerts"].as_array().unwrap().iter().find(|a| a["code"] == "PACK_INVALID").unwrap();
        assert_eq!(critical["level"], "critical");
        // status --refresh says the same, with nothing run from the pack
        let s = status_with(&roots, true, &fake_env(&running, &ok)).unwrap();
        assert!(alerts(&s.data).contains(&"PACK_INVALID".to_string()));
        // the pack comes back: the alert goes
        std::fs::write(&auth, {
            b[0] ^= 1;
            &b
        })
        .unwrap();
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        assert!(!alerts(&out.data).contains(&"PACK_INVALID".to_string()));
    }

    // ---- Task 9B: journal-driven states and the update alerts ----
    use crate::ops::journal::Journal;
    use crate::ops::lock::{acquire, LockMode};
    use crate::ops::outcome::OpKind;
    use crate::update::result_file::{Pending, UpdateResultFile};

    fn op_roots() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(r.update_dir()).unwrap();
        (d, r)
    }
    fn write_journal(r: &Roots) {
        Journal::new(OpKind::Update, "op", 1, 2, Some("a".into()), Some("b".into())).write(&r.update_dir()).unwrap();
    }

    #[test]
    fn the_lock_kind_names_the_state_while_an_operation_runs() {
        for (kind, want) in [("update", OpPhase::Updating), ("recover", OpPhase::Updating), ("switch", OpPhase::Switching),
                             ("switch-rollback", OpPhase::Switching), ("restore", OpPhase::Restoring)] {
            let (_d, r) = op_roots();
            write_journal(&r);
            let _held = acquire(&r.update_dir(), LockMode::Exclusive, kind, "op", Duration::from_secs(0)).unwrap();
            assert_eq!(op_phase(&r), want, "lock kind {kind}");
        }
    }
    #[test]
    fn a_journal_with_the_lock_free_or_an_unreadable_one_means_recovery_is_needed() {
        let (_d, r) = op_roots();
        assert_eq!(op_phase(&r), OpPhase::None, "nothing going on");
        write_journal(&r);
        assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded, "journal present, lock free");
        std::fs::write(crate::ops::journal::path(&r.update_dir()), b"{ torn").unwrap();
        assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded, "corrupt journal is not absent");
        let mut j = Journal::new(OpKind::Update, "op", 1, 2, None, None);
        j.schema = crate::ops::journal::JOURNAL_SCHEMA + 1;
        j.write(&r.update_dir()).unwrap();
        assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded, "a journal from a newer posctl is not absent");
        // an unreadable journal wins even over a running lock: a live operation writes it atomically
        std::fs::write(crate::ops::journal::path(&r.update_dir()), b"{ torn").unwrap();
        let _held = acquire(&r.update_dir(), LockMode::Exclusive, "update", "op", Duration::from_secs(0)).unwrap();
        assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded);
    }
    // ---- FR19: an update folder the reader cannot look into is "unknown", never "no update in progress" ----
    fn denied<T>(_: &std::path::Path) -> std::io::Result<T> { Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) }

    #[test]
    fn an_unreadable_journal_makes_the_update_state_unknown_not_none() {
        let (_d, r) = op_roots();
        assert_eq!(op_phase_via(&r, &denied, &|p: &std::path::Path| p.try_exists()), OpPhase::Unknown);
        // while a corrupt journal is still "recovery needed": that one WAS read
        std::fs::write(crate::ops::journal::path(&r.update_dir()), b"{ torn").unwrap();
        assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded);
    }

    #[test]
    fn an_unreadable_fence_marker_makes_the_update_state_unknown_not_none() {
        let (_d, r) = op_roots();
        assert_eq!(op_phase_via(&r, &crate::ops::journal::fs_read, &denied), OpPhase::Unknown);
        assert_eq!(op_phase_via(&r, &crate::ops::journal::fs_read, &|_: &std::path::Path| Ok(false)), OpPhase::None);
    }

    #[test]
    fn unknown_is_its_own_state_and_raises_a_warning_that_says_to_elevate() {
        let mut i = inputs();
        i.op = OpPhase::Unknown;
        assert_eq!(derive_state(&i), "unknown");
        let a = build_alerts(&i);
        let w = a.iter().find(|x| x["code"] == "UPDATE_STATE_UNKNOWN").expect("alert");
        assert_eq!(w["level"], "warn");
        assert!(w["message"].as_str().unwrap().contains("elevat"), "{w}");
    }

    #[test]
    fn a_backup_or_an_unrelated_lock_is_not_an_operation() {
        let (_d, r) = op_roots();
        let _shared = acquire(&r.update_dir(), LockMode::Shared, "backup", "b", Duration::from_secs(0)).unwrap();
        assert_eq!(op_phase(&r), OpPhase::None);
        drop(_shared);
        let _prune = acquire(&r.update_dir(), LockMode::Exclusive, "prune", "p", Duration::from_secs(0)).unwrap();
        assert_eq!(op_phase(&r), OpPhase::None);
    }

    #[test]
    fn the_operation_states_outrank_the_service_states_and_a_live_fence_is_never_degraded() {
        for (op, want) in [(OpPhase::Updating, "updating"), (OpPhase::Switching, "switching"), (OpPhase::Restoring, "restoring"), (OpPhase::RecoveryNeeded, "recovery-needed")] {
            let mut i = inputs();
            i.services.iter_mut().for_each(|s| { s.state = "stopped".into(); s.healthy = false; }); // the fence stops the stack
            i.op = op;
            assert_eq!(derive_state(&i), want);
            i.services[0].healthy = false;
            i.services[1].state = "running".into();
            assert_eq!(derive_state(&i), want, "{want} is never shown as degraded");
        }
        assert_eq!(derive_state(&inputs()), "running");
    }

    #[test]
    fn recovery_needed_is_a_critical_alert_with_a_stable_since() {
        let mut i = inputs();
        i.op = OpPhase::RecoveryNeeded;
        let a = build_alerts(&i);
        assert!(a.iter().any(|x| x["code"] == "RECOVERY_NEEDED" && x["level"] == "critical"), "{a:?}");
        i.op = OpPhase::None;
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "RECOVERY_NEEDED"));
    }

    fn pending_for_days(days: u64) -> Inputs {
        let mut i = inputs();
        let now = parse_rfc3339_utc(&i.generated_at).unwrap();
        i.update_result = UpdateResultFile { pending: Some(Pending { pack_version: "1.1.0-r1".into(), since_ms: (now - days * 86_400) * 1000, deferred_reason: "OPEN_CAJA".into(), verified: true }), ..Default::default() };
        i
    }
    fn update_alert(i: &Inputs) -> Option<(String, String)> {
        build_alerts(i).iter().find(|x| x["code"] == "PACK_UPDATE_AVAILABLE").map(|x| (x["level"].as_str().unwrap().to_string(), x["since"].as_str().unwrap().to_string()))
    }
    #[test]
    fn a_pending_update_alerts_after_a_week_and_turns_critical_after_two() {
        assert_eq!(update_alert(&pending_for_days(6)), None);
        assert_eq!(update_alert(&pending_for_days(8)).unwrap().0, "warn");
        assert_eq!(update_alert(&pending_for_days(15)).unwrap().0, "critical");
        assert_eq!(update_alert(&inputs()), None, "nothing pending, nothing to say");
    }
    #[test]
    fn a_pending_version_nobody_has_verified_never_goes_past_warn() {
        let unverified = |days| { let mut i = pending_for_days(days); i.update_result.pending.as_mut().unwrap().verified = false; i };
        assert_eq!(update_alert(&unverified(6)), None);
        assert_eq!(update_alert(&unverified(8)).unwrap().0, "warn");
        assert_eq!(update_alert(&unverified(15)).unwrap().0, "warn", "an unsigned feed claim is capped at warn");
        assert_eq!(update_alert(&unverified(400)).unwrap().0, "warn");
    }
    #[test]
    fn the_pending_alert_keeps_the_first_seen_time_across_writes() {
        let a = pending_for_days(8);
        let mut b = a.clone();
        b.generated_at = "2026-10-02T12:01:00Z".into(); // a minute later
        b.previous_alerts = vec![("PACK_UPDATE_AVAILABLE".into(), "warn".into(), "2026-10-02T12:00:00Z".into())];
        let (sa, sb) = (update_alert(&a).unwrap().1, update_alert(&b).unwrap().1);
        assert_eq!(sa, sb, "since must not move");
        assert_eq!(sa, "2026-09-24T12:00:00Z", "since is the persisted first-seen time, not the time of the write");
    }

    #[test]
    fn the_update_section_reports_the_last_result_and_the_pending_pack_without_any_free_text() {
        let nulls = sections::update(&UpdateResultFile::default(), &[], None);
        assert_eq!((nulls["lastAt"].is_null(), nulls["lastResult"].is_null(), nulls["pending"].is_null()), (true, true, true));
        let r = UpdateResultFile { last_at_ms: 1_790_908_215_000, last_result: "rolled_back".into(), last_code: "ROLLED_BACK".into(),
            last_message: Some("connection string postgres://u:pw@h/db".into()), pending: Some(Pending { pack_version: "1.1.0-r1".into(), since_ms: 1_790_908_215_000, deferred_reason: "OPEN_CAJA".into(), verified: false }), ..Default::default() };
        let v = sections::update(&r, &[], None);
        assert_eq!((v["lastAt"].as_str(), v["lastResult"].as_str()), (Some("2026-10-02T02:30:15Z"), Some("rolled_back")));
        assert_eq!((v["pending"]["packVersion"].as_str(), v["pending"]["since"].as_str(), v["pending"]["reason"].as_str()), (Some("1.1.0-r1"), Some("2026-10-02T02:30:15Z"), Some("OPEN_CAJA")));
        assert!(!v.to_string().contains("postgres://") && !v.to_string().contains("pw@"), "no free text may reach status.json: {v}");
    }
    // ---- FR19: TASKS_STALE ----
    #[test]
    fn a_scheduled_task_without_the_flag_or_missing_raises_a_warn_that_says_to_reinstall() {
        let stale = |f: Vec<(&str, bool)>| { let mut i = inputs(); i.task_flags = Some(f.into_iter().map(|(n, b)| (n.to_string(), b)).collect()); build_alerts(&i) };
        assert!(!stale(vec![("Recover", true), ("UpdateCheck", true)]).iter().any(|x| x["code"] == "TASKS_STALE"), "both current");
        for f in [vec![("Recover", true), ("UpdateCheck", false)], vec![("Recover", false), ("UpdateCheck", false)]] {
            let a = stale(f);
            let x = a.iter().find(|x| x["code"] == "TASKS_STALE").expect("stale or missing task");
            assert_eq!(x["level"], "warn");
            assert!(x["message"].as_str().unwrap().contains("run posctl tasks install"), "{x}");
        }
        let mut i = inputs();
        i.task_flags = None;
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "TASKS_STALE"), "unreadable scheduler is unknown, not stale");
    }
    #[test]
    fn status_says_whether_the_tasks_are_current_and_null_when_it_could_not_tell() {
        let mut i = inputs();
        assert_eq!(build_status(&i)["tasksCurrent"], json!(true));
        i.task_flags = Some(vec![("Recover".into(), true), ("UpdateCheck".into(), false)]);
        assert_eq!(build_status(&i)["tasksCurrent"], json!(false));
        i.task_flags = None;
        assert_eq!(build_status(&i)["tasksCurrent"], Value::Null, "unknown is not current");
    }
    #[test]
    fn the_update_section_carries_the_last_exit_code_and_reason_after_a_success_and_after_a_rollback() {
        let none = sections::update(&UpdateResultFile::default(), &[], None);
        assert!(none["lastCode"].is_null() && none["lastReason"].is_null() && none["rolledBackVersion"].is_null(), "{none}");
        let ok = UpdateResultFile { last_at_ms: 1, last_result: "updated".into(), last_code: "OK".into(), ..Default::default() };
        let v = sections::update(&ok, &[], None);
        assert_eq!((v["lastCode"].as_i64(), v["lastReason"].is_null()), (Some(0), true), "{v}");
        let rb = UpdateResultFile { last_at_ms: 1, last_result: "rolled_back".into(), last_code: "VERIFY_FAILED_ROLLED_BACK".into(), last_reason: Some("VERIFY_FAILED".into()),
            last_message: Some("postgres://u:pw@h/db".into()), ..Default::default() };
        let rec = crate::update::result_file::RolledBack { pack_version: "1.1.0-r1".into(), since_ms: 1, code: "VERIFY_FAILED_ROLLED_BACK".into(), reason: Some("VERIFY_FAILED".into()) };
        let v = sections::update(&rb, &[], Some(&rec));
        assert_eq!((v["lastCode"].as_i64(), v["lastReason"].as_str(), v["rolledBackVersion"].as_str()), (Some(15), Some("VERIFY_FAILED"), Some("1.1.0-r1")), "{v}");
        assert!(!v.to_string().contains("pw@"), "no free text: {v}");
    }
    #[test]
    fn the_rolled_back_alert_is_a_warn_that_follows_the_record() {
        let mut i = inputs();
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "UPDATE_ROLLED_BACK"), "no record, no alert");
        i.rolled_back = Some(crate::update::result_file::RolledBack { pack_version: "1.1.0-r1".into(), since_ms: 1, code: "ROLLED_BACK".into(), reason: None });
        let a = build_alerts(&i);
        let x = a.iter().find(|x| x["code"] == "UPDATE_ROLLED_BACK").expect("alert while the record exists");
        assert_eq!(x["level"], "warn");
        assert!(x["message"].as_str().is_some_and(|m| m.contains("1.1.0-r1")), "{x}");
        i.rolled_back = None;
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "UPDATE_ROLLED_BACK"), "cleared with the record");
    }
    #[test]
    fn build_status_carries_the_state_and_the_update_section() {
        let mut i = pending_for_days(8);
        i.op = OpPhase::Updating;
        let v = build_status(&i);
        assert_eq!(v["state"], "updating");
        assert_eq!(v["update"]["pending"]["packVersion"], "1.1.0-r1");
    }

    // ---- FR6 X2: the Health task only reports; during an operation its exit code says so ----
    fn op_health_code(kind: Option<&str>, journal: bool) -> (Code, String, Scm) {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        if journal {
            crate::ops::journal::Journal::new(crate::ops::outcome::OpKind::Update, "op", 0, 0, Some("a".into()), Some("b".into())).write(&roots.update_dir()).unwrap();
        }
        let held = kind.map(|k| crate::ops::lock::acquire(&roots.update_dir(), crate::ops::lock::LockMode::Exclusive, k, "op", Duration::from_secs(0)).unwrap());
        let scm = Scm::all_running();
        let nothing_healthy = |_: Component| false; // the fence has stopped the stack on purpose
        let out = health_with(&roots, true, false, &scm, &fake_env(&running, &nothing_healthy), &canary_of(|| Ok(()))).unwrap();
        drop(held);
        (out.code, out.message, scm)
    }

    #[test]
    fn x2_health_during_an_update_is_ok_with_the_state_named_and_it_touches_no_service() {
        for kind in ["update", "recover", "switch", "restore"] {
            let (code, msg, scm) = op_health_code(Some(kind), true);
            assert_eq!(code, Code::Ok, "{kind}: {msg}");
            assert!(msg.contains("in progress"), "{msg}");
            assert!(scm.calls.borrow().is_empty() && scm.start_types.borrow().is_empty(), "the Health task must not start, stop or reconfigure anything");
        }
    }

    #[test]
    fn x2_an_interrupted_operation_exits_17_not_unhealthy() {
        let (code, msg, scm) = op_health_code(None, true);
        assert_eq!((code, code.exit()), (Code::RecoveryNeeded, 17), "{msg}");
        assert!(scm.calls.borrow().is_empty());
    }

    #[test]
    fn x2_without_an_operation_an_unhealthy_service_is_still_unhealthy() {
        let (code, _, _) = op_health_code(None, false);
        assert_eq!(code, Code::Unhealthy);
    }

    #[test]
    fn m1_three_failed_unattended_recoveries_add_a_support_alert() {
        let mut i = inputs();
        i.op = OpPhase::RecoveryNeeded;
        i.recovery_exhausted = true;
        assert!(build_alerts(&i).iter().any(|x| x["code"] == "RECOVERY_SUPPORT_NEEDED" && x["level"] == "critical"));
        i.recovery_exhausted = false;
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "RECOVERY_SUPPORT_NEEDED"));
    }

    #[test]
    fn m1_the_exhausted_flag_comes_from_the_journal_attempts() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        assert!(!recovery_attempts_exhausted(&roots));
        let mut j = crate::ops::journal::Journal::new(crate::ops::outcome::OpKind::Update, "op", 0, 0, Some("a".into()), Some("b".into()));
        j.extra = json!({"recoverAttempts": [{"atMs": 1, "by": "unattended"}, {"atMs": 2, "by": "hand"}, {"atMs": 3, "by": "unattended"}]});
        j.write(&roots.update_dir()).unwrap();
        assert!(!recovery_attempts_exhausted(&roots), "a person's attempt is not one of the three");
        j.extra = json!({"recoverAttempts": [{"atMs": 1, "by": "unattended"}, {"atMs": 2, "by": "unattended"}, {"atMs": 3, "by": "unattended"}]});
        j.write(&roots.update_dir()).unwrap();
        assert!(recovery_attempts_exhausted(&roots));
    }

    // ---- FR7 P ----
    #[test]
    fn the_status_writer_never_creates_the_lock_file_or_deletes_its_holder_info() {
        let (_d, r) = op_roots();
        std::fs::create_dir_all(r.update_dir()).unwrap();
        assert_eq!(op_phase(&r), OpPhase::None);
        assert!(!r.update_dir().join("update.lock").exists(), "op_phase must not create update.lock");
        std::fs::write(r.update_dir().join("update.lock"), "").unwrap();
        std::fs::write(r.update_dir().join("update.lock.info"), b"{\"pid\":1,\"op_id\":\"x\",\"kind\":\"update\",\"started_ms\":1}").unwrap();
        let _ = op_phase(&r);
        assert!(r.update_dir().join("update.lock.info").exists(), "op_phase must not delete .info");
    }

    // ---- FR7 addendum 6 ----
    #[test]
    fn the_update_section_shows_how_often_and_when_recovery_was_tried() {
        let mut i = inputs();
        i.recover_attempts = vec![(1_790_908_215_000, "unattended".into()), (1_790_908_275_000, "hand".into())];
        let v = build_status(&i);
        assert_eq!(v["update"]["recoverAttempts"]["count"], 2, "{}", v["update"]);
        assert_eq!(v["update"]["recoverAttempts"]["unattended"], 1);
        assert_eq!(v["update"]["recoverAttempts"]["lastAt"], json!(crate::util::rfc3339_utc(1_790_908_275)));
        assert_eq!(build_status(&inputs())["update"]["recoverAttempts"]["count"], 0);
    }

    #[test]
    fn the_attempts_come_from_the_journal() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        assert!(recovery_attempts(&roots).is_empty());
        let mut j = crate::ops::journal::Journal::new(crate::ops::outcome::OpKind::Update, "op", 0, 0, Some("a".into()), Some("b".into()));
        j.extra = json!({"recoverAttempts": [{"atMs": 5, "by": "unattended"}, {"atMs": 9, "by": "hand"}]});
        j.write(&roots.update_dir()).unwrap();
        assert_eq!(recovery_attempts(&roots), vec![(5, "unattended".to_string()), (9, "hand".to_string())]);
    }

    // ---- FR8 ----
    #[test]
    fn an_unusable_maintenance_window_raises_a_warn_alert() {
        let mut i = inputs();
        i.window_invalid = true;
        assert!(build_alerts(&i).iter().any(|x| x["code"] == "MAINTENANCE_WINDOW_INVALID" && x["level"] == "warn"));
        i.window_invalid = false;
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "MAINTENANCE_WINDOW_INVALID"));
    }

    #[test]
    fn the_window_problem_is_read_from_posctl_json() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let mut c = crate::config::PosctlJson::new("offline-only", "s", 47300, "h", "p");
        std::fs::create_dir_all(roots.conf()).unwrap();
        c.save(&roots).unwrap();
        assert!(!window_invalid(&roots));
        c.maintenance.window = Some(crate::config::MaintenanceWindow { start: "1:00".into(), end: "05:00".into() });
        c.save(&roots).unwrap();
        assert!(window_invalid(&roots));
        c.maintenance.window = Some(crate::config::MaintenanceWindow { start: "22:00".into(), end: "02:00".into() });
        c.save(&roots).unwrap();
        assert!(!window_invalid(&roots));
    }

    // ---- FR8 item 3: a leftover fence with no journal ----
    #[test]
    fn a_leftover_fence_with_no_journal_and_no_holder_is_recovery_needed() {
        for rel in [("update", "fence-start-types.json"), ("conf", "Caddyfile.live")] {
            let (_d, r) = op_roots();
            assert_eq!(op_phase(&r), OpPhase::None);
            let dir = if rel.0 == "update" { r.update_dir() } else { r.conf() };
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(rel.1), "x").unwrap();
            assert_eq!(op_phase(&r), OpPhase::RecoveryNeeded, "{}", rel.1);
            let _held = acquire(&r.update_dir(), LockMode::Exclusive, "update", "op", Duration::from_secs(0)).unwrap();
            assert_eq!(op_phase(&r), OpPhase::Updating, "a live operation owns its own fence");
        }
    }

    #[test]
    fn the_recovery_needed_state_carries_the_critical_alert_for_a_leftover_fence() {
        let (_d, r) = op_roots();
        std::fs::write(r.fence_start_types(), "x").unwrap();
        let mut i = inputs();
        i.op = op_phase(&r);
        assert!(build_alerts(&i).iter().any(|x| x["code"] == "RECOVERY_NEEDED" && x["level"] == "critical"));
    }

    // ---- Plan 08: status.backup, the backup alerts and the health wiring ----

    fn bk(alerts: Vec<Value>) -> crate::backup::status::Computed {
        crate::backup::status::Computed { block: json!({"configured": true, "alert": "warn", "destinations": []}), alerts, last_error_kind: None, restore_canary_warned_at: None }
    }

    #[test]
    fn the_backup_block_and_alerts_come_from_the_backup_service_and_follow_the_existing_alerts() {
        let mut i = inputs();
        i.disk_free_bytes = 1;
        i.backup = bk(vec![json!({"code": "BACKUP_STALE_24H", "level": "warn", "since": "2026-10-01T00:00:00Z"})]);
        let s = build_status(&i);
        assert_eq!(s["backup"]["configured"], true);
        let codes: Vec<&str> = s["alerts"].as_array().unwrap().iter().map(|a| a["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["DISK_LOW", "BACKUP_STALE_24H"], "appended after Plan 05's own alerts");
        assert_eq!(s["alerts"][1]["since"], "2026-10-01T00:00:00Z", "a stored since is kept as it is");
        assert_eq!(build_status(&inputs())["backup"]["alert"], "none", "nothing configured: the quiet block");
    }

    #[test]
    fn a_backup_alert_without_a_stored_time_is_stamped_first_seen_like_every_other_alert() {
        let mut i = inputs();
        i.backup = bk(vec![json!({"code": "BACKUP_STALE_72H", "level": "critical", "since": Value::Null})]);
        assert_eq!(build_alerts(&i)[0]["since"], "2026-10-02T12:00:00Z", "first time: now");
        i.generated_at = "2026-10-02T12:07:00Z".into();
        i.previous_alerts = vec![("BACKUP_STALE_72H".into(), "critical".into(), "2026-10-02T12:00:00Z".into())];
        assert_eq!(build_alerts(&i)[0]["since"], "2026-10-02T12:00:00Z", "later: the stored first-seen time, not this minute");
        assert!(!build_alerts(&i)[0].to_string().contains("1970"));
    }

    fn blocked(days: u64, reason: Option<&str>) -> Inputs {
        let mut i = pending_for_days(days);
        i.update_result.last_reason = reason.map(String::from);
        i.update_result.last_result = "refused".into();
        i
    }
    fn blocked_alert(i: &Inputs) -> Option<Value> {
        build_alerts(i).into_iter().find(|x| x["code"] == "UPDATE_BLOCKED")
    }

    #[test]
    fn a_pack_that_waits_three_nights_because_the_backup_is_broken_is_an_update_blocked_warning() {
        assert!(blocked_alert(&blocked(2, Some("BACKUP_NOT_READY"))).is_none(), "two nights is not yet");
        for reason in ["BACKUP_NOT_READY", "PRE_UPDATE_BACKUP_FAILED"] {
            let a = blocked_alert(&blocked(3, Some(reason))).expect(reason);
            assert_eq!(a["level"], "warn");
            assert_eq!(a["since"], "2026-09-29T12:00:00Z", "the pending pack's first-seen time (stored, like PACK_UPDATE_AVAILABLE), never moving");
        }
        assert!(blocked_alert(&blocked(9, Some("OPEN_CAJA"))).is_none(), "blocked by something else: PACK_UPDATE_AVAILABLE speaks");
        assert!(blocked_alert(&blocked(9, None)).is_none());
        assert!(blocked_alert(&inputs()).is_none(), "nothing pending");
    }

    #[test]
    fn update_blocked_says_why_in_one_word_and_never_in_error_text() {
        let mut i = blocked(4, Some("BACKUP_NOT_READY"));
        i.backup = crate::backup::status::Computed { last_error_kind: Some("disk-full"), ..bk(vec![]) };
        let a = blocked_alert(&i).unwrap();
        assert_eq!(a["error"], "disk-full");
        assert!(a["message"].as_str().unwrap().contains("backup"), "{a}");
        i.update_result.last_message = Some(r"E:\secret password=x".into());
        assert!(!blocked_alert(&i).unwrap().to_string().contains("secret"));
    }

    fn lockout(i: &Inputs) -> Option<Value> {
        build_alerts(i).into_iter().find(|x| x["code"] == "LOCKOUT_HOOK_INACTIVE")
    }

    #[test]
    fn lockout_hook_inactive_after_a_restore_says_so_and_to_call_support_and_is_otherwise_unchanged() {
        let now = parse_rfc3339_utc("2026-10-02T12:00:00Z").unwrap() as i64;
        let mut i = inputs();
        i.canary_ok = Some(false);
        let plain = lockout(&i).expect("a failed canary");
        assert_eq!((plain["level"].as_str(), plain.get("cause"), plain.get("message")), (Some("critical"), None, None), "no restore: exactly as before");
        i.backup = crate::backup::status::Computed { restore_canary_warned_at: Some(now - 3 * 86_400), ..bk(vec![]) };
        let a = lockout(&i).unwrap();
        assert_eq!((a["code"].as_str(), a["level"].as_str(), a["cause"].as_str()), (Some("LOCKOUT_HOOK_INACTIVE"), Some("critical"), Some("after-restore")));
        assert_eq!(a["message"], "sign-in is blocked until the lockout protection works; call support");
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "BACKUP_RESTORE_SIGN_IN_BLOCKED"), "folded into the existing alert");
        i.backup.restore_canary_warned_at = Some(now - 8 * 86_400);
        assert!(lockout(&i).unwrap().get("cause").is_none(), "a restore older than a week is not the cause");
        i.backup.restore_canary_warned_at = Some(now - 86_400);
        i.canary_ok = Some(true);
        assert!(lockout(&i).is_none(), "canary passes: nothing");
    }

    #[test]
    fn the_canary_note_leaves_the_restore_warning_while_the_lockout_alert_speaks() {
        let w = |ws: Vec<&str>| json!({"code": "BACKUP_RESTORE_WARNING", "level": "warn", "since": "2026-10-01T00:00:00Z", "warnings": ws});
        let mut i = inputs();
        i.canary_ok = Some(false);
        i.backup = bk(vec![w(vec!["PHOTOS_SOME_MISSING", "CANARY_AFTER_RESTORE"])]);
        let a = build_alerts(&i).into_iter().find(|x| x["code"] == "BACKUP_RESTORE_WARNING").unwrap();
        assert_eq!(a["warnings"], json!(["PHOTOS_SOME_MISSING"]));
        i.backup = bk(vec![w(vec!["CANARY_AFTER_RESTORE"])]);
        assert!(!build_alerts(&i).iter().any(|x| x["code"] == "BACKUP_RESTORE_WARNING"), "nothing left to say");
        i.canary_ok = Some(true);
        let a = build_alerts(&i).into_iter().find(|x| x["code"] == "BACKUP_RESTORE_WARNING").expect("the hook is fine: the note stays");
        assert_eq!(a["warnings"], json!(["CANARY_AFTER_RESTORE"]));
    }

    #[test]
    fn update_blocked_names_the_backup_as_the_cause_when_a_stale_alert_is_active() {
        let mut i = blocked(4, Some("BACKUP_NOT_READY"));
        assert!(blocked_alert(&i).unwrap().get("cause").is_none(), "no stale alert: no cause claimed");
        i.backup = bk(vec![json!({"code": "BACKUP_STALE_24H", "level": "warn", "since": "2026-10-01T00:00:00Z"})]);
        assert_eq!(blocked_alert(&i).unwrap()["cause"], "backup");
    }

    #[test]
    fn an_unreadable_backup_state_turns_critical_after_a_day_with_a_since_that_does_not_move() {
        let unknown = |prev_level: &str, hours_ago: i64| {
            let mut i = inputs();
            i.backup = bk(vec![json!({"code": "BACKUP_STATE_UNKNOWN", "level": "warn", "since": Value::Null})]);
            let since = crate::util::rfc3339_utc(parse_rfc3339_utc(&i.generated_at).unwrap() - (hours_ago * 3600) as u64);
            i.previous_alerts = vec![("BACKUP_STATE_UNKNOWN".into(), prev_level.into(), since.clone())];
            (build_alerts(&i).into_iter().find(|x| x["code"] == "BACKUP_STATE_UNKNOWN").unwrap(), since)
        };
        let (a, since) = unknown("warn", 23);
        assert_eq!((a["level"].as_str(), a["since"].as_str()), (Some("warn"), Some(since.as_str())));
        let (a, since) = unknown("warn", 24);
        assert_eq!((a["level"].as_str(), a["since"].as_str()), (Some("critical"), Some(since.as_str())));
        let (a, since) = unknown("critical", 30);
        assert_eq!((a["level"].as_str(), a["since"].as_str()), (Some("critical"), Some(since.as_str())), "already critical last minute: same since");
        let mut i = inputs();
        i.backup = bk(vec![json!({"code": "BACKUP_STATE_UNKNOWN", "level": "warn", "since": Value::Null})]);
        let s = build_status(&i);
        assert_eq!(s["alerts"][0]["level"], "warn");
    }
    #[test]
    fn health_write_puts_the_backup_block_and_alerts_in_status_json_without_touching_the_backup_state() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let paths = crate::backup::paths::BackupPaths::from_roots(&roots);
        std::fs::write(paths.state_file(), b"{ not json").unwrap();
        std::fs::write(roots.status_json(), r#"{"alerts":[{"code":"BACKUP_STALE_72H","level":"critical","since":"2026-10-01T08:00:00Z"}]}"#).unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(roots.status_json()).unwrap()).unwrap();
        assert_eq!(written["backup"]["configured"], true);
        assert_eq!(written["backup"]["historyUnknown"], true);
        let a = written["alerts"].as_array().unwrap().iter().find(|a| a["code"] == "BACKUP_STALE_72H").expect("unknown history is stale at once");
        assert_eq!(a["since"], "2026-10-01T08:00:00Z", "kept from the previous file");
        assert_eq!(std::fs::read(paths.state_file()).unwrap(), b"{ not json", "the status writer only reads");
    }

    #[test]
    fn no_backup_value_in_status_json_looks_like_a_key_or_a_password() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d, true);
        let paths = crate::backup::paths::BackupPaths::from_roots(&roots);
        let key = "cd".repeat(32);
        let mut st = crate::backup::state::BackupState { first_seen_at: 1, last_attempt_at: 5, last_error: Some(format!("restic failed with {key} password=hunter2 at E:\\x")), ..Default::default() };
        st.recovery_key = Some(crate::backup::state::RecoveryKeyRef { issued_at: 2, key_ids: [("local".to_string(), key.clone())].into() });
        st.save_unprotected(&paths.state_file()).unwrap();
        let scm = Scm::all_running();
        let ok = |_: Component| true;
        health_with(&roots, true, false, &scm, &fake_env(&running, &ok), &canary_of(|| Ok(()))).unwrap();
        let text = std::fs::read_to_string(roots.status_json()).unwrap();
        for bad in [key.as_str(), "hunter2", "E:\\x", "password"] {
            assert!(!text.contains(bad), "{bad} reached status.json");
        }
    }}
