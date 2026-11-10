//! Writing the config files the components read, and re-pointing the services at a pack
//! (`pack activate`, conventions 17.D). Every writer of `conf\Caddyfile` takes `update.lock`
//! exclusive (rule H): `write_configs` and `activate` assume the CALLER holds it (an update holds
//! it already); the CLI wrapper `activate_locked` takes it. It must never render a secret into an
//! error message, and never touch `conf\Caddyfile` while the tills are fenced.

use std::time::Duration;

use serde_json::json;

use crate::acl;
use crate::config::PosctlJson;
use crate::envelope::{Code, Outcome, PosctlError};
use crate::gateway::{self, GatewayParams};
use crate::layout::write_protected;
use crate::ops::lock::{acquire_for, LockMode};
use crate::pack;
use crate::paths::Roots;
use crate::ports::Ports;
use crate::render::{self, RenderInput};
use crate::runtime::Runtime;
use crate::secrets;
use crate::services::Component;
use crate::util::random_uuid_v4;

/// The LAN listener stays on loopback until Plan 06 ships TLS. Defined once, in `render`.
pub use crate::render::BOOTSTRAP_LAN_BIND;
/// Plan 12 (C-12g): defined beside the other binPath builders in `services`; re-exported, never redefined.
pub use crate::services::repoint_bin_path;

pub fn caddyfile_live_copy(roots: &Roots) -> std::path::PathBuf {
    roots.conf().join("Caddyfile.live")
}
pub fn caddyfile_maintenance(roots: &Roots) -> std::path::PathBuf {
    roots.conf().join("Caddyfile.maintenance")
}

/// THE gateway renderer seam: `(live, maintenance)` config text from `gateway::render`. `write_configs` is the only writer and
/// `dev render-gateway` calls this too; nothing else in posctl renders a Caddyfile. Until Plan 06's provision wiring (Task 5)
/// TLS mode, bind and hosts come from `RenderInput.gateway`.
pub fn render_gateway_files(p: &GatewayParams) -> Result<(String, String), String> {
    let r = gateway::render(p).map_err(|e| e.to_string())?;
    Ok((r.gateway, r.maintenance))
}

/// gotrue.env, postgrest.conf, the live gateway config and the maintenance gateway config.
/// While the tills are fenced (`Caddyfile.live` exists) `Caddyfile` holds the maintenance config and
/// must not be touched: the live config is rendered into `Caddyfile.live` instead.
pub fn write_configs(roots: &Roots, rt: &dyn Runtime, input: &RenderInput) -> Result<bool, PosctlError> {
    write_protected(roots, rt, &roots.gotrue_env(), &render::gotrue_env(input).map_err(PosctlError::error)?, &acl::gotrue_env_grants())?;
    write_protected(roots, rt, &roots.postgrest_conf(), &render::postgrest_conf(input), &acl::postgrest_conf_grants())?;
    let gw = GatewayParams::for_roots(roots, &input.ports, input.anon_key.expose(), input.service_role_key.expose(), input.gateway.tls, &input.gateway.ext_bind, input.gateway.hosts.clone());
    let (live, maintenance) = render_gateway_files(&gw).map_err(PosctlError::error)?;
    // the files the Caddyfile imports must exist before Caddy starts (the Gateway account reads them, nobody else)
    for (path, text) in gateway::imported_files_to_write(&roots.conf()) {
        write_protected(roots, rt, &path, text, &acl::caddy_file_grants())?;
    }
    write_protected(roots, rt, &roots.state().join("gateway.json"), &gateway::state_json(&gw), &acl::caddy_file_grants())?;
    let fenced = caddyfile_live_copy(roots).exists();
    let live_target = if fenced { caddyfile_live_copy(roots) } else { roots.caddyfile() };
    write_protected(roots, rt, &live_target, &live, &acl::caddy_file_grants())?;
    write_protected(roots, rt, &caddyfile_maintenance(roots), &maintenance, &acl::caddy_file_grants())?;
    Ok(fenced)
}

