//! The five Windows services (conventions section 4.1): one Shawl-wrapped service per component,
//! each under its own `NT SERVICE\<name>` virtual account. Everything that builds a command line
//! is a pure function with a test; the functions at the bottom only run `sc.exe`.
//!
//! Binding mitigations of Objection O1 (Shawl): no secret ever goes in a Shawl `--env` (the values
//! land in the service's binPath, readable with `sc qc`); PostgREST gets `--pass 0,252` because it
//! exits 252 on Ctrl-C; Postgres gets a 30 s stop timeout; log rotation is set explicitly (Q9).
//! It must never put a secret on a command line or in a Shawl `--env`, and never register a service outside `SupermarketPOS-*`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::acl::service_sid;
use crate::exec::{Cmd, ExecError};
use crate::paths::Roots;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Component {
    Postgres,
    Auth,
    Rest,
    Functions,
    Gateway,
}

impl Component {
    /// Start order (a component only depends on earlier ones). Stop order is the reverse.
    pub const ALL: [Component; 5] = [Component::Postgres, Component::Auth, Component::Rest, Component::Functions, Component::Gateway];

    pub fn service_name(self) -> &'static str {
        match self {
            Component::Postgres => "SupermarketPOS-Postgres",
            Component::Auth => "SupermarketPOS-Auth",
            Component::Rest => "SupermarketPOS-Rest",
            Component::Functions => "SupermarketPOS-Functions",
            Component::Gateway => "SupermarketPOS-Gateway",
        }
    }
    pub fn display_name(self) -> &'static str {
        match self {
            Component::Postgres => "Supermarket POS Database",
            Component::Auth => "Supermarket POS Sign-in",
            Component::Rest => "Supermarket POS Data API",
            Component::Functions => "Supermarket POS Functions",
            Component::Gateway => "Supermarket POS Gateway",
        }
    }
    /// The key used in `status.json` (`services.Postgres`, ...) and in `--component`.
    pub fn short(self) -> &'static str {
        match self {
            Component::Postgres => "Postgres",
            Component::Auth => "Auth",
            Component::Rest => "Rest",
            Component::Functions => "Functions",
            Component::Gateway => "Gateway",
        }
    }
    pub fn from_short(s: &str) -> Option<Component> {
        Component::ALL.into_iter().find(|c| c.short().eq_ignore_ascii_case(s))
    }
    pub fn account(self) -> String {
        format!("NT SERVICE\\{}", self.service_name())
    }
    pub fn sid(self) -> String {
        service_sid(self.service_name())
    }
    pub fn depends_on(self) -> &'static [Component] {
        match self {
            Component::Postgres => &[],
            Component::Auth | Component::Rest => &[Component::Postgres],
            Component::Functions => &[Component::Rest, Component::Auth],
            Component::Gateway => &[Component::Functions, Component::Auth, Component::Rest],
        }
    }
    pub fn stop_timeout_ms(self) -> u32 {
        if self == Component::Postgres { 30_000 } else { 10_000 }
    }
    /// Exit codes Shawl treats as success (PostgREST exits 252 on Ctrl-C).
    pub fn pass_codes(self) -> Option<&'static str> {
        if self == Component::Rest { Some("0,252") } else { None }
    }
}

pub const LOG_ROTATE: &str = "bytes=10485760";
pub const LOG_RETAIN: &str = "5";

/// `<exe> <args...>` after the `--`, as absolute paths (conventions 4.1, third column).
pub fn component_command(roots: &Roots, pack_dir: &Path, c: Component) -> Vec<String> {
    let p = |rel: &str| pack_dir.join(rel).display().to_string();
    match c {
        Component::Postgres => vec![p("pg\\bin\\postgres.exe"), "-D".into(), roots.pgdata().display().to_string()],
        Component::Auth => vec![p("bin\\auth.exe"), "-c".into(), roots.gotrue_env().display().to_string(), "serve".into()],
        Component::Rest => vec![p("bin\\postgrest.exe"), roots.postgrest_conf().display().to_string()],
        Component::Functions => vec![p("bin\\functions.exe")],
        Component::Gateway => vec![
            p("bin\\caddy.exe"),
            "run".into(),
            "--config".into(),
            roots.caddyfile().display().to_string(),
            "--adapter".into(),
            "caddyfile".into(),
        ],
    }
}

