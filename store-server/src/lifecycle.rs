//! `start`, `stop`, `restart` for the five services, in dependency order with health gates.
//! Used by the commands and (through `Runtime`) by `dev` instances.
//!
//! Each public command checks the operation journal, then takes `update.lock` exclusive through
//! `ops::lock::acquire_for` (trust checks included) so it can never interleave with an update, a
//! switch or a restore. The `*_locked` variants are for a caller that already holds the lock (an
//! operation that restarts services in the middle of its own work); taking it twice would deadlock.
//! It must never start sign-in without the lockout hook variables, and never run while
//! `state\update\journal.json` exists.

use std::time::Duration;

use serde_json::json;

use crate::config::{guard_no_operation, PosctlJson};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::ops::lock::{acquire_for, LockGuard, LockMode};
use crate::pack;
use crate::paths::Roots;
use crate::pg::PgTools;
use crate::ports::Ports;
use crate::probe;
use crate::render;
use crate::runtime::Runtime;
use crate::services::{with_dependents, Component, ServiceState};
use crate::sys;
use crate::util::random_uuid_v4;

pub struct Installed {
    pub ports: Ports,
    pub pack: pack::Pack,
}

/// A provisioned machine's ports and config, with NO pack involved. `stop` needs only this (it works on service names), and
/// the status commands use it to still say something when the pack does not verify.
pub fn provisioned(roots: &Roots) -> Result<(Ports, PosctlJson), PosctlError> {
    if !roots.provisioned_json().exists() {
        return Err(PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"));
    }
    let cfg = PosctlJson::load(roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "conf\\posctl.json is missing"))?;
    let ports = Ports::new(cfg.ports.base).map_err(PosctlError::error)?;
    Ok((ports, cfg))
}

/// What `start` (and everything else that RUNS something from the pack) needs: the current pack, verified at the FULL tier
/// (signature, every file hash, nothing unlisted).
pub fn load_installed(roots: &Roots) -> Result<Installed, PosctlError> {
    load_installed_tier(roots, pack::Tier::Full)
}

/// The same at the LIGHT tier (signature, sizes, nothing unlisted): for `status`, `health` and `version`, which run every
/// minute and run nothing from the pack's binaries on the strength of it.
pub fn load_installed_light(roots: &Roots) -> Result<Installed, PosctlError> {
    load_installed_tier(roots, pack::Tier::Light)
}

fn load_installed_tier(roots: &Roots, tier: pack::Tier) -> Result<Installed, PosctlError> {
    let (ports, cfg) = provisioned(roots)?;
    let dir = roots.pack_dir(&cfg.pack.current).map_err(|e| PosctlError::new(Code::PackInvalid, e))?;
    let pack = match tier {
        pack::Tier::Full => pack::load(&dir),
        pack::Tier::Light => pack::load_light(&dir),
    }
    .map_err(|e| PosctlError::new(Code::PackInvalid, e))?;
    Ok(Installed { ports, pack })
}

pub fn select(component: Option<&str>) -> Result<Vec<Component>, PosctlError> {
    match component {
        None => Ok(Component::ALL.to_vec()),
        Some(s) if s.eq_ignore_ascii_case("all") => Ok(Component::ALL.to_vec()),
        Some(s) => Component::from_short(s).map(|c| vec![c]).ok_or_else(|| PosctlError::new(Code::Usage, format!("unknown component '{s}' (Postgres, Auth, Rest, Functions, Gateway or all)"))),
    }
}

/// Journal guard, installed-ness, elevation, then the lock; the journal is checked again under the lock
/// (an operation writes it only while holding the lock, so a check made before could be stale).
pub fn begin(roots: &Roots) -> Result<(Installed, LockGuard), PosctlError> {
    begin_as(roots, &sys::is_elevated)
}

fn begin_as(roots: &Roots, is_elevated: &dyn Fn() -> bool) -> Result<(Installed, LockGuard), PosctlError> {
    begin_with(roots, is_elevated, load_installed)
}

