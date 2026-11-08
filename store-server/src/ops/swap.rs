//! Clone, rename-swap, prune and the disk rule. All SQL runs as supabase_admin from `template1`
//! (a connection to `postgres` would block the rename). Procedure B of S8, with the S8 review fixes:
//! FILE_COPY clone (I3), disk >= 3x + floor (I3), sessions terminated and recorded (I1).
//! Secrets reach psql only through PGPASSFILE or `\set` lines on stdin, never argv; database and role names
//! reach SQL only through `ident()`, which refuses anything outside `[a-z0-9_]`.
use crate::ops::names::{parse_stamp, valid_ident, DbNames};
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const WEEK_MS: u64 = 7 * 86_400_000;
const FLOOR_BYTES: u64 = 2 << 30;

/// The same rule as `ident`, as an error: a name read back from the server (`pg_database`) may be anything.
fn checked(s: &str) -> R<()> {
    if valid_ident(s) { Ok(()) } else { Err(OpError::err("BAD_DB_NAME", "a database name is not a safe identifier; it is left alone")) }
}

fn ident(s: &str) -> &str { assert!(valid_ident(s), "unsafe SQL identifier: {s:?}"); s }

pub fn create_clone_sql(n: &DbNames, owner: &str) -> String {
    format!(r#"CREATE DATABASE "{}" TEMPLATE "{}" STRATEGY = FILE_COPY OWNER "{}""#, ident(&n.next), ident(&n.live), ident(owner))
}
pub fn swap_sql(n: &DbNames) -> String {
    format!(r#"BEGIN; ALTER DATABASE "{l}" RENAME TO "{p}"; ALTER DATABASE "{x}" RENAME TO "{l}"; COMMIT"#,
        l = ident(&n.live), p = ident(&n.prev), x = ident(&n.next))
}
pub fn swap_back_sql(n: &DbNames) -> String {
    format!(r#"BEGIN; ALTER DATABASE "{l}" RENAME TO "{f}"; ALTER DATABASE "{p}" RENAME TO "{l}"; COMMIT"#,
        l = ident(&n.live), f = ident(&n.failed), p = ident(&n.prev))
}
pub fn drop_sql(name: &str) -> String { format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, ident(name)) }
pub const NAMES_SQL: &str = "SELECT datname::text FROM pg_database";
pub fn size_sql(db: &str) -> String { format!("SELECT pg_database_size('{}')::text", ident(db)) }
pub fn owner_sql(db: &str) -> String { format!("SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = '{}'", ident(db)) }
pub fn collation_sql(db: &str) -> String {
    format!("SELECT datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid) FROM pg_database WHERE datname = '{}'", ident(db))
}
/// The inside of `IN (..)`: quoted names, or `NULL` (matches nothing) for an empty list, because `IN ()` is a syntax error.
fn in_list<'a>(names: impl Iterator<Item = &'a str>) -> String {
    let l = names.map(|n| format!("'{n}'")).collect::<Vec<_>>().join(",");
    if l.is_empty() { "NULL".into() } else { l }
}
pub fn terminate_sql(dbs: &[&str]) -> String {
    let list = in_list(dbs.iter().map(|d| ident(d)));
    format!("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname IN ({list}) AND pid <> pg_backend_pid()")
}
pub fn terminate_roles_sql(roles: &[String]) -> String {
    let list = in_list(roles.iter().map(|r| ident(r)));
    format!("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename IN ({list}) AND pid <> pg_backend_pid()")
}
pub fn login_sql(roles: &[String], login: bool) -> String {
    let word = if login { "LOGIN" } else { "NOLOGIN" };
    roles.iter().map(|r| format!(r#"ALTER ROLE "{}" {word}"#, ident(r))).collect::<Vec<_>>().join("; ")
}

/// Settings whose value is a comma-separated LIST: re-quoted element by element (also used by Plan 08's restore).
pub(crate) const LIST_GUCS: &[&str] = &["search_path", "temp_tablespaces", "session_preload_libraries", "shared_preload_libraries", "local_preload_libraries", "unix_socket_directories"];

/// CREATE DATABASE ... TEMPLATE does not copy the database ACL or the per-database role settings (S8): replay them.
/// The ACL is replayed as a replacement, not an addition: when the source has an explicit ACL, PUBLIC's default
/// CONNECT/TEMP on the clone is revoked first, so a CONNECT revoked on the live database stays revoked.
/// List-valued settings (search_path, ...) are re-quoted element by element, like pg_dump does.
pub fn replay_attrs_sql(n: &DbNames) -> String {
    let listy = LIST_GUCS.iter().map(|g| format!("'{g}'")).collect::<Vec<_>>().join(",");
    format!(r#"DO $$ DECLARE r record; nm text := '{next}'; src oid := (SELECT oid FROM pg_database WHERE datname = '{live}');
  listy text[] := ARRAY[{listy}];
  k text; v text; lit text;
BEGIN
  IF (SELECT datacl IS NOT NULL FROM pg_database WHERE datname = '{live}') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', nm);
  END IF;
  FOR r IN SELECT a.grantee, a.privilege_type, a.is_grantable FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = '{live}' AND a.grantee <> d.datdba LOOP
    EXECUTE format('GRANT %s ON DATABASE %I TO %s %s', r.privilege_type, nm,
      CASE r.grantee WHEN 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END,
      CASE WHEN r.is_grantable THEN 'WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  FOR r IN SELECT setrole, unnest(setconfig) kv FROM pg_db_role_setting WHERE setdatabase = src LOOP
    k := split_part(r.kv,'=',1);
    v := substr(r.kv, position('=' in r.kv)+1);
    IF k = ANY(listy) THEN
      SELECT string_agg(quote_literal(btrim(btrim(e), '"')), ', ') INTO lit FROM unnest(string_to_array(v, ',')) e;
      lit := coalesce(lit, quote_literal(''));
    ELSE
      lit := quote_literal(v);
    END IF;
    IF r.setrole = 0 THEN
      EXECUTE format('ALTER DATABASE %I SET %s TO %s', nm, k, lit);
    ELSE
      EXECUTE format('ALTER ROLE %I IN DATABASE %I SET %s TO %s', pg_get_userbyid(r.setrole), nm, k, lit);
    END IF;
  END LOOP;
END $$"#, next = ident(&n.next), live = ident(&n.live))
}

/// Databases to drop: keep at most ONE `pos_prev_*` and ONE `pos_failed_*`, each only for 7 days (conventions 7).
pub fn prune_plan(names: &BTreeSet<String>, now_ms: u64) -> Vec<String> {
    let mut drop = vec![];
    let stamp_of = |n: &str| -> Option<u64> { parse_stamp(n.rsplit('_').next()?) };
    for family in [&["pos_prev_"][..], &["pos_failed_"][..]] {
        let mut mine: Vec<(u64, &String)> = names.iter()
            .filter(|n| family.iter().any(|p| n.starts_with(p)) && valid_ident(n)) // an unsafe name is never planned: ident() would panic on it
            .filter_map(|n| Some((stamp_of(n)?, n))).collect();
        mine.sort_by_key(|m| std::cmp::Reverse(m.0));
        for (i, (ts, name)) in mine.iter().enumerate() {
            if i > 0 || now_ms.saturating_sub(*ts) > WEEK_MS { drop.push((*name).clone()); }
        }
    }
    drop
}

#[derive(Debug, PartialEq, Eq)]
pub enum DiskVerdict { Ok, OkAfterDroppingOld, Short { need: u64 } }

/// Free space must cover clone + WAL + dump + rewrites: 3x the database plus a floor (S8 review I3).
pub fn disk_ok(free: u64, db_bytes: u64, droppable: u64) -> DiskVerdict {
    let need = db_bytes.saturating_mul(3).saturating_add(FLOOR_BYTES);
    if free >= need { DiskVerdict::Ok }
    else if free.saturating_add(droppable) >= need { DiskVerdict::OkAfterDroppingOld }
    else { DiskVerdict::Short { need } }
}

/// The gate a caller runs BEFORE `create_clone`: a short disk is a refusal (`Precondition`, nothing touched).
pub fn disk_gate(free: u64, db_bytes: u64, droppable: u64) -> R<DiskVerdict> {
    match disk_ok(free, db_bytes, droppable) {
        DiskVerdict::Short { need } => Err(OpError::new(OpCode::Precondition, "DISK_SHORT",
            format!("not enough free disk space for the update: {} GiB needed, {} GiB free", need >> 30, free >> 30))),
        v => Ok(v),
    }
}

/// Re-execution guards (a crash between the SQL and the journal write makes the runner repeat the call).
/// Swap is done when `prev` exists and `next` is gone; ambiguous states are left to the SQL, which fails closed.
pub fn swap_done(names: &BTreeSet<String>, n: &DbNames) -> bool { names.contains(&n.prev) && !names.contains(&n.next) }
pub fn swap_back_done(names: &BTreeSet<String>, n: &DbNames) -> bool { names.contains(&n.failed) && !names.contains(&n.prev) }

#[cfg(windows)]
pub fn free_bytes(path: &Path) -> R<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut free), None, None) }
        .map_err(|e| OpError::err("DISK_QUERY", e.to_string()))?;
    Ok(free)
}
#[cfg(not(windows))]
pub fn free_bytes(_path: &Path) -> R<u64> { Ok(u64::MAX) }

