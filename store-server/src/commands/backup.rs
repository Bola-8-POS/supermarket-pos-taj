//! `posctl backup ...`: the thin adapter between the command line and `backup::cli`. It builds the machine's `Env` and the
//! backup context the way `commands::update` does, reads the recovery key from stdin only when `--key-stdin` was given, turns the
//! result into the one JSON envelope, and writes the backup log line (`backup::runlog`).
//!
//! A scheduled run that has nothing to do, or finds the lock busy, is `ok` (exit 0). A failure is its own code: BACKUP_FAILED 30,
//! RESTORE_FAILED 31, LOCK_HELD 10, PRECONDITION 12, RECOVERY_NEEDED 17, NOT_ELEVATED 3, NOT_PROVISIONED 4, USAGE 2.
use std::cell::Cell;
use std::io::{IsTerminal, Read, Write};
use std::rc::Rc;

use crate::backup::args::{BackupArgs, Cmd};
use crate::backup::cli::{dispatch, Done, Invocation};
use crate::backup::{plan08_backup::ctx_from_env, runlog, Deps};
use crate::envelope::{Code, Outcome, PosctlError, SecretOnce};
use crate::paths::Roots;
use crate::update::Env;

thread_local! {
    /// Set by `to_outcome` for a `key-export` on a console; `after_emit` waits for Enter once the envelope is printed.
    static PAUSE: Cell<bool> = const { Cell::new(false) };
}

/// The recovery key is a one-time secret: `SecretOnce` puts it on stdout (`data.recovery.key`) and keeps it out of the result file
/// and the posctl log.
pub fn to_outcome(d: Done) -> Outcome {
    PAUSE.set(d.pause_after_print);
    let o = Outcome::ok(d.message, d.data);
    match d.secret {
        Some(value) => o.secret_once(SecretOnce { section: "recovery", field: "key", value }),
        None => o,
    }
}

/// After the envelope is printed: a `key-export` console waits for Enter, so an elevated window does not close with the key on it.
/// The prompt goes to stderr (stdout carries exactly one JSON object).
pub fn after_emit(out: &mut dyn Write, stdin: &mut dyn Read) {
    if PAUSE.replace(false) {
        let _ = out.flush();
        eprintln!("Press Enter to close this window.");
        wait_for_enter(stdin);
    }
}

/// Reads up to and including the next line break (or the end of the input), nothing more.
pub fn wait_for_enter(stdin: &mut dyn Read) {
    let mut b = [0u8; 1];
    while matches!(stdin.read(&mut b), Ok(1)) && b[0] != b'\n' {}
}

