//! Gateway (Caddy) configuration: validated parameters in, two config texts out. PURE: nothing here touches the disk.
//!
//! `conf::write_configs` is the only writer (ACL'd `write_protected`, fence-aware `Caddyfile.live`); it and
//! `dev render-gateway` call [`render`]. Nothing here starts or stops a process.

use std::path::{Path, PathBuf};

use crate::paths::Roots;
use crate::pki::san::{validate_site_host, SanError};
use crate::ports::Ports;

const COMMON: &str = include_str!("../../templates/common.caddy.template");
pub const GATEWAY: &str = include_str!("../../templates/Caddyfile.template");
const MAINTENANCE: &str = include_str!("../../templates/Caddyfile.maintenance.template");
/// The INTERNAL listener: appended unchanged to both the live and the maintenance file (contract A).
const INTERNAL: &str = include_str!("../../templates/internal.caddy.template");

/// Written to `conf\storage-routes.caddy` when that file is absent or older. Plan 10 owns the real content.
pub const STORAGE_ROUTES_STUB: &str = include_str!("../../pack/functions/storage-routes.caddy");
/// Comment-only; Plan 12 owns the real content. Created only when absent.
pub const REMOTE_CADDY_STUB: &str = "# remote.caddy: Plan 12 (optional cloud) fills this file. Intentionally empty.\n";

/// Largest request body the `/rest/v1` and `/functions/v1` routes accept.
pub const MAX_BODY: &str = "10MB";
/// `keepalive` of every upstream (S10 review: 10 s, not 20 s).
pub const UPSTREAM_KEEPALIVE_NANOS: u64 = 10_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// Plain HTTP. Only for a loopback instance (`dev new --tls off`, the contract fixture).
    Off,
    /// Caddy `tls internal`: the store's own certificate authority.
    Internal,
}

/// The three gateway inputs that are NOT derivable from the layout: TLS mode, the LAN bind and the site hosts. Provision
/// and `pki reissue` decide them; every other re-render (`pack activate`) reads them back from `state\gateway.json`
/// so a TLS store is never rendered back to plain HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewaySettings {
    pub tls: TlsMode,
    pub ext_bind: String,
    pub hosts: Vec<String>,
}

impl Default for GatewaySettings {
    /// Plain HTTP on loopback: what a store that has never been given TLS serves.
    fn default() -> Self {
        GatewaySettings { tls: TlsMode::Off, ext_bind: crate::render::BOOTSTRAP_LAN_BIND.into(), hosts: Vec::new() }
    }
}

impl GatewaySettings {
    /// A throwaway dev instance with `--tls internal`: loopback only, the two names a browser on this PC uses.
    pub fn dev_internal() -> Self {
        GatewaySettings { tls: TlsMode::Internal, ext_bind: crate::render::BOOTSTRAP_LAN_BIND.into(), hosts: vec!["127.0.0.1".into(), "localhost".into()] }
    }

    /// What `state\gateway.json` says; the default when the file does not exist yet AND nothing shows the store ever served
    /// TLS. A missing file with TLS evidence (a `tls internal` Caddyfile, or the store CA's root) is refused, never answered with
    /// plain loopback HTTP: that would silently cut off every till on a TLS store (`GATEWAY_STATE_MISSING`). A file that exists
    /// but cannot be understood is refused too (`GATEWAY_STATE_DAMAGED`), field by field: guessing, narrowing or defaulting a
    /// field would quietly change what the store serves. Under a dev root only a loopback bind is accepted.
    pub fn load(roots: &Roots) -> Result<Self, crate::envelope::PosctlError> {
        let path = roots.state().join("gateway.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(why) = tls_evidence(roots) {
                    return Err(crate::envelope::PosctlError::precondition(format!(
                        "GATEWAY_STATE_MISSING: {} is missing but this store serves TLS ({why}); re-rendering would switch it to plain HTTP and cut off every till. Restore the file from a backup, or rebuild it with `posctl pki reissue --server-host <the name tills use> [--server-host <another name>]`",
                        path.display()
                    )));
                }
                return Ok(Self::default());
            }
            Err(e) => return Err(crate::envelope::PosctlError::precondition(format!("GATEWAY_STATE_DAMAGED: cannot read {}: {e}; check the file's permissions, or restore it from a backup", path.display()))),
        };
        Self::parse(&text).map_err(|e| crate::envelope::PosctlError::precondition(format!("GATEWAY_STATE_DAMAGED: {}: {e}; restore the file from a backup, or rebuild it with `posctl pki reissue --server-host <the name tills use> [--server-host <another name>]`", path.display())))
    }

    /// True for the `GATEWAY_STATE_MISSING` / `GATEWAY_STATE_DAMAGED` refusals of `load` (the ones `pki reissue --server-host` repairs;
    /// an unreadable file, a permissions problem, is not repaired by rewriting it).
    pub fn is_state_error(e: &crate::envelope::PosctlError) -> bool {
        e.message.starts_with("GATEWAY_STATE_MISSING") || (e.message.starts_with("GATEWAY_STATE_DAMAGED") && !e.message.contains("cannot read"))
    }

    /// `load` for a re-render (`pack activate`, a resumed provision): under a dev root a bind other than loopback is refused,
    /// so a state file edited or copied from a real store can never open a throwaway instance to the LAN.
    pub fn load_for_rerender(roots: &Roots) -> Result<Self, crate::envelope::PosctlError> {
        let s = Self::load(roots)?;
        if roots.dev && s.ext_bind != crate::render::BOOTSTRAP_LAN_BIND {
            return Err(crate::envelope::PosctlError::precondition(format!(
                "GATEWAY_STATE_DAMAGED: {}: a dev instance may only bind 127.0.0.1, not {:?}; restore the file or run `posctl dev` to recreate the instance",
                roots.state().join("gateway.json").display(),
                s.ext_bind
            )));
        }
        Ok(s)
    }

    fn parse(text: &str) -> Result<Self, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON ({e})"))?;
        let tls = match v["tls"].as_str() {
            Some("off") => TlsMode::Off,
            Some("internal") => TlsMode::Internal,
            _ => return Err("\"tls\" must be \"off\" or \"internal\"".into()),
        };
        // a file without extBind (written before TLS existed) was always loopback; one that has the field must have it right
        let ext_bind = match v.get("extBind") {
            None => crate::render::BOOTSTRAP_LAN_BIND.to_string(),
            Some(b) => match b.as_str() {
                Some(s @ ("tcp4/0.0.0.0" | "127.0.0.1")) => s.to_string(),
                _ => return Err("\"extBind\" must be \"tcp4/0.0.0.0\" or \"127.0.0.1\"".into()),
            },
        };
        let hosts = match v.get("hosts") {
            None => Vec::new(),
            Some(h) => {
                let a = h.as_array().ok_or("\"hosts\" must be a list of names")?;
                a.iter().map(|x| x.as_str().map(String::from).ok_or("every entry of \"hosts\" must be a text")).collect::<Result<Vec<_>, _>>()?
            }
        };
        Ok(GatewaySettings { tls, ext_bind, hosts })
    }
}

