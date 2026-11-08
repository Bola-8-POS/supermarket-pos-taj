//! Arguments of `posctl backup ...`. One clap grammar serves both the real command line (flattened into `cli::Command`,
//! so the global flags `--json`, `--result-file`, `--dev`, ... work after the subcommand, which Plan 11's elevated runs
//! rely on) and `parse`, the pure entry the tests use.
//!
//! No flag takes a key, a password or a PIN: a recovery key is only ever read from stdin (`--key-stdin`).
use clap::{Args, Parser, Subcommand};

use super::config::valid_dest_name;
use super::policy::Reason;

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Run { reason: Reason, dest: Option<String>, scheduled: bool },
    List,
    /// `scheduled` is what the BackupVerify task passes: due-based, and a held lock is a quiet skip.
    Verify { read_data: bool, scheduled: bool },
    Restore { snapshot: String, swap: bool, repo: Option<String>, key_stdin: bool },
    Drill { scheduled: bool },
    KeyExport { rotate: bool },
    DestCandidates,
    DestList,
    DestCheck { name: Option<String> },
    DestRemove { name: String },
    DestAddDevice { name: Option<String>, path: String, allow_fixed: bool, key_stdin: bool },
    DestAddR2 { name: Option<String>, repo: String, key_stdin: bool },
}

impl Cmd {
    /// The words of the command, for the log (`backup run`, `backup dest add`, ...): fixed text, never an argument value.
    pub fn word(&self) -> &'static str {
        match self {
            Cmd::Run { .. } => "backup run",
            Cmd::List => "backup list",
            Cmd::Verify { .. } => "backup verify",
            Cmd::Restore { .. } => "backup restore",
            Cmd::Drill { .. } => "backup drill",
            Cmd::KeyExport { .. } => "backup key-export",
            Cmd::DestCandidates => "backup dest candidates",
            Cmd::DestList => "backup dest list",
            Cmd::DestCheck { .. } => "backup dest check",
            Cmd::DestRemove { .. } => "backup dest remove",
            Cmd::DestAddDevice { .. } | Cmd::DestAddR2 { .. } => "backup dest add",
        }
    }

    /// Everything but the drive picker reads the machine key or the configuration, which only SYSTEM and Administrators may open.
    /// No `_` arm: a new command has to decide.
    pub fn needs_admin(&self) -> bool {
        match self {
            Cmd::DestCandidates => false,
            Cmd::Run { .. } | Cmd::List | Cmd::Verify { .. } | Cmd::Restore { .. } | Cmd::Drill { .. } | Cmd::KeyExport { .. } | Cmd::DestList | Cmd::DestCheck { .. } | Cmd::DestRemove { .. } | Cmd::DestAddDevice { .. } | Cmd::DestAddR2 { .. } => true,
        }
    }

    /// Whether the command reads the owner's recovery key from stdin.
    pub fn reads_stdin(&self) -> bool {
        matches!(self, Cmd::Restore { key_stdin: true, .. } | Cmd::DestAddDevice { key_stdin: true, .. } | Cmd::DestAddR2 { key_stdin: true, .. })
    }
}

/// Flattened into `cli::Command`, so the words are `posctl backup ...`.
#[derive(Subcommand, Debug)]
pub enum BackupTop {
    /// Encrypted backups of the store, restore, restore drill and backup destinations.
    Backup(BackupArgs),
}

#[derive(Args, Debug, Clone)]
pub struct BackupArgs {
    #[command(subcommand)]
    pub sub: Sub,
}

