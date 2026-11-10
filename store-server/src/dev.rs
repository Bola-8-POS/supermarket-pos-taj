//! Test instances for Playwright against a native stack (conventions section 13):
//! `posctl dev new|start|stop|destroy|env|seed-first-admin --slot <0-9>`. An instance is a complete store
//! backend in `E:\tmp\two-mode-instances\slot<n>` (or `%POSCTL_DEV_ROOT%\slot<n>`) on ports `47400 + 10 * slot`,
//! run as plain child processes: no service, no ACL change, no firewall rule or network-profile change, no
//! registry write, no scheduled task. It runs the same provisioning steps as production through the `Runtime`
//! seam (`DevProcesses` instead of `WindowsServices`), so what the e2e suite exercises is what ships.
//!
//! Packs. An instance loads its pack at the FULL verification tier like any start. A dev instance accepts a pack
//! signed with the compiled updater key or, in a `--features test-hooks` build, the key in
//! `POSCTL_TEST_UPDATER_PUBKEY`; there is no unsigned bypass. To get one: build the pack folder, run
//! `store-server\tests\fixtures\sign-pack.ps1 -PackDir <folder> -OutZip x.pospack -OutPub signer.pub` (throwaway
//! key), set `POSCTL_TEST_UPDATER_PUBKEY` to the contents of `signer.pub`, install the zip into a dev program root
//! with the test-hooks `posctl.exe --dev --data-root <d> --program-root <p> pack install x.pospack`, then
//! `posctl.exe --dev ... dev new --slot 1 --pack-dir <p>\packs\<version>`.
//!
//! Processes. Long-lived components are spawned detached (`Host::spawn`), never through `exec::Cmd::run`, which
//! kills everything in its job when it returns. Every child gets an explicit environment (the system locations from
//! `exec::base_env`, the component's own TEMP, and its `gotrue.env` / `functions.env` values) and never inherits
//! the caller's. `pids.json` records `{pid, creationTime}` of every child at spawn; a pid counts only while the
//! process's FULL image path is the exe we spawned (from the pack) AND its creation time is the recorded one, so
//! a recycled pid, or another slot's / the production stack's `postgres.exe`, is never killed. A lookup that
//! fails is an error, never "stopped". An entry without a creation time (an older `pids.json`) is unknown: never
//! killed, never counted as running.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::envelope::{Code, Outcome, PosctlError, SecretOnce};
use crate::exec::Cmd;
use crate::firstadmin::{self, Endpoint, FirstAdmin, FirstAdminError};
use crate::lifecycle;
use crate::paths::Roots;
use crate::pg::{PgTools, Psql};
use crate::ports::{dev_base, Ports};
use crate::provision::{self, ProvisionArgs};
use crate::render::parse_dotenv;
use crate::runtime::Runtime;
use crate::secrets;
use crate::services::{self, Component, ServiceState};
use crate::sys::ProcIdentity;
use crate::util::{is_trivial_pin, now_rfc3339, write_atomic, Redactor};

const ADMIN_NAME: &str = "Dev Admin";

const DEFAULT_DEV_ROOT: &str = "E:\\tmp\\two-mode-instances";

