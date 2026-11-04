//! `posctl provision`: preflight, layout, then thirteen journaled steps (conventions 7 and 11.3).
//! Fail closed: any failing step stops the run, is recorded as `failed`, and leaves the machine for
//! `provision --resume` (rerunnable steps) or `unprovision --delete-data` (nothing but the first
//! admin exists yet, so starting over loses nothing). It must never write a secret into an error,
//! the journal or the envelope: every tool output goes through the run's `Redactor` first, the
//! initdb password file is deleted on every path, and no long-lived server is started through `exec`.
//!
//! `network` (after `secrets`) and `tasks` (before `first_admin`) are Plan 05b's: they change the machine outside
//! the data root (Windows network profile, firewall rule, Task Scheduler), so a dev root skips both. Everything they
//! touch goes through `HostOps`, which tests replace. Insert point for Plan 06: `pki` (after `start_stack`), one
//! `StepDef` plus one match arm.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::acl;
use crate::canary;
use crate::conf;
use crate::config::{self, classify_data_root, DataDecision, PosctlJson};
use crate::envelope::{Code, Outcome, PosctlError, SecretOnce};
use crate::exec::Cmd;
use crate::firstadmin::{self, Endpoint, FirstAdmin};
use crate::gateway::GatewaySettings;
use crate::journal::{resume_index, Journal, StepDef, StepState};
use crate::layout;
use crate::ops::lock::{acquire_for, LockMode};
use crate::pack::{self, Pack};
use crate::paths::Roots;
use crate::pg::{self, PgTools, Psql};
use crate::ports::{self, Ports};
use crate::probe;
use crate::render::{self, RenderInput};
use crate::runorder;
use crate::net::{self, Confirmation};
use crate::runtime::Runtime;
use crate::secrets::{self, Secrets};
use crate::services::Component;
use crate::staff_password::acceptable_pepper;
use crate::sys;
use crate::util::{clear_dir, is_trivial_pin, is_uuid_v4, now_rfc3339, random_digits6, random_uuid_v4, Redactor};

const MIN_FREE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
pub const STEPS: [StepDef; 14] = [
    StepDef { name: "secrets", rerunnable: true },
    StepDef { name: "network", rerunnable: true }, // Plan 05b; skipped for a dev root
    StepDef { name: "initdb", rerunnable: true }, // a partial cluster is wiped and redone (always, no PG_VERSION shortcut)
    StepDef { name: "services", rerunnable: true },
    // Shawl mitigation O1 / Q6: raise WaitToKillServiceTimeout to 30000 through `rt.raise_shutdown_timeout()`,
    // remember the previous value for `provisioned.json` / `unprovision`
    StepDef { name: "shutdown_timeout", rerunnable: true },
    StepDef { name: "start_postgres", rerunnable: true },
    // Executes sql\run-order.json; it journals each of its own steps as `ro:<id>` and knows
    // which of them may be repeated (see runorder::Step::rerunnable).
    StepDef { name: "run_order", rerunnable: true },
    StepDef { name: "start_stack", rerunnable: true },
    // `canary` and `client_files` do not need the admin, so they run BEFORE `first_admin`; the
    // step that mints the once-only PIN is the last one that can fail before `finalize`
    StepDef { name: "canary", rerunnable: true },
    StepDef { name: "client_files", rerunnable: true },
    // The server PC trusts its own store CA and writes its own `client\store.env` (conventions 8.3): the ONLY writer of that file
    // on a provisioned server. After `canary` (the Gateway is up, Caddy has issued its root) and before `first_admin`.
    StepDef { name: "store_trust", rerunnable: true },
    StepDef { name: "tasks", rerunnable: true }, // Plan 05b; skipped for a dev root. Before first_admin: nothing after the PIN-bearing step may fail
    StepDef { name: "first_admin", rerunnable: true },
    StepDef { name: "finalize", rerunnable: true },
];

#[derive(Clone, Default)]
pub struct ProvisionArgs {
    /// `auto` (highest installed pack) or the directory of an installed pack.
    pub pack: String,
    pub server_host: Option<String>,
    pub base_port: Option<u16>,
    /// `--confirm-private-network[=<alias>...]`: the owner says the Public network(s) named (or the one Public network)
    /// is the shop network and may be switched to Private. `None` = not confirmed.
    pub confirm_private_network: Option<Confirmation>,
    pub first_admin_name: Option<String>,
    /// The PIN read from stdin, if `--first-admin-pin-stdin` was given.
    pub pin: Option<String>,
    pub resume: bool,
    /// Dev instances only (`posctl dev new`): do not create the first admin.
    pub skip_first_admin: bool,
    /// `--prepare-for-switch` (Plan 09/11). Builds the whole local stack for an owner who is moving an
    /// existing cloud store: `conf\posctl.json` and `provisioned.json` record mode `cloud`, the
    /// `first_admin` step is skipped (the staff come from the cloud copy at the switch) and no `store.env`
    /// is written (it is never written by provision at all). The switch itself stays a console/runbook action.
    pub prepare_for_switch: bool,
    /// True only when stdout is an interactive terminal AND no `--result-file` was given (set by `cli.rs`
    /// from `std::io::IsTerminal`). A generated first-admin PIN needs this: otherwise no one can read it
    /// (a run launched with `runas` or from NSIS has no readable stdout).
    pub interactive: bool,
    /// Gateway TLS mode, bind and hosts. `None` keeps `state\gateway.json` (plain loopback HTTP on a first run).
    /// Only `posctl dev new --tls internal` sets it today; production provision is wired by Plan 06 Tasks 7 and 9.
    pub gateway: Option<GatewaySettings>,
}

/// Hand-written so a `{:?}` of the arguments (a log line, a failed assertion) can never print the first admin's PIN.
impl std::fmt::Debug for ProvisionArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProvisionArgs")
            .field("pack", &self.pack)
            .field("server_host", &self.server_host)
            .field("base_port", &self.base_port)
            .field("confirm_private_network", &self.confirm_private_network)
            .field("first_admin_name", &self.first_admin_name)
            .field("pin", &self.pin.as_ref().map(|_| "<redacted>"))
            .field("resume", &self.resume)
            .field("skip_first_admin", &self.skip_first_admin)
            .field("prepare_for_switch", &self.prepare_for_switch)
            .field("interactive", &self.interactive)
            .field("gateway", &self.gateway)
            .finish()
    }
}

pub enum PinPlan {
    /// No first admin is created (`skip_first_admin` or `prepare_for_switch`).
    None,
    /// The caller supplied the PIN (`--first-admin-pin-stdin`; later Plan 11's pipe, ruling C8).
    Supplied,
    /// Generate a PIN and show it once; only allowed when `interactive`.
    Generate,
}

/// Decided BEFORE anything is created. A bad supplied PIN or a missing way to show a generated one is
/// `USAGE`, so a failed run never leaves a first admin whose PIN nobody has seen.
pub fn pin_plan(args: &ProvisionArgs) -> Result<PinPlan, PosctlError> {
    if args.skip_first_admin || args.prepare_for_switch {
        return Ok(PinPlan::None);
    }
    match &args.pin {
        Some(pin) if pin.len() == 6 && pin.bytes().all(|c| c.is_ascii_digit()) && is_trivial_pin(pin) => Err(PosctlError::new(Code::Usage, "the first admin PIN is too easy to guess (a repeated digit or a run like 123456); choose another")),
        Some(pin) if pin.len() == 6 && pin.bytes().all(|c| c.is_ascii_digit()) => Ok(PinPlan::Supplied),
        Some(_) => Err(PosctlError::new(Code::Usage, "the first admin PIN must be exactly six digits")),
        None if args.interactive => Ok(PinPlan::Generate),
        None => Err(PosctlError::new(Code::Usage, "no terminal to show a generated first-admin PIN on (or --result-file was given): pass --first-admin-pin-stdin")),
    }
}

/// A resumed run whose `first_admin` step is already done needs no PIN at all (an NSIS resume passes none).
pub fn pin_plan_for_run(args: &ProvisionArgs, first_admin_done: bool) -> Result<PinPlan, PosctlError> {
    if first_admin_done { Ok(PinPlan::None) } else { pin_plan(args) }
}

/// The arguments a resumed run really uses: the plan (first admin name, `--prepare-for-switch`,
/// `--skip-first-admin`) comes from the journal. An argument that was GIVEN and disagrees is `USAGE`; a flag that
/// was left out means "as in the journal".
fn resume_args(args: &ProvisionArgs, params: &Value) -> Result<ProvisionArgs, PosctlError> {
    let usage = |m: String| PosctlError::new(Code::Usage, format!("{m}; omit it, or run unprovision --delete-data and provision again"));
    let mut eff = args.clone();
    if let Some(j) = params.get("firstAdminName").and_then(Value::as_str) {
        if let Some(a) = &args.first_admin_name {
            if a != j {
                return Err(usage(format!("--first-admin-name '{a}' disagrees with the run being resumed ('{j}')")));
            }
        }
        eff.first_admin_name = Some(j.to_string());
    }
    // The journal holds what the owner confirmed (the aliases a bare flag resolved to). A resume may repeat it, or the bare
    // flag, but never name other networks: that would open a network the first run never saw.
    let journaled = confirmation_from_json(params.get("confirmPrivateNetwork").unwrap_or(&Value::Null));
    eff.confirm_private_network = match (&args.confirm_private_network, journaled) {
        (None, j) => j,
        (Some(Confirmation::Bare), Some(j)) => Some(j),
        (Some(Confirmation::Aliases(a)), Some(Confirmation::Aliases(j))) => {
            let norm = |v: &[String]| {
                let mut v: Vec<String> = v.iter().map(|x| x.to_lowercase()).collect();
                v.sort();
                v.dedup();
                v
            };
            if norm(a) != norm(&j) {
                return Err(usage(format!("--confirm-private-network names {a:?}, but the run being resumed confirmed {j:?}")));
            }
            Some(Confirmation::Aliases(j))
        }
        (Some(a), _) => Some(a.clone()),
    };
    if let Some(j) = params.get("prepareForSwitch").and_then(Value::as_bool) {
        if args.prepare_for_switch && !j {
            return Err(usage("--prepare-for-switch disagrees with the run being resumed (it was started without it)".to_string()));
        }
        eff.prepare_for_switch = j;
    }
    if let Some(j) = params.get("skipFirstAdmin").and_then(Value::as_bool) {
        if args.skip_first_admin && !j {
            return Err(usage("--skip-first-admin disagrees with the run being resumed (it was started without it)".to_string()));
        }
        eff.skip_first_admin = j;
    }
    Ok(eff)
}

/// A journal's store id is trusted only as a UUID v4 (it ends up in files, URLs and the license).
fn store_id_for(journal_value: Option<&str>) -> Result<String, PosctlError> {
    match journal_value {
        Some(v) if is_uuid_v4(v) => Ok(v.to_string()),
        Some(_) => Err(PosctlError::new(Code::RecoveryNeeded, "the provision journal holds a storeId that is not a UUID v4; run unprovision --delete-data and provision again")),
        None => random_uuid_v4().map_err(PosctlError::error),
    }
}

/// Never a PIN anyone would try first.
pub(crate) fn fresh_pin() -> Result<String, String> {
    loop {
        let p = random_digits6()?;
        if !is_trivial_pin(&p) {
            return Ok(p);
        }
    }
}

pub fn target_mode(args: &ProvisionArgs) -> &'static str {
    if args.prepare_for_switch { "cloud" } else { "offline-only" }
}

/// The journal's form of the confirmation: `null`, `"bare"` or the list of aliases.
fn confirmation_to_json(c: &Option<Confirmation>) -> Value {
    match c {
        None => Value::Null,
        Some(Confirmation::Bare) => json!("bare"),
        Some(Confirmation::Aliases(a)) => json!(a),
    }
}

fn confirmation_from_json(v: &Value) -> Option<Confirmation> {
    match v {
        Value::String(s) if s == "bare" => Some(Confirmation::Bare),
        Value::Array(a) => Some(Confirmation::Aliases(a.iter().filter_map(|x| x.as_str().map(String::from)).collect())),
        Value::Bool(true) => Some(Confirmation::Bare), // a journal written before aliases existed
        _ => None,
    }
}

/// What the `network` and `tasks` steps do to the machine, behind one seam so no test (and no dev root) can reach the
/// real firewall, network profiles or Task Scheduler by accident.
pub trait HostOps {
    fn read_profiles(&self) -> Result<Vec<net::Profile>, String>;
    fn fix_profiles(&self, confirmation: &Confirmation) -> Result<Vec<String>, String>;
    fn ensure_rule(&self, ports: &Ports) -> Result<(), String>;
    fn install_tasks(&self, exe: &std::path::Path) -> Result<Vec<String>, String>;
    /// The machine's preferred IPv4 addresses, for the certificate's site names.
    fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String>;
    /// `paircmd::server_self_pair`: installs the store CA into LocalMachine\Root and writes `client\store.env`.
    fn self_pair(&self, roots: &Roots) -> Result<Value, PosctlError>;
}

pub struct RealHost;

impl HostOps for RealHost {
    fn read_profiles(&self) -> Result<Vec<net::Profile>, String> {
        net::read_profiles()
    }
    fn fix_profiles(&self, confirmation: &Confirmation) -> Result<Vec<String>, String> {
        net::fix_profiles(confirmation)
    }
    fn ensure_rule(&self, ports: &Ports) -> Result<(), String> {
        net::ensure_rule(ports)
    }
    fn install_tasks(&self, exe: &std::path::Path) -> Result<Vec<String>, String> {
        crate::tasks::install(exe)
    }
    fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> {
        crate::pki::san::detect_local_ipv4s().map_err(|e| e.to_string())
    }
    fn self_pair(&self, roots: &Roots) -> Result<Value, PosctlError> {
        // Caddy issues its root asynchronously after the Gateway starts, so wait for it
        crate::paircmd::server_self_pair(roots, !roots.dev, Duration::from_secs(30))
    }
}

/// The default in unit tests: any test that reaches the machine through a step must say so with a fake.
#[cfg(test)]
struct NoHost;

