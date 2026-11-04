//! psql / pg_dump plumbing: connection description, the exported-snapshot session, SQL texts.
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::ctx::BackupCtx;
use super::dump::DbInfo;
use super::result::{BResult, BackupError};
use super::util::{tail, Exec};
use crate::ops::names::NEXT;

#[derive(Clone, Debug)]
pub struct PgConn {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub db: String,
    pub passfile: Option<PathBuf>,
}

impl PgConn {
    pub fn local(ctx: &BackupCtx, user: &str, db: &str, passfile: PathBuf) -> Self {
        Self { host: "127.0.0.1".into(), port: ctx.pg_port(), user: user.into(), db: db.into(), passfile: Some(passfile) }
    }
    pub fn with_db(&self, db: &str) -> Self {
        Self { db: db.into(), ..self.clone() }
    }
    pub fn psql_args(&self, extra: &[&str]) -> Vec<String> {
        // terse + no context: a server error never quotes the statement or the row that caused it (invariant 3),
        // the same flags `ops::swap::PsqlAdmin` uses.
        let mut a: Vec<String> = ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never", "-h"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        a.extend([self.host.clone(), "-p".into(), self.port.to_string(), "-U".into(), self.user.clone(), "-d".into(), self.db.clone()]);
        a.extend(extra.iter().map(|s| s.to_string()));
        a
    }
    pub fn env(&self) -> Vec<(String, String)> {
        let mut e = vec![
            ("PGCONNECT_TIMEOUT".to_string(), "10".to_string()),
            ("PGCLIENTENCODING".to_string(), "UTF8".to_string()),
            ("PGAPPNAME".to_string(), "posctl-backup".to_string()),
        ];
        if let Some(p) = &self.passfile {
            e.push(("PGPASSFILE".into(), p.to_string_lossy().into_owned()));
        }
        e
    }
}

/// A NUL byte can never be part of a name or a literal; the manifest-driven builders check first and
/// return an error, so this assert only fires on a programming mistake (like `ops::swap::ident`).
fn no_nul(s: &str) -> BResult<()> {
    if s.contains('\0') { Err(BackupError::restore_failed("a value contains a NUL byte")) } else { Ok(()) }
}

pub fn ident(s: &str) -> String {
    assert!(!s.contains('\0'), "NUL byte in an SQL identifier");
    format!("\"{}\"", s.replace('"', "\"\""))
}

pub fn literal(s: &str) -> String {
    assert!(!s.contains('\0'), "NUL byte in an SQL literal");
    format!("'{}'", s.replace('\'', "''"))
}

pub const SCRIPT_PRELUDE: &str = "SET standard_conforming_strings = on;\n";

/// One statement, one value. `read_only` makes the whole session `default_transaction_read_only`.
pub fn sql_scalar(exec: &dyn Exec, ctx: &BackupCtx, conn: &PgConn, sql: &str, read_only: bool) -> BResult<String> {
    let mut env = conn.env();
    if read_only {
        env.push(("PGOPTIONS".into(), "-c default_transaction_read_only=on".into()));
    }
    let out = exec
        .run(&ctx.pg_exe("psql.exe"), &conn.psql_args(&["-c", sql]), &env, None, Duration::from_secs(120))
        .map_err(BackupError::tool)?;
    if !out.ok() {
        return Err(BackupError::error(format!("psql failed: {}", tail(&out.stderr))));
    }
    Ok(out.stdout.trim().to_string())
}

/// A script on psql's stdin (so literals such as derived passwords never reach a command line).
pub fn sql_script(exec: &dyn Exec, ctx: &BackupCtx, conn: &PgConn, script: &str, timeout: Duration) -> BResult<String> {
    // every script is quoted for standard_conforming_strings = on, whatever the server or role default is
    let script = format!("{SCRIPT_PRELUDE}{script}");
    let out = exec
        .run(&ctx.pg_exe("psql.exe"), &conn.psql_args(&[]), &conn.env(), Some(script.as_bytes()), timeout)
        .map_err(BackupError::tool)?;
    if !out.ok() {
        return Err(BackupError::error(format!("psql script failed: {}", tail(&out.stderr))));
    }
    Ok(out.stdout)
}

