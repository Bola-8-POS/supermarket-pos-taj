//! `posctl pki export-root | status | verify-trust | reissue` (two-mode Plan 06 Task 7).
//!
//! `reissue` is the only command here that rewrites `conf\Caddyfile`, so it takes `update.lock` exclusive (rule H) BEFORE it
//! detects or reads anything, writes through `conf::write_configs` (the one writer: ACLs, and `Caddyfile.live` while the tills
//! are fenced), and restarts the Gateway IN THIS PROCESS (`lifecycle::restart_locked`): a child `posctl restart` would take the
//! same lock with no wait and always be refused.

use std::path::PathBuf;
use std::time::Duration;

use clap::Subcommand;
use serde_json::{json, Value};

use crate::config::{guard_no_operation, PosctlJson};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::gateway::{GatewaySettings, TlsMode};
use crate::lifecycle::{self, HealthWait};
use crate::ops::lock::{acquire_for, LockMode};
use crate::paths::Roots;
use crate::pki::trust::{CertutilStore, RootStore};
use crate::pki::{self, fingerprint16, pem_to_der, san};
use crate::render;
use crate::runtime::Runtime;
use crate::secrets;
use crate::{conf, sys};

/// Flattened into `cli::Command`, so the words are `posctl pki ...`.
#[derive(Subcommand, Debug)]
pub enum PkiTop {
    /// Store certificate authority: export the root, lifetimes, trust check, reissue after an address change.
    #[command(subcommand)]
    Pki(PkiCmd),
}