/// Milliseconds left of the operation's maintenance budget, read when a psql child starts.
#[derive(Clone)]
pub struct Remaining(pub std::sync::Arc<dyn Fn(StmtClass) -> u64 + Send + Sync>);

/// How long past its statement timeout a child is left alone before posctl kills it: the server has already been told to
/// stop at the timeout (and a lock wait is at most `LOCK_TIMEOUT_S`), so the kill is only the last resort. Quick statements
/// get a short margin, the clone and REINDEX a long one.
pub fn kill_margin_ms(class: StmtClass) -> u64 {
    match class { StmtClass::Quick => 15_000, StmtClass::Default => 30_000, StmtClass::Heavy => 60_000 }
}

/// What a statement is allowed to take. `Quick` (renames, ALTER ROLE, terminate) is capped at one minute always; `Default`
/// is everything else; `Heavy` is the clone and REINDEX. The caller's budget closure maps a class to milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtClass { Quick, Default, Heavy }
impl std::fmt::Debug for Remaining {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Remaining(..)") }
}

#[derive(Debug, Clone)]
pub struct PsqlAdmin {
    pub psql: PathBuf, pub host: String, pub port: u16, pub user: String, pub pgpass: PathBuf,
    /// The operation's remaining budget; `None` (status checks, tests) means the long default.
    pub remaining: Option<Remaining>,
    /// Replaces the per-class kill margin (tests only); `None` = `kill_margin_ms(class)`.
    pub margin_override_ms: Option<u64>,
}

