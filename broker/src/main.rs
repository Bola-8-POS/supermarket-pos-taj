//! `broker` — store-local durable print broker. Plan 19-01 proved the core
//! pipeline (authenticated HTTP -> durable SQLite ledger -> WinSpool delivery
//! -> reconciliation) as a plain foreground process. Plan 19-02 turns this
//! into a genuine SCM-managed Windows Service (`windows-service` crate) with
//! `install`/`uninstall`/`run` CLI subcommands, replacing the old plain
//! foreground `fn main()` body with a real SCM entry point.
//!
//! Dispatch: no args or "run" -> the real SCM entry point
//! (`windows_service::service_dispatcher::start`, which blocks until the
//! service is stopped); "install" -> `install::install()`; "uninstall" ->
//! `install::uninstall()`.

mod config;
mod delivery;
mod http;
mod ledger;
mod retry;

// `install/` is a sibling of `src/`, not nested inside it — see
// broker/install/mod.rs's own doc comment and 19-RESEARCH.md's Recommended
// Project Structure.
#[path = "../install/mod.rs"]
mod install;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Service name used for both SCM registration (`install::install()`) and
/// the SCM entry point (`service_dispatcher::start`) — keep these in sync.
pub const SERVICE_NAME: &str = "PrintBrokerService";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Run,
    Install,
    Uninstall,
}

/// Pure argv dispatch — no side effects, so it can be unit-tested without
/// executing any of the install/uninstall/service-dispatcher paths.
fn parse_command(args: &[String]) -> Command {
    match args.first().map(String::as_str) {
        None | Some("run") => Command::Run,
        Some("install") => Command::Install,
        Some("uninstall") => Command::Uninstall,
        Some(other) => {
            eprintln!("unknown argument '{other}', defaulting to 'run'");
            Command::Run
        }
    }
}

/// The actual print-broker work loop (worker thread + HTTP server) — moved
/// verbatim from Plan 19-01's `fn main()` body, plus the already-resolved
/// bearer `secret` (Plan wave-3c: the caller resolves it once, before the
/// service reports `Running` to the SCM, and fails closed if it can't).
/// Shared by the real SCM entry point (`scm::service_main`, Windows only).
fn run_broker(shutdown: Arc<AtomicBool>, secret: String) {
    let db_path = ledger::default_db_path();
    ledger::log(&format!(
        "=== print-broker starting, db={} ===",
        db_path.display()
    ));
    let _ = ledger::open_db(&db_path); // ensure schema exists before either loop starts

    let worker_db_path = db_path.clone();
    let worker_shutdown = shutdown.clone();
    let worker_handle =
        std::thread::spawn(move || delivery::run_worker(worker_shutdown, &worker_db_path));

    let bind_addr = format!("{}:{}", http::BIND_ADDR, http::PORT);
    http::run_http_server(shutdown.clone(), &db_path, &bind_addr, secret);
    shutdown.store(true, Ordering::SeqCst);
    let _ = worker_handle.join();
    ledger::log("=== print-broker exiting ===");
}

#[cfg(windows)]
mod scm {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};

    windows_service::define_windows_service!(ffi_service_main, service_main);

    /// Real SCM entry point (Pattern 4, 19-RESEARCH.md): registers a control
    /// handler (Stop -> signal shutdown, Interrogate -> NoError), resolves
    /// the bearer secret BEFORE reporting Running (wave-3c: fail closed — a
    /// broker that cannot resolve a real secret must never bind the port),
    /// then runs the same worker/HTTP-server pair Plan 19-01 already wired
    /// via `run_broker`.
    pub fn service_main(_args: Vec<OsString>) {
        let shutdown = Arc::new(AtomicBool::new(false));
        let control_shutdown = shutdown.clone();

        let event_handler = move |control: ServiceControl| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop => {
                    control_shutdown.store(true, Ordering::SeqCst);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };

        let status_handle = match service_control_handler::register(
            crate::SERVICE_NAME,
            event_handler,
        ) {
            Ok(h) => h,
            Err(e) => {
                crate::ledger::log_error(&format!("service_control_handler::register failed: {e}"));
                return;
            }
        };

        let secret = match crate::http::resolve_broker_secret() {
            Ok(s) => s,
            Err(e) => {
                crate::ledger::log_error(&format!(
                    "broker secret unavailable, refusing to start: {e}"
                ));
                let failed_status = ServiceStatus {
                    service_type: ServiceType::OWN_PROCESS,
                    current_state: ServiceState::Stopped,
                    controls_accepted: ServiceControlAccept::empty(),
                    exit_code: ServiceExitCode::ServiceSpecific(1),
                    checkpoint: 0,
                    wait_hint: Duration::default(),
                    process_id: None,
                };
                let _ = status_handle.set_service_status(failed_status);
                return;
            }
        };

        let running_status = ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP,
            exit_code: ServiceExitCode::NO_ERROR,
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        if let Err(e) = status_handle.set_service_status(running_status) {
            crate::ledger::log_error(&format!("set_service_status(Running) failed: {e}"));
            return;
        }

        crate::run_broker(shutdown, secret);

        let stopped_status = ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::NO_ERROR,
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        let _ = status_handle.set_service_status(stopped_status);
    }

    /// Wrapper so `main()` never needs to reach `ffi_service_main` directly —
    /// the macro-generated fn has no `pub` and must be referenced from
    /// within this module.
    pub fn start_dispatcher() -> windows_service::Result<()> {
        windows_service::service_dispatcher::start(crate::SERVICE_NAME, ffi_service_main)
    }
}

/// The worker thread (`run_broker`'s `std::thread::spawn`) has no supervisor —
/// an unhandled panic there used to just print Rust's default message to
/// stderr (nowhere, since a Windows Service has no console) and silently die,
/// leaving printing broken with zero record anywhere. Routes panics through
/// `log_error` (file + Windows Event Log) before the thread unwinds.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        ledger::log_error(&format!("panic: {info}"));
    }));
}

fn main() {
    install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_command(&args) {
        Command::Install => {
            if let Err(e) = install::install() {
                eprintln!("install failed: {e}");
                std::process::exit(1);
            }
        }
        Command::Uninstall => {
            if let Err(e) = install::uninstall() {
                eprintln!("uninstall failed: {e}");
                std::process::exit(1);
            }
        }
        Command::Run => {
            #[cfg(windows)]
            {
                if let Err(e) = scm::start_dispatcher() {
                    eprintln!(
                        "service_dispatcher::start failed ({e}) — not running under the SCM? \
                         run `broker.exe install` first, then `sc.exe start {SERVICE_NAME}`."
                    );
                    std::process::exit(1);
                }
            }
            #[cfg(not(windows))]
            {
                eprintln!("the print broker only runs on Windows");
                std::process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test 3: CLI argument parsing routes "install" to the install path,
    // "uninstall" to the uninstall path, and no-args/"run" to the SCM
    // service-dispatcher path, without executing any of the other two.
    #[test]
    fn parse_command_routes_correctly() {
        assert_eq!(parse_command(&[]), Command::Run);
        assert_eq!(parse_command(&["run".to_string()]), Command::Run);
        assert_eq!(parse_command(&["install".to_string()]), Command::Install);
        assert_eq!(parse_command(&["uninstall".to_string()]), Command::Uninstall);
    }
}
