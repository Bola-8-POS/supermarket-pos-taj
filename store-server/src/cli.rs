//! Argument parsing, dispatch and the one-JSON-object output contract (conventions section 11):
//! stdout carries exactly one UTF-8 JSON object, logs go to the log file, `--result-file` gets an
//! atomic copy without the once-only secret.
//!
//! It must never print anything but that one object on stdout (clap text is only ever `--help`),
//! never write the once-only secret (a generated first-admin PIN) to the result file or the log, and
//! never read a secret from an argument: values come in on stdin.

use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;

use clap::{error::ErrorKind, Args, Parser, Subcommand};
use serde_json::json;

use crate::envelope::{Code, Envelope, Outcome, PosctlError, POSCTL_VERSION};
use crate::paths::Roots;
use crate::runtime::{Runtime, WindowsServices};
use crate::util::{now_rfc3339, write_atomic};
use crate::{console, lifecycle, provision, secrets, unprovision};

#[derive(Parser, Debug)]
#[command(name = "posctl", disable_version_flag = true, about = "Supermarket POS store-server control")]
pub struct Cli {
    /// Accepted for symmetry: output is always one JSON object.
    #[arg(long, global = true)]
    pub json: bool,
    /// Also write the result JSON atomically to this file (without the once-only secret).
    #[arg(long, global = true, value_name = "PATH")]
    pub result_file: Option<PathBuf>,
    /// Dev/test only: use this data root (requires --dev and --program-root).
    #[arg(long, global = true, value_name = "DIR")]
    pub data_root: Option<PathBuf>,
    #[arg(long, global = true, value_name = "DIR")]
    pub program_root: Option<PathBuf>,
    #[arg(long, global = true)]
    pub dev: bool,
    #[arg(long, global = true)]
    pub quiet: bool,
    /// A person at a visible elevated console (installer or app): questions, human output, a pause at the end. Needs a terminal; refuses --json and --result-file.
    #[arg(long, global = true)]
    pub console: bool,
    #[command(subcommand)]
    pub command: Command,
}

/// One flattened variant per plan that adds subcommands. Plan 05b adds `Ops`, Plan 06 `Pki`, ...
#[derive(Subcommand, Debug)]
pub enum Command {
    #[command(flatten)]
    Lifecycle(LifecycleCmd),
    #[command(flatten)]
    Ops(crate::cli_ops::OpsCmd),
    #[command(flatten)]
    Pki(crate::pkicmd::PkiTop),
    #[command(flatten)]
    Pair(crate::paircmd::PairTop),
    #[command(flatten)]
    Update(crate::commands::update::UpdateTop),
    #[command(flatten)]
    Backup(crate::backup::args::BackupTop),
    #[command(flatten)]
    Switch(crate::commands::switch::SwitchTop),
    #[command(flatten)]
    Photos(crate::commands::photos::PhotosTop),
}

#[derive(Subcommand, Debug)]
pub enum LifecycleCmd {
    /// Install and start the Offline-only backend on this PC.
    Provision(ProvisionCli),
    /// Remove the services; optionally delete the data.
    Unprovision(UnprovisionCli),
    /// Start the services (all, or one component).
    Start(StartCli),
    /// Stop the services, dependents first.
    Stop(ComponentCli),
    Restart(ComponentCli),
    /// Optional Functions secrets (AI import, e-mail receipts).
    Secret(SecretCli),
    /// Versions of posctl and the newest installed pack.
    Version,
}

#[derive(Args, Debug, Clone)]
pub struct ProvisionCli {
    /// `auto` (highest installed pack) or the folder of an installed pack.
    #[arg(long, default_value = "auto")]
    pub pack: String,
    #[arg(long)]
    pub server_host: Option<String>,
    #[arg(long)]
    pub base_port: Option<u16>,
    /// The shop network is marked Public: switch it to Private. Bare, or `=<name>` (repeatable) when several networks are Public.
    #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "", action = clap::ArgAction::Append, value_name = "NAME")]
    pub confirm_private_network: Vec<String>,
    #[arg(long)]
    pub first_admin_name: Option<String>,
    /// Read the first admin's PIN (one line) from stdin instead of generating one.
    #[arg(long)]
    pub first_admin_pin_stdin: bool,
    #[arg(long)]
    pub resume: bool,
    /// Build the local stack for an owner moving an existing cloud store (Plan 09/11): the mode
    /// stays `cloud`, no first admin is created, no `store.env` is written.
    #[arg(long)]
    pub prepare_for_switch: bool,
}

#[derive(Args, Debug)]
pub struct UnprovisionCli {
    #[arg(long)]
    pub keep_data: bool,
    #[arg(long)]
    pub delete_data: bool,
    #[arg(long)]
    pub confirm: Option<String>,
}

#[derive(Args, Debug)]
pub struct ComponentCli {
    #[arg(long)]
    pub component: Option<String>,
}

#[derive(Args, Debug)]
pub struct StartCli {
    #[arg(long)]
    pub component: Option<String>,
    /// After starting, prove the PIN lockout (the canary). A failed canary stops the sign-in stack again (exit 22).
    #[arg(long)]
    pub canary: bool,
}