impl PsqlAdmin {
    pub fn new(psql: PathBuf, port: u16, pgpass: PathBuf) -> Self {
        PsqlAdmin { psql, host: "127.0.0.1".into(), port, user: "supabase_admin".into(), pgpass, remaining: None, margin_override_ms: None }
    }
    /// Tie every psql call to the operation's remaining budget (the runner's deadline minus now).
    pub fn with_budget(mut self, remaining: impl Fn(StmtClass) -> u64 + Send + Sync + 'static) -> Self {
        self.remaining = Some(Remaining(std::sync::Arc::new(remaining)));
        self
    }
    fn base(&self, db: &str) -> Vec<String> {
        // -w: never prompt (a missing pgpass entry must fail, not block a console). terse + no context: the server's
        // error text never quotes the statement, so a \set secret cannot come back in an error.
        ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never",
         "-h", &self.host, "-p", &self.port.to_string(), "-U", &self.user, "-d", db]
            .iter().map(|s| s.to_string()).collect()
    }
    pub fn args(&self, db: &str, sql: &str) -> Vec<String> { let mut a = self.base(db); a.extend(["-c".into(), sql.into()]); a }

    /// The statement timeout the server is given: what is left of the operation budget (never less than a second).
    fn statement_ms(&self, class: StmtClass) -> u64 {
        let dflt = match class { StmtClass::Quick => 60_000, StmtClass::Default => 600_000, StmtClass::Heavy => DEFAULT_BUDGET_MS };
        self.remaining.as_ref().map(|r| (r.0)(class)).unwrap_or(dflt).clamp(1_000, i32::MAX as u64)
    }
    fn command(&self, args: Vec<String>, statement_ms: u64) -> Command {
        let mut c = Command::new(&self.psql);
        c.args(args);
        // every inherited PG* variable can outrank PGPASSFILE or change the connection (pg.rs owns the scrub); the tool's own dir is the cwd
        crate::pg::scrub_pg_env(&mut c);
        if let Some(d) = self.psql.parent().filter(|d| !d.as_os_str().is_empty()) { c.current_dir(d); }
        c.env("PGPASSFILE", &self.pgpass).env("PGCONNECT_TIMEOUT", "5").env("PGCLIENTENCODING", "UTF8")
            .env("PGOPTIONS", format!("-c lock_timeout={LOCK_TIMEOUT_S}s -c statement_timeout={statement_ms}"));
        c
    }
    /// Run psql with the server-side limits set and a longer backstop on the child. Killing psql alone would not stop a
    /// backend that already has the statement, so the server limits come first and the kill is only the last resort.
    fn run_with(&self, args: Vec<String>, stdin: Option<String>, secrets: &[String], class: StmtClass) -> R<String> {
        let ms = self.statement_ms(class);
        let margin = self.margin_override_ms.unwrap_or_else(|| kill_margin_ms(class));
        let out = exec_backstop(self.command(args, ms), stdin, Duration::from_millis(ms.saturating_add(margin)))
            .map_err(|e| OpError::err("PSQL_SPAWN", e.to_string()))?;
        if out.timed_out {
            return Err(OpError::err("PSQL_TIMEOUT", format!("psql did not finish within {} ms and was stopped", ms.saturating_add(margin))));
        }
        if out.code != Some(0) {
            let msg = scrub(&out.stderr, secrets);
            let reason = if msg.contains("statement timeout") || msg.contains("lock timeout") { "PSQL_TIMEOUT" } else { "PSQL_FAILED" };
            return Err(OpError::err(reason, msg));
        }
        Ok(out.stdout.trim().to_string())
    }
    fn run(&self, args: Vec<String>) -> R<String> { self.run_with(args, None, &[], StmtClass::Default) }
    pub fn scalar(&self, db: &str, sql: &str) -> R<String> { self.run(self.args(db, sql)) }
    pub fn exec(&self, db: &str, sql: &str) -> R<()> { self.run(self.args(db, sql)).map(|_| ()) }
    /// `scalar` with an explicit statement class (catalog reads are `Quick`).
    pub fn scalar_class(&self, db: &str, sql: &str, class: StmtClass) -> R<String> { self.run_with(self.args(db, sql), None, &[], class) }
    /// `exec` with an explicit statement class (renames and role changes are `Quick`; the clone and REINDEX are `Heavy`).
    pub fn exec_class(&self, db: &str, sql: &str, class: StmtClass) -> R<()> {
        self.run_with(self.args(db, sql), None, &[], class).map(|_| ())
    }

    /// Same server, another login role (run-order.json names the role per step; pgpass has all four).
    pub fn with_user(&self, user: &str) -> PsqlAdmin { PsqlAdmin { user: user.to_string(), ..self.clone() } }

    /// Conventions 17: secrets reach psql as `\set` lines on STDIN, never on a command line or in a written .sql file. The file's TEXT
    /// follows on the same stdin, exactly as provision feeds a step (`runorder::psql_header` + the text): psql reads `-f -` in text mode but
    /// `-f <file>` / `\i` in binary mode, which would leave a CRLF checkout's carriage returns inside `$$` bodies and so in the catalog digest.
    pub fn stdin_script(vars: &[(String, String)], sql: &str) -> Result<String, String> {
        Ok(format!("{}{sql}", crate::runorder::psql_header(vars)?))
    }
    pub fn run_file_vars(&self, db: &str, file: &Path, vars: &[(String, String)]) -> R<()> {
        self.run_file_opts(db, file, vars, false, &[])
    }
    /// One `kind: "sql"` step of run-order.json: `single` = `--single-transaction`, `extra` = the file's `psqlArgs`.
    /// Secrets (`vars`) go in as `\set` lines on stdin, ahead of the file's text.
    pub fn run_file_opts(&self, db: &str, file: &Path, vars: &[(String, String)], single: bool, extra: &[String]) -> R<()> {
        let mut a = self.base(db);
        a.extend(extra.iter().cloned());
        if single { a.push("--single-transaction".to_string()); }
        a.extend(["-f".to_string(), "-".to_string()]);
        let sql = std::fs::read_to_string(file).map_err(|e| OpError::err("PSQL_FILE", format!("cannot read {}: {e}", file.display())))?;
        let input = Self::stdin_script(vars, &sql).map_err(|e| OpError::err("PSQL_FILE", e))?;
        let secrets: Vec<String> = vars.iter().map(|(_, v)| v.clone()).collect();
        self.run_with(a, Some(input), &secrets, StmtClass::Default).map(|_| ())
    }
    /// One SQL script on STDIN (`-f -`), behind the QUIET prelude so no server log line carries a statement: for text that holds
    /// derived passwords. `secrets` are replaced by `***` in any error. Returns psql's trimmed stdout.
    pub fn script(&self, db: &str, text: &str, secrets: &[&str], class: StmtClass) -> R<String> {
        use crate::backup::rederive::QUIET;
        let mut a = self.base(db);
        a.extend(["-f".to_string(), "-".to_string()]);
        let input = if text.starts_with(QUIET) { text.to_string() } else { format!("{QUIET}{text}") };
        let secrets: Vec<String> = secrets.iter().map(|s| s.to_string()).collect();
        self.run_with(a, Some(input), &secrets, class)
    }
}

