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
    std::fs::write(root.path().join("state").join("status.json"), r#"{"schema":1,"state":"updating"}"#).unwrap();
    let xdg = root.path().join("xdg");
    let child = Command::new(caddy())
        .args(["run", "--adapter", "caddyfile", "--config"])
        .arg(if maintenance { &w.maintenance } else { &w.caddyfile })
        .env("XDG_DATA_HOME", &xdg)
        .env("XDG_CONFIG_HOME", &xdg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
                panic!("caddy did not listen on {port}");
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