#[cfg(test)]
impl HostOps for NoHost {
    fn read_profiles(&self) -> Result<Vec<net::Profile>, String> {
        panic!("a test reached the real network profiles")
    }
    fn fix_profiles(&self, _: &Confirmation) -> Result<Vec<String>, String> {
        panic!("a test reached Set-NetConnectionProfile")
    }
    fn ensure_rule(&self, _: &Ports) -> Result<(), String> {
        panic!("a test reached the firewall")
    }
    fn install_tasks(&self, _: &std::path::Path) -> Result<Vec<String>, String> {
        panic!("a test reached the Task Scheduler")
    }
    fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> {
        panic!("a test reached Get-NetIPAddress")
    }
    fn self_pair(&self, _: &Roots) -> Result<Value, PosctlError> {
        panic!("a test reached the certificate store")
    }
}

struct Cx<'a> {
    roots: &'a Roots,
    rt: &'a dyn Runtime,
    ops: &'a dyn HostOps,
    confirm: Option<Confirmation>,
    ports: Ports,
    host: String,
    pack: Pack,
    store_id: String,
    admin_name: String,
    pin: Option<String>,
    skip_first_admin: bool,
    /// `"offline-only"`, or `"cloud"` under `--prepare-for-switch`
    mode: &'static str,
    /// Previous `WaitToKillServiceTimeout` text recorded by the `shutdown_timeout` step
    /// (`None` = not run or nothing changed), written to `provisioned.json` by `finalize`
    shutdown_previous: Option<String>,
    generated_pin: Option<String>,
    admin_id: Option<String>,
    /// What the step that just ran wants in its journal record (not a secret): the `network` step's applied aliases.
    detail: Option<String>,
    secrets: Option<Secrets>,
    redact: Redactor,
    /// What this run was told to render for the Gateway (`dev new --tls internal`); `None` = keep what `state\gateway.json` says.
    gateway: Option<GatewaySettings>,
}

impl Cx<'_> {
    /// Loads the secrets once and registers every one of them with the redactor, so nothing a tool
    /// echoes can reach an error, the journal or the envelope.
    fn secrets(&mut self) -> Result<&Secrets, PosctlError> {
        if self.secrets.is_none() {
            let s = secrets::load(&self.roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
            for v in [s.jwt_secret.expose(), s.pepper.expose(), s.service_role_key.expose()] {
                self.redact.add(v);
            }
            for r in secrets::PG_ROLES {
                self.redact.add(s.pg_password(r));
            }
            self.secrets = Some(s);
        }
        Ok(self.secrets.as_ref().expect("just loaded"))
    }
    fn tools(&self) -> PgTools {
        PgTools::for_pack(&self.pack.dir)
    }
    fn psql(&self) -> Psql {
        Psql { tools: self.tools(), port: self.ports.pg(), pgpass: self.roots.pgpass() }
    }
    fn render_input(&mut self) -> Result<RenderInput, PosctlError> {
        let (ports, host) = (self.ports, self.host.clone());
        let s = self.secrets()?.clone();
        let mut input = render::input_from(self.roots, ports, &host, &s);
        input.optional = secrets::load_optional(&self.roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
        input.gateway = match &self.gateway {
            Some(g) => g.clone(),
            None => GatewaySettings::load_for_rerender(self.roots)?,
        };
        Ok(input)
    }
    fn endpoint(&mut self) -> Result<Endpoint, PosctlError> {
        let url = format!("http://127.0.0.1:{}", self.ports.gateway_internal());
        let s = self.secrets()?;
        Ok(Endpoint { internal_url: url, anon_key: s.anon_key.clone(), service_key: s.service_role_key.clone() })
    }
    /// An error whose detail (a tool's output, an OS message) is redacted. Callers load the secrets first.
    fn fail(&self, what: &str, detail: &str) -> PosctlError {
        PosctlError::error(format!("{what}: {}", self.redact.redact(detail.trim())))
    }
}

#[cfg(test)]
impl<'a> Cx<'a> {
    /// A fake pack, generated secrets, mode `offline-only`. The layout (`secrets\`) must exist.
    fn for_test(roots: &'a Roots, rt: &'a dyn Runtime) -> Cx<'a> {
        let dir = roots.packs().join("1.0.0-r1");
        std::fs::create_dir_all(&dir).unwrap();
        pack::make_fake_pack(&dir, "1.0.0-r1");
        secrets::ensure(&roots.secrets(), false).unwrap();
        Cx {
            roots,
            rt,
            ops: &NoHost,
            confirm: None,
            ports: Ports { base: 47300 },
            host: "shop".into(),
            pack: pack::load(&dir).unwrap(),
            store_id: "11111111-2222-4333-8444-555555555555".into(),
            admin_name: "Administrador".into(),
            pin: None,
            skip_first_admin: true,
            mode: "offline-only",
            shutdown_previous: None,
            generated_pin: None,
            admin_id: None,
            detail: None,
            secrets: None,
            redact: Redactor::new(),
            gateway: None,
        }
    }
}

fn os_host() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default().to_lowercase()
}

/// Everything that must be true before anything is created. Returns the decision about the data root.
fn preflight(roots: &Roots, args: &ProvisionArgs, ports: &Ports) -> Result<DataDecision, PosctlError> {
    if !roots.dev && !sys::is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "provision must run as an administrator"));
    }
    if !roots.dev {
        // the folder comes from SHGetKnownFolderPath, never from the (user-overridable) environment
        let pd = sys::known_folder(sys::KnownFolder::ProgramData).map_err(PosctlError::precondition)?.display().to_string();
        crate::paths::check_program_data(Some(pd.as_str())).map_err(PosctlError::precondition)?;
    }
    layout::check_existing_data_root(roots)?;
    let owner_trusted = true; // check_existing_data_root already refused an untrusted owner
    let decision = classify_data_root(
        roots.data.exists(),
        owner_trusted,
        roots.provisioned_json().exists(),
        roots.unprovisioned_json().exists(),
        roots.provision_journal().exists(),
        args.resume,
    )
    .map_err(|(code, msg)| PosctlError::new(code, msg))?;
    if decision == DataDecision::Fresh {
        let busy = ports::busy_ports(ports);
        if !busy.is_empty() {
            return Err(PosctlError::precondition(format!("ports already in use: {busy:?}")));
        }
        if !roots.dev {
            let netsh = sys::system_dir().map_err(PosctlError::precondition)?.join("netsh.exe");
            let out = Cmd::new(netsh).args(["int", "ipv4", "show", "excludedportrange", "protocol=tcp"]).run().map_err(|e| PosctlError::error(e.to_string()))?;
            if let Some((a, b)) = ports::excluded_overlap(ports, &ports::parse_excluded_ranges(&out.stdout)) {
                return Err(PosctlError::precondition(format!("the port block overlaps the Windows-excluded range {a}-{b}")));
            }
        }
    }
    let probe_dir = if roots.data.exists() { roots.data.clone() } else { roots.data.parent().map(|p| p.to_path_buf()).unwrap_or_default() };
    if !roots.dev {
        let free = sys::free_disk_bytes(&probe_dir).map_err(PosctlError::error)?;
        if free < MIN_FREE_BYTES {
            return Err(PosctlError::precondition(format!("only {} MiB free; at least {} MiB are needed", free / 1_048_576, MIN_FREE_BYTES / 1_048_576)));
        }
    }
    Ok(decision)
}

/// `canonicalize` yields `\\?\C:\...`; a service binPath and a Cmd must get the plain form.
pub(crate) fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn resolve_pack(roots: &Roots, arg: &str) -> Result<Pack, PosctlError> {
    let bad = |m: String| PosctlError::new(Code::PackInvalid, m);
    if arg.eq_ignore_ascii_case("auto") || arg.is_empty() {
        return match pack::latest_installed(&roots.packs(), pack::Tier::Full) {
            Ok(Some(p)) => Ok(p),
            Ok(None) => Err(bad(format!("no backend pack is installed under {}; run pack fetch or pack install first", roots.packs().display()))),
            Err(e) => Err(bad(e)),
        };
    }
    let dir = PathBuf::from(arg);
    if !dir.is_dir() {
        return Err(bad(format!("{arg} is not a folder: install a .pospack file with `pack install` first")));
    }
    // canonicalize BOTH sides before comparing, so `packs\..\x` (and a junction inside `packs\`) cannot pass a plain `starts_with`
    let dir = dir.canonicalize().map_err(|e| bad(format!("{arg}: {e}")))?;
    if !roots.dev {
        let packs = roots.packs().canonicalize().map_err(|e| bad(format!("{}: {e}", roots.packs().display())))?;
        if !dir.starts_with(&packs) {
            return Err(bad(format!("{arg} is not under {}", packs.display())));
        }
    }
    pack::load(&strip_verbatim(dir)).map_err(bad)
}

/// A resumed run stays on the pack version its journal recorded: `auto` means that pack (not a newer one that was
/// installed since), and an explicit pack of another version is `USAGE`.
fn resolve_pack_for_run(roots: &Roots, arg: &str, resumed: Option<&Value>) -> Result<Pack, PosctlError> {
    let Some(want) = resumed.and_then(|v| v.get("packVersion")).and_then(Value::as_str) else {
        return resolve_pack(roots, arg);
    };
    let bad = |m: String| PosctlError::new(Code::PackInvalid, m);
    let pack = if arg.is_empty() || arg.eq_ignore_ascii_case("auto") {
        pack::load(&roots.pack_dir(want).map_err(bad)?).map_err(|e| PosctlError::new(Code::PackInvalid, format!("pack {want}: {e}")))?
    } else {
        resolve_pack(roots, arg)?
    };
    if pack.manifest.pack_version != want {
        return Err(PosctlError::new(Code::Usage, format!("--pack is version {}, but the run being resumed uses {want}; omit --pack, or run unprovision --delete-data and provision again", pack.manifest.pack_version)));
    }
    Ok(pack)
}

pub fn run(roots: &Roots, rt: &dyn Runtime, args: &ProvisionArgs) -> Result<Outcome, PosctlError> {
    run_with(roots, rt, args, &RealHost)
}

pub fn run_with(roots: &Roots, rt: &dyn Runtime, args: &ProvisionArgs, ops: &dyn HostOps) -> Result<Outcome, PosctlError> {
    config::guard_no_operation(roots)?; // lives in config.rs (Task 8), not lifecycle.rs (Task 11)
    let resumed = if args.resume { Journal::load(&roots.provision_journal())? } else { None };
    let resuming_params: Option<Value> = resumed.as_ref().map(|j| j.params.clone());
    let first_admin_done = resumed.as_ref().is_some_and(|j| j.state_of("first_admin") == Some(StepState::Done));
    let pack = resolve_pack_for_run(roots, &args.pack, resuming_params.as_ref())?;
    // the plan of a resumed run is the journal's, never the arguments' (they may only repeat it)
    let eff = match &resuming_params {
        Some(p) => resume_args(args, p)?,
        None => args.clone(),
    };
    let args = &eff;
    let p = |k: &str| resuming_params.as_ref().and_then(|v| v.get(k)).cloned();

    let ports = match (p("basePort").and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()), args.base_port) {
        (Some(b), _) => Ports::new(b).map_err(PosctlError::precondition)?,
        (None, Some(b)) => {
            // a bad --base-port is a usage error; a production store may not sit on a test-instance or contract-fixture block
            let ports = Ports::new(b).map_err(|e| PosctlError::new(Code::Usage, e))?;
            if !roots.dev {
                ports::check_production_base(b).map_err(|e| PosctlError::new(Code::Usage, e))?;
            }
            ports
        }
        (None, None) => Ports::new(ports::DEFAULT_BASE).map_err(PosctlError::precondition)?,
    };
    let base = ports.base;
    let host = match p("serverHost").and_then(|v| v.as_str().map(String::from)).or_else(|| args.server_host.clone()) {
        Some(h) => config::validate_server_host(&h).map_err(|e| PosctlError::new(Code::Usage, e))?,
        None => config::validate_server_host(&os_host()).map_err(|e| PosctlError::new(Code::Usage, format!("cannot derive the server host from COMPUTERNAME ({e}); pass --server-host")))?,
    };
    // the `store_trust` step pairs the server PC with itself; the till app only reaches one port and one kind of name, so a store
    // that fails that step could never be reached by any till. Refuse it now, not after the stack is up.
    if !roots.dev && !args.prepare_for_switch {
        if ports.gateway_lan() != crate::pairing::store_port() {
            return Err(PosctlError::new(Code::Usage, format!("--base-port {base}: the store listens on port {} for the tills, which needs base port {}; omit --base-port", ports.gateway_lan(), crate::pairing::store_port() - 4)));
        }
        crate::pairing::check_shop_host(&host).map_err(|e| PosctlError::new(Code::Usage, format!("--server-host: {e}; tills only accept a single name (shop), a name ending in .local, or a private IP address")))?;
    }
    let pin_plan = pin_plan_for_run(args, first_admin_done)?; // USAGE before anything exists (bad PIN, or no terminal for a generated one)

    // before minutes of work: a Public network the owner has not confirmed. Gated on a journal being resumed, not on the flag.
    let confirm = net_preflight(roots, args, ops, resuming_params.is_some())?;
    let decision = preflight(roots, args, &ports)?;
    // planted-folder window: `fresh` makes `create_layout` use `create_dir` and refuse a folder that is already
    // there; the exclusive lock (a file under `state\`) is taken right after, before any step runs
    layout::create_layout(roots, decision == DataDecision::Fresh)?;
    let _lock = acquire_for(roots, LockMode::Exclusive, "provision", &random_uuid_v4().map_err(PosctlError::error)?, Duration::from_secs(0))?;

    let store_id = store_id_for(p("storeId").as_ref().and_then(Value::as_str))?;
    let admin_name = args.first_admin_name.clone().unwrap_or_else(|| "Administrador".to_string());
    let params = json!({"storeId": store_id, "basePort": base, "serverHost": host, "packVersion": pack.manifest.pack_version, "confirmPrivateNetwork": confirmation_to_json(&confirm), "firstAdminName": admin_name, "prepareForSwitch": args.prepare_for_switch, "skipFirstAdmin": args.skip_first_admin});
    let mut journal = match (decision, Journal::load(&roots.provision_journal())?) {
        (DataDecision::Resume, Some(j)) => j,
        _ => Journal::begin(&roots.provision_journal(), "provision", params)?,
    };
    let first = resume_index(&journal, &STEPS).map_err(|r| match r {
        crate::journal::ResumeRefusal::NotRerunnable(s) => PosctlError::new(Code::RecoveryNeeded, format!("step '{s}' was interrupted and cannot be repeated safely; run unprovision --delete-data and provision again")),
    })?;

    let gateway = gateway_for_run(roots, args, &host, ops)?;
    let mut cx = Cx { roots, rt, ops, confirm, ports, host: host.clone(), pack, store_id: store_id.clone(), admin_name, pin: args.pin.clone(), skip_first_admin: matches!(pin_plan, PinPlan::None), mode: target_mode(args), shutdown_previous: None, generated_pin: None, admin_id: None, detail: None, secrets: None, redact: Redactor::new(), gateway };
    if first_admin_done {
        // a resumed finalize needs the admin id the finished step recorded
        cx.admin_id = journal.steps.iter().find(|r| r.name == "first_admin").and_then(|r| r.detail.clone());
    }
    if let Err(e) = drive_steps(&mut cx, &mut journal, first, &mut |name, cx, journal| execute(name, cx, journal)) {
        return failure_outcome(&mut cx, e, &roots.provision_journal());
    }

    let mut data = json!({
        "storeId": cx.store_id, "packVersion": cx.pack.manifest.pack_version, "basePort": base, "serverHost": host,
        "services": Component::ALL.iter().map(|c| c.service_name()).collect::<Vec<_>>(),
        "firstAdmin": {"id": cx.admin_id, "name": cx.admin_name, "mustChangePin": true, "pinShown": cx.generated_pin.is_some()},
    });
    if cx.admin_id.is_none() {
        data["firstAdmin"]["note"] = json!("no administrator was created by this run");
    }
    let mut out = Outcome::ok("provisioned", data).journal(roots.provision_journal().display().to_string());
    if let Some(pin) = cx.generated_pin.take() {
        out = out.secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin });
    }
    Ok(out)
}

