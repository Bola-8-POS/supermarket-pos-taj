//! The update-specific middle of the operation (procedure B of S8).
//! Every error text leaves through `mig()` / `vf()`, which scrub it (connection strings, passwords, known secrets):
//! the runner copies these messages into the journal and the outcome.
use crate::ops::hooks;
use crate::ops::journal::Journal;
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::probe::http_get;
use crate::ops::proc::run_with_timeout;
use crate::ops::real::{redact, scrub};
use crate::ops::swap::{kill_margin_ms, PsqlAdmin, RealDb, StmtClass};
use crate::ops::world::{BackupReason, OpCtx, OpWork, R};
use crate::runorder::{self, Rerun, RunOrder, Step};
use crate::update::catalog::{self, CATALOG_SQL};
use crate::update::cluster::{changed_sections, parse_cluster, CLUSTER_SQL};
use crate::update::invariants::{rows_lost, INVARIANTS_SQL, ROWS_SQL};
use crate::update::manifest::{verify_files, Manifest};
pub use crate::update::manifest::{auth_plan, needs_auth_migrate, AuthPlan};

use crate::update::Env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const LEVEL_SQL: &str = "SELECT count(*)::text || '|' || COALESCE(max(version)::text, '') FROM supabase_migrations.schema_migrations";
pub const AUTH_LEVEL_SQL: &str = "SELECT count(*)::text || '|' || COALESCE(max(version)::text, '') FROM auth.schema_migrations";
pub const STORE_VERSION_SQL: &str = "SELECT max_version::text || '|' || applied::text FROM public.store_schema_version";
pub const HOOK_SQL: &str = "SELECT to_regprocedure('pos_lockout.password_verification_hook(jsonb)') IS NOT NULL"; // psql prints t / f


fn mig(reason: &str, msg: impl Into<String>) -> OpError { OpError::new(OpCode::MigrationFailed, reason, scrub(&msg.into(), &[])) }
fn vf(msg: impl Into<String>) -> OpError { OpError::new(OpCode::VerifyFailedRolledBack, "VERIFY_FAILED", scrub(&msg.into(), &[])) }

/// The reasons this module raises as MIGRATION_FAILED (14) and as VERIFY_FAILED_ROLLED_BACK (15). The journal keeps only the reason,
/// so `commands::update::code_for_reason` maps it back to its code from these two lists; a test scans this file's own source and
/// fails when a reason is raised without being listed (or listed without being raised).
pub(crate) const MIGRATION_REASONS: &[&str] = &["MIGRATION_FAILED", "MIGRATION_TIMEOUT", "RUN_ORDER", "STUBS", "STAGE_FAILED", "STAGE_COUNT", "AUTH_MIGRATE",
    "AUTH_MIGRATE_TIMEOUT", "CLUSTER_DIGEST_FAILED", "PACK_SQL_FAILED", "AUTH_LEVEL_MISMATCH", "CLUSTER_CHANGED", "VIEW_MISMATCH", "HOOK_MISSING",
    "CATALOG_MISSING", "CATALOG_MISMATCH", "INVARIANT_BROKEN", "AUTH_SNAPSHOT_MISSING", "GOTRUE_MIGRATIONS_MAX_MISSING", "LIVE_AUTH_CHANGED",
    "ROWS_UNREADABLE", "ROWS_LOST", "LEVEL_MISMATCH"]; // LEVEL_MISMATCH: `verify_clone` passes `mig` to `expect_level`
pub(crate) const VERIFY_REASONS: &[&str] = &["VERIFY_FAILED"];

/// The timeout of each HTTP probe `verify_live` makes (functions health, the version view, GoTrue health, a service-role read).
pub(crate) const VERIFY_PROBE_SECS: u64 = 5;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What one statement may take, by class (the deadline is `RECOVERY_FLAG` during recovery):
///
/// | class | normal run | recovery |
/// |---|---|---|
/// | Quick (rename, ALTER ROLE, terminate) | 60 s | 60 s |
/// | Default (queries, SQL steps, DROP) | min(10 min, remaining) | 10 min |
/// | Heavy (clone, REINDEX, db push) | min(2 h, remaining) | 10 min |
///
/// "remaining" is the deadline minus now, never below one minute (a step that starts a second before the deadline still
/// gets a minute; the runner's own deadline check decides whether it starts at all).
/// The top bit of the shared deadline cell marks a RECOVERY. A recovery has no end time (the store is already down, so the clock never
/// holds it back): the low bits are not read, and a statement is capped at 10 minutes flat. `u64::MAX` carries the same flag.
pub const RECOVERY_FLAG: u64 = 1 << 63;
pub const TEN_MIN_MS: u64 = 600_000;
/// The least a statement is given, however close the deadline is (also what a rollback statement gets after the deadline has passed).
pub const STMT_FLOOR_MS: u64 = 60_000;

pub fn statement_budget_ms(class: StmtClass, deadline_ms: u64, now: u64) -> u64 {
    const TEN_MIN: u64 = TEN_MIN_MS;
    const TWO_H: u64 = 7_200_000;
    const FLOOR: u64 = STMT_FLOOR_MS;
    let recovery = deadline_ms & RECOVERY_FLAG != 0;
    // recovery: no time end, only the flat cap below
    let remaining = if recovery { u64::MAX } else { deadline_ms.saturating_sub(now).max(FLOOR) };
    match class {
        StmtClass::Quick => 60_000,
        StmtClass::Default => remaining.min(TEN_MIN),
        StmtClass::Heavy if recovery => remaining.min(TEN_MIN),
        StmtClass::Heavy => remaining.min(TWO_H),
    }
}

/// The maintenance window must still be open: a deadline that is not in the future is a budget failure (rollback), never a
/// run on the one-minute floor of the statement caps. Checked before every step of the work, not only between phases.
pub fn window_open(deadline_ms: u64, now_ms: u64) -> R<()> {
    if deadline_ms <= now_ms {
        return Err(OpError::new(OpCode::RolledBack, "MAINTENANCE_BUDGET", "the maintenance budget was used up; the update is undone and the live database is as it was"));
    }
    Ok(())
}

/// Values of a dotenv file that must never be printed: every non-trivial value (JWT secret, SMTP and hook secrets...).
fn dotenv_secrets(text: &str) -> Vec<String> {
    text.lines().filter_map(|l| l.split_once('=')).map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string()).filter(|v| v.len() >= 8).collect()
}

/// The `db push` URL. The statement and lock timeouts ride in the URL (`options=-c ...`, percent-encoded) as well as in
/// PGOPTIONS, because the supabase CLI's driver may honour only one of them; the Sandbox asserts which.
pub fn push_url(port: u16, db: &str, statement_ms: u64) -> String {
    let opts = format!("-c statement_timeout={statement_ms} -c lock_timeout=10s");
    let enc: String = opts.bytes().map(|b| match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(), _ => format!("%{b:02X}") }).collect();
    format!("postgresql://postgres@127.0.0.1:{port}/{db}?sslmode=disable&options={enc}")
}

/// Never `--include-all` (S6/S8: it would apply out-of-order files). No password in argv: libpq reads PGPASSFILE.
pub fn push_args(url: &str, workdir: &Path) -> Vec<String> {
    ["db", "push", "--db-url", url, "--yes", "--workdir", &workdir.display().to_string()].iter().map(|s| s.to_string()).collect()
}
/// The `rerun: every-update` steps of the pack's run-order.json, in file order (R18/R19). The file itself comes from
/// `runorder::load` (psqlArgs allow-list, safe paths, role allow-list, pinned stub folder, one db-push, unknown kinds and
/// fields refused, BOM stripped), so nothing here re-parses it.
#[derive(Debug)]
pub struct UpdatePlan { pub order: RunOrder, pub steps: Vec<Step> }

pub fn plan_update_steps(order: RunOrder) -> R<UpdatePlan> {
    let steps: Vec<Step> = order.steps.iter().filter(|s| s.rerun() == Rerun::EveryUpdate).cloned().collect();
    let push = steps.iter().position(|s| matches!(s, Step::DbPush { .. })).ok_or_else(|| mig("RUN_ORDER", "run-order.json has no every-update db-push"))?;
    if !steps[push + 1..].iter().any(|s| matches!(s, Step::Sql { .. })) {
        return Err(mig("RUN_ORDER", "run-order.json has no SQL step after db-push to re-apply"));
    }
    Ok(UpdatePlan { order, steps })
}

/// Stub files a crashed update may leave in the RUNNING pack (the vector stub is the only one the packs use).
const KNOWN_STUBS: [&str; 2] = ["vector.control", "vector--0.0.1.sql"];
const STUB_DIR: &str = "pg/share/extension";
const MIGRATE_ENV: &str = "gotrue-migrate.env";

/// Copies the extension stubs into the running server's share folder and removes them again on drop, so a later
/// `CREATE EXTENSION vector` cannot succeed silently (S6 REVIEW 6). The pg_net stub is permanent in the pack.
pub struct StubGuard { files: Vec<PathBuf> }
impl StubGuard {
    pub fn install(running_pack: &Path, new_pack: &Path, files: &[String], dest_dir: &str) -> R<StubGuard> {
        let mut g = StubGuard { files: vec![] };
        for src in files {
            let name = Path::new(src).file_name().ok_or_else(|| mig("STUBS", "bad stub path"))?;
            let dest = running_pack.join(dest_dir).join(name);
            g.files.push(dest.clone()); // registered first so a failed copy is also cleaned up
            std::fs::copy(new_pack.join(src), &dest).map_err(|e| mig("STUBS", format!("{src}: {e}")))?;
        }
        Ok(g)
    }
}
impl Drop for StubGuard { fn drop(&mut self) { for f in &self.files { let _ = std::fs::remove_file(f); } } }

/// A file holding secrets that exists only for one run.
struct TempSecretFile(PathBuf);
impl Drop for TempSecretFile { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

/// gotrue.env with its DATABASE_URL replaced by the clone's. GoTrue 2.197.0 loads `-c <file>` with godotenv.Overload, so a
/// DATABASE_URL in the file beats the environment: the file itself must name the clone. No password in it (PGPASSFILE).
fn migrate_env_text(live_env: &str, clone_url: &str) -> String {
    let mut out = String::new();
    // every key that names a database URL goes (DATABASE_URL, GOTRUE_DB_DATABASE_URL, ...): GoTrue's config prefix means any of
    // them could win over the clone's
    let is_db_url = |l: &str| l.trim_start().trim_start_matches("export ").split('=').next().is_some_and(|k| k.trim().to_uppercase().ends_with("DATABASE_URL"));
    for l in live_env.lines().filter(|l| !is_db_url(l)) {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str(&format!("DATABASE_URL={clone_url}\n"));
    out
}

/// A child's saved logs hold whatever it printed: rewrite them through `redact` (userinfo, passwords, JWTs, known secrets).
fn redact_logs(prefix: &Path, secrets: &[String]) {
    for ext in ["out.log", "err.log"] {
        let p = prefix.with_extension(ext);
        if let Ok(text) = std::fs::read_to_string(&p) { let _ = std::fs::write(&p, redact(&text, secrets)); }
    }
}

/// Closes `supabase_auth_admin` again if `with_auth_login` is left any way but the normal one (an early error, a panic). A close that
/// itself fails cannot be returned from `drop`: its code goes to `logs\posctl\ops\auth-login.log`, no text, and the fence that
/// recovery re-applies first closes the role anyway.
struct LoginGuard<'a> { w: &'a UpdateWork, open: bool }
impl Drop for LoginGuard<'_> {
    fn drop(&mut self) {
        if !self.open { return; }
        if let Err(e) = self.w.set_auth_login(false) {
            let dir = self.w.env.logs_ops();
            let _ = std::fs::create_dir_all(&dir);
            let line = format!("{} AUTH_LOGIN_CLOSE_LOST {}\n", now_ms(), e.reason);
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("auth-login.log")).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
        }
    }
}

pub struct UpdateWork {
    env: Env, admin: PsqlAdmin,
    from: Manifest, to: Manifest, from_dir: PathBuf, to_dir: PathBuf,
    /// The operation's deadline, set from `ctx` at every OpWork call; the psql budget closure reads it.
    deadline: Arc<AtomicU64>,
    /// `count|max` of the LIVE database's auth.schema_migrations before the work: it must be the same after.
    live_auth_before: Option<String>,
    auth_migrated: bool,
    /// The cluster digest taken inside the fence before the work; `verify_clone` compares it with one taken after.
    cluster_before: Option<std::collections::BTreeMap<String, String>>,
    /// A batch-file fake cannot take the real multi-line statements, so tests may replace them all with a one-liner.
    #[cfg(test)]
    test_sql: Option<String>,
    /// Wall clock in ms; a field so a test can make a step "take" the whole window.
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    #[cfg(test)]
    auth_exe: Option<PathBuf>,
    /// A batch-file fake cannot take a multi-line argument, so tests may swap the digest statement for a one-liner.
    #[cfg(test)]
    catalog_sql: Option<String>,
    /// Tests record the role's LOGIN state instead of reaching a server.
    #[cfg(test)]
    login_hook: Option<Box<dyn Fn(bool) -> R<()> + Send + Sync>>,
    /// Tests replace the in-process lockout canary (it needs a live GoTrue and database).
    #[cfg(test)]
    canary_fn: Option<Box<dyn Fn() -> Result<(), crate::envelope::PosctlError> + Send + Sync>>,
    pub warnings: Vec<String>,
}