fn lower(p: &Path) -> String {
    p.display().to_string().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// `POSCTL_DEV_ROOT` must be absolute (a relative one would resolve against whatever folder posctl was started
/// in) and must not sit in, or be, the production data or program folder: `dev destroy` deletes folders under it.
pub fn check_dev_root(root: &Path) -> Result<(), PosctlError> {
    if !root.is_absolute() {
        return Err(PosctlError::new(Code::Usage, format!("POSCTL_DEV_ROOT must be an absolute path, got {}", root.display())));
    }
    use crate::sys::{known_folder, KnownFolder};
    let prod: Vec<PathBuf> = [KnownFolder::ProgramData, KnownFolder::ProgramFiles].into_iter().filter_map(|k| known_folder(k).ok()).map(|p| p.join(crate::paths::PRODUCT)).collect();
    let r = lower(root);
    for p in &prod {
        let p = lower(p);
        if r == p || r.starts_with(&format!("{p}\\")) {
            return Err(PosctlError::new(Code::Usage, format!("POSCTL_DEV_ROOT {} is inside the production folder {p}; test instances never live there", root.display())));
        }
    }
    Ok(())
}

pub fn dev_root() -> Result<PathBuf, PosctlError> {
    match std::env::var_os("POSCTL_DEV_ROOT") {
        Some(v) => {
            let root = PathBuf::from(v);
            check_dev_root(&root)?;
            Ok(root)
        }
        None => Ok(PathBuf::from(DEFAULT_DEV_ROOT)),
    }
}

pub fn instance_dir(slot: u8) -> Result<PathBuf, PosctlError> {
    dev_base(slot).map_err(|e| PosctlError::new(Code::Usage, e))?;
    Ok(dev_root()?.join(format!("slot{slot}")))
}

fn deleting_dir(dir: &Path) -> PathBuf {
    let mut n = dir.as_os_str().to_owned();
    n.push(".deleting");
    PathBuf::from(n)
}

/// A `slotN.deleting` left by a destroy that was interrupted between the rename and the delete.
fn clean_leftover(dir: &Path) -> Result<(), PosctlError> {
    let d = deleting_dir(dir);
    if d.exists() {
        std::fs::remove_dir_all(&d).map_err(|e| PosctlError::error(format!("cannot remove the leftover {}: {e}", d.display())))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceFile {
    pub slot: u8,
    /// `ports.base`: the key Plan 06's native e2e guard reads.
    pub ports: crate::config::PortsCfg,
    pub pack_dir: String,
    pub tls: String,
    pub created_at: String,
}

pub fn instance_roots(dir: &Path, pack_dir: &Path) -> Roots {
    let mut r = Roots::custom(dir.join("data"), dir.join("program"));
    r.pack_override = Some(pack_dir.to_path_buf());
    r
}

fn load_instance(slot: u8) -> Result<(PathBuf, InstanceFile, Roots), PosctlError> {
    let dir = instance_dir(slot)?;
    let text = std::fs::read_to_string(dir.join("instance.json")).map_err(|_| PosctlError::new(Code::NotProvisioned, format!("no dev instance in slot {slot}; run `dev new --slot {slot} --pack-dir <dir>`")))?;
    let inst: InstanceFile = serde_json::from_str(&text)?;
    // an instance.json copied from another slot would aim this slot's commands at that slot's ports and processes
    let base = dev_base(slot).map_err(|e| PosctlError::new(Code::Usage, e))?;
    if inst.slot != slot || inst.ports.base != base {
        return Err(PosctlError::precondition(format!("{} does not describe slot {slot} (slot {}, base port {}); refusing to use it", dir.join("instance.json").display(), inst.slot, inst.ports.base)));
    }
    let roots = instance_roots(&dir, Path::new(&inst.pack_dir));
    Ok((dir, inst, roots))
}

// ---------------------------------------------------------------------------------------------
// The host: the only place a process is looked up, started or killed
// ---------------------------------------------------------------------------------------------

/// One process to start. `env` is everything the child sees beyond the system locations.
#[derive(Clone)]
pub struct Spec {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Appended to by stdout and stderr; `None` discards them.
    pub log: Option<PathBuf>,
}

/// A started child: its pid and its creation time (FILETIME ticks), read from the child's own handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spawned {
    pub pid: u32,
    pub created: u64,
}

pub trait Host {
    /// Who `pid` is right now; `Ok(None)` when no such process is running, `Err` when the lookup failed.
    fn identity(&self, pid: u32) -> Result<Option<ProcIdentity>, String>;
    fn kill_tree(&self, pid: u32) -> Result<(), String>;
    /// Starts a long-lived child.
    fn spawn(&self, spec: &Spec) -> Result<Spawned, String>;
    /// Runs a short tool to completion; returns its exit code.
    fn run(&self, spec: &Spec, timeout: Duration) -> Result<i32, String>;
}

pub fn taskkill_args(pid: u32) -> Vec<String> {
    vec!["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

/// CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, plus CREATE_BREAKAWAY_FROM_JOB so a child outlives a caller whose job
/// object kills its members on close (a CI runner, an agent's shell). A job that forbids breakaway refuses the flag
/// with access denied; the spawn is then retried without it.
pub fn spawn_flags(breakaway: bool) -> u32 {
    0x0800_0000 | 0x0000_0200 | if breakaway { 0x0100_0000 } else { 0 }
}

fn system32(exe: &str) -> Result<PathBuf, String> {
    Ok(crate::sys::system_dir()?.join(exe))
}

pub struct WinHost;

impl Host for WinHost {
    fn identity(&self, pid: u32) -> Result<Option<ProcIdentity>, String> {
        crate::sys::process_identity(pid)
    }

    fn kill_tree(&self, pid: u32) -> Result<(), String> {
        let o = Cmd::new(system32("taskkill.exe")?).args(taskkill_args(pid)).timeout(Duration::from_secs(30)).run().map_err(|e| e.to_string())?;
        if o.success() { Ok(()) } else { Err(format!("taskkill exited {}", o.code)) }
    }

    fn spawn(&self, spec: &Spec) -> Result<Spawned, String> {
        let (out, err) = match &spec.log {
            Some(p) => {
                let f = OpenOptions::new().create(true).append(true).open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                let f2 = f.try_clone().map_err(|e| e.to_string())?;
                (std::process::Stdio::from(f), std::process::Stdio::from(f2))
            }
            None => (std::process::Stdio::null(), std::process::Stdio::null()),
        };
        let mut c = std::process::Command::new(&spec.exe);
        c.args(&spec.args).current_dir(&spec.cwd).stdin(std::process::Stdio::null()).stdout(out).stderr(err).env_clear();
        for (k, v) in crate::exec::base_env()? {
            c.env(k, v);
        }
        for (k, v) in &spec.env {
            c.env(k, v);
        }
        // the child gets only the stdio set above, never the caller's pipes (see `clear_std_handle_inheritance`)
        crate::sys::clear_std_handle_inheritance();
        #[cfg(windows)]
        let spawned = {
            use std::os::windows::process::CommandExt;
            c.creation_flags(spawn_flags(true));
            match c.spawn() {
                Err(e) if e.raw_os_error() == Some(5) => {
                    c.creation_flags(spawn_flags(false));
                    c.spawn()
                }
                r => r,
            }
        };
        #[cfg(not(windows))]
        let spawned = c.spawn();
        let mut child = spawned.map_err(|e| format!("cannot start {}: {e}", spec.exe.display()))?;
        match crate::sys::child_creation_time(&child) {
            Ok(created) => Ok(Spawned { pid: child.id(), created }),
            Err(e) => {
                let _ = child.kill(); // our own, just-started child: without its creation time it could never be stopped safely
                Err(format!("cannot identify {} after starting it: {e}", spec.exe.display()))
            }
        }
    }

    fn run(&self, spec: &Spec, timeout: Duration) -> Result<i32, String> {
        let mut cmd = Cmd::new(&spec.exe).args(spec.args.clone()).cwd(&spec.cwd).timeout(timeout);
        for (k, v) in &spec.env {
            cmd = cmd.env(k, v);
        }
        cmd.run().map(|o| o.code).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// The child-process runtime
// ---------------------------------------------------------------------------------------------

pub struct DevProcesses<H: Host = WinHost> {
    pub dir: PathBuf,
    pub pack_dir: PathBuf,
    host: H,
    /// How long a stopped process may take to disappear.
    pub settle: Duration,
}

impl DevProcesses<WinHost> {
    pub fn real(dir: PathBuf, pack_dir: PathBuf) -> Self {
        Self::with_host(dir, pack_dir, WinHost)
    }
}

impl<H: Host> DevProcesses<H> {
    pub fn with_host(dir: PathBuf, pack_dir: PathBuf, host: H) -> Self {
        DevProcesses { dir, pack_dir, host, settle: Duration::from_secs(10) }
    }

    fn roots(&self) -> Roots {
        instance_roots(&self.dir, &self.pack_dir)
    }
    fn pids_file(&self) -> PathBuf {
        self.dir.join("pids.json")
    }
    /// Missing file = nothing recorded; an unreadable or malformed one is an error (never silently replaced).
    fn read_pids(&self) -> Result<BTreeMap<String, PidEntry>, String> {
        match std::fs::read_to_string(self.pids_file()) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| format!("{} is not valid ({e}); stop the processes by hand and delete it", self.pids_file().display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("{}: {e}", self.pids_file().display())),
        }
    }
    fn write_pids(&self, m: &BTreeMap<String, PidEntry>) -> Result<(), String> {
        write_atomic(&self.pids_file(), serde_json::to_string_pretty(m).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())
    }
    /// The exe a component's process must be running: the full path of its command, from the pack.
    fn expected_image(&self, c: Component) -> String {
        services::component_command(&self.roots(), &self.pack_dir, c).into_iter().next().unwrap_or_default()
    }
    pub fn pid_of(&self, c: Component) -> Result<Option<u32>, String> {
        Ok(match self.read_pids()?.get(c.short()) {
            Some(PidEntry::Known { pid, .. }) | Some(PidEntry::Legacy(pid)) => Some(*pid),
            None => None,
        })
    }
    /// Is this recorded process still the one we started for `c`? `Ok(false)` for a gone process, a recycled pid
    /// (other image or other creation time) and an entry without a creation time; `Err` when the lookup failed.
    fn is_ours(&self, e: &PidEntry, c: Component) -> Result<bool, String> {
        let PidEntry::Known { pid, creation_time } = e else { return Ok(false) };
        Ok(match self.host.identity(*pid)? {
            Some(id) => id.created == *creation_time && same_image(&id.image, &self.expected_image(c)),
            None => false,
        })
    }
    pub fn state_of(&self, c: Component) -> Result<ServiceState, String> {
        Ok(match self.read_pids()?.get(c.short()) {
            Some(e) if self.is_ours(e, c)? => ServiceState::Running,
            _ => ServiceState::Stopped,
        })
    }
    fn wait_gone(&self, e: &PidEntry, c: Component) -> Result<(), String> {
        let deadline = Instant::now() + self.settle;
        loop {
            if !self.is_ours(e, c)? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("{} is still running after the stop", c.short()));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// One recorded child. `Legacy` is a bare pid from a `pids.json` written before creation times were kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PidEntry {
    #[serde(rename_all = "camelCase")]
    Known { pid: u32, creation_time: u64 },
    Legacy(u32),
}

fn same_image(a: &str, b: &str) -> bool {
    let n = |s: &str| s.replace('/', "\\").to_lowercase();
    !b.is_empty() && n(a) == n(b)
}

/// The component's environment: the non-secret part from `services::component_env`, plus its own env file
/// (`gotrue.env` for sign-in, `secrets\functions.env` for the Functions). Nothing is inherited.
fn env_for(roots: &Roots, c: Component) -> Vec<(String, String)> {
    let mut v = services::component_env(roots, c);
    let file = match c {
        Component::Auth => Some(roots.gotrue_env()),
        Component::Functions => Some(roots.secrets().join("functions.env")),
        _ => None,
    };
    if let Some(f) = file {
        v.extend(parse_dotenv(&std::fs::read_to_string(f).unwrap_or_default()));
    }
    v
}

impl<H: Host> Runtime for DevProcesses<H> {
    fn name(&self) -> &'static str {
        "dev-processes"
    }

    fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> {
        Ok(())
    }

    fn run_script_as_postgres(&self, roots: &Roots, _: &Path, script: &Path, timeout: Duration) -> Result<(), String> {
        let tmp = roots.tmp_for(Component::Postgres.service_name());
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let spec = Spec { exe: system32("cmd.exe")?, args: vec!["/d".into(), "/c".into(), script.display().to_string()], cwd: roots.data.clone(), env: env_for(roots, Component::Postgres), log: None };
        match self.host.run(&spec, timeout)? {
            0 => Ok(()),
            code => Err(format!("script exited {code}")),
        }
    }

    fn start(&self, roots: &Roots, pack_dir: &Path, c: Component) -> Result<(), String> {
        if self.state_of(c)? == ServiceState::Running {
            return Ok(());
        }
        let cmd = services::component_command(roots, pack_dir, c);
        let log_dir = roots.logs_for(c.service_name());
        std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(roots.tmp_for(c.service_name())).map_err(|e| e.to_string())?;
        let spec = Spec { exe: PathBuf::from(&cmd[0]), args: cmd[1..].to_vec(), cwd: roots.data.clone(), env: env_for(roots, c), log: Some(log_dir.join("dev.log")) };
        let Spawned { pid, created } = self.host.spawn(&spec)?;
        let mut pids = self.read_pids()?;
        pids.insert(c.short().to_string(), PidEntry::Known { pid, creation_time: created });
        self.write_pids(&pids)
    }

    fn stop(&self, c: Component) -> Result<(), String> {
        let mut pids = self.read_pids()?;
        let Some(entry) = pids.get(c.short()).cloned() else { return Ok(()) };
        // any `?` below leaves pids.json as it was: a failed lookup or kill must not forget a possibly-running child
        if self.is_ours(&entry, c)? {
            if c == Component::Postgres {
                // a clean shutdown first; the tree is killed only when that did not end it
                let roots = self.roots();
                let spec = Spec {
                    exe: PgTools::for_pack(&self.pack_dir).exe("pg_ctl"),
                    args: vec!["-D".into(), roots.pgdata().display().to_string(), "-m".into(), "fast".into(), "-w".into(), "-t".into(), "60".into(), "stop".into()],
                    cwd: roots.data.clone(),
                    env: env_for(&roots, c),
                    log: None,
                };
                let _ = self.host.run(&spec, Duration::from_secs(90));
            }
            if self.is_ours(&entry, c)? {
                if let PidEntry::Known { pid, .. } = entry {
                    self.host.kill_tree(pid)?;
                }
            }
            self.wait_gone(&entry, c)?;
        }
        pids.remove(c.short());
        self.write_pids(&pids)
    }

    fn set_functions_env(&self, roots: &Roots, entries: &[String]) -> Result<(), String> {
        std::fs::create_dir_all(roots.secrets()).map_err(|e| e.to_string())?;
        std::fs::write(roots.secrets().join("functions.env"), entries.join("\n") + "\n").map_err(|e| e.to_string())
    }

    fn unregister(&self, c: Component) -> Result<(), String> {
        self.stop(c)
    }

    fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// `admin` is `(name, pin)` of the test admin made by `dev seed-first-admin` (saved to `<instance dir>\admin.json`, a
/// dev-only file; `dev env` reads it). When present, `E2E_ADMIN_NAME` and `E2E_ADMIN_PIN` are appended (the e2e
/// harnesses need them); an instance never seeded simply lacks them. Never a VITE_ variable.
pub fn app_env(inst: &InstanceFile, s: &secrets::Secrets, admin: Option<(&str, &str)>) -> String {
    let p = Ports { base: inst.ports.base };
    let mut text = format!(
        "# Written by `posctl dev env`. Test instance only.\nVITE_SUPABASE_URL={}://127.0.0.1:{}\nVITE_SUPABASE_ANON_KEY={}\nVITE_STORE_MODE=offline-only\nE2E_ADMIN_SUPABASE_URL=http://127.0.0.1:{}\nSUPABASE_SERVICE_ROLE_KEY={}\n",
        lan_scheme(inst),
        p.gateway_lan(),
        s.anon_key.expose(),
        p.gateway_internal(),
        s.service_role_key.expose()
    );
    if let Some((name, pin)) = admin {
        text.push_str(&format!("E2E_ADMIN_NAME={name}\nE2E_ADMIN_PIN={pin}\n"));
    }
    text
}

/// `--tls off|internal` of `dev new` and `dev render-gateway`. A dev instance never faces the LAN: loopback bind either way.
fn dev_gateway(tls: &str) -> Result<crate::gateway::GatewaySettings, PosctlError> {
    match tls {
        "off" => Ok(crate::gateway::GatewaySettings::default()),
        "internal" => Ok(crate::gateway::GatewaySettings::dev_internal()),
        other => Err(PosctlError::new(Code::Usage, format!("--tls must be off or internal, not {other:?}"))),
    }
}

/// `https` for an instance created with `--tls internal`, else `http`: the scheme of its LAN listener.
fn lan_scheme(inst: &InstanceFile) -> &'static str {
    if inst.tls == "internal" { "https" } else { "http" }
}

pub fn new(slot: u8, pack_dir: &Path, tls: &str) -> Result<Outcome, PosctlError> {
    new_with(slot, pack_dir, tls, &|dir, pack| Box::new(DevProcesses::real(dir, pack)))
}

/// `make` builds the runtime that provisions the instance and then stops it (tests hand in a recorder).
pub fn new_with(slot: u8, pack_dir: &Path, tls: &str, make: &dyn Fn(PathBuf, PathBuf) -> Box<dyn Runtime>) -> Result<Outcome, PosctlError> {
    let gateway = dev_gateway(tls)?;
    let base = dev_base(slot).map_err(|e| PosctlError::new(Code::Usage, e))?;
    let dir = instance_dir(slot)?;
    clean_leftover(&dir)?;
    if dir.exists() && std::fs::read_dir(&dir)?.next().is_some() {
        return Err(PosctlError::precondition(format!("{} is not empty; run `dev destroy --slot {slot}` first", dir.display())));
    }
    let pack_dir = provision::strip_verbatim(pack_dir.canonicalize().map_err(|e| PosctlError::new(Code::Usage, format!("--pack-dir: {e}")))?);
    std::fs::create_dir_all(&dir)?;
    let inst = InstanceFile { slot, ports: crate::config::PortsCfg { base }, pack_dir: pack_dir.display().to_string(), tls: tls.into(), created_at: now_rfc3339() };
    std::fs::write(dir.join("instance.json"), serde_json::to_string_pretty(&inst)?)?;
    let roots = instance_roots(&dir, &pack_dir);
    let rt = make(dir.clone(), pack_dir.clone());
    // "localhost": Plan 05's validate_server_host refuses 127.0.0.1 (not RFC 1918) but accepts a host name
    let out = provision::run(&roots, rt.as_ref(), &ProvisionArgs { pack: pack_dir.display().to_string(), server_host: Some("localhost".into()), base_port: Some(base), skip_first_admin: true, gateway: Some(gateway), ..Default::default() });
    for c in Component::ALL.iter().rev() {
        let _ = rt.stop(*c);
    }
    match out {
        Ok(o) => Ok(Outcome::ok("dev instance created (stopped)", json!({"slot": slot, "basePort": base, "dir": dir.display().to_string(), "lanListener": base + 4, "internalListener": base + 5, "provision": o.data}))),
        Err(mut e) => {
            e.message.push_str(&format!("; the logs are under {}; run `dev destroy --slot {slot}` to start over", roots.logs().display()));
            Err(e)
        }
    }
}

pub fn start(slot: u8) -> Result<Outcome, PosctlError> {
    let (dir, inst, roots) = load_instance(slot)?;
    lifecycle::start(&roots, &DevProcesses::real(dir, PathBuf::from(inst.pack_dir)), None)
}

pub fn stop(slot: u8) -> Result<Outcome, PosctlError> {
    let (dir, inst, roots) = load_instance(slot)?;
    lifecycle::stop(&roots, &DevProcesses::real(dir, PathBuf::from(inst.pack_dir)), None)
}

pub fn env(slot: u8) -> Result<Outcome, PosctlError> {
    let (dir, inst, roots) = load_instance(slot)?;
    let s = secrets::load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    let path = dir.join("app.env");
    let admin: Option<(String, String)> = std::fs::read_to_string(dir.join("admin.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| Some((v.get("name")?.as_str()?.to_string(), v.get("pin")?.as_str()?.to_string())));
    std::fs::write(&path, app_env(&inst, &s, admin.as_ref().map(|(n, p)| (n.as_str(), p.as_str()))))?;
    Ok(Outcome::ok("app.env written", json!({"path": path.display().to_string(), "lanUrl": format!("{}://127.0.0.1:{}", lan_scheme(&inst), inst.ports.base + 4), "adminUrl": format!("http://127.0.0.1:{}", inst.ports.base + 5)})))
}

pub fn seed_first_admin(slot: u8, pin_from_stdin: Option<String>) -> Result<Outcome, PosctlError> {
    let (_dir, inst, roots) = load_instance(slot)?;
    let s = secrets::load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    let ep = Endpoint { internal_url: format!("http://127.0.0.1:{}", inst.ports.base + 5), anon_key: s.anon_key.clone(), service_key: s.service_role_key.clone() };
    let psql = Psql { tools: PgTools::for_pack(Path::new(&inst.pack_dir)), port: inst.ports.base, pgpass: roots.pgpass() };
    let answer = psql.scalar("postgres", "postgres", firstadmin::PIN_HASHED_SQL).map_err(|e| PosctlError::error(format!("cannot read the profiles.pin schema: {e}")))?;
    let hashed = firstadmin::parse_pin_hashed(&answer).map_err(PosctlError::error)?;
    seed_first_admin_with(slot, pin_from_stdin, &mut |pin, register| firstadmin::create_first_admin(&ep, &s.pepper, ADMIN_NAME, pin, hashed, register))
}

type CreateFn<'a> = &'a mut dyn FnMut(&str, &mut dyn FnMut(&str)) -> Result<FirstAdmin, FirstAdminError>;

/// The PIN rules and the redaction around one `create_first_admin` call. A supplied PIN must be six digits and not
/// trivial; a generated one comes from the same CSPRNG draw provisioning uses. The PIN goes to the redactor
/// BEFORE the first request, so no error text can carry it.
pub fn seed_first_admin_with(slot: u8, pin_from_stdin: Option<String>, create: CreateFn) -> Result<Outcome, PosctlError> {
    let (dir, _inst, _roots) = load_instance(slot)?;
    let (pin, generated) = match pin_from_stdin {
        Some(p) => {
            if p.len() != 6 || !p.bytes().all(|c| c.is_ascii_digit()) {
                return Err(PosctlError::new(Code::Usage, "the PIN must be exactly six digits"));
            }
            if is_trivial_pin(&p) {
                return Err(PosctlError::new(Code::Usage, "that PIN is too easy to guess (a repeated digit or a run like 123456); choose another"));
            }
            (p, false)
        }
        None => (provision::fresh_pin().map_err(PosctlError::error)?, true),
    };
    let mut red = Redactor::new();
    let result = {
        let mut register = firstadmin::registrar(&mut red);
        register(&pin);
        create(&pin, &mut register)
    };
    match result {
        Ok(FirstAdmin::Created { id, email }) => {
            // remembered for `dev env` (E2E_ADMIN_NAME / E2E_ADMIN_PIN); dev instances only
            write_atomic(&dir.join("admin.json"), serde_json::to_string_pretty(&json!({"name": ADMIN_NAME, "pin": pin}))?.as_bytes())?;
            let mut o = Outcome::ok("first admin created (must change PIN at first sign-in)", json!({"firstAdmin": {"id": id, "email": email, "mustChangePin": true}}));
            if generated {
                o = o.secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin });
            }
            Ok(o)
        }
        Ok(FirstAdmin::AlreadyExists { id }) => Ok(Outcome::ok("an admin already exists", json!({"firstAdmin": {"id": id}}))),
        Err(e) => {
            let text = red.redact(&e.to_string());
            Err(match e {
                FirstAdminError::Transport(_) => PosctlError::new(Code::Unhealthy, format!("cannot reach the dev instance ({text}); is it running? run `dev start --slot {slot}`")),
                _ => PosctlError::error(text),
            })
        }
    }
}

/// Fixed values the black-box gateway contract test relies on: base 47980 (LAN 47984, INTERNAL 47985, mode probe 47988),
/// apikey `anonhead.anonpayload.anonsig1`, a service-role key whose payload segment is `svcpayloadtest`, state folder `<out>\state`.
pub const CONTRACT_BASE: u16 = crate::ports::CONTRACT_BASE;
/// Test-only keys of the contract fixture (not secrets); `dev render-gateway` reports them so the test never hardcodes them.
const CONTRACT_ANON_KEY: &str = "anonhead.anonpayload.anonsig1";
const CONTRACT_SERVICE_ROLE_KEY: &str = "svchead1.svcpayloadtest.signature";

pub fn render_gateway(out: &Path, tls: &str) -> Result<Outcome, PosctlError> {
    let settings = dev_gateway(tls)?;
    let ports = Ports { base: CONTRACT_BASE };
    let roots = crate::paths::Roots::custom(out.to_path_buf(), out.to_path_buf());
    let gw = crate::gateway::GatewayParams::for_roots(&roots, &ports, CONTRACT_ANON_KEY, CONTRACT_SERVICE_ROLE_KEY, settings.tls, &settings.ext_bind, settings.hosts);
    let (live, maintenance) = crate::conf::render_gateway_files(&gw).map_err(PosctlError::error)?;
    std::fs::create_dir_all(roots.conf())?;
    for (path, text) in crate::gateway::imported_files_to_write(&roots.conf()) {
        std::fs::write(path, text)?;
    }
    std::fs::create_dir_all(out.join("state"))?;
    std::fs::create_dir_all(out.join("logs").join("SupermarketPOS-Gateway"))?;
    std::fs::create_dir_all(out.join("pki").join("caddy"))?;
    std::fs::write(out.join("Caddyfile.live"), live)?;
    std::fs::write(out.join("Caddyfile.maintenance"), maintenance)?;
    Ok(Outcome::ok("gateway configs rendered", json!({"out": out.display().to_string(), "lanPort": ports.gateway_lan(), "internalPort": ports.gateway_internal(), "modePort": ports.mode_probe(),
        "gotruePort": ports.gotrue(), "restPort": ports.rest(), "functionsPort": ports.functions(),
        "anonKey": CONTRACT_ANON_KEY, "serviceRoleKey": CONTRACT_SERVICE_ROLE_KEY})))
}

pub fn destroy(slot: u8) -> Result<Outcome, PosctlError> {
    let dir = instance_dir(slot)?;
    clean_leftover(&dir)?;
    if !dir.exists() {
        return Ok(Outcome::ok("nothing to destroy", json!({"destroyed": false})));
    }
    // only a folder whose instance.json is ours AND names this slot is deleted
    let ours = std::fs::read_to_string(dir.join("instance.json")).ok().and_then(|t| serde_json::from_str::<InstanceFile>(&t).ok()).filter(|i| i.slot == slot);
    let Some(inst) = ours else {
        return Err(PosctlError::precondition(format!("{} is not a posctl dev instance for slot {slot} (no valid instance.json); refusing to delete it", dir.display())));
    };
    let rt = DevProcesses::real(dir.clone(), PathBuf::from(inst.pack_dir));
    for c in Component::ALL.iter().rev() {
        rt.stop(*c).map_err(|e| PosctlError::error(format!("cannot stop {} before deleting: {e}", c.short())))?;
    }
    // rename first: the slot is either whole or gone, never a half-deleted folder without its instance.json (which
    // `destroy` would then refuse as foreign); a delete that fails leaves slotN.deleting, cleaned by the next call
    let gone = deleting_dir(&dir);
    std::fs::rename(&dir, &gone).map_err(|e| PosctlError::error(format!("cannot remove {} (is a file in it open?): {e}", dir.display())))?;
    std::fs::remove_dir_all(&gone).map_err(|e| PosctlError::error(format!("{} was set aside but not fully deleted ({e}); `dev destroy --slot {slot}` finishes it", gone.display())))?;
    Ok(Outcome::ok("dev instance destroyed", json!({"destroyed": true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Code;
    use crate::firstadmin::{FirstAdmin, FirstAdminError};
    use crate::paths::Roots;
    use crate::runtime::Runtime;
    use crate::secrets;
    use crate::services::Component;
    use serde_json::Value;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::{Mutex, MutexGuard};
    use std::time::Duration;

    /// The tests below point POSCTL_DEV_ROOT at their own folder; they must not interleave.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Holds ENV_LOCK; removes the variables a test set when it ends.
    #[allow(dead_code)] // held for its Drop and the lock
    struct EnvGuard(MutexGuard<'static, ()>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for k in ["POSCTL_DEV_ROOT", "DATABASE_URL", "GOTRUE_JWT_SECRET"] {
                std::env::remove_var(k);
            }
        }
    }
    fn env_lock() -> EnvGuard {
        EnvGuard(ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn with_root() -> (tempfile::TempDir, EnvGuard) {
        let guard = env_lock();
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("POSCTL_DEV_ROOT", d.path());
        (d, guard)
    }

    // ---- a scripted host: no process is ever started or killed ----------------------------------------------------

    #[derive(Default)]
    struct FakeState {
        /// pid -> (full image path, creation time)
        alive: HashMap<u32, (String, u64)>,
        lookup_fails: bool,
        spawned: Vec<Spec>,
        ran: Vec<Spec>,
        killed: Vec<u32>,
        next_pid: u32,
        kill_works: bool,
        run_kills: Option<u32>,
    }
    struct FakeHost(RefCell<FakeState>);
    impl FakeHost {
        fn new() -> Self {
            FakeHost(RefCell::new(FakeState { next_pid: 1000, kill_works: true, ..Default::default() }))
        }
        fn alive(self, pid: u32, created: u64, image: &str) -> Self {
            self.0.borrow_mut().alive.insert(pid, (image.into(), created));
            self
        }
    }
    impl Host for &FakeHost {
        fn identity(&self, pid: u32) -> Result<Option<ProcIdentity>, String> {
            let s = self.0.borrow();
            if s.lookup_fails {
                return Err("access denied".into());
            }
            Ok(s.alive.get(&pid).map(|(image, created)| ProcIdentity { image: image.clone(), created: *created }))
        }
        fn kill_tree(&self, pid: u32) -> Result<(), String> {
            let mut s = self.0.borrow_mut();
            s.killed.push(pid);
            if s.kill_works {
                s.alive.remove(&pid);
            }
            Ok(())
        }
        fn spawn(&self, spec: &Spec) -> Result<Spawned, String> {
            let mut s = self.0.borrow_mut();
            s.next_pid += 1;
            let pid = s.next_pid;
            let created = 7000 + u64::from(pid);
            s.alive.insert(pid, (spec.exe.display().to_string(), created));
            s.spawned.push(spec.clone());
            Ok(Spawned { pid, created })
        }
        fn run(&self, spec: &Spec, _t: Duration) -> Result<i32, String> {
            let mut s = self.0.borrow_mut();
            s.ran.push(spec.clone());
            if let Some(pid) = s.run_kills {
                s.alive.remove(&pid); // pg_ctl stop ended the postmaster
            }
            Ok(0)
        }
    }

    fn instance(dir: &Path) -> (Roots, PathBuf) {
        let pack = dir.join("pack");
        std::fs::create_dir_all(&pack).unwrap();
        let roots = instance_roots(dir, &pack);
        std::fs::create_dir_all(roots.secrets()).unwrap();
        std::fs::create_dir_all(roots.logs()).unwrap();
        (roots, pack)
    }

    fn dp<'a>(dir: &Path, pack: &Path, host: &'a FakeHost) -> DevProcesses<&'a FakeHost> {
        let mut d = DevProcesses::with_host(dir.to_path_buf(), pack.to_path_buf(), host);
        d.settle = Duration::from_millis(0);
        d
    }

    /// The exe a component's process must be running in this instance.
    fn exe_of(roots: &Roots, pack: &Path, c: Component) -> String {
        services::component_command(roots, pack, c).remove(0)
    }

    fn pids_text(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("pids.json")).unwrap()
    }

    fn pids(dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("pids.json")).unwrap()).unwrap()
    }

    // ---- the brief's tests -----------------------------------------------------------------------------------------

    #[test]
    fn instances_live_in_slot_folders_and_slots_are_bounded() {
        let (d, _g) = with_root();
        assert_eq!(instance_dir(3).unwrap(), d.path().join("slot3"));
        assert_eq!(instance_dir(10).unwrap_err().code, Code::Usage);
    }

    #[test]
    fn taskkill_arguments_and_spawn_flags() {
        assert_eq!(taskkill_args(42), ["/PID", "42", "/T", "/F"]);
        assert_eq!(spawn_flags(false), 0x0800_0000 | 0x0000_0200, "no window, own process group");
        assert_eq!(spawn_flags(true), spawn_flags(false) | 0x0100_0000, "breakaway from the caller's job object");
    }

    #[test]
    fn app_env_splits_the_browser_url_from_the_service_role_url() {
        let d = tempfile::tempdir().unwrap();
        secrets::ensure(d.path(), false).unwrap();
        let s = secrets::load(d.path()).unwrap();
        let inst = InstanceFile { slot: 2, ports: crate::config::PortsCfg { base: 47420 }, pack_dir: "X:\\p".into(), tls: "off".into(), created_at: "t".into() };
        let kv = crate::render::parse_dotenv(&app_env(&inst, &s, Some(("Dev Admin", "246810"))));
        let get = |k: &str| kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!((get("E2E_ADMIN_NAME").as_str(), get("E2E_ADMIN_PIN").as_str()), ("Dev Admin", "246810"));
        assert!(!crate::render::parse_dotenv(&app_env(&inst, &s, None)).iter().any(|(k, _)| k.starts_with("E2E_ADMIN_N") || k == "E2E_ADMIN_PIN"), "unseeded: absent");
        assert_eq!(get("VITE_SUPABASE_URL"), "http://127.0.0.1:47424");
        assert_eq!(get("E2E_ADMIN_SUPABASE_URL"), "http://127.0.0.1:47425");
        assert_eq!(get("VITE_STORE_MODE"), "offline-only");
        assert_eq!(get("VITE_SUPABASE_ANON_KEY"), s.anon_key.expose());
        assert!(!kv.iter().any(|(k, _)| k.contains("PEPPER") || k.contains("JWT_SECRET")));
        assert!(!kv.iter().any(|(k, v)| k.starts_with("VITE_") && v == s.service_role_key.expose()), "the service-role key never goes in a VITE_ variable");
    }

    #[test]
    fn an_internal_instance_serves_its_lan_listener_over_https_and_the_internal_one_stays_http() {
        let d = tempfile::tempdir().unwrap();
        secrets::ensure(d.path(), false).unwrap();
        let s = secrets::load(d.path()).unwrap();
        let inst = InstanceFile { slot: 1, ports: crate::config::PortsCfg { base: 47410 }, pack_dir: "X:\\p".into(), tls: "internal".into(), created_at: "t".into() };
        let kv = crate::render::parse_dotenv(&app_env(&inst, &s, None));
        let get = |k: &str| kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("VITE_SUPABASE_URL"), "https://127.0.0.1:47414");
        assert_eq!(get("E2E_ADMIN_SUPABASE_URL"), "http://127.0.0.1:47415");
    }

    #[test]
    fn render_gateway_honours_tls_internal_and_refuses_an_unknown_mode() {
        let d = tempfile::tempdir().unwrap();
        render_gateway(d.path(), "internal").unwrap();
        let live = std::fs::read_to_string(d.path().join("Caddyfile.live")).unwrap();
        assert!(live.contains("https://127.0.0.1:47984, https://localhost:47984") && live.contains("tls internal") && live.contains("bind 127.0.0.1"), "{live}");
        let o = tempfile::tempdir().unwrap();
        render_gateway(o.path(), "off").unwrap();
        assert!(!std::fs::read_to_string(o.path().join("Caddyfile.live")).unwrap().contains("tls internal"));
        assert_eq!(render_gateway(o.path(), "on").unwrap_err().code, Code::Usage);
    }

    #[test]
    fn an_unknown_tls_mode_is_usage_and_destroy_refuses_a_foreign_folder() {
        let (d, _g) = with_root();
        assert_eq!(new(0, Path::new("."), "strict").unwrap_err().code, Code::Usage);
        let foreign = d.path().join("slot5");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("precious.txt"), "x").unwrap();
        assert_eq!(destroy(5).unwrap_err().code, Code::Precondition);
        assert!(foreign.join("precious.txt").exists());
        assert!(!destroy(6).unwrap().data["destroyed"].as_bool().unwrap());
    }

    #[test]
    fn destroy_refuses_an_instance_json_that_is_not_ours_or_names_another_slot() {
        let (d, _g) = with_root();
        let dir = d.path().join("slot4");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("instance.json"), "{\"hello\":1}").unwrap();
        std::fs::write(dir.join("precious.txt"), "x").unwrap();
        assert_eq!(destroy(4).unwrap_err().code, Code::Precondition);
        let other = InstanceFile { slot: 7, ports: crate::config::PortsCfg { base: 47470 }, pack_dir: "X:\\p".into(), tls: "off".into(), created_at: "t".into() };
        std::fs::write(dir.join("instance.json"), serde_json::to_string(&other).unwrap()).unwrap();
        assert_eq!(destroy(4).unwrap_err().code, Code::Precondition, "an instance.json copied from another slot");
        assert!(dir.join("precious.txt").exists());
    }

    fn write_instance(dir: &Path, slot: u8, base: u16) {
        std::fs::create_dir_all(dir).unwrap();
        let inst = InstanceFile { slot, ports: crate::config::PortsCfg { base }, pack_dir: "X:\\p".into(), tls: "off".into(), created_at: "t".into() };
        std::fs::write(dir.join("instance.json"), serde_json::to_string(&inst).unwrap()).unwrap();
    }

    #[test]
    fn an_instance_json_that_names_another_slot_or_port_block_is_refused_by_every_command() {
        let (d, _g) = with_root();
        let dir = d.path().join("slot4");
        write_instance(&dir, 7, 47470); // copied from slot 7
        for r in [start(4), stop(4), env(4), seed_first_admin(4, Some("135790".into()))] {
            assert_eq!(r.unwrap_err().code, Code::Precondition);
        }
        write_instance(&dir, 4, 47470); // right slot, another slot's ports
        assert_eq!(start(4).unwrap_err().code, Code::Precondition);
        write_instance(&dir, 4, 47440);
        assert_ne!(env(4).unwrap_err().code, Code::Precondition, "a consistent file passes the check (and then finds no secrets)");
    }

    #[test]
    fn a_failed_destroy_never_leaves_a_slot_without_its_instance_json_and_a_leftover_is_cleaned() {
        let (d, _g) = with_root();
        let dir = d.path().join("slot2");
        write_instance(&dir, 2, 47420);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data").join("a.txt"), "x").unwrap();
        // a leftover of an interrupted destroy
        let left = d.path().join("slot2.deleting");
        std::fs::create_dir_all(left.join("data")).unwrap();
        std::fs::write(left.join("data").join("old.txt"), "x").unwrap();
        assert!(destroy(2).unwrap().data["destroyed"].as_bool().unwrap());
        assert!(!dir.exists() && !left.exists());
        // only a leftover: destroy cleans it and reports nothing to destroy
        std::fs::create_dir_all(&left).unwrap();
        assert!(!destroy(2).unwrap().data["destroyed"].as_bool().unwrap());
        assert!(!left.exists());
        // `new` also clears one (it then fails on the missing pack, after the cleanup)
        std::fs::create_dir_all(&left).unwrap();
        let _ = new(2, Path::new("X:\\no-such-pack"), "off");
        assert!(!left.exists());
    }

    #[test]
    fn destroy_sets_the_folder_aside_before_deleting_it() {
        let src = include_str!("dev.rs");
        let code = src.split("pub fn destroy").nth(1).unwrap().split("#[cfg(test)]").next().unwrap();
        let (rename, delete) = (code.find("std::fs::rename").unwrap(), code.find("remove_dir_all(&gone)").unwrap());
        assert!(rename < delete, "slotN is renamed to slotN.deleting first");
        assert!(!code.contains("remove_dir_all(&dir)"));
    }

    #[test]
    fn the_dev_root_must_be_absolute_and_outside_the_production_folders() {
        let (d, _g) = with_root();
        std::env::set_var("POSCTL_DEV_ROOT", "relative\\dir");
        assert_eq!(instance_dir(1).unwrap_err().code, Code::Usage);
        for bad in ["C:\\ProgramData\\SupermarketPOS", "C:\\ProgramData\\SupermarketPOS\\dev", "c:/programdata/supermarketpos/x", "C:\\Program Files\\SupermarketPOS\\t"] {
            std::env::set_var("POSCTL_DEV_ROOT", bad);
            assert_eq!(dev_root().unwrap_err().code, Code::Usage, "{bad}");
            assert_eq!(destroy(1).unwrap_err().code, Code::Usage, "{bad}");
        }
        std::env::set_var("POSCTL_DEV_ROOT", "C:\\ProgramData\\SupermarketPOS-dev"); // a sibling, not a child
        assert!(dev_root().is_ok());
        std::env::set_var("POSCTL_DEV_ROOT", d.path());
        assert_eq!(dev_root().unwrap(), d.path());
    }

    #[test]
    fn instance_json_carries_the_base_port_as_ports_base() {
        let inst = InstanceFile { slot: 1, ports: crate::config::PortsCfg { base: 47410 }, pack_dir: "X:\\p".into(), tls: "off".into(), created_at: "t".into() };
        let v: Value = serde_json::to_value(&inst).unwrap();
        assert_eq!(v["ports"]["base"], 47410);
        assert!(v.get("basePort").is_none());
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["createdAt", "packDir", "ports", "slot", "tls"]);
    }

    #[test]
    fn the_gateway_renderer_writes_both_contract_files() {
        let d = tempfile::tempdir().unwrap();
        let out = render_gateway(d.path(), "off").unwrap();
        assert_eq!(out.data["modePort"], 47988);
        assert_eq!((out.data["gotruePort"].as_u64(), out.data["restPort"].as_u64(), out.data["functionsPort"].as_u64()), (Some(47981), Some(47982), Some(47983)));
        assert_eq!((out.data["anonKey"].as_str(), out.data["serviceRoleKey"].as_str()), (Some("anonhead.anonpayload.anonsig1"), Some("svchead1.svcpayloadtest.signature")));
        let live = std::fs::read_to_string(d.path().join("Caddyfile.live")).unwrap();
        let maint = std::fs::read_to_string(d.path().join("Caddyfile.maintenance")).unwrap();
        assert!(live.contains("anonhead.anonpayload.anonsig1") && live.contains("svcpayloadtest") && maint.contains("STORE_UPDATING"));
    }

    #[test]
    fn a_missing_instance_is_reported_as_not_provisioned() {
        let (_d, _g) = with_root();
        assert_eq!(start(7).unwrap_err().code, Code::NotProvisioned);
        assert_eq!(stop(7).unwrap_err().code, Code::NotProvisioned);
        assert_eq!(env(7).unwrap_err().code, Code::NotProvisioned);
    }

    // ---- the child-process runtime ---------------------------------------------------------------------------------

    #[test]
    fn start_spawns_the_component_with_its_own_environment_and_records_the_pid() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(roots.gotrue_env(), "GOTRUE_API_PORT=47421\nDATABASE_URL=postgres://x\n").unwrap();
        let host = FakeHost::new();
        let rt = dp(d.path(), &pack, &host);
        rt.start(&roots, &pack, Component::Auth).unwrap();
        let s = host.0.borrow();
        let spec = &s.spawned[0];
        assert!(spec.exe.ends_with("bin\\auth.exe"), "{:?}", spec.exe);
        assert_eq!(spec.args, ["-c".to_string(), roots.gotrue_env().display().to_string(), "serve".into()]);
        let env = |k: &str| spec.env.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        assert_eq!(env("GOTRUE_API_PORT").as_deref(), Some("47421"), "gotrue.env is passed explicitly");
        assert_eq!(env("DATABASE_URL").as_deref(), Some("postgres://x"));
        assert_eq!(env("TEMP"), Some(roots.tmp_for(Component::Auth.service_name()).display().to_string()), "own TEMP");
        assert!(roots.tmp_for(Component::Auth.service_name()).is_dir(), "the TEMP folder is created");
        assert_eq!(spec.log, Some(roots.logs_for(Component::Auth.service_name()).join("dev.log")));
        assert_eq!(pids(d.path())["Auth"], json!({"pid": 1001, "creationTime": 8001}), "pid and creation time are recorded at spawn");
    }

    #[test]
    fn functions_get_their_secrets_from_the_functions_env_file() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let host = FakeHost::new();
        let rt = dp(d.path(), &pack, &host);
        rt.set_functions_env(&roots, &["A=1".into(), "B=two=2".into()]).unwrap();
        rt.start(&roots, &pack, Component::Functions).unwrap();
        let s = host.0.borrow();
        let env = |k: &str| s.spawned[0].env.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        assert_eq!((env("A").as_deref(), env("B").as_deref()), (Some("1"), Some("two=2")));
    }

    #[test]
    fn start_does_nothing_for_a_component_that_is_running() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{\"Rest\":{\"pid\":77,\"creationTime\":5}}").unwrap();
        let host = FakeHost::new().alive(77, 5, &exe_of(&roots, &pack, Component::Rest));
        dp(d.path(), &pack, &host).start(&roots, &pack, Component::Rest).unwrap();
        assert!(host.0.borrow().spawned.is_empty());
    }

    #[test]
    fn a_recycled_pid_is_not_a_running_component_and_is_never_killed() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{\"Rest\":{\"pid\":4242,\"creationTime\":1}}").unwrap();
        let host = FakeHost::new().alive(4242, 1, "C:\\Windows\\chrome.exe");
        let rt = dp(d.path(), &pack, &host);
        assert_eq!(rt.state_of(Component::Rest).unwrap(), crate::services::ServiceState::Stopped);
        rt.stop(Component::Rest).unwrap();
        assert!(host.0.borrow().killed.is_empty(), "never kill a process that is not ours");
        assert!(pids(d.path()).get("Rest").is_none());
        // and a start replaces the stale entry
        rt.start(&roots, &pack, Component::Rest).unwrap();
        assert_eq!(host.0.borrow().spawned.len(), 1);
    }

    #[test]
    fn the_same_exe_name_from_another_folder_or_another_creation_time_is_never_killed() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let ours = exe_of(&roots, &pack, Component::Postgres);
        let production = "C:\\Program Files\\SupermarketPOS\\packs\\1.0.0\\pg\\bin\\postgres.exe";
        assert_ne!(ours.to_lowercase(), production.to_lowercase());
        std::fs::write(d.path().join("pids.json"), "{\"Postgres\":{\"pid\":900,\"creationTime\":5}}").unwrap();
        // another slot's / the production stack's postgres.exe now owns the recorded pid
        let host = FakeHost::new().alive(900, 5, production);
        dp(d.path(), &pack, &host).stop(Component::Postgres).unwrap();
        // the recorded pid was recycled into a postgres.exe of THIS pack, started later
        let host2 = FakeHost::new().alive(900, 6, &ours);
        let rt2 = dp(d.path(), &pack, &host2);
        std::fs::write(d.path().join("pids.json"), "{\"Postgres\":{\"pid\":900,\"creationTime\":5}}").unwrap();
        assert_eq!(rt2.state_of(Component::Postgres).unwrap(), crate::services::ServiceState::Stopped);
        rt2.stop(Component::Postgres).unwrap();
        for h in [&host, &host2] {
            let s = h.0.borrow();
            assert!(s.killed.is_empty() && s.ran.is_empty(), "no pg_ctl, no taskkill for a process that is not ours");
        }
    }

    #[test]
    fn the_same_exe_with_the_same_creation_time_is_ours_whatever_the_path_spelling() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let shouting = exe_of(&roots, &pack, Component::Gateway).to_uppercase().replace('\\', "/");
        std::fs::write(d.path().join("pids.json"), "{\"Gateway\":{\"pid\":55,\"creationTime\":9}}").unwrap();
        let host = FakeHost::new().alive(55, 9, &shouting);
        dp(d.path(), &pack, &host).stop(Component::Gateway).unwrap();
        assert_eq!(host.0.borrow().killed, [55]);
    }

    #[test]
    fn a_pid_without_a_creation_time_is_unknown_never_running_and_never_killed() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{\"Rest\":4242}").unwrap();
        let host = FakeHost::new().alive(4242, 3, &exe_of(&roots, &pack, Component::Rest));
        let rt = dp(d.path(), &pack, &host);
        assert_eq!(rt.state_of(Component::Rest).unwrap(), crate::services::ServiceState::Stopped);
        rt.stop(Component::Rest).unwrap();
        assert!(host.0.borrow().killed.is_empty());
        assert!(pids(d.path()).get("Rest").is_none(), "the unknown entry is dropped");
    }

    #[test]
    fn a_failed_lookup_is_an_error_and_leaves_pids_json_untouched() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let text = "{\"Rest\":{\"pid\":77,\"creationTime\":5},\"Auth\":{\"pid\":78,\"creationTime\":6}}";
        std::fs::write(d.path().join("pids.json"), text).unwrap();
        let host = FakeHost::new().alive(77, 5, &exe_of(&roots, &pack, Component::Rest));
        host.0.borrow_mut().lookup_fails = true;
        let rt = dp(d.path(), &pack, &host);
        assert!(rt.state_of(Component::Rest).is_err());
        assert!(rt.stop(Component::Rest).is_err(), "not read as stopped");
        assert!(rt.start(&roots, &pack, Component::Rest).is_err(), "not read as not running: no duplicate spawn");
        assert_eq!(pids_text(d.path()), text);
        let s = host.0.borrow();
        assert!(s.spawned.is_empty() && s.killed.is_empty());
    }

    #[test]
    fn a_malformed_pids_json_is_an_error_not_an_empty_list() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{not json").unwrap();
        let host = FakeHost::new();
        let rt = dp(d.path(), &pack, &host);
        assert!(rt.stop(Component::Rest).is_err());
        assert!(rt.start(&roots, &pack, Component::Rest).is_err());
        assert_eq!(pids_text(d.path()), "{not json");
    }

    #[test]
    fn stop_kills_the_tree_of_a_component_whose_image_matches() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{\"Gateway\":{\"pid\":55,\"creationTime\":1},\"Auth\":{\"pid\":56,\"creationTime\":2}}").unwrap();
        let host = FakeHost::new().alive(55, 1, &exe_of(&roots, &pack, Component::Gateway)).alive(56, 2, &exe_of(&roots, &pack, Component::Auth));
        let rt = dp(d.path(), &pack, &host);
        rt.stop(Component::Gateway).unwrap();
        assert_eq!(host.0.borrow().killed, [55]);
        let p = pids(d.path());
        assert!(p.get("Gateway").is_none() && p["Auth"]["pid"] == 56, "only the stopped component leaves pids.json");
    }

    #[test]
    fn postgres_is_stopped_by_pg_ctl_first_and_killed_only_if_it_survives() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let pg = exe_of(&roots, &pack, Component::Postgres);
        std::fs::write(d.path().join("pids.json"), "{\"Postgres\":{\"pid\":900,\"creationTime\":4}}").unwrap();
        let host = FakeHost::new().alive(900, 4, &pg);
        host.0.borrow_mut().run_kills = Some(900);
        dp(d.path(), &pack, &host).stop(Component::Postgres).unwrap();
        {
            let s = host.0.borrow();
            assert!(s.killed.is_empty(), "pg_ctl ended it");
            let ran = &s.ran[0];
            assert!(ran.exe.ends_with("pg\\bin\\pg_ctl.exe"));
            assert_eq!(ran.args, ["-D".to_string(), roots.pgdata().display().to_string(), "-m".into(), "fast".into(), "-w".into(), "-t".into(), "60".into(), "stop".into()]);
        }
        // pg_ctl that leaves it running: the tree is killed
        std::fs::write(d.path().join("pids.json"), "{\"Postgres\":{\"pid\":901,\"creationTime\":4}}").unwrap();
        let host2 = FakeHost::new().alive(901, 4, &pg);
        dp(d.path(), &pack, &host2).stop(Component::Postgres).unwrap();
        assert_eq!(host2.0.borrow().killed, [901]);
    }

    #[test]
    fn stop_fails_and_keeps_the_pid_when_the_process_will_not_die() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        std::fs::write(d.path().join("pids.json"), "{\"Auth\":{\"pid\":56,\"creationTime\":2}}").unwrap();
        let host = FakeHost::new().alive(56, 2, &exe_of(&roots, &pack, Component::Auth));
        host.0.borrow_mut().kill_works = false;
        assert!(dp(d.path(), &pack, &host).stop(Component::Auth).is_err());
        assert_eq!(pids(d.path())["Auth"]["pid"], 56);
    }

    #[test]
    fn the_initdb_script_runs_through_cmd_with_the_postgres_temp_folder() {
        let d = tempfile::tempdir().unwrap();
        let (roots, pack) = instance(d.path());
        let host = FakeHost::new();
        let script = d.path().join("initdb.cmd");
        dp(d.path(), &pack, &host).run_script_as_postgres(&roots, &pack, &script, Duration::from_secs(5)).unwrap();
        let s = host.0.borrow();
        assert!(s.ran[0].exe.ends_with("cmd.exe"));
        assert_eq!(s.ran[0].args.last().unwrap(), &script.display().to_string());
        assert!(s.ran[0].env.iter().any(|(k, v)| k == "TEMP" && *v == roots.tmp_for(Component::Postgres.service_name()).display().to_string()));
    }

    // ---- new / seed-first-admin ------------------------------------------------------------------------------------

    struct Recorder(Rc<RefCell<Vec<Component>>>);
    impl Runtime for Recorder {
        fn name(&self) -> &'static str {
            "recorder"
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
        fn stop(&self, c: Component) -> Result<(), String> {
            self.0.borrow_mut().push(c);
            Ok(())
        }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> {
            Ok(())
        }
        fn unregister(&self, _: Component) -> Result<(), String> {
            Ok(())
        }
        fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_failed_new_keeps_instance_json_stops_everything_dependents_first_and_says_how_to_start_over() {
        let (root, _g) = with_root();
        let pack = root.path().join("src-pack");
        crate::pack::make_fake_pack(&pack, "1.0.0-r1");
        let log = Rc::new(RefCell::new(Vec::<Component>::new()));
        let l2 = log.clone();
        // the fake runtime cannot run initdb, so provisioning fails at that step
        let err = new_with(9, &pack, "off", &move |_, _| Box::new(Recorder(l2.clone()))).unwrap_err();
        assert!(err.message.contains("dev destroy --slot 9"), "{}", err.message);
        let inst: Value = serde_json::from_str(&std::fs::read_to_string(root.path().join("slot9").join("instance.json")).unwrap()).unwrap();
        assert_eq!(inst["ports"]["base"], 47490);
        assert_eq!(inst["tls"], "off");
        assert!(inst["packDir"].as_str().unwrap().ends_with("src-pack"));
        let seen = log.borrow().clone();
        let mut want = Component::ALL.to_vec();
        want.reverse();
        assert_eq!(&seen[seen.len() - 5..], &want[..], "every component is stopped, dependents first");
        // a second `new` on the same slot is refused, not merged
        assert_eq!(new(9, &pack, "off").unwrap_err().code, Code::Precondition);
    }

    fn seeded_fixture(root: &Path, slot: u8) -> PathBuf {
        let dir = root.join(format!("slot{slot}"));
        let roots = instance_roots(&dir, Path::new("X:\\p"));
        std::fs::create_dir_all(roots.secrets()).unwrap();
        secrets::ensure(&roots.secrets(), false).unwrap();
        let inst = InstanceFile { slot, ports: crate::config::PortsCfg { base: 47400 + 10 * u16::from(slot) }, pack_dir: "X:\\p".into(), tls: "off".into(), created_at: "t".into() };
        std::fs::write(dir.join("instance.json"), serde_json::to_string(&inst).unwrap()).unwrap();
        dir
    }

    #[test]
    fn seed_first_admin_registers_the_pin_first_and_redacts_it_from_errors() {
        let (root, _g) = with_root();
        let _dir = seeded_fixture(root.path(), 1);
        let order = RefCell::new(Vec::<String>::new());
        let r = seed_first_admin_with(1, Some("246810".into()), &mut |pin, register| {
            order.borrow_mut().push("create".into());
            register(pin);
            order.borrow_mut().push("registered".into());
            Err(FirstAdminError::Transport(format!("connection refused while sending {pin}")))
        });
        let e = r.unwrap_err();
        assert!(!e.message.contains("246810"), "{}", e.message);
        assert_eq!(e.code, Code::Unhealthy);
        assert!(e.message.contains("dev start --slot 1"), "{}", e.message);
        assert_eq!(*order.borrow(), ["create", "registered"]);
    }

    #[test]
    fn seed_first_admin_refuses_weak_and_malformed_pins_before_any_request() {
        let (root, _g) = with_root();
        let _dir = seeded_fixture(root.path(), 1);
        let called = RefCell::new(false);
        for bad in ["111111", "123456", "654321", "012345", "12345", "1234567", "12345a"] {
            let r = seed_first_admin_with(1, Some(bad.into()), &mut |_, _| {
                *called.borrow_mut() = true;
                Ok(FirstAdmin::AlreadyExists { id: "x".into() })
            });
            assert_eq!(r.unwrap_err().code, Code::Usage, "{bad}");
        }
        assert!(!*called.borrow(), "a refused PIN never reaches the server");
    }

    #[test]
    fn a_created_admin_is_remembered_for_dev_env_and_a_generated_pin_is_shown_once() {
        let (root, _g) = with_root();
        let dir = seeded_fixture(root.path(), 2);
        let seen = RefCell::new(String::new());
        let out = seed_first_admin_with(2, None, &mut |pin, register| {
            register(pin);
            *seen.borrow_mut() = pin.to_string();
            Ok(FirstAdmin::Created { id: "id-1".into(), email: "id-1@barpos.local".into() })
        })
        .unwrap();
        let pin = seen.borrow().clone();
        assert_eq!(pin.len(), 6);
        assert!(!crate::util::is_trivial_pin(&pin));
        assert_eq!(out.secret_once.as_ref().unwrap().value, pin);
        assert!(!serde_json::to_string(&out.data).unwrap().contains(&pin), "the PIN is only in secret_once");
        let admin: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("admin.json")).unwrap()).unwrap();
        assert_eq!((admin["name"].as_str(), admin["pin"].as_str()), (Some("Dev Admin"), Some(pin.as_str())));
        // `dev env` now carries them
        let text = std::fs::read_to_string(env(2).unwrap().data["path"].as_str().unwrap()).unwrap();
        assert!(text.contains(&format!("E2E_ADMIN_PIN={pin}")));
        // a supplied PIN is not echoed
        let out2 = seed_first_admin_with(2, Some("135790".into()), &mut |_, _| Ok(FirstAdmin::Created { id: "i".into(), email: "e".into() })).unwrap();
        assert!(out2.secret_once.is_none());
    }

    #[test]
    fn an_existing_admin_changes_nothing() {
        let (root, _g) = with_root();
        let dir = seeded_fixture(root.path(), 3);
        let out = seed_first_admin_with(3, Some("135790".into()), &mut |_, _| Ok(FirstAdmin::AlreadyExists { id: "old".into() })).unwrap();
        assert!(out.secret_once.is_none());
        assert!(!dir.join("admin.json").exists());
    }

    #[test]
    fn dev_never_touches_the_host_network_or_services() {
        // Instances are plain child processes: no firewall rule, no network profile change, no service, no registry (Task 1 ruling).
        let src = include_str!("dev.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["net::", "netsh", "tasks::", "sc.exe", "winreg", "schtasks"] {
            assert!(!code.contains(forbidden), "dev.rs must not use {forbidden}");
        }
        assert!(!code.contains("0.0.0.0"), "a dev instance never binds the LAN");
        assert!(code.contains("GatewaySettings"), "the gateway bind and TLS mode come from the shared settings, not literals here");
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            let t = to.join(e.file_name());
            if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &t) } else { std::fs::copy(e.path(), &t).unwrap(); }
        }
    }

    /// Unprivileged, loopback, temp folders only: no service, registry, firewall or ACL is touched. Needs a real extracted
    /// pack (the lib test build skips signature checks, so an unsigned folder works) and a non-elevated shell
    /// (Postgres refuses to run elevated).
    #[test]
    #[ignore = "needs POS_DEV_PACK_DIR (an extracted pack folder) and a non-elevated shell; spawns Postgres, GoTrue, PostgREST, Functions and Caddy on 127.0.0.1:47490-47499"]
    fn a_real_instance_provisions_starts_seeds_and_stops() {
        let (root, _g) = with_root();
        let src = PathBuf::from(std::env::var("POS_DEV_PACK_DIR").expect("POS_DEV_PACK_DIR"));
        let pack = root.path().join("pack");
        copy_dir(&src, &pack); // provisioning copies extension stubs into the pack: never into the shared folder
        let made = new(9, &pack, "off");
        let dir = root.path().join("slot9");
        let result = (|| -> Result<(), String> {
            made.map_err(|e| e.to_string())?;
            start(9).map_err(|e| e.to_string())?;
            let o = seed_first_admin(9, None).map_err(|e| e.to_string())?;
            let pin = o.secret_once.expect("a generated PIN").value;
            let again = seed_first_admin(9, Some(pin)).map_err(|e| e.to_string())?;
            assert_eq!(again.message, "an admin already exists");
            let e = env(9).map_err(|e| e.to_string())?;
            assert!(std::fs::read_to_string(e.data["path"].as_str().unwrap()).unwrap().contains("E2E_ADMIN_PIN="));
            stop(9).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = stop(9);
        let destroyed = destroy(9);
        assert!(result.is_ok(), "{result:?}");
        assert!(destroyed.unwrap().data["destroyed"].as_bool().unwrap() && !dir.exists());
    }

    /// Helper for `a_started_daemon_does_not_keep_the_callers_pipe_open`: runs in its own process, starts a
    /// long-lived child through the real host, prints its pid and exits.
    #[cfg(windows)]
    #[test]
    #[ignore = "helper process; only does anything when POSCTL_TEST_DAEMON_HELPER is set"]
    fn daemon_helper() {
        if std::env::var_os("POSCTL_TEST_DAEMON_HELPER").is_none() {
            return;
        }
        let cmd = crate::sys::system_dir().unwrap().join("cmd.exe");
        let spec = Spec { exe: cmd, args: vec!["/d".into(), "/c".into(), "ping -n 12 127.0.0.1 >nul".into()], cwd: std::env::temp_dir(), env: vec![], log: None };
        println!("DAEMON {}", WinHost.spawn(&spec).unwrap().pid);
    }

    /// A caller that reads posctl's stdout to the end (Node's execFile, PowerShell `$(...)`) must get EOF when posctl
    /// exits, not when the daemon it started exits: the daemon must not inherit the caller's pipe.
    #[cfg(windows)]
    #[test]
    fn a_started_daemon_does_not_keep_the_callers_pipe_open() {
        use std::io::Read;
        let exe = std::env::current_exe().unwrap();
        let mut helper = std::process::Command::new(exe)
            .args(["--exact", "dev::tests::daemon_helper", "--ignored", "--nocapture", "--test-threads=1"])
            .env("POSCTL_TEST_DAEMON_HELPER", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut out = String::new();
        let t0 = Instant::now();
        helper.stdout.take().unwrap().read_to_string(&mut out).unwrap(); // EOF only when every holder of the pipe is gone
        let waited = t0.elapsed();
        helper.wait().unwrap();
        let pid: u32 = out.lines().find_map(|l| l.split_once("DAEMON ").map(|(_, p)| p)).expect("the helper printed the daemon pid").trim().parse().unwrap();
        if WinHost.identity(pid).unwrap().is_some_and(|i| i.image.to_lowercase().ends_with("\\cmd.exe")) {
            WinHost.kill_tree(pid).unwrap(); // our own daemon, by pid
        }
        assert!(waited < Duration::from_secs(8), "the caller's pipe stayed open for {waited:?}: the daemon inherited it");
    }

    // ---- the real host, against processes this test starts and stops itself ----------------------------------------

    #[cfg(windows)]
    #[test]
    fn the_real_host_scrubs_the_environment_and_kills_only_its_own_tree() {
        let _g = env_lock(); // restores the variables set below when the test ends
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("DATABASE_URL", "postgres://leak");
        std::env::set_var("GOTRUE_JWT_SECRET", "leak");
        let log = d.path().join("env.log");
        let cmd = crate::sys::system_dir().unwrap().join("cmd.exe");
        let host = WinHost;
        let spec = Spec { exe: cmd.clone(), args: vec!["/d".into(), "/c".into(), "set".into()], cwd: d.path().to_path_buf(), env: vec![("FOO".into(), "bar".into())], log: Some(log.clone()) };
        let pid = host.spawn(&spec).unwrap().pid;
        for _ in 0..100 {
            if host.identity(pid).unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.contains("FOO=bar") && text.to_lowercase().contains("systemroot="), "{text}");
        assert!(!text.contains("DATABASE_URL") && !text.contains("GOTRUE_JWT_SECRET"), "inherited variables leaked into the child");
        // a long-lived child: found by pid, image matches, killed by pid
        let sleeper = Spec { exe: cmd, args: vec!["/d".into(), "/c".into(), "ping -n 60 127.0.0.1 >nul".into()], cwd: d.path().to_path_buf(), env: vec![], log: None };
        let started = host.spawn(&sleeper).unwrap();
        let id = host.identity(started.pid).unwrap().expect("running");
        assert!(id.image.to_lowercase().ends_with("\\cmd.exe"), "the full image path: {}", id.image);
        assert_eq!(id.created, started.created, "the creation time recorded at spawn is the live one");
        host.kill_tree(started.pid).unwrap();
        for _ in 0..50 {
            if host.identity(started.pid).unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(host.identity(started.pid).unwrap(), None);
    }
}
