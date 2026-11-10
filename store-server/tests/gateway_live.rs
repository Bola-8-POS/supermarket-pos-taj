//! Real Caddy, no other component: `POS_PACK_DIR=<unpacked pack> cargo test --test gateway_live -- --ignored --test-threads=1`
//! Loopback and ephemeral ports only. Every Caddy this file starts is a child it kills on drop (by PID, never by image name).
//! The host certificate store is never touched (`skip_install_trust` in the rendered file; plain HTTP here anyway).
mod common;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::{caddy, params, write_conf};
use posctl::gateway::TlsMode;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Running {
    child: Child,
    port: u16,
    int_port: u16,
    mode_port: u16,
    root: tempfile::TempDir,
    anon: String,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts Caddy on the live (or maintenance) file. `upstreams` = (gotrue, postgrest, functions); `None` = three free ports
/// nobody listens on, so every proxied request is a Caddy-generated failure. `unfiltered_access_log` is the negative control.
fn start(maintenance: bool, upstreams: Option<(u16, u16, u16)>, unfiltered_access_log: bool) -> Running {
    start_mutated(maintenance, upstreams, unfiltered_access_log, None)
}

/// `mutate` rewrites the rendered live Caddyfile before Caddy reads it (negative controls only).
fn start_mutated(maintenance: bool, upstreams: Option<(u16, u16, u16)>, unfiltered_access_log: bool, mutate: Option<fn(String) -> String>) -> Running {
    let root = tempfile::tempdir().unwrap();
    let (gp, pp, fp) = upstreams.unwrap_or_else(|| (free_port(), free_port(), free_port()));
    let (ext, int_port, mode_port) = (free_port(), free_port(), free_port());
    let p = params(root.path(), TlsMode::Off, [ext, int_port, mode_port, gp, pp, fp], vec![]);
    let anon = p.anon_key.clone();
    let w = write_conf(&p);
    if unfiltered_access_log {
        let text = std::fs::read_to_string(&w.caddyfile).unwrap().replace("\r\n", "\n"); // git may check templates out with CRLF
        let marker = "caddy-external-access.log\" {\n\t\t\troll_size 10MiB\n\t\t\troll_keep 3\n\t\t}\n\t\timport log_filter";
        assert!(text.contains(marker), "template changed; update the control");
        std::fs::write(&w.caddyfile, text.replace(marker, &marker.replace("\n\t\timport log_filter", ""))).unwrap();
    }
    if let Some(m) = mutate {
        let text = std::fs::read_to_string(&w.caddyfile).unwrap().replace("\r\n", "\n");
        std::fs::write(&w.caddyfile, m(text)).unwrap();
    }
    std::fs::write(root.path().join("state").join("status.json"), r#"{"schema":1,"state":"updating"}"#).unwrap();
    let xdg = root.path().join("xdg");
    let child = Command::new(caddy())
        .args(["run", "--adapter", "caddyfile", "--config"])
        .arg(if maintenance { &w.maintenance } else { &w.caddyfile })
        .env("XDG_DATA_HOME", &xdg)
        .env("XDG_CONFIG_HOME", &xdg)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start caddy");
    let mut r = Running { child, port: ext, int_port, mode_port, root, anon };
    let started = Instant::now();
    let mut ready = vec![ext, int_port];
    if maintenance {
        ready.push(mode_port);
    }
    for port in ready {
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            if started.elapsed() > Duration::from_secs(15) || r.child.try_wait().ok().flatten().is_some() {
                let mut err = String::new();
                if r.child.try_wait().ok().flatten().is_some() {
                    if let Some(mut e) = r.child.stderr.take() {
                        let _ = std::io::Read::read_to_string(&mut e, &mut err); // caddy has exited, so its stderr has ended
                    }
                }
                // the runtime log is configured to a file, so a startup error lands there rather than on stderr
                let log = std::fs::read_to_string(r.root.path().join("logs").join("caddy-runtime.log")).unwrap_or_default();
                panic!("caddy did not listen on {port}; caddy stderr:
{err}
caddy-runtime.log:
{log}");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    r
}

struct Reply {
    status: u16,
    headers: String,
    body: String,
}

fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)]) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("Content-Length: 0\r\n\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut raw = String::new();
    let _ = s.read_to_string(&mut raw);
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Reply { status, headers: head.to_ascii_lowercase(), body: body.to_string() }
}

const ORIGIN: (&str, &str) = ("Origin", "http://tauri.localhost");

fn read_logs(root: &Path) -> String {
    let dir: PathBuf = root.join("logs");
    let mut all = String::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        all.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
    }
    all
}

/// Waits (bounded) until the logs hold `needle`: Caddy flushes asynchronously.
fn wait_for_log(root: &Path, needle: &str) -> String {
    let started = Instant::now();
    loop {
        let logs = read_logs(root);
        if logs.contains(needle) || started.elapsed() > Duration::from_secs(5) {
            return logs;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A minimal upstream: records each request (line + headers) and answers 200 `{}` with a CORS header of its own.
struct Echo {
    port: u16,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

fn echo_upstream() -> Echo {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { break };
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap_or(0);
            seen2.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
            // Like a real backend, read the whole declared body before answering: Caddy's `request_body max_size` trips while the body
            // streams through (it does not refuse on Content-Length alone), so an upstream that never reads would hide an oversize body.
            let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            let declared = head.lines().find_map(|l| l.strip_prefix("content-length:")?.trim().parse::<usize>().ok()).unwrap_or(0);
            let mut got = head.find("\r\n\r\n").map_or(0, |i| n - (i + 4));
            let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
            while got < declared {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => got += k,
                }
            }
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        }
    });
    Echo { port, seen }
}

fn seen_count(e: &Echo) -> usize {
    e.seen.lock().unwrap().len()
}

/// Waits (bounded) until the upstream has recorded `n` requests.
fn wait_seen(e: &Echo, n: usize) -> Vec<String> {
    let started = Instant::now();
    while seen_count(e) < n && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    e.seen.lock().unwrap().clone()
}

#[test]
#[ignore]
fn maintenance_answers_store_updating_with_cors_and_serves_the_status_file() {
    let g = start(true, None, false);
    let r = http(g.port, "POST", "/functions/v1/process-direct-sale", &[ORIGIN, ("Apikey", &g.anon)]);
    assert_eq!(r.status, 503);
    assert!(r.body.contains("\"code\":\"STORE_UPDATING\""), "{}", r.body);
    assert!(r.headers.contains("retry-after: 30"), "{}", r.headers);
    assert!(r.headers.contains("access-control-allow-origin: http://tauri.localhost"), "{}", r.headers);
    assert_eq!(http(g.port, "GET", "/_store/health", &[ORIGIN]).status, 503);
    assert_eq!(http(g.port, "OPTIONS", "/rest/v1/products", &[ORIGIN]).status, 204);
    assert_eq!(http(g.port, "OPTIONS", "/rest/v1/products", &[("Origin", "http://evil.example")]).status, 403);
    // Task 2 ruling (@status_read): the status file answers GET/HEAD only, every other method is the 503
    assert_eq!(http(g.port, "GET", "/_store/status", &[ORIGIN]).status, 401);
    let s = http(g.port, "GET", "/_store/status", &[ORIGIN, ("Apikey", &g.anon)]);
    assert_eq!(s.status, 200);
    assert!(s.body.contains("\"state\":\"updating\""), "{}", s.body);
    assert_eq!(http(g.port, "HEAD", "/_store/status", &[ORIGIN, ("Apikey", &g.anon)]).status, 200);
    let post = http(g.port, "POST", "/_store/status", &[ORIGIN, ("Apikey", &g.anon)]);
    assert_eq!(post.status, 503, "{} {}", post.headers, post.body);
    assert!(post.body.contains("\"code\":\"STORE_UPDATING\""), "{}", post.body);
}

#[test]
#[ignore]
fn a_forced_502_becomes_503_and_no_log_keeps_a_secret() {
    let g = start(false, None, false);
    let bearer = "Bearer BEARERSECRETVALUE";
    let r = http(
        g.port,
        "POST",
        "/rest/v1/rpc/x?token=SECRETSIGNEDTOKEN&apikey=QUERYAPIKEYVALUE",
        &[ORIGIN, ("Apikey", &g.anon), ("Authorization", bearer), ("Cookie", "sid=COOKIEVALUE")],
    );
    assert_eq!(r.status, 503, "{} {}", r.headers, r.body);
    assert!(r.body.contains("\"code\":\"UPSTREAM_UNAVAILABLE\""), "{}", r.body);
    assert!(r.headers.contains("retry-after: 5"), "{}", r.headers);
    assert!(r.headers.contains("access-control-allow-origin: http://tauri.localhost"), "{}", r.headers);
    // wait for the access log line of this very request, so the absence checks below prove something
    let logs = wait_for_log(g.root.path(), "rpc/x");
    assert!(logs.contains("/rest/v1/rpc/x"), "no access log line was written, the test proves nothing: {logs}");
    // the LAN pairing code is a bearer secret for its lifetime: it must not reach any log either
    let _ = http(g.port, "GET", "/_store/pair/ABCD2345", &[]);
    let logs = wait_for_log(g.root.path(), "/_store/pair/");
    assert!(logs.contains("/_store/pair/REDACTED"), "the pairing request was not logged, the test proves nothing: {logs}");
    for forbidden in ["ABCD2345", "Apikey", "apikey=QUERYAPIKEYVALUE", g.anon.as_str(), "BEARERSECRETVALUE", "Authorization", "SECRETSIGNEDTOKEN", "COOKIEVALUE", "Cookie"] {
        assert!(!logs.contains(forbidden), "a log kept {forbidden}: {logs}");
    }
}

#[test]
#[ignore]
fn negative_control_an_unfiltered_access_log_does_keep_the_apikey_and_the_signed_query() {
    let g = start(false, None, true);
    let _ = http(
        g.port,
        "POST",
        "/rest/v1/rpc/x?token=SECRETSIGNEDTOKEN",
        &[ORIGIN, ("Apikey", &g.anon), ("Authorization", "Bearer BEARERSECRETVALUE"), ("Cookie", "sid=COOKIEVALUE")],
    );
    let _ = http(g.port, "GET", "/_store/pair/ABCD2345", &[]);
    let _ = wait_for_log(g.root.path(), "/_store/pair/");
    let logs = wait_for_log(g.root.path(), "rpc/x");
    // Caddy itself already logs Authorization and Cookie as REDACTED; the Apikey header and the signed-URL query are the
    // secrets only the log_filter protects, so those are what the control must see leak.
    for leaked in ["Apikey", g.anon.as_str(), "SECRETSIGNEDTOKEN", "ABCD2345"] {
        assert!(logs.contains(leaked), "the control no longer leaks {leaked}, so the filter test above proves nothing: {logs}");
    }
}

#[test]
#[ignore]
fn each_route_reaches_its_upstream_with_the_right_path_and_headers() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let spoof = [
        ("Apikey", g.anon.as_str()),
        ("X-Forwarded-For", "6.6.6.6, 7.7.7.7"),
        ("X-Real-IP", "8.8.8.8"),
        ("Forwarded", "for=9.9.9.9"),
        ("Authorization", "Bearer user-token-for-the-backend"),
    ];
    assert_eq!(http(g.port, "GET", "/rest/v1/products?select=id", &spoof).status, 200);
    assert_eq!(http(g.port, "GET", "/auth/v1/user", &spoof).status, 200);
    assert_eq!(http(g.port, "POST", "/functions/v1/get-server-time", &spoof).status, 200);
    assert_eq!(http(g.port, "GET", "/_store/health", &spoof).status, 200);
    let rest = wait_seen(&postgrest, 1).join("\n");
    let auth = wait_seen(&gotrue, 1).join("\n");
    let funcs = wait_seen(&functions, 2);
    assert_eq!(funcs.len(), 2, "{funcs:?}");
    assert!(rest.starts_with("GET /products?select=id HTTP/1.1"), "{rest}");
    assert!(auth.starts_with("GET /user HTTP/1.1"), "{auth}");
    assert!(funcs[0].starts_with("POST /functions/v1/get-server-time HTTP/1.1"), "{}", funcs[0]);
    // Task 2 ruling: the health route IS rewritten to the functions program's health endpoint
    assert!(funcs[1].starts_with("GET /functions/v1/_health HTTP/1.1"), "{}", funcs[1]);
    for seen in [&rest, &auth, &funcs[0], &funcs[1]] {
        let low = seen.to_ascii_lowercase();
        assert!(low.contains("x-forwarded-for: 127.0.0.1\r\n"), "XFF must be exactly the peer: {seen}");
        assert!(!low.contains("6.6.6.6") && !low.contains("7.7.7.7"), "spoofed XFF reached the upstream: {seen}");
        assert!(!low.contains("8.8.8.8") && !low.contains("9.9.9.9"), "spoofed X-Real-IP/Forwarded reached the upstream: {seen}");
        assert!(!low.contains("x-real-ip") && !low.contains("forwarded: for="), "{seen}");
        assert!(low.contains("authorization: bearer user-token-for-the-backend"), "the user's bearer must pass through: {seen}");
    }
    // nothing was sent to a backend that did not own the route
    assert_eq!(seen_count(&postgrest), 1);
    assert_eq!(seen_count(&gotrue), 1);
    assert_eq!(seen_count(&functions), 2);
}

