//! HTTP boundary: `/jobs`, `/jobs/{id}`, `/audit`, `/health`. Ordering matters
//! — idempotency-dedup lookup happens BEFORE any INSERT, and the durable
//! INSERT of the job + its first event happens BEFORE the 200 response is
//! returned (durable-accept-before-response, PRN-02/PRN-03). Ported from the
//! spike (.planning/spikes/001-windows-print-broker/broker/src/main.rs:92-282)
//! with one deliberate adaptation: handlers return a plain `HttpResult`
//! (status + body) instead of a `tiny_http::Response` directly, so tests can
//! assert on status/body without depending on tiny_http's Response
//! introspection API — the wire behavior (status codes, JSON shape, ordering)
//! is unchanged; `to_tiny_http_response` wraps it at the HTTP edge.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

use crate::ledger::{now_iso, open_db, record_event};

/// Production port. LAN/VPN firewall scoping is Plan 19-02's job, not this plan's.
pub const PORT: u16 = 8973;

/// All interfaces, deliberately: the broker also serves other machines on
/// the store's LAN, not only the local Tauri app. Firewall scoping to
/// the local subnet happens in the installer (`windows/hooks.nsh`), not
/// here.
pub const BIND_ADDR: &str = "0.0.0.0";

/// Resolves the broker's bearer secret from the on-disk config/secret files.
/// Thin wrapper over `config::resolve_secret` — no insecure literal fallback
/// remains: a blank config secret with no usable secret file is now an
/// error, not a silently-accepted default.
pub fn resolve_broker_secret() -> Result<String, String> {
    crate::config::resolve_secret()
}

/// Constant-time (no early exit inside the fold) comparison of a raw header
/// value against the expected `Bearer <secret>` string. A length mismatch is
/// still folded over the longer side's length before being combined with the
/// byte-difference accumulator, so the comparison time does not depend on
/// where the strings first diverge. An empty `expected` never matches
/// anything (a blank/misconfigured secret must never authenticate).
fn bearer_matches(header_value: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = header_value.as_bytes();
    let b = expected.as_bytes();
    let len_ok = a.len() == b.len();
    let max_len = a.len().max(b.len());
    let mut diff: u8 = 0;
    for i in 0..max_len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    len_ok && diff == 0
}

#[derive(Deserialize)]
pub struct SubmitReq {
    pub idempotency_key: String,
    pub printer_name: String,
    pub payload_b64: String,
    pub origin: String,
}

#[derive(Serialize)]
struct SubmitResp {
    job_id: String,
    status: String,
}

#[derive(Serialize)]
struct ErrorResp {
    error: String,
    detail: String,
    job_id: Option<String>,
}

/// Plain (status, body) pair returned by every handler.
pub struct HttpResult {
    pub status: u16,
    pub body: Vec<u8>,
}

fn err_json(status_code: u16, error: &str, detail: &str, job_id: Option<String>) -> HttpResult {
    let body = serde_json::to_vec(&ErrorResp {
        error: error.to_string(),
        detail: detail.to_string(),
        job_id,
    })
    .unwrap();
    HttpResult { status: status_code, body }
}

fn ok_json<T: Serialize>(body: &T) -> HttpResult {
    HttpResult { status: 200, body: serde_json::to_vec(body).unwrap() }
}

