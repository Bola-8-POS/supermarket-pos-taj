//! Delivery worker: WinSpool submission (`win_print`), the immediate
//! post-submit poll, and periodic reconciliation. Ported verbatim from the
//! spike (.planning/spikes/001-windows-print-broker/broker/src/main.rs:284-507)
//! — including the "Ok(None) => mark 'unknown', never resubmit" branch, the
//! single most safety-critical line in this module (PRN-06/PRN-07).

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::config::{self, BrokerConfig};
use crate::ledger::{now_iso, open_db, purge_expired_payloads, record_event};
use crate::retry::{self, RetryDecision};

pub const JOB_STATUS_PRINTED: u32 = 0x0000_0080;
pub const JOB_STATUS_ERROR: u32 = 0x0000_0002;
pub const JOB_STATUS_DELETED: u32 = 0x0000_0100;
pub const JOB_STATUS_PRINTING: u32 = 0x0000_0010;

/// Queue-health stuck-job threshold (D-15): a job left in 'submitted_to_os'
/// with no status change for longer than this gets exactly one
/// 'queue_health_alert' event — alert-only, never a status transition, never
/// a purge/resubmit. See `worker_tick_with_config`'s stuck-queue pass.
pub const STUCK_QUEUE_THRESHOLD_MS: i64 = 60_000;