/// Non-secret environment for the component (Shawl `--env`). Secrets never appear here: the
/// Functions secrets live in the service's registry key, GoTrue and PostgREST read files.
pub fn component_env(roots: &Roots, c: Component) -> Vec<(String, String)> {
    let tmp = roots.tmp_for(c.service_name()).display().to_string();
    let mut v = vec![
        ("TEMP".to_string(), tmp.clone()),
        ("TMP".to_string(), tmp),
        ("SUPABASE_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("SUPABASE_NO_UPDATE_NOTIFIER".to_string(), "1".to_string()),
        ("DENO_NO_UPDATE_CHECK".to_string(), "1".to_string()),
    ];
    match c {
        Component::Gateway => {
            let xdg = roots.caddy_xdg().display().to_string();
            v.push(("XDG_DATA_HOME".to_string(), xdg.clone()));
            v.push(("XDG_CONFIG_HOME".to_string(), xdg));
        }
        Component::Functions => {
            v.push(("DENO_DIR".to_string(), roots.tmp_for(c.service_name()).join("deno").display().to_string()));
        }
        _ => {}
    }
    v
}

/// Everything after `shawl.exe` in the binPath: `run --name ... -- <command>`.
pub fn shawl_run_args(roots: &Roots, pack_dir: &Path, c: Component) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "run".into(),
        "--name".into(),
        c.service_name().into(),
        "--cwd".into(),
        roots.data.display().to_string(),
        "--no-restart".into(),
        "--kill-process-tree".into(),
        "--stop-timeout".into(),
        c.stop_timeout_ms().to_string(),
        "--log-dir".into(),
        roots.logs_for(c.service_name()).display().to_string(),
        "--log-rotate".into(),
        LOG_ROTATE.into(),
        "--log-retain".into(),
        LOG_RETAIN.into(),
    ];
    if let Some(codes) = c.pass_codes() {
        a.push("--pass".into());
        a.push(codes.into());
    }
    for (k, v) in component_env(roots, c) {
        a.push("--env".into());
        a.push(format!("{k}={v}"));
    }
    a.push("--".into());
    a.extend(component_command(roots, pack_dir, c));
    a
}

/// Quote one argument for a Windows command line (CommandLineToArgvW rules).
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

pub fn shawl_exe(pack_dir: &Path) -> PathBuf {
    pack_dir.join("bin").join("shawl.exe")
}

/// The full binPath string registered with the SCM.
pub fn bin_path(roots: &Roots, pack_dir: &Path, c: Component) -> String {
    let mut parts = vec![quote_arg(&shawl_exe(pack_dir).display().to_string())];
    parts.extend(shawl_run_args(roots, pack_dir, c).iter().map(|a| quote_arg(a)));
    parts.join(" ")
}

fn pair(a: &mut Vec<String>, key: &str, val: String) {
    a.push(key.to_string());
    a.push(val);
}

fn registration_pairs(roots: &Roots, pack_dir: &Path, c: Component, for_config: bool) -> Vec<String> {
    let mut a = Vec::new();
    pair(&mut a, "binPath=", bin_path(roots, pack_dir, c));
    pair(&mut a, "start=", "auto".into()); // not delayed-auto: delayed adds ~2 minutes and nothing waits on the network
    pair(&mut a, "obj=", c.account());
    pair(&mut a, "DisplayName=", c.display_name().into());
    let deps: Vec<&str> = c.depends_on().iter().map(|d| d.service_name()).collect();
    // `depend= /` clears the dependencies of an existing service; on create it is simply omitted.
    if !deps.is_empty() {
        pair(&mut a, "depend=", deps.join("/"));
    } else if for_config {
        pair(&mut a, "depend=", "/".into());
    }
    a
}

/// binPath of the one-shot service that runs `cmd /c <script>` as the Postgres virtual account
/// (initdb must run as that account so the cluster files belong to it). `cmd.exe` is the absolute
/// path under the system directory (from the API), so this fails closed when that cannot be resolved.
pub fn one_shot_bin_path(roots: &Roots, pack_dir: &Path, script: &Path) -> Result<String, String> {
    let c = Component::Postgres;
    let args = [
        "run".to_string(),
        "--name".into(),
        c.service_name().into(),
        "--cwd".into(),
        roots.data.display().to_string(),
        "--no-restart".into(),
        "--log-dir".into(),
        roots.logs_for(c.service_name()).display().to_string(),
        "--".into(),
        crate::sys::system_dir()?.join("cmd.exe").display().to_string(),
        "/c".into(),
        script.display().to_string(),
    ];
    Ok(std::iter::once(quote_arg(&shawl_exe(pack_dir).display().to_string()))
        .chain(args.iter().map(|a| quote_arg(a)))
        .collect::<Vec<_>>()
        .join(" "))
}

pub fn sc_create_args(roots: &Roots, pack_dir: &Path, c: Component) -> Vec<String> {
    let mut a = vec!["create".to_string(), c.service_name().to_string()];
    a.extend(registration_pairs(roots, pack_dir, c, false));
    a
}

pub fn sc_config_args(roots: &Roots, pack_dir: &Path, c: Component) -> Vec<String> {
    let mut a = vec!["config".to_string(), c.service_name().to_string()];
    a.extend(registration_pairs(roots, pack_dir, c, true));
    a
}

/// Restart after 5 s, three times; the failure counter resets after one hour (an 86400 s reset
/// escalated the third restart to 30 s and the gateway looped twelve times after boot).
pub fn sc_failure_args(c: Component) -> Vec<String> {
    ["failure", c.service_name(), "reset=", "3600", "actions=", "restart/5000/restart/5000/restart/5000"]
        .map(String::from)
        .to_vec()
}

