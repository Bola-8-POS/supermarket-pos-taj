//! The llama-server child: where it lives, how its argv is built, how it is started and waited for.
//!
//! The POS app (not a service) starts it, per user, from the verified install dir only. Rust fixes the argv: loopback
//! host, OS-chosen port, `--offline --no-webui -np 1`, and only allow-listed flags from the signed manifest. The
//! per-launch key goes in the child's environment, never in argv. Real spawn and listener behaviour is proven in
//! Windows Sandbox (Plan 29-04); the functions here are pure or take their effects as parameters.

use super::manifest::{Manifest, Profile};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const INSTALL_DIR_NAME: &str = "Supermarket POS Assistant";
const HEALTH_WAIT: Duration = Duration::from_secs(60);

/// Manifest flags that take a value / take none. Everything else (`--tools`, `--agent`, `--host`, `--port`,
/// `--api-key`, `-hf`, `--hf-repo`, `--model-url`, `--webui`, ...) is refused. `--threads`, `--ctx-size` and
/// `--sleep-idle-seconds` come from the manifest profile, not from this list.
const VALUE_FLAGS: [&str; 4] = ["--n-predict", "--prio", "--reasoning", "--reasoning-budget"];
const SWITCH_FLAGS: [&str; 2] = ["--no-slots", "--no-warmup"];

/// Where the add-on installs. `None` off Windows. In debug builds `POS_ASSISTANT_DIR` overrides it for local dev (no
/// Program Files trust check then, the caller sees `vet == false`).
pub struct InstallLocation {
    pub dir: PathBuf,
    /// Run the Program Files / owner / reparse checks. False only for the debug override.
    pub vet: bool,
}

#[cfg(windows)]
pub fn install_dir() -> Option<InstallLocation> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("POS_ASSISTANT_DIR").filter(|v| !v.is_empty()) {
        return Some(InstallLocation { dir: PathBuf::from(dir), vet: false });
    }
    Some(InstallLocation { dir: crate::commands::posctl_console::known_program_files()?.join(INSTALL_DIR_NAME), vet: true })
}
#[cfg(not(windows))]
pub fn install_dir() -> Option<InstallLocation> {
    None
}

type OwnerOf<'a> = &'a dyn Fn(&Path) -> Result<String, String>;
type PathTest<'a> = &'a dyn Fn(&Path) -> bool;

/// The same trust rule `posctl_open_console` applies before an elevated launch, for a process that is not elevated:
/// the install dir is strictly inside Program Files, on a fixed drive, is not a link, and the dir, the manifest and
/// the server binary are owned by Administrators or SYSTEM. Read-only; returns a reason code.
pub fn check_trusted(dir: &Path, program_files: &Path, owner_of: OwnerOf, is_link: PathTest, is_fixed: PathTest) -> Result<(), &'static str> {
    if !crate::commands::posctl_console::is_under_program_files(dir, program_files) {
        return Err("UNTRUSTED_PATH");
    }
    crate::vet_base(dir, is_fixed).map_err(|_| "UNTRUSTED_PATH")?;
    let probes = [dir.to_path_buf(), dir.join("manifest.json"), dir.join(super::manifest::RUNTIME_EXE)];
    // checked before anything that follows links
    if probes.iter().any(|p| is_link(p)) {
        return Err("UNTRUSTED_PATH");
    }
    let owners: Vec<_> = probes.iter().map(|p| owner_of(p)).collect();
    if !crate::owners_trusted(&owners) {
        return Err("UNTRUSTED_OWNER");
    }
    Ok(())
}

/// Binds 127.0.0.1:0 and returns the port the OS picked.
/// ponytail: the port is released before the child binds it; a local process could race for it, but it would then
/// lack the per-launch key. If the child fails to bind, start-up reports `unavailable` and the next launch retries.
pub fn pick_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// 256 bits from the OS CSPRNG (uuid v4), hex.
pub fn new_key() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// `min(profile.threads_max, max(1, logical_cpus / 2))`.
pub fn thread_count(threads_max: u32, logical_cpus: u32) -> u32 {
    threads_max.min((logical_cpus / 2).max(1))
}

