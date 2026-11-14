//! `backup list`, `backup verify [--read-data]`: the weekly check, retention on every repository and the protect-tag
//! expiry. Verify runs under the same gates as a backup (`update.lock` shared + `backup.lock`), so it never overlaps a
//! backup, a restore or an update.
//!
//! The update.lock tradeoff: a verify that holds `update.lock` shared keeps the unattended updater out (it wants the lock
//! exclusively and waits at most `OPERATION_LOCK_WAIT_SECS`, or fails with LOCK_HELD and tries again later). `--read-data` on
//! a big USB disk can take hours, so the whole run is bounded by `VERIFY_BUDGET_SECS`: every child gets
//! `min(its own timeout, time left)` and a repository the budget ran out for is reported as NOT verified (a failure, never a
//! pass). The scheduled weekly task should run in the small hours; a manual run is the owner's choice.
use serde_json::{json, Value};
use std::time::Duration;

use super::config::{self, BackupConfig, DestKind};
use super::ctx::BackupCtx;
use super::dest::{self, Reach};
use super::repo::{dest_repo, ensure_local_repo, local_exists, local_repo};
use super::restic::{self, describe_exit, expired_protected, parse_snapshots, run_restic, run_restic_with, ReadData, Repo, Snap};
use super::result::{BResult, BackupError};
use super::run::{gated, Deps, Gate, LockPolicy};
use super::state::{BackupState, CheckRef, DestState};
use super::util::{iso_utc, tail, RunOutput};

const HOUR: u64 = 3600;
/// A repository is verified, and pruned, once its own clock is this old.
pub(crate) const MAINTENANCE_EVERY_SECS: i64 = 6 * 86_400;

/// Only removes stale locks (restic refuses to remove a live one).
pub(crate) const UNLOCK_TIMEOUT: Duration = Duration::from_secs(120);
const SNAPSHOTS_TIMEOUT: Duration = Duration::from_secs(300);
const TAG_TIMEOUT: Duration = Duration::from_secs(300);
/// `forget` without `--prune` only rewrites snapshot references.
const FORGET_TIMEOUT: Duration = Duration::from_secs(600);
/// `forget --prune` repacks: minutes on a small store, long on a big USB disk.
pub(crate) const PRUNE_TIMEOUT: Duration = Duration::from_secs(2 * HOUR);
/// `check` without `--read-data` reads metadata and the index only.
pub(crate) const CHECK_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// `check --read-data` of the local repository or a device: reads every pack. 2 h is about 70 GB at a slow USB disk's
/// 10 MB/s; a bigger repository fails here visibly (BACKUP_VERIFY_FAILED) instead of holding the lock for ever.
pub(crate) const READ_DATA_TIMEOUT: Duration = Duration::from_secs(2 * HOUR);
/// R2 reads a 5% sample (egress costs money).
const R2_READ_DATA_TIMEOUT: Duration = Duration::from_secs(HOUR);
/// The whole run, all repositories together (see the module doc).
pub(crate) const VERIFY_BUDGET_SECS: i64 = 4 * HOUR as i64;
/// Each repository gets an equal share of the budget, never less than this, so a slow local read cannot starve the USB
/// disk (and the shares add up to the budget unless there are more than eight repositories).
pub(crate) const MIN_REPO_SHARE_SECS: i64 = 30 * 60;

pub(crate) fn repo_share_secs(repos: usize) -> i64 {
    (VERIFY_BUDGET_SECS / repos.max(1) as i64).max(MIN_REPO_SHARE_SECS)
}

const FOREIGN_NOTE: &str = super::dest::DEVICE_REFUSED_MSG;

struct Target {
    name: String,
    repo: Repo,
    r2: bool,
}

struct Skipped {
    name: String,
    foreign: bool,
}

struct Targets {
    /// `local` first, then every destination that is connected now.
    up: Vec<Target>,
    /// Unplugged (the tick already raises BACKUP_DEST_DOWN) or a foreign drive: skipped, never written.
    skipped: Vec<Skipped>,
    /// A destination whose repository handle cannot be built (e.g. `r2.env` missing): a failure, not a skip.
    broken: Vec<(String, String)>,
    /// `list` only: a repository that does not exist yet.
    absent: Vec<String>,
}

/// `create`: verify may create the local repository and machine key on first use; `list` never does (it is read-only), so a
/// missing local repository is `absent` and simply not listed.
fn targets(ctx: &BackupCtx, deps: &Deps, cfg: &BackupConfig, create: bool, want: &dyn Fn(&str) -> bool) -> BResult<Targets> {
    let mut t = Targets { up: Vec::new(), skipped: Vec::new(), broken: Vec::new(), absent: Vec::new() };
    if !want("local") {
    } else if create {
        let local = ensure_local_repo(ctx, &*deps.exec, !cfg.destinations.is_empty())?;
        t.up.push(Target { name: "local".into(), repo: local, r2: false });
    } else if local_exists(ctx) {
        t.up.push(Target { name: "local".into(), repo: local_repo(ctx), r2: false });
    } else {
        t.absent.push("local".to_string());
    }
    for d in cfg.destinations.iter().filter(|d| want(&d.name)) {
        if d.kind == DestKind::Device {
            match dest::probe(d) {
                Reach::Up => {}
                other => {
                    t.skipped.push(Skipped { name: d.name.clone(), foreign: other == Reach::Foreign });
                    continue;
                }
            }
        }
        match dest_repo(ctx, d) {
            Ok(repo) => t.up.push(Target { name: d.name.clone(), repo, r2: d.kind == DestKind::R2 }),
            Err(e) => t.broken.push((d.name.clone(), e.message)),
        }
    }
    Ok(t)
}

fn snapshots_of(ctx: &BackupCtx, deps: &Deps, repo: &Repo) -> Result<Vec<Snap>, String> {
    let out = run_restic(&*deps.exec, ctx, repo, &restic::snapshots_args(), SNAPSHOTS_TIMEOUT).map_err(|e| e.message)?;
    if !out.ok() {
        return Err(format!("{} {}", describe_exit(&out), tail(&out.stderr)));
    }
    parse_snapshots(&out.stdout)
}

fn provisioned(ctx: &BackupCtx) -> BResult<()> {
    if ctx.paths.conf_file().exists() { Ok(()) } else { Err(BackupError::not_provisioned()) }
}

/// Every snapshot once, newest first, with the repositories that hold it. A copy is the same snapshot as its source
/// (`restic copy` gives it a new id and records the source id in `original`), so snapshots are keyed by source id.
/// Read-only: no lock, no unlock (`restic unlock` must not race a live backup), nothing created: a missing local
/// repository is reported as `absent`, a repository that cannot be read goes under `broken` and the rest are still listed.
pub fn list(ctx: &BackupCtx, deps: &Deps) -> BResult<Value> {
    provisioned(ctx)?;
    let cfg = config::load(&ctx.paths.conf_file())?;
    let ts = targets(ctx, deps, &cfg, false, &|_| true)?;
    let mut by_id: std::collections::BTreeMap<String, (Snap, Vec<String>)> = Default::default();
    // one repository failing (locked by a live backup, R2 down) must not hide the others
    let mut broken: Vec<Value> = ts.broken.iter().map(|(n, m)| json!({ "repo": n, "detail": m })).collect();
    for t in &ts.up {
        match snapshots_of(ctx, deps, &t.repo) {
            Ok(snaps) => {
                for s in snaps {
                    by_id.entry(s.source_id()).or_insert_with(|| (s.clone(), Vec::new())).1.push(t.name.clone());
                }
            }
            Err(e) => broken.push(json!({ "repo": t.name, "detail": e })),
        }
    }
    let mut rows: Vec<(&String, &(Snap, Vec<String>))> = by_id.iter().collect();
    rows.sort_by_key(|(_, (s, _))| std::cmp::Reverse(s.time));
    let snapshots: Vec<Value> = rows
        .iter()
        .map(|(id, (s, on))| json!({ "id": id, "time": iso_utc(s.time), "reason": s.reason(), "schema": s.schema(), "protected": s.protected(), "on": on }))
        .collect();
    let unreachable: Vec<&str> = ts.skipped.iter().map(|s| s.name.as_str()).collect();
    Ok(json!({ "snapshots": snapshots, "unreachable": unreachable, "broken": broken, "absent": ts.absent }))
}