/// C6: like `sql_script`, but values go in as `\set <name> '<value>'` lines prepended on stdin and the SQL
/// refers to `:'name'`. Values must be `[A-Za-z0-9_-]+` (generated secrets are hex), else `precondition` error.
pub fn sql_script_vars(exec: &dyn Exec, ctx: &BackupCtx, conn: &PgConn, sql: &str, vars: &[(&str, &str)], timeout: Duration) -> BResult<String> {
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let mut script = String::new();
    for (k, v) in vars {
        if !ok(k) || !ok(v) { return Err(BackupError::precondition("a psql variable has characters that are not allowed")); }
        script.push_str(&format!("\\set {k} '{v}'\n"));
    }
    script.push_str(sql);
    sql_script(exec, ctx, conn, &script, timeout)
}

/// Names a restore may create: `pos_next` (the clone name of Plan 07's runner, which swaps it in) or a
/// drill scratch name. Never `postgres`, `template*`.
pub fn check_new_db_name(name: &str) -> BResult<()> {
    let digits = |s: &str| s.len() == 14 && s.bytes().all(|b| b.is_ascii_digit());
    let ok = name == NEXT || name.strip_prefix("pos_drill_").is_some_and(digits);
    if ok { Ok(()) } else { Err(BackupError::restore_failed(format!("refusing to create database '{name}'"))) }
}

pub fn create_db_sql(info: &DbInfo, name: &str) -> BResult<String> {
    check_new_db_name(name)?;
    for v in [&info.owner, &info.encoding, &info.locale, &info.collate, &info.ctype] {
        no_nul(v)?;
    }
    let provider = match info.provider.as_str() {
        "i" => format!("LOCALE_PROVIDER icu ICU_LOCALE {} LC_COLLATE {} LC_CTYPE {}", literal(&info.locale), literal(&info.collate), literal(&info.ctype)),
        "c" => format!("LOCALE_PROVIDER libc LC_COLLATE {} LC_CTYPE {}", literal(&info.collate), literal(&info.ctype)),
        other => return Err(BackupError::restore_failed(format!("database locale provider '{other}' is not supported"))),
    };
    Ok(format!("CREATE DATABASE {} TEMPLATE template0 OWNER {} ENCODING {} {};", ident(name), ident(&info.owner), literal(&info.encoding), provider))
}

/// `settings` are `key=value` strings from pg_db_role_setting. Postgres stores the canonical spelling
/// (`TimeZone`, `DateStyle`), so names may be mixed case; they are letters, digits, `_` and `.` only.
/// List-valued settings (`search_path`, ...) are split on `,` and each element is quoted on its own, like
/// `ops::swap::replay_attrs_sql` (Plan 07) and pg_dump do; the list of such names is Plan 07's `LIST_GUCS`.
pub fn alter_settings_sql(name: &str, settings: &[String]) -> BResult<String> {
    let mut out = String::new();
    for s in settings {
        no_nul(s)?;
        let (k, v) = s.split_once('=').ok_or_else(|| BackupError::restore_failed(format!("bad database setting: {s}")))?;
        if k.is_empty() || !k.bytes().next().is_some_and(|b| b.is_ascii_alphabetic()) || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.') {
            return Err(BackupError::restore_failed(format!("refusing database setting name: {k}")));
        }
        let value = if is_list_guc(k) {
            let items: Vec<String> = v.split(',').map(|e| literal(e.trim().trim_matches('"'))).collect();
            items.join(", ")
        } else {
            literal(v)
        };
        out.push_str(&format!("ALTER DATABASE {} SET {} TO {};\n", ident(name), k, value));
    }
    Ok(out)
}

/// Whether Postgres treats the setting's value as a comma-separated list (case-insensitive name).
pub fn is_list_guc(name: &str) -> bool {
    crate::ops::swap::LIST_GUCS.iter().any(|g| g.eq_ignore_ascii_case(name))
}

