//! The drill: restore the newest non-pre-restore backup into a scratch database, prove it, drop it. It prefers the first connected
//! destination (the real disaster path: the drive plus the key) over the local repository, and it is a normal member of
//! the day's maintenance task, so every child runs at below-normal priority (PM ruling T6 B) and is capped by what is left
//! of `backup.rtoBudgetSeconds`.
//!
//! Failure and cleanup rules (invariants 1 and 3):
//! - a marker saying "interrupted" is saved before the first child starts, so a drill killed by a power loss shows as a
//!   failure, never as a stale success;
//! - the scratch database is dropped on every exit path, a panic included (`Scratch`), and the plaintext restore folder
//!   goes with the `Fetched` it belongs to;
//! - a scratch database a killed drill left behind is dropped at the next start;
//! - failing, or taking `rtoBudgetSeconds` or longer, records `ok: false` in state, which the alert code reads as
//!   BACKUP_VERIFY_FAILED.
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use super::acl;
use super::config::BackupConfig;
use super::ctx::BackupCtx;
use super::dest::reachable;
use super::pg::{check_new_db_name, sql_scalar};
use super::photos::{self, Verdict};
use super::rederive;
use super::repo::{dest_repo, local_exists};
use super::restic::{self, run_restic};
use super::restore::{self, Rx, Source};
use super::result::{BResult, BackupError};
use super::run::{admin_conn, gated, Deps, Gate, LockPolicy};
use super::state::{BackupState, DrillRef};
use super::util::{stamp_utc, BelowNormal};

/// A passing drill is repeated after this long; a failed (or killed) one is retried after a day, not every run.
pub const DRILL_EVERY_SECS: i64 = 6 * 86_400;
pub const DRILL_RETRY_SECS: i64 = 86_400;
/// Disk kept free beyond the two copies of the database a drill holds at once (dump + restored scratch database).
const ROOM_HEADROOM: u64 = 2 << 30;

/// Whether a scheduled run should drill now. A clock that went backwards counts as due: never silent.
pub fn due(st: &BackupState, now: i64) -> bool {
    match &st.drill {
        None => true,
        Some(d) if d.at > now => true,
        Some(d) if d.ok => now - d.last_pass_at >= DRILL_EVERY_SECS,
        Some(d) => now - d.at >= DRILL_RETRY_SECS,
    }
}

/// `backup drill`: a manual run; a busy lock is LOCK_HELD.
pub fn run_drill(ctx: &BackupCtx, deps: &Deps) -> BResult<Value> {
    drill_with(ctx, deps, false)
}

/// `scheduled`: only when due, and a busy lock is a quiet `skipped`.
pub fn drill_with(ctx: &BackupCtx, deps: &Deps, scheduled: bool) -> BResult<Value> {
    match gated(ctx, LockPolicy::Acquire, scheduled, || drill_recorded(ctx, deps, scheduled))? {
        Gate::Ran(r) => r,
        Gate::Busy(why) => Ok(json!({ "skipped": why })),
    }
}

