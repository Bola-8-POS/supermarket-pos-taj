//! The pieces of a restore that do not depend on how the result is swapped in (Task 8) or thrown away (the drill).
//! Every database name passes `pg::check_new_db_name` (`pos_next` or a drill scratch name, never `postgres` or `template*`).
//!
//! The fetched stage holds `profiles.pin` in plaintext (invariant 3), so it lives in a per-run `PrivateDir` and is deleted
//! when the `Fetched` is dropped, whatever the exit path. Every `PrivateDir` user holds `backup.lock` (the drill via
//! `run::gated`, the restore work in process under the exclusive update lock).
//!
//! Nothing read from a dump is ever put in an error: `pg_restore` and `psql` errors reach the caller as counts and the
//! first line of the first error with digit runs masked, never the DETAIL, `Command was` or context lines.
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::acl::PrivateDir;
use super::ctx::BackupCtx;
use super::dump::{self, Manifest};
use super::fingerprint::{diff_catalog, diff_tables, parse_catalog, parse_table_fp};
use super::keys::normalize_recovery_key;
use super::paths::restic_path;
use super::pg::{self, check_new_db_name, ident};
use super::policy::Reason;
use super::restic::latest_where;
use super::repo::{load_env_file, local_exists, local_repo};
use super::restic::{self, parse_snapshots, run_restic, Password, Repo, Snap};
use super::result::{BResult, BackupError};
use super::run::{admin_conn, Deps};
use super::util::{tail, Exec};

/// What the restore building blocks run against: the process runner, the clock, and an optional deadline (epoch seconds
/// on the `now` clock). The drill sets a deadline (its RTO budget) and a below-normal runner; a real restore sets neither.
pub struct Rx<'a> {
    pub exec: &'a dyn Exec,
    pub now: fn() -> i64,
    pub deadline: Option<i64>,
}

impl<'a> Rx<'a> {
    pub fn new(deps: &'a Deps) -> Self {
        Self { exec: &*deps.exec, now: deps.now, deadline: None }
    }

    /// A child's timeout: its own, never more than the time left; out of time is an error naming the step.
    pub fn cap(&self, own: Duration, step: &str) -> BResult<Duration> {
        let Some(dl) = self.deadline else { return Ok(own) };
        let left = dl - (self.now)();
        if left <= 0 {
            return Err(BackupError::restore_failed(format!("over the recovery time budget before {step}")));
        }
        Ok(own.min(Duration::from_secs(left as u64)))
    }
}

#[derive(Debug)]
pub struct Source {
    pub repo: Repo,
    pub label: String,
}

/// Credentials in an `s3:` address would land on restic's argv, in the journal, in `posctl.json` and in the outcome: they belong
/// in `secrets\r2.env`. The address is never echoed. Shared by `restore --repo` and `dest add --kind r2`.
pub(crate) fn refuse_s3_credentials(loc: &str) -> BResult<()> {
    if loc.starts_with("s3:") && loc.contains('@') {
        return Err(BackupError::usage("an s3: address must not contain credentials (no @ part); they come from secrets\\r2.env"));
    }
    Ok(())
}

/// A restic repository location this module will read: an `s3:` URL or an absolute drive path. A share (`\\host\...`)
/// is refused like it is for destinations (SYSTEM would authenticate to it), and so is anything an option parser could
/// take for a flag.
fn check_location(loc: &str) -> BResult<()> {
    refuse_s3_credentials(loc)?;
    let s3 = loc.strip_prefix("s3:").is_some_and(|r| !r.is_empty());
    let drive = Path::new(loc).is_absolute() && !loc.starts_with("\\\\") && !loc.starts_with("//");
    if s3 || drive {
        Ok(())
    } else if loc.starts_with("\\\\") || loc.starts_with("//") {
        Err(BackupError::usage("network shares are not supported; use a USB drive or R2"))
    } else {
        Err(BackupError::usage("--repo must be a full drive path such as E:\\SupermarketPOS-Backup, or an s3: address"))
    }
}

pub fn resolve_source(ctx: &BackupCtx, repo_arg: Option<&str>, recovery_key: Option<&str>) -> BResult<Source> {
    let password = match recovery_key {
        Some(k) => Password::Plain(normalize_recovery_key(k).ok_or_else(|| BackupError::usage("that is not a valid recovery key"))?),
        None => Password::File(ctx.paths.machine_key()),
    };
    match repo_arg {
        None => {
            if !local_exists(ctx) {
                return Err(BackupError::precondition("there is no backup repository on this PC; give the drive or share with --repo <folder or s3 URL> and the recovery key with --key-stdin"));
            }
            Ok(Source { repo: Repo { password, ..local_repo(ctx) }, label: "local".into() })
        }
        Some(loc) => {
            check_location(loc)?;
            if !loc.starts_with("s3:") && !matches!(super::dest::reparse_on_path(std::path::Path::new(loc)), Ok(None)) {
                return Err(BackupError::precondition("the backup folder is a link; give the real folder"));
            }
            let extra_env = if loc.starts_with("s3:") { load_env_file(&ctx.paths.r2_env())? } else { vec![] };
            Ok(Source { repo: Repo { location: loc.to_string(), password, extra_env }, label: loc.to_string() })
        }
    }
}