impl UpdateWork {
    #[cfg(test)]
    pub fn from_journal(j: &Journal, env: &Env) -> R<UpdateWork> { Self::from_journal_with(j, env, Arc::new(AtomicU64::new(u64::MAX))) }

    /// `deadline` is the ONE operation deadline (`u64::MAX` = recovery) shared with the world's psql wrapper.
    pub fn from_journal_with(j: &Journal, env: &Env, deadline: Arc<AtomicU64>) -> R<UpdateWork> {
        let (Some(f), Some(t)) = (&j.pack_from, &j.pack_to) else {
            return Err(OpError::new(OpCode::RecoveryNeeded, "JOURNAL_NO_PACKS", "an update journal must name both packs"));
        };
        let (from_dir, to_dir) = (env.pack_dir(f), env.pack_dir(t));
        Self::sweep_leftovers(env, &from_dir)?; // before anything else, on a normal run and on recovery alike
        let d2 = deadline.clone();
        // Every psql call carries a statement timeout from the operation budget (the server stops the work).
        let admin = PsqlAdmin::new(from_dir.join("pg").join("bin").join("psql.exe"), env.ports.pg(), env.secrets().join("pgpass.conf"))
            .with_budget(move |class| statement_budget_ms(class, d2.load(Ordering::Relaxed), now_ms()));
        let (from, to) = (Manifest::read(&from_dir)?, Manifest::read(&to_dir)?); // signature-verified bytes only
        Self::sweep_verified(&from_dir, &to_dir, &from, &to)?;
        Ok(UpdateWork {
            env: env.clone(), admin, from, to, from_dir, to_dir, deadline,
            live_auth_before: None, auth_migrated: false, cluster_before: None,
            #[cfg(test)] test_sql: None, clock: Arc::new(now_ms),
            #[cfg(test)] auth_exe: None,
            #[cfg(test)] catalog_sql: None,
            #[cfg(test)] login_hook: None,
            #[cfg(test)] canary_fn: None,
            warnings: vec![],
        })
    }

    /// A crash mid-work leaves the vector stub in the running pack's share folder (a later CREATE EXTENSION vector would
    /// then succeed silently) and the per-run GoTrue env file, or its `.tmp` from a crash between create and rename (both
    /// hold secrets), in the secrets folder: remove them. This uses only constants, so it needs no trust in any file.
    fn sweep_leftovers(env: &Env, from_dir: &Path) -> R<()> {
        let names: Vec<String> = KNOWN_STUBS.iter().map(|s| s.to_string()).collect();
        runorder::remove_stubs(from_dir, &names, STUB_DIR).map_err(|e| OpError::new(OpCode::RecoveryNeeded, "STUB_SWEEP_FAILED", scrub(&e, &[])))?;
        let sweep = |p: &Path| match std::fs::remove_file(p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(OpError::new(OpCode::RecoveryNeeded, "ENV_SWEEP_FAILED", e.to_string())),
        };
        sweep(&env.secrets().join(MIGRATE_ENV))?;
        let tmp_prefix = format!(".{MIGRATE_ENV}.");
        if let Ok(rd) = std::fs::read_dir(env.secrets()) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with(&tmp_prefix) && n.ends_with(".tmp") { sweep(&e.path())?; }
            }
        }
        Ok(())
    }

    /// The stub names a pack's own run-order lists, read only AFTER its manifest signature verified and the run-order's hash
    /// matched, from both packs: whatever a past or future pack may have copied.
    fn sweep_verified(from_dir: &Path, to_dir: &Path, from: &Manifest, to: &Manifest) -> R<()> {
        let mut names: Vec<String> = vec![];
        for (dir, m) in [(from_dir, from), (to_dir, to)] {
            if verify_files(dir, m, &["sql/run-order.json"]).is_err() { continue; }
            if let Ok(o) = runorder::load(dir) {
                for s in &o.steps { if let Step::RemoveExtensionStubs { files, .. } = s { names.extend(files.iter().cloned()); } }
            }
        }
        names.sort();
        names.dedup();
        runorder::remove_stubs(from_dir, &names, STUB_DIR).map_err(|e| OpError::new(OpCode::RecoveryNeeded, "STUB_SWEEP_FAILED", scrub(&e, &[])))
    }

    fn now(&self) -> u64 { (self.clock)() }
    fn arm(&self, ctx: &OpCtx) { self.deadline.store(ctx.deadline_ms, Ordering::Relaxed); }
    fn db(&self) -> RealDb { RealDb { admin: self.admin.clone() } }
    fn addr(&self, p: u16) -> String { format!("127.0.0.1:{p}") }

    fn stage_migrations(&self) -> R<()> {
        let dir = self.env.data.join("work").join("supabase").join("migrations");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| mig("STAGE_FAILED", e.to_string()))?;
        let mut n = 0u32;
        for e in std::fs::read_dir(self.to_dir.join("migrations")).map_err(|e| mig("STAGE_FAILED", e.to_string()))?.flatten() {
            if e.file_name().to_string_lossy().ends_with(".sql") {
                std::fs::copy(e.path(), dir.join(e.file_name())).map_err(|e| mig("STAGE_FAILED", e.to_string()))?;
                n += 1;
            }
        }
        if n != self.to.migrations.count { return Err(mig("STAGE_COUNT", format!("staged {n} files, manifest says {}", self.to.migrations.count))); }
        Ok(())
    }

    /// The kill timer of every child this work starts (the server-side statement timeouts come first).
    fn child_limit(&self, ctx: &OpCtx) -> Duration {
        Duration::from_millis(statement_budget_ms(StmtClass::Heavy, ctx.deadline_ms, now_ms()).saturating_add(kill_margin_ms(StmtClass::Heavy)))
    }

    fn auth_exe(&self) -> PathBuf {
        #[cfg(test)]
        if let Some(p) = &self.auth_exe { return p.clone(); }
        self.to_dir.join("bin").join("auth.exe")
    }

    /// GoTrue's own migrations on the clone. GoTrue loads `-c <file>` with godotenv.Overload (the FILE beats the
    /// environment), and gotrue.env names the LIVE database, so a per-run copy whose DATABASE_URL is the clone's is passed
    /// instead; it is removed afterwards, on failure too. The password is in neither the file, the argv nor the environment:
    /// libpq (pgx) finds it in PGPASSFILE. The password file is read only so its value can be scrubbed from anything printed.
    fn auth_migrate(&self, ctx: &OpCtx) -> R<()> {
        let secrets = self.env.secrets();
        let pw = crate::util::read_secret_file(&secrets.join("pg-supabase_auth_admin.pw")).map(|s| s.expose().trim().to_string()).map_err(|e| mig("AUTH_MIGRATE", e.to_string()))?;
        let live_env = std::fs::read_to_string(secrets.join("gotrue.env")).map_err(|e| mig("AUTH_MIGRATE", e.to_string()))?;
        let (user, host, port, db) = ("supabase_auth_admin", "127.0.0.1", self.env.ports.pg(), &ctx.names.next);
        let url = format!("postgres://{user}@{host}:{port}/{db}?sslmode=disable");
        let file = secrets.join(MIGRATE_ENV);
        let _ = std::fs::remove_file(&file);
        crate::util::write_atomic(&file, migrate_env_text(&live_env, &url).as_bytes()).map_err(|e| mig("AUTH_MIGRATE", e.to_string()))?;
        let _guard = TempSecretFile(file.clone());
        let mut scrub_list = dotenv_secrets(&live_env);
        scrub_list.push(pw.clone());
        let mut c = Command::new(self.auth_exe());
        c.args(["-c", &file.display().to_string(), "migrate"]);
        // scrub FIRST: it removes every PG* name in the parent env, so a PGPASSFILE set before it would be wiped too
        crate::pg::scrub_pg_env(&mut c);
        c.env("DATABASE_URL", &url).env("PGPASSFILE", secrets.join("pgpass.conf"));
        if let Some(d) = self.auth_exe().parent() { c.current_dir(d); }
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().to_uppercase().starts_with("GOTRUE_") { c.env_remove(&k); }
        }
        let prefix = self.env.logs_ops().join("auth-migrate");
        let r = run_with_timeout(c, &prefix, self.child_limit(ctx));
        redact_logs(&prefix, &scrub_list);
        let r = r?;
        if r.timed_out { return Err(mig("AUTH_MIGRATE_TIMEOUT", "the GoTrue migration outlived the maintenance budget")); }
        if r.code != Some(0) { return Err(OpError::new(OpCode::MigrationFailed, "AUTH_MIGRATE", scrub(&r.stderr_tail, &scrub_list))); }
        Ok(())
    }

    fn set_auth_login(&self, login: bool) -> R<()> {
        #[cfg(test)]
        if let Some(f) = &self.login_hook { return f(login); }
        self.db().set_login(&["supabase_auth_admin".to_string()], login)
    }

    /// The fence turned `supabase_auth_admin` NOLOGIN and the migration connects as exactly that role: open it for the migration
    /// only (the internal stack is stopped and the LAN is fenced), and close it again on EVERY exit. A crash in between is
    /// closed by the fence recovery re-applies first.
    fn auth_migrate_with_login(&self, ctx: &OpCtx) -> R<()> { self.with_auth_login(|| self.auth_migrate(ctx)) }

    /// Opens the role, runs `f`, and closes the role again from a Drop guard: the close runs on an error return AND on a panic.
    fn with_auth_login<T>(&self, f: impl FnOnce() -> R<T>) -> R<T> {
        let mut guard = LoginGuard { w: self, open: true }; // armed before the grant: a half-granted login is closed too
        self.set_auth_login(true)?;
        let v = f();
        guard.open = false;
        let closed = self.set_auth_login(false);
        let v = v?;
        closed?;
        Ok(v)
    }

    fn pick<'a>(&'a self, real: &'a str) -> &'a str {
        #[cfg(test)]
        if let Some(q) = &self.test_sql { return q; }
        real
    }
    /// The cluster digest right now, as supabase_admin on template1.
    fn cluster_snapshot(&self) -> R<std::collections::BTreeMap<String, String>> {
        let out = self.admin.scalar_class("template1", self.pick(CLUSTER_SQL), StmtClass::Default)
            .map_err(|e| mig("CLUSTER_DIGEST_FAILED", e.message))?;
        parse_cluster(&out)
    }

    /// FR14: WHAT differs, for the operator and the CI that built the digest. Per-section `name=count:hash8` of the clone and of the pre-update live
    /// database (both fenced), never a raw line. The text goes through `mig()`'s scrub like every error. Best effort: a failing query says so.
    fn catalog_detail(&self, clone: &str, live: &str, got: &str, want: &str) -> String {
        let q = catalog::sections_sql();
        let sections = |db: &str| match self.admin.scalar_class(db, &q, StmtClass::Default) {
            Ok(o) => catalog::describe_sections(&o),
            Err(e) => format!("unavailable {}", e.reason),
        };
        let short = |d: &str| d.chars().take(8).collect::<String>();
        let text = format!("; digest {} declared {}; clone [{}]; live [{}]", short(got), short(want), sections(clone), sections(live));
        #[cfg(feature = "test-hooks")]
        self.dump_catalog_lines(clone, live);
        text
    }

    /// Hooks build only: every line the digest hashes, for the clone and for live, next to the other ops logs (a scenario copies them out and diffs).
    #[cfg(feature = "test-hooks")]
    fn dump_catalog_lines(&self, clone: &str, live: &str) {
        let q = catalog::lines_sql();
        let dir = self.env.logs_ops();
        let _ = std::fs::create_dir_all(&dir);
        for (db, file) in [(clone, "catalog-lines-clone.txt"), (live, "catalog-lines-live.txt")] {
            if let Ok(o) = self.admin.scalar_class(db, &q, StmtClass::Default) { let _ = std::fs::write(dir.join(file), o); }
        }
    }

    fn catalog_sql(&self) -> &str {
        #[cfg(test)]
        if let Some(q) = &self.catalog_sql { return q; }
        CATALOG_SQL
    }

    fn plan(&self) -> R<UpdatePlan> {
        let o = runorder::load(&self.to_dir).map_err(|e| mig("RUN_ORDER", e))?;
        plan_update_steps(o)
    }

    /// One `kind: "sql"` step of run-order.json: as its `runAs` role, its variables from the role password files, over stdin.
    fn run_step(&self, db: &str, order: &RunOrder, st: &Step) -> R<()> {
        let Step::Sql { id, file, run_as, vars: names, single_transaction, .. } = st else { return Ok(()) };
        let mut vars = vec![];
        for v in names {
            let role = order.var_roles.get(v).ok_or_else(|| mig("RUN_ORDER", format!("no role for variable {v}")))?;
            let pw = crate::util::read_secret_file(&self.env.secrets().join(format!("pg-{role}.pw"))).map(|s| s.0).map_err(|e| mig("PACK_SQL_FAILED", e.to_string()))?;
            vars.push((v.clone(), pw.trim().to_string()));
        }
        self.admin.with_user(run_as).run_file_opts(db, &self.to_dir.join(file), &vars, *single_transaction, &order.psql_args)
            .map_err(|e| mig("PACK_SQL_FAILED", format!("{id}: {}", e.message)))
    }

    fn push(&self, ctx: &OpCtx) -> R<()> {
        let ms = statement_budget_ms(StmtClass::Heavy, ctx.deadline_ms, now_ms());
        let url = push_url(self.env.ports.pg(), &ctx.names.next, ms);
        let mut c = Command::new(self.to_dir.join("tools").join("supabase.exe"));
        c.args(push_args(&url, &self.env.data.join("work")));
        crate::pg::scrub_pg_env(&mut c);
        c.current_dir(self.env.data.join("work"));
        c.env("PGPASSFILE", self.env.secrets().join("pgpass.conf"))
            .env("PGOPTIONS", format!("-c lock_timeout=10s -c statement_timeout={ms}"))
            .env("SUPABASE_TELEMETRY_DISABLED", "1").env("SUPABASE_NO_UPDATE_NOTIFIER", "1").env("DOCKER_HOST", "tcp://127.0.0.1:9");
        let prefix = self.env.logs_ops().join("db-push");
        let r = run_with_timeout(c, &prefix, self.child_limit(ctx));
        redact_logs(&prefix, &[]);
        let r = r?;
        // A killed CLI leaves server-side work running (S8 case c): the clone is dropped WITH (FORCE) on rollback, which ends it.
        if r.timed_out { return Err(mig("MIGRATION_TIMEOUT", "the migration outlived the maintenance budget")); }
        if r.code != Some(0) { return Err(mig("MIGRATION_FAILED", r.stderr_tail)); }
        Ok(())
    }

    fn level(&self, db: &str) -> R<String> {
        self.admin.scalar_class(db, LEVEL_SQL, StmtClass::Quick)
    }
    /// `count|max` of GoTrue's own migration table.
    fn auth_level(&self, db: &str) -> R<String> {
        self.admin.scalar_class(db, AUTH_LEVEL_SQL, StmtClass::Quick)
    }
    fn expect_level(&self, db: &str, m: &Manifest, mk: impl Fn(&str, String) -> OpError) -> R<()> {
        let got = self.level(db)?;
        let want = format!("{}|{}", m.migrations.count, m.migrations.max);
        if got != want { return Err(mk("LEVEL_MISMATCH", format!("{db} is at {got}, expected {want}"))); }
        Ok(())
    }
    fn keys(&self) -> R<(String, String)> {
        let v: serde_json::Value = serde_json::from_str(crate::util::read_secret_file(&self.env.secrets().join("keys.json")).map_err(|e| vf(e.to_string()))?.expose())
            .map_err(|e| vf(e.to_string()))?;
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string).ok_or_else(|| vf(format!("keys.json has no {k}")));
        Ok((get("anon")?, get("service_role")?))
    }
    /// The schema-version view through the INTERNAL listener, exactly as the tills will read it through the LAN one.
    fn check_view(&self, m: &Manifest) -> R<()> {
        let (anon, _) = self.keys()?;
        let (s, body) = http_get(&self.addr(self.env.ports.gateway_internal()), "/rest/v1/store_schema_version?select=max_version,applied", &[("apikey", &anon)], Duration::from_secs(5))?;
        let rows: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap_or_default();
        let ok = s == 200 && rows.len() == 1
            && rows[0]["max_version"].as_str() == Some(m.migrations.max.as_str())
            && rows[0]["applied"].as_u64() == Some(m.migrations.count as u64);
        if ok { Ok(()) } else { Err(vf(format!("the version view answered {s} {}", body.chars().take(120).collect::<String>()))) }
    }
}