/// A non-zero exit of the Shawl wrapper counts as a failure (PostgREST's 252 is mapped to 0 by `--pass`).
pub fn sc_failureflag_args(c: Component) -> Vec<String> {
    ["failureflag", c.service_name(), "1"].map(String::from).to_vec()
}

/// Maintenance (update, switch, restore): the SCM must not restart what the updater stopped.
/// Plan 07 owns the behaviour; the builder lives here beside the policy it undoes.
pub fn sc_failure_none_args(c: Component) -> Vec<String> {
    ["failure", c.service_name(), "reset=", "0", "actions=", ""].map(String::from).to_vec()
}

/// `sc config <svc> start= auto|demand`. The boot gate uses `demand` so a reboot cannot bring a gated sign-in
/// stack back; `posctl start` restores `auto`.
pub fn sc_start_type_args(c: Component, auto: bool) -> Vec<String> {
    vec!["config".into(), c.service_name().into(), "start=".into(), if auto { "auto" } else { "demand" }.into()]
}

pub fn set_start_type(c: Component, auto: bool) -> Result<(), String> {
    let args = sc_start_type_args(c, auto);
    let o = sc(&args).map_err(|e| e.to_string())?;
    if o.success() {
        Ok(())
    } else {
        Err(format!("sc config {} start= failed ({}): {}", c.service_name(), o.code, o.text().trim()))
    }
}

