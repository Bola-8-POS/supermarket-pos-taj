//! Windows Service SCM registration for `broker.exe` (`install`/`uninstall`
//! CLI subcommands). Lives outside `src/` deliberately, mirroring
//! 19-RESEARCH.md's Recommended Project Structure (`broker/install/` is a
//! sibling of `broker/src/`, not nested inside it) — included into the crate
//! via `#[path = "../install/mod.rs"] mod install;` in `src/main.rs`.
//!
//! Account choice: `NT SERVICE\PrintBrokerService`, a Windows-provided
//! per-service virtual account (Vista+ least-privilege mechanism) — chosen
//! over creating a real local user account via `NetUserAdd` because it needs
//! zero secret/password storage for the account itself, and over
//! LocalSystem/LocalService/NetworkService because those are overprivileged
//! for a process that only needs to talk HTTP + WinSpool (D-02, Pitfall 2,
//! spike finding #4). NEVER change this to LocalSystem/LocalService/
//! NetworkService — see this plan's `prohibitions`.

#[cfg(windows)]
mod imp {
    use std::ffi::OsString;

    use windows_service::service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceType,
    };
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    use crate::SERVICE_NAME;

    /// Dedicated per-service virtual account — never LocalSystem/LocalService/
    /// NetworkService (D-02, prohibitions).
    const SERVICE_ACCOUNT: &str = "NT SERVICE\\PrintBrokerService";

    /// ERROR_SERVICE_EXISTS — returned by `CreateServiceW` when the service is
    /// already registered from a prior install/upgrade run.
    const ERROR_SERVICE_EXISTS: i32 = 1073;

    pub fn install() -> Result<(), String> {
        // Ensure the per-store secret + config exist before the service ever
        // starts (idempotent — only generates a secret when absent). A
        // present-but-corrupt config is now a hard error instead of a
        // silent secret regeneration.
        crate::config::load_or_init()?;

        let manager =
            ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)
                .map_err(|e| format!("open SCM failed: {e}"))?;

        let exe_path = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;

        let service_info = ServiceInfo {
            name: OsString::from(SERVICE_NAME),
            display_name: OsString::from("Store Print Broker"),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: exe_path,
            launch_arguments: vec![],
            dependencies: vec![],
            account_name: Some(OsString::from(SERVICE_ACCOUNT)),
            account_password: None,
        };

        match manager.create_service(&service_info, ServiceAccess::QUERY_STATUS) {
            Ok(_service) => {
                apply_failure_recovery_policy();
                Ok(())
            }
            Err(windows_service::Error::Winapi(ref io_err))
                if io_err.raw_os_error() == Some(ERROR_SERVICE_EXISTS) =>
            {
                // Idempotent across upgrades: already registered is not an
                // error — re-apply the recovery policy in case this is an
                // upgrade of a service registered by an older installer.
                apply_failure_recovery_policy();
                Ok(())
            }
            Err(e) => Err(format!("create_service failed: {e}")),
        }
    }

    /// `sc.exe failure` — the `windows-service` crate has no first-class API
    /// for the crash-restart recovery policy, so shell out (19-RESEARCH.md
    /// Anti-Patterns: "Registering the Windows Service without a `sc failure`
    /// recovery policy"). Three restart actions at 5s spacing, resetting the
    /// failure count after 24h (86400s) with no failures.
    fn apply_failure_recovery_policy() {
        let status = std::process::Command::new("sc.exe")
            .args([
                "failure",
                SERVICE_NAME,
                "reset=",
                "86400",
                "actions=",
                "restart/5000/restart/5000/restart/5000",
            ])
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => crate::ledger::log_error(&format!("sc.exe failure exited with status {s}")),
            Err(e) => crate::ledger::log_error(&format!("sc.exe failure failed to launch: {e}")),
        }
    }

    pub fn uninstall() -> Result<(), String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(|e| format!("open SCM failed: {e}"))?;
        let service = manager
            .open_service(
                SERVICE_NAME,
                ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS,
            )
            .map_err(|e| format!("open_service failed: {e}"))?;
        let _ = service.stop();
        // Bounded wait for the service to actually reach Stopped before
        // deleting it: a still-stopping service marked for deletion fails
        // the next `install` with 1072. Never blocks indefinitely — if
        // query_status itself errors, or the service is still not stopped
        // after 10s, delete proceeds anyway rather than hang the uninstall.
        wait_for_stopped(&service, std::time::Duration::from_secs(10));
        service
            .delete()
            .map_err(|e| format!("delete_service failed: {e}"))?;
        // Deliberately does NOT delete %ProgramData%\PrintBroker\ — the audit
        // ledger and config must survive an app uninstall/reinstall.
        Ok(())
    }

    fn wait_for_stopped(service: &windows_service::service::Service, timeout: std::time::Duration) {
        let start = std::time::Instant::now();
        loop {
            match service.query_status() {
                Ok(status) if status.current_state == ServiceState::Stopped => return,
                Ok(_) => {}
                Err(_) => return,
            }
            if start.elapsed() >= timeout {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn install() -> Result<(), String> {
        Err("Windows Service install is only supported on Windows".to_string())
    }

    pub fn uninstall() -> Result<(), String> {
        Err("Windows Service uninstall is only supported on Windows".to_string())
    }
}

pub use imp::{install, uninstall};
