//! The cloud project, seen through psql. Credentials travel in the CHILD'S ENVIRONMENT only (a pgpass file named by PGPASSFILE),
//! never in an argument. The fence is plain SQL on public.store_switch_state (hosted migrations 20261025000001 + 000002).
//!
//! The switch connects as the source's OWNER role and writes the state row directly. Every transition is ONE transaction
//! (`BEGIN; SET LOCAL ...; DO ...; COMMIT;`, never a session `SET`: a pooler would carry it to the next client) that locks the
//! state row first and only then runs a guarded UPDATE whose row count must be exactly 1. Zero rows is always a refusal.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::switch::drain::TillRow;
use crate::switch::redact::redact_pg_stderr;
use crate::switch::source::{check_target, is_local_host, PgTarget};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Supabase Root 2021 CA (public; valid to 2031-04-26, renew this file and release before then). The default trust anchor
/// for a non-loopback source; an operator's `sslrootcert` replaces it.
/// Where `write_pgpass` puts the bundled CA, beside the pgpass file.
pub const BUNDLED_CA_FILE: &str = "supabase-root-2021-ca.crt";
pub const SUPABASE_ROOT_CA_PEM: &[u8] = include_bytes!("../../resources/supabase-root-2021-ca.crt");

/// Writes the cloud target's one-line `pgpass` file (`host:port:db:user:password`, `\` and `:` escaped) into `dir`
/// (the private staging folder, deleted by its Drop guard). The password never goes in an argument or in `PGPASSWORD`.
/// `create_new`: a file or link already there is refused, never written through or replaced.
pub fn write_pgpass(dir: &std::path::Path, pg: &PgTarget) -> R<PathBuf> {
    use std::io::Write;
    let esc = |s: &str| s.replace('\\', "\\\\").replace(':', "\\:");
    let path = dir.join("pgpass");
    let line = format!(
        "{}:{}:{}:{}:{}\n",
        esc(pg.host.trim_matches(|c| c == '[' || c == ']')),
        pg.port,
        esc(&pg.dbname),
        esc(&pg.user),
        esc(pg.password.expose())
    );
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| OpError::err("CLOUD_PGPASS", e.to_string()))?;
    if uses_bundled_ca(pg) {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        o.open(dir.join(BUNDLED_CA_FILE))
            .and_then(|mut f| f.write_all(SUPABASE_ROOT_CA_PEM))
            .map_err(|e| OpError::err("CLOUD_PGPASS", e.to_string()))?;
    }
    Ok(path)
}

/// A non-loopback source that verifies the server and names no CA of its own trusts the bundled Supabase root.
fn uses_bundled_ca(pg: &PgTarget) -> bool {
    pg.sslrootcert.is_none()
        && !is_local_host(&pg.host)
        && matches!(pg.sslmode.as_str(), "verify-ca" | "verify-full")
}

/// Environment for any libpq tool (psql, pg_dump) talking to the cloud. The host is its own variable (a URL is never
/// rebuilt); no password ever appears in an argument or in the environment: `pgpass` is the file `write_pgpass` made.
pub fn libpq_env(pg: &PgTarget, pgpass: &std::path::Path) -> Vec<(String, String)> {
    let mut env = vec![
        (
            "PGHOST".into(),
            pg.host.trim_matches(|c| c == '[' || c == ']').to_string(),
        ),
        ("PGPORT".into(), pg.port.to_string()),
        ("PGUSER".into(), pg.user.clone()),
        ("PGPASSFILE".into(), pgpass.display().to_string()),
        ("PGDATABASE".into(), pg.dbname.clone()),
        ("PGSSLMODE".into(), pg.sslmode.clone()),
        ("PGCONNECT_TIMEOUT".into(), "10".into()),
        ("PGCLIENTENCODING".into(), "UTF8".into()),
        ("PGAPPNAME".into(), "posctl-switch".into()),
    ];
    // The CA: the operator's, else the bundled one (`write_pgpass` put it beside the pgpass file). `require` verifies nothing, so
    // it only gets a CA the operator named. No channel binding: verify-full already authenticates the server.
    if let Some(p) = &pg.sslrootcert {
        env.push(("PGSSLROOTCERT".into(), p.clone()));
    } else if uses_bundled_ca(pg) {
        env.push((
            "PGSSLROOTCERT".into(),
            pgpass.with_file_name(BUNDLED_CA_FILE).display().to_string(),
        ));
    }
    env
}