pub fn sc_simple_args(verb: &str, c: Component) -> Vec<String> {
    vec![verb.to_string(), c.service_name().to_string()]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceState {
    NotInstalled,
    Stopped,
    StartPending,
    StopPending,
    Running,
    Other(String),
}

pub const SC_NOT_INSTALLED: i32 = 1060;
pub const SC_ALREADY_EXISTS: i32 = 1073;

impl ServiceState {
    /// Maps `SERVICE_STATUS.dwCurrentState` (1 stopped, 2 start pending, 3 stop pending, 4 running;
    /// anything else `Other`). Replaces parsing the localized `STATE` label of `sc query`.
    pub fn from_scm(n: u32) -> ServiceState {
        match n {
            1 => ServiceState::Stopped,
            2 => ServiceState::StartPending,
            3 => ServiceState::StopPending,
            4 => ServiceState::Running,
            other => ServiceState::Other(other.to_string()),
        }
    }
}

/// Shawl mitigation O1 / Q6: the value to write to `WaitToKillServiceTimeout`, or `None` when the
/// current one is already enough. Absent, non-numeric or below 30000 gives `"30000"`; a larger
/// value is never lowered. Pure; the registry access is `sys::wait_to_kill_get/set`.
pub fn wait_to_kill_target(current: Option<&str>) -> Option<String> {
    match current.and_then(|v| v.trim().parse::<u32>().ok()) {
        Some(n) if n >= 30_000 => None,
        _ => Some("30000".to_string()),
    }
}

/// The optional Plan 12 tunnel service (`repoint_optional` re-points it after a pack switch).
pub const TUNNEL_SERVICE: &str = "SupermarketPOS-Tunnel";

/// Rewrite every `<packs_dir>\<old version>\` in a service's binPath to `<packs_dir>\<new_version>\`;
/// `None` when nothing under `packs_dir` is referenced or the path already names `new_version`.
/// Pure; only paths under `packs\` are ever rewritten. (Lives here, beside the other binPath
/// builders, so `runtime` can use it before `conf` exists; `conf` re-uses it.)
pub fn repoint_bin_path(bin_path: &str, packs_dir: &Path, new_version: &str) -> Option<String> {
    // a pack version is digits, dots and `-r`: it cannot hold a quote, separator, whitespace or `..`
    crate::pack::parse_pack_version(new_version)?;
    let prefix = format!("{}\\", packs_dir.display());
    let mut out = String::new();
    let mut rest = bin_path;
    let mut changed = false;
    while let Some(i) = rest.find(&prefix) {
        out.push_str(&rest[..i + prefix.len()]);
        rest = &rest[i + prefix.len()..];
        let end = rest.find(|c: char| c == '\\' || c == '"' || c.is_whitespace()).unwrap_or(rest.len());
        if &rest[..end] != new_version {
            changed = true;
        }
        out.push_str(new_version);
        rest = &rest[end..];
    }
    out.push_str(rest);
    changed.then_some(out)
}

// ---------------------------------------------------------------------------------------------
// Impure: run sc.exe. Not unit-tested (needs an elevated machine); the Windows Sandbox
// scenarios in Plan 05b exercise every function below.
// ---------------------------------------------------------------------------------------------

fn sc_exe() -> Result<PathBuf, String> {
    Ok(crate::sys::system_dir()?.join("sc.exe")) // GetSystemDirectoryW, never %SystemRoot%
}
/// `c` plus every service that depends on it, directly or through another, in start order. `sc stop` refuses
/// (1051) while a dependent runs, so stopping one component means stopping this set, last-started first.
pub fn with_dependents(c: Component) -> Vec<Component> {
    let mut set: Vec<Component> = Vec::new();
    // ALL is a topological order (a service only depends on earlier ones), so one pass finds the closure
    for x in Component::ALL {
        if x == c || x.depends_on().iter().any(|d| set.contains(d)) {
            set.push(x);
        }
    }
    set
}

#[cfg(test)]
pub(crate) fn sc_exe_for_test() -> PathBuf {
    sc_exe().expect("system directory")
}

pub fn sc(args: &[String]) -> Result<crate::exec::ToolOutput, ExecError> {
    let exe = sc_exe().map_err(ExecError::Io)?;
    Cmd::new(exe).args(args.iter().cloned()).timeout(Duration::from_secs(60)).run()
}

/// Asks the SCM through `sys::service_state` (OpenService/QueryServiceStatus); no text parsing.
pub fn query_state(c: Component) -> Result<ServiceState, String> {
    crate::sys::service_state(c.service_name())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Registered {
    Created,
    Reconfigured,
}

/// Create (or, if it already exists, reconfigure) the service and set its failure policy.
pub fn register(roots: &Roots, pack_dir: &Path, c: Component) -> Result<Registered, String> {
    let created = sc(&sc_create_args(roots, pack_dir, c)).map_err(|e| e.to_string())?;
    let outcome = if created.success() {
        Registered::Created
    } else if created.code == SC_ALREADY_EXISTS {
        let cfg = sc(&sc_config_args(roots, pack_dir, c)).map_err(|e| e.to_string())?;
        if !cfg.success() {
            return Err(format!("sc config {} failed ({}): {}", c.service_name(), cfg.code, cfg.text().trim()));
        }
        Registered::Reconfigured
    } else {
        return Err(format!("sc create {} failed ({}): {}", c.service_name(), created.code, created.text().trim()));
    };
    for args in [sc_failure_args(c), sc_failureflag_args(c)] {
        let o = sc(&args).map_err(|e| e.to_string())?;
        if !o.success() {
            return Err(format!("sc {} failed ({}): {}", args[0], o.code, o.text().trim()));
        }
    }
    Ok(outcome)
}

pub fn wait_for_state(c: Component, want: &ServiceState, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if &query_state(c)? == want {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `sc stop` result: 0 and 1062 (service not started) are fine, anything else (access denied, a
/// dependent still running, ...) fails now instead of after a full wait for STOPPED.
pub fn stop_result(c: Component, code: i32, text: &str) -> Result<(), String> {
    if code == 0 || code == 1062 {
        Ok(())
    } else {
        Err(format!("sc stop {} failed ({code}): {}", c.service_name(), text.trim()))
    }
}

/// `sc delete` result. 1072 means an earlier delete is still pending because something holds a handle.
pub fn delete_result(c: Component, code: i32, text: &str) -> Result<(), String> {
    match code {
        0 | SC_NOT_INSTALLED => Ok(()),
        1072 => Err(format!(
            "{} is marked for deletion but still open elsewhere: close services.msc, Task Manager and anything else holding it, then retry (a reboot also completes the deletion)",
            c.service_name()
        )),
        _ => Err(format!("sc delete {} failed ({code}): {}", c.service_name(), text.trim())),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartWait {
    Done,
    KeepWaiting,
    /// Not running and not on its way: it exited (or vanished) after `sc start` was accepted.
    Died,
}

pub fn start_wait(state: &ServiceState) -> StartWait {
    match state {
        ServiceState::Running => StartWait::Done,
        ServiceState::StartPending | ServiceState::Other(_) => StartWait::KeepWaiting,
        ServiceState::Stopped | ServiceState::StopPending | ServiceState::NotInstalled => StartWait::Died,
    }
}

/// The one-shot (initdb) service may only be created or reconfigured while no service of that name
/// is running: reconfiguring a running service changes nothing for the live process, and starting it
/// would hit 1056 and report the real Postgres' exit as the script's.
pub fn one_shot_precheck(state: &ServiceState) -> Result<(), String> {
    match state {
        ServiceState::NotInstalled | ServiceState::Stopped => Ok(()),
        other => Err(format!("{} is {other:?}; stop it before running the one-shot initdb service", Component::Postgres.service_name())),
    }
}

/// A finished one-shot must be STOPPED with exit code 0: STOPPED alone also describes a script that failed.
pub fn one_shot_outcome(st: &crate::sys::ScmStatus) -> Result<(), String> {
    if st.state != 1 {
        return Err(format!("the one-shot service is still not stopped (state {})", st.state));
    }
    match (st.win32_exit, st.specific_exit) {
        (0, 0) => Ok(()),
        (1066, code) => Err(format!("the one-shot service failed with service-specific exit code {code}")),
        (code, _) => Err(format!("the one-shot service failed with exit code {code}")),
    }
}

/// Failure actions off for the one-shot: a failing script must not be restarted by the SCM.
pub fn one_shot_failure_args() -> Vec<String> {
    sc_failure_none_args(Component::Postgres)
}

/// `sc stop`, then wait for STOPPED. Not-installed and already-stopped are success; an `sc stop`
/// error other than "not started" is returned at once.
pub fn stop(c: Component, timeout: Duration) -> Result<(), String> {
    match query_state(c)? {
        ServiceState::NotInstalled | ServiceState::Stopped => return Ok(()),
        ServiceState::StopPending => {} // already going down: just wait
        _ => {
            let o = sc(&sc_simple_args("stop", c)).map_err(|e| e.to_string())?;
            stop_result(c, o.code, &o.text())?;
        }
    }
    if wait_for_state(c, &ServiceState::Stopped, timeout)? {
        Ok(())
    } else {
        Err(format!("{} did not reach STOPPED within {}s", c.service_name(), timeout.as_secs()))
    }
}

/// `sc start`, then wait for RUNNING (health gating is the caller's job: see `probe`).
pub fn start(c: Component, timeout: Duration) -> Result<(), String> {
    if query_state(c)? == ServiceState::Running {
        return Ok(());
    }
    let o = sc(&sc_simple_args("start", c)).map_err(|e| e.to_string())?;
    // 1056: already running (a race with the SCM); fine
    if !o.success() && o.code != 1056 {
        return Err(format!("sc start {} failed ({}): {}", c.service_name(), o.code, o.text().trim()));
    }
    let deadline = Instant::now() + timeout;
    loop {
        match start_wait(&query_state(c)?) {
            StartWait::Done => return Ok(()),
            StartWait::Died => {
                let codes = crate::sys::service_status(c.service_name()).ok().flatten();
                return Err(format!("{} stopped right after it was started (exit codes {codes:?}); see its log", c.service_name()));
            }
            StartWait::KeepWaiting => {}
        }
        if Instant::now() >= deadline {
            return Err(format!("{} did not reach RUNNING within {}s", c.service_name(), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Stop (if needed) and delete the service registration, then wait until the SCM really forgot it
/// (`sc delete` only marks it while a handle is open). Not-installed is success.
pub fn unregister(c: Component) -> Result<(), String> {
    stop(c, Duration::from_secs(45))?;
    let o = sc(&sc_simple_args("delete", c)).map_err(|e| e.to_string())?;
    delete_result(c, o.code, &o.text())?;
    if wait_for_state(c, &ServiceState::NotInstalled, Duration::from_secs(15))? {
        Ok(())
    } else {
        Err(format!(
            "{} was deleted but is still listed (marked for deletion): close services.msc and anything holding it, or reboot",
            c.service_name()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Roots {
        Roots::custom(PathBuf::from("C:\\ProgramData\\SupermarketPOS"), PathBuf::from("C:\\Program Files\\SupermarketPOS"))
    }
    fn pack() -> PathBuf {
        PathBuf::from("C:\\Program Files\\SupermarketPOS\\packs\\1.0.0-r1")
    }

    #[test]
    fn names_accounts_and_dependencies_match_the_conventions_table() {
        let want = [
            (Component::Postgres, "SupermarketPOS-Postgres", "Supermarket POS Database"),
            (Component::Auth, "SupermarketPOS-Auth", "Supermarket POS Sign-in"),
            (Component::Rest, "SupermarketPOS-Rest", "Supermarket POS Data API"),
            (Component::Functions, "SupermarketPOS-Functions", "Supermarket POS Functions"),
            (Component::Gateway, "SupermarketPOS-Gateway", "Supermarket POS Gateway"),
        ];
        for (c, name, display) in want {
            assert_eq!(c.service_name(), name);
            assert_eq!(c.display_name(), display);
            assert_eq!(c.account(), format!("NT SERVICE\\{name}"));
        }
        assert!(Component::Postgres.depends_on().is_empty());
        assert_eq!(Component::Auth.depends_on(), &[Component::Postgres]);
        assert_eq!(Component::Functions.depends_on(), &[Component::Rest, Component::Auth]);
        assert_eq!(Component::Gateway.depends_on(), &[Component::Functions, Component::Auth, Component::Rest]);
    }

    // C1: `sc stop X` fails with 1051 while a service that depends on X runs, so a single-component stop needs the set
    #[test]
    fn with_dependents_is_the_component_and_everything_that_needs_it_in_start_order() {
        use Component::*;
        assert_eq!(with_dependents(Gateway), vec![Gateway]);
        assert_eq!(with_dependents(Functions), vec![Functions, Gateway]);
        assert_eq!(with_dependents(Rest), vec![Rest, Functions, Gateway]);
        assert_eq!(with_dependents(Auth), vec![Auth, Functions, Gateway]);
        assert_eq!(with_dependents(Postgres), Component::ALL.to_vec());
    }

    #[test]
    fn start_order_respects_every_dependency() {
        for (i, c) in Component::ALL.iter().enumerate() {
            for d in c.depends_on() {
                let j = Component::ALL.iter().position(|x| x == d).unwrap();
                assert!(j < i, "{:?} must start after {:?}", c, d);
            }
        }
    }

    #[test]
    fn commands_are_absolute_and_match_the_table() {
        let r = roots();
        let p = pack();
        assert_eq!(
            component_command(&r, &p, Component::Postgres),
            vec![
                "C:\\Program Files\\SupermarketPOS\\packs\\1.0.0-r1\\pg\\bin\\postgres.exe".to_string(),
                "-D".into(),
                "C:\\ProgramData\\SupermarketPOS\\pgdata".into()
            ]
        );
        let auth = component_command(&r, &p, Component::Auth);
        assert!(auth[0].ends_with("bin\\auth.exe") && auth[1] == "-c" && auth[2].ends_with("secrets\\gotrue.env") && auth[3] == "serve");
        let rest = component_command(&r, &p, Component::Rest);
        assert!(rest[0].ends_with("bin\\postgrest.exe") && rest[1].ends_with("secrets\\postgrest.conf") && rest.len() == 2);
        assert_eq!(component_command(&r, &p, Component::Functions).len(), 1);
        let gw = component_command(&r, &p, Component::Gateway);
        assert!(gw[0].ends_with("bin\\caddy.exe") && gw[1] == "run" && gw[3].ends_with("conf\\Caddyfile") && gw[5] == "caddyfile");
    }

    #[test]
    fn shawl_flags_carry_the_s9_recipe_and_the_o1_mitigations() {
        let r = roots();
        let p = pack();
        let pg = shawl_run_args(&r, &p, Component::Postgres);
        let flag = |a: &[String], f: &str| a.iter().position(|x| x == f).map(|i| a[i + 1].clone());
        assert_eq!(pg[0], "run");
        assert!(pg.contains(&"--no-restart".to_string()) && pg.contains(&"--kill-process-tree".to_string()));
        assert_eq!(flag(&pg, "--stop-timeout").as_deref(), Some("30000"));
        assert_eq!(flag(&pg, "--cwd").as_deref(), Some("C:\\ProgramData\\SupermarketPOS"));
        assert_eq!(flag(&pg, "--log-dir").as_deref(), Some("C:\\ProgramData\\SupermarketPOS\\logs\\SupermarketPOS-Postgres"));
        assert_eq!(flag(&pg, "--log-rotate").as_deref(), Some("bytes=10485760"));
        assert_eq!(flag(&pg, "--log-retain").as_deref(), Some("5"));
        assert!(flag(&pg, "--pass").is_none(), "only PostgREST passes 252");
        let rest = shawl_run_args(&r, &p, Component::Rest);
        assert_eq!(flag(&rest, "--pass").as_deref(), Some("0,252"));
        assert_eq!(flag(&rest, "--stop-timeout").as_deref(), Some("10000"));
        let dashes = rest.iter().position(|x| x == "--").unwrap();
        assert!(rest[dashes + 1].ends_with("postgrest.exe"));
    }

    #[test]
    fn no_secret_can_reach_a_shawl_env_value() {
        let r = roots();
        for c in Component::ALL {
            for (k, _) in component_env(&r, c) {
                let k = k.to_uppercase();
                for bad in ["KEY", "SECRET", "PASSWORD", "PEPPER", "TOKEN", "JWT"] {
                    assert!(!k.contains(bad), "{k} looks like a secret name");
                }
            }
        }
        let gw: Vec<_> = component_env(&r, Component::Gateway).into_iter().map(|(k, _)| k).collect();
        assert!(gw.contains(&"XDG_DATA_HOME".to_string()) && gw.contains(&"XDG_CONFIG_HOME".to_string()));
        assert!(component_env(&r, Component::Functions).iter().any(|(k, _)| k == "DENO_DIR"));
        assert!(component_env(&r, Component::Postgres).iter().any(|(k, v)| k == "TEMP" && v.ends_with("tmp\\SupermarketPOS-Postgres")));
    }

    #[test]
    fn quoting_follows_the_windows_rules() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg("C:\\Program Files\\x.exe"), "\"C:\\Program Files\\x.exe\"");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
        assert_eq!(quote_arg("TEMP=C:\\a b"), "\"TEMP=C:\\a b\"");
    }

    #[test]
    fn bin_path_quotes_the_shawl_path_and_every_spaced_argument() {
        let b = bin_path(&roots(), &pack(), Component::Gateway);
        assert!(b.starts_with("\"C:\\Program Files\\SupermarketPOS\\packs\\1.0.0-r1\\bin\\shawl.exe\" run --name SupermarketPOS-Gateway"));
        assert!(b.contains(" -- \"C:\\Program Files\\SupermarketPOS\\packs\\1.0.0-r1\\bin\\caddy.exe\" run --config "));
    }

    #[test]
    fn sc_create_registers_an_auto_start_virtual_account_service_with_dependencies() {
        let a = sc_create_args(&roots(), &pack(), Component::Functions);
        assert_eq!(&a[..2], &["create".to_string(), "SupermarketPOS-Functions".to_string()]);
        let val = |k: &str| a.iter().position(|x| x == k).map(|i| a[i + 1].clone()).unwrap();
        assert_eq!(val("start="), "auto");
        assert_eq!(val("obj="), "NT SERVICE\\SupermarketPOS-Functions");
        assert_eq!(val("depend="), "SupermarketPOS-Rest/SupermarketPOS-Auth");
        assert_eq!(val("DisplayName="), "Supermarket POS Functions");
        assert!(a.iter().all(|x| x != "password=" && x != "delayed-auto"));
        let pg = sc_create_args(&roots(), &pack(), Component::Postgres);
        assert!(!pg.contains(&"depend=".to_string()), "create omits an empty dependency list");
        let pg_cfg = sc_config_args(&roots(), &pack(), Component::Postgres);
        assert_eq!(pg_cfg[pg_cfg.iter().position(|x| x == "depend=").unwrap() + 1], "/", "config clears dependencies with '/'");
        let cfg = sc_config_args(&roots(), &pack(), Component::Functions);
        assert_eq!(cfg[0], "config");
        assert_eq!(&cfg[2..], &a[2..]);
    }

    #[test]
    fn failure_policy_is_five_seconds_with_a_one_hour_reset() {
        assert_eq!(
            sc_failure_args(Component::Gateway),
            ["failure", "SupermarketPOS-Gateway", "reset=", "3600", "actions=", "restart/5000/restart/5000/restart/5000"]
        );
        assert_eq!(sc_failureflag_args(Component::Gateway), ["failureflag", "SupermarketPOS-Gateway", "1"]);
        let none = sc_failure_none_args(Component::Gateway);
        assert_eq!(none[3], "0");
        assert_eq!(none[5], "");
    }

    // `query_state` calls `sys::service_state`; the non-elevated tests live in `sys`.
    #[test]
    fn service_state_numbers_map_to_the_enum() {
        assert_eq!(ServiceState::from_scm(1), ServiceState::Stopped);
        assert_eq!(ServiceState::from_scm(2), ServiceState::StartPending);
        assert_eq!(ServiceState::from_scm(3), ServiceState::StopPending);
        assert_eq!(ServiceState::from_scm(4), ServiceState::Running);
        assert!(matches!(ServiceState::from_scm(7), ServiceState::Other(_)));
    }

    // Shawl mitigation O1 / Q6: at OS shutdown the SCM waits WaitToKillServiceTimeout (default ~5 s) for all
    // services; Postgres needs its 30 s stop timeout to be honoured.
    #[test]
    fn wait_to_kill_target_raises_but_never_lowers() {
        assert_eq!(wait_to_kill_target(None), Some("30000".to_string()));
        assert_eq!(wait_to_kill_target(Some("5000")), Some("30000".to_string()));
        assert_eq!(wait_to_kill_target(Some("garbage")), Some("30000".to_string()));
        assert_eq!(wait_to_kill_target(Some("30000")), None);
        assert_eq!(wait_to_kill_target(Some("45000")), None);
    }

    #[test]
    fn the_one_shot_service_runs_the_script_through_cmd_without_restart() {
        let b = one_shot_bin_path(&roots(), &pack(), Path::new(r"C:\ProgramData\SupermarketPOS\tmp\SupermarketPOS-Postgres\initdb.cmd")).unwrap();
        assert!(b.contains(" --no-restart "));
        assert!(b.to_lowercase().contains("\\system32\\cmd.exe /c "), "cmd is an absolute path under the system directory, not a PATH search");
        assert!(b.ends_with("initdb.cmd"));
        assert!(!b.contains("--kill-process-tree"));
    }

    #[test]
    fn sids_are_distinct_per_service() {
        let sids: std::collections::HashSet<_> = Component::ALL.iter().map(|c| c.sid()).collect();
        assert_eq!(sids.len(), 5);
        assert!(sids.iter().all(|s| s.starts_with("S-1-5-80-")));
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

    fn status(state: u32, win32: u32, specific: u32) -> crate::sys::ScmStatus {
        crate::sys::ScmStatus { state, win32_exit: win32, specific_exit: specific }
    }

    // F5 b: STOPPED alone is not success; the one-shot must have exited 0.
    #[test]
    fn the_one_shot_must_be_stopped_with_exit_code_zero() {
        assert!(one_shot_outcome(&status(1, 0, 0)).is_ok());
        assert!(one_shot_outcome(&status(4, 0, 0)).unwrap_err().contains("still"));
        assert!(one_shot_outcome(&status(1, 1, 0)).unwrap_err().contains("exit code 1"));
        let e = one_shot_outcome(&status(1, 1066, 3)).unwrap_err(); // ERROR_SERVICE_SPECIFIC_ERROR
        assert!(e.contains("3"), "{e}");
        assert!(one_shot_outcome(&status(1, 0, 9)).is_err());
    }

    #[test]
    fn the_one_shot_is_refused_while_the_service_exists_and_is_not_stopped() {
        assert!(one_shot_precheck(&ServiceState::NotInstalled).is_ok());
        assert!(one_shot_precheck(&ServiceState::Stopped).is_ok());
        for s in [ServiceState::Running, ServiceState::StartPending, ServiceState::StopPending, ServiceState::Other("7".into())] {
            assert!(one_shot_precheck(&s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn the_one_shot_has_its_failure_actions_cleared_before_it_starts() {
        assert_eq!(one_shot_failure_args(), ["failure", "SupermarketPOS-Postgres", "reset=", "0", "actions=", ""]);
    }

    // F5 e: a service that is already STOPPED after a successful `sc start` has died; do not wait out the timeout.
    #[test]
    fn waiting_for_running_gives_up_as_soon_as_the_service_is_stopped() {
        assert_eq!(start_wait(&ServiceState::Running), StartWait::Done);
        assert_eq!(start_wait(&ServiceState::StartPending), StartWait::KeepWaiting);
        assert_eq!(start_wait(&ServiceState::Stopped), StartWait::Died);
        assert_eq!(start_wait(&ServiceState::NotInstalled), StartWait::Died);
        assert_eq!(start_wait(&ServiceState::StopPending), StartWait::Died);
    }

    // F5 f: only 0 and 1062 (not started) are fine from `sc stop`; access denied etc. fail at once.
    #[test]
    fn sc_stop_failures_other_than_not_started_are_errors() {
        assert!(stop_result(Component::Rest, 0, "").is_ok());
        assert!(stop_result(Component::Rest, 1062, "").is_ok());
        let e = stop_result(Component::Rest, 5, "Access is denied.").unwrap_err();
        assert!(e.contains("5") && e.contains("Access is denied"), "{e}");
        assert!(stop_result(Component::Rest, 1051, "").is_err());
    }

    // F5 g: delete leaves the registration until the last handle closes.
    #[test]
    fn sc_delete_codes_are_mapped_to_clear_outcomes() {
        assert!(delete_result(Component::Gateway, 0, "").is_ok());
        assert!(delete_result(Component::Gateway, SC_NOT_INSTALLED, "").is_ok());
        let e = delete_result(Component::Gateway, 1072, "").unwrap_err();
        assert!(e.contains("marked for deletion") && e.contains("services.msc"), "{e}");
        assert!(delete_result(Component::Gateway, 5, "denied").unwrap_err().contains("5"));
    }

    // F5 c/h: the version is a pack version, and the segment cut stops at a quote or whitespace.
    #[test]
    fn repoint_validates_the_new_version() {
        let packs = Path::new(r"C:\Program Files\SupermarketPOS\packs");
        let old = r#""C:\Program Files\SupermarketPOS\packs\1.0.0-r1\bin\shawl.exe" run"#;
        for bad in ["", "..", "1.1.0", r"1.1.0-r1\..\x", r"1.1.0-r1\x", "1.1.0-r1/x", "1.1.0-r1\"", "1.1.0-r1 x", r"..\1.1.0-r1"] {
            assert_eq!(repoint_bin_path(old, packs, bad), None, "{bad:?}");
        }
        assert!(repoint_bin_path(old, packs, "1.1.0-r1").is_some());
    }

    #[test]
    fn repoint_cuts_the_old_version_at_a_quote_or_whitespace_too() {
        let packs = Path::new(r"C:\Program Files\SupermarketPOS\packs");
        let quoted = r#"shawl run --cwd "C:\Program Files\SupermarketPOS\packs\1.0.0-r1" -- x"#;
        assert_eq!(repoint_bin_path(quoted, packs, "1.1.0-r1").unwrap(), r#"shawl run --cwd "C:\Program Files\SupermarketPOS\packs\1.1.0-r1" -- x"#);
        let bare = r"shawl --log C:\Program Files\SupermarketPOS\packs\1.0.0-r1 tail";
        assert_eq!(repoint_bin_path(bare, packs, "1.1.0-r1").unwrap(), r"shawl --log C:\Program Files\SupermarketPOS\packs\1.1.0-r1 tail");
    }

    #[test]
    fn the_start_type_builder_switches_between_manual_and_automatic() {
        assert_eq!(sc_start_type_args(Component::Auth, false), ["config", "SupermarketPOS-Auth", "start=", "demand"]);
        assert_eq!(sc_start_type_args(Component::Auth, true), ["config", "SupermarketPOS-Auth", "start=", "auto"]);
    }
}
