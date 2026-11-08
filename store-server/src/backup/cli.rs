//! Dispatch for `posctl backup ...`: what each command locks, whether it needs an Administrator, and what it returns.
//! The envelope, exit codes and the log belong to `commands::backup`; this file is pure over its inputs (the context, the
//! tools, the clock and the lock folder are all passed in), so every rule below is tested on the host.
//!
//! Locks (conventions section 11.3):
//! - `run`, `verify` and `drill` take `update.lock` SHARED and `backup.lock` (in `run_backup`, `verify_with`, `drill_with`).
//! - Everything that writes the destinations, the keys or the configuration of the backup service (`dest add|remove|check`,
//!   `key-export`) does the same through `run::gated`, so a PrivateDir user also holds `backup.lock` and the tick's sweep
//!   cannot delete its folder, and an update (which needs the lock exclusively) waits for it.
//! - `restore --swap` takes `update.lock` EXCLUSIVE through Plan 07's runner (`restore_work`). `config set` stays exclusive too.
use serde_json::{json, Value};
use std::time::Duration;

use super::args::Cmd;
use super::config::{self, Destination};
use super::ctx::BackupCtx;
use super::dest::{self, AddDevice};
use super::escrow::{self, ObjectPut};
use super::keys;
use super::repo::{dest_repo, ensure_local_repo};
use super::restic::{key_remove_args, run_restic};
use super::result::{BResult, BackupError};
use super::restore_work::RestoreArgs;
use super::run::{gated, run_backup, Deps, Gate, LockPolicy, RunOptions};
use super::state::BackupState;
use super::util::iso_utc;
use crate::update::Env;

/// What a command hands back. The recovery key (`key-export` only) travels in `secret` and nowhere else.
pub struct Done {
    pub message: String,
    pub data: Value,
    pub secret: Option<String>,
    /// `key-export` on a console: print, then wait for Enter so an elevated window does not vanish with the key.
    pub pause_after_print: bool,
}

// Debug must never print the recovery key.
impl std::fmt::Debug for Done {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Done").field("message", &self.message).field("data", &self.data).field("secret", &self.secret.as_ref().map(|_| "<redacted>")).finish()
    }
}

/// How this run was started. Decided by the caller (`commands::backup`), so the rules stay testable.
pub struct Invocation<'a> {
    /// An Administrator token (true under `--dev`).
    pub elevated: bool,
    /// `--result-file` was given.
    pub result_file: bool,
    /// stdin and stdout are a console (a person is looking at it).
    pub interactive: bool,
    /// stdout alone is a console: `key-export` prints the key there, so a pipe or a file never sees it.
    pub stdout_console: bool,
    /// One line of stdin: the owner's recovery key. Only called for a command that was given `--key-stdin`.
    pub read_stdin: &'a dyn Fn() -> String,
}

fn done(message: &str, data: Value) -> BResult<Done> {
    Ok(Done { message: message.into(), data, secret: None, pause_after_print: false })
}

fn need_admin(inv: &Invocation) -> BResult<()> {
    if inv.elevated { Ok(()) } else { Err(BackupError::not_elevated()) }
}

/// The recovery key as typed or piped: trimmed, never kept in an error message.
fn stdin_key(inv: &Invocation, wanted: bool) -> Option<String> {
    wanted.then(|| (inv.read_stdin)().trim().to_string()).filter(|k| !k.is_empty())
}

/// `update.lock` shared plus `backup.lock` for the whole body (see the module comment). A person at the console who finds
/// either busy gets LOCK_HELD (10).
fn locked<T>(ctx: &BackupCtx, f: impl FnOnce() -> BResult<T>) -> BResult<T> {
    match gated(ctx, LockPolicy::Acquire, false, f)? {
        Gate::Ran(v) => Ok(v),
        Gate::Busy(_) => Err(BackupError::lock_held()),
    }
}

/// The drive picker lists drive letters and nothing else: no context, no configuration, no ProgramData. `commands::backup::run_cli`
/// answers it before it looks for `provisioned.json`, so a standard user on a provisioned PC gets the list.
pub fn dest_candidates() -> BResult<Done> {
    #[cfg(windows)]
    return done("drives listed", dest::candidates(std::env::var("SystemDrive").ok().and_then(|s| s.chars().next()).unwrap_or('C')));
    #[cfg(not(windows))]
    done("drives listed", json!({ "candidates": [] }))
}

