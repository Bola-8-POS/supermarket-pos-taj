//! Helpers for the real-Postgres fence tests (cargo feature `fence-db-tests`). They need a native instance made by
//! store-server/tests/support/new-switch-instance.ps1, which sets the variables below; run-fence-db-tests.ps1 does both.
//! With the feature on and the variables missing the tests FAIL (never skip).
use crate::ops::swap::PsqlAdmin;
use crate::switch::cloud::CloudDb;
use crate::switch::source::{PgTarget, Secret};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

pub fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("{name} is required: run store-server/tests/support/run-fence-db-tests.ps1 (it provisions the throwaway instance)")
    })
}

fn port() -> u16 {
    let p: u16 = var("POS_SWITCH_PORT").parse().expect("POS_SWITCH_PORT");
    // never the selfhosted stack, never the shared dev2 database: these tests change the fence state and delete rows
    assert!(
        p != 54322 && p != 56322,
        "port {p} is not a throwaway instance"
    );
    p
}

/// supabase_admin on the instance's cluster (the test "local server" lives in `postgres`, the test "cloud" in `cloud_src`).
pub fn admin() -> PsqlAdmin {
    PsqlAdmin::new(
        PathBuf::from(var("POS_SWITCH_PSQL")),
        port(),
        PathBuf::from(var("POS_SWITCH_PGPASS")),
    )
}
pub const LOCAL: &str = "postgres";
pub const CLOUD: &str = "cloud_src";

/// The instance's supabase_admin as a "cloud" target (the password is read from the instance's pgpass file).
pub fn cloud_target() -> PgTarget {
    let line = std::fs::read_to_string(var("POS_SWITCH_PGPASS"))
        .expect("pgpass")
        .lines()
        .find(|l| l.contains(":supabase_admin:"))
        .expect("pgpass has no supabase_admin line")
        .to_string();
    let pw = line
        .rsplit(':')
        .next()
        .expect("pgpass format")
        .trim()
        .to_string();
    PgTarget {
        host: "127.0.0.1".into(),
        port: port(),
        user: "supabase_admin".into(),
        password: Secret::new(pw),
        dbname: CLOUD.into(),
        sslmode: "disable".into(),
        sslrootcert: None,
    }
}
pub fn cloud_db() -> CloudDb {
    CloudDb::new(
        PathBuf::from(var("POS_SWITCH_PSQL")),
        cloud_target(),
        PathBuf::from(var("POS_SWITCH_PGPASS")),
    )
    .allow_local(port())
}

/// Puts `cloud_src`'s state row back to active whatever a test did (and removes the markers the cloud tests wrote).
pub struct ResetFence;
impl Drop for ResetFence {
    fn drop(&mut self) {
        if std::env::var("POS_SWITCH_PORT").is_err() {
            return; // a panic inside Drop while unwinding would abort the whole run
        }
        let a = admin();
        let _ = a.exec(
            CLOUD,
            "INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;              UPDATE public.store_switch_state SET state = 'active', op_id = NULL, drain_since = NULL, until_at = NULL",
        );
        // session defaults a test may have set (one statement each: a missing role must not stop the others)
        for r in ["anon", "authenticated", "service_role"] {
            let _ = a.exec(CLOUD, &format!("ALTER ROLE {r} RESET session_replication_role"));
        }
        let _ = a.exec(CLOUD, "ALTER DATABASE cloud_src RESET session_replication_role");
        let _ = a.exec(
            CLOUD,
            "DELETE FROM public.till_sync_report WHERE terminal_uuid LIKE 'zz-test-%';              DELETE FROM public.categories WHERE name LIKE 'zz_t5_%'",
        );
    }
}

const OUT_END: &str = "@@OUT_END@@";
const ERR_END: &str = "@@ERR_END@@";

/// One long-lived psql connection, so a test can hold a transaction open while another session acts.
/// Errors do not stop the session (a failed statement just aborts the open transaction, like a real client).
pub struct Session {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<(bool, String)>,
    out: Vec<String>,
    err: Vec<String>,
    out_done: bool,
    err_done: bool,
}

impl Session {
    pub fn open(db: &str) -> Session {
        let mut args = admin().args(db, "");
        args.truncate(args.len() - 2); // drop the "-c" ""
        args.extend(["-v".to_string(), "ON_ERROR_STOP=0".to_string()]);
        let mut c = Command::new(var("POS_SWITCH_PSQL"));
        c.args(args);
        crate::pg::scrub_pg_env(&mut c);
        c.env("PGPASSFILE", var("POS_SWITCH_PGPASS"))
            .env("PGCONNECT_TIMEOUT", "5")
            .env("PGCLIENTENCODING", "UTF8")
            .env("PGOPTIONS", "-c lock_timeout=30s");
        c.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().expect("spawn psql");
        let stdin = child.stdin.take().unwrap();
        let (tx, rx) = channel();
        let o = child.stdout.take().unwrap();
        let e = child.stderr.take().unwrap();
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(o).lines().map_while(Result::ok) {
                let _ = tx.send((false, l));
            }
        });
        std::thread::spawn(move || {
            for l in BufReader::new(e).lines().map_while(Result::ok) {
                let _ = tx2.send((true, l));
            }
        });
        Session {
            child,
            stdin,
            rx,
            out: vec![],
            err: vec![],
            out_done: true,
            err_done: true,
        }
    }

    /// Sends the statements without waiting for the answer.
    pub fn post(&mut self, sql: &str) {
        self.out.clear();
        self.err.clear();
        self.out_done = false;
        self.err_done = false;
        // The trailing ; matters: without it psql keeps the statement in its buffer and the \echo below runs first.
        // \echo goes to stdout and \warn to stderr: one sentinel per stream, so an error line is never read late.
        writeln!(self.stdin, "{sql};\n\\echo {OUT_END}\n\\warn {ERR_END}")
            .expect("write psql stdin");
        self.stdin.flush().expect("flush psql stdin");
    }

    /// The answer once both sentinels arrived (`Ok(stdout)`, or `Err(stderr)` when the statements raised), None while still waiting.
    pub fn collect(&mut self, wait: Duration) -> Option<Result<String, String>> {
        let until = Instant::now() + wait;
        while !(self.out_done && self.err_done) {
            let left = until.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok((is_err, l)) => match (is_err, l.as_str()) {
                    (false, OUT_END) => self.out_done = true,
                    (true, ERR_END) => self.err_done = true,
                    (false, _) => self.out.push(l),
                    (true, _) => self.err.push(l),
                },
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => panic!("psql session ended"),
            }
        }
        Some(if self.err.is_empty() {
            Ok(self.out.join("\n"))
        } else {
            Err(self.err.join("\n"))
        })
    }

    /// `post` then `collect`; a statement that blocks for more than 30 s is a test failure, not a hang.
    pub fn run(&mut self, sql: &str) -> Result<String, String> {
        self.post(sql);
        self.collect(Duration::from_secs(30))
            .expect("statement still blocked after 30 s")
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