/// Why a store with no `state\gateway.json` is known to have served TLS, if it is.
fn tls_evidence(roots: &Roots) -> Option<&'static str> {
    for f in [roots.caddyfile(), roots.conf().join("Caddyfile.live")] {
        if std::fs::read_to_string(&f).is_ok_and(|t| t.lines().any(|l| l.trim() == "tls internal")) {
            return Some("its Caddyfile says `tls internal`");
        }
    }
    if crate::pki::root_path(&roots.data).exists() {
        return Some("the store certificate authority's root exists");
    }
    None
}

#[derive(Debug, Clone)]
pub struct GatewayParams {
    pub tls: TlsMode,
    /// `tcp4/0.0.0.0` (the shop LAN) or `127.0.0.1` (a test instance).
    pub ext_bind: String,
    pub ext_port: u16,
    pub int_port: u16,
    /// Loopback plain-HTTP mode probe, `base+8`: only the maintenance file listens on it.
    pub mode_port: u16,
    pub gotrue_port: u16,
    pub postgrest_port: u16,
    pub functions_port: u16,
    /// Site names for `TlsMode::Internal`; each goes through `validate_site_host`.
    pub hosts: Vec<String>,
    pub anon_key: String,
    pub service_role_key: String,
    pub pki_dir: PathBuf,
    pub log_dir: PathBuf,
    pub state_dir: PathBuf,
    pub offers_dir: PathBuf,
    /// Where `storage-routes.caddy` and `remote.caddy` live (`DATA\conf`).
    pub conf_dir: PathBuf,
}

impl GatewayParams {
    /// Built from the real layout (`Roots`) and port plan (`Ports`), never from raw JSON.
    pub fn for_roots(roots: &Roots, ports: &Ports, anon_key: &str, service_role_key: &str, tls: TlsMode, ext_bind: &str, hosts: Vec<String>) -> Self {
        GatewayParams {
            tls,
            ext_bind: ext_bind.to_string(),
            ext_port: ports.gateway_lan(),
            int_port: ports.gateway_internal(),
            mode_port: ports.mode_probe(),
            gotrue_port: ports.gotrue(),
            postgrest_port: ports.rest(),
            functions_port: ports.functions(),
            hosts,
            anon_key: anon_key.to_string(),
            service_role_key: service_role_key.to_string(),
            pki_dir: roots.pki_caddy(),
            log_dir: roots.logs_for("SupermarketPOS-Gateway"),
            state_dir: roots.state(),
            offers_dir: roots.pairing_offers(),
            conf_dir: roots.conf(),
        }
    }
}

#[derive(Debug)]
pub enum GatewayError {
    Invalid(String),
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GatewayError::Invalid(m) => write!(f, "invalid gateway settings: {m}"),
        }
    }
}

impl std::error::Error for GatewayError {}

impl From<SanError> for GatewayError {
    fn from(e: SanError) -> Self {
        GatewayError::Invalid(e.to_string())
    }
}

