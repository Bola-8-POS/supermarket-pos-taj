//! Minimal blocking HTTP for loopback calls (health probes, GoTrue admin API, PostgREST) and a
//! tiny in-process mock server used by the tests of the modules that call it.
//! It must never talk to anything but a 127.0.0.1 URL, and never follow a redirect.

use std::time::Duration;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    pub body: String,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

/// Any HTTP status is a normal `Resp`; only transport failures are errors.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&Value>, timeout: Duration) -> Result<Resp, String> {
    // Loopback only: every caller talks to this machine's own stack. Exact prefix (a userinfo or a
    // lookalike host cannot match `127.0.0.1:` / `127.0.0.1/`), no redirects (a 3xx must not leave).
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://127.0.0.1/")) || url.contains('@') {
        return Err(format!("{method} refused: only loopback http://127.0.0.1 URLs are allowed"));
    }
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut req = agent.request(method, url).timeout(timeout);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    let result = match body {
        Some(b) => req.send_json(b.clone()),
        None => req.call(),
    };
    match result {
        Ok(r) => {
            let status = r.status();
            Ok(Resp { status, body: r.into_string().unwrap_or_default() })
        }
        Err(ureq::Error::Status(status, r)) => Ok(Resp { status, body: r.into_string().unwrap_or_default() }),
        Err(e) => Err(format!("{method} {url}: {e}")),
    }
}

pub fn get_status(url: &str, headers: &[(&str, &str)], timeout: Duration) -> Option<u16> {
    request("GET", url, headers, None, timeout).ok().map(|r| r.status)
}

#[cfg(test)]
pub mod mock {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    pub struct Req {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    pub struct Mock {
        pub port: u16,
        pub seen: Arc<Mutex<Vec<Req>>>,
    }

    impl Mock {
        pub fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
        pub fn requests(&self) -> Vec<Req> {
            self.seen.lock().unwrap().clone()
        }
    }

    pub fn start(handler: impl Fn(&Req) -> (u16, String) + Send + 'static) -> Mock {
        start_bytes(move |r| {
            let (s, b) = handler(r);
            (s, b.into_bytes())
        })
    }

    /// Serves forever on a background thread; `handler` returns `(status, body bytes)`.
    pub fn start_bytes(handler: impl Fn(&Req) -> (u16, Vec<u8>) + Send + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(i + 4);
                    }
                };
                let Some(head_end) = head_end else { continue };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or("").to_string();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let headers: Vec<(String, String)> = lines
                    .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())))
                    .collect();
                let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let req = Req { method, path, headers, body };
                seen2.lock().unwrap().push(req.clone());
                let (status, out) = handler(&req);
                // a 3xx answer carries its body as the Location header (and no body)
                let (loc, out) = if (300..400).contains(&status) { (format!("Location: {}\r\n", String::from_utf8_lossy(&out)), Vec::new()) } else { (String::new(), out) };
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{loc}Content-Length: {}\r\nConnection: close\r\n\r\n", out.len());
                let _ = s.write_all(&out);
            }
        });
        Mock { port, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_2xx_statuses_are_responses_not_errors() {
        let m = mock::start(|r| if r.path == "/ok" { (200, "{\"a\":1}".into()) } else { (503, "{\"code\":\"X\"}".into()) });
        let ok = request("GET", &format!("{}/ok", m.url()), &[], None, Duration::from_secs(5)).unwrap();
        assert_eq!((ok.status, ok.json()["a"].clone()), (200, json!(1)));
        let bad = request("POST", &format!("{}/no", m.url()), &[("apikey", "k")], Some(&json!({"x": 1})), Duration::from_secs(5)).unwrap();
        assert_eq!(bad.status, 503);
        let seen = m.requests();
        assert_eq!(seen[1].method, "POST");
        assert_eq!(seen[1].body, "{\"x\":1}");
        assert!(seen[1].headers.iter().any(|(k, v)| k == "apikey" && v == "k"));
    }

    #[test]
    fn a_closed_port_is_a_transport_error() {
        assert!(request("GET", "http://127.0.0.1:1/", &[], None, Duration::from_millis(500)).is_err());
        assert_eq!(get_status("http://127.0.0.1:1/", &[], Duration::from_millis(500)), None);
    }

    #[test]
    fn only_loopback_urls_are_ever_requested() {
        for url in ["http://example.com/", "https://127.0.0.1:1/", "http://127.0.0.1.evil.test/", "http://127.0.0.1@evil.test/", "http://localhost:1/"] {
            let e = request("GET", url, &[], None, Duration::from_millis(200)).unwrap_err();
            assert!(e.contains("loopback"), "{url}: {e}");
        }
    }

    #[test]
    fn redirects_are_not_followed() {
        let m = mock::start(|_| (302, "".into()));
        let r = request("GET", &format!("{}/x", m.url()), &[], None, Duration::from_secs(5)).unwrap();
        assert_eq!(r.status, 302);
    }
}