impl UpdateWork {
    /// The PIN-lockout proof, IN PROCESS: a `posctl health --canary` child would skip itself while the journal is open and could not
    /// take update.lock (held exclusive here), and `health` reports an update in progress as fine, so the lockout was never checked.
    /// It runs the same check as the boot task and `provision` (`canary::run_for_update`), against the NEW pack's psql: the dedicated
    /// canary account (state\canary.json, no profiles row, its own lock keys `gt:<id>`/`login:<id>`) is the only one that gets five
    /// wrong grants, and its lock keys are deleted before and after. A pass stamps canary.json `lastRunAt`/`lastOk: true`; a failure
    /// writes NOTHING (the update rolls back, and a `lastOk: false` would outlive that and gate sign-in on a healthy stack).
    /// The canary is bounded by what is left of the update budget (capped at 120 s inside). A recovery has no time end (its deadline is
    /// RECOVERY_FLAG), so the canary gets the same flat 10 minutes as a statement.
    fn lockout_canary(&self, ctx: &OpCtx) -> R<()> {
        #[cfg(test)]
        if let Some(f) = &self.canary_fn { return f().map_err(|e| vf(format!("the lockout canary failed: {}", e.message))); }
        let (anon, svc) = self.keys()?;
        let psql = crate::pg::Psql { tools: crate::pg::PgTools::for_pack(&self.to_dir), port: self.env.ports.pg(), pgpass: self.env.roots.pgpass() };
        let ep = crate::firstadmin::Endpoint { internal_url: format!("http://127.0.0.1:{}", self.env.ports.gateway_internal()),
            anon_key: crate::util::Secret(anon), service_key: crate::util::Secret(svc) };
        let left = if ctx.deadline_ms & RECOVERY_FLAG != 0 { TEN_MIN_MS } else { ctx.deadline_ms.saturating_sub(now_ms()) };
        crate::canary::run_for_update(&self.env.roots, &self.env.ports, &psql, &ep, Duration::from_millis(left)).map_err(|e| vf(format!("the lockout canary failed: {}", e.message)))
    }

    fn work_steps(&mut self, ctx: &OpCtx) -> R<()> {
        hooks::fail("migrate")?;
        let live = ctx.names.live.clone();
        self.steps_on_clone(ctx, &live, false)
    }

    /// Plan 08 `backup restore --swap`: the update's own sequence (the pack's every-update steps, GoTrue's migrate, `db push`) on the
    /// clone `ctx.names.next`, which holds a restored OLDER snapshot. The GoTrue decision reads the restored database's own
    /// `auth.schema_migrations` (the pack manifest says nothing about the snapshot's build). Called by `backup::restore_work` with a
    /// synthetic journal naming the running pack as both `from` and `to`.
    pub(crate) fn migrate_restored(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        let next = ctx.names.next.clone();
        self.steps_on_clone(ctx, &next, true)
    }

    /// `level_db` is the database whose GoTrue level decides (an update: the LIVE one; a restore: the restored clone).
    /// `unknown_build`: the snapshot's GoTrue build is unknown, so a pack that declares no `gotrueMigrationsMax` cannot rule the
    /// migration out by label; GoTrue's `migrate` is a no-op on a database that already has it.
    fn steps_on_clone(&mut self, ctx: &OpCtx, level_db: &str, unknown_build: bool) -> R<()> {
        verify_files(&self.to_dir, &self.to, &["migrations/", "sql/", "tools/supabase.exe", "bin/auth.exe"]).map_err(|e| mig(&e.reason, e.message))?;
        self.stage_migrations()?;
        let plan = self.plan()?; // sql\run-order.json is the only authority (conventions 17), never section 7's prose
        // GoTrue's migrations must land on the clone and nowhere else: remember what the LIVE database looks like now.
        let live_auth = self.auth_level(level_db)?;
        self.live_auth_before = Some(live_auth.clone());
        self.auth_migrated = false;
        // decided once, on the level read under the operation lock, before any step touches the clone
        let mut auth = auth_plan(&self.from, &self.to, &live_auth);
        if unknown_build && auth == AuthPlan::Skip && self.to.gotrue_migrations_max.is_none() { auth = AuthPlan::Migrate; }
        if let AuthPlan::Refuse(why) = &auth { return Err(mig("AUTH_LEVEL_MISMATCH", why.clone())); }
        // The vector stub sits in the RUNNING server's share folder only while `db push` runs, and goes even on failure
        // (the guard's Drop is the `always` step: it runs on every early return below).
        let mut stubs: Option<StubGuard> = None;
        for st in &plan.steps {
            window_open(ctx.deadline_ms, self.now())?; // before EVERY step, not only between the runner's phases
            match st {
                Step::CopyExtensionStubs { files, to, .. } => stubs = Some(StubGuard::install(&self.from_dir, &self.to_dir, files, to)?),
                Step::GotrueMigrate { .. } => { if auth == AuthPlan::Migrate { self.auth_migrate_with_login(ctx)?; self.auth_migrated = true; } }
                Step::Sql { .. } => self.run_step(&ctx.names.next, &plan.order, st)?,
                Step::DbPush { .. } => self.push(ctx)?,
                Step::RemoveExtensionStubs { .. } => { stubs = None; }
            }
        }
        drop(stubs);
        Ok(())
    }
}

impl OpWork for UpdateWork {
    fn kind(&self) -> OpKind { OpKind::Update }
    fn backup_reason(&self) -> BackupReason { BackupReason::PreUpdate }

    fn warnings(&self) -> Vec<String> { self.warnings.clone() }

    /// Before the clone, on the SOURCE (a clone of a template with a mismatching collation version is refused, so the clone itself
    /// can never need this: it inherits the refreshed version, and its binary is the running one until `activate`).
    /// Idempotent: a repeat finds no mismatch. A rollback leaves it alone; a refreshed version is not something to undo.
    fn repair_source(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        let db = self.db();
        if db.collation_mismatch(&ctx.names.live)? { db.repair_collation(&ctx.names.live)?; self.warnings.push("COLLATION_REPAIRED_ON_SOURCE".into()); }
        Ok(())
    }

    fn work_on_clone(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        // inside the fence, before any step: what the cluster looks like now
        self.cluster_before = Some(self.cluster_snapshot()?);
        let r = self.work_steps(ctx);
        if r.is_err() {
            // rollback drops the clone but cannot undo a role, a setting or a slot: say so if the failed work moved any of them
            if let (Some(before), Ok(after)) = (self.cluster_before.clone(), self.cluster_snapshot()) {
                if !changed_sections(&before, &after).is_empty() { self.warnings.push("CLUSTER_CHANGED_ON_FAILED_WORK".into()); }
            }
        }
        r
    }

    fn verify_clone(&mut self, ctx: &OpCtx) -> R<()> {
        // Whatever the checks could not even run (psql gone, the clone unreadable) is still a failed migration, never a bare error.
        self.verify_clone_checks(ctx).map_err(|e| if e.code == OpCode::Error { mig(&e.reason, e.message) } else { e })
    }

    fn after_activate(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        let db = self.db();
        if db.collation_mismatch(&ctx.names.live)? { db.repair_collation(&ctx.names.live)?; self.warnings.push("COLLATION_REPAIRED_AFTER_ACTIVATE".into()); }
        Ok(())
    }

    /// Behind the fence. Reads and health only: it never creates a sale (S8 review C1).
    fn verify_live(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        hooks::fail("verify_live")?;
        // An unreachable service or a failing query is a failed verification (rolled back, exit 15), not a bare error (exit 16).
        self.verify_live_checks(ctx).map_err(|e| if e.code == OpCode::Error { vf(format!("{}: {}", e.reason, e.message)) } else { e })
    }

    fn verify_after_rollback(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        self.expect_level(&ctx.names.live, &self.from, OpError::err)?;
        self.check_view(&self.from).map_err(|e| OpError::err("ROLLBACK_VERIFY", e.message))
    }

    fn on_commit(&mut self, ctx: &OpCtx) -> R<()> {
        let to = ctx.pack_to.clone().unwrap_or_default();
        // v1.6: in process (update.lock is held exclusive by this process); a child `posctl pack activate` exits 10 LOCK_HELD.
        // The same function the world uses for `activate_pack` (FR4's Activator), with `set_current = true`.
        (self.env.activate)(&self.env.roots, &to, true).map_err(|e| OpError::err("SET_CURRENT_FAILED", scrub(&e, &[])))
    }
}

