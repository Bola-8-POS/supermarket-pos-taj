//! `backup restore --snapshot <id|latest> --swap` as an `OpWork` run by Plan 07's runner (`ops::runner::run_operation`):
//! the fence, the `PreRestore` backup (best effort), the clone, the swap, `verify_live`, the reopen and the rollback are
//! the runner's; what is restore-specific is only here.
//!
//! * `update.lock` is held EXCLUSIVE by `run_restore` from before the fetch to after the swap. The fetched plaintext
//!   (`profiles.pin`, invariant 3) lives in a per-run `PrivateDir` owned by `Fetched`, which lives in the work object,
//!   which is declared after the lock guard: it is deleted on every exit path before the lock is released, and
//!   nothing sweeps `run-*` folders while this process holds the lock (`LockPolicy::CallerHoldsExclusive`).
//! * A pending update/switch/restore journal (or a leftover fence) refuses the restore with `RECOVERY_NEEDED` (17)
//!   before anything is fetched or touched: `create_and_load` drops `pos_next` and the migration wipes
//!   `DATA\work\supabase\migrations`, which a half-done operation may still need.
//! * The recovery key comes from the caller (stdin, Task 11), goes to restic through its environment only
//!   (`Password::Plain`) and is never logged or journaled.
//! * An older snapshot is migrated forward with Plan 07's own sequence (`UpdateWork::migrate_restored`).
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::ctx::BackupCtx;
use super::migrate::{self, Relation};
use super::photos::Verdict;
use super::plan08_backup::ctx_from_env;
use super::pg::{ident, literal};
use super::restore::{self, Fetched, Rx, Source};
use super::state::{BackupState, LastRestore};
use super::result::{BResult, BackupError};
use super::run::{admin_conn, run_backup, Deps, LockPolicy, Reason, RunOptions};
use super::util::{hex, random_bytes};
use crate::envelope::{Code, PosctlError};
use crate::ops::journal::Journal;
use crate::ops::lock::{acquire_for, LockMode};
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::world::{BackupReason, OpCtx, OpWork, World, R};
use crate::update::Env;

/// The post-restore backup runs while the tills are still fenced (the runner calls `on_commit` before it reopens), so it is
/// bounded; if it does not finish in this time the caller takes it again after the store has reopened.
pub const POST_RESTORE_BACKUP_CAP_SECS: i64 = 600;
/// How long a restore waits for a running backup (shared holder) before it gives up with `LOCK_HELD`.
#[cfg(not(test))]
const LOCK_WAIT: Duration = Duration::from_secs(120);
#[cfg(test)]
const LOCK_WAIT: Duration = Duration::from_millis(300);

fn rf(msg: impl Into<String>) -> OpError {
    OpError::new(OpCode::Error, "RESTORE_FAILED", msg)
}
fn vf(msg: impl Into<String>) -> OpError {
    OpError::new(OpCode::VerifyFailedRolledBack, "VERIFY_FAILED", msg)
}
fn be(e: BackupError) -> OpError {
    let code = if e.code == Code::Precondition { OpCode::Precondition } else { OpCode::Error };
    OpError::new(code, "RESTORE_FAILED", e.message)
}

/// Every failure of a restore is a nonzero `BackupError`: 10 lock, 12 precondition, 17 recovery needed, 2 usage, else 31.
pub fn map_op_error(e: OpError) -> BackupError {
    let rolled_back = matches!(e.code, OpCode::RolledBack | OpCode::VerifyFailedRolledBack | OpCode::MigrationFailed);
    match e.code {
        OpCode::LockHeld => BackupError::lock_held(),
        OpCode::Precondition => BackupError::precondition(e.message),
        OpCode::RecoveryNeeded => BackupError::recovery_needed(format!("{}: {}", e.reason, e.message)),
        OpCode::Usage => BackupError::usage(e.message),
        _ if rolled_back => BackupError::restore_failed(format!("{}: {} (the store was rolled back to how it was)", e.reason, e.message)),
        _ => BackupError::restore_failed(format!("{}: {}", e.reason, e.message)),
    }
}

/// Inputs a recovering process needs. No key, no password, no PIN: the journal is readable by operators.
pub fn restore_journal_extra(snapshot: &str, expect_count: i64, expect_max: &str, source: &str) -> Value {
    json!({ "snapshot": snapshot, "expectCount": expect_count, "expectMax": expect_max, "source": source })
}

#[cfg(test)]
type MigrateFn = Box<dyn Fn(&OpCtx) -> R<()>>;
#[cfg(test)]
type CanaryFn = Box<dyn Fn() -> Result<(), PosctlError>>;
#[cfg(test)]
type BackupFn = Box<dyn Fn(&RunOptions) -> BResult<()>>;
/// Builds the operation's world for a pack (production: Plan 07's `RealDeps::world`; tests: a world made of data).
pub type MakeWorld<'a> = dyn Fn(&Env, &str) -> R<Box<dyn World>> + 'a;

pub struct RestoreWork {
    env: Env,
    ctx: BackupCtx,
    deps: Deps,
    /// The operation deadline cell shared with the world's psql wrapper (`UpdateWork` arms it from every `OpCtx`).
    deadline: Arc<AtomicU64>,
    stage: Option<(Source, Fetched)>,
    /// The installed pack's schema level `(count, max)`: what the restored database must be at after the work.
    expect: (i64, String),
    admin_id: Option<String>,
    /// `127.0.0.1:<internal listener>`
    internal: String,
    pub photo_report: Option<Value>,
    pub rederive_report: Option<Value>,
    pub migrated_forward: bool,
    /// The post-restore backup of `on_commit` completed (otherwise the caller takes it after the reopen).
    pub post_backup_done: bool,
    warnings: Vec<String>,
    #[cfg(test)]
    migrate_fn: Option<MigrateFn>,
    #[cfg(test)]
    canary_fn: Option<CanaryFn>,
    #[cfg(test)]
    backup_fn: Option<BackupFn>,
}

impl RestoreWork {
    pub fn new(env: Env, ctx: BackupCtx, deps: Deps, deadline: Arc<AtomicU64>, stage: Option<(Source, Fetched)>, expect: (i64, String)) -> Self {
        let internal = format!("127.0.0.1:{}", env.ports.gateway_internal());
        Self {
            env, ctx, deps, deadline, stage, expect, admin_id: None, internal, photo_report: None, rederive_report: None, migrated_forward: false,
            post_backup_done: false, warnings: vec![],
            #[cfg(test)] migrate_fn: None,
            #[cfg(test)] canary_fn: None,
            #[cfg(test)] backup_fn: None,
        }
    }

    /// Recovery path (`update --recover` -> `commands::update::work_for`): the backup files are not needed to roll back or to
    /// finish after the swap, only what the journal recorded.
    pub fn from_journal(j: &Journal, env: &Env) -> R<Self> {
        let jr = |m: &str| OpError::new(OpCode::RecoveryNeeded, "JOURNAL_INCOMPLETE", m);
        let count = j.extra["expectCount"].as_i64().ok_or_else(|| jr("the restore journal has no expectCount"))?;
        let max = j.extra["expectMax"].as_str().ok_or_else(|| jr("the restore journal has no expectMax"))?.to_string();
        let pack = j.pack_to.clone().or_else(|| j.pack_from.clone()).ok_or_else(|| jr("the restore journal names no pack"))?;
        Ok(Self::new(env.clone(), ctx_from_env(env, &pack), Deps::real(), Arc::new(AtomicU64::new(u64::MAX)), None, (count, max)))
    }

    fn keys(&self) -> R<(String, String)> {
        let t = std::fs::read(self.env.secrets().join("keys.json")).map_err(|e| vf(format!("keys.json unreadable: {e}")))?;
        let v: Value = serde_json::from_slice(&t).map_err(|e| vf(format!("keys.json invalid: {e}")))?;
        let get = |k: &str| v.get(k).and_then(Value::as_str).map(String::from).ok_or_else(|| vf(format!("keys.json has no {k}")));
        Ok((get("anon")?, get("service_role")?))
    }

    /// Plan 07's migration sequence on the restored clone: the update's own steps (the pack's every-update SQL, GoTrue's migrate
    /// when the restored level trails, `db push`) through a synthetic update journal that names the running pack as both sides.
    fn migrate(&self, c: &OpCtx) -> R<()> {
        #[cfg(test)]
        if let Some(f) = &self.migrate_fn {
            return f(c);
        }
        let pack = self.ctx.pack_version.clone();
        let j = Journal::new(OpKind::Update, &c.op_id, 0, 0, Some(pack.clone()), Some(pack));
        let mut w = crate::update::work::UpdateWork::from_journal_with(&j, &self.env, self.deadline.clone())?;
        w.migrate_restored(c)
    }

    /// The lockout canary on the restored database, in process (a `health --canary` child would find the journal open and the
    /// lock held, exactly as for an update).
    fn canary(&self) -> Result<(), PosctlError> {
        #[cfg(test)]
        if let Some(f) = &self.canary_fn {
            return f();
        }
        let (anon, svc) = self.keys().map_err(|e| PosctlError::new(Code::Unhealthy, e.message))?;
        let psql = crate::pg::Psql { tools: crate::pg::PgTools::for_pack(&self.ctx.pack_dir), port: self.env.ports.pg(), pgpass: self.env.roots.pgpass() };
        let ep = crate::firstadmin::Endpoint { internal_url: format!("http://127.0.0.1:{}", self.env.ports.gateway_internal()), anon_key: crate::util::Secret(anon), service_key: crate::util::Secret(svc) };
        crate::canary::run_for_update(&self.env.roots, &self.env.ports, &psql, &ep, Duration::from_secs(120))
    }