/// `latest` (the newest snapshot of THIS repository) or a snapshot id of at least 8 hex digits. An id is looked up with
/// `Snap::is`, so the id a snapshot had where it was made also finds its copy in a destination (restic copy assigns new
/// ids); a specific id never falls back to the newest snapshot.
pub fn pick_snapshot(ctx: &BackupCtx, rx: &Rx, src: &Source, which: &str) -> BResult<Snap> {
    let t = rx.cap(Duration::from_secs(300), "listing the backups")?;
    let out = run_restic(rx.exec, ctx, &src.repo, &restic::snapshots_args(), t)?;
    if !out.ok() {
        return Err(match out.code {
            12 => BackupError::precondition("these backups were made with a different key; supply the owner's recovery key (--key-stdin)"),
            10 => BackupError::precondition(format!("there is no backup repository at {}", src.label)),
            _ => BackupError::restore_failed(format!("cannot list the backups: {} {}", restic::describe_exit(&out), tail(&out.stderr))),
        });
    }
    let snaps = parse_snapshots(&out.stdout).map_err(BackupError::restore_failed)?;
    let found = if which == "latest" {
        // the snapshot a restore takes of the damaged live database must not be what a retried `latest` restores (its id still works: an undo)
        latest_where(&snaps, |s| !s.tags.iter().any(|t| *t == format!("reason:{}", Reason::PreRestore.as_str()))).cloned()
    } else if which.len() >= 8 && which.bytes().all(|b| b.is_ascii_hexdigit()) {
        snaps.iter().filter(|s| s.is(which)).max_by_key(|s| s.time).cloned()
    } else {
        None
    };
    // the id comes out of the repository's JSON and goes to restic's argv and the journal: hex only (a repository on a removable
    // drive is not trusted)
    if let Some(f) = &found {
        if !(8..=64).contains(&f.id.len()) || !f.id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BackupError::restore_failed("the repository returned something that is not a valid snapshot id"));
        }
    }
    found.ok_or_else(|| BackupError::restore_failed(if which == "latest" { "there are no backups in this repository".to_string() } else { format!("no backup matches '{which}'") }))
}

/// The restored stage. Dropping it deletes the plaintext (when it owns a `PrivateDir`).
pub struct Fetched {
    pub snap: Snap,
    pub dir: std::path::PathBuf,
    pub manifest: Manifest,
    pub photos_sub: Option<String>,
    pub guard: Option<PrivateDir>,
}

impl std::fmt::Debug for Fetched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Fetched").field("snapshot", &self.snap.id).field("dir", &self.dir).finish_non_exhaustive()
    }
}

fn sub_of(snap: &Snap, suffix: &str) -> Option<String> {
    snap.paths.iter().find(|p| p.replace('\\', "/").to_lowercase().ends_with(suffix)).map(|p| restic_path(Path::new(p)))
}

/// The manifest of `snap` alone (a few KB), read before anything is written, so the disk can be checked first. It is only used
/// to size the restore: `fetch_stage` reads the manifest again from the restored stage and proves every file against it.
pub fn peek_manifest(ctx: &BackupCtx, rx: &Rx, src: &Source, snap: &Snap) -> BResult<Manifest> {
    let stage_sub = sub_of(snap, "/stage/current").ok_or_else(|| BackupError::restore_failed("the backup does not contain a database dump"))?;
    let t = rx.cap(Duration::from_secs(300), "reading the backup manifest")?;
    let out = run_restic(rx.exec, ctx, &src.repo, &restic::dump_file_args(&snap.id, &stage_sub, dump::MANIFEST_FILE), t)?;
    if !out.ok() {
        return Err(BackupError::restore_failed(format!("cannot read the backup manifest: {} {}", restic::describe_exit(&out), tail(&out.stderr))));
    }
    serde_json::from_str(&out.stdout).map_err(|e| BackupError::restore_failed(format!("the backup manifest is invalid: {e}")))
}

/// Restores the staged folder of `snap` into a private run folder under `backups\tmp\` and proves every file against the
/// manifest (exact name set, size, sha256). Any failure deletes the folder.
pub fn fetch_stage(ctx: &BackupCtx, rx: &Rx, src: &Source, snap: &Snap) -> BResult<Fetched> {
    let stage_sub = sub_of(snap, "/stage/current").ok_or_else(|| BackupError::restore_failed("the backup does not contain a database dump"))?;
    let guard = PrivateDir::create(ctx)?;
    let dir = guard.path().join("stage");
    let t = rx.cap(Duration::from_secs(6 * 3600), "fetching the backup")?;
    let out = run_restic(rx.exec, ctx, &src.repo, &restic::restore_args(&snap.id, &stage_sub, &dir, false), t)?;
    if !out.ok() {
        return Err(BackupError::restore_failed(format!("restic restore failed: {} {}", restic::describe_exit(&out), tail(&out.stderr))));
    }
    let manifest = dump::read_manifest(&dir).map_err(BackupError::restore_failed)?;
    if manifest.schema != 1 {
        return Err(BackupError::restore_failed(format!("this backup has manifest format {}; this version understands 1", manifest.schema)));
    }
    dump::verify_files(&dir, &manifest).map_err(BackupError::restore_failed)?;
    Ok(Fetched { photos_sub: sub_of(snap, "/photos"), snap: snap.clone(), dir, manifest, guard: Some(guard) })
}