#[derive(Debug)]
pub struct Rendered {
    pub gateway: String,
    pub maintenance: String,
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, GatewayError> {
    Err(GatewayError::Invalid(msg.into()))
}

/// A path as it goes into a Caddyfile: forward slashes, and nothing Caddy would read as syntax.
fn caddy_path(p: &Path) -> Result<String, GatewayError> {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.is_empty() || s.chars().any(|c| c.is_control() || matches!(c, '"' | '`' | '{' | '}' | '[' | ']' | '*' | '?')) || s.contains("@@") {
        return invalid(format!("path {s:?} cannot be written into a Caddyfile"));
    }
    Ok(s)
}

/// Checks a JWT-shaped key and returns its payload (middle) segment. The service-role key itself is never rendered,
/// only its payload (a public part), which the gateway matches to refuse such a bearer on the shop network.
fn jwt_payload(key: &str, what: &str) -> Result<String, GatewayError> {
    let segments: Vec<&str> = key.split('.').collect();
    let url_safe = |s: &str, min: usize| s.len() >= min && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    match segments.as_slice() {
        [h, p, s] if url_safe(h, 8) && url_safe(p, 8) && url_safe(s, 1) => Ok((*p).to_string()),
        _ => invalid(format!("{what} is not a JWT")),
    }
}

fn fill(template: &str, vars: &[(&str, String)]) -> Result<String, GatewayError> {
    let mut out = template.to_string();
    for (name, value) in vars {
        if value.contains("@@") {
            return invalid(format!("value for {name} contains a placeholder marker"));
        }
        out = out.replace(&format!("@@{name}@@"), value);
    }
    if let Some(start) = out.find("@@") {
        let tail: String = out[start..].chars().take(32).collect();
        return invalid(format!("template placeholder was not filled: {tail}"));
    }
    Ok(out)
}

pub fn render(p: &GatewayParams) -> Result<Rendered, GatewayError> {
    let ports = [p.ext_port, p.int_port, p.mode_port, p.gotrue_port, p.postgrest_port, p.functions_port];
    if ports.contains(&0) {
        return invalid("a port is 0");
    }
    let mut sorted = ports.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.len() != ports.len() {
        return invalid("two gateway ports are the same");
    }
    if !matches!(p.ext_bind.as_str(), "tcp4/0.0.0.0" | "127.0.0.1") {
        return invalid("ext_bind must be tcp4/0.0.0.0 or 127.0.0.1");
    }
    // Plain HTTP must never face the shop network: PINs and sessions would cross it in clear.
    if p.tls == TlsMode::Off && p.ext_bind != "127.0.0.1" {
        return invalid("TLS off is only allowed on 127.0.0.1");
    }

    let anon_payload = jwt_payload(&p.anon_key, "the anon key")?;
    let svc_payload = jwt_payload(&p.service_role_key, "the service-role key")?;
    if p.anon_key == p.service_role_key || anon_payload == svc_payload {
        return invalid("the anon key and the service-role key are the same");
    }

    let (addresses, tls_line) = match p.tls {
        TlsMode::Off => (format!("http://:{}", p.ext_port), String::new()),
        TlsMode::Internal => {
            if p.hosts.is_empty() {
                return invalid("TLS internal needs at least one site host");
            }
            let mut checked = Vec::new();
            for h in &p.hosts {
                checked.push(format!("https://{}:{}", validate_site_host(h)?, p.ext_port));
            }
            (checked.join(", "), "\ttls internal".to_string())
        }
    };

    let log_dir = caddy_path(&p.log_dir)?;
    let state_dir = caddy_path(&p.state_dir)?;
    let common = fill(COMMON, &[("PKI_DIR", caddy_path(&p.pki_dir)?), ("LOG_DIR", log_dir.clone())])?;
    let internal = fill(
        INTERNAL,
        &[
            ("INT_PORT", p.int_port.to_string()),
            ("LOG_DIR", log_dir.clone()),
            ("GOTRUE", p.gotrue_port.to_string()),
            ("POSTGREST", p.postgrest_port.to_string()),
            ("FUNCTIONS", p.functions_port.to_string()),
        ],
    )?;
    let gateway_body = fill(
        GATEWAY,
        &[
            ("STORAGE_ROUTES", caddy_path(&p.conf_dir.join("storage-routes.caddy"))?),
            ("REMOTE_CADDY", caddy_path(&p.conf_dir.join("remote.caddy"))?),
            ("EXT_ADDRESSES", addresses.clone()),
            ("EXT_BIND", p.ext_bind.clone()),
            ("EXT_TLS", tls_line.clone()),
            ("LOG_DIR", log_dir),
            ("ANON", p.anon_key.clone()),
            ("SVC_PAYLOAD", svc_payload),
            ("STATE_DIR", state_dir.clone()),
            ("OFFERS_DIR", caddy_path(&p.offers_dir)?),
            ("MAX_BODY", MAX_BODY.to_string()),
            ("FUNCTIONS", p.functions_port.to_string()),
            ("GOTRUE", p.gotrue_port.to_string()),
            ("POSTGREST", p.postgrest_port.to_string()),
        ],
    )?;
    let maintenance_body = fill(
        MAINTENANCE,
        &[
            ("EXT_ADDRESSES", addresses),
            ("EXT_BIND", p.ext_bind.clone()),
            ("EXT_TLS", tls_line),
            ("ANON", p.anon_key.clone()),
            ("STATE_DIR", state_dir),
            ("MODE_PORT", p.mode_port.to_string()),
        ],
    )?;
    Ok(Rendered {
        gateway: format!("{common}{gateway_body}{internal}"),
        maintenance: format!("{common}{maintenance_body}{internal}"),
    })
}

/// The first `# storage-routes-version: N` in `text` (missing or unparsable = 0).
pub fn embedded_version(text: &str) -> u32 {
    text.lines()
        .find_map(|l| l.strip_prefix("# storage-routes-version:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

/// The files the Caddyfile imports, that must exist before Caddy starts: `storage-routes.caddy` (absent, or older than the
/// embedded stub; an equal or newer one survives a re-render) and `remote.caddy` (absent only). Returned as (path, text) so
/// the one writer (`conf::write_configs`, or `dev render-gateway`) decides how to write them.
pub fn imported_files_to_write(conf_dir: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    let storage = conf_dir.join("storage-routes.caddy");
    let current = std::fs::read_to_string(&storage).ok();
    if current.as_deref().is_none_or(|c| embedded_version(STORAGE_ROUTES_STUB) > embedded_version(c)) {
        out.push((storage, STORAGE_ROUTES_STUB));
    }
    let remote = conf_dir.join("remote.caddy");
    if !remote.exists() {
        out.push((remote, REMOTE_CADDY_STUB));
    }
    out
}

/// `state\gateway.json`: the site hosts this configuration covers (read by `pki status` to report address drift).
pub fn state_json(p: &GatewayParams) -> String {
    let hosts: Vec<String> = match p.tls {
        TlsMode::Internal => p.hosts.iter().filter_map(|h| validate_site_host(h).ok()).collect(),
        TlsMode::Off => Vec::new(),
    };
    serde_json::json!({
        "schema": 1,
        "tls": if p.tls == TlsMode::Internal { "internal" } else { "off" },
        "extBind": p.ext_bind,
        "extPort": p.ext_port,
        "hosts": hosts,
        "renderedAt": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    })
    .to_string()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use base64::Engine;

    pub fn fake_jwt(role: &str) -> String {
        let b64 = |v: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.as_bytes());
        format!(
            "{}.{}.{}",
            b64(r#"{"alg":"HS256","typ":"JWT"}"#),
            b64(&format!(r#"{{"role":"{role}","iss":"supabase-offline-store"}}"#)),
            b64(&format!("signature-of-{role}"))
        )
    }

    pub fn params(root: &Path, tls: TlsMode) -> GatewayParams {
        GatewayParams {
            tls,
            ext_bind: if tls == TlsMode::Off { "127.0.0.1".into() } else { "tcp4/0.0.0.0".into() },
            ext_port: 47304,
            int_port: 47305,
            mode_port: 47308,
            gotrue_port: 47301,
            postgrest_port: 47302,
            functions_port: 47303,
            hosts: vec!["storepc".into(), "storepc.local".into(), "localhost".into(), "127.0.0.1".into(), "192.168.1.20".into()],
            anon_key: fake_jwt("anon"),
            service_role_key: fake_jwt("service_role"),
            pki_dir: root.join("pki").join("caddy"),
            log_dir: root.join("logs").join("SupermarketPOS-Gateway"),
            state_dir: root.join("state"),
            offers_dir: root.join("client").join("pairing").join("offers"),
            conf_dir: root.join("conf"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("C:\\ProgramData\\SupermarketPOS")
    }

    #[test]
    fn renders_every_placeholder_for_tls_internal() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        assert!(!r.gateway.contains("@@") && !r.maintenance.contains("@@"));
        assert!(r.gateway.contains("https://storepc:47304, https://storepc.local:47304, https://localhost:47304, https://127.0.0.1:47304, https://192.168.1.20:47304 {"));
        assert!(r.gateway.contains("bind tcp4/0.0.0.0"));
        assert!(r.gateway.contains("\ttls internal"));
        assert!(r.gateway.contains("storage file_system \"C:/ProgramData/SupermarketPOS/pki/caddy\""));
        assert!(r.gateway.contains("import \"C:/ProgramData/SupermarketPOS/conf/storage-routes.caddy\""));
        assert!(r.gateway.contains("import \"C:/ProgramData/SupermarketPOS/conf/remote.caddy\""));
        assert!(!r.maintenance.contains("remote.caddy"));
        assert!(r.gateway.contains("import storage_pre_apikey 127.0.0.1:47303") && r.gateway.contains("import storage_routes 127.0.0.1:47303"));
        assert!(r.gateway.contains("http://127.0.0.1:47305 {"));
        assert!(r.gateway.contains("reverse_proxy 127.0.0.1:47301 {"));
        assert!(r.gateway.contains("output file \"C:/ProgramData/SupermarketPOS/logs/SupermarketPOS-Gateway/caddy-external-access.log\""));
    }

    #[test]
    fn the_anon_key_is_matched_exactly_and_only_the_service_payload_is_rendered() {
        let p = params(&root(), TlsMode::Internal);
        let r = render(&p).unwrap();
        let anon = &p.anon_key;
        assert!(r.gateway.contains(&format!("{{http.request.header.Apikey}} == \"{anon}\"")));
        assert!(!r.gateway.contains(&p.service_role_key));
        let payload = p.service_role_key.split('.').nth(1).unwrap();
        assert!(r.gateway.contains(&format!(r"(?i)^bearer\s+[A-Za-z0-9_-]+\.{payload}\.")));
    }

    #[test]
    fn tls_off_is_loopback_only() {
        let mut p = params(&root(), TlsMode::Off);
        let r = render(&p).unwrap();
        assert!(r.gateway.contains("http://:47304 {"));
        assert!(!r.gateway.contains("tls internal"));
        p.ext_bind = "tcp4/0.0.0.0".into();
        let err = render(&p).unwrap_err().to_string();
        assert!(err.contains("TLS off is only allowed on 127.0.0.1"), "{err}");
    }

    #[test]
    fn refuses_hostile_input() {
        let bad = |f: &dyn Fn(&mut GatewayParams)| {
            let mut p = params(&root(), TlsMode::Internal);
            f(&mut p);
            assert!(render(&p).is_err());
        };
        bad(&|p| p.hosts.push("evil`host".into()));
        bad(&|p| p.hosts.push("*.shop".into()));
        bad(&|p| p.anon_key = "not-a-jwt".into());
        bad(&|p| p.anon_key = format!("{}\"", fake_jwt("anon")));
        bad(&|p| p.log_dir = PathBuf::from("C:\\logs\\bad\"dir"));
        bad(&|p| p.state_dir = PathBuf::from("C:\\state\\{env.SECRET}"));
        bad(&|p| p.ext_bind = "0.0.0.0".into());
        bad(&|p| p.gotrue_port = p.ext_port);
        bad(&|p| p.hosts.clear());
    }

    #[test]
    fn a_path_with_a_space_is_quoted_not_split() {
        let mut p = params(&root(), TlsMode::Internal);
        p.log_dir = PathBuf::from("D:\\tmp\\two mode\\logs");
        let r = render(&p).unwrap();
        assert!(r.gateway.contains("output file \"D:/tmp/two mode/logs/caddy-runtime.log\""));
    }

    #[test]
    fn every_reverse_proxy_in_the_templates_imports_the_keepalive_snippet() {
        let all = [GATEWAY, INTERNAL, STORAGE_ROUTES_STUB];
        for text in all {
            let mut open = 0usize;
            let mut have_import = false;
            let mut in_proxy = false;
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with("reverse_proxy ") && t.ends_with('{') {
                    in_proxy = true;
                    have_import = false;
                    open = 1;
                    continue;
                }
                if in_proxy {
                    if t == "import upstream_transport" {
                        have_import = true;
                    }
                    open += t.matches('{').count();
                    open -= t.matches('}').count();
                    if open == 0 {
                        assert!(have_import, "a reverse_proxy block lacks `import upstream_transport`");
                        in_proxy = false;
                    }
                }
            }
            assert!(!text.contains("reverse_proxy 127.0.0.1:@@FUNCTIONS@@\n"), "a bare reverse_proxy has no transport");
            assert!(!text.contains("lb_retries"), "POST must never be retried by the gateway");
        }
        assert!(COMMON.contains("keepalive 10s") && !COMMON.contains("keepalive 20s"));
    }

    #[test]
    fn every_log_output_goes_through_the_secret_filter() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        for text in [&r.gateway, &r.maintenance] {
            assert_eq!(text.matches("output file").count(), text.matches("import log_filter").count(), "a log without the filter");
        }
        assert!(COMMON.contains("request>headers>Apikey delete"));
        // ONE regexp on the uri (a second filter on the same field replaces the first): the signed-URL token parameters
        // and the pairing code in /_store/pair/<CODE> are both masked in every log
        assert!(COMMON.contains("request>uri regexp") && COMMON.contains("/_store/pair/") && COMMON.contains("access_token") && !COMMON.contains("request>uri query"));
    }

    #[test]
    fn maintenance_answers_store_updating_and_proxies_nothing() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        assert!(r.maintenance.contains("\"code\":\"STORE_UPDATING\""));
        assert!(r.maintenance.contains("Retry-After 30"));
        assert!(r.maintenance.contains("https://storepc:47304"));
        let before_internal = &r.maintenance[..r.maintenance.find("# INTERNAL listener").unwrap()];
        assert!(!before_internal.contains("reverse_proxy 127"));
    }

    #[test]
    fn contract_a_the_internal_listener_is_identical_in_both_files() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        let marker = "# INTERNAL listener";
        let live = &r.gateway[r.gateway.find(marker).unwrap()..];
        let maint = &r.maintenance[r.maintenance.find(marker).unwrap()..];
        assert_eq!(live, maint);
        assert!(live.contains("http://127.0.0.1:47305 {") && live.contains("reverse_proxy 127.0.0.1:47301"));
    }

    #[test]
    fn contract_a_only_the_maintenance_file_listens_on_the_mode_port() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        assert!(r.maintenance.contains("http://127.0.0.1:47308 {"));
        assert!(r.maintenance.contains("respond \"maintenance\" 200"));
        assert!(!r.gateway.contains("47308") && !r.gateway.contains("/_mode"));
    }

    #[test]
    fn cors_exposes_date_so_the_status_screen_can_read_the_server_clock() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        for (name, text) in [("gateway", &r.gateway), ("maintenance", &r.maintenance)] {
            let line = text.lines().find(|l| l.contains("Access-Control-Expose-Headers \"")).unwrap_or_else(|| panic!("{name}: no Expose-Headers line"));
            assert!(line.split('"').nth(1).unwrap().split(',').any(|h| h.trim() == "Date"), "{name}: {line}");
        }
    }

    #[test]
    fn contract_a_maintenance_keeps_preflight_and_status_and_503s_the_rest() {
        let r = render(&params(&root(), TlsMode::Internal)).unwrap();
        assert!(r.maintenance.contains("handle @preflight_ok") && r.maintenance.contains("@status_read"));
        assert!(r.maintenance.contains("Retry-After 30") && r.maintenance.contains("STORE_UPDATING"));
    }

    #[test]
    fn storage_stub_is_written_when_absent_or_older_and_an_equal_or_newer_file_survives() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("conf");
        std::fs::create_dir_all(&conf).unwrap();
        let names = |v: Vec<(PathBuf, &str)>| v.iter().map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>();
        assert_eq!(names(imported_files_to_write(&conf)), ["storage-routes.caddy", "remote.caddy"]);
        std::fs::write(conf.join("storage-routes.caddy"), "# storage-routes-version: 0\n# old").unwrap();
        assert!(names(imported_files_to_write(&conf)).contains(&"storage-routes.caddy".to_string()));
        std::fs::write(conf.join("storage-routes.caddy"), "no marker at all").unwrap();
        assert!(names(imported_files_to_write(&conf)).contains(&"storage-routes.caddy".to_string()));
        std::fs::write(conf.join("storage-routes.caddy"), "# storage-routes-version: 99\n# plan 10 content").unwrap();
        std::fs::write(conf.join("remote.caddy"), "# owner edit").unwrap();
        assert!(imported_files_to_write(&conf).is_empty());
        assert!(STORAGE_ROUTES_STUB.contains("(storage_routes)") && STORAGE_ROUTES_STUB.contains("(storage_pre_apikey)"));
        assert!(REMOTE_CADDY_STUB.starts_with('#'));
    }