    /// A reason code that reaches the result JSON (once, however often `on_commit` is entered).
    fn warn(&mut self, code: &str) {
        if !self.warnings.iter().any(|w| w == code) {
            self.warnings.push(code.to_string());
        }
    }

    /// The safety copy (`pos_prev_restore_<stamp>`) still holds the OLD store, `profiles.pin` included, and the swap kept its
    /// original database ACL (PUBLIC may connect). Close it to PUBLIC and to every non-owner grantee; the owner keeps access.
    /// Best effort: a failure is a warning. Plan 07's `pos_prev_update_*` / `pos_prev_switch_*` are a ledgered follow-up.
    pub(crate) fn close_previous_copy(&mut self, prev: &str) {
        if !is_restore_copy(prev) {
            return;
        }
        let script = format!(
            "REVOKE CONNECT ON DATABASE {} FROM PUBLIC;\nSELECT format('REVOKE CONNECT ON DATABASE %I FROM %I', d.datname, pg_get_userbyid(a.grantee)) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = {} AND a.privilege_type = 'CONNECT' AND a.grantee <> d.datdba AND a.grantee <> 0\n\\gexec\n",
            ident(prev),
            literal(prev)
        );
        if super::pg::sql_script(&*self.deps.exec, &self.ctx, &admin_conn(&self.ctx, "postgres"), &script, Duration::from_secs(60)).is_err() {
            self.warn("PREV_COPY_REVOKE_FAILED");
        }
    }

    /// The canary said the PIN lockout is NOT working: record it where `health` reads it, so status raises the alert now, not at
    /// the next daily canary. (A canary that merely could not be judged records nothing: it is no evidence about the hook.)
    fn record_failed_canary(&self) {
        let p = self.env.roots.canary_json();
        let mut v = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
        v["lastRunAt"] = json!(crate::util::rfc3339_utc((self.deps.now)().max(0) as u64));
        v["lastOk"] = json!(false);
        if let Ok(t) = serde_json::to_string_pretty(&v) {
            let _ = crate::util::write_atomic(&p, t.as_bytes());
        }
    }

    fn backup(&self, o: &RunOptions) -> BResult<()> {
        #[cfg(test)]
        if let Some(f) = &self.backup_fn {
            return f(o);
        }
        run_backup(&self.ctx, &self.deps, o).map(|_| ())
    }
}

impl OpWork for RestoreWork {
    fn kind(&self) -> OpKind {
        OpKind::Restore
    }
    fn backup_reason(&self) -> BackupReason {
        BackupReason::PreRestore
    }
    fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }

    fn needs_clone(&self) -> bool { false } // `create_and_load` makes pos_next from the dump; a template copy of the live database would be thrown away
    fn work_on_clone(&mut self, c: &OpCtx) -> R<()> {
        // refuse a snapshot the installed software cannot run before anything is created (the manifest is in the fetched stage)
        let relation = {
            let (_, f) = self.stage.as_ref().ok_or_else(|| rf("this process does not hold the fetched backup; start the restore again"))?;
            migrate::relation(&f.manifest.migrations_max, f.manifest.migrations_count, &self.expect.1, self.expect.0)
        };
        if relation == Relation::Newer {
            return Err(OpError::new(OpCode::Precondition, "RESTORE_FAILED", "this backup was made by a newer version of the software than the one installed; update first"));
        }
        let db = c.names.next.clone();
        {
            let (_, f) = self.stage.as_ref().ok_or_else(|| rf("no fetched backup"))?;
            let rx = Rx::new(&self.deps);
            restore::create_and_load(&self.ctx, &rx, f, &db).map_err(be)?;
            // before migrating and before re-deriving: both change what is fingerprinted
            restore::verify_content(&self.ctx, &rx, f, &db).map_err(be)?;
        }
        if relation == Relation::Older {
            self.migrate(c)?;
            self.migrated_forward = true;
        }
        let rx = Rx::new(&self.deps);
        self.rederive_report = Some(super::rederive::run(&self.ctx, &rx, &db).map_err(be)?);
        self.admin_id = Some(super::rederive::admin_credential_check(&self.ctx, &rx, &db).map_err(be)?);
        Ok(())
    }

    fn verify_clone(&mut self, c: &OpCtx) -> R<()> {
        let (src, f) = self.stage.as_ref().ok_or_else(|| rf("no fetched backup"))?;
        let admin = self.admin_id.clone().ok_or_else(|| rf("the admin check did not run"))?;
        let rx = Rx::new(&self.deps);
        restore::verify_structure(&self.ctx, &rx, f, &c.names.next, &admin, (self.expect.0, &self.expect.1)).map_err(be)?;
        // Photos are added (never deleted) only now that the database has proven itself: a restore that fails earlier leaves the
        // live photo folder exactly as it was.
        restore::merge_photos(&self.ctx, &rx, src, f).map_err(be)?;
        let rows = restore::photo_rows(&self.ctx, &rx, &c.names.next).map_err(be)?;
        let (report, verdict) = restore::photo_report_from_dir(&rows, &self.ctx.paths.photos());
        self.photo_report = Some(report.clone());
        match verdict {
            Verdict::Fail => return Err(rf(format!("photos are missing after the restore: {report}"))),
            Verdict::Warn => self.warnings.push("PHOTOS_SOME_MISSING".into()),
            Verdict::Ok => {}
        }
        Ok(())
    }

    /// Services are up on the INTERNAL listener, the LAN is still in maintenance. Reads and one sign-in only: no sale.
    fn verify_live(&mut self, _c: &OpCtx) -> R<()> {
        let (anon, service) = self.keys()?;
        let t = Duration::from_secs(10);
        let (s, body) = crate::ops::probe::http_get(&self.internal, "/rest/v1/store_schema_version?select=max_version,applied", &[("apikey", &anon)], t)?;
        let rows: Vec<Value> = serde_json::from_str(&body).unwrap_or_default();
        let level_ok = s == 200 && rows.len() == 1 && rows[0]["max_version"].as_str() == Some(self.expect.1.as_str()) && rows[0]["applied"].as_i64() == Some(self.expect.0);
        if !level_ok {
            return Err(vf(format!("the schema-version view answered {s}: {}", body.chars().take(120).collect::<String>())));
        }
        let bearer = format!("Bearer {service}");
        let (rs, _) = crate::ops::probe::http_get(&self.internal, "/rest/v1/profiles?select=id&limit=1", &[("apikey", &service), ("Authorization", &bearer)], t)?;
        if rs != 200 {
            return Err(vf(format!("a service-role read answered {rs}")));
        }
        let rx = Rx::new(&self.deps);
        let (id, pw) = super::rederive::admin_login(&self.ctx, &rx, "postgres").map_err(|e| vf(e.message))?;
        let payload = json!({ "email": crate::firstadmin::staff_email(&id), "password": pw }).to_string();
        let (gs, gb) = http_post_json(&self.internal, "/auth/v1/token?grant_type=password", &[("apikey", &anon)], &payload, t)?;
        if gs != 200 || !gb.contains("access_token") {
            return Err(vf(format!("the admin could not sign in to the restored store (status {gs})")));
        }
        // best effort: do not leave the probe's session behind
        let token = serde_json::from_str::<Value>(&gb).ok().and_then(|v| v["access_token"].as_str().map(String::from)).unwrap_or_default();
        let bearer = format!("Bearer {token}");
        match http_post_json(&self.internal, "/auth/v1/logout", &[("apikey", &anon), ("Authorization", &bearer)], "{}", t) {
            Ok((st, _)) if (200..300).contains(&st) => {}
            _ => self.warn("PROBE_LOGOUT_FAILED"),
        }
        Ok(())
    }

    fn verify_after_rollback(&mut self, _c: &OpCtx) -> R<()> {
        super::pg::sql_scalar(&*self.deps.exec, &self.ctx, &admin_conn(&self.ctx, "postgres"), "SELECT 1;", true)
            .map(|_| ())
            .map_err(|e| OpError::err("ROLLBACK_VERIFY", e.message))
    }

    /// After the point of no return, idempotent, never fails the restore: one more backup of the restored state (so `latest` is
    /// the restored database, not the damaged one the `PreRestore` snapshot holds), then the lockout canary on a fresh account.
    fn on_commit(&mut self, c: &OpCtx) -> R<()> {
        self.close_previous_copy(&c.names.prev);
        let now = (self.deps.now)();
        let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: Some(now.saturating_add(POST_RESTORE_BACKUP_CAP_SECS)) };
        match self.backup(&opts) {
            Ok(()) => self.post_backup_done = true,
            Err(e) => {
                eprintln!("{{\"warn\":\"POST_RESTORE_BACKUP_FAILED\",\"message\":{}}}", serde_json::to_string(&e.message).unwrap_or_default());
                self.warn("POST_RESTORE_BACKUP_FAILED");
                // Not finished while the tills were fenced: the next scheduled tick takes it (also when a recovery got here), never a
                // multi-hour copy under the exclusive lock.
                if let Ok(mut st) = BackupState::load_in(&self.ctx.paths, now) {
                    st.backup_due_now = true;
                    let _ = st.save_in(&self.ctx);
                }
            }
        }
        // C7 (conventions v1.6): the restored database holds the OLD PC's canary account (or none). The record goes FIRST so the
        // canary creates a fresh account on this database; `canary::run_for_update` also repairs a record whose account is gone.
        let _ = std::fs::remove_file(self.env.roots.canary_json());
        if let Err(e) = self.canary() {
            eprintln!("{{\"warn\":\"CANARY_AFTER_RESTORE\",\"message\":{}}}", serde_json::to_string(&e.message).unwrap_or_default());
            self.warn("CANARY_AFTER_RESTORE");
            if e.code == Code::CanaryFailed {
                self.record_failed_canary();
            }
        }
        Ok(())
    }
}