/// The first regular file under `dir` that has more than one hard link (Windows `nNumberOfLinks`), or an error when one cannot be
/// inspected. A photo is a plain file named by row uuid, so a second link can only have been planted.
#[cfg(windows)]
fn hardlinked_file_under(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let m = e.metadata()?;
            if m.is_dir() {
                todo.push(e.path());
            } else if m.is_file() {
                let f = std::fs::File::open(e.path())?;
                if super::acl::link_count(&f)? > 1 {
                    return Ok(Some(e.path()));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(not(windows))]
fn hardlinked_file_under(_dir: &Path) -> std::io::Result<Option<PathBuf>> {
    Ok(None)
}

/// Adds the snapshot's photos to the live folder (same names, same bytes: files are named by row uuid).
/// Nothing is deleted: a newer photo stays as a harmless orphan, and a failed restore cannot lose a photo.
// Accepted as cosmetic: `--overwrite if-changed` also reverts a file whose key is reused in place (the store logo) to the
// snapshot's bytes, and a restore that rolls back later does not put the newer one back. Photos are named by row uuid, so
// this only touches rows that exist in both; the mode is deliberately not changed.
pub fn merge_photos(ctx: &BackupCtx, rx: &Rx, src: &Source, f: &Fetched) -> BResult<()> {
    let Some(sub) = &f.photos_sub else { return Ok(()) };
    std::fs::create_dir_all(ctx.paths.photos())?;
    // The Functions account can write here: a planted junction would send an admin-run restore anywhere, and a planted hard link
    // (files are skipped by the walk) would let `--overwrite if-changed` write through to another file. The same check-to-restic
    // TOCTOU window as for a destination applies, over this restore's 6 h cap; it is a known limit.
    if !matches!(super::dest::reparse_on_path(&ctx.paths.photos()), Ok(None)) {
        return Err(BackupError::restore_failed("the photos folder contains a link; no photos were restored"));
    }
    if !matches!(hardlinked_file_under(&ctx.paths.photos()), Ok(None)) {
        return Err(BackupError::restore_failed("the photos folder contains a hard-linked file; no photos were restored"));
    }
    let t = rx.cap(Duration::from_secs(6 * 3600), "restoring the photos")?;
    let out = run_restic(rx.exec, ctx, &src.repo, &restic::restore_args(&f.snap.id, sub, &ctx.paths.photos(), true), t)?;
    if !out.ok() {
        return Err(BackupError::restore_failed(format!("restoring the photos failed: {} {}", restic::describe_exit(&out), tail(&out.stderr))));
    }
    Ok(())
}

/// Cleanup is never capped by the budget: a scratch database must go even when time ran out.
pub fn drop_database(ctx: &BackupCtx, rx: &Rx, name: &str) -> BResult<()> {
    check_new_db_name(name)?;
    pg::sql_script(rx.exec, ctx, &admin_conn(ctx, "postgres"), &format!("DROP DATABASE IF EXISTS {} WITH (FORCE);\n", ident(name)), Duration::from_secs(120)).map(|_| ())
}

/// Replaces every quoted value (`"..."`, or `'...'` opened after a space, colon or bracket) with `"…"`: server messages quote
/// the offending value (an e-mail, a name). An unclosed quote hides the rest of the line.
fn redact_quoted(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let opens = c == '"' || (c == '\'' && (i == 0 || matches!(chars[i - 1], ' ' | ':' | '(' | '[' | ',')));
        if !opens {
            out.push(c);
            i += 1;
            continue;
        }
        out.push_str("\"\u{2026}\"");
        match chars[i + 1..].iter().position(|x| *x == c) {
            Some(n) => i += n + 2,
            None => break,
        }
    }
    out
}

/// What a failed `pg_restore` may say: how many errors, and the first error's own line (no DETAIL, no `Command was`, no
/// context lines, which can quote rows such as `profiles.pin`) with quoted values redacted and every run of four or more digits masked.
fn restore_error_summary(stderr: &str) -> String {
    let errs: Vec<&str> = stderr.lines().filter(|l| l.starts_with("pg_restore: error:")).collect();
    let first: String = redact_quoted(&errs.first().map(|l| l.chars().take(160).collect::<String>()).unwrap_or_default());
    let mut masked = String::new();
    let mut run = String::new();
    for c in first.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            if run.len() >= 4 { masked.push('#') } else { masked.push_str(&run) }
            run.clear();
            masked.push(c);
        }
    }
    format!("{} error line(s); first: {}", errs.len(), masked.trim())
}

/// Longest `pg_restore` may run: 2 MiB/s of the database size, at least 15 minutes, at most 6 hours.
pub(crate) fn restore_timeout(db_bytes: i64) -> Duration {
    Duration::from_secs((15 * 60u64).max(db_bytes.max(0) as u64 / (2 << 20)).min(6 * 3600))
}

/// CREATE (manifest locale, owner, settings, the live database's ACL), `pg_restore --exit-on-error`, ANALYZE.
/// The globals file is never replayed: the cluster's roles come from provisioning, and a role the dump needs but the
/// cluster lacks makes `pg_restore --exit-on-error` fail before anything is swapped.
/// On any failure the half-built database is dropped.
pub fn create_and_load(ctx: &BackupCtx, rx: &Rx, f: &Fetched, db: &str) -> BResult<()> {
    let create = format!("{}\n{}", pg::create_db_sql(&f.manifest.database, db)?, pg::alter_settings_sql(db, &f.manifest.database.settings)?);
    let admin = admin_conn(ctx, "postgres");
    let _ = drop_database(ctx, rx, db);
    let result = (|| -> BResult<()> {
        pg::sql_script(rx.exec, ctx, &admin, &create, rx.cap(Duration::from_secs(120), "creating the database")?)?;
        // Only the clone inherits the live database's grants. A drill database gets none: PUBLIC loses CONNECT, so no app
        // role can open the restored copy (it holds the staff table in plaintext).
        let acl = if db == crate::ops::names::NEXT {
            pg::sql_scalar(rx.exec, ctx, &admin, &pg::acl_replicate_sql("postgres", db), true)?
        } else {
            format!("REVOKE ALL ON DATABASE {} FROM PUBLIC;", ident(db))
        };
        if !acl.trim().is_empty() {
            pg::sql_script(rx.exec, ctx, &admin, &acl, rx.cap(Duration::from_secs(60), "copying the database privileges")?)?;
        }
        let mut args: Vec<String> = ["-h", &admin.host, "-p", &admin.port.to_string(), "-U", &admin.user, "-w", "--exit-on-error", "-j", "2", "-d", db].iter().map(|s| s.to_string()).collect();
        args.push(f.dir.join(dump::DUMP_FILE).to_string_lossy().into_owned());
        let t = rx.cap(restore_timeout(f.manifest.database.bytes), "loading the database")?;
        let out = rx.exec.run(&ctx.pg_exe("pg_restore.exe"), &args, &admin.env(), None, t).map_err(BackupError::tool)?;
        if !out.ok() {
            let how = if out.timed_out { "timed out".to_string() } else { format!("exit {}", out.code) };
            return Err(BackupError::restore_failed(format!("pg_restore failed ({how}): {}", restore_error_summary(&out.stderr))));
        }
        pg::sql_script(rx.exec, ctx, &admin_conn(ctx, db), "ANALYZE;\n", rx.cap(Duration::from_secs(1800), "analysing the database")?).map(|_| ())
    })();
    if result.is_err() {
        let _ = drop_database(ctx, rx, db);
    }
    result
}

