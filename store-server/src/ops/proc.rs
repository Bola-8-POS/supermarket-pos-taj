//! Run a child with a timeout, output to files (no pipe deadlock), and a short stderr tail for the error message.
//! It never logs the command line (argv may name a database or a path); callers redact before they log.
use crate::ops::outcome::OpError;
use crate::ops::world::R;
use std::fs::File;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ProcResult { pub code: Option<i32>, pub timed_out: bool, pub stderr_tail: String }

pub fn run_with_timeout(cmd: Command, log_prefix: &Path, timeout: Duration) -> R<ProcResult> { run_inner(cmd, log_prefix, timeout, true) }

/// Like `run_with_timeout` but stdout goes nowhere: for a child whose output is a config full of keys.
pub fn run_stderr_only(cmd: Command, log_prefix: &Path, timeout: Duration) -> R<ProcResult> { run_inner(cmd, log_prefix, timeout, false) }

fn run_inner(mut cmd: Command, log_prefix: &Path, timeout: Duration, keep_stdout: bool) -> R<ProcResult> {
    if let Some(dir) = log_prefix.parent() { let _ = std::fs::create_dir_all(dir); }
    let out_p = log_prefix.with_extension("out.log");
    let err_p = log_prefix.with_extension("err.log");
    let io = |e: std::io::Error| OpError::err("PROC_IO", e.to_string());
    let out: Stdio = if keep_stdout { Stdio::from(File::create(&out_p).map_err(io)?) } else { Stdio::null() };
    cmd.stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::from(File::create(&err_p).map_err(io)?));
    let mut child = cmd.spawn().map_err(io)?;
    let started = Instant::now();
    let tail = || {
        let s = std::fs::read_to_string(&err_p).unwrap_or_default();
        let t: Vec<&str> = s.lines().rev().take(12).collect();
        t.into_iter().rev().collect::<Vec<_>>().join(" | ")
    };
    loop {
        match child.try_wait().map_err(io)? {
            Some(st) => return Ok(ProcResult { code: st.code(), timed_out: false, stderr_tail: tail() }),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(ProcResult { code: None, timed_out: true, stderr_tail: tail() });
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn exit_code_and_stderr_tail_are_returned() {
        let d = tempfile::tempdir().unwrap();
        let mut c = Command::new("cmd"); c.args(["/c", "echo boom 1>&2 & exit 3"]);
        let r = run_with_timeout(c, &d.path().join("t"), Duration::from_secs(10)).unwrap();
        assert_eq!((r.code, r.timed_out), (Some(3), false));
        assert!(r.stderr_tail.contains("boom"));
    }

    #[test]
    fn a_child_that_outlives_the_timeout_is_killed() {
        let d = tempfile::tempdir().unwrap();
        let mut c = Command::new("cmd"); c.args(["/c", "ping -n 30 127.0.0.1 >nul"]);
        let r = run_with_timeout(c, &d.path().join("t"), Duration::from_millis(600)).unwrap();
        assert!(r.timed_out);
    }
}
