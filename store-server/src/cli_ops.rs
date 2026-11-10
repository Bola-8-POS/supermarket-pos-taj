//! Plan 05b's subcommands: status, health, tasks, net, config, pack, dev. Kept in its own file
//! so the other plans' groups (pki, update, backup, ...) never edit it.
//!
//! Roots. `dev` carries its own (the instance under `POSCTL_DEV_ROOT`, never the global ones). Everything else uses
//! the global roots, which `--dev --data-root --program-root` replaces. A command that changes the machine outside
//! those roots (`tasks`, `net fix-profile`, `health --write`, which can stop real services) refuses a dev root.
//! Commands that change the machine need an elevated process (exit 3) except under a dev root.

use std::io::Read;
use std::time::Duration;

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::config::{validate_server_host, PosctlJson};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::net::{self, Confirmation};
use crate::ops::lock::{acquire_for, LockGuard, LockMode};
use crate::paths::Roots;
use crate::runtime::Runtime;
use crate::util::random_uuid_v4;
use crate::{conf, dev, layout, lifecycle, pack, packcmd, provision, status, sys, tasks};

#[derive(Subcommand, Debug)]
pub enum OpsCmd {
    /// Show the store server status.
    Status {
        /// Measure now instead of reading the last health run.
        #[arg(long)]
        refresh: bool,
    },
    /// Measure health; exit 20 unhealthy, 21 degraded, 22 canary failed.
    Health {
        /// Write `state\status.json` and gate the sign-in stack when the PIN lockout is off (the scheduled task).
        #[arg(long)]
        write: bool,
        /// Also run the PIN lockout canary now.
        #[arg(long)]
        canary: bool,
    },
    /// Scheduled health and canary tasks.
    #[command(subcommand)]
    Tasks(TasksCmd),
    /// Network profile and firewall rule checks.
    #[command(subcommand)]
    Net(NetCmd),
    /// Read or change an allow-listed setting.
    #[command(subcommand)]
    Config(ConfigCmd),
    /// Backend packs: fetch, install, verify, list.
    #[command(subcommand)]
    Pack(PackCmd),
    /// Test instances for Playwright (slots 0-9); never touch the production services.
    #[command(subcommand)]
    Dev(DevCmd),
}

#[derive(Subcommand, Debug)]
pub enum TasksCmd {
    /// Register the Health and Canary scheduled tasks.
    Install {
        #[command(flatten)]
        wait: WaitLock,
    },
    Remove {
        #[command(flatten)]
        wait: WaitLock,
    },
    Status,
}

/// The installer runs next to the per-minute Health task, which holds `update.lock` for a few seconds: its calls pass
/// `--wait-lock <seconds>` and wait for the lock that long. Interactive use keeps the default (no wait).
#[derive(Args, Debug, Clone, Copy)]
pub struct WaitLock {
    /// Seconds to wait for update.lock before giving up with exit 10.
    #[arg(long = "wait-lock", value_name = "SECONDS", default_value_t = 0)]
    pub secs: u64,
}

impl WaitLock {
    fn duration(self) -> Duration {
        Duration::from_secs(self.secs.min(600))
    }
}