/// Row fingerprints and catalog fingerprints of the restored database against the ones taken inside the backup's own
/// snapshot. Run BEFORE migrating forward and before re-deriving passwords (both change what is fingerprinted).
pub fn verify_content(ctx: &BackupCtx, rx: &Rx, f: &Fetched, db: &str) -> BResult<()> {
    let conn = admin_conn(ctx, db);
    let tables_out = pg::sql_script(rx.exec, ctx, &conn, &format!("{}{}", pg::session_settings(false), pg::TABLES_FP_SQL), rx.cap(Duration::from_secs(1800), "checking the table contents")?)?;
    let got: Vec<_> = tables_out.lines().filter(|l| !l.trim().is_empty()).map(parse_table_fp).collect::<Result<_, _>>().map_err(BackupError::restore_failed)?;
    let cat_out = pg::sql_script(rx.exec, ctx, &conn, &format!("{}{}", pg::session_settings(false), pg::catalog_fp_sql()), rx.cap(Duration::from_secs(600), "checking the database structure")?)?;
    let lines: Vec<String> = cat_out.lines().map(String::from).collect();
    let got_cat = parse_catalog(&lines).map_err(BackupError::restore_failed)?;
    let mut diffs = diff_tables(&f.manifest.tables, &got);
    diffs.extend(diff_catalog(&f.manifest.catalog, &got_cat));
    if diffs.is_empty() {
        Ok(())
    } else {
        Err(BackupError::restore_failed(format!("the restored database does not match the backup: {}", diffs.iter().take(5).cloned().collect::<Vec<_>>().join("; "))))
    }
}

/// Migration level, the app role path (S7 REVIEW I2) and the lockout hook's privilege.
/// `expect`: (count, max) the database must be at now.
pub fn verify_structure(ctx: &BackupCtx, rx: &Rx, f: &Fetched, db: &str, admin_id: &str, expect: (i64, &str)) -> BResult<Value> {
    if !crate::staff_password::is_uuid(admin_id) {
        return Err(BackupError::restore_failed("the admin id is not a UUID"));
    }
    let conn = admin_conn(ctx, db);
    let lvl = pg::sql_scalar(rx.exec, ctx, &conn, pg::MIGRATIONS_SQL, true)?;
    if lvl != format!("{}|{}", expect.0, expect.1) {
        return Err(BackupError::restore_failed(format!("the restored database is at migration level {lvl}, expected {}|{}", expect.0, expect.1)));
    }
    if pg::sql_scalar(rx.exec, ctx, &conn, "SELECT has_function_privilege('supabase_auth_admin', 'pos_lockout.password_verification_hook(jsonb)', 'EXECUTE');", true)? != "t" {
        return Err(BackupError::restore_failed("the PIN lockout hook is missing or not executable by the sign-in service in the restored database"));
    }
    let caja = f.manifest.tables.iter().find(|t| t.name == "public.caja_sessions").map(|t| t.count);
    if let Some(expected) = caja {
        let claims = format!("{{\"sub\":\"{admin_id}\",\"role\":\"authenticated\"}}");
        let auth = pg::sql_script(
            rx.exec,
            ctx,
            &conn,
            &format!("BEGIN;\nSET LOCAL ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '{admin_id}', true);\nSELECT set_config('request.jwt.claims', '{claims}', true);\nSELECT 'AUTH:' || count(*) FROM public.caja_sessions;\nROLLBACK;\n"),
            rx.cap(Duration::from_secs(60), "checking staff access")?,
        )?;
        let seen: i64 = auth.lines().find_map(|l| l.strip_prefix("AUTH:")).and_then(|n| n.trim().parse().ok()).unwrap_or(-1);
        if seen != expected {
            return Err(BackupError::restore_failed(format!("a signed-in staff member would see {seen} caja sessions, the backup had {expected}")));
        }
        match pg::sql_script(rx.exec, ctx, &conn, "BEGIN;\nSET LOCAL ROLE anon;\nSELECT 'ANON:' || count(*) FROM public.caja_sessions;\nROLLBACK;\n", rx.cap(Duration::from_secs(60), "checking anonymous access")?) {
            Ok(o) if o.lines().any(|l| l.trim() == "ANON:0") => {}
            Err(e) if e.message.contains("permission denied") => {}
            Ok(_) => return Err(BackupError::restore_failed("an anonymous visitor could read caja sessions in the restored database")),
            Err(e) => return Err(e),
        }
    }
    Ok(json!({ "migrations": lvl, "rlsRead": caja.is_some(), "hook": true }))
}