/// `begin` with a caller-chosen load: `stop` loads no pack at all (it only needs service names).
fn begin_with<T>(roots: &Roots, is_elevated: &dyn Fn() -> bool, load: impl FnOnce(&Roots) -> Result<T, PosctlError>) -> Result<(T, LockGuard), PosctlError> {
    // elevation first: a standard user cannot see provisioned.json, so any check that reads it would answer NOT_PROVISIONED
    if !roots.dev && !is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "starting and stopping services must run as an administrator"));
    }
    guard_no_operation(roots)?;
    let inst = load(roots)?;
    let lock = acquire_for(roots, LockMode::Exclusive, "lifecycle", &random_uuid_v4().map_err(PosctlError::error)?, Duration::from_secs(0))?;
    guard_no_operation(roots)?;
    Ok((inst, lock))
}

/// How long the commands wait for one component to answer its health probe.
const HEALTH_WAIT: Duration = Duration::from_secs(90);

/// Waits for one component to be healthy; `Some(ms)` or `None` on timeout. Injected so tests never wait on a network.
pub type HealthWait<'a> = &'a dyn Fn(Component, &Installed) -> Option<u64>;

pub fn real_wait(c: Component, inst: &Installed) -> Option<u64> {
    probe::wait_healthy(c, &inst.ports, &PgTools::for_pack(&inst.pack.dir), HEALTH_WAIT)
}

pub fn start(roots: &Roots, rt: &dyn Runtime, component: Option<&str>) -> Result<Outcome, PosctlError> {
    let (inst, _lock) = begin(roots)?;
    start_locked(roots, rt, &inst, component, &real_wait)
}

/// An operator must be able to stop the stack whatever state the pack folder is in, so no pack is loaded or verified here.
pub fn stop(roots: &Roots, rt: &dyn Runtime, component: Option<&str>) -> Result<Outcome, PosctlError> {
    let (_provisioned, _lock) = begin_with(roots, &sys::is_elevated, provisioned)?;
    stop_locked(rt, component)
}

/// Stop then start under ONE lock acquisition.
pub fn restart(roots: &Roots, rt: &dyn Runtime, component: Option<&str>) -> Result<Outcome, PosctlError> {
    restart_with(roots, rt, component, &real_wait)
}

pub fn restart_with(roots: &Roots, rt: &dyn Runtime, component: Option<&str>, wait: HealthWait) -> Result<Outcome, PosctlError> {
    let (inst, _lock) = begin(roots)?;
    restart_locked(roots, rt, &inst, component, wait)
}

/// The set a stop or restart acts on: everything, or the component and what depends on it (the SCM refuses to
/// stop a service while a dependent runs, and a restarted dependency must bring them back).
fn closure(component: Option<&str>) -> Result<Vec<Component>, PosctlError> {
    let comps = select(component)?;
    Ok(if comps.len() == 1 { with_dependents(comps[0]) } else { comps })
}

/// The caller holds `update.lock` and has run the journal guard. Stops the closure dependents-first, starts it
/// again in order, each behind its health gate.
pub fn restart_locked(roots: &Roots, rt: &dyn Runtime, inst: &Installed, component: Option<&str>, wait: HealthWait) -> Result<Outcome, PosctlError> {
    let comps = closure(component)?;
    // validate the hook gate BEFORE stopping anything: a refused restart must not take sign-in down
    precheck_start(roots, &comps)?;
    stop_all(rt, &comps)?;
    start_all(roots, rt, inst, &comps, wait)
}

/// True when starting any of `comps` brings sign-in up: Auth itself, or Functions / the Gateway, which the SCM
/// starts Auth for as a dependency.
fn touches_sign_in(comps: &[Component]) -> bool {
    comps.iter().any(|c| with_dependents(Component::Auth).contains(c))
}

/// Refusals that need no service: missing lockout hook variables.
fn precheck_hook_env(roots: &Roots, comps: &[Component]) -> Result<(), PosctlError> {
    // S11 REVIEW I2: never start sign-in without the lockout hook variables.
    if touches_sign_in(comps) {
        let env = std::fs::read_to_string(roots.gotrue_env()).map_err(|e| PosctlError::error(format!("gotrue.env: {e}")))?;
        if !render::gotrue_hook_env_ok(&env) {
            return Err(PosctlError::new(Code::Unhealthy, "gotrue.env lacks the PIN lockout hook variables; refusing to start sign-in"));
        }
    }
    Ok(())
}

