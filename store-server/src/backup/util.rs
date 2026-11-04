//! Small helpers shared by the backup service: UTC time, atomic writes, hashing, the OS random
//! source, and one process runner behind a trait so the orchestration can be unit-tested with a
//! fake. Plan 07 as built already owns most of this (`crate::util`, `crate::exec::Cmd`,
//! `crate::ops::swap::free_bytes`), so these are thin wrappers that keep the names later tasks use.
use std::path::Path;

use super::result::{BResult, BackupError};
use std::time::Duration;

pub fn now_secs() -> i64 {
    crate::util::now_unix() as i64
}

/// `2026-10-02T09:00:00Z`.
pub fn iso_utc(secs: i64) -> String {
    crate::util::rfc3339_utc(secs.max(0) as u64)
}

/// `20261002090000`, the suffix of every database name this module creates.
pub fn stamp_utc(secs: i64) -> String {
    iso_utc(secs).chars().filter(char::is_ascii_digit).collect()
}

/// RFC 3339 with optional fraction and `Z` or `+hh:mm`; the form restic prints.
/// ponytail: the `time` crate is already a dependency, so no hand parser.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok().map(|t| t.unix_timestamp())
}

/// Write to a sibling temp file, flush to disk, rename over the target (replaces on Windows).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::util::write_atomic(path, bytes)
}

pub use crate::util::write_atomic_prepared;

pub fn hex(bytes: &[u8]) -> String {
    crate::util::hex(bytes)
}

pub use crate::util::file_sha256 as sha256_file;

/// Thin wrapper over `crate::util::random_bytes(n)` (getrandom); this plan adds no dependency for it.
pub fn random_bytes(buf: &mut [u8]) -> BResult<()> {
    let v = crate::util::random_bytes(buf.len()).map_err(BackupError::error)?;
    buf.copy_from_slice(&v);
    Ok(())
}

/// Last ~400 characters of a tool's stderr, for error messages (never on a char boundary split).
pub fn tail(s: &str) -> String {
    let t = s.trim();
    if t.len() <= 400 {
        return t.to_string();
    }
    let start = t.char_indices().rev().take_while(|(i, _)| t.len() - i <= 400).last().map(|(i, _)| i).unwrap_or(0);
    format!("...{}", &t[start..])
}

/// Free bytes on the volume holding `path` (Plan 07's `ops::swap::free_bytes`).
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    crate::ops::swap::free_bytes(path).map_err(|e| std::io::Error::other(e.to_string()))
}

/// Leaves SYSTEM and Administrators (by SID) only, with inheritance removed, and reads the DACL back.
/// Reuses Plan 05's `acl::apply_one_with_owner` (SetNamedSecurityInfo, refuses a reparse point) instead of shelling
/// out to a bare `icacls.exe`. The owner is left alone: a non-elevated process cannot take ownership.
pub fn lock_down_file(path: &Path) -> std::io::Result<()> {
    use crate::acl::{apply_one_with_owner, Grant, Inherit, SID_ADMINISTRATORS, SID_SYSTEM};
    let grants = [Grant::new(SID_SYSTEM, "F", Inherit::No), Grant::new(SID_ADMINISTRATORS, "F", Inherit::No)];
    apply_one_with_owner(path, &grants, None).map_err(std::io::Error::other)
}

#[derive(Clone, Debug, Default)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl RunOutput {
    pub fn ok(&self) -> bool {
        self.code == 0 && !self.timed_out
    }
}

/// Every external tool goes through this trait so run/restore orchestration can be tested with
/// `fake::FakeExec`. `program` must be absolute and the child gets a cleared environment plus `env`
/// (`exec::Cmd` semantics, Plan 05 amendment), not the inherited one.
pub trait Exec {
    fn run(
        &self,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> std::io::Result<RunOutput>;

    /// `run` at a given scheduling class. An implementation that cannot set one ignores it.
    fn run_prio(
        &self,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
        stdin: Option<&[u8]>,
        timeout: Duration,
        _priority: crate::exec::Priority,
    ) -> std::io::Result<RunOutput> {
        self.run(program, args, env, stdin, timeout)
    }
}

/// Runs every child of the wrapped `Exec` at `BELOW_NORMAL` priority, whatever the caller asked for: the weekly drill
/// shares the day's maintenance task with verify and prune (PM ruling T6 B) and must not slow the tills down.
pub struct BelowNormal<'a>(pub &'a dyn Exec);

