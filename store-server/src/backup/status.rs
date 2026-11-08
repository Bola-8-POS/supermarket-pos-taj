//! What the owner is told. One pure function turns the service's memory into the `status.backup` block and the
//! alert list; `health --write` embeds both in `status.json`, which is served to every till. So nothing free-form
//! leaves this module: no path (not even a photo's: the alert carries the count, the paths stay in the log and the CLI), no address,
//! no error text.
//! A failure is reported as one word from a fixed vocabulary (`error_kind`).
//!
//! Every `since` is derived from a stored time, so it does not move between minutes (Plan 12 de-duplicates e-mail on
//! `code + since`). Where no stored time exists, `since` is `null` and the writer (`status::build_alerts`) stamps the
//! first-seen time of that alert from the previous `status.json`, exactly as it does for its own alerts: never a
//! 1970-based value, never the clock of this minute.
use serde_json::{json, Value};
use std::path::Path;

use super::config::{self, BackupConfig, DestKind};
use super::ctx::BackupCtx;
use super::keys::dests_without_recovery_key;
use super::paths::BackupPaths;
use super::state::BackupState;
use super::util::iso_utc;
use crate::envelope::Code;

const H: i64 = 3600;
const D: i64 = 24 * H;
pub const WARN_AFTER_SECS: i64 = 24 * H;
pub const CRITICAL_AFTER_SECS: i64 = 72 * H;
pub const KEY_GRACE_SECS: i64 = 24 * H;
pub const VERIFY_OVERDUE_SECS: i64 = 10 * D;
/// A reachable destination whose copies keep failing is reported after this long.
pub const DEST_FAILING_AFTER_SECS: i64 = 6 * H;
/// Unreadable photos that stay unreadable this long turn critical (the whole folder unreadable is critical at once).
pub const PHOTOS_UNREADABLE_CRITICAL_SECS: i64 = 3 * D;
/// How long a restore's warnings stay on the owner's screen.
pub const RESTORE_WARNING_SHOW_SECS: i64 = 7 * D;
/// The restore warnings worth an alert (anything else stays in `lastRestore.warnings` only).
const RESTORE_ALERT_WARNINGS: [&str; 5] = ["PHOTOS_SOME_MISSING", "POST_RESTORE_BACKUP_FAILED", "PREV_COPY_REVOKE_FAILED", "CANARY_AFTER_RESTORE", "RECOVERY_SCRATCH_LEFT"];

#[derive(Debug, Clone)]
pub struct Computed {
    pub block: Value,
    pub alerts: Vec<Value>,
    /// The fixed word for the last failed backup attempt (see `error_kind`), for `UPDATE_BLOCKED`.
    pub last_error_kind: Option<&'static str>,
    /// When the last restore ended with `CANARY_AFTER_RESTORE`, for the sign-in-blocked alert (it also needs the canary result).
    pub restore_canary_warned_at: Option<i64>,
}

impl Computed {
    pub fn quiet() -> Self {
        Self { block: json!({ "configured": false, "alert": "none", "destinations": [] }), alerts: Vec::new(), last_error_kind: None, restore_canary_warned_at: None }
    }
    fn unreadable() -> Self {
        let a = json!({
            "code": "BACKUP_STATE_UNKNOWN", "level": "warn", "since": Value::Null,
            "message": "the backup state cannot be read, so it is not reported as healthy; run posctl status as an administrator (needs elevation)"
        });
        Self { block: json!({ "configured": true, "readable": false, "alert": "warn", "reason": "unreadable", "destinations": [] }), alerts: vec![a], last_error_kind: None, restore_canary_warned_at: None }
    }
}

pub struct StatusFragment {
    pub backup: Value,
    pub alerts: Vec<Value>,
}

/// What the pure function cannot learn from the state alone.
#[derive(Debug, Clone, Default)]
pub struct Extra {
    /// The photos folder, to recognise "the whole folder is unreadable".
    pub photos_dir: Option<String>,
    /// `backup.lock` is held right now: a backup, verify or drill is running, so an "interrupted" marker is its own.
    pub running: bool,
}

/// One word for a failure; the text itself never reaches `status.json`.
pub fn error_kind(text: &str) -> &'static str {
    let t = text.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if has(&["no space left", "not enough space", "disk full", "disk is full", "out of space", "quota"]) {
        "disk-full"
    } else if has(&["not connected", "no such file", "cannot find the path", "cannot find the file", "device is not ready", "path not found"]) {
        "not-connected"
    } else if has(&["access is denied", "permission denied", "os error 5"]) {
        "access-denied"
    } else if has(&["wrong password", "no key found", "wrong key"]) {
        "wrong-key"
    } else if has(&["timed out", "timeout"]) {
        "timed-out"
    } else if t.contains("interrupted") {
        "interrupted"
    } else {
        "failed"
    }
}

/// A stored time plus an offset, or `null` when the time is unknown (see the module doc).
fn since(base: i64, add: i64) -> Value {
    if base <= 0 { Value::Null } else { json!(iso_utc(base + add)) }
}

fn alert(code: &str, level: &str, since: Value) -> Value {
    json!({ "code": code, "level": level, "since": since })
}

fn with(mut a: Value, k: &str, v: Value) -> Value {
    a[k] = v;
    a
}

