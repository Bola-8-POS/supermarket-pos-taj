//! Needs a real Caddy: `POS_PACK_DIR=<unpacked pack> cargo test --test gateway_adapt -- --ignored`
//! `caddy adapt` only: no process is started, nothing listens.
mod common;

use std::path::Path;
use std::process::Command;

use common::{caddy, params, write_conf};
use posctl::gateway::{TlsMode, UPSTREAM_KEEPALIVE_NANOS};
use serde_json::Value;

fn adapt(file: &Path) -> Value {
    let out = Command::new(caddy()).args(["adapt", "--adapter", "caddyfile", "--config"]).arg(file).output().expect("run caddy adapt");
    assert!(out.status.success(), "caddy adapt failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("adapt json")
}

/// `v2.11.7 h1:...` -> (2, 11, 7)
fn caddy_version() -> (u32, u32, u32) {
    let out = Command::new(caddy()).arg("version").output().expect("run caddy version");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let v: Vec<u32> = text.trim_start_matches('v').split_whitespace().next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect();
    (v[0], v[1], v[2])
}

#[test]
#[ignore = "needs POS_PACK_DIR"]
fn the_pack_carries_a_caddy_without_the_2_11_6_http2_crash() {
    assert!(caddy_version() >= (2, 11, 7), "caddy {:?} in the pack: 2.11.6 panics over HTTP/2 (caddy#8101), pin >= 2.11.7", caddy_version());
}

fn walk<'a>(v: &'a Value, f: &mut dyn FnMut(&'a Value)) {
    f(v);
    match v {
        Value::Array(a) => a.iter().for_each(|x| walk(x, f)),
        Value::Object(o) => o.values().for_each(|x| walk(x, f)),
        _ => {}
    }
}

const HOSTS: [&str; 4] = ["storepc", "storepc.local", "localhost", "192.168.1.20"];

fn rendered(tls: TlsMode) -> (tempfile::TempDir, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let hosts = if tls == TlsMode::Off { vec![] } else { HOSTS.iter().map(|s| s.to_string()).collect() };
    let p = params(dir.path(), tls, [47304, 47305, 47308, 47301, 47302, 47303], hosts);
    let w = write_conf(&p);
    let g = adapt(&w.caddyfile);
    let m = adapt(&w.maintenance);
    (dir, g, m)
}

fn listens(v: &Value) -> Vec<String> {
    v.pointer("/apps/http/servers")
        .unwrap()
        .as_object()
        .unwrap()
        .values()
        .flat_map(|s| s["listen"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()))
        .collect()
}

#[test]
#[ignore]
fn every_reverse_proxy_has_a_10_second_keepalive_and_no_retries() {
    for tls in [TlsMode::Internal, TlsMode::Off] {
        let (_d, g, m) = rendered(tls);
        for (which, doc, expect) in [("live", g, 7), ("maintenance", m, 3)] {
            let mut proxies = 0;
            walk(&doc, &mut |n| {
                if n.get("handler").and_then(Value::as_str) == Some("reverse_proxy") {
                    proxies += 1;
                    let idle = n.pointer("/transport/keep_alive/idle_timeout").and_then(Value::as_u64);
                    assert_eq!(idle, Some(UPSTREAM_KEEPALIVE_NANOS), "{which}: proxy without keepalive 10s: {n}");
                    assert!(n.get("load_balancing").and_then(|l| l.get("retries")).is_none(), "{which}: retries set: {n}");
                }
            });
            assert_eq!(proxies, expect, "{which}: live = 4 LAN + 3 INTERNAL; maintenance = the 3 INTERNAL only");
        }
    }
}

#[test]
#[ignore]
fn listeners_tls_and_logging_are_as_designed() {
    let (_d, g, m) = rendered(TlsMode::Internal);
    let servers = g.pointer("/apps/http/servers").unwrap().as_object().unwrap();
    let l = listens(&g);
    assert!(l.contains(&"tcp4/0.0.0.0:47304".to_string()), "{l:?}");
    assert!(l.contains(&"127.0.0.1:47305".to_string()), "{l:?}");
    assert!(l.iter().all(|x| x != "0.0.0.0:47304" && !x.starts_with(':')), "{l:?}");
    for s in servers.values() {
        assert_eq!(s["protocols"], serde_json::json!(["h1", "h2"]));
        assert_eq!(s["read_header_timeout"], 15_000_000_000u64);
        assert_eq!(s["idle_timeout"], 600_000_000_000u64);
        // Caddy 2.11.6 shipped default 1-minute idle read/write deadlines that panic over HTTP/2 (caddy#8101). 2.11.7 fixed that, and
        // the pack must carry it; the template must not switch the deadlines off again (a negative value disables them: slow-body
        // and slow-read clients could then pin upstream connections for ever). Absent (the default) or a positive value only.
        for key in ["read_idle_timeout", "write_idle_timeout"] {
            if let Some(v) = s.get(key) {
                assert!(v.as_i64().unwrap_or(-1) > 0, "the gateway template disables {key} ({v}): remove the caddy#8101 workaround");
            }
        }
        assert_eq!(s["automatic_https"]["disable_redirects"], true);
    }
    let subjects = g.pointer("/apps/tls/automation/policies/0/subjects").unwrap();
    let mut got: Vec<String> = subjects.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    got.sort();
    let mut want: Vec<String> = HOSTS.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(got, want);
    assert_eq!(g.pointer("/apps/tls/automation/policies/0/issuers/0/module").unwrap(), "internal");
    assert_eq!(g.pointer("/apps/pki/certificate_authorities/local/install_trust").unwrap(), false, "never the host certificate store");
    assert_eq!(g.pointer("/admin/disabled").unwrap(), true);
    assert_eq!(g.pointer("/storage/module").unwrap(), "file_system");
    // every logger removes the same secrets
    let logs = g.pointer("/logging/logs").unwrap().as_object().unwrap();
    assert_eq!(logs.len(), 3, "default (runtime) + external access + internal access");
    for (name, lg) in logs {
        for h in ["Apikey", "Authorization", "Cookie"] {
            assert_eq!(lg.pointer(&format!("/encoder/fields/request>headers>{h}/filter")).unwrap(), "delete", "{name} keeps {h}");
        }
        // one regexp on the uri (a second filter on the same field replaces the first): signed-URL token parameters + the pairing code
        let uri = lg.pointer("/encoder/fields/request>uri").unwrap();
        assert_eq!(uri["filter"], "regexp", "{name}");
        let re = regex_lite_check(uri["regexp"].as_str().unwrap());
        assert!(re, "{name}: {uri}");
    }
    // the maintenance responder: the same LAN and INTERNAL listeners, plus the mode probe the live file lacks (contract A)
    let ml = listens(&m);
    assert!(ml.contains(&"127.0.0.1:47308".to_string()), "mode probe: {ml:?}");
    assert!(ml.contains(&"127.0.0.1:47305".to_string()) && ml.contains(&"tcp4/0.0.0.0:47304".to_string()), "{ml:?}");
    assert!(!l.contains(&"127.0.0.1:47308".to_string()), "the live file must not listen on the mode port");
    // the same certificate policy and storage, so a till's trust does not change
    assert_eq!(m.pointer("/storage/module").unwrap(), "file_system");
    assert_eq!(m.pointer("/apps/tls/automation/policies/0/issuers/0/module").unwrap(), "internal");
}

#[test]
#[ignore]
fn tls_off_has_no_tls_automation() {
    let (_d, g, _m) = rendered(TlsMode::Off);
    assert!(g.pointer("/apps/tls").is_none());
    let l = serde_json::to_string(g.pointer("/apps/http/servers").unwrap()).unwrap();
    assert!(l.contains("127.0.0.1:47304") && !l.contains("0.0.0.0"), "{l}");
}

/// The pattern names the pairing path and the three secret query parameters, and the replacement keeps both groups.
fn regex_lite_check(p: &str) -> bool {
    ["/_store/pair/", "[A-Z2-7]{8}", "token", "apikey", "access_token"].iter().all(|s| p.contains(s))
}