impl Exec for BelowNormal<'_> {
    fn run(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration) -> std::io::Result<RunOutput> {
        self.0.run_prio(program, args, env, stdin, timeout, crate::exec::Priority::BelowNormal)
    }
    fn run_prio(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration, _priority: crate::exec::Priority) -> std::io::Result<RunOutput> {
        self.run(program, args, env, stdin, timeout)
    }
}

/// Delegates to `crate::exec::Cmd` (Job Object kill on timeout, no console window, cleared environment).
pub struct RealExec;

impl Exec for RealExec {
    fn run(
        &self,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> std::io::Result<RunOutput> {
        self.run_prio(program, args, env, stdin, timeout, crate::exec::Priority::Normal)
    }

    fn run_prio(
        &self,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
        stdin: Option<&[u8]>,
        timeout: Duration,
        priority: crate::exec::Priority,
    ) -> std::io::Result<RunOutput> {
        use crate::exec::{Cmd, ExecError};
        let mut cmd = Cmd::new(program).args(args.iter().cloned()).timeout(timeout).priority(priority);
        for (k, v) in env {
            cmd = cmd.env(k, v);
        }
        if let Some(s) = stdin {
            cmd = cmd.stdin(s.to_vec());
        }
        match cmd.run() {
            Ok(o) => Ok(RunOutput { code: o.code, stdout: o.stdout, stderr: o.stderr, timed_out: false }),
            // ponytail: `ExecError::Timeout` carries no partial output, so a timed-out run has an empty stderr tail;
            // keeping it needs a change in Plan 05's exec.rs.
            Err(ExecError::Timeout { .. }) => Ok(RunOutput { code: -1, timed_out: true, ..Default::default() }),
            // a program that cannot be started is `NotFound` so `BackupError::tool` maps it to PRECONDITION
            Err(e @ ExecError::Spawn { .. }) => Err(std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string())),
            Err(e) => Err(std::io::Error::other(e.to_string())),
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::cell::RefCell;

    /// A context over made-up absolute Windows paths, for tests that only drive `FakeExec`.
    pub fn test_ctx() -> crate::backup::ctx::BackupCtx {
        use crate::backup::ctx::BackupCtx;
        let roots = crate::paths::Roots::custom(std::path::PathBuf::from(r"C:\d"), std::path::PathBuf::from(r"C:\p"));
        BackupCtx::new(&roots, std::path::PathBuf::from(r"C:\pack"), crate::ports::Ports::new(47300).expect("valid base"), "t".into(), "t".into())
    }

    /// Test credentials are built at run time (secret-lint: no PIN or password literal in a file).
    pub fn rand_pin() -> String {
        let b = crate::util::random_bytes(4).expect("random");
        (u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 900_000 + 100_000).to_string()
    }
    pub fn rand_pepper() -> String {
        loop {
            let p = crate::backup::keys::generate_machine_key().expect("random");
            if crate::staff_password::acceptable_pepper(&p) {
                return p;
            }
        }
    }

    /// A dev context over a real temp folder with the files a restore or drill expects (machine key, pepper, local
    /// repository marker, config). The folder is deleted with the returned guard.
    pub fn temp_ctx() -> (tempfile::TempDir, crate::backup::ctx::BackupCtx) {
        let d = tempfile::tempdir().expect("tempdir");
        let roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("program"));
        let c = crate::backup::ctx::BackupCtx::new(&roots, d.path().join("pack"), crate::ports::Ports::new(47300).expect("ports"), "t".into(), "t".into());
        for p in [c.paths.secrets(), c.paths.backups(), c.paths.backups_tmp(), c.paths.state_dir(), c.paths.photos(), c.paths.repo(), c.paths.conf_file().parent().unwrap().to_path_buf(), c.pack_dir.join("bin"), c.pack_dir.join("migrations")] {
            std::fs::create_dir_all(p).expect("mkdir");
        }
        std::fs::write(c.paths.repo().join("config"), b"x").unwrap();
        std::fs::write(c.restic_exe(), b"x").unwrap();
        std::fs::write(c.paths.machine_key(), crate::backup::keys::generate_machine_key().unwrap()).unwrap();
        std::fs::write(c.paths.pepper(), rand_pepper()).unwrap();
        std::fs::write(c.paths.conf_file(), r#"{"schema":1,"backup":{"rtoBudgetSeconds":1800}}"#).unwrap();
        (d, c)
    }

    pub type Effect = Box<dyn Fn(&[String])>;

    pub struct Rule {
        pub needle: String,
        pub out: RunOutput,
        pub effect: Option<Effect>,
        /// `Some(n)`: the rule answers only its first `n` matches, later lines fall through to the next rule.
        pub limit: Option<usize>,
        pub used: std::cell::Cell<usize>,
    }

    /// First rule whose needle is contained in `"<program file name> <args joined by space>[ <<stdin script>]"` wins;
    /// no rule means exit 0 with empty output. `calls` records every invocation in order.
    #[derive(Default)]
    pub struct FakeExec {
        pub rules: Vec<Rule>,
        pub calls: RefCell<Vec<String>>,
        /// Environment variable NAMES passed on each call (never the values).
        pub envs: RefCell<Vec<Vec<String>>>,
        /// The timeout each call was given (index-aligned with `calls`).
        pub timeouts: RefCell<Vec<Duration>>,
        /// The scheduling class each call asked for (index-aligned with `calls`).
        pub prios: RefCell<Vec<crate::exec::Priority>>,
    }

    impl FakeExec {
        pub fn on(mut self, needle: &str, code: i32, stdout: &str) -> Self {
            self.rules.push(Rule {
                needle: needle.into(),
                out: RunOutput { code, stdout: stdout.into(), stderr: String::new(), timed_out: false },
                effect: None,
                limit: None,
                used: Default::default(),
            });
            self
        }
        /// Like `on`, with a stderr text.
        pub fn on_stderr(mut self, needle: &str, code: i32, stderr: &str) -> Self {
            self.rules.push(Rule {
                needle: needle.into(),
                out: RunOutput { code, stdout: String::new(), stderr: stderr.into(), timed_out: false },
                effect: None,
                limit: None,
                used: Default::default(),
            });
            self
        }
        /// Like `on`, but only for the first `n` matching calls (e.g. a role check that fails once, then succeeds).
        pub fn on_n(mut self, needle: &str, n: usize, code: i32, stdout: &str) -> Self {
            self.rules.push(Rule {
                needle: needle.into(),
                out: RunOutput { code, stdout: stdout.into(), stderr: String::new(), timed_out: false },
                effect: None,
                limit: Some(n),
                used: Default::default(),
            });
            self
        }
        pub fn on_with(mut self, needle: &str, code: i32, stdout: &str, effect: impl Fn(&[String]) + 'static) -> Self {
            self.rules.push(Rule {
                needle: needle.into(),
                out: RunOutput { code, stdout: stdout.into(), stderr: String::new(), timed_out: false },
                effect: Some(Box::new(effect)),
                limit: None,
                used: Default::default(),
            });
            self
        }
        pub fn index_of(&self, needle: &str) -> Option<usize> {
            self.calls.borrow().iter().position(|c| c.contains(needle))
        }
        /// The timeout the first call containing `needle` received.
        pub fn timeout_of(&self, needle: &str) -> Duration {
            self.timeouts.borrow()[self.index_of(needle).unwrap_or_else(|| panic!("no call containing {needle:?}"))]
        }
        pub fn count_of(&self, needle: &str) -> usize {
            self.calls.borrow().iter().filter(|c| c.contains(needle)).count()
        }
    }

    impl Exec for FakeExec {
        fn run(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration) -> std::io::Result<RunOutput> {
            self.run_prio(program, args, env, stdin, timeout, crate::exec::Priority::Normal)
        }

        fn run_prio(
            &self,
            program: &Path,
            args: &[String],
            env: &[(String, String)],
            stdin: Option<&[u8]>,
            timeout: Duration,
            priority: crate::exec::Priority,
        ) -> std::io::Result<RunOutput> {
            if !program.is_absolute() {
                return Err(std::io::Error::other("the program path must be absolute"));
            }
            let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // A script sent on stdin is part of the line, so a needle can pick one script out of many psql calls.
            let script = stdin.map(|s| format!(" <<{}", String::from_utf8_lossy(s))).unwrap_or_default();
            let line = format!("{name} {}{script}", args.join(" "));
            self.calls.borrow_mut().push(line.clone());
            self.envs.borrow_mut().push(env.iter().map(|(k, _)| k.clone()).collect());
            self.prios.borrow_mut().push(priority);
            self.timeouts.borrow_mut().push(timeout);
            for r in &self.rules {
                if line.contains(&r.needle) {
                    if r.limit.is_some_and(|n| r.used.get() >= n) {
                        continue;
                    }
                    r.used.set(r.used.get() + 1);
                    if let Some(e) = &r.effect {
                        e(args);
                    }
                    return Ok(r.out.clone());
                }
            }
            Ok(RunOutput::default())
        }
    }

    /// Lets a test keep a handle on the fake (`calls`, `envs`) while `Deps` owns a boxed clone.
    impl Exec for std::rc::Rc<FakeExec> {
        fn run(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration) -> std::io::Result<RunOutput> {
            (**self).run(program, args, env, stdin, timeout)
        }
        fn run_prio(&self, program: &Path, args: &[String], env: &[(String, String)], stdin: Option<&[u8]>, timeout: Duration, priority: crate::exec::Priority) -> std::io::Result<RunOutput> {
            (**self).run_prio(program, args, env, stdin, timeout, priority)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_stamp_known_values() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(stamp_utc(951_782_400 + 3_661), "20000229010101");
    }

    #[test]
    fn rfc3339_round_trips_and_handles_offsets_and_fractions() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339(&iso_utc(1_790_000_000)), Some(1_790_000_000));
        assert_eq!(parse_rfc3339("2000-02-29T03:00:00+03:00"), Some(951_782_400));
        assert_eq!(parse_rfc3339("2000-02-28T21:00:00-03:00"), Some(951_782_400));
        assert_eq!(parse_rfc3339("2000-02-29T00:00:00.999999999Z"), Some(951_782_400));
    }

    #[test]
    fn rfc3339_rejects_garbage() {
        assert_eq!(parse_rfc3339("nope"), None);
        assert_eq!(parse_rfc3339("2000-02-29"), None);
        assert_eq!(parse_rfc3339("2000-02-29T00:00:00"), None);
    }

    #[test]
    fn write_atomic_replaces_an_existing_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("state.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(d.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no temp file may remain");
    }