const DEFAULT_BUDGET_MS: u64 = 30 * 60_000;
const LOCK_TIMEOUT_S: u32 = 10;
const STDERR_CAP: usize = 2048;

/// Every secret replaced by `***` (also in its quote-doubled form), then capped to the last ~2 KB.
fn scrub(stderr: &str, secrets: &[String]) -> String {
    let mut t = stderr.trim().to_string();
    for s in secrets.iter().filter(|s| !s.is_empty()) {
        t = t.replace(&s.replace('\'', "''"), "***").replace(s.as_str(), "***");
    }
    if t.len() > STDERR_CAP {
        let mut cut = t.len() - STDERR_CAP;
        while !t.is_char_boundary(cut) { cut += 1; }
        t = format!("...{}", &t[cut..]);
    }
    t
}

struct Exec { code: Option<i32>, timed_out: bool, stdout: String, stderr: String }

/// Run a child with piped output and optional stdin, killing it when `limit` passes. Output is drained on threads
/// (no pipe deadlock). (`ops::proc::run_with_timeout` writes files and returns only a tail; psql's stdout is the answer here.)
fn exec_backstop(mut cmd: Command, stdin: Option<String>, limit: Duration) -> std::io::Result<Exec> {
    use std::io::{Read, Write};
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let feeder = child.stdin.take().map(|mut si| {
        let data = stdin.unwrap_or_default();
        std::thread::spawn(move || { let _ = si.write_all(data.as_bytes()); })
    });
    let drain = |mut r: Box<dyn Read + Send>| std::thread::spawn(move || { let mut b = Vec::new(); let _ = r.read_to_end(&mut b); b });
    let out_h = drain(Box::new(child.stdout.take().expect("piped")));
    let err_h = drain(Box::new(child.stderr.take().expect("piped")));
    let started = Instant::now();
    let (code, timed_out) = loop {
        if let Some(st) = child.try_wait()? { break (st.code(), false); }
        if started.elapsed() >= limit { let _ = child.kill(); let _ = child.wait(); break (None, true); }
        std::thread::sleep(Duration::from_millis(25));
    };
    // A killed child can leave a grandchild holding the pipes open: do not wait for them (the reader threads end with it).
    if timed_out { return Ok(Exec { code, timed_out, stdout: String::new(), stderr: String::new() }); }
    if let Some(f) = feeder { let _ = f.join(); }
    let text = |h: std::thread::JoinHandle<Vec<u8>>| String::from_utf8_lossy(&h.join().unwrap_or_default()).into_owned();
    Ok(Exec { code, timed_out, stdout: text(out_h), stderr: text(err_h) })
}

pub struct RealDb { pub admin: PsqlAdmin }

impl RealDb {
    pub fn names(&self) -> R<BTreeSet<String>> {
        Ok(self.admin.scalar_class("template1", NAMES_SQL, StmtClass::Quick)?.lines().map(|l| l.trim().to_string()).collect())
    }
    pub fn size_bytes(&self, db: &str) -> R<u64> {
        checked(db)?;
        self.admin.scalar("template1", &size_sql(db))?.parse().map_err(|_| OpError::err("DB_SIZE", "unparseable size"))
    }
    pub fn owner(&self, db: &str) -> R<String> {
        self.admin.scalar("template1", &owner_sql(db))
    }
    pub fn terminate(&self, dbs: &[&str]) -> R<()> { self.admin.exec_class("template1", &terminate_sql(dbs), StmtClass::Quick) }
    /// Idempotent: `DROP DATABASE IF EXISTS`.
    pub fn drop_db(&self, name: &str) -> R<()> { checked(name)?; self.admin.exec("template1", &drop_sql(name)) }