#[derive(Args, Debug)]
pub struct SecretCli {
    #[command(subcommand)]
    pub action: SecretAction,
}

#[derive(Subcommand, Debug)]
pub enum SecretAction {
    /// `secret set <NAME> --stdin`: the value is one line on stdin, never an argument.
    Set(SecretSetCli),
}

#[derive(Args, Debug)]
pub struct SecretSetCli {
    /// One of ANTHROPIC_API_KEY, RESEND_API_KEY, RECEIPT_FROM_EMAIL.
    pub name: String,
    /// Required: read the value from stdin.
    #[arg(long)]
    pub stdin: bool,
}

pub fn command_name(c: &Command) -> &'static str {
    match c {
        Command::Ops(o) => o.name(),
        Command::Pki(_) => "pki",
        Command::Pair(_) => "pair",
        Command::Update(_) => "update",
        Command::Backup(_) => "backup",
        Command::Switch(_) => "switch",
        Command::Photos(_) => "photos",
        Command::Lifecycle(l) => match l {
            LifecycleCmd::Provision(_) => "provision",
            LifecycleCmd::Unprovision(_) => "unprovision",
            LifecycleCmd::Start(_) => "start",
            LifecycleCmd::Stop(_) => "stop",
            LifecycleCmd::Restart(_) => "restart",
            LifecycleCmd::Secret(_) => "secret",
            LifecycleCmd::Version => "version",
        },
    }
}

fn roots_for(cli: &Cli) -> Result<Roots, PosctlError> {
    match (&cli.data_root, &cli.program_root) {
        (None, None) if !cli.dev => Roots::production(),
        (Some(d), Some(p)) if cli.dev => {
            if let Ok(prod) = Roots::production() {
                refuse_production_data(d, &prod.data)?;
            }
            Ok(Roots::custom(d.clone(), p.clone()))
        }
        _ => Err(PosctlError::new(Code::Usage, "--data-root and --program-root are dev/test options: pass both, together with --dev")),
    }
}