pub fn handle_submit(conn: &Connection, req: SubmitReq) -> HttpResult {
    let payload = match base64::engine::general_purpose::STANDARD.decode(&req.payload_b64) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => return err_json(400, "invalid_payload", "payload_b64 decodes to empty bytes", None),
        Err(e) => {
            return err_json(
                400,
                "invalid_payload",
                &format!("payload_b64 is not valid base64: {e}"),
                None,
            )
        }
    };
    if req.idempotency_key.trim().is_empty() || req.printer_name.trim().is_empty() {
        return err_json(
            400,
            "invalid_payload",
            "idempotency_key and printer_name are required",
            None,
        );
    }

    // Idempotency: a repeat submission returns the existing durable job, never a second row.
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT id, status FROM jobs WHERE idempotency_key = ?1",
            params![req.idempotency_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap_or(None);
    if let Some((id, status)) = existing {
        record_event(
            conn,
            &id,
            "duplicate_submit",
            "idempotency_key already accepted; no new job created",
        );
        return ok_json(&SubmitResp { job_id: id, status });
    }

    let job_id = uuid::Uuid::new_v4().to_string();
    let ts = now_iso();
    // Durable commit BEFORE acceptance is returned to the caller.
    let result = conn.execute(
        "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'accepted', 0, ?6, ?6)",
        params![job_id, req.idempotency_key, req.printer_name, req.origin, payload, ts],
    );
    match result {
        Ok(_) => {
            record_event(
                conn,
                &job_id,
                "accepted",
                &format!("origin={} printer={}", req.origin, req.printer_name),
            );
            ok_json(&SubmitResp { job_id, status: "accepted".to_string() })
        }
        Err(e) => err_json(500, "persistence_failed", &format!("{e}"), None),
    }
}