#[cfg(target_os = "windows")]
pub mod win_print {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, DOC_INFO_1W, EndDocPrinter, EnumPrintersW, GetDefaultPrinterW, GetJobW,
        JOB_INFO_1W, OpenPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE,
        PRINTER_INFO_4W, StartDocPrinterW, WritePrinter,
    };

    /// Sends RAW bytes to an explicitly NAMED printer queue (never the
    /// default) and returns the Win32 spooler job id for later reconciliation.
    pub fn send_raw_named(printer_name: &str, bytes: &[u8]) -> Result<u32, String> {
        let name = HSTRING::from(printer_name);
        let mut handle = PRINTER_HANDLE::default();
        unsafe {
            OpenPrinterW(&name, &mut handle, None)
                .map_err(|e| format!("OpenPrinter('{printer_name}') failed: {}", e.message()))?;
        }
        let mut doc_name: Vec<u16> = "PrintBrokerJob\0".encode_utf16().collect();
        let mut datatype: Vec<u16> = "RAW\0".encode_utf16().collect();
        let doc_info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_mut_ptr()),
        };
        let job = unsafe { StartDocPrinterW(handle, 1, &doc_info) };
        if job == 0 {
            let _ = unsafe { ClosePrinter(handle) };
            return Err(
                "StartDocPrinter failed (job id 0) — spooler likely stopped or printer unreachable"
                    .to_string(),
            );
        }
        let mut written: u32 = 0;
        let ok = unsafe {
            WritePrinter(
                handle,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                std::ptr::addr_of_mut!(written),
            )
        };
        unsafe {
            let _ = EndDocPrinter(handle);
            let _ = ClosePrinter(handle);
        }
        if ok.0 == 0 || written != bytes.len() as u32 {
            return Err("WritePrinter failed or incomplete write".to_string());
        }
        Ok(job)
    }

    /// Queries the spooler for a job's current status bits. Returns None if
    /// the spooler no longer knows about the job (ambiguous: could mean
    /// long-completed-and-purged, or lost — caller must NOT treat that as
    /// success or blindly resubmit).
    pub fn query_job_status(printer_name: &str, win32_job_id: u32) -> Result<Option<u32>, String> {
        let name = HSTRING::from(printer_name);
        let mut handle = PRINTER_HANDLE::default();
        unsafe {
            OpenPrinterW(&name, &mut handle, None)
                .map_err(|e| format!("OpenPrinter('{printer_name}') failed: {}", e.message()))?;
        }
        let mut needed: u32 = 0;
        let mut buf: Vec<u8> = Vec::new();
        unsafe {
            let _ = GetJobW(handle, win32_job_id, 1, None, &mut needed);
            if needed > 0 {
                buf.resize(needed as usize, 0);
                let ok = GetJobW(handle, win32_job_id, 1, Some(&mut buf), &mut needed);
                let _ = ClosePrinter(handle);
                if ok.0 == 0 {
                    return Ok(None);
                }
                let info = &*(buf.as_ptr() as *const JOB_INFO_1W);
                return Ok(Some(info.Status));
            }
            let _ = ClosePrinter(handle);
        }
        Ok(None)
    }

    /// Enumerates locally-installed and remote-connection printer queue names
    /// via WinSpool `EnumPrintersW` (level 4 — name + server only, the
    /// cheapest info level for a plain name list). Two-call pattern: first
    /// call with a zero-length buffer to learn the required size, second call
    /// to actually fill it — the standard WinSpool idiom (mirrors
    /// `query_job_status`'s `GetJobW` two-call shape above).
    pub fn list_printer_names() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        unsafe {
            let _ = EnumPrintersW(flags, None, 4, None, &mut needed, &mut returned);
        }
        if needed == 0 {
            return Ok(Vec::new());
        }
        let mut buf: Vec<u8> = vec![0; needed as usize];
        unsafe {
            EnumPrintersW(flags, None, 4, Some(&mut buf), &mut needed, &mut returned)
                .map_err(|e| format!("EnumPrinters failed: {}", e.message()))?;
        }
        let mut names = Vec::new();
        unsafe {
            let base = buf.as_ptr() as *const PRINTER_INFO_4W;
            for i in 0..returned as isize {
                let info = &*base.offset(i);
                if !info.pPrinterName.is_null() {
                    if let Ok(name) = info.pPrinterName.to_string() {
                        if !name.is_empty() {
                            names.push(name);
                        }
                    }
                }
            }
        }
        Ok(names)
    }

    /// Reads the Windows-configured default printer name (`GetDefaultPrinterW`),
    /// two-call pattern as above. Returns `None` when no default printer is
    /// configured on this machine rather than erroring — the caller (broker
    /// HTTP layer) treats an absent default as "let the store pick one",
    /// never as a failure.
    pub fn default_printer_name() -> Option<String> {
        let mut needed: u32 = 0;
        unsafe {
            let _ = GetDefaultPrinterW(None, &mut needed);
        }
        if needed == 0 {
            return None;
        }
        let mut buf: Vec<u16> = vec![0; needed as usize];
        let result = unsafe { GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut needed) };
        if !result.as_bool() {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// Cross-platform wrapper around `win_print::list_printer_names` — the
/// non-Windows dev fallback returns an empty list rather than failing, same
/// posture as the rest of this module's non-Windows branches (`Err` on the
/// delivery path above logs a warning and never resubmits; a printer *list*
/// has no delivery consequence, so empty is enough for a dev machine that has
/// no real WinSpool).
pub fn list_available_printers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        win_print::list_printer_names()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// Cross-platform wrapper around `win_print::default_printer_name`.
pub fn default_printer() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        win_print::default_printer_name()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Classifies a WinSpool `JOB_INFO_1W::Status` bitfield into a ledger status
/// transition. Pure and platform-independent (factored out of the
/// reconciliation pass below) so it is unit-testable without real WinSpool
/// hardware — a `JOB_STATUS_DELETED` bit now maps to `Cancelled`, a distinct
/// outcome from `Failed`, completing PRN-07's 6-way status vocabulary.
enum StatusBitsOutcome {
    Failed,
    Printed,
    Cancelled,
    StillPrinting,
    StillPending,
}

fn classify_status_bits(bits: u32) -> StatusBitsOutcome {
    if bits & JOB_STATUS_ERROR != 0 {
        StatusBitsOutcome::Failed
    } else if bits & JOB_STATUS_PRINTED != 0 {
        StatusBitsOutcome::Printed
    } else if bits & JOB_STATUS_DELETED != 0 {
        StatusBitsOutcome::Cancelled
    } else if bits & JOB_STATUS_PRINTING != 0 {
        StatusBitsOutcome::StillPrinting
    } else {
        StatusBitsOutcome::StillPending
    }
}

/// Applies a reconciliation-pass status-bits outcome to the ledger — the
/// pure-classification half (`classify_status_bits`) plus the ledger
/// mutation, factored apart so the classification can be unit-tested without
/// real WinSpool hardware.
fn apply_status_bits_outcome(conn: &Connection, id: &str, ts: &str, outcome: StatusBitsOutcome, bits: u32) {
    match outcome {
        StatusBitsOutcome::Failed => {
            conn.execute("UPDATE jobs SET status='failed', updated_at=?1, last_checked_at=?1, last_error='spooler reported JOB_STATUS_ERROR' WHERE id=?2", params![ts, id]).ok();
            record_event(conn, id, "os_reported_failed", "JOB_STATUS_ERROR");
        }
        StatusBitsOutcome::Printed => {
            conn.execute("UPDATE jobs SET status='os_reported_printed', updated_at=?1, last_checked_at=?1 WHERE id=?2", params![ts, id]).ok();
            record_event(
                conn,
                id,
                "os_reported_printed",
                "JOB_STATUS_PRINTED (submission acknowledgement only, not physical-output proof)",
            );
        }
        StatusBitsOutcome::Cancelled => {
            // Distinct from Failed (PRN-07's 6-way status vocabulary) — a
            // spooler-cancelled job is not the same outcome as a genuine
            // delivery failure.
            conn.execute("UPDATE jobs SET status='cancelled', updated_at=?1, last_checked_at=?1, last_error='spooler job was deleted/cancelled' WHERE id=?2", params![ts, id]).ok();
            record_event(conn, id, "os_reported_cancelled", "JOB_STATUS_DELETED");
        }
        StatusBitsOutcome::StillPrinting => {
            conn.execute("UPDATE jobs SET last_checked_at=?1 WHERE id=?2", params![ts, id]).ok();
            record_event(conn, id, "still_printing", &format!("status_bits={bits:#x}"));
        }
        StatusBitsOutcome::StillPending => {
            conn.execute("UPDATE jobs SET last_checked_at=?1 WHERE id=?2", params![ts, id]).ok();
            record_event(conn, id, "still_pending", &format!("status_bits={bits:#x}"));
        }
    }
}

/// Gate for the config-load-failure log line below: `true` once the failure
/// has already been logged, so a tick every 500ms doesn't log again on
/// every pass. A corrupt config with a valid secret file (see
/// `resolve_secret_at`) can keep the service running on this fallback
/// indefinitely, so an un-gated log_error here would otherwise fill the
/// Windows Event Log for as long as the store stays open. Reset by a
/// successful load, so a later failure (after a fix, then a fresh break) is
/// still reported.
static CONFIG_ERROR_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Runs `log_once` only the first time `logged` flips from false to true;
/// a caller resets `logged` to false to re-arm it. Extracted from
/// `worker_tick` so "log once, not every tick" is testable without a real
/// config file or the Windows Event Log.
fn log_config_error_once(logged: &std::sync::atomic::AtomicBool, log_once: impl FnOnce()) {
    if !logged.swap(true, std::sync::atomic::Ordering::Relaxed) {
        log_once();
    }
}

/// Loads the current `BrokerConfig` (data-driven retry policy + retention
/// window, D-10/D-14) once for this tick and delegates. Kept separate from
/// `worker_tick_with_config` so tests can inject a fixture config directly
/// instead of racing against the real `%ProgramData%\PrintBroker\`
/// filesystem path.
pub fn worker_tick(conn: &Connection) {
    // A config load failure here must not stop delivery of jobs already
    // accepted (the HTTP boundary is what fails closed on a bad secret, not
    // this background worker) — fall back to defaults and log it once.
    let cfg = match config::load_or_init() {
        Ok(cfg) => {
            CONFIG_ERROR_LOGGED.store(false, std::sync::atomic::Ordering::Relaxed);
            cfg
        }
        Err(e) => {
            log_config_error_once(&CONFIG_ERROR_LOGGED, || {
                crate::ledger::log_error(&format!(
                    "worker_tick: broker config unavailable, using defaults: {e}"
                ));
            });
            BrokerConfig {
                port: crate::http::PORT,
                bearer_secret: String::new(),
                retention_days: config::DEFAULT_RETENTION_DAYS,
                retry: retry::RetryPolicy::default(),
            }
        }
    };
    worker_tick_with_config(conn, &cfg);
}

pub fn worker_tick_with_config(conn: &Connection, cfg: &BrokerConfig) {
    // Delivery pass: everything status='accepted'.
    let mut stmt = conn
        .prepare("SELECT id, printer_name, payload, attempts FROM jobs WHERE status = 'accepted'")
        .unwrap();
    let rows: Vec<(String, String, Vec<u8>, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    for (id, printer_name, payload, attempts) in rows {
        #[cfg(target_os = "windows")]
        let outcome = win_print::send_raw_named(&printer_name, &payload);
        #[cfg(not(target_os = "windows"))]
        let outcome: Result<u32, String> = Err("non-windows host".to_string());

        let ts = now_iso();
        match outcome {
            Ok(win32_job_id) => {
                conn.execute(
                    "UPDATE jobs SET status='submitted_to_os', win32_job_id=?1, attempts=attempts+1, updated_at=?2, last_checked_at=?2, last_error=NULL WHERE id=?3",
                    params![win32_job_id, ts, id],
                )
                .ok();
                record_event(conn, &id, "submitted_to_os", &format!("win32_job_id={win32_job_id}"));

                // Immediate follow-up check: some jobs complete and get purged
                // from the spooler faster than the periodic reconciliation
                // sweep can see them. Tight retry loop (0/10/20/40/80ms)
                // instead of one fixed delay — a single sleep either
                // overshoots (job already purged) or undershoots (not yet
                // terminal).
                let mut caught = false;
                for delay_ms in [0u64, 10, 20, 40, 80] {
                    if delay_ms > 0 {
                        std::thread::sleep(Duration::from_millis(delay_ms));
                    }
                    #[cfg(target_os = "windows")]
                    let quick_check = win_print::query_job_status(&printer_name, win32_job_id);
                    #[cfg(not(target_os = "windows"))]
                    let quick_check: Result<Option<u32>, String> = Ok(None);
                    if let Ok(Some(bits)) = quick_check {
                        if bits & JOB_STATUS_PRINTED != 0 || bits & JOB_STATUS_ERROR != 0 {
                            let ts2 = now_iso();
                            if bits & JOB_STATUS_PRINTED != 0 {
                                conn.execute("UPDATE jobs SET status='os_reported_printed', updated_at=?1, last_checked_at=?1 WHERE id=?2", params![ts2, id]).ok();
                                record_event(
                                    conn,
                                    &id,
                                    "os_reported_printed",
                                    &format!("caught by immediate post-submit check after {delay_ms}ms (JOB_STATUS_PRINTED)"),
                                );
                            } else {
                                conn.execute("UPDATE jobs SET status='failed', updated_at=?1, last_checked_at=?1, last_error='spooler reported JOB_STATUS_ERROR' WHERE id=?2", params![ts2, id]).ok();
                                record_event(
                                    conn,
                                    &id,
                                    "os_reported_failed",
                                    &format!("caught by immediate post-submit check after {delay_ms}ms (JOB_STATUS_ERROR)"),
                                );
                            }
                            caught = true;
                            break;
                        }
                        // still pending/printing — keep retrying within the tight loop.
                    } else {
                        // Job already gone from the spooler. If this happened
                        // at delay_ms == 0, it purged faster than this
                        // process can react at all — a real timing property
                        // of fast/local delivery, not a bug. Leave it for the
                        // periodic sweep to classify as 'unknown' rather than
                        // guessing here.
                        break;
                    }
                }
                let _ = caught;
            }
            Err(e) => {
                // D-10: classify then apply the config-driven per-failure-
                // class policy instead of the removed hardcoded MAX_ATTEMPTS.
                let decision = retry::decide(retry::classify_failure(&e), attempts, &cfg.retry);
                match decision {
                    RetryDecision::MarkFailed { attempts: final_attempts, event_category } => {
                        conn.execute(
                            "UPDATE jobs SET status='failed', attempts=?1, updated_at=?2, last_error=?3 WHERE id=?4",
                            params![final_attempts, ts, e, id],
                        )
                        .ok();
                        record_event(conn, &id, event_category, &e);
                    }
                    RetryDecision::WillRetry { attempts: new_attempts } => {
                        conn.execute(
                            "UPDATE jobs SET attempts=?1, updated_at=?2, last_error=?3 WHERE id=?4",
                            params![new_attempts, ts, e, id],
                        )
                        .ok();
                        record_event(
                            conn,
                            &id,
                            "submit_failed_will_retry",
                            &format!(
                                "attempt {new_attempts}/{}: {e}",
                                cfg.retry.max_attempts_transient
                            ),
                        );
                    }
                }
            }
        }
    }

    // Reconciliation pass: poll spooler for jobs we already submitted,
    // instead of trusting a single notification (notifications can
    // overflow/collapse per 19-RESEARCH.md).
    let mut stmt2 = conn
        .prepare(
            "SELECT id, printer_name, win32_job_id FROM jobs
             WHERE status = 'submitted_to_os' AND win32_job_id IS NOT NULL
             AND (last_checked_at IS NULL OR CAST(? AS INTEGER) - CAST(last_checked_at AS INTEGER) > ?)",
        )
        .unwrap();
    let now_ms: i64 = now_iso().parse().unwrap_or(0);
    let threshold_ms = (cfg.retry.reconcile_after_secs * 1000) as i64;
    let recon_rows: Vec<(String, String, i64)> = stmt2
        .query_map(params![now_ms, threshold_ms], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    for (id, printer_name, win32_job_id) in recon_rows {
        let ts = now_iso();
        #[cfg(target_os = "windows")]
        let status = win_print::query_job_status(&printer_name, win32_job_id as u32);
        #[cfg(not(target_os = "windows"))]
        let status: Result<Option<u32>, String> = Ok(None);

        match status {
            Ok(Some(bits)) => {
                apply_status_bits_outcome(conn, &id, &ts, classify_status_bits(bits), bits);
            }
            Ok(None) => {
                // Ambiguous handoff: spooler no longer has this job id. Do
                // NOT resubmit blindly — mark unknown for manual
                // reconciliation. This is the single most safety-critical
                // branch in the broker (PRN-06/PRN-07) — never change this to
                // auto-resubmit.
                conn.execute("UPDATE jobs SET status='unknown', updated_at=?1, last_checked_at=?1, last_error='spooler no longer reports this job id' WHERE id=?2", params![ts, id]).ok();
                record_event(
                    conn,
                    &id,
                    "ambiguous_handoff",
                    "GetJob returned no data for this win32_job_id; marked unknown, will not auto-resubmit",
                );
            }
            Err(e) => {
                conn.execute(
                    "UPDATE jobs SET last_checked_at=?1, last_error=?2 WHERE id=?3",
                    params![ts, e, id],
                )
                .ok();
                record_event(conn, &id, "reconcile_query_failed", &e);
            }
        }
    }

    // Stuck-queue detection pass (D-15, spike finding #2): a job left in
    // 'submitted_to_os' for over STUCK_QUEUE_THRESHOLD_MS with no status
    // change may be blocked behind a stuck head-of-queue job on that
    // printer. Alert-only — this ONLY appends a 'queue_health_alert' event;
    // it never updates the job's status and never touches the Windows print
    // queue. The `NOT IN (...)` clause against the events table is the sole
    // dedup mechanism (do not add a second one) — it is what makes this fire
    // exactly once per stuck job across repeated ticks.
    let now_ms_stuck: i64 = now_iso().parse().unwrap_or(0);
    let mut stmt3 = conn
        .prepare(
            "SELECT id, printer_name FROM jobs
             WHERE status = 'submitted_to_os'
               AND CAST(? AS INTEGER) - CAST(last_checked_at AS INTEGER) > ?
               AND id NOT IN (SELECT job_id FROM events WHERE category = 'queue_health_alert')",
        )
        .unwrap();
    let stuck_rows: Vec<(String, String)> = stmt3
        .query_map(params![now_ms_stuck, STUCK_QUEUE_THRESHOLD_MS], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    for (id, printer_name) in stuck_rows {
        record_event(
            conn,
            &id,
            "queue_health_alert",
            &format!(
                "job has been submitted_to_os for over {STUCK_QUEUE_THRESHOLD_MS}ms with no status \
                 change on printer '{printer_name}' — a stuck head-of-queue job may be blocking this \
                 printer; clear it manually via Windows Print Management"
            ),
        );
    }

    // Payload-retention purge pass (D-14, confirmed 7-day window): clears
    // only the payload BLOB on old jobs, never jobs/events metadata rows.
    purge_expired_payloads(conn, cfg.retention_days);
}

pub fn run_worker(shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>, db_path: &Path) {
    crate::ledger::log("worker loop starting");
    while !shutdown.load(std::sync::atomic::Ordering::SeqCst) {
        let conn = open_db(db_path);
        worker_tick(&conn);
        std::thread::sleep(Duration::from_millis(500));
    }
    crate::ledger::log("worker loop stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "print-broker-test-delivery-{name}-{}.db",
            std::process::id()
        ))
    }

    // D-15-adjacent cleanup: the config-load-failure line must not repeat
    // on every 500ms tick (it also writes the Windows Event Log), only the
    // first time a failure streak starts, and again after a later streak
    // starts fresh.
    #[test]
    fn log_config_error_once_logs_only_on_the_first_call_until_reset() {
        let logged = std::sync::atomic::AtomicBool::new(false);
        let mut calls = 0;

        log_config_error_once(&logged, || calls += 1);
        log_config_error_once(&logged, || calls += 1);
        assert_eq!(calls, 1, "a second call in the same failure streak must not log again");

        logged.store(false, std::sync::atomic::Ordering::Relaxed); // e.g. a load succeeded, then failed again
        log_config_error_once(&logged, || calls += 1);
        assert_eq!(calls, 2, "a fresh failure streak after a reset must log again");
    }

    // Formerly "retries up to MAX_ATTEMPTS then marks failed" — under D-10's
    // per-failure-class classification (this plan), a nonexistent printer
    // name is the canonical Terminal case (classify_failure matches
    // "invalid" in the real OpenPrinterW error text), so it now fails after
    // exactly 1 attempt instead of retrying 5x. Deterministic — never
    // depends on real print hardware being attached.
    #[test]
    fn nonexistent_printer_is_terminal_and_marks_failed_after_one_attempt() {
        let path = temp_db_path("retry-then-fail");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES ('job-retry', 'idem-retry', 'NONEXISTENT_TEST_PRINTER_19', 'test', X'00', 'accepted', 0, '1', '1')",
            [],
        )
        .unwrap();

        worker_tick(&conn);

        let (status, attempts, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, last_error FROM jobs WHERE id='job-retry'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(attempts, 1, "Terminal failures must not retry");
        assert!(last_error.is_some());
        let _ = std::fs::remove_file(&path);
    }

    // Test 5: restart-mid-flight recovery. A job durably accepted but never
    // delivered (attempts pre-seeded at 1, mirroring "the broker process was
    // killed right after a durable accept, a prior delivery attempt already
    // recorded in the ledger, before the worker tick could finish delivering
    // it") survives a fresh Connection against the same path (simulating a
    // process/service restart — the ledger, not any in-memory state, is
    // what survives per PRN-03), and a single worker_tick call after that
    // "restart" transitions it away from 'accepted' with zero new rows for
    // its idempotency_key (zero client resubmission). Uses the same
    // deterministic nonexistent-printer target as the test above so this
    // test does not depend on real print hardware.
    #[test]
    fn accepted_job_survives_restart_and_worker_tick_transitions_it_with_zero_new_rows() {
        let path = temp_db_path("restart-recovery");
        let _ = std::fs::remove_file(&path);
        {
            let conn = open_db(&path);
            conn.execute(
                "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
                 VALUES ('job-restart', 'idem-restart', 'NONEXISTENT_TEST_PRINTER_19', 'test', X'00', 'accepted', 1, '1', '1')",
                [],
            )
            .unwrap();
            // conn dropped here — simulates the broker process being killed
            // after durable accept but before the worker tick could deliver it.
        }

        let conn2 = open_db(&path); // simulates relaunching the broker against the same ledger file.
        worker_tick(&conn2);

        let (status, count): (String, i64) = conn2
            .query_row(
                "SELECT status, (SELECT COUNT(*) FROM jobs WHERE idempotency_key='idem-restart') FROM jobs WHERE id='job-restart'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(
            status, "accepted",
            "status must transition away from 'accepted' after the ledger-recovered worker tick"
        );
        assert_eq!(
            count, 1,
            "zero new rows for the same idempotency_key across the simulated restart — no client resubmission"
        );
        let _ = std::fs::remove_file(&path);
    }

    // Gap-audit (19-08-PLAN.md Task 3): the "unknown" reconciliation branch
    // (Ok(None) => mark 'unknown', never resubmit — the single most
    // safety-critical line in this module, PRN-06/PRN-07) had NO independent
    // automated test anywhere in this crate's suite — Plan 19-01's own
    // SUMMARY documented this as a known gap ("reproducing it deterministically
    // ... requires a live Windows printer object where OpenPrinterW succeeds
    // but GetJobW returns no data for a submitted job id"). This test closes
    // that gap using a real, always-present Windows printer object
    // ("Microsoft Print to PDF") purely for a READ-ONLY GetJobW query against
    // a win32_job_id that was never actually submitted to it — OpenPrinterW
    // succeeds (real printer, no hang/interactive-prompt risk since no
    // StartDocPrinterW call is ever made), GetJobW reports no data for the
    // bogus job id, exercising the exact Ok(None) branch deterministically.
    // Skips gracefully (does not fail) if this host has no "Microsoft Print
    // to PDF" printer object — same documented-platform-gap convention as
    // read_only_ledger_file_returns_persistence_failed_without_writing_rows
    // in ledger.rs.
    #[cfg(target_os = "windows")]
    #[test]
    fn ambiguous_handoff_marks_unknown_and_never_resubmits_when_spooler_no_longer_reports_job_id() {
        const PROBE_PRINTER: &str = "Microsoft Print to PDF";
        const BOGUS_WIN32_JOB_ID: u32 = 999_999_999;

        // Probe first: skip cleanly if this host lacks the printer object,
        // rather than failing a test on an environment-dependent precondition.
        if win_print::query_job_status(PROBE_PRINTER, BOGUS_WIN32_JOB_ID).is_err() {
            eprintln!(
                "SKIPPED ambiguous_handoff test: '{PROBE_PRINTER}' printer object not present on \
                 this host — platform-dependent, see .planning/spikes/CONVENTIONS.md"
            );
            return;
        }

        let path = temp_db_path("ambiguous-handoff");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at, win32_job_id, last_checked_at)
             VALUES ('job-ambig', 'idem-ambig', ?1, 'test', X'00', 'submitted_to_os', 1, '1', '1', ?2, '1')",
            params![PROBE_PRINTER, BOGUS_WIN32_JOB_ID],
        )
        .unwrap();

        worker_tick(&conn);

        let (status, last_error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error FROM jobs WHERE id='job-ambig'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "unknown", "an ambiguous handoff must mark 'unknown', never 'failed'/resubmit");
        assert!(last_error.unwrap().contains("no longer reports"));

        let category: String = conn
            .query_row(
                "SELECT category FROM events WHERE job_id='job-ambig' ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(category, "ambiguous_handoff");

        // The single most safety-critical guarantee: a second worker_tick
        // must NEVER pick this job back up for delivery or reconciliation —
        // 'unknown' is structurally excluded from both passes' SQL WHERE
        // clauses (never status='accepted'/'submitted_to_os').
        worker_tick(&conn);
        let (status2, attempts2): (String, i64) = conn
            .query_row(
                "SELECT status, attempts FROM jobs WHERE id='job-ambig'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status2, "unknown", "must never auto-resubmit a job once marked unknown");
        assert_eq!(attempts2, 1, "attempts must not change from a second tick on an unknown job");

        let _ = std::fs::remove_file(&path);
    }

    // Test 4: a job whose WinSpool status query returns JOB_STATUS_DELETED
    // is recorded with status='cancelled' (not 'failed'), with an
    // 'os_reported_cancelled' event category — distinct from a genuine
    // JOB_STATUS_ERROR failure.
    #[test]
    fn job_status_deleted_marks_cancelled_not_failed_with_os_reported_cancelled_event() {
        assert!(matches!(classify_status_bits(JOB_STATUS_DELETED), StatusBitsOutcome::Cancelled));

        let path = temp_db_path("cancelled-split");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES ('job-del', 'idem-del', 'P', 'test', X'00', 'submitted_to_os', 1, '1', '1')",
            [],
        )
        .unwrap();

        apply_status_bits_outcome(&conn, "job-del", "2", classify_status_bits(JOB_STATUS_DELETED), JOB_STATUS_DELETED);

        let status: String = conn
            .query_row("SELECT status FROM jobs WHERE id='job-del'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "cancelled", "must be its own status, not folded into 'failed'");

        let category: String = conn
            .query_row(
                "SELECT category FROM events WHERE job_id='job-del' ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(category, "os_reported_cancelled");
        let _ = std::fs::remove_file(&path);
    }

    // Test 5: a job with status='submitted_to_os' whose last_checked_at is
    // older than STUCK_QUEUE_THRESHOLD_MS gets exactly one
    // 'queue_health_alert' event on the tick that first detects it; a second
    // worker_tick call against the same still-stuck job appends no
    // additional event; the job's status itself is left unchanged
    // (alert-only, D-15).
    #[test]
    fn stuck_submitted_to_os_job_gets_exactly_one_queue_health_alert_event() {
        let path = temp_db_path("stuck-queue");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let now_ms: i64 = now_iso().parse().unwrap();
        let stale_ms = (now_ms - STUCK_QUEUE_THRESHOLD_MS - 10_000).to_string();

        // win32_job_id left NULL so the reconciliation pass (which requires
        // win32_job_id IS NOT NULL) does not also touch this row — isolates
        // the stuck-queue pass under test.
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at, last_checked_at)
             VALUES ('job-stuck', 'idem-stuck', 'P', 'test', X'00', 'submitted_to_os', 1, ?1, ?1, ?1)",
            params![stale_ms],
        )
        .unwrap();

        worker_tick(&conn);

        let alert_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE job_id='job-stuck' AND category='queue_health_alert'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(alert_count, 1, "exactly one alert on first detection");

        let status: String = conn
            .query_row("SELECT status FROM jobs WHERE id='job-stuck'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "submitted_to_os", "alert-only — status must never change (D-15)");

        worker_tick(&conn);
        let alert_count2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE job_id='job-stuck' AND category='queue_health_alert'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(alert_count2, 1, "no duplicate alert on a second tick for the same still-stuck job");

        let _ = std::fs::remove_file(&path);
    }
}