/// `bucket/id` of every photo row, from the restored database.
pub fn photo_rows(ctx: &BackupCtx, rx: &Rx, db: &str) -> BResult<BTreeSet<String>> {
    let out = pg::sql_scalar(rx.exec, ctx, &admin_conn(ctx, db), pg::PHOTO_ROWS_SQL, true)?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

pub fn photo_report(rows: &BTreeSet<String>, files: &BTreeSet<String>) -> (Value, super::photos::Verdict) {
    let (dang, orphans) = super::photos::dangling(rows, files);
    let v = super::photos::verdict(rows.len(), dang.len());
    (json!({ "rows": rows.len(), "files": files.len(), "dangling": dang.len(), "danglingSample": dang.iter().take(20).collect::<Vec<_>>(), "orphans": orphans }), v)
}

/// `photo_report` against the live photos folder (after `merge_photos`).
pub fn photo_report_from_dir(rows: &BTreeSet<String>, photos: &Path) -> (Value, super::photos::Verdict) {
    photo_report(rows, &super::photos::list_dir(photos))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::dump::{self, DbInfo, Manifest};
    use crate::backup::fingerprint::TableFp;
    use crate::backup::pg::PsqlOpener;
    use crate::backup::util::fake::{rand_pin, temp_ctx, FakeExec};
    use crate::backup::util::iso_utc;
    use crate::envelope::Code;
    use std::rc::Rc;

    const NOW: i64 = 1_790_000_000;
    const STAGE: &str = "C:\\ProgramData\\SupermarketPOS\\backups\\tmp\\run-abc123\\stage\\current";
    const STAGE_SUB: &str = "/C/ProgramData/SupermarketPOS/backups/tmp/run-abc123/stage/current";
    const PHOTOS: &str = "C:\\ProgramData\\SupermarketPOS\\photos";
    const ADMIN: &str = "00000000-0000-4000-8000-000000000001";

    fn deps(e: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(e), opener: Box::new(PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }
    fn snaps(items: &[(&str, i64)]) -> String {
        let v: Vec<String> = items
            .iter()
            .map(|(id, t)| format!("{{\"id\":\"{id}\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"{}\",\"{}\"]}}", iso_utc(*t), STAGE.replace('\\', "\\\\"), PHOTOS.replace('\\', "\\\\")))
            .collect();
        format!("[{}]", v.join(","))
    }
    fn restic_snap(id: &str) -> Snap {
        crate::backup::restic::parse_snapshots(&snaps(&[(id, NOW - 60)])).unwrap().remove(0)
    }
    fn manifest(dir: &Path, tables: Vec<TableFp>) -> Manifest {
        std::fs::write(dir.join(dump::DUMP_FILE), b"dump").unwrap();
        std::fs::write(dir.join(dump::GLOBALS_FILE), b"globals").unwrap();
        let m = Manifest {
            schema: 1,
            taken_at: NOW - 100,
            reason: "hourly".into(),
            pack_version: "t".into(),
            database: DbInfo { name: "postgres".into(), owner: "postgres".into(), encoding: "UTF8".into(), provider: "i".into(), locale: "es-MX".into(), collate: "C".into(), ctype: "C".into(), collversion: "1".into(), bytes: 4096, settings: vec![] },
            migrations_count: 3,
            migrations_max: "20260930000001".into(),
            files: dump::file_entries(dir).unwrap(),
            tables,
            catalog: [("functions".to_string(), "aa".to_string())].into_iter().collect(),
            stage_subpath: "/C/x".into(),
            photos_subpath: Some("/C/p".into()),
            ..Default::default()
        };
        dump::write_manifest(dir, &m).unwrap();
        m
    }
    /// A fetched stage on disk (no guard: the temp folder owns it).
    fn fetched(c: &BackupCtx, tables: Vec<TableFp>) -> Fetched {
        let dir = c.paths.backups_tmp().join("fixture");
        std::fs::create_dir_all(&dir).unwrap();
        let m = manifest(&dir, tables);
        Fetched { snap: restic_snap("aaaa1111bbbb"), dir, manifest: m, photos_sub: Some("/C/ProgramData/SupermarketPOS/photos".into()), guard: None }
    }
    fn src(c: &BackupCtx) -> Source {
        resolve_source(c, None, None).unwrap()
    }

    #[test]
    fn latest_and_id_prefixes_resolve_and_short_or_unknown_ids_do_not() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(FakeExec::default().on("snapshots --json", 0, &snaps(&[("aaaa1111bbbb", NOW - 7200), ("cccc2222dddd", NOW - 60)])));
        let d = deps(e);
        let rx = Rx::new(&d);
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "latest").unwrap().id, "cccc2222dddd");
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "aaaa1111").unwrap().id, "aaaa1111bbbb");
        assert!(pick_snapshot(&c, &rx, &src(&c), "aaa").is_err());
        assert!(pick_snapshot(&c, &rx, &src(&c), "ffff9999").is_err());
        assert!(pick_snapshot(&c, &rx, &src(&c), "not-hex-at-all").is_err());
    }

    #[test]
    fn a_specific_id_finds_the_copy_in_a_destination_by_its_original_and_never_the_newest() {
        let (_d, c) = temp_ctx();
        // a destination's listing: restic copy gave the snapshot a NEW id and kept the source id in `original`
        let listing = format!(
            "[{{\"id\":\"99998888cccc\",\"original\":\"aaaa1111bbbb\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"{}\"]}},{{\"id\":\"77776666dddd\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"{}\"]}}]",
            iso_utc(NOW - 7200), STAGE.replace('\\', "\\\\"), iso_utc(NOW - 10), STAGE.replace('\\', "\\\\")
        );
        let d = deps(Rc::new(FakeExec::default().on("snapshots --json", 0, &listing)));
        let rx = Rx::new(&d);
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "aaaa1111").unwrap().id, "99998888cccc", "the source id names the copy, not the newest snapshot");
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "latest").unwrap().id, "77776666dddd");
    }

    #[test]
    fn a_repository_with_another_key_says_so_and_asks_for_the_recovery_key() {
        let (_d, c) = temp_ctx();
        let d = deps(Rc::new(FakeExec::default().on("snapshots --json", 12, "")));
        let err = pick_snapshot(&c, &Rx::new(&d), &src(&c), "latest").unwrap_err();
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("recovery key"));
    }

    #[test]
    fn without_a_local_repository_a_repo_and_key_are_required() {
        let (_d, c) = temp_ctx();
        std::fs::remove_file(c.paths.repo().join("config")).unwrap();
        assert_eq!(resolve_source(&c, None, None).err().unwrap().code, Code::Precondition);
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        let s = resolve_source(&c, Some(r"E:\SupermarketPOS-Backup"), Some(&rk)).unwrap();
        assert!(matches!(s.repo.password, crate::backup::restic::Password::Plain(_)));
        assert_eq!(resolve_source(&c, Some("E:\\x"), Some("nonsense")).err().unwrap().code, Code::Usage);
    }

    #[test]
    fn a_network_share_or_an_option_lookalike_is_not_a_repository() {
        let (_d, c) = temp_ctx();
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        for bad in [r"\\server\share\backup", "--option", "-r", "relative\\folder", ""] {
            assert_eq!(resolve_source(&c, Some(bad), Some(&rk)).err().unwrap().code, Code::Usage, "{bad:?}");
        }
        assert!(resolve_source(&c, Some("s3:https://x.example/bucket"), Some(&rk)).is_ok());
    }

    #[test]
    fn fetching_restores_the_stage_into_a_private_folder_and_checks_every_checksum() {
        let (_d, c) = temp_ctx();
        let snap = restic_snap("aaaa1111bbbb");
        let tmp = c.paths.backups_tmp();
        let e = Rc::new(FakeExec::default().on_with(&format!("restore aaaa1111bbbb:{STAGE_SUB}"), 0, "", move |args| {
            let t = args.iter().position(|a| a == "--target").unwrap();
            let dir = std::path::PathBuf::from(&args[t + 1]);
            assert!(dir.starts_with(&tmp), "the plaintext dump lands under backups\\tmp, in a private run folder: {dir:?}");
            assert!(dir.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("run-"));
            std::fs::create_dir_all(&dir).unwrap();
            manifest(&dir, vec![]);
        }));
        let d = deps(e);
        let f = fetch_stage(&c, &Rx::new(&d), &src(&c), &snap).unwrap();
        assert_eq!(f.manifest.migrations_max, "20260930000001");
        assert_eq!(f.photos_sub.as_deref(), Some("/C/ProgramData/SupermarketPOS/photos"));
        let kept = f.dir.clone();
        assert!(kept.exists());
        // tamper after the fact: the same bytes must now be refused
        std::fs::write(f.dir.join(dump::DUMP_FILE), b"tampered").unwrap();
        assert!(dump::verify_files(&f.dir, &f.manifest).is_err());
        drop(f);
        assert!(!kept.exists(), "dropping the fetched stage deletes the plaintext");
    }

    #[test]
    fn a_stage_that_fails_its_checksums_is_deleted_and_refused() {
        let (_d, c) = temp_ctx();
        let snap = restic_snap("aaaa1111bbbb");
        let e = Rc::new(FakeExec::default().on_with("restore aaaa1111bbbb:", 0, "", |args| {
            let t = args.iter().position(|a| a == "--target").unwrap();
            let dir = std::path::PathBuf::from(&args[t + 1]);
            std::fs::create_dir_all(&dir).unwrap();
            manifest(&dir, vec![]);
            std::fs::write(dir.join(dump::DUMP_FILE), b"tampered!").unwrap();
        }));
        let d = deps(e);
        let err = fetch_stage(&c, &Rx::new(&d), &src(&c), &snap).unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        let left: Vec<_> = std::fs::read_dir(c.paths.backups_tmp()).unwrap().flatten().filter(|x| x.file_name().to_string_lossy().starts_with("run-")).collect();
        assert!(left.is_empty(), "no plaintext left behind: {left:?}");
    }

    #[test]
    fn latest_skips_a_pre_restore_snapshot_but_its_id_still_restores_it() {
        let (_d, c) = temp_ctx();
        // the newest snapshot is the one taken of the damaged live database before a restore
        let mut v: Vec<serde_json::Value> = serde_json::from_str(&snaps(&[("aaaa1111bbbb", NOW - 7200), ("cccc2222dddd", NOW - 3600), ("eeee3333ffff", NOW - 60)])).unwrap();
        v[2]["tags"] = serde_json::json!(["posctl", "reason:pre-restore"]);
        v[1]["tags"] = serde_json::json!(["posctl", "reason:pre-update"]);
        let e = Rc::new(FakeExec::default().on("snapshots --json", 0, &serde_json::to_string(&v).unwrap()));
        let d = deps(e);
        let rx = Rx::new(&d);
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "latest").unwrap().id, "cccc2222dddd", "pre-update stays eligible, pre-restore does not");
        assert_eq!(pick_snapshot(&c, &rx, &src(&c), "eeee3333").unwrap().id, "eeee3333ffff", "an explicit id is an undo");
    }

    #[cfg(windows)]
    #[test]
    fn photos_are_not_restored_through_a_junction_inside_the_photos_folder() {
        let (_d, c) = temp_ctx();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(c.paths.photos()).unwrap();
        let link = c.paths.photos().join("planted");
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &outside.path().display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let e = Rc::new(FakeExec::default());
        let f = Fetched { snap: restic_snap("aaaa1111bbbb"), dir: c.paths.backups_tmp().join("x"), manifest: Manifest::default(), photos_sub: Some("/C/ProgramData/SupermarketPOS/photos".into()), guard: None };
        let d = deps(e.clone());
        let err = merge_photos(&c, &Rx::new(&d), &src(&c), &f).unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        assert!(!e.calls.borrow().iter().any(|l| l.contains(" restore ")), "restic must not run");
    }

    #[cfg(windows)]
    #[test]
    fn photos_are_not_restored_over_a_hard_linked_file() {
        let (_d, c) = temp_ctx();
        std::fs::create_dir_all(c.paths.photos().join("sub")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("target.bin"), b"secret").unwrap();
        std::fs::hard_link(outside.path().join("target.bin"), c.paths.photos().join("sub").join("a.jpg")).unwrap();
        let e = Rc::new(FakeExec::default());
        let f = Fetched { snap: restic_snap("aaaa1111bbbb"), dir: c.paths.backups_tmp().join("x"), manifest: Manifest::default(), photos_sub: Some("/C/ProgramData/SupermarketPOS/photos".into()), guard: None };
        let d = deps(e.clone());
        let err = merge_photos(&c, &Rx::new(&d), &src(&c), &f).unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        assert!(!e.calls.borrow().iter().any(|l| l.contains(" restore ")), "restic must not run");
    }

    #[test]
    fn photos_are_merged_into_the_live_folder_without_deleting_anything() {
        let (_d, c) = temp_ctx();
        let e = Rc::new(FakeExec::default());
        let f = Fetched { snap: restic_snap("aaaa1111bbbb"), dir: c.paths.backups_tmp().join("x"), manifest: Manifest::default(), photos_sub: Some("/C/ProgramData/SupermarketPOS/photos".into()), guard: None };
        let d = deps(e.clone());
        merge_photos(&c, &Rx::new(&d), &src(&c), &f).unwrap();
        let line = e.calls.borrow().iter().find(|l| l.contains("restore aaaa1111bbbb:/C/ProgramData/SupermarketPOS/photos")).cloned().unwrap();
        assert!(line.contains("--overwrite if-changed") && line.contains(&c.paths.photos().to_string_lossy().to_string()));
        assert!(!line.contains("--delete"));
    }

    #[test]
    fn the_target_is_created_from_the_manifest_locale_restored_with_exit_on_error_and_analysed() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let e = Rc::new(FakeExec::default());
        let d = deps(e.clone());
        create_and_load(&c, &Rx::new(&d), &f, "pos_next").unwrap();
        let calls = e.calls.borrow().clone();
        let create = calls.iter().position(|l| l.contains("CREATE DATABASE \"pos_next\" TEMPLATE template0")).unwrap();
        let restore = calls.iter().position(|l| l.starts_with("pg_restore.exe")).unwrap();
        let analyze = calls.iter().position(|l| l.contains("ANALYZE;")).unwrap();
        assert!(create < restore && restore < analyze);
        assert!(calls[restore].contains("--exit-on-error") && calls[restore].contains("-d pos_next") && calls[restore].contains("-U supabase_admin"));
        assert!(!calls.iter().any(|l| l.contains("-d postgres") && l.starts_with("pg_restore.exe")), "never restore into the live database");
        assert!(!calls[restore].contains("globals"), "globals are never replayed");
        assert!(!calls.iter().any(|l| l.contains(dump::GLOBALS_FILE)));
    }

    #[test]
    fn a_restore_can_only_create_the_clone_or_a_drill_database() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let e = Rc::new(FakeExec::default());
        let d = deps(e.clone());
        for bad in ["postgres", "template0", "template1", "pos_drill_x", "pos_next; DROP DATABASE postgres", "\"pos_next\""] {
            assert!(create_and_load(&c, &Rx::new(&d), &f, bad).is_err(), "{bad}");
            assert!(drop_database(&c, &Rx::new(&d), bad).is_err(), "{bad}");
        }
        assert!(e.calls.borrow().is_empty(), "a refused name runs nothing");
        create_and_load(&c, &Rx::new(&d), &f, "pos_drill_20261022010203").unwrap();
    }

    #[test]
    fn a_failed_pg_restore_drops_the_half_built_database_and_fails() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let e = Rc::new(FakeExec::default().on("pg_restore.exe", 1, ""));
        let d = deps(e.clone());
        let err = create_and_load(&c, &Rx::new(&d), &f, "pos_next").unwrap_err();
        assert_eq!((err.code, err.exit()), (Code::RestoreFailed, 31));
        assert!(e.count_of("DROP DATABASE IF EXISTS \"pos_next\" WITH (FORCE)") >= 2, "dropped before creating and again after the failure");
    }

    #[test]
    fn a_pg_restore_failure_never_carries_row_data_from_the_dump() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let pin = rand_pin();
        let stderr = format!("pg_restore: error: could not execute query: ERROR:  duplicate key value violates unique constraint \"profiles_pkey\"\nDETAIL:  Failing row contains ({ADMIN}, admin, {pin}).\nCommand was: COPY public.profiles (id, role, pin) FROM stdin;\n");
        let e = Rc::new(FakeExec::default().on_stderr("pg_restore.exe", 1, &stderr));
        let d = deps(e);
        let err = create_and_load(&c, &Rx::new(&d), &f, "pos_next").unwrap_err();
        assert!(!err.message.contains(&pin) && !err.message.contains("DETAIL") && !err.message.contains("COPY"), "{}", err.message);
        assert!(err.message.contains("pg_restore"), "{}", err.message);
    }

    #[test]
    fn quoted_values_in_a_pg_restore_error_are_redacted_but_the_error_text_stays() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let stderr = "pg_restore: error: could not execute query: ERROR:  invalid input value for enum user_role: \"owner@shop.example\" near 'Maria Lopez'\nDETAIL:  x\n";
        let d = deps(Rc::new(FakeExec::default().on_stderr("pg_restore.exe", 1, stderr)));
        let err = create_and_load(&c, &Rx::new(&d), &f, "pos_next").unwrap_err();
        assert!(!err.message.contains("owner@shop") && !err.message.contains("Maria") && !err.message.contains("Lopez"), "{}", err.message);
        assert!(err.message.contains("invalid input value for enum user_role"), "{}", err.message);
        assert!(err.message.contains("\"…\""), "{}", err.message);
    }

    #[test]
    fn a_drill_database_gets_no_replicated_grants_only_a_revoke_from_public() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![]);
        let e = Rc::new(FakeExec::default());
        let d = deps(e.clone());
        create_and_load(&c, &Rx::new(&d), &f, "pos_drill_20261022010203").unwrap();
        assert!(e.calls.borrow().iter().all(|l| !l.contains("aclexplode")), "no replicated grants for a scratch database");
        assert!(e.index_of("REVOKE ALL ON DATABASE \"pos_drill_20261022010203\" FROM PUBLIC;").is_some());
        let e2 = Rc::new(FakeExec::default());
        let d2 = deps(e2.clone());
        create_and_load(&c, &Rx::new(&d2), &f, "pos_next").unwrap();
        assert!(e2.index_of("aclexplode").is_some(), "the clone still gets the live database's grants");
        assert!(e2.index_of("REVOKE ALL ON DATABASE \"pos_next\" FROM PUBLIC;").is_none());
    }

    #[test]
    fn content_verification_names_the_table_that_does_not_match() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![TableFp { name: "public.items".into(), count: 3, hash: "123".into() }]);
        let good = deps(Rc::new(FakeExec::default().on("ONLY %s __fp_row", 0, "public.items|3|123\n").on("pg_default_acl", 0, "functions|aa\n")));
        verify_content(&c, &Rx::new(&good), &f, "pos_next").unwrap();
        let bad = deps(Rc::new(FakeExec::default().on("ONLY %s __fp_row", 0, "public.items|3|999\n").on("pg_default_acl", 0, "functions|aa\n")));
        let err = verify_content(&c, &Rx::new(&bad), &f, "pos_next").unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        assert!(err.message.contains("public.items"));
        let lost_grant = deps(Rc::new(FakeExec::default().on("ONLY %s __fp_row", 0, "public.items|3|123\n").on("pg_default_acl", 0, "functions|zz\n")));
        assert!(verify_content(&c, &Rx::new(&lost_grant), &f, "pos_next").unwrap_err().message.contains("functions"));
    }

    fn structure_fake(level: &str, hook: &str, auth: &str, anon: &str) -> Rc<FakeExec> {
        Rc::new(
            FakeExec::default()
                .on("FROM supabase_migrations.schema_migrations", 0, level)
                .on("has_function_privilege", 0, hook)
                .on("AUTH:", 0, auth)
                .on("ANON:", 0, anon),
        )
    }

    #[test]
    fn structure_checks_the_level_the_hook_and_what_each_role_can_read() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![TableFp { name: "public.caja_sessions".into(), count: 1, hash: "5".into() }]);
        let ok = deps(structure_fake("3|20260930000001\n", "t\n", "AUTH:1\n", "ANON:0\n"));
        let out = verify_structure(&c, &Rx::new(&ok), &f, "pos_next", ADMIN, (3, "20260930000001")).unwrap();
        assert_eq!(out["hook"], true);
        let wrong_level = deps(structure_fake("2|20260927000004\n", "t\n", "AUTH:1\n", "ANON:0\n"));
        assert!(verify_structure(&c, &Rx::new(&wrong_level), &f, "pos_next", ADMIN, (3, "20260930000001")).unwrap_err().message.contains("migration level"));
        let no_hook = deps(structure_fake("3|20260930000001\n", "f\n", "AUTH:1\n", "ANON:0\n"));
        assert!(verify_structure(&c, &Rx::new(&no_hook), &f, "pos_next", ADMIN, (3, "20260930000001")).unwrap_err().message.contains("lockout hook"));
        let blind = deps(structure_fake("3|20260930000001\n", "t\n", "AUTH:0\n", "ANON:0\n"));
        assert!(verify_structure(&c, &Rx::new(&blind), &f, "pos_next", ADMIN, (3, "20260930000001")).unwrap_err().message.contains("would see 0 caja sessions"));
        let leaky = deps(structure_fake("3|20260930000001\n", "t\n", "AUTH:1\n", "ANON:1\n"));
        assert!(verify_structure(&c, &Rx::new(&leaky), &f, "pos_next", ADMIN, (3, "20260930000001")).unwrap_err().message.contains("anonymous"));
    }

    #[test]
    fn the_rls_probe_only_trusts_a_uuid() {
        let (_d, c) = temp_ctx();
        let f = fetched(&c, vec![TableFp { name: "public.caja_sessions".into(), count: 1, hash: "5".into() }]);
        let e = structure_fake("3|20260930000001\n", "t\n", "AUTH:1\n", "ANON:0\n");
        let d = deps(e.clone());
        assert!(verify_structure(&c, &Rx::new(&d), &f, "pos_next", "x'; DROP TABLE y; --", (3, "20260930000001")).is_err());
        assert!(e.calls.borrow().iter().all(|l| !l.contains("DROP TABLE")));
    }

    #[test]
    fn photo_rows_and_the_directory_report_agree_on_what_is_missing() {
        let (_d, c) = temp_ctx();
        let d = deps(Rc::new(FakeExec::default().on("storage.objects", 0, "product-photos/aaa\nproduct-photos/bbb\n")));
        let rows = photo_rows(&c, &Rx::new(&d), "pos_next").unwrap();
        assert_eq!(rows.len(), 2);
        std::fs::create_dir_all(c.paths.photos().join("product-photos")).unwrap();
        std::fs::write(c.paths.photos().join("product-photos").join("aaa"), b"x").unwrap();
        let (rep, v) = photo_report_from_dir(&rows, &c.paths.photos());
        assert_eq!((rep["rows"].as_u64(), rep["dangling"].as_u64()), (Some(2), Some(1)));
        assert_eq!(v, crate::backup::photos::Verdict::Warn);
    }

    #[test]
    fn the_budget_caps_every_child_and_runs_out_with_a_clear_message() {
        let d = deps(Rc::new(FakeExec::default()));
        let mut rx = Rx::new(&d);
        assert_eq!(rx.cap(std::time::Duration::from_secs(600), "a step").unwrap(), std::time::Duration::from_secs(600));
        rx.deadline = Some(NOW + 100);
        assert_eq!(rx.cap(std::time::Duration::from_secs(600), "a step").unwrap(), std::time::Duration::from_secs(100));
        assert_eq!(rx.cap(std::time::Duration::from_secs(30), "a step").unwrap(), std::time::Duration::from_secs(30));
        rx.deadline = Some(NOW);
        let err = rx.cap(std::time::Duration::from_secs(600), "restoring").unwrap_err();
        assert!(err.message.contains("budget") && err.message.contains("restoring"), "{}", err.message);
    }
}