/// The server's argv. `Err("MANIFEST_INVALID")` if the manifest asks for anything outside the allow-list.
pub fn build_args(manifest: &Manifest, port: u16, model_path: &Path, logical_cpus: u32) -> Result<Vec<String>, &'static str> {
    let mut args: Vec<String> = vec![
        "--model".into(),
        model_path.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--offline".into(),
        "--no-webui".into(),
        "-np".into(),
        "1".into(),
        "--threads".into(),
        thread_count(manifest.profile.threads_max, logical_cpus).to_string(),
        "--ctx-size".into(),
        manifest.profile.ctx_size.to_string(),
        "--sleep-idle-seconds".into(),
        manifest.profile.sleep_idle_seconds.to_string(),
    ];
    let mut it = manifest.server_args.iter();
    while let Some(flag) = it.next() {
        if SWITCH_FLAGS.contains(&flag.as_str()) {
            args.push(flag.clone());
        } else if VALUE_FLAGS.contains(&flag.as_str()) {
            // a value is never itself a flag-looking `--x` token (a negative number such as `-1` is fine)
            match it.next() {
                Some(v) if !v.starts_with("--") && !v.is_empty() => args.extend([flag.clone(), v.clone()]),
                _ => return Err("MANIFEST_INVALID"),
            }
        } else {
            return Err("MANIFEST_INVALID");
        }
    }
    Ok(args)
}

/// Per-process limits applied through a Job Object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobLimits {
    pub kill_on_close: bool,
    pub process_memory_bytes: u64,
    pub below_normal_priority: bool,
    /// Hard CPU cap in 1/100 of a percent (50 % = 5000), the unit of `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`.
    pub cpu_rate_hard_cap: u32,
}

/// Kill-on-close, process memory limit, BELOW_NORMAL priority and a CPU hard cap (percent * 100), from the profile.
pub fn job_limits_from(p: &Profile) -> JobLimits {
    JobLimits {
        kill_on_close: true,
        process_memory_bytes: p.process_memory_limit_bytes,
        below_normal_priority: true,
        cpu_rate_hard_cap: p.cpu_rate_percent.clamp(1, 100) * 100,
    }
}

/// True when available physical memory is below the profile's floor. An unreadable value counts as no pressure.
/// ponytail: GlobalMemoryStatusEx practically cannot fail; if it ever does, the Job's memory cap still bounds the child.
pub fn pressure(avail_bytes: Option<u64>, p: &Profile) -> bool {
    avail_bytes.is_some_and(|a| a < p.min_available_memory_bytes)
}

/// Available physical memory now (`GlobalMemoryStatusEx`); None off Windows or on failure.
#[cfg(windows)]
pub fn available_memory_bytes() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut s = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `s` is a valid MEMORYSTATUSEX with dwLength set, as the API requires.
    unsafe { GlobalMemoryStatusEx(&mut s) }.ok().map(|()| s.ullAvailPhys)
}
#[cfg(not(windows))]
pub fn available_memory_bytes() -> Option<u64> {
    None
}

/// What one /health result means for the periodic status check: the new consecutive-failure count and whether the
/// server is now considered dead (3 in a row). There is no automatic restart.
pub fn next_health(failures: u32, ok: bool) -> (u32, bool) {
    if ok {
        (0, false)
    } else {
        (failures + 1, failures + 1 >= 3)
    }
}

#[cfg(windows)]
pub use job::Job;

#[cfg(windows)]
mod job {
    use super::JobLimits;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS;

    /// A Job Object holding the server. The handle lives as long as the app, so exiting the app (or a crash) closes it
    /// and KILL_ON_JOB_CLOSE ends the child. Never a kill by image name.
    pub struct Job(HANDLE);

