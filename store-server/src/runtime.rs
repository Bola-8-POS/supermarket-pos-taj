//! The seam between "what provisioning does" and "how components are run". `WindowsServices`
//! (this plan) registers real Shawl services; Plan 05b adds `DevProcesses` for test instances
//! (`posctl dev ...`), which spawns the same executables as plain child processes and never
//! touches the SCM, ACLs, the registry or the firewall. This module must never run from a test
//! against the real machine: it calls `sc.exe`, the registry and the ACL APIs.

use std::path::Path;
use std::time::Duration;

use crate::acl;
use crate::paths::Roots;
use crate::services::{self, Component, ServiceState};

pub trait Runtime {
    fn name(&self) -> &'static str;
    /// Make the component startable (register the service). Idempotent.
    fn prepare(&self, roots: &Roots, pack_dir: &Path, c: Component) -> Result<(), String>;
    /// Run a `.cmd` script to completion as the Postgres account (initdb).
    fn run_script_as_postgres(&self, roots: &Roots, pack_dir: &Path, script: &Path, timeout: Duration) -> Result<(), String>;
    fn start(&self, roots: &Roots, pack_dir: &Path, c: Component) -> Result<(), String>;
    fn stop(&self, c: Component) -> Result<(), String>;
    /// The Functions secrets (`KEY=value`), delivered without a file or a command line.
    fn set_functions_env(&self, roots: &Roots, entries: &[String]) -> Result<(), String>;
    fn unregister(&self, c: Component) -> Result<(), String>;
    /// Set the service's start type: `true` = automatic, `false` = manual (demand). The boot gate sets manual so a
    /// reboot cannot bring a gated sign-in stack back; `posctl start` restores automatic. Default: nothing (dev instances).
    fn set_auto_start(&self, _c: Component, _auto: bool) -> Result<(), String> {
        Ok(())
    }
    /// Restrict a file to SYSTEM, Administrators and the listed extra grants.
    fn protect_file(&self, path: &Path, grants: &[acl::Grant]) -> Result<(), String>;

    /// The Postgres service name is shared with the one-shot initdb service and the data folder is about to be
    /// wiped: make sure nothing of that name is running (stop it if it is), or fail. Default: nothing runs.
    fn ensure_postgres_idle(&self) -> Result<(), String> {
        Ok(())
    }

    /// Raise `WaitToKillServiceTimeout` to 30000 when needed (never lower a larger value). Returns the
    /// previous text that must be restored (`Some("")` = the value was absent), `None` when nothing changed.
    /// Default: do nothing, so dev instances never touch the registry.
    fn raise_shutdown_timeout(&self) -> Result<Option<String>, String> {
        Ok(None)
    }
    /// Undo `raise_shutdown_timeout`: `Some("")` deletes the value, `Some(text)` writes it back.
    fn restore_shutdown_timeout(&self, _previous: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    /// Plan 12 (C-12g): re-point the optional Tunnel service at pack `version` when it is registered.
    /// Returns the names it changed. Default: nothing to re-point.
    fn repoint_optional(&self, _roots: &Roots, _pack_dir: &Path, _version: &str) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
}

pub struct WindowsServices;

impl Runtime for WindowsServices {
    fn name(&self) -> &'static str {
        "windows-services"
    }

    fn prepare(&self, roots: &Roots, pack_dir: &Path, c: Component) -> Result<(), String> {
        services::register(roots, pack_dir, c).map(|_| ())
    }