#[derive(Subcommand, Debug)]
pub enum NetCmd {
    /// Network profile and firewall rule; exit 21 when either needs attention.
    Check,
    /// Switch a Public network to Private (and re-create the firewall rule).
    FixProfile {
        /// Bare, or `=<name>` (repeatable) when several networks are Public.
        #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "", action = clap::ArgAction::Append, value_name = "NAME")]
        confirm_private_network: Vec<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum ConfigCmd {
    Get { key: String },
    Set { key: String, value: String },
}

#[derive(Subcommand, Debug)]
pub enum PackCmd {
    /// Download (or take the bundled) pack and install it; data: { current, latest, installed }.
    Fetch {
        #[arg(long)]
        feed: Option<String>,
    },
    Install {
        #[arg(long)]
        file: std::path::PathBuf,
        #[command(flatten)]
        wait: WaitLock,
    },
    /// Check a .pospack file (signature and every hash) without installing it.
    Verify {
        #[arg(long)]
        file: std::path::PathBuf,
    },
    List,
    /// Delete old packs (keeping the 2 newest, `pack.current`, `pack.previous` and the packs of an interrupted operation) and old
    /// pos_prev_* / pos_failed_* databases. Takes `update.lock`.
    Prune {
        #[arg(long, default_value_t = 2)]
        keep: usize,
    },
    /// Re-point the services and configs at an installed pack (used by `update`; hidden).
    #[command(hide = true)]
    Activate {
        #[arg(long)]
        version: String,
        #[arg(long)]
        set_current: bool,
    },
}

#[derive(Args, Debug)]
pub struct SlotArg {
    /// 0-9
    #[arg(long)]
    pub slot: u8,
}

#[derive(Subcommand, Debug)]
pub enum DevCmd {
    New {
        #[arg(long)]
        slot: u8,
        #[arg(long)]
        pack_dir: std::path::PathBuf,
        #[arg(long, default_value = "off")]
        tls: String,
    },
    Start(SlotArg),
    Stop(SlotArg),
    Destroy(SlotArg),
    Env(SlotArg),
    /// Render the current gateway configs with fixed test values for tests/gateway-contract.test.ps1 (hidden).
    #[command(hide = true)]
    RenderGateway {
        #[arg(long)]
        out: std::path::PathBuf,
        /// `off` (plain HTTP) or `internal` (Caddy's own CA, as `dev new --tls internal`).
        #[arg(long, default_value = "off")]
        tls: String,
    },
    /// Print the test hooks compiled into this binary: an empty list in every release build (hidden).
    #[command(hide = true, alias = "hook-labels")]
    HookEnv,
    /// Run the product's own SQL against the live cluster and print one result per statement (test-hooks builds only; Sandbox scenario 68).
    #[cfg(feature = "test-hooks")]
    #[command(hide = true)]
    SqlSmoke,
    /// Create the instance's first admin; with `--pin-stdin` the PIN is the first line of stdin.
    SeedFirstAdmin {
        #[arg(long)]
        slot: u8,
        #[arg(long)]
        pin_stdin: bool,
    },
}

impl OpsCmd {
    pub fn name(&self) -> &'static str {
        match self {
            OpsCmd::Status { .. } => "status",
            OpsCmd::Health { .. } => "health",
            OpsCmd::Tasks(_) => "tasks",
            OpsCmd::Net(_) => "net",
            OpsCmd::Config(_) => "config",
            OpsCmd::Pack(_) => "pack",
            OpsCmd::Dev(_) => "dev",
        }
    }
}

fn need_admin(roots: &Roots) -> Result<(), PosctlError> {
    if roots.dev || sys::is_elevated() {
        Ok(())
    } else {
        Err(PosctlError::new(Code::NotElevated, "this command must run as an administrator"))
    }
}

/// `tasks`, `net fix-profile` and `health --write` act on the real machine (Task Scheduler, network profiles, the
/// production services) whatever the roots say, so a dev root is refused rather than half honoured.
fn refuse_dev_root(roots: &Roots, what: &str) -> Result<(), PosctlError> {
    if roots.dev {
        return Err(PosctlError::new(Code::Usage, format!("{what} acts on the real machine and cannot run with --dev")));
    }
    Ok(())
}

/// The flag value(s) of `--confirm-private-network[=NAME]...`: none = not given; one empty value = the bare flag;
/// names = exactly those networks. A bare flag next to names says two things at once, so it is refused.
pub fn parse_confirmation(values: &[String]) -> Result<Option<Confirmation>, PosctlError> {
    match values {
        [] => Ok(None),
        [v] if v.trim().is_empty() => Ok(Some(Confirmation::Bare)),
        _ if values.iter().any(|v| v.trim().is_empty()) => Err(PosctlError::new(Code::Usage, "--confirm-private-network is either bare or names networks (=<name>), not both")),
        _ => Ok(Some(Confirmation::Aliases(values.iter().map(|v| v.trim().to_string()).collect()))),
    }
}

/// The keys `config set` may change (conventions: allow-listed). Everything else is written by
/// the command that owns it.
pub const CONFIG_KEYS: [&str; 3] = ["pack.feedUrl", "maintenance.maxSeconds", "server.extraSans"];

pub fn config_get(cfg: &PosctlJson, key: &str) -> Result<Value, PosctlError> {
    match key {
        "pack.feedUrl" => Ok(json!(cfg.pack.feed_url)),
        "maintenance.maxSeconds" => Ok(json!(cfg.maintenance.max_seconds)),
        "server.extraSans" => Ok(json!(cfg.server.extra_sans)),
        _ => Err(PosctlError::new(Code::Usage, format!("'{key}' is not a readable key; allowed: {}", CONFIG_KEYS.join(", ")))),
    }
}

pub fn config_set(cfg: &mut PosctlJson, key: &str, value: &str) -> Result<(), PosctlError> {
    let usage = |m: String| PosctlError::new(Code::Usage, m);
    match key {
        "pack.feedUrl" => {
            if value.is_empty() {
                cfg.pack.feed_url = None;
            } else if packcmd::feed_url_allowed(value, false) {
                cfg.pack.feed_url = Some(value.to_string());
            } else {
                return Err(usage("pack.feedUrl must be an https URL".into()));
            }
        }
        "maintenance.maxSeconds" => {
            let n: u32 = value.parse().map_err(|_| usage("maintenance.maxSeconds must be a number".into()))?;
            if !(60..=7200).contains(&n) {
                return Err(usage("maintenance.maxSeconds must be between 60 and 7200".into()));
            }
            cfg.maintenance.max_seconds = n;
        }
        "server.extraSans" => {
            let mut list = Vec::new();
            for h in value.split(',').map(str::trim).filter(|h| !h.is_empty()) {
                list.push(validate_server_host(h).map_err(usage)?);
            }
            cfg.server.extra_sans = list;
        }
        _ => return Err(usage(format!("'{key}' cannot be set; allowed: {}", CONFIG_KEYS.join(", ")))),
    }
    Ok(())
}

/// The operation lock for a command that writes under the data root (a pack install racing an update or a
/// provision would otherwise pick its pack folder under it). Taken only once a state folder exists: on a PC that
/// was never provisioned there is nothing to race (the NSIS installer's first `pack install`). The data root is
/// judged on one handle BEFORE the lock, as everywhere else.
///
/// `wait` is how long to retry while another operation holds the lock (`acquire` itself fails fast on an exclusive
/// holder, which is right for an update but not for the seconds-long Health task the installer races).
fn write_lock(roots: &Roots, kind: &str, wait: Duration) -> Result<Option<LockGuard>, PosctlError> {
    if !roots.state().exists() {
        return Ok(None);
    }
    layout::check_existing_data_root(roots)?;
    let op_id = random_uuid_v4().map_err(PosctlError::error)?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        match acquire_for(roots, LockMode::Exclusive, kind, &op_id, Duration::from_secs(0)) {
            Ok(g) => return Ok(Some(g)),
            Err(e) if e.code == crate::ops::outcome::OpCode::LockHeld && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(e.into()),
        }
    }
}