#[derive(Subcommand, Debug, Clone)]
pub enum Sub {
    /// Take a backup now, or (with --scheduled, from the 5-minute task) whatever is due.
    Run {
        /// hourly | caja-close | pre-update | pre-switch | manual
        #[arg(long)]
        reason: String,
        /// Copy only to this destination.
        #[arg(long)]
        dest: Option<String>,
        /// Passed by the Backup task and by nothing a person types.
        #[arg(long, hide = true)]
        scheduled: bool,
    },
    /// The snapshots, newest first, and where each one is held.
    List,
    /// Check every connected backup copy; --read-data reads every byte.
    Verify {
        #[arg(long)]
        read_data: bool,
        #[arg(long, hide = true)]
        scheduled: bool,
    },
    /// Restore into a scratch database and prove it (nothing replaced), or with --swap replace the store's database.
    Restore {
        #[arg(long)]
        snapshot: String,
        #[arg(long)]
        swap: bool,
        /// A backup copy to restore from: a folder, or an s3: repository.
        #[arg(long)]
        repo: Option<String>,
        /// Read the owner's recovery key (one line) from stdin.
        #[arg(long)]
        key_stdin: bool,
    },
    /// Restore the newest backup into a scratch database, compare it, drop it.
    Drill {
        #[arg(long, hide = true)]
        scheduled: bool,
    },
    /// Issue the owner's recovery key (shown once, on this console).
    KeyExport {
        #[arg(long)]
        rotate: bool,
    },
    /// Backup destinations: a USB or second drive, or R2.
    Dest {
        #[command(subcommand)]
        cmd: DestSub,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub enum DestSub {
    /// Drives the owner could choose.
    Candidates,
    List,
    Check {
        #[arg(long)]
        name: Option<String>,
    },
    Remove {
        #[arg(long)]
        name: String,
    },
    Add {
        /// device | r2
        #[arg(long)]
        kind: String,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        repo: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        allow_fixed: bool,
        /// Read the owner's recovery key (one line) from stdin; needed once a recovery key has been issued.
        #[arg(long)]
        key_stdin: bool,
    },
}

fn name_ok(n: &Option<String>) -> Result<(), String> {
    match n {
        Some(n) if !valid_dest_name(n) => Err("a destination name is 1-32 lowercase letters, digits or dashes, and not 'local'".into()),
        _ => Ok(()),
    }
}

impl BackupArgs {
    pub fn to_cmd(&self) -> Result<Cmd, String> {
        self.sub.clone().into_cmd()
    }
}

impl Sub {
    pub fn into_cmd(self) -> Result<Cmd, String> {
        Ok(match self {
            Sub::Run { reason, dest, scheduled } => {
                let reason = Reason::parse(&reason).filter(|r| *r != Reason::PreRestore).ok_or_else(|| format!("unknown reason '{reason}': use hourly, caja-close, pre-update, pre-switch or manual"))?;
                if scheduled && reason != Reason::Hourly {
                    return Err("--scheduled is only for --reason hourly".into());
                }
                name_ok(&dest)?;
                Cmd::Run { reason, dest, scheduled }
            }
            Sub::List => Cmd::List,
            Sub::Verify { read_data, scheduled } => Cmd::Verify { read_data, scheduled },
            Sub::Restore { snapshot, swap, repo, key_stdin } => Cmd::Restore { snapshot, swap, repo, key_stdin },
            Sub::Drill { scheduled } => Cmd::Drill { scheduled },
            Sub::KeyExport { rotate } => Cmd::KeyExport { rotate },
            Sub::Dest { cmd } => match cmd {
                DestSub::Candidates => Cmd::DestCandidates,
                DestSub::List => Cmd::DestList,
                DestSub::Check { name } => {
                    name_ok(&name)?;
                    Cmd::DestCheck { name }
                }
                DestSub::Remove { name } => {
                    name_ok(&Some(name.clone()))?;
                    Cmd::DestRemove { name }
                }
                DestSub::Add { kind, path, repo, name, allow_fixed, key_stdin } => {
                    name_ok(&name)?;
                    match kind.as_str() {
                        "device" => {
                            if repo.is_some() {
                                return Err("--repo is for --kind r2".into());
                            }
                            Cmd::DestAddDevice { name, path: path.ok_or("dest add --kind device needs --path")?, allow_fixed, key_stdin }
                        }
                        "r2" => {
                            if path.is_some() || allow_fixed {
                                return Err("--path and --allow-fixed are for --kind device".into());
                            }
                            Cmd::DestAddR2 { name, repo: repo.ok_or("dest add --kind r2 needs --repo")?, key_stdin }
                        }
                        _ => return Err("dest add needs --kind device|r2".into()),
                    }
                }
            },
        })
    }
}

#[derive(Parser, Debug)]
#[command(name = "backup", disable_help_subcommand = true)]
struct Standalone {
    #[command(subcommand)]
    sub: Sub,
}

/// The words after `backup`, as the tests and any script-side check see them. The first line of clap's message only.
pub fn parse(args: &[String]) -> Result<Cmd, String> {
    let all = std::iter::once("backup".to_string()).chain(args.iter().cloned());
    let p = Standalone::try_parse_from(all).map_err(|e| e.to_string().lines().next().unwrap_or("bad arguments").trim_start_matches("error: ").to_string())?;
    p.sub.into_cmd()
}

/// Every command line that needs an Administrator, for the tests of both places that check it (`commands::backup::precheck`, `cli::dispatch`).
#[cfg(test)]
pub(crate) const ADMIN_COMMAND_LINES: &[&str] = &[
    "run --reason manual",
    "list",
    "verify",
    "drill",
    "restore --snapshot latest",
    "restore --snapshot latest --swap",
    "key-export",
    "dest list",
    "dest check",
    "dest remove --name x",
    "dest add --kind device --path E:\\",
    "dest add --kind r2 --repo s3:https://x/b",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::policy::Reason;

    fn a(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn run_needs_a_known_reason_and_accepts_the_scheduled_flag() {
        assert_eq!(parse(&a("run --reason manual")).unwrap(), Cmd::Run { reason: Reason::Manual, dest: None, scheduled: false });
        assert_eq!(parse(&a("run --reason hourly --scheduled")).unwrap(), Cmd::Run { reason: Reason::Hourly, dest: None, scheduled: true });
        assert_eq!(parse(&a("run --reason caja-close --dest usb-e")).unwrap(), Cmd::Run { reason: Reason::CajaClose, dest: Some("usb-e".into()), scheduled: false });
        assert!(parse(&a("run")).is_err());
        assert!(parse(&a("run --reason nightly")).is_err());
        assert!(parse(&a("run --reason pre-restore")).is_err(), "pre-restore is internal");
        assert!(parse(&a("run --reason manual --scheduled")).is_err(), "scheduled means the hourly tick");
        assert!(parse(&a("run --reason manual --dest Bad_Name")).is_err(), "a destination name is checked at the door");
    }

    #[test]
    fn restore_needs_a_snapshot_and_the_swap_is_explicit() {
        assert_eq!(parse(&a("restore --snapshot latest --swap")).unwrap(), Cmd::Restore { snapshot: "latest".into(), swap: true, repo: None, key_stdin: false });
        assert_eq!(parse(&a("restore --snapshot aaaa1111 --repo E:\\b --key-stdin")).unwrap(), Cmd::Restore { snapshot: "aaaa1111".into(), swap: false, repo: Some("E:\\b".into()), key_stdin: true });
        assert!(parse(&a("restore --swap")).is_err());
    }

    #[test]
    fn dest_subcommands_and_their_required_flags() {
        assert_eq!(parse(&a("dest list")).unwrap(), Cmd::DestList);
        assert_eq!(parse(&a("dest candidates")).unwrap(), Cmd::DestCandidates);
        assert_eq!(parse(&a("dest check")).unwrap(), Cmd::DestCheck { name: None });
        assert_eq!(parse(&a("dest check --name usb-e")).unwrap(), Cmd::DestCheck { name: Some("usb-e".into()) });
        assert_eq!(parse(&a("dest remove --name usb-e")).unwrap(), Cmd::DestRemove { name: "usb-e".into() });
        assert_eq!(parse(&a("dest add --kind device --path E:\\ --allow-fixed")).unwrap(), Cmd::DestAddDevice { name: None, path: "E:\\".into(), allow_fixed: true, key_stdin: false });
        assert_eq!(parse(&a("dest add --kind device --path E:\\ --key-stdin --name usb-e")).unwrap(), Cmd::DestAddDevice { name: Some("usb-e".into()), path: "E:\\".into(), allow_fixed: false, key_stdin: true });
        assert_eq!(parse(&a("dest add --kind r2 --repo s3:https://x/b --name r2")).unwrap(), Cmd::DestAddR2 { name: Some("r2".into()), repo: "s3:https://x/b".into(), key_stdin: false });
        assert_eq!(parse(&a("dest add --kind r2 --repo s3:https://x/b --key-stdin")).unwrap(), Cmd::DestAddR2 { name: None, repo: "s3:https://x/b".into(), key_stdin: true });
        assert!(parse(&a("dest add --kind device")).is_err());
        assert!(parse(&a("dest add --kind r2")).is_err());
        assert!(parse(&a("dest add --kind tape --path x")).is_err());
        assert!(parse(&a("dest add --kind device --path E:\\ --repo s3:x")).is_err(), "a device has no repo url");
        assert!(parse(&a("dest add --kind r2 --repo s3:x --path E:\\")).is_err(), "an r2 repository has no drive path");
        assert!(parse(&a("dest add --kind device --path E:\\ --name Bad_Name")).is_err());
        assert!(parse(&a("dest remove")).is_err());
        assert!(parse(&a("dest remove --name Bad_Name")).is_err(), "names are checked at the door");
        assert!(parse(&a("dest check --name ../x")).is_err());
        assert!(parse(&a("dest check --name local")).is_err());
        assert!(parse(&a("dest")).is_err());
    }

    #[test]
    fn simple_commands_and_unknown_things_are_usage_errors() {
        assert_eq!(parse(&a("list")).unwrap(), Cmd::List);
        assert_eq!(parse(&a("drill")).unwrap(), Cmd::Drill { scheduled: false });
        assert_eq!(parse(&a("drill --scheduled")).unwrap(), Cmd::Drill { scheduled: true });
        assert_eq!(parse(&a("verify")).unwrap(), Cmd::Verify { read_data: false, scheduled: false });
        assert_eq!(parse(&a("verify --read-data")).unwrap(), Cmd::Verify { read_data: true, scheduled: false });
        assert_eq!(parse(&a("verify --read-data --scheduled")).unwrap(), Cmd::Verify { read_data: true, scheduled: true });
        assert_eq!(parse(&a("key-export")).unwrap(), Cmd::KeyExport { rotate: false });
        assert_eq!(parse(&a("key-export --rotate")).unwrap(), Cmd::KeyExport { rotate: true });
        assert!(parse(&a("")).is_err());
        assert!(parse(&a("frobnicate")).is_err());
        assert!(parse(&a("list --bogus")).is_err());
        assert!(parse(&a("verify --read-data --force")).is_err());
    }

    /// A recovery key reaches posctl on stdin only: an argument would sit in the process list and in the task history.
    #[test]
    fn no_flag_takes_a_key_a_password_or_a_pin() {
        for bad in ["restore --snapshot latest --key abcde", "restore --snapshot latest --recovery-key abcde", "dest add --kind device --path E:\\ --recovery-key abcde", "dest add --kind r2 --repo s3:x --password abcde", "key-export --pin 123456"] {
            assert!(parse(&a(bad)).is_err(), "{bad}");
        }
        use clap::CommandFactory;
        let mut names = Vec::new();
        fn walk(c: &clap::Command, names: &mut Vec<String>) {
            names.extend(c.get_arguments().map(|a| a.get_id().to_string()));
            c.get_subcommands().for_each(|s| walk(s, names));
        }
        walk(&Standalone::command(), &mut names);
        assert!(names.iter().all(|n| !["key", "password", "pin", "secret", "recovery_key", "token"].contains(&n.as_str())), "{names:?}");
    }

    #[test]
    fn the_log_word_names_the_command_and_nothing_the_person_typed() {
        for (cmd, word) in [("run --reason manual", "backup run"), ("list", "backup list"), ("verify", "backup verify"), ("restore --snapshot latest --repo s3:https://h.example/b/secret-folder", "backup restore"), ("drill", "backup drill"), ("key-export", "backup key-export"), ("dest list", "backup dest list"), ("dest add --kind r2 --repo s3:https://x/b", "backup dest add"), ("dest remove --name x", "backup dest remove")] {
            assert_eq!(parse(&a(cmd)).unwrap().word(), word, "{cmd}");
        }
    }

    #[test]
    fn only_a_stdin_key_flag_makes_a_command_read_stdin() {
        assert!(parse(&a("restore --snapshot latest --key-stdin")).unwrap().reads_stdin());
        assert!(parse(&a("dest add --kind device --path E:\\ --key-stdin")).unwrap().reads_stdin());
        assert!(parse(&a("dest add --kind r2 --repo s3:x --key-stdin")).unwrap().reads_stdin());
        for quiet in ["restore --snapshot latest", "key-export", "run --reason manual", "dest add --kind device --path E:\\", "verify"] {
            assert!(!parse(&a(quiet)).unwrap().reads_stdin(), "{quiet}");
        }
    }
}