/// The manual form: a busy lock is LOCK_HELD (10).
pub fn verify(ctx: &BackupCtx, deps: &Deps, read_data: bool) -> BResult<Value> {
    verify_with(ctx, deps, read_data, false)
}

/// `scheduled`: due-based (see `verify_inner`: it returns `{"outcome":"not-due"}` at once when no repository is due, with no
/// restic call), and a held lock (update or backup running) is a quiet `{"skipped": why}`, not an error.
pub fn verify_with(ctx: &BackupCtx, deps: &Deps, read_data: bool, scheduled: bool) -> BResult<Value> {
    provisioned(ctx)?;
    // The scheduled verify is the weekly proof that the data can be read back: it always reads everything.
    let read_data = read_data || scheduled;
    match gated(ctx, LockPolicy::Acquire, scheduled, || verify_inner(ctx, deps, read_data, scheduled))? {
        Gate::Ran(v) => Ok(v),
        Gate::Busy(why) => Ok(json!({ "skipped": why })),
    }
}

#[derive(Clone, Copy)]
struct Plan {
    /// Epoch seconds on the `Deps::now` clock after which no child may start.
    deadline: i64,
    read_data: bool,
    prune_due: bool,
    now: i64,
}

struct RepoResult {
    ok: bool,
    /// A full read that ran out of time: not verified, but not a damaged repository either.
    incomplete: bool,
    /// The full read itself failed (real damage): backs off weekly like an unfinished read; `st.verify` keeps the failure.
    read_failed: bool,
    detail: String,
    warnings: Vec<String>,
    pruned: bool,
}

/// One child at below-normal priority, capped by the time left in the repository's share; out of time is an error naming the step.
fn step(ctx: &BackupCtx, deps: &Deps, plan: &Plan, repo: &Repo, args: &[String], own: Duration, what: &str) -> Result<RunOutput, String> {
    let left = plan.deadline - (deps.now)();
    if left <= 0 {
        return Err(format!("the verify time budget was used up before {what}; this repository was not verified"));
    }
    run_restic_with(&*deps.exec, ctx, repo, args, own.min(Duration::from_secs(left as u64)), crate::exec::Priority::BelowNormal).map_err(|e| e.message)
}

fn failed(what: &str, out: &RunOutput) -> String {
    format!("{what} failed: {} {}", describe_exit(out), tail(&out.stderr))
}

/// unlock, list (and reconcile the remembered state with it), drop expired protect tags, retention, check.
fn check_repo(ctx: &BackupCtx, deps: &Deps, plan: &Plan, t: &Target, st: &mut BackupState) -> RepoResult {
    let mut warnings = Vec::new();
    let mut pruned = false;
    let mut incomplete = false;
    let mut read_failed = false;
    let run = (|| -> Result<(), String> {
        step(ctx, deps, plan, &t.repo, &restic::unlock_args(), UNLOCK_TIMEOUT, "unlock")?;
        let out = step(ctx, deps, plan, &t.repo, &restic::snapshots_args(), SNAPSHOTS_TIMEOUT, "listing snapshots")?;
        if !out.ok() {
            return Err(failed("listing snapshots", &out));
        }
        let snaps = parse_snapshots(&out.stdout)?;
        reconcile(st, &t.name, &snaps);
        let expired = expired_protected(&snaps, plan.now);
        if !expired.is_empty() {
            let o = step(ctx, deps, plan, &t.repo, &restic::tag_remove_args(restic::TAG_PROTECT, &expired), TAG_TIMEOUT, "removing expired protect tags")?;
            if !o.ok() {
                // the old snapshots stay protected (and grow the repository) until this works: say so, do not fail the verify
                warnings.push(failed("removing expired protect tags", &o));
            }
        }
        // A prune repacks and deletes packs: never on a repository whose metadata does not check out.
        if plan.prune_due {
            let c = step(ctx, deps, plan, &t.repo, &restic::check_args(ReadData::No), CHECK_TIMEOUT, "check")?;
            if !c.ok() {
                return Err(format!("{} (no retention or prune was run on it)", failed("check", &c)));
            }
        }
        // Retention on EVERY repository, destinations included: nothing else ever forgets on a USB disk, which would
        // otherwise fill up over months. `--prune` (which frees the space) only on the weekly read-data run.
        let (own, what) = if plan.prune_due { (PRUNE_TIMEOUT, "retention and prune") } else { (FORGET_TIMEOUT, "retention") };
        let mut f = step(ctx, deps, plan, &t.repo, &restic::forget_args(plan.prune_due), own, what)?;
        if !f.ok() && plan.prune_due {
            // A full drive cannot repack. `--max-unused unlimited` deletes what is unreferenced without repacking, which
            // needs almost no free space; the space is reclaimed gradually. Once, not in a loop.
            let retry = step(ctx, deps, plan, &t.repo, &restic::forget_prune_unlimited_args(), own, "retention and prune (retry)")?;
            if retry.ok() {
                warnings.push(format!("the prune failed ({}); it was repeated with --max-unused unlimited, which frees less space", describe_exit(&f)));
            }
            f = retry;
        }
        if !f.ok() {
            return Err(failed("retention", &f));
        }
        pruned = plan.prune_due;
        let (mode, own) = match (plan.read_data, t.r2) {
            (false, _) => (ReadData::No, CHECK_TIMEOUT),
            (true, true) => (ReadData::Subset(5), R2_READ_DATA_TIMEOUT),
            (true, false) => (ReadData::Full, READ_DATA_TIMEOUT),
        };
        let c = match step(ctx, deps, plan, &t.repo, &restic::check_args(mode), own, "check") {
            Ok(c) => c,
            // The share was used up before the read could start (a long prune): same as a read that timed out.
            Err(e) => {
                incomplete = plan.read_data;
                return Err(e);
            }
        };
        if !c.ok() {
            if plan.read_data && c.timed_out {
                incomplete = true;
                return Err(format!("could not finish reading {} (timed out); it was not verified", t.name));
            }
            // damage found by the full read itself (earlier steps keep retrying at the next daily due check)
            read_failed = plan.read_data;
            return Err(failed("check", &c));
        }
        Ok(())
    })();
    match run {
        Ok(()) => RepoResult { ok: true, incomplete: false, read_failed: false, detail: "ok".into(), warnings, pruned },
        // `pruned` stays as it was: a prune that succeeded really happened, whatever the read said afterwards
        Err(e) => RepoResult { ok: false, incomplete, read_failed, detail: e, warnings, pruned },
    }
}