    #[test]
    fn sha256_matches_the_known_vector() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(sha256_file(&p).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn tail_keeps_the_end_and_never_splits_a_character() {
        assert_eq!(tail("  short  "), "short");
        let long = "é".repeat(500);
        let t = tail(&long);
        assert!(t.len() <= 410 && t.starts_with("..."));
        assert!(t.ends_with('é'));
    }

    #[test]
    fn random_bytes_are_not_all_zero_and_differ() {
        let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
        random_bytes(&mut a).unwrap();
        random_bytes(&mut b).unwrap();
        assert_ne!(a, [0u8; 32]);
        assert_ne!(a, b);
    }

    // S7 REVIEW I5 / S8 gotcha: a hung child must be killed, not waited for. (Plan 07 as built: RealExec -> exec::Cmd, absolute exe.)
    #[cfg(windows)]
    #[test]
    fn real_exec_kills_a_child_that_outlives_the_timeout() {
        let ping = crate::sys::system_dir().unwrap().join("PING.EXE");
        let started = std::time::Instant::now();
        let args = ["-n", "30", "127.0.0.1"].map(String::from);
        let out = RealExec.run(&ping, &args, &[], None, Duration::from_millis(600)).unwrap();
        assert!(out.timed_out);
        assert!(!out.ok());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(windows)]
    #[test]
    fn real_exec_captures_output_exit_code_and_passes_env() {
        let cmd = crate::sys::system_dir().unwrap().join("cmd.exe");
        let args = ["/c", "echo %BK_PROBE%& exit 3"].map(String::from);
        let out = RealExec.run(&cmd, &args, &[("BK_PROBE".into(), "hello".into())], None, Duration::from_secs(10)).unwrap();
        assert_eq!(out.code, 3);
        assert!(out.stdout.contains("hello"), "{}", out.stdout);
        assert!(!out.timed_out && !out.ok());
    }

    #[test]
    fn fake_exec_matches_needles_in_order_and_counts_calls() {
        use super::fake::FakeExec;
        let f = FakeExec::default().on("restic.exe backup", 3, "x");
        let o = f.run(Path::new(r"C:\p\restic.exe"), &["backup".into()], &[], None, Duration::from_secs(1)).unwrap();
        assert_eq!(o.code, 3);
        let o = f.run(Path::new(r"C:\p\psql.exe"), &["-c".into()], &[], Some(b"select 1"), Duration::from_secs(1)).unwrap();
        assert!(o.ok());
        assert_eq!(f.count_of("psql.exe -c <<select 1"), 1);
        assert_eq!(f.index_of("restic"), Some(0));
    }

    #[test]
    fn fake_exec_first_matching_rule_wins_when_rules_overlap() {
        use super::fake::FakeExec;
        let f = FakeExec::default().on("pg_dump.exe --version", 7, "specific").on("pg_dump.exe", 9, "general");
        let run = |args: &[&str]| {
            let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            f.run(Path::new(r"C:\p\pg_dump.exe"), &a, &[], None, Duration::from_secs(1)).unwrap()
        };
        assert_eq!(run(&["--version"]).code, 7);
        assert_eq!(run(&["-Fc"]).code, 9);
    }

    #[test]
    fn fake_exec_refuses_a_relative_program_like_exec_cmd_does() {
        use super::fake::FakeExec;
        let f = FakeExec::default();
        assert!(f.run(Path::new("restic.exe"), &[], &[], None, Duration::from_secs(1)).is_err());
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn fake_exec_records_env_keys_never_values() {
        use super::fake::FakeExec;
        let f = FakeExec::default();
        let env = [("RESTIC_PASSWORD_FILE".to_string(), "do-not-record".to_string())];
        f.run(Path::new(r"C:\p\restic.exe"), &[], &env, None, Duration::from_secs(1)).unwrap();
        assert_eq!(f.envs.borrow()[0], vec!["RESTIC_PASSWORD_FILE".to_string()]);
        assert!(!format!("{:?}{:?}", f.envs.borrow(), f.calls.borrow()).contains("do-not-record"));
    }

    #[cfg(windows)]
    #[test]
    fn real_exec_reports_a_missing_program_as_not_found() {
        let missing = crate::sys::system_dir().unwrap().join("no-such-tool-xyz.exe");
        let e = RealExec.run(&missing, &[], &[], None, Duration::from_secs(5)).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(windows)]
    #[test]
    fn lock_down_file_leaves_system_and_administrators_only_with_no_inherited_ace() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::write(&p, b"{}").unwrap();
        lock_down_file(&p).unwrap();
        let acl = crate::sys::path_acl(&p).unwrap();
        assert!(acl.protected, "inheritance must be removed");
        let mut sids: Vec<_> = acl.aces.iter().map(|a| a.sid.as_str()).collect();
        sids.sort();
        assert_eq!(sids, ["S-1-5-18", "S-1-5-32-544"], "no Gateway, no Users, no creator");
    }

    #[test]
    fn a_failing_prepare_step_keeps_the_target_and_leaves_no_temp_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::write(&p, b"old").unwrap();
        let r = write_atomic_prepared(&p, b"new", &|_| Err(std::io::Error::other("no")));
        assert!(r.is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
        let seen = std::cell::Cell::new(false);
        write_atomic_prepared(&p, b"new", &|t| { seen.set(t != p && std::fs::read(t).unwrap() == b"new"); Ok(()) }).unwrap();
        assert!(seen.get(), "prepare sees the finished temp file, not the target");
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
    }

    #[test]
    fn free_bytes_of_the_temp_dir_is_positive() {
        assert!(free_bytes(&std::env::temp_dir()).unwrap() > 0);
    }
}