#[test]
#[ignore]
fn the_backend_cors_headers_never_reach_the_till() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let r = http(g.port, "GET", "/rest/v1/products", &[ORIGIN, ("Apikey", &g.anon)]);
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.matches("access-control-allow-origin:").count(), 1, "{}", r.headers);
    assert!(r.headers.contains("access-control-allow-origin: http://tauri.localhost"), "{}", r.headers);
    let r = http(g.port, "GET", "/rest/v1/products", &[("Apikey", &g.anon)]);
    assert_eq!(r.status, 200);
    assert!(!r.headers.contains("access-control-allow-origin"), "a request with no Origin gets no CORS header: {}", r.headers);
}

/// The status screen reads the server clock from `Date` on GET /_store/status (LAN listener, Origin + Apikey), which a browser
/// only exposes cross-origin when `Date` is in Access-Control-Expose-Headers. Token match, and the older tokens must remain.
#[test]
#[ignore]
fn cors_exposes_the_date_header_through_the_gateway() {
    let g = start(false, None, false);
    let r = http(g.port, "GET", "/_store/status", &[ORIGIN, ("Apikey", &g.anon)]);
    assert_eq!(r.status, 200, "{} {}", r.headers, r.body);
    let line = r.headers.lines().find_map(|l| l.strip_prefix("access-control-expose-headers:")).unwrap_or_else(|| panic!("no expose-headers: {}", r.headers));
    let tokens: Vec<&str> = line.split(',').map(str::trim).collect();
    for want in ["date", "content-range", "content-location", "retry-after", "preference-applied"] {
        assert!(tokens.contains(&want), "{want} missing from {tokens:?}");
    }
}