/// Statements that pin every output format the fingerprints depend on.
pub fn session_settings(local: bool) -> String {
    let l = if local { "LOCAL " } else { "" };
    format!(
        "SET {l}TIME ZONE 'UTC';\nSET {l}extra_float_digits = 3;\nSET {l}DateStyle = 'ISO, YMD';\nSET {l}IntervalStyle = 'iso_8601';\nSET {l}bytea_output = 'hex';\nSET {l}search_path = pg_catalog, public;\n"
    )
}

/// Prints the GRANT/REVOKE script that copies the live database's ACL onto `target`
/// (database-level privileges are not in a custom-format dump). Empty output = default ACL.
/// Mirrors `ops::swap::replay_attrs_sql`: the owner's own grants are skipped (the owner keeps them anyway) and
/// `WITH GRANT OPTION` is kept. The REVOKE comes first even when only the owner holds an explicit entry.
pub fn acl_replicate_sql(live: &str, target: &str) -> String {
    format!(
        "SELECT coalesce((SELECT 'REVOKE ALL ON DATABASE ' || quote_ident({t}) || ' FROM PUBLIC;' || coalesce(E'\\n' || (SELECT string_agg(format('GRANT %s ON DATABASE %I TO %s%s;', a.privilege_type, {t}, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END, CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END), E'\\n') FROM aclexplode(d.datacl) a WHERE a.grantee <> d.datdba), '') FROM pg_database d WHERE d.datname = {l} AND d.datacl IS NOT NULL), '');",
        t = literal(target),
        l = literal(live)
    )
}

/// Database-level settings only (`setrole = 0`).
/// ponytail: role-in-database settings (`setrole <> 0`, ALTER ROLE ... IN DATABASE ... SET) are deliberately NOT
/// captured: `pg_dumpall --globals-only` stopped emitting them in PG 11, so a restore does not bring them back. The
/// stores this plan backs up have none; capture them here (and replay with ALTER ROLE ... IN DATABASE) if one ever does.
pub const DBINFO_SQL: &str = "SELECT json_build_object('name', d.datname, 'owner', pg_get_userbyid(d.datdba), 'encoding', pg_encoding_to_char(d.encoding), 'provider', d.datlocprovider::text, 'locale', coalesce(d.datlocale, ''), 'collate', d.datcollate, 'ctype', d.datctype, 'collversion', coalesce(d.datcollversion, ''), 'bytes', pg_database_size(d.oid), 'settings', coalesce((SELECT json_agg(c) FROM (SELECT unnest(setconfig) AS c FROM pg_db_role_setting WHERE setdatabase = d.oid AND setrole = 0) x), '[]'::json)) FROM pg_database d WHERE d.datname = current_database();";
pub const MIGRATIONS_SQL: &str = "SELECT count(*) || '|' || coalesce(max(version), '') FROM supabase_migrations.schema_migrations;";
pub const CAJA_PRESENT_SQL: &str = "SELECT to_regclass('public.caja_sessions') IS NOT NULL;";
/// `closed` = newest `closed_at` (epoch seconds, 0 when none); `open` = a caja is open right now.
pub const CAJA_SQL: &str = "SELECT json_build_object('open', EXISTS (SELECT 1 FROM public.caja_sessions WHERE status = 'open'), 'closed', (SELECT coalesce(extract(epoch FROM max(closed_at)), 0)::bigint FROM public.caja_sessions WHERE status = 'closed'));";
pub const PHOTO_ROWS_SQL: &str = "SELECT bucket_id || '/' || id::text FROM storage.objects ORDER BY 1;";

/// One line per table: `schema.table|rows|hash`. The hash is the order-independent sum of the first
/// 60 bits of md5 of each row's text (constant memory; a changed, lost or duplicated row changes it).
/// Ends in `\gexec`: send it as a script (stdin or a snapshot session), not through `-c`.
pub const TABLES_FP_SQL: &str = "SELECT format($f$SELECT %L, count(*), coalesce(sum((('x' || substr(md5(__fp_row::text), 1, 15))::bit(60))::bigint::numeric), 0) FROM ONLY %s __fp_row$f$, format('%I.%I', n.nspname, c.relname), format('%I.%I', n.nspname, c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('public','auth','storage','supabase_migrations') ORDER BY n.nspname, c.relname\n\\gexec";

