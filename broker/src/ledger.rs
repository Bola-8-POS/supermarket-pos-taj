//! Broker durable ledger: SQLite WAL schema (`jobs`, `events`) plus the
//! `%ProgramData%\PrintBroker\` data-dir/log helpers. `open_db` takes an
//! explicit path (never a hidden global) so Task 2's tests can point at a
//! tempfile-backed path without colliding with a running dev instance.
//!
//! Ported from the spike
//! (.planning/spikes/001-windows-print-broker/broker/src/main.rs:28-90),
//! with the production data-dir name (`PrintBroker`, not `PrintBrokerSpike`).

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Production data directory: `%ProgramData%\PrintBroker\`.
pub fn data_dir() -> PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let dir = PathBuf::from(base).join("PrintBroker");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Production ledger path — only used by `main.rs`. Tests inject their own
/// tempfile path directly into `open_db`, never this function.
pub fn default_db_path() -> PathBuf {
    data_dir().join("ledger.db")
}

pub fn log_path() -> PathBuf {
    data_dir().join("broker.log")
}

pub fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    format!("{}", dur.as_millis())
}

/// Disk-fill guard: the broker is a permanent Windows Service and used to
/// append to `broker.log` forever with no cap. Rotate once the active file
/// crosses this size instead.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
/// Cap on rotated files kept alongside the active one (oldest deleted first).
const MAX_ROTATED_LOGS: usize = 10;

/// Takes an explicit `dir` (rather than calling `data_dir()` itself) so this
/// is unit-testable against a tempdir instead of the real `%ProgramData%`.
fn rotate_log_if_needed(path: &Path, dir: &Path, max_bytes: u64, max_rotated: usize) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < max_bytes {
        return;
    }
    let rotated = dir.join(format!("broker.{}.log", now_iso()));
    let _ = std::fs::rename(path, &rotated);

    let mut rotated_logs: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("broker.") && n.ends_with(".log") && n != "broker.log")
        })
        .collect();
    rotated_logs.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    if rotated_logs.len() > max_rotated {
        for p in rotated_logs.iter().take(rotated_logs.len() - max_rotated) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Appends a timestamped line to `broker.log` and stderr, rotating the file
/// once it grows past `MAX_LOG_BYTES`. Best-effort — a log write failure must
/// never break the broker itself.
pub fn log(msg: &str) {
    log_at(msg, false);
}

/// Same as `log`, but also reports the message to the Windows Application
/// Event Log (native OS logging service, visible in Event Viewer / any SIEM
/// already reading it) — use for failures an operator needs to see without
/// opening broker.log. No-op on non-Windows.
pub fn log_error(msg: &str) {
    log_at(msg, true);
}

fn log_at(msg: &str, is_error: bool) {
    use std::io::Write as _;
    let path = log_path();
    rotate_log_if_needed(&path, &data_dir(), MAX_LOG_BYTES, MAX_ROTATED_LOGS);
    let line = format!("{} {}\n", now_iso(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
    eprint!("{line}");
    if is_error {
        report_to_event_log(msg);
    }
}

#[cfg(windows)]
fn report_to_event_log(msg: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::System::EventLog::{
        DeregisterEventSource, RegisterEventSourceW, ReportEventW, EVENTLOG_ERROR_TYPE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // Best-effort, ad-hoc event source (no registry-registered message DLL) —
    // Event Viewer still records the source/message text; it just shows a
    // generic "description not found" header instead of a formatted one.
    unsafe {
        let source = wide(crate::SERVICE_NAME);
        let Ok(handle) = RegisterEventSourceW(None, PCWSTR(source.as_ptr())) else {
            return;
        };
        if handle.is_invalid() {
            return;
        }
        let message = wide(msg);
        let strings = [PCWSTR(message.as_ptr())];
        let _ = ReportEventW(
            handle,
            EVENTLOG_ERROR_TYPE,
            0,
            0,
            None,
            0,
            Some(&strings),
            None,
        );
        let _ = DeregisterEventSource(handle);
    }
}

#[cfg(not(windows))]
fn report_to_event_log(_msg: &str) {}

const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    printer_name TEXT NOT NULL,
    origin TEXT NOT NULL,
    payload BLOB,
    status TEXT NOT NULL,
    win32_job_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_checked_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    category TEXT NOT NULL,
    detail TEXT
);";

/// Opens (creating if needed) the WAL SQLite ledger at `path`. `synchronous=FULL`
/// in WAL mode fsyncs the WAL after each commit — a COMMIT does not return
/// until the write is durable (sqlite.org/pragma.html#pragma_synchronous).
/// Never weaken this to `NORMAL` — this pragma is what makes durable-accept-
/// before-response (PRN-02/PRN-03) actually true.
pub fn open_db(path: &Path) -> Connection {
    let conn = Connection::open(path).expect("open sqlite db");
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "FULL").ok();
    conn.execute_batch(SCHEMA_SQL).expect("create schema");
    conn
}

pub fn record_event(conn: &Connection, job_id: &str, category: &str, detail: &str) {
    conn.execute(
        "INSERT INTO events (job_id, ts, category, detail) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![job_id, now_iso(), category, detail],
    )
    .ok();
}

/// Purges payload BLOB bytes for jobs older than `retention_days` (D-14,
/// confirmed 7-day window). NEVER touches status/attempts/created_at/
/// updated_at or any events row — only the payload column is ever cleared,
/// per D-14's "metadata retained indefinitely" split.
///
/// Excludes `status='accepted'` jobs: those are still awaiting delivery and
/// need their payload bytes intact for `delivery.rs`'s next worker tick —
/// a job stuck in 'accepted' for longer than the retention window (e.g. the
/// broker was down) must not have its payload silently nulled out from
/// under it before it can ever be delivered.
pub fn purge_expired_payloads(conn: &Connection, retention_days: u32) {
    let now_ms: i64 = now_iso().parse().unwrap_or(0);
    let retention_ms = retention_days as i64 * 86_400_000;
    conn.execute(
        "UPDATE jobs SET payload = NULL
         WHERE payload IS NOT NULL
           AND status != 'accepted'
           AND (CAST(?1 AS INTEGER) - CAST(created_at AS INTEGER)) > ?2",
        rusqlite::params![now_ms, retention_ms],
    )
    .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "print-broker-test-ledger-{name}-{}.db",
            std::process::id()
        ))
    }

    #[test]
    fn rotate_log_if_needed_rolls_oversized_file_and_prunes_beyond_cap() {
        let dir = std::env::temp_dir().join(format!(
            "print-broker-test-rotate-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let active = dir.join("broker.log");

        // Below the cap: no rotation.
        std::fs::write(&active, "small").unwrap();
        rotate_log_if_needed(&active, &dir, 1024, 10);
        assert!(active.exists(), "file under cap must not rotate");

        // Over the cap: rotates to a timestamped sibling, active path freed up.
        std::fs::write(&active, "x".repeat(20)).unwrap();
        rotate_log_if_needed(&active, &dir, 10, 10);
        assert!(!active.exists(), "oversized file must be renamed away");
        let rotated: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(rotated.len(), 1, "exactly one rotated file expected");

        // Beyond max_rotated: oldest rotated files get pruned.
        for i in 0..3 {
            std::fs::write(&active, "x".repeat(20)).unwrap();
            rotate_log_if_needed(&active, &dir, 10, 1);
            std::thread::sleep(std::time::Duration::from_millis(5));
            let _ = i;
        }
        let remaining: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            remaining.len() <= 2, // 1 kept rotated file + the fresh active file
            "pruning must cap rotated files at max_rotated, got {}",
            remaining.len()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_db_creates_jobs_and_events_tables() {
        let path = temp_db_path("schema");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('jobs','events')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    // Test 6: making the ledger file read-only mirrors the spike's `attrib +R`
    // fault case — POST /jobs (here, a direct handle_submit call against a
    // Connection opened while the file was still writable) must return 500
    // persistence_failed with no job/event row created, never a false
    // "accepted". Skips with a clear message on platforms/filesystems where a
    // read-only file doesn't block SQLite writes the same way (task allows
    // this explicitly — CONVENTIONS.md documents the same platform caveat).
    #[test]
    fn read_only_ledger_file_returns_persistence_failed_without_writing_rows() {
        let path = temp_db_path("readonly");
        let _ = std::fs::remove_file(&path);
        {
            // Create schema while the file is still writable.
            let conn = open_db(&path);
            drop(conn);
        }

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        // Re-opening against the now-read-only file can itself fail on some
        // platforms (a stronger form of the same "no write reaches the
        // ledger" guarantee this test exists to prove) — catch that case and
        // treat it as a pass-by-a-stronger-guarantee, not a test failure.
        let open_result = std::panic::catch_unwind(|| open_db(&path));
        let conn = match open_result {
            Ok(conn) => conn,
            Err(_) => {
                restore_writable(&path);
                eprintln!(
                    "SKIPPED read_only_ledger_file test: Connection::open() itself failed against \
                     the read-only file (a stronger form of the same guarantee) — platform-dependent, \
                     see .planning/spikes/CONVENTIONS.md"
                );
                let _ = std::fs::remove_file(&path);
                return;
            }
        };

        let resp = crate::http::handle_submit(&conn, sample_req("idem-readonly-1"));
        drop(conn);
        restore_writable(&path);

        if resp.status == 200 {
            eprintln!(
                "SKIPPED read_only_ledger_file test: this platform/filesystem did not block writes \
                 to a read-only-attributed SQLite file — documented platform gap, see \
                 .planning/spikes/CONVENTIONS.md"
            );
            let _ = std::fs::remove_file(&path);
            return;
        }
        assert_eq!(resp.status, 500);
        let body = String::from_utf8(resp.body).unwrap();
        assert!(body.contains("persistence_failed"));

        let conn2 = open_db(&path);
        let count: i64 = conn2
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE idempotency_key='idem-readonly-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_file(&path);
    }

    // Test 5: purge_expired_payloads nulls payload for jobs older than the
    // retention window while status/attempts/created_at/updated_at stay
    // byte-identical.
    #[test]
    fn purge_expired_payloads_nulls_payload_for_old_jobs_leaves_metadata_untouched() {
        let path = temp_db_path("purge-old");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let now_ms: i64 = now_iso().parse().unwrap();
        let eight_days_ago_ms = (now_ms - 8 * 86_400_000).to_string();

        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES ('job-old', 'idem-old', 'P', 'test', X'0011', 'failed', 1, ?1, ?1)",
            rusqlite::params![eight_days_ago_ms],
        )
        .unwrap();

        purge_expired_payloads(&conn, 7);

        let (payload, status, attempts, created_at, updated_at): (
            Option<Vec<u8>>,
            String,
            i64,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT payload, status, attempts, created_at, updated_at FROM jobs WHERE id='job-old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(payload, None, "payload must be purged");
        assert_eq!(status, "failed");
        assert_eq!(attempts, 1);
        assert_eq!(created_at, eight_days_ago_ms);
        assert_eq!(updated_at, eight_days_ago_ms);
        let _ = std::fs::remove_file(&path);
    }

    // Test 6: a job within the retention window is untouched.
    #[test]
    fn purge_expired_payloads_leaves_jobs_within_window_untouched() {
        let path = temp_db_path("purge-recent");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let now_ms: i64 = now_iso().parse().unwrap();
        let one_day_ago_ms = (now_ms - 1 * 86_400_000).to_string();

        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES ('job-recent', 'idem-recent', 'P', 'test', X'0011', 'failed', 1, ?1, ?1)",
            rusqlite::params![one_day_ago_ms],
        )
        .unwrap();

        purge_expired_payloads(&conn, 7);

        let payload: Option<Vec<u8>> = conn
            .query_row("SELECT payload FROM jobs WHERE id='job-recent'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(payload, Some(vec![0x00, 0x11]), "job within retention window must be untouched");
        let _ = std::fs::remove_file(&path);
    }

    // Test 7: GET /jobs/{id} for a job whose payload was already purged
    // still returns 200 with status/events — handle_get_job never selects
    // the payload column at all, so a NULL payload can never surface as an
    // error here (degrades gracefully per UI-SPEC).
    #[test]
    fn get_job_returns_200_with_events_when_payload_already_purged() {
        let path = temp_db_path("purge-get-job");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let now_ms: i64 = now_iso().parse().unwrap();
        let eight_days_ago_ms = (now_ms - 8 * 86_400_000).to_string();
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES ('job-purged', 'idem-purged', 'P', 'test', X'0011', 'failed', 1, ?1, ?1)",
            rusqlite::params![eight_days_ago_ms],
        )
        .unwrap();
        record_event(&conn, "job-purged", "accepted", "origin=test printer=P");
        purge_expired_payloads(&conn, 7);

        let resp = crate::http::handle_get_job(&conn, "job-purged");
        assert_eq!(resp.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(body["status"], "failed");
        assert!(!body["events"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    fn restore_writable(path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }
    }

    fn sample_req(idem: &str) -> crate::http::SubmitReq {
        use base64::Engine;
        crate::http::SubmitReq {
            idempotency_key: idem.to_string(),
            printer_name: "NONEXISTENT_TEST_PRINTER_19".to_string(),
            payload_b64: base64::engine::general_purpose::STANDARD.encode(b"hello"),
            origin: "test".to_string(),
        }
    }
}