#[test]
#[ignore]
fn contract_a_the_maintenance_file_has_a_mode_probe_and_the_same_internal_listener() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let m = start(true, Some((gotrue.port, postgrest.port, functions.port)), false);
    let mode = http(m.mode_port, "GET", "/_mode", &[]);
    assert_eq!(mode.status, 200);
    assert_eq!(mode.body, "maintenance");
    // the LAN listener refuses work ...
    assert_eq!(http(m.port, "POST", "/rest/v1/rpc/x", &[ORIGIN, ("Apikey", &m.anon)]).status, 503);
    // ... while the INTERNAL listener still reaches the backends exactly as in the live file
    assert_eq!(http(m.int_port, "GET", "/rest/v1/products?select=id", &[]).status, 200);
    assert_eq!(http(m.int_port, "GET", "/auth/v1/user", &[]).status, 200);
    assert!(wait_seen(&postgrest, 1)[0].starts_with("GET /products?select=id HTTP/1.1"));
    assert!(wait_seen(&gotrue, 1)[0].starts_with("GET /user HTTP/1.1"));
    assert_eq!(seen_count(&functions), 0, "the LAN refusal never reached a backend");
}

#[test]
#[ignore]
fn contract_a_the_live_file_does_not_listen_on_the_mode_port() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    assert!(TcpStream::connect(("127.0.0.1", g.mode_port)).is_err());
    assert_eq!(http(g.int_port, "GET", "/rest/v1/x", &[]).status, 200);
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan 10: the `tx=` strip (coupled with PostgREST's `db-tx-end = commit-allow-override`) and the storage routes.
// ---------------------------------------------------------------------------------------------------------------------

/// Like `http`, but with an explicit Content-Length (which may exceed the bytes actually sent) and a body.
fn http_body(port: u16, method: &str, path: &str, headers: &[(&str, &str)], declared: usize, body: &[u8]) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str(&format!("Content-Length: {declared}\r\n\r\n"));
    s.write_all(req.as_bytes()).unwrap();
    let _ = s.write_all(body); // the gateway may answer 413 and close before the body is read
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Reply { status, headers: head.to_ascii_lowercase(), body: body.to_string() }
}

