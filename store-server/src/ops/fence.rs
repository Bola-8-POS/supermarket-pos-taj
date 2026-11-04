//! Service control rules and the Caddy maintenance swap of the persistent fence.
//! The fence survives a power cut on purpose. Three artefacts carry it, all on disk or in the catalog:
//! `conf\Caddyfile` holds the maintenance config with the live one in `conf\Caddyfile.live`; the service roles are
//! NOLOGIN in `pg_authid`; the SCM failure actions are empty in the service registry. A rebooted server stays fenced
//! until `update --recover` has decided. The service names, the SCM calls and their health gates already exist in
//! `services`; this module adds only the maintenance-time rules over them.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::services::{self, Component};
use std::path::PathBuf;

pub const ALL_FIVE: [Component; 5] = Component::ALL;
/// Last-started first: the gateway goes before the services it depends on.
pub const STOP_ORDER: [Component; 4] = [Component::Gateway, Component::Functions, Component::Rest, Component::Auth];
pub const START_ORDER: [Component; 3] = [Component::Auth, Component::Rest, Component::Functions];
/// How long the SCM is given to bring a service to RUNNING / to STOPPED.
pub const SC_START_SECS: u64 = 90;
pub const SC_STOP_SECS: u64 = 60;

pub fn sc_failure_none(c: Component) -> Vec<String> { services::sc_failure_none_args(c) }
/// conventions 4.1: reset 3600 s, 5 s restarts (a 86400 s reset escalated to 30 s and the gateway looped, S9)
pub fn sc_failure_policy(c: Component) -> Vec<String> { services::sc_failure_args(c) }
pub fn sc_failureflag(c: Component, on: bool) -> Vec<String> {
    if on { services::sc_failureflag_args(c) } else { vec!["failureflag".into(), c.service_name().into(), "0".into()] }
}
/// While fenced the gateway must start without dragging Auth/Rest/Functions up with it (and `sc stop` of them
/// must not be refused for a running dependent).
pub fn sc_gateway_depend(restore: bool) -> Vec<String> {
    let value = if restore {
        Component::Gateway.depends_on().iter().map(|d| d.service_name()).collect::<Vec<_>>().join("/")
    } else { "/".to_string() };
    vec!["config".into(), Component::Gateway.service_name().into(), "depend=".into(), value]
}

/// Runs `sc.exe <args>`; a non-zero exit is an error. sc output carries service names only, never a secret.
pub fn sc_run(args: &[String]) -> R<()> {
    let o = services::sc(args).map_err(|e| OpError::err("SC_SPAWN", e.to_string()))?;
    if o.success() { Ok(()) } else {
        Err(OpError::err("SC_FAILED", format!("sc {} {} failed ({}): {}", args.first().map(String::as_str).unwrap_or(""),
            args.get(1).map(String::as_str).unwrap_or(""), o.code, o.text().trim())))
    }
}

/// Every role the stack logs in as (render.rs: Auth connects as `supabase_auth_admin`, PostgREST as `authenticator`;
/// Functions and the gateway use no database role). These are the roles the fence turns NOLOGIN. A test in
/// `render` keeps this list a superset of the users in the rendered service configs.
pub const SERVICE_DB_ROLES: [&str; 2] = ["authenticator", "supabase_auth_admin"];

/// The services whose start type the fence sets to on-demand: a reboot must not bring them back while an operation
/// is undecided. The Gateway stays automatic (it serves the 503 STORE_UPDATING answers).
pub const DEMAND_WHILE_FENCED: [Component; 3] = [Component::Auth, Component::Rest, Component::Functions];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartType { Auto, Demand }
impl StartType {
    fn word(self) -> &'static str { match self { StartType::Auto => "auto", StartType::Demand => "demand" } }
    fn parse(s: &str) -> Option<StartType> { match s { "auto" => Some(StartType::Auto), "demand" => Some(StartType::Demand), _ => None } }
}

/// The service control manager as the fence needs it: a seam so the SCM rules are testable without a real service.
pub trait Scm {
    /// `sc.exe <args>`; non-zero exit is an error.
    fn sc(&self, args: &[String]) -> R<()>;
    fn start(&self, c: Component) -> R<()>;
    fn stop(&self, c: Component) -> R<()>;
    /// `None` for a type the fence does not manage (disabled, boot, system) or a service that is not installed.
    fn start_type(&self, c: Component) -> R<Option<StartType>>;
    fn set_start_type(&self, c: Component, t: StartType) -> R<()>;
}