/// Plus: a recorded failed lockout canary (`canary.json` `lastOk: false`) keeps the stack down until
/// `start_checked` has proven the lockout again.
fn precheck_start(roots: &Roots, comps: &[Component]) -> Result<(), PosctlError> {
    precheck_hook_env(roots, comps)?;
    let failed = std::fs::read_to_string(roots.canary_json()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("lastOk")?.as_bool()) == Some(false);
    if touches_sign_in(comps) && failed {
        return Err(PosctlError::new(Code::CanaryFailed, "the last PIN lockout canary failed; refusing to start sign-in until `posctl start --canary` proves the lockout"));
    }
    Ok(())
}

/// The caller holds `update.lock` and has run the journal guard.
pub fn start_locked(roots: &Roots, rt: &dyn Runtime, inst: &Installed, component: Option<&str>, wait: HealthWait) -> Result<Outcome, PosctlError> {
    let comps = select(component)?;
    precheck_start(roots, &comps)?;
    start_all(roots, rt, inst, &comps, wait)
}

fn start_all(roots: &Roots, rt: &dyn Runtime, inst: &Installed, comps: &[Component], wait: HealthWait) -> Result<Outcome, PosctlError> {
    let mut timings = serde_json::Map::new();
    for &c in comps {
        // the boot gate may have set the service to manual start: a start puts it back to automatic
        rt.set_auto_start(c, true).map_err(|e| PosctlError::error(format!("{} start type: {e}", c.short())))?;
        rt.start(roots, &inst.pack.dir, c).map_err(PosctlError::error)?;
        let ms = wait(c, inst).ok_or_else(|| PosctlError::new(Code::Unhealthy, format!("{} did not become healthy within {} s", c.short(), HEALTH_WAIT.as_secs())))?;
        timings.insert(c.short().to_string(), json!(ms));
    }
    Ok(Outcome::ok("started", json!({"healthyAfterMs": timings})))
}

/// The caller holds `update.lock` and has run the journal guard. One component stops with its dependents.
pub fn stop_locked(rt: &dyn Runtime, component: Option<&str>) -> Result<Outcome, PosctlError> {
    stop_all(rt, &closure(component)?)
}

/// `start` for a stack that a failed canary gated: starts it without the canary-record refusal, then runs
/// `canary`. A positive failure (`CANARY_FAILED`) gates the sign-in stack again; any other error leaves what was
/// started running and is returned as it is.
pub fn start_checked(roots: &Roots, rt: &dyn Runtime, component: Option<&str>, canary: &dyn Fn(&Roots, &Installed) -> Result<(), PosctlError>) -> Result<Outcome, PosctlError> {
    let (inst, _lock) = begin(roots)?;
    start_checked_locked(roots, rt, &inst, component, &real_wait, canary)
}

/// The caller holds `update.lock` and has run the journal guard.
pub fn start_checked_locked(roots: &Roots, rt: &dyn Runtime, inst: &Installed, component: Option<&str>, wait: HealthWait, canary: &dyn Fn(&Roots, &Installed) -> Result<(), PosctlError>) -> Result<Outcome, PosctlError> {
    let comps = select(component)?;
    precheck_hook_env(roots, &comps)?;
    let out = start_all(roots, rt, inst, &comps, wait)?;
    if let Err(mut e) = canary(roots, inst) {
        if e.code == Code::CanaryFailed {
            for n in stop_sign_in_stack(rt).notes() {
                e.message.push_str(&format!("; {n}"));
            }
        }
        return Err(e);
    }
    Ok(out)
}

/// What `gate_sign_in_stack` could not do.
#[derive(Debug, Default)]
pub struct StackStop {
    pub stop_failed: Vec<(Component, String)>,
    pub start_type_failed: Vec<(Component, String)>,
}