/// Every `Prefer` header value in a request head an upstream recorded (any case of the name).
fn prefer_values(seen: &str) -> Vec<String> {
    seen.split("\r\n\r\n")
        .next()
        .unwrap_or("")
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("prefer").then(|| v.trim().to_string())
        })
        .collect()
}

/// The request the upstream saw after `before` earlier ones.
fn nth_seen(e: &Echo, before: usize) -> String {
    wait_seen(e, before + 1).get(before).cloned().unwrap_or_else(|| panic!("the upstream saw no request #{before}"))
}

type PreferCase = (&'static [(&'static str, &'static str)], &'static [&'static str]);

/// (the Prefer headers a till sends, the non-tx tokens that must survive)
const PREFER_CASES: &[PreferCase] = &[
    (&[("Prefer", "tx=rollback")], &[]),
    (&[("Prefer", "TX=Rollback")], &[]),
    (&[("pReFeR", "return=representation,tx=rollback")], &["return=representation"]),
    (&[("Prefer", "tx=commit")], &[]),
    (&[("Prefer", "return=minimal"), ("Prefer", "tx=rollback"), ("prefer", "count=exact, TX = Rollback")], &["return=minimal", "count=exact"]),
    (&[("Prefer", "tx=rollback,return=minimal,handling=strict")], &["return=minimal", "handling=strict"]), // the storage dry-run probe, sent by a till
    (&[("Prefer", "return=minimal;tx=rollback")], &["return=minimal"]),
    (&[("Prefer", "tx=rollback,tx=commit")], &[]),
];

fn assert_no_tx(seen: &str, keep: &[&str], what: &str) {
    let joined = prefer_values(seen).join(",").to_ascii_lowercase().replace(' ', "");
    assert!(!joined.contains("tx="), "{what}: a tx= token reached the upstream: {seen}");
    for k in keep {
        assert!(joined.contains(k), "{what}: the strip removed the unrelated token {k}: {seen}");
    }
}

#[test]
#[ignore]
fn lan_prefer_tx_token_is_stripped() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    // every LAN route that can reach PostgREST, directly or through the functions program
    let routes: [(&str, &Echo); 3] = [
        ("/rest/v1/rpc/process_direct_sale_atomic", &postgrest),
        ("/functions/v1/get-server-time", &functions),
        ("/storage/v1/object/list/product-photos", &functions),
    ];
    for (path, up) in routes {
        for (i, (prefer, keep)) in PREFER_CASES.iter().enumerate() {
            let before = seen_count(up);
            let mut headers = vec![ORIGIN, ("Apikey", g.anon.as_str())];
            headers.extend_from_slice(prefer);
            let r = http(g.port, "POST", path, &headers);
            assert_eq!(r.status, 200, "{path} case {i}: {} {}", r.headers, r.body);
            assert_no_tx(&nth_seen(up, before), keep, &format!("{path} case {i}"));
        }
    }
    // the gateway's own health route proxies to the functions program too
    let before = seen_count(&functions);
    assert_eq!(http(g.port, "GET", "/_store/health", &[("Prefer", "tx=rollback")]).status, 200);
    assert_no_tx(&nth_seen(&functions, before), &[], "/_store/health");
    // a request with no Prefer header gets none added
    let before = seen_count(&postgrest);
    let _ = http(g.port, "GET", "/rest/v1/products", &[("Apikey", &g.anon)]);
    assert!(prefer_values(&nth_seen(&postgrest, before)).is_empty());
}

#[test]
#[ignore]
fn the_internal_listener_keeps_the_tx_preference_for_the_dry_run_insert() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let r = http(g.int_port, "POST", "/rest/v1/objects", &[("Prefer", "tx=rollback,return=minimal,handling=strict")]);
    assert_eq!(r.status, 200);
    assert_eq!(prefer_values(&nth_seen(&postgrest, 0)), ["tx=rollback,return=minimal,handling=strict"]);
}

