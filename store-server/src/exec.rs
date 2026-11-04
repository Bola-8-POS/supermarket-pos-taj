//! Running external tools (`icacls`, `sc.exe`, `psql`, `auth.exe`, `supabase.exe`, ...) with
//! three guarantees: secrets only ever travel on stdin or in an env var of the child (never in
//! argv), the call can never hang forever (timeout kills the process tree, via a Job Object), and
//! no console window flashes up under the Task Scheduler. posctl runs elevated, so the child also
//! gets a cleared environment (a small allowlist plus explicit `Cmd::env` pairs) and the program
//! must be an absolute path: nothing is resolved through `PATH` or the current directory.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ToolOutput {
    pub fn success(&self) -> bool {
        self.code == 0
    }
    pub fn text(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

#[derive(Debug)]
pub enum ExecError {
    Spawn { exe: String, why: String },
    Timeout { exe: String, after: Duration },
    Io(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::Spawn { exe, why } => write!(f, "could not start {exe}: {why}"),
            ExecError::Timeout { exe, after } => write!(f, "{exe} did not finish within {}ms and was stopped", after.as_millis()),
            ExecError::Io(e) => write!(f, "I/O error while running a tool: {e}"),
        }
    }
}

impl std::error::Error for ExecError {}

/// Scheduling class of a child. `Normal` is what every existing caller gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Priority {
    #[default]
    Normal,
    /// BELOW_NORMAL_PRIORITY_CLASS: maintenance (verify, prune) must not slow the till down.
    BelowNormal,
}

#[derive(Clone)]
pub struct Cmd {
    priority: Priority,
    exe: PathBuf,
    args: Vec<OsString>,
    stdin: Option<Vec<u8>>,
    env: Vec<(String, String)>,
    env_remove: Vec<String>,
    cwd: Option<PathBuf>,
    timeout: Duration,
}

/// Never prints env values, stdin bytes or argv-hidden data: only what is safe in a log.
impl std::fmt::Debug for Cmd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cmd")
            .field("exe", &self.exe)
            .field("args", &self.args)
            .field("env_keys", &self.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>())
            .field("env_remove", &self.env_remove)
            .field("stdin_len", &self.stdin.as_ref().map(Vec::len))
            .field("cwd", &self.cwd)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// The only variables a child inherits: system locations from the API (never the caller's
/// environment, which an invoking user controls). A tool that needs more adds it with `Cmd::env`.
pub(crate) fn base_env() -> Result<Vec<(&'static str, String)>, String> {
    use crate::sys::{known_folder, system_dir, KnownFolder};
    let windows = known_folder(KnownFolder::Windows)?;
    let system = system_dir()?;
    let drive: String = windows.display().to_string().chars().take(2).collect();
    Ok(vec![
        ("SystemRoot", windows.display().to_string()),
        ("windir", windows.display().to_string()),
        ("SystemDrive", drive),
        ("ComSpec", system.join("cmd.exe").display().to_string()),
        ("PATH", system.display().to_string()),
        ("TEMP", windows.join("Temp").display().to_string()),
        ("TMP", windows.join("Temp").display().to_string()),
    ])
}