const NS: &str = "('public','auth','storage','supabase_migrations','pos_lockout','extensions')";

/// An ACL as sorted text: `pg_restore` re-grants in its own order (owner first), and an `aclitem[]` is an ordered array, so the
/// raw text of an identical set of grants differs between the live database and its restored copy. Plain `string_agg`, no DISTINCT:
/// Postgres keeps one entry per grantee and grantor. `col` must already be NOT NULL (see `acl_or_default`): NULL and `{}` would
/// both unnest to nothing and hash alike.
fn acl_sorted(col: &str) -> String {
    format!("coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest({col}) x), '')")
}

/// NULL ACL = "the default grants" for the owner and kind; that is expanded so it differs from an explicit `{}` (everything revoked)
/// and equals an explicit ACL that spells out the default (which a restore may store as NULL).
fn acl_or_default(col: &str, kind: &str, owner: &str) -> String {
    acl_sorted(&format!("coalesce({col}, acldefault({kind}, {owner}))"))
}

/// Security-relevant catalog facts (S7 REVIEW I1), hashed per kind. Deparsed expression text is
/// deliberately left out: a restore re-deparses it (S8: harmless `= ANY(ARRAY[...])` noise).
pub fn catalog_fp_sql() -> String {
    format!(
        "SELECT k || '|' || md5(coalesce(v, '')) FROM (\n\
SELECT 'schemas' AS k, string_agg(format('%s|%s|%s', n.nspname, pg_get_userbyid(n.nspowner), {a_nsp}), E'\\n' ORDER BY n.nspname) AS v FROM pg_namespace n WHERE n.nspname IN {ns}\n\
UNION ALL SELECT 'relations', string_agg(format('%s.%s|%s|%s|%s|%s|%s', n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, {a_rel}), E'\\n' ORDER BY n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN {ns} AND c.relkind IN ('r','p','v','m','S')\n\
UNION ALL SELECT 'columns', string_agg(format('%s.%s.%s|%s|%s|%s|%s', n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef, {a_att}), E'\\n' ORDER BY n.nspname, c.relname, a.attname) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m') AND n.nspname IN {ns}\n\
UNION ALL SELECT 'functions', string_agg(format('%s.%s(%s)|%s|%s|%s|%s|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), p.prosecdef, {a_proc}, coalesce(array_to_string(p.proconfig, ','), ''), md5(p.prosrc)), E'\\n' ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN {ns} AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')\n\
UNION ALL SELECT 'policies', string_agg(format('%s.%s.%s|%s|%s|%s', schemaname, tablename, policyname, cmd, permissive, array_to_string(roles, ',')), E'\\n' ORDER BY schemaname, tablename, policyname) FROM pg_policies WHERE schemaname IN {ns}\n\
UNION ALL SELECT 'triggers', string_agg(format('%s.%s.%s|%s|%s', n.nspname, c.relname, t.tgname, t.tgenabled, t.tgfoid::regproc::text), E'\\n' ORDER BY n.nspname, c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN {ns}\n\
UNION ALL SELECT 'constraints', string_agg(format('%s.%s.%s|%s', n.nspname, c.relname, k.conname, k.contype), E'\\n' ORDER BY n.nspname, c.relname, k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN {ns}\n\
UNION ALL SELECT 'indexes', string_agg(format('%s.%s|%s|%s', n.nspname, i.relname, x.indisunique, x.indisprimary), E'\\n' ORDER BY n.nspname, i.relname) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname IN {ns}\n\
UNION ALL SELECT 'default_acls', string_agg(format('%s|%s|%s|%s', pg_get_userbyid(d.defaclrole), d.defaclnamespace::regnamespace::text, d.defaclobjtype, {a_def}), E'\\n' ORDER BY pg_get_userbyid(d.defaclrole), d.defaclnamespace::regnamespace::text, d.defaclobjtype) FROM pg_default_acl d\n\
UNION ALL SELECT 'extensions', string_agg(format('%s|%s', e.extname, e.extversion), E'\\n' ORDER BY e.extname) FROM pg_extension e\n\
) x ORDER BY k;",
        ns = NS,
        a_nsp = acl_or_default("n.nspacl", "'n'", "n.nspowner"),
        a_rel = acl_or_default("c.relacl", "(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\"", "c.relowner"),
        // attacl: NULL and {} both mean "no column grants", so they correctly hash alike
        a_att = acl_sorted("a.attacl"),
        a_proc = acl_or_default("p.proacl", "'f'", "p.proowner"),
        // defaclacl is NOT NULL; that a pg_default_acl row exists at all is part of the signal (the rows are listed by role, schema, objtype)
        a_def = acl_sorted("d.defaclacl"),
    )
}