fn drop_the_tx_strip(t: String) -> String {
    assert!(t.contains("import strip_tx_preference"), "template changed; update the control");
    t.replace("import strip_tx_preference\n", "")
}

#[test]
#[ignore]
fn negative_control_without_the_strip_a_till_tx_rollback_reaches_postgrest() {
    // proves lan_prefer_tx_token_is_stripped can fail: with the import removed, the exact threat (a LAN sale POST with
    // `Prefer: tx=rollback`, which PostgREST would roll back and still answer 2xx) gets through.
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start_mutated(false, Some((gotrue.port, postgrest.port, functions.port)), false, Some(drop_the_tx_strip));
    let r = http(g.port, "POST", "/rest/v1/rpc/process_direct_sale_atomic", &[("Apikey", &g.anon), ("Prefer", "return=representation,tx=rollback")]);
    assert_eq!(r.status, 200);
    assert_eq!(prefer_values(&nth_seen(&postgrest, 0)), ["return=representation,tx=rollback"]);
}

#[test]
#[ignore]
fn signed_get_is_exempt_from_apikey() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let p = "/storage/v1/object/sign/product-photos/abc/def%20x.jpg?token=SIGNEDTOK";
    assert_eq!(http(g.port, "GET", p, &[]).status, 200, "no apikey, no Authorization: the token is the credential");
    assert!(nth_seen(&functions, 0).starts_with(&format!("GET {p} HTTP/1.1")), "{}", nth_seen(&functions, 0));
    // only GET/HEAD of /object/sign/ is exempt
    for (m, path) in [("POST", p), ("DELETE", p), ("GET", "/storage/v1/object/product-photos/abc.jpg"), ("GET", "/storage/v1/object/list/product-photos"), ("GET", "/storage/v1/bucket/product-photos")] {
        assert_eq!(http(g.port, m, path, &[]).status, 401, "{m} {path}");
    }
    assert_eq!(seen_count(&functions), 1, "an unauthenticated non-signed route reached the functions program");
    // an authenticated storage request is proxied (the 404 and the 501 for unknown routes come from the functions program)
    assert_eq!(http(g.port, "GET", "/storage/v1/object/product-photos/abc.jpg", &[("Apikey", &g.anon)]).status, 200);
    assert_eq!(seen_count(&functions), 2);
}