fn verify_inner(ctx: &BackupCtx, deps: &Deps, read_data: bool, scheduled: bool) -> BResult<Value> {
    let cfg = config::load(&ctx.paths.conf_file())?;
    let now = (deps.now)();
    let mut st = BackupState::load_in(&ctx.paths, now)?;
    // Per-repository clocks. A scheduled run does only what is due (each repository's own `verified_at` six days old,
    // or in the future = clock skew); a manual run does every connected repository.
    // Due = last verified AND last attempted (an unfinished read) both six days ago, so a read that cannot finish is
    // retried weekly instead of re-reading for two hours every day.
    let clocks = |st: &BackupState, name: &str| if name == "local" { (st.local_verified_at, st.local_verify_attempt_at) } else { st.destinations.get(name).map_or((0, 0), |d| (d.verified_at, d.verify_attempt_at)) };
    let stale = |at: i64| !(0..MAINTENANCE_EVERY_SECS).contains(&(now - at));
    let is_due = |st: &BackupState, name: &str| !scheduled || { let (v, a) = clocks(st, name); stale(v) && stale(a) };
    let due: Vec<String> = std::iter::once("local".to_string()).chain(cfg.destinations.iter().map(|d| d.name.clone())).filter(|n| is_due(&st, n)).collect();
    if due.is_empty() {
        return Ok(json!({ "outcome": "not-due" }));
    }
    let ts = targets(ctx, deps, &cfg, true, &|n| due.iter().any(|d| d == n))?;
    if ts.up.is_empty() && ts.broken.is_empty() {
        // everything that is due is unplugged: the tick already raises BACKUP_DEST_DOWN
        let away: Vec<&str> = ts.skipped.iter().map(|s| s.name.as_str()).collect();
        return Ok(json!({ "outcome": "not-due", "notConnected": away }));
    }
    // Same pattern as the backup's "interrupted" attempt: a run that is killed (power cut, task stopped) leaves this
    // behind instead of a stale-looking success; a finished run overwrites it.
    let prev_pass = st.verify.as_ref().map(|v| v.last_pass_at).unwrap_or(0);
    let prev_fail = st.verify.as_ref().and_then(|v| v.failing_since);
    st.verify = Some(CheckRef { at: now, ok: false, last_pass_at: prev_pass, detail: "interrupted: a verify started and did not finish".into(), incomplete: true, failing_since: prev_fail });
    let _ = st.save_in(ctx);

    let share = repo_share_secs(ts.up.len());
    let mut rows = Vec::new();
    let mut all_ok = true;
    let mut incomplete = false;
    let mut any_pruned = false;
    for t in &ts.up {
        let pruned_clock = if t.name == "local" { st.local_pruned_at } else { st.destinations.get(&t.name).map_or(0, |d| d.pruned_at) };
        // each repository's own window and its own prune clock: it cannot spend what the next one is owed
        let plan = Plan { deadline: (deps.now)() + share, read_data, prune_due: read_data && !(0..MAINTENANCE_EVERY_SECS).contains(&(now - pruned_clock)), now };
        let r = check_repo(ctx, deps, &plan, t, &mut st);
        all_ok &= r.ok;
        incomplete |= r.incomplete;
        any_pruned |= r.pruned;
        // `verified_at` moves only on a successful FULL read (a metadata-only pass proves nothing about the data, so it must
        // not silence the overdue alert). `pruned_at` moves whenever the prune itself succeeded, whatever the read said, or
        // a repository whose read keeps failing would be re-pruned at every due check. A read that did not finish or that
        // found damage stamps `verify_attempt_at` (weekly back-off); a failure in an earlier step is retried at the next
        // due check.
        if r.pruned || (read_data && (r.ok || r.incomplete || r.read_failed)) {
            let (verified, pruned, attempt) = if t.name == "local" {
                (&mut st.local_verified_at, &mut st.local_pruned_at, &mut st.local_verify_attempt_at)
            } else {
                // reachable: the drive was just probed (or is R2)
                let ds = st.destinations.entry(t.name.clone()).or_insert_with(|| DestState { reachable: true, ..Default::default() });
                (&mut ds.verified_at, &mut ds.pruned_at, &mut ds.verify_attempt_at)
            };
            if r.pruned {
                *pruned = now;
            }
            if read_data && r.ok {
                *verified = now;
            } else if read_data && (r.incomplete || r.read_failed) {
                *attempt = now;
            }
        }
        let outcome = if r.ok { "ok" } else if r.incomplete { "incomplete" } else { "failed" };
        let mut row = json!({ "name": t.name, "ok": r.ok, "outcome": outcome, "skipped": false, "detail": r.detail });
        if !r.warnings.is_empty() {
            row["warnings"] = json!(r.warnings);
        }
        rows.push(row);
    }
    for s in &ts.skipped {
        let detail = if s.foreign { FOREIGN_NOTE } else { "not connected" };
        rows.push(json!({ "name": s.name, "ok": true, "outcome": "skipped", "skipped": true, "foreign": s.foreign, "detail": detail }));
    }
    for (name, msg) in &ts.broken {
        all_ok = false;
        rows.push(json!({ "name": name, "ok": false, "outcome": "failed", "skipped": false, "detail": msg }));
    }
    let detail = if all_ok {
        "ok".to_string()
    } else {
        rows.iter().filter(|r| r["ok"] == false).map(|r| format!("{}: {}", r["name"].as_str().unwrap_or("?"), r["detail"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("; ")
    };
    st.verify = Some(CheckRef { at: now, ok: all_ok, last_pass_at: if all_ok { now } else { prev_pass }, detail: detail.clone(), incomplete: !all_ok && incomplete,
        // a real failure keeps its first time; an unfinished read neither starts nor ends one; a pass ends it
        failing_since: if all_ok { None } else if incomplete { prev_fail } else { prev_fail.or(Some(now)) } });
    // the failure is recorded either way
    let saved = st.save_in(ctx);
    if !all_ok {
        return Err(BackupError::backup_failed(format!("verify failed: {detail}")));
    }
    let mut out = json!({ "outcome": "verified", "repos": rows, "pruned": any_pruned, "readData": read_data });
    if let Err(e) = saved {
        out["warnings"] = json!([format!("the backup state file could not be written: {e}")]);
    }
    Ok(out)
}

/// What the repository really holds is the truth; the remembered state follows it.
///
/// Ids: `restic copy` gives the copy a NEW id and records the source id in `original`, and ids come in an 8-digit and a
/// 64-digit form, so snapshots are matched with `Snap::is` and ids are
/// compared with `restic::same_snapshot`. `DestState::last_success` holds the SOURCE (local) snapshot id.
fn reconcile(st: &mut BackupState, name: &str, snaps: &[Snap]) {
    if name == "local" {
        // A remembered local snapshot that is no longer there is forgotten, and the next tick takes a fresh backup.
        // Adopting the newest one instead is unsafe: restic leaves no marker on an incomplete (exit 3) snapshot, and Task 5
        // only forgets it at backup time, so a leftover could be picked as "the newest good backup".
        if st.local.as_ref().is_some_and(|l| !snaps.iter().any(|s| s.is(&l.id))) {
            st.local = None;
        }
    } else if let Some(ds) = st.destinations.get_mut(name) {
        if ds.last_success.as_ref().is_some_and(|l| snaps.iter().any(|s| s.is(&l.id))) {
            return; // the drive still holds it (maybe under another id): keep the source id, no spurious copy
        }
        // Not on the drive: forget it. Adopting the drive's newest snapshot instead could pick one Task 5 would have rejected
        // (restic marks no incomplete snapshot). It costs one no-op `restic copy`, which then records the SOURCE id.
        ds.last_success = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{self, BackupConfig, DestKind, Destination};
    use crate::backup::policy::copy_pending;
    use crate::backup::state::{BackupState, CheckRef, DestState, SnapRef};
    use crate::backup::util::{fake::FakeExec, iso_utc};
    use crate::envelope::Code;
    use crate::paths::Roots;
    use crate::ports::Ports;
    use std::path::Path;
    use std::rc::Rc;
    use std::time::Duration;
    use std::sync::atomic::{AtomicI64, Ordering};

    const NOW: i64 = 1_790_000_000;

    /// A 64-digit restic id starting with an 8-digit prefix (`snapshots --json` prints 64 digits; some restic outputs and versions print only the 8-digit prefix).
    fn fid(prefix: &str) -> String {
        format!("{prefix}{}", "0".repeat(64 - prefix.len()))
    }

    /// (id, time, tags, original)
    fn snaps_json(items: &[(&str, i64, &[&str], Option<&str>)]) -> String {
        let v: Vec<String> = items
            .iter()
            .map(|(id, t, tags, orig)| {
                let tags: Vec<String> = tags.iter().map(|x| format!("\"{x}\"")).collect();
                let orig = orig.map(|o| format!(",\"original\":\"{o}\"")).unwrap_or_default();
                format!("{{\"id\":\"{id}\"{orig},\"time\":\"{}\",\"tags\":[{}],\"paths\":[]}}", iso_utc(*t), tags.join(","))
            })
            .collect();
        format!("[{}]", v.join(","))
    }
    fn plain(items: &[(&str, i64, &[&str])]) -> String {
        snaps_json(&items.iter().map(|(a, b, c)| (*a, *b, *c, None)).collect::<Vec<_>>())
    }

    fn usb_dest(dir: &Path) -> Destination {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("config"), b"x").unwrap();
        Destination { name: "usb-e".into(), kind: DestKind::Device, path: Some(dir.to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() }
    }

    fn fixture(with_usb: bool) -> (tempfile::TempDir, BackupCtx, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots { dev: true, ..Roots::custom(d.path().join("data"), d.path().join("program")) };
        let c = BackupCtx::new(&roots, d.path().join("pack"), Ports::new(47300).unwrap(), "1.11.0-r1".into(), "t".into());
        for p in [c.paths.secrets(), c.paths.backups(), c.paths.state_dir(), c.paths.conf_file().parent().unwrap().to_path_buf(), c.pack_dir.join("bin"), c.paths.repo()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(c.paths.repo().join("config"), b"x").unwrap();
        std::fs::write(c.paths.machine_key(), crate::backup::keys::generate_machine_key().unwrap()).unwrap();
        std::fs::write(c.restic_exe(), b"x").unwrap();
        std::fs::write(c.paths.conf_file(), r#"{"schema":1}"#).unwrap();
        let usb = d.path().join("usb");
        if with_usb {
            config::save(&c.paths.conf_file(), &BackupConfig { destinations: vec![usb_dest(&usb)], ..Default::default() }).unwrap();
        }
        (d, c, usb)
    }

    fn deps(exec: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(exec), opener: Box::new(crate::backup::pg::PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }
    fn load(c: &BackupCtx) -> BackupState {
        BackupState::load(&c.paths.state_file(), 0).unwrap()
    }
    fn save(c: &BackupCtx, st: &BackupState) {
        st.save_unprotected(&c.paths.state_file()).unwrap();
    }
    fn sref(id: &str, at: i64) -> SnapRef {
        SnapRef { id: id.into(), at, reason: "hourly".into() }
    }

    #[test]
    fn a_weekly_verify_unlocks_prunes_then_reads_all_data_in_that_order_and_records_a_pass() {
        let (_d, c, _) = fixture(false);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, &plain(&[("aaaa", NOW - 3600, &["posctl"])])));
        verify(&c, &deps(exec.clone()), true).unwrap();
        let (u, f, k) = (exec.index_of(" unlock").unwrap(), exec.index_of("forget").unwrap(), exec.index_of("check --read-data").unwrap());
        assert!(u < f && f < k, "unlock, then forget+prune, then check");
        assert!(exec.calls.borrow().iter().any(|l| l.contains("forget") && l.contains("--prune")));
        let st = load(&c);
        let v = st.verify.unwrap();
        assert!(v.ok && v.last_pass_at == NOW);
        assert_eq!(st.local_pruned_at, NOW);
        assert_eq!(st.local_verified_at, NOW);
    }

    #[test]
    fn prune_waits_a_week_and_a_metadata_only_verify_never_prunes() {
        let (_d, c, _) = fixture(false);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local_pruned_at = NOW - 3 * 86_400;
        save(&c, &st);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec.clone()), true).unwrap();
        assert!(!exec.calls.borrow().iter().any(|l| l.contains("--prune")));
        assert!(exec.index_of("forget").is_some(), "retention itself runs every time; only the prune waits");
        let exec2 = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        let mut st = load(&c);
        st.local_pruned_at = 0;
        save(&c, &st);
        verify(&c, &deps(exec2.clone()), false).unwrap();
        assert!(exec2.index_of("check").is_some() && exec2.index_of("--read-data").is_none() && exec2.index_of("--prune").is_none());
        assert_eq!(load(&c).local_pruned_at, 0, "a metadata-only verify does not move the prune clock");
    }

    #[test]
    fn a_failed_check_is_an_error_the_state_says_so_and_the_last_pass_time_is_kept() {
        let (_d, c, _) = fixture(false);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.verify = Some(CheckRef { at: 5, ok: true, last_pass_at: 5, ..Default::default() });
        save(&c, &st);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check", 1, ""));
        let e = verify(&c, &deps(exec), true).unwrap_err();
        assert_eq!((e.code, e.exit()), (Code::BackupFailed, 30));
        let v = load(&c).verify.unwrap();
        assert!(!v.ok && v.at == NOW && v.last_pass_at == 5);
        assert_eq!(v.failing_since, Some(NOW), "the first real failure is stamped");
        // a later failure keeps the first time; a pass clears it
        let mut st = load(&c);
        st.verify.as_mut().unwrap().failing_since = Some(NOW - 2 * 86_400);
        save(&c, &st);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check", 1, ""));
        verify(&c, &deps(exec), true).unwrap_err();
        assert_eq!(load(&c).verify.unwrap().failing_since, Some(NOW - 2 * 86_400));
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check", 0, ""));
        verify(&c, &deps(exec), true).unwrap();
        let v = load(&c).verify.unwrap();
        assert!(v.ok && v.failing_since.is_none(), "{v:?}");
    }

    #[test]
    fn protected_snapshots_older_than_30_days_lose_the_tag_before_retention_runs() {
        let (_d, c, _) = fixture(false);
        let old = NOW - 31 * 86_400;
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, &plain(&[("oldprot", old, &["posctl", "protect"]), ("newprot", NOW - 86_400, &["posctl", "protect"])])));
        verify(&c, &deps(exec.clone()), true).unwrap();
        let tag = exec.index_of("tag --remove protect oldprot").expect("tag removal");
        assert!(tag < exec.index_of("forget").unwrap());
        assert!(!exec.calls.borrow().iter().any(|l| l.contains("newprot") && l.contains("tag --remove")));
    }

    #[test]
    fn the_recorded_destination_state_is_reconciled_with_what_the_drive_really_holds() {
        let (_d, c, usb) = fixture(true);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.destinations.insert("usb-e".into(), DestState { reachable: true, ok: true, last_success: Some(sref("ghost", NOW - 60)), ..Default::default() });
        save(&c, &st);
        let usb_s = usb.to_string_lossy().to_string();
        let exec = Rc::new(FakeExec::default().on(&format!("--repo {usb_s} snapshots --json"), 0, "[]").on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec), false).unwrap();
        assert!(load(&c).destinations["usb-e"].last_success.is_none(), "a wiped drive must not keep a remembered success");
    }

    // ---- CARRY T6: restic copy gives the copy a new id and records the source id in `original` ----

    /// local holds `cafebabe` (state remembers the short id); the drive holds its copy under a NEW id.
    fn copied_fixture(remembered_on_dest: &str) -> (tempfile::TempDir, BackupCtx, Rc<FakeExec>) {
        let (d, c, usb) = fixture(true);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local = Some(sref("cafebabe", NOW - 600));
        st.last_attempt_ok = true;
        st.last_attempt_at = NOW - 600;
        st.destinations.insert("usb-e".into(), DestState { reachable: true, ok: true, last_success: Some(sref(remembered_on_dest, NOW - 590)), ..Default::default() });
        save(&c, &st);
        let usb_s = usb.to_string_lossy().to_string();
        let local_full = fid("cafebabe");
        let exec = Rc::new(
            FakeExec::default()
                .on(&format!("--repo {usb_s} snapshots --json"), 0, &snaps_json(&[(&fid("d00dfeed"), NOW - 600, &["posctl", "reason:hourly"], Some(&local_full))]))
                .on("snapshots --json", 0, &plain(&[(&local_full, NOW - 600, &["posctl", "reason:hourly"])])),
        );
        (d, c, exec)
    }

    #[test]
    fn a_verify_leaves_an_up_to_date_destination_with_no_copy_pending() {
        let (_d, c, exec) = copied_fixture("cafebabe");
        verify(&c, &deps(exec), false).unwrap();
        let st = load(&c);
        assert_eq!(st.destinations["usb-e"].last_success.as_ref().unwrap().id, "cafebabe", "the SOURCE id is kept, not the copy's new id");
        assert_eq!(st.local.as_ref().unwrap().id, "cafebabe");
        let cfg = config::load(&c.paths.conf_file()).unwrap();
        assert!(!copy_pending(&st, &cfg, NOW), "no spurious copy each week");
    }

    #[test]
    fn a_remembered_success_the_drive_does_not_hold_is_forgotten_not_replaced() {
        let (_d, c, exec) = copied_fixture("ghost");
        verify(&c, &deps(exec), false).unwrap();
        let st = load(&c);
        assert!(st.destinations["usb-e"].last_success.is_none(), "not found on the drive: forgotten, never adopted from the drive's newest");
        let cfg = config::load(&c.paths.conf_file()).unwrap();
        assert!(copy_pending(&st, &cfg, NOW), "one no-op copy follows, and that records the source id");
    }

    #[test]
    fn a_drive_that_only_holds_an_older_snapshot_has_no_remembered_success_and_a_copy_pending() {
        let (_d, c, usb) = fixture(true);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local = Some(sref("cafebabe", NOW - 600));
        st.destinations.insert("usb-e".into(), DestState { reachable: true, ok: true, last_success: Some(sref("cafebabe", NOW - 590)), ..Default::default() });
        save(&c, &st);
        let usb_s = usb.to_string_lossy().to_string();
        let exec = Rc::new(
            FakeExec::default()
                .on(&format!("--repo {usb_s} snapshots --json"), 0, &snaps_json(&[(&fid("d00dfeed"), NOW - 7200, &["posctl"], Some(&fid("0ld0ld00")))]))
                .on("snapshots --json", 0, &plain(&[(&fid("cafebabe"), NOW - 600, &["posctl"]), (&fid("0ld0ld00"), NOW - 7200, &["posctl"])])),
        );
        verify(&c, &deps(exec), false).unwrap();
        let st = load(&c);
        assert!(st.destinations["usb-e"].last_success.is_none());
        assert!(copy_pending(&st, &config::load(&c.paths.conf_file()).unwrap(), NOW), "the newest local snapshot is not on the drive");
    }

    #[test]
    fn a_tag_rewrite_that_changes_the_local_id_does_not_lose_the_remembered_snapshot_and_a_missing_one_forces_a_backup() {
        let (_d, c, _) = fixture(false);
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local = Some(sref("cafebabe", NOW - 600));
        save(&c, &st);
        // `restic tag` re-saves the snapshot under a new id and keeps the old one in `original`
        let rewritten = snaps_json(&[(&fid("77777777"), NOW - 600, &["posctl"], Some(&fid("cafebabe")))]);
        verify(&c, &deps(Rc::new(FakeExec::default().on("snapshots --json", 0, &rewritten))), false).unwrap();
        assert_eq!(load(&c).local.unwrap().id, "cafebabe", "kept as remembered");
        // a repository that no longer holds it (wiped, restored from an older copy): never adopt whatever is newest there
        // (restic leaves no marker on an incomplete snapshot), forget it so the next tick takes a fresh backup
        verify(&c, &deps(Rc::new(FakeExec::default().on("snapshots --json", 0, &plain(&[(&fid("12121212"), NOW - 60, &["posctl"])])))), false).unwrap();
        assert!(load(&c).local.is_none());
    }

    #[test]
    fn every_repository_starts_with_unlock_and_destinations_get_retention_too() {
        let (_d, c, usb) = fixture(true);
        let usb_s = usb.to_string_lossy().to_string();
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local_pruned_at = 0;
        save(&c, &st);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec.clone()), true).unwrap();
        for repo in [c.paths.repo().to_string_lossy().to_string(), usb_s.clone()] {
            let at = |what: &str| exec.index_of(&format!("--repo {repo} {what}")).unwrap_or_else(|| panic!("{repo}: no {what}"));
            assert!(at("unlock") < at("snapshots") && at("snapshots") < at("check") && at("check") < at("forget") && at("forget") < at("check --read-data"), "{repo}: metadata check, then prune, then the full read");
        }
        let f = exec.calls.borrow().iter().find(|l| l.contains(&format!("--repo {usb_s} forget"))).cloned().unwrap();
        for need in ["--tag posctl", "--group-by host", "--keep-hourly 24", "--keep-daily 30", "--keep-monthly 12", "--keep-tag protect", "--prune"] {
            assert!(f.contains(need), "{need} in {f}");
        }
        assert!(exec.index_of(&format!("--repo {usb_s} check --read-data")).is_some(), "devices are read in full");
        // not due: still forgets on the drive (a USB fills up otherwise) but does not prune
        let exec2 = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec2.clone()), true).unwrap();
        let f2 = exec2.calls.borrow().iter().find(|l| l.contains(&format!("--repo {usb_s} forget"))).cloned().unwrap();
        assert!(!f2.contains("--prune") && f2.contains("--keep-tag protect"));
    }

    #[test]
    fn a_failed_retention_run_on_a_destination_fails_the_verify() {
        let (_d, c, usb) = fixture(true);
        let usb_s = usb.to_string_lossy().to_string();
        let exec = Rc::new(FakeExec::default().on(&format!("--repo {usb_s} forget"), 1, "").on("snapshots --json", 0, "[]"));
        let e = verify(&c, &deps(exec), false).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        let v = load(&c).verify.unwrap();
        assert!(!v.ok && v.detail.contains("usb-e") && v.detail.contains("retention"), "{}", v.detail);
    }

    #[test]
    fn an_unplugged_drive_is_skipped_not_failed() {
        let (_d, c, usb) = fixture(true);
        std::fs::remove_file(usb.join("config")).unwrap();
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        let out = verify(&c, &deps(exec.clone()), true).unwrap();
        assert_eq!(out["repos"][1]["skipped"], true);
        assert!(!exec.calls.borrow().iter().any(|l| l.contains("usb")));
    }

    #[cfg(windows)]
    #[test]
    fn a_foreign_drive_under_the_same_letter_is_skipped_reported_and_never_written() {
        let (_d, c, usb) = fixture(true);
        let mut cfg = config::load(&c.paths.conf_file()).unwrap();
        cfg.destinations[0].volume_serial = Some("00000000".into()); // no real volume has serial 0
        config::save(&c.paths.conf_file(), &cfg).unwrap();
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        let out = verify(&c, &deps(exec.clone()), true).unwrap();
        assert_eq!(out["repos"][1]["skipped"], true);
        assert_eq!(out["repos"][1]["foreign"], true);
        assert!(out["repos"][1]["detail"].as_str().unwrap().contains("different drive"));
        let usb_s = usb.to_string_lossy().to_string();
        assert!(!exec.calls.borrow().iter().any(|l| l.contains(&usb_s)), "neither unlock, forget nor check touched it");
    }

    #[test]
    fn list_shows_newest_first_with_where_each_snapshot_lives() {
        let (_d, c, usb) = fixture(true);
        let usb_s = usb.to_string_lossy().to_string();
        let exec = Rc::new(
            FakeExec::default()
                .on(&format!("--repo {usb_s} snapshots --json"), 0, &plain(&[("aaaa1111", NOW - 7200, &["posctl", "reason:hourly"])]))
                .on("snapshots --json", 0, &plain(&[("aaaa1111", NOW - 7200, &["posctl", "reason:hourly"]), ("bbbb2222", NOW - 60, &["posctl", "reason:caja-close", "protect"])])),
        );
        let out = list(&c, &deps(exec.clone())).unwrap();
        let s = out["snapshots"].as_array().unwrap();
        assert_eq!(s[0]["id"], "bbbb2222");
        assert_eq!(s[0]["reason"], "caja-close");
        assert_eq!(s[0]["protected"], true);
        assert_eq!(s[0]["on"], serde_json::json!(["local"]));
        assert_eq!(s[1]["on"], serde_json::json!(["local", "usb-e"]));
        assert_eq!(exec.count_of(" unlock"), 0, "list is read-only: it does not hold backup.lock, so it never unlocks");
    }

    #[test]
    fn list_counts_a_copy_once_under_its_source_id() {
        let (_d, c, usb) = fixture(true);
        let usb_s = usb.to_string_lossy().to_string();
        let src = fid("cafebabe");
        let exec = Rc::new(
            FakeExec::default()
                .on(&format!("--repo {usb_s} snapshots --json"), 0, &snaps_json(&[(&fid("d00dfeed"), NOW - 600, &["posctl", "reason:hourly"], Some(&src))]))
                .on("snapshots --json", 0, &plain(&[(&src, NOW - 600, &["posctl", "reason:hourly"])])),
        );
        let out = list(&c, &deps(exec)).unwrap();
        let s = out["snapshots"].as_array().unwrap();
        assert_eq!(s.len(), 1, "{out}");
        assert_eq!(s[0]["on"], serde_json::json!(["local", "usb-e"]));
    }

    // ---- bounded: a weekly verify holds update.lock shared, so it must end ----

    static CLOCK: AtomicI64 = AtomicI64::new(NOW);

    static CLOCK_B: AtomicI64 = AtomicI64::new(NOW);

    #[test]
    fn a_repository_that_overruns_its_share_is_unverified_and_does_not_starve_the_next_one() {
        let (_d, c, usb) = fixture(true);
        CLOCK.store(NOW, Ordering::SeqCst);
        let once = std::sync::atomic::AtomicBool::new(false);
        // the local repository's unlock "takes" 3 hours of the fake clock: past its 2 h share (4 h budget / 2 repositories)
        let exec = Rc::new(FakeExec::default().on_with(" unlock", 0, "", move |_| {
            if !once.swap(true, Ordering::SeqCst) {
                CLOCK.fetch_add(3 * 3600, Ordering::SeqCst);
            }
        }).on("snapshots --json", 0, "[]"));
        let d = Deps { exec: Box::new(exec.clone()), opener: Box::new(crate::backup::pg::PsqlOpener), now: || CLOCK.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) };
        let e = verify(&c, &d, true).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        let v = load(&c).verify.unwrap();
        assert!(!v.ok && v.detail.contains("local") && v.detail.contains("time budget"), "{}", v.detail);
        let usb_s = usb.to_string_lossy().to_string();
        assert!(exec.index_of(&format!("--repo {usb_s} check --read-data")).is_some(), "the USB still got its full read");
        assert_eq!(exec.timeout_of(&format!("--repo {usb_s} check --read-data")), READ_DATA_TIMEOUT);
    }

    #[test]
    fn a_slow_step_shortens_only_that_repositorys_later_timeouts() {
        let (_d, c, _) = fixture(true);
        CLOCK_B.store(NOW, Ordering::SeqCst);
        let once = std::sync::atomic::AtomicBool::new(false);
        // the local retention takes an hour: 1 h is left of its 2 h share for the read, below READ_DATA_TIMEOUT
        let exec = Rc::new(FakeExec::default().on_with("forget", 0, "", move |_| {
            if !once.swap(true, Ordering::SeqCst) {
                CLOCK_B.fetch_add(3600, Ordering::SeqCst);
            }
        }).on("snapshots --json", 0, "[]"));
        let d = Deps { exec: Box::new(exec.clone()), opener: Box::new(crate::backup::pg::PsqlOpener), now: || CLOCK_B.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) };
        verify(&c, &d, true).unwrap();
        assert_eq!(exec.timeout_of("check --read-data"), Duration::from_secs(3600));
    }

    #[test]
    fn the_share_per_repository_has_a_floor() {
        assert_eq!(repo_share_secs(2), VERIFY_BUDGET_SECS / 2);
        assert_eq!(repo_share_secs(1), VERIFY_BUDGET_SECS);
        assert_eq!(repo_share_secs(100), MIN_REPO_SHARE_SECS);
        assert_eq!(repo_share_secs(0), VERIFY_BUDGET_SECS);
    }

    // ---- batch 1 (SRE review) ----

    #[test]
    fn a_prune_is_preceded_by_a_metadata_check_and_skipped_when_that_check_fails() {
        let (_d, c, _) = fixture(false);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec.clone()), true).unwrap();
        assert_eq!(exec.count_of(" check"), 2, "metadata check before the prune, full read after");
        assert!(exec.index_of(" check").unwrap() < exec.index_of("--prune").unwrap());
        assert!(exec.index_of("--prune").unwrap() < exec.index_of("check --read-data").unwrap());
        // a damaged repository is never repacked
        let (_d2, c2, _) = fixture(false);
        let bad = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on(" check", 1, ""));
        verify(&c2, &deps(bad.clone()), true).unwrap_err();
        assert!(bad.index_of("forget").is_none(), "no forget and no prune after a failed check");
        assert!(load(&c2).verify.unwrap().detail.contains("check failed"));
    }

    #[test]
    fn a_failed_prune_is_retried_once_with_unlimited_unused_space_and_reported_as_a_warning() {
        let (_d, c, _) = fixture(false);
        let exec = Rc::new(FakeExec::default().on_n("forget", 1, 1, "").on("snapshots --json", 0, "[]"));
        let out = verify(&c, &deps(exec.clone()), true).unwrap();
        assert_eq!(exec.count_of("forget"), 2);
        let calls = exec.calls.borrow();
        let forgets: Vec<&String> = calls.iter().filter(|l| l.contains("forget")).collect();
        assert!(forgets[0].contains("--prune") && !forgets[0].contains("--max-unused"));
        assert!(forgets[1].contains("--prune") && forgets[1].contains("--max-unused unlimited") && forgets[1].contains("--keep-tag protect"));
        let w = out["repos"][0]["warnings"].to_string();
        assert!(w.contains("max-unused unlimited"), "{w}");
        assert_eq!(out["pruned"], true);
        drop(calls);
        // failing twice is a failed verify
        let (_d2, c2, _) = fixture(false);
        let exec2 = Rc::new(FakeExec::default().on("forget", 1, "").on("snapshots --json", 0, "[]"));
        assert_eq!(verify(&c2, &deps(exec2.clone()), true).unwrap_err().code, Code::BackupFailed);
        assert_eq!(exec2.count_of("forget"), 2, "retried once, not in a loop");
    }

    #[test]
    fn a_read_that_times_out_is_incomplete_not_a_generic_check_failure() {
        use crate::backup::util::RunOutput;
        let (_d, c, _) = fixture(false);
        let mut exec = FakeExec::default().on("snapshots --json", 0, "[]");
        exec.rules.insert(0, crate::backup::util::fake::Rule {
            needle: "check --read-data".into(),
            out: RunOutput { code: -1, stdout: String::new(), stderr: String::new(), timed_out: true },
            effect: None,
            limit: None,
            used: Default::default(),
        });
        let e = verify(&c, &deps(Rc::new(exec)), true).unwrap_err();
        assert_eq!(e.code, Code::BackupFailed);
        let v = load(&c).verify.unwrap();
        assert!(!v.ok && v.incomplete, "still not verified, but flagged as unfinished");
        assert!(v.detail.contains("could not finish reading local") && !v.detail.contains("check failed"), "{}", v.detail);
        // a genuine check failure is not incomplete
        let (_d2, c2, _) = fixture(false);
        verify(&c2, &deps(Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check --read-data", 1, ""))), true).unwrap_err();
        assert!(!load(&c2).verify.unwrap().incomplete);
    }

    #[test]
    fn list_never_creates_the_local_repository_or_a_key_and_says_it_is_absent() {
        let (_d, c, _) = fixture(false);
        std::fs::remove_file(c.paths.repo().join("config")).unwrap();
        std::fs::remove_file(c.paths.machine_key()).unwrap();
        let exec = Rc::new(FakeExec::default());
        let out = list(&c, &deps(exec.clone())).unwrap();
        assert_eq!(out["absent"], serde_json::json!(["local"]));
        assert!(exec.calls.borrow().is_empty(), "nothing was run, in particular no `init`");
        assert!(!c.paths.machine_key().exists() && !c.paths.repo().join("config").exists());
    }

    #[test]
    fn list_takes_no_lock() {
        use crate::ops::lock::{acquire_for, LockMode};
        let (_d, c, _) = fixture(false);
        let _held = acquire_for(c.paths.roots(), LockMode::Exclusive, "update", "u-2", Duration::from_secs(0)).unwrap();
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, &plain(&[("aaaa1111", NOW - 60, &["posctl"])])));
        assert_eq!(list(&c, &deps(exec)).unwrap()["snapshots"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn one_failing_repository_is_listed_under_broken_and_the_others_still_appear() {
        let (_d, c, usb) = fixture(true);
        let usb_s = usb.to_string_lossy().to_string();
        let exec = Rc::new(
            FakeExec::default()
                .on(&format!("--repo {usb_s} snapshots --json"), 11, "")
                .on("snapshots --json", 0, &plain(&[("aaaa1111", NOW - 60, &["posctl"])])),
        );
        let out = list(&c, &deps(exec)).unwrap();
        assert_eq!(out["snapshots"].as_array().unwrap().len(), 1);
        assert_eq!(out["broken"][0]["repo"], "usb-e");
        assert!(out["broken"][0]["detail"].as_str().unwrap().contains("locked"), "{out}");
    }

    #[test]
    fn child_timeouts_are_the_named_constants() {
        let (_d, c, _) = fixture(false);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec.clone()), true).unwrap();
        assert_eq!(exec.timeout_of(" unlock"), UNLOCK_TIMEOUT);
        assert_eq!(exec.timeout_of("check --read-data"), READ_DATA_TIMEOUT);
        assert!(READ_DATA_TIMEOUT.as_secs() <= VERIFY_BUDGET_SECS as u64, "one read cannot outlast the whole budget");
    }

    #[test]
    fn a_scheduled_verify_yields_quietly_to_an_update_and_a_manual_one_says_lock_held() {
        use crate::ops::lock::{acquire_for, LockMode};
        let (_d, c, _) = fixture(false);
        let held = acquire_for(c.paths.roots(), LockMode::Exclusive, "update", "u-1", std::time::Duration::from_secs(0)).unwrap();
        let exec = Rc::new(FakeExec::default());
        let out = verify_with(&c, &deps(exec.clone()), true, true).unwrap();
        assert_eq!(out["skipped"], "update-in-progress");
        assert_eq!(verify_with(&c, &deps(exec.clone()), true, false).unwrap_err().code, Code::LockHeld);
        assert!(exec.calls.borrow().is_empty());
        drop(held);
    }

    // ---- batch 2: per-repository clocks, a due-based scheduled verify, interrupted marker, priority ----

    const DAY: i64 = 86_400;

    /// (local verified, local pruned, usb verified, usb pruned)
    fn seed_clocks(c: &BackupCtx, lv: i64, lp: i64, uv: i64, up: i64) {
        let mut st = BackupState::load(&c.paths.state_file(), NOW).unwrap();
        st.local_verified_at = lv;
        st.local_pruned_at = lp;
        st.destinations.insert("usb-e".into(), DestState { reachable: true, ok: true, verified_at: uv, pruned_at: up, ..Default::default() });
        save(c, &st);
    }

    #[test]
    fn a_scheduled_verify_with_nothing_due_returns_not_due_without_touching_restic_or_the_drive() {
        let (_d, c, _) = fixture(true);
        seed_clocks(&c, NOW - DAY, NOW - DAY, NOW - 5 * DAY, NOW - DAY);
        let exec = Rc::new(FakeExec::default());
        let out = verify_with(&c, &deps(exec.clone()), true, true).unwrap();
        assert_eq!(out["outcome"], "not-due");
        assert!(exec.calls.borrow().is_empty());
        assert!(load(&c).verify.is_none(), "nothing ran, so nothing is recorded");
    }

    #[test]
    fn a_scheduled_verify_checks_only_the_repositories_whose_own_clock_is_six_days_old() {
        let (_d, c, usb) = fixture(true);
        seed_clocks(&c, NOW - DAY, NOW - DAY, NOW - 7 * DAY, NOW - 7 * DAY);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify_with(&c, &deps(exec.clone()), true, true).unwrap();
        let (local_s, usb_s) = (c.paths.repo().to_string_lossy().to_string(), usb.to_string_lossy().to_string());
        assert!(exec.index_of(&format!("--repo {usb_s} unlock")).is_some() && exec.index_of(&format!("--repo {usb_s} check --read-data")).is_some());
        assert!(!exec.calls.borrow().iter().any(|l| l.contains(&format!("--repo {local_s} "))), "the local repository was verified yesterday");
        let st = load(&c);
        assert_eq!((st.destinations["usb-e"].verified_at, st.destinations["usb-e"].pruned_at), (NOW, NOW));
        assert_eq!((st.local_verified_at, st.local_pruned_at), (NOW - DAY, NOW - DAY), "untouched");
    }

    #[test]
    fn a_manual_verify_checks_every_connected_repository_and_prunes_each_on_its_own_clock() {
        let (_d, c, usb) = fixture(true);
        seed_clocks(&c, NOW - DAY, NOW - DAY, NOW - DAY, NOW - 7 * DAY);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify_with(&c, &deps(exec.clone()), true, false).unwrap();
        let (local_s, usb_s) = (c.paths.repo().to_string_lossy().to_string(), usb.to_string_lossy().to_string());
        let forget_of = |repo: &str| exec.calls.borrow().iter().find(|l| l.contains(&format!("--repo {repo} forget"))).cloned().unwrap();
        assert!(!forget_of(&local_s).contains("--prune"), "pruned yesterday");
        assert!(forget_of(&usb_s).contains("--prune"), "pruned a week ago");
        let st = load(&c);
        assert_eq!((st.local_verified_at, st.local_pruned_at), (NOW, NOW - DAY));
        assert_eq!((st.destinations["usb-e"].verified_at, st.destinations["usb-e"].pruned_at), (NOW, NOW));
    }

    #[test]
    fn a_failed_read_keeps_verified_at_but_the_prune_that_really_happened_moves_pruned_at() {
        let (_d, c, _) = fixture(false);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, 0, 0);
        verify(&c, &deps(Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check --read-data", 1, ""))), true).unwrap_err();
        let st = load(&c);
        assert_eq!(st.local_verified_at, NOW - 10 * DAY, "only a successful full read moves it");
        assert_eq!(st.local_pruned_at, NOW, "the prune ran and succeeded: it must not repeat at every due check");
    }

    #[test]
    fn an_interrupted_marker_is_saved_before_the_first_child_and_a_finished_run_replaces_it() {
        use std::cell::RefCell;
        let (_d, c, _) = fixture(false);
        let seen: Rc<RefCell<Option<(bool, String)>>> = Default::default();
        let (path, s2) = (c.paths.state_file(), seen.clone());
        let exec = Rc::new(FakeExec::default().on_with(" unlock", 0, "", move |_| {
            *s2.borrow_mut() = BackupState::load(&path, 0).ok().and_then(|s| s.verify).map(|v| (v.ok, v.detail));
        }).on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec), false).unwrap();
        let (ok, detail) = seen.borrow().clone().expect("a marker existed while the first child ran");
        assert!(!ok && detail.contains("interrupted"), "{detail}");
        let v = load(&c).verify.unwrap();
        assert!(v.ok && v.detail == "ok");
    }

    #[test]
    fn every_child_of_a_verify_runs_below_normal_priority() {
        use crate::exec::Priority;
        let (_d, c, _) = fixture(true);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec.clone()), true).unwrap();
        let prios = exec.prios.borrow();
        assert!(!prios.is_empty() && prios.len() == exec.calls.borrow().len());
        assert!(prios.iter().all(|p| *p == Priority::BelowNormal), "{prios:?}");
    }

    // ---- last fix: a scheduled verify always reads, only a full read moves the clocks, an unfinished read backs off ----

    #[test]
    fn a_scheduled_verify_always_reads_all_data_whatever_the_caller_passed() {
        let (_d, c, _) = fixture(false);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        let out = verify_with(&c, &deps(exec.clone()), false, true).unwrap();
        assert!(exec.index_of("check --read-data").is_some());
        assert_eq!(out["readData"], true);
        // a manual run honours the flag
        let exec2 = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify_with(&c, &deps(exec2.clone()), false, false).unwrap();
        assert!(exec2.index_of("--read-data").is_none());
    }

    #[test]
    fn a_metadata_only_pass_never_moves_verified_at_or_pruned_at() {
        let (_d, c, _) = fixture(true);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY);
        let exec = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify(&c, &deps(exec), false).unwrap();
        let st = load(&c);
        assert!(st.verify.unwrap().ok, "the pass itself is recorded");
        assert_eq!((st.local_verified_at, st.local_pruned_at), (NOW - 10 * DAY, NOW - 10 * DAY));
        let u = &st.destinations["usb-e"];
        assert_eq!((u.verified_at, u.pruned_at), (NOW - 10 * DAY, NOW - 10 * DAY));
    }

    static CLOCK_D: AtomicI64 = AtomicI64::new(NOW);

    #[test]
    fn an_unfinished_read_backs_off_to_the_next_weekly_due_and_leaves_the_overdue_clock_old() {
        use crate::backup::util::RunOutput;
        let (_d, c, _) = fixture(false);
        CLOCK_D.store(NOW, Ordering::SeqCst);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, 0, 0);
        let at = |exec: Rc<FakeExec>| Deps { exec: Box::new(exec), opener: Box::new(crate::backup::pg::PsqlOpener), now: || CLOCK_D.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) };
        // day 0: the read times out
        let mut exec = FakeExec::default().on("snapshots --json", 0, "[]");
        exec.rules.insert(0, crate::backup::util::fake::Rule { needle: "check --read-data".into(), out: RunOutput { code: -1, timed_out: true, ..Default::default() }, effect: None, limit: None, used: Default::default() });
        verify_with(&c, &at(Rc::new(exec)), true, true).unwrap_err();
        let st = load(&c);
        assert_eq!(st.local_verified_at, NOW - 10 * DAY, "still overdue");
        assert_eq!(st.local_verify_attempt_at, NOW);
        // day 1: not due, and nothing runs
        CLOCK_D.store(NOW + DAY, Ordering::SeqCst);
        let day1 = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        assert_eq!(verify_with(&c, &at(day1.clone()), true, true).unwrap()["outcome"], "not-due");
        assert!(day1.calls.borrow().is_empty());
        // day 5: still not due
        CLOCK_D.store(NOW + 5 * DAY, Ordering::SeqCst);
        assert_eq!(verify_with(&c, &at(Rc::new(FakeExec::default())), true, true).unwrap()["outcome"], "not-due");
        // day 6: due again, and a pass clears it
        CLOCK_D.store(NOW + 6 * DAY, Ordering::SeqCst);
        let day6 = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        assert_eq!(verify_with(&c, &at(day6.clone()), true, true).unwrap()["outcome"], "verified");
        assert!(day6.index_of("check --read-data").is_some());
        assert_eq!(load(&c).local_verified_at, NOW + 6 * DAY);
    }

    #[test]
    fn a_failure_before_the_read_is_retried_at_the_next_daily_due() {
        let (_d, c, _) = fixture(false);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, 0, 0);
        // retention fails (twice: the full-drive retry fails too)
        verify_with(&c, &deps(Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("forget", 1, ""))), true, true).unwrap_err();
        let st = load(&c);
        assert_eq!((st.local_verify_attempt_at, st.local_pruned_at), (0, NOW - 10 * DAY));
    }

    static CLOCK_E: AtomicI64 = AtomicI64::new(NOW);

    fn at_e(exec: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(exec), opener: Box::new(crate::backup::pg::PsqlOpener), now: || CLOCK_E.load(Ordering::SeqCst), free_bytes: |_| Ok(1 << 40) }
    }

    #[test]
    fn a_prune_that_uses_the_whole_share_leaves_no_time_for_the_read_and_does_not_repeat_tomorrow() {
        let (_d, c, _) = fixture(false);
        CLOCK_E.store(NOW, Ordering::SeqCst);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, 0, 0);
        let once = std::sync::atomic::AtomicBool::new(false);
        let exec = Rc::new(FakeExec::default().on_with("--prune", 0, "", move |_| {
            if !once.swap(true, Ordering::SeqCst) {
                CLOCK_E.fetch_add(VERIFY_BUDGET_SECS + 60, Ordering::SeqCst); // the prune eats the single repository's whole share
            }
        }).on("snapshots --json", 0, "[]"));
        verify_with(&c, &at_e(exec), true, true).unwrap_err();
        let st = load(&c);
        assert_eq!(st.local_pruned_at, NOW, "the prune really happened");
        assert_eq!(st.local_verified_at, NOW - 10 * DAY, "no read, no verification");
        assert_eq!(st.local_verify_attempt_at, NOW, "a read that could not start is incomplete: weekly back-off");
        assert!(st.verify.as_ref().unwrap().incomplete);
        CLOCK_E.store(NOW + DAY, Ordering::SeqCst);
        let day1 = Rc::new(FakeExec::default());
        assert_eq!(verify_with(&c, &at_e(day1.clone()), true, true).unwrap()["outcome"], "not-due");
        assert!(day1.calls.borrow().is_empty(), "no second prune");
    }

    #[test]
    fn damage_found_by_the_read_backs_off_weekly_and_a_manual_verify_the_next_day_still_runs_and_clears_it() {
        let (_d, c, _) = fixture(false);
        CLOCK_E.store(NOW, Ordering::SeqCst);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, 0, 0);
        let bad = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]").on("check --read-data", 1, ""));
        verify_with(&c, &at_e(bad), true, true).unwrap_err();
        let st = load(&c);
        assert_eq!(st.local_verify_attempt_at, NOW);
        assert!(!st.verify.as_ref().unwrap().ok && !st.verify.as_ref().unwrap().incomplete, "the failed result stays (BACKUP_VERIFY_FAILED)");
        CLOCK_E.store(NOW + DAY, Ordering::SeqCst);
        // scheduled: not due
        assert_eq!(verify_with(&c, &at_e(Rc::new(FakeExec::default())), true, true).unwrap()["outcome"], "not-due");
        // manual, after the repository was repaired: skips the due check and clears the same day
        let fixed = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        let out = verify_with(&c, &at_e(fixed.clone()), true, false).unwrap();
        assert_eq!(out["outcome"], "verified");
        assert!(fixed.index_of("check --read-data").is_some());
        let st = load(&c);
        assert_eq!(st.local_verified_at, NOW + DAY);
        assert!(st.verify.unwrap().ok);
    }

    #[test]
    fn a_manual_full_read_that_passes_advances_verified_at_and_a_metadata_only_one_does_not() {
        let (_d, c, _) = fixture(true);
        seed_clocks(&c, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY, NOW - 10 * DAY);
        let meta = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify_with(&c, &deps(meta), false, false).unwrap();
        assert_eq!((load(&c).local_verified_at, load(&c).destinations["usb-e"].verified_at), (NOW - 10 * DAY, NOW - 10 * DAY));
        let full = Rc::new(FakeExec::default().on("snapshots --json", 0, "[]"));
        verify_with(&c, &deps(full), true, false).unwrap();
        let st = load(&c);
        assert_eq!((st.local_verified_at, st.destinations["usb-e"].verified_at), (NOW, NOW), "this is what clears the overdue alert");
    }
}