/// What the caller can ask of an open `REPEATABLE READ` snapshot.
pub trait SnapshotQueries {
    fn snapshot_id(&self) -> String;
    /// `sql` must be a complete statement (ends with `;`) or end with `\gexec` on its own line.
    fn query(&mut self, sql: &str) -> BResult<Vec<String>>;
    /// How long each following `query` may wait. A caller with a deadline sets it before every query.
    /// // ponytail: a fake that never waits keeps the default no-op.
    fn set_query_timeout(&mut self, _d: Duration) {}
    fn close(&mut self);
}

pub trait SnapshotOpener {
    /// `timeout` bounds the opening itself (the snapshot export is the first query).
    fn open(&self, ctx: &BackupCtx, conn: &PgConn, timeout: Duration) -> BResult<Box<dyn SnapshotQueries>>;
}

pub struct PsqlOpener;

impl SnapshotOpener for PsqlOpener {
    fn open(&self, ctx: &BackupCtx, conn: &PgConn, timeout: Duration) -> BResult<Box<dyn SnapshotQueries>> {
        Ok(Box::new(PsqlSession::open_with(ctx, conn, timeout)?))
    }
}

/// A long-lived psql child holding `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` open, so
/// `pg_export_snapshot()` stays valid while `pg_dump --snapshot` runs and the fingerprints are
/// computed on exactly the same data (a sale committing mid-backup cannot cause a false mismatch).
const CLOSE_GRACE: Duration = Duration::from_secs(10);
/// The wait per query when the caller has no deadline (15 minutes).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(900);

pub struct PsqlSession {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Option<String>>,
    stderr: Arc<Mutex<String>>,
    id: String,
    query_timeout: Duration,
    /// KILL_ON_JOB_CLOSE: psql (and anything it starts) cannot outlive this session, even if posctl dies.
    _job: crate::sys::Job,
}

impl PsqlSession {
    pub fn open(ctx: &BackupCtx, conn: &PgConn) -> BResult<Self> {
        Self::open_with(ctx, conn, QUERY_TIMEOUT)
    }