/// Before anything is read: who may run this, then whether the PC is provisioned. A standard user cannot see ProgramData, so the
/// provisioned file always looks missing to them: the elevation answer has to come first or they would be told NOT_PROVISIONED.
/// `dest candidates` (the drive picker) is the one command open to a standard user.
fn precheck(roots: &Roots, cmd: &Cmd, elevated: bool) -> Result<(), PosctlError> {
    if cmd.needs_admin() && !(roots.dev || elevated) {
        return Err(crate::backup::result::BackupError::not_elevated().into());
    }
    if !roots.provisioned_json().exists() {
        return Err(PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"));
    }
    Ok(())
}

pub fn run_cli(roots: &Roots, a: &BackupArgs, result_file: bool, stdin: &mut dyn Read) -> Result<Outcome, PosctlError> {
    let cmd = a.to_cmd().map_err(|m| PosctlError::new(Code::Usage, m))?;
    // before anything else: this key is shown on a console and never lands in a file
    if result_file && matches!(cmd, Cmd::KeyExport { .. }) {
        return Err(PosctlError::new(Code::Usage, "the recovery key is shown once on the console; it is never written to a result file"));
    }
    // the drive picker reads nothing under ProgramData and is open to a standard user: no provisioned check, no log line
    if matches!(cmd, Cmd::DestCandidates) {
        return crate::backup::cli::dest_candidates().map(to_outcome).map_err(PosctlError::from);
    }
    let elevated = crate::sys::is_elevated(); // asked once: the precheck and the dispatch must agree
    precheck(roots, &cmd, elevated)?;
    let env = Env::production(roots, Rc::new(crate::runtime::WindowsServices))?;
    let pack = crate::config::PosctlJson::load(roots).map_err(PosctlError::error)?.map(|c| c.pack.current).ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
    let ctx = ctx_from_env(&env, &pack);
    // the key: one line of stdin, only when asked for, never an argument
    let key_line = if cmd.reads_stdin() { crate::cli::pin_line(&crate::cli::read_stdin_text(stdin, 1024)?) } else { String::new() };
    let read = move || key_line.clone();
    let inv = Invocation {
        elevated: roots.dev || elevated,
        result_file,
        interactive: std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        stdout_console: std::io::stdout().is_terminal(),
        read_stdin: &read,
    };
    let word = cmd.word();
    let res = dispatch(&ctx, &env, &Deps::real(), cmd, &inv);
    let at = crate::util::now_rfc3339();
    match &res {
        Ok(d) => runlog::write(roots, word, &at, "OK", &d.message, &d.data),
        Err(e) => runlog::write(roots, word, &at, e.code.name(), &e.message, &serde_json::Value::Null),
    }
    res.map(to_outcome).map_err(PosctlError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::run_cli_with;
    use serde_json::{json, Value};
    use std::ffi::OsString;

    fn run(args: &[&str]) -> (i32, String) {
        let mut out = Vec::new();
        let code = run_cli_with(args.iter().map(OsString::from).collect(), &mut std::io::empty(), &mut out, false);
        (code, String::from_utf8(out).unwrap())
    }

    fn dev(d: &tempfile::TempDir) -> Vec<String> {
        vec!["posctl".into(), "--dev".into(), "--data-root".into(), d.path().join("data").display().to_string(), "--program-root".into(), d.path().join("prog").display().to_string()]
    }

    fn run_dev(d: &tempfile::TempDir, rest: &[&str]) -> (i32, Value) {
        let mut args = dev(d);
        args.extend(rest.iter().map(|s| s.to_string()));
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, out) = run(&refs);
        assert_eq!(out.lines().count(), 1, "exactly one JSON object on stdout: {out}");
        (code, serde_json::from_str(out.trim()).unwrap())
    }

    #[test]
    fn an_unprovisioned_pc_is_exit_4_and_a_bad_command_is_exit_2() {
        let d = tempfile::tempdir().unwrap();
        let (code, v) = run_dev(&d, &["backup", "run", "--reason", "manual", "--json"]);
        assert_eq!((code, v["code"].as_str(), v["ok"].as_bool()), (4, Some("NOT_PROVISIONED"), Some(false)));
        for bad in [&["backup", "run", "--reason", "bogus"][..], &["backup", "run"][..], &["backup"][..], &["backup", "frobnicate"][..], &["backup", "dest", "add", "--kind", "tape"][..]] {
            let (code, v) = run_dev(&d, bad);
            assert_eq!((code, v["code"].as_str()), (2, Some("USAGE")), "{bad:?}");
        }
    }

    #[test]
    fn the_global_flags_work_after_the_backup_subcommand() {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("data").display().to_string(), d.path().join("prog").display().to_string());
        let (code, out) = run(&["posctl", "backup", "list", "--json", "--dev", "--data-root", &data, "--program-root", &prog, "--quiet"]);
        assert_eq!(code, 4, "{out}");
        assert!(out.contains("NOT_PROVISIONED"), "{out}");
    }

    #[test]
    fn the_recovery_key_console_refuses_a_result_file_before_anything_else() {
        let d = tempfile::tempdir().unwrap();
        let rf = d.path().join("r.json");
        let (code, v) = run_dev(&d, &["backup", "key-export", "--result-file", &rf.display().to_string()]);
        assert_eq!((code, v["code"].as_str()), (2, Some("USAGE")));
        assert!(v["message"].as_str().unwrap().contains("result file"), "{v}");
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&rf).unwrap()).unwrap();
        assert_eq!(file["code"], "USAGE");
    }

    #[test]
    fn the_key_is_on_stdout_once_and_in_neither_the_result_file_nor_the_log_line() {
        let d = tempfile::tempdir().unwrap();
        let key = crate::backup::keys::new_recovery_key().unwrap();
        let o = to_outcome(Done { message: "m".into(), data: json!({ "issuedAt": "x" }), secret: Some(key.clone()), pause_after_print: false });
        let env = crate::envelope::Envelope::from_outcome("backup", "a", "b", &o);
        assert!(env.to_stdout_json(o.secret_once.as_ref()).contains(&key));
        assert_eq!(serde_json::from_str::<Value>(&env.to_stdout_json(o.secret_once.as_ref())).unwrap()["data"]["recovery"]["key"], key.as_str());
        assert!(!env.to_file_json().contains(&key));
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.posctl_logs()).unwrap();
        runlog::write(&roots, "backup key-export", "2026-10-22T10:00:00Z", "OK", &o.message, &o.data);
        let logged: String = std::fs::read_dir(roots.posctl_logs()).unwrap().map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert!(!logged.is_empty() && !logged.contains(&key));
        PAUSE.set(false);
    }

    #[test]
    fn a_console_waits_for_enter_after_the_key_is_printed_and_a_pipe_never_waits() {
        let o = to_outcome(Done { message: "m".into(), data: json!({}), secret: Some("K".into()), pause_after_print: true });
        assert!(o.secret_once.is_some());
        let mut input = std::io::Cursor::new(b"\nrest".to_vec());
        let mut out: Vec<u8> = Vec::new();
        after_emit(&mut out, &mut input);
        assert_eq!(input.position(), 1, "read up to the line break and no further");
        // the pause is once: a second call (or a command that did not ask) reads nothing
        let mut again = std::io::Cursor::new(b"x\n".to_vec());
        after_emit(&mut out, &mut again);
        assert_eq!(again.position(), 0);
        let _ = to_outcome(Done { message: "m".into(), data: json!({}), secret: None, pause_after_print: false });
        let mut none = std::io::Cursor::new(b"x\n".to_vec());
        after_emit(&mut out, &mut none);
        assert_eq!(none.position(), 0);
        assert!(out.is_empty(), "nothing is written to stdout by the pause");
    }

    #[test]
    fn a_standard_user_is_not_elevated_before_the_pc_is_provisioned() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false; // the provisioned file is absent: what a standard user sees under ProgramData
        for w in crate::backup::args::ADMIN_COMMAND_LINES {
            let cmd = crate::backup::args::parse(&w.split(' ').map(String::from).collect::<Vec<_>>()).unwrap_or_else(|e| panic!("{w}: {e}"));
            let e = precheck(&roots, &cmd, false).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::NotElevated, 3), "{w}");
            assert_eq!(precheck(&roots, &cmd, true).unwrap_err().code, Code::NotProvisioned, "{w}: an administrator on an unprovisioned PC");
        }
        assert!(!Cmd::DestCandidates.needs_admin());
    }

    #[test]
    fn the_drive_picker_works_for_a_standard_user_and_reads_nothing_under_programdata() {
        use clap::Parser;
        #[derive(Parser)]
        struct W { #[command(flatten)] a: BackupArgs }
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false; // standard user: provisioned.json is invisible
        let a = W::try_parse_from(["posctl", "dest", "candidates"]).unwrap().a;
        let o = run_cli(&roots, &a, false, &mut std::io::empty()).unwrap_or_else(|e| panic!("{:?} {}", e.code, e.message));
        assert!(o.data["candidates"].is_array(), "{:?}", o.data);
        assert!(!roots.data.exists(), "nothing was created under the data root");
    }

    #[test]
    fn backup_is_in_the_help_and_has_the_conventions_subcommands() {
        let (code, out) = run(&["posctl", "--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("backup"), "{out}");
        let (_, sub) = run(&["posctl", "backup", "--help"]);
        for w in ["run", "list", "verify", "restore", "drill", "key-export", "dest"] {
            assert!(sub.contains(w), "{w} in {sub}");
        }
    }
}