#[test]
#[ignore]
fn signed_path_variants_never_reach_functions_router() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let variants = [
        "/storage/v1/object/sign/product-photos/a/../b?token=x",
        "/storage/v1/object/sign/product-photos/a/./b?token=x",
        "/storage/v1/object/sign/product-photos/a/%2e%2e/b?token=x",
        "/storage/v1/object/sign/product-photos/a/%2E%2E/b?token=x",
        "/storage/v1/object/sign/product-photos/a/.%2e/b?token=x",
        "/storage/v1/object/sign//product-photos/b?token=x",
        "/storage/v1/object/sign/product-photos//b?token=x",
        "/storage/v1/object/sign/product-photos/a%2fb?token=x",
        "/storage/v1/object/sign/product-photos/a%5cb?token=x",
        "/storage/v1/object/sign/product-photos/a%5Cb?token=x",
        "/storage/v1/object/sign/product-photos/a%00b?token=x",
        "/storage/v1/object/sign/product-photos/a\\b?token=x",
        "/STORAGE/V1/OBJECT/SIGN/product-photos/b?token=x",
        "/storage/v1/object/sign/?token=x",
        "/storage/v1/object/sign/product-photos?token=x",
    ];
    for p in variants {
        let r = http(g.port, "GET", p, &[]);
        assert!(matches!(r.status, 400 | 401 | 404), "{p}: {} {}", r.status, r.body);
    }
    assert_eq!(seen_count(&functions), 0, "a path variant reached the functions program without an apikey");
    // the control: the plain form is let through
    assert_eq!(http(g.port, "GET", "/storage/v1/object/sign/product-photos/abc.jpg?token=x", &[]).status, 200);
    assert_eq!(seen_count(&functions), 1);
}

#[test]
#[ignore]
fn token_query_is_redacted_in_access_log() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let r = http(g.port, "GET", "/storage/v1/object/sign/product-photos/abc.jpg?token=SIGNEDSECRETTOKEN&apikey=QAPIKEYSECRET&access_token=ACCESSSECRET", &[]);
    assert_eq!(r.status, 200);
    let logs = wait_for_log(g.root.path(), "object/sign/product-photos/abc.jpg");
    assert!(logs.contains("object/sign/product-photos/abc.jpg"), "no access log line was written, the test proves nothing: {logs}");
    assert!(logs.contains("token=REDACTED"), "{logs}");
    for forbidden in ["SIGNEDSECRETTOKEN", "QAPIKEYSECRET", "ACCESSSECRET"] {
        assert!(!logs.contains(forbidden), "a log kept {forbidden}: {logs}");
    }
}