/// Outer `Err`: the drill could not even be recorded. Inner: the drill's own verdict (already recorded).
fn drill_recorded(ctx: &BackupCtx, deps: &Deps, scheduled: bool) -> BResult<BResult<Value>> {
    let cfg = super::config::load(&ctx.paths.conf_file())?;
    let now = (deps.now)();
    let mut st = BackupState::load_in(&ctx.paths, now)?;
    if scheduled && !due(&st, now) {
        return Ok(Ok(json!({ "skipped": "not-due" })));
    }
    if scheduled && !local_exists(ctx) && cfg.destinations.is_empty() {
        return Ok(Ok(json!({ "skipped": "no-backup-yet" })));
    }
    // a crashed run's plaintext (we hold backup.lock, so nothing else is using a run folder)
    let links = acl::sweep_stale(ctx)?;
    let prev_pass = st.drill.as_ref().map(|d| d.last_pass_at).unwrap_or(0);
    let prev_fail = st.drill.as_ref().and_then(|d| d.failing_since);
    let record = |st: &mut BackupState, ok: bool, seconds: u64, source: &str, detail: &str| -> BResult<()> {
        st.drill = Some(DrillRef { at: now, ok, last_pass_at: if ok { now } else { prev_pass }, seconds, source: source.to_string(), detail: detail.chars().take(300).collect(), failing_since: if ok { None } else if detail.starts_with("interrupted") { prev_fail } else { prev_fail.or(Some(now)) } });
        st.save_in(ctx).map_err(|e| BackupError::error(format!("cannot record the drill: {e}")))
    };
    record(&mut st, false, 0, "", "interrupted: the drill started and did not finish")?;
    let started = Instant::now();
    let mut label = "local".to_string();
    let result = room(ctx, deps, st.last_db_bytes).and_then(|_| attempt(ctx, deps, &cfg, now, &mut label));
    let seconds = started.elapsed().as_secs();
    let result = match result {
        Ok(_) if seconds >= cfg.rto_budget_seconds => Err(BackupError::restore_failed(format!("the drill took {seconds} s, over the {} s recovery budget", cfg.rto_budget_seconds))),
        other => other,
    };
    match &result {
        Ok(_) => record(&mut st, true, seconds, &label, "ok")?,
        Err(e) => record(&mut st, false, seconds, &label, &e.message)?,
    }
    Ok(result.map(|mut v| {
        v["seconds"] = json!(seconds);
        if !links.is_empty() {
            v["warnings"] = json!(links);
        }
        v
    }))
}

/// Two copies of the database exist at once (the plaintext dump and the scratch database): refuse before fetching a byte.
fn room(ctx: &BackupCtx, deps: &Deps, last_db_bytes: u64) -> BResult<()> {
    let need = last_db_bytes.saturating_mul(2).saturating_add(ROOM_HEADROOM);
    let free = (deps.free_bytes)(&ctx.paths.backups()).map_err(|e| BackupError::precondition(format!("cannot read free disk space: {e}")))?;
    if free < need {
        return Err(BackupError::precondition(format!("only {} MB free; a restore drill needs {} MB", free >> 20, need >> 20)));
    }
    Ok(())
}

fn attempt(ctx: &BackupCtx, deps: &Deps, cfg: &BackupConfig, now: i64, label: &mut String) -> BResult<Value> {
    let low = BelowNormal(&*deps.exec);
    let budget = cfg.rto_budget_seconds.min(i64::MAX as u64 / 2) as i64;
    let rx = Rx { exec: &low, now: deps.now, deadline: Some(now.saturating_add(budget)) };
    let src = match cfg.destinations.iter().find(|d| reachable(d)) {
        Some(d) => {
            *label = d.name.clone();
            Source { repo: dest_repo(ctx, d)?, label: d.name.clone() }
        }
        None => restore::resolve_source(ctx, None, None)?,
    };
    check_snapshot(ctx, &rx, &src, "latest", now)
}

/// `backup restore` without `--swap`: the same proof on a chosen snapshot, nothing is replaced and nothing is recorded.
pub fn verify_only(ctx: &BackupCtx, deps: &Deps, src: Source, which: &str) -> BResult<Value> {
    let rx = Rx::new(deps);
    match gated(ctx, LockPolicy::Acquire, false, || {
        let st = BackupState::load_in(&ctx.paths, (deps.now)())?;
        room(ctx, deps, st.last_db_bytes)?;
        check_snapshot(ctx, &rx, &src, which, (deps.now)())
    })? {
        Gate::Ran(r) => Ok(r),
        Gate::Busy(why) => Ok(json!({ "skipped": why })),
    }
}

/// Drops the scratch database when it goes out of scope, a panic included.
struct Scratch<'a, 'b> {
    ctx: &'a BackupCtx,
    rx: &'a Rx<'b>,
    name: String,
    armed: bool,
}

impl Scratch<'_, '_> {
    fn finish(mut self) -> bool {
        self.armed = false;
        restore::drop_database(self.ctx, self.rx, &self.name).is_ok()
    }
}