impl StackStop {
    /// One sentence per failure, ready to join into an error message. Empty when everything worked.
    pub fn notes(&self) -> Vec<String> {
        let stop = self.stop_failed.iter().map(|(c, why)| format!("AND {} could not be stopped: {why}", c.short()));
        let start = self.start_type_failed.iter().map(|(c, why)| format!("AND {} could not be set to manual start: {why}", c.short()));
        stop.chain(start).collect()
    }
}

/// Fail-closed gate of the sign-in stack (Auth and everything that depends on it: Functions, and the Gateway tills
/// reach), dependents first. Every installed service is set to manual start, so a reboot cannot bring it back
/// (`posctl start` restores automatic), and the ones that run are stopped. Every step is attempted even when
/// one fails. Used when the lockout control is off: provision's canary, `health --write`, a failed `start --canary`.
pub fn gate_sign_in_stack(rt: &dyn Runtime, state: &dyn Fn(Component) -> ServiceState) -> StackStop {
    let mut r = StackStop::default();
    for &c in with_dependents(Component::Auth).iter().rev() {
        let st = state(c);
        if st == ServiceState::NotInstalled {
            continue;
        }
        if let Err(why) = rt.set_auto_start(c, false) {
            r.start_type_failed.push((c, why));
        }
        if st != ServiceState::Stopped {
            if let Err(why) = rt.stop(c) {
                r.stop_failed.push((c, why));
            }
        }
    }
    r
}

/// `gate_sign_in_stack` for a caller that knows every service is installed and running (provision).
pub fn stop_sign_in_stack(rt: &dyn Runtime) -> StackStop {
    gate_sign_in_stack(rt, &|_| ServiceState::Running)
}

fn stop_all(rt: &dyn Runtime, comps: &[Component]) -> Result<Outcome, PosctlError> {
    for &c in comps.iter().rev() {
        rt.stop(c).map_err(PosctlError::error)?; // dependents first
    }
    Ok(Outcome::ok("stopped", json!({})))
}