pub fn dispatch(ctx: &BackupCtx, env: &Env, deps: &Deps, cmd: Cmd, inv: &Invocation) -> BResult<Done> {
    // everything but the drive picker reads the machine key or the configuration, which only SYSTEM and Administrators may open
    if cmd.needs_admin() {
        need_admin(inv)?;
    }
    match cmd {
        Cmd::Run { reason, dest, scheduled } => {
            let r = run_backup(ctx, deps, &RunOptions { reason, only_dest: dest, scheduled, lock: LockPolicy::Acquire, deadline: None })?;
            let msg = match r.outcome.as_str() {
                "skipped" => format!("nothing to do ({})", r.skip.clone().unwrap_or_default()),
                "copied" => "copied the newest backup to the connected drives".to_string(),
                _ => "backup completed".to_string(),
            };
            done(&msg, serde_json::to_value(&r).unwrap_or(Value::Null))
        }
        Cmd::List => {
            let mut v = super::maintain::list(ctx, deps)?;
            // the paths of photos restic could not read: for the person at the console and the local log, never status.json
            if let Ok(st) = BackupState::load_in(&ctx.paths, (deps.now)()) {
                if let Some(p) = st.photos_unreadable {
                    v["photosUnreadable"] = json!({ "total": p.total, "paths": p.paths });
                }
            }
            done("backups listed", v)
        }
        Cmd::Verify { read_data, scheduled } => done("backups verified", super::maintain::verify_with(ctx, deps, read_data, scheduled)?),
        Cmd::Drill { scheduled } => done("restore drill finished", super::drill::drill_with(ctx, deps, scheduled)?),
        Cmd::Restore { snapshot, swap, repo, key_stdin } => {
            // the key is read here, only when asked for, and goes straight into the call: never into an argument or a message
            let key = stdin_key(inv, key_stdin);
            let mut v = super::restore_work::run_restore(env, ctx, &RestoreArgs { snapshot, swap, repo }, key)?;
            let blocked = swap && restore_notice(env, &mut v);
            let msg = match (swap, blocked) {
                (_, true) => SIGN_IN_BLOCKED,
                (true, false) => "the store was restored from the backup",
                (false, false) => "the backup restores and verifies; nothing was replaced",
            };
            done(msg, v)
        }
        Cmd::KeyExport { rotate } => {
            if inv.result_file {
                return Err(BackupError::usage("the recovery key is shown once on the console; it is never written to a result file"));
            }
            console_required(inv.stdout_console)?;
            let (data, key) = key_export_with(ctx, deps, rotate, &escrow::build_pubkey(), escrow::real_put().as_ref())?;
            Ok(Done { message: "write this key down and keep it away from this PC; it is not stored anywhere".into(), data, secret: Some(key), pause_after_print: inv.interactive })
        }
        Cmd::DestCandidates => dest_candidates(),
        Cmd::DestList => done("destinations listed", dest::check(ctx, &*deps.exec, None)?),
        Cmd::DestCheck { name } => done("destinations checked", locked(ctx, || dest::check(ctx, &*deps.exec, name.as_deref()))?),
        Cmd::DestRemove { name } => done("destination removed", locked(ctx, || dest::remove(ctx, &name))?),
        Cmd::DestAddDevice { name, path, allow_fixed, key_stdin } => {
            let recovery_key = stdin_key(inv, key_stdin);
            #[cfg(windows)]
            return done("destination added; the first copy happens within minutes", locked(ctx, || dest::add_device(ctx, &*deps.exec, &AddDevice { name, path, allow_fixed, recovery_key }))?);
            #[cfg(not(windows))]
            {
                let _ = (name, path, allow_fixed, recovery_key);
                Err(BackupError::error("drive destinations are only supported on Windows"))
            }
        }
        Cmd::DestAddR2 { name, repo, key_stdin } => {
            let recovery_key = stdin_key(inv, key_stdin);
            done("destination added", locked(ctx, || dest::add_r2(ctx, &*deps.exec, name, &repo, recovery_key))?)
        }
    }
}

/// The key is printed to stdout, so stdout must be a console window: a pipe or a redirect to a file would keep it.
pub fn console_required(stdout_is_console: bool) -> BResult<()> {
    if stdout_is_console { Ok(()) } else { Err(BackupError::precondition("run key-export in a console window")) }
}

pub const SIGN_IN_BLOCKED: &str = "sign-in is blocked until the lockout protection works; call support";