    pub fn open_with(ctx: &BackupCtx, conn: &PgConn, timeout: Duration) -> BResult<Self> {
        let mut cmd = Command::new(ctx.pg_exe("psql.exe"));
        cmd.args(conn.psql_args(&[])).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // The environment rules of `exec::Cmd`: nothing inherited (a stray PG* variable could outrank PGPASSFILE).
        cmd.env_clear();
        for (k, v) in crate::exec::base_env().map_err(BackupError::backup_failed)? {
            cmd.env(k, v);
        }
        for (k, v) in conn.env() {
            cmd.env(k, v);
        }
        cmd.env("PGOPTIONS", "-c default_transaction_read_only=on");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let job = crate::sys::Job::new().map_err(BackupError::backup_failed)?;
        let mut child = cmd.spawn().map_err(|e| BackupError::backup_failed(format!("cannot start psql: {e}")))?;
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BackupError::backup_failed(e));
        }
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr_pipe = child.stderr.take().expect("piped stderr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(Some(l)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(None);
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let err_clone = Arc::clone(&stderr);
        thread::spawn(move || {
            for l in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
                if let Ok(mut g) = err_clone.lock() {
                    g.push_str(&l);
                    g.push('\n');
                }
            }
        });
        let mut s = Self { child, stdin, rx, stderr, id: String::new(), query_timeout: timeout, _job: job };
        let prelude = format!("{SCRIPT_PRELUDE}BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n{}", session_settings(true));
        s.write(&prelude)?;
        let rows = s.query("SELECT 'SNAP:' || pg_export_snapshot();")?;
        s.id = rows
            .iter()
            .find_map(|l| l.strip_prefix("SNAP:").map(String::from))
            .ok_or_else(|| BackupError::backup_failed("the database did not export a snapshot"))?;
        Ok(s)
    }

    /// Whether the psql child has already exited.
    pub fn child_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn kill_child(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn write(&mut self, text: &str) -> BResult<()> {
        self.stdin.write_all(text.as_bytes()).and_then(|_| self.stdin.flush()).map_err(|e| {
            BackupError::backup_failed(format!("psql session ended: {e}; {}", tail(&self.stderr.lock().map(|g| g.clone()).unwrap_or_default())))
        })
    }
}

impl SnapshotQueries for PsqlSession {
    fn set_query_timeout(&mut self, d: Duration) {
        self.query_timeout = d;
    }

    fn snapshot_id(&self) -> String {
        self.id.clone()
    }

    fn query(&mut self, sql: &str) -> BResult<Vec<String>> {
        self.write(&format!("{sql}\n\\echo __END__\n"))?;
        let mut out = Vec::new();
        loop {
            match self.rx.recv_timeout(self.query_timeout) {
                Ok(Some(l)) if l == "__END__" => return Ok(out),
                Ok(Some(l)) => out.push(l),
                Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                    let e = self.stderr.lock().map(|g| g.clone()).unwrap_or_default();
                    return Err(BackupError::backup_failed(format!("psql session ended: {}", tail(&e))));
                }
                Err(RecvTimeoutError::Timeout) => {
                    // The backend is still running the statement: kill psql (and its job) now, so nothing
                    // keeps the snapshot open and a later close() cannot wait on a child that never answers.
                    self.kill_child();
                    return Err(BackupError::backup_failed("psql session timed out"));
                }
            }
        }
    }

    fn close(&mut self) {
        let _ = self.stdin.write_all(b"ROLLBACK;\n\\q\n");
        let _ = self.stdin.flush();
        // Bounded: a psql that does not exit on `\q` is killed after the grace period instead of hanging the run.
        let deadline = std::time::Instant::now() + CLOSE_GRACE;
        while std::time::Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.kill_child();
    }
}