/// What this run renders for the Gateway. A real store serves TLS from its own CA on the shop LAN: `tls internal`, `tcp4/0.0.0.0`,
/// and the site names tills may use (`<computer>`, `<computer>.local`, `localhost`, `127.0.0.1`, this PC's private IPv4 addresses,
/// the owner's extra names). Only provision and `pki reissue` detect these; every other re-render reads them back from
/// `state\gateway.json` (a resumed run that already wrote a TLS file keeps it). A dev root and `--prepare-for-switch` (cloud mode,
/// no till connects) keep what the arguments say: plain loopback HTTP unless `dev new --tls internal` asked otherwise.
fn gateway_for_run(roots: &Roots, args: &ProvisionArgs, host: &str, ops: &dyn HostOps) -> Result<Option<GatewaySettings>, PosctlError> {
    if args.gateway.is_some() || roots.dev || args.prepare_for_switch {
        return Ok(args.gateway.clone());
    }
    if GatewaySettings::load(roots)?.tls == crate::gateway::TlsMode::Internal {
        return Ok(None);
    }
    let ips = ops.local_ipv4s().map_err(PosctlError::error)?;
    let extra = PosctlJson::load(roots).ok().flatten().map(|c| c.server.extra_sans).unwrap_or_default();
    let hosts = crate::pki::san::compute_site_hosts(host, &ips, &extra).map_err(|e| PosctlError::new(Code::Usage, format!("the store's certificate names: {e}")))?;
    Ok(Some(GatewaySettings { tls: crate::gateway::TlsMode::Internal, ext_bind: "tcp4/0.0.0.0".into(), hosts }))
}

/// Runs the steps from `first`. A journal write that fails (before or after a step) is that step's failure, like
/// any other. The error carries the failed step and the journal path.
fn drive_steps(cx: &mut Cx, journal: &mut Journal, first: usize, exec: &mut dyn FnMut(&str, &mut Cx, &mut Journal) -> Result<(), PosctlError>) -> Result<(), PosctlError> {
    for step in &STEPS[first..] {
        let r = (|| -> Result<(), PosctlError> {
            journal.mark(step.name, StepState::Started, None)?;
            exec(step.name, cx, journal)?;
            // the first admin's id (not a secret) is kept so a resumed `finalize` can record it
            let detail = if step.name == "first_admin" { cx.admin_id.clone() } else { cx.detail.take() };
            journal.mark(step.name, StepState::Done, detail)?;
            Ok(())
        })();
        if let Err(mut e) = r {
            let _ = journal.mark(step.name, StepState::Failed, Some(cx.redact.redact(&e.message)));
            e.message = format!("step '{}' failed: {}", step.name, cx.redact.redact(&e.message));
            return Err(e.with_data(json!({"failedStep": step.name, "journal": journal.path().display().to_string()})));
        }
    }
    Ok(())
}

/// A run that fails after it minted the first admin's PIN must still show it: the failure becomes an outcome that
/// carries the PIN as `secret_once` (stdout only; `--result-file` never gets it). Without a minted PIN it is a plain error.
fn failure_outcome(cx: &mut Cx, e: PosctlError, journal: &std::path::Path) -> Result<Outcome, PosctlError> {
    let Some(pin) = cx.generated_pin.take() else { return Err(e) };
    let mut out = Outcome::from(e).journal(journal.display().to_string()).secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin });
    out.message.push_str(" - the first admin PIN of this run is shown once in this output; resuming sets a new one");
    Ok(out)
}