/// The lowest schema an installed pack may carry: the highest of the live database's `max_version`, the one
/// `provision` last recorded (`state\schema-max`: survives a stopped Postgres and a rolled-back activation) and the
/// pack the PC runs. Where data exists (a provisioned PC, a kept cluster, a half-finished provision) and none of the
/// three can be read, the install is REFUSED: silently checking nothing would let an older pack under a newer schema.
pub(crate) fn live_schema_max_with(roots: &Roots, query: &dyn Fn(&Roots) -> Option<String>) -> Result<Option<String>, PosctlError> {
    let data_exists = roots.provisioned_json().exists() || roots.pgdata().join("PG_VERSION").exists();
    if !data_exists {
        return Ok(None);
    }
    let from_pack = || {
        let cfg = PosctlJson::load(roots).ok()??;
        let dir = roots.pack_dir(&cfg.pack.current).ok()?;
        pack::load_unverified(&dir).ok().map(|p| p.manifest.migrations.max)
    };
    // 14-digit versions: the text order is the numeric order
    let floor = [query(roots), provision::read_persisted_schema_max(roots), from_pack()].into_iter().flatten().max();
    match floor {
        Some(f) => Ok(Some(f)),
        None => Err(PosctlError::new(Code::PackInvalid, "this PC has data, but its database schema version cannot be determined (no live database, no recorded schema, no readable current pack); not installing a pack that could be older. Start the stack (posctl start) and retry")),
    }
}

/// `health --write` acts on the real machine and gates the sign-in stack; `--canary` reads admin-only secrets. Either one
/// without an elevated process would report a misleading verdict, so both are refused up front (exit 3).
fn health_gate(roots: &Roots, write: bool, canary: bool) -> Result<(), PosctlError> {
    if write {
        refuse_dev_root(roots, "health --write")?;
    }
    if write || canary {
        need_admin(roots)?;
    }
    Ok(())
}

/// `tasks install`: provisioned, then the operation lock (an `unprovision` or update in flight owns the machine), then
/// provisioned AGAIN under the lock (an `unprovision` that finished while we waited would otherwise leave SYSTEM tasks
/// on an unprovisioned PC).
fn tasks_install_with(roots: &Roots, wait: Duration, install: &dyn Fn() -> Result<Vec<String>, String>) -> Result<Outcome, PosctlError> {
    tasks_install_after(roots, wait, &|| {}, install)
}

fn tasks_install_after(roots: &Roots, wait: Duration, between: &dyn Fn(), install: &dyn Fn() -> Result<Vec<String>, String>) -> Result<Outcome, PosctlError> {
    let not_provisioned = || PosctlError::new(Code::NotProvisioned, "nothing to schedule: this PC is not provisioned");
    if !roots.provisioned_json().exists() {
        return Err(not_provisioned());
    }
    between();
    let _lock = write_lock(roots, "tasks-install", wait)?;
    if !roots.provisioned_json().exists() {
        return Err(not_provisioned());
    }
    let done = install().map_err(PosctlError::error)?;
    Ok(Outcome::ok("tasks installed", json!({"tasks": done})))
}