impl Drop for PsqlSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::dump::DbInfo;

    fn conn() -> PgConn {
        PgConn { host: "127.0.0.1".into(), port: 47300, user: "pos_backup".into(), db: "postgres".into(), passfile: Some(r"C:\s\pgpass-backup.conf".into()) }
    }

    #[test]
    fn psql_args_fail_fast_and_carry_no_password() {
        let a = conn().psql_args(&["-c", "select 1"]);
        let j = a.join(" ");
        assert!(j.contains("ON_ERROR_STOP=1") && j.contains("-w") && j.contains("-h 127.0.0.1 -p 47300 -U pos_backup -d postgres"));
        assert!(j.ends_with("-c select 1"));
        assert!(!j.to_lowercase().contains("password"));
        assert!(conn().env().iter().any(|(k, _)| k == "PGPASSFILE"));
        let mut c2 = conn();
        c2.passfile = None;
        assert!(!c2.env().iter().any(|(k, _)| k == "PGPASSFILE"));
    }

    #[test]
    fn quoting_doubles_the_quote_character() {
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(literal("it's"), "'it''s'");
    }

    #[test]
    fn only_generated_names_may_be_created_by_a_restore() {
        assert!(check_new_db_name("pos_next").is_ok());
        assert!(check_new_db_name("pos_drill_20261002090000").is_ok());
        for bad in ["postgres", "template0", "template1", "pos_restore_20261002090000", "pos_drill_1", "pos_drill_2026100209000x", "pos_drill_20261002090000; drop", "pos_next2"] {
            assert!(check_new_db_name(bad).is_err(), "{bad} must be refused");
        }
    }

    fn icu() -> DbInfo {
        DbInfo { name: "postgres".into(), owner: "postgres".into(), encoding: "UTF8".into(), provider: "i".into(), locale: "es-MX".into(),
                 collate: "C".into(), ctype: "C".into(), collversion: "153.14".into(), bytes: 1, settings: vec!["timezone=UTC".into()] }
    }

    #[test]
    fn create_database_follows_the_manifest_locale() {
        let sql = create_db_sql(&icu(), "pos_next").unwrap();
        assert_eq!(sql, "CREATE DATABASE \"pos_next\" TEMPLATE template0 OWNER \"postgres\" ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'es-MX' LC_COLLATE 'C' LC_CTYPE 'C';");
        let mut libc = icu();
        libc.provider = "c".into();
        assert!(create_db_sql(&libc, "pos_drill_20261002090000").unwrap().contains("LOCALE_PROVIDER libc"));
        let mut builtin = icu();
        builtin.provider = "b".into();
        assert!(create_db_sql(&builtin, "pos_drill_20261002090000").is_err());
        assert!(create_db_sql(&icu(), "postgres").is_err());
    }

    #[test]
    fn database_settings_are_replayed_and_only_plain_guc_names_pass() {
        let ok = alter_settings_sql("pos_next", &["timezone=UTC".into(), "log_timezone=UTC".into()]).unwrap();
        assert!(ok.contains("ALTER DATABASE \"pos_next\" SET timezone TO 'UTC';"));
        assert!(alter_settings_sql("pos_next", &["x; drop table y=1".into()]).is_err());
        // Postgres stores the canonical spelling; a real manifest carries it.
        assert!(alter_settings_sql("pos_next", &["TimeZone=UTC".into(), "DateStyle=ISO, YMD".into()]).unwrap().contains("SET DateStyle TO 'ISO, YMD';"));
        for bad in ["1x=1", "=1", "a b=1", "a\"b=1", "a'b=1"] {
            assert!(alter_settings_sql("pos_next", &[bad.into()]).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_session_settings_pin_every_output_format_the_fingerprint_depends_on() {
        let s = session_settings(true);
        for needle in ["SET LOCAL TIME ZONE 'UTC'", "extra_float_digits = 3", "DateStyle = 'ISO, YMD'", "IntervalStyle = 'iso_8601'", "bytea_output = 'hex'", "search_path"] {
            assert!(s.contains(needle), "missing {needle}");
        }
        assert!(session_settings(false).contains("SET TIME ZONE 'UTC'") && !session_settings(false).contains("LOCAL"));
    }

    #[test]
    fn psql_errors_never_quote_the_statement_or_its_data() {
        let j = conn().psql_args(&[]).join(" ");
        assert!(j.contains("VERBOSITY=terse") && j.contains("SHOW_CONTEXT=never"));
    }

    #[test]
    fn scalar_runs_psql_with_the_password_file_and_read_only_on_request() {
        use crate::backup::util::fake::{test_ctx, FakeExec};
        use crate::envelope::Code;
        let exec = FakeExec::default().on("psql.exe", 0, " 42
");
        assert_eq!(sql_scalar(&exec, &test_ctx(), &conn(), "select 42", true).unwrap(), "42");
        let envs = exec.envs.borrow();
        assert!(envs[0].iter().any(|k| k == "PGPASSFILE") && envs[0].iter().any(|k| k == "PGOPTIONS"));
        let bad = FakeExec::default().on("psql.exe", 2, "");
        assert_eq!(sql_scalar(&bad, &test_ctx(), &conn(), "select 1", false).unwrap_err().code, Code::Error);
        let calls = exec.calls.borrow();
        assert!(!calls[0].to_lowercase().contains("password"));
    }

    #[test]
    fn a_script_goes_in_on_stdin_and_variables_are_validated() {
        use crate::backup::util::fake::{test_ctx, FakeExec};
        use crate::envelope::Code;
        use std::time::Duration;
        let exec = FakeExec::default();
        sql_script_vars(&exec, &test_ctx(), &conn(), "select :'v';", &[("v", "abc-123_x")], Duration::from_secs(5)).unwrap();
        assert!(exec.calls.borrow()[0].contains("<<SET standard_conforming_strings = on;\n\\set v 'abc-123_x'\nselect :'v';"));
        let e = sql_script_vars(&exec, &test_ctx(), &conn(), "x", &[("v", "a'b")], Duration::from_secs(5)).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert_eq!(exec.calls.borrow().len(), 1, "a refused variable must not run psql");
    }

    #[test]
    fn the_acl_replication_sql_quotes_both_names() {
        let sql = acl_replicate_sql("po'stgres", "pos_next");
        assert!(sql.contains("'po''stgres'") && sql.contains("'pos_next'"));
    }

    #[test]
    fn list_valued_settings_are_requoted_element_by_element() {
        let sql = alter_settings_sql("pos_next", &[r#"search_path="$user", public"#.into()]).unwrap();
        assert_eq!(sql, "ALTER DATABASE \"pos_next\" SET search_path TO '$user', 'public';\n");
        let one = alter_settings_sql("pos_next", &["search_path=public".into()]).unwrap();
        assert!(one.contains("SET search_path TO 'public';"));
        let empty = alter_settings_sql("pos_next", &["search_path=".into()]).unwrap();
        assert!(empty.contains("SET search_path TO '';"));
        // a plain setting is NOT split
        assert!(alter_settings_sql("pos_next", &["DateStyle=ISO, YMD".into()]).unwrap().contains("SET DateStyle TO 'ISO, YMD';"));
        // a quote inside an element is doubled, not passed through
        assert!(alter_settings_sql("pos_next", &["search_path=a'b".into()]).unwrap().contains("'a''b'"));
    }

    #[test]
    fn the_list_valued_names_are_plan_07s_list() {
        assert!(crate::ops::swap::LIST_GUCS.contains(&"search_path"));
        assert!(is_list_guc("Search_Path"));
        assert!(!is_list_guc("timezone"));
    }

    #[test]
    fn nul_bytes_are_refused_by_the_quoting_helpers_and_the_manifest_driven_builders() {
        assert!(std::panic::catch_unwind(|| ident("a\0b")).is_err());
        assert!(std::panic::catch_unwind(|| literal("a\0b")).is_err());
        let mut info = icu();
        info.locale = "es\0MX".into();
        assert!(create_db_sql(&info, "pos_next").is_err(), "a hostile manifest is an error, not a panic");
        assert!(alter_settings_sql("pos_next", &["timezone=U\0TC".into()]).is_err());
    }

    #[test]
    fn every_script_starts_with_standard_conforming_strings_on() {
        use crate::backup::util::fake::{test_ctx, FakeExec};
        use std::time::Duration;
        let exec = FakeExec::default();
        sql_script(&exec, &test_ctx(), &conn(), "select 1;", Duration::from_secs(5)).unwrap();
        sql_script_vars(&exec, &test_ctx(), &conn(), "select :'v';", &[("v", "x")], Duration::from_secs(5)).unwrap();
        let calls = exec.calls.borrow();
        assert!(calls[0].contains("<<SET standard_conforming_strings = on;\nselect 1;"));
        assert!(calls[1].contains("<<SET standard_conforming_strings = on;\n\\set v 'x'\nselect :'v';"));
    }

    #[test]
    fn the_row_fingerprint_uses_an_alias_no_table_column_can_shadow() {
        assert!(TABLES_FP_SQL.contains("__fp_row::text") && TABLES_FP_SQL.contains("ONLY %s __fp_row"));
        assert!(!TABLES_FP_SQL.contains("md5(t::text)"));
    }

    #[test]
    fn column_grants_are_part_of_the_catalog_fingerprint() {
        assert!(catalog_fp_sql().contains("a.attacl"));
    }
}