fn execute(step: &str, cx: &mut Cx, journal: &mut Journal) -> Result<(), PosctlError> {
    match step {
        "secrets" => {
            // CARRY (Task 4/5): `secrets\` exists, has no reparse point and carries the protected SYSTEM +
            // Administrators ACL BEFORE the first secret is written (a temp file inherits the folder ACL).
            if !cx.roots.dev {
                acl::protect_secrets_dir(cx.roots).map_err(PosctlError::error)?;
            }
            let cluster = cx.roots.pgdata().join("PG_VERSION").exists();
            secrets::ensure(&cx.roots.secrets(), cluster).map_err(|e| PosctlError::error(e.to_string()))?;
            let s = cx.secrets()?.clone();
            // `acceptable_pepper` (length AND at least 8 distinct characters), not the length alone
            if !acceptable_pepper(s.pepper.expose()) {
                return Err(PosctlError::error("the staff password pepper is too short or has too little entropy"));
            }
            secrets::write_pgpass(&cx.roots.secrets(), cx.ports.pg(), &s).map_err(|e| PosctlError::error(e.to_string()))?;
            Ok(())
        }
        "network" => step_network(cx),
        "initdb" => step_initdb(cx),
        "services" => step_services(cx),
        "shutdown_timeout" => {
            // Raise `WaitToKillServiceTimeout` to 30000 (never lower a larger value); the previous text goes to
            // `state\shutdown-timeout.json` ({"previous": "<text>"}) so even a half-provisioned PC can restore it
            // (`unprovision` reads that file); `finalize` mirrors it into `provisioned.json`. A file that already
            // exists is never overwritten (a rerun would otherwise record the raised value as "previous").
            let file = cx.roots.state().join("shutdown-timeout.json");
            if let Some(prev) = cx.rt.raise_shutdown_timeout().map_err(PosctlError::error)? {
                if !file.exists() {
                    crate::util::write_atomic(&file, serde_json::to_string_pretty(&json!({"previous": prev}))?.as_bytes())?;
                }
                cx.shutdown_previous = Some(prev);
            }
            Ok(())
        }
        "start_postgres" => {
            cx.rt.start(cx.roots, &cx.pack.dir, Component::Postgres).map_err(PosctlError::error)?;
            probe::wait_healthy(Component::Postgres, &cx.ports, &cx.tools(), Duration::from_secs(90)).map(|_| ()).ok_or_else(|| PosctlError::error("Postgres did not accept connections within 90 s"))
        }
        "run_order" => step_run_order(cx, journal),
        "start_stack" => {
            let hba = std::fs::read_to_string(cx.roots.pgdata().join("pg_hba.conf"))?;
            pg::assert_pg_hba_loopback_only(&hba).map_err(PosctlError::error)?;
            // fail closed: the live server listens on loopback only, and no ALTER SYSTEM override says otherwise
            let show = cx.psql().scalar("postgres", "postgres", "show listen_addresses;").map_err(|e| cx.fail("cannot read listen_addresses", &e))?;
            let auto = match std::fs::read_to_string(cx.roots.pgdata().join("postgresql.auto.conf")) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(e.into()),
            };
            pg::assert_listen_loopback_only(&show, &auto).map_err(PosctlError::error)?;
            let env = std::fs::read_to_string(cx.roots.gotrue_env())?;
            if !render::gotrue_hook_env_ok(&env) {
                return Err(PosctlError::error("the lockout hook variables are missing from gotrue.env"));
            }
            start_sign_in_stack(cx, &|c| probe::wait_healthy(c, &cx.ports, &cx.tools(), Duration::from_secs(90)).is_some())
        }
        "tasks" => {
            if cx.roots.dev {
                return Ok(());
            }
            let exe = std::env::current_exe()?;
            cx.ops.install_tasks(&exe).map(|_| ()).map_err(PosctlError::error)
        }
        "first_admin" => step_first_admin(cx),
        "canary" => step_canary(cx, journal),
        "client_files" => {
            // NO `store.env` here: the `store_trust` step (Plan 06's `server_self_pair`) is the only writer of the server
            // PC's `store.env`, once the Gateway serves TLS and its CA root exists. The mode is recorded in
            // `posctl.json`; `PosctlJson::save` keeps unknown sections, so a resumed run does not drop later plans' settings.
            let mut cfg = PosctlJson::load(cx.roots).map_err(PosctlError::error)?.unwrap_or_else(|| PosctlJson::new(cx.mode, &cx.store_id, cx.ports.base, &cx.host, &cx.pack.manifest.pack_version));
            cfg.mode = cx.mode.to_string();
            cfg.save(cx.roots)?;
            std::fs::create_dir_all(cx.roots.client())?;
            Ok(())
        }
        "store_trust" => {
            // Nothing to trust under a dev root (no certificate store, no shop name) or for a cloud-mode store built for a later switch.
            if cx.roots.dev || cx.mode == "cloud" {
                return Ok(());
            }
            let paired = cx.ops.self_pair(cx.roots)?;
            cx.detail = paired["rootSha256"].as_str().map(String::from);
            Ok(())
        }
        "finalize" => {
            let admin = cx.admin_id.clone(); // None under --prepare-for-switch or when no admin was created
            if cx.shutdown_previous.is_none() {
                // a resumed run skipped the `shutdown_timeout` step: read what it recorded
                cx.shutdown_previous = std::fs::read_to_string(cx.roots.state().join("shutdown-timeout.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("previous").and_then(Value::as_str).map(String::from));
            }
            let v = config::provisioned_json(cx.mode, &cx.store_id, cx.ports.base, &cx.host, &cx.pack.manifest.pack_version, admin.as_deref(), cx.shutdown_previous.as_deref(), &now_rfc3339());
            crate::util::write_atomic(&cx.roots.provisioned_json(), serde_json::to_string_pretty(&v)?.as_bytes())?;
            Ok(())
        }
        other => Err(PosctlError::error(format!("unknown step {other}"))),
    }
}

/// Deletes the listed files when dropped: the initdb password file must go on every path, a panic included.
struct RemoveOnDrop(Vec<PathBuf>);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Fail early when a connected network is Public and the owner has not confirmed that it is the shop network (a Public
/// profile blocks the LAN rule, so tills could not reach the server). A confirmation that cannot be applied (a bare flag
/// with two Public networks, an alias that is not one) is refused here too, before anything exists.
///
/// Returns the confirmation the run goes on with: a bare flag becomes the NAMES of the networks it resolved to, so the
/// journal records what the owner actually saw and a resume on another Wi-Fi cannot widen it. With no Public network
/// there is nothing to confirm and nothing is recorded. A resumed run keeps what its journal says.
fn net_preflight(roots: &Roots, args: &ProvisionArgs, ops: &dyn HostOps, resuming: bool) -> Result<Option<Confirmation>, PosctlError> {
    if roots.dev || resuming {
        return Ok(args.confirm_private_network.clone()); // a resumed run was checked when it started; its `network` step checks again
    }
    let profiles = ops.read_profiles().map_err(PosctlError::error)?;
    if !net::any_public(&profiles) {
        return Ok(None);
    }
    let Some(c) = &args.confirm_private_network else {
        return Err(PosctlError::precondition("a connected network is marked Public, so tills could not reach the server. Confirm that it is the shop network with --confirm-private-network (or --confirm-private-network=<name>) and it will be switched to Private"));
    };
    let targets = net::choose_targets(&profiles, c).map_err(|m| PosctlError::new(Code::Usage, m))?;
    let names = profiles.iter().filter(|p| targets.contains(&p.interface_index)).map(|p| p.alias.clone()).collect();
    Ok(Some(Confirmation::Aliases(names)))
}

/// A confirmation the networks do not match is the owner's to fix (`USAGE`); a failure while changing the profile is `ERROR`.
pub(crate) fn fix_public(ops: &dyn HostOps, profiles: &[net::Profile], c: &Confirmation) -> Result<Vec<String>, PosctlError> {
    net::choose_targets(profiles, c).map_err(|m| PosctlError::new(Code::Usage, m))?;
    ops.fix_profiles(c).map_err(PosctlError::error)
}

fn step_network(cx: &mut Cx) -> Result<(), PosctlError> {
    if cx.roots.dev {
        return Ok(());
    }
    let profiles = cx.ops.read_profiles().map_err(PosctlError::error)?;
    if net::any_public(&profiles) {
        let Some(c) = cx.confirm.clone() else {
            return Err(PosctlError::precondition("a connected network is marked Public; pass --confirm-private-network"));
        };
        let applied = fix_public(cx.ops, &profiles, &c)?;
        cx.detail = Some(format!("private: {}", applied.join(", ")));
    }
    cx.ops.ensure_rule(&cx.ports).map_err(PosctlError::error)
}

fn step_initdb(cx: &mut Cx) -> Result<(), PosctlError> {
    let pgdata = cx.roots.pgdata();
    // NO `PG_VERSION` shortcut. initdb writes `PG_VERSION` first and the port/listen/UTC overrides are appended
    // only after it finishes, so a crash mid-initdb (or between initdb and the append) used to resume into a
    // broken cluster, or one on port 5432 that never passes the gate. This step is only reached when the journal
    // does not say it is done, so the cluster holds nothing yet: always wipe and rerun.
    // the one-shot service reuses the Postgres service name: nothing of that name may be running when the data goes
    cx.rt.ensure_postgres_idle().map_err(|e| cx.fail("the Postgres service is not idle", &e))?;
    std::fs::create_dir_all(&pgdata)?;
    clear_dir(&pgdata)?;
    let tmp = cx.roots.tmp_for(Component::Postgres.service_name());
    std::fs::create_dir_all(&tmp)?;
    let (pwfile, log, exit_file, script) = (tmp.join("initdb-pw.tmp"), tmp.join("initdb.log"), tmp.join("initdb.exit"), tmp.join("initdb.cmd"));
    let _ = std::fs::remove_file(&exit_file);
    let admin_pw = cx.secrets()?.pg_password("supabase_admin").to_string();
    // created before the file exists, so even a failing write below leaves nothing behind
    let _cleanup = RemoveOnDrop(vec![pwfile.clone()]);
    // readable by the Postgres account and SYSTEM only (the reader is initdb running as that account)
    layout::write_protected(cx.roots, cx.rt, &pwfile, &admin_pw, &acl::initdb_pwfile_grants())?;
    std::fs::write(&script, pg::initdb_cmd_script(&cx.tools().exe("initdb"), &pg::initdb_args(&pgdata, &pwfile), &log, &exit_file))?;
    let ran = cx.rt.run_script_as_postgres(cx.roots, &cx.pack.dir, &script, Duration::from_secs(300));
    // always, success or not; a file that cannot be removed is an error of its own
    match std::fs::remove_file(&pwfile) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(PosctlError::error(format!("cannot delete the initdb password file {}: {e}", pwfile.display()))),
    }
    ran.map_err(|e| cx.fail("initdb", &e))?;
    let code = pg::parse_exit_file(&std::fs::read_to_string(&exit_file).unwrap_or_default());
    if code != Some(0) || !pgdata.join("PG_VERSION").exists() {
        return Err(cx.fail(&format!("initdb exited {code:?}"), &std::fs::read_to_string(&log).unwrap_or_default()));
    }
    let conf = pgdata.join("postgresql.conf");
    let mut text = std::fs::read_to_string(&conf)?;
    text.push_str(&render::postgresql_conf_overrides(cx.ports.pg()));
    std::fs::write(&conf, text)?;
    // the real pg_hba.conf, as initdb wrote it: loopback and scram only
    let hba = std::fs::read_to_string(pgdata.join("pg_hba.conf"))?;
    pg::assert_pg_hba_loopback_only(&hba).map_err(PosctlError::error)
}

fn step_services(cx: &mut Cx) -> Result<(), PosctlError> {
    let input = cx.render_input()?;
    conf::write_configs(cx.roots, cx.rt, &input)?;
    for c in Component::ALL {
        cx.rt.prepare(cx.roots, &cx.pack.dir, c).map_err(PosctlError::error)?;
    }
    cx.rt.set_functions_env(cx.roots, &render::functions_env(&input).map_err(PosctlError::error)?).map_err(PosctlError::error)
}

/// `^\d{14}_[^/]+\.sql$` - the manifest builder's definition of a migration (`pack/build/lib/manifest.mjs`).
/// Only these are copied and counted; anything else in `migrations\` is not a migration.
fn is_migration_file(name: &str) -> bool {
    let b = name.as_bytes();
    name.len() > 19
        && b[..14].iter().all(u8::is_ascii_digit)
        && b[14] == b'_'
        && name.ends_with(".sql")
        && !name.contains(['/', '\\'])
}

fn exec_run_order_step(cx: &mut Cx, order: &runorder::RunOrder, step: &runorder::Step) -> Result<(), PosctlError> {
    use runorder::Step;
    match step {
        Step::CopyExtensionStubs { files, to, .. } => runorder::copy_stubs(&cx.pack.dir, files, to).map_err(PosctlError::error),
        Step::RemoveExtensionStubs { files, from, .. } => runorder::remove_stubs(&cx.pack.dir, files, from).map_err(PosctlError::error),
        Step::Sql { id, file, run_as, vars, .. } => {
            let path = cx.pack.dir.join(crate::pack::safe_entry_path(file).map_err(PosctlError::error)?);
            let sql = std::fs::read_to_string(&path).map_err(|e| PosctlError::error(format!("cannot read {file}: {e}")))?;
            let secrets = cx.secrets()?.clone();
            let header = runorder::psql_header(&runorder::step_vars(order, vars, &|role| secrets.pg_password(role).to_string())).map_err(PosctlError::error)?;
            // the pack's `psqlArgs` (terse errors, no statement context) and `--single-transaction` when the step asks
            let o = cx.psql().run_with(run_as, "postgres", &runorder::psql_extra_args(order, step), &format!("{header}{sql}")).map_err(|e| cx.fail(&format!("{id} ({file}) could not run"), &e))?;
            if !o.success() {
                return Err(cx.fail(&format!("{id} ({file}) failed as {run_as} (exit {})", o.code), &o.text()));
            }
            Ok(())
        }
        Step::GotrueMigrate { .. } => {
            cx.secrets()?; // register the secrets before any output is read
            // the child gets only the allowlisted system variables (Cmd clears the rest): no inherited GOTRUE_*,
            // DATABASE_URL or PORT can override `gotrue.env`
            let o = Cmd::new(cx.pack.dir.join("bin").join("auth.exe"))
                .args(["-c".to_string(), cx.roots.gotrue_env().display().to_string(), "migrate".to_string()])
                .cwd(&cx.roots.data)
                .timeout(Duration::from_secs(300))
                .run()
                .map_err(|e| cx.fail("auth.exe migrate could not run", &e.to_string()))?;
            if !o.success() {
                return Err(cx.fail(&format!("auth.exe migrate exited {}", o.code), &o.text()));
            }
            Ok(())
        }
        Step::DbPush { .. } => step_db_push(cx),
    }
}

/// What `run_order` does with a database step, given the journal's record of it.
#[derive(Debug, PartialEq, Eq)]
pub enum RoAction {
    Run,
    Skip,
    /// Interrupted and not known to be idempotent (a `sql` file): never run it twice.
    Refuse,
}

pub fn ro_action(state: Option<StepState>, rerunnable: bool) -> RoAction {
    match state {
        Some(StepState::Done) => RoAction::Skip,
        Some(StepState::Started) | Some(StepState::Failed) if !rerunnable => RoAction::Refuse,
        _ => RoAction::Run,
    }
}

/// The loop of `applyRunOrder` (`pack/test/helpers/stack.mjs`), journaling each step as `ro:<id>`:
/// after a failure every later step is skipped EXCEPT `always` steps (the stub removal, its `finally`), and the
/// first error is returned at the end. The two stub steps ignore the journal on resume: they are idempotent file
/// operations that must reflect the disk (stubs removed by an earlier failed run, `db push` not yet done, would
/// otherwise resume without the stubs). An interrupted non-rerunnable `sql` step refuses the resume (exit 17).
/// Error text is redacted before it is stored or returned.
fn drive_run_order(order: &runorder::RunOrder, journal: &mut Journal, redact: &Redactor, exec: &mut dyn FnMut(&runorder::Step) -> Result<(), PosctlError>) -> Result<(), PosctlError> {
    use runorder::Step;
    let mut failure: Option<PosctlError> = None;
    for step in &order.steps {
        if failure.is_some() && !step.always() {
            continue;
        }
        let key = format!("ro:{}", step.id());
        let stub = matches!(step, Step::CopyExtensionStubs { .. } | Step::RemoveExtensionStubs { .. });
        let action = if stub { RoAction::Run } else { ro_action(journal.state_of(&key), step.rerunnable()) };
        match action {
            RoAction::Skip => continue,
            RoAction::Refuse => {
                failure.get_or_insert_with(|| PosctlError::new(Code::RecoveryNeeded, format!("database step '{}' was interrupted and cannot be repeated safely; run unprovision --delete-data and provision again", step.id())));
                continue;
            }
            RoAction::Run => {}
        }
        // a journal write error is this step's failure and the loop goes on, so the `always` cleanup still runs
        if let Err(e) = journal.mark(&key, StepState::Started, None) {
            failure.get_or_insert_with(|| PosctlError::from(e));
            if !step.always() {
                continue;
            }
        }
        match exec(step) {
            Ok(()) => {
                if let Err(e) = journal.mark(&key, StepState::Done, None) {
                    failure.get_or_insert_with(|| PosctlError::from(e));
                }
            }
            Err(mut e) => {
                e.message = redact.redact(&e.message);
                let _ = journal.mark(&key, StepState::Failed, Some(e.message.clone())); // cleanup below matters more than this record
                failure.get_or_insert(e);
            }
        }
    }
    failure.map_or(Ok(()), Err)
}

fn step_run_order(cx: &mut Cx, journal: &mut Journal) -> Result<(), PosctlError> {
    let order = runorder::load(&cx.pack.dir).map_err(|e| PosctlError::new(Code::PackInvalid, e))?;
    cx.secrets()?; // registers every secret with the redactor before any tool output is read
    let redact = cx.redact.clone();
    drive_run_order(&order, journal, &redact, &mut |step| exec_run_order_step(cx, &order, step))?;
    // the schema is now at least this pack's: remembered so a later `pack install` cannot go below it even when Postgres is down
    persist_schema_max(cx.roots, &cx.pack.manifest.migrations.max)?;
    // every generated password must now log in (a variable mix-up shows up here, not in production)
    for role in secrets::PG_ROLES {
        cx.psql().scalar(role, "postgres", "select 1;").map_err(|e| cx.fail(&format!("role {role} cannot sign in with its generated password"), &e))?;
    }
    record_collation(cx)
}

pub(crate) fn schema_max_path(roots: &Roots) -> PathBuf {
    roots.state().join("schema-max")
}

pub(crate) fn read_persisted_schema_max(roots: &Roots) -> Option<String> {
    let t = std::fs::read_to_string(schema_max_path(roots)).ok()?;
    let t = t.trim();
    (t.len() == 14 && t.bytes().all(|c| c.is_ascii_digit())).then(|| t.to_string())
}

/// `state\schema-max`: the highest migration version this PC's database has ever had, never lowered.
pub(crate) fn persist_schema_max(roots: &Roots, max: &str) -> Result<(), PosctlError> {
    if read_persisted_schema_max(roots).is_some_and(|have| have.as_str() >= max) {
        return Ok(());
    }
    crate::util::write_atomic(&schema_max_path(roots), max.as_bytes())?;
    Ok(())
}

fn record_collation(cx: &mut Cx) -> Result<(), PosctlError> {
    let v = cx
        .psql()
        .scalar("postgres", "postgres", crate::pg::COLLATION_SQL)
        .map_err(|e| cx.fail("cannot read the cluster collation", &e))?;
    let parts: Vec<&str> = v.split('|').collect();
    if parts.len() != 4 || parts[0] != "i" || parts[1] != "es-MX" {
        return Err(PosctlError::error(format!("the cluster is not ICU es-MX (got '{v}')")));
    }
    crate::util::write_atomic(&cx.roots.collation_json(), serde_json::to_string_pretty(&json!({"provider": "icu", "locale": parts[1], "datcollversion": parts[2], "pgVersion": parts[3]}))?.as_bytes())?;
    Ok(())
}

fn step_db_push(cx: &mut Cx) -> Result<(), PosctlError> {
    cx.secrets()?;
    let src = cx.pack.dir.join("migrations");
    let dst = cx.roots.work_migrations();
    std::fs::create_dir_all(&dst)?;
    clear_dir(&dst)?; // sub-folders included
    // only files the manifest counts as migrations (14-digit version, `_`, name, `.sql`) are copied and counted
    let mut copied = 0u32;
    for e in std::fs::read_dir(&src)? {
        let e = e?;
        if !is_migration_file(&e.file_name().to_string_lossy()) {
            continue;
        }
        std::fs::copy(e.path(), dst.join(e.file_name()))?;
        copied += 1;
    }
    if copied != cx.pack.manifest.migrations.count {
        return Err(PosctlError::new(Code::MigrationFailed, format!("the pack has {copied} migration files, its manifest says {}", cx.pack.manifest.migrations.count)));
    }
    // supabase.exe gets only the allowlisted system variables plus what is set here. HOME/USERPROFILE/APPDATA/
    // LOCALAPPDATA point at a folder inside the data root so the CLI never reads or writes the elevated user's profile.
    let home = cx.roots.tmp().join("supabase-home");
    std::fs::create_dir_all(&home)?;
    let home = home.display().to_string();
    let o = Cmd::new(cx.pack.dir.join("tools").join("supabase.exe"))
        .args(["db", "push", "--db-url", &pg::db_url_no_password("postgres", cx.ports.pg(), "postgres"), "--yes", "--workdir", &cx.roots.work().display().to_string()])
        .env_remove_all(&pg::PG_ENV_TO_CLEAR) // PGOPTIONS, PGSERVICEFILE, PGSYSCONFDIR, PGSSLMODE, PGSERVICE, PGPASSWORD never leak in
        .env("PGPASSFILE", &cx.roots.pgpass().display().to_string())
        .env("SUPABASE_TELEMETRY_DISABLED", "1")
        .env("SUPABASE_NO_UPDATE_NOTIFIER", "1")
        .env("DOCKER_HOST", "tcp://127.0.0.1:9")
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", &home)
        .env("LOCALAPPDATA", &home)
        .cwd(cx.roots.work())
        .timeout(Duration::from_secs(1500))
        .run()
        .map_err(|e| cx.fail("supabase db push could not run", &e.to_string()))?;
    if !o.success() {
        let e = cx.fail(&format!("supabase db push exited {}", o.code), &o.text());
        return Err(PosctlError::new(Code::MigrationFailed, e.message));
    }
    let row = cx.psql().scalar("postgres", "postgres", "select count(*) || '|' || coalesce(max(version),'') from supabase_migrations.schema_migrations;").map_err(|e| cx.fail("cannot read schema_migrations", &e))?;
    let want = format!("{}|{}", cx.pack.manifest.migrations.count, cx.pack.manifest.migrations.max);
    if row != want {
        return Err(PosctlError::new(Code::MigrationFailed, format!("schema_migrations is '{row}', the manifest says '{want}'")));
    }
    Ok(())
}

type CreateFn<'a> = &'a mut dyn FnMut(&str, &mut dyn FnMut(&str)) -> Result<FirstAdmin, firstadmin::FirstAdminError>;
type ResetFn<'a> = &'a mut dyn FnMut(&str, &str, &mut dyn FnMut(&str)) -> Result<(), firstadmin::FirstAdminError>;

fn step_first_admin(cx: &mut Cx) -> Result<(), PosctlError> {
    if cx.skip_first_admin {
        return Ok(());
    }
    let ep = cx.endpoint()?;
    let pepper = cx.secrets()?.pepper.clone();
    let name = cx.admin_name.clone();
    first_admin_with(
        cx,
        &mut |pin, reg| firstadmin::create_first_admin(&ep, &pepper, &name, pin, reg),
        &mut |id, pin, reg| firstadmin::reset_first_admin_pin(&ep, id, pin, &pepper, reg),
    )
}

/// Creates the first admin, or - when one already exists, which in `provision` can only be the one an earlier
/// attempt of THIS run made (kept data is refused in preflight) - resets that admin's PIN in both stores. Either way
/// the PIN in use is known to this run: a generated one is kept in `generated_pin` to be shown once; a supplied one
/// is not echoed. The PIN and the derived password are registered with the Redactor before the first request.
fn first_admin_with(cx: &mut Cx, create: CreateFn, reset: ResetFn) -> Result<(), PosctlError> {
    let (pin, generated) = match cx.pin.clone() {
        Some(p) => (p, false),
        None => (fresh_pin().map_err(PosctlError::error)?, true),
    };
    let created = {
        let mut reg = firstadmin::registrar(&mut cx.redact);
        create(&pin, &mut reg)
    };
    let id = match created.map_err(|e| cx.fail("first admin", &e.to_string()))? {
        FirstAdmin::Created { id, .. } => id,
        FirstAdmin::AlreadyExists { id } => {
            let r = {
                let mut reg = firstadmin::registrar(&mut cx.redact);
                reset(&id, &pin, &mut reg)
            };
            r.map_err(|e| cx.fail("first admin PIN reset", &e.to_string()))?;
            id
        }
    };
    cx.admin_id = Some(id);
    if generated {
        cx.generated_pin = Some(pin);
    }
    Ok(())
}

/// Plan 05 wrote `secrets\canary.pw`; the canary account's password is random and never stored now.
fn remove_orphan_canary_pw(roots: &Roots) {
    let _ = std::fs::remove_file(roots.secrets().join("canary.pw")); // best effort: an absent file is the normal case
}

fn step_canary(cx: &mut Cx, journal: &mut Journal) -> Result<(), PosctlError> {
    let ep = cx.endpoint()?;
    let (roots, ports, psql) = (cx.roots, cx.ports, cx.psql());
    remove_orphan_canary_pw(roots);
    step_canary_with(cx, journal, &|| canary::run(roots, &ports, &psql, &ep, std::time::Duration::from_secs(120)))
}

/// Starts Auth, Rest, Functions and the Gateway in order, each behind its health gate.
fn start_sign_in_stack(cx: &Cx, healthy: &dyn Fn(Component) -> bool) -> Result<(), PosctlError> {
    for c in [Component::Auth, Component::Rest, Component::Functions, Component::Gateway] {
        // a gated (failed canary) provision left these on manual start: a resume puts them back on automatic
        cx.rt.set_auto_start(c, true).map_err(|e| PosctlError::error(format!("{} start type: {e}", c.short())))?;
        cx.rt.start(cx.roots, &cx.pack.dir, c).map_err(PosctlError::error)?;
        if !healthy(c) {
            return Err(PosctlError::error(format!("{} did not become healthy within 90 s", c.short())));
        }
    }
    Ok(())
}

/// A failed canary means the lockout hook is not protecting sign-ins: Auth and everything that depends on it
/// (the Gateway is what tills reach) are stopped, dependents first, before the failure is returned, so the stack
/// is never left serving without the control. The stack is then down, so `start_stack` is marked Failed: a resume
/// starts it again before the canary runs, instead of failing at the canary forever.
fn step_canary_with(cx: &mut Cx, journal: &mut Journal, check: &dyn Fn() -> Result<(), PosctlError>) -> Result<(), PosctlError> {
    let Err(mut e) = check() else { return Ok(()) };
    let gated = crate::lifecycle::stop_sign_in_stack(cx.rt);
    let notes = gated.notes();
    for n in &notes {
        e.message.push_str(&format!("; {n}"));
    }
    if notes.is_empty() {
        e.message.push_str("; the gateway, functions and auth services were stopped");
    }
    let _ = journal.mark("start_stack", StepState::Failed, Some("the canary failed and the stack was stopped".into())); // the canary's own error matters more than this record
    Err(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ToolOutput;
    use crate::runtime::NoopRuntime;
    use std::cell::{Cell, RefCell};

    #[test]
    fn the_step_table_is_ordered_and_unique() {
        let names: Vec<_> = STEPS.iter().map(|s| s.name).collect();
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len());
        let pos = |n: &str| names.iter().position(|x| *x == n).unwrap();
        assert!(pos("secrets") < pos("network") && pos("network") < pos("initdb") && pos("initdb") < pos("services") && pos("services") < pos("shutdown_timeout") && pos("shutdown_timeout") < pos("start_postgres"));
        assert!(pos("start_postgres") < pos("run_order") && pos("run_order") < pos("start_stack"));
        // the PIN-bearing step runs last before `finalize`, so nothing after it can fail and lose the PIN
        assert!(pos("start_stack") < pos("canary") && pos("canary") < pos("client_files") && pos("client_files") < pos("store_trust") && pos("store_trust") < pos("tasks") && pos("tasks") < pos("first_admin") && pos("first_admin") < pos("finalize"));
        assert_eq!(names.last(), Some(&"finalize"), "provisioned.json is written last");
        assert!(STEPS.iter().all(|s| s.rerunnable), "the database steps guard themselves inside run_order");
    }

    #[test]
    fn an_interrupted_sql_step_is_never_repeated_but_other_database_steps_are() {
        use StepState::*;
        assert_eq!(ro_action(None, false), RoAction::Run);
        assert_eq!(ro_action(Some(Done), false), RoAction::Skip);
        assert_eq!(ro_action(Some(Started), false), RoAction::Refuse);
        assert_eq!(ro_action(Some(Failed), false), RoAction::Refuse);
        assert_eq!(ro_action(Some(Started), true), RoAction::Run, "db push, auth migrate and the stub copies may run again");
        assert_eq!(ro_action(Some(Failed), true), RoAction::Run);
        assert_eq!(ro_action(Some(Done), true), RoAction::Skip);
    }

    fn sample() -> runorder::RunOrder {
        runorder::parse(runorder::SAMPLE).unwrap()
    }

    /// Drives `drive_run_order` over the real run-order.json, recording which steps ran; `fail_at` fails one id.
    fn drive(journal: &mut Journal, fail_at: Option<&str>) -> (Vec<String>, Result<(), PosctlError>) {
        let ran = RefCell::new(Vec::new());
        let order = sample();
        let r = drive_run_order(&order, journal, &Redactor::new(), &mut |s: &runorder::Step| {
            ran.borrow_mut().push(s.id().to_string());
            if Some(s.id()) == fail_at { Err(PosctlError::error("boom")) } else { Ok(()) }
        });
        (ran.into_inner(), r)
    }

    fn journal_in(d: &tempfile::TempDir) -> Journal {
        Journal::begin(&d.path().join("j.json"), "provision", json!({})).unwrap()
    }

    // applyRunOrder's `finally`: a failure skips the rest except `always` steps (stub removal), which still run.
    #[test]
    fn a_failed_step_still_removes_the_stubs_and_skips_the_rest() {
        let d = tempfile::tempdir().unwrap();
        let mut j = journal_in(&d);
        let (ran, r) = drive(&mut j, Some("db-push"));
        assert_eq!(r.unwrap_err().message, "boom");
        assert_eq!(ran.last().map(String::as_str), Some("stubs-remove"));
        assert!(!ran.iter().any(|i| i == "20-pos-lockout-hook" || i == "30-store-schema-version"), "{ran:?}");
        assert_eq!(j.state_of("ro:db-push"), Some(StepState::Failed));
        assert_eq!(j.state_of("ro:stubs-remove"), Some(StepState::Done));
    }

    // the two stub steps ignore the journal on resume: stubs are removed but db-push is not done, so they must be copied again
    #[test]
    fn on_resume_the_stub_steps_run_again_even_when_the_journal_says_done() {
        let d = tempfile::tempdir().unwrap();
        let mut j = journal_in(&d);
        for id in ["stubs-install", "01-pre-gotrue", "03-owner-role", "03b-storage", "03c-database-grants", "auth-migrate", "02-shim-after-gotrue", "04-nonsuper-fixups", "stubs-remove"] {
            j.mark(&format!("ro:{id}"), StepState::Done, None).unwrap();
        }
        j.mark("ro:db-push", StepState::Failed, None).unwrap();
        let (ran, r) = drive(&mut j, None);
        r.unwrap();
        assert_eq!(ran, ["stubs-install", "db-push", "stubs-remove", "20-pos-lockout-hook", "30-store-schema-version"]);
    }

    // 01/03/03b are plain CREATE ROLE: interrupted, they cannot be retried, so resume refuses (exit 17) - after the stubs are cleaned up
    #[test]
    fn an_interrupted_non_rerunnable_sql_step_refuses_resume_with_exit_17() {
        let d = tempfile::tempdir().unwrap();
        let mut j = journal_in(&d);
        j.mark("ro:stubs-install", StepState::Done, None).unwrap();
        j.mark("ro:01-pre-gotrue", StepState::Started, None).unwrap();
        let (ran, r) = drive(&mut j, None);
        let e = r.unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::RecoveryNeeded, 17));
        assert!(e.message.contains("01-pre-gotrue") && e.message.contains("unprovision"), "{}", e.message);
        assert_eq!(ran, ["stubs-install", "stubs-remove"], "nothing else ran; the stubs were still cleaned up");
    }

    #[test]
    fn a_secret_in_a_step_error_never_reaches_the_journal() {
        let d = tempfile::tempdir().unwrap();
        let mut j = journal_in(&d);
        let mut red = Redactor::new();
        let pw = "f".repeat(64);
        red.add(&pw);
        let order = sample();
        let r = drive_run_order(&order, &mut j, &red, &mut |s: &runorder::Step| if s.id() == "03-owner-role" { Err(PosctlError::error(format!("ALTER ROLE postgres PASSWORD '{pw}'"))) } else { Ok(()) });
        assert!(!r.unwrap_err().message.contains(&pw));
        let on_disk = std::fs::read_to_string(j.path()).unwrap();
        assert!(!on_disk.contains(&pw) && on_disk.contains("***"), "{on_disk}");
    }

    #[test]
    fn only_the_manifest_migration_pattern_counts_as_a_migration() {
        assert!(is_migration_file("20260101000001_init.sql"));
        assert!(!is_migration_file("README.md"));
        assert!(!is_migration_file("2026_x.sql"));
        assert!(!is_migration_file("20260101000001.sql"), "the pattern needs the underscore and a name");
        assert!(!is_migration_file("20260101000001_x.sql.bak"));
        assert!(!is_migration_file("20260101000001_a/b.sql"));
    }

    #[test]
    fn the_pack_argument_is_resolved_strictly() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        assert_eq!(resolve_pack(&roots, "auto").unwrap_err().code, Code::PackInvalid);
        let v = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&v).unwrap();
        pack::make_fake_pack(&v, "1.0.0-r1");
        assert_eq!(resolve_pack(&roots, "auto").unwrap().manifest.pack_version, "1.0.0-r1");
        let by_path = resolve_pack(&roots, &v.display().to_string()).unwrap();
        assert_eq!(by_path.manifest.pack_version, "1.0.0-r1");
        assert!(!by_path.dir.display().to_string().starts_with(r"\\?\"), "a verbatim path must not reach a service binPath");
        assert!(resolve_pack(&roots, "C:\\nope").is_err());
        roots.dev = false; // production: only folders under packs\ are accepted
        let outside = d.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        pack::make_fake_pack(&outside, "1.0.0-r1");
        assert!(resolve_pack(&roots, &outside.display().to_string()).is_err());
        assert!(resolve_pack(&roots, &v.display().to_string()).is_ok());
        // `starts_with` alone lets `packs\..\x` through; the path is canonicalized first
        let sneaky = format!("{}\\..\\elsewhere", roots.packs().display());
        std::fs::create_dir_all(roots.packs()).unwrap();
        assert!(resolve_pack(&roots, &sneaky).is_err());
    }

    // a PIN is generated only when someone can read it; otherwise refuse with USAGE before anything is created
    #[test]
    fn a_generated_pin_needs_an_interactive_terminal_and_no_result_file() {
        let a = |pin: Option<&str>, interactive: bool| ProvisionArgs { pin: pin.map(String::from), interactive, ..Default::default() };
        assert!(matches!(pin_plan(&a(None, true)), Ok(PinPlan::Generate)));
        assert_eq!(pin_plan(&a(None, false)).err().unwrap().code, Code::Usage, "no terminal, or --result-file given");
        assert!(matches!(pin_plan(&a(Some("135790"), false)), Ok(PinPlan::Supplied)), "a supplied PIN never needs a terminal");
        assert_eq!(pin_plan(&a(Some("12345"), true)).err().unwrap().code, Code::Usage);
    }

    #[test]
    fn prepare_for_switch_skips_the_first_admin_and_keeps_the_mode_cloud() {
        let args = ProvisionArgs { prepare_for_switch: true, ..Default::default() };
        assert_eq!(target_mode(&args), "cloud");
        assert_eq!(target_mode(&ProvisionArgs::default()), "offline-only");
        assert!(matches!(pin_plan(&args), Ok(PinPlan::None)));
    }

    fn layout_roots(d: &tempfile::TempDir) -> Roots {
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        crate::layout::create_layout(&roots, true).unwrap();
        roots
    }

    // `client_files` never writes `store.env`: the `store_trust` step is its only writer (R13).
    #[test]
    fn the_client_files_step_does_not_write_store_env() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        execute("client_files", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        assert!(!roots.store_env().exists());
        assert!(roots.posctl_json().exists(), "posctl.json is still written");
    }

    /// Records the self-pair and the address query; nothing else is reachable.
    struct TrustHost {
        calls: RefCell<Vec<String>>,
        ips: Vec<std::net::Ipv4Addr>,
    }
    impl TrustHost {
        fn new() -> Self {
            TrustHost { calls: RefCell::new(vec![]), ips: vec!["192.168.1.20".parse().unwrap(), "169.254.3.4".parse().unwrap()] }
        }
    }
    impl HostOps for TrustHost {
        fn read_profiles(&self) -> Result<Vec<Profile>, String> { panic!("no network profiles here") }
        fn fix_profiles(&self, _: &Confirmation) -> Result<Vec<String>, String> { panic!("no network profiles here") }
        fn ensure_rule(&self, _: &Ports) -> Result<(), String> { panic!("no firewall here") }
        fn install_tasks(&self, _: &std::path::Path) -> Result<Vec<String>, String> { panic!("no tasks here") }
        fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> {
            self.calls.borrow_mut().push("ips".into());
            Ok(self.ips.clone())
        }
        fn self_pair(&self, _: &Roots) -> Result<Value, PosctlError> {
            self.calls.borrow_mut().push("self_pair".into());
            Ok(json!({"rootSha256": "ab".repeat(32)}))
        }
    }

    fn production_roots(d: &tempfile::TempDir) -> Roots {
        let mut roots = layout_roots(d);
        roots.dev = false;
        roots
    }

    #[test]
    fn a_production_run_serves_tls_on_the_lan_with_every_name_a_till_may_use() {
        let d = tempfile::tempdir().unwrap();
        let roots = production_roots(&d);
        let ops = TrustHost::new();
        let g = gateway_for_run(&roots, &ProvisionArgs::default(), "storepc", &ops).unwrap().expect("a first production run decides the gateway");
        assert_eq!(g.tls, crate::gateway::TlsMode::Internal);
        assert_eq!(g.ext_bind, "tcp4/0.0.0.0");
        assert_eq!(g.hosts, ["storepc", "storepc.local", "localhost", "127.0.0.1", "192.168.1.20"], "private addresses only, link-local left out");
    }

    #[test]
    fn a_resumed_production_run_keeps_the_tls_settings_an_earlier_pass_wrote_and_does_not_detect_again() {
        let d = tempfile::tempdir().unwrap();
        let roots = production_roots(&d);
        std::fs::write(roots.state().join("gateway.json"), r#"{"tls":"internal","extBind":"tcp4/0.0.0.0","hosts":["storepc","127.0.0.1"]}"#).unwrap();
        let ops = TrustHost::new();
        assert!(gateway_for_run(&roots, &ProvisionArgs::default(), "storepc", &ops).unwrap().is_none());
        assert!(ops.calls.borrow().is_empty());
    }

    #[test]
    fn a_dev_root_a_prepare_for_switch_run_and_explicit_settings_are_left_alone() {
        let d = tempfile::tempdir().unwrap();
        let dev = layout_roots(&d);
        let ops = TrustHost::new();
        assert!(gateway_for_run(&dev, &ProvisionArgs::default(), "shop", &ops).unwrap().is_none());
        let d2 = tempfile::tempdir().unwrap();
        let prod = production_roots(&d2);
        let switch = ProvisionArgs { prepare_for_switch: true, ..ProvisionArgs::default() };
        assert!(gateway_for_run(&prod, &switch, "shop", &ops).unwrap().is_none());
        let given = ProvisionArgs { gateway: Some(GatewaySettings::dev_internal()), ..ProvisionArgs::default() };
        assert_eq!(gateway_for_run(&prod, &given, "shop", &ops).unwrap(), Some(GatewaySettings::dev_internal()));
        assert!(ops.calls.borrow().is_empty());
    }

    #[test]
    fn a_bad_extra_name_stops_the_run_before_anything_is_rendered() {
        let d = tempfile::tempdir().unwrap();
        let roots = production_roots(&d);
        let mut cfg = PosctlJson::new("offline-only", "id", 47300, "storepc", "1.0.0-r1");
        cfg.server.extra_sans = vec!["8.8.8.8".into()];
        cfg.save(&roots).unwrap();
        let e = gateway_for_run(&roots, &ProvisionArgs::default(), "storepc", &TrustHost::new()).unwrap_err();
        assert_eq!(e.code, Code::Usage);
    }

    #[test]
    fn the_trust_step_self_pairs_a_real_store_and_journals_the_root_hash() {
        let d = tempfile::tempdir().unwrap();
        let roots = production_roots(&d);
        let ops = TrustHost::new();
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &ops;
        execute("store_trust", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        assert_eq!(*ops.calls.borrow(), ["self_pair"]);
        assert_eq!(cx.detail.as_deref(), Some("ab".repeat(32).as_str()), "the step's journal detail is the root hash, never a secret");
    }

    #[test]
    fn the_trust_step_does_nothing_for_a_dev_root_or_a_cloud_mode_store() {
        let d = tempfile::tempdir().unwrap();
        let dev = layout_roots(&d);
        let ops = TrustHost::new();
        let mut cx = Cx::for_test(&dev, &NoopRuntime);
        cx.ops = &ops;
        execute("store_trust", &mut cx, &mut Journal::for_test(&dev)).unwrap();
        let d2 = tempfile::tempdir().unwrap();
        let prod = production_roots(&d2);
        let mut cx = Cx::for_test(&prod, &NoopRuntime);
        cx.ops = &ops;
        cx.mode = "cloud";
        execute("store_trust", &mut cx, &mut Journal::for_test(&prod)).unwrap();
        assert!(ops.calls.borrow().is_empty());
    }

    #[test]
    fn a_failing_self_pair_fails_the_step_with_its_own_error() {
        struct Failing;
        impl HostOps for Failing {
            fn read_profiles(&self) -> Result<Vec<Profile>, String> { panic!() }
            fn fix_profiles(&self, _: &Confirmation) -> Result<Vec<String>, String> { panic!() }
            fn ensure_rule(&self, _: &Ports) -> Result<(), String> { panic!() }
            fn install_tasks(&self, _: &std::path::Path) -> Result<Vec<String>, String> { panic!() }
            fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> { panic!() }
            fn self_pair(&self, _: &Roots) -> Result<Value, PosctlError> { Err(PosctlError::new(Code::PairFailed, "no root")) }
        }
        let d = tempfile::tempdir().unwrap();
        let roots = production_roots(&d);
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &Failing;
        let e = execute("store_trust", &mut cx, &mut Journal::for_test(&roots)).unwrap_err();
        assert_eq!(e.code, Code::PairFailed);
    }

    /// Stands in for the one-shot initdb service: writes the files initdb would, or crashes.
    struct InitdbFake {
        ok: bool,
        runs: Cell<u32>,
        pw_present_during_run: Cell<bool>,
        busy: bool,
        protected: RefCell<Vec<(std::path::PathBuf, Vec<String>)>>,
    }
    impl InitdbFake {
        fn new(ok: bool) -> Self {
            InitdbFake { ok, runs: Cell::new(0), pw_present_during_run: Cell::new(false), busy: false, protected: RefCell::new(vec![]) }
        }
        fn failing() -> Self {
            Self::new(false)
        }
        fn succeeding() -> Self {
            Self::new(true)
        }
        fn runs(&self) -> u32 {
            self.runs.get()
        }
    }
    impl Runtime for InitdbFake {
        fn name(&self) -> &'static str { "initdb-fake" }
        fn prepare(&self, _: &Roots, _: &std::path::Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, roots: &Roots, _: &std::path::Path, script: &std::path::Path, _: Duration) -> Result<(), String> {
            self.runs.set(self.runs.get() + 1);
            let dir = script.parent().unwrap();
            self.pw_present_during_run.set(dir.join("initdb-pw.tmp").is_file());
            std::fs::write(roots.pgdata().join("PG_VERSION"), "17\n").unwrap();
            if !self.ok {
                return Err("crashed mid-initdb".into());
            }
            std::fs::write(roots.pgdata().join("postgresql.conf"), "# initdb\n").unwrap();
            std::fs::write(roots.pgdata().join("pg_hba.conf"), "host all all 127.0.0.1/32 scram-sha-256\n").unwrap();
            std::fs::write(dir.join("initdb.exit"), "0\r\n").unwrap();
            Ok(())
        }
        fn ensure_postgres_idle(&self) -> Result<(), String> {
            if self.busy { Err("SupermarketPOS-Postgres is Running".into()) } else { Ok(()) }
        }
        fn start(&self, _: &Roots, _: &std::path::Path, _: Component) -> Result<(), String> { Ok(()) }
        fn stop(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> { Ok(()) }
        fn unregister(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn protect_file(&self, p: &std::path::Path, g: &[crate::acl::Grant]) -> Result<(), String> {
            self.protected.borrow_mut().push((p.to_path_buf(), g.iter().map(|x| x.sid.clone()).collect()));
            Ok(())
        }
    }

    // a half-built cluster is never adopted (initdb writes PG_VERSION first, the port/listen/UTC overrides last),
    // so the step always wipes pgdata and reruns.
    #[test]
    fn initdb_wipes_a_half_built_cluster_and_reruns() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        std::fs::write(roots.pgdata().join("PG_VERSION"), "17\n").unwrap();
        std::fs::write(roots.pgdata().join("leftover"), "x").unwrap();
        let rt = InitdbFake::failing();
        let mut cx = Cx::for_test(&roots, &rt);
        assert!(step_initdb(&mut cx).is_err());
        assert!(!roots.pgdata().join("leftover").exists(), "the old contents were wiped before initdb ran");
        assert_eq!(rt.runs(), 1);
        let ok = InitdbFake::succeeding();
        let mut cx = Cx::for_test(&roots, &ok);
        assert!(step_initdb(&mut cx).is_ok());
        assert_eq!(ok.runs(), 1, "a pgdata that already holds PG_VERSION is still rerun");
        let conf = std::fs::read_to_string(roots.pgdata().join("postgresql.conf")).unwrap();
        assert!(conf.contains("listen_addresses = '127.0.0.1'") && conf.contains(&format!("port = {}", cx.ports.pg())));
    }

    // CARRY (Task 7): the initdb password file is ACL'd to the Postgres account and SYSTEM only, and gone on every path.
    #[test]
    fn the_initdb_password_file_is_protected_and_deleted_on_success_and_on_failure() {
        for ok in [true, false] {
            let d = tempfile::tempdir().unwrap();
            let mut roots = layout_roots(&d);
            roots.dev = false; // so `protect_file` is called on the fake
            let rt = InitdbFake::new(ok);
            let mut cx = Cx::for_test(&roots, &rt);
            assert_eq!(step_initdb(&mut cx).is_ok(), ok);
            assert!(rt.pw_present_during_run.get(), "the file exists while initdb runs");
            let pw = roots.tmp_for(Component::Postgres.service_name()).join("initdb-pw.tmp");
            assert!(!pw.exists(), "deleted (ok = {ok})");
            let prot = rt.protected.borrow().clone();
            let (_, sids) = prot.iter().find(|(p, _)| p == &pw).expect("the password file was protected");
            assert_eq!(sids, &vec![crate::acl::SID_SYSTEM.to_string(), Component::Postgres.sid()]);
        }
    }

    // CARRY (Task 2): a tool's output is redacted before it reaches an error, the journal or the envelope.
    #[test]
    fn a_failing_alter_role_echo_never_reaches_the_error_text() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        let pw = cx.secrets().unwrap().pg_password("postgres").to_string();
        let o = ToolOutput { code: 3, stdout: String::new(), stderr: format!("ERROR:  syntax error\nSTATEMENT:  ALTER ROLE postgres PASSWORD '{pw}'") };
        let e = cx.fail("03-owner-role failed", &o.text());
        assert!(!e.message.contains(&pw) && e.message.contains("***"), "{}", e.message);
        let anon_free = cx.secrets().unwrap().service_role_key.expose().to_string();
        assert!(!cx.fail("x", &anon_free).message.contains(&anon_free), "every loaded secret is registered");
    }

    #[test]
    fn a_bad_first_admin_pin_is_a_usage_error_before_anything_is_touched() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        let v = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&v).unwrap();
        pack::make_fake_pack(&v, "1.0.0-r1");
        let args = ProvisionArgs { pack: "auto".into(), server_host: Some("shop".into()), pin: Some("12345".into()), ..Default::default() };
        let err = run(&roots, &NoopRuntime, &args).unwrap_err();
        assert_eq!(err.code, Code::Usage);
        assert!(!roots.data.exists(), "nothing may be created before validation");
    }

    #[test]
    fn an_operation_journal_blocks_provision_before_anything_else() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(roots.journal(), "{}").unwrap();
        let err = run(&roots, &NoopRuntime, &ProvisionArgs::default()).unwrap_err();
        assert_eq!((err.code, err.code.exit()), (Code::RecoveryNeeded, 17));
    }

    // ---------------------------------------------------------------- F10
    #[test]
    fn trivial_supplied_pins_are_usage_errors() {
        for pin in ["000000", "123456", "654321", "012345", "987654"] {
            let a = ProvisionArgs { pin: Some(pin.into()), ..Default::default() };
            assert_eq!(pin_plan(&a).err().unwrap().code, Code::Usage, "{pin}");
        }
        assert!(matches!(pin_plan(&ProvisionArgs { pin: Some("135790".into()), ..Default::default() }), Ok(PinPlan::Supplied)));
    }

    #[test]
    fn a_generated_pin_is_never_trivial() {
        for _ in 0..3000 {
            assert!(!crate::util::is_trivial_pin(&fresh_pin().unwrap()));
        }
    }

    #[test]
    fn a_resumed_run_takes_its_plan_from_the_journal_and_refuses_args_that_disagree() {
        let params = json!({"firstAdminName": "Ana", "prepareForSwitch": true, "skipFirstAdmin": false});
        let eff = resume_args(&ProvisionArgs { resume: true, ..Default::default() }, &params).unwrap();
        assert_eq!((eff.first_admin_name.as_deref(), eff.prepare_for_switch, eff.skip_first_admin), (Some("Ana"), true, false), "an omitted flag means the journal's value");
        let same = ProvisionArgs { first_admin_name: Some("Ana".into()), prepare_for_switch: true, ..Default::default() };
        assert!(resume_args(&same, &params).is_ok());
        let usage = |a: ProvisionArgs, p: &Value| {
            let e = resume_args(&a, p).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::Usage, 2));
            e.message
        };
        assert!(usage(ProvisionArgs { first_admin_name: Some("Bob".into()), ..Default::default() }, &params).contains("Ana"));
        let plain = json!({"firstAdminName": "Ana", "prepareForSwitch": false, "skipFirstAdmin": false});
        assert!(usage(ProvisionArgs { prepare_for_switch: true, ..Default::default() }, &plain).contains("prepare-for-switch"));
        assert!(usage(ProvisionArgs { skip_first_admin: true, ..Default::default() }, &plain).contains("skip"));
    }

    #[test]
    fn a_resumed_run_keeps_the_journals_pack_version() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        for v in ["1.0.0-r1", "1.1.0-r1"] {
            let dir = roots.pack_dir(v).unwrap();
            std::fs::create_dir_all(&dir).unwrap();
            pack::make_fake_pack(&dir, v);
        }
        let params = json!({"packVersion": "1.0.0-r1"});
        assert_eq!(resolve_pack_for_run(&roots, "auto", Some(&params)).unwrap().manifest.pack_version, "1.0.0-r1", "auto does not jump to the newer pack");
        assert_eq!(resolve_pack_for_run(&roots, "auto", None).unwrap().manifest.pack_version, "1.1.0-r1");
        let newer = roots.pack_dir("1.1.0-r1").unwrap().display().to_string();
        let e = resolve_pack_for_run(&roots, &newer, Some(&params)).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert!(e.message.contains("1.0.0-r1") && e.message.contains("1.1.0-r1"), "{}", e.message);
    }

    #[test]
    fn no_pin_is_needed_once_the_first_admin_step_is_done() {
        let a = ProvisionArgs { resume: true, ..Default::default() }; // not interactive, no PIN
        assert_eq!(pin_plan_for_run(&a, false).err().unwrap().code, Code::Usage);
        assert!(matches!(pin_plan_for_run(&a, true), Ok(PinPlan::None)));
        let bad = ProvisionArgs { pin: Some("12".into()), ..a };
        assert!(matches!(pin_plan_for_run(&bad, true), Ok(PinPlan::None)), "a leftover argument is not validated either");
    }

    #[test]
    fn a_bad_base_port_argument_is_usage_before_anything_is_created() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        let v = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&v).unwrap();
        pack::make_fake_pack(&v, "1.0.0-r1");
        let args = ProvisionArgs { pack: "auto".into(), server_host: Some("shop".into()), base_port: Some(80), skip_first_admin: true, ..Default::default() };
        let e = run(&roots, &NoopRuntime, &args).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::Usage, 2));
        assert!(!roots.data.exists());
    }

    #[test]
    fn a_production_provision_refuses_a_dev_or_contract_base_port_before_anything_is_created() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        let v = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&v).unwrap();
        pack::make_fake_pack(&v, "1.0.0-r1");
        for b in [47400u16, 47450, 47980] {
            let args = ProvisionArgs { pack: "auto".into(), server_host: Some("shop".into()), base_port: Some(b), skip_first_admin: true, ..Default::default() };
            let e = run(&roots, &NoopRuntime, &args).unwrap_err();
            assert_eq!(e.code, Code::Usage, "{b}");
            assert!(!roots.data.exists());
        }
    }

    // Final review CODE I1/I2: a store the tills could never pair with is refused before anything is created
    #[test]
    fn a_production_provision_refuses_a_port_or_host_pairing_would_reject_before_anything_is_created() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        let v = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&v).unwrap();
        pack::make_fake_pack(&v, "1.0.0-r1");
        for (host, base) in [("shop", 48000u16), ("storepc.lan", 47300), ("tienda.home", 47300), ("shop.example.com", 47300)] {
            let args = ProvisionArgs { pack: "auto".into(), server_host: Some(host.into()), base_port: Some(base), skip_first_admin: true, ..Default::default() };
            let e = run(&roots, &NoopRuntime, &args).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::Usage, 2), "{host} {base}");
            assert!(!roots.data.exists(), "{host} {base}");
        }
    }

    #[test]
    fn the_store_id_from_a_journal_must_be_a_uuid_v4() {
        assert_eq!(store_id_for(Some("11111111-2222-4333-8444-555555555555")).unwrap(), "11111111-2222-4333-8444-555555555555");
        assert!(crate::util::is_uuid_v4(&store_id_for(None).unwrap()));
        for bad in ["", "not-a-uuid", "11111111-2222-3333-8444-555555555555", "..\\..\\x"] {
            assert_eq!(store_id_for(Some(bad)).unwrap_err().code, Code::RecoveryNeeded, "{bad}");
        }
    }

    // a journal that cannot be written fails the step, but the `always` cleanup (stub removal) still runs
    #[test]
    fn a_journal_write_error_is_the_failure_and_the_always_steps_still_run() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("gone");
        std::fs::create_dir_all(&sub).unwrap();
        let mut j = Journal::begin(&sub.join("j.json"), "provision", json!({})).unwrap();
        std::fs::remove_dir_all(&sub).unwrap(); // every later mark() fails
        let (ran, r) = drive(&mut j, None);
        let e = r.unwrap_err();
        assert!(e.message.contains("I/O error"), "{}", e.message);
        assert_eq!(ran, ["stubs-remove"], "nothing else ran, the cleanup did");
    }

    #[test]
    fn initdb_refuses_to_wipe_while_a_postgres_service_is_running() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        std::fs::write(roots.pgdata().join("PG_VERSION"), "17\n").unwrap();
        let mut rt = InitdbFake::succeeding();
        rt.busy = true;
        let mut cx = Cx::for_test(&roots, &rt);
        assert!(step_initdb(&mut cx).is_err());
        assert!(roots.pgdata().join("PG_VERSION").exists(), "nothing was wiped");
        assert_eq!(rt.runs(), 0);
    }

    #[test]
    fn the_gateway_settings_a_run_was_given_reach_the_render_input_and_default_to_the_state_file() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        secrets::ensure(&roots.secrets(), false).unwrap();
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        assert_eq!(cx.render_input().unwrap().gateway, GatewaySettings::default(), "first run, nothing given: plain loopback HTTP");
        cx.gateway = Some(GatewaySettings::dev_internal());
        assert_eq!(cx.render_input().unwrap().gateway, GatewaySettings::dev_internal());
        cx.gateway = None;
        std::fs::write(roots.state().join("gateway.json"), r#"{"tls":"internal","extBind":"127.0.0.1","hosts":["localhost"]}"#).unwrap();
        let g = cx.render_input().unwrap().gateway;
        assert_eq!((g.tls, g.hosts), (crate::gateway::TlsMode::Internal, vec!["localhost".to_string()]), "a resumed run keeps what the state file says");
    }

    // ---- first admin (F10 i)
    type Created = Result<FirstAdmin, firstadmin::FirstAdminError>;
    fn admin_cx<'a>(roots: &'a Roots, rt: &'a dyn Runtime, pin: Option<&str>) -> Cx<'a> {
        let mut cx = Cx::for_test(roots, rt);
        cx.skip_first_admin = false;
        cx.pin = pin.map(String::from);
        cx
    }
    fn run_admin(cx: &mut Cx, create: Created, reset: Result<(), firstadmin::FirstAdminError>) -> (Result<(), PosctlError>, Vec<(String, String)>) {
        let resets = RefCell::new(Vec::new());
        let mut create = Some(create);
        let r = first_admin_with(
            cx,
            &mut |_pin, _reg| create.take().expect("create called once"),
            &mut |id, pin, _reg| {
                resets.borrow_mut().push((id.to_string(), pin.to_string()));
                reset.as_ref().map(|_| ()).map_err(|e| firstadmin::FirstAdminError::Reset(e.to_string()))
            },
        );
        (r, resets.into_inner())
    }

    #[test]
    fn a_created_admin_with_a_generated_pin_shows_it() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = admin_cx(&roots, &NoopRuntime, None);
        let (r, resets) = run_admin(&mut cx, Ok(FirstAdmin::Created { id: "a".into(), email: "e".into() }), Ok(()));
        r.unwrap();
        assert!(resets.is_empty());
        assert_eq!(cx.generated_pin.as_ref().map(String::len), Some(6));
        assert_eq!(cx.admin_id.as_deref(), Some("a"));
    }

    // crash after create: the resumed step sees AlreadyExists, resets the PIN and shows the new one
    #[test]
    fn a_resumed_run_resets_the_pin_of_the_admin_it_already_made_and_shows_the_new_one() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = admin_cx(&roots, &NoopRuntime, None);
        let (r, resets) = run_admin(&mut cx, Ok(FirstAdmin::AlreadyExists { id: "abc".into() }), Ok(()));
        r.unwrap();
        let shown = cx.generated_pin.clone().expect("a PIN is shown");
        assert_eq!(resets, vec![("abc".to_string(), shown)], "the reset used the very PIN that is shown");
        assert_eq!(cx.admin_id.as_deref(), Some("abc"));
    }

    #[test]
    fn a_resumed_run_with_a_supplied_pin_resets_to_it_and_does_not_echo_it() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = admin_cx(&roots, &NoopRuntime, Some("135790"));
        let (r, resets) = run_admin(&mut cx, Ok(FirstAdmin::AlreadyExists { id: "abc".into() }), Ok(()));
        r.unwrap();
        assert_eq!(resets, vec![("abc".to_string(), "135790".to_string())]);
        assert!(cx.generated_pin.is_none(), "the caller already knows a PIN it supplied");
    }

    #[test]
    fn a_failed_reset_fails_the_step_and_shows_no_pin() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = admin_cx(&roots, &NoopRuntime, None);
        let (r, _) = run_admin(&mut cx, Ok(FirstAdmin::AlreadyExists { id: "abc".into() }), Err(firstadmin::FirstAdminError::Reset("both stores were restored".into())));
        assert!(r.unwrap_err().message.contains("restored"));
        assert!(cx.generated_pin.is_none(), "the old PIN still works, so no new one is announced");
    }

    // finalize fails after the PIN was minted: the outcome still carries it (stdout only), the result file never does
    #[test]
    fn a_failure_after_the_pin_was_minted_still_carries_it() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let mut cx = admin_cx(&roots, &NoopRuntime, None);
        let mut j = Journal::for_test(&roots);
        let err = drive_steps(&mut cx, &mut j, 0, &mut |name, cx, _| {
            match name {
                "first_admin" => {
                    cx.admin_id = Some("abc".into());
                    cx.generated_pin = Some("482915".into());
                }
                "finalize" => return Err(PosctlError::error("disk full")),
                _ => {}
            }
            Ok(())
        })
        .unwrap_err();
        assert_eq!(j.steps.iter().find(|s| s.name == "first_admin").and_then(|s| s.detail.clone()).as_deref(), Some("abc"), "the admin id is kept in the journal for a resumed finalize");
        assert_eq!(err.data["failedStep"], "finalize");
        let out = failure_outcome(&mut cx, err, j.path()).expect("an outcome, not an Err");
        assert_eq!(out.code, Code::Error);
        let secret = out.secret_once.clone().expect("the PIN rides along");
        assert_eq!((secret.section, secret.field, secret.value.as_str()), ("firstAdmin", "pin", "482915"));
        let env = crate::envelope::Envelope::from_outcome("provision", "t0", "t1", &out);
        assert!(!env.to_file_json().contains("482915"));
        assert!(env.to_stdout_json(out.secret_once.as_ref()).contains("482915"));
        // no PIN minted: a plain error
        let mut cx2 = admin_cx(&roots, &NoopRuntime, None);
        assert!(failure_outcome(&mut cx2, PosctlError::error("x"), j.path()).is_err());
    }

    // ---- canary failure stops the stack (F10 j)
    struct OrderRt(RefCell<Vec<String>>);
    impl Runtime for OrderRt {
        fn name(&self) -> &'static str { "order" }
        fn prepare(&self, _: &Roots, _: &std::path::Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, _: &Roots, _: &std::path::Path, _: &std::path::Path, _: Duration) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &Roots, _: &std::path::Path, _: Component) -> Result<(), String> { Ok(()) }
        fn stop(&self, c: Component) -> Result<(), String> { self.0.borrow_mut().push(c.short().to_string()); Ok(()) }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> { Ok(()) }
        fn unregister(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn protect_file(&self, _: &std::path::Path, _: &[crate::acl::Grant]) -> Result<(), String> { Ok(()) }
    }

    // I1: Functions depends on Auth, so stopping only [Gateway, Auth] fails with 1051 and leaves Auth serving
    #[test]
    fn a_failed_canary_stops_gateway_then_functions_then_auth_and_keeps_its_code() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let rt = OrderRt(RefCell::new(vec![]));
        let mut cx = Cx::for_test(&roots, &rt);
        let mut j = Journal::for_test(&roots);
        let e = step_canary_with(&mut cx, &mut j, &|| Err(PosctlError::new(Code::CanaryFailed, "hook not active"))).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::CanaryFailed, 22));
        assert_eq!(*rt.0.borrow(), [Component::Gateway.short(), Component::Functions.short(), Component::Auth.short()]);
        let ok = OrderRt(RefCell::new(vec![]));
        let mut cx = Cx::for_test(&roots, &ok);
        let mut j = Journal::for_test(&roots);
        step_canary_with(&mut cx, &mut j, &|| Ok(())).unwrap();
        assert!(ok.0.borrow().is_empty(), "a passing canary stops nothing");
        assert_eq!(j.state_of("start_stack"), None, "a passing canary leaves the journal alone");
    }

    // CR-I1: a resume after a gated (failed canary) provision must put the gated services back on automatic start
    #[test]
    fn start_stack_after_a_gated_provision_restores_automatic_start() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let scm = crate::lifecycle::test_support::Scm::all_running();
        scm.running.borrow_mut().clear();
        let cx = Cx::for_test(&roots, &scm);
        start_sign_in_stack(&cx, &|_| true).unwrap();
        let types = scm.start_types.borrow().clone();
        for c in ["Auth", "Functions", "Gateway"] {
            assert!(types.contains(&format!("{c}=auto")), "{c} must be set to automatic start: {types:?}");
        }
    }

    // A2: the stack is stopped, so a resume must restart it before the canary runs again (not sit at exit 22 forever)
    #[test]
    fn after_a_failed_canary_a_resume_restarts_the_stack_and_then_reruns_the_canary() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let rt = OrderRt(RefCell::new(vec![]));
        let mut cx = Cx::for_test(&roots, &rt);
        let mut j = Journal::for_test(&roots);
        for s in STEPS.iter().take_while(|s| s.name != "canary") {
            j.mark(s.name, StepState::Done, None).unwrap();
        }
        j.mark("canary", StepState::Started, None).unwrap();
        step_canary_with(&mut cx, &mut j, &|| Err(PosctlError::new(Code::CanaryFailed, "hook not active"))).unwrap_err();
        let first = crate::journal::resume_index(&j, &STEPS).unwrap();
        assert_eq!(STEPS[first].name, "start_stack");
        let mut ran = Vec::new();
        drive_steps(&mut cx, &mut j, first, &mut |name, _, _| {
            ran.push(name.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(&ran[..2], ["start_stack", "canary"]);
    }

    // F3: Plan 05 wrote secrets\canary.pw; the account password is random and never stored now
    #[test]
    fn the_orphan_canary_password_file_is_removed_and_a_missing_one_is_fine() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        let pw = roots.secrets().join("canary.pw");
        std::fs::write(&pw, "0123456789abcdef0123456789abcdef").unwrap();
        remove_orphan_canary_pw(&roots);
        assert!(!pw.exists());
        remove_orphan_canary_pw(&roots);
    }

    // ---- Plan 05b: the `network` and `tasks` steps and the early network refusal

    use crate::net::{Category, Confirmation, Profile};

    #[derive(Default)]
    struct FakeHost {
        calls: RefCell<Vec<String>>,
        profiles: Vec<Profile>,
    }
    impl HostOps for FakeHost {
        fn read_profiles(&self) -> Result<Vec<Profile>, String> {
            self.calls.borrow_mut().push("read_profiles".into());
            Ok(self.profiles.clone())
        }
        fn fix_profiles(&self, c: &Confirmation) -> Result<Vec<String>, String> {
            self.calls.borrow_mut().push(format!("fix_profiles {c:?}"));
            Ok(vec![])
        }
        fn ensure_rule(&self, ports: &Ports) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("ensure_rule {}", ports.base));
            Ok(())
        }
        fn install_tasks(&self, _exe: &std::path::Path) -> Result<Vec<String>, String> {
            self.calls.borrow_mut().push("install_tasks".into());
            Ok(vec![])
        }
        fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> { panic!("not used by the network steps") }
        fn self_pair(&self, _: &Roots) -> Result<Value, PosctlError> { panic!("not used by the network steps") }
    }
    fn nic(alias: &str, category: Category) -> Profile {
        Profile { interface_index: 7, alias: alias.into(), category }
    }

    #[test]
    fn a_dev_root_provision_never_reaches_the_network_or_tasks_steps() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        assert!(roots.dev);
        let host = FakeHost { profiles: vec![nic("Wi-Fi", Category::Public)], ..Default::default() };
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        for step in ["network", "tasks"] {
            execute(step, &mut cx, &mut Journal::for_test(&roots)).unwrap();
        }
        assert!(host.calls.borrow().is_empty(), "{:?}", host.calls);
        let args = ProvisionArgs::default();
        net_preflight(&roots, &args, &host, false).unwrap();
        assert!(host.calls.borrow().is_empty(), "the early refusal skips a dev root too");
    }

    #[test]
    fn a_production_root_confirms_then_marks_the_network_private_then_adds_the_rule_then_schedules_the_tasks() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = layout_roots(&d);
        roots.dev = false;
        let host = FakeHost { profiles: vec![nic("Wi-Fi", Category::Public)], ..Default::default() };
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        cx.confirm = Some(Confirmation::Bare);
        execute("network", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        execute("tasks", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        assert_eq!(*host.calls.borrow(), ["read_profiles", "fix_profiles Bare", "ensure_rule 47300", "install_tasks"]);
    }

    #[test]
    fn a_private_network_needs_no_confirmation_and_changes_nothing_but_the_rule() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = layout_roots(&d);
        roots.dev = false;
        let host = FakeHost { profiles: vec![nic("Ethernet", Category::Private)], ..Default::default() };
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        execute("network", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        assert_eq!(*host.calls.borrow(), ["read_profiles", "ensure_rule 47300"]);
    }

    #[test]
    fn a_public_network_without_confirmation_fails_before_anything_is_created_and_never_touches_it() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = layout_roots(&d);
        roots.dev = false;
        let host = FakeHost { profiles: vec![nic("Wi-Fi", Category::Public)], ..Default::default() };
        let e = net_preflight(&roots, &ProvisionArgs::default(), &host, false).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("--confirm-private-network"), "{}", e.message);
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        assert_eq!(execute("network", &mut cx, &mut Journal::for_test(&roots)).unwrap_err().code, Code::Precondition);
        assert!(!host.calls.borrow().iter().any(|c| c.starts_with("fix_profiles") || c.starts_with("ensure_rule")), "{:?}", host.calls);
    }

    #[test]
    fn a_bare_confirmation_with_two_public_networks_is_refused_up_front_and_named_ones_pass() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = layout_roots(&d);
        roots.dev = false;
        let host = FakeHost { profiles: vec![nic("Shop LAN", Category::Public), Profile { interface_index: 9, alias: "Guest Wi-Fi".into(), category: Category::Public }], ..Default::default() };
        let bare = ProvisionArgs { confirm_private_network: Some(Confirmation::Bare), ..Default::default() };
        assert_eq!(net_preflight(&roots, &bare, &host, false).unwrap_err().code, Code::Usage);
        let named = ProvisionArgs { confirm_private_network: Some(Confirmation::Aliases(vec!["Shop LAN".into()])), ..Default::default() };
        net_preflight(&roots, &named, &host, false).unwrap();
        let typo = ProvisionArgs { confirm_private_network: Some(Confirmation::Aliases(vec!["Shop".into()])), ..Default::default() };
        assert_eq!(net_preflight(&roots, &typo, &host, false).unwrap_err().code, Code::Usage);
        // a resumed run was checked when it started
        net_preflight(&roots, &ProvisionArgs { resume: true, ..Default::default() }, &host, true).unwrap();
    }

    #[test]
    fn the_confirmation_survives_the_journal_so_a_resume_without_the_flag_keeps_it() {
        for c in [None, Some(Confirmation::Bare), Some(Confirmation::Aliases(vec!["Wi-Fi".into(), "Eth 2".into()]))] {
            assert_eq!(confirmation_from_json(&confirmation_to_json(&c)), c);
        }
        let params = json!({"confirmPrivateNetwork": "bare"});
        let eff = resume_args(&ProvisionArgs { resume: true, ..Default::default() }, &params).unwrap();
        assert_eq!(eff.confirm_private_network, Some(Confirmation::Bare));
        let given = ProvisionArgs { resume: true, confirm_private_network: Some(Confirmation::Aliases(vec!["Wi-Fi".into()])), ..Default::default() };
        assert_eq!(resume_args(&given, &params).unwrap().confirm_private_network, Some(Confirmation::Aliases(vec!["Wi-Fi".into()])), "naming a network narrows a legacy bare confirmation");
    }

    fn prod_roots(d: &tempfile::TempDir) -> Roots {
        let mut roots = layout_roots(d);
        roots.dev = false;
        roots
    }

    #[test]
    fn the_early_check_runs_on_a_fresh_resume_without_a_journal_and_skips_only_a_real_one() {
        let d = tempfile::tempdir().unwrap();
        let roots = prod_roots(&d);
        let host = FakeHost { profiles: vec![nic("Wi-Fi", Category::Public)], ..Default::default() };
        let args = ProvisionArgs { resume: true, ..Default::default() };
        assert_eq!(net_preflight(&roots, &args, &host, false).unwrap_err().code, Code::Precondition, "--resume with no journal is a fresh run");
        assert!(net_preflight(&roots, &args, &host, true).is_ok(), "a journal was found: checked when it started");
    }

    #[test]
    fn a_bare_confirmation_is_journaled_as_the_networks_it_resolved_to() {
        let d = tempfile::tempdir().unwrap();
        let roots = prod_roots(&d);
        let host = FakeHost { profiles: vec![nic("Shop LAN", Category::Public)], ..Default::default() };
        let bare = ProvisionArgs { confirm_private_network: Some(Confirmation::Bare), ..Default::default() };
        assert_eq!(net_preflight(&roots, &bare, &host, false).unwrap(), Some(Confirmation::Aliases(vec!["Shop LAN".into()])));
        let quiet = FakeHost { profiles: vec![nic("Shop LAN", Category::Private)], ..Default::default() };
        assert_eq!(net_preflight(&roots, &bare, &quiet, false).unwrap(), None, "nothing Public: nothing to confirm or record");
    }

    #[test]
    fn a_resume_never_widens_the_journaled_confirmation_to_another_network() {
        let params = json!({"confirmPrivateNetwork": ["Shop LAN"]});
        let other = ProvisionArgs { resume: true, confirm_private_network: Some(Confirmation::Aliases(vec!["Guest Wi-Fi".into()])), ..Default::default() };
        assert_eq!(resume_args(&other, &params).unwrap_err().code, Code::Usage);
        let same = ProvisionArgs { resume: true, confirm_private_network: Some(Confirmation::Aliases(vec!["shop lan".into()])), ..Default::default() };
        assert_eq!(resume_args(&same, &params).unwrap().confirm_private_network, Some(Confirmation::Aliases(vec!["Shop LAN".into()])));
        // repeating the bare flag of the first command line means "what I confirmed", not "whatever is Public now"
        let bare = ProvisionArgs { resume: true, confirm_private_network: Some(Confirmation::Bare), ..Default::default() };
        assert_eq!(resume_args(&bare, &params).unwrap().confirm_private_network, Some(Confirmation::Aliases(vec!["Shop LAN".into()])));
        // and the network step, now on a PC whose only Public network is another one, changes nothing
        let d = tempfile::tempdir().unwrap();
        let roots = prod_roots(&d);
        let host = FakeHost { profiles: vec![nic("Guest Wi-Fi", Category::Public)], ..Default::default() };
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        cx.confirm = Some(Confirmation::Aliases(vec!["Shop LAN".into()]));
        assert_eq!(execute("network", &mut cx, &mut Journal::for_test(&roots)).unwrap_err().code, Code::Usage);
        assert!(!host.calls.borrow().iter().any(|c| c.starts_with("fix_profiles") || c.starts_with("ensure_rule")), "{:?}", host.calls);
    }

    #[test]
    fn a_profile_change_that_fails_is_error_and_the_applied_networks_reach_the_step_detail() {
        struct Failing;
        impl HostOps for Failing {
            fn read_profiles(&self) -> Result<Vec<Profile>, String> { Ok(vec![]) }
            fn fix_profiles(&self, _: &Confirmation) -> Result<Vec<String>, String> { Err("Set-NetConnectionProfile failed".into()) }
            fn ensure_rule(&self, _: &Ports) -> Result<(), String> { Ok(()) }
            fn install_tasks(&self, _: &std::path::Path) -> Result<Vec<String>, String> { Ok(vec![]) }
            fn local_ipv4s(&self) -> Result<Vec<std::net::Ipv4Addr>, String> { panic!() }
            fn self_pair(&self, _: &Roots) -> Result<Value, PosctlError> { panic!() }
        }
        let profiles = [nic("Wi-Fi", Category::Public)];
        assert_eq!(fix_public(&Failing, &profiles, &Confirmation::Bare).unwrap_err().code, Code::Error);
        assert_eq!(fix_public(&Failing, &profiles, &Confirmation::Aliases(vec!["Nope".into()])).unwrap_err().code, Code::Usage);
        let d = tempfile::tempdir().unwrap();
        let roots = prod_roots(&d);
        let host = FakeHost { profiles: vec![nic("Wi-Fi", Category::Public)], ..Default::default() };
        let mut cx = Cx::for_test(&roots, &NoopRuntime);
        cx.ops = &host;
        cx.confirm = Some(Confirmation::Bare);
        execute("network", &mut cx, &mut Journal::for_test(&roots)).unwrap();
        assert!(cx.detail.as_deref().is_some_and(|d| d.contains("private")), "{:?}", cx.detail);
    }

    #[test]
    fn the_debug_form_of_the_arguments_never_shows_the_pin() {
        let a = ProvisionArgs { pin: Some("135790".into()), ..Default::default() };
        let text = format!("{a:?}");
        assert!(!text.contains("135790") && text.contains("redacted"), "{text}");
    }

    #[test]
    fn the_schema_floor_file_only_ever_rises() {
        let d = tempfile::tempdir().unwrap();
        let roots = layout_roots(&d);
        assert_eq!(read_persisted_schema_max(&roots), None);
        persist_schema_max(&roots, "20260901000000").unwrap();
        persist_schema_max(&roots, "20260101000000").unwrap();
        assert_eq!(read_persisted_schema_max(&roots).as_deref(), Some("20260901000000"));
        persist_schema_max(&roots, "20270101000000").unwrap();
        assert_eq!(read_persisted_schema_max(&roots).as_deref(), Some("20270101000000"));
        std::fs::write(schema_max_path(&roots), "garbage").unwrap();
        assert_eq!(read_persisted_schema_max(&roots), None, "an unreadable value is no floor, never a panic");
    }
}