    // SAFETY: a Job Object handle is a kernel handle usable from any thread; it is only closed in Drop.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new(limits: &JobLimits) -> Result<Job, String> {
            // SAFETY: plain Win32 calls on a handle we own (closed in Drop); the info structs are fully initialised locals.
            unsafe {
                let h = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
                let job = Job(h);
                let mut flags = JOB_OBJECT_LIMIT(0);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                if limits.kill_on_close {
                    flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                }
                if limits.process_memory_bytes > 0 {
                    flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                    info.ProcessMemoryLimit = usize::try_from(limits.process_memory_bytes).unwrap_or(usize::MAX);
                }
                if limits.below_normal_priority {
                    flags |= JOB_OBJECT_LIMIT_PRIORITY_CLASS;
                    info.BasicLimitInformation.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS.0;
                }
                info.BasicLimitInformation.LimitFlags = flags;
                SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
                    .map_err(|e| format!("SetInformationJobObject(limits) failed: {e}"))?;
                let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                    ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    ..Default::default()
                };
                cpu.Anonymous.CpuRate = limits.cpu_rate_hard_cap;
                SetInformationJobObject(job.0, JobObjectCpuRateControlInformation, &cpu as *const _ as *const _, std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32)
                    .map_err(|e| format!("SetInformationJobObject(cpu) failed: {e}"))?;
                Ok(job)
            }
        }

        /// ponytail: assigned right after spawn, so the child runs uncapped for a few microseconds before the Job takes
        /// hold (it is only starting to load a model). Upgrade: CREATE_SUSPENDED, assign, then resume the main thread.
        pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
            // SAFETY: the child's process handle is valid while `child` is borrowed.
            unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())).map_err(|e| format!("AssignProcessToJobObject failed: {e}")) }
        }
    }

    impl Job {
        /// The limits the OS holds for this Job (`QueryInformationJobObject`), not the ones we asked for. Used by the
        /// Sandbox probe (Plan 29-04) to prove the caps took effect.
        pub fn read_back(&self) -> Result<JobLimits, String> {
            // SAFETY: plain Win32 queries on our own handle into fully initialised locals of the exact struct size.
            unsafe {
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                QueryInformationJobObject(Some(self.0), JobObjectExtendedLimitInformation, &mut info as *mut _ as *mut _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32, None)
                    .map_err(|e| format!("QueryInformationJobObject(limits) failed: {e}"))?;
                let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
                QueryInformationJobObject(Some(self.0), JobObjectCpuRateControlInformation, &mut cpu as *mut _ as *mut _, std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32, None)
                    .map_err(|e| format!("QueryInformationJobObject(cpu) failed: {e}"))?;
                let flags = info.BasicLimitInformation.LimitFlags;
                let hard_cap = cpu.ControlFlags.0 & (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE.0 | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP.0) == (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE.0 | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP.0);
                Ok(JobLimits {
                    kill_on_close: flags.0 & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 != 0,
                    process_memory_bytes: if flags.0 & JOB_OBJECT_LIMIT_PROCESS_MEMORY.0 != 0 { info.ProcessMemoryLimit as u64 } else { 0 },
                    below_normal_priority: flags.0 & JOB_OBJECT_LIMIT_PRIORITY_CLASS.0 != 0 && info.BasicLimitInformation.PriorityClass == BELOW_NORMAL_PRIORITY_CLASS.0,
                    // ponytail: the union member is only meaningful when the hard-cap flags are set; 0 otherwise
                    cpu_rate_hard_cap: if hard_cap { cpu.Anonymous.CpuRate } else { 0 },
                })
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle once; KILL_ON_JOB_CLOSE ends any survivors.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

pub struct Spawned {
    pub child: Child,
    /// Keep for the app's lifetime: dropping it closes the Job, which kills the child.
    #[cfg(windows)]
    pub job: Option<Job>,
}

/// Starts `exe` with `args` and `env`. stdout, stderr and stdin are discarded (no prompt text ever reaches a log).
/// Used by the assistant start-up and by the Sandbox probe (Plan 29-04).
pub fn spawn_with_args(exe: &Path, args: &[String], env: &[(&str, &str)], limits: Option<&JobLimits>) -> Result<Spawned, String> {
    // The Job is created before the spawn so a failure here never leaves an uncapped child behind.
    #[cfg(windows)]
    let job = limits.map(Job::new).transpose()?;
    #[cfg(not(windows))]
    if limits.is_some() {
        return Err("job limits need Windows".to_string());
    }
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    #[cfg(windows)]
    if let Some(j) = &job {
        if let Err(e) = j.assign(&child) {
            let _ = child.kill(); // our own child handle, never by name
            return Err(e);
        }
    }
    Ok(Spawned {
        child,
        #[cfg(windows)]
        job,
    })
}

/// Polls `GET /health` until 200, the child exits, or `total` passes.
pub fn wait_healthy(client: &reqwest::Client, port: u16, child: &mut Child, total: Duration) -> Result<(), &'static str> {
    let deadline = Instant::now() + total;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Err("EXITED");
        }
        if health_ok(client, port) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("START_TIMEOUT");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `GET /health` answers 200 within 2 s.
pub async fn health_ok_async(client: &reqwest::Client, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    client.get(url).timeout(Duration::from_secs(2)).send().await.map(|r| r.status().as_u16() == 200).unwrap_or(false)
}

fn health_ok(client: &reqwest::Client, port: u16) -> bool {
    tauri::async_runtime::block_on(health_ok_async(client, port))
}

pub fn health_wait_default() -> Duration {
    HEALTH_WAIT
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::assistant::manifest::{fixtures, Manifest};

    fn manifest_with(args: &[&str]) -> Manifest {
        let mut m: Manifest = serde_json::from_str(fixtures::MANIFEST).unwrap();
        m.server_args = args.iter().map(|s| s.to_string()).collect();
        m
    }
    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn build_args_pins_loopback_offline_and_one_slot() {
        let m = manifest_with(&["--n-predict", "160", "--prio", "-1", "--no-slots"]);
        let a = build_args(&m, 4242, Path::new("C:/x/m.gguf"), 8).unwrap();
        assert_eq!(&a[..10], ["--model", "C:/x/m.gguf", "--host", "127.0.0.1", "--port", "4242", "--offline", "--no-webui", "-np", "1"]);
        assert!(has_pair(&a, "--threads", "4"));
        assert!(has_pair(&a, "--ctx-size", "2048"));
        assert!(has_pair(&a, "--sleep-idle-seconds", "300"));
        assert!(has_pair(&a, "--prio", "-1"), "a negative number is a value, not a flag");
        assert!(a.contains(&"--no-slots".to_string()));
        assert_eq!(a.iter().filter(|s| *s == "--host").count(), 1);
    }

    #[test]
    fn build_args_refuses_tool_runtime() {
        for bad in ["--tools", "--agent", "--host", "--port", "--api-key", "--hf-repo", "-hf", "--model-url", "--webui", "--unknown"] {
            assert_eq!(build_args(&manifest_with(&[bad]), 1, Path::new("m"), 4), Err("MANIFEST_INVALID"), "{bad}");
            assert_eq!(build_args(&manifest_with(&["--n-predict", "160", bad, "x"]), 1, Path::new("m"), 4), Err("MANIFEST_INVALID"), "{bad} after a valid flag");
        }
    }

    #[test]
    fn build_args_refuses_a_missing_or_flag_shaped_value() {
        assert_eq!(build_args(&manifest_with(&["--n-predict"]), 1, Path::new("m"), 4), Err("MANIFEST_INVALID"));
        assert_eq!(build_args(&manifest_with(&["--n-predict", "--tools"]), 1, Path::new("m"), 4), Err("MANIFEST_INVALID"));
        assert_eq!(build_args(&manifest_with(&["160"]), 1, Path::new("m"), 4), Err("MANIFEST_INVALID"), "a bare value without its flag");
    }

    #[test]
    fn thread_count_is_half_the_cores_capped() {
        assert_eq!(thread_count(4, 8), 4);
        assert_eq!(thread_count(4, 4), 2);
        assert_eq!(thread_count(4, 2), 1);
        assert_eq!(thread_count(4, 1), 1);
        assert_eq!(thread_count(2, 64), 2);
    }

    #[test]
    fn pick_port_returns_a_loopback_bindable_port() {
        let p = pick_port().unwrap();
        assert!(p > 0);
        assert!(std::net::TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn per_launch_keys_are_long_and_distinct() {
        let (a, b) = (new_key(), new_key());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    fn profile() -> Profile {
        serde_json::from_str::<Manifest>(fixtures::MANIFEST).unwrap().profile
    }

    #[test]
    fn job_limits_from_the_profile() {
        let l = job_limits_from(&profile());
        assert_eq!(l, JobLimits { kill_on_close: true, process_memory_bytes: 1_400_000_000, below_normal_priority: true, cpu_rate_hard_cap: 5000 });
    }

    /// A Job with nothing assigned is host-safe: it only asks the OS what it holds.
    #[cfg(windows)]
    #[test]
    fn job_read_back_returns_what_was_set() {
        let want = job_limits_from(&profile());
        let got = Job::new(&want).unwrap().read_back().unwrap();
        // the OS rounds the memory limit down to a 4 KiB page (1_400_000_000 reads back as 1_399_996_416)
        assert!(want.process_memory_bytes - got.process_memory_bytes < 4096, "got {}", got.process_memory_bytes);
        assert_eq!(JobLimits { process_memory_bytes: want.process_memory_bytes, ..got }, want);
    }

    #[test]
    fn job_cpu_cap_is_clamped_to_1_through_100_percent() {
        let mut p = profile();
        p.cpu_rate_percent = 0;
        assert_eq!(job_limits_from(&p).cpu_rate_hard_cap, 100, "0 would disable the cap; the floor is 1 %");
        p.cpu_rate_percent = 250;
        assert_eq!(job_limits_from(&p).cpu_rate_hard_cap, 10_000);
    }

    #[test]
    fn pressure_is_true_below_the_floor_only() {
        let p = profile();
        assert!(pressure(Some(p.min_available_memory_bytes - 1), &p));
        assert!(!pressure(Some(p.min_available_memory_bytes), &p));
        assert!(!pressure(Some(u64::MAX), &p));
        assert!(!pressure(None, &p), "an unreadable value is not treated as pressure");
    }

    #[test]
    fn three_consecutive_health_failures_kill_the_verdict_and_a_success_resets() {
        assert_eq!(next_health(0, false), (1, false));
        assert_eq!(next_health(1, false), (2, false));
        assert_eq!(next_health(2, false), (3, true));
        assert_eq!(next_health(2, true), (0, false));
    }

    fn pf() -> &'static Path {
        Path::new(r"C:\Program Files")
    }
    const ADMIN: &str = "S-1-5-32-544";
    const USER: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn check_trusted_accepts_only_a_vetted_program_files_dir() {
        let dir = Path::new(r"C:\Program Files\Supermarket POS Assistant");
        let admin = |_: &Path| Ok(ADMIN.to_string());
        let ok = |_: &Path| true;
        let no = |_: &Path| false;
        assert_eq!(check_trusted(dir, pf(), &admin, &no, &ok), Ok(()));
        // outside Program Files, including a sibling that merely shares the prefix
        assert_eq!(check_trusted(Path::new(r"C:\Users\x\assistant"), pf(), &admin, &no, &ok), Err("UNTRUSTED_PATH"));
        assert_eq!(check_trusted(Path::new(r"C:\Program Files Evil\a"), pf(), &admin, &no, &ok), Err("UNTRUSTED_PATH"));
        // not a fixed drive, or a link anywhere on the probe list
        assert_eq!(check_trusted(dir, pf(), &admin, &no, &no), Err("UNTRUSTED_PATH"));
        assert_eq!(check_trusted(dir, pf(), &admin, &ok, &ok), Err("UNTRUSTED_PATH"));
        // owned by a standard user
        let user = |_: &Path| Ok(USER.to_string());
        assert_eq!(check_trusted(dir, pf(), &user, &no, &ok), Err("UNTRUSTED_OWNER"));
        let unreadable = |_: &Path| Err("denied".to_string());
        assert_eq!(check_trusted(dir, pf(), &unreadable, &no, &ok), Err("UNTRUSTED_OWNER"));
    }
}