/// A restore whose canary proved the PIN lockout is NOT working leaves `canary.json` with `lastOk: false` (fail-closed: the
/// sign-in gate keeps the till out). The person at the console is told in plain words. Returns whether it is so.
pub fn restore_notice(env: &Env, result: &mut Value) -> bool {
    let failed = std::fs::read_to_string(env.roots.canary_json()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|c| c["lastOk"] == false);
    let warned = result["warnings"].as_array().is_some_and(|w| w.iter().any(|x| x == "CANARY_AFTER_RESTORE"));
    if failed && warned {
        result["signInBlocked"] = json!(true);
        result["notice"] = json!(SIGN_IN_BLOCKED);
    }
    failed && warned
}

/// Adds a fresh recovery key to the local repository and every destination (all of which must be connected), publishes the
/// vendor escrow copy and returns `(data, key)`. The key is generated, returned once and forgotten: it is not in `data`.
///
/// The escrow copy is written only after `export_recovery_key` returned Ok, i.e. after every repository has the key; a build
/// without a vendor escrow key (the placeholder) refuses first and changes nothing at all.
pub fn key_export_with(ctx: &BackupCtx, deps: &Deps, rotate: bool, escrow_pub: &str, put: &dyn ObjectPut) -> BResult<(Value, String)> {
    key_export_saving(ctx, deps, rotate, escrow_pub, put, &|st: &BackupState| st.save_in(ctx))
}

/// `save` is the state write after the key is in every repository; a seam so the failure path is tested.
fn key_export_saving(ctx: &BackupCtx, deps: &Deps, rotate: bool, escrow_pub: &str, put: &dyn ObjectPut, save: &dyn Fn(&BackupState) -> std::io::Result<()>) -> BResult<(Value, String)> {
    locked(ctx, || {
        // before any repository, key file or state is touched
        escrow::check_recipient(escrow_pub)?;
        let cfg = config::load(&ctx.paths.conf_file())?;
        let now = (deps.now)();
        let mut st = BackupState::load_in(&ctx.paths, now)?;
        let mut repos = vec![("local".to_string(), ensure_local_repo(ctx, &*deps.exec, !cfg.destinations.is_empty())?)];
        for d in &cfg.destinations {
            if d.kind == config::DestKind::Device && !dest::reachable(d) {
                return Err(BackupError::precondition(format!("connect the drive '{}' first: the recovery key must be added to every backup copy", d.name)));
            }
            repos.push((d.name.clone(), dest_repo(ctx, d)?));
        }
        let ex = keys::export_recovery_key(ctx, &*deps.exec, &mut st, &repos, &cfg, rotate, now, escrow_pub)?;
        let mut warnings = ex.warnings.clone();
        // Fail closed: a key whose ids are not recorded could never be rotated or counted by the alerts. Take the keys just added
        // out of every repository again and return the error, never the key.
        if let Err(e) = save(&st) {
            let added: Vec<(String, String)> = st.recovery_key.iter().flat_map(|k| ex.repos.iter().filter_map(|n| k.key_ids.get(n).map(|id| (n.clone(), id.clone())))).collect();
            let mut stuck = Vec::new();
            for (name, id) in added {
                let Some((_, repo)) = repos.iter().find(|(n, _)| *n == name) else { continue };
                let gone = run_restic(&*deps.exec, ctx, repo, &key_remove_args(&id), Duration::from_secs(120));
                if !gone.is_ok_and(|o| o.ok()) {
                    stuck.push(name);
                }
            }
            let mut msg = format!("the backup state could not be saved ({e}); no recovery key was issued");
            if rotate {
                msg.push_str("; the rotation did not happen and the previous recovery key still works");
            }
            if !stuck.is_empty() {
                msg.push_str(&format!("; the new key could not be removed from {} and stays there unused", stuck.join(", ")));
            }
            return Err(BackupError::error(msg));
        }
        // the new ids are recorded: only now do the replaced keys go (a failure is a warning, the extra key is harmless)
        warnings.extend(keys::retire_old_keys(ctx, &*deps.exec, &repos, &ex.old_ids));
        let escrow = publish_escrow(ctx, &ex.escrow, &cfg.destinations, put, &mut warnings);
        let data = json!({ "issuedAt": iso_utc(ex.issued_at), "repositories": ex.repos, "escrow": escrow, "warnings": warnings });
        Ok((data, ex.key))
    })
}