/// `pos_prev_restore_<14 digits>`: the only name `close_previous_copy` ever revokes on.
fn is_restore_copy(name: &str) -> bool {
    name.strip_prefix("pos_prev_restore_").is_some_and(|d| d.len() == 14 && d.bytes().all(|b| b.is_ascii_digit()))
}

/// Best effort: a failed write of the record never changes the outcome of the restore.
pub fn record_restore(ctx: &BackupCtx, now: i64, snapshot: &str, result: &str, reason: Option<&str>) {
    record_restore_with(ctx, now, snapshot, result, reason, &[])
}

/// `record_restore` plus the warning codes the restore ended with (shown by status.backup; codes only, anything else is dropped).
pub fn record_restore_with(ctx: &BackupCtx, now: i64, snapshot: &str, result: &str, reason: Option<&str>, warnings: &[String]) {
    let warnings: Vec<String> = warnings.iter().filter(|w| !w.is_empty() && w.len() <= 48 && w.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')).cloned().collect();
    let snapshot = if snapshot.bytes().all(|b| b.is_ascii_hexdigit()) { snapshot } else { "" };
    if let Ok(mut st) = BackupState::load_in(&ctx.paths, now) {
        st.last_restore = Some(LastRestore { at: now, result: result.to_string(), reason: reason.map(String::from), snapshot: snapshot.to_string(), warnings });
        let _ = st.save_in(ctx);
    }
}

/// After `update --recover` has finished or undone a killed restore (the database is already back in service): the decrypted dump it left
/// (backups\tmp\run-*\stage, backups\restore) is zero-filled and deleted. The caller holds `update.lock` exclusively (a restore holds it
/// exclusively, a backup run or drill shared), so every `run-*` folder is dead. A failure never fails the recovery: the scratch stays for
/// the next run-start sweep or restore-start scrub, and the caller shows the fixed code `RECOVERY_SCRATCH_LEFT`. True when scratch is left.
pub fn scrub_after_recovery(env: &Env, j: &Journal) -> bool {
    let pack = j.pack_to.clone().or_else(|| j.pack_from.clone()).unwrap_or_default();
    super::acl::scrub_scratch(&ctx_from_env(env, &pack)).is_err()
}

/// A restore that `update --recover` finished or undid: recorded as a restore, never as an update event.
pub fn record_recovered(env: &Env, j: &Journal, rolled_back: Option<&str>, now: i64) {
    let Some(pack) = j.pack_to.clone().or_else(|| j.pack_from.clone()) else { return };
    let snap = j.extra["snapshot"].as_str().unwrap_or("");
    let left = scrub_after_recovery(env, j);
    let warnings: Vec<String> = if left { vec![SCRATCH_LEFT.to_string()] } else { vec![] };
    if left {
        // a fixed line, no path and no content: the run log is the whitelisted place for it
        let at = crate::util::rfc3339_utc(now.max(0) as u64);
        super::runlog::write(&env.roots, "update recover", &at, SCRATCH_LEFT, "a recovered restore left scratch files that could not be removed; the next backup or restore retries", &serde_json::Value::Null);
    }
    record_restore_with(&ctx_from_env(env, &pack), now, snap, if rolled_back.is_some() { "rolled_back" } else { "restored" }, rolled_back, &warnings);
}

/// The fixed warning code of a recovery whose scratch could not be removed (shown in status.backup `lastRestore.warnings`).
pub const SCRATCH_LEFT: &str = "RECOVERY_SCRATCH_LEFT";

/// Before the plaintext dump is written: its size, plus the update path's 3x rule (clone, restored copy, WAL). Old database
/// copies cannot be dropped silently here, so a short disk names the ones that could be removed.
fn check_disk(env: &Env, ctx: &BackupCtx, deps: &Deps, rx: &Rx, m: &super::dump::Manifest) -> BResult<()> {
    use crate::ops::swap::{disk_ok, DiskVerdict};
    let free = (deps.free_bytes)(&env.data).map_err(|e| BackupError::precondition(format!("cannot read free disk space: {e}")))?;
    let dump = m.files.iter().find(|f| f.name == super::dump::DUMP_FILE).map(|f| f.bytes).unwrap_or(0);
    let (avail, db) = (free.saturating_sub(dump), m.database.bytes.max(0) as u64);
    if disk_ok(avail, db, 0) == DiskVerdict::Ok {
        return Ok(());
    }
    let old: Vec<(String, u64)> = super::pg::sql_scalar(rx.exec, ctx, &admin_conn(ctx, "postgres"), "SELECT datname || '|' || pg_database_size(oid) FROM pg_database WHERE datname ~ '^pos_(prev|failed)_' ORDER BY 1;", true)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('|'))
        .filter(|(n, _)| n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
        .filter_map(|(n, b)| Some((n.to_string(), b.trim().parse().ok()?)))
        .collect();
    let droppable: u64 = old.iter().map(|(_, b)| *b).sum();
    let need = match disk_ok(0, db, 0) {
        DiskVerdict::Short { need } => need,
        _ => 0,
    };
    let mut msg = format!("not enough free disk space to restore: {} MB needed (the dump {} MB plus three times the database), {} MB free", (need + dump) >> 20, dump >> 20, free >> 20);
    if !old.is_empty() {
        let names: Vec<String> = old.iter().map(|(n, b)| format!("{n} ({} MB)", b >> 20)).collect();
        let enough = if disk_ok(avail, db, droppable) == DiskVerdict::OkAfterDroppingOld { "; removing them would be enough" } else { "" };
        msg.push_str(&format!("; old database copies that can be removed to make room: {}{enough}", names.join(", ")));
    }
    Err(BackupError::precondition(msg))
}

/// POST with a JSON body to the loopback INTERNAL listener (`crate::http` refuses anything else and any redirect).
pub fn http_post_json(addr: &str, path: &str, headers: &[(&str, &str)], body: &str, timeout: Duration) -> R<(u16, String)> {
    let v: Value = serde_json::from_str(body).map_err(|e| OpError::err("PROBE_IO", format!("bad request body: {e}")))?;
    crate::http::request("POST", &format!("http://{addr}{path}"), headers, Some(&v), timeout)
        .map(|r| (r.status, r.body))
        .map_err(|e| OpError::err("PROBE_IO", e))
}

pub struct RestoreArgs {
    pub snapshot: String,
    pub swap: bool,
    pub repo: Option<String>,
}

/// An unfinished operation of the shared API (a journal, or the fence it left behind) must be recovered first.
fn pending_gate(env: &Env) -> BResult<()> {
    let recover = "run `posctl update --recover` as an administrator first, then restore again";
    match Journal::read(&env.update_dir()) {
        Ok(None) => {}
        Ok(Some(j)) => return Err(BackupError::recovery_needed(format!("an interrupted {:?} operation left its journal; {recover}", j.kind))),
        Err(e) => return Err(BackupError::recovery_needed(format!("the operation journal cannot be read ({e:?}); {recover}"))),
    }
    for p in [env.roots.fence_start_types(), env.conf().join("Caddyfile.live")] {
        match p.try_exists() {
            Ok(false) => {}
            Ok(true) => return Err(BackupError::recovery_needed(format!("a previous operation left its gateway or service fence behind; {recover}"))),
            Err(e) => return Err(BackupError::recovery_needed(format!("cannot tell whether a previous operation left its fence behind ({e}); {recover}"))),
        }
    }
    Ok(())
}

/// The production entry (Task 11 calls it with the key read from stdin): Plan 07's real world and deadline cell.
pub fn run_restore(env: &Env, ctx: &BackupCtx, a: &RestoreArgs, recovery_key: Option<String>) -> BResult<Value> {
    use crate::commands::update::{Deps as UpdateDeps, RealDeps};
    if ctx.is_dev() && a.swap {
        return Err(BackupError::usage("restore --swap fences the tills and swaps databases of the real server and cannot run with --dev"));
    }
    // a restore can take hours: the machine may not sleep until it ends (the execution state is per thread, and this is the one)
    let _awake = crate::awake::KeepAwake::new();
    let upd = RealDeps::new();
    let make = |e: &Env, pack: &str| upd.world(e, pack, pack);
    run_restore_with(env, ctx, a, recovery_key, Deps::real(), &make, upd.deadline_cell())
}

pub(crate) fn run_restore_with(env: &Env, ctx: &BackupCtx, a: &RestoreArgs, recovery_key: Option<String>, deps: Deps, make_world: &MakeWorld, deadline: Arc<AtomicU64>) -> BResult<Value> {
    run_restore_with_seams(env, ctx, a, recovery_key, deps, make_world, deadline, &|_| {})
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_restore_with_seams(env: &Env, ctx: &BackupCtx, a: &RestoreArgs, recovery_key: Option<String>, deps: Deps, make_world: &MakeWorld, deadline: Arc<AtomicU64>, configure: &dyn Fn(&mut RestoreWork)) -> BResult<Value> {
    let src = restore::resolve_source(ctx, a.repo.as_deref(), recovery_key.as_deref())?;
    if !a.swap {
        return super::drill::verify_only(ctx, &deps, src, &a.snapshot);
    }
    let mut r = [0u8; 4];
    random_bytes(&mut r)?;
    let op_id = format!("restore-{}", hex(&r));
    // Declared first, so dropped last: the plaintext stage (owned by `work`) is gone before the lock is released.
    let _lock = acquire_for(&env.roots, LockMode::Exclusive, "restore", &op_id, LOCK_WAIT).map_err(map_op_error)?;
    pending_gate(env)?;
    // We hold update.lock exclusively, so no backup run or drill is live: whatever dump an earlier restore left is dead plaintext.
    super::acl::scrub_scratch(ctx)?;

    let (snap, fetched) = {
        let rx = Rx::new(&deps);
        let snap = restore::pick_snapshot(ctx, &rx, &src, &a.snapshot)?;
        // before the plaintext dump is written anywhere: refuse a newer schema, and check the disk from the manifest alone
        let peek = restore::peek_manifest(ctx, &rx, &src, &snap)?;
        migrate::require_not_newer(ctx, peek.migrations_count, &peek.migrations_max)?;
        check_disk(env, ctx, &deps, &rx, &peek)?;
        let fetched = restore::fetch_stage(ctx, &rx, &src, &snap)?;
        (snap, fetched)
    };
    let m = fetched.manifest.clone();
    let (pc, pm) = migrate::pack_level(&ctx.pack_dir)?;
    migrate::require_not_newer(ctx, m.migrations_count, &m.migrations_max)?;

    let pack = ctx.pack_version.clone();
    let mut w = make_world(env, &pack).map_err(map_op_error)?;
    let now_fn = deps.now;
    let now_ms = w.now_ms();
    let budget_ms = ((m.database.bytes.max(0) as u64 >> 20) * 1000).clamp(30 * 60_000, 6 * 3_600_000);
    let deadline_ms = now_ms + budget_ms;
    let mut j = Journal::new(OpKind::Restore, &op_id, now_ms, deadline_ms, Some(pack.clone()), Some(pack.clone()));
    j.extra = restore_journal_extra(&snap.id, pc, &pm, &src.label);
    let octx = OpCtx { op_id: op_id.clone(), names: j.db.clone(), pack_from: Some(pack.clone()), pack_to: Some(pack), deadline_ms };
    deadline.store(deadline_ms, Ordering::Relaxed);
    let label = src.label.clone();
    let mut work = RestoreWork::new(env.clone(), ctx.clone(), deps, deadline, Some((src, fetched)), (pc, pm));
    configure(&mut work);
    let result = crate::ops::runner::run_operation(w.as_mut(), &mut work, &octx, j);
    // the restore's own record (never `update-result.json`): the snapshot id only
    let at = now_fn();
    let warnings = [work.warnings(), w.warnings()].concat();
    match &result {
        Ok(_) => record_restore_with(ctx, at, &snap.id, "restored", None, &warnings),
        Err(e) if e.code == OpCode::RecoveryNeeded => record_restore_with(ctx, at, &snap.id, "failed", Some(&e.reason), &warnings),
        Err(e) => record_restore_with(ctx, at, &snap.id, "rolled_back", Some(&e.reason), &warnings),
    }
    let outcome = result.map_err(map_op_error)?;
    // If the bounded backup of the restored state did not finish while the tills were fenced, `on_commit` flagged the state and the
    // next scheduled tick takes it: nothing here copies for hours under the exclusive lock.
    Ok(json!({
        "restored": snap.id, "source": label, "previousDatabase": outcome.prev_db, "reopened": true,
        "migratedForward": work.migrated_forward, "postRestoreBackup": work.post_backup_done, "photos": work.photo_report, "rederived": work.rederive_report, "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::dump::{self, DbInfo, Manifest};
    use crate::backup::fingerprint::TableFp;
    use crate::backup::state::{BackupState, LastRestore};
    use crate::backup::util::fake::{rand_pin, temp_ctx, FakeExec};
    use crate::envelope::Code;
    use crate::ops::fake::{fresh, FakeWorld};
    use crate::ops::names::DbNames;
    use std::cell::RefCell;
    use std::rc::Rc;

    const ADMIN: &str = "00000000-0000-4000-8000-000000000001";
    const NOW: i64 = 1_790_000_000;
    const LEVEL_MAX: &str = "20260930000001";
    const STAGE: &str = "C:\\ProgramData\\SupermarketPOS\\backups\\tmp\\run-abc123\\stage\\current";
    const STAGE_SUB: &str = "/C/ProgramData/SupermarketPOS/backups/tmp/run-abc123/stage/current";

    struct Rig {
        _d: tempfile::TempDir,
        env: Env,
        ctx: BackupCtx,
    }

    fn rig() -> Rig {
        let (d, ctx) = temp_ctx();
        let roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("program"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(ctx.pack_dir.join("manifest.json"), format!(r#"{{"migrations":{{"count":3,"max":"{LEVEL_MAX}"}}}}"#)).unwrap();
        let env = Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe: d.path().join("posctl.exe"), ports: ctx.ports, roots, activate: Rc::new(|_, _, _| Ok(())) };
        Rig { _d: d, env, ctx }
    }

    fn deps(e: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(e), opener: Box::new(crate::backup::pg::PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }

    fn manifest_in(dir: &std::path::Path, max: &str, tables: Vec<TableFp>) -> Manifest {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(dump::DUMP_FILE), b"dump").unwrap();
        std::fs::write(dir.join(dump::GLOBALS_FILE), b"globals").unwrap();
        let m = Manifest {
            schema: 1,
            taken_at: NOW - 100,
            reason: "hourly".into(),
            pack_version: "t".into(),
            database: DbInfo { name: "postgres".into(), owner: "postgres".into(), encoding: "UTF8".into(), provider: "i".into(), locale: "es-MX".into(), collate: "C".into(), ctype: "C".into(), collversion: "1".into(), bytes: 4096, settings: vec![] },
            migrations_count: 3,
            migrations_max: max.into(),
            files: dump::file_entries(dir).unwrap(),
            tables,
            catalog: [("functions".to_string(), "aa".to_string())].into_iter().collect(),
            stage_subpath: "/C/x".into(),
            photos_subpath: None,
            ..Default::default()
        };
        dump::write_manifest(dir, &m).unwrap();
        m
    }

    fn snap(id: &str) -> crate::backup::restic::Snap {
        let listing = format!("[{{\"id\":\"{id}\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"{}\"]}}]", crate::backup::util::iso_utc(NOW - 60), STAGE.replace('\\', "\\\\"));
        crate::backup::restic::parse_snapshots(&listing).unwrap().remove(0)
    }

    fn stage(r: &Rig, max: &str, tables: Vec<TableFp>) -> (Source, Fetched) {
        let dir = r.ctx.paths.backups_tmp().join("fixture");
        let manifest = manifest_in(&dir, max, tables);
        (restore::resolve_source(&r.ctx, None, None).unwrap(), Fetched { snap: snap("aaaa1111bbbb"), dir, manifest, photos_sub: None, guard: None })
    }

    fn work(r: &Rig, e: Rc<FakeExec>, st: Option<(Source, Fetched)>) -> RestoreWork {
        RestoreWork::new(r.env.clone(), r.ctx.clone(), deps(e), Arc::new(AtomicU64::new(u64::MAX)), st, (3, LEVEL_MAX.to_string()))
    }

    fn octx() -> OpCtx {
        OpCtx { op_id: "restore-1".into(), names: DbNames::for_kind(OpKind::Restore, 1_790_000_000_000), pack_from: Some("p".into()), pack_to: Some("p".into()), deadline_ms: u64::MAX }
    }

    /// Answers for the content proof and the credential check of a healthy restored database.
    fn healthy() -> FakeExec {
        let pin = rand_pin();
        FakeExec::default().on("role::text = 'admin'", 0, &format!("{ADMIN},{pin}\n")).on("encrypted_password = crypt", 0, "t\n").on("pg_default_acl", 0, "functions|aa\n")
    }

    // ---- work_on_clone ----

    #[test]
    fn work_on_clone_proves_the_content_before_it_touches_a_single_password() {
        let r = rig();
        let e = Rc::new(healthy());
        let mut w = work(&r, e.clone(), Some(stage(&r, LEVEL_MAX, vec![])));
        let migrated = Rc::new(RefCell::new(0));
        let m2 = migrated.clone();
        w.migrate_fn = Some(Box::new(move |_| { *m2.borrow_mut() += 1; Ok(()) }));
        w.work_on_clone(&octx()).unwrap();
        let at = |n: &str| e.index_of(n).unwrap_or_else(|| panic!("{n} never ran"));
        assert!(at("CREATE DATABASE \"pos_next\"") < at("pg_restore.exe"));
        assert!(at("pg_restore.exe") < at("ONLY %s __fp_row"), "fingerprints after the load");
        assert!(at("ONLY %s __fp_row") < at("encrypted_password = crypt"), "credential check after the content proof");
        assert_eq!(*migrated.borrow(), 0, "a snapshot at the installed level is not migrated");
        assert!(e.calls.borrow().iter().all(|l| !(l.starts_with("pg_restore.exe") && l.contains("-d postgres"))), "never into the live database");
    }

    #[test]
    fn a_content_mismatch_stops_the_restore_before_passwords_are_rewritten() {
        let r = rig();
        let e = Rc::new(healthy().on("ONLY %s __fp_row", 0, "public.items|3|999\n"));
        let mut w = work(&r, e.clone(), Some(stage(&r, LEVEL_MAX, vec![TableFp { name: "public.items".into(), count: 3, hash: "123".into() }])));
        let err = w.work_on_clone(&octx()).unwrap_err();
        assert_eq!(err.reason, "RESTORE_FAILED");
        assert!(err.message.contains("public.items"));
        assert!(e.index_of("UPDATE auth.users").is_none() && e.index_of("encrypted_password = crypt").is_none());
    }

    #[test]
    fn a_backup_from_a_newer_schema_than_the_installed_pack_is_refused_before_anything_runs() {
        let r = rig();
        let e = Rc::new(healthy());
        let mut w = work(&r, e.clone(), Some(stage(&r, "20261001000001", vec![])));
        let err = w.work_on_clone(&octx()).unwrap_err();
        assert!(err.message.contains("newer"), "{}", err.message);
        assert!(e.calls.borrow().is_empty(), "nothing is created for a snapshot the software cannot run");
    }

    #[test]
    fn an_older_snapshot_gets_plan_07s_sequence_after_the_content_proof_and_before_passwords_are_rewritten() {
        let r = rig();
        let e = Rc::new(healthy());
        let mut w = work(&r, e.clone(), Some(stage(&r, "20260927000004", vec![])));
        let seen: Rc<RefCell<Option<(bool, bool)>>> = Rc::new(RefCell::new(None));
        let (s2, e2) = (seen.clone(), e.clone());
        w.migrate_fn = Some(Box::new(move |c| {
            assert_eq!(c.names.next, "pos_next", "the sequence runs on the restored clone");
            *s2.borrow_mut() = Some((e2.index_of("ONLY %s __fp_row").is_some(), e2.index_of("encrypted_password = crypt").is_some()));
            Ok(())
        }));
        w.work_on_clone(&octx()).unwrap();
        assert_eq!(*seen.borrow(), Some((true, false)), "(content proven, credentials not yet rewritten) when the migration ran");
        assert!(e.index_of("encrypted_password = crypt").is_some(), "passwords are rewritten after the migration");
    }

    #[test]
    fn a_failed_migration_fails_the_restore_without_rewriting_passwords() {
        let r = rig();
        let e = Rc::new(healthy());
        let mut w = work(&r, e.clone(), Some(stage(&r, "20260927000004", vec![])));
        w.migrate_fn = Some(Box::new(|_| Err(OpError::new(OpCode::MigrationFailed, "MIGRATION_FAILED", "boom"))));
        let err = w.work_on_clone(&octx()).unwrap_err();
        assert_eq!(err.code, OpCode::MigrationFailed);
        assert!(e.index_of("encrypted_password = crypt").is_none());
        assert_eq!(map_op_error(err).exit(), 31);
    }

    #[test]
    fn a_hostile_target_name_is_refused_before_any_command_runs() {
        let r = rig();
        for bad in ["postgres", "template1", "pos_next; DROP DATABASE postgres", "\"pos_next\""] {
            let e = Rc::new(healthy());
            let mut w = work(&r, e.clone(), Some(stage(&r, LEVEL_MAX, vec![])));
            let mut c = octx();
            c.names.next = bad.to_string();
            assert!(w.work_on_clone(&c).is_err(), "{bad}");
            assert!(e.calls.borrow().is_empty(), "{bad}: a refused name runs nothing");
        }
    }

    #[test]
    fn without_the_fetched_backup_a_restore_cannot_start_and_says_so() {
        let r = rig();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        let err = w.work_on_clone(&octx()).unwrap_err();
        assert_eq!(err.reason, "RESTORE_FAILED");
        assert!(w.verify_clone(&octx()).is_err());
    }

    // ---- verify_clone ----

    fn structure_fake() -> Rc<FakeExec> {
        Rc::new(
            healthy()
                .on("FROM supabase_migrations.schema_migrations", 0, &format!("3|{LEVEL_MAX}\n"))
                .on("has_function_privilege", 0, "t\n")
                .on("storage.objects", 0, "product-photos/aaa\n"),
        )
    }

    #[test]
    fn verify_clone_checks_the_structure_then_reports_the_photos_and_merges_them_only_now() {
        let r = rig();
        std::fs::create_dir_all(r.ctx.paths.photos().join("product-photos")).unwrap();
        std::fs::write(r.ctx.paths.photos().join("product-photos").join("aaa"), b"x").unwrap();
        let e = structure_fake();
        let mut w = work(&r, e.clone(), Some(stage(&r, LEVEL_MAX, vec![])));
        w.admin_id = Some(ADMIN.to_string());
        w.verify_clone(&octx()).unwrap();
        let at = |n: &str| e.index_of(n).unwrap();
        assert!(at("has_function_privilege") < at("storage.objects"), "structure first, photos after");
        assert_eq!(w.photo_report.as_ref().unwrap()["dangling"], 0);
    }

    #[test]
    fn a_large_share_of_missing_photos_fails_the_restore_and_a_few_only_warn() {
        let r = rig();
        let rows: String = (0..10).map(|i| format!("product-photos/p{i}\n")).collect();
        let e = Rc::new(healthy().on("FROM supabase_migrations.schema_migrations", 0, &format!("3|{LEVEL_MAX}\n")).on("has_function_privilege", 0, "t\n").on("storage.objects", 0, &rows));
        let mut w = work(&r, e, Some(stage(&r, LEVEL_MAX, vec![])));
        w.admin_id = Some(ADMIN.to_string());
        let err = w.verify_clone(&octx()).unwrap_err();
        assert!(err.message.contains("photos are missing"), "{}", err.message);
        // three of ten dangling is within max(3, 5%): a warning
        std::fs::create_dir_all(r.ctx.paths.photos().join("product-photos")).unwrap();
        for i in 0..7 {
            std::fs::write(r.ctx.paths.photos().join("product-photos").join(format!("p{i}")), b"x").unwrap();
        }
        w.verify_clone(&octx()).unwrap();
        assert!(w.warnings().iter().any(|x| x == "PHOTOS_SOME_MISSING"));
    }

    // ---- recovery, journal, error mapping ----

    #[test]
    fn recovery_can_rebuild_the_work_from_the_journal_alone_and_never_needs_the_backup_files() {
        let r = rig();
        let mut j = crate::ops::journal::Journal::new(OpKind::Restore, "restore-1", 1_790_000_000_000, 1_790_000_900_000, Some("1.0.1-r1".into()), Some("1.0.1-r1".into()));
        j.extra = restore_journal_extra("aaaa1111bbbb", 3, LEVEL_MAX, "local");
        let w = RestoreWork::from_journal(&j, &r.env).unwrap();
        assert_eq!(w.kind(), OpKind::Restore);
        assert_eq!(w.backup_reason(), BackupReason::PreRestore);
        j.extra = serde_json::Value::Null;
        assert!(RestoreWork::from_journal(&j, &r.env).is_err(), "a journal without its inputs must not be guessed at");
        j.extra = restore_journal_extra("aaaa1111bbbb", 3, LEVEL_MAX, "local");
        j.pack_from = None;
        j.pack_to = None;
        assert!(RestoreWork::from_journal(&j, &r.env).is_err());
    }

    #[test]
    fn update_recover_finds_a_restore_work_through_work_for() {
        let r = rig();
        let mut j = crate::ops::journal::Journal::new(OpKind::Restore, "restore-1", 1, 2, Some("1.0.1-r1".into()), Some("1.0.1-r1".into()));
        j.extra = restore_journal_extra("aaaa1111bbbb", 3, LEVEL_MAX, "local");
        let w = crate::commands::update::work_for(&j, &r.env).unwrap();
        assert_eq!(w.kind(), OpKind::Restore);
        j.extra = serde_json::Value::Null;
        assert_eq!(crate::commands::update::work_for(&j, &r.env).err().unwrap().code, OpCode::RecoveryNeeded);
        let sw = crate::ops::journal::Journal::new(OpKind::Switch, "op", 0, 0, None, None);
        assert_eq!(crate::commands::update::work_for(&sw, &r.env).err().unwrap().reason, "WORK_NOT_REGISTERED");
    }

    #[test]
    fn the_journal_never_contains_a_key_or_a_password() {
        let extra = restore_journal_extra("aaaa1111bbbb", 3, LEVEL_MAX, "local");
        let text = extra.to_string().to_lowercase();
        assert!(!text.contains("password") && !text.contains("key") && !text.contains("pin") && !text.contains("pepper"), "{text}");
    }

    #[test]
    fn operation_errors_map_to_the_posctl_exit_codes_and_never_to_zero() {
        use crate::ops::outcome::OpCode::*;
        let exit = |c: OpCode| map_op_error(OpError::new(c, "R", "x")).exit();
        assert_eq!(exit(LockHeld), 10);
        assert_eq!(exit(Precondition), 12);
        assert_eq!(exit(RecoveryNeeded), 17);
        assert_eq!(exit(Usage), 2);
        for c in [Error, VerifyFailedRolledBack, RolledBack, MigrationFailed, PackInvalid, Ok] {
            assert_eq!(exit(c), 31, "{c:?}");
        }
        assert_eq!(map_op_error(OpError::new(RolledBack, "X", "m")).code, Code::RestoreFailed);
    }

    // ---- verify_live ----

    fn keys(r: &Rig) {
        std::fs::create_dir_all(r.env.secrets()).unwrap();
        std::fs::write(r.env.secrets().join("keys.json"), r#"{"anon":"anon-k","service_role":"svc-k"}"#).unwrap();
    }

    fn live_mock(level: &'static str, signin: u16) -> crate::http::mock::Mock {
        crate::http::mock::start(move |q| {
            if q.path.starts_with("/rest/v1/store_schema_version") {
                (200, format!("[{{\"max_version\":\"{level}\",\"applied\":3}}]"))
            } else if q.path.starts_with("/rest/v1/profiles") {
                (200, "[]".into())
            } else if q.path.starts_with("/auth/v1/token") {
                (signin, if signin == 200 { "{\"access_token\":\"abc\"}".into() } else { "{\"error\":\"invalid_grant\"}".into() })
            } else {
                (404, String::new())
            }
        })
    }

    #[test]
    fn verify_live_signs_the_admin_in_through_gotrue_on_the_internal_listener_and_creates_no_sale() {
        let r = rig();
        keys(&r);
        let m = live_mock(LEVEL_MAX, 200);
        let mut w = work(&r, Rc::new(healthy()), None);
        w.internal = format!("127.0.0.1:{}", m.port);
        w.verify_live(&octx()).unwrap();
        let reqs = m.requests();
        let token = reqs.iter().find(|q| q.path.starts_with("/auth/v1/token?grant_type=password")).expect("a sign-in was made");
        assert_eq!(token.method, "POST");
        assert!(token.body.contains(&format!("{ADMIN}@barpos.local")), "the staff e-mail shape");
        assert!(reqs.iter().all(|q| q.method == "GET" || q.path.starts_with("/auth/v1/token") || q.path.starts_with("/auth/v1/logout")), "reads and one sign-in only: {:?}", reqs.iter().map(|q| (&q.method, &q.path)).collect::<Vec<_>>());
    }

    #[test]
    fn verify_live_fails_when_the_admin_cannot_sign_in_or_the_level_is_wrong_and_leaks_nothing() {
        let r = rig();
        keys(&r);
        let m = live_mock(LEVEL_MAX, 400);
        let mut w = work(&r, Rc::new(healthy()), None);
        w.internal = format!("127.0.0.1:{}", m.port);
        let err = w.verify_live(&octx()).unwrap_err();
        assert_eq!(err.code, OpCode::VerifyFailedRolledBack);
        assert!(err.message.contains("could not sign in"), "{}", err.message);
        let m2 = live_mock("20260101000000", 200);
        w.internal = format!("127.0.0.1:{}", m2.port);
        assert_eq!(w.verify_live(&octx()).unwrap_err().code, OpCode::VerifyFailedRolledBack);
        let pw_leak = format!("{:?}", err);
        assert!(!pw_leak.contains("anon-k") && !pw_leak.contains("svc-k"));
    }

    #[test]
    fn the_sign_in_probe_posts_json_and_reads_status_and_body() {
        let m = crate::http::mock::start(|_| (200, "{\"access_token\":\"abc\"}".into()));
        let (status, body) = http_post_json(&format!("127.0.0.1:{}", m.port), "/auth/v1/token?grant_type=password", &[("apikey", "k")], "{\"email\":\"a\"}", Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("access_token"));
        let q = &m.requests()[0];
        assert_eq!((q.method.as_str(), q.path.as_str()), ("POST", "/auth/v1/token?grant_type=password"));
        assert!(q.headers.iter().any(|(k, v)| k == "apikey" && v == "k"));
        assert_eq!(q.body, "{\"email\":\"a\"}");
        assert!(http_post_json("10.0.0.5:80", "/", &[], "{}", Duration::from_millis(300)).is_err(), "loopback only");
    }

    // ---- on_commit (C7) ----

    #[test]
    fn on_commit_deletes_the_canary_record_before_the_canary_runs_and_a_canary_failure_still_succeeds() {
        let r = rig();
        let canary = r.env.roots.canary_json();
        std::fs::create_dir_all(canary.parent().unwrap()).unwrap();
        std::fs::write(&canary, r#"{"userId":"x","email":"x@barpos.local"}"#).unwrap();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        let order: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(vec![]));
        let (o1, o2, c2) = (order.clone(), order.clone(), canary.clone());
        w.backup_fn = Some(Box::new(move |_| { o1.borrow_mut().push("backup".into()); Ok(()) }));
        w.canary_fn = Some(Box::new(move || {
            o2.borrow_mut().push(format!("canary(record exists: {})", c2.exists()));
            Err(crate::envelope::PosctlError::new(Code::CanaryFailed, "the lockout could not be proven"))
        }));
        w.on_commit(&octx()).expect("a canary failure after a restore never fails the restore");
        assert_eq!(*order.borrow(), ["backup", "canary(record exists: false)"]);
    }

    #[test]
    fn on_commit_takes_one_more_backup_of_the_restored_state_bounded_in_time_under_the_callers_lock() {
        let r = rig();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        let seen: Rc<RefCell<Vec<RunOptions>>> = Rc::new(RefCell::new(vec![]));
        let s2 = seen.clone();
        w.backup_fn = Some(Box::new(move |o| { s2.borrow_mut().push(o.clone()); Ok(()) }));
        w.canary_fn = Some(Box::new(|| Ok(())));
        w.on_commit(&octx()).unwrap();
        let o = seen.borrow()[0].clone();
        assert_eq!((o.reason, o.lock, o.scheduled), (Reason::Manual, LockPolicy::CallerHoldsExclusive, false));
        let left = o.deadline.expect("the store is still fenced: the backup is bounded") - NOW;
        assert!((1..=POST_RESTORE_BACKUP_CAP_SECS).contains(&left), "{left}");
        assert!(w.post_backup_done);
    }

    #[test]
    fn a_failed_post_restore_backup_is_a_visible_warning_and_makes_the_next_tick_take_one() {
        let r = rig();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        w.backup_fn = Some(Box::new(|_| Err(BackupError::backup_failed("over the budget"))));
        w.canary_fn = Some(Box::new(|| Ok(())));
        w.on_commit(&octx()).unwrap();
        assert!(!w.post_backup_done);
        assert!(w.warnings().iter().any(|x| x == "POST_RESTORE_BACKUP_FAILED"), "{:?}", w.warnings());
        assert!(BackupState::load(&r.ctx.paths.state_file(), NOW).unwrap().backup_due_now, "the scheduled tick is told to back up at once");
        // a repeat (recovery re-enters on_commit) does not duplicate the warning
        w.on_commit(&octx()).unwrap();
        assert_eq!(w.warnings().iter().filter(|x| *x == "POST_RESTORE_BACKUP_FAILED").count(), 1);
    }

    #[test]
    fn a_positive_canary_failure_is_a_visible_warning_and_a_failed_canary_record_so_status_alerts_at_once() {
        let r = rig();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        w.backup_fn = Some(Box::new(|_| Ok(())));
        w.canary_fn = Some(Box::new(|| Err(crate::envelope::PosctlError::new(Code::CanaryFailed, "five wrong passwords did not lock the account"))));
        w.on_commit(&octx()).unwrap();
        assert!(w.warnings().iter().any(|x| x == "CANARY_AFTER_RESTORE"));
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.env.roots.canary_json()).unwrap()).unwrap();
        assert_eq!(rec["lastOk"], false);
        assert!(rec["lastRunAt"].as_str().is_some());
    }

    #[test]
    fn a_canary_that_could_not_be_judged_warns_but_does_not_record_a_failure() {
        let r = rig();
        let mut w = work(&r, Rc::new(FakeExec::default()), None);
        w.backup_fn = Some(Box::new(|_| Ok(())));
        w.canary_fn = Some(Box::new(|| Err(crate::envelope::PosctlError::new(Code::Unhealthy, "gotrue answered 503"))));
        w.on_commit(&octx()).unwrap();
        assert!(w.warnings().iter().any(|x| x == "CANARY_AFTER_RESTORE"));
        assert!(!r.env.roots.canary_json().exists(), "a 5xx is not evidence about the hook: nothing gates sign-in");
    }

    // ---- the safety copy is closed to app roles (PM ruling) ----

    #[test]
    fn on_commit_closes_the_previous_restore_copy_to_public_and_every_grantee_and_never_touches_postgres() {
        let r = rig();
        let e = Rc::new(FakeExec::default());
        let mut w = work(&r, e.clone(), None);
        w.backup_fn = Some(Box::new(|_| Ok(())));
        w.canary_fn = Some(Box::new(|| Ok(())));
        let c = octx();
        w.on_commit(&c).unwrap();
        let revokes: Vec<String> = e.calls.borrow().iter().filter(|l| l.contains("REVOKE")).cloned().collect();
        assert!(!revokes.is_empty());
        let want = format!("REVOKE CONNECT ON DATABASE \"{}\" FROM PUBLIC", c.names.prev);
        assert!(revokes.iter().any(|l| l.contains(&want)), "{revokes:?}");
        assert!(revokes.iter().any(|l| l.contains("aclexplode") && l.contains(&format!("'{}'", c.names.prev))), "every non-owner grantee is read from datacl");
        assert!(revokes.iter().all(|l| !l.contains("\"postgres\"") && !l.contains("'postgres'")), "{revokes:?}");
    }

    #[test]
    fn a_name_that_is_not_a_restore_copy_is_never_revoked() {
        let r = rig();
        for bad in ["postgres", "pos_prev_update_20261001020000", "pos_next", "pos_prev_restore_x; DROP DATABASE postgres"] {
            let e = Rc::new(FakeExec::default());
            let mut w = work(&r, e.clone(), None);
            w.backup_fn = Some(Box::new(|_| Ok(())));
            w.canary_fn = Some(Box::new(|| Ok(())));
            let mut c = octx();
            c.names.prev = bad.to_string();
            w.on_commit(&c).unwrap();
            assert!(e.calls.borrow().iter().all(|l| !l.contains("REVOKE")), "{bad}");
        }
    }

    #[test]
    fn a_failed_revoke_is_a_warning_and_never_fails_the_restore() {
        let r = rig();
        let e = Rc::new(FakeExec::default().on("REVOKE CONNECT", 1, ""));
        let mut w = work(&r, e, None);
        w.backup_fn = Some(Box::new(|_| Ok(())));
        w.canary_fn = Some(Box::new(|| Ok(())));
        w.on_commit(&octx()).unwrap();
        assert!(w.warnings().iter().any(|x| x == "PREV_COPY_REVOKE_FAILED"), "{:?}", w.warnings());
    }

    // ---- AppSec ----

    #[test]
    fn credentials_in_an_s3_address_are_refused_before_they_reach_argv_or_the_journal() {
        let r = rig();
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        for bad in ["s3:https://key:secret@acct.r2.cloudflarestorage.com/bucket", "s3:https://x@host/b"] {
            let err = restore::resolve_source(&r.ctx, Some(bad), Some(&rk)).err().unwrap();
            assert_eq!(err.code, Code::Usage, "{bad}");
            assert!(!err.message.contains("key:secret"), "{}", err.message);
        }
        assert!(restore::resolve_source(&r.ctx, Some("s3:https://acct.r2.cloudflarestorage.com/bucket"), Some(&rk)).is_ok());
    }

    #[test]
    fn a_snapshot_id_that_is_not_hex_never_reaches_argv_or_the_journal() {
        let r = rig();
        let bad = format!("[{{\"id\":\"--password-file=x\",\"time\":\"{}\",\"tags\":[],\"paths\":[\"{}\"]}}]", crate::backup::util::iso_utc(NOW - 60), STAGE.replace('\\', "\\\\"));
        let e = Rc::new(FakeExec::default().on(SNAPSHOTS, 0, &bad));
        let d = deps(e);
        let src = restore::resolve_source(&r.ctx, None, None).unwrap();
        let err = restore::pick_snapshot(&r.ctx, &Rx::new(&d), &src, "latest").unwrap_err();
        assert_eq!(err.code, Code::RestoreFailed);
        assert!(err.message.contains("not a valid snapshot id"), "{}", err.message);
    }

    #[test]
    fn the_probe_signs_the_admin_out_again_and_a_failed_logout_is_only_a_warning() {
        let r = rig();
        keys(&r);
        let m = crate::http::mock::start(|q| {
            if q.path.starts_with("/rest/v1/store_schema_version") {
                (200, format!("[{{\"max_version\":\"{LEVEL_MAX}\",\"applied\":3}}]"))
            } else if q.path.starts_with("/rest/v1/profiles") {
                (200, "[]".into())
            } else if q.path.starts_with("/auth/v1/token") {
                (200, "{\"access_token\":\"tok-1\"}".into())
            } else {
                (500, String::new())
            }
        });
        let mut w = work(&r, Rc::new(healthy()), None);
        w.internal = format!("127.0.0.1:{}", m.port);
        w.verify_live(&octx()).unwrap();
        let out = m.requests().into_iter().find(|q| q.path.starts_with("/auth/v1/logout")).expect("a logout");
        assert!(out.headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer tok-1"));
        assert!(w.warnings().iter().any(|x| x == "PROBE_LOGOUT_FAILED"), "the mock answered 500");
    }

    // ---- run_restore_with: lock, journal gate, order ----

    const SNAPSHOTS: &str = "snapshots --json";

    fn listing() -> String {
        format!("[{{\"id\":\"aaaa1111bbbb\",\"time\":\"{}\",\"tags\":[\"posctl\"],\"paths\":[\"{}\"]}}]", crate::backup::util::iso_utc(NOW - 60), STAGE.replace('\\', "\\\\"))
    }

    /// Restic answers: the listing and a restore that writes the manifest into the private run folder.
    fn manifest_json(max: &str) -> String {
        let d = tempfile::tempdir().unwrap();
        manifest_in(d.path(), max, vec![]);
        std::fs::read_to_string(d.path().join(dump::MANIFEST_FILE)).unwrap()
    }

    fn restic_fake(max: &'static str) -> FakeExec {
        healthy().on(SNAPSHOTS, 0, &listing()).on(&format!("dump aaaa1111bbbb:{STAGE_SUB} {}", dump::MANIFEST_FILE), 0, &manifest_json(max)).on_with(&format!("restore aaaa1111bbbb:{STAGE_SUB}"), 0, "", move |args| {
            let t = args.iter().position(|a| a == "--target").unwrap();
            manifest_in(&std::path::PathBuf::from(&args[t + 1]), max, vec![]);
        })
    }

    fn last_restore(r: &Rig) -> Option<LastRestore> {
        BackupState::load(&r.ctx.paths.state_file(), NOW).unwrap().last_restore
    }

    fn args() -> RestoreArgs {
        RestoreArgs { snapshot: "latest".into(), swap: true, repo: None }
    }

    type Made = Rc<RefCell<u32>>;
    fn run(r: &Rig, e: Rc<FakeExec>, shared: &crate::ops::fake::Shared, made: &Made) -> BResult<Value> {
        let (s2, m2) = (shared.clone(), made.clone());
        let make = move |_: &Env, _: &str| -> R<Box<dyn crate::ops::world::World>> { *m2.borrow_mut() += 1; Ok(Box::new(FakeWorld(s2.clone()))) };
        run_restore_with(&r.env, &r.ctx, &args(), None, deps(e), &make, Arc::new(AtomicU64::new(u64::MAX)))
    }

    #[test]
    fn a_pending_update_journal_refuses_the_restore_before_anything_is_touched() {
        let r = rig();
        crate::ops::journal::Journal::new(OpKind::Update, "op", 1, 2, Some("a".into()), Some("b".into())).write(&r.env.update_dir()).unwrap();
        let e = Rc::new(restic_fake(LEVEL_MAX));
        let made: Made = Rc::default();
        let err = run(&r, e.clone(), &fresh(), &made).unwrap_err();
        assert_eq!((err.code, err.exit()), (Code::RecoveryNeeded, 17));
        assert!(err.message.contains("update --recover"), "{}", err.message);
        assert!(e.calls.borrow().is_empty(), "no restic, no psql: {:?}", e.calls.borrow());
        assert_eq!(*made.borrow(), 0, "no fence");
        assert!(!r.env.data.join("work").exists(), "the staged migrations folder is untouched");
    }

    #[test]
    fn a_corrupt_journal_or_a_leftover_fence_also_refuses_with_recovery_needed() {
        let r = rig();
        std::fs::write(crate::ops::journal::path(&r.env.update_dir()), b"{ not json").unwrap();
        let e = Rc::new(restic_fake(LEVEL_MAX));
        let made: Made = Rc::default();
        assert_eq!(run(&r, e.clone(), &fresh(), &made).unwrap_err().exit(), 17);
        std::fs::remove_file(crate::ops::journal::path(&r.env.update_dir())).unwrap();
        std::fs::write(r.env.roots.fence_start_types(), b"{}").unwrap();
        assert_eq!(run(&r, e.clone(), &fresh(), &made).unwrap_err().exit(), 17);
        std::fs::remove_file(r.env.roots.fence_start_types()).unwrap();
        std::fs::create_dir_all(r.env.conf()).unwrap();
        std::fs::write(r.env.conf().join("Caddyfile.live"), b"x").unwrap();
        assert_eq!(run(&r, e.clone(), &fresh(), &made).unwrap_err().exit(), 17);
        assert!(e.calls.borrow().is_empty());
    }

    #[test]
    fn another_operation_holding_the_lock_refuses_with_lock_held() {
        let r = rig();
        let _held = crate::ops::lock::acquire_for(&r.env.roots, crate::ops::lock::LockMode::Shared, "backup", "b", Duration::from_secs(0)).unwrap();
        let e = Rc::new(restic_fake(LEVEL_MAX));
        let made: Made = Rc::default();
        let err = run(&r, e.clone(), &fresh(), &made).unwrap_err();
        assert_eq!(err.exit(), 10);
        assert!(e.calls.borrow().is_empty());
    }

    #[test]
    fn a_newer_snapshot_is_refused_after_the_fetch_and_before_the_fence_and_the_plaintext_is_gone() {
        let r = rig();
        let e = Rc::new(restic_fake("20261001000001"));
        let made: Made = Rc::default();
        let err = run(&r, e, &fresh(), &made).unwrap_err();
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("newer"));
        assert_eq!(*made.borrow(), 0, "the world is never built, the tills are never fenced");
        assert!(no_run_folders(&r), "the fetched plaintext is deleted on every exit path");
    }

    fn no_run_folders(r: &Rig) -> bool {
        std::fs::read_dir(r.ctx.paths.backups_tmp()).map(|rd| rd.flatten().all(|e| !e.file_name().to_string_lossy().starts_with("run-"))).unwrap_or(true)
    }

    fn run_with_free(r: &Rig, e: Rc<FakeExec>, free: fn(&std::path::Path) -> std::io::Result<u64>) -> (BackupError, Made) {
        let mut d = deps(e);
        d.free_bytes = free;
        let made: Made = Rc::default();
        let m2 = made.clone();
        let make = move |_: &Env, _: &str| -> R<Box<dyn crate::ops::world::World>> { *m2.borrow_mut() += 1; Ok(Box::new(FakeWorld(fresh()))) };
        (run_restore_with(&r.env, &r.ctx, &args(), None, d, &make, Arc::new(AtomicU64::new(u64::MAX))).unwrap_err(), made)
    }

    #[test]
    fn too_little_disk_refuses_before_the_dump_is_fetched_or_the_fence_is_raised() {
        let r = rig();
        let e = Rc::new(restic_fake(LEVEL_MAX));
        let (err, made) = run_with_free(&r, e.clone(), |_| Ok(1 << 20));
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("free disk space"), "{}", err.message);
        assert!(e.index_of(&format!("restore aaaa1111bbbb:{STAGE_SUB}")).is_none(), "the plaintext dump is never written to a disk that cannot hold it");
        assert!(e.index_of("dump aaaa1111bbbb").is_some(), "the size comes from the manifest, read on its own");
        assert_eq!(*made.borrow(), 0);
        assert!(no_run_folders(&r));
    }

    #[test]
    fn the_refusal_names_the_old_database_copies_that_could_be_removed() {
        let r = rig();
        let e = Rc::new(restic_fake(LEVEL_MAX).on("pos_(prev|failed)_", 0, "pos_prev_update_20261001020000|9999999999999\npos_failed_20260901020000|1\n"));
        let (err, _) = run_with_free(&r, e, |_| Ok(1 << 20));
        assert!(err.message.contains("pos_prev_update_20261001020000"), "{}", err.message);
        assert!(err.message.contains("removed"), "{}", err.message);
    }

    #[test]
    fn a_failing_restore_is_rolled_back_by_the_runner_exits_31_and_leaves_no_plaintext() {
        let r = rig();
        keys(&r);
        let e = Rc::new(restic_fake(LEVEL_MAX).on("ONLY %s __fp_row", 0, "public.items|9|9\n"));
        let shared = fresh();
        shared.borrow_mut().dbs.insert(crate::ops::names::NEXT.to_string(), "old"); // what work_on_clone's create_and_load builds (the runner no longer templates it)
        let made: Made = Rc::default();
        // the manifest has no tables, the database reports one the backup never had
        let err = run(&r, e, &shared, &made).unwrap_err();
        assert_eq!(err.exit(), 31, "{}", err.message);
        assert_eq!(*made.borrow(), 1);
        let st = shared.borrow();
        assert!(st.journal.is_none(), "the rollback archived the journal");
        assert_eq!(st.dbs.keys().cloned().collect::<Vec<_>>(), ["postgres"], "only the live database is left");
        assert!(st.violations.is_empty());
        drop(st);
        assert!(no_run_folders(&r));
        let lr = last_restore(&r).expect("a rolled back restore is recorded");
        assert_eq!((lr.result.as_str(), lr.snapshot.as_str(), lr.at), ("rolled_back", "aaaa1111bbbb", NOW));
        assert_eq!(lr.reason.as_deref(), Some("RESTORE_FAILED"));
    }

    #[test]
    fn the_restore_runs_through_the_runner_in_order_and_reports_the_previous_database() {
        let r = rig();
        keys(&r);
        let m = live_mock(LEVEL_MAX, 200);
        let e = Rc::new(
            restic_fake(LEVEL_MAX)
                .on("FROM supabase_migrations.schema_migrations", 0, &format!("3|{LEVEL_MAX}\n"))
                .on("has_function_privilege", 0, "t\n"),
        );
        let shared = fresh();
        shared.borrow_mut().dbs.insert(crate::ops::names::NEXT.to_string(), "old"); // what work_on_clone's create_and_load builds (the runner no longer templates it)
        let made: Made = Rc::default();
        let (s2, m2) = (shared.clone(), made.clone());
        let port = m.port;
        let make = move |_: &Env, _: &str| -> R<Box<dyn crate::ops::world::World>> { *m2.borrow_mut() += 1; Ok(Box::new(FakeWorld(s2.clone()))) };
        let out = run_restore_with_seams(&r.env, &r.ctx, &args(), None, deps(e.clone()), &make, Arc::new(AtomicU64::new(u64::MAX)), &|w: &mut RestoreWork| {
            w.internal = format!("127.0.0.1:{port}");
            w.canary_fn = Some(Box::new(|| Ok(())));
            w.backup_fn = Some(Box::new(|_| Ok(())));
        })
        .unwrap();
        assert_eq!(out["restored"], "aaaa1111bbbb");
        assert_eq!(out["reopened"], true);
        assert!(out["previousDatabase"].as_str().unwrap().starts_with("pos_prev_restore_"), "{out}");
        let st = shared.borrow();
        assert!(st.journal.is_none() && st.violations.is_empty(), "{:?}", st.violations);
        assert!(st.dbs.keys().any(|k| k.starts_with("pos_prev_restore_")), "the old live database is kept as the safety copy");
        assert!(st.trace.contains(&"backup"), "the PreRestore backup ran in the runner, behind the fence");
        drop(st);
        assert!(no_run_folders(&r));
        let lr = last_restore(&r).expect("a restore is recorded");
        assert_eq!((lr.result.as_str(), lr.snapshot.as_str(), lr.reason), ("restored", "aaaa1111bbbb", None));
        assert!(!BackupState::load(&r.ctx.paths.state_file(), NOW).unwrap().backup_due_now, "the post-restore backup completed");
        assert!(e.calls.borrow().iter().any(|l| l.contains("REVOKE CONNECT ON DATABASE \"pos_prev_restore_")), "the safety copy is closed to app roles");
    }

    #[test]
    fn the_restore_record_keeps_warning_codes_only() {
        let r = rig();
        let w = |s: &str| s.to_string();
        record_restore_with(&r.ctx, NOW, "aaaa1111", "restored", None, &[w("PHOTOS_SOME_MISSING"), w("free text with spaces"), w(r"E:\x"), w("")]);
        assert_eq!(last_restore(&r).unwrap().warnings, ["PHOTOS_SOME_MISSING"]);
        record_restore(&r.ctx, NOW, "aaaa1111", "restored", None);
        assert!(last_restore(&r).unwrap().warnings.is_empty());
    }

    #[test]
    fn a_restore_whose_final_backup_failed_records_that_warning_for_the_status_task() {
        let r = rig();
        keys(&r);
        let m = live_mock(LEVEL_MAX, 200);
        let e = Rc::new(restic_fake(LEVEL_MAX).on("FROM supabase_migrations.schema_migrations", 0, &format!("3|{LEVEL_MAX}\n")).on("has_function_privilege", 0, "t\n"));
        let shared = fresh();
        shared.borrow_mut().dbs.insert(crate::ops::names::NEXT.to_string(), "old"); // what create_and_load builds
        let s2 = shared.clone();
        let port = m.port;
        let make = move |_: &Env, _: &str| -> R<Box<dyn crate::ops::world::World>> { Ok(Box::new(FakeWorld(s2.clone()))) };
        run_restore_with_seams(&r.env, &r.ctx, &args(), None, deps(e), &make, Arc::new(AtomicU64::new(u64::MAX)), &|w: &mut RestoreWork| {
            w.internal = format!("127.0.0.1:{port}");
            w.canary_fn = Some(Box::new(|| Ok(())));
            w.backup_fn = Some(Box::new(|_| Err(BackupError::backup_failed("copy failed"))));
        })
        .unwrap();
        assert!(last_restore(&r).unwrap().warnings.iter().any(|w| w == "POST_RESTORE_BACKUP_FAILED"), "{:?}", last_restore(&r));
    }
    #[test]
    fn the_production_entry_refuses_a_dev_root_before_it_touches_anything() {
        let r = rig();
        assert!(r.ctx.is_dev());
        let err = run_restore(&r.env, &r.ctx, &args(), None).unwrap_err();
        assert_eq!(err.code, Code::Usage);
        assert!(err.message.contains("--dev"), "{}", err.message);
        assert!(no_run_folders(&r));
    }
}