pub struct WindowsScm;
impl Scm for WindowsScm {
    fn sc(&self, args: &[String]) -> R<()> { sc_run(args) }
    fn start(&self, c: Component) -> R<()> { services::start(c, std::time::Duration::from_secs(SC_START_SECS)).map_err(|e| OpError::err("SC_START", e)) }
    fn stop(&self, c: Component) -> R<()> { services::stop(c, std::time::Duration::from_secs(SC_STOP_SECS)).map_err(|e| OpError::err("SC_STOP", e)) }
    fn start_type(&self, c: Component) -> R<Option<StartType>> {
        Ok(match crate::sys::service_start_type(c.service_name()).map_err(|e| OpError::err("SC_QUERY", e))? {
            Some(2) => Some(StartType::Auto),
            Some(3) => Some(StartType::Demand),
            _ => None,
        })
    }
    fn set_start_type(&self, c: Component, t: StartType) -> R<()> {
        services::set_start_type(c, t == StartType::Auto).map_err(|e| OpError::err("SC_CONFIG", e))
    }
}

/// The SCM half of the fence, in one place so it can be applied again after anything that re-registers the services
/// (`conf::activate` sets start=auto, the restart actions, failureflag 1 and the gateway dependencies back).
/// Persistent: the SCM registry carries it across a reboot. The start types found BEFORE the first change are written
/// to `sidecar` (a repeat never overwrites an entry, or it would record the fence's own `demand`, or the `auto` that
/// a re-registration put back; a service missing from an existing record is added) and `scm_unfence` restores exactly those.
/// Sidecar shape: `{"schema":1,"types":{"Auth":"auto","Rest":"demand","Functions":"auto"}}`.
pub fn scm_fence(scm: &dyn Scm, sidecar: &std::path::Path) -> R<()> {
    for c in ALL_FIVE { scm.sc(&sc_failure_none(c))?; scm.sc(&sc_failureflag(c, false))?; }
    scm.sc(&sc_gateway_depend(false))?;
    // Record the pre-demand start type of every managed service the sidecar does not already name. An existing entry is never
    // overwritten (it would record the fence's own `demand`), but an empty or stale record is completed, or unfence would
    // restore nothing for the services it left on demand.
    let existed = sidecar.exists();
    let known = std::fs::read_to_string(sidecar).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("types").and_then(|t| t.as_object()).cloned());
    // an unreadable record is left alone: unfence restores the automatic default for it and warns
    if !existed || known.is_some() {
        let mut map = known.unwrap_or_default();
        let mut changed = !existed;
        for c in DEMAND_WHILE_FENCED {
            if map.contains_key(c.short()) { continue; }
            if let Some(t) = scm.start_type(c)? { map.insert(c.short().to_string(), t.word().into()); changed = true; }
        }
        if changed {
            let body = serde_json::to_vec_pretty(&serde_json::json!({"schema": 1, "types": map})).map_err(|e| OpError::err("FENCE_TYPES_IO", e.to_string()))?;
            crate::util::write_atomic(sidecar, &body).map_err(|e| OpError::err("FENCE_TYPES_IO", e.to_string()))?;
        }
    }
    // Demand for EVERY managed service, whatever the sidecar says (an empty or stale record must not leave one on automatic start);
    // a disabled or absent service (`start_type` None) is not touched.
    for c in DEMAND_WHILE_FENCED {
        if scm.start_type(c)?.is_some() { scm.set_start_type(c, StartType::Demand)?; }
    }
    Ok(())
}

/// Recovery policy and dependencies back, then the start types recorded by `scm_fence`.
/// Restores the recorded start types and the recovery policy, then deletes the sidecar. `Some("FENCE_SIDECAR_CORRUPT")` = the
/// record could not be trusted, so every managed service went back to automatic (the product default); the caller reports it.
pub fn scm_unfence(scm: &dyn Scm, sidecar: &std::path::Path) -> R<Option<&'static str>> {
    let warning = scm_unfence_keep(scm, sidecar)?;
    match std::fs::remove_file(sidecar) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(OpError::err("FENCE_TYPES_IO", e.to_string())),
        _ => Ok(warning),
    }
}
/// `scm_unfence` without deleting the sidecar: the caller deletes it last.
pub fn scm_unfence_keep(scm: &dyn Scm, sidecar: &std::path::Path) -> R<Option<&'static str>> {
    for c in ALL_FIVE { scm.sc(&sc_failure_policy(c))?; scm.sc(&sc_failureflag(c, true))?; }
    scm.sc(&sc_gateway_depend(true))?;
    let (rec, warning) = match recorded_types(sidecar) {
        Recorded::Absent => (vec![], None),
        Recorded::Valid(v) => (v, None),
        // an unreadable record restores the product default (automatic) rather than leaving the stack on demand forever
        Recorded::Corrupt => (DEMAND_WHILE_FENCED.iter().map(|c| (*c, StartType::Auto)).collect(), Some("FENCE_SIDECAR_CORRUPT")),
    };
    for (c, t) in rec { scm.set_start_type(c, t)?; }
    Ok(warning)
}

enum Recorded { Absent, Valid(Vec<(Component, StartType)>), Corrupt }