#[derive(Subcommand, Debug)]
pub enum PkiCmd {
    /// Copy the PUBLIC root certificate to client\pki\root.crt (and optionally to --out).
    ExportRoot {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Root and leaf lifetimes, the covered host names and address drift.
    Status,
    /// Is the store root in LocalMachine\Root on this PC?
    VerifyTrust,
    /// Re-detect this PC's addresses, rewrite the gateway configuration and restart the Gateway.
    Reissue {
        #[arg(long)]
        no_restart: bool,
        /// Recovery only: when state\\gateway.json is missing or damaged, rebuild it as TLS on the shop LAN from this store's recorded
        /// names plus these (repeat for each name a till may use). Refused when the file is intact.
        #[arg(long = "server-host")]
        server_host: Vec<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Drift {
    pub missing: Vec<String>,
    pub extra: Vec<String>,
}

/// `missing`: names this PC now has that the certificates do not cover. `extra`: covered names it no longer has.
pub fn drift(configured: &[String], fresh: &[String]) -> Drift {
    let missing = fresh.iter().filter(|h| !configured.contains(h)).cloned().collect();
    let extra = configured.iter().filter(|h| !fresh.contains(h)).cloned().collect();
    Drift { missing, extra }
}

fn precondition(m: impl Into<String>) -> PosctlError {
    PosctlError::new(Code::Precondition, m)
}

/// The site names this store has now: the server host RECORDED at provision (`conf\\posctl.json`, the `--server-host` or the
/// computer name provision derived), its private IPv4 addresses and the owner's extra names. Never `COMPUTERNAME` on its own:
/// a store provisioned with `--server-host tienda` would otherwise be reissued under another name and every till would fail.
fn detect_hosts_with(roots: &Roots, ips: &dyn Fn() -> std::io::Result<Vec<std::net::Ipv4Addr>>) -> Result<Vec<String>, PosctlError> {
    let cfg = PosctlJson::load(roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "conf\\posctl.json is missing"))?;
    let ips = ips().map_err(|e| precondition(format!("cannot list this PC's addresses: {e}")))?;
    san::compute_site_hosts(&cfg.server.host, &ips, &cfg.server.extra_sans).map_err(|e| precondition(e.to_string()))
}

fn detect_hosts(roots: &Roots) -> Result<Vec<String>, PosctlError> {
    detect_hosts_with(roots, &san::detect_local_ipv4s)
}

pub fn run(roots: &Roots, rt: &dyn Runtime, cmd: &PkiCmd) -> Result<Outcome, PosctlError> {
    match cmd {
        PkiCmd::ExportRoot { out } => export_root(roots, out.as_deref()),
        PkiCmd::Status => status(roots, &|| detect_hosts(roots)),
        PkiCmd::VerifyTrust => verify_trust(roots, &CertutilStore),
        PkiCmd::Reissue { no_restart, server_host } => {
            if roots.dev {
                return Err(PosctlError::new(Code::Usage, "pki reissue changes the installed gateway; it is not available under --dev"));
            }
            reissue(roots, rt, &|| detect_hosts(roots), server_host, *no_restart, Duration::from_secs(30), &lifecycle::real_wait)
        }
    }
}

fn export_root(roots: &Roots, out: Option<&std::path::Path>) -> Result<Outcome, PosctlError> {
    let info = pki::export_root(&roots.data).map_err(precondition)?;
    if let Some(out) = out {
        std::fs::write(out, &info.pem).map_err(|e| PosctlError::error(format!("{}: {e}", out.display())))?;
    }
    Ok(Outcome::ok(
        "root certificate exported",
        json!({
            "path": pki::exported_root_path(&roots.data),
            "sha256": info.sha256,
            "fingerprint": fingerprint16(&info.sha256),
            "subject": info.subject,
            "notAfterUnix": info.not_after_unix,
        }),
    ))
}

/// `fresh` is only called outside a dev root (it runs PowerShell and reads this PC's addresses).
fn status(roots: &Roots, fresh: &dyn Fn() -> Result<Vec<String>, PosctlError>) -> Result<Outcome, PosctlError> {
    let info = pki::read_root(&roots.data).map_err(precondition)?;
    let configured = GatewaySettings::load(roots)?.hosts;
    let leafs: Vec<Value> = configured.iter().map(|h| json!({ "host": h, "notAfterUnix": pki::leaf_not_after(&roots.data, h) })).collect();
    let d = if roots.dev { Drift { missing: vec![], extra: vec![] } } else { drift(&configured, &fresh()?) };
    Ok(Outcome::ok(
        "pki status",
        json!({
            "rootSha256": info.sha256,
            "fingerprint": fingerprint16(&info.sha256),
            "rootNotAfterUnix": info.not_after_unix,
            "hosts": configured,
            "leafs": leafs,
            "drift": { "missing": d.missing, "extra": d.extra },
            "driftChecked": !roots.dev,
        }),
    ))
}

fn verify_trust(roots: &Roots, store: &dyn RootStore) -> Result<Outcome, PosctlError> {
    let pem = std::fs::read_to_string(pki::exported_root_path(&roots.data)).map_err(|e| precondition(format!("client\\pki\\root.crt: {e} (run pki export-root or pair join first)")))?;
    let der = pem_to_der(&pem).map_err(PosctlError::error)?;
    let sha = pki::sha256_hex(&der);
    if roots.dev {
        return Ok(Outcome::ok("trust not checked", json!({ "trusted": null, "skipped": "dev root: the certificate store is never read", "sha256": sha })));
    }
    if !store.contains(&der, &sha).map_err(PosctlError::error)? {
        return Err(precondition("the store root certificate is not in LocalMachine\\Root on this PC"));
    }
    Ok(Outcome::ok("the store root is trusted", json!({ "trusted": true, "sha256": sha })))
}

/// Rule H: the lock comes first. `fresh_hosts` runs under it. A store that does not serve TLS is refused (turning plain HTTP into
/// TLS is provision's decision, not a certificate command's), and the LAN bind is kept as it is: a reissue never widens exposure.
/// The LAN bind a rebuilt state file gets: a real store is on the shop LAN, a dev root stays on loopback.
fn recovery_bind(dev: bool) -> &'static str {
    if dev { render::BOOTSTRAP_LAN_BIND } else { "tcp4/0.0.0.0" }
}

pub fn reissue(roots: &Roots, rt: &dyn Runtime, fresh_hosts: &dyn Fn() -> Result<Vec<String>, PosctlError>, recover: &[String], no_restart: bool, lock_wait: Duration, wait: HealthWait) -> Result<Outcome, PosctlError> {
    if !roots.dev && !sys::is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "pki reissue must run as an administrator"));
    }
    crate::layout::check_existing_data_root(roots)?;
    let op_id = crate::util::random_uuid_v4().map_err(PosctlError::error)?;
    let _lock = acquire_for(roots, LockMode::Exclusive, "reissue", &op_id, lock_wait)?;
    guard_no_operation(roots)?;
    let (ports, cfg) = lifecycle::provisioned(roots)?;
    // Recovery (`--server-host`): only for a state file that is missing (with TLS evidence) or damaged. The names are validated like
    // any site host; the bind is the store's LAN bind (a dev root stays on loopback), so recovery never widens exposure.
    let mut extra_names: Vec<String> = Vec::new();
    for n in recover {
        extra_names.push(san::validate_site_host(n).map_err(|e| PosctlError::new(Code::Usage, format!("--server-host {n:?}: {e}")))?);
    }
    let current = match GatewaySettings::load(roots) {
        Ok(c) if !recover.is_empty() => {
            if c.tls == TlsMode::Internal {
                return Err(PosctlError::new(Code::Usage, "state\\gateway.json is intact; run pki reissue without --server-host"));
            }
            c
        }
        Ok(c) => c,
        Err(e) if !recover.is_empty() && GatewaySettings::is_state_error(&e) => {
            GatewaySettings { tls: TlsMode::Internal, ext_bind: recovery_bind(roots.dev).into(), hosts: Vec::new() }
        }
        Err(e) => return Err(e),
    };
    if current.tls != TlsMode::Internal {
        return Err(precondition("this store does not serve TLS (state\\gateway.json says tls off); there is nothing to reissue"));
    }
    let mut hosts = fresh_hosts()?;
    for n in extra_names {
        if !hosts.contains(&n) {
            hosts.push(n);
        }
    }
    // a cable out, a DHCP wait or an APIPA address leaves no private IPv4: dropping every IP name would cut off each till
    // that reaches the store by address, and report success. Refuse; the operator reissues once the network is back.
    let is_lan_ip = |h: &String| h.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| !ip.is_loopback());
    if hosts.iter().all(|h| !is_lan_ip(h)) && current.hosts.iter().any(is_lan_ip) {
        let gone: Vec<&String> = current.hosts.iter().filter(|h| is_lan_ip(h)).collect();
        return Err(precondition(format!("this PC has no private IPv4 address right now, but the certificates cover {gone:?}; fix the network connection and run pki reissue again")));
    }
    let s = secrets::load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    let mut input = render::input_from(roots, ports, &cfg.server.host, &s);
    input.optional = secrets::load_optional(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    input.gateway = GatewaySettings { tls: TlsMode::Internal, ext_bind: current.ext_bind, hosts: hosts.clone() };
    let fenced = conf::write_configs(roots, rt, &input)?;
    // while fenced the maintenance file is what runs: the new live file takes effect when its owner promotes it
    let restarted = if no_restart || fenced {
        false
    } else {
        let inst = lifecycle::load_installed(roots)?;
        lifecycle::restart_locked(roots, rt, &inst, Some("Gateway"), wait)?;
        true
    };
    Ok(Outcome::ok("gateway certificates reissued", json!({ "hosts": hosts, "restarted": restarted, "liveConfigWrittenToCaddyfileLive": fenced })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl::Grant;
    use crate::ops::lock::acquire;
    use crate::pki::test_support::FIXTURE_ROOT_PEM;
    use crate::services::Component;
    use std::cell::RefCell;
    use std::path::Path;

    #[test]
    fn drift_reports_new_and_vanished_names() {
        let configured = vec!["storepc".to_string(), "192.168.1.20".to_string(), "127.0.0.1".to_string()];
        let fresh = vec!["storepc".to_string(), "192.168.1.77".to_string(), "127.0.0.1".to_string()];
        assert_eq!(drift(&configured, &fresh), Drift { missing: vec!["192.168.1.77".into()], extra: vec!["192.168.1.20".into()] });
        assert_eq!(drift(&configured, &configured), Drift { missing: vec![], extra: vec![] });
    }

    fn data_root_with_gateway() -> (tempfile::TempDir, Roots) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().join("data"), dir.path().join("prog"));
        let root = pki::root_path(&roots.data);
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::fs::write(&root, FIXTURE_ROOT_PEM).unwrap();
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(roots.state().join("gateway.json"), r#"{"schema":1,"tls":"internal","extPort":47304,"hosts":["storepc","127.0.0.1"]}"#).unwrap();
        (dir, roots)
    }

    #[derive(Default)]
    struct Fake {
        started: RefCell<Vec<Component>>,
        stopped: RefCell<Vec<Component>>,
    }
    impl Runtime for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> {
            Ok(())
        }
        fn start(&self, _: &Roots, _: &Path, c: Component) -> Result<(), String> {
            self.started.borrow_mut().push(c);
            Ok(())
        }
        fn stop(&self, c: Component) -> Result<(), String> {
            self.stopped.borrow_mut().push(c);
            Ok(())
        }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> {
            Ok(())
        }
        fn unregister(&self, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn protect_file(&self, _: &Path, _: &[Grant]) -> Result<(), String> {
            Ok(())
        }
    }

    /// A provisioned dev root whose gateway serves TLS on the LAN (a fake pack, real secrets).
    fn tls_store() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        crate::layout::create_layout(&roots, true).unwrap();
        secrets::ensure(&roots.secrets(), false).unwrap();
        let p = roots.packs().join("1.0.0-r1");
        std::fs::create_dir_all(&p).unwrap();
        crate::pack::make_fake_pack(&p, "1.0.0-r1");
        PosctlJson::new("offline-only", "id", 47300, "shop", "1.0.0-r1").save(&roots).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        std::fs::write(roots.state().join("gateway.json"), r#"{"schema":1,"tls":"internal","extBind":"tcp4/0.0.0.0","extPort":47304,"hosts":["shop","127.0.0.1"]}"#).unwrap();
        (d, roots)
    }

    fn hosts_now() -> Result<Vec<String>, PosctlError> {
        Ok(vec!["shop".into(), "127.0.0.1".into(), "192.168.1.77".into()])
    }

    fn healthy(_: Component, _: &lifecycle::Installed) -> Option<u64> {
        Some(1)
    }

    #[test]
    fn export_root_writes_the_public_certificate_and_reports_its_fingerprint() {
        let (dir, roots) = data_root_with_gateway();
        let out = dir.path().join("copy.crt");
        let o = run(&roots, &Fake::default(), &PkiCmd::ExportRoot { out: Some(out.clone()) }).unwrap();
        assert_eq!(o.data["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(o.data["fingerprint"].as_str().unwrap().len(), pki::FINGERPRINT_LEN);
        assert_eq!(std::fs::read_to_string(out).unwrap(), FIXTURE_ROOT_PEM);
        assert!(pki::exported_root_path(&roots.data).exists());
    }

    #[test]
    fn export_root_before_the_gateway_has_run_is_a_precondition_failure() {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().join("data"), dir.path().join("prog"));
        let e = run(&roots, &Fake::default(), &PkiCmd::ExportRoot { out: None }).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
    }

    #[test]
    fn status_lists_hosts_and_root_lifetime_without_probing_the_machine_under_dev() {
        let (_d, roots) = data_root_with_gateway();
        let o = run(&roots, &Fake::default(), &PkiCmd::Status).unwrap();
        assert_eq!(o.data["hosts"], json!(["storepc", "127.0.0.1"]));
        assert_eq!(o.data["driftChecked"], false);
        assert!(o.data["rootNotAfterUnix"].as_i64().unwrap() > 0);
    }

    #[test]
    fn status_off_dev_lists_missing_and_vanished_names() {
        let (_d, mut roots) = data_root_with_gateway();
        roots.dev = false;
        let o = status(&roots, &|| Ok(vec!["storepc".into(), "192.168.1.77".into()])).unwrap();
        assert_eq!(o.data["driftChecked"], true);
        assert_eq!(o.data["drift"], json!({"missing": ["192.168.1.77"], "extra": ["127.0.0.1"]}));
    }

    struct Store(Option<bool>);
    impl RootStore for Store {
        fn add_root(&self, _: &Path) -> Result<(), String> {
            panic!("store touched")
        }
        fn contains(&self, _: &[u8], _: &str) -> Result<bool, String> {
            Ok(self.0.expect("the certificate store was read under --dev"))
        }
        fn remove(&self, _: &[u8]) -> Result<(), String> {
            panic!("store touched")
        }
    }

    #[test]
    fn verify_trust_under_dev_never_reads_the_certificate_store() {
        let (_d, roots) = data_root_with_gateway();
        pki::export_root(&roots.data).unwrap();
        let o = verify_trust(&roots, &Store(None)).unwrap();
        assert!(o.data["trusted"].is_null());
        assert!(o.data["skipped"].as_str().unwrap().contains("dev"));
    }

    #[test]
    fn verify_trust_reports_an_untrusted_root_as_a_precondition_failure() {
        let (_d, mut roots) = data_root_with_gateway();
        pki::export_root(&roots.data).unwrap();
        roots.dev = false;
        assert_eq!(verify_trust(&roots, &Store(Some(false))).unwrap_err().code, Code::Precondition);
        assert_eq!(verify_trust(&roots, &Store(Some(true))).unwrap().data["trusted"], true);
    }

    #[test]
    fn reissue_is_refused_under_dev() {
        let (_d, roots) = data_root_with_gateway();
        assert_eq!(run(&roots, &Fake::default(), &PkiCmd::Reissue { no_restart: true, server_host: vec![] }).unwrap_err().code, Code::Usage);
    }

    #[test]
    fn reissue_refuses_while_another_operation_holds_update_lock_and_writes_nothing() {
        let (_d, roots) = tls_store();
        let _held = acquire(&roots.update_dir(), LockMode::Exclusive, "update", "op-1", Duration::from_secs(0)).unwrap();
        let e = reissue(&roots, &Fake::default(), &hosts_now, &[], true, Duration::from_millis(0), &healthy).unwrap_err();
        assert_eq!(e.code, Code::LockHeld);
        assert!(!roots.caddyfile().exists(), "no gateway config is written without the lock");
    }

    #[test]
    fn reissue_takes_the_lock_exclusive_while_it_works() {
        let (_d, roots) = tls_store();
        let seen = RefCell::new(None);
        let probe = |_: Component, _: &lifecycle::Installed| {
            // the lock is held while the Gateway restarts: nobody else can take it
            *seen.borrow_mut() = Some(acquire(&roots.update_dir(), LockMode::Shared, "probe", "p", Duration::from_secs(0)).is_err());
            Some(1)
        };
        reissue(&roots, &Fake::default(), &hosts_now, &[], false, Duration::from_secs(1), &probe).unwrap();
        assert_eq!(*seen.borrow(), Some(true));
    }

    #[test]
    fn reissue_rewrites_the_hosts_keeps_the_bind_and_restarts_only_the_gateway_in_process() {
        let (_d, roots) = tls_store();
        let rt = Fake::default();
        let o = reissue(&roots, &rt, &hosts_now, &[], false, Duration::from_secs(1), &healthy).unwrap();
        assert_eq!(o.data["restarted"], true);
        let gw = std::fs::read_to_string(roots.state().join("gateway.json")).unwrap();
        assert!(gw.contains("192.168.1.77") && gw.contains("tcp4/0.0.0.0"));
        assert!(std::fs::read_to_string(roots.caddyfile()).unwrap().contains("192.168.1.77"));
        assert_eq!(rt.started.borrow().as_slice(), &[Component::Gateway]);
        assert!(!rt.stopped.borrow().contains(&Component::Postgres));
    }

    #[test]
    fn reissue_while_fenced_writes_caddyfile_live_and_leaves_the_maintenance_file_running() {
        let (_d, roots) = tls_store();
        std::fs::write(roots.caddyfile(), "# maintenance config running\n").unwrap();
        std::fs::write(conf::caddyfile_live_copy(&roots), "# old live\n").unwrap();
        let rt = Fake::default();
        let o = reissue(&roots, &rt, &hosts_now, &[], false, Duration::from_secs(1), &healthy).unwrap();
        assert_eq!(o.data["liveConfigWrittenToCaddyfileLive"], true);
        assert_eq!(o.data["restarted"], false);
        assert_eq!(std::fs::read_to_string(roots.caddyfile()).unwrap(), "# maintenance config running\n");
        assert!(std::fs::read_to_string(conf::caddyfile_live_copy(&roots)).unwrap().contains("192.168.1.77"));
        assert!(rt.started.borrow().is_empty());
    }

    #[test]
    fn reissue_refuses_when_the_pc_lost_its_lan_address_instead_of_dropping_every_ip_name() {
        let (_d, roots) = tls_store();
        std::fs::write(roots.state().join("gateway.json"), r#"{"schema":1,"tls":"internal","extBind":"tcp4/0.0.0.0","extPort":47304,"hosts":["shop","127.0.0.1","192.168.1.20"]}"#).unwrap();
        let before = std::fs::read_to_string(roots.state().join("gateway.json")).unwrap();
        let no_lan = || Ok(vec!["shop".to_string(), "127.0.0.1".to_string()]);
        let rt = Fake::default();
        let e = reissue(&roots, &rt, &no_lan, &[], true, Duration::from_secs(0), &healthy).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("192.168.1.20"), "{}", e.message);
        assert_eq!(std::fs::read_to_string(roots.state().join("gateway.json")).unwrap(), before);
        // a store that never had a LAN address (a name-only store) is not blocked
        std::fs::write(roots.state().join("gateway.json"), r#"{"schema":1,"tls":"internal","extBind":"tcp4/0.0.0.0","extPort":47304,"hosts":["shop","127.0.0.1"]}"#).unwrap();
        assert!(reissue(&roots, &rt, &no_lan, &[], true, Duration::from_secs(0), &healthy).is_ok());
    }

    #[test]
    fn reissue_refuses_a_store_that_does_not_serve_tls() {
        let (_d, roots) = tls_store();
        std::fs::write(roots.state().join("gateway.json"), r#"{"schema":1,"tls":"off","extPort":47304,"hosts":[]}"#).unwrap();
        assert_eq!(reissue(&roots, &Fake::default(), &hosts_now, &[], true, Duration::from_secs(0), &healthy).unwrap_err().code, Code::Precondition);
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recovery_rebuilds_a_missing_state_file_from_the_given_names_and_keeps_the_ca() {
        let (_d, roots) = tls_store();
        let root = pki::root_path(&roots.data);
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::fs::write(&root, FIXTURE_ROOT_PEM).unwrap(); // TLS evidence: the CA root exists
        std::fs::remove_file(roots.state().join("gateway.json")).unwrap();
        let rt = Fake::default();
        let o = reissue(&roots, &rt, &hosts_now, &names(&["Tienda", "caja1"]), true, Duration::from_secs(0), &healthy).unwrap();
        let g = GatewaySettings::load(&roots).unwrap();
        assert_eq!((g.tls, g.ext_bind.as_str()), (TlsMode::Internal, "127.0.0.1"), "a dev root stays on loopback");
        assert_eq!((recovery_bind(true), recovery_bind(false)), ("127.0.0.1", "tcp4/0.0.0.0"));
        for h in ["tienda", "caja1", "shop", "192.168.1.77"] {
            assert!(g.hosts.iter().any(|x| x == h), "{h} in {:?}", g.hosts);
        }
        assert!(o.data["hosts"].as_array().unwrap().len() >= 4);
        assert_eq!(std::fs::read_to_string(&root).unwrap(), FIXTURE_ROOT_PEM, "the CA is not touched");
    }

    #[test]
    fn recovery_also_repairs_a_damaged_state_file() {
        let (_d, roots) = tls_store();
        std::fs::write(roots.state().join("gateway.json"), r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":"shop"}"#).unwrap();
        reissue(&roots, &Fake::default(), &hosts_now, &names(&["shop"]), true, Duration::from_secs(0), &healthy).unwrap();
        assert!(GatewaySettings::load(&roots).is_ok());
    }

    #[test]
    fn without_names_a_missing_state_is_refused_and_the_hint_names_the_exact_recovery_command() {
        let (_d, roots) = tls_store();
        let root = pki::root_path(&roots.data);
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::fs::write(&root, FIXTURE_ROOT_PEM).unwrap();
        std::fs::remove_file(roots.state().join("gateway.json")).unwrap();
        let e = reissue(&roots, &Fake::default(), &hosts_now, &[], true, Duration::from_secs(0), &healthy).unwrap_err();
        assert!(e.message.starts_with("GATEWAY_STATE_MISSING") && e.message.contains("posctl pki reissue --server-host"), "{}", e.message);
        assert!(!roots.state().join("gateway.json").exists());
    }

    #[test]
    fn recovery_refuses_an_invalid_name_and_a_state_that_is_intact_and_writes_nothing() {
        let (_d, roots) = tls_store();
        std::fs::write(roots.state().join("gateway.json"), "{broken").unwrap();
        let e = reissue(&roots, &Fake::default(), &hosts_now, &names(&["8.8.8.8"]), true, Duration::from_secs(0), &healthy).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert_eq!(std::fs::read_to_string(roots.state().join("gateway.json")).unwrap(), "{broken");
        let (_d2, roots2) = tls_store();
        let before = std::fs::read_to_string(roots2.state().join("gateway.json")).unwrap();
        let e = reissue(&roots2, &Fake::default(), &hosts_now, &names(&["shop"]), true, Duration::from_secs(0), &healthy).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert_eq!(std::fs::read_to_string(roots2.state().join("gateway.json")).unwrap(), before);
    }

    #[test]
    fn the_names_come_from_the_recorded_server_host_never_from_the_computer_name() {
        let (_d, roots) = tls_store();
        let mut cfg = PosctlJson::load(&roots).unwrap().unwrap();
        cfg.server.host = "tienda".into();
        cfg.server.extra_sans = vec!["caja1".into()];
        cfg.save(&roots).unwrap();
        let ips = || Ok(vec!["192.168.1.20".parse().unwrap()]);
        let hosts = detect_hosts_with(&roots, &ips).unwrap();
        assert_eq!(hosts, ["tienda", "tienda.local", "localhost", "127.0.0.1", "192.168.1.20", "caja1"]);
    }
}