/// `escrow.age` next to every backup copy: one `{dest, ok}` per destination. A failure is a warning, never an error: the owner
/// still has the printed key.
fn publish_escrow(ctx: &BackupCtx, blob: &[u8], dests: &[Destination], put: &dyn ObjectPut, warnings: &mut Vec<String>) -> Vec<Value> {
    match escrow::publish(ctx, blob, dests, put) {
        Ok(rows) => rows
            .into_iter()
            .map(|(d, r)| match r {
                Ok(()) => json!({ "dest": d, "ok": true }),
                Err(e) => json!({ "dest": d, "ok": false, "error": e }),
            })
            .collect(),
        Err(e) => {
            warnings.push(format!("the escrow copy could not be written on this PC: {}", e.message));
            dests.iter().map(|d| json!({ "dest": d.name, "ok": false, "error": "not written" })).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::args::parse;
    use crate::backup::config::{DestKind, Destination};
    use crate::backup::pg::PsqlOpener;
    use crate::backup::state::RecoveryKeyRef;
    use crate::backup::util::fake::{temp_ctx, FakeExec};
    use crate::envelope::Code;
    use crate::ops::lock::{acquire_for, LockMode};
    use std::rc::Rc;
    use std::time::Duration;

    const NOW: i64 = 1_790_000_100;

    fn a(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    fn fx() -> (tempfile::TempDir, BackupCtx, Env) {
        let (d, c) = temp_ctx();
        let roots = c.paths.roots().clone();
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        let env = Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe: d.path().join("posctl.exe"), ports: c.ports, roots, activate: Rc::new(|_, _, _| Ok(())) };
        (d, c, env)
    }

    fn deps(e: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(e), opener: Box::new(PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }

    fn no_stdin() -> String {
        String::new()
    }

    fn inv(elevated: bool, result_file: bool, read: &dyn Fn() -> String) -> Invocation<'_> {
        Invocation { elevated, result_file, interactive: false, stdout_console: true, read_stdin: read }
    }

    fn run(c: &BackupCtx, env: &Env, d: &Deps, cmd: &str, i: &Invocation) -> BResult<Done> {
        dispatch(c, env, d, parse(&a(cmd)).unwrap(), i)
    }

    fn hold(env: &Env, mode: LockMode) -> crate::ops::lock::LockGuard {
        acquire_for(&env.roots, mode, "test", "op-test", Duration::ZERO).unwrap()
    }

    fn write_conf(c: &BackupCtx, json: &str) {
        std::fs::write(c.paths.conf_file(), json).unwrap();
    }

    fn issued(c: &BackupCtx) {
        let st = BackupState { recovery_key: Some(RecoveryKeyRef { issued_at: 1, key_ids: [("local".to_string(), "aaaa1111".to_string())].into_iter().collect() }), ..Default::default() };
        st.save_unprotected(&c.paths.state_file()).unwrap();
    }

    #[test]
    fn every_command_but_the_drive_picker_needs_an_elevated_session() {
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        for cmd in crate::backup::args::ADMIN_COMMAND_LINES {
            let e = run(&c, &env, &dp, cmd, &inv(false, false, &no_stdin)).unwrap_err();
            assert_eq!((e.code, e.exit()), (Code::NotElevated, 3), "{cmd}");
        }
        assert!(run(&c, &env, &dp, "dest candidates", &inv(false, false, &no_stdin)).is_ok(), "listing drive letters needs no secret");
    }

    #[test]
    fn the_recovery_key_is_never_written_to_a_result_file() {
        let _g = crate::backup::escrow::env_lock(); // POSCTL_TEST_ESCROW_PUBKEY is process-wide: every test that sets it or reaches build_pubkey holds this
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let e = run(&c, &env, &dp, "key-export", &inv(true, true, &no_stdin)).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert!(e.message.contains("result file"), "{}", e.message);
    }

    #[test]
    fn the_key_from_stdin_is_trimmed_and_never_echoed_in_an_error() {
        let (d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let secret = keys::new_recovery_key().unwrap();
        let s2 = secret.clone();
        let read = move || format!("  {s2}\r\n");
        let _ = &d;
        let repo = "nowhere".to_string();
        let e = run(&c, &env, &dp, &format!("restore --snapshot latest --repo {repo} --key-stdin"), &inv(true, false, &read)).unwrap_err();
        assert!(!e.message.contains(&secret) && !e.message.contains(&secret.replace('-', "")), "a key must never appear in a message: {}", e.message);
        let junk = || "not-a-key-at-all".to_string();
        let e = run(&c, &env, &dp, &format!("restore --snapshot latest --repo {repo} --key-stdin"), &inv(true, false, &junk)).unwrap_err();
        assert!(!e.message.contains("not-a-key-at-all"), "{}", e.message);
    }

    #[test]
    fn a_restore_without_the_stdin_flag_never_reads_stdin() {
        let (d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let touched = std::cell::Cell::new(false);
        let read = || {
            touched.set(true);
            String::new()
        };
        let _ = &d;
        let repo = "nowhere".to_string();
        let _ = run(&c, &env, &dp, &format!("restore --snapshot latest --repo {repo}"), &inv(true, false, &read));
        assert!(!touched.get());
    }

    #[test]
    fn a_network_share_is_refused_with_exactly_one_sentence() {
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let e = dispatch(&c, &env, &dp, parse(&["dest".into(), "add".into(), "--kind".into(), "device".into(), "--path".into(), r"\\server\share".into()]).unwrap(), &inv(true, false, &no_stdin)).unwrap_err();
        assert_eq!(e.message, "network shares are not supported; use a USB drive or R2");
        assert_eq!(e.code, Code::Usage);
    }

    #[test]
    fn the_destination_commands_and_key_export_hold_update_lock_shared_for_their_whole_run() {
        let _g = crate::backup::escrow::env_lock(); // POSCTL_TEST_ESCROW_PUBKEY is process-wide: every test that sets it or reaches build_pubkey holds this
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        {
            let _x = hold(&env, LockMode::Exclusive);
            for cmd in ["dest remove --name x", "dest check", "dest add --kind r2 --repo s3:https://x/b", "dest add --kind device --path E:\\", "key-export"] {
                let e = run(&c, &env, &dp, cmd, &inv(true, false, &no_stdin)).unwrap_err();
                assert_eq!((e.code, e.exit()), (Code::LockHeld, 10), "{cmd}");
            }
        }
        // another shared holder (a running backup) does not block them: they are readers of the update lock, not writers
        let _s = hold(&env, LockMode::Shared);
        let e = run(&c, &env, &dp, "dest remove --name x", &inv(true, false, &no_stdin)).unwrap_err();
        assert_eq!(e.code, Code::Usage, "got past the lock to the real answer: {}", e.message);
        assert!(e.message.contains("no destination named"));
    }

    #[test]
    fn a_scheduled_run_that_finds_nothing_to_do_or_the_lock_busy_is_a_success_and_a_manual_one_is_exit_10() {
        let (_d, c, env) = fx();
        write_conf(&c, r#"{"schema":1,"backup":{"enabled":false}}"#);
        let dp = deps(Rc::new(FakeExec::default()));
        let r = run(&c, &env, &dp, "run --reason hourly --scheduled", &inv(true, false, &no_stdin)).unwrap();
        assert_eq!(r.data["outcome"], "skipped");
        assert!(r.message.contains("nothing to do"));
        let _x = hold(&env, LockMode::Exclusive);
        let busy = run(&c, &env, &dp, "run --reason hourly --scheduled", &inv(true, false, &no_stdin)).unwrap();
        assert_eq!((busy.data["outcome"].as_str(), busy.data["skip"].as_str()), (Some("skipped"), Some("update-in-progress")));
        let manual = run(&c, &env, &dp, "run --reason manual", &inv(true, false, &no_stdin)).unwrap_err();
        assert_eq!((manual.code, manual.exit()), (Code::LockHeld, 10));
    }

    #[test]
    fn verify_and_drill_pass_the_scheduled_flag_on_so_a_busy_lock_is_quiet_for_the_task_and_exit_10_for_a_person() {
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let _x = hold(&env, LockMode::Exclusive);
        for cmd in ["verify --read-data --scheduled", "drill --scheduled"] {
            let r = run(&c, &env, &dp, cmd, &inv(true, false, &no_stdin)).unwrap();
            assert_eq!(r.data["skipped"], "update-in-progress", "{cmd}");
        }
        for cmd in ["verify --read-data", "drill"] {
            assert_eq!(run(&c, &env, &dp, cmd, &inv(true, false, &no_stdin)).unwrap_err().exit(), 10, "{cmd}");
        }
    }

    fn escrow_identity() -> (age::x25519::Identity, String) {
        let id = age::x25519::Identity::generate();
        let p = id.to_public().to_string();
        (id, p)
    }

    fn usb(d: &std::path::Path) -> Destination {
        let dir = d.join("usb");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config"), b"x").unwrap();
        Destination { name: "usb-e".into(), kind: DestKind::Device, path: Some(dir.display().to_string()), repo: None, volume_serial: None, added_at: 1, extra: Default::default() }
    }

    fn add_dests(c: &BackupCtx, dests: Vec<Destination>) {
        let mut cfg = config::load(&c.paths.conf_file()).unwrap();
        cfg.destinations = dests;
        config::save(&c.paths.conf_file(), &cfg).unwrap();
    }

    fn tree_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { tree_files(&p, out) } else { out.push(p) }
        }
    }

    #[test]
    fn key_export_adds_the_key_everywhere_publishes_the_escrow_and_leaves_the_key_in_no_file() {
        let (d, c, _env) = fx();
        add_dests(&c, vec![usb(d.path())]);
        let (identity, public) = escrow_identity();
        let exec = Rc::new(FakeExec::default().on("key add", 0, "saved new key with ID aaaa1111\n"));
        let (data, key) = key_export_with(&c, &deps(exec.clone()), false, &public, escrow::real_put().as_ref()).unwrap();
        assert!(keys::normalize_recovery_key(&key).is_some());
        assert_eq!(data["escrow"], json!([{ "dest": "usb-e", "ok": true }]));
        assert_eq!(data["repositories"], json!(["local", "usb-e"]));
        assert!(!data.to_string().contains(&key), "the key is returned beside the data, never in it");
        // the escrow copy decrypts (with the vendor's private half) to exactly the key, on this PC and next to the drive
        for p in [escrow::stored_path(&c), d.path().join(escrow::FILE_NAME)] {
            assert_eq!(age::decrypt(&identity, &std::fs::read(&p).unwrap()).unwrap(), key.as_bytes(), "{}", p.display());
        }
        // Plan 04 test 6: the key is in no file under the data tree (backups, state, tmp, secrets) and not on any command line
        let mut files = Vec::new();
        tree_files(c.paths.data(), &mut files);
        tree_files(&d.path().join("usb"), &mut files);
        assert!(!files.is_empty());
        let plain = key.replace('-', "");
        for f in files {
            let text = String::from_utf8_lossy(&std::fs::read(&f).unwrap()).into_owned();
            assert!(!text.contains(&key) && !text.contains(&plain), "the recovery key is in {}", f.display());
        }
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&key) && !l.contains(&plain)));
        let st = BackupState::load_in(&c.paths, NOW).unwrap();
        assert_eq!(st.recovery_key.unwrap().key_ids.len(), 2);
        assert_eq!(std::fs::read_dir(c.paths.backups_tmp()).unwrap().count(), 0, "no private run folder is left");
    }

    #[test]
    fn a_destination_the_escrow_copy_cannot_reach_is_reported_and_the_export_still_succeeds() {
        let (d, c, _env) = fx();
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k\n").unwrap();
        let cloud = Destination { name: "cloud".into(), kind: DestKind::R2, path: None, repo: Some("s3:https://h.example/b/f".into()), volume_serial: None, added_at: 1, extra: Default::default() };
        add_dests(&c, vec![usb(d.path()), cloud]);
        let (_id, public) = escrow_identity();
        let exec = Rc::new(FakeExec::default().on("key add", 0, "saved new key with ID aaaa1111\n"));
        let (data, _key) = key_export_with(&c, &deps(exec), false, &public, escrow::real_put().as_ref()).unwrap();
        let rows = data["escrow"].as_array().unwrap();
        assert_eq!(rows.iter().map(|r| (r["dest"].as_str().unwrap(), r["ok"].as_bool().unwrap())).collect::<Vec<_>>(), [("usb-e", true), ("cloud", false)]);
    }

    #[test]
    fn a_build_without_the_vendor_escrow_key_refuses_and_changes_nothing() {
        let _g = crate::backup::escrow::env_lock(); // POSCTL_TEST_ESCROW_PUBKEY is process-wide: every test that sets it or reaches build_pubkey holds this
        let (d, c, env) = fx();
        add_dests(&c, vec![usb(d.path())]);
        let exec = Rc::new(FakeExec::default());
        let e = key_export_with(&c, &deps(exec.clone()), false, escrow::PLACEHOLDER, escrow::real_put().as_ref()).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(exec.calls.borrow().is_empty(), "no restic call: {:?}", exec.calls.borrow());
        assert!(!c.paths.state_file().exists() && !escrow::stored_path(&c).exists() && !d.path().join(escrow::FILE_NAME).exists());
        // the production entry is that build today: the committed key is the placeholder
        let e = run(&c, &env, &deps(exec), "key-export", &inv(true, false, &no_stdin)).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
    }

    #[test]
    fn an_unplugged_drive_stops_the_export_before_any_key_is_added() {
        let (d, c, _env) = fx();
        let mut u = usb(d.path());
        std::fs::remove_file(d.path().join("usb").join("config")).unwrap();
        u.path = Some(d.path().join("usb").display().to_string());
        add_dests(&c, vec![u]);
        let (_id, public) = escrow_identity();
        let exec = Rc::new(FakeExec::default());
        let e = key_export_with(&c, &deps(exec.clone()), false, &public, escrow::real_put().as_ref()).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert_eq!(exec.count_of("key add"), 0);
    }

    #[test]
    fn dest_add_takes_the_recovery_key_from_stdin_once_one_exists_and_never_puts_it_on_a_command_line() {
        let (_d, c, env) = fx();
        issued(&c);
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k\n").unwrap();
        let local_cat = format!("{} cat config", c.paths.repo().display());
        let exec = Rc::new(FakeExec::default().on(&local_cat, 0, "").on("cat config", 10, "").on("key add", 0, "saved new key with ID 1a2b3c4d\n"));
        let dp = deps(exec.clone());
        let cmd = "dest add --kind r2 --repo s3:https://h.example/b/f --name cloud --key-stdin";
        let none = || String::new();
        let e = run(&c, &env, &dp, cmd, &inv(true, false, &none)).unwrap_err();
        assert_eq!(e.code, Code::Precondition, "{}", e.message);
        assert!(config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
        let rk = keys::new_recovery_key().unwrap();
        let r2 = rk.clone();
        let read = move || format!("{r2}\n");
        let ok = run(&c, &env, &dp, cmd, &inv(true, false, &read)).unwrap();
        assert_eq!(ok.data["name"], "cloud");
        assert!(ok.data.get("escrowWarning").is_some(), "the escrow outcome is part of the result");
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&rk)), "the key must not appear on argv");
    }

    #[test]
    fn list_adds_the_unreadable_photo_paths_for_the_console_and_the_log() {
        let (_d, c, env) = fx();
        let st = BackupState { photos_unreadable: Some(crate::backup::state::PhotosUnreadableRef { at: 1, total: 2, paths: vec!["C:/x/a.jpg".into(), "C:/x/b.jpg".into()] }), ..Default::default() };
        st.save_unprotected(&c.paths.state_file()).unwrap();
        let exec = Rc::new(FakeExec::default().on("snapshots", 0, "[]"));
        let r = run(&c, &env, &deps(exec), "list", &inv(true, false, &no_stdin)).unwrap();
        assert_eq!(r.data["photosUnreadable"]["total"], 2);
        assert_eq!(r.data["photosUnreadable"]["paths"][0], "C:/x/a.jpg");
    }

    #[test]
    fn a_canary_failure_after_a_restore_is_said_in_plain_words() {
        let (_d, _c, env) = fx();
        let canary = env.roots.canary_json();
        std::fs::create_dir_all(canary.parent().unwrap()).unwrap();
        let mut v = json!({ "warnings": ["PHOTOS_SOME_MISSING"] });
        assert!(!restore_notice(&env, &mut v), "no canary record");
        std::fs::write(&canary, r#"{"lastOk":false}"#).unwrap();
        assert!(!restore_notice(&env, &mut v), "a warning that is not the canary's");
        let mut v = json!({ "warnings": ["CANARY_AFTER_RESTORE"] });
        assert!(restore_notice(&env, &mut v));
        assert_eq!(v["notice"], "sign-in is blocked until the lockout protection works; call support");
        assert_eq!(v["signInBlocked"], true);
        std::fs::write(&canary, r#"{"lastOk":true}"#).unwrap();
        let mut v = json!({ "warnings": ["CANARY_AFTER_RESTORE"] });
        assert!(!restore_notice(&env, &mut v), "the canary passed");
    }

    #[test]
    fn key_export_needs_a_console_for_stdout_so_the_key_never_lands_in_a_pipe_or_a_file() {
        let (_d, c, env) = fx();
        let dp = deps(Rc::new(FakeExec::default()));
        let i = Invocation { elevated: true, result_file: false, interactive: false, stdout_console: false, read_stdin: &no_stdin };
        let e = run(&c, &env, &dp, "key-export", &i).unwrap_err();
        assert_eq!((e.code, e.exit()), (Code::Precondition, 12));
        assert_eq!(e.message, "run key-export in a console window");
        // the other commands do not care where stdout goes
        assert!(run(&c, &env, &dp, "dest candidates", &i).is_ok());
    }

    #[test]
    fn a_state_save_failure_after_the_export_removes_the_new_keys_and_returns_no_key() {
        let (d, c, _env) = fx();
        add_dests(&c, vec![usb(d.path())]);
        let (_id, public) = escrow_identity();
        let exec = Rc::new(FakeExec::default().on("key add", 0, "saved new key with ID aaaa1111
"));
        let save = |_: &BackupState| -> std::io::Result<()> { Err(std::io::Error::other("disk full")) };
        let e = key_export_saving(&c, &deps(exec.clone()), false, &public, escrow::real_put().as_ref(), &save).unwrap_err();
        assert_eq!(e.code, Code::Error, "{}", e.message);
        assert!(!e.message.contains("KEY"), "no key in the error");
        assert_eq!(exec.count_of("key remove"), 2, "the id just added is removed from the local repository and from the drive: {:?}", exec.calls.borrow());
        assert!(!escrow::stored_path(&c).exists() && !d.path().join(escrow::FILE_NAME).exists(), "no escrow copy of a key that was withdrawn");
        assert!(!c.paths.state_file().exists());
    }

    fn rotation_rig() -> (tempfile::TempDir, BackupCtx, String) {
        let (d, c, _env) = fx();
        issued(&c); // local key id aaaa1111 is recorded
        let (_id, public) = escrow_identity();
        (d, c, public)
    }

    #[test]
    fn a_rotation_whose_state_cannot_be_saved_rolls_back_only_the_new_key_and_the_old_one_keeps_working() {
        let (d, c, public) = rotation_rig();
        let exec = Rc::new(FakeExec::default().on("key add", 0, "saved new key with ID eeee5555
"));
        let save = |_: &BackupState| -> std::io::Result<()> { Err(std::io::Error::other("disk full")) };
        let e = key_export_saving(&c, &deps(exec.clone()), true, &public, escrow::real_put().as_ref(), &save).unwrap_err();
        assert!(e.message.contains("rotation did not happen"), "{}", e.message);
        assert_eq!(exec.count_of("key remove eeee5555"), 1, "the new key is taken out again");
        assert_eq!(exec.count_of("key remove aaaa1111"), 0, "the old key is never touched: {:?}", exec.calls.borrow());
        let st = BackupState::load_in(&c.paths, NOW).unwrap();
        assert_eq!(st.recovery_key.unwrap().key_ids["local"], "aaaa1111", "the old id is still recorded");
        assert!(!escrow::stored_path(&c).exists() && !d.path().join(escrow::FILE_NAME).exists());
    }

    #[test]
    fn the_old_key_is_removed_only_after_the_new_ids_are_saved() {
        let (_d, c, public) = rotation_rig();
        let log: Rc<std::cell::RefCell<Vec<String>>> = Default::default();
        let (l1, l2) = (log.clone(), log.clone());
        let exec = Rc::new(
            FakeExec::default()
                .on_with("key add", 0, "saved new key with ID eeee5555
", move |_| l1.borrow_mut().push("add".into()))
                .on_with("key remove", 0, "", move |a| l2.borrow_mut().push(format!("remove {}", a.last().cloned().unwrap_or_default()))),
        );
        let l3 = log.clone();
        let save = move |st: &BackupState| -> std::io::Result<()> {
            assert_eq!(st.recovery_key.as_ref().unwrap().key_ids["local"], "eeee5555", "the new ids are what is saved");
            l3.borrow_mut().push("save".into());
            Ok(())
        };
        let (data, key) = key_export_saving(&c, &deps(exec), true, &public, escrow::real_put().as_ref(), &save).unwrap();
        assert_eq!(*log.borrow(), ["add", "save", "remove aaaa1111"]);
        assert!(keys::normalize_recovery_key(&key).is_some());
        assert_eq!(data["warnings"], json!([]));
    }

    #[test]
    fn an_old_key_that_cannot_be_removed_after_a_successful_save_is_a_warning() {
        let (_d, c, public) = rotation_rig();
        let exec = Rc::new(FakeExec::default().on("key remove aaaa1111", 1, "").on("key add", 0, "saved new key with ID eeee5555
"));
        let save = |_: &BackupState| -> std::io::Result<()> { Ok(()) };
        let (data, _key) = key_export_saving(&c, &deps(exec), true, &public, escrow::real_put().as_ref(), &save).unwrap();
        assert!(data["warnings"][0].as_str().unwrap().contains("aaaa1111"), "{data}");
    }

    #[test]
    fn done_never_prints_the_key_in_debug() {
        let d = Done { message: "m".into(), data: json!({}), secret: Some("KEYKEYKEY".into()), pause_after_print: false };
        assert!(!format!("{d:?}").contains("KEYKEYKEY"));
    }
}