/// Corrupt = unreadable, not JSON, no `types` object, or a value other than auto/demand. `{"schema":1,"types":{}}` is valid and
/// restores nothing.
fn recorded_types(sidecar: &std::path::Path) -> Recorded {
    let text = match std::fs::read_to_string(sidecar) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Recorded::Absent,
        Err(_) => return Recorded::Corrupt,
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Recorded::Corrupt };
    let Some(types) = v.get("types").and_then(|t| t.as_object()) else { return Recorded::Corrupt };
    if types.values().any(|t| t.as_str().and_then(StartType::parse).is_none()) { return Recorded::Corrupt; }
    Recorded::Valid(DEMAND_WHILE_FENCED.iter().filter_map(|c| Some((*c, StartType::parse(types.get(c.short())?.as_str()?)?))).collect())
}

/// The steps that finish a fence an operation left behind. Real implementation: `commands::update`.
pub trait LeftoverSteps {
    fn roles_login(&self) -> R<()>;
    fn start_stack(&self) -> R<()>;
    fn probe_stack(&self) -> R<()>;
    fn gateway_live(&self) -> R<()>;
    fn restore_policy(&self) -> R<()>;
    fn delete_markers(&self) -> R<()>;
}

/// Finishes a fence with NO journal behind it: the operation finalized (the live database is the final one) and only the unfence
/// died. In this order, stopping at the first failure with RECOVERY_NEEDED and the gateway still in maintenance: the service roles
/// can log in, the internal stack runs (START_ORDER), a loopback probe says it answers, the recorded start types and the
/// recovery policy come back, and only then does the gateway go live (a reboot in between must not find a live gateway over demand-start
/// services); the markers (sidecar, set-aside Caddyfile) are deleted at the very end.
pub fn complete_unfence(w: &dyn LeftoverSteps) -> R<()> {
    let steps: [(&str, &dyn Fn() -> R<()>); 6] = [
        ("roles_login", &|| w.roles_login()), ("start_stack", &|| w.start_stack()), ("probe_stack", &|| w.probe_stack()),
        ("restore_policy", &|| w.restore_policy()), ("gateway_live", &|| w.gateway_live()), ("delete_markers", &|| w.delete_markers()),
    ];
    for (name, f) in steps {
        f().map_err(|e| OpError::new(OpCode::RecoveryNeeded, "LEFTOVER_UNFENCE_FAILED", format!("{name}: {} (the tills stay fenced; run `posctl update --recover` again)", e.message)))?;
    }
    Ok(())
}

/// A `Caddyfile.live` left behind with no journal (the operation that set it aside ended uncleanly): make it the active config
/// again and reload the gateway. A torn file is never restored; the live config is re-rendered into it first
/// (`regen`, i.e. `conf::activate`, which writes the live render to `Caddyfile.live` while that file exists).
pub fn restore_leftover_gateway(conf: &std::path::Path, scm: &dyn Scm, regen: &dyn Fn() -> Result<(), String>) -> R<()> {
    let c = CaddyFiles { conf: conf.to_path_buf() };
    if !c.fenced() { return Ok(()); }
    match c.restore_live() {
        Ok(()) => {}
        Err(e) if e.reason == "LIVE_CADDYFILE_TORN" => {
            regen().map_err(|m| OpError::err("LIVE_REGEN_FAILED", m))?;
            c.restore_live()?;
        }
        Err(e) => return Err(e),
    }
    scm.stop(Component::Gateway)?;
    scm.start(Component::Gateway)
    // the marker stays: it is deleted with the sidecar, last (`complete_unfence`)
}

/// Nothing but ASCII whitespace and NULs (empty, zero-filled, blank): what a file looks like after a write that never reached the
/// disk, and a config `caddy adapt` may accept while serving no sites at all.
fn torn(bytes: &[u8]) -> bool { bytes.iter().all(|b| *b == 0 || b.is_ascii_whitespace()) }

/// `conf\Caddyfile` is what the Gateway service runs. In place overwrites keep its ACL (Gateway SID read).
pub struct CaddyFiles { pub conf: PathBuf }
impl CaddyFiles {
    fn live_cfg(&self) -> PathBuf { self.conf.join("Caddyfile") }
    fn marker(&self) -> PathBuf { self.conf.join("Caddyfile.live") }
    fn maint(&self) -> PathBuf { self.conf.join("Caddyfile.maintenance") }
    pub fn fenced(&self) -> bool { self.marker().exists() }