impl UpdateWork {
    fn verify_clone_checks(&mut self, ctx: &OpCtx) -> R<()> {
        self.arm(ctx);
        window_open(ctx.deadline_ms, self.now())?;
        // first: did the work leave the cluster alone? (section names only, never a hash)
        let after = self.cluster_snapshot()?;
        let Some(before) = self.cluster_before.clone() else {
            return Err(mig("CLUSTER_DIGEST_FAILED", "the cluster digest was not recorded before the work"));
        };
        let changed = changed_sections(&before, &after);
        if !changed.is_empty() {
            return Err(mig("CLUSTER_CHANGED", format!("the work changed the cluster ({}); dropping the clone cannot undo that", changed.join(", "))));
        }
        let n = &ctx.names.next;
        self.expect_level(n, &self.to, mig)?;
        let v = self.admin.scalar(n, STORE_VERSION_SQL)?;
        if v != format!("{}|{}", self.to.migrations.max, self.to.migrations.count) { return Err(mig("VIEW_MISMATCH", format!("store_schema_version says {v}"))); }
        if self.admin.scalar(n, HOOK_SQL)? != "t" {
            return Err(mig("HOOK_MISSING", "the lockout hook function is absent on the clone"));
        }
        // Fail closed: a release without a catalog digest cannot prove its grants, policies and functions.
        let Some(c) = &self.to.catalog else {
            return Err(mig("CATALOG_MISSING", "the pack's manifest has no catalog digest; this release cannot be verified"));
        };
        let got = self.admin.scalar(n, self.catalog_sql())?;
        if !got.eq_ignore_ascii_case(c.digest.trim()) {
            let detail = self.catalog_detail(n, &ctx.names.live, &got, c.digest.trim());
            return Err(mig("CATALOG_MISMATCH", format!("grants, policies or functions differ from what the release was built with{detail}")));
        }
        // Absolute invariants, whatever the CI digest says: RLS on, no grant on the PIN column, no slots, the known roles only.
        let broken = self.admin.scalar_class(n, self.pick(INVARIANTS_SQL), StmtClass::Default)?;
        if !broken.trim().is_empty() {
            return Err(mig("INVARIANT_BROKEN", format!("the clone breaks: {}", broken.trim())));
        }
        // GoTrue's own schema: the clone must be at the pack's level, and the LIVE database must not have moved.
        let Some(before) = self.live_auth_before.clone() else {
            return Err(mig("AUTH_SNAPSHOT_MISSING", "the live auth schema level was not recorded before the work"));
        };
        let clone_auth = self.auth_level(n)?;
        let clone_max = clone_auth.split_once('|').map(|(_, m)| m).unwrap_or("");
        match &self.to.gotrue_migrations_max {
            Some(want) if want != clone_max => return Err(mig("AUTH_LEVEL_MISMATCH", format!("the clone's auth.schema_migrations is at {clone_max}, the pack says {want}"))),
            Some(_) => {}
            None if self.auth_migrated => return Err(mig("GOTRUE_MIGRATIONS_MAX_MISSING", "GoTrue was migrated but the pack does not declare gotrueMigrationsMax; the clone's auth level cannot be proven")),
            None if !self.auth_migrated && clone_auth != before => return Err(mig("AUTH_LEVEL_MISMATCH", format!("GoTrue did not change but the clone's auth level is {clone_auth}, the live one {before}"))),
            None => {}
        }
        let live_now = self.auth_level(&ctx.names.live)?;
        if live_now != before {
            return Err(mig("LIVE_AUTH_CHANGED", format!("the live database's auth.schema_migrations moved from {before} to {live_now} during the work")));
        }
        // Last: no data may be lost unless the signed manifest says so. The live database is fenced, so its counts are stable.
        let live_rows = self.admin.scalar_class(&ctx.names.live, self.pick(ROWS_SQL), StmtClass::Default)?;
        let clone_rows = self.admin.scalar_class(n, self.pick(ROWS_SQL), StmtClass::Default)?;
        match rows_lost(&live_rows, &clone_rows, &self.to.data_changes) {
            Err(m) => return Err(mig("ROWS_UNREADABLE", m)),
            Ok(Some(lost)) => return Err(mig("ROWS_LOST", lost)),
            Ok(None) => {}
        }
        Ok(())
    }