    #[test]
    fn the_gateway_state_records_tls_port_and_validated_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let state: serde_json::Value = serde_json::from_str(&state_json(&params(dir.path(), TlsMode::Internal))).unwrap();
        assert_eq!(state["tls"], "internal");
        assert_eq!(state["extPort"], 47304);
        assert_eq!(state["hosts"].as_array().unwrap().len(), 5);
        let off: serde_json::Value = serde_json::from_str(&state_json(&params(dir.path(), TlsMode::Off))).unwrap();
        assert_eq!((off["tls"].as_str(), off["hosts"].as_array().unwrap().len()), (Some("off"), 0));
    }

    #[test]
    fn built_from_the_real_layout_and_port_plan() {
        let roots = Roots::custom(PathBuf::from("C:\\d"), PathBuf::from("C:\\p"));
        let p = GatewayParams::for_roots(&roots, &Ports { base: 47300 }, &fake_jwt("anon"), &fake_jwt("service_role"), TlsMode::Off, "127.0.0.1", vec![]);
        assert_eq!((p.gotrue_port, p.postgrest_port, p.functions_port, p.ext_port, p.int_port, p.mode_port), (47301, 47302, 47303, 47304, 47305, 47308));
        assert!(p.log_dir.ends_with("SupermarketPOS-Gateway") && p.pki_dir.ends_with("caddy") && p.offers_dir.ends_with("offers"));
        assert!(render(&p).is_ok());
    }

    // Without a usable payload segment the service-role bearer rule would silently turn off.
    #[test]
    fn a_service_role_key_without_a_usable_payload_segment_is_an_error() {
        let call = |anon: &str, svc: &str| {
            let mut p = params(&root(), TlsMode::Internal);
            p.anon_key = anon.into();
            p.service_role_key = svc.into();
            render(&p)
        };
        let anon = fake_jwt("anon");
        for bad in ["", "nodots", "a..c", "a.b", "a.b.c.d", ".b.c", "a.b c.d", "a.b%c.d", "a.b
c.d", "a.b\"c.d", "a.@@x.c", "a.b/c.d", "short.cGF5.sig", "headerxx.short.sig"] {
            assert!(call(&anon, bad).is_err(), "{bad:?}");
        }
        for bad in ["", "a b", "a
b", "a\"b", "a@@b", "x.y.z"] {
            assert!(call(bad, &fake_jwt("service_role")).is_err(), "{bad:?}");
        }
        assert!(call(&anon, "headerxx.cGF5-_AAAA.sig").is_ok());
    }

    // AppSec I1: a service-role bearer is refused before every route that can reach a backend without the apikey rule.
    #[test]
    fn the_service_role_bearer_is_refused_before_the_pre_apikey_routes() {
        let g = render(&params(&root(), TlsMode::Internal)).unwrap().gateway;
        let at = |needle: &str| g.find(needle).unwrap_or_else(|| panic!("{needle} missing"));
        let svc = at("handle @svcbearer");
        for later in ["handle @preflight_ok", "handle /_store/health", "handle @pair_offer", "import storage_pre_apikey 127", "import storage_routes 127"] {
            assert!(svc < at(later), "@svcbearer must come before {later}");
        }
    }

    /// (the `reverse_proxy ... {` line, the whole block text) of every block-form reverse_proxy in `text`.
    fn proxy_blocks(text: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut cur: Option<(String, String, i32)> = None;
        for line in text.lines() {
            let t = line.trim();
            if let Some((head, body, open)) = cur.as_mut() {
                body.push_str(t);
                body.push('\n');
                *open += t.matches('{').count() as i32 - t.matches('}').count() as i32;
                if *open == 0 {
                    out.push((head.clone(), body.clone()));
                    cur = None;
                }
            } else if t.starts_with("reverse_proxy ") && t.ends_with('{') {
                cur = Some((t.to_string(), String::new(), 1));
            }
        }
        out
    }

    // PM coupling (2026-10-31): PostgREST's `db-tx-end = commit-allow-override` is safe only while no till can send `tx=`.
    #[test]
    fn every_lan_proxy_that_can_reach_postgrest_strips_the_tx_preference() {
        // PostgREST directly, the functions program (which calls PostgREST with the caller's headers' context), and the storage snippets
        let mut checked = 0;
        for (name, text) in [("Caddyfile.template", GATEWAY), ("storage-routes.caddy", STORAGE_ROUTES_STUB)] {
            for (head, body) in proxy_blocks(text) {
                if head.contains("@@POSTGREST@@") || head.contains("@@FUNCTIONS@@") || head.contains("{args[0]}") {
                    assert!(body.contains("import strip_tx_preference"), "{name}: `{head}` can reach PostgREST on the LAN without the tx= strip");
                    assert!(body.contains("import strip_profile_headers"), "{name}: `{head}` can reach PostgREST on the LAN without the profile strip");
                    checked += 1;
                }
            }
        }
        // health, /rest, /functions, signed GET, authenticated storage: a parser that finds fewer proves nothing
        assert_eq!(checked, 5, "the LAN template or the storage snippets changed shape; update this guard deliberately");
        // the only route to PostgREST in the LAN template is the /rest/v1 handler (no second, unguarded path)
        assert_eq!(GATEWAY.matches("@@POSTGREST@@").count(), 1);
        // the three removals are present and unconditional
        let snippet = COMMON.split("(strip_tx_preference) {").nth(1).expect("snippet missing").split("\n}").next().unwrap();
        assert!(snippet.contains("header_up Prefer \"(?i)(^|[,;])\\s*tx\\s*=[^,;]*\" \"\""), "{snippet}");
        assert_eq!(snippet.matches("header_up Prefer").count(), 3);
        assert_eq!(COMMON.matches("(strip_tx_preference) {").count(), 1);
        // the maintenance file proxies nothing, so it needs no strip
        assert!(proxy_blocks(MAINTENANCE).is_empty());
    }

    #[test]
    fn the_internal_listener_keeps_tx_and_is_bound_to_loopback_only() {
        // the functions program's dry-run needs tx= through here; so this listener must never face the LAN
        let internal_proxies = proxy_blocks(INTERNAL);
        assert!(internal_proxies.iter().any(|(h, _)| h.contains("@@POSTGREST@@")), "internal /rest/v1 proxy missing");
        for (head, body) in &internal_proxies {
            assert!(!body.contains("strip_tx_preference") && !body.contains("strip_profile_headers"), "`{head}`: the internal listener must keep tx= and the storage profile (the storage dry-run and rows)");
        }
        assert!(INTERNAL.replace("\r\n", "\n").contains("http://127.0.0.1:@@INT_PORT@@ {\n\tbind 127.0.0.1\n"), "internal listener must name 127.0.0.1 and bind it");
        assert_eq!(INTERNAL.matches("bind ").count(), 1);
        assert!(!INTERNAL.contains("0.0.0.0") && !INTERNAL.contains("tcp4/"));
        // rendered: the LAN part of the file never mentions the internal port, the internal part sits on loopback
        let g = render(&params(&root(), TlsMode::Internal)).unwrap().gateway;
        let at = g.find("http://127.0.0.1:47305 {").expect("internal listener missing");
        assert!(!g[..at].contains("47305"), "the LAN listener references the internal port");
        // dev (TLS off) has two loopback ports; never the same one
        assert!(!GATEWAY.contains("@@INT_PORT@@"));
    }

    // `storage` is in PostgREST's db-schemas: the LAN may only ever reach `public`.
    #[test]
    fn the_lan_is_held_to_the_public_profile() {
        let g = GATEWAY.replace("\r\n", "\n");
        let matcher = g.split("@bad_profile {").nth(1).unwrap().split("\n\t}").next().unwrap();
        assert!(matcher.contains("path /rest/v1/*"), "{matcher}");
        for h in ["Accept-Profile", "Content-Profile"] {
            assert!(matcher.contains(&format!("{{http.request.header.{h}}} != \"\" && {{http.request.header.{h}}} != \"public\"")), "{h} not covered: {matcher}");
        }
        // refused before the proxy that would forward it
        let at = |n: &str| g.find(n).unwrap_or_else(|| panic!("{n} missing"));
        assert!(at("handle @bad_profile") < at("handle /rest/v1/*"));
        // the snippet deletes both headers; the internal listener (storage rows, Content-Profile: storage) must not
        let snippet = COMMON.split("(strip_profile_headers) {").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(snippet.contains("header_up -Accept-Profile") && snippet.contains("header_up -Content-Profile"), "{snippet}");
        assert!(!INTERNAL.contains("Profile"));
    }

    #[test]
    fn embedded_snippet_has_both_names_and_one_arg() {
        assert_eq!(embedded_version(STORAGE_ROUTES_STUB), 2);
        let tops: Vec<&str> = STORAGE_ROUTES_STUB.lines().filter(|l| l.starts_with('(')).collect();
        assert_eq!(tops, ["(storage_pre_apikey) {", "(storage_routes) {"], "exactly two top-level snippets");
        assert!(STORAGE_ROUTES_STUB.contains("{args[0]}") && !STORAGE_ROUTES_STUB.contains("{args[1]}"));
        for (head, body) in proxy_blocks(STORAGE_ROUTES_STUB) {
            assert_eq!(head, "reverse_proxy {args[0]} {");
            assert!(body.contains("import upstream_transport"));
        }
        // the signed GET is the only apikey-exempt route and it is GET/HEAD of /object/sign/ only
        let pre = STORAGE_ROUTES_STUB.split("(storage_routes) {").next().unwrap();
        assert!(pre.contains("method GET HEAD") && pre.contains("/storage/v1/object/sign/") && pre.matches("handle ").count() == 1);
        for refused in ["%2e", "%2f", "%5c", "%00", "//"] {
            assert!(pre.contains(refused), "the signed-GET matcher no longer refuses {refused}");
        }
        // slot order in the LAN file: exempt route before the apikey rules, authenticated storage after /rest
        let g = GATEWAY;
        let at = |n: &str| g.find(n).unwrap_or_else(|| panic!("{n} missing"));
        assert!(at("import storage_pre_apikey") < at("handle @noapikey"));
        assert!(at("handle /rest/v1/*") < at("import storage_routes"));
    }

    #[test]
    fn storage_body_cap_is_set_and_sized_for_a_2_mib_photo() {
        let post = STORAGE_ROUTES_STUB.split("(storage_routes) {").nth(1).unwrap();
        assert_eq!(post.matches("request_body ").count(), 2, "an upload cap and a JSON cap");
        assert_eq!(post.matches("read_timeout").count(), 0, "Caddy request_body has no read_timeout subdirective; Caddy would refuse to start");
        let mib = |label: &str| -> u64 {
            let at = post.find(label).unwrap_or_else(|| panic!("{label} missing"));
            let rest = &post[at..];
            let n = rest.split("max_size ").nth(1).unwrap().split("MiB").next().unwrap().trim();
            n.parse::<u64>().unwrap() * 1024 * 1024
        };
        let upload = mib("request_body @pos_storage_multipart");
        let json = mib("request_body @pos_storage_other");
        // above bucket limit (2 MiB) + multipart envelope (64 KiB), under the functions program's 12 MiB ceiling
        assert!(upload > 2 * 1024 * 1024 + 64 * 1024 && upload < 12 * 1024 * 1024, "{upload}");
        // the functions program caps JSON at 1 MiB; the gateway must not be looser than that
        assert!(json <= 1024 * 1024, "{json}");
        // a Content-Type the gateway cannot classify falls on the SMALL cap (fails closed)
        assert!(post.contains("@pos_storage_other not header Content-Type multipart/form-data*"));
    }

    #[test]
    fn stub_v1_on_disk_is_replaced_by_v2() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("conf");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("storage-routes.caddy"), "# storage-routes-version: 1\n(storage_routes) {\n\thandle /storage/v1/* {\n\t\trespond 501\n\t}\n}\n").unwrap();
        std::fs::write(conf.join("remote.caddy"), "# owner edit").unwrap();
        let w = imported_files_to_write(&conf);
        assert_eq!(w.len(), 1);
        assert_eq!(embedded_version(w[0].1), 2);
    }

    #[test]
    fn equal_version_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("conf");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("storage-routes.caddy"), STORAGE_ROUTES_STUB).unwrap();
        std::fs::write(conf.join("remote.caddy"), "# owner edit").unwrap();
        assert!(imported_files_to_write(&conf).is_empty());
    }

    // The GoTrue 503 mapping covers exactly 500/502/504: a 4xx from the auth service (bad token, bad grant) passes through.
    #[test]
    fn the_auth_outage_mapping_covers_only_500_502_504() {
        let g = render(&params(&root(), TlsMode::Internal)).unwrap().gateway;
        assert!(g.contains("@upstream_failed status 500 502 504
"), "status matcher changed");
        assert_eq!(g.matches("@upstream_failed status").count(), 1);
    }

    #[test]
    fn glob_characters_in_an_import_or_log_path_and_a_shared_key_are_refused() {
        for bad in ["D:/POS[1]/conf", "D:/POS]/conf", "D:/POS*/conf", "D:/POS?/conf"] {
            let mut p = params(&root(), TlsMode::Internal);
            p.conf_dir = PathBuf::from(bad);
            assert!(render(&p).is_err(), "{bad}");
            let mut p = params(&root(), TlsMode::Internal);
            p.log_dir = PathBuf::from(bad);
            assert!(render(&p).is_err(), "{bad}");
        }
        let mut p = params(&root(), TlsMode::Internal);
        p.service_role_key = p.anon_key.clone();
        assert!(render(&p).is_err(), "anon key equal to the service-role key");
        let mut p = params(&root(), TlsMode::Internal);
        p.service_role_key = format!("{}.{}.zz", "headerxx", p.anon_key.split('.').nth(1).unwrap());
        assert!(render(&p).is_err(), "same payload");
    }

    fn state_roots(d: &tempfile::TempDir, dev: bool) -> Roots {
        let mut r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        r.dev = dev;
        std::fs::create_dir_all(r.state()).unwrap();
        std::fs::create_dir_all(r.conf()).unwrap();
        r
    }
    fn write_state(r: &Roots, text: &str) {
        std::fs::write(r.state().join("gateway.json"), text).unwrap();
    }

    #[test]
    fn a_missing_state_file_is_plain_loopback_only_when_nothing_shows_tls() {
        let d = tempfile::tempdir().unwrap();
        let r = state_roots(&d, false);
        assert_eq!(GatewaySettings::load(&r).unwrap(), GatewaySettings::default());
    }

    #[test]
    fn a_missing_state_file_on_a_tls_store_is_refused_with_a_code_and_a_hint() {
        let d = tempfile::tempdir().unwrap();
        let r = state_roots(&d, false);
        std::fs::write(r.caddyfile(), "https://storepc:47304 {
	tls internal
}
").unwrap();
        let e = GatewaySettings::load(&r).unwrap_err();
        assert!(e.message.starts_with("GATEWAY_STATE_MISSING") && e.message.contains("pki reissue"), "{}", e.message);
        // the fenced live copy counts as evidence too
        let d2 = tempfile::tempdir().unwrap();
        let r2 = state_roots(&d2, false);
        std::fs::write(r2.conf().join("Caddyfile.live"), "x {
	tls internal
}
").unwrap();
        assert!(GatewaySettings::load(&r2).unwrap_err().message.starts_with("GATEWAY_STATE_MISSING"));
        // so does the store CA's root
        let d3 = tempfile::tempdir().unwrap();
        let r3 = state_roots(&d3, false);
        let root = crate::pki::root_path(&r3.data);
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::fs::write(&root, "pem").unwrap();
        assert!(GatewaySettings::load(&r3).unwrap_err().message.starts_with("GATEWAY_STATE_MISSING"));
    }

    #[test]
    fn a_state_file_with_a_malformed_field_is_refused_not_narrowed() {
        for bad in [
            r#"{"tls":"internal","extBind":7,"hosts":["a"]}"#,
            r#"{"tls":"internal","extBind":"0.0.0.0","hosts":["a"]}"#,
            r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":"storepc"}"#,
            r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["a", 5]}"#,
            r#"{"tls":"maybe"}"#,
            "not json",
        ] {
            let d = tempfile::tempdir().unwrap();
            let r = state_roots(&d, false);
            write_state(&r, bad);
            let e = GatewaySettings::load(&r).unwrap_err();
            assert!(e.message.starts_with("GATEWAY_STATE_DAMAGED") && e.message.contains("restore"), "{bad}: {}", e.message);
        }
        let d = tempfile::tempdir().unwrap();
        let r = state_roots(&d, false);
        write_state(&r, r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["storepc","127.0.0.1"]}"#);
        let g = GatewaySettings::load(&r).unwrap();
        assert_eq!((g.tls, g.ext_bind.as_str(), g.hosts.len()), (TlsMode::Internal, "tcp4/0.0.0.0", 2));
    }

    #[test]
    fn a_dev_root_refuses_a_non_loopback_bind_from_the_state_file() {
        let d = tempfile::tempdir().unwrap();
        let r = state_roots(&d, true);
        write_state(&r, r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["127.0.0.1"]}"#);
        assert!(GatewaySettings::load_for_rerender(&r).unwrap_err().message.starts_with("GATEWAY_STATE_DAMAGED"));
        write_state(&r, r#"{"tls":"internal","extBind":"127.0.0.1","hosts":["127.0.0.1"]}"#);
        assert!(GatewaySettings::load_for_rerender(&r).is_ok());
        let d2 = tempfile::tempdir().unwrap();
        let prod = state_roots(&d2, false);
        write_state(&prod, r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["127.0.0.1"]}"#);
        assert!(GatewaySettings::load_for_rerender(&prod).is_ok(), "a real store may bind the LAN");
    }
}