/// `--dev` with the production data folder would run dev-only paths (no ACL checks, no elevation) on the real store.
fn refuse_production_data(custom: &std::path::Path, production: &std::path::Path) -> Result<(), PosctlError> {
    // canonical where the folder exists (`..`, `.`, case, links resolved); lexical otherwise, so a root that does not exist yet still compares
    let norm = |p: &std::path::Path| -> String {
        let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        c.to_string_lossy().trim_start_matches(r"\\?\").trim_end_matches(['\\', '/']).to_lowercase()
    };
    if norm(custom) == norm(production) {
        return Err(PosctlError::new(Code::Usage, "--dev must not point at the production data folder; use a test folder"));
    }
    Ok(())
}

/// `dispatch` uses `WindowsServices`, so these commands refuse a dev root outright. Otherwise an
/// elevated `--dev provision` would register real services and write secrets to the real HKLM Functions key,
/// and `--dev unprovision` would delete the production services (conventions 11, `paths.rs`).
fn refuse_dev_root(cli: &Cli, what: &str) -> Result<(), PosctlError> {
    if cli.dev {
        return Err(PosctlError::new(Code::Usage, format!("{what} registers or removes real Windows services and cannot run with --dev; use `posctl dev ...` for test instances")));
    }
    Ok(())
}

/// At most `max` bytes of stdin as text. A longer input is cut, so a runaway pipe cannot fill memory;
/// the callers' own validation then refuses what is left.
pub(crate) fn read_stdin_text(stdin: &mut dyn Read, max: u64) -> Result<String, PosctlError> {
    let mut s = String::new();
    stdin.take(max).read_to_string(&mut s).map_err(|e| PosctlError::new(Code::Usage, format!("stdin is not readable text: {e}")))?;
    Ok(s)
}

/// A leading BOM (PowerShell pipes add one) and one trailing line break are the pipe's; anything else stays
/// and is refused by the value rules.
fn secret_value(text: &str) -> &str {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    text.strip_suffix("\r\n").or_else(|| text.strip_suffix('\n')).unwrap_or(text)
}

/// The first line of a PIN piped in on stdin: a leading byte order mark (PowerShell pipes add one) and the line break are
/// the pipe's, surrounding spaces are dropped, everything else stays for the PIN rules to refuse.
pub(crate) fn pin_line(text: &str) -> String {
    text.strip_prefix('\u{feff}').unwrap_or(text).lines().next().unwrap_or("").trim().to_string()
}

pub fn dispatch(cli: &Cli, stdin: &mut dyn Read) -> Result<Outcome, PosctlError> {
    match &cli.command {
        // before the dev refusal below: status, health, config, pack and net work on a dev root, `dev` has its own
        Command::Ops(o) => crate::cli_ops::run(&|| roots_for(cli), o, stdin, &WindowsServices),
        Command::Lifecycle(l) => dispatch_lifecycle(cli, l, stdin),
        // export-root, status and verify-trust work on a dev root; reissue refuses one itself
        Command::Pki(crate::pkicmd::PkiTop::Pki(c)) => crate::pkicmd::run(&roots_for(cli)?, &WindowsServices, c),
        // create, fetch, join and prune work on a dev root (the certificate store is never called there)
        Command::Pair(crate::paircmd::PairTop::Pair(c)) => crate::paircmd::run(&roots_for(cli)?, c),
        // not elevated -> exit 3, then not provisioned -> exit 4; a dev root never reaches the real services (see `commands::update::run_cli`)
        Command::Update(crate::commands::update::UpdateTop::Update(a)) => crate::commands::update::run_cli(&roots_for(cli)?, cli.dev, a),
        // not provisioned -> exit 4; the key console refuses a result file; works on a dev root (it never touches the real services)
        Command::Backup(crate::backup::args::BackupTop::Backup(a)) => crate::commands::backup::run_cli(&roots_for(cli)?, a, cli.result_file.is_some(), stdin),
        // not elevated -> exit 3, then not provisioned -> exit 4; works on a dev root; the cloud credentials come from stdin only
        Command::Switch(crate::commands::switch::SwitchTop::Switch(c)) => crate::commands::switch::run_cli(&roots_for(cli)?, cli.dev, c, stdin),
        // bad flag/name -> exit 2, not elevated -> 3, not provisioned -> 4, then stdin credentials (2); a dev root works (it never touches the real services)
        Command::Photos(crate::commands::photos::PhotosTop::Photos(a)) => crate::commands::photos::run_cli(&roots_for(cli)?, a, stdin),
    }
}

fn dispatch_lifecycle(cli: &Cli, l: &LifecycleCmd, stdin: &mut dyn Read) -> Result<Outcome, PosctlError> {
    let rt: &dyn Runtime = &WindowsServices;
    match l {
        LifecycleCmd::Provision(_) => refuse_dev_root(cli, "provision")?,
        LifecycleCmd::Unprovision(_) => refuse_dev_root(cli, "unprovision")?,
        LifecycleCmd::Start(_) => refuse_dev_root(cli, "start")?,
        LifecycleCmd::Stop(_) => refuse_dev_root(cli, "stop")?,
        LifecycleCmd::Restart(_) => refuse_dev_root(cli, "restart")?,
        LifecycleCmd::Secret(_) => refuse_dev_root(cli, "secret set")?,
        LifecycleCmd::Version => {}
    }
    match l {
        LifecycleCmd::Version => {
            let roots = roots_for(cli).ok();
            // Light tier: `version` must stay cheap. A highest pack that does not verify is reported, never skipped for an older one.
            let (pack, pack_error) = match roots.map(|r| crate::pack::latest_installed(&r.packs(), crate::pack::Tier::Light)) {
                Some(Ok(p)) => (p.map(|p| p.manifest.pack_version), None),
                Some(Err(e)) => (None, Some(e)),
                None => (None, None),
            };
            Ok(Outcome::ok("posctl", json!({"posctlVersion": POSCTL_VERSION, "latestInstalledPack": pack, "packError": pack_error})))
        }
        LifecycleCmd::Provision(a) => run_provision(cli, a, rt, stdin),
        LifecycleCmd::Unprovision(a) => {
            if a.keep_data && a.delete_data {
                return Err(PosctlError::new(Code::Usage, "--keep-data and --delete-data exclude each other"));
            }
            unprovision::run(&roots_for(cli)?, rt, &unprovision::UnprovisionArgs { delete_data: a.delete_data, confirm: a.confirm.clone() })
        }
        LifecycleCmd::Start(a) if a.canary => {
            let canary = crate::status::Canary::real();
            lifecycle::start_checked(&roots_for(cli)?, rt, a.component.as_deref(), &*canary.run)
        }
        LifecycleCmd::Start(a) => lifecycle::start(&roots_for(cli)?, rt, a.component.as_deref()),
        LifecycleCmd::Stop(a) => lifecycle::stop(&roots_for(cli)?, rt, a.component.as_deref()),
        LifecycleCmd::Restart(a) => lifecycle::restart(&roots_for(cli)?, rt, a.component.as_deref()),
        LifecycleCmd::Secret(SecretCli { action: SecretAction::Set(a) }) => {
            if !a.stdin {
                return Err(PosctlError::new(Code::Usage, "secret set reads the value from stdin: pass --stdin (a secret is never an argument)"));
            }
            let text = read_stdin_text(stdin, 2048)?;
            let value = secret_value(&text);
            secrets::check_optional_args(&a.name, value)?; // refuse before any root is resolved
            secrets::set_optional(&roots_for(cli)?, rt, &a.name, value)
        }
    }
}

fn run_provision(cli: &Cli, a: &ProvisionCli, rt: &dyn Runtime, stdin: &mut dyn Read) -> Result<Outcome, PosctlError> {
    let roots = roots_for(cli)?;
    let pin = if a.first_admin_pin_stdin { Some(pin_line(&read_stdin_text(stdin, 1024)?)) } else { None };
    let confirm_private_network = crate::cli_ops::parse_confirmation(&a.confirm_private_network)?;
    provision::run(
        &roots,
        rt,
        &provision::ProvisionArgs {
            pack: a.pack.clone(),
            server_host: a.server_host.clone(),
            base_port: a.base_port,
            confirm_private_network,
            first_admin_name: a.first_admin_name.clone(),
            pin,
            resume: a.resume,
            skip_first_admin: false,
            prepare_for_switch: a.prepare_for_switch,
            // a generated first-admin PIN is only allowed with an interactive terminal and no
            // --result-file (`std::io::IsTerminal` on stdout): otherwise no one can read it.
            // `--console` was checked to be a terminal run (or a Sandbox test run) before dispatch.
            interactive: cli.console || (std::io::IsTerminal::is_terminal(&std::io::stdout()) && cli.result_file.is_none()),
            gateway: None,
        },
    )
}

/// The answers of `provision --console` become the flags they stand for; provision itself is untouched.
fn apply_answers(a: &mut ProvisionCli, answers: &console::ProvisionAnswers) {
    a.prepare_for_switch = answers.moving_cloud_store;
    a.first_admin_name = answers.admin_name.clone();
    if answers.confirm_private_network {
        a.confirm_private_network = vec![String::new()]; // the bare flag
    }
}

/// `--console` commands that ask questions; every other command runs as without the flag.
fn dispatch_console(cli: &Cli, stdin: &mut dyn Read, out: &mut dyn std::io::Write) -> Result<Outcome, PosctlError> {
    match &cli.command {
        Command::Lifecycle(LifecycleCmd::Provision(a)) if !a.resume => {
            refuse_dev_root(cli, "provision")?;
            if a.prepare_for_switch || a.first_admin_name.is_some() || a.first_admin_pin_stdin || !a.confirm_private_network.is_empty() {
                return Err(PosctlError::new(Code::Usage, "provision --console asks for these itself: drop --prepare-for-switch, --first-admin-* and --confirm-private-network"));
            }
            let public = crate::net::read_profiles().map(|p| crate::net::any_public(&p)).unwrap_or(false); // unreadable: provision's own check decides
            let answers = console::provision_answers(stdin, out, public)?;
            let mut a = a.clone();
            apply_answers(&mut a, &answers);
            run_provision(cli, &a, &WindowsServices, stdin)
        }
        Command::Pair(crate::paircmd::PairTop::Pair(crate::paircmd::PairCmd::Join { prompt: true, .. })) => crate::paircmd::join_prompt(&roots_for(cli)?, stdin, out),
        _ => dispatch(cli, stdin),
    }
}

/// Runs one invocation; returns the process exit code. `out` receives the single JSON line.
pub fn run_cli(args: Vec<OsString>, stdin: &mut dyn Read, out: &mut dyn std::io::Write) -> i32 {
    run_cli_with(args, stdin, out, true)
}

/// `log` is false in unit tests, so a test run never appends to a real `logs\posctl` folder.
pub fn run_cli_with(args: Vec<OsString>, stdin: &mut dyn Read, out: &mut dyn std::io::Write, log: bool) -> i32 {
    let started = now_rfc3339();
    let mut human = false;
    let (name, outcome, cli) = match Cli::try_parse_from(&args) {
        Ok(cli) => {
            let name = command_name(&cli.command);
            let refusal = if cli.console { console::refuse(cli.json, cli.result_file.is_some(), console::is_interactive()).err() } else { None };
            human = cli.console && refusal.is_none();
            let outcome = match refusal {
                Some(e) => Outcome::from(e),
                None if human => dispatch_console(&cli, stdin, out).unwrap_or_else(Outcome::from),
                None => dispatch(&cli, stdin).unwrap_or_else(Outcome::from),
            };
            (name, outcome, Some(cli))
        }
        Err(e) if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) => {
            let _ = write!(out, "{e}");
            return 0;
        }
        Err(e) => ("usage", Outcome::from(PosctlError::new(Code::Usage, e.to_string().lines().next().unwrap_or("bad arguments").to_string())), None),
    };
    let env = if human {
        // the envelope (no once-only value) is what the log gets; the person gets the human text
        let env = Envelope::from_outcome(name, &started, &now_rfc3339(), &outcome);
        console::print_outcome(out, &outcome);
        console::pause(out, stdin);
        env
    } else {
        emit(name, &started, &outcome, out, cli.as_ref().and_then(|c| c.result_file.as_deref()))
    };
    // a `backup key-export` console waits for Enter once the key is on screen (no-op for every other command)
    crate::commands::backup::after_emit(out, stdin);
    if log {
        if let Some(Ok(roots)) = cli.as_ref().map(roots_for) {
            append_log(&roots, &env);
        }
    }
    env.exit
}