    fn overwrite_in_place(&self, bytes: &[u8]) -> R<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(self.live_cfg())
            .map_err(|e| OpError::err("CADDY_IO", e.to_string()))?;
        f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| OpError::err("CADDY_IO", e.to_string()))
    }
    pub fn enter_maintenance(&self) -> R<()> {
        let io = |e: std::io::Error| OpError::err("CADDY_IO", e.to_string());
        let maint = std::fs::read(self.maint()).map_err(|_| OpError::new(OpCode::Precondition, "MAINTENANCE_CADDYFILE_MISSING",
            "conf\\Caddyfile.maintenance is missing; refusing to update without a way to tell the tills"))?;
        if !self.marker().exists() {
            // durable (flushed, then renamed into place): a power cut leaves the live copy complete or absent, never zero-filled
            let live = std::fs::read(self.live_cfg()).map_err(io)?;
            if torn(&live) {
                return Err(OpError::new(OpCode::Precondition, "LIVE_CADDYFILE_TORN", "conf\\Caddyfile is empty; refusing to fence over a config that cannot be restored"));
            }
            crate::util::write_atomic(&self.marker(), &live).map_err(io)?;
        }
        self.overwrite_in_place(&maint)
    }
    /// The set-aside live copy, or `None` when there is none. A torn one is `LIVE_CADDYFILE_TORN` (refused, never restored):
    /// callers that parse the copy first (`adapt_live`) must call this before, or a torn file is misreported as invalid.
    pub fn read_live(&self) -> R<Option<Vec<u8>>> {
        match std::fs::read(self.marker()) {
            Ok(live) if torn(&live) => Err(OpError::new(OpCode::RecoveryNeeded, "LIVE_CADDYFILE_TORN",
                "conf\\Caddyfile.live is empty or zero-filled (a power cut during the fence?); re-render the gateway config with `posctl pack activate` before reopening")),
            Ok(live) => Ok(Some(live)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(OpError::err("CADDY_IO", e.to_string())),
        }
    }
    pub fn restore_live(&self) -> R<()> {
        match self.read_live()? { Some(live) => self.overwrite_in_place(&live), None => Ok(()) }
    }
    pub fn drop_marker(&self) -> R<()> {
        match std::fs::remove_file(self.marker()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(OpError::err("CADDY_IO", e.to_string())),
            _ => Ok(()),
        }
    }
}


/// A registry of five services that interprets the same `sc` argument lists the real code sends.
#[cfg(test)]
pub mod fake_scm {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::rc::Rc;

    #[derive(Clone, Debug, PartialEq)]
    pub struct Svc { pub start: Option<StartType>, pub actions: String, pub flag: bool }
    #[derive(Clone, Debug)]
    pub struct State { pub svcs: BTreeMap<&'static str, Svc>, pub gateway_depend: String, pub running: BTreeSet<&'static str>, pub log: Vec<String> }

    const POLICY: &str = "restart/5000/restart/5000/restart/5000";
    const DEPENDS: &str = "SupermarketPOS-Functions/SupermarketPOS-Auth/SupermarketPOS-Rest";