/// A fake that models what the Service Control Manager does: stopping a service while a service that depends on
/// it runs is refused (error 1051). Every fake that accepted any stop order is how C1 went unseen.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::cell::RefCell;
    use std::path::Path;

    pub struct Scm {
        pub running: RefCell<Vec<Component>>,
        pub calls: RefCell<Vec<String>>,
        pub env: RefCell<Vec<String>>,
        /// `"Gateway=demand"` / `"Gateway=auto"`, in call order.
        pub start_types: RefCell<Vec<String>>,
    }
    impl Scm {
        pub fn all_running() -> Self {
            Scm { running: RefCell::new(Component::ALL.to_vec()), calls: RefCell::default(), env: RefCell::default(), start_types: RefCell::default() }
        }
    }
    impl Runtime for Scm {
        fn name(&self) -> &'static str { "scm" }
        fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &Roots, _: &Path, c: Component) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("start {}", c.short()));
            self.running.borrow_mut().push(c);
            Ok(())
        }
        fn stop(&self, c: Component) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("stop {}", c.short()));
            if let Some(d) = self.running.borrow().iter().find(|d| **d != c && d.depends_on().contains(&c)) {
                return Err(format!("sc stop {}: 1051 ({} depends on it and is running)", c.short(), d.short()));
            }
            self.running.borrow_mut().retain(|x| *x != c);
            Ok(())
        }
        fn set_functions_env(&self, _: &Roots, e: &[String]) -> Result<(), String> { *self.env.borrow_mut() = e.to_vec(); Ok(()) }
        fn set_auto_start(&self, c: Component, auto: bool) -> Result<(), String> {
            self.start_types.borrow_mut().push(format!("{}={}", c.short(), if auto { "auto" } else { "demand" }));
            Ok(())
        }
        fn unregister(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::Scm;
    use super::*;
    use std::cell::RefCell;
    use std::path::Path;

    /// Records every call. `start` fails on purpose so no health gate (a real network wait) is ever reached.
    #[derive(Default)]
    struct Log {
        calls: RefCell<Vec<String>>,
    }
    impl Runtime for Log {
        fn name(&self) -> &'static str { "log" }
        fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &Roots, _: &Path, c: Component) -> Result<(), String> { self.calls.borrow_mut().push(format!("start {}", c.short())); Err("stop here".into()) }
        fn stop(&self, c: Component) -> Result<(), String> { self.calls.borrow_mut().push(format!("stop {}", c.short())); Ok(()) }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> { Ok(()) }
        fn unregister(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> { Ok(()) }
    }

    fn installed_root() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.state()).unwrap();
        std::fs::create_dir_all(roots.conf()).unwrap();
        std::fs::create_dir_all(roots.secrets()).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let p = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&p).unwrap();
        pack::make_fake_pack(&p, "1.0.0-r1");
        PosctlJson::new("offline-only", "id", 47300, "shop", "1.0.0-r1").save(&roots).unwrap();
        (d, roots)
    }

    #[test]
    fn component_selection() {
        assert_eq!(select(None).unwrap().len(), 5);
        assert_eq!(select(Some("ALL")).unwrap().len(), 5);
        assert_eq!(select(Some("rest")).unwrap(), vec![Component::Rest]);
        assert_eq!(select(Some("nope")).unwrap_err().code, Code::Usage);
    }

    #[test]
    fn start_stop_and_restart_refuse_while_an_operation_journal_exists() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        assert!(guard_no_operation(&roots).is_ok());
        std::fs::write(roots.journal(), "{}").unwrap();
        let rt = Log::default();
        for r in [start(&roots, &rt, None), stop(&roots, &rt, None), restart(&roots, &rt, None)] {
            let e = r.unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::RecoveryNeeded, 17));
        }
        assert!(rt.calls.borrow().is_empty(), "nothing is touched while an operation is in flight");
        // provisioning keeps its own journal, which must not block anything
        std::fs::remove_file(roots.journal()).unwrap();
        std::fs::write(roots.provision_journal(), "{}").unwrap();
        assert!(guard_no_operation(&roots).is_ok());
    }

    #[test]
    fn an_unprovisioned_machine_answers_not_provisioned() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        assert_eq!(load_installed(&roots).err().unwrap().code, Code::NotProvisioned);
        for r in [start(&roots, &Log::default(), None), stop(&roots, &Log::default(), None)] {
            let e = r.unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::NotProvisioned, 4));
        }
    }

    // I2: a standard user cannot even see provisioned.json (the data root grants Users nothing), so the elevation
    // check must come first or the app is told "not provisioned" (4) instead of "not elevated" (3)
    #[test]
    fn a_non_elevated_caller_gets_not_elevated_even_when_the_pc_looks_unprovisioned() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        let e = begin_as(&roots, &|| false).err().unwrap();
        assert_eq!((e.code, e.code.exit()), (Code::NotElevated, 3));
    }

    #[test]
    fn start_refuses_when_the_lockout_hook_variables_are_gone() {
        let (_d, roots) = installed_root();
        std::fs::write(roots.gotrue_env(), "PORT=47301\n").unwrap();
        struct Never;
        impl Runtime for Never {
            fn name(&self) -> &'static str { "never" }
            fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { unreachable!() }
            fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> { unreachable!() }
            fn start(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { panic!("must not start anything") }
            fn stop(&self, _: Component) -> Result<(), String> { panic!("a refused restart must not stop anything") }
            fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> { unreachable!() }
            fn unregister(&self, _: Component) -> Result<(), String> { unreachable!() }
            fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> { unreachable!() }
        }
        let e = start(&roots, &Never, None).unwrap_err();
        assert_eq!(e.code, Code::Unhealthy);
        assert!(e.message.contains("lockout hook"));
        // restart passes the same gate, and before it stops anything
        let e = restart(&roots, &Never, Some("Auth")).unwrap_err();
        assert_eq!(e.code, Code::Unhealthy);
    }

    #[test]
    fn a_duplicated_hook_variable_is_refused_and_a_good_file_reaches_the_runtime() {
        let (_d, roots) = installed_root();
        let good = format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true\nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}\n", render::HOOK_URI);
        std::fs::write(roots.gotrue_env(), &good).unwrap();
        let rt = Log::default();
        let e = start(&roots, &rt, Some("Auth")).unwrap_err();
        assert_eq!(e.code, Code::Error); // the Log runtime refuses to start: the gate itself passed
        assert_eq!(*rt.calls.borrow(), vec!["start Auth".to_string()]);
        std::fs::write(roots.gotrue_env(), format!("{good}GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=false\n")).unwrap();
        assert_eq!(start(&roots, &Log::default(), Some("Auth")).unwrap_err().code, Code::Unhealthy);
    }

    fn hook_env(roots: &Roots) {
        std::fs::write(roots.gotrue_env(), format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true\nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}\n", render::HOOK_URI)).unwrap();
    }

    // SEC-I1: starting Functions or the Gateway makes the SCM start Auth as a dependency, so the hook and canary gates apply to them too
    #[test]
    fn start_and_restart_of_functions_or_gateway_obey_the_hook_and_failed_canary_gates() {
        let (_d, roots) = installed_root();
        let rt = Log::default();
        let wait = |_: Component, _: &Installed| Some(1u64);
        for comp in ["gateway", "functions"] {
            // hook variables missing: UNHEALTHY (20), nothing started or stopped
            std::fs::write(roots.gotrue_env(), "PORT=47301
").unwrap();
            let inst = load_installed(&roots).unwrap();
            for r in [start_locked(&roots, &rt, &inst, Some(comp), &wait), restart_locked(&roots, &rt, &inst, Some(comp), &wait), start_checked_locked(&roots, &rt, &inst, Some(comp), &wait, &|_, _| Ok(()))] {
                let e = r.unwrap_err();
                assert_eq!((e.code, e.code.exit()), (Code::Unhealthy, 20), "{comp}: {}", e.message);
            }
            // hook fine, failed canary on record: CANARY_FAILED (22) for start and restart (start_checked exists to prove it again)
            hook_env(&roots);
            put_failed_canary(&roots);
            for r in [start_locked(&roots, &rt, &inst, Some(comp), &wait), restart_locked(&roots, &rt, &inst, Some(comp), &wait)] {
                let e = r.unwrap_err();
                assert_eq!((e.code, e.code.exit()), (Code::CanaryFailed, 22), "{comp}: {}", e.message);
            }
            std::fs::remove_file(roots.canary_json()).unwrap();
        }
        // restarting Rest also restarts Functions and the Gateway, which bring Auth with them
        std::fs::write(roots.gotrue_env(), "PORT=47301
").unwrap();
        let inst = load_installed(&roots).unwrap();
        assert_eq!(restart_locked(&roots, &rt, &inst, Some("rest"), &wait).unwrap_err().code, Code::Unhealthy);
        assert!(rt.calls.borrow().is_empty(), "a refused command starts and stops nothing: {:?}", rt.calls.borrow());
    }

    // C1: stopping ONE component takes its dependents down first (the SCM refuses with 1051 otherwise)
    #[test]
    fn stopping_one_component_stops_its_dependents_first() {
        let (_d, roots) = installed_root();
        let scm = Scm::all_running();
        stop(&roots, &scm, Some("Auth")).unwrap();
        assert_eq!(*scm.calls.borrow(), vec!["stop Gateway", "stop Functions", "stop Auth"]);
        assert_eq!(*scm.running.borrow(), vec![Component::Postgres, Component::Rest]);
    }

    // C1 + I3: restart --component ends with everything it stopped running again, in start order, each behind its health gate
    #[test]
    fn restarting_one_component_brings_every_stopped_dependent_back_behind_a_health_gate() {
        let (_d, roots) = installed_root();
        hook_env(&roots);
        let scm = Scm::all_running();
        let waited = RefCell::new(Vec::new());
        let healthy = |c: Component, _: &Installed| {
            waited.borrow_mut().push(c.short().to_string());
            Some(1u64)
        };
        let out = restart_with(&roots, &scm, Some("Auth"), &healthy).unwrap();
        assert_eq!(out.code, Code::Ok);
        assert_eq!(*scm.calls.borrow(), vec!["stop Gateway", "stop Functions", "stop Auth", "start Auth", "start Functions", "start Gateway"]);
        assert_eq!(*waited.borrow(), vec!["Auth", "Functions", "Gateway"]);
        assert_eq!(scm.running.borrow().len(), 5);
    }

    #[test]
    fn a_component_that_never_turns_healthy_is_unhealthy_and_stops_the_start_sequence() {
        let (_d, roots) = installed_root();
        hook_env(&roots);
        let scm = Scm::all_running();
        let never = |c: Component, _: &Installed| if c == Component::Functions { None } else { Some(1u64) };
        let e = restart_with(&roots, &scm, Some("Rest"), &never).unwrap_err();
        assert_eq!(e.code, Code::Unhealthy);
        assert!(e.message.contains("Functions"));
        assert!(!scm.calls.borrow().contains(&"start Gateway".to_string()));
    }

    #[test]
    fn stop_goes_dependents_first_and_a_held_lock_refuses_with_lock_held() {
        let (_d, roots) = installed_root();
        let rt = Log::default();
        stop(&roots, &rt, None).unwrap();
        assert_eq!(*rt.calls.borrow(), vec!["stop Gateway", "stop Functions", "stop Rest", "stop Auth", "stop Postgres"]);
        // the lock is released between commands
        stop(&roots, &rt, Some("Rest")).unwrap();
        let held = acquire_for(&roots, LockMode::Exclusive, "update", "op", Duration::from_secs(0)).unwrap();
        let before = rt.calls.borrow().len();
        let e = restart(&roots, &rt, Some("Rest")).unwrap_err();
        assert_eq!(e.code, Code::LockHeld);
        assert_eq!(rt.calls.borrow().len(), before, "a refused command touches nothing");
        drop(held);
    }

    // ---- F3 I2/I4: a gated stack comes back only through `start`, and only after the canary passes

    fn put_failed_canary(roots: &Roots) {
        std::fs::write(roots.canary_json(), json!({"userId": "00000000-0000-4000-8000-0000000000aa", "email": "x@barpos.local", "lastOk": false, "lastRunAt": "2026-10-02T03:00:00Z"}).to_string()).unwrap();
    }

    #[test]
    fn start_refuses_after_a_failed_canary_and_a_passing_or_absent_record_does_not() {
        let (_d, roots) = installed_root();
        hook_env(&roots);
        put_failed_canary(&roots);
        let rt = Log::default();
        let e = start(&roots, &rt, None).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::CanaryFailed, 22));
        assert!(rt.calls.borrow().is_empty(), "nothing is started or stopped");
        let e = restart(&roots, &rt, Some("Auth")).unwrap_err();
        assert_eq!(e.code, Code::CanaryFailed);
        std::fs::write(roots.canary_json(), json!({"lastOk": true}).to_string()).unwrap();
        assert_eq!(start(&roots, &Log::default(), Some("Auth")).unwrap_err().code, Code::Error, "the gate passed; the Log runtime refuses to start");
    }

    #[test]
    fn start_checked_starts_then_proves_the_lockout_and_a_failing_canary_stops_the_stack_again() {
        let (_d, roots) = installed_root();
        hook_env(&roots);
        put_failed_canary(&roots);
        let inst = load_installed(&roots).unwrap();
        let fresh = || {
            let s = test_support::Scm::all_running();
            s.running.borrow_mut().clear();
            s
        };
        // passes: started in order, the canary ran after the last start
        let scm = fresh();
        let calls_at_canary = std::cell::Cell::new(0);
        let out = start_checked_locked(&roots, &scm, &inst, None, &|_, _| Some(1), &|_, _| {
            calls_at_canary.set(scm.calls.borrow().len());
            Ok(())
        });
        assert!(out.is_ok(), "{:?}", out.err().map(|e| e.message));
        assert_eq!(calls_at_canary.get(), 5, "the canary ran after all five starts");
        // fails: the stack is gated again (manual start, stopped dependents first)
        let scm = fresh();
        let e = start_checked_locked(&roots, &scm, &inst, None, &|_, _| Some(1), &|_, _| Err(PosctlError::new(Code::CanaryFailed, "hook not active"))).unwrap_err();
        assert_eq!(e.code, Code::CanaryFailed);
        let calls = scm.calls.borrow().clone();
        assert_eq!(calls[calls.len() - 3..], ["stop Gateway", "stop Functions", "stop Auth"]);
        assert_eq!(scm.start_types.borrow()[scm.start_types.borrow().len() - 3..], ["Gateway=demand", "Functions=demand", "Auth=demand"]);
        // a canary error that is not a verdict leaves what was started running
        let scm = fresh();
        let e = start_checked_locked(&roots, &scm, &inst, None, &|_, _| Some(1), &|_, _| Err(PosctlError::error("timed out"))).unwrap_err();
        assert_eq!(e.code, Code::Error);
        assert!(!scm.calls.borrow().iter().any(|c| c.starts_with("stop")));
    }

    #[test]
    fn start_restores_automatic_start_for_what_it_starts() {
        let (_d, roots) = installed_root();
        hook_env(&roots);
        let inst = load_installed(&roots).unwrap();
        let scm = test_support::Scm::all_running();
        scm.running.borrow_mut().clear();
        start_locked(&roots, &scm, &inst, None, &|_, _| Some(1)).unwrap();
        assert_eq!(scm.start_types.borrow().len(), 5);
        assert!(scm.start_types.borrow().iter().all(|t| t.ends_with("=auto")));
        let scm = test_support::Scm::all_running();
        scm.running.borrow_mut().clear();
        start_locked(&roots, &scm, &inst, Some("Rest"), &|_, _| Some(1)).unwrap();
        assert_eq!(*scm.start_types.borrow(), ["Rest=auto"]);
    }

    #[test]
    fn the_gate_skips_what_is_not_installed_sets_manual_for_all_else_and_stops_only_what_runs() {
        let scm = test_support::Scm::all_running();
        scm.running.borrow_mut().retain(|c| !matches!(c, Component::Functions | Component::Gateway)); // not installed / already stopped
        let state = |c: Component| match c {
            Component::Functions => ServiceState::NotInstalled,
            Component::Gateway => ServiceState::Stopped,
            _ => ServiceState::Running,
        };
        let r = gate_sign_in_stack(&scm, &state);
        assert!(r.stop_failed.is_empty() && r.start_type_failed.is_empty());
        assert_eq!(*scm.calls.borrow(), ["stop Auth"]);
        assert_eq!(*scm.start_types.borrow(), ["Gateway=demand", "Auth=demand"]);
    }

    #[test]
    fn stop_needs_no_pack_verification_but_start_refuses_a_corrupted_pack() {
        let d = tempfile::tempdir().unwrap();
        let roots = crate::packcmd::fixtures::signed_root(&d, true);
        let auth = roots.pack_dir("1.0.0-r1").unwrap().join("bin").join("auth.exe");
        let mut b = std::fs::read(&auth).unwrap();
        b[0] ^= 1; // same size: only a Full load sees it
        std::fs::write(&auth, b).unwrap();
        let rt = Log::default();
        let e = start(&roots, &rt, None).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid, "{}", e.message);
        assert!(rt.calls.borrow().is_empty(), "nothing is started from a pack that does not verify");
        // an operator must be able to stop the stack whatever state the pack folder is in
        let scm = Scm::all_running();
        stop(&roots, &scm, None).expect("stop works with a corrupted pack");
        assert_eq!(*scm.calls.borrow(), ["stop Gateway", "stop Functions", "stop Rest", "stop Auth", "stop Postgres"]);
        std::fs::remove_dir_all(roots.pack_dir("1.0.0-r1").unwrap()).unwrap();
        let scm = Scm::all_running();
        stop(&roots, &scm, Some("Gateway")).expect("stop works with no pack at all");
        assert_eq!(*scm.calls.borrow(), ["stop Gateway"]);
        // but an unprovisioned PC is still refused
        std::fs::remove_file(roots.provisioned_json()).unwrap();
        assert_eq!(stop(&roots, &Scm::all_running(), None).unwrap_err().code, Code::NotProvisioned);
    }
}