fn query_live_schema(roots: &Roots) -> Option<String> {
    let inst = lifecycle::load_installed(roots).ok()?;
    let psql = crate::pg::Psql { tools: crate::pg::PgTools::for_pack(&inst.pack.dir), port: inst.ports.pg(), pgpass: roots.pgpass() };
    psql.scalar("postgres", "postgres", "select coalesce(max_version,'') from public.store_schema_version;").ok().filter(|s| !s.is_empty())
}

fn install_options(roots: &Roots) -> Result<packcmd::InstallOptions, PosctlError> {
    Ok(packcmd::InstallOptions { allow_downgrade: false, live_schema_max: live_schema_max_with(roots, &query_live_schema)? })
}

pub fn run(roots_fn: &dyn Fn() -> Result<Roots, PosctlError>, cmd: &OpsCmd, stdin: &mut dyn Read, rt: &dyn Runtime) -> Result<Outcome, PosctlError> {
    // `dev` carries its own roots (the instance); everything else uses the global ones.
    if let OpsCmd::Dev(d) = cmd {
        return match d {
            DevCmd::New { slot, pack_dir, tls } => dev::new(*slot, pack_dir, tls),
            DevCmd::Start(s) => dev::start(s.slot),
            DevCmd::Stop(s) => dev::stop(s.slot),
            DevCmd::Destroy(s) => dev::destroy(s.slot),
            DevCmd::Env(s) => dev::env(s.slot),
            DevCmd::RenderGateway { out, tls } => dev::render_gateway(out, tls),
            // the names of the env-var test hooks; `dev hook-labels` (crash labels) is Plan 07's command
            DevCmd::HookEnv => {
                // `killLabels`: every point a Sandbox scenario can kill an update at (test-hooks builds only)
                #[cfg(feature = "test-hooks")]
                return Ok(Outcome::ok("test hooks", json!({"labels": packcmd::hook_env(), "killLabels": crate::ops::hooked::journal_labels()})));
                #[cfg(not(feature = "test-hooks"))]
                Ok(Outcome::ok("test hooks", json!({"labels": packcmd::hook_env()})))
            }
            #[cfg(feature = "test-hooks")]
            DevCmd::SqlSmoke => crate::commands::update::sql_smoke_cli(&roots_fn()?),
            DevCmd::SeedFirstAdmin { slot, pin_stdin } => {
                let pin = if *pin_stdin { Some(crate::cli::pin_line(&crate::cli::read_stdin_text(stdin, 1024)?)) } else { None };
                dev::seed_first_admin(*slot, pin)
            }
        };
    }
    let roots = roots_fn()?;
    match cmd {
        OpsCmd::Status { refresh } => status::status(&roots, *refresh, &status::scm_state),
        OpsCmd::Health { write, canary } => {
            health_gate(&roots, *write, *canary)?;
            status::health(&roots, *write, *canary, &status::scm_state, rt)
        }
        OpsCmd::Tasks(t) => {
            refuse_dev_root(&roots, "tasks")?;
            match t {
                TasksCmd::Install { wait } => {
                    need_admin(&roots)?;
                    let exe = std::env::current_exe()?;
                    tasks_install_with(&roots, wait.duration(), &|| tasks::install(&exe))
                }
                TasksCmd::Remove { wait } => {
                    need_admin(&roots)?;
                    let _lock = write_lock(&roots, "tasks-remove", wait.duration())?; // not while `unprovision` or an update owns the machine
                    let removed = tasks::remove().map_err(PosctlError::error)?;
                    Ok(Outcome::ok("tasks removed", json!({"tasks": removed})))
                }
                TasksCmd::Status => {
                    need_admin(&roots)?; // an unreadable task would read as missing
                    let st = tasks::status().map_err(PosctlError::error)?;
                    Ok(Outcome::ok("tasks", json!({"tasks": st.iter().map(|(n, ok)| json!({"name": n, "installed": ok})).collect::<Vec<_>>()})))
                }
            }
        }
        OpsCmd::Net(n) => {
            let cfg = PosctlJson::load(&roots).map_err(PosctlError::error)?;
            let ports = crate::ports::Ports::new(cfg.as_ref().map(|c| c.ports.base).unwrap_or(crate::ports::DEFAULT_BASE)).map_err(PosctlError::error)?;
            match n {
                NetCmd::Check => {
                    let profiles = net::read_profiles().map_err(PosctlError::error)?;
                    let rules = net::read_rule().map_err(PosctlError::error)?;
                    let public = net::any_public(&profiles);
                    let rule_ok = net::rule_ok(&rules, &ports);
                    let data = json!({
                        "profiles": profiles.iter().map(|p| json!({"interface": p.alias, "category": p.category.name()})).collect::<Vec<_>>(),
                        "anyPublic": public,
                        "firewallRule": {"exists": !rules.is_empty(), "ok": rule_ok},
                        "alert": if public { json!("NETWORK_PROFILE_PUBLIC") } else { Value::Null },
                    });
                    let attention = public || (cfg.is_some() && !rule_ok);
                    let code = if attention { Code::Degraded } else { Code::Ok };
                    Ok(Outcome::with_code(code, if attention { "the network profile or the firewall rule needs attention" } else { "network ok" }, data))
                }
                NetCmd::FixProfile { confirm_private_network } => {
                    refuse_dev_root(&roots, "net fix-profile")?;
                    need_admin(&roots)?;
                    let Some(confirmation) = parse_confirmation(confirm_private_network)? else {
                        return Err(PosctlError::new(Code::Usage, "pass --confirm-private-network (or =<name>) to confirm that the connected network is the shop network"));
                    };
                    let _lock = write_lock(&roots, "net-fix-profile", Duration::ZERO)?;
                    // a confirmation the networks do not match is USAGE; a failure to change the profile is ERROR
                    let host = provision::RealHost;
                    let profiles = provision::HostOps::read_profiles(&host).map_err(PosctlError::error)?;
                    let fixed = provision::fix_public(&host, &profiles, &confirmation)?;
                    if cfg.is_some() {
                        net::ensure_rule(&ports).map_err(PosctlError::error)?;
                    }
                    Ok(Outcome::ok("network profile fixed", json!({"fixed": fixed})))
                }
            }
        }
        OpsCmd::Config(c) => {
            let mut cfg = PosctlJson::load(&roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
            match c {
                ConfigCmd::Get { key } => Ok(Outcome::ok("config", json!({"key": key, "value": config_get(&cfg, key)?}))),
                ConfigCmd::Set { key, value } => {
                    need_admin(&roots)?;
                    config_set(&mut cfg, key, value)?; // validate before the lock
                    let _lock = write_lock(&roots, "config", Duration::ZERO)?;
                    // re-read under the lock: an update that finished meanwhile may have changed other keys
                    let mut cfg = PosctlJson::load(&roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
                    config_set(&mut cfg, key, value)?;
                    cfg.save(&roots)?;
                    Ok(Outcome::ok("config saved", json!({"key": key, "value": config_get(&cfg, key)?})))
                }
            }
        }
        OpsCmd::Pack(p) => match p {
            PackCmd::List => Ok(Outcome::ok("packs", json!({"packs": packcmd::list(&roots).iter().map(|(v, ok)| json!({"packVersion": v, "valid": ok})).collect::<Vec<_>>()}))),
            PackCmd::Prune { keep } => {
                need_admin(&roots)?;
                crate::commands::update::run_prune_cli(&roots, *keep)
            }
            PackCmd::Verify { file } => {
                // signature and every file hash: the FULL tier, as at install
                let m = packcmd::process_zip(file, &packcmd::updater_pubkey(), None)?;
                Ok(Outcome::ok("the pack is valid", json!({"packVersion": m.pack_version, "appVersion": m.app_version, "files": m.files.len()})))
            }
            PackCmd::Install { file, wait } => {
                need_admin(&roots)?;
                let _lock = write_lock(&roots, "pack-install", wait.duration())?;
                let r = packcmd::install_file(&roots, file, &packcmd::updater_pubkey(), &install_options(&roots)?)?;
                Ok(install_outcome(r))
            }
            PackCmd::Activate { version, set_current } => {
                refuse_dev_root(&roots, "pack activate")?; // it re-points the real services and the Functions registry key
                need_admin(&roots)?;
                conf::activate_locked(&roots, rt, version, *set_current)
            }
            PackCmd::Fetch { feed } => {
                need_admin(&roots)?;
                let _lock = write_lock(&roots, "pack-fetch", Duration::ZERO)?;
                let src = packcmd::source(&roots, None, feed.as_deref()).map_err(|e| PosctlError::new(Code::Usage, e))?;
                let opts = install_options(&roots)?;
                let (r, latest) = match src {
                    packcmd::PackSource::Download { feed_url } => packcmd::fetch(&roots, &feed_url, &packcmd::updater_pubkey(), &opts)?,
                    packcmd::PackSource::Bundled(f) | packcmd::PackSource::File(f) => {
                        let r = packcmd::install_file(&roots, &f, &packcmd::updater_pubkey(), &opts)?;
                        let v = match &r {
                            packcmd::Installed::New { pack_version } | packcmd::Installed::AlreadyInstalled { pack_version } => pack_version.clone(),
                        };
                        (r, v)
                    }
                };
                let mut out = install_outcome(r);
                // conventions 17.D: the envelope data of `pack fetch` is { current, latest, installed }
                out.data["current"] = json!(PosctlJson::load(&roots).ok().flatten().map(|c| c.pack.current));
                out.data["latest"] = json!(latest);
                out.data["installed"] = json!(packcmd::list(&roots).into_iter().map(|(v, _)| v).collect::<Vec<_>>());
                Ok(out)
            }
        },
        OpsCmd::Dev(_) => unreachable!("handled above"),
    }
}

fn install_outcome(r: packcmd::Installed) -> Outcome {
    match r {
        packcmd::Installed::New { pack_version } => Outcome::ok("pack installed", json!({"packVersion": pack_version, "alreadyInstalled": false})),
        packcmd::Installed::AlreadyInstalled { pack_version } => Outcome::ok("pack already installed", json!({"packVersion": pack_version, "alreadyInstalled": true})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PosctlJson;
    use crate::paths::Roots;
    use serde_json::{json, Value};
    use std::ffi::OsString;

    fn cfg() -> PosctlJson {
        PosctlJson::new("offline-only", "id", 47300, "shop", "1.0.0-r1")
    }

    fn run(args: &[String]) -> (i32, Value) {
        let mut out = Vec::new();
        let code = crate::cli::run_cli_with(args.iter().map(OsString::from).collect(), &mut std::io::empty(), &mut out, false);
        (code, serde_json::from_str(String::from_utf8(out).unwrap().trim()).unwrap())
    }

    fn dev_args(d: &tempfile::TempDir, tail: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = ["posctl", "--dev", "--data-root", &d.path().join("data").display().to_string(), "--program-root", &d.path().join("prog").display().to_string()].map(String::from).to_vec();
        v.extend(tail.iter().map(|s| s.to_string()));
        v
    }

    fn provisioned(d: &tempfile::TempDir) -> Roots {
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        for p in [roots.state(), roots.conf(), roots.secrets()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let p = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&p).unwrap();
        crate::pack::make_fake_pack(&p, "1.0.0-r1");
        cfg().save(&roots).unwrap();
        roots
    }

    #[test]
    fn only_allow_listed_config_keys_can_be_read_or_written() {
        let mut c = cfg();
        assert!(config_get(&c, "ports.base").is_err());
        assert!(config_set(&mut c, "ports.base", "47400").is_err());
        assert!(config_set(&mut c, "mode", "cloud").is_err());
        config_set(&mut c, "maintenance.maxSeconds", "1200").unwrap();
        assert_eq!(config_get(&c, "maintenance.maxSeconds").unwrap(), json!(1200));
        for bad in ["10", "100000", "abc"] {
            assert!(config_set(&mut c, "maintenance.maxSeconds", bad).is_err(), "{bad}");
        }
        config_set(&mut c, "pack.feedUrl", "https://example.invalid/pack-latest.json").unwrap();
        assert!(config_set(&mut c, "pack.feedUrl", "http://example.invalid/x").is_err());
        config_set(&mut c, "pack.feedUrl", "").unwrap();
        assert_eq!(config_get(&c, "pack.feedUrl").unwrap(), Value::Null);
        config_set(&mut c, "server.extraSans", "Shop-PC, 192.168.1.20").unwrap();
        assert_eq!(config_get(&c, "server.extraSans").unwrap(), json!(["shop-pc", "192.168.1.20"]));
        assert!(config_set(&mut c, "server.extraSans", "8.8.8.8").is_err());
        assert!(config_set(&mut c, "server.extraSans", "*.shop").is_err());
    }

    #[test]
    fn the_confirm_flag_maps_to_bare_or_named_networks_and_never_both() {
        use crate::net::Confirmation::{Aliases, Bare};
        assert_eq!(parse_confirmation(&[]).unwrap(), None);
        assert_eq!(parse_confirmation(&["".into()]).unwrap(), Some(Bare));
        assert_eq!(parse_confirmation(&["Wi-Fi".into(), "Ethernet 2".into()]).unwrap(), Some(Aliases(vec!["Wi-Fi".into(), "Ethernet 2".into()])));
        assert_eq!(parse_confirmation(&["".into(), "Wi-Fi".into()]).unwrap_err().code, crate::envelope::Code::Usage);
    }

    #[test]
    fn commands_that_touch_the_host_refuse_a_dev_root() {
        let d = tempfile::tempdir().unwrap();
        for tail in [&["tasks", "install"][..], &["tasks", "remove"], &["tasks", "status"], &["net", "fix-profile", "--confirm-private-network"], &["health", "--write"], &["pack", "activate", "--version", "1.0.0-r1"]] {
            let (code, v) = run(&dev_args(&d, tail));
            assert_eq!((code, v["code"].clone()), (2, json!("USAGE")), "{tail:?}: {v}");
        }
    }

    #[test]
    fn config_set_then_get_goes_through_the_cli_and_the_file() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d);
        let (code, v) = run(&dev_args(&d, &["config", "set", "maintenance.maxSeconds", "1200"]));
        assert_eq!(code, 0, "{v}");
        assert_eq!(PosctlJson::load(&roots).unwrap().unwrap().maintenance.max_seconds, 1200);
        let (code, v) = run(&dev_args(&d, &["config", "get", "maintenance.maxSeconds"]));
        assert_eq!((code, v["data"]["value"].clone()), (0, json!(1200)));
        let (code, v) = run(&dev_args(&d, &["config", "get", "ports.base"]));
        assert_eq!((code, v["code"].clone()), (2, json!("USAGE")));
    }

    #[test]
    fn config_on_a_pc_that_is_not_provisioned_is_exit_4() {
        let d = tempfile::tempdir().unwrap();
        let (code, v) = run(&dev_args(&d, &["config", "get", "pack.feedUrl"]));
        assert_eq!((code, v["code"].clone()), (4, json!("NOT_PROVISIONED")));
    }

    #[test]
    fn pack_verify_of_a_file_that_is_not_a_pack_is_exit_13() {
        let d = tempfile::tempdir().unwrap();
        let bogus = d.path().join("x.pospack");
        std::fs::write(&bogus, b"not a zip").unwrap();
        let (code, v) = run(&dev_args(&d, &["pack", "verify", "--file", &bogus.display().to_string()]));
        assert_eq!((code, v["code"].clone()), (13, json!("PACK_INVALID")), "{v}");
    }

    #[test]
    fn dev_hook_env_lists_exactly_the_hooks_compiled_in() {
        let (code, v) = run(&["posctl".into(), "dev".into(), "hook-env".into()]);
        assert_eq!(code, 0, "{v}");
        assert_eq!(v["data"]["labels"], json!(crate::packcmd::hook_env()));
        #[cfg(not(feature = "test-hooks"))]
        assert_eq!(v["data"]["labels"], json!([]), "a plain build has no hook");
        #[cfg(not(feature = "test-hooks"))]
        assert!(v["data"].get("killLabels").is_none(), "a plain build lists no kill label");
        // the Plan 07 name of the same command, and the kill-label list the Sandbox scripts read
        #[cfg(feature = "test-hooks")]
        {
            let (code, v) = run(&["posctl".into(), "dev".into(), "hook-labels".into()]);
            assert_eq!(code, 0, "{v}");
            assert_eq!(v["data"]["killLabels"].as_array().map(Vec::len), Some(25), "{v}");
            assert_eq!(v["data"]["killLabels"][0], json!("journal:started:done"));
            assert_eq!(v["data"]["labels"], json!(crate::packcmd::hook_env()), "the Plan 05b arm is kept");
        }
    }

    #[test]
    fn a_dev_slot_out_of_range_is_usage_and_dev_needs_no_global_roots() {
        let (code, v) = run(&["posctl".into(), "dev".into(), "env".into(), "--slot".into(), "10".into()]);
        assert_eq!((code, v["code"].clone()), (2, json!("USAGE")), "{v}");
    }

    #[test]
    fn the_install_floor_is_the_highest_of_live_persisted_and_current_pack_and_only_where_data_exists() {
        let d = tempfile::tempdir().unwrap();
        let bare = Roots::custom(d.path().join("none"), d.path().join("prog0"));
        assert_eq!(live_schema_max_with(&bare, &|_| panic!("no data: nothing to ask")).unwrap(), None);
        let roots = provisioned(&d);
        assert_eq!(live_schema_max_with(&roots, &|_| Some("20270101000000".into())).unwrap(), Some("20270101000000".into()));
        // Postgres down: the pack the PC runs still sets a floor, so an older pack cannot slip in
        assert_eq!(live_schema_max_with(&roots, &|_| None).unwrap(), Some("20260101000002".into()));
        // a schema that was once higher (a rolled-back activation) beats the lower current pack
        crate::provision::persist_schema_max(&roots, "20270303000000").unwrap();
        assert_eq!(live_schema_max_with(&roots, &|_| None).unwrap(), Some("20270303000000".into()));
        assert_eq!(live_schema_max_with(&roots, &|_| Some("20270101000000".into())).unwrap(), Some("20270303000000".into()));
    }

    #[test]
    fn data_with_no_way_to_know_its_schema_refuses_the_install_instead_of_checking_nothing() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d);
        std::fs::remove_file(roots.conf().join("posctl.json")).unwrap();
        let e = live_schema_max_with(&roots, &|_| None).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid, "{}", e.message);
        // after `unprovision --keep-data` (no provisioned.json, the cluster is still there) the same holds
        std::fs::remove_file(roots.provisioned_json()).unwrap();
        std::fs::create_dir_all(roots.pgdata()).unwrap();
        std::fs::write(roots.pgdata().join("PG_VERSION"), "17").unwrap();
        assert_eq!(live_schema_max_with(&roots, &|_| None).unwrap_err().code, Code::PackInvalid);
        crate::provision::persist_schema_max(&roots, "20260101000002").unwrap();
        assert_eq!(live_schema_max_with(&roots, &|_| None).unwrap(), Some("20260101000002".into()));
    }

    #[test]
    fn tasks_install_under_a_held_operation_lock_is_refused_and_installs_nothing() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d);
        let held = acquire_for(&roots, LockMode::Exclusive, "update", "op-1", Duration::from_secs(0)).unwrap();
        let called = std::cell::Cell::new(false);
        let install = || {
            called.set(true);
            Ok(vec![])
        };
        let e = tasks_install_with(&roots, Duration::ZERO, &install).unwrap_err();
        assert_eq!(e.code, Code::LockHeld, "{}", e.message);
        assert!(!called.get());
        drop(held);
        assert!(tasks_install_with(&roots, Duration::ZERO, &install).is_ok() && called.get());
    }

    #[test]
    fn write_lock_waits_for_a_short_holder_and_gives_up_after_the_wait() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d);
        // the per-minute Health task holds update.lock for seconds: an installer call with a wait gets in behind it
        let held = acquire_for(&roots, LockMode::Exclusive, "health", "h-1", Duration::from_secs(0)).unwrap();
        let e = write_lock(&roots, "tasks-install", Duration::from_millis(300)).err().unwrap();
        assert_eq!(e.code, Code::LockHeld, "gives up once the wait is over");
        assert_eq!(write_lock(&roots, "x", Duration::ZERO).err().unwrap().code, Code::LockHeld, "default stays immediate");
        let r2 = roots.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            drop(held);
            r2
        });
        assert!(write_lock(&roots, "tasks-install", Duration::from_secs(10)).unwrap().is_some());
        t.join().unwrap();
    }

    #[test]
    fn the_installer_flag_wait_lock_is_accepted_by_tasks_install_remove_() {
        let d = tempfile::tempdir().unwrap();
        for tail in [&["tasks", "install", "--wait-lock", "30"][..], &["tasks", "remove", "--wait-lock", "30"], &["pack", "install", "--file", "x.pospack", "--wait-lock", "30"]] {
            let (_, v) = run(&dev_args(&d, tail));
            assert!(!v["message"].as_str().unwrap_or("").contains("unexpected argument"), "{tail:?}: {v}");
        }
    }

    #[test]
    fn tasks_install_rechecks_under_the_lock_that_the_pc_is_still_provisioned() {
        let d = tempfile::tempdir().unwrap();
        let roots = provisioned(&d);
        let installed = std::cell::Cell::new(false);
        // the first check passes, then unprovision completes before the lock is ours: nothing may be installed
        let unprovision_won = || std::fs::remove_file(roots.provisioned_json()).unwrap(); // what a finished `unprovision` leaves
        let e = tasks_install_after(&roots, Duration::ZERO, &unprovision_won, &|| {
            installed.set(true);
            Ok(vec![])
        })
        .unwrap_err();
        assert_eq!(e.code, Code::NotProvisioned);
        assert!(!installed.get());
    }

    #[test]
    fn health_write_and_canary_need_an_administrator_before_they_measure_anything() {
        if crate::sys::is_elevated() {
            return; // the check is for the plain-user case; an elevated run would really write the status file
        }
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        for (write, canary) in [(true, false), (false, true), (true, true)] {
            assert_eq!(health_gate(&roots, write, canary).unwrap_err().code, Code::NotElevated, "write={write} canary={canary}");
        }
        assert!(health_gate(&roots, false, false).is_ok(), "a plain read needs no elevation");
    }

    #[test]
    fn help_stays_coherent_and_the_internal_commands_are_hidden() {
        use clap::CommandFactory;
        let cmd = crate::cli::Cli::command();
        cmd.clone().debug_assert();
        for name in ["status", "health", "tasks", "net", "config", "pack", "dev", "provision", "unprovision", "start"] {
            assert!(cmd.find_subcommand(name).is_some_and(|c| !c.is_hide_set()), "{name} must be listed");
        }
        let hidden = |parent: &str, child: &str| cmd.find_subcommand(parent).and_then(|p| p.find_subcommand(child)).is_some_and(|c| c.is_hide_set());
        assert!(hidden("pack", "activate") && hidden("dev", "render-gateway") && hidden("dev", "hook-env"));
        assert!(!hidden("pack", "install") && !hidden("dev", "new"));
        // the SQL smoke exists only in a test-hooks build, and there it is hidden
        assert_eq!(cmd.find_subcommand("dev").and_then(|p| p.find_subcommand("sql-smoke")).map(|c| c.is_hide_set()), if cfg!(feature = "test-hooks") { Some(true) } else { None });
    }
}