    #[derive(Clone)]
    pub struct FakeScm(pub Rc<RefCell<State>>);
    impl FakeScm {
        /// Registered as `conf::activate` leaves them: automatic, restart policy, flag on, gateway depends on the stack.
        pub fn registered() -> FakeScm {
            let svcs = ALL_FIVE.iter().map(|c| (c.service_name(), Svc { start: Some(StartType::Auto), actions: POLICY.into(), flag: true })).collect();
            FakeScm(Rc::new(RefCell::new(State { svcs, gateway_depend: DEPENDS.into(), running: BTreeSet::new(), log: vec![] })))
        }
        pub fn set_type(&self, c: Component, t: StartType) { self.0.borrow_mut().svcs.get_mut(c.service_name()).unwrap().start = Some(t); }
        pub fn type_of(&self, c: Component) -> Option<StartType> { self.0.borrow().svcs[c.service_name()].start }
        /// What `conf::activate` -> `services::register` does to every service (services.rs register, sc_create/config args).
        pub fn re_register(&self) {
            let mut s = self.0.borrow_mut();
            for v in s.svcs.values_mut() { v.start = Some(StartType::Auto); v.actions = POLICY.into(); v.flag = true; }
            s.gateway_depend = DEPENDS.into();
        }
        pub fn is_fenced(&self) -> bool {
            let s = self.0.borrow();
            s.svcs.values().all(|v| v.actions.is_empty() && !v.flag) && s.gateway_depend == "/"
                && DEMAND_WHILE_FENCED.iter().all(|c| s.svcs[c.service_name()].start == Some(StartType::Demand))
                && s.svcs[Component::Gateway.service_name()].start == Some(StartType::Auto)
        }
        pub fn policy_restored(&self) -> bool {
            let s = self.0.borrow();
            s.svcs.values().all(|v| v.actions == POLICY && v.flag) && s.gateway_depend == DEPENDS
        }
    }
    impl Scm for FakeScm {
        fn sc(&self, a: &[String]) -> R<()> {
            let mut s = self.0.borrow_mut();
            s.log.push(a.join(" "));
            let name = |n: &str| ALL_FIVE.iter().map(|c| c.service_name()).find(|x| *x == n).ok_or_else(|| OpError::err("SC_FAILED", "unknown service"));
            match a.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                ["failure", n, "reset=", _, "actions=", acts] => { let n = name(n)?; s.svcs.get_mut(n).unwrap().actions = acts.to_string(); }
                ["failureflag", n, v] => { let n = name(n)?; s.svcs.get_mut(n).unwrap().flag = *v == "1"; }
                ["config", n, "depend=", v] if *n == Component::Gateway.service_name() => { s.gateway_depend = v.to_string(); }
                other => return Err(OpError::err("SC_FAILED", format!("fake scm: unmodelled {other:?}"))),
            }
            Ok(())
        }
        fn start(&self, c: Component) -> R<()> { let mut s = self.0.borrow_mut(); s.log.push(format!("start {}", c.short())); s.running.insert(c.service_name()); Ok(()) }
        fn stop(&self, c: Component) -> R<()> { let mut s = self.0.borrow_mut(); s.log.push(format!("stop {}", c.short())); s.running.remove(c.service_name()); Ok(()) }
        fn start_type(&self, c: Component) -> R<Option<StartType>> { Ok(self.type_of(c)) }
        fn set_start_type(&self, c: Component, t: StartType) -> R<()> { self.set_type(c, t); Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::Component as C;

    #[test]
    fn stop_order_is_reverse_dependency_order_and_start_order_is_forward() {
        assert_eq!(STOP_ORDER, [C::Gateway, C::Functions, C::Rest, C::Auth]);
        assert_eq!(START_ORDER, [C::Auth, C::Rest, C::Functions]);
    }

    #[test]
    fn recovery_is_suspended_with_an_empty_action_list_and_restored_to_the_policy_of_conventions_4_1() {
        assert_eq!(sc_failure_none(C::Rest), ["failure", "SupermarketPOS-Rest", "reset=", "0", "actions=", ""]);
        assert_eq!(sc_failure_policy(C::Rest),
            ["failure", "SupermarketPOS-Rest", "reset=", "3600", "actions=", "restart/5000/restart/5000/restart/5000"]);
        assert_eq!(sc_failureflag(C::Rest, true), ["failureflag", "SupermarketPOS-Rest", "1"]);
        assert_eq!(sc_failureflag(C::Rest, false), ["failureflag", "SupermarketPOS-Rest", "0"]);
    }

    #[test]
    fn the_gateway_loses_its_dependencies_while_fenced_and_gets_them_back() {
        assert_eq!(sc_gateway_depend(false), ["config", "SupermarketPOS-Gateway", "depend=", "/"]);
        assert_eq!(sc_gateway_depend(true), ["config", "SupermarketPOS-Gateway", "depend=", "SupermarketPOS-Functions/SupermarketPOS-Auth/SupermarketPOS-Rest"]);
    }

    #[test]
    fn the_fence_covers_all_five_services_including_the_database() {
        assert_eq!(ALL_FIVE, C::ALL);
    }

    #[test]
    fn entering_maintenance_keeps_the_live_config_and_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), "LIVE").unwrap();
        std::fs::write(d.path().join("Caddyfile.maintenance"), "MAINT").unwrap();
        let c = CaddyFiles { conf: d.path().to_path_buf() };
        c.enter_maintenance().unwrap();
        c.enter_maintenance().unwrap(); // a second call must NOT save MAINT as the live config
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "MAINT");
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile.live")).unwrap(), "LIVE");
        assert!(c.fenced());
        c.restore_live().unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "LIVE");
        assert!(c.fenced(), "the marker stays until the gateway is proven healthy");
        c.drop_marker().unwrap();
        assert!(!c.fenced());
        c.restore_live().unwrap(); // idempotent when nothing is fenced
        c.drop_marker().unwrap();  // and so is dropping an absent marker
    }

    #[test]
    fn a_rebooted_server_reads_the_maintenance_config_because_the_fence_is_on_disk() {
        // The Gateway service runs conf\Caddyfile. After enter_maintenance that FILE is the maintenance config and
        // the marker survives a power cut; a fresh CaddyFiles value (a new process) still sees the fence.
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), "LIVE").unwrap();
        std::fs::write(d.path().join("Caddyfile.maintenance"), "MAINT").unwrap();
        CaddyFiles { conf: d.path().to_path_buf() }.enter_maintenance().unwrap();
        let after_reboot = CaddyFiles { conf: d.path().to_path_buf() };
        assert!(after_reboot.fenced());
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "MAINT");
    }

    #[test]
    fn a_missing_maintenance_config_refuses_to_fence() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), "LIVE").unwrap();
        let c = CaddyFiles { conf: d.path().to_path_buf() };
        let e = c.enter_maintenance().unwrap_err();
        assert_eq!(e.reason, "MAINTENANCE_CADDYFILE_MISSING");
        assert!(!c.fenced(), "nothing was changed");
    }

    // ---- FR4: the SCM half of the fence (F1, F2) and the durable Caddy backup (F4) ----
    use super::fake_scm::FakeScm;

    fn sidecar(d: &tempfile::TempDir) -> std::path::PathBuf { d.path().join("fence-start-types.json") }

    #[test]
    fn the_scm_fence_closes_recovery_dependencies_and_start_types_and_unfence_restores_the_recorded_ones() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm.set_type(C::Rest, StartType::Demand); // the Health boot gate set this one manual on purpose
        scm_fence(&scm, &sidecar(&d)).unwrap();
        assert!(scm.is_fenced(), "{:?}", scm.0.borrow());
        let rec: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(sidecar(&d)).unwrap()).unwrap();
        assert_eq!(rec, serde_json::json!({"schema": 1, "types": {"Auth": "auto", "Rest": "demand", "Functions": "auto"}}));
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        assert!(scm.policy_restored());
        assert_eq!((scm.type_of(C::Auth), scm.type_of(C::Rest), scm.type_of(C::Functions), scm.type_of(C::Gateway)),
            (Some(StartType::Auto), Some(StartType::Demand), Some(StartType::Auto), Some(StartType::Auto)), "never a blind auto");
        assert!(!sidecar(&d).exists());
    }

    #[test]
    fn fencing_and_unfencing_again_change_nothing_more() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm.set_type(C::Functions, StartType::Demand);
        scm_fence(&scm, &sidecar(&d)).unwrap();
        let first = std::fs::read_to_string(sidecar(&d)).unwrap();
        scm_fence(&scm, &sidecar(&d)).unwrap();
        assert_eq!(std::fs::read_to_string(sidecar(&d)).unwrap(), first, "a repeat must not record the fence's own demand");
        assert!(scm.is_fenced());
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        assert_eq!(scm.type_of(C::Functions), Some(StartType::Demand));
        assert!(scm.policy_restored());
    }

    #[test]
    fn a_re_registration_undoes_the_fence_and_applying_it_again_still_restores_the_original_types() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm.set_type(C::Rest, StartType::Demand);
        scm_fence(&scm, &sidecar(&d)).unwrap();
        scm.re_register(); // conf::activate
        assert!(!scm.is_fenced(), "the model must reproduce the problem");
        scm_fence(&scm, &sidecar(&d)).unwrap();
        assert!(scm.is_fenced());
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        assert_eq!(scm.type_of(C::Rest), Some(StartType::Demand), "the type found before the first fence, not the auto that activate put back");
    }

    #[test]
    fn fence_demands_even_with_an_empty_or_stale_sidecar() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        std::fs::write(sidecar(&d), r#"{"schema":1,"types":{}}"#).unwrap(); // left by an earlier run, records nothing
        assert_eq!(scm.type_of(C::Auth), Some(StartType::Auto));
        scm_fence(&scm, &sidecar(&d)).unwrap();
        assert!(DEMAND_WHILE_FENCED.iter().all(|c| scm.type_of(*c) == Some(StartType::Demand)), "every managed service is demand while fenced, whatever the sidecar says");
        assert!(scm.is_fenced());
    }

    #[test]
    fn fence_then_unfence_with_an_empty_sidecar_puts_every_service_back() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm.set_type(C::Rest, StartType::Demand); // the operator's own choice before the update
        std::fs::write(sidecar(&d), r#"{"schema":1,"types":{}}"#).unwrap();
        scm_fence(&scm, &sidecar(&d)).unwrap();
        assert!(DEMAND_WHILE_FENCED.iter().all(|c| scm.type_of(*c) == Some(StartType::Demand)));
        assert_eq!(scm_unfence(&scm, &sidecar(&d)).unwrap(), None);
        assert_eq!(scm.type_of(C::Auth), Some(StartType::Auto), "Auth was automatic before");
        assert_eq!(scm.type_of(C::Functions), Some(StartType::Auto), "Functions was automatic before");
        assert_eq!(scm.type_of(C::Rest), Some(StartType::Demand), "Rest was on demand before");
    }

    #[test]
    fn a_stale_sidecar_is_completed_never_overwritten() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        std::fs::write(sidecar(&d), r#"{"schema":1,"types":{"Auth":"demand"}}"#).unwrap(); // stale: Auth only, and not what it is now
        scm_fence(&scm, &sidecar(&d)).unwrap();
        let rec: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(sidecar(&d)).unwrap()).unwrap();
        assert_eq!(rec["types"]["Auth"], "demand", "an existing entry is kept");
        assert_eq!(rec["types"]["Rest"], "auto");
        assert_eq!(rec["types"]["Functions"], "auto");
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        assert_eq!(scm.type_of(C::Auth), Some(StartType::Demand));
        assert_eq!(scm.type_of(C::Rest), Some(StartType::Auto));
        assert_eq!(scm.type_of(C::Functions), Some(StartType::Auto));
    }

    #[test]
    fn garbage_sidecar_restores_auto_and_warns() {
        for garbage in ["{ not json", "[]", r#"{"schema":1}"#, r#"{"schema":1,"types":[1]}"#, r#"{"schema":1,"types":{"Auth":"manual"}}"#, r#"{"schema":1,"types":{"Rest":7}}"#] {
            let d = tempfile::tempdir().unwrap();
            let scm = FakeScm::registered();
            scm.set_type(C::Rest, StartType::Demand);
            scm_fence(&scm, &sidecar(&d)).unwrap();
            std::fs::write(sidecar(&d), garbage).unwrap();
            let w = scm_unfence(&scm, &sidecar(&d)).unwrap();
            assert_eq!(w, Some("FENCE_SIDECAR_CORRUPT"), "{garbage}");
            assert!(DEMAND_WHILE_FENCED.iter().all(|c| scm.type_of(*c) == Some(StartType::Auto)), "{garbage}");
        }
        // an unreadable file is corrupt too
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm_fence(&scm, &sidecar(&d)).unwrap();
        std::fs::remove_file(sidecar(&d)).unwrap();
        std::fs::create_dir(sidecar(&d)).unwrap(); // a folder where the file should be
        assert_eq!(scm_unfence_keep(&scm, &sidecar(&d)).unwrap(), Some("FENCE_SIDECAR_CORRUPT"));
    }

    #[test]
    fn empty_types_is_valid_not_corrupt() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm_fence(&scm, &sidecar(&d)).unwrap();
        std::fs::write(sidecar(&d), r#"{"schema":1,"types":{}}"#).unwrap();
        scm.set_type(C::Rest, StartType::Demand); // someone's own choice: an empty record restores nothing
        assert_eq!(scm_unfence(&scm, &sidecar(&d)).unwrap(), None, "no warning");
        assert_eq!(scm.type_of(C::Rest), Some(StartType::Demand), "nothing was restored");
        assert!(scm.policy_restored());
        // and no sidecar at all is not corrupt either
        assert_eq!(scm_unfence(&scm, &sidecar(&d)).unwrap(), None);
    }

    #[test]
    fn an_unreadable_sidecar_restores_automatic_instead_of_leaving_the_stack_on_demand() {
        let d = tempfile::tempdir().unwrap();
        let scm = FakeScm::registered();
        scm_fence(&scm, &sidecar(&d)).unwrap();
        std::fs::write(sidecar(&d), "{ not json").unwrap();
        scm_unfence(&scm, &sidecar(&d)).unwrap();
        assert!(DEMAND_WHILE_FENCED.iter().all(|c| scm.type_of(*c) == Some(StartType::Auto)));
    }

    #[test]
    fn a_torn_or_empty_live_backup_is_never_restored_and_an_empty_live_config_is_never_backed_up() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), "MAINT").unwrap();
        let c = CaddyFiles { conf: d.path().to_path_buf() };
        for torn in [vec![], vec![0u8; 64]] {
            std::fs::write(d.path().join("Caddyfile.live"), &torn).unwrap();
            let e = c.restore_live().unwrap_err();
            assert_eq!(e.reason, "LIVE_CADDYFILE_TORN", "{torn:?}");
            assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "MAINT", "the active config is untouched");
        }
        let d2 = tempfile::tempdir().unwrap();
        std::fs::write(d2.path().join("Caddyfile"), "").unwrap();
        std::fs::write(d2.path().join("Caddyfile.maintenance"), "MAINT").unwrap();
        let c2 = CaddyFiles { conf: d2.path().to_path_buf() };
        assert_eq!(c2.enter_maintenance().unwrap_err().reason, "LIVE_CADDYFILE_TORN");
        assert!(!c2.fenced(), "no marker from an empty file");
    }

    #[test]
    fn a_whitespace_only_live_config_counts_as_torn() {
        // caddy adapt may accept a blank config and bring the gateway up with no sites: a silent outage reported as success
        for blank in [&b"  \t\r\n"[..], b"\r\n\r\n", b"\0\0 \n\0", b" "] {
            let d = tempfile::tempdir().unwrap();
            std::fs::write(d.path().join("Caddyfile"), "MAINT").unwrap();
            std::fs::write(d.path().join("Caddyfile.live"), blank).unwrap();
            let c = CaddyFiles { conf: d.path().to_path_buf() };
            assert_eq!(c.restore_live().unwrap_err().reason, "LIVE_CADDYFILE_TORN", "{blank:?}");
            let d2 = tempfile::tempdir().unwrap();
            std::fs::write(d2.path().join("Caddyfile"), blank).unwrap();
            std::fs::write(d2.path().join("Caddyfile.maintenance"), "MAINT").unwrap();
            let c2 = CaddyFiles { conf: d2.path().to_path_buf() };
            assert_eq!(c2.enter_maintenance().unwrap_err().reason, "LIVE_CADDYFILE_TORN", "{blank:?}");
            assert!(!c2.fenced());
        }
    }

    #[test]
    fn the_live_backup_is_written_through_write_atomic_and_leaves_no_temp_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), "LIVE").unwrap();
        std::fs::write(d.path().join("Caddyfile.maintenance"), "MAINT").unwrap();
        CaddyFiles { conf: d.path().to_path_buf() }.enter_maintenance().unwrap();
        let mut names: Vec<String> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["Caddyfile", "Caddyfile.live", "Caddyfile.maintenance"]);
    }

    // ---- FR6 X1: a live Caddyfile left behind with no journal ----
    fn conf_with(active: &str, live: Option<&[u8]>) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("Caddyfile"), active).unwrap();
        if let Some(l) = live { std::fs::write(d.path().join("Caddyfile.live"), l).unwrap(); }
        d
    }

    #[test]
    fn x1_a_good_leftover_live_config_becomes_the_active_one_the_gateway_reloads_and_the_marker_goes() {
        let d = conf_with("MAINT", Some(b"LIVE"));
        let scm = FakeScm::registered();
        restore_leftover_gateway(d.path(), &scm, &|| panic!("a valid file is not re-rendered")).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "LIVE");
        assert!(d.path().join("Caddyfile.live").exists(), "deleted last, with the sidecar, not here");
        let log = scm.0.borrow().log.clone();
        assert!(log.iter().position(|l| l == "stop Gateway") < log.iter().position(|l| l == "start Gateway") && log.contains(&"start Gateway".to_string()), "{log:?}");
    }

    #[test]
    fn x1_a_torn_leftover_is_re_rendered_first_and_then_restored() {
        let d = conf_with("MAINT", Some(&[0u8; 32]));
        let scm = FakeScm::registered();
        let live = d.path().join("Caddyfile.live");
        restore_leftover_gateway(d.path(), &scm, &|| std::fs::write(&live, "FRESH").map_err(|e| e.to_string())).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "FRESH");
    }

    #[test]
    fn x1_when_the_re_render_fails_the_marker_and_the_active_file_stay_as_they_were() {
        let d = conf_with("MAINT", Some(&[0u8; 32]));
        let scm = FakeScm::registered();
        let e = restore_leftover_gateway(d.path(), &scm, &|| Err("no".into())).unwrap_err();
        assert_eq!(e.reason, "LIVE_REGEN_FAILED");
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "MAINT");
        assert!(d.path().join("Caddyfile.live").exists());
    }

    #[test]
    fn x1_without_a_marker_nothing_is_touched() {
        let d = conf_with("LIVE", None);
        let scm = FakeScm::registered();
        restore_leftover_gateway(d.path(), &scm, &|| panic!("nothing to render")).unwrap();
        assert!(scm.0.borrow().log.is_empty());
        assert_eq!(std::fs::read_to_string(d.path().join("Caddyfile")).unwrap(), "LIVE");
    }

    // ---- FR7 U ----
    struct Rec { calls: std::cell::RefCell<Vec<&'static str>>, fail_at: Option<&'static str> }
    impl Rec {
        fn step(&self, n: &'static str) -> R<()> {
            self.calls.borrow_mut().push(n);
            if self.fail_at == Some(n) { Err(OpError::err("PSQL_FAILED", "boom")) } else { Ok(()) }
        }
    }
    impl LeftoverSteps for Rec {
        fn roles_login(&self) -> R<()> { self.step("roles_login") }
        fn start_stack(&self) -> R<()> { self.step("start_stack") }
        fn probe_stack(&self) -> R<()> { self.step("probe_stack") }
        fn gateway_live(&self) -> R<()> { self.step("gateway_live") }
        fn restore_policy(&self) -> R<()> { self.step("restore_policy") }
        fn delete_markers(&self) -> R<()> { self.step("delete_markers") }
    }

    #[test]
    fn u_the_leftover_fence_is_finished_in_the_order_the_gateway_goes_live_last() {
        let r = Rec { calls: Default::default(), fail_at: None };
        complete_unfence(&r).unwrap();
        assert_eq!(*r.calls.borrow(), ["roles_login", "start_stack", "probe_stack", "restore_policy", "gateway_live", "delete_markers"]);
    }

    #[test]
    fn u_a_failure_before_the_gateway_leaves_it_in_maintenance_and_needs_recovery() {
        for fail in ["roles_login", "start_stack", "probe_stack", "restore_policy"] {
            let r = Rec { calls: Default::default(), fail_at: Some(fail) };
            let e = complete_unfence(&r).unwrap_err();
            assert_eq!((e.code, e.reason.as_str()), (OpCode::RecoveryNeeded, "LEFTOVER_UNFENCE_FAILED"), "{fail}: {e:?}");
            let calls = r.calls.borrow();
            assert_eq!(calls.last(), Some(&fail), "stops at the failing step");
            assert!(!calls.contains(&"gateway_live") && !calls.contains(&"delete_markers"), "{fail}: the gateway must stay in maintenance and the markers stay: {calls:?}");
        }
    }

    #[test]
    fn u_a_failure_after_the_gateway_keeps_the_markers() {
        let r = Rec { calls: Default::default(), fail_at: Some("gateway_live") };
        let e = complete_unfence(&r).unwrap_err();
        assert_eq!(e.code, OpCode::RecoveryNeeded);
        assert!(!r.calls.borrow().contains(&"delete_markers"));
    }
}