    fn run_script_as_postgres(&self, roots: &Roots, pack_dir: &Path, script: &Path, timeout: Duration) -> Result<(), String> {
        let c = Component::Postgres;
        let bin = services::one_shot_bin_path(roots, pack_dir, script)?;
        let pairs = |verb: &str| -> Vec<String> {
            let mut a = vec![verb.to_string(), c.service_name().to_string()];
            a.extend(["binPath=".to_string(), bin.clone(), "start=".to_string(), "demand".to_string(), "obj=".to_string(), c.account()]);
            a
        };
        // the one-shot reuses the Postgres service name: never touch a running one
        services::one_shot_precheck(&services::query_state(c)?)?;
        let created = services::sc(&pairs("create")).map_err(|e| e.to_string())?;
        if !created.success() {
            if created.code != services::SC_ALREADY_EXISTS {
                return Err(format!("sc create (one-shot) failed ({}): {}", created.code, created.text().trim()));
            }
            let cfg = services::sc(&pairs("config")).map_err(|e| e.to_string())?;
            if !cfg.success() {
                return Err(format!("sc config (one-shot) failed ({}): {}", cfg.code, cfg.text().trim()));
            }
        }
        // the registered failure actions (restart) would re-run initdb on a failing script
        let none = services::sc(&services::one_shot_failure_args()).map_err(|e| e.to_string())?;
        if !none.success() {
            return Err(format!("sc failure (one-shot) failed ({}): {}", none.code, none.text().trim()));
        }
        let started = services::sc(&services::sc_simple_args("start", c)).map_err(|e| e.to_string())?;
        if !started.success() {
            // 1056 included: the precheck said it was stopped, so "already running" means something else started it
            return Err(format!("sc start (one-shot) failed ({}): {}", started.code, started.text().trim()));
        }
        if !services::wait_for_state(c, &ServiceState::Stopped, timeout)? {
            return Err(format!("the one-shot service did not finish within {}s", timeout.as_secs()));
        }
        match crate::sys::service_status(c.service_name())? {
            Some(st) => services::one_shot_outcome(&st),
            None => Err("the one-shot service vanished before its exit code could be read".to_string()),
        }
    }

    fn ensure_postgres_idle(&self) -> Result<(), String> {
        let c = Component::Postgres;
        if services::one_shot_precheck(&services::query_state(c)?).is_err() {
            services::stop(c, Duration::from_secs(60))?;
        }
        services::one_shot_precheck(&services::query_state(c)?)
    }

    fn start(&self, _roots: &Roots, _pack_dir: &Path, c: Component) -> Result<(), String> {
        services::start(c, Duration::from_secs(60))
    }

    fn stop(&self, c: Component) -> Result<(), String> {
        services::stop(c, Duration::from_secs(if c == Component::Postgres { 60 } else { 30 }))
    }

    fn set_functions_env(&self, _roots: &Roots, entries: &[String]) -> Result<(), String> {
        crate::sys::set_service_environment(Component::Functions.service_name(), entries)
    }

    fn unregister(&self, c: Component) -> Result<(), String> {
        services::unregister(c)
    }

    fn set_auto_start(&self, c: Component, auto: bool) -> Result<(), String> {
        services::set_start_type(c, auto)
    }

    fn protect_file(&self, path: &Path, grants: &[acl::Grant]) -> Result<(), String> {
        acl::apply_one(path, grants)
    }

    fn raise_shutdown_timeout(&self) -> Result<Option<String>, String> {
        let current = crate::sys::wait_to_kill_get()?;
        match services::wait_to_kill_target(current.as_deref()) {
            Some(target) => {
                crate::sys::wait_to_kill_set(&target)?;
                Ok(Some(current.unwrap_or_default()))
            }
            None => Ok(None),
        }
    }

    fn restore_shutdown_timeout(&self, previous: Option<&str>) -> Result<(), String> {
        match previous {
            None => Ok(()),
            Some("") => crate::sys::wait_to_kill_delete(),
            Some(text) => crate::sys::wait_to_kill_set(text),
        }
    }

    fn repoint_optional(&self, roots: &Roots, _pack_dir: &Path, version: &str) -> Result<Vec<String>, String> {
        let name = services::TUNNEL_SERVICE;
        if crate::sys::service_state(name)? == ServiceState::NotInstalled {
            return Ok(vec![]);
        }
        if crate::pack::parse_pack_version(version).is_none() {
            return Err(format!("{version:?} is not a pack version; refusing to re-point {name}"));
        }
        let current = crate::sys::service_bin_path(name)?;
        let Some(new) = services::repoint_bin_path(&current, &roots.packs(), version) else {
            return Ok(vec![]);
        };
        let o = services::sc(&["config".to_string(), name.to_string(), "binPath=".to_string(), new]).map_err(|e| e.to_string())?;
        if !o.success() {
            return Err(format!("sc config {name} failed ({}): {}", o.code, o.text().trim()));
        }
        Ok(vec![name.to_string()])
    }
}

/// Every method succeeds and does nothing (tests of steps that never reach a service).
#[cfg(test)]
pub struct NoopRuntime;

#[cfg(test)]
impl Runtime for NoopRuntime {
    fn name(&self) -> &'static str {
        "noop"
    }
    fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> {
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
    fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn unregister(&self, _: Component) -> Result<(), String> {
        Ok(())
    }
    fn protect_file(&self, _: &Path, _: &[acl::Grant]) -> Result<(), String> {
        Ok(())
    }
}