#[test]
#[ignore]
fn oversize_upload_is_413_at_the_gateway() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    let mp = ("Content-Type", "multipart/form-data; boundary=pos");
    let js = ("Content-Type", "application/json");
    let key = ("Apikey", g.anon.as_str());
    // an upload may carry the 2 MiB bucket limit plus the multipart envelope; one byte over the 3 MiB gateway cap is refused while the body streams (Caddy does not refuse on Content-Length alone)
    let r = http_body(g.port, "POST", "/storage/v1/object/product-photos/a.jpg", &[ORIGIN, key, mp], 3 * 1024 * 1024 + 1, &vec![b'x'; 3 * 1024 * 1024 + 1]);
    assert_eq!(r.status, 413, "{} {}", r.headers, r.body);
    assert!(r.headers.contains("access-control-allow-origin: http://tauri.localhost"), "the till must be able to read the 413: {}", r.headers);
    // JSON bodies (sign, list, delete) are capped at 1 MiB, the same as the functions program
    for p in ["/storage/v1/object/sign/product-photos", "/storage/v1/object/list/product-photos", "/storage/v1/object/product-photos"] {
        let r = http_body(g.port, "POST", p, &[key, js], 1024 * 1024 + 1, &vec![b'x'; 1024 * 1024 + 1]);
        assert_eq!(r.status, 413, "{p}: {} {}", r.headers, r.body);
    }
    // the upstream may have seen the head of an oversize request, but never a complete 200 for it: the 413 above is the gateway's answer
    // a small upload passes
    let body = vec![b'x'; 1024];
    let r = http_body(g.port, "POST", "/storage/v1/object/product-photos/a.jpg", &[key, mp], body.len(), &body);
    assert_eq!(r.status, 200, "{} {}", r.headers, r.body);
    assert_eq!(seen_count(&functions), 5, "four refused heads + the small upload");
}

#[test]
#[ignore]
fn storage_preflight_answers_x_upsert_and_cache_control() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    // what supabase-js sends before an upload from the app's WebView origin, and from the Vite dev origin
    for origin in ["http://tauri.localhost", "tauri://localhost", "http://localhost:1520"] {
        let r = http(
            g.port,
            "OPTIONS",
            "/storage/v1/object/product-photos/abc/def.jpg",
            &[("Origin", origin), ("Access-Control-Request-Method", "POST"), ("Access-Control-Request-Headers", "authorization, apikey, x-client-info, x-upsert, cache-control, content-type")],
        );
        assert_eq!(r.status, 204, "{origin}: {} {}", r.headers, r.body);
        assert!(r.headers.contains(&format!("access-control-allow-origin: {origin}")), "{origin}: {}", r.headers);
        let allow = r.headers.lines().find(|l| l.starts_with("access-control-allow-headers:")).unwrap_or_else(|| panic!("no Allow-Headers: {}", r.headers)).to_string();
        for h in ["authorization", "apikey", "x-client-info", "x-upsert", "cache-control", "content-type"] {
            assert!(allow.split([',', ':', ' ']).any(|t| t == h), "{origin}: Allow-Headers lacks {h}: {allow}");
        }
        let methods = r.headers.lines().find(|l| l.starts_with("access-control-allow-methods:")).unwrap_or_default().to_string();
        assert!(methods.contains("post") && methods.contains("delete"), "{methods}");
    }
    // a foreign origin gets no preflight approval
    let r = http(g.port, "OPTIONS", "/storage/v1/object/product-photos/abc.jpg", &[("Origin", "http://evil.example"), ("Access-Control-Request-Method", "POST")]);
    assert_eq!(r.status, 403, "{}", r.headers);
    assert!(!r.headers.contains("access-control-allow-origin"), "{}", r.headers);
    assert_eq!(seen_count(&functions), 0, "a preflight reached the functions program");
    // the real request: exactly one Allow-Origin (the functions program's own is stripped)
    let r = http(g.port, "POST", "/storage/v1/object/sign/product-photos", &[ORIGIN, ("Apikey", &g.anon), ("Content-Type", "application/json")]);
    assert_eq!(r.status, 200);
    assert_eq!(r.headers.matches("access-control-allow-origin:").count(), 1, "{}", r.headers);
    assert!(r.headers.contains("access-control-allow-origin: http://tauri.localhost"), "{}", r.headers);
}

// ---- schema profiles: `storage` is in PostgREST's db-schemas, so a till must be held to `public` -------------------------

/// Every Accept-Profile / Content-Profile value in a recorded request head.
fn profile_values(seen: &str) -> Vec<String> {
    seen.split("\r\n\r\n")
        .next()
        .unwrap_or("")
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            let k = k.trim().to_ascii_lowercase();
            (k == "accept-profile" || k == "content-profile").then(|| v.trim().to_string())
        })
        .collect()
}

/// Header sets that ask for a schema other than `public`.
const BAD_PROFILES: &[&[(&str, &str)]] = &[
    &[("Accept-Profile", "storage")],
    &[("ACCEPT-PROFILE", "storage")],
    &[("accept-profile", "Storage")],
    &[("Content-Profile", "storage")],
    &[("cOnTeNt-PrOfIlE", "storage")],
    &[("Accept-Profile", "public"), ("Accept-Profile", "storage")],
    &[("Content-Profile", "storage"), ("Content-Profile", "public")],
    &[("Accept-Profile", "public,storage")],
    &[("Accept-Profile", "  storage  ")],
    &[("Accept-Profile", "pos_lockout")],
    &[("Accept-Profile", "public"), ("Content-Profile", "storage")],
    &[("Accept-Profile", ""), ("Accept-Profile", "storage")],
];