    fn verify_live_checks(&mut self, ctx: &OpCtx) -> R<()> {
        // First and before any health probe: the live database must be at exactly the pack's schema level. A migration that
        // applied cleanly but left the wrong level fails here and is swapped back, never reopened.
        self.expect_level(&ctx.names.live, &self.to, |r, m| vf(format!("{r}: {m}")))?;
        self.check_view(&self.to)?;
        let p = self.env.ports;
        let t = Duration::from_secs(VERIFY_PROBE_SECS);
        let (_, svc) = self.keys()?;
        let fh = http_get(&self.addr(p.functions()), "/functions/v1/_health", &[], t)?;
        if fh.0 != 200 || !fh.1.contains("\"functions\":16") { return Err(vf(format!("functions health answered {} {}", fh.0, fh.1))); }
        // PACK_VERSION is compiled into functions.exe (conventions 17): the new program must report the new pack.
        let sh = http_get(&self.addr(p.functions()), "/_store/health", &[], t)?;
        let reported = serde_json::from_str::<serde_json::Value>(&sh.1).ok().and_then(|v| v["packVersion"].as_str().map(str::to_string));
        if sh.0 != 200 || reported.as_deref() != Some(self.to.pack_version.as_str()) {
            return Err(vf(format!("/_store/health reports {:?}, expected {}", reported, self.to.pack_version)));
        }
        if http_get(&self.addr(p.gotrue()), "/health", &[], t)?.0 != 200 { return Err(vf("GoTrue health is not 200")); }
        let bearer = format!("Bearer {svc}");
        let read = http_get(&self.addr(p.gateway_internal()), "/rest/v1/profiles?select=id&limit=1", &[("apikey", &svc), ("Authorization", &bearer)], t)?;
        if read.0 != 200 { return Err(vf(format!("a service-role read answered {}", read.0))); }
        if self.admin.scalar(&ctx.names.live, HOOK_SQL)? != "t" {
            return Err(vf("the lockout hook function is absent"));
        }
        self.lockout_canary(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reason_this_module_raises_is_classified_for_the_recovery_mapping() {
        let src = include_str!("work.rs");
        let prod = &src[..src.find("#[cfg(test)]
mod tests").unwrap()];
        let after = |pat: &str| -> std::collections::BTreeSet<&str> {
            prod.match_indices(pat).map(|(i, _)| { let r = &prod[i + pat.len()..]; &r[..r.find('"').unwrap()] }).collect()
        };
        let mut mig_raised = after("mig(\"");
        mig_raised.extend(after("OpCode::MigrationFailed, \""));
        mig_raised.extend(after("mk(\"")); // `expect_level`'s one reason, raised through whichever constructor its caller passes
        let verify_raised = after("OpCode::VerifyFailedRolledBack, \""); // `vf` is the one constructor, and its reason is VERIFY_FAILED
        assert_eq!(mig_raised, MIGRATION_REASONS.iter().copied().collect(), "MIGRATION_REASONS and the reasons raised as MigrationFailed differ");
        assert_eq!(verify_raised, VERIFY_REASONS.iter().copied().collect(), "VERIFY_REASONS and the reasons raised as VerifyFailedRolledBack differ");
    }
    use crate::ops::names::DbNames;
    use crate::update::manifest::Manifest;

    #[test]
    fn the_cli_is_never_asked_to_include_all_and_gets_no_password() {
        let a = push_args("postgresql://postgres@127.0.0.1:47300/pos_next?sslmode=disable", Path::new(r"C:\ProgramData\SupermarketPOS\work"));
        assert!(a.contains(&"--yes".to_string()) && !a.iter().any(|x| x == "--include-all"));
        assert!(!a.join(" ").to_lowercase().contains("password"));
    }

    #[test]
    fn the_stubs_are_removed_when_the_guard_drops() {
        let (run, new) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::create_dir_all(run.path().join("pg/share/extension")).unwrap();
        std::fs::create_dir_all(new.path().join("sql/stub-extensions")).unwrap();
        std::fs::write(new.path().join("sql/stub-extensions/vector.control"), "x").unwrap();
        std::fs::write(new.path().join("sql/stub-extensions/vector--0.0.1.sql"), "x").unwrap();
        let files = vec!["sql/stub-extensions/vector.control".to_string(), "sql/stub-extensions/vector--0.0.1.sql".to_string()];
        {
            let _g = StubGuard::install(run.path(), new.path(), &files, "pg/share/extension").unwrap();
            assert!(run.path().join("pg/share/extension/vector.control").exists());
        }
        assert!(!run.path().join("pg/share/extension/vector.control").exists());
    }

    #[test]
    fn auth_migrate_binary_runs_only_when_gotrue_changed() {
        let mut f = Manifest::for_test("1.0.0-r1", "1.0.0", 1, "1"); f.set_component("gotrue", "2.196.0");
        let mut t = Manifest::for_test("1.0.1-r1", "1.0.1", 1, "1"); t.set_component("gotrue", "2.196.0");
        assert!(!needs_auth_migrate(&f, &t));
        t.set_component("gotrue", "2.197.0");
        assert!(needs_auth_migrate(&f, &t));
    }

    fn gt(label: &str, max: Option<&str>) -> Manifest {
        let mut m = Manifest::for_test("1.0.1-r1", "1.0.1", 1, "1"); m.set_component("gotrue", label); m.gotrue_migrations_max = max.map(str::to_string); m
    }

    #[test]
    fn auth_migrate_runs_when_the_labels_differ() {
        assert_eq!(auth_plan(&gt("2.196.0", None), &gt("2.197.0", Some("20260301")), "58|20260101"), AuthPlan::Migrate);
        assert_eq!(auth_plan(&gt("2.196.0", None), &gt("2.197.0", None), "58|20260101"), AuthPlan::Migrate, "no declared level: labels decide");
        assert_eq!(auth_plan(&gt("2.196.0", None), &gt("2.197.0", Some("20260301")), "58|20260301"), AuthPlan::Migrate, "a changed build is always migrated");
    }

    #[test]
    fn auth_migrate_runs_when_the_db_trails_the_packs_gotrue_level_with_the_same_build() {
        let (f, t) = (gt("2.197.0", None), gt("2.197.0", Some("20260301")));
        assert_eq!(auth_plan(&f, &t, "58|20260101"), AuthPlan::Migrate);
        assert_eq!(auth_plan(&f, &t, "0|"), AuthPlan::Migrate, "an empty auth.schema_migrations trails too");
        assert_eq!(auth_plan(&f, &t, "60|20260301"), AuthPlan::Skip, "already there: nothing to run");
        assert_eq!(auth_plan(&f, &gt("2.197.0", None), "58|20260101"), AuthPlan::Skip, "no declared level, same build: unchanged behaviour");
    }

    #[test]
    fn auth_level_above_the_packs_gotrue_level_is_refused_never_migrated_down() {
        let (f, t) = (gt("2.197.0", None), gt("2.197.0", Some("20260301")));
        assert!(matches!(auth_plan(&f, &t, "62|20260401"), AuthPlan::Refuse(m) if m.contains("20260401") && m.contains("20260301")));
        assert!(matches!(auth_plan(&gt("2.196.0", None), &t, "62|20260401"), AuthPlan::Refuse(_)), "a changed build does not excuse a downgrade");
    }

    #[test]
    fn the_statement_budget_by_class_normal_run_versus_recovery() {
        use StmtClass::*;
        let now = 1_000_000_000_000u64;
        let h = 3_600_000u64;
        // normal run, plenty left: Quick 60 s, Default 10 min, Heavy up to the 2 h ceiling
        assert_eq!((statement_budget_ms(Quick, now + 10 * h, now), statement_budget_ms(Default, now + 10 * h, now), statement_budget_ms(Heavy, now + 10 * h, now)), (60_000, 600_000, 7_200_000));
        // normal run, 20 minutes left: Default 10 min, Heavy = what is left
        assert_eq!((statement_budget_ms(Default, now + 1_200_000, now), statement_budget_ms(Heavy, now + 1_200_000, now)), (600_000, 1_200_000));
        // deadline already passed: the one-minute floor, never zero
        assert_eq!((statement_budget_ms(Default, now - 5, now), statement_budget_ms(Heavy, now - 5, now)), (60_000, 60_000));
        // recovery (no deadline): nothing is ever longer than 10 minutes, renames stay at 60 s
        assert_eq!((statement_budget_ms(Quick, u64::MAX, now), statement_budget_ms(Default, u64::MAX, now), statement_budget_ms(Heavy, u64::MAX, now)), (60_000, 600_000, 600_000));
    }

    // --- a work object wired to fake tools (a batch file stands in for psql.exe / auth.exe) ---
    const T0: u64 = 1_790_908_215_000;
    const AUTH_PW: &str = "hunter-pw-77";
    const GOTRUE_ENV: &str = "GOTRUE_JWT_SECRET=jwtsecret\nDATABASE_URL=postgres://supabase_auth_admin:hunter-pw-77@127.0.0.1:47300/postgres?sslmode=disable\nGOTRUE_SITE_URL=http://x\n";
    struct Rig { d: tempfile::TempDir, w: UpdateWork }
    fn rig(psql_body: &str, count: u32, max: &str) -> Rig { rig_x(psql_body, count, max, "") }
    /// `extra`: more members for the NEW pack's manifest.json (e.g. a catalog digest), each starting with a comma.
    fn rig_x(psql_body: &str, count: u32, max: &str, extra: &str) -> Rig {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        let prog = d.path().join("prog");
        for (v, c, m, x) in [("1.0.0-r1", 1u32, "20260101", ""), ("1.0.1-r1", count, max, extra)] {
            let dir = prog.join("packs").join(v);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("manifest.json"), format!(r#"{{"schema":1,"packVersion":"{v}","appVersion":"{}","platform":"win-x64","migrations":{{"count":{c},"max":"{m}"}},"files":[]{x}}}"#, &v[..5])).unwrap();
        }
        std::fs::create_dir_all(data.join("secrets")).unwrap();
        crate::util::write_secret_file(&data.join("secrets").join("pg-supabase_auth_admin.pw"), AUTH_PW).unwrap();
        std::fs::write(data.join("secrets").join("gotrue.env"), GOTRUE_ENV).unwrap();
        let psql = d.path().join("psql.cmd");
        std::fs::write(&psql, format!("@echo off\r\n{psql_body}\r\n")).unwrap();
        let roots = crate::paths::Roots::custom(data.clone(), prog.clone());
        let env = Env { data, program: prog, posctl_exe: d.path().join("posctl.exe"), ports: crate::ports::Ports::new(47300).unwrap(),
            roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
        let j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("1.0.0-r1".into()), Some("1.0.1-r1".into()));
        let mut w = UpdateWork::from_journal(&j, &env).unwrap();
        w.admin.psql = psql;
        Rig { d, w }
    }
    fn ctx(deadline_ms: u64) -> OpCtx {
        OpCtx { op_id: "op".into(), names: DbNames::for_kind(OpKind::Update, T0), pack_from: Some("1.0.0-r1".into()), pack_to: Some("1.0.1-r1".into()), deadline_ms }
    }
    /// Answers each psql call with the next canned line (`n.txt` counts the calls).
    fn canned(lines: &[&str]) -> String {
        let mut s = "set /p n=<\"%~dp0n.txt\"\r\nset /a n+=1\r\n>\"%~dp0n.txt\" echo %n%".to_string();
        for (i, l) in lines.iter().enumerate() {
            let echoes: Vec<String> = l.split('\n').map(|x| if x.is_empty() { "echo.".to_string() } else { format!("echo {}", x.replace('|', "^|")) }).collect();
            s.push_str(&format!("\r\nif %n%=={} ({})", i + 1, echoes.join("&")));
        }
        s
    }

    #[test]
    fn a_secret_echoed_by_auth_exe_never_reaches_the_error_text() {
        let mut r = rig("exit /b 0", 2, "20260102");
        let auth = r.d.path().join("auth.cmd");
        // the fake prints the connection string it was given (as a crashing GoTrue would) and a bare password line
        std::fs::write(&auth, format!("@echo off\r\necho cannot connect to %DATABASE_URL% 1>&2\r\necho postgres://supabase_auth_admin:{AUTH_PW}@127.0.0.1:47300/x 1>&2\r\necho password=%PGPASSWORD% 1>&2\r\nexit /b 1\r\n")).unwrap();
        r.w.auth_exe = Some(auth);
        let e = r.w.auth_migrate(&ctx(now_ms() + 600_000)).unwrap_err();
        let all = format!("{} {} {e}", e.reason, e.message);
        assert_eq!(e.reason, "AUTH_MIGRATE");
        assert!(!all.contains(AUTH_PW), "password leaked into the error: {all}");
    }

    #[test]
    fn the_saved_child_logs_are_redacted_too() {
        let mut r = rig("exit /b 0", 2, "20260102");
        let auth = r.d.path().join("auth.cmd");
        std::fs::write(&auth, format!("@echo off\r\necho dial postgres://supabase_auth_admin:{AUTH_PW}@127.0.0.1:47300/x\r\necho token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoieCJ9.c2lnbmF0dXJl 1>&2\r\nexit /b 0\r\n")).unwrap();
        r.w.auth_exe = Some(auth);
        r.w.auth_migrate(&ctx(now_ms() + 600_000)).unwrap();
        let logs = r.d.path().join("data/logs/posctl/ops");
        for f in ["auth-migrate.out.log", "auth-migrate.err.log"] {
            let t = std::fs::read_to_string(logs.join(f)).unwrap();
            assert!(!t.contains(AUTH_PW) && !t.contains("eyJhbGci"), "{f} keeps a secret: {t}");
        }
    }

    /// A fake auth.exe that behaves like GoTrue 2.197.0 `-c <file> migrate`: the file is loaded with godotenv.Overload, so a
    /// DATABASE_URL in the FILE overrides the environment; it reports the URL migrate would use and the GOTRUE_* it sees.
    fn overload_auth(d: &Path) -> PathBuf {
        let auth = d.join("auth.cmd");
        std::fs::write(&auth, "@echo off\r\nset URL=%DATABASE_URL%\r\nif \"%~1\"==\"-c\" for /f \"usebackq tokens=1,* delims==\" %%a in (\"%~2\") do if \"%%a\"==\"DATABASE_URL\" set URL=%%b\r\necho %URL%>\"%~dp0effective-url.txt\"\r\necho [%GOTRUE_PROBE_FR5A%]>\"%~dp0inherited.txt\"\r\necho PW=%PGPASSWORD% PASSFILE=%PGPASSFILE%>\"%~dp0pw.txt\"\r\nexit /b 0\r\n").unwrap();
        auth
    }

    #[test]
    fn auth_migrate_uses_the_clone_whichever_of_the_file_and_the_environment_wins() {
        let mut r = rig("exit /b 0", 2, "20260102");
        let secrets = r.d.path().join("data").join("secrets");
        r.w.auth_exe = Some(overload_auth(r.d.path()));
        std::env::set_var("GOTRUE_PROBE_FR5A", "inherited");
        let res = r.w.auth_migrate(&ctx(now_ms() + 600_000));
        std::env::remove_var("GOTRUE_PROBE_FR5A");
        res.unwrap();
        let url = std::fs::read_to_string(r.d.path().join("effective-url.txt")).unwrap();
        assert!(url.contains("/pos_next"), "migrate would run against the wrong database: {url}");
        assert!(!url.contains("/postgres?") && !url.contains(AUTH_PW), "migrate would use the live database or a password in the URL: {url}");
        assert_eq!(std::fs::read_to_string(r.d.path().join("inherited.txt")).unwrap().trim(), "[]", "an inherited GOTRUE_* reached auth.exe");
        let pw = std::fs::read_to_string(r.d.path().join("pw.txt")).unwrap();
        assert!(!pw.contains(AUTH_PW) && pw.contains("pgpass.conf"), "{pw}");
        let left: Vec<_> = std::fs::read_dir(&secrets).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(!left.iter().any(|n| n.contains("migrate")), "the per-run env file must not outlive the run: {left:?}");
    }

    #[test]
    fn a_parent_pgpassfile_does_not_wipe_the_explicit_one_in_auth_migrate() {
        static PG_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = PG_ENV.lock().unwrap_or_else(|p| p.into_inner());
        let mut r = rig("exit /b 0", 2, "20260102");
        r.w.auth_exe = Some(overload_auth(r.d.path()));
        std::env::set_var("PGPASSFILE", r"Z:\parent-evil.conf");
        let res = r.w.auth_migrate(&ctx(now_ms() + 600_000));
        std::env::remove_var("PGPASSFILE");
        res.unwrap();
        let pw = std::fs::read_to_string(r.d.path().join("pw.txt")).unwrap();
        assert!(pw.contains("pgpass.conf") && !pw.contains("parent-evil"), "the scrub removed the explicit PGPASSFILE: {pw}");
    }

    #[test]
    fn the_per_run_env_file_keeps_the_other_settings_and_is_removed_when_auth_exe_fails_too() {
        let t = migrate_env_text(GOTRUE_ENV, "postgres://u@h/pos_next");
        assert!(t.contains("GOTRUE_JWT_SECRET=jwtsecret") && t.contains("GOTRUE_SITE_URL=http://x"));
        assert_eq!(t.matches("DATABASE_URL").count(), 1);
        assert!(!t.contains("/postgres?") && !t.contains(AUTH_PW));
        let mut r = rig("exit /b 0", 2, "20260102");
        let secrets = r.d.path().join("data").join("secrets");
        let auth = r.d.path().join("auth.cmd");
        std::fs::write(&auth, "@echo off\r\necho boom 1>&2\r\nexit /b 1\r\n").unwrap();
        r.w.auth_exe = Some(auth);
        assert!(r.w.auth_migrate(&ctx(now_ms() + 600_000)).is_err());
        assert!(!std::fs::read_dir(&secrets).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("migrate")));
    }

    #[test]
    fn the_operation_budget_reaches_every_psql_child_by_statement_class() {
        let r = rig("echo %PGOPTIONS%>\"%~dp0opts.txt\"\r\necho 1^|20260101", 2, "20260102");
        let opts = |r: &Rig| std::fs::read_to_string(r.d.path().join("opts.txt")).unwrap();
        let ms = |s: &str| -> u64 { s.split("statement_timeout=").nth(1).unwrap().trim().parse().unwrap() };
        r.w.arm(&ctx(now_ms() + 120_000));
        let _ = r.w.admin.scalar("template1", "SELECT 1"); // Default
        assert!((60_000..=120_000).contains(&ms(&opts(&r))), "{}", opts(&r));
        let _ = r.w.db().terminate(&["postgres"]); // Quick
        assert_eq!(ms(&opts(&r)), 60_000, "{}", opts(&r));
        r.w.arm(&ctx(now_ms() + 5 * 3_600_000));
        let _ = r.w.admin.scalar("template1", "SELECT 1");
        assert_eq!(ms(&opts(&r)), 600_000, "a plain statement is capped at 10 minutes");
        let _ = r.w.admin.exec_class("template1", "SELECT 1", StmtClass::Heavy);
        let h = ms(&opts(&r));
        assert_eq!(h, 7_200_000, "Heavy on a normal run keeps the 2 h ceiling");
        r.w.arm(&ctx(u64::MAX)); // recovery
        let _ = r.w.admin.exec_class("template1", "SELECT 1", StmtClass::Heavy);
        assert_eq!(ms(&opts(&r)), 600_000, "recovery never runs a statement longer than 10 minutes");
        let _ = r.w.db().terminate(&["postgres"]);
        assert_eq!(ms(&opts(&r)), 60_000);
    }

    #[test]
    fn a_recovery_has_no_time_end_only_the_ten_minute_statement_cap() {
        let now = now_ms();
        for class in [StmtClass::Default, StmtClass::Heavy] {
            assert_eq!(statement_budget_ms(class, RECOVERY_FLAG, now), 600_000, "{class:?}: the flag alone is a recovery with a flat cap");
        }
        assert_eq!(statement_budget_ms(StmtClass::Quick, RECOVERY_FLAG, now), 60_000);
    }

    #[test]
    fn a_migration_that_applied_cleanly_but_left_the_wrong_level_fails_verification() {
        // the live database reports 1 migration at 20260101; the pack says 2 at 20260102
        let mut r = rig("echo 1^|20260101", 2, "20260102");
        let e = r.w.verify_live(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!(e.code, OpCode::VerifyFailedRolledBack);
        assert!(e.message.contains("LEVEL_MISMATCH"), "{}", e.message);
    }

    #[test]
    fn verify_live_that_cannot_reach_the_stack_fails_verification_not_a_generic_error() {
        // the level matches, the keys are there, and nothing listens on the internal gateway port: a transport failure
        let mut r = rig("echo 2^|20260102", 2, "20260102");
        crate::util::write_secret_file(&r.d.path().join("data").join("secrets").join("keys.json"), r#"{"anon":"a","service_role":"s"}"#).unwrap();
        let port = r.w.env.ports.gateway_internal();
        drop(std::net::TcpListener::bind(("127.0.0.1", port)).expect("the test port is free"));
        let e = r.w.verify_live(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!((e.code, e.code.exit(), e.reason.as_str()), (OpCode::VerifyFailedRolledBack, 15, "VERIFY_FAILED"), "{e:?}");
    }

    #[test]
    fn verify_clone_that_loses_the_database_after_the_cluster_check_fails_the_migration_not_a_generic_error() {
        // the cluster digest is read and unchanged; the level reads fine; the next call (the version view) cannot run at all
        let mut r = rig(&format!("{}\r\nif %n% GEQ 3 (exit /b 1)", canned(&[CL, "2|20260102"])), 2, "20260102");
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.test_sql = Some("SELECT 1".into());
        r.w.cluster_before = Some(crate::update::cluster::parse_cluster(CL).unwrap());
        let e = r.w.verify_clone(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (OpCode::MigrationFailed, 14), "{e:?}");
    }

    #[test]
    fn verify_live_runs_the_canary_in_process_and_fails_when_the_lockout_fails() {
        // The canary is not a child process any more: posctl.exe does not exist in this rig, so a spawn could only fail with PROC_IO.
        let mut r = rig("exit /b 0", 2, "20260102");
        r.w.canary_fn = Some(Box::new(|| Err(crate::envelope::PosctlError::new(crate::envelope::Code::CanaryFailed, "the PIN lockout hook is not active: five wrong passwords did not lock the account"))));
        let e = r.w.lockout_canary(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!(e.code, OpCode::VerifyFailedRolledBack, "{e:?}");
        assert_eq!(e.reason, "VERIFY_FAILED");
        assert!(e.message.contains("five wrong passwords"), "{}", e.message);
        r.w.canary_fn = Some(Box::new(|| Ok(())));
        r.w.lockout_canary(&ctx(now_ms() + 600_000)).unwrap();
    }

    #[test]
    fn a_secret_variable_echoed_by_a_failing_sql_step_never_reaches_the_error_text() {
        let order = runorder::parse(runorder::SAMPLE).unwrap();
        // psql_header takes letters and digits only, so this step's secret is not AUTH_PW; the step file must exist or psql never runs
        const PW: &str = "hunter77pw";
        let r = rig(&format!("echo LINE 1: ALTER ROLE x PASSWORD '{PW}' 1>&2
exit /b 3"), 2, "20260102");
        let role = order.var_roles.get("pw_authadm").unwrap();
        crate::util::write_secret_file(&r.d.path().join("data").join("secrets").join(format!("pg-{role}.pw")), PW).unwrap();
        let sql = r.d.path().join("prog").join("packs").join("1.0.1-r1").join("sql");
        std::fs::create_dir_all(&sql).unwrap();
        std::fs::write(sql.join("01.sql"), "select 1;").unwrap();
        let step = Step::Sql { id: "01".into(), file: "sql/01.sql".into(), run_as: "supabase_admin".into(), vars: vec!["pw_authadm".into()],
            single_transaction: true, rerun: Rerun::Never, always: false };
        let e = r.w.run_step("pos_next", &order, &step).unwrap_err();
        assert_eq!(e.reason, "PACK_SQL_FAILED");
        let all = format!("{} {}", e.reason, e.message);
        assert!(all.contains("PASSWORD '***'"), "psql must have run and its echo been scrubbed: {all}");
        assert!(!all.contains(PW), "{all}");
    }

    /// A run-order.json in the NEW pack plus every file it names.
    fn write_run_order(r: &Rig, text: &str) {
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("sql").join("stub-extensions")).unwrap();
        for f in ["01-pre-gotrue", "03-owner-role", "03b-storage", "03c-database-grants", "02-shim-after-gotrue", "04-nonsuper-fixups", "20-pos-lockout-hook", "30-store-schema-version"] {
            std::fs::write(to.join("sql").join(format!("{f}.sql")), "select 1;").unwrap();
        }
        std::fs::write(to.join("sql/stub-extensions/vector.control"), "trusted = true\n").unwrap();
        std::fs::write(to.join("sql/stub-extensions/vector--0.0.1.sql"), "select 1;").unwrap();
        std::fs::write(to.join("sql").join("run-order.json"), text).unwrap();
    }
    #[test]
    fn the_plan_comes_from_the_typed_loader_and_its_checks() {
        let r = rig("exit /b 0", 2, "20260102");
        write_run_order(&r, runorder::SAMPLE);
        let p = r.w.plan().expect("the real run-order.json must plan");
        assert_eq!(p.steps.iter().map(|s| s.id()).collect::<Vec<_>>(),
            ["stubs-install", "03c-database-grants", "auth-migrate", "02-shim-after-gotrue", "04-nonsuper-fixups", "db-push", "stubs-remove", "20-pos-lockout-hook", "30-store-schema-version"]);
        assert!(!p.steps.iter().any(|s| matches!(s.id(), "01-pre-gotrue" | "03-owner-role" | "03b-storage")), "bootstrap-only steps are never replayed");
        let bad = [
            ("an unknown kind, even on a never step", runorder::SAMPLE.replacen("\"kind\": \"sql\"", "\"kind\": \"mystery\"", 1)),
            ("a psqlArgs entry off the allow-list", runorder::SAMPLE.replace("SHOW_CONTEXT=never", "ON_ERROR_STOP=0")),
            ("an unknown role", runorder::SAMPLE.replace("\"runAs\": \"postgres\"", "\"runAs\": \"root\"")),
            ("an escaping path", runorder::SAMPLE.replace("sql/30-store-schema-version.sql", "../30-store-schema-version.sql")),
            ("an unknown field", runorder::SAMPLE.replacen("\"rerun\": \"never\"", "\"rerun\": \"never\", \"extra\": 1", 1)),
        ];
        for (what, text) in bad {
            write_run_order(&r, &text);
            assert!(r.w.plan().is_err(), "{what} must be refused");
        }
    }

    fn env_of(r: &Rig) -> Env {
        Env { data: r.d.path().join("data"), program: r.d.path().join("prog"), posctl_exe: r.d.path().join("posctl.exe"),
            ports: crate::ports::Ports::new(47300).unwrap(), roots: crate::paths::Roots::custom(r.d.path().join("data"), r.d.path().join("prog")),
            activate: std::rc::Rc::new(|_, _, _| Ok(())) }
    }
    #[test]
    fn a_stub_and_a_secret_file_left_by_a_crashed_run_are_swept_before_anything_else() {
        let r = rig("exit /b 0", 2, "20260102");
        let ext = r.d.path().join("prog").join("packs").join("1.0.0-r1").join("pg/share/extension");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("vector.control"), "x").unwrap();
        std::fs::write(ext.join("vector--0.0.1.sql"), "x").unwrap();
        std::fs::write(ext.join("pg_net.control"), "keep").unwrap();
        let leftover = r.d.path().join("data").join("secrets").join(MIGRATE_ENV);
        std::fs::write(&leftover, GOTRUE_ENV).unwrap();
        let j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("1.0.0-r1".into()), Some("1.0.1-r1".into()));
        let _w = UpdateWork::from_journal(&j, &env_of(&r)).unwrap();
        assert!(!ext.join("vector.control").exists() && !ext.join("vector--0.0.1.sql").exists(), "the stub survived");
        assert!(ext.join("pg_net.control").exists(), "only the known stubs go");
        assert!(!leftover.exists(), "the per-run env file survived");
    }

    #[test]
    fn a_manifest_without_a_catalog_digest_fails_the_clone_verification() {
        let mut r = rig(&canned(&[CL, "2|20260102", "20260102|2", "t"]), 2, "20260102");
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.cluster_before = Some(crate::update::cluster::parse_cluster(CL).unwrap());
        r.w.test_sql = Some("SELECT 1".into());
        let e = r.w.verify_clone(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!(e.reason, "CATALOG_MISSING", "{e:?}");
    }

    /// The cluster digest both sides of the work, as `section|sha256` lines.
    const CL: &str = "databases|a1\nmembers|b1\nroles|c1\nsettings|d1\nslots|e1";
    const ROWS: &str = "auth.users|1\npublic.payments|120\npublic.profiles|3";
    /// Every psql answer `verify_clone` reads, in order: cluster digest, level, view, hook, catalog digest, invariants, the clone's
    /// auth level, the live auth level, the live row counts, the clone's row counts.
    fn seq<'a>(cluster: &'a str, inv: &'a str, auth_clone: &'a str, auth_live: &'a str, rows_live: &'a str, rows_clone: &'a str) -> Vec<&'a str> {
        vec![cluster, "2|20260102", "20260102|2", "t", "abc", inv, auth_clone, auth_live, rows_live, rows_clone]
    }
    fn good() -> Vec<&'static str> { seq(CL, "", "58|20260101", "58|20260101", ROWS, ROWS) }
    fn verify_with(extra: &str, calls: &[&str], before: Option<&str>, migrated: bool) -> R<()> {
        let mut r = rig_x(&canned(calls), 2, "20260102", extra);
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.catalog_sql = Some("SELECT digest".into());
        r.w.test_sql = Some("SELECT 1".into());
        r.w.cluster_before = Some(crate::update::cluster::parse_cluster(CL).unwrap());
        r.w.live_auth_before = before.map(str::to_string);
        r.w.auth_migrated = migrated;
        r.w.verify_clone(&ctx(now_ms() + 600_000))
    }
    const CAT: &str = ",\"catalog\":{\"digest\":\"abc\"}";

    // ---- FR14: a CATALOG_MISMATCH says which sections the clone and the live database carry ----
    #[test]
    fn a_catalog_mismatch_names_the_sections_of_the_clone_and_of_live_and_no_raw_line() {
        let calls = [CL, "2|20260102", "20260102|2", "t", "zzzzzzzzzz", "authfn|3|0a1b2c3d
rel|4|aaaaaaaa", "authfn|3|0a1b2c3d
rel|3|bbbbbbbb"];
        let e = verify_with(CAT, &calls, Some("58|20260101"), false).unwrap_err();
        assert_eq!(e.reason, "CATALOG_MISMATCH", "{e:?}");
        assert!(e.message.contains("digest zzzzzzzz declared abc;"), "{}", e.message);
        assert!(e.message.contains("clone [authfn=3:0a1b2c3d,rel=4:aaaaaaaa]") && e.message.contains("live [authfn=3:0a1b2c3d,rel=3:bbbbbbbb]"), "{}", e.message);
        assert!(e.message.len() <= 600, "{}", e.message.len());
    }

    #[test]
    fn a_failing_section_query_does_not_hide_the_mismatch() {
        let calls = [CL, "2|20260102", "20260102|2", "t", "zzz"];   // nothing is canned after the digest: both section reads come back empty
        let e = verify_with(CAT, &calls, Some("58|20260101"), false).unwrap_err();
        assert_eq!(e.reason, "CATALOG_MISMATCH", "{e:?}");
        assert!(e.message.starts_with("grants, policies or functions differ"), "{}", e.message);
    }

    #[test]
    fn the_clone_must_be_at_the_packs_auth_level_and_the_live_database_must_not_have_moved() {
        let with = |a: &str, b: &str| seq(CL, "", a.to_owned().leak(), b.to_owned().leak(), ROWS, ROWS);
        let declared = format!("{CAT},\"gotrueMigrationsMax\":\"20260301\"");
        // GoTrue changed and migrated: the clone moved forward, the live database did not
        verify_with(&declared, &with("60|20260301", "58|20260101"), Some("58|20260101"), true).unwrap();
        // the same run, but the live database moved too (migrate hit the wrong URL)
        assert_eq!(verify_with(&declared, &with("60|20260301", "60|20260301"), Some("58|20260101"), true).unwrap_err().reason, "LIVE_AUTH_CHANGED");
        // migrated but the pack does not declare its level: nothing to prove it against
        assert_eq!(verify_with(CAT, &with("60|20260301", "58|20260101"), Some("58|20260101"), true).unwrap_err().reason, "GOTRUE_MIGRATIONS_MAX_MISSING");
        verify_with(&declared, &with("60|20260301", "58|20260101"), Some("58|20260101"), true).unwrap();
        assert_eq!(verify_with(&declared, &with("58|20260101", "58|20260101"), Some("58|20260101"), true).unwrap_err().reason, "AUTH_LEVEL_MISMATCH");
        // GoTrue did not change: the clone must be exactly where live is
        assert_eq!(verify_with(CAT, &with("59|20260201", "58|20260101"), Some("58|20260101"), false).unwrap_err().reason, "AUTH_LEVEL_MISMATCH");
        // no snapshot: fail closed
        assert_eq!(verify_with(CAT, &with("58|20260101", "58|20260101"), None, false).unwrap_err().reason, "AUTH_SNAPSHOT_MISSING");
    }

    // ---- FR9 item 5: the live database is ctx.names.live, never a literal ----
    #[test]
    fn the_live_database_reads_use_the_ops_live_name() {
        // psql.cmd logs the -d argument (the 19th) of every call
        let log = "shift /1
".repeat(10) + "echo %9>>\"%~dp0dbs.log\"
";
        let mut r = rig_x(&format!("{log}{}", canned(&good())), 2, "20260102", CAT);
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.catalog_sql = Some("SELECT digest".into());
        r.w.test_sql = Some("SELECT 1".into());
        r.w.cluster_before = Some(crate::update::cluster::parse_cluster(CL).unwrap());
        r.w.live_auth_before = Some("58|20260101".into());
        let mut c = ctx(now_ms() + 600_000);
        c.names.live = "pos_live_zz".into();
        r.w.verify_clone(&c).unwrap();
        let dbs: Vec<String> = std::fs::read_to_string(r.d.path().join("dbs.log")).unwrap().lines().map(|l| l.trim().to_string()).collect();
        assert_eq!(dbs.len(), 10, "{dbs:?}");
        assert_eq!((dbs[7].as_str(), dbs[8].as_str()), ("pos_live_zz", "pos_live_zz"), "live auth level and live row counts: {dbs:?}");
        assert!(!dbs.iter().any(|d| d == "postgres"), "{dbs:?}");
    }

    // ---- FR5c ----
    #[test]
    fn a_step_that_eats_the_window_stops_the_next_step() {
        let mut r = rig_x(&format!("echo x>>\"%~dp0calls.log\"\r\n{}", canned(&[CL, "f"])), 2, "20260102", "");
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.test_sql = Some("SELECT 1".into());
        write_run_order(&r, runorder::SAMPLE);
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("migrations")).unwrap();
        for v in ["20260101", "20260102"] { std::fs::write(to.join("migrations").join(format!("{v}_m.sql")), "select 1;").unwrap(); }
        std::fs::create_dir_all(r.d.path().join("prog/packs/1.0.0-r1/pg/share/extension")).unwrap();
        let deadline = now_ms() + 600_000;
        let calls = Arc::new(AtomicU64::new(0));
        let c2 = calls.clone();
        // the first check (before step one) is inside the window, every later one is past it
        r.w.clock = Arc::new(move || if c2.fetch_add(1, Ordering::SeqCst) == 0 { deadline - 1 } else { deadline + 1 });
        let e = r.w.work_on_clone(&ctx(deadline)).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "MAINTENANCE_BUDGET"), "{e:?}");
        let psql_calls = std::fs::read_to_string(r.d.path().join("calls.log")).map(|t| t.lines().count()).unwrap_or(0);
        assert!(psql_calls <= 4, "a SQL step ran after the window was over ({psql_calls} psql calls)");
    }

    #[test]
    fn every_key_ending_in_database_url_is_dropped_from_the_per_run_file() {
        let mut r = rig("exit /b 0", 2, "20260102");
        let secrets = r.d.path().join("data").join("secrets");
        std::fs::write(secrets.join("gotrue.env"), format!("{GOTRUE_ENV}GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:{AUTH_PW}@127.0.0.1:47300/postgres\nexport OTHER_DATABASE_URL=postgres://x/postgres\n")).unwrap();
        let auth = r.d.path().join("auth.cmd");
        std::fs::write(&auth, "@echo off\r\ncopy \"%~2\" \"%~dp0seen.env\" >nul\r\nexit /b 0\r\n").unwrap();
        r.w.auth_exe = Some(auth);
        r.w.auth_migrate(&ctx(now_ms() + 600_000)).unwrap();
        let seen = std::fs::read_to_string(r.d.path().join("seen.env")).unwrap();
        let urls: Vec<&str> = seen.lines().filter(|l| l.to_uppercase().contains("DATABASE_URL")).collect();
        assert_eq!(urls.len(), 1, "only the clone's URL may remain: {urls:?}");
        assert!(urls[0].starts_with("DATABASE_URL=") && urls[0].contains("/pos_next"), "{urls:?}");
        assert!(!seen.contains(AUTH_PW), "{seen}");
    }

    #[test]
    fn everything_in_gotrue_env_is_scrubbed_from_what_auth_exe_prints() {
        let mut r = rig("exit /b 0", 2, "20260102");
        let secrets = r.d.path().join("data").join("secrets");
        std::fs::write(secrets.join("gotrue.env"), "GOTRUE_JWT_SECRET=0123456789abcdef0123456789abcdef\nGOTRUE_SMTP_PASS=plain-smtp-secret\nDATABASE_URL=postgres://u@h/postgres\n").unwrap();
        let auth = r.d.path().join("auth.cmd");
        std::fs::write(&auth, "@echo off\r\necho config dump jwt=0123456789abcdef0123456789abcdef smtp=plain-smtp-secret 1>&2\r\necho and stdout 0123456789abcdef0123456789abcdef\r\nexit /b 1\r\n").unwrap();
        r.w.auth_exe = Some(auth);
        let e = r.w.auth_migrate(&ctx(now_ms() + 600_000)).unwrap_err();
        let all = format!("{} {}", e.reason, e.message);
        assert!(!all.contains("0123456789abcdef") && !all.contains("plain-smtp-secret"), "error text keeps a gotrue.env value: {all}");
        let logs = r.d.path().join("data/logs/posctl/ops");
        for f in ["auth-migrate.out.log", "auth-migrate.err.log"] {
            let t = std::fs::read_to_string(logs.join(f)).unwrap();
            assert!(!t.contains("0123456789abcdef") && !t.contains("plain-smtp-secret"), "{f} keeps a gotrue.env value: {t}");
        }
    }

    #[test]
    fn the_push_url_carries_the_timeouts_correctly_encoded() {
        let u = push_url(47300, "pos_next", 120_000);
        assert_eq!(u, "postgresql://postgres@127.0.0.1:47300/pos_next?sslmode=disable&options=-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D10s");
        assert!(!u.contains(' ') && !u.to_lowercase().contains("password"));
    }

    #[test]
    fn leftover_env_temp_files_and_the_stubs_of_both_verified_run_orders_are_swept() {
        let r = rig("exit /b 0", 2, "20260102");
        let secrets = r.d.path().join("data").join("secrets");
        std::fs::write(secrets.join(".gotrue-migrate.env.deadbeef.tmp"), GOTRUE_ENV).unwrap();
        std::fs::write(secrets.join(".gotrue.env.other.tmp"), "keep").unwrap();
        let j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("1.0.0-r1".into()), Some("1.0.1-r1".into()));
        let _w = UpdateWork::from_journal(&j, &env_of(&r)).unwrap();
        assert!(!secrets.join(".gotrue-migrate.env.deadbeef.tmp").exists(), "the per-run file's temp survived");
        assert!(secrets.join(".gotrue.env.other.tmp").exists(), "only our own temp pattern goes");
    }

    #[test]
    fn a_mismatching_source_is_repaired_before_the_clone_and_says_so_and_a_clean_one_is_left_alone() {
        // answers: 1 collation check, then REINDEX and REFRESH (any output)
        let mut r = rig(&canned(&["t", "REINDEX", "ALTER DATABASE"]), 2, "20260102");
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.repair_source(&ctx(u64::MAX)).unwrap();
        assert_eq!(r.w.warnings, ["COLLATION_REPAIRED_ON_SOURCE"]);
        assert_eq!(std::fs::read_to_string(r.d.path().join("n.txt")).unwrap().trim(), "3", "check + reindex + refresh");
        let mut clean = rig(&canned(&["f"]), 2, "20260102");
        std::fs::write(clean.d.path().join("n.txt"), "0").unwrap();
        clean.w.repair_source(&ctx(u64::MAX)).unwrap();
        assert!(clean.w.warnings.is_empty());
        assert_eq!(std::fs::read_to_string(clean.d.path().join("n.txt")).unwrap().trim(), "1", "only the check ran");
    }

    #[test]
    fn the_quick_statements_are_the_catalog_reads() {
        let r = rig("echo %PGOPTIONS%>\"%~dp0opts.txt\"\r\necho 1^|x", 2, "20260102");
        r.w.arm(&ctx(u64::MAX));
        let opts = || std::fs::read_to_string(r.d.path().join("opts.txt")).unwrap();
        let _ = r.w.level("postgres");
        assert!(opts().contains("statement_timeout=60000"), "level: {}", opts());
        let _ = r.w.auth_level("postgres");
        assert!(opts().contains("statement_timeout=60000"), "auth level: {}", opts());
        let _ = r.w.db().names();
        assert!(opts().contains("statement_timeout=60000"), "names: {}", opts());
        let _ = r.w.db().collation_mismatch("postgres");
        assert!(opts().contains("statement_timeout=60000"), "collation: {}", opts());
    }

    // ---- FR6 X3: the fence makes supabase_auth_admin NOLOGIN; the migration runs as that role ----
    fn login_rig(auth_exit: i32) -> (Rig, PathBuf) {
        let mut r = rig("exit /b 0", 2, "20260102");
        let d = r.d.path().to_path_buf();
        std::fs::write(d.join("state.txt"), "NOLOGIN").unwrap();
        std::fs::write(d.join("history.txt"), "").unwrap();
        let dd = d.clone();
        r.w.login_hook = Some(Box::new(move |login| {
            let w = if login { "LOGIN" } else { "NOLOGIN" };
            std::fs::write(dd.join("state.txt"), w).unwrap();
            let h = std::fs::read_to_string(dd.join("history.txt")).unwrap();
            std::fs::write(dd.join("history.txt"), format!("{h}{w};")).unwrap();
            Ok(())
        }));
        let auth = d.join("auth.cmd");
        std::fs::write(&auth, format!("@echo off\r\ncopy /y \"%~dp0state.txt\" \"%~dp0at-auth.txt\" >nul\r\nif {auth_exit} NEQ 0 echo boom 1>&2\r\nexit /b {auth_exit}\r\n")).unwrap();
        r.w.auth_exe = Some(auth);
        (r, d)
    }

    #[test]
    fn x3_the_role_is_login_while_gotrue_migrates_and_nologin_again_afterwards() {
        let (r, d) = login_rig(0);
        r.w.auth_migrate_with_login(&ctx(now_ms() + 600_000)).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN", "auth.exe ran while the role could not log in");
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN");
        assert_eq!(std::fs::read_to_string(d.join("history.txt")).unwrap(), "LOGIN;NOLOGIN;");
    }

    #[test]
    fn x3_a_failed_migration_still_closes_the_door_again() {
        let (r, d) = login_rig(1);
        let e = r.w.auth_migrate_with_login(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!(e.reason, "AUTH_MIGRATE", "{e:?}");
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN");
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN", "the error path must not leave the role able to log in");
    }

    #[test]
    fn x3_when_the_login_cannot_be_granted_nothing_runs_and_the_role_is_closed() {
        let (mut r, d) = login_rig(0);
        let dd = d.clone();
        r.w.login_hook = Some(Box::new(move |login| {
            std::fs::write(dd.join("state.txt"), if login { "LOGIN" } else { "NOLOGIN" }).unwrap();
            if login { Err(mig("PSQL_FAILED", "no")) } else { Ok(()) }
        }));
        assert!(r.w.auth_migrate_with_login(&ctx(now_ms() + 600_000)).is_err());
        assert!(!d.join("at-auth.txt").exists(), "auth.exe must not run");
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN");
    }

    #[test]
    fn t_verify_clone_checks_the_window_before_it_touches_the_database() {
        let mut r = rig("echo x>>\"%~dp0calls.log\"", 2, "20260102");
        let e = r.w.verify_clone(&ctx(now_ms() - 1)).unwrap_err();
        assert_eq!(e.reason, "MAINTENANCE_BUDGET", "{e:?}");
        assert!(!r.d.path().join("calls.log").exists(), "no psql call may start inside a spent window");
    }

    #[test]
    fn l5_the_budget_message_does_not_claim_that_nothing_was_changed() {
        let e = window_open(1_000, 2_000).unwrap_err();
        assert_eq!(e.reason, "MAINTENANCE_BUDGET");
        assert!(!e.message.to_lowercase().contains("nothing"), "old copies may already have been dropped: {}", e.message);
        assert!(e.message.contains("undone") || e.message.contains("rolled back"), "{}", e.message);
    }

    #[test]
    fn x_the_gotrue_step_of_work_on_clone_runs_auth_exe_with_the_role_open_and_closes_it_afterwards() {
        let (mut r, d) = login_rig(0);
        std::fs::write(d.join("psql.cmd"), format!("@echo off\r\n{}\r\n", CL.split('\n').map(|l| format!("echo {}", l.replace('|', "^|"))).collect::<Vec<_>>().join("&"))).unwrap();
        r.w.test_sql = Some("SELECT 1".into());
        r.w.from.set_component("gotrue", "2.196.0");
        r.w.to.set_component("gotrue", "2.197.0");
        write_run_order(&r, runorder::SAMPLE);
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("migrations")).unwrap();
        for v in ["20260101", "20260102"] { std::fs::write(to.join("migrations").join(format!("{v}_m.sql")), "select 1;").unwrap(); }
        std::fs::create_dir_all(r.d.path().join("prog/packs/1.0.0-r1/pg/share/extension")).unwrap();
        // the steps after auth-migrate need tools this rig does not have; the run may fail there, after the GoTrue step
        let _ = r.w.work_on_clone(&ctx(now_ms() + 600_000));
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN", "work_on_clone ran auth.exe while the role could not log in");
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN");
        assert!(std::fs::read_to_string(d.join("history.txt")).unwrap().starts_with("LOGIN;NOLOGIN;"));
    }

    /// work_on_clone with the SAME gotrue build on both sides and the pack declaring `gotrueMigrationsMax`; the live auth level is `live`.
    fn same_build_rig(live: &str) -> (Rig, PathBuf) {
        let (mut r, d) = login_rig(0);
        let mut m = std::fs::read_to_string(r.d.path().join("prog/packs/1.0.1-r1/manifest.json")).unwrap();
        m = m.replace("\"files\":[]", "\"files\":[],\"gotrueMigrationsMax\":\"20260301\"");
        std::fs::write(r.d.path().join("prog/packs/1.0.1-r1/manifest.json"), m).unwrap();
        // psql answers: 1 cluster digest, 2 the live auth level
        std::fs::write(d.join("n.txt"), "0").unwrap();
        std::fs::write(d.join("psql.cmd"), format!("@echo off\r\n{}\r\n", canned(&[CL, live]))).unwrap();
        r.w.test_sql = Some("SELECT 1".into());
        r.w.from.set_component("gotrue", "2.197.0");
        r.w.to.set_component("gotrue", "2.197.0");
        r.w.to.gotrue_migrations_max = Some("20260301".into());
        write_run_order(&r, runorder::SAMPLE);
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("migrations")).unwrap();
        for v in ["20260101", "20260102"] { std::fs::write(to.join("migrations").join(format!("{v}_m.sql")), "select 1;").unwrap(); }
        std::fs::create_dir_all(r.d.path().join("prog/packs/1.0.0-r1/pg/share/extension")).unwrap();
        (r, d)
    }

    #[test]
    fn x_the_gotrue_step_runs_auth_exe_when_only_the_db_level_trails() {
        let (mut r, d) = same_build_rig("58|20260101");
        let _ = r.w.work_on_clone(&ctx(now_ms() + 600_000)); // fails later at `db push` (no supabase.exe in this rig)
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN", "auth.exe did not run for a trailing level");
        assert!(r.w.auth_migrated);
    }

    #[test]
    fn x_a_live_auth_level_above_the_pack_is_refused_before_any_step_and_auth_exe_never_runs() {
        let (mut r, d) = same_build_rig("62|20260401");
        let e = r.w.work_on_clone(&ctx(now_ms() + 600_000)).unwrap_err();
        assert_eq!(e.reason, "AUTH_LEVEL_MISMATCH", "{e:?}");
        assert!(e.message.contains("20260401") && e.message.contains("20260301"), "{}", e.message);
        assert!(!d.join("at-auth.txt").exists(), "never migrate down");
        assert!(!r.w.auth_migrated);
    }

    #[test]
    fn a5_the_role_is_closed_again_even_when_the_migration_panics() {
        let (r, d) = login_rig(0);
        let w = &r.w;
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _: R<()> = w.with_auth_login(|| panic!("boom")); }));
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN", "a panic must not leave supabase_auth_admin able to log in");
    }

    #[test]
    fn a2_a_statement_after_the_first_recovery_step_is_still_a_recovery_statement() {
        let mut r = rig("echo %PGOPTIONS%>\"%~dp0opts.txt\"
echo 1^|20260101", 2, "20260102");
        let j = Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("1.0.0-r1".into()), Some("1.0.1-r1".into()));
        r.w.deadline.store(crate::commands::update::recovery_cell(), Ordering::Relaxed); // what recover_locked does
        let c = crate::commands::update::recovery_ctx(&j);
        let _ = r.w.verify_after_rollback(&c); // arm() runs first, then the statements
        let _ = r.w.admin.scalar("template1", "SELECT 1"); // a plain (Default class) statement after that first step
        let opts = std::fs::read_to_string(r.d.path().join("opts.txt")).unwrap();
        let t: u64 = opts.split("statement_timeout=").nth(1).unwrap().trim().parse().unwrap();
        assert_eq!(t, 600_000, "arm() wiped the recovery mark and the statement got {t} ms");
    }

    // ---- FR5b item 2: the cluster digest ----
    #[test]
    fn same_cluster_digest_passes() {
        verify_with(CAT, &good(), Some("58|20260101"), false).unwrap();
    }
    #[test]
    fn a_changed_section_refuses_cluster_changed_naming_only_the_section() {
        let after = "databases|a1\nmembers|b1\nroles|c2\nsettings|d1\nslots|e1";
        let e = verify_with(CAT, &seq(after, "", "58|20260101", "58|20260101", ROWS, ROWS), Some("58|20260101"), false).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::MigrationFailed, "CLUSTER_CHANGED"));
        assert!(e.message.contains("roles"), "{}", e.message);
        assert!(!e.message.contains("c1") && !e.message.contains("c2") && !e.message.contains("members"), "only the section name may appear: {}", e.message);
    }
    #[test]
    fn a_short_digest_refuses() {
        let short = "databases|a1\nmembers|b1\nroles|c1\nsettings|d1";
        let e = verify_with(CAT, &seq(short, "", "58|20260101", "58|20260101", ROWS, ROWS), Some("58|20260101"), false).unwrap_err();
        assert_eq!(e.reason, "CLUSTER_DIGEST_FAILED");
    }
    #[test]
    fn a_failed_work_that_moved_the_cluster_warns() {
        // calls: 1 cluster before, 2 live auth level, then the window closes before the second step, 3 cluster after
        let moved = "databases|a1\nmembers|b1\nroles|c9\nsettings|d1\nslots|e1";
        let mut r = rig_x(&canned(&[CL, "58|20260101", moved]), 2, "20260102", "");
        std::fs::write(r.d.path().join("n.txt"), "0").unwrap();
        r.w.test_sql = Some("SELECT 1".into());
        write_run_order(&r, runorder::SAMPLE);
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("migrations")).unwrap();
        for v in ["20260101", "20260102"] { std::fs::write(to.join("migrations").join(format!("{v}_m.sql")), "select 1;").unwrap(); }
        std::fs::create_dir_all(r.d.path().join("prog/packs/1.0.0-r1/pg/share/extension")).unwrap();
        let deadline = now_ms() + 600_000;
        let calls = Arc::new(AtomicU64::new(0));
        let c2 = calls.clone();
        r.w.clock = Arc::new(move || if c2.fetch_add(1, Ordering::SeqCst) == 0 { deadline - 1 } else { deadline + 1 });
        let e = r.w.work_on_clone(&ctx(deadline)).unwrap_err();
        assert_eq!(e.reason, "MAINTENANCE_BUDGET");
        assert!(r.w.warnings.iter().any(|w| w == "CLUSTER_CHANGED_ON_FAILED_WORK"), "{:?}", r.w.warnings);
    }
    #[test]
    fn cluster_sql_excludes_only_the_clone() {
        assert_eq!(crate::update::cluster::CLUSTER_SQL.matches(crate::ops::names::NEXT).count(), 1, "databases only: the clone's own settings must be visible (FR9)");
        let settings = crate::update::cluster::CLUSTER_SQL.lines().find(|l| l.contains("'settings', coalesce")).expect("settings branch");
        assert!(!settings.contains(crate::ops::names::NEXT), "the settings branch must not skip the clone");
        assert!(crate::update::cluster::CLUSTER_SQL.trim_start().to_lowercase().starts_with("set search_path = pg_catalog"));
        for section in ["databases", "members", "roles", "settings", "slots"] { assert!(crate::update::cluster::CLUSTER_SQL.contains(&format!("'{section}'")), "{section}"); }
        assert!(!crate::update::cluster::CLUSTER_SQL.contains("rolpassword,'')) x") || crate::update::cluster::CLUSTER_SQL.contains("md5(coalesce(a.rolpassword"), "a password verifier may only enter as md5");
    }

    // ---- FR5b item 4: absolute invariants on the clone ----
    #[test]
    fn all_invariants_hold_passes() { verify_with(CAT, &good(), Some("58|20260101"), false).unwrap(); }
    #[test]
    fn a_broken_invariant_refuses_naming_it() {
        let e = verify_with(CAT, &seq(CL, "RLS_OFF public.t;SLOTS", "58|20260101", "58|20260101", ROWS, ROWS), Some("58|20260101"), false).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::MigrationFailed, "INVARIANT_BROKEN"));
        assert!(e.message.contains("RLS_OFF public.t") && e.message.contains("SLOTS"), "{}", e.message);
    }
    #[test]
    fn the_invariant_sql_has_no_constant_order_by() {
        let q = crate::update::invariants::INVARIANTS_SQL;
        assert!(!q.to_uppercase().contains("ORDER BY 1") && !q.to_uppercase().contains("ORDER BY '"), "string_agg must order by its own expression");
        assert!(q.trim_start().to_lowercase().starts_with("set search_path = pg_catalog"));
        for tag in ["RLS_OFF", "PIN_GRANT", "SLOTS", "ROLE_SET", "BACKUP_ROLE", "SUPERUSERS"] { assert!(q.contains(tag), "{tag}"); }
    }

    // ---- FR5b item 5: row counts ----
    #[test]
    fn equal_counts_pass() { verify_with(CAT, &good(), Some("58|20260101"), false).unwrap(); }
    #[test]
    fn growth_passes() {
        let more = "auth.users|2\npublic.payments|500\npublic.profiles|3\npublic.new_table|7";
        verify_with(CAT, &seq(CL, "", "58|20260101", "58|20260101", ROWS, more), Some("58|20260101"), false).unwrap();
    }
    #[test]
    fn a_shrunk_table_refuses_rows_lost() {
        let shrunk = "auth.users|1\npublic.payments|0\npublic.profiles|3";
        let e = verify_with(CAT, &seq(CL, "", "58|20260101", "58|20260101", ROWS, shrunk), Some("58|20260101"), false).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::MigrationFailed, "ROWS_LOST"));
        assert!(e.message.contains("public.payments 120\u{2192}0"), "{}", e.message);
    }
    #[test]
    fn a_declared_delete_passes() {
        let shrunk = "auth.users|1\npublic.payments|0\npublic.profiles|3";
        let declared = format!("{CAT},\"dataChanges\":[{{\"table\":\"public.payments\",\"kind\":\"delete\"}}]");
        verify_with(&declared, &seq(CL, "", "58|20260101", "58|20260101", ROWS, shrunk), Some("58|20260101"), false).unwrap();
    }
    #[test]
    fn a_dropped_table_needs_drop() {
        let gone = "auth.users|1\npublic.profiles|3";
        let e = verify_with(CAT, &seq(CL, "", "58|20260101", "58|20260101", ROWS, gone), Some("58|20260101"), false).unwrap_err();
        assert_eq!(e.reason, "ROWS_LOST");
        assert!(e.message.contains("public.payments missing"), "{}", e.message);
        let delete_only = format!("{CAT},\"dataChanges\":[{{\"table\":\"public.payments\",\"kind\":\"delete\"}}]");
        assert_eq!(verify_with(&delete_only, &seq(CL, "", "58|20260101", "58|20260101", ROWS, gone), Some("58|20260101"), false).unwrap_err().reason, "ROWS_LOST", "a delete declaration does not cover a drop");
        let drop_decl = format!("{CAT},\"dataChanges\":[{{\"table\":\"public.payments\",\"kind\":\"drop\"}}]");
        verify_with(&drop_decl, &seq(CL, "", "58|20260101", "58|20260101", ROWS, gone), Some("58|20260101"), false).unwrap();
    }
    #[test]
    fn manifest_parses_data_changes_and_rejects_unknown_kind() {
        let base = r#"{"schema":1,"packVersion":"1.0.1-r1","appVersion":"1.0.1","platform":"win-x64","migrations":{"count":1,"max":"1"},"files":[],"dataChanges":[{"table":"public.x","kind":"KIND"}]}"#;
        let m: Manifest = serde_json::from_str(&base.replace("KIND", "delete")).unwrap();
        assert_eq!(m.data_changes.len(), 1);
        assert!(serde_json::from_str::<Manifest>(&base.replace("KIND", "backfill")).is_err(), "no backfill kind: growth is never refused");
        assert!(serde_json::from_str::<Manifest>(&base.replace("KIND", "truncate")).is_err());
    }

    // ---- Plan 08 Task 9: a restored older snapshot gets the update's own migration sequence on the clone ----
    /// `declared`: the pack's `gotrueMigrationsMax` (None = the pack does not declare one). psql answers the auth level once
    /// and logs the database of every call (`%9`).
    fn restore_rig(level: &str, declared: Option<&str>) -> (Rig, PathBuf) {
        let (mut r, d) = login_rig(0);
        if let Some(m) = declared {
            let f = r.d.path().join("prog/packs/1.0.1-r1/manifest.json");
            let t = std::fs::read_to_string(&f).unwrap().replace("\"files\":[]", &format!("\"files\":[],\"gotrueMigrationsMax\":\"{m}\""));
            std::fs::write(&f, t).unwrap();
            r.w.to.gotrue_migrations_max = Some(m.into());
        }
        std::fs::write(d.join("n.txt"), "0").unwrap();
        std::fs::write(d.join("psql.cmd"), format!("@echo off\r\nfor %%a in (%*) do echo %%a>>\"%~dp0args.log\"\r\n{}\r\n", canned(&[level]))).unwrap();
        r.w.from.set_component("gotrue", "2.197.0");
        r.w.to.set_component("gotrue", "2.197.0");
        write_run_order(&r, runorder::SAMPLE);
        let to = r.d.path().join("prog").join("packs").join("1.0.1-r1");
        std::fs::create_dir_all(to.join("migrations")).unwrap();
        for v in ["20260101", "20260102"] { std::fs::write(to.join("migrations").join(format!("{v}_m.sql")), "select 1;").unwrap(); }
        std::fs::create_dir_all(r.d.path().join("prog/packs/1.0.0-r1/pg/share/extension")).unwrap();
        (r, d)
    }
    /// The `-d <db>` of each logged psql call.
    fn dbs_of(d: &Path) -> Vec<String> {
        let t = std::fs::read_to_string(d.join("args.log")).unwrap_or_default();
        let l: Vec<&str> = t.lines().map(str::trim).collect();
        l.iter().enumerate().filter(|(_, x)| **x == "-d").filter_map(|(i, _)| l.get(i + 1).map(|x| x.to_string())).collect()
    }
    fn restore_ctx() -> OpCtx {
        OpCtx { op_id: "restore-1".into(), names: DbNames::for_kind(OpKind::Restore, T0), pack_from: Some("1.0.0-r1".into()), pack_to: Some("1.0.0-r1".into()), deadline_ms: now_ms() + 600_000 }
    }

    #[test]
    fn restore_decides_gotrue_from_the_restored_databases_own_level_and_runs_auth_exe_with_the_role_open() {
        let (mut r, d) = restore_rig("58|20260101", Some("20260301"));
        let _ = r.w.migrate_restored(&restore_ctx()); // fails later at `db push` (no supabase.exe in this rig)
        let dbs = dbs_of(&d);
        assert_eq!(dbs.first().map(String::as_str), Some("pos_next"), "the level must be read on the restored database, never the live one: {dbs:?}");
        assert!(!dbs.iter().any(|l| l == "postgres"), "{dbs:?}");
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN", "auth.exe ran while the role could not log in");
        assert_eq!(std::fs::read_to_string(d.join("state.txt")).unwrap(), "NOLOGIN");
        assert!(r.w.auth_migrated);
    }

    #[test]
    fn restore_never_migrates_gotrue_down_and_runs_no_step_before_refusing() {
        let (mut r, d) = restore_rig("62|20260401", Some("20260301"));
        let e = r.w.migrate_restored(&restore_ctx()).unwrap_err();
        assert_eq!(e.reason, "AUTH_LEVEL_MISMATCH", "{e:?}");
        assert!(!d.join("at-auth.txt").exists(), "never migrate down");
    }

    #[test]
    fn restore_skips_gotrue_when_the_snapshot_already_has_the_packs_level() {
        let (mut r, d) = restore_rig("60|20260301", Some("20260301"));
        let _ = r.w.migrate_restored(&restore_ctx());
        assert!(!d.join("at-auth.txt").exists());
        assert!(!r.w.auth_migrated);
    }

    #[test]
    fn restore_of_a_pack_that_declares_no_gotrue_level_still_runs_gotrue_because_the_snapshots_build_is_unknown() {
        let (mut r, d) = restore_rig("58|20260101", None);
        let _ = r.w.migrate_restored(&restore_ctx());
        assert_eq!(std::fs::read_to_string(d.join("at-auth.txt")).unwrap().trim(), "LOGIN");
        assert!(r.w.auth_migrated);
    }

    #[test]
    fn restore_stages_the_packs_migrations_and_the_update_path_still_reads_the_live_database() {
        let (mut r, d) = restore_rig("60|20260301", Some("20260301"));
        let _ = r.w.migrate_restored(&restore_ctx());
        let staged = r.d.path().join("data/work/supabase/migrations");
        assert_eq!(std::fs::read_dir(&staged).unwrap().count(), 2, "db push needs exactly the manifest's files staged");
        // the update's own entry point is unchanged: it reads the LIVE database's level
        let (mut u, ud) = restore_rig("60|20260301", Some("20260301"));
        let _ = u.w.work_steps(&ctx(now_ms() + 600_000));
        assert_eq!(dbs_of(&ud).first().map(String::as_str), Some("postgres"));
        let _ = d;
    }
}