/// `VERBOSITY=sqlstate` makes an error come back as `ERROR:  <5-char code>` and nothing else (no message text that could quote a row).
pub fn psql_args(sql: &str) -> Vec<String> {
    [
        "-X",
        "-q",
        "-A",
        "-t",
        "-w",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=sqlstate",
        "-c",
        sql,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Read-only and timeouts are transaction-local, never a session setting (a pooler hands the session to the next client).
/// No COMMIT: the last statement is the query, so older psql versions (which print only the last result of a `-c` string) still
/// print its rows; a read-only transaction that ends with the connection has nothing to lose.
pub(crate) const RO_PREFIX: &str =
    "BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '600s'; ";
pub(crate) const RW_PREFIX: &str =
    "BEGIN; SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'; ";

/// SQLSTATE the fence DO blocks raise when the guarded UPDATE did not touch exactly one row.
const REFUSED: &str = "PS001";
const LOCK_TIMEOUT: &str = "55P03";
const STATEMENT_TIMEOUT: &str = "57014";
/// A freeze that cannot get the row lock (an in-flight writer, an idle-in-transaction session) fails closed after this many tries.
const FREEZE_ATTEMPTS: u32 = 5;

/// A failed psql call. `sqlstate` is the 5-character code when the server raised one (connection failures have none).
#[derive(Debug, Clone)]
pub(crate) struct RunFail {
    pub sqlstate: Option<String>,
    pub message: String,
    /// libpq could not verify the server's certificate (see `is_cert_verify_failure`).
    pub cert: bool,
}

/// libpq's wording when the TLS handshake fails on the certificate (OpenSSL texts and libpq's own host-name check).
pub(crate) fn is_cert_verify_failure(stderr: &str) -> bool {
    let l = stderr.to_ascii_lowercase();
    [
        "certificate verify failed",
        "ssl error: certificate",
        "does not match host name",
        "root certificate file",
        "unable to get local issuer certificate",
        "self-signed certificate",
        "self signed certificate",
    ]
    .iter()
    .any(|p| l.contains(p))
}

/// A failed libpq child's stderr as a `RunFail`. A certificate failure carries a fixed hint and none of the stderr text.
pub(crate) fn classify_failure(stderr: &str) -> RunFail {
    if is_cert_verify_failure(stderr) {
        return RunFail {
            sqlstate: None,
            message: "the cloud database's certificate could not be verified: check this computer's clock, or name the right CA with sslrootcert=<file> in the source URL (a custom domain or a self-hosted server); do not lower sslmode".into(),
            cert: true,
        };
    }
    RunFail {
        sqlstate: sqlstate_of(stderr),
        message: redact_pg_stderr(stderr),
        cert: false,
    }
}

fn sqlstate_of(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|l| {
        let code = l.trim().strip_prefix("ERROR:")?.trim();
        (code.len() == 5 && code.bytes().all(|b| b.is_ascii_alphanumeric()))
            .then(|| code.to_string())
    })
}

#[cfg(test)]
type Hook = Arc<dyn Fn(&str) -> Result<String, RunFail> + Send + Sync>;

#[derive(Clone)]
pub struct CloudDb {
    pub psql: PathBuf,
    pub pg: PgTarget,
    pub pgpass: PathBuf,
    allow_local: bool,
    local_pg_port: u16,
    #[cfg(test)]
    hook: Option<Hook>,
}

impl CloudDb {
    /// A real cloud project: `check_target` runs before every call and refuses a local host.
    pub fn new(psql: PathBuf, pg: PgTarget, pgpass: PathBuf) -> CloudDb {
        CloudDb {
            psql,
            pg,
            pgpass,
            allow_local: false,
            local_pg_port: 0,
            #[cfg(test)]
            hook: None,
        }
    }
    /// Tests and `test-hooks` builds only (the Sandbox scenarios): a "cloud" on this machine's throwaway instance. `check_target`
    /// still refuses the developer stacks. No other build has this setter, so no production path can call it.
    #[cfg(any(all(test, feature = "fence-db-tests"), feature = "test-hooks"))]
    pub(crate) fn allow_local(mut self, local_pg_port: u16) -> CloudDb {
        self.allow_local = true;
        self.local_pg_port = local_pg_port;
        self
    }
    #[cfg(test)]
    pub(crate) fn with_hook(mut self, h: Hook) -> CloudDb {
        self.hook = Some(h);
        self
    }

    pub(crate) fn run_raw(&self, sql: &str) -> Result<String, RunFail> {
        #[cfg(test)]
        if let Some(h) = &self.hook {
            return h(sql);
        }
        check_target(&self.pg, self.allow_local, self.local_pg_port).map_err(|e| RunFail {
            sqlstate: None,
            message: e.message,
            cert: false,
        })?;
        let mut c = Command::new(&self.psql);
        c.args(psql_args(sql)).stdin(Stdio::null());
        crate::pg::scrub_pg_env(&mut c);
        for (k, v) in libpq_env(&self.pg, &self.pgpass) {
            c.env(k, v);
        }
        let out = c.output().map_err(|e| RunFail {
            sqlstate: None,
            message: format!("psql could not start: {}", e.kind()),
            cert: false,
        })?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(classify_failure(&stderr))
    }

    fn query_failed(f: RunFail) -> OpError {
        let code = if f.cert {
            "SOURCE_CERT_VERIFY_FAILED"
        } else {
            "CLOUD_QUERY_FAILED"
        };
        OpError::new(OpCode::Precondition, code, f.message)
    }
    /// A session that cannot write: every plan-time and verification query uses it.
    pub(crate) fn ro(&self, sql: &str) -> R<String> {
        self.run_raw(&format!("{RO_PREFIX}{sql}"))
            .map_err(Self::query_failed)
    }
}

pub fn valid_op_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The op id is spliced into a `DO $fence$ ... $fence$` body, where `lit()` quoting cannot help (`$fence$` would close the
/// block), so every builder validates it here and gets back the quoted literal. Nothing unvalidated reaches the SQL text.
fn checked_op(op: &str) -> R<String> {
    if !valid_op_id(op) {
        return Err(OpError::new(
            OpCode::Usage,
            "OP_ID_INVALID",
            "the operation id has an unsafe shape",
        ));
    }
    Ok(lit(op))
}
/// A refusal, not a clamp: a window outside 1..=240 minutes is a caller bug, and a silent clamp would hide it.
fn checked_minutes(m: u32) -> R<u32> {
    if !(1..=MAX_FENCE_MINUTES).contains(&m) {
        return Err(OpError::new(
            OpCode::Usage,
            "MINUTES_OUT_OF_RANGE",
            "a fence window must be 1 to 240 minutes",
        ));
    }
    Ok(m)
}

/// The longest window any fence transition may set (`draining`, `frozen`, an extension).
pub const MAX_FENCE_MINUTES: u32 = 240;

const STATE: &str = "public.store_switch_state";
/// Waits for every writer that holds the guard's FOR SHARE on the row: that wait is the in-flight barrier.
const LOCK_EXCLUSIVE: &str = "PERFORM 1 FROM public.store_switch_state WHERE id FOR UPDATE;";
/// Conflicts with FOR SHARE too, but not with the key-share locks foreign keys take.
const LOCK_NO_KEY: &str = "PERFORM 1 FROM public.store_switch_state WHERE id FOR NO KEY UPDATE;";

/// One transition = one transaction: transaction-local timeouts, then `body`, whose LAST statement is the guarded UPDATE;
/// its row count must be exactly 1, else SQLSTATE PS001 (a refusal, never a success).
fn fence_txn(body: &str) -> String {
    format!(
        "{RW_PREFIX}DO $fence$ DECLARE n bigint; BEGIN {body} GET DIAGNOSTICS n = ROW_COUNT; \
         IF n <> 1 THEN RAISE EXCEPTION 'fence transition refused' USING ERRCODE = '{REFUSED}'; END IF; END $fence$; COMMIT;"
    )
}

/// The ONLY upsert: the missing row (the demo's nightly reset, a table wipe) is created as `active`, then drained.
/// Allowed from `active`, or from a draining/frozen whose dead-man time has passed (that reads as `active`).
pub(crate) fn sql_begin_draining(op: &str, minutes: u32) -> R<String> {
    let (op, minutes) = (checked_op(op)?, checked_minutes(minutes)?);
    Ok(fence_txn(&format!(
        "INSERT INTO {STATE} (id) VALUES (true) ON CONFLICT (id) DO NOTHING; {LOCK_EXCLUSIVE} \
         UPDATE {STATE} SET state = 'draining', op_id = {op}, since = now(), drain_since = clock_timestamp(), \
           until_at = clock_timestamp() + interval '{minutes} minutes' \
         WHERE id AND (state = 'active' OR (state IN ('draining','frozen') AND (until_at IS NULL OR until_at <= clock_timestamp())));",
        op = op
    )))
}
/// Lock first (waits for every in-flight writer), THEN check the clock in a later statement: a plain UPDATE that waited on a
/// FOR SHARE holder is not re-checked after the wait, so a freeze could otherwise succeed past its own expiry.
pub(crate) fn sql_freeze(op: &str, minutes: u32) -> R<String> {
    let (op, minutes) = (checked_op(op)?, checked_minutes(minutes)?);
    Ok(fence_txn(&format!(
        "{LOCK_EXCLUSIVE} UPDATE {STATE} SET state = 'frozen', since = now(), until_at = clock_timestamp() + interval '{minutes} minutes' \
         WHERE id AND op_id = {op} AND state = 'draining' AND until_at > clock_timestamp();",
        op = op
    )))
}
/// Never resurrects an expired freeze: the dead-man has already released the cloud.
pub(crate) fn sql_extend(op: &str, minutes: u32) -> R<String> {
    let (op, minutes) = (checked_op(op)?, checked_minutes(minutes)?);
    Ok(fence_txn(&format!(
        "{LOCK_NO_KEY} UPDATE {STATE} SET until_at = clock_timestamp() + interval '{minutes} minutes' \
         WHERE id AND op_id = {op} AND state IN ('draining','frozen') AND until_at > clock_timestamp();",
        op = op
    )))
}
/// `moved` only while the freeze is alive and belongs to this operation.
pub(crate) fn sql_mark_moved(op: &str) -> R<String> {
    let op = checked_op(op)?;
    Ok(fence_txn(&format!(
        "{LOCK_EXCLUSIVE} UPDATE {STATE} SET state = 'moved', since = now(), until_at = NULL \
         WHERE id AND op_id = {op} AND state = 'frozen' AND until_at > clock_timestamp();",
        op = op
    )))
}
pub(crate) fn sql_release(op: &str) -> R<String> {
    let op = checked_op(op)?;
    Ok(fence_txn(&format!(
        "{LOCK_EXCLUSIVE} UPDATE {STATE} SET state = 'active', op_id = NULL, since = now(), drain_since = NULL, until_at = NULL \
         WHERE id AND op_id = {op} AND state IN ('draining','frozen','moved');",
        op = op
    )))
}
/// Gives back the hold of THIS operation only (`draining` or `frozen`, never `moved`, never another operation's row). Zero rows is a
/// normal answer (the hold was never taken or is gone), reported as `0`: a failed `begin_draining` must not free someone else's hold.
pub(crate) fn sql_release_held(op: &str) -> R<String> {
    let op = checked_op(op)?;
    Ok(format!(
        "SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'; \
         WITH r AS (UPDATE {STATE} SET state = 'active', op_id = NULL, since = now(), drain_since = NULL, until_at = NULL \
           WHERE id AND op_id = {op} AND state IN ('draining','frozen') RETURNING 1) SELECT count(*) FROM r"
    ))
}
/// For `switch rollback` when no operation id is known. Never touches a recorded move. One statement in the implicit
/// transaction of the string; zero rows is a normal answer here (nothing to release), reported as `0`, not a refusal.
pub fn sql_release_unfinished() -> String {
    format!(
        "SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'; \
         WITH r AS (UPDATE {STATE} SET state = 'active', op_id = NULL, since = now(), drain_since = NULL, until_at = NULL \
           WHERE id AND state IN ('draining','frozen') RETURNING 1) SELECT count(*) FROM r"
    )
}
pub const SQL_READ_STATE: &str = "SELECT state || '|' || COALESCE(op_id, '') || '|' || (SELECT state FROM public.store_switch_effective_state()) FROM public.store_switch_state WHERE id";
/// Backend pids (no query text) holding a lock on the state table: the guard's FOR SHARE writers and idle-in-transaction sessions.
pub const SQL_BLOCKERS: &str = "SELECT COALESCE(string_agg(DISTINCT pid::text, ','), '') FROM pg_locks WHERE relation = 'public.store_switch_state'::regclass AND granted AND pid <> pg_backend_pid()";

pub const SQL_TILLS: &str = "SELECT COALESCE(json_agg(t), '[]'::json) FROM (\
    SELECT r.terminal_uuid, r.terminal_label, r.queue_depth::bigint AS queue_depth, r.dead_letter_depth::bigint AS dead_letter_depth, \
           r.seen_state, r.app_version, r.reported_by::text AS reported_by, EXTRACT(EPOCH FROM (now() - r.reported_at))::bigint AS age_s, \
           r.reported_at > COALESCE((SELECT s.drain_since FROM public.store_switch_state s WHERE s.id), 'infinity'::timestamptz) AS after_drain \
    FROM public.till_sync_report r WHERE r.reported_at > now() - interval '30 days' ORDER BY r.terminal_label, r.terminal_uuid) t";
pub const SQL_EXPECTED_LABELS: &str = "SELECT COALESCE(json_agg(DISTINCT terminal_id), '[]'::json) FROM public.caja_sessions WHERE opened_at > now() - interval '30 days'";

pub fn parse_tills(json: &str) -> R<Vec<TillRow>> {
    serde_json::from_str(json).map_err(|_| {
        OpError::err(
            "CLOUD_TILLS_UNREADABLE",
            "the till report list could not be read",
        )
    })
}
pub fn parse_labels(json: &str) -> R<Vec<String>> {
    serde_json::from_str(json).map_err(|_| {
        OpError::err(
            "CLOUD_LABELS_UNREADABLE",
            "the terminal label list could not be read",
        )
    })
}

/// The fence of ONE operation. Clone it into the keepalive thread.
#[derive(Clone)]
pub struct CloudFence {
    db: CloudDb,
    pub op_id: String,
    retry_pause: Duration,
    /// Set (and never cleared) when an extend was refused, or was asked for with an invalid window: the caller must fail.
    lost: Arc<AtomicBool>,
}

impl CloudFence {
    pub fn new(db: CloudDb, op_id: &str) -> R<CloudFence> {
        if !valid_op_id(op_id) {
            return Err(OpError::err(
                "OP_ID_INVALID",
                "the operation id has an unsafe shape",
            ));
        }
        Ok(CloudFence {
            db,
            op_id: op_id.to_string(),
            retry_pause: Duration::from_secs(2),
            lost: Arc::new(AtomicBool::new(false)),
        })
    }
    #[cfg(test)]
    pub(crate) fn with_retry_pause(mut self, d: Duration) -> CloudFence {
        self.retry_pause = d;
        self
    }

    /// Runs one transition. A PS001 (row count not 1) is the refusal `reason`; any other failure is CLOUD_QUERY_FAILED.
    fn transition(&self, txn: String, reason: &str, message: &str) -> R<()> {
        match self.db.run_raw(&txn) {
            Ok(_) => Ok(()),
            Err(f) if f.sqlstate.as_deref() == Some(REFUSED) => {
                Err(OpError::new(OpCode::Precondition, reason, message))
            }
            Err(f) => Err(CloudDb::query_failed(f)),
        }
    }
    pub fn begin_draining(&self, minutes: u32) -> R<()> {
        self.transition(
            sql_begin_draining(&self.op_id, minutes)?,
            "CLOUD_NOT_ACTIVE",
            "the cloud store is not active (another switch is running, or the store already moved)",
        )
    }
    /// Waits for in-flight writers (lock_timeout 10 s per try). A lock or statement timeout is retried up to 5 times, then the
    /// freeze fails closed as CLOUD_FREEZE_BLOCKED naming the blocking backend pids. A refused guarded UPDATE (missing row, not
    /// ours, not draining, expired) is CLOUD_DRAIN_EXPIRED at once: never retried.
    pub fn freeze(&self, minutes: u32) -> R<()> {
        let sql = sql_freeze(&self.op_id, minutes)?;
        for attempt in 1..=FREEZE_ATTEMPTS {
            match self.db.run_raw(&sql) {
                Ok(_) => return Ok(()),
                Err(f) if f.sqlstate.as_deref() == Some(REFUSED) => {
                    return Err(OpError::new(
                        OpCode::Precondition,
                        "CLOUD_DRAIN_EXPIRED",
                        "the drain window expired, was released or is not this operation's before the freeze",
                    ))
                }
                Err(f)
                    if matches!(
                        f.sqlstate.as_deref(),
                        Some(LOCK_TIMEOUT) | Some(STATEMENT_TIMEOUT)
                    ) =>
                {
                    if attempt < FREEZE_ATTEMPTS {
                        std::thread::sleep(self.retry_pause);
                    }
                }
                Err(f) => return Err(CloudDb::query_failed(f)),
            }
        }
        let pids = self
            .db
            .ro(SQL_BLOCKERS)
            .unwrap_or_else(|_| "unknown".to_string());
        Err(OpError::new(
            OpCode::Precondition,
            "CLOUD_FREEZE_BLOCKED",
            format!(
                "the freeze could not take the state row after {FREEZE_ATTEMPTS} tries; blocking backend pids: [{}]",
                if pids.is_empty() { "none visible" } else { &pids }
            ),
        ))
    }
    /// false = not extended (expired, released, not ours, or the call failed or timed out). A REFUSAL (PS001) also sets
    /// `lost()`: the fence is definitely gone, so the caller fails at once. A timeout or other failure is transient: the
    /// caller counts consecutive failures (5) and never retries into a dead freeze.
    pub fn extend(&self, minutes: u32) -> bool {
        // an invalid window is a caller bug: it must not look like a network blip
        let Ok(sql) = sql_extend(&self.op_id, minutes) else {
            self.lost.store(true, Ordering::SeqCst);
            return false;
        };
        match self.db.run_raw(&sql) {
            Ok(_) => true,
            Err(f) => {
                if f.sqlstate.as_deref() == Some(REFUSED) {
                    self.lost.store(true, Ordering::SeqCst);
                }
                false
            }
        }
    }
    /// True once any `extend` was refused. Shared by every clone (the keepalive's too).
    pub fn lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
    pub fn mark_moved(&self) -> R<()> {
        self.transition(
            sql_mark_moved(&self.op_id)?,
            "CLOUD_FENCE_LOST",
            "the cloud freeze expired, was released or is not this operation's: the move cannot be recorded",
        )
    }
    /// A missing row, a foreign operation or an already-active store is a refusal (CLOUD_FENCE_LOST), never a success.
    pub fn release(&self) -> R<()> {
        self.transition(
            sql_release(&self.op_id)?,
            "CLOUD_FENCE_LOST",
            "the cloud fence is not held by this operation: nothing was released",
        )
    }
    /// This operation's own hold, if it still has one (`sql_release_held`).
    pub fn release_held(&self) -> R<bool> {
        let out = self
            .db
            .run_raw(&sql_release_held(&self.op_id)?)
            .map_err(CloudDb::query_failed)?;
        Ok(out == "1")
    }
    pub fn release_unfinished(&self) -> R<bool> {
        let out = self
            .db
            .run_raw(&sql_release_unfinished())
            .map_err(CloudDb::query_failed)?;
        Ok(out == "1")
    }
    pub fn state(&self) -> R<String> {
        self.db.ro(SQL_READ_STATE)
    }
    pub fn tills(&self) -> R<Vec<TillRow>> {
        parse_tills(&self.db.ro(SQL_TILLS)?)
    }
    pub fn expected_labels(&self) -> R<Vec<String>> {
        parse_labels(&self.db.ro(SQL_EXPECTED_LABELS)?)
    }
}

/// Calls `tick` every `interval` on a thread until dropped. `tick` returns whether it worked.
pub struct KeepAlive {
    stop: Arc<AtomicBool>,
    failures: Arc<AtomicU32>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl KeepAlive {
    pub fn start(interval: Duration, tick: impl Fn() -> bool + Send + 'static) -> KeepAlive {
        let stop = Arc::new(AtomicBool::new(false));
        let failures = Arc::new(AtomicU32::new(0));
        let (s, f) = (stop.clone(), failures.clone());
        let handle = std::thread::spawn(move || {
            let slice = Duration::from_millis(25);
            // a clock deadline, not a count of nominal slices (a loaded machine oversleeps every slice): ticks START every `interval`
            let mut next = std::time::Instant::now() + interval;
            while !s.load(Ordering::SeqCst) {
                std::thread::sleep(slice);
                // stopped while asleep: no tick (a detached keepalive must not renew after the rollback began)
                if s.load(Ordering::SeqCst) {
                    break;
                }
                let now = std::time::Instant::now();
                if now >= next {
                    next = now + interval;
                    if tick() {
                        f.store(0, Ordering::SeqCst);
                    } else {
                        f.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        });
        KeepAlive {
            stop,
            failures,
            handle: Some(handle),
        }
    }
    pub fn consecutive_failures(&self) -> u32 {
        self.failures.load(Ordering::SeqCst)
    }
    /// Stop the thread (it ends after the tick it may be in) and return at once: dropping a `KeepAlive` waits for that tick, which can
    /// be a cloud call stuck on a silent link.
    pub fn stop_detached(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(self.handle.take());
    }
}
impl Drop for KeepAlive {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::switch::source::Secret;
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

    fn target(pw: &str) -> PgTarget {
        PgTarget {
            host: "db.example.invalid".into(),
            port: 5432,
            user: "postgres.abc".into(),
            password: Secret::new(pw),
            dbname: "postgres".into(),
            sslmode: "require".into(),
            sslrootcert: None,
        }
    }
    fn db() -> CloudDb {
        CloudDb::new("psql".into(), target("x"), "pgpass".into())
    }
    /// A fence whose psql answers are scripted; every SQL text it was given is recorded.
    fn scripted(answers: Vec<Result<String, RunFail>>) -> (CloudFence, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        let (s, a) = (seen.clone(), Mutex::new(answers.into_iter()));
        let hook: Hook = Arc::new(move |sql: &str| {
            s.lock().unwrap().push(sql.to_string());
            a.lock()
                .unwrap()
                .next()
                .unwrap_or_else(|| Ok(String::new()))
        });
        let f = CloudFence::new(db().with_hook(hook), "op-1")
            .unwrap()
            .with_retry_pause(Duration::ZERO);
        (f, seen)
    }
    fn fail(code: &str) -> Result<String, RunFail> {
        Err(RunFail {
            sqlstate: Some(code.into()),
            message: format!("ERROR:  {code}"),
            cert: false,
        })
    }

    #[test]
    fn the_password_travels_in_a_pgpass_file_never_in_an_argument_or_the_environment() {
        let pw = ["Zq", "9x", "Lm", "4v"].concat();
        let dir = tempfile::tempdir().unwrap();
        let file = write_pgpass(dir.path(), &target(&pw)).unwrap();
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .trim_end()
            .ends_with(&format!(":{pw}")));
        let env = libpq_env(&target(&pw), &file);
        assert!(env
            .iter()
            .any(|(k, v)| k == "PGPASSFILE" && v == &file.display().to_string()));
        assert!(!env.iter().any(|(k, v)| k == "PGPASSWORD" || v == &pw));
        assert!(env.iter().any(|(k, v)| k == "PGSSLMODE" && v == "require"));
        let args = psql_args("SELECT 1");
        let joined = args.join(" ");
        assert!(
            !joined.contains(&pw)
                && !joined.contains("db.example.invalid")
                && !joined.contains("postgres.abc")
        );
        assert_eq!(args.last().map(String::as_str), Some("SELECT 1"));
        assert!(args.iter().any(|a| a == "ON_ERROR_STOP=1"));
        assert!(
            args.iter().any(|a| a == "VERBOSITY=sqlstate"),
            "errors must come back as a bare SQLSTATE"
        );
    }

    fn env_of(t: &PgTarget, pgpass: &str) -> std::collections::HashMap<String, String> {
        libpq_env(t, std::path::Path::new(pgpass))
            .into_iter()
            .collect()
    }

    #[test]
    fn a_cloud_source_is_verified_against_the_bundled_ca_unless_the_operator_names_one() {
        let mut t = target("x");
        t.sslmode = "verify-full".into();
        let env = env_of(&t, "stage/pgpass");
        assert_eq!(env["PGSSLMODE"], "verify-full");
        assert_eq!(
            std::path::PathBuf::from(&env["PGSSLROOTCERT"]),
            std::path::Path::new("stage").join(BUNDLED_CA_FILE)
        );
        t.sslrootcert = Some("D:/pki/own.crt".into());
        assert_eq!(
            env_of(&t, "stage/pgpass")["PGSSLROOTCERT"],
            "D:/pki/own.crt"
        );
    }

    #[test]
    fn the_loopback_disable_contract_has_no_ca_and_no_cloud_policy_ever_sets_channel_binding() {
        let mut l = target("x");
        l.host = "127.0.0.1".into();
        l.sslmode = "disable".into();
        let env = env_of(&l, "pgpass");
        assert_eq!(env["PGSSLMODE"], "disable");
        assert!(!env.contains_key("PGSSLROOTCERT"));
        for ssl in ["disable", "require", "verify-ca", "verify-full"] {
            let mut t = target("x");
            t.sslmode = ssl.into();
            assert!(
                !env_of(&t, "pgpass").contains_key("PGCHANNELBINDING"),
                "{ssl}"
            );
        }
        // require alone names no CA (it would not be checked)
        assert!(!env_of(&target("x"), "pgpass").contains_key("PGSSLROOTCERT"));
    }

    #[test]
    fn the_pgpass_folder_also_gets_the_bundled_ca_only_when_it_will_be_used() {
        let mut t = target("x");
        t.sslmode = "verify-full".into();
        let d = tempfile::tempdir().unwrap();
        write_pgpass(d.path(), &t).unwrap();
        assert_eq!(
            std::fs::read(d.path().join(BUNDLED_CA_FILE)).unwrap(),
            SUPABASE_ROOT_CA_PEM
        );
        let mut own = t.clone();
        own.sslrootcert = Some("D:/pki/own.crt".into());
        let d2 = tempfile::tempdir().unwrap();
        write_pgpass(d2.path(), &own).unwrap();
        assert!(!d2.path().join(BUNDLED_CA_FILE).exists());
        let d3 = tempfile::tempdir().unwrap();
        write_pgpass(d3.path(), &target("x")).unwrap();
        assert!(
            !d3.path().join(BUNDLED_CA_FILE).exists(),
            "require does not verify"
        );
    }

    #[test]
    fn libpq_certificate_failures_get_their_own_code_and_other_failures_do_not() {
        for s in [
            "psql: error: connection to server at \"h\" (1.2.3.4), port 5432 failed: SSL error: certificate verify failed",
            "psql: error: connection to server failed: server certificate for \"a.example\" does not match host name \"b.example\"",
            "psql: error: could not read root certificate file \"/x/ca.crt\": No such file or directory",
            "psql: error: root certificate file \"/x/ca.crt\" does not exist",
            "SSL error: unable to get local issuer certificate",
            "SSL error: certificate has expired",
        ] {
            assert!(is_cert_verify_failure(s), "{s}");
            let secret = "Zq9xLm4v";
            let e = CloudDb::query_failed(classify_failure(&format!("{s} {secret}")));
            assert_eq!(e.reason, "SOURCE_CERT_VERIFY_FAILED");
            assert!(e.message.contains("sslrootcert") && e.message.contains("clock"));
            assert!(!e.message.contains(secret));
        }
        for s in [
            "FATAL:  password authentication failed for user \"postgres\"",
            "psql: error: connection timed out",
            "SSL error: sslv3 alert handshake failure",
        ] {
            assert!(!is_cert_verify_failure(s), "{s}");
            assert_eq!(
                CloudDb::query_failed(classify_failure(s)).reason,
                "CLOUD_QUERY_FAILED"
            );
        }
    }

    #[test]
    fn read_only_sessions_say_so_and_write_sessions_do_not_and_neither_uses_a_session_set() {
        assert!(RO_PREFIX.contains("READ ONLY") && !RW_PREFIX.contains("READ ONLY"));
        for p in [RO_PREFIX, RW_PREFIX] {
            assert!(p.contains("SET LOCAL statement_timeout"));
            assert!(
                !p.replace("SET LOCAL", "").contains("SET "),
                "a session-level SET would leak through a pooler: {p}"
            );
        }
        assert!(RW_PREFIX.contains("SET LOCAL lock_timeout = '10s'"));
        assert!(RW_PREFIX.contains("statement_timeout = '60s'"));
    }

    #[test]
    fn a_hand_built_target_is_guarded_too_and_a_local_one_is_refused_for_the_real_client() {
        let mut t = target("x");
        t.host = "127.0.0.1".into();
        let local = CloudDb::new("psql".into(), t, "pgpass".into());
        let e = local.run_raw("SELECT 1").unwrap_err();
        assert!(e.message.contains("network"), "{}", e.message);
        let mut bad = target("x");
        bad.host = "a b".into();
        assert!(CloudDb::new("psql".into(), bad, "pgpass".into())
            .run_raw("SELECT 1")
            .is_err());
        let mut plain = target("x");
        plain.sslmode = "disable".into();
        assert!(CloudDb::new("psql".into(), plain, "pgpass".into())
            .run_raw("SELECT 1")
            .is_err());
    }

    #[test]
    fn operation_ids_have_a_safe_shape() {
        assert!(valid_op_id("20261003-ab12cd34"));
        for bad in ["", "a b", "a'b", "a;b", &"x".repeat(41)] {
            assert!(!valid_op_id(bad), "{bad}");
        }
        assert!(CloudFence::new(db(), "a'b").is_err());
    }

    #[test]
    fn every_transition_is_one_transaction_that_locks_first_and_checks_the_clock_after() {
        let op = "op-1";
        for (name, sql) in [
            ("draining", sql_begin_draining(op, 30).unwrap()),
            ("freeze", sql_freeze(op, 25).unwrap()),
            ("extend", sql_extend(op, 20).unwrap()),
            ("moved", sql_mark_moved(op).unwrap()),
            ("release", sql_release(op).unwrap()),
        ] {
            assert!(sql.starts_with("BEGIN; SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '60s'; DO $fence$"), "{name}");
            assert!(sql.ends_with("COMMIT;"), "{name}");
            assert!(
                sql.contains("IF n <> 1 THEN RAISE EXCEPTION") && sql.contains("PS001"),
                "{name}: zero rows must be a refusal"
            );
            let lock = sql.find("PERFORM 1 FROM public.store_switch_state WHERE id FOR");
            let update = sql.find("UPDATE public.store_switch_state").unwrap();
            assert!(
                lock.is_some_and(|l| l < update),
                "{name}: the row is locked before the guarded UPDATE"
            );
            assert!(sql.contains("op_id = 'op-1'") || name == "draining");
            assert!(
                !sql.contains("now() <") && !sql.contains("> now()"),
                "{name}: the expiry is judged with clock_timestamp(), not the transaction start"
            );
        }
        let d = sql_begin_draining(op, 30).unwrap();
        assert!(d.contains(
            "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING"
        ));
        assert!(d.contains("interval '30 minutes'") && d.contains("state = 'active'"));
        assert!(
            !sql_freeze(op, 1).unwrap().contains("ON CONFLICT"),
            "the freeze is never an upsert"
        );
        // a lease, not a cap: every extend sets the deadline to NOW plus the window, whatever the freeze started with
        let ext = sql_extend(op, 30).unwrap();
        assert!(
            ext.contains("until_at = clock_timestamp() + interval '30 minutes'")
                && !ext.contains("LEAST")
                && !ext.contains("since +"),
            "{ext}"
        );
        for (name, sql) in [
            ("extend", sql_extend(op, 5).unwrap()),
            ("moved", sql_mark_moved(op).unwrap()),
            ("freeze", sql_freeze(op, 5).unwrap()),
        ] {
            assert!(
                sql.contains("until_at > clock_timestamp()"),
                "{name}: an expired freeze is never extended, frozen or recorded"
            );
        }
        assert!(
            sql_freeze(op, 1).unwrap().contains("FOR UPDATE;")
                && sql_freeze(op, 1).unwrap().contains("state = 'draining'")
        );
        assert!(
            sql_extend(op, 1).unwrap().contains("FOR NO KEY UPDATE;")
                && sql_extend(op, 1)
                    .unwrap()
                    .contains("state IN ('draining','frozen')")
        );
        let moved = sql_mark_moved(op).unwrap();
        assert!(moved.contains("state = 'frozen'") && moved.contains("until_at = NULL"));
        assert!(sql_release(op).unwrap().contains("'moved'"));
        assert!(
            !sql_release_unfinished().contains("'moved'"),
            "the unconditional release never reverts a recorded move"
        );
        assert!(!sql_release_unfinished().contains("BEGIN"));
    }

    #[test]
    fn the_scoped_release_names_the_operation_and_never_frees_a_moved_row() {
        let sql = sql_release_held("op-mine").unwrap();
        assert!(sql.contains("op_id = 'op-mine'"), "{sql}");
        assert!(
            sql.contains("state IN ('draining','frozen')") && !sql.contains("'moved'"),
            "{sql}"
        );
        assert!(sql_release_held("x$fence$; drop").is_err());
    }

    #[test]
    fn a_builder_given_an_op_that_closes_the_dollar_quote_refuses_and_yields_no_sql() {
        let evil = "x$fence$; DROP TABLE public.store_switch_state; --";
        for r in [
            sql_begin_draining(evil, 5),
            sql_freeze(evil, 5),
            sql_extend(evil, 5),
            sql_mark_moved(evil),
            sql_release(evil),
        ] {
            let e = r.unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "OP_ID_INVALID")
            );
        }
    }

    #[test]
    fn minutes_outside_1_to_240_are_refused_in_every_builder_and_never_reach_psql() {
        for bad in [0u32, 241, u32::MAX] {
            for r in [
                sql_begin_draining("op-1", bad),
                sql_freeze("op-1", bad),
                sql_extend("op-1", bad),
            ] {
                let e = r.unwrap_err();
                assert_eq!(
                    (e.code, e.reason.as_str()),
                    (OpCode::Usage, "MINUTES_OUT_OF_RANGE"),
                    "{bad}"
                );
            }
        }
        for ok in [1u32, 240] {
            assert!(sql_begin_draining("op-1", ok)
                .unwrap()
                .contains(&format!("interval '{ok} minutes'")));
            assert!(sql_freeze("op-1", ok).is_ok() && sql_extend("op-1", ok).is_ok());
        }
        let (f, seen) = scripted(vec![]);
        assert!(f.begin_draining(0).is_err() && f.freeze(241).is_err());
        assert!(!f.extend(0));
        assert!(f.lost(), "an invalid window is a bug, not a blip");
        assert!(seen.lock().unwrap().is_empty(), "no SQL was sent");
    }

    #[test]
    fn the_pgpass_escapes_a_colon_and_a_backslash_and_is_never_overwritten() {
        let pw = r"a:b\c";
        let dir = tempfile::tempdir().unwrap();
        let file = write_pgpass(dir.path(), &target(pw)).unwrap();
        let line = std::fs::read_to_string(&file).unwrap();
        assert!(line.trim_end().ends_with(r":a\:b\\c"), "{line}");
        let again = write_pgpass(dir.path(), &target("other")).unwrap_err();
        assert_eq!(again.reason, "CLOUD_PGPASS");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), line, "untouched");
    }

    #[test]
    fn a_control_character_in_the_user_password_or_database_is_refused() {
        for c in ['\n', '\r', '\0', '\u{7f}'] {
            for which in 0..3 {
                let mut t = target("pw");
                match which {
                    0 => t.user = format!("u{c}x"),
                    1 => t.password = Secret::new(format!("p{c}x")),
                    _ => t.dbname = format!("d{c}x"),
                }
                let e = check_target(&t, false, 0).unwrap_err();
                assert_eq!(
                    (e.code, e.reason.as_str()),
                    (OpCode::Usage, "SOURCE_URL_INVALID"),
                    "{c:?}/{which}"
                );
            }
        }
        assert!(check_target(&target("fine pw"), false, 0).is_ok());
    }

    #[test]
    fn a_refused_extend_marks_the_fence_lost_at_once_and_a_timeout_does_not() {
        let (f, _) = scripted(vec![fail("PS001")]);
        let clone = f.clone();
        assert!(!f.lost());
        assert!(!f.extend(5));
        assert!(
            f.lost() && clone.lost(),
            "the flag is shared with the keepalive's clone"
        );
        for code in ["55P03", "57014", "08006"] {
            let (f, _) = scripted(vec![fail(code)]);
            assert!(!f.extend(5));
            assert!(!f.lost(), "{code} is transient");
        }
        let (f, _) = scripted(vec![Ok(String::new())]);
        assert!(f.extend(5) && !f.lost());
    }

    #[test]
    fn the_till_rows_parse() {
        let json = r#"[{"terminal_uuid":"u1","terminal_label":"POS-1","queue_depth":2,"dead_letter_depth":0,"seen_state":"draining","app_version":"1.2.3","reported_by":"x","age_s":12,"after_drain":true},
                       {"terminal_uuid":"u2","terminal_label":"POS-2","queue_depth":0,"dead_letter_depth":1,"seen_state":"active","app_version":null,"reported_by":"y","age_s":900000,"after_drain":false}]"#;
        let rows = parse_tills(json).unwrap();
        assert_eq!(
            (rows.len(), rows[0].queue_depth, rows[1].app_version.clone()),
            (2, 2, None)
        );
        assert!(parse_tills("[]").unwrap().is_empty());
        assert!(parse_tills("not json").is_err());
        assert_eq!(
            parse_labels(r#"["POS-1","POS-2"]"#).unwrap(),
            vec!["POS-1".to_string(), "POS-2".to_string()]
        );
    }

    #[test]
    fn a_refused_guarded_update_is_the_operations_refusal_reason_and_never_a_success() {
        for (op, reason) in [
            ("draining", "CLOUD_NOT_ACTIVE"),
            ("freeze", "CLOUD_DRAIN_EXPIRED"),
            ("moved", "CLOUD_FENCE_LOST"),
            ("release", "CLOUD_FENCE_LOST"),
        ] {
            let (f, _) = scripted(vec![fail("PS001")]);
            let e = match op {
                "draining" => f.begin_draining(5),
                "freeze" => f.freeze(5),
                "moved" => f.mark_moved(),
                _ => f.release(),
            }
            .unwrap_err();
            assert_eq!(e.reason, reason, "{op}");
        }
        let (f, _) = scripted(vec![fail("08006")]);
        assert_eq!(f.mark_moved().unwrap_err().reason, "CLOUD_QUERY_FAILED");
        let (f, _) = scripted(vec![Ok(String::new())]);
        assert!(f.release().is_ok());
    }

    #[test]
    fn the_freeze_retries_a_lock_timeout_and_a_statement_timeout_then_succeeds() {
        let (f, seen) = scripted(vec![
            fail("55P03"),
            fail("57014"),
            fail("55P03"),
            Ok(String::new()),
        ]);
        f.freeze(5).unwrap();
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[test]
    fn the_freeze_gives_up_after_five_tries_and_names_the_blocking_pids_only() {
        let mut answers: Vec<_> = (0..5).map(|_| fail("55P03")).collect();
        answers.push(Ok("4242,4243".into())); // the blockers query
        let (f, seen) = scripted(answers);
        let e = f.freeze(5).unwrap_err();
        assert_eq!(e.reason, "CLOUD_FREEZE_BLOCKED");
        assert!(e.message.contains("[4242,4243]"), "{}", e.message);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.iter().filter(|s| s.contains("DO $fence$")).count(), 5);
        assert!(
            seen.last().unwrap().contains("pg_locks") && !seen.last().unwrap().contains("query"),
            "pids only, never query text"
        );
    }

    #[test]
    fn the_freeze_does_not_retry_a_refusal_or_any_other_error() {
        let (f, seen) = scripted(vec![fail("PS001")]);
        assert_eq!(f.freeze(5).unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        assert_eq!(seen.lock().unwrap().len(), 1);
        let (f, seen) = scripted(vec![fail("42501")]);
        assert_eq!(f.freeze(5).unwrap_err().reason, "CLOUD_QUERY_FAILED");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_extend_that_times_out_or_is_refused_is_false_and_counts_toward_the_keepalive_limit() {
        for code in ["55P03", "57014", "PS001"] {
            let (f, _) = scripted(vec![fail(code)]);
            assert!(!f.extend(5), "{code}");
        }
        let (f, _) = scripted(vec![Ok(String::new())]);
        assert!(f.extend(5));
        // the real wiring: a keepalive whose tick is `extend` while the cloud keeps timing out reaches the 5-failure limit
        let answers: Vec<_> = (0..40).map(|_| fail("55P03")).collect();
        let (f, _) = scripted(answers);
        let ka = KeepAlive::start(Duration::from_millis(25), move || f.extend(5));
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            ka.consecutive_failures() >= 5,
            "{}",
            ka.consecutive_failures()
        );
    }

    #[test]
    fn a_pg_failure_keeps_its_sqlstate_through_the_redaction() {
        assert_eq!(sqlstate_of("ERROR:  57014\n").as_deref(), Some("57014"));
        assert_eq!(sqlstate_of("psql: error: connection refused\n"), None);
        for code in ["57014", "55P03", "PS001"] {
            assert!(redact_pg_stderr(&format!("ERROR:  {code}\n")).contains(code));
        }
    }

    #[test]
    fn keepalive_ticks_until_it_is_dropped_and_counts_failures() {
        let ticks = Arc::new(AtomicU32::new(0));
        let t = ticks.clone();
        let ka = KeepAlive::start(Duration::from_millis(100), move || {
            t.fetch_add(1, Ordering::SeqCst);
            true
        });
        std::thread::sleep(Duration::from_millis(550));
        assert!(
            ticks.load(Ordering::SeqCst) >= 3,
            "ticked {}",
            ticks.load(Ordering::SeqCst)
        );
        assert_eq!(ka.consecutive_failures(), 0);
        drop(ka);
        let after = ticks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(ticks.load(Ordering::SeqCst), after, "no tick after drop");

        let bad = KeepAlive::start(Duration::from_millis(50), || false);
        std::thread::sleep(Duration::from_millis(400));
        assert!(bad.consecutive_failures() >= 3);
    }

    #[test]
    fn keepalive_measures_the_interval_by_the_clock_not_by_counting_sleep_slices() {
        // each tick takes 60 ms of a 100 ms interval: ticks START every ~100 ms (a nominal-slice count would add the 60 ms every time)
        let starts = Arc::new(std::sync::Mutex::new(Vec::<std::time::Instant>::new()));
        let st = starts.clone();
        let ka = KeepAlive::start(Duration::from_millis(100), move || {
            st.lock().unwrap().push(std::time::Instant::now());
            std::thread::sleep(Duration::from_millis(60));
            true
        });
        std::thread::sleep(Duration::from_millis(900));
        drop(ka);
        let starts = starts.lock().unwrap();
        let tightest = starts.windows(2).map(|w| w[1] - w[0]).min().unwrap();
        assert!(
            tightest < Duration::from_millis(150),
            "ticks started at least {tightest:?} apart; the 60 ms tick was added to the interval"
        );
    }
}

/// Real-Postgres tests of the fence state machine (cargo feature `fence-db-tests`; run only through
/// tests/support/run-fence-db-tests.ps1). They write the throwaway instance's `cloud_src`, never dev2.
#[cfg(all(test, feature = "fence-db-tests"))]
mod real {
    use super::*;
    use crate::switch::testkit::{admin, cloud_db, var, ResetFence, Session, CLOUD};
    use std::sync::{Mutex, MutexGuard};

    static SERIAL: Mutex<()> = Mutex::new(());
    /// One state row: the tests take turns (the runner also passes --test-threads=1), and the row is put back afterwards.
    fn turn() -> (MutexGuard<'static, ()>, ResetFence) {
        var("POS_SWITCH_PORT");
        let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let r = ResetFence;
        drop(ResetFence); // start from a clean row too
        (g, r)
    }
    fn fence(op: &str) -> CloudFence {
        CloudFence::new(cloud_db(), op).unwrap()
    }
    fn sql(q: &str) {
        admin().exec(CLOUD, q).unwrap();
    }
    fn one(q: &str) -> String {
        admin().scalar(CLOUD, q).unwrap()
    }
    fn row(op_expr: &str) -> String {
        one(&format!("SELECT COALESCE((SELECT state || '|' || COALESCE(op_id,'') FROM public.store_switch_state WHERE id), '{op_expr}')"))
    }
    /// Makes the drain/freeze of `op` expire in `ms` milliseconds (the time is the test's lever; the SQL under test is not changed).
    fn expire_in(ms: u32) {
        sql(&format!("UPDATE public.store_switch_state SET until_at = clock_timestamp() + interval '{ms} milliseconds'"));
    }
    /// A session that holds the guard's FOR SHARE on the state row, like a writer that already passed the guard.
    fn writer_holding_the_row() -> Session {
        let mut w = Session::open(CLOUD);
        w.run("BEGIN").unwrap();
        w.run("SELECT 1 FROM public.store_switch_state WHERE id FOR SHARE")
            .unwrap();
        w
    }

    #[test]
    fn the_state_machine_walks_draining_frozen_moved_and_refuses_the_wrong_operation() {
        let _t = turn();
        let f = fence("op-test-1");
        let other = fence("op-test-2");
        f.begin_draining(5).unwrap();
        assert_eq!(f.state().unwrap(), "draining|op-test-1|draining");
        assert_eq!(
            other.begin_draining(5).unwrap_err().reason,
            "CLOUD_NOT_ACTIVE",
            "only one switch at a time"
        );
        assert!(!other.extend(5));
        assert_eq!(other.freeze(5).unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        f.freeze(5).unwrap();
        assert!(f.extend(5));
        assert_eq!(
            other.mark_moved().unwrap_err().reason,
            "CLOUD_FENCE_LOST",
            "mark_moved by a foreign op_id is refused"
        );
        f.mark_moved().unwrap();
        assert_eq!(f.state().unwrap(), "moved|op-test-1|moved");
        assert!(
            !f.release_unfinished().unwrap(),
            "the unconditional release never reverts a move"
        );
        assert_eq!(
            other.release().unwrap_err().reason,
            "CLOUD_FENCE_LOST",
            "release of a foreign op is refused"
        );
        assert_eq!(f.state().unwrap(), "moved|op-test-1|moved");
        f.release().unwrap();
        assert_eq!(f.state().unwrap(), "active||active");
        assert_eq!(
            f.release().unwrap_err().reason,
            "CLOUD_FENCE_LOST",
            "releasing an already-released fence is a refusal, not a success"
        );
    }

    /// The keepalive is detached (not joined) when a rollback starts, so one last `extend` can land after the release: it must be
    /// refused by the guarded statement (no row matches: PS001), never re-freeze the cloud.
    #[test]
    fn a_late_extend_after_the_release_is_refused_and_does_not_freeze_the_cloud_again() {
        let _t = turn();
        let f = fence("op-test-late");
        f.begin_draining(5).unwrap();
        f.freeze(5).unwrap();
        assert!(
            f.release_held().unwrap(),
            "the rollback released this operation's hold"
        );
        assert_eq!(f.state().unwrap(), "active||active");
        assert!(!f.extend(30), "a late extend is refused");
        assert!(f.lost(), "the refusal (PS001) marks the fence lost");
        assert_eq!(
            f.state().unwrap(),
            "active||active",
            "the cloud row stays released: nothing was re-frozen"
        );
    }

    #[test]
    fn an_expired_freeze_cannot_be_extended_or_recorded_as_moved() {
        let _t = turn();
        let f = fence("op-test-3");
        f.begin_draining(5).unwrap();
        f.freeze(5).unwrap();
        expire_in(0);
        assert!(!f.extend(5), "extend after expiry is refused");
        assert_eq!(
            f.mark_moved().unwrap_err().reason,
            "CLOUD_FENCE_LOST",
            "mark_moved after expiry is refused"
        );
        assert_eq!(
            cloud_db()
                .ro("SELECT state FROM public.store_switch_status")
                .unwrap(),
            "active",
            "the dead-man released the cloud"
        );
        assert_eq!(
            row("-"),
            "frozen|op-test-3",
            "and the row was not resurrected by the extension"
        );
    }

    #[test]
    fn an_extend_that_waited_behind_a_writer_past_the_expiry_is_refused() {
        let _t = turn();
        let f = fence("op-test-5");
        f.begin_draining(5).unwrap();
        expire_in(1500);
        let mut w = writer_holding_the_row();
        let f2 = f.clone();
        let h = std::thread::spawn(move || f2.extend(5));
        std::thread::sleep(std::time::Duration::from_millis(2500));
        w.run("COMMIT").unwrap();
        assert!(
            !h.join().unwrap(),
            "the clock is checked after the lock wait, not at the start of the transaction"
        );
        assert_eq!(row("-"), "draining|op-test-5");
        assert!(
            one("SELECT (until_at < clock_timestamp())::text FROM public.store_switch_state")
                == "true",
            "the expiry was not pushed out"
        );
    }

    #[test]
    fn a_mark_moved_that_waited_behind_a_writer_past_the_expiry_is_refused() {
        let _t = turn();
        let f = fence("op-test-6");
        f.begin_draining(5).unwrap();
        f.freeze(5).unwrap();
        expire_in(1500);
        let mut w = writer_holding_the_row();
        let f2 = f.clone();
        let h = std::thread::spawn(move || f2.mark_moved());
        std::thread::sleep(std::time::Duration::from_millis(2500));
        w.run("COMMIT").unwrap();
        assert_eq!(h.join().unwrap().unwrap_err().reason, "CLOUD_FENCE_LOST");
        assert_eq!(row("-"), "frozen|op-test-6", "never recorded as moved");
    }

    #[test]
    fn a_freeze_whose_wait_outlasts_its_drain_window_is_refused() {
        let _t = turn();
        let f = fence("op-test-7");
        f.begin_draining(5).unwrap();
        expire_in(1500);
        let mut w = writer_holding_the_row();
        let f2 = f.clone();
        let h = std::thread::spawn(move || f2.freeze(5));
        std::thread::sleep(std::time::Duration::from_millis(2500));
        w.run("COMMIT").unwrap();
        assert_eq!(h.join().unwrap().unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        assert_eq!(
            row("-"),
            "draining|op-test-7",
            "the cloud was not frozen past its own expiry"
        );
    }

    #[test]
    fn a_freeze_waits_for_an_in_flight_writer_and_a_post_freeze_snapshot_sees_its_row() {
        let _t = turn();
        let f = fence("op-test-8");
        f.begin_draining(5).unwrap();
        let tag = format!("zz_t5_{}", std::process::id());
        let mut w = Session::open(CLOUD);
        w.run("BEGIN").unwrap();
        w.run(&format!(
            "INSERT INTO public.categories (name) VALUES ('{tag}')"
        ))
        .unwrap();
        let f2 = f.clone();
        let started = std::time::Instant::now();
        let h = std::thread::spawn(move || f2.freeze(5));
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(
            !h.is_finished(),
            "the freeze did not wait for an in-flight writer"
        );
        assert_eq!(row("-"), "draining|op-test-8");
        w.run("COMMIT").unwrap();
        h.join().unwrap().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(1500));
        assert_eq!(row("-"), "frozen|op-test-8");
        assert_eq!(
            one(&format!(
                "SELECT count(*) FROM public.categories WHERE name = '{tag}'"
            )),
            "1",
            "a snapshot taken after the freeze sees the writer's row"
        );
        // the marker row is removed by ResetFence once the store is active again (a frozen store refuses even this cleanup)
    }

    #[test]
    fn begin_draining_on_a_missing_row_creates_it_and_drains_it() {
        let _t = turn();
        sql("DELETE FROM public.store_switch_state");
        let f = fence("op-test-9");
        f.begin_draining(5).unwrap();
        assert_eq!(f.state().unwrap(), "draining|op-test-9|draining");
        assert_eq!(one("SELECT count(*) FROM public.store_switch_state"), "1");
    }

    #[test]
    fn a_freeze_on_a_truly_missing_row_is_refused_and_creates_nothing() {
        let _t = turn();
        sql("DELETE FROM public.store_switch_state");
        let f = fence("op-test-10");
        assert_eq!(f.freeze(5).unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        assert_eq!(
            one("SELECT count(*) FROM public.store_switch_state"),
            "0",
            "no frozen row was created"
        );
        assert_eq!(f.mark_moved().unwrap_err().reason, "CLOUD_FENCE_LOST");
        assert!(!f.extend(5));
        assert_eq!(f.release().unwrap_err().reason, "CLOUD_FENCE_LOST");
        assert_eq!(one("SELECT count(*) FROM public.store_switch_state"), "0");
    }

    #[test]
    fn a_freeze_past_an_uncommitted_heal_row_is_refused_and_the_store_stays_active() {
        let _t = turn();
        sql("DELETE FROM public.store_switch_state");
        let mut heal = Session::open(CLOUD);
        heal.run("BEGIN").unwrap();
        heal.run(
            "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING",
        )
        .unwrap();
        let f = fence("op-test-11");
        assert_eq!(f.freeze(5).unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        heal.run("COMMIT").unwrap();
        assert_eq!(
            row("-"),
            "active|",
            "the heal committed as active; nothing froze"
        );
    }

    #[test]
    fn a_freeze_that_cannot_get_the_row_fails_closed_naming_the_blocker() {
        let _t = turn();
        let f = fence("op-test-12");
        f.begin_draining(5).unwrap();
        // a session idle in a transaction holding the row exclusively: lock_timeout (10 s) x 5 tries, then CLOUD_FREEZE_BLOCKED
        let mut idle = Session::open(CLOUD);
        idle.run("BEGIN").unwrap();
        idle.run("SELECT 1 FROM public.store_switch_state WHERE id FOR UPDATE")
            .unwrap();
        let pid = idle.run("SELECT pg_backend_pid()").unwrap();
        let f2 = f
            .clone()
            .with_retry_pause(std::time::Duration::from_millis(100));
        let e = f2.freeze(5).unwrap_err();
        assert_eq!(e.reason, "CLOUD_FREEZE_BLOCKED");
        assert!(e.message.contains(pid.trim()), "{} / pid {pid}", e.message);
        assert_eq!(
            row("-"),
            "draining|op-test-12",
            "fail closed: nothing froze"
        );
    }

    #[test]
    fn a_read_only_session_cannot_write() {
        let _t = turn();
        let e = cloud_db()
            .ro("UPDATE public.store_switch_state SET state = 'moved'")
            .unwrap_err();
        assert_eq!(e.reason, "CLOUD_QUERY_FAILED");
        assert!(e.message.contains("25006"), "{}", e.message);
        assert_eq!(
            cloud_db()
                .ro("SELECT state FROM public.store_switch_status")
                .unwrap(),
            "active"
        );
    }

    #[test]
    fn till_reports_are_fresh_only_when_they_arrive_after_the_drain_began() {
        let _t = turn();
        let f = fence("op-test-4");
        let ins = |uuid: &str, label: &str| {
            sql(&format!(
                "INSERT INTO public.till_sync_report (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, app_version, reported_by) \
                 VALUES ('{uuid}', '{label}', 0, 0, 'draining', '1', '00000000-0000-4000-8000-000000000001') ON CONFLICT (terminal_uuid) DO UPDATE SET reported_at = now()"
            ))
        };
        ins("zz-test-old", "POS-8");
        f.begin_draining(5).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        ins("zz-test-new", "POS-9");
        let rows = f.tills().unwrap();
        let old = rows
            .iter()
            .find(|r| r.terminal_uuid == "zz-test-old")
            .unwrap();
        let new = rows
            .iter()
            .find(|r| r.terminal_uuid == "zz-test-new")
            .unwrap();
        assert!(!old.after_drain && new.after_drain);
        let pending =
            crate::switch::drain::evaluate_drain(&rows, &[], &Default::default()).unwrap();
        assert!(pending.iter().any(|p| matches!(p, crate::switch::drain::Pending::NotSeenDrain { label, .. } if label == "POS-8")));
        f.expected_labels().unwrap();
    }

    #[test]
    fn the_unconditional_release_ends_an_unfinished_switch_and_nothing_else() {
        let _t = turn();
        let f = fence("op-test-13");
        assert!(
            !f.release_unfinished().unwrap(),
            "nothing to release on an active store"
        );
        f.begin_draining(5).unwrap();
        assert!(f.release_unfinished().unwrap());
        assert_eq!(f.state().unwrap(), "active||active");
    }

    #[test]
    fn an_expired_drain_taken_over_by_another_operation_refuses_the_first_ones_every_move() {
        let _t = turn();
        let (a, b) = (fence("op-test-14a"), fence("op-test-14b"));
        a.begin_draining(5).unwrap();
        expire_in(1);
        std::thread::sleep(Duration::from_millis(50));
        b.begin_draining(5).unwrap();
        assert_eq!(a.freeze(5).unwrap_err().reason, "CLOUD_DRAIN_EXPIRED");
        assert_eq!(a.release().unwrap_err().reason, "CLOUD_FENCE_LOST");
        assert!(!a.extend(5) && a.lost(), "a refused extend is a lost fence");
        assert_eq!(a.mark_moved().unwrap_err().reason, "CLOUD_FENCE_LOST");
        assert_eq!(row("none"), "draining|op-test-14b");
    }

    #[test]
    fn a_store_that_already_moved_cannot_be_drained_again() {
        let _t = turn();
        let f = fence("op-test-15");
        f.begin_draining(5).unwrap();
        f.freeze(5).unwrap();
        f.mark_moved().unwrap();
        let e = fence("op-test-15b").begin_draining(5).unwrap_err();
        assert_eq!(e.reason, "CLOUD_NOT_ACTIVE");
        assert_eq!(row("none"), "moved|op-test-15");
    }

    #[test]
    fn the_unconditional_release_ends_a_live_frozen_fence_and_reports_it() {
        let _t = turn();
        let f = fence("op-test-16");
        f.begin_draining(5).unwrap();
        f.freeze(5).unwrap();
        assert_eq!(row("none"), "frozen|op-test-16");
        assert!(f.release_unfinished().unwrap());
        assert_eq!(f.state().unwrap(), "active||active");
    }
}