#[test]
#[ignore]
fn lan_rest_refuses_a_non_public_profile_and_never_forwards_one() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    for (i, extra) in BAD_PROFILES.iter().enumerate() {
        for m in ["GET", "POST", "PATCH", "DELETE"] {
            let mut h = vec![ORIGIN, ("Apikey", g.anon.as_str())];
            h.extend_from_slice(extra);
            let r = http(g.port, m, "/rest/v1/objects", &h);
            assert_eq!(r.status, 403, "case {i} {m}: {} {}", r.headers, r.body);
            assert!(r.body.contains("schema not available"), "case {i} {m}: {}", r.body);
        }
    }
    assert_eq!(seen_count(&postgrest), 0, "a storage-profile request reached PostgREST from the LAN");
    // `public`, an empty value and no header all stay allowed, and whatever profile header arrives is deleted (public is the default)
    for (i, extra) in [&[("Accept-Profile", "public")][..], &[("Content-Profile", "public")], &[("accept-profile", "public"), ("Content-Profile", "public")], &[("Accept-Profile", "")], &[]].into_iter().enumerate() {
        let before = seen_count(&postgrest);
        let mut h = vec![("Apikey", g.anon.as_str())];
        h.extend_from_slice(extra);
        assert_eq!(http(g.port, "POST", "/rest/v1/products", &h).status, 200, "allowed case {i}");
        assert!(profile_values(&nth_seen(&postgrest, before)).is_empty(), "allowed case {i}: a profile header reached PostgREST");
    }
}

#[test]
#[ignore]
fn lan_functions_and_storage_never_forward_a_profile_header() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    for path in ["/functions/v1/get-server-time", "/storage/v1/object/list/product-photos", "/storage/v1/object/product-photos/a.jpg"] {
        for (i, extra) in BAD_PROFILES.iter().enumerate() {
            let before = seen_count(&functions);
            let mut h = vec![("Apikey", g.anon.as_str())];
            h.extend_from_slice(extra);
            assert_eq!(http(g.port, "POST", path, &h).status, 200, "{path} case {i}");
            assert!(profile_values(&nth_seen(&functions, before)).is_empty(), "{path} case {i}: a profile header reached the functions program");
        }
    }
    let before = seen_count(&functions);
    let _ = http(g.port, "GET", "/_store/health", &[("Accept-Profile", "storage")]);
    assert!(profile_values(&nth_seen(&functions, before)).is_empty());
    // a signed GET carries no credential but the token; a profile header on it is dropped too
    let before = seen_count(&functions);
    let _ = http(g.port, "GET", "/storage/v1/object/sign/product-photos/a.jpg?token=x", &[("Accept-Profile", "storage")]);
    assert!(profile_values(&nth_seen(&functions, before)).is_empty());
}

#[test]
#[ignore]
fn the_internal_listener_keeps_the_storage_profile() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start(false, Some((gotrue.port, postgrest.port, functions.port)), false);
    assert_eq!(http(g.int_port, "POST", "/rest/v1/objects", &[("Content-Profile", "storage"), ("Accept-Profile", "storage")]).status, 200);
    assert_eq!(profile_values(&nth_seen(&postgrest, 0)), ["storage", "storage"]);
}

fn drop_the_profile_guards(t: String) -> String {
    let matcher = "@bad_profile {\n\t\tpath /rest/v1/*\n";
    assert!(t.contains(matcher) && t.contains("import strip_profile_headers"), "template changed; update the control");
    t.replace(matcher, "@bad_profile {\n\t\tpath /nowhere/*\n").replace("import strip_profile_headers\n", "")
}

#[test]
#[ignore]
fn negative_control_without_the_guards_a_till_content_profile_storage_reaches_postgrest() {
    let (gotrue, postgrest, functions) = (echo_upstream(), echo_upstream(), echo_upstream());
    let g = start_mutated(false, Some((gotrue.port, postgrest.port, functions.port)), false, Some(drop_the_profile_guards));
    let r = http(g.port, "POST", "/rest/v1/objects", &[("Apikey", &g.anon), ("Content-Profile", "storage")]);
    assert_eq!(r.status, 200);
    assert_eq!(profile_values(&nth_seen(&postgrest, 0)), ["storage"]);
}