/// `pack activate --version <v> [--set-current]` (hidden). The caller holds `update.lock`.
pub fn activate(roots: &Roots, rt: &dyn Runtime, version: &str, set_current: bool) -> Result<Outcome, PosctlError> {
    let mut cfg = PosctlJson::load(roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
    let dir = roots.pack_dir(version).map_err(|e| PosctlError::new(Code::PackInvalid, e))?;
    let target = pack::load(&dir).map_err(|e| PosctlError::new(Code::PackInvalid, format!("pack {version}: {e}")))?;
    if target.manifest.pack_version != version {
        return Err(PosctlError::new(Code::PackInvalid, format!("the folder for {version} holds pack {}", target.manifest.pack_version)));
    }
    let ports = Ports::new(cfg.ports.base).map_err(PosctlError::error)?;
    let s = secrets::load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    let mut input = render::input_from(roots, ports, &cfg.server.host, &s);
    input.optional = secrets::load_optional(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?; // owner-set Functions secrets survive an activation
    input.gateway = gateway::GatewaySettings::load_for_rerender(roots)?; // never re-detected: a TLS store stays TLS
    let fenced = write_configs(roots, rt, &input)?;
    for c in Component::ALL {
        rt.prepare(roots, &target.dir, c).map_err(PosctlError::error)?;
    }
    rt.set_functions_env(roots, &render::functions_env(&input).map_err(PosctlError::error)?).map_err(PosctlError::error)?;
    // review fix (Plan 12, C-12g): optional services that live outside `Component::ALL` (the Tunnel) are re-pointed too
    let repointed = rt.repoint_optional(roots, &target.dir, version).map_err(PosctlError::error)?;
    let mut changed_current = false;
    if set_current && cfg.pack.current != version {
        cfg.pack.previous = Some(cfg.pack.current.clone());
        cfg.pack.current = version.to_string();
        cfg.save(roots)?;
        changed_current = true;
    }
    Ok(Outcome::ok("pack activated", json!({"packVersion": version, "liveConfigWrittenToCaddyfileLive": fenced, "currentChanged": changed_current, "current": cfg.pack.current, "previous": cfg.pack.previous, "repointedOptional": repointed})))
}

pub fn activate_locked(roots: &Roots, rt: &dyn Runtime, version: &str, set_current: bool) -> Result<Outcome, PosctlError> {
    // handle-based trust check of the data root BEFORE the lock is taken (and before any ACL or config write)
    crate::layout::check_existing_data_root(roots)?;
    let _lock = acquire_for(roots, LockMode::Exclusive, "pack-activate", &random_uuid_v4().map_err(PosctlError::error)?, Duration::from_secs(0))?;
    activate(roots, rt, version, set_current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::lock::acquire;
    use crate::acl::Grant;
    use std::cell::RefCell;
    use std::path::Path;

    #[derive(Default)]
    struct Fake {
        prepared: RefCell<Vec<(Component, std::path::PathBuf)>>,
        functions_env: RefCell<Vec<String>>,
        protected: RefCell<Vec<(std::path::PathBuf, Vec<String>)>>,
        repointed: RefCell<Vec<String>>,
        tunnel_registered: bool,
        fail_prepare: bool,
    }
    impl Runtime for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn prepare(&self, _: &Roots, p: &Path, c: Component) -> Result<(), String> {
            if self.fail_prepare {
                return Err("sc config failed".into());
            }
            self.prepared.borrow_mut().push((c, p.to_path_buf()));
            Ok(())
        }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> {
            Ok(())
        }
        fn start(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn stop(&self, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn set_functions_env(&self, _: &Roots, e: &[String]) -> Result<(), String> {
            *self.functions_env.borrow_mut() = e.to_vec();
            Ok(())
        }
        fn unregister(&self, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn protect_file(&self, p: &Path, g: &[Grant]) -> Result<(), String> {
            self.protected.borrow_mut().push((p.to_path_buf(), g.iter().map(|x| x.sid.clone()).collect()));
            Ok(())
        }
        fn repoint_optional(&self, _: &Roots, _: &Path, version: &str) -> Result<Vec<String>, String> {
            if self.tunnel_registered {
                self.repointed.borrow_mut().push(version.to_string());
                Ok(vec!["SupermarketPOS-Tunnel".into()])
            } else {
                Ok(vec![])
            }
        }
    }

    fn provisioned() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        crate::layout::create_layout(&roots, true).unwrap();
        secrets::ensure(&roots.secrets(), false).unwrap();
        for v in ["1.0.0-r1", "1.1.0-r1"] {
            let p = roots.packs().join(v);
            std::fs::create_dir_all(&p).unwrap();
            pack::make_fake_pack(&p, v);
        }
        PosctlJson::new("offline-only", "id", 47300, "shop", "1.0.0-r1").save(&roots).unwrap();
        (d, roots)
    }

    #[test]
    fn write_configs_writes_all_four_files_and_protects_them() {
        let (_d, mut roots) = provisioned();
        roots.dev = false; // on a dev root `protect_file` is never called, so the readers would not be asserted
        let s = secrets::load(&roots.secrets()).unwrap();
        let input = render::input_from(&roots, Ports { base: 47300 }, "shop", &s);
        let rt = Fake::default();
        assert!(!write_configs(&roots, &rt, &input).unwrap());
        let prot = rt.protected.borrow().clone();
        let readers = |p: &std::path::Path| prot.iter().find(|(f, _)| f == p).map(|(_, g)| g.clone()).unwrap_or_else(|| panic!("{} was not protected", p.display()));
        assert_eq!(readers(&roots.gotrue_env())[2], Component::Auth.sid());
        assert_eq!(readers(&roots.postgrest_conf())[2], Component::Rest.sid());
        assert_eq!(readers(&roots.caddyfile())[2], Component::Gateway.sid());
        assert_eq!(readers(&caddyfile_maintenance(&roots))[2], Component::Gateway.sid());
        for p in [roots.gotrue_env(), roots.postgrest_conf(), roots.caddyfile(), caddyfile_maintenance(&roots)] {
            assert!(p.is_file(), "{}", p.display());
        }
        assert!(render::gotrue_hook_env_ok(&std::fs::read_to_string(roots.gotrue_env()).unwrap()));
        let live = std::fs::read_to_string(roots.caddyfile()).unwrap();
        assert!(live.contains(s.anon_key.expose()) && !live.contains(s.service_role_key.expose()), "the anon key is in the gateway config, the service-role key is not");
        assert!(live.contains("bind 127.0.0.1"));
        assert!(std::fs::read_to_string(caddyfile_maintenance(&roots)).unwrap().contains("STORE_UPDATING"));
    }

    #[test]
    fn the_lan_bind_is_the_one_defined_in_render_and_loopback() {
        assert_eq!(BOOTSTRAP_LAN_BIND, "127.0.0.1");
        assert_eq!(BOOTSTRAP_LAN_BIND, crate::render::BOOTSTRAP_LAN_BIND);
    }

    #[test]
    fn while_fenced_the_live_config_goes_to_caddyfile_live_and_the_active_file_is_untouched() {
        let (_d, roots) = provisioned();
        let s = secrets::load(&roots.secrets()).unwrap();
        let input = render::input_from(&roots, Ports { base: 47300 }, "shop", &s);
        std::fs::write(caddyfile_live_copy(&roots), "old live").unwrap();
        std::fs::write(roots.caddyfile(), "MAINTENANCE IN PLACE").unwrap();
        assert!(write_configs(&roots, &Fake::default(), &input).unwrap());
        assert_eq!(std::fs::read_to_string(roots.caddyfile()).unwrap(), "MAINTENANCE IN PLACE");
        assert!(std::fs::read_to_string(caddyfile_live_copy(&roots)).unwrap().contains("/_store/health"));
    }

    #[test]
    fn activate_repoints_every_service_and_sets_current_atomically() {
        let (_d, roots) = provisioned();
        let rt = Fake::default();
        let out = activate(&roots, &rt, "1.1.0-r1", false).unwrap();
        assert_eq!(out.data["currentChanged"], false);
        assert_eq!(PosctlJson::load(&roots).unwrap().unwrap().pack.current, "1.0.0-r1", "without --set-current nothing is committed");
        let prepared = rt.prepared.borrow().clone();
        assert_eq!(prepared.len(), 5);
        assert!(prepared.iter().all(|(_, p)| p.ends_with("1.1.0-r1")));
        assert!(rt.functions_env.borrow().iter().any(|l| l.starts_with("STAFF_PASSWORD_PEPPER=")));
        let out = activate(&roots, &rt, "1.1.0-r1", true).unwrap();
        assert_eq!((out.data["currentChanged"].clone(), out.data["previous"].clone()), (json!(true), json!("1.0.0-r1")));
        let cfg = PosctlJson::load(&roots).unwrap().unwrap();
        assert_eq!((cfg.pack.current.as_str(), cfg.pack.previous.as_deref()), ("1.1.0-r1", Some("1.0.0-r1")));
        let again = activate(&roots, &rt, "1.1.0-r1", true).unwrap();
        assert_eq!(again.data["currentChanged"], false, "already current is a no-op");
        assert_eq!(PosctlJson::load(&roots).unwrap().unwrap().pack.previous.as_deref(), Some("1.0.0-r1"));
    }

    #[test]
    fn a_tls_store_stays_tls_across_pack_activate_and_a_damaged_state_file_refuses() {
        let (_d, roots) = provisioned();
        let s = secrets::load(&roots.secrets()).unwrap();
        let mut input = render::input_from(&roots, Ports { base: 47300 }, "shop", &s);
        input.gateway = gateway::GatewaySettings::dev_internal();
        write_configs(&roots, &Fake::default(), &input).unwrap();
        let before = std::fs::read_to_string(roots.caddyfile()).unwrap();
        assert!(before.contains("https://127.0.0.1:47304, https://localhost:47304") && before.contains("tls internal"), "{before}");
        std::fs::write(roots.caddyfile(), "stale").unwrap();
        activate(&roots, &Fake::default(), "1.1.0-r1", false).unwrap();
        assert_eq!(std::fs::read_to_string(roots.caddyfile()).unwrap(), before, "activate re-renders the same TLS gateway");
        let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(roots.state().join("gateway.json")).unwrap()).unwrap();
        assert_eq!((state["tls"].as_str(), state["extBind"].as_str()), (Some("internal"), Some("127.0.0.1")));
        std::fs::write(roots.state().join("gateway.json"), "{not json").unwrap();
        std::fs::write(roots.caddyfile(), "stale").unwrap();
        assert!(activate(&roots, &Fake::default(), "1.1.0-r1", false).is_err(), "an unreadable state file is never guessed as plain HTTP");
        assert_eq!(std::fs::read_to_string(roots.caddyfile()).unwrap(), "stale");
    }

    #[test]
    fn a_tls_store_that_lost_its_state_file_is_refused_and_its_gateway_config_is_left_alone() {
        let (_d, roots) = provisioned();
        let s = secrets::load(&roots.secrets()).unwrap();
        let mut input = render::input_from(&roots, Ports { base: 47300 }, "shop", &s);
        input.gateway = gateway::GatewaySettings::dev_internal();
        write_configs(&roots, &Fake::default(), &input).unwrap();
        let before = std::fs::read_to_string(roots.caddyfile()).unwrap();
        std::fs::remove_file(roots.state().join("gateway.json")).unwrap();
        let e = activate(&roots, &Fake::default(), "1.1.0-r1", false).unwrap_err();
        assert!(e.message.starts_with("GATEWAY_STATE_MISSING"), "{}", e.message);
        assert_eq!(std::fs::read_to_string(roots.caddyfile()).unwrap(), before, "no silent switch to plain HTTP");
        assert!(!roots.state().join("gateway.json").exists(), "and no tls:off file written");
    }

    #[test]
    fn a_dev_store_whose_state_file_asks_for_the_lan_is_refused_on_activate() {
        let (_d, roots) = provisioned();
        assert!(roots.dev);
        std::fs::write(roots.state().join("gateway.json"), r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["127.0.0.1"]}"#).unwrap();
        assert!(activate(&roots, &Fake::default(), "1.1.0-r1", false).unwrap_err().message.starts_with("GATEWAY_STATE_DAMAGED"));
    }

    #[test]
    fn a_store_with_no_gateway_state_activates_as_plain_loopback_http() {
        let (_d, roots) = provisioned();
        assert_eq!(gateway::GatewaySettings::load(&roots).unwrap(), gateway::GatewaySettings::default());
        activate(&roots, &Fake::default(), "1.1.0-r1", false).unwrap();
        assert!(!std::fs::read_to_string(roots.caddyfile()).unwrap().contains("tls internal"));
    }

    #[test]
    fn activation_keeps_the_owner_set_optional_secrets_in_the_functions_environment() {
        let (_d, roots) = provisioned();
        let v = format!("opt-{}", crate::util::random_hex(6).unwrap());
        std::fs::write(roots.secrets().join(secrets::optional_file("RESEND_API_KEY")), &v).unwrap();
        let rt = Fake::default();
        activate_locked(&roots, &rt, "1.1.0-r1", false).unwrap();
        assert!(rt.functions_env.borrow().contains(&format!("RESEND_API_KEY={v}")));
    }

    #[test]
    fn a_failing_prepare_leaves_pack_current_unchanged() {
        let (_d, roots) = provisioned();
        let rt = Fake { fail_prepare: true, ..Fake::default() };
        assert!(activate(&roots, &rt, "1.1.0-r1", true).is_err());
        let cfg = PosctlJson::load(&roots).unwrap().unwrap();
        assert_eq!((cfg.pack.current.as_str(), cfg.pack.previous), ("1.0.0-r1", None), "the commit comes after every service was re-pointed");
    }

    #[test]
    fn activate_repoints_the_tunnel_service_only_when_it_is_registered() {
        let (_d, roots) = provisioned();
        let none = Fake::default();
        activate(&roots, &none, "1.1.0-r1", true).unwrap();
        assert!(none.repointed.borrow().is_empty());
        let with = Fake { tunnel_registered: true, ..Fake::default() };
        let out = activate(&roots, &with, "1.1.0-r1", false).unwrap();
        assert_eq!(*with.repointed.borrow(), vec!["1.1.0-r1".to_string()]);
        assert_eq!(out.data["repointedOptional"], json!(["SupermarketPOS-Tunnel"]));
    }

    #[test]
    fn repoint_bin_path_swaps_only_the_pack_version_segment() {
        let packs = Path::new(r"C:\Program Files\SupermarketPOS\packs");
        let old = r#""C:\Program Files\SupermarketPOS\packs\1.0.0-r1\bin\shawl.exe" run --name SupermarketPOS-Tunnel -- "C:\Program Files\SupermarketPOS\packs\1.0.0-r1\bin\cloudflared.exe" tunnel run"#;
        let new = repoint_bin_path(old, packs, "1.1.0-r1").unwrap();
        assert_eq!(new.matches(r"packs\1.1.0-r1\").count(), 2);
        assert!(!new.contains("1.0.0-r1") && new.ends_with("tunnel run"));
        assert_eq!(repoint_bin_path(&new, packs, "1.1.0-r1"), None, "already current");
        assert_eq!(repoint_bin_path(r"C:\elsewhere\x.exe", packs, "1.1.0-r1"), None, "a path outside packs\\ is never rewritten");
    }

    #[test]
    fn an_unknown_or_unprovisioned_activation_is_refused() {
        let (_d, roots) = provisioned();
        assert_eq!(activate(&roots, &Fake::default(), "9.9.9-r1", false).unwrap_err().code, Code::PackInvalid);
        assert_eq!(activate(&roots, &Fake::default(), "..\\x", false).unwrap_err().code, Code::PackInvalid, "a non-version string never reaches a path");
        let d2 = tempfile::tempdir().unwrap();
        let bare = Roots::custom(d2.path().join("d"), d2.path().join("p"));
        assert_eq!(activate(&bare, &Fake::default(), "1.0.0-r1", false).unwrap_err().code, Code::NotProvisioned);
    }

    #[test]
    fn the_cli_wrapper_takes_the_lock_exclusive() {
        let (_d, roots) = provisioned();
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        let _held = acquire(&roots.update_dir(), LockMode::Exclusive, "update", "u", Duration::from_secs(0)).unwrap();
        assert_eq!(activate_locked(&roots, &Fake::default(), "1.1.0-r1", true).unwrap_err().code, Code::LockHeld);
    }
}