impl Drop for Scratch<'_, '_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = restore::drop_database(self.ctx, self.rx, &self.name);
        }
    }
}

/// A killed drill's scratch database would sit in the cluster for ever. Drops every `pos_drill_<14 digits>` database (each
/// name re-checked with `check_new_db_name`); returns how many went. Err when the list or a drop failed: callers treat that
/// as a warning. Also run at the start of every backup run, so a store whose drill is not due still gets cleaned.
pub(crate) fn sweep_scratch(ctx: &BackupCtx, rx: &Rx) -> BResult<usize> {
    let out = sql_scalar(rx.exec, ctx, &admin_conn(ctx, "postgres"), "SELECT datname FROM pg_database WHERE datname ~ '^pos_drill_[0-9]{14}$';", true)?;
    let (mut dropped, mut failed) = (0usize, 0usize);
    for name in out.lines().map(str::trim).filter(|n| check_new_db_name(n).is_ok()) {
        match restore::drop_database(ctx, rx, name) {
            Ok(()) => dropped += 1,
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        return Err(BackupError::error(format!("{failed} scratch database(s) could not be dropped")));
    }
    Ok(dropped)
}

/// Restore `which` into a scratch database, prove it, drop it, delete the plaintext folder.
fn check_snapshot(ctx: &BackupCtx, rx: &Rx, src: &Source, which: &str, now: i64) -> BResult<Value> {
    let snap = restore::pick_snapshot(ctx, rx, src, which)?;
    let fetched = restore::fetch_stage(ctx, rx, src, &snap)?;
    let _ = sweep_scratch(ctx, rx);
    let db = format!("pos_drill_{}", stamp_utc(now));
    let scratch = Scratch { ctx, rx, name: db.clone(), armed: true };
    let outcome = (|| -> BResult<Value> {
        restore::create_and_load(ctx, rx, &fetched, &db)?;
        restore::verify_content(ctx, rx, &fetched, &db)?;
        let re = rederive::run(ctx, rx, &db)?;
        let admin = rederive::admin_credential_check(ctx, rx, &db)?;
        let m = &fetched.manifest;
        let structure = restore::verify_structure(ctx, rx, &fetched, &db, &admin, (m.migrations_count, &m.migrations_max))?;
        // the photo list comes from the snapshot itself: nothing is downloaded
        let rows = restore::photo_rows(ctx, rx, &db)?;
        let files = match &fetched.photos_sub {
            Some(sub) => {
                let t = rx.cap(Duration::from_secs(1800), "listing the photos")?;
                let out = run_restic(rx.exec, ctx, &src.repo, &restic::ls_args(&snap.id, sub), t)?;
                if !out.ok() {
                    return Err(BackupError::restore_failed(format!("cannot list the photos of the backup: {}", restic::describe_exit(&out))));
                }
                photos::from_restic_ls(&out.stdout, sub)
            }
            None => Default::default(),
        };
        let (report, verdict) = restore::photo_report(&rows, &files);
        if verdict == Verdict::Fail {
            return Err(BackupError::restore_failed(format!("the backup is missing photos that the database refers to ({} of {} rows have no file)", report["dangling"], report["rows"])));
        }
        Ok(json!({ "source": src.label, "snapshot": snap.id, "tables": m.tables.len(), "rows": m.tables.iter().map(|t| t.count).sum::<i64>(),
                   "rederive": re, "structure": structure, "photos": report, "photosVerdict": format!("{verdict:?}") }))
    })();
    let dropped = scratch.finish();
    outcome.map(|mut v| {
        v["scratchDropped"] = json!(dropped);
        v
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::dump::{self, DbInfo, Manifest};
    use crate::backup::fingerprint::TableFp;
    use crate::backup::pg::PsqlOpener;
    use crate::backup::state::BackupState;
    use crate::backup::util::fake::{rand_pepper, rand_pin, temp_ctx, FakeExec};
    use crate::backup::util::{iso_utc, stamp_utc};
    use crate::envelope::Code;
    use crate::ops::lock::{acquire_for, LockMode};
    use std::cell::Cell;
    use std::rc::Rc;

    const NOW: i64 = 1_790_000_000;
    const ADMIN: &str = "00000000-0000-4000-8000-000000000001";
    const STAGE_SUB: &str = "/C/ProgramData/SupermarketPOS/backups/tmp/run-abc123/stage/current";

    fn write_stage(args: &[String]) {
        let t = args.iter().position(|a| a == "--target").unwrap();
        let dir = std::path::PathBuf::from(&args[t + 1]);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(dump::DUMP_FILE), b"dump").unwrap();
        std::fs::write(dir.join(dump::GLOBALS_FILE), b"globals").unwrap();
        let m = Manifest {
            schema: 1,
            taken_at: NOW - 100,
            reason: "hourly".into(),
            database: DbInfo { name: "postgres".into(), owner: "postgres".into(), encoding: "UTF8".into(), provider: "i".into(), locale: "es-MX".into(), collate: "C".into(), ctype: "C".into(), collversion: "1".into(), bytes: 4096, settings: vec![] },
            migrations_count: 3,
            migrations_max: "20260930000001".into(),
            files: dump::file_entries(&dir).unwrap(),
            tables: vec![TableFp { name: "public.items".into(), count: 3, hash: "123".into() }, TableFp { name: "public.caja_sessions".into(), count: 1, hash: "5".into() }],
            catalog: [("functions".to_string(), "aa".to_string())].into_iter().collect(),
            ..Default::default()
        };
        dump::write_manifest(&dir, &m).unwrap();
    }

    fn snapshot_json() -> String {
        format!(
            "[{{\"id\":\"aaaa1111bbbb\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"C:\\\\ProgramData\\\\SupermarketPOS\\\\backups\\\\tmp\\\\run-abc123\\\\stage\\\\current\",\"C:\\\\ProgramData\\\\SupermarketPOS\\\\photos\"]}}]",
            iso_utc(NOW - 60)
        )
    }

    fn healthy(pin: &str) -> FakeExec {
        FakeExec::default()
            .on_with(&format!("restore aaaa1111bbbb:{STAGE_SUB}"), 0, "", write_stage)
            .on("snapshots --json", 0, &snapshot_json())
            .on("role::text = 'admin'", 0, &format!("{ADMIN},{pin}\n"))
            .on("WHERE pin ~", 0, &format!("{ADMIN},{pin}\n"))
            .on("encrypted_password = crypt", 0, "t\n")
            .on("ONLY %s __fp_row", 0, "public.items|3|123\npublic.caja_sessions|1|5\n")
            .on("pg_default_acl", 0, "functions|aa\n")
            .on("AUTH:", 0, "AUTH:1\n")
            .on("ANON:", 0, "ANON:0\n")
            .on("has_function_privilege", 0, "t\n")
            .on("FROM supabase_migrations.schema_migrations", 0, "3|20260930000001\n")
            .on("storage.objects", 0, "product-photos/aaa\n")
            .on(" ls --json", 0, "{\"name\":\"aaa\",\"type\":\"file\",\"path\":\"/C/ProgramData/SupermarketPOS/photos/product-photos/aaa\",\"message_type\":\"node\"}\n")
    }

    fn deps(e: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(e), opener: Box::new(PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }
    fn state(c: &BackupCtx) -> BackupState {
        BackupState::load(&c.paths.state_file(), 0).unwrap()
    }
    fn run_folders(c: &BackupCtx) -> usize {
        std::fs::read_dir(c.paths.backups_tmp()).map(|r| r.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("run-")).count()).unwrap_or(0)
    }
    fn set_budget(c: &BackupCtx, secs: u64) {
        std::fs::write(c.paths.conf_file(), format!(r#"{{"schema":1,"backup":{{"rtoBudgetSeconds":{secs}}}}}"#)).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_drill_with_a_non_private_scratch_root_is_refused_before_anything_is_swept() {
        let (d, dev) = temp_ctx();
        // a real (non-dev) context over the same folders: they inherit the user's DACL, so they are not private
        let roots = crate::paths::Roots { dev: false, ..crate::paths::Roots::custom(dev.paths.data().to_path_buf(), d.path().join("program")) };
        let c = BackupCtx::new(&roots, dev.pack_dir.clone(), crate::ports::Ports::new(47300).unwrap(), "t".into(), "t".into());
        std::fs::create_dir_all(c.paths.backups_tmp().join("run-dead")).unwrap();
        let e = Rc::new(healthy(&rand_pin()));
        let err = drill_recorded(&c, &deps(e.clone()), false).unwrap_err();
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("not private"), "{}", err.message);
        assert!(c.paths.backups_tmp().join("run-dead").exists(), "nothing was swept");
        assert!(e.calls.borrow().is_empty(), "no tool ran");
    }

    #[test]
    fn a_healthy_drill_restores_verifies_drops_the_scratch_database_and_records_a_pass() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(healthy(&rand_pin()));
        let out = run_drill(&c, &deps(e.clone())).unwrap();
        assert_eq!(out["source"], "local");
        let name = format!("pos_drill_{}", stamp_utc(NOW));
        assert!(e.index_of(&format!("CREATE DATABASE \"{name}\"")).is_some());
        assert!(e.calls.borrow().last().unwrap().contains(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")), "the scratch database is the last thing touched");
        assert_eq!(run_folders(&c), 0, "the plaintext restore folder is deleted");
        let d = state(&c).drill.unwrap();
        assert!(d.ok && d.last_pass_at == NOW && d.source == "local" && d.detail == "ok");
        assert!(e.calls.borrow().iter().all(|l| !l.contains("RENAME TO")), "a drill never touches the live database");
        assert!(e.calls.borrow().iter().all(|l| !l.contains("-d postgres") || !l.starts_with("pg_restore")), "never restores into the live database");
    }

    #[test]
    fn every_child_of_the_drill_runs_below_normal_priority() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(healthy(&rand_pin()));
        run_drill(&c, &deps(e.clone())).unwrap();
        let prios = e.prios.borrow().clone();
        assert!(prios.len() > 10, "{}", prios.len());
        assert!(prios.iter().all(|p| *p == crate::exec::Priority::BelowNormal), "{prios:?}");
    }

    #[test]
    fn a_mismatching_table_fails_the_drill_still_cleans_up_and_records_the_failure() {
        let (_d, c) = temp_ctx();
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| r.needle != "ONLY %s __fp_row");
        let e = Rc::new(base.on("ONLY %s __fp_row", 0, "public.items|3|999\npublic.caja_sessions|1|5\n"));
        let err = run_drill(&c, &deps(e.clone())).unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        assert!(e.calls.borrow().last().unwrap().contains("DROP DATABASE IF EXISTS"));
        assert_eq!(run_folders(&c), 0);
        let d = state(&c).drill.unwrap();
        assert!(!d.ok && d.detail.contains("public.items"), "{d:?}");
        assert_eq!(d.last_pass_at, 0);
    }

    #[test]
    fn a_failed_drill_keeps_the_time_of_the_last_pass() {
        let (_d, c) = temp_ctx();
        let mut st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        st.drill = Some(crate::backup::state::DrillRef { at: NOW - 86_400, ok: true, last_pass_at: NOW - 86_400, seconds: 5, source: "local".into(), detail: "ok".into(), ..Default::default() });
        st.save_in(&c).unwrap();
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| r.needle != "ONLY %s __fp_row");
        let e = Rc::new(base.on("ONLY %s __fp_row", 0, "public.items|3|999\n"));
        assert!(run_drill(&c, &deps(e)).is_err());
        let d = state(&c).drill.unwrap();
        assert!(!d.ok && d.last_pass_at == NOW - 86_400 && d.at == NOW);
        assert_eq!(d.failing_since, Some(NOW), "the first real failure is stamped");
    }

    #[test]
    fn a_second_failure_and_the_interrupted_marker_keep_the_first_failing_time() {
        let (_d, c) = temp_ctx();
        let mut st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        st.drill = Some(crate::backup::state::DrillRef { at: NOW - 3 * 86_400, ok: false, last_pass_at: NOW - 9 * 86_400, seconds: 5, source: "local".into(), detail: "old".into(), failing_since: Some(NOW - 3 * 86_400) });
        st.save_in(&c).unwrap();
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| r.needle != "ONLY %s __fp_row");
        let e = Rc::new(base.on("ONLY %s __fp_row", 0, "public.items|3|999\n"));
        assert!(run_drill(&c, &deps(e)).is_err());
        assert_eq!(state(&c).drill.unwrap().failing_since, Some(NOW - 3 * 86_400), "repeated failures do not move it");
    }

    #[test]
    fn a_backup_that_silently_omits_the_photos_fails_the_drill() {
        let (_d, c) = temp_ctx();
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| r.needle != " ls --json" && r.needle != "storage.objects");
        let rows: String = (0..40).map(|i| format!("product-photos/p{i}\n")).collect();
        let e = Rc::new(base.on(" ls --json", 0, "").on("storage.objects", 0, &rows));
        let err = run_drill(&c, &deps(e)).unwrap_err();
        assert!(err.message.contains("photos"), "{}", err.message);
    }

    #[test]
    fn a_drill_at_or_over_the_rto_budget_is_a_failure_and_says_so() {
        let (_d, c) = temp_ctx();
        set_budget(&c, 0);
        let err = run_drill(&c, &deps(Rc::new(healthy(&rand_pin())))).unwrap_err();
        assert!(err.message.contains("budget"), "{}", err.message);
        let d = state(&c).drill.unwrap();
        assert!(!d.ok && d.detail.contains("budget"));
    }

    #[test]
    fn child_timeouts_are_capped_by_the_budget_that_is_left() {
        let (_d, c) = temp_ctx();
        set_budget(&c, 120);
        let e = Rc::new(healthy(&rand_pin()));
        run_drill(&c, &deps(e.clone())).unwrap();
        for (line, t) in e.calls.borrow().iter().zip(e.timeouts.borrow().iter()) {
            if line.starts_with("restic.exe") || line.starts_with("pg_restore.exe") {
                assert!(*t <= std::time::Duration::from_secs(120), "{line}: {t:?}");
            }
        }
    }

    #[test]
    fn the_drill_prefers_a_connected_destination_because_that_is_the_disaster_path() {
        let (d, c) = temp_ctx();
        let usb = d.path().join("usb");
        std::fs::create_dir_all(&usb).unwrap();
        std::fs::write(usb.join("config"), b"x").unwrap();
        std::fs::write(c.paths.conf_file(), format!(r#"{{"schema":1,"backup":{{"destinations":[{{"name":"usb-e","kind":"device","path":{},"addedAt":0}}]}}}}"#, serde_json::to_string(&usb.to_string_lossy()).unwrap())).unwrap();
        let e = Rc::new(healthy(&rand_pin()));
        let out = run_drill(&c, &deps(e.clone())).unwrap();
        assert_eq!(out["source"], "usb-e");
        assert!(e.calls.borrow().iter().any(|l| l.contains(&format!("--repo {}", usb.display())) && l.contains(" restore ")));
        assert_eq!(state(&c).drill.unwrap().source, "usb-e");
    }

    #[test]
    fn an_unplugged_destination_falls_back_to_the_local_repository() {
        let (d, c) = temp_ctx();
        let usb = d.path().join("usb-missing");
        std::fs::write(c.paths.conf_file(), format!(r#"{{"schema":1,"backup":{{"destinations":[{{"name":"usb-e","kind":"device","path":{},"addedAt":0}}]}}}}"#, serde_json::to_string(&usb.to_string_lossy()).unwrap())).unwrap();
        let out = run_drill(&c, &deps(Rc::new(healthy(&rand_pin())))).unwrap();
        assert_eq!(out["source"], "local");
    }

    #[test]
    fn a_killed_drill_leaves_a_failure_marker_not_a_stale_success() {
        let (_d, c) = temp_ctx();
        let mut st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        st.drill = Some(crate::backup::state::DrillRef { at: NOW - 86_400, ok: true, last_pass_at: NOW - 86_400, seconds: 5, source: "local".into(), detail: "ok".into(), ..Default::default() });
        st.save_in(&c).unwrap();
        let seen = Rc::new(Cell::new(false));
        let (flag, path) = (seen.clone(), c.paths.state_file());
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| !r.needle.starts_with("restore aaaa1111bbbb"));
        let e = Rc::new(base.on_with(&format!("restore aaaa1111bbbb:{STAGE_SUB}"), 0, "", move |args| {
            let text = std::fs::read_to_string(&path).unwrap();
            let s: BackupState = serde_json::from_str(&text).unwrap();
            let d = s.drill.unwrap();
            flag.set(!d.ok && d.detail.contains("interrupted") && d.last_pass_at == NOW - 86_400);
            write_stage(args);
        }));
        run_drill(&c, &deps(e)).unwrap();
        assert!(seen.get(), "the marker is saved before the first child starts");
    }

    #[test]
    fn a_panic_mid_drill_still_drops_the_scratch_database_deletes_the_plaintext_and_frees_the_lock() {
        let (_d, c) = temp_ctx();
        let mut base = healthy(&rand_pin());
        base.rules.retain(|r| r.needle != "AUTH:");
        let e = Rc::new(base.on_with("pg_restore.exe", 0, "", |_| panic!("simulated crash inside pg_restore")));
        let d = deps(e.clone());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_drill(&c, &d)));
        assert!(r.is_err(), "the panic propagates");
        assert!(e.calls.borrow().last().unwrap().contains("DROP DATABASE IF EXISTS \"pos_drill_"), "{:?}", e.calls.borrow().last());
        assert_eq!(run_folders(&c), 0, "the plaintext stage is gone");
        drop(acquire_for(c.paths.roots(), LockMode::Exclusive, "test", "t-1", std::time::Duration::from_secs(0)).expect("the lock was released"));
    }

    #[test]
    fn leftover_scratch_databases_of_a_killed_drill_are_dropped_first_and_only_those() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(healthy(&rand_pin()).on("datname ~", 0, "pos_drill_20250101000000\nnot_a_drill\npostgres\npos_drill_x\n"));
        run_drill(&c, &deps(e.clone())).unwrap();
        assert!(e.index_of("DROP DATABASE IF EXISTS \"pos_drill_20250101000000\" WITH (FORCE)").is_some());
        for never in ["not_a_drill", "\"postgres\" WITH", "pos_drill_x"] {
            assert!(e.calls.borrow().iter().all(|l| !(l.contains("DROP DATABASE") && l.contains(never))), "{never}");
        }
        let sweep = e.index_of("datname ~").unwrap();
        assert!(sweep < e.index_of("CREATE DATABASE").unwrap());
    }

    #[test]
    fn no_pin_pepper_or_derived_password_ever_reaches_a_command_line_or_the_result() {
        let (_d, c) = temp_ctx();
        let pin = rand_pin();
        let pepper = std::fs::read_to_string(c.paths.pepper()).unwrap();
        let _ = rand_pepper();
        let e = Rc::new(healthy(&pin));
        let out = run_drill(&c, &deps(e.clone())).unwrap();
        for l in e.calls.borrow().iter() {
            let argv = l.split(" <<").next().unwrap();
            assert!(!argv.contains(&pin) && !argv.contains(pepper.trim()) && !argv.contains("v1."), "{argv}");
            assert!(!l.contains(&pin) && !l.contains(pepper.trim()), "{l}");
        }
        let all = format!("{out}{:?}", state(&c).drill);
        assert!(!all.contains(&pin) && !all.contains(pepper.trim()));
    }

    #[test]
    fn a_manual_drill_that_finds_an_update_running_is_lock_held_and_a_scheduled_one_is_quiet() {
        let (_d, c) = temp_ctx();
        let _held = acquire_for(c.paths.roots(), LockMode::Exclusive, "update", "u-1", std::time::Duration::from_secs(0)).unwrap();
        let e = Rc::new(healthy(&rand_pin()));
        assert_eq!(run_drill(&c, &deps(e.clone())).unwrap_err().code, Code::LockHeld);
        let out = drill_with(&c, &deps(e.clone()), true).unwrap();
        assert_eq!(out["skipped"], "update-in-progress");
        assert!(e.calls.borrow().is_empty());
    }

    #[test]
    fn a_scheduled_drill_runs_only_when_one_is_due() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(healthy(&rand_pin()));
        // never drilled: due
        assert!(drill_with(&c, &deps(e.clone()), true).unwrap().get("skipped").is_none());
        // just passed: not due, nothing runs
        let before = e.calls.borrow().len();
        assert_eq!(drill_with(&c, &deps(e.clone()), true).unwrap()["skipped"], "not-due");
        assert_eq!(e.calls.borrow().len(), before);
    }

    #[test]
    fn due_is_weekly_after_a_pass_and_daily_after_a_failure() {
        let mk = |at: i64, ok: bool, pass: i64| BackupState { drill: Some(crate::backup::state::DrillRef { at, ok, last_pass_at: pass, ..Default::default() }), ..Default::default() };
        assert!(due(&BackupState::default(), NOW), "never drilled");
        assert!(!due(&mk(NOW - 86_400, true, NOW - 86_400), NOW));
        assert!(!due(&mk(NOW - 6 * 86_400 + 60, true, NOW - 6 * 86_400 + 60), NOW));
        assert!(due(&mk(NOW - 6 * 86_400 - 60, true, NOW - 6 * 86_400 - 60), NOW));
        assert!(!due(&mk(NOW - 3600, false, NOW - 86_400), NOW), "a failure is retried tomorrow, not every hour");
        assert!(due(&mk(NOW - 86_400 - 60, false, NOW - 3 * 86_400), NOW));
        assert!(due(&mk(NOW + 3600, true, NOW + 3600), NOW), "a clock that went backwards is due, never silent");
    }

    #[test]
    fn verifying_a_chosen_snapshot_restores_proves_and_drops_without_recording_a_drill() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(healthy(&rand_pin()));
        let d = deps(e.clone());
        let src = crate::backup::restore::resolve_source(&c, None, None).unwrap();
        let out = verify_only(&c, &d, src, "aaaa1111").unwrap();
        assert_eq!(out["snapshot"], "aaaa1111bbbb");
        assert!(e.calls.borrow().last().unwrap().contains("DROP DATABASE IF EXISTS"));
        assert!(state(&c).drill.is_none());
        assert_eq!(run_folders(&c), 0);
    }

    #[test]
    fn the_plaintext_of_a_crashed_earlier_run_is_swept_when_the_drill_starts() {
        let (_d, c) = temp_ctx();
        let old = c.paths.backups_tmp().join("run-deadbeef0000");
        std::fs::create_dir_all(old.join("stage").join("current")).unwrap();
        std::fs::write(old.join("stage").join("current").join(dump::DUMP_FILE), b"left behind").unwrap();
        run_drill(&c, &deps(Rc::new(healthy(&rand_pin())))).unwrap();
        assert!(!old.exists());
    }

    #[test]
    fn a_drill_without_room_for_two_copies_of_the_database_fails_before_fetching_anything() {
        let (_d, c) = temp_ctx();
        let mut st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        st.last_db_bytes = 10 << 30;
        st.save_in(&c).unwrap();
        let e = Rc::new(healthy(&rand_pin()));
        let d = Deps { exec: Box::new(e.clone()), opener: Box::new(PsqlOpener), now: || NOW, free_bytes: |_| Ok(15 << 30) };
        let err = run_drill(&c, &d).unwrap_err();
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("MB free"), "{}", err.message);
        assert!(e.calls.borrow().is_empty(), "nothing was fetched or created");
        let rec = state(&c).drill.unwrap();
        assert!(!rec.ok, "a drill that cannot run is a failed drill, not a silent one");
    }
}