    /// FILE_COPY needs zero sessions on the template: terminate and retry (S8 B-hold).
    /// Idempotent: any earlier (possibly half-built) clone is dropped first, so a repeat rebuilds it.
    pub fn create_clone(&self, n: &DbNames) -> R<()> {
        let owner = self.owner(&n.live)?;
        let mut last = OpError::err("CLONE_FAILED", "no attempt made");
        for _ in 0..10 {
            self.drop_db(&n.next)?;
            match self.admin.exec_class("template1", &create_clone_sql(n, &owner), StmtClass::Heavy) {
                Ok(()) => return self.admin.exec("template1", &replay_attrs_sql(n)),
                Err(e) => { last = e; let _ = self.terminate(&[&n.live]); std::thread::sleep(std::time::Duration::from_millis(500)); }
            }
        }
        Err(OpError::new(OpCode::RolledBack, "CLONE_FAILED", last.message))
    }
    /// Retry the rename while sessions are terminated. Before each retry the postcondition is re-read: a statement that
    /// timed out client-side may still have committed on the server.
    fn rename_txn(&self, sql: String, dbs: &[&str], reason: &str, done: &dyn Fn(&BTreeSet<String>) -> bool) -> R<()> {
        let mut last = String::new();
        for attempt in 0..6 {
            if attempt > 0 {
                if let Ok(names) = self.names() { if done(&names) { return Ok(()); } }
            }
            let _ = self.terminate(dbs);
            match self.admin.exec_class("template1", &sql, StmtClass::Quick) { Ok(()) => return Ok(()), Err(e) => last = e.message }
            std::thread::sleep(Duration::from_millis(700));
        }
        if let Ok(names) = self.names() { if done(&names) { return Ok(()); } }
        Err(OpError::err(reason, last))
    }
    /// Idempotent: a repeat after the rename committed is a no-op (`prev` exists, `next` is gone).
    pub fn swap(&self, n: &DbNames) -> R<()> {
        if swap_done(&self.names()?, n) { return Ok(()); }
        self.rename_txn(swap_sql(n), &[&n.live, &n.next], "SWAP_FAILED", &|x| swap_done(x, n))
    }
    /// Idempotent: a repeat after the swap-back committed is a no-op (`failed` exists, `prev` is gone).
    pub fn swap_back(&self, n: &DbNames) -> R<()> {
        if swap_back_done(&self.names()?, n) { return Ok(()); }
        self.rename_txn(swap_back_sql(n), &[&n.live, &n.prev], "SWAP_BACK_FAILED", &|x| swap_back_done(x, n))
    }
    pub fn set_login(&self, roles: &[String], login: bool) -> R<()> {
        if roles.is_empty() { return Ok(()); }
        if roles.iter().any(|r| r == &self.admin.user) {
            return Err(OpError::err("ROLE_IS_ADMIN", "refusing to change the login of the role posctl itself connects as"));
        }
        self.admin.exec_class("template1", &login_sql(roles, login), StmtClass::Quick)?;
        if !login {
            self.admin.exec_class("template1", &terminate_roles_sql(roles), StmtClass::Quick)?;
        }
        Ok(())
    }
    /// A changed ICU build makes stored text-index order untrustworthy (S8 review): detect on the running binary.
    pub fn collation_mismatch(&self, db: &str) -> R<bool> {
        Ok(self.admin.scalar_class("template1", &collation_sql(db), StmtClass::Quick)? == "t")
    }
    /// REINDEX then REFRESH, both from a connection to that database (both statements require it).
    pub fn repair_collation(&self, db: &str) -> R<()> {
        self.admin.exec_class(db, &format!(r#"REINDEX DATABASE "{0}""#, ident(db)), StmtClass::Heavy)?;
        self.admin.exec(db, &format!(r#"ALTER DATABASE "{0}" REFRESH COLLATION VERSION"#, ident(db)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::OpKind;

    fn n() -> DbNames { DbNames::for_kind(OpKind::Update, 1_790_908_215_000) }

    #[test]
    fn the_clone_uses_file_copy_and_the_live_owner() {
        assert_eq!(
            create_clone_sql(&n(), "postgres"),
            r#"CREATE DATABASE "pos_next" TEMPLATE "postgres" STRATEGY = FILE_COPY OWNER "postgres""#
        );
    }

    #[test]
    fn swap_is_one_transaction_renaming_from_template1() {
        let s = swap_sql(&n());
        assert_eq!(s, r#"BEGIN; ALTER DATABASE "postgres" RENAME TO "pos_prev_update_20261002023015"; ALTER DATABASE "pos_next" RENAME TO "postgres"; COMMIT"#);
        assert_eq!(swap_back_sql(&n()), r#"BEGIN; ALTER DATABASE "postgres" RENAME TO "pos_failed_20261002023015"; ALTER DATABASE "pos_prev_update_20261002023015" RENAME TO "postgres"; COMMIT"#);
    }

    #[test]
    fn identifiers_outside_the_safe_alphabet_never_reach_sql() {
        let mut bad = n(); bad.next = "pos\";drop".into();
        assert!(std::panic::catch_unwind(|| create_clone_sql(&bad, "postgres")).is_err());
    }

    #[test]
    fn terminate_and_login_sql() {
        assert_eq!(terminate_sql(&["postgres", "pos_next"]),
            "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname IN ('postgres','pos_next') AND pid <> pg_backend_pid()");
        assert_eq!(login_sql(&["authenticator".into(), "supabase_auth_admin".into()], false),
            r#"ALTER ROLE "authenticator" NOLOGIN; ALTER ROLE "supabase_auth_admin" NOLOGIN"#);
        assert!(login_sql(&["authenticator".into()], true).ends_with("LOGIN"));
    }

    #[test]
    fn no_password_ever_appears_in_psql_arguments() {
        let a = PsqlAdmin::new("psql.exe".into(), 47300, r"C:\x\pgpass.conf".into());
        let joined = a.args("postgres", "SELECT 1").join(" ");
        assert!(!joined.to_lowercase().contains("password") && !joined.contains("PGPASSWORD"));
        assert!(joined.contains("-h 127.0.0.1") && joined.contains("-U supabase_admin") && joined.contains("ON_ERROR_STOP=1"));
    }

    #[test]
    fn secrets_go_in_as_set_lines_on_stdin_ahead_of_the_file_text() {
        let s = PsqlAdmin::stdin_script(&[("pw_owner".into(), "ab12".into())], "select 1;\n").unwrap();
        assert_eq!(s, "SET log_min_error_statement = panic;\n\\set pw_owner 'ab12'\nselect 1;\n");
        assert_eq!(PsqlAdmin::stdin_script(&[], "select 1;\n").unwrap(), "select 1;\n", "no vars: the text only, as provision sends it");
        assert!(PsqlAdmin::stdin_script(&[("pw_owner".into(), "a'b".into())], "x").is_err(), "a value that needs quoting is refused");
    }

    fn set(v: &[&str]) -> BTreeSet<String> { v.iter().map(|s| s.to_string()).collect() }
    const DAY: u64 = 86_400_000;

    #[test]
    fn prune_keeps_one_recent_prev_and_drops_older_and_stale_failed() {
        let now = 1_790_908_215_000u64; // 20261002023015
        let names = set(&["postgres", "pos_prev_update_20261001023015", "pos_prev_switch_20260920023015",
                          "pos_prev_update_20260901023015", "pos_failed_20260930023015", "pos_failed_20260925023015", "pos_next"]);
        let mut drop = prune_plan(&names, now);
        drop.sort();
        assert_eq!(drop, vec!["pos_failed_20260925023015", "pos_prev_switch_20260920023015", "pos_prev_update_20260901023015"]);
        // The newest prev is older than 7 days: it goes too.
        let late = now + 8 * DAY;
        assert!(prune_plan(&names, late).contains(&"pos_prev_update_20261001023015".to_string()));
        // pos_next and postgres are never pruned here.
        assert!(!prune_plan(&names, late).iter().any(|x| x == "pos_next" || x == "postgres"));
    }

    #[test]
    fn disk_rule_is_three_times_the_database_plus_a_floor_and_drops_old_copies_first() {
        let gib = 1u64 << 30;
        let need = 3 * 10 * gib + 2 * gib;
        assert_eq!(disk_ok(need, 10 * gib, 0), DiskVerdict::Ok);
        assert_eq!(disk_ok(need - 1, 10 * gib, 0), DiskVerdict::Short { need });
        assert_eq!(disk_ok(need - 5 * gib, 10 * gib, 10 * gib), DiskVerdict::OkAfterDroppingOld);
        assert_eq!(disk_ok(0, 0, 0), DiskVerdict::Short { need: 2 * gib });
    }

    // --- additions beyond the brief: the clone is refused on short disk, and re-running swap steps is safe ---
    #[test]
    fn a_short_disk_refuses_the_clone_with_a_precondition_and_names_the_need() {
        let gib = 1u64 << 30;
        let e = disk_gate(5 * gib, 10 * gib, 0).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (crate::ops::outcome::OpCode::Precondition, "DISK_SHORT"));
        assert!(e.message.contains("32"), "{}", e.message); // 32 GiB needed
        assert_eq!(disk_gate(40 * gib, 10 * gib, 0).unwrap(), DiskVerdict::Ok);
        assert_eq!(disk_gate(20 * gib, 10 * gib, 20 * gib).unwrap(), DiskVerdict::OkAfterDroppingOld);
    }

    #[test]
    fn a_swap_whose_postcondition_already_holds_is_recognised() {
        let x = n();
        assert!(swap_done(&set(&["postgres", &x.prev]), &x));
        assert!(!swap_done(&set(&["postgres", "pos_next"]), &x));
        assert!(!swap_done(&set(&["postgres", &x.prev, "pos_next"]), &x)); // ambiguous: let the SQL decide
        assert!(swap_back_done(&set(&["postgres", &x.failed]), &x));
        assert!(!swap_back_done(&set(&["postgres", &x.prev]), &x));
    }

    #[test]
    fn psql_failures_close_the_door_the_exit_code_is_the_verdict() {
        let a = PsqlAdmin::new("definitely-not-a-psql.exe".into(), 1, "x".into());
        let e = a.exec("template1", "SELECT 1").unwrap_err();
        assert_eq!(e.reason, "PSQL_SPAWN");
    }


    // --- FR3: time limits, child hygiene, secret scrubbing, set_login guards, lossless replay ---
    fn fake_psql(body: &str) -> (tempfile::TempDir, PsqlAdmin) {
        let d = tempfile::tempdir().unwrap();
        let psql = d.path().join("psql.cmd");
        std::fs::write(&psql, format!("@echo off
{body}
")).unwrap();
        let pgpass = d.path().join("pgpass.conf");
        std::fs::write(&pgpass, "x").unwrap();
        (d, PsqlAdmin::new(psql, 47300, pgpass))
    }

    #[test]
    fn a_psql_that_hangs_is_cut_off_within_the_budget_and_reports_a_timeout() {
        let (_d, a) = fake_psql("ping -n 30 127.0.0.1 >nul");
        let a = PsqlAdmin { margin_override_ms: Some(300), ..a.with_budget(|_| 1_000) };
        let t = std::time::Instant::now();
        let e = a.exec("template1", "SELECT 1").unwrap_err();
        assert_eq!(e.reason, "PSQL_TIMEOUT", "{e:?}");
        assert!(t.elapsed() < std::time::Duration::from_secs(4), "took {:?}", t.elapsed());
    }

    #[test]
    fn the_server_is_told_the_limits_through_pgoptions_scaled_from_the_budget() {
        let (d, a) = fake_psql("echo %PGOPTIONS%>\"%~dp0env.txt\"");
        a.with_budget(|_| 120_000).exec("template1", "SELECT 1").unwrap();
        let env = std::fs::read_to_string(d.path().join("env.txt")).unwrap();
        assert!(env.contains("-c lock_timeout=10s") && env.contains("-c statement_timeout=120000"), "{env}");
    }

    #[test]
    fn script_sends_the_quiet_prelude_on_stdin_and_never_on_the_command_line() {
        let (d, a) = fake_psql("echo %*>\"%~dp0argv.txt\"\nfindstr \"^\" >\"%~dp0in.txt\"");
        a.script("postgres", "SELECT 'S3CRET';\n", &["S3CRET"], StmtClass::Default).unwrap();
        let (argv, input) = (std::fs::read_to_string(d.path().join("argv.txt")).unwrap(), std::fs::read_to_string(d.path().join("in.txt")).unwrap());
        assert!(input.starts_with("SET log_statement = 'none';"), "{input}");
        assert!(input.contains("SELECT 'S3CRET';") && argv.contains("-f -") && !argv.contains("S3CRET") && !argv.contains("log_statement"), "{argv}");
    }

    #[test]
    fn script_errors_never_carry_a_listed_secret() {
        let (_d, a) = fake_psql("echo ERROR with S3CRET inside 1>&2\nexit /b 3");
        let e = a.script("postgres", "SELECT 1;", &["S3CRET"], StmtClass::Quick).unwrap_err();
        assert_eq!(e.reason, "PSQL_FAILED");
        assert!(!e.message.contains("S3CRET") && e.message.contains("***"), "{}", e.message);
    }

    #[test]
    fn psql_never_prompts_and_never_inherits_a_password_or_options_from_the_parent() {
        let a = PsqlAdmin::new("psql.exe".into(), 47300, "x".into());
        assert!(a.args("postgres", "SELECT 1").contains(&"-w".to_string()));
        let (d, a) = fake_psql("echo [%PGPASSWORD%][%PGSERVICE%]>\"%~dp0env.txt\"");
        std::env::set_var("PGPASSWORD", "inherited-secret");
        std::env::set_var("PGSERVICE", "inherited-service");
        let r = a.exec("template1", "SELECT 1");
        std::env::remove_var("PGPASSWORD");
        std::env::remove_var("PGSERVICE");
        r.unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("env.txt")).unwrap().trim(), "[][]");
    }

    #[test]
    fn a_secret_echoed_by_psql_never_reaches_the_error_text() {
        let (d, a) = fake_psql("echo LINE 1: ALTER ROLE x PASSWORD 's3cr3tvalue' 1>&2
exit /b 3");
        let f = d.path().join("x.sql");
        std::fs::write(&f, "select 1").unwrap();
        let e = a.run_file_vars("postgres", &f, &[("pw".into(), "s3cr3tvalue".into())]).unwrap_err();
        assert_eq!(e.reason, "PSQL_FAILED");
        assert!(!e.message.contains("s3cr3tvalue"), "{}", e.message);
        assert!(e.message.contains("***"), "{}", e.message);
    }

    #[test]
    fn psql_is_asked_for_terse_errors_without_context() {
        let a = PsqlAdmin::new("psql.exe".into(), 47300, "x".into());
        let j = a.args("postgres", "SELECT 1").join(" ");
        assert!(j.contains("VERBOSITY=terse") && j.contains("SHOW_CONTEXT=never"), "{j}");
    }

    #[test]
    fn set_login_never_touches_the_role_it_connects_as_and_never_runs_an_empty_list() {
        let (d, a) = fake_psql("echo x>>\"%~dp0calls.log\"");
        let db = RealDb { admin: a };
        let e = db.set_login(&["authenticator".into(), "supabase_admin".into()], false).unwrap_err();
        assert_eq!(e.reason, "ROLE_IS_ADMIN");
        db.set_login(&[], false).unwrap();
        assert!(!d.path().join("calls.log").exists(), "nothing may reach the server for a refused or empty request");
    }

    #[test]
    fn terminating_sessions_never_kills_our_own() {
        let sql = terminate_roles_sql(&["authenticator".into()]);
        assert!(sql.contains("pid <> pg_backend_pid()"), "{sql}");
        assert!(sql.contains("usename IN ('authenticator')"), "{sql}");
    }

    #[test]
    fn the_clone_replay_removes_default_public_access_first_and_keeps_list_settings_as_lists() {
        let sql = replay_attrs_sql(&n());
        assert!(sql.contains("REVOKE ALL ON DATABASE"), "a revoked CONNECT must stay revoked");
        assert!(sql.contains("FROM PUBLIC"), "{sql}");
        for name in ["search_path", "temp_tablespaces", "session_preload_libraries"] { assert!(sql.contains(name), "{name}"); }
        assert!(sql.contains("string_agg(quote_literal"), "list values are quoted per element");
    }

    /// Positions where a call, list or tuple has an empty argument: `(,`, `,,` or `,)` outside string literals
    /// and comments. A server rejects every one of them (`coalesce(lit, )` shipped once).
    fn empty_argument_positions(sql: &str) -> Vec<String> {
        let b: Vec<char> = sql.chars().collect();
        let mut sig: Vec<(char, usize)> = vec![];
        let (mut in_str, mut i) = (false, 0);
        while i < b.len() {
            let c = b[i];
            if in_str {
                if c == '\'' { in_str = false; }
            } else if c == '\'' {
                in_str = true;
                sig.push(('s', i));
            } else if c == '-' && b.get(i + 1) == Some(&'-') {
                while i < b.len() && b[i] != '\n' { i += 1; }
                continue;
            } else if !c.is_whitespace() {
                sig.push((c, i));
            }
            i += 1;
        }
        sig.windows(2)
            .filter(|w| matches!((w[0].0, w[1].0), ('(', ',') | (',', ',') | (',', ')')))
            .map(|w| format!("{}{} near: {}", w[0].0, w[1].0, b[w[0].1.saturating_sub(20)..(w[0].1 + 20).min(b.len())].iter().collect::<String>().replace('\n', " ")))
            .collect()
    }

    #[test]
    fn the_empty_argument_check_itself_bites() {
        assert!(!empty_argument_positions("SELECT coalesce(lit, );").is_empty());
        assert!(!empty_argument_positions("f(a,,b)").is_empty());
        assert!(!empty_argument_positions("f(,a)").is_empty());
        assert!(empty_argument_positions("f(a, ',', ')', 'it''s') -- (,)\n").is_empty());
    }


    #[test]
    fn no_generated_sql_has_an_empty_argument_and_the_empty_list_default_is_a_quoted_empty_literal() {
        let names = n();
        for sql in [replay_attrs_sql(&names), create_clone_sql(&names, "postgres"), swap_sql(&names), swap_back_sql(&names),
                    drop_sql(&names.next), terminate_sql(&["postgres"]), terminate_roles_sql(&["authenticator".into()]),
                    login_sql(&["authenticator".into(), "supabase_auth_admin".into()], true)] {
            assert!(empty_argument_positions(&sql).is_empty(), "{:?} in {sql}", empty_argument_positions(&sql));
            assert!(!sql.contains("coalesce(lit, )"));
        }
        assert!(replay_attrs_sql(&names).contains("coalesce(lit, quote_literal(''))"), "an empty list setting is SET x TO ''");
    }

    #[test]
    fn the_kill_margins_grow_with_the_statement_class_and_always_outlast_the_lock_wait() {
        use StmtClass::*;
        assert_eq!(LOCK_TIMEOUT_S, 10);
        assert_eq!((kill_margin_ms(Quick), kill_margin_ms(Default), kill_margin_ms(Heavy)), (15_000, 30_000, 60_000));
        for c in [Quick, Default, Heavy] { assert!(kill_margin_ms(c) >= u64::from(LOCK_TIMEOUT_S) * 1000 + 5_000, "{c:?}"); }
        assert!(kill_margin_ms(Heavy) >= 3 * u64::from(LOCK_TIMEOUT_S) * 1000);
    }

    use crate::ops::test_cluster::TestCluster;

    // real_ tests: compiled here, run only in Windows Sandbox (owner rule); never on the developer PC.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_clone_replays_acl_and_settings_and_swaps_both_ways() {
        let c = TestCluster::start(0);
        let db = RealDb { admin: c.admin.clone() };
        let a = &c.admin;
        a.exec("template1", "CREATE ROLE s7_probe NOLOGIN").unwrap();
        a.exec("template1", "GRANT CONNECT ON DATABASE postgres TO s7_probe").unwrap();
        a.exec("template1", "ALTER DATABASE postgres SET work_mem TO '7MB'").unwrap();
        a.exec("template1", "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC").unwrap();
        a.exec("template1", "ALTER DATABASE postgres SET search_path TO '$user', 'public'").unwrap();
        a.exec("template1", "ALTER DATABASE postgres SET temp_tablespaces TO ''").unwrap(); // the empty list the coalesce default serves
        a.exec("template1", "ALTER ROLE s7_probe IN DATABASE postgres SET work_mem TO '9MB'").unwrap();
        a.exec("postgres", "CREATE TABLE marker(v text); INSERT INTO marker VALUES ('old')").unwrap();
        let names = DbNames::for_kind(OpKind::Update, 1_790_908_215_000);
        db.create_clone(&names).unwrap();
        a.exec("pos_next", "UPDATE marker SET v = 'new'").unwrap();
        // the ACL is the same SET of rows on the clone as on the live database (owner row excluded: the owner is replayed by CREATE)
        let acl = |db: &str| a.scalar("template1", &format!(
            "SELECT string_agg(coalesce(pg_get_userbyid(NULLIF(x.grantee,0)),'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable, ',' ORDER BY coalesce(pg_get_userbyid(NULLIF(x.grantee,0)),'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable)              FROM pg_database d, aclexplode(d.datacl) x WHERE d.datname = '{db}' AND x.grantee <> d.datdba")).unwrap();
        assert_eq!(acl("pos_next"), acl("postgres"), "ACL rows differ between clone and live");
        assert!(acl("pos_next").contains("s7_probe:CONNECT"), "{}", acl("pos_next"));
        assert!(!acl("pos_next").contains("PUBLIC:CONNECT"), "a CONNECT revoked from PUBLIC came back: {}", acl("pos_next"));
        // the settings are identical to the live ones, exactly (db-wide and per-role, list values kept as lists)
        let cfg = |db: &str| a.scalar("template1", &format!(
            "SELECT string_agg(s.setrole::regrole::text || '=' || s.setconfig::text, ';' ORDER BY s.setrole::regrole::text, s.setconfig::text)              FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = '{db}'")).unwrap();
        assert_eq!(cfg("pos_next"), cfg("postgres"), "settings differ between clone and live");
        let c = cfg("pos_next");
        for part in ["work_mem=7MB", "$user", "public", "temp_tablespaces=", "work_mem=9MB"] { assert!(c.contains(part), "{part} missing from {c}"); }
        db.swap(&names).unwrap();
        assert_eq!(a.scalar("postgres", "SELECT v FROM marker").unwrap(), "new");
        assert!(db.names().unwrap().contains(&names.prev));
        db.swap(&names).unwrap(); // a repeat is a no-op
        db.swap_back(&names).unwrap();
        assert_eq!(a.scalar("postgres", "SELECT v FROM marker").unwrap(), "old");
        assert!(db.names().unwrap().contains(&names.failed));
        db.swap_back(&names).unwrap(); // a repeat is a no-op
    }

    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_collation_mismatch_is_detected_and_repaired() {
        let c = TestCluster::start(1);
        let db = RealDb { admin: c.admin.clone() };
        assert!(!db.collation_mismatch("postgres").unwrap());
        c.admin.exec("template1", "UPDATE pg_database SET datcollversion = 'bogus' WHERE datname = 'postgres'").unwrap();
        assert!(db.collation_mismatch("postgres").unwrap());
        db.repair_collation("postgres").unwrap();
        assert!(!db.collation_mismatch("postgres").unwrap());
    }

    // ---- FR7 N ----
    #[test]
    fn prune_plan_never_names_an_unsafe_identifier() {
        let names: BTreeSet<String> = ["pos_prev_UPDATE_20200101000000", "pos_prev_ok_20200101000000", "pos_failed_x-y_20200101000000"].iter().map(|s| s.to_string()).collect();
        assert_eq!(prune_plan(&names, 1_790_908_215_000), vec!["pos_prev_ok_20200101000000".to_string()]);
    }

    #[test]
    fn sizing_or_dropping_an_unsafe_name_is_an_error_and_never_a_panic() {
        let db = RealDb { admin: PsqlAdmin::new("psql.exe".into(), 47300, "x".into()) };
        for bad in ["Bad Name", "pos_prev_UPDATE_1", "x\"; DROP DATABASE postgres; --"] {
            assert_eq!(db.size_bytes(bad).unwrap_err().reason, "BAD_DB_NAME", "{bad}");
            assert_eq!(db.drop_db(bad).unwrap_err().reason, "BAD_DB_NAME", "{bad}");
        }
    }
}
