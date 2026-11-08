//! Loopback plain-HTTP probes for the verification behind the fence. The INTERNAL and component ports are plain
//! HTTP on 127.0.0.1, so there is no TLS client here (the gateway's TLS is Plan 06's). Built on `crate::http`, which
//! refuses any non-loopback URL and any redirect; every call carries a timeout.
use crate::ops::outcome::OpError;
use crate::ops::world::R;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn tcp_open(addr: &str, timeout: Duration) -> bool {
    addr.to_socket_addrs().ok().and_then(|mut a| a.next()).map(|a| TcpStream::connect_timeout(&a, timeout).is_ok()).unwrap_or(false)
}

/// `addr` is `127.0.0.1:<port>`. Any HTTP status is a normal answer; only transport failures are errors.
pub fn http_get(addr: &str, path: &str, headers: &[(&str, &str)], timeout: Duration) -> R<(u16, String)> {
    crate::http::request("GET", &format!("http://{addr}{path}"), headers, None, timeout)
        .map(|r| (r.status, r.body))
        .map_err(|e| OpError::err("PROBE_IO", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock;
    use std::time::Duration;

    #[test]
    fn status_and_body_come_back_for_a_503() {
        let m = mock::start(|_| (503, "hello".to_string()));
        let r = http_get(&format!("127.0.0.1:{}", m.port), "/x", &[("X-A", "b")], Duration::from_secs(2)).unwrap();
        assert_eq!(r, (503, "hello".to_string()));
    }

    #[test]
    fn only_loopback_plain_http_is_ever_dialled() {
        for addr in ["10.0.0.5:80", "example.com:80", "127.0.0.1@evil:80"] {
            let e = http_get(addr, "/", &[], Duration::from_millis(300)).unwrap_err();
            assert_eq!(e.reason, "PROBE_IO", "{addr}");
        }
    }

    #[test]
    fn a_closed_port_is_an_error_not_a_hang() {
        let t = std::time::Instant::now();
        assert!(http_get("127.0.0.1:1", "/", &[], Duration::from_millis(500)).is_err());
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_closed_port_is_not_open() { assert!(!tcp_open("127.0.0.1:1", Duration::from_millis(300))); }

    #[test]
    fn an_open_port_is_open() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(tcp_open(&l.local_addr().unwrap().to_string(), Duration::from_secs(1)));
    }
}