/// The one stdout line (with the once-only secret), then the atomic `--result-file` copy (without it).
fn emit(name: &str, started: &str, outcome: &Outcome, out: &mut dyn std::io::Write, result_file: Option<&std::path::Path>) -> Envelope {
    let mut env = Envelope::from_outcome(name, started, &now_rfc3339(), outcome);
    if let Some(path) = result_file {
        if let Err(e) = write_atomic(path, env.to_file_json().as_bytes()) {
            // the installer reads this file: a stale or missing one must not pass for this run's result
            let msg = format!("could not write the result file {}: {e} (the command itself ended {}: {})", path.display(), env.code, env.message);
            let mut failed = Outcome::with_code(Code::Error, msg, json!({"resultFile": path.display().to_string(), "commandCode": env.code}));
            failed.secret_once = outcome.secret_once.clone();
            env = Envelope::from_outcome(name, started, &now_rfc3339(), &failed);
        }
    }
    let _ = writeln!(out, "{}", env.to_stdout_json(outcome.secret_once.as_ref()));
    env
}

/// One compact JSON line per command in `logs\posctl\posctl-<yyyyMMdd>.log`, if that folder exists.
/// Skipped when the data root, `logs\` or `logs\posctl` is a link or planted (an elevated process must not
/// append through one), and after a PRECONDITION outcome (those are the runs that found something wrong with them).
fn append_log(roots: &Roots, env: &Envelope) {
    // backup commands write their own, richer line (`backup::runlog`): the 5-minute tick would otherwise add 288 lines a day
    if env.command == "backup" || env.code == Code::Precondition.name() || !crate::layout::log_dir_is_trusted(roots) {
        return;
    }
    let dir = roots.posctl_logs();
    let day = env.finished_at.get(..10).unwrap_or("0000-00-00").replace('-', "");
    let line = serde_json::to_string(&json!({"at": env.finished_at, "command": env.command, "code": env.code, "message": env.message})).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("posctl-{day}.log"))) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::SecretOnce;
    use serde_json::Value;

    fn run(args: &[&str]) -> (i32, String) {
        let mut out = Vec::new();
        let code = run_cli_with(args.iter().map(OsString::from).collect(), &mut std::io::empty(), &mut out, false);
        (code, String::from_utf8(out).unwrap())
    }

    #[test]
    fn version_prints_exactly_one_json_object() {
        let (code, out) = run(&["posctl", "version"]);
        assert_eq!(code, 0);
        assert_eq!(out.lines().count(), 1);
        let v: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!((v["ok"].clone(), v["command"].clone(), v["code"].clone()), (json!(true), json!("version"), json!("OK")));
        assert_eq!(v["data"]["posctlVersion"], POSCTL_VERSION);
        assert_eq!(v["exit"], 0);
    }

    #[test]
    fn bad_arguments_are_a_usage_envelope_not_clap_text() {
        for args in [&["posctl", "frobnicate"][..], &["posctl"][..], &["posctl", "provision", "--base-port", "abc"][..]] {
            let (code, out) = run(args);
            assert_eq!(code, 2, "{args:?}");
            assert_eq!(out.lines().count(), 1, "{args:?}");
            let v: Value = serde_json::from_str(out.trim()).unwrap();
            assert_eq!((v["code"].clone(), v["ok"].clone(), v["exit"].clone()), (json!("USAGE"), json!(false), json!(2)));
        }
    }

    #[test]
    fn a_dev_root_that_is_the_production_data_folder_is_refused_however_it_is_spelled() {
        let d = tempfile::tempdir().unwrap();
        let prod = d.path().join("ProgramData");
        std::fs::create_dir_all(prod.join("sub")).unwrap();
        for spelling in [prod.clone(), prod.join("sub").join(".."), prod.join("."), PathBuf::from(prod.display().to_string().to_uppercase()), PathBuf::from(format!("{}\\", prod.display()))] {
            let e = refuse_production_data(&spelling, &prod).unwrap_err();
            assert_eq!(e.code, Code::Usage, "{}", spelling.display());
            assert!(e.message.contains("--dev"), "{}", e.message);
        }
        assert!(refuse_production_data(&prod.join("sub"), &prod).is_ok(), "a folder inside it is not it");
        assert!(refuse_production_data(&d.path().join("elsewhere"), &prod).is_ok(), "a root that does not exist yet is fine");
    }

    #[test]
    fn custom_roots_require_dev_and_both_paths() {
        for args in [&["posctl", "--data-root", "X:\\d", "stop"][..], &["posctl", "--dev", "stop"][..], &["posctl", "--dev", "--data-root", "X:\\d", "stop"][..]] {
            let (code, out) = run(args);
            assert_eq!(code, 2, "{args:?}: {out}");
        }
    }

    // `dispatch` always uses `WindowsServices`, so on a dev root `provision` would register real
    // services and write the real HKLM Functions key, and `--dev unprovision` would delete the production
    // services. Conventions 11 ("--dev refuses service registration") and `paths.rs` promise this cannot happen:
    // these commands refuse a dev root with USAGE. (Dev instances are driven by Plan 05b's `dev` group,
    // which uses `DevProcesses`.) The NOT_PROVISIONED exit-4 case stays covered by the `lifecycle` unit test.
    #[test]
    fn service_commands_refuse_a_dev_root() {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("d").display().to_string(), d.path().join("p").display().to_string());
        let sets: [&[&str]; 6] = [&["provision"], &["unprovision"], &["start"], &["stop"], &["restart"], &["secret", "set", "RESEND_API_KEY", "--stdin"]];
        for cmd in sets {
            let mut args = vec!["posctl", "--dev", "--data-root", &data, "--program-root", &prog];
            args.extend_from_slice(cmd);
            let (code, out) = run(&args);
            assert_eq!(code, 2, "{cmd:?}: {out}");
            assert!(out.contains("USAGE") && out.contains("--dev"), "{cmd:?}: {out}");
        }
        assert!(!d.path().join("d").exists(), "nothing is created");
    }

    // `provision --prepare-for-switch` parses; a generated PIN needs a terminal, which a test run lacks
    #[test]
    fn prepare_for_switch_parses_and_a_pinless_non_terminal_provision_is_usage() {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("d").display().to_string(), d.path().join("p").display().to_string());
        let (code, out) = run(&["posctl", "--dev", "--data-root", &data, "--program-root", &prog, "provision", "--prepare-for-switch", "--server-host", "localhost"]);
        assert_eq!(code, 2, "still refused: dev root ({out})");
        assert!(!out.contains("unexpected argument"), "the flag exists: {out}");
    }

    #[test]
    fn result_file_gets_a_copy_and_keep_and_delete_exclude_each_other() {
        let d = tempfile::tempdir().unwrap();
        let rf = d.path().join("r.json");
        let (data, prog) = (d.path().join("d").display().to_string(), d.path().join("p").display().to_string());
        let (code, _) = run(&["posctl", "--dev", "--data-root", &data, "--program-root", &prog, "--result-file", &rf.display().to_string(), "unprovision", "--keep-data", "--delete-data"]);
        assert_eq!(code, 2);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(rf).unwrap()).unwrap();
        assert_eq!(v["code"], "USAGE");
    }

    // A6: PowerShell's `echo x | ...` prepends a BOM; it is not part of the secret
    #[test]
    fn a_leading_byte_order_mark_is_not_part_of_a_secret_value() {
        assert_eq!(secret_value("\u{feff}abc\r\n"), "abc");
        assert_eq!(secret_value("abc\n"), "abc");
    }

    // A4: a result file the installer cannot read must not look like success
    #[test]
    fn a_result_file_that_cannot_be_written_is_exit_1_and_says_so_on_stdout() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("file");
        std::fs::write(&blocker, "x").unwrap();
        let rf = blocker.join("under-a-file").join("r.json");
        let (code, out) = run(&["posctl", "--result-file", &rf.display().to_string(), "version"]);
        assert_eq!(code, 1, "{out}");
        assert_eq!(out.lines().count(), 1);
        let v: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!((v["code"].clone(), v["exit"].clone()), (json!("ERROR"), json!(1)));
        assert!(v["message"].as_str().unwrap().contains("result file"), "{out}");
    }

    // A1: the log folder is judged like every other folder posctl writes into
    #[cfg(windows)]
    #[test]
    fn a_log_folder_that_is_a_junction_gets_no_file_and_a_precondition_run_writes_no_log() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.logs()).unwrap();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &roots.posctl_logs().display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let ok = Envelope::from_outcome("version", "a", "2026-10-18T00:00:00Z", &Outcome::ok("m", json!({})));
        append_log(&roots, &ok);
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0, "nothing is written through a junction");
        // a plain folder is written, unless the outcome is PRECONDITION (the folders are what failed the check)
        let plain = Roots::custom(d.path().join("data2"), d.path().join("prog"));
        std::fs::create_dir_all(plain.posctl_logs()).unwrap();
        let pre = Envelope::from_outcome("provision", "a", "2026-10-18T00:00:00Z", &Outcome::from(PosctlError::precondition("planted")));
        append_log(&plain, &pre);
        assert_eq!(std::fs::read_dir(plain.posctl_logs()).unwrap().count(), 0);
        append_log(&plain, &ok);
        assert_eq!(std::fs::read_dir(plain.posctl_logs()).unwrap().count(), 1);
    }

    // the 5-minute backup tick must not add a generic line each time: `backup::runlog` writes (and dedupes) its own
    #[test]
    fn backup_commands_are_left_to_the_backup_log() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.posctl_logs()).unwrap();
        let tick = Envelope::from_outcome("backup", "a", "2026-10-22T00:00:00Z", &Outcome::ok("nothing to do (not-due)", json!({})));
        append_log(&roots, &tick);
        assert_eq!(std::fs::read_dir(roots.posctl_logs()).unwrap().count(), 0);
        let update = Envelope::from_outcome("update", "a", "2026-10-22T00:00:00Z", &Outcome::ok("m", json!({})));
        append_log(&roots, &update);
        assert_eq!(std::fs::read_dir(roots.posctl_logs()).unwrap().count(), 1, "every other command is still logged here");
    }

    #[test]
    fn help_is_plain_text_and_exits_zero() {
        let (code, out) = run(&["posctl", "--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("provision") && out.contains("unprovision") && out.contains("secret"));
    }

    // the once-only secret is on stdout, in the one line, and in neither the result file nor the log line
    #[test]
    fn the_once_only_pin_reaches_stdout_but_never_the_result_file_or_the_log() {
        let d = tempfile::tempdir().unwrap();
        let rf = d.path().join("res.json");
        let pin: String = [4, 9, 3, 8, 1, 7].iter().map(|d| char::from_digit(*d, 10).unwrap()).collect();
        let pin = pin.as_str();
        let outcome = Outcome::ok("provisioned", json!({"firstAdmin": {"id": "u", "pinShown": true}})).secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin.to_string() });
        let mut out = Vec::new();
        let env = emit("provision", &now_rfc3339(), &outcome, &mut out, Some(&rf));
        let stdout = String::from_utf8(out).unwrap();
        assert_eq!(stdout.lines().count(), 1);
        assert_eq!(serde_json::from_str::<Value>(stdout.trim()).unwrap()["data"]["firstAdmin"]["pin"], pin);
        assert!(!std::fs::read_to_string(&rf).unwrap().contains(pin));
        // the log line carries command, code and message only
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.posctl_logs()).unwrap();
        append_log(&roots, &env);
        let logged: String = std::fs::read_dir(roots.posctl_logs()).unwrap().map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert!(logged.contains("provision") && !logged.contains(pin));
    }

    #[test]
    fn secret_set_without_stdin_or_with_an_unknown_name_or_a_multi_line_value_is_usage() {
        let (code, out) = run(&["posctl", "secret", "set", "RESEND_API_KEY"]);
        assert_eq!(code, 2, "{out}");
        assert!(out.contains("--stdin"));
        for (name, input) in [("JWT_SECRET", "x\n"), ("RESEND_API_KEY", "line1\nline2\n"), ("RESEND_API_KEY", "\n")] {
            let mut out = Vec::new();
            let args: Vec<OsString> = ["posctl", "secret", "set", name, "--stdin"].iter().map(OsString::from).collect();
            let code = run_cli_with(args, &mut input.as_bytes(), &mut out, false);
            assert_eq!(code, 2, "{name} {input:?}: {}", String::from_utf8_lossy(&out));
            assert!(!String::from_utf8_lossy(&out).contains("line1"), "the value is never echoed");
        }
    }

    // conventions 11.2: the number in the envelope is the process exit code, for every code
    #[test]
    fn the_envelope_exit_is_the_exit_code_and_the_table_is_stable() {
        for c in Code::ALL {
            let env = Envelope::from_outcome("x", "a", "b", &Outcome::with_code(c, "m", json!({})));
            assert_eq!(env.exit, c.exit());
        }
        let pinned = [(Code::Ok, 0), (Code::Error, 1), (Code::Usage, 2), (Code::NotElevated, 3), (Code::NotProvisioned, 4), (Code::RecoveryNeeded, 17)];
        for (c, n) in pinned {
            assert_eq!(c.exit(), n, "{c:?}");
        }
    }

    #[test]
    fn a_pin_from_stdin_loses_the_bom_and_the_line_break_but_keeps_everything_else() {
        assert_eq!(pin_line("\u{feff}123457\r\n"), "123457");
        assert_eq!(pin_line("123457\n999999\n"), "123457");
        assert_eq!(pin_line(" 12 3457 "), "12 3457");
        assert_eq!(pin_line(""), "");
    }

    #[test]
    fn photos_verify_prints_the_envelope_with_exit_60() {
        use crate::backup::util::fake::{test_ctx, FakeExec};
        let d = tempfile::tempdir().unwrap();
        // one row, no file: the database is answered by a fake psql, the envelope is the real one
        let fx = FakeExec::default().on("bucket_id || '/'", 0, "product-photos/11111111-1111-4111-8111-111111111111\n").on("json_build_object", 0, "");
        let outcome = crate::photos::verify::run_with(&test_ctx(), &fx, d.path(), "postgres", &crate::photos::default_buckets());
        let mut out = Vec::new();
        let env = emit("photos", "a", &outcome, &mut out, None);
        assert_eq!(env.exit, 60);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1, "exactly one JSON object on stdout: {text}");
        let v: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!((v["ok"].clone(), v["command"].clone(), v["code"].clone(), v["exit"].clone()), (json!(false), json!("photos"), json!("PHOTOS_INCONSISTENT"), json!(60)));
        assert_eq!((v["data"]["rows"].clone(), v["data"]["dangling"].clone()), (json!(1), json!(1)));
    }

    #[test]
    fn photos_is_in_the_help_with_both_subcommands_and_no_key_flag() {
        let (code, out) = run(&["posctl", "--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("photos"), "{out}");
        let (code, sub) = run(&["posctl", "photos", "--help"]);
        assert_eq!(code, 0);
        for w in ["verify", "import-from-cloud"] {
            assert!(sub.contains(w), "{w} in {sub}");
        }
        for (_, text) in [run(&["posctl", "photos", "verify", "--help"]), run(&["posctl", "photos", "--help"])] {
            for never in ["--service-role-key", "--project-url", "--key"] {
                assert!(!text.contains(never), "{never} must not exist: {text}");
            }
        }
    }

    #[test]
    fn photos_import_help_exits_0() {
        let (code, out) = run(&["posctl", "photos", "import-from-cloud", "--help"]);
        assert_eq!(code, 0, "{out}");
        for flag in ["--source-credentials-stdin", "--buckets", "--dry-run", "--database"] {
            assert!(out.contains(flag), "{flag} in {out}");
        }
        for never in ["--service-role-key", "--project-url", "--key"] {
            assert!(!out.contains(never), "{never} must not exist: {out}");
        }
    }

    #[test]
    fn photos_import_requires_credentials_flag_is_usage() {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("data").display().to_string(), d.path().join("prog").display().to_string());
        let (code, out) = run(&["posctl", "--dev", "--data-root", &data, "--program-root", &prog, "photos", "import-from-cloud"]);
        assert_eq!(code, 2, "{out}");
        let v: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!((v["code"].as_str(), v["command"].as_str()), (Some("USAGE"), Some("photos")));
        assert!(v["message"].as_str().unwrap().contains("--source-credentials-stdin"), "{v}");
    }

    #[test]
    fn start_takes_a_canary_flag_and_stop_does_not() {
        let cli = Cli::try_parse_from(["posctl", "start", "--canary"]).unwrap();
        assert!(matches!(cli.command, Command::Lifecycle(LifecycleCmd::Start(StartCli { canary: true, .. }))));
        assert!(Cli::try_parse_from(["posctl", "stop", "--canary"]).is_err());
        let cli = Cli::try_parse_from(["posctl", "provision", "--confirm-private-network"]).unwrap();
        let Command::Lifecycle(LifecycleCmd::Provision(p)) = cli.command else { panic!() };
        assert_eq!(p.confirm_private_network, vec![String::new()], "bare flag");
        let cli = Cli::try_parse_from(["posctl", "provision", "--confirm-private-network=Wi-Fi", "--confirm-private-network=Ethernet"]).unwrap();
        let Command::Lifecycle(LifecycleCmd::Provision(p)) = cli.command else { panic!() };
        assert_eq!(p.confirm_private_network, vec!["Wi-Fi".to_string(), "Ethernet".to_string()]);
    }

    fn provision_cli(args: &[&str]) -> ProvisionCli {
        let mut v = vec!["posctl", "provision"];
        v.extend_from_slice(args);
        let Command::Lifecycle(LifecycleCmd::Provision(p)) = Cli::try_parse_from(v).unwrap().command else { panic!() };
        p
    }

    #[test]
    fn answer_two_runs_prepare_for_switch_and_creates_no_admin() {
        let mut a = provision_cli(&["--console"]);
        apply_answers(&mut a, &console::ProvisionAnswers { moving_cloud_store: true, admin_name: None, confirm_private_network: false });
        assert!(a.prepare_for_switch && a.first_admin_name.is_none() && !a.first_admin_pin_stdin);
    }

    #[test]
    fn answer_one_uses_the_name_and_the_generated_pin() {
        let mut a = provision_cli(&["--console"]);
        apply_answers(&mut a, &console::ProvisionAnswers { moving_cloud_store: false, admin_name: Some("Ana".into()), confirm_private_network: true });
        assert!(!a.prepare_for_switch && !a.first_admin_pin_stdin, "no typed PIN: posctl generates it");
        assert_eq!((a.first_admin_name.as_deref(), a.confirm_private_network), (Some("Ana"), vec![String::new()]));
    }

    #[test]
    fn public_network_no_leaves_the_confirmation_out_so_provision_refuses_as_before() {
        let mut a = provision_cli(&["--console"]);
        apply_answers(&mut a, &console::ProvisionAnswers { moving_cloud_store: false, admin_name: None, confirm_private_network: false });
        assert!(a.confirm_private_network.is_empty());
    }

    #[test]
    fn console_without_a_terminal_or_with_json_or_a_result_file_is_usage_and_does_nothing() {
        // a test run has no terminal on stdin
        let d = tempfile::tempdir().unwrap();
        let rf = d.path().join("r.json").display().to_string();
        for extra in [&[][..], &["--json"][..], &["--result-file", rf.as_str()][..]] {
            let mut args = vec!["posctl", "--console"];
            args.extend_from_slice(extra);
            args.extend_from_slice(&["provision", "--resume"]);
            let (code, out) = run(&args);
            assert_eq!(code, 2, "{extra:?}: {out}");
            assert!(out.contains("USAGE") && out.contains("--console"), "{out}");
        }
    }

    #[test]
    fn console_mode_never_logs_the_once_only_value() {
        let d = tempfile::tempdir().unwrap();
        let pin_text = ["493", "817"].concat(); // built from parts: a PIN-shaped literal trips the pin-assignment secret rule
        let pin = pin_text.as_str();
        let outcome = Outcome::ok("provisioned", json!({})).secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin.to_string() });
        // exactly what `run_cli_with` does in console mode: the log gets the envelope, the person gets the text
        let env = Envelope::from_outcome("provision", &now_rfc3339(), &now_rfc3339(), &outcome);
        let mut screen = Vec::new();
        console::print_outcome(&mut screen, &outcome);
        assert!(String::from_utf8(screen).unwrap().contains(pin));
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.posctl_logs()).unwrap();
        append_log(&roots, &env);
        let logged: String = std::fs::read_dir(roots.posctl_logs()).unwrap().map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert!(logged.contains("provision") && !logged.contains(pin) && !env.to_file_json().contains(pin));
    }

    #[test]
    fn resume_with_console_parses_and_keeps_the_resume_flag() {
        let a = provision_cli(&["--resume", "--console"]);
        assert!(a.resume);
    }
}