fn norm_dir(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

pub fn compute(st: &BackupState, cfg: &BackupConfig, now: i64) -> Computed {
    compute_with(st, cfg, now, &Extra::default())
}

pub fn compute_with(st: &BackupState, cfg: &BackupConfig, now: i64, x: &Extra) -> Computed {
    let off_disk = !cfg.destinations.is_empty();
    let newest = cfg.destinations.iter().filter_map(|d| st.destinations.get(&d.name).and_then(|s| s.last_success.clone())).max_by_key(|s| s.at);
    // A state file that started over after corruption (`first_seen_at == 0`) has no history at all: nothing proves a recent
    // off-disk copy, so the store is stale at once, and there is no honest age to show.
    let history_unknown = newest.is_none() && st.first_seen_at <= 0;
    let base = newest.as_ref().map(|s| s.at).unwrap_or(st.first_seen_at);
    let age = (!history_unknown).then(|| (now - base).max(0));

    let mut alerts = Vec::new();
    // With no second device the stale alerts carry the fixed word `no-destination` (the same word as `block.reason`).
    let stale = |a: Value| if off_disk { a } else { with(a, "reason", json!("no-destination")) };
    match age {
        None => alerts.push(stale(alert("BACKUP_STALE_72H", "critical", Value::Null))),
        Some(a) if a >= CRITICAL_AFTER_SECS => alerts.push(stale(alert("BACKUP_STALE_72H", "critical", since(base, CRITICAL_AFTER_SECS)))),
        Some(a) if a >= WARN_AFTER_SECS => alerts.push(stale(alert("BACKUP_STALE_24H", "warn", since(base, WARN_AFTER_SECS)))),
        Some(_) => {}
    }

    // A removed drive: only a device can be "unplugged" (an R2 outage just ages), and a different drive in its place is its own alert.
    let device = |d: &&config::Destination| d.kind == DestKind::Device;
    let named = |foreign: bool| -> Vec<(&str, Option<i64>)> {
        cfg.destinations.iter().filter(device).filter_map(|d| st.destinations.get(&d.name).map(|s| (d.name.as_str(), s))).filter(|(_, s)| !s.reachable && s.foreign == foreign).map(|(n, s)| (n, s.down_since)).collect()
    };
    let down = named(false);
    let foreign = named(true);
    let group = |code: &str, v: &[(&str, Option<i64>)]| {
        let first = v.iter().filter_map(|(n, t)| t.map(|t| (t, *n))).min();
        let a = alert(code, "warn", first.map(|(t, _)| since(t, 0)).unwrap_or(Value::Null));
        let a = with(a, "dest", json!(first.map(|(_, n)| n).unwrap_or(v[0].0)));
        with(a, "dests", json!(v.iter().map(|(n, _)| *n).collect::<Vec<_>>()))
    };
    if !down.is_empty() {
        alerts.push(group("BACKUP_DEST_DOWN", &down));
    }
    if !foreign.is_empty() {
        alerts.push(group("BACKUP_DEST_FOREIGN", &foreign));
    }
    for d in &cfg.destinations {
        let Some(s) = st.destinations.get(&d.name) else { continue };
        if let (true, false, false, Some(f)) = (s.reachable, s.foreign, s.ok, s.failing_since) {
            if now - f >= DEST_FAILING_AFTER_SECS {
                let a = with(alert("BACKUP_DEST_FAILING", "warn", since(f, DEST_FAILING_AFTER_SECS)), "dest", json!(d.name));
                alerts.push(with(a, "error", json!(error_kind(s.last_error.as_deref().unwrap_or("")))));
            }
        }
    }

    // The key exists but some destination was never given it: the owner could not open that drive with the key on paper.
    let no_key = dests_without_recovery_key(cfg, st);
    if let (false, Some(rk)) = (no_key.is_empty(), st.recovery_key.as_ref()) {
        let added = cfg.destinations.iter().filter(|d| no_key.contains(&d.name)).map(|d| d.added_at).min().unwrap_or(0);
        alerts.push(with(alert("BACKUP_DEST_NO_RECOVERY_KEY", "warn", since(rk.issued_at.max(added), 0)), "dests", json!(no_key)));
    }
    let grace_start = cfg.destinations.iter().map(|d| d.added_at).min().map(|a| a.max(st.first_seen_at)).unwrap_or(st.first_seen_at);
    if off_disk && st.recovery_key.is_none() && now - grace_start >= KEY_GRACE_SECS {
        alerts.push(alert("BACKUP_KEY_NOT_EXPORTED", "warn", since(grace_start, KEY_GRACE_SECS)));
    }

    // A failed verify is a damaged repository; a drill that failed (or ran over the budget) is a restore that does not work.
    // A verify that merely ran out of time (`incomplete`) is not a failure. A drill marker "interrupted" while the lock is held
    // is the drill that is running right now.
    let interrupted = |d: &str| d.starts_with("interrupted");
    // `failing_since` is the first time it failed for real; it survives the interrupted marker of a retry (so the alert stays up while
    // the retry runs) and is the stable `since`. Without it, an unfinished or interrupted run is not a failure.
    let mut failed: Vec<(i64, &str)> = Vec::new();
    if let Some(v) = st.verify.as_ref().filter(|v| !v.ok && (v.failing_since.is_some() || !v.incomplete)) {
        failed.push((v.failing_since.unwrap_or(v.at), "verify"));
    }
    if let Some(d) = st.drill.as_ref().filter(|d| !d.ok && (d.failing_since.is_some() || !(x.running && interrupted(&d.detail)))) {
        failed.push((d.failing_since.unwrap_or(d.at), "drill"));
    }
    if let Some((at, _)) = failed.iter().min() {
        let what: Vec<&str> = failed.iter().map(|(_, w)| *w).collect();
        alerts.push(with(alert("BACKUP_VERIFY_FAILED", "critical", since(*at, 0)), "what", json!(what)));
    }

    // Overdue: per repository (its own clock), plus the drill. The global verify record only speaks for installs whose repository
    // clocks have not caught up. A basis of 0 is unknown history, which the stale alert already reports.
    // The clock runs from the last pass; before any pass it runs from when this store (or this drive) came under backup.
    let first = st.first_seen_at;
    let basis = |passed: i64, floor: i64| if passed > 0 { passed } else { floor };
    let mut overdue: Vec<(Option<String>, &str, i64)> = vec![(Some("local".into()), "verify", basis(st.local_verified_at, first))];
    for d in &cfg.destinations {
        let v = st.destinations.get(&d.name).map_or(0, |s| s.verified_at);
        overdue.push((Some(d.name.clone()), "verify", basis(v, first.max(d.added_at))));
    }
    let drill_basis = basis(st.drill.as_ref().map_or(0, |d| d.last_pass_at), first);
    let global_basis = basis(st.verify.as_ref().map_or(0, |v| v.last_pass_at), first);
    let due = |b: i64| b > 0 && now - b > VERIFY_OVERDUE_SECS;
    // a drive that is away or replaced already has its own alert; it is not also "overdue"
    let away: Vec<&str> = down.iter().chain(foreign.iter()).map(|(n, _)| *n).collect();
    let mut repo_hits: Vec<_> = overdue.iter().filter(|(d, _, b)| due(*b) && !d.as_deref().is_some_and(|n| away.contains(&n))).cloned().collect();
    if repo_hits.is_empty() && due(global_basis) {
        repo_hits.push((None, "verify", global_basis));
    }
    if due(drill_basis) {
        repo_hits.push((None, "drill", drill_basis));
    }
    for (dest, what, b) in repo_hits {
        let a = with(alert("BACKUP_VERIFY_OVERDUE", "warn", since(b, VERIFY_OVERDUE_SECS)), "what", json!(what));
        alerts.push(if let Some(n) = dest { with(a, "dest", json!(n)) } else { a });
    }

    // Photos the backup could not read (the database itself is safe).
    let photos = st.photos_unreadable.as_ref().map(|p| {
        let whole = x.photos_dir.as_deref().map(norm_dir).is_some_and(|dir| p.paths.iter().any(|q| norm_dir(q) == dir));
        let persisted = now - p.at >= PHOTOS_UNREADABLE_CRITICAL_SECS;
        let (level, s) = if whole { ("critical", since(p.at, 0)) } else if persisted { ("critical", since(p.at, PHOTOS_UNREADABLE_CRITICAL_SECS)) } else { ("warn", since(p.at, 0)) };
        // the count only: file names are in the backup log and `posctl backup` output, not in the file every till can fetch
        (with(alert("BACKUP_PHOTOS_UNREADABLE", level, s), "count", json!(p.total)), p)
    });
    if let Some((a, _)) = &photos {
        alerts.push(a.clone());
    }

    // The last restore: shown always; its warnings alert for a week.
    let mut restore_canary_warned_at = None;
    let last_restore = st.last_restore.as_ref().map(|lr| {
        if lr.warnings.iter().any(|w| w == "CANARY_AFTER_RESTORE") {
            restore_canary_warned_at = Some(lr.at);
        }
        let shown: Vec<&String> = lr.warnings.iter().filter(|w| RESTORE_ALERT_WARNINGS.contains(&w.as_str()))
            .filter(|w| w.as_str() != "POST_RESTORE_BACKUP_FAILED" || st.backup_due_now || st.local.as_ref().is_none_or(|l| l.at <= lr.at)).collect();
        if lr.result == "restored" && !shown.is_empty() && (0..RESTORE_WARNING_SHOW_SECS).contains(&(now - lr.at)) {
            alerts.push(with(alert("BACKUP_RESTORE_WARNING", "warn", since(lr.at, 0)), "warnings", json!(shown)));
        }
        let reason = lr.reason.as_deref().filter(|r| !r.is_empty() && r.len() <= 48 && r.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'));
        json!({ "at": iso_utc(lr.at), "result": lr.result, "reason": reason, "snapshot": lr.snapshot, "warnings": lr.warnings })
    });

    let level = if alerts.iter().any(|a| a["level"] == "critical") { "critical" } else if alerts.is_empty() { "none" } else { "warn" };
    let reason = if !down.is_empty() {
        Some("destination-down")
    } else if !foreign.is_empty() {
        Some("destination-foreign")
    } else if !off_disk {
        Some("no-destination")
    } else if newest.is_none() {
        Some(if history_unknown { "history-unknown" } else { "never-copied" })
    } else if age.is_some_and(|a| a >= WARN_AFTER_SECS) {
        Some("stale")
    } else {
        None
    };

    let attempt_failed = !st.last_attempt_ok && st.last_attempt_at > 0;
    let last_error_kind = (attempt_failed && !x.running).then(|| error_kind(st.last_error.as_deref().unwrap_or("")));
    let mut dests = vec![json!({
        "name": "local", "kind": "local",
        "ok": st.local.is_some() && (st.last_attempt_ok || st.last_attempt_at == 0),
        "lastSuccessAt": st.local.as_ref().map(|s| iso_utc(s.at)),
        "verifiedAt": (st.local_verified_at > 0).then(|| iso_utc(st.local_verified_at)),
    })];
    for d in &cfg.destinations {
        let s = st.destinations.get(&d.name);
        dests.push(json!({
            "name": d.name,
            "kind": if d.kind == DestKind::R2 { "r2" } else { "device" },
            "ok": s.map(|x| x.ok && (d.kind == DestKind::R2 || x.reachable)).unwrap_or(false),
            "reachable": s.map(|x| x.reachable),
            "foreign": s.is_some_and(|x| x.foreign),
            "lastSuccessAt": s.and_then(|x| x.last_success.as_ref()).map(|x| iso_utc(x.at)),
            "verifiedAt": s.filter(|x| x.verified_at > 0).map(|x| iso_utc(x.verified_at)),
            "error": s.filter(|x| !x.ok && x.last_error.is_some()).map(|x| error_kind(x.last_error.as_deref().unwrap_or(""))),
        }));
    }
    let block = json!({
        "configured": true,
        "readable": true,
        "lastSuccessAt": newest.as_ref().map(|s| iso_utc(s.at)),
        "lastKind": newest.as_ref().map(|s| s.reason.clone()),
        "ageSeconds": age,
        "alert": level,
        "reason": reason,
        "offDisk": off_disk,
        "historyUnknown": history_unknown,
        "running": x.running,
        "localLastSuccessAt": st.local.as_ref().map(|s| iso_utc(s.at)),
        "lastAttemptAt": (st.last_attempt_at > 0).then(|| iso_utc(st.last_attempt_at)),
        "lastAttemptOk": (st.last_attempt_at > 0).then_some(st.last_attempt_ok),
        "lastError": last_error_kind,
        "destinations": dests,
        "recoveryKeyIssued": st.recovery_key.is_some(),
        "lastVerifyAt": st.verify.as_ref().map(|v| iso_utc(v.at)),
        "lastVerifyOk": st.verify.as_ref().map(|v| v.ok),
        "lastVerifyIncomplete": st.verify.as_ref().map(|v| v.incomplete),
        "lastDrillAt": st.drill.as_ref().map(|d| iso_utc(d.at)),
        "lastDrillOk": st.drill.as_ref().map(|d| d.ok),
        "photosUnreadable": photos.as_ref().map(|(_, p)| json!({ "count": p.total, "since": iso_utc(p.at) })),
        "lastRestore": last_restore,
    });
    Computed { block, alerts, last_error_kind, restore_canary_warned_at }
}

/// Is `backup.lock` held right now? Read-only: it opens the file for reading (never creates it) and tries a shared lock, which a
/// running backup, verify or drill (exclusive) refuses. Unknown (cannot open) counts as "not running".
fn lock_held(path: &Path) -> bool {
    let Ok(f) = std::fs::OpenOptions::new().read(true).open(path) else { return false };
    match f.try_lock_shared() {
        Ok(()) => {
            let _ = f.unlock();
            false
        }
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(_) => false,
    }
}

/// The reader behind `health --write`: configuration, state and one lock probe, nothing else (no restic, no psql), and it never
/// writes: a corrupt state file is read as "history unknown" and left for the next backup to set aside. A machine that is not
/// provisioned for backups, or has them off, reports a quiet block. Anything unreadable says so (`BACKUP_STATE_UNKNOWN`).
pub fn read(paths: &BackupPaths, now: i64) -> Computed {
    let cfg = match config::load(&paths.conf_file()) {
        Ok(c) if c.enabled => c,
        Ok(_) => return Computed::quiet(),
        Err(e) if e.code == Code::NotProvisioned => return Computed::quiet(),
        Err(_) => return Computed::unreadable(),
    };
    let st = match std::fs::read_to_string(paths.state_file()) {
        Ok(t) => serde_json::from_str::<BackupState>(&t).unwrap_or_else(|_| BackupState { first_seen_at: 0, ..Default::default() }),
        // never ticked (or the tick never ran): the service is as old as its configuration. A missing state file must not look young
        // for ever, so age it from when the backup config file was CREATED (not modified: `dest add` rewrites it).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BackupState { first_seen_at: super::state::config_created(paths, now), ..Default::default() },
        Err(_) => return Computed::unreadable(),
    };
    let x = Extra { photos_dir: Some(paths.photos().to_string_lossy().into_owned()), running: lock_held(&paths.backup_lock()) };
    compute_with(&st, &cfg, now, &x)
}

/// For `health --write` (Plan 05) and Plan 11: the block and the alerts, built by `read`. Takes no lock that a backup would wait for.
pub fn fragment(ctx: &BackupCtx, now: i64) -> StatusFragment {
    let c = read(&ctx.paths, now);
    StatusFragment { backup: c.block, alerts: c.alerts }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{BackupConfig, DestKind, Destination};
    use crate::backup::state::{BackupState, CheckRef, DestState, DrillRef, LastRestore, PhotosUnreadableRef, RecoveryKeyRef, SnapRef};

    const T0: i64 = 1_790_000_000;
    const H: i64 = 3600;
    const D: i64 = 86_400;

    fn dest(name: &str, kind: DestKind, added: i64) -> Destination {
        Destination { name: name.into(), kind, path: Some(r"E:\b".into()), repo: Some("s3:x".into()), volume_serial: None, added_at: added, extra: Default::default() }
    }
    fn cfg(d: Vec<Destination>) -> BackupConfig {
        BackupConfig { destinations: d, ..Default::default() }
    }
    fn snap(at: i64) -> Option<SnapRef> {
        Some(SnapRef { id: "a".into(), at, reason: "hourly".into() })
    }
    fn healthy_state(first: i64) -> BackupState {
        let mut s = BackupState {
            first_seen_at: first,
            local: snap(T0),
            last_attempt_ok: true,
            recovery_key: Some(RecoveryKeyRef { issued_at: first, key_ids: [("local".to_string(), "k1".to_string()), ("usb".to_string(), "k2".to_string())].into() }),
            local_verified_at: T0,
            ..Default::default()
        };
        s.destinations.insert("usb".into(), DestState { reachable: true, ok: true, last_success: snap(T0), verified_at: T0, ..Default::default() });
        s.verify = Some(CheckRef { at: T0, ok: true, last_pass_at: T0, detail: String::new(), incomplete: false, ..Default::default() });
        s.drill = Some(DrillRef { at: T0, ok: true, last_pass_at: T0, seconds: 60, source: "usb".into(), detail: String::new(), ..Default::default() });
        s
    }
    fn usb_cfg() -> BackupConfig {
        cfg(vec![dest("usb", DestKind::Device, T0 - 100 * H)])
    }
    fn codes(c: &Computed) -> Vec<String> {
        c.alerts.iter().map(|a| a["code"].as_str().unwrap().to_string()).collect()
    }
    fn alert<'a>(c: &'a Computed, code: &str) -> &'a Value {
        c.alerts.iter().find(|a| a["code"] == code).unwrap_or_else(|| panic!("no {code} in {:?}", codes(c)))
    }

    // ---- the plan's table ----

    #[test]
    fn thresholds_are_exact_23h59_is_quiet_24h_warns_72h_is_critical_and_only_one_of_them() {
        let cfg = usb_cfg();
        let st = healthy_state(T0 - 100 * H);
        assert!(codes(&compute(&st, &cfg, T0 + 24 * H - 1)).is_empty());
        let w = compute(&st, &cfg, T0 + 24 * H);
        assert_eq!(codes(&w), ["BACKUP_STALE_24H"]);
        assert_eq!(w.block["alert"], "warn");
        assert_eq!(w.block["ageSeconds"], 24 * H);
        assert!(codes(&compute(&st, &cfg, T0 + 72 * H - 1)).iter().all(|c| c == "BACKUP_STALE_24H"));
        let c = compute(&st, &cfg, T0 + 72 * H);
        assert_eq!(codes(&c), ["BACKUP_STALE_72H"]);
        assert_eq!(c.block["alert"], "critical");
    }

    #[test]
    fn the_exact_boundaries_each_give_exactly_one_stale_alert() {
        for (cfg, st) in [(usb_cfg(), healthy_state(T0 - 100 * H)), (cfg(vec![]), BackupState { first_seen_at: T0, local: snap(T0), last_attempt_ok: true, ..Default::default() })] {
            let stale = |secs: i64| -> Vec<(String, String)> {
                compute(&st, &cfg, T0 + secs).alerts.iter().filter(|a| a["code"].as_str().unwrap().starts_with("BACKUP_STALE")).map(|a| (a["code"].as_str().unwrap().to_string(), a["level"].as_str().unwrap().to_string())).collect()
            };
            assert!(stale(24 * H - 60).is_empty(), "23:59 is quiet");
            assert_eq!(stale(24 * H), [("BACKUP_STALE_24H".to_string(), "warn".to_string())], "24:00 warns");
            assert_eq!(stale(72 * H - 60), [("BACKUP_STALE_24H".to_string(), "warn".to_string())], "71:59 still warns");
            assert_eq!(stale(72 * H), [("BACKUP_STALE_72H".to_string(), "critical".to_string())], "72:00 is critical");
        }
    }

    #[test]
    fn with_no_destination_the_stale_alerts_say_so_warn_on_days_one_to_three_then_critical() {
        let cfg = cfg(vec![]);
        let st = BackupState { first_seen_at: T0, local: snap(T0), last_attempt_ok: true, ..Default::default() };
        for secs in [24 * H, 48 * H, 72 * H - 60] {
            let c = compute(&st, &cfg, T0 + secs);
            assert_eq!((c.alerts[0]["code"].as_str(), c.alerts[0]["level"].as_str(), c.alerts[0]["reason"].as_str()), (Some("BACKUP_STALE_24H"), Some("warn"), Some("no-destination")));
            assert_eq!(c.block["reason"], "no-destination");
        }
        let c = compute(&st, &cfg, T0 + 72 * H);
        assert_eq!((c.alerts[0]["code"].as_str(), c.alerts[0]["level"].as_str(), c.alerts[0]["reason"].as_str()), (Some("BACKUP_STALE_72H"), Some("critical"), Some("no-destination")));
        // with a destination the stale alert has no reason word
        assert!(compute(&healthy_state(T0 - 100 * H), &usb_cfg(), T0 + 25 * H).alerts[0].get("reason").is_none());
    }

    #[test]
    fn since_does_not_move_from_one_minute_to_the_next() {
        let cfg = usb_cfg();
        let st = healthy_state(T0 - 100 * H);
        let a = compute(&st, &cfg, T0 + 30 * H);
        let b = compute(&st, &cfg, T0 + 30 * H + 60);
        assert_eq!(a.alerts[0]["since"], b.alerts[0]["since"]);
        assert_eq!(a.alerts[0]["since"], crate::backup::util::iso_utc(T0 + 24 * H));
    }

    #[test]
    fn a_removed_usb_raises_dest_down_immediately_even_though_the_last_copy_is_fresh() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.get_mut("usb").unwrap();
        d.reachable = false;
        d.ok = false;
        d.down_since = Some(T0 + 600);
        let c = compute(&st, &cfg, T0 + 900);
        assert_eq!(codes(&c), ["BACKUP_DEST_DOWN"]);
        assert_eq!(c.alerts[0]["since"], crate::backup::util::iso_utc(T0 + 600));
        assert_eq!(c.alerts[0]["dest"], "usb");
        assert_eq!(c.block["reason"], "destination-down");
        assert_eq!(c.block["destinations"][1]["ok"], false);
    }

    #[test]
    fn dest_down_without_a_recorded_time_has_no_since_instead_of_a_moving_one() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.destinations.get_mut("usb").unwrap().reachable = false;
        let a = compute(&st, &cfg, T0 + 900);
        let b = compute(&st, &cfg, T0 + 960);
        assert_eq!(a.alerts[0]["since"], Value::Null, "the writer stamps first-seen; a clock reading would move");
        assert_eq!(a.alerts, b.alerts);
    }

    #[test]
    fn an_r2_outage_is_not_a_destination_alarm_it_only_ages() {
        let cfg = cfg(vec![dest("r2", DestKind::R2, T0 - 100 * H)]);
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.remove("usb").unwrap();
        st.destinations.insert("r2".into(), DestState { reachable: false, ok: false, ..d });
        st.recovery_key.as_mut().unwrap().key_ids.insert("r2".into(), "k3".into());
        assert!(codes(&compute(&st, &cfg, T0 + 2 * H)).is_empty());
    }

    #[test]
    fn a_store_with_no_second_device_is_told_after_a_day_and_the_age_counts_from_the_first_run() {
        let cfg = cfg(vec![]);
        let st = BackupState { first_seen_at: T0, local: snap(T0), last_attempt_ok: true, ..Default::default() };
        assert!(codes(&compute(&st, &cfg, T0 + 23 * H)).is_empty());
        let c = compute(&st, &cfg, T0 + 25 * H);
        assert_eq!(codes(&c), ["BACKUP_STALE_24H"]);
        assert_eq!(c.block["reason"], "no-destination");
        assert_eq!(c.block["offDisk"], false);
        assert_eq!(c.block["lastSuccessAt"], Value::Null);
        assert_eq!(c.block["localLastSuccessAt"], crate::backup::util::iso_utc(T0));
        assert_eq!(compute(&st, &cfg, T0 + 80 * H).block["alert"], "critical");
    }

    #[test]
    fn the_recovery_key_reminder_waits_a_day_after_the_drive_is_added_and_stops_once_issued() {
        let added = T0 - 1000 * H;
        let cfg = cfg(vec![dest("usb", DestKind::Device, T0)]);
        let mut st = healthy_state(added);
        st.recovery_key = None;
        assert!(!codes(&compute(&st, &cfg, T0 + 23 * H)).contains(&"BACKUP_KEY_NOT_EXPORTED".to_string()));
        let c = compute(&st, &cfg, T0 + 25 * H);
        assert_eq!(alert(&c, "BACKUP_KEY_NOT_EXPORTED")["since"], crate::backup::util::iso_utc(T0 + 24 * H));
        st.recovery_key = Some(RecoveryKeyRef { issued_at: T0, key_ids: [("usb".to_string(), "k".to_string())].into() });
        assert!(!codes(&compute(&st, &cfg, T0 + 25 * H)).contains(&"BACKUP_KEY_NOT_EXPORTED".to_string()));
        assert_eq!(compute(&st, &cfg, T0 + 25 * H).block["recoveryKeyIssued"], true);
    }

    #[test]
    fn a_failed_drill_or_verify_is_critical_and_a_missing_one_is_only_overdue() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.drill = Some(DrillRef { at: T0 + H, ok: false, last_pass_at: T0, seconds: 5, source: "usb".into(), detail: "table differs".into(), ..Default::default() });
        let c = compute(&st, &cfg, T0 + 2 * H);
        assert_eq!(codes(&c), ["BACKUP_VERIFY_FAILED"]);
        assert_eq!(c.alerts[0]["since"], crate::backup::util::iso_utc(T0 + H));
        assert_eq!(c.block["alert"], "critical");
        assert_eq!(c.block["lastDrillOk"], false);
        let mut st2 = healthy_state(T0 - 100 * H);
        st2.verify = Some(CheckRef { at: T0, ok: true, last_pass_at: T0 - 11 * D, detail: String::new(), incomplete: false, ..Default::default() });
        let o = compute(&st2, &cfg, T0 + 600);
        assert_eq!(codes(&o), ["BACKUP_VERIFY_OVERDUE"]);
        assert_eq!(o.block["alert"], "warn");
    }

    #[test]
    fn a_fresh_install_is_not_overdue_for_ten_days() {
        let cfg = cfg(vec![dest("usb", DestKind::Device, T0)]);
        let mut st = healthy_state(T0);
        st.verify = None;
        st.drill = None;
        st.local_verified_at = 0;
        st.destinations.get_mut("usb").unwrap().verified_at = 0;
        let quiet = |now| compute(&st, &cfg, now).alerts.iter().filter(|a| a["code"] == "BACKUP_VERIFY_OVERDUE").count();
        assert_eq!(quiet(T0 + 9 * D), 0);
        assert!(quiet(T0 + 11 * D) > 0);
    }

    // ---- carries ----

    #[test]
    fn unknown_history_is_stale_at_once_with_a_since_the_writer_stamps_never_1970() {
        let cfg = cfg(vec![]);
        let st = BackupState { first_seen_at: 0, ..Default::default() };
        let c = compute(&st, &cfg, T0);
        assert_eq!(codes(&c), ["BACKUP_STALE_72H"]);
        assert_eq!(c.alerts[0]["since"], Value::Null);
        assert_eq!(c.block["historyUnknown"], true);
        assert_eq!(c.block["ageSeconds"], Value::Null);
        assert_eq!(c.block["alert"], "critical");
        assert!(!c.block.to_string().contains("1970") && !c.alerts[0].to_string().contains("1970"));
    }

    #[test]
    fn an_off_disk_snapshot_proves_history_even_when_the_state_file_started_fresh() {
        let cfg = usb_cfg();
        let st = healthy_state(0);
        let c = compute(&st, &cfg, T0 + H);
        assert!(c.alerts.is_empty(), "{:?}", c.alerts);
        assert_eq!(c.block["historyUnknown"], false);
    }

    #[test]
    fn an_interrupted_drill_is_not_an_alert_while_the_backup_lock_is_held_and_is_one_afterwards() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.drill = Some(DrillRef { at: T0 + H, ok: false, last_pass_at: T0, seconds: 0, source: String::new(), detail: "interrupted: the drill started and did not finish".into(), ..Default::default() });
        let running = compute_with(&st, &cfg, T0 + 2 * H, &Extra { running: true, ..Default::default() });
        assert!(running.alerts.is_empty(), "{:?}", running.alerts);
        assert_eq!(running.block["running"], true);
        assert_eq!(codes(&compute(&st, &cfg, T0 + 2 * H)), ["BACKUP_VERIFY_FAILED"]);
    }

    #[test]
    fn an_unfinished_verify_is_not_a_failure_it_only_ages_into_overdue() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.verify = Some(CheckRef { at: T0 + H, ok: false, last_pass_at: T0, detail: "could not finish reading local (timed out)".into(), incomplete: true, ..Default::default() });
        st.local_verified_at = T0;
        assert!(compute(&st, &cfg, T0 + 2 * H).alerts.is_empty());
        let later = compute(&st, &cfg, T0 + 11 * D);
        assert!(!codes(&later).contains(&"BACKUP_VERIFY_FAILED".to_string()), "{:?}", codes(&later));
        assert!(codes(&later).contains(&"BACKUP_VERIFY_OVERDUE".to_string()));
        let mut real = st.clone();
        real.verify = Some(CheckRef { at: T0 + H, ok: false, last_pass_at: T0, detail: "check failed".into(), incomplete: false, ..Default::default() });
        assert_eq!(codes(&compute(&real, &cfg, T0 + 2 * H)), ["BACKUP_VERIFY_FAILED"]);
    }

    #[test]
    fn overdue_is_named_per_repository() {
        let cfg = cfg(vec![dest("usb", DestKind::Device, T0 - 100 * D), dest("usb2", DestKind::Device, T0 - 100 * D)]);
        let mut st = healthy_state(T0 - 100 * D);
        st.destinations.insert("usb2".into(), DestState { reachable: true, ok: true, last_success: snap(T0), verified_at: T0 - 20 * D, ..Default::default() });
        st.recovery_key.as_mut().unwrap().key_ids.insert("usb2".into(), "k".into());
        st.verify.as_mut().unwrap().last_pass_at = T0 - 20 * D;
        let c = compute(&st, &cfg, T0 + H);
        let over: Vec<&Value> = c.alerts.iter().filter(|a| a["code"] == "BACKUP_VERIFY_OVERDUE").collect();
        assert_eq!(over.len(), 1, "{over:?}");
        assert_eq!(over[0]["dest"], "usb2");
        assert_eq!(over[0]["since"], crate::backup::util::iso_utc(T0 - 20 * D + 10 * D));
        st.local_verified_at = T0 - 30 * D;
        let c = compute(&st, &cfg, T0 + H);
        let names: Vec<&str> = c.alerts.iter().filter(|a| a["code"] == "BACKUP_VERIFY_OVERDUE").map(|a| a["dest"].as_str().unwrap()).collect();
        assert_eq!(names, ["local", "usb2"]);
    }

    #[test]
    fn photos_unreadable_is_a_warning_with_the_count_and_no_paths() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.photos_unreadable = Some(PhotosUnreadableRef { at: T0, total: 7, paths: (0..7).map(|i| format!(r"D:\photos\p{i}.jpg")).collect() });
        let c = compute_with(&st, &cfg, T0 + H, &Extra { photos_dir: Some(r"D:\photos".into()), ..Default::default() });
        let a = alert(&c, "BACKUP_PHOTOS_UNREADABLE");
        assert_eq!((a["level"].as_str(), a["count"].as_i64()), (Some("warn"), Some(7)));
        assert_eq!(a["since"], crate::backup::util::iso_utc(T0));
        assert!(a.get("paths").is_none() && c.block["photosUnreadable"].get("paths").is_none(), "the count only: no path reaches status.json");
        assert!(!format!("{a}{}", c.block).contains("p0.jpg"));
        assert_eq!(c.block["alert"], "warn");
        assert_eq!(c.block["photosUnreadable"]["count"], 7);
    }

    #[test]
    fn photos_unreadable_escalates_when_it_persists_or_the_whole_folder_is_unreadable_and_never_both_levels() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        let extra = Extra { photos_dir: Some(r"D:\Data\photos".into()), ..Default::default() };
        st.photos_unreadable = Some(PhotosUnreadableRef { at: T0, total: 1, paths: vec![r"D:\Data\photos\a.jpg".into()] });
        let lvl = |now| {
            let c = compute_with(&st, &cfg, now, &extra);
            let v: Vec<String> = c.alerts.iter().filter(|a| a["code"] == "BACKUP_PHOTOS_UNREADABLE").map(|a| a["level"].as_str().unwrap().to_string()).collect();
            v
        };
        assert_eq!(lvl(T0 + PHOTOS_UNREADABLE_CRITICAL_SECS - 1), ["warn"]);
        assert_eq!(lvl(T0 + PHOTOS_UNREADABLE_CRITICAL_SECS), ["critical"]);
        let c = compute_with(&st, &cfg, T0 + PHOTOS_UNREADABLE_CRITICAL_SECS + 5, &extra);
        assert_eq!(alert(&c, "BACKUP_PHOTOS_UNREADABLE")["since"], crate::backup::util::iso_utc(T0 + PHOTOS_UNREADABLE_CRITICAL_SECS));
        // the whole folder: critical at once
        st.photos_unreadable = Some(PhotosUnreadableRef { at: T0, total: 1, paths: vec![r"d:\data\photos\".into()] });
        let c = compute_with(&st, &cfg, T0 + H, &extra);
        assert_eq!(alert(&c, "BACKUP_PHOTOS_UNREADABLE")["level"], "critical");
        assert_eq!(alert(&c, "BACKUP_PHOTOS_UNREADABLE")["since"], crate::backup::util::iso_utc(T0));
        assert_eq!(c.alerts.iter().filter(|a| a["code"] == "BACKUP_PHOTOS_UNREADABLE").count(), 1);
    }

    #[test]
    fn a_destination_the_recovery_key_cannot_open_is_flagged() {
        let cfg = cfg(vec![dest("usb", DestKind::Device, T0 - 100 * H), dest("r2", DestKind::R2, T0 - 50 * H)]);
        let mut st = healthy_state(T0 - 100 * H);
        st.destinations.insert("r2".into(), DestState { reachable: true, ok: true, last_success: snap(T0), verified_at: T0, ..Default::default() });
        // the key was issued before r2 existed and r2 never got it
        st.recovery_key = Some(RecoveryKeyRef { issued_at: T0 - 90 * H, key_ids: [("local".to_string(), "k1".to_string()), ("usb".to_string(), "k2".to_string())].into() });
        let c = compute(&st, &cfg, T0 + H);
        let a = alert(&c, "BACKUP_DEST_NO_RECOVERY_KEY");
        assert_eq!((a["level"].as_str(), a["dests"][0].as_str()), (Some("warn"), Some("r2")));
        assert_eq!(a["since"], crate::backup::util::iso_utc(T0 - 50 * H));
        st.recovery_key.as_mut().unwrap().key_ids.insert("r2".into(), "k3".into());
        assert!(!codes(&compute(&st, &cfg, T0 + H)).contains(&"BACKUP_DEST_NO_RECOVERY_KEY".to_string()));
    }

    #[test]
    fn a_reachable_destination_that_keeps_failing_is_flagged_after_six_hours_with_the_kind_of_error() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.get_mut("usb").unwrap();
        d.ok = false;
        d.last_error = Some(r"restic copy failed: no space left on device writing E:\b\data\ab".into());
        d.failing_since = Some(T0 + H);
        assert!(!codes(&compute(&st, &cfg, T0 + 7 * H - 1)).contains(&"BACKUP_DEST_FAILING".to_string()));
        let c = compute(&st, &cfg, T0 + 7 * H);
        let a = alert(&c, "BACKUP_DEST_FAILING");
        assert_eq!((a["level"].as_str(), a["dest"].as_str(), a["error"].as_str()), (Some("warn"), Some("usb"), Some("disk-full")));
        assert_eq!(a["since"], crate::backup::util::iso_utc(T0 + 7 * H));
        assert_eq!(c.block["destinations"][1]["error"], "disk-full");
        assert!(!c.block.to_string().contains("E:\\"));
    }

    #[test]
    fn a_cut_off_copy_that_resumes_on_the_next_tick_is_not_a_failing_destination() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.get_mut("usb").unwrap();
        d.ok = false;
        d.last_error = Some("copy time cap reached; resumes on the next tick".into());
        d.failing_since = None;
        assert!(!codes(&compute(&st, &cfg, T0 + 10 * H)).contains(&"BACKUP_DEST_FAILING".to_string()));
    }

    #[test]
    fn a_different_drive_under_the_letter_is_its_own_alert_and_not_destination_down() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.get_mut("usb").unwrap();
        d.reachable = false;
        d.ok = false;
        d.foreign = true;
        d.down_since = Some(T0 + 600);
        let c = compute(&st, &cfg, T0 + 900);
        assert_eq!(codes(&c), ["BACKUP_DEST_FOREIGN"]);
        assert_eq!(c.alerts[0]["since"], crate::backup::util::iso_utc(T0 + 600));
        assert_eq!(c.block["reason"], "destination-foreign");
        assert_eq!(c.block["destinations"][1]["foreign"], true);
    }

    #[test]
    fn the_last_restore_is_shown_and_its_warnings_alert_for_a_week() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.last_restore = Some(LastRestore { at: T0 - H, result: "restored".into(), reason: None, snapshot: "ab12cd34".into(), warnings: vec!["PHOTOS_SOME_MISSING".into(), "PREV_COPY_REVOKE_FAILED".into()] });
        let c = compute(&st, &cfg, T0 + H);
        assert_eq!(c.block["lastRestore"]["result"], "restored");
        assert_eq!(c.block["lastRestore"]["warnings"][0], "PHOTOS_SOME_MISSING");
        let a = alert(&c, "BACKUP_RESTORE_WARNING");
        assert_eq!((a["level"].as_str(), a["warnings"].as_array().unwrap().len()), (Some("warn"), 2));
        assert_eq!(a["since"], crate::backup::util::iso_utc(T0 - H));
        assert!(!codes(&compute(&st, &cfg, T0 - H + RESTORE_WARNING_SHOW_SECS)).contains(&"BACKUP_RESTORE_WARNING".to_string()));
    }

    #[test]
    fn a_post_restore_backup_warning_clears_when_a_later_backup_completed() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.last_restore = Some(LastRestore { at: T0 + 10, result: "restored".into(), reason: None, snapshot: "ab12cd34".into(), warnings: vec!["POST_RESTORE_BACKUP_FAILED".into()] });
        assert!(codes(&compute(&st, &cfg, T0 + H)).contains(&"BACKUP_RESTORE_WARNING".to_string()), "local backup is older than the restore");
        st.local = snap(T0 + 20);
        assert!(!codes(&compute(&st, &cfg, T0 + H)).contains(&"BACKUP_RESTORE_WARNING".to_string()));
    }

    #[test]
    fn a_restore_is_not_an_alert_by_itself_and_a_rolled_back_one_is_only_reported() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.last_restore = Some(LastRestore { at: T0, result: "rolled_back".into(), reason: Some("VERIFY_FAILED".into()), snapshot: "ab12".into(), warnings: vec![] });
        let c = compute(&st, &cfg, T0 + H);
        assert!(c.alerts.is_empty());
        assert_eq!(c.block["lastRestore"]["result"], "rolled_back");
        assert_eq!(c.block["lastRestore"]["reason"], "VERIFY_FAILED");
    }

    #[test]
    fn a_canary_warning_after_a_restore_is_remembered_for_the_sign_in_alert() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * H);
        st.last_restore = Some(LastRestore { at: T0, result: "restored".into(), reason: None, snapshot: "ab12".into(), warnings: vec!["CANARY_AFTER_RESTORE".into()] });
        assert_eq!(compute(&st, &cfg, T0 + H).restore_canary_warned_at, Some(T0));
        st.last_restore.as_mut().unwrap().warnings.clear();
        assert_eq!(compute(&st, &cfg, T0 + H).restore_canary_warned_at, None);
    }

    #[test]
    fn the_last_error_is_a_fixed_word_never_the_error_text() {
        assert_eq!(error_kind(r"restic copy failed: no space left on device writing E:\b"), "disk-full");
        assert_eq!(error_kind("There is not enough space on the disk"), "disk-full");
        assert_eq!(error_kind("the drive is not connected"), "not-connected");
        assert_eq!(error_kind("Access is denied. (os error 5)"), "access-denied");
        assert_eq!(error_kind("timed out after 7200 s"), "timed-out");
        assert_eq!(error_kind("interrupted"), "interrupted");
        assert_eq!(error_kind("wrong password or no key found"), "wrong-key");
        assert_eq!(error_kind("pg_dump failed on 127.0.0.1 with password=hunter2"), "failed");
    }

    #[test]
    fn the_block_and_the_alerts_never_carry_a_path_an_address_or_a_secret_shaped_value() {
        let cfg = usb_cfg();
        let key = "ab".repeat(32);
        let mut st = healthy_state(T0 - 100 * H);
        let d = st.destinations.get_mut("usb").unwrap();
        d.ok = false;
        d.failing_since = Some(T0);
        let uri = format!("{}://u:{}@h/db", "postgres", "pw"); // built at run time: secret-lint
        d.last_error = Some(format!(r"E:\secret\place failed 10.1.2.3 password=hunter2 key {key} {uri}"));
        st.last_error = Some(format!("pg_dump failed on 127.0.0.1 {key}"));
        st.last_attempt_ok = false;
        st.last_attempt_at = T0;
        st.photos_unreadable = Some(PhotosUnreadableRef { at: T0, total: 2, paths: vec![r"D:\Data\photos\secret-name.jpg".into(), r"D:\Data\photos".into()] });
        st.verify = Some(CheckRef { at: T0, ok: false, last_pass_at: T0, detail: format!(r"E:\x {key}"), incomplete: false, ..Default::default() });
        st.drill = Some(DrillRef { at: T0, ok: false, last_pass_at: T0, seconds: 1, source: r"E:\src".into(), detail: format!("password=hunter2 {key}"), ..Default::default() });
        let c = compute_with(&st, &cfg, T0 + 8 * H, &Extra { photos_dir: Some(r"D:\Data\photos".into()), ..Default::default() });
        assert!(c.alerts.iter().any(|a| a["code"] == "BACKUP_PHOTOS_UNREADABLE"));
        let all = format!("{}{}", c.block, serde_json::Value::Array(c.alerts.clone()));
        for bad in ["E:\\", "D:\\", "photos\\", "127.0.0.1", "10.1.2.3", "hunter2", "postgres://", "pw@", key.as_str(), "secret"] {
            assert!(!all.contains(bad), "{bad} leaked into {all}");
        }
        assert!(all.contains("disk-full") || all.contains("failed"), "{all}");
        assert_eq!(c.block["lastError"], "failed");
    }

    #[test]
    fn a_destination_that_is_down_or_foreign_is_not_also_reported_overdue() {
        let cfg = usb_cfg();
        let mut st = healthy_state(T0 - 100 * D);
        st.destinations.get_mut("usb").unwrap().verified_at = T0 - 30 * D;
        st.verify.as_mut().unwrap().last_pass_at = T0;
        let over = |st: &BackupState| compute(st, &cfg, T0 + H).alerts.iter().filter(|a| a["code"] == "BACKUP_VERIFY_OVERDUE").count();
        assert_eq!(over(&st), 1, "connected and unverified: overdue");
        st.destinations.get_mut("usb").unwrap().reachable = false;
        st.destinations.get_mut("usb").unwrap().down_since = Some(T0);
        assert_eq!(over(&st), 0, "down: BACKUP_DEST_DOWN speaks");
        st.destinations.get_mut("usb").unwrap().foreign = true;
        assert_eq!(over(&st), 0, "foreign: BACKUP_DEST_FOREIGN speaks");
    }

    fn failed_state(failing_since: Option<i64>, at: i64, detail: &str, incomplete: bool) -> BackupState {
        let mut st = healthy_state(T0 - 100 * H);
        st.drill = Some(DrillRef { at, ok: false, last_pass_at: T0, seconds: 0, source: String::new(), detail: detail.into(), failing_since });
        st.verify = Some(CheckRef { at, ok: false, last_pass_at: T0, detail: detail.into(), incomplete, failing_since });
        st
    }

    #[test]
    fn verify_failed_since_is_the_first_failure_not_the_latest_run() {
        let cfg = usb_cfg();
        let first = compute(&failed_state(Some(T0 + H), T0 + H, "table differs", false), &cfg, T0 + 2 * H);
        let again = compute(&failed_state(Some(T0 + H), T0 + 30 * H, "table differs", false), &cfg, T0 + 31 * H);
        let since = |c: &Computed| alert(c, "BACKUP_VERIFY_FAILED")["since"].clone();
        assert_eq!(since(&first), since(&again));
        assert_eq!(since(&first), crate::backup::util::iso_utc(T0 + H));
    }

    #[test]
    fn an_interrupted_marker_during_a_retry_keeps_the_alert_up_and_a_first_time_one_does_not_raise_it() {
        let cfg = usb_cfg();
        let marker = "interrupted: started and did not finish";
        // a retry of a drill/verify that already failed: marker written, run still going or killed
        let retry = failed_state(Some(T0 + H), T0 + 30 * H, marker, true);
        for running in [true, false] {
            let c = compute_with(&retry, &cfg, T0 + 31 * H, &Extra { running, ..Default::default() });
            let a = alert(&c, "BACKUP_VERIFY_FAILED");
            assert_eq!(a["since"], crate::backup::util::iso_utc(T0 + H), "running={running}");
        }
        // the first run that has only just started (no earlier failure) is not a failure while it runs
        let first = failed_state(None, T0 + 30 * H, marker, true);
        assert!(!codes(&compute_with(&first, &cfg, T0 + 31 * H, &Extra { running: true, ..Default::default() })).contains(&"BACKUP_VERIFY_FAILED".to_string()));
    }

    #[test]
    fn a_pass_clears_the_failed_alert() {
        let cfg = usb_cfg();
        let mut st = failed_state(Some(T0 + H), T0 + 2 * H, "x", false);
        assert!(codes(&compute(&st, &cfg, T0 + 3 * H)).contains(&"BACKUP_VERIFY_FAILED".to_string()));
        st.drill = Some(DrillRef { at: T0 + 3 * H, ok: true, last_pass_at: T0 + 3 * H, failing_since: None, ..Default::default() });
        st.verify = Some(CheckRef { at: T0 + 3 * H, ok: true, last_pass_at: T0 + 3 * H, failing_since: None, ..Default::default() });
        assert!(!codes(&compute(&st, &cfg, T0 + 4 * H)).contains(&"BACKUP_VERIFY_FAILED".to_string()));
    }

    // ---- the reader ----

    fn rooted() -> (tempfile::TempDir, crate::backup::paths::BackupPaths) {
        let d = tempfile::tempdir().unwrap();
        let roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("prog"));
        let paths = crate::backup::paths::BackupPaths::from_roots(&roots);
        std::fs::create_dir_all(paths.state_dir()).unwrap();
        std::fs::create_dir_all(paths.conf_file().parent().unwrap()).unwrap();
        std::fs::create_dir_all(paths.backups()).unwrap();
        (d, paths)
    }
    fn write_conf(p: &crate::backup::paths::BackupPaths, body: &str) {
        std::fs::write(p.conf_file(), body).unwrap();
    }

    #[test]
    fn the_fragment_for_an_unprovisioned_machine_is_quiet() {
        let (_d, p) = rooted();
        let c = read(&p, T0);
        assert_eq!(c.block["configured"], false);
        assert_eq!(c.block["alert"], "none");
        assert!(c.alerts.is_empty());
    }

    #[test]
    fn the_fragment_reads_config_and_state_and_never_writes() {
        let (_d, p) = rooted();
        write_conf(&p, r#"{"schema":1,"backup":{"enabled":true,"destinations":[]}}"#);
        healthy_state(T0 - 100 * H).save_unprotected(&p.state_file()).unwrap();
        let before = std::fs::read(p.state_file()).unwrap();
        let c = read(&p, T0 + 2 * H);
        assert_eq!(c.block["configured"], true);
        assert_eq!(std::fs::read(p.state_file()).unwrap(), before);
        // a missing state file is a fresh start, and creating nothing
        std::fs::remove_file(p.state_file()).unwrap();
        let c = read(&p, T0);
        assert_eq!(c.block["ageSeconds"], 0);
        assert!(!p.state_file().exists());
    }

    #[test]
    fn a_store_that_never_wrote_a_state_file_is_aged_from_when_its_backup_config_was_created() {
        use std::os::windows::fs::FileTimesExt;
        let (_d, p) = rooted();
        write_conf(&p, r#"{"backup":{"enabled":true,"destinations":[]}}"#);
        let f = std::fs::OpenOptions::new().write(true).open(p.conf_file()).unwrap();
        let made = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 3600);
        f.set_times(std::fs::FileTimes::new().set_created(made)).unwrap();
        drop(f);
        // the file was rewritten just now (as `dest add` does): its modified time says nothing
        let now = made.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 25 * 3600;
        let c = read(&p, now);
        assert_eq!(codes(&c), ["BACKUP_STALE_24H"], "{:?}", c.block);
        assert!(c.block["ageSeconds"].as_i64().unwrap() >= 25 * 3600 - 5);
    }

    #[test]
    fn a_corrupt_state_file_is_unknown_history_and_is_left_where_it_is() {
        let (_d, p) = rooted();
        write_conf(&p, r#"{"backup":{"enabled":true}}"#);
        std::fs::write(p.state_file(), b"{ not json").unwrap();
        let c = read(&p, T0);
        assert_eq!(c.block["historyUnknown"], true);
        assert_eq!(std::fs::read(p.state_file()).unwrap(), b"{ not json");
        assert_eq!(std::fs::read_dir(p.state_dir()).unwrap().count(), 1, "no .corrupt- file: only the tick sets evidence aside");
    }

    #[test]
    fn a_state_that_cannot_be_read_says_unreadable_instead_of_crashing() {
        let (_d, p) = rooted();
        write_conf(&p, r#"{"backup":{"enabled":true}}"#);
        std::fs::create_dir(p.state_file()).unwrap(); // reading a directory is an error that is not NotFound
        let c = read(&p, T0);
        assert_eq!(c.block["reason"], "unreadable");
        assert_eq!(c.block["alert"], "warn");
        assert_eq!(codes(&c), ["BACKUP_STATE_UNKNOWN"]);
        assert_eq!(c.alerts[0]["since"], Value::Null);
        assert!(c.alerts[0]["message"].as_str().unwrap().contains("administrator"));
    }

    #[test]
    fn a_held_backup_lock_is_reported_as_running_and_hides_an_interrupted_marker() {
        let (_d, p) = rooted();
        write_conf(&p, r#"{"backup":{"enabled":true,"destinations":[]}}"#);
        let mut st = healthy_state(T0 - 100 * H);
        st.drill = Some(DrillRef { at: T0, ok: false, last_pass_at: T0, seconds: 0, source: String::new(), detail: "interrupted: the drill started and did not finish".into(), ..Default::default() });
        st.save_unprotected(&p.state_file()).unwrap();
        let f = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(p.backup_lock()).unwrap();
        f.try_lock().unwrap();
        let held = read(&p, T0 + H);
        assert_eq!(held.block["running"], true);
        assert!(!codes(&held).contains(&"BACKUP_VERIFY_FAILED".to_string()), "{:?}", codes(&held));
        f.unlock().unwrap();
        let free = read(&p, T0 + H);
        assert_eq!(free.block["running"], false);
        assert!(codes(&free).contains(&"BACKUP_VERIFY_FAILED".to_string()));
    }

    #[test]
    fn the_fragment_entry_point_matches_the_reader() {
        let (_d, p) = rooted();
        let roots = p.roots().clone();
        let ctx = crate::backup::ctx::BackupCtx::new(&roots, std::path::PathBuf::from(r"C:\pack"), crate::ports::Ports::new(47300).unwrap(), "t".into(), "t".into());
        let f = fragment(&ctx, T0);
        assert_eq!(f.backup["configured"], false);
        assert!(f.alerts.is_empty());
    }
}