#[allow(clippy::type_complexity)]
pub fn handle_get_job(conn: &Connection, job_id: &str) -> HttpResult {
    let job: Option<(String, String, String, i64, Option<i64>, Option<String>, String, String)> = conn
        .query_row(
            "SELECT status, origin, printer_name, attempts, win32_job_id, last_error, created_at, updated_at FROM jobs WHERE id = ?1",
            params![job_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()
        .unwrap_or(None);
    let Some((status, origin, printer_name, attempts, win32_job_id, last_error, created_at, updated_at)) = job
    else {
        return err_json(404, "not_found", "no job with that id", None);
    };
    let mut stmt = conn
        .prepare("SELECT ts, category, detail FROM events WHERE job_id = ?1 ORDER BY id ASC")
        .unwrap();
    let events: Vec<serde_json::Value> = stmt
        .query_map(params![job_id], |r| {
            Ok(serde_json::json!({
                "ts": r.get::<_, String>(0)?,
                "category": r.get::<_, String>(1)?,
                "detail": r.get::<_, Option<String>>(2)?,
            }))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    ok_json(&serde_json::json!({
        "job_id": job_id,
        "status": status,
        "origin": origin,
        "printer_name": printer_name,
        "attempts": attempts,
        "win32_job_id": win32_job_id,
        "last_error": last_error,
        "created_at": created_at,
        "updated_at": updated_at,
        "events": events,
    }))
}

/// Hand-rolled query-string filters for `GET /jobs` — no URL-parsing crate
/// added, matching this module's existing style (tiny_http exposes the raw
/// URL including its query string via `request.url()`; we split on `?` and
/// `&`/`=` ourselves).
#[derive(Default)]
struct JobListFilters {
    origin: Option<String>,
    printer_name: Option<String>,
    status: Option<String>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

fn parse_job_list_query(query_string: &str) -> JobListFilters {
    let mut f = JobListFilters::default();
    for pair in query_string.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        match key {
            "origin" if !value.is_empty() => f.origin = Some(value.to_string()),
            "printer_name" if !value.is_empty() => f.printer_name = Some(value.to_string()),
            "status" if !value.is_empty() => f.status = Some(value.to_string()),
            "from_ms" => f.from_ms = value.parse().ok(),
            "to_ms" => f.to_ms = value.parse().ok(),
            "limit" => f.limit = value.parse().ok(),
            "offset" => f.offset = value.parse().ok(),
            _ => {}
        }
    }
    f
}

/// `GET /jobs` — filterable, paginated job list (PRN-05). Returns summary
/// fields only (no payload, no event history — those stay `GET /jobs/{id}`-
/// only). Checked before the single-job `/jobs/{id}` route in
/// `run_http_server` so a bare `/jobs` or `/jobs?...` never falls into that
/// path.
pub fn handle_list_jobs(conn: &Connection, query_string: &str) -> HttpResult {
    let f = parse_job_list_query(query_string);
    let limit: i64 = f.limit.unwrap_or(50).clamp(1, 500);
    let offset: i64 = f.offset.unwrap_or(0).max(0);

    let mut where_clauses: Vec<&str> = vec!["1=1"];
    let mut bind: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(origin) = &f.origin {
        where_clauses.push("AND origin = ?");
        bind.push(Box::new(origin.clone()));
    }
    if let Some(printer_name) = &f.printer_name {
        where_clauses.push("AND printer_name = ?");
        bind.push(Box::new(printer_name.clone()));
    }
    if let Some(status) = &f.status {
        where_clauses.push("AND status = ?");
        bind.push(Box::new(status.clone()));
    }
    if let Some(from_ms) = f.from_ms {
        where_clauses.push("AND CAST(created_at AS INTEGER) >= ?");
        bind.push(Box::new(from_ms));
    }
    if let Some(to_ms) = f.to_ms {
        where_clauses.push("AND CAST(created_at AS INTEGER) <= ?");
        bind.push(Box::new(to_ms));
    }
    let where_sql = where_clauses.join(" ");

    let list_sql = format!(
        "SELECT id, status, origin, printer_name, attempts, created_at, updated_at FROM jobs WHERE {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );
    let count_sql = format!("SELECT COUNT(*) FROM jobs WHERE {where_sql}");

    let mut list_bind: Vec<&dyn ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    list_bind.push(&limit);
    list_bind.push(&offset);

    let mut stmt = conn.prepare(&list_sql).unwrap();
    let jobs: Vec<serde_json::Value> = stmt
        .query_map(list_bind.as_slice(), |r| {
            Ok(serde_json::json!({
                "job_id": r.get::<_, String>(0)?,
                "status": r.get::<_, String>(1)?,
                "origin": r.get::<_, String>(2)?,
                "printer_name": r.get::<_, String>(3)?,
                "attempts": r.get::<_, i64>(4)?,
                "created_at": r.get::<_, String>(5)?,
                "updated_at": r.get::<_, String>(6)?,
            }))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    let count_bind: Vec<&dyn ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let total: i64 = conn
        .query_row(&count_sql, count_bind.as_slice(), |r| r.get(0))
        .unwrap_or(0);

    ok_json(&serde_json::json!({ "jobs": jobs, "total": total }))
}

/// `GET /printers` — installed printer queue names plus the OS-configured
/// default (Settings' printer-select dropdown, closing the gap where
/// `receipt_printer_name()` on the Tauri side was a hardcoded placeholder
/// string that never matched any real Windows printer).
pub fn handle_list_printers() -> HttpResult {
    match crate::delivery::list_available_printers() {
        Ok(printers) => ok_json(&serde_json::json!({
            "printers": printers,
            "default": crate::delivery::default_printer(),
        })),
        Err(e) => err_json(500, "enum_printers_failed", &e, None),
    }
}

pub fn handle_audit(conn: &Connection) -> HttpResult {
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM jobs GROUP BY status")
        .unwrap();
    let counts: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({ "status": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? }))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    ok_json(&serde_json::json!({ "counts_by_status": counts }))
}

fn to_tiny_http_response(result: HttpResult) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(result.body)
        .with_status_code(result.status)
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
}

/// `secret` is already resolved by the caller (`main.rs`, before the service
/// reports `Running` to the SCM) — this function never resolves or refuses
/// to serve on a missing secret itself. The request loop polls
/// `server.recv_timeout` instead of blocking on `server.incoming_requests()`
/// so `shutdown` is checked at least twice a second even with no traffic;
/// `sc stop` then completes within about half a second instead of waiting
/// for the next request, which matters for an upgrade replacing the locked
/// `broker.exe` file.
pub fn run_http_server(shutdown: Arc<AtomicBool>, db_path: &Path, bind_addr: &str, secret: String) {
    let server = Server::http(bind_addr).expect("bind http server");
    crate::ledger::log(&format!(
        "http server listening on {bind_addr} (db={})",
        db_path.display()
    ));
    loop {
        if shutdown.load(AtomicOrdering::SeqCst) {
            break;
        }
        let mut request = match server.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => continue,
        };
        if shutdown.load(AtomicOrdering::SeqCst) {
            break;
        }
        let auth_ok = request
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Authorization"))
            .map(|h| bearer_matches(h.value.as_str(), &format!("Bearer {secret}")))
            .unwrap_or(false);

        let url = request.url().to_string();
        let method = request.method().clone();

        if !auth_ok {
            let _ = request.respond(to_tiny_http_response(err_json(
                401,
                "unauthorized",
                "missing or invalid Authorization bearer token",
                None,
            )));
            continue;
        }

        let conn = open_db(db_path);

        if method == Method::Post && url == "/jobs" {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let _ = request.respond(to_tiny_http_response(err_json(
                    400,
                    "invalid_payload",
                    "could not read request body",
                    None,
                )));
                continue;
            }
            let parsed: Result<SubmitReq, _> = serde_json::from_str(&body);
            match parsed {
                Ok(req) => {
                    let resp = handle_submit(&conn, req);
                    let _ = request.respond(to_tiny_http_response(resp));
                }
                Err(e) => {
                    let _ = request.respond(to_tiny_http_response(err_json(
                        400,
                        "invalid_payload",
                        &format!("malformed JSON body: {e}"),
                        None,
                    )));
                }
            }
        } else if method == Method::Get && (url == "/jobs" || url.starts_with("/jobs?")) {
            // Checked BEFORE the /jobs/{id} branch below so a bare /jobs or
            // /jobs?... never falls into that path.
            let query_string = url.splitn(2, '?').nth(1).unwrap_or("");
            let _ = request.respond(to_tiny_http_response(handle_list_jobs(&conn, query_string)));
        } else if method == Method::Get && url.starts_with("/jobs/") {
            let id = url.trim_start_matches("/jobs/");
            let _ = request.respond(to_tiny_http_response(handle_get_job(&conn, id)));
        } else if method == Method::Get && url == "/printers" {
            let _ = request.respond(to_tiny_http_response(handle_list_printers()));
        } else if method == Method::Get && url == "/audit" {
            let _ = request.respond(to_tiny_http_response(handle_audit(&conn)));
        } else if method == Method::Get && url == "/health" {
            let _ = request.respond(to_tiny_http_response(ok_json(&serde_json::json!({ "ok": true }))));
        } else {
            let _ = request.respond(to_tiny_http_response(err_json(404, "not_found", "no such route", None)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("print-broker-test-http-{name}-{}.db", std::process::id()))
    }

    fn sample_req(idem: &str) -> SubmitReq {
        SubmitReq {
            idempotency_key: idem.to_string(),
            printer_name: "NONEXISTENT_TEST_PRINTER_19".to_string(),
            payload_b64: base64::engine::general_purpose::STANDARD.encode(b"hello"),
            origin: "test".to_string(),
        }
    }

    // Test 1: a valid submission returns 200 with a UUID job_id, and a direct
    // SELECT against the ledger immediately shows status='accepted'.
    #[test]
    fn valid_submit_returns_200_and_durably_commits_accepted_status() {
        let path = temp_db_path("submit-ok");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let resp = handle_submit(&conn, sample_req("idem-ok-1"));
        assert_eq!(resp.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        let job_id = body["job_id"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(job_id).is_ok());

        let status: String = conn
            .query_row("SELECT status FROM jobs WHERE id=?1", params![job_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "accepted");
        let _ = std::fs::remove_file(&path);
    }

    // Test 3: malformed payload_b64 / empty idempotency_key -> 400, no row created.
    #[test]
    fn invalid_payload_rejected_400_before_any_write() {
        let path = temp_db_path("invalid-payload");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let mut bad_b64 = sample_req("idem-bad-1");
        bad_b64.payload_b64 = "not-base64!!!".to_string();
        let resp = handle_submit(&conn, bad_b64);
        assert_eq!(resp.status, 400);

        let mut bad_key = sample_req("");
        bad_key.idempotency_key = "".to_string();
        let resp2 = handle_submit(&conn, bad_key);
        assert_eq!(resp2.status, 400);

        let mut whitespace_key = sample_req("   ");
        whitespace_key.idempotency_key = "   ".to_string();
        let resp3 = handle_submit(&conn, whitespace_key);
        assert_eq!(resp3.status, 400);

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM jobs", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_file(&path);
    }

    // Directly required by must_haves.truths (PRN-06): two POST /jobs with the
    // same idempotency_key create exactly one job row and return the same
    // job_id both times.
    #[test]
    fn duplicate_idempotency_key_returns_same_job_id_and_creates_no_second_row() {
        let path = temp_db_path("idem-dedup");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);

        let first = handle_submit(&conn, sample_req("idem-dup-1"));
        let first_body: serde_json::Value = serde_json::from_slice(&first.body).unwrap();
        let first_id = first_body["job_id"].as_str().unwrap().to_string();

        let second = handle_submit(&conn, sample_req("idem-dup-1"));
        assert_eq!(second.status, 200);
        let second_body: serde_json::Value = serde_json::from_slice(&second.body).unwrap();
        assert_eq!(second_body["job_id"].as_str().unwrap(), first_id);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE idempotency_key='idem-dup-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_file(&path);
    }

    fn insert_job(conn: &Connection, id: &str, origin: &str, status: &str, created_at: &str) {
        conn.execute(
            "INSERT INTO jobs (id, idempotency_key, printer_name, origin, payload, status, attempts, created_at, updated_at)
             VALUES (?1, ?1, 'P', ?2, X'00', ?3, 0, ?4, ?4)",
            params![id, origin, status, created_at],
        )
        .unwrap();
    }

    // Test 1: GET /jobs with no query params returns jobs ordered by
    // created_at DESC (most recent first), as {jobs, total}, with summary
    // fields only (no payload/events).
    #[test]
    fn list_jobs_no_filters_returns_jobs_ordered_desc_by_created_at() {
        let path = temp_db_path("list-no-filters");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        insert_job(&conn, "job-a", "receipt", "accepted", "100");
        insert_job(&conn, "job-b", "receipt", "accepted", "300");
        insert_job(&conn, "job-c", "receipt", "accepted", "200");

        let resp = handle_list_jobs(&conn, "");
        assert_eq!(resp.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(body["total"], 3);
        let jobs = body["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 3);
        assert_eq!(jobs[0]["job_id"], "job-b");
        assert_eq!(jobs[1]["job_id"], "job-c");
        assert_eq!(jobs[2]["job_id"], "job-a");
        assert!(jobs[0].get("payload").is_none());
        assert!(jobs[0].get("events").is_none());
        let _ = std::fs::remove_file(&path);
    }

    // Test 2: GET /jobs?origin=receipt&status=failed returns only jobs
    // matching both filters.
    #[test]
    fn list_jobs_filters_by_origin_and_status() {
        let path = temp_db_path("list-origin-status");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        insert_job(&conn, "job-match", "receipt", "failed", "100");
        insert_job(&conn, "job-wrong-status", "receipt", "accepted", "100");
        insert_job(&conn, "job-wrong-origin", "test_print", "failed", "100");

        let resp = handle_list_jobs(&conn, "origin=receipt&status=failed");
        let body: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        let jobs = body["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["job_id"], "job-match");
        let _ = std::fs::remove_file(&path);
    }

    // Test 3: GET /jobs?from_ms=X&to_ms=Y returns only jobs with created_at
    // in that range.
    #[test]
    fn list_jobs_filters_by_date_range() {
        let path = temp_db_path("list-date-range");
        let _ = std::fs::remove_file(&path);
        let conn = open_db(&path);
        insert_job(&conn, "job-too-early", "receipt", "accepted", "100");
        insert_job(&conn, "job-in-range", "receipt", "accepted", "200");
        insert_job(&conn, "job-too-late", "receipt", "accepted", "300");

        let resp = handle_list_jobs(&conn, "from_ms=150&to_ms=250");
        let body: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        let jobs = body["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["job_id"], "job-in-range");
        let _ = std::fs::remove_file(&path);
    }

    fn raw_http_post(addr: &str, path: &str, auth_header: Option<&str>, body: &str) -> (u16, String) {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let mut stream = TcpStream::connect(addr).expect("connect to test server");
        let mut req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        );
        if let Some(h) = auth_header {
            req.push_str(&format!("Authorization: {h}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        stream.write_all(req.as_bytes()).expect("write request");
        let mut resp = String::new();
        stream.read_to_string(&mut resp).expect("read response");
        let status_line = resp.lines().next().unwrap_or("");
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        (status, resp)
    }

    // Test 2: POST /jobs with no Authorization header, the wrong bearer
    // value, or the old insecure default literal, returns 401 and the jobs
    // table row count is unchanged. Spins up the real run_http_server on a
    // fixed non-production test port (never 8973, to avoid colliding with a
    // real running broker) started with an explicit, known secret (the new
    // run_http_server signature requires one — there is no literal fallback
    // any more) and drives it with a minimal raw-HTTP client — this is the
    // one test that needs a genuine HTTP round trip since the auth check
    // lives inline in run_http_server's request loop, before any handler
    // (and thus before any SQLite write) runs.
    #[test]
    fn missing_or_wrong_auth_header_rejected_401_before_any_sqlite_write() {
        const TEST_ADDR: &str = "127.0.0.1:18980";
        const TEST_SECRET: &str = "test-fixed-secret-for-401-test";
        let path = temp_db_path("auth-401");
        let _ = std::fs::remove_file(&path);
        let _ = open_db(&path); // ensure schema exists up front

        let shutdown = Arc::new(AtomicBool::new(false));
        let db_path_clone = path.clone();
        std::thread::spawn(move || {
            run_http_server(shutdown, &db_path_clone, TEST_ADDR, TEST_SECRET.to_string());
        });
        std::thread::sleep(std::time::Duration::from_millis(300));

        let body = r#"{"idempotency_key":"idem-401","printer_name":"NONEXISTENT_TEST_PRINTER_19","payload_b64":"aGVsbG8=","origin":"test"}"#;

        let (status_no_auth, _) = raw_http_post(TEST_ADDR, "/jobs", None, body);
        assert_eq!(status_no_auth, 401);

        let (status_wrong_auth, _) = raw_http_post(TEST_ADDR, "/jobs", Some("Bearer totally-wrong-secret"), body);
        assert_eq!(status_wrong_auth, 401);

        let (status_old_literal, _) = raw_http_post(
            TEST_ADDR,
            "/jobs",
            Some("Bearer dev-only-insecure-secret-CHANGE-AT-INSTALL"),
            body,
        );
        assert_eq!(status_old_literal, 401);

        let conn = open_db(&path);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM jobs", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_file(&path);
    }

    // bearer_matches: equal -> true; one byte different -> false; different
    // length -> false; empty expected -> false (a blank secret must never
    // authenticate anything).
    #[test]
    fn bearer_matches_is_exact() {
        assert!(bearer_matches("Bearer abc123", "Bearer abc123"));
        assert!(!bearer_matches("Bearer abc124", "Bearer abc123"));
        assert!(!bearer_matches("Bearer abc12", "Bearer abc123"));
        assert!(!bearer_matches("", ""));
        assert!(!bearer_matches("anything", ""));
    }

    // BIND_ADDR stays "0.0.0.0" on purpose: the broker also serves
    // other machines on the store LAN, not only the local Tauri app.
    #[test]
    fn bind_addr_is_all_interfaces() {
        assert_eq!(BIND_ADDR, "0.0.0.0");
    }

    // The recv_timeout loop must notice `shutdown` and return even when no
    // request ever arrives, bounded well under the 3s test timeout (the
    // production poll interval is 500ms).
    #[test]
    fn server_returns_after_shutdown_without_a_request() {
        let path = temp_db_path("shutdown-no-request");
        let _ = std::fs::remove_file(&path);
        let _ = open_db(&path);

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();
        let db_path_clone = path.clone();
        let handle = std::thread::spawn(move || {
            run_http_server(shutdown_clone, &db_path_clone, "127.0.0.1:18981", "unused-secret".to_string());
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        shutdown.store(true, AtomicOrdering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = handle.join();
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(3))
            .expect("server thread did not exit within 3s of shutdown being set");
        let _ = std::fs::remove_file(&path);
    }
}