impl Cmd {
    pub fn new(exe: impl AsRef<Path>) -> Self {
        Cmd {
            priority: Priority::Normal,
            exe: exe.as_ref().to_path_buf(),
            args: Vec::new(),
            stdin: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: None,
            timeout: Duration::from_secs(120),
        }
    }
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
    /// Bytes fed to the child's stdin, then stdin is closed.
    pub fn stdin(mut self, bytes: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(bytes.into());
        self
    }
    pub fn env(mut self, k: &str, v: &str) -> Self {
        self.env.push((k.to_string(), v.to_string()));
        self
    }
    pub fn env_remove(mut self, k: &str) -> Self {
        self.env_remove.push(k.to_string());
        self
    }
    /// review fix: remove several variables at once (used with `pg::PG_ENV_TO_CLEAR`).
    pub fn env_remove_all(mut self, ks: &[&str]) -> Self {
        self.env_remove.extend(ks.iter().map(|k| k.to_string()));
        self
    }
    pub fn cwd(mut self, p: impl AsRef<Path>) -> Self {
        self.cwd = Some(p.as_ref().to_path_buf());
        self
    }
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }
    pub fn priority(mut self, p: Priority) -> Self {
        self.priority = p;
        self
    }

    /// Windows process creation flags: no console window, plus the priority class. Pure, so it is tested on the host.
    pub(crate) fn creation_flags(&self) -> u32 {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        // ponytail: only the priority CLASS. Background I/O priority (PROCESS_MODE_BACKGROUND_BEGIN) can only be set by a
        // process on itself, so the parent cannot request it at creation; a child that wants it must ask for it.
        CREATE_NO_WINDOW
            | match self.priority {
                Priority::Normal => 0,
                Priority::BelowNormal => BELOW_NORMAL_PRIORITY_CLASS,
            }
    }

    pub fn run(self) -> Result<ToolOutput, ExecError> {
        let exe_name = self.exe.display().to_string();
        let spawn_err = |why: String| ExecError::Spawn { exe: exe_name.clone(), why };
        if !self.exe.is_absolute() {
            return Err(spawn_err("the program path must be absolute".into()));
        }
        let mut c = Command::new(&self.exe);
        c.args(&self.args)
            .stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        for (k, v) in base_env().map_err(&spawn_err)? {
            c.env(k, v);
        }
        for (k, v) in &self.env {
            c.env(k, v);
        }
        for k in &self.env_remove {
            c.env_remove(k);
        }
        if let Some(d) = &self.cwd {
            c.current_dir(d);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(self.creation_flags());
        }
        let job = crate::sys::Job::new().map_err(&spawn_err)?;
        let mut child = c.spawn().map_err(|e| spawn_err(e.to_string()))?;
        // ponytail: assigned just after spawn, so a grandchild forked in that instant escapes; closing it needs CREATE_SUSPENDED + resume.
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(spawn_err(e));
        }

        let (done_tx, done_rx) = mpsc::channel::<()>();
        let stdin_done = self.stdin.map(|bytes| {
            let mut pipe = child.stdin.take().expect("stdin was piped");
            let tx = done_tx.clone();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
                drop(pipe); // closes stdin
                let _ = tx.send(());
            });
        });
        let mut out_pipe = child.stdout.take().expect("stdout was piped");
        let mut err_pipe = child.stderr.take().expect("stderr was piped");
        let (out_tx, out_rx) = mpsc::channel();
        let (err_tx, err_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = out_pipe.read_to_end(&mut b);
            let _ = out_tx.send(b);
        });
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = err_pipe.read_to_end(&mut b);
            let _ = err_tx.send(b);
        });
        drop(done_tx);

        let timed_out = |job: &crate::sys::Job, child: &mut std::process::Child| {
            job.kill();
            let _ = child.kill();
            let _ = child.wait();
            ExecError::Timeout { exe: exe_name.clone(), after: self.timeout }
        };
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        return Err(timed_out(&job, &mut child));
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => {
                    job.kill();
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ExecError::Io(e.to_string()));
                }
            }
        };
        // The child is gone, but a grandchild may still hold a pipe: every wait below is bounded by the same deadline.
        let left = || deadline.saturating_duration_since(Instant::now());
        if stdin_done.is_some() && done_rx.recv_timeout(left()).is_err() {
            return Err(timed_out(&job, &mut child));
        }
        let Ok(stdout) = out_rx.recv_timeout(left()) else { return Err(timed_out(&job, &mut child)) };
        let Ok(stderr) = err_rx.recv_timeout(left()) else { return Err(timed_out(&job, &mut child)) };
        Ok(ToolOutput {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn sys32(name: &str) -> PathBuf {
        crate::sys::system_dir().unwrap().join(name)
    }
    fn cmd_exe() -> PathBuf {
        sys32("cmd.exe")
    }

    #[test]
    fn the_creation_flags_add_the_priority_class_and_change_nothing_by_default() {
        const NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL: u32 = 0x0000_4000;
        assert_eq!(Cmd::new(cmd_exe()).creation_flags(), NO_WINDOW, "existing callers are unchanged");
        assert_eq!(Cmd::new(cmd_exe()).priority(Priority::Normal).creation_flags(), NO_WINDOW);
        assert_eq!(Cmd::new(cmd_exe()).priority(Priority::BelowNormal).creation_flags(), NO_WINDOW | BELOW_NORMAL);
    }

    fn pid_alive(pid: u32) -> bool {
        let o = std::process::Command::new(sys32("tasklist.exe"))
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())
    }

    #[test]
    fn captures_stdout_and_the_exit_code() {
        let o = Cmd::new(cmd_exe()).args(["/c", "echo hello & exit 3"]).run().unwrap();
        assert_eq!(o.code, 3);
        assert!(o.stdout.contains("hello"));
    }

    #[test]
    fn feeds_stdin_and_closes_it() {
        let o = Cmd::new(sys32("findstr.exe")).args(["x"]).stdin("axb\nnope\n").run().unwrap();
        assert_eq!(o.code, 0);
        assert!(o.stdout.contains("axb") && !o.stdout.contains("nope"));
    }

    #[test]
    fn passes_env_to_the_child_only() {
        let o = Cmd::new(cmd_exe()).args(["/c", "echo %POSCTL_TEST_VAR%"]).env("POSCTL_TEST_VAR", "from-parent").run().unwrap();
        assert!(o.stdout.contains("from-parent"));
        assert!(std::env::var("POSCTL_TEST_VAR").is_err());
    }

    #[test]
    fn the_child_environment_is_an_allowlist() {
        let saved = std::env::var_os("POSCTL_INHERIT_MARKER");
        std::env::set_var("POSCTL_INHERIT_MARKER", "leaked");
        let o = Cmd::new(cmd_exe()).args(["/c", "set"]).env("POSCTL_EXPLICIT", "yes").run().unwrap();
        match saved {
            Some(v) => std::env::set_var("POSCTL_INHERIT_MARKER", v),
            None => std::env::remove_var("POSCTL_INHERIT_MARKER"),
        }
        let text = o.stdout.to_lowercase();
        assert!(!text.contains("posctl_inherit_marker"), "{text}");
        assert!(text.contains("systemroot=") && text.contains("posctl_explicit=yes"), "{text}");
    }

    #[test]
    fn a_hung_tool_is_killed_at_the_timeout() {
        let r = Cmd::new(cmd_exe()).args(["/c", "ping -n 20 127.0.0.1 >nul"]).timeout(Duration::from_millis(400)).run();
        assert!(matches!(r, Err(ExecError::Timeout { .. })));
    }

    #[test]
    fn the_timeout_kills_the_grandchildren_too() {
        let t = tempfile::tempdir().unwrap();
        let pid_file = t.path().join("pid.txt");
        let script = format!(
            "$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','60','127.0.0.1'; $p.Id | Out-File -Encoding ascii '{}'; Start-Sleep 60",
            pid_file.display()
        );
        let started = Instant::now();
        let r = Cmd::new(sys32("WindowsPowerShell/v1.0/powershell.exe"))
            .args(["-NoProfile", "-Command", &script])
            .timeout(Duration::from_secs(5))
            .run();
        assert!(matches!(r, Err(ExecError::Timeout { .. })));
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        let pid: u32 = std::fs::read_to_string(&pid_file).expect("grandchild never started").trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!pid_alive(pid), "grandchild {pid} survived the timeout");
    }

    #[test]
    fn a_grandchild_holding_stdout_cannot_hang_run() {
        let started = Instant::now();
        let r = Cmd::new(cmd_exe()).args(["/c", "start /b ping -n 60 127.0.0.1"]).timeout(Duration::from_secs(2)).run();
        assert!(matches!(r, Err(ExecError::Timeout { .. })));
        assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
    }

    #[test]
    fn a_relative_program_is_refused() {
        assert!(matches!(Cmd::new("findstr").run(), Err(ExecError::Spawn { .. })));
    }

    #[test]
    fn a_missing_program_is_a_spawn_error() {
        assert!(matches!(Cmd::new("C:/no/such/tool.exe").run(), Err(ExecError::Spawn { .. })));
    }

    #[test]
    fn the_timeout_message_is_in_milliseconds() {
        let e = ExecError::Timeout { exe: "x".into(), after: Duration::from_millis(400) };
        assert!(e.to_string().contains("400ms"), "{e}");
    }

    #[test]
    fn debug_shows_env_keys_and_stdin_length_but_never_values() {
        let c = Cmd::new(cmd_exe()).args(["/c", "x"]).env("DATABASE_URL", "value-hunter2").stdin("topsecret");
        let d = format!("{c:?}");
        assert!(d.contains("DATABASE_URL") && d.contains("cmd.exe") && d.contains('9'), "{d}");
        assert!(!d.contains("hunter2") && !d.contains("topsecret"), "{d}");
    }
}
