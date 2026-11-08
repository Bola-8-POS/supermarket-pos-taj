//! Shared by the real-Caddy tests. Writes the rendered gateway files the way a test needs them (no ACLs: the production writer
//! is `conf::write_configs`, which these tests do not exercise).
#![allow(dead_code)]
use std::path::{Path, PathBuf};

use base64::Engine;
use posctl::gateway::{imported_files_to_write, render, GatewayParams, TlsMode};

pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
}

pub fn jwt(role: &str) -> String {
    format!("{}.{}.{}", b64(r#"{"alg":"HS256"}"#), b64(&format!(r#"{{"role":"{role}"}}"#)), b64("sig-material"))
}

pub struct Written {
    pub caddyfile: PathBuf,
    pub maintenance: PathBuf,
}

/// Renders `p`, creates the folders Caddy writes to and the imported files, and writes `Caddyfile` + `Caddyfile.maintenance`.
pub fn write_conf(p: &GatewayParams) -> Written {
    let r = render(p).expect("render");
    for d in [&p.conf_dir, &p.log_dir, &p.state_dir, &p.offers_dir, &p.pki_dir] {
        std::fs::create_dir_all(d).unwrap();
    }
    for (path, text) in imported_files_to_write(&p.conf_dir) {
        std::fs::write(path, text).unwrap();
    }
    let caddyfile = p.conf_dir.join("Caddyfile");
    let maintenance = p.conf_dir.join("Caddyfile.maintenance");
    std::fs::write(&caddyfile, r.gateway).unwrap();
    std::fs::write(&maintenance, r.maintenance).unwrap();
    Written { caddyfile, maintenance }
}

pub fn caddy() -> PathBuf {
    let pack = std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR");
    Path::new(&pack).join("bin").join("caddy.exe")
}

/// ports: ext, int, mode, gotrue, postgrest, functions
pub fn params(root: &Path, tls: TlsMode, ports: [u16; 6], hosts: Vec<String>) -> GatewayParams {
    GatewayParams {
        tls,
        ext_bind: if tls == TlsMode::Off { "127.0.0.1".into() } else { "tcp4/0.0.0.0".into() },
        ext_port: ports[0],
        int_port: ports[1],
        mode_port: ports[2],
        gotrue_port: ports[3],
        postgrest_port: ports[4],
        functions_port: ports[5],
        hosts,
        anon_key: jwt("anon"),
        service_role_key: jwt("service_role"),
        pki_dir: root.join("pki").join("caddy"),
        log_dir: root.join("logs"),
        state_dir: root.join("state"),
        offers_dir: root.join("offers"),
        conf_dir: root.join("conf"),
    }
}
