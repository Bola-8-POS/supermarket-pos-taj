//! Scheduled tasks (conventions 4.2), folder `\SupermarketPOS\`, principal SYSTEM, each running
//! `posctl.exe` from `$INSTDIR\posctl\`. Built as Task Scheduler XML (UTF-16 with a BOM: verified,
//! `schtasks /Create /XML` rejects a UTF-8 file that declares UTF-8) and registered with
//! `schtasks.exe`, so the app update only has to re-run `tasks install` for the action path to
//! follow the new install folder. Plan 05 owns `Health` and `Canary`; every other plan appends
//! its task to `all_tasks()` (one entry each).
//!
//! Locale: store PCs run es-MX Windows, so nothing here parses `schtasks` text. Existence is the
//! `/Query` exit code (0 = there, non-zero = not there or not readable) and failures are reported
//! by exit code; the tool's own (localized) text is only quoted in error messages.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::exec::{Cmd, ToolOutput};

pub const FOLDER: &str = "\\SupermarketPOS";

/// Names of tasks an earlier release registered and this one no longer defines: `install` deletes them
/// first and `remove` deletes them with the current ones.
pub const RETIRED: &[&str] = &[];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// Every N minutes, forever.
    EveryMinutes(u32),
    /// Daily at `HH:MM` local time.
    DailyAt(&'static str),
    /// Daily at this many minutes after local midnight: for a time derived from the configuration (the BackupVerify task
    /// follows the maintenance window), which cannot be a `&'static str`.
    DailyAtMinute(u32),
    /// At boot, after a delay of N minutes (0 = immediately).
    AtBoot { delay_minutes: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDef {
    pub name: &'static str,
    pub description: &'static str,
    pub triggers: Vec<Trigger>,
    pub args: &'static [&'static str],
    /// A second action of the same task, run after the first (empty = none). The scheduler runs a task's actions in order.
    pub then_args: &'static [&'static str],
    pub time_limit_minutes: u32,
    /// Run once when the PC was off at the trigger time. NOT for a task that must only run in its window (UpdateCheck).
    pub start_when_available: bool,
}

/// The single source of the product's scheduled tasks. Plans 07, 08, 12 append theirs here.
pub fn all_tasks() -> Vec<TaskDef> {
    let mut v = vec![
        TaskDef {
            name: "Health",
            description: "Writes the store server status file every minute",
            triggers: vec![Trigger::EveryMinutes(1)],
            args: &["health", "--write"],
            then_args: &[],
            time_limit_minutes: 5,
            start_when_available: true,
        },
        TaskDef {
            name: "Canary",
            description: "Proves the PIN lockout is active",
            triggers: vec![Trigger::DailyAt("03:00"), Trigger::AtBoot { delay_minutes: 3 }],
            args: &["health", "--canary", "--write"],
            then_args: &[],
            time_limit_minutes: 10,
            start_when_available: true,
        },
        // Plan 07: finish or undo an interrupted update at boot (no delay: the boot Canary skips while a journal exists).
        // the task's time limit is derived from the code's own timeouts (`update::limits`); `--scheduled` marks the run as unattended (a person types neither).
        TaskDef {
            name: "Recover",
            description: "Finishes or undoes an interrupted update, switch or restore",
            triggers: vec![Trigger::AtBoot { delay_minutes: 0 }],
            args: &["update", "--recover", "--quiet", "--scheduled"],
            then_args: &[],
            time_limit_minutes: crate::update::limits::RECOVER_LIMIT_MINUTES,
            start_when_available: true,
        },
        TaskDef {
            name: "UpdateCheck",
            description: "Updates the store server when a newer pack exists and the store is idle",
            // hourly: the maintenance WINDOW (posctl.json, default 01:00-05:00) decides when an update may start, so the trigger must
            // land inside any window the store configures; outside it the run only records a pending pack and exits
            triggers: vec![Trigger::EveryMinutes(60)],
            args: &["update", "--if-available", "--window-aware", "--quiet", "--scheduled"],
            then_args: &[],
            time_limit_minutes: crate::update::limits::UPDATE_CHECK_LIMIT_MINUTES,
            start_when_available: false,
        },
    ];
    // Plan 08: the backup tick and the daily verify + drill
    v.extend(crate::backup::backup_tasks::defs());
    v
}

pub fn full_name(t: &TaskDef) -> String {
    format!("{FOLDER}\\{}", t.name)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The task's `<Exec>` actions, in order. Arguments are plain words (a test pins that).
fn actions(t: &TaskDef, exe: &Path) -> String {
    let one = |args: &[&str]| format!("<Exec><Command>{}</Command><Arguments>{}</Arguments></Exec>", esc(&exe.display().to_string()), esc(&args.join(" ")));
    let mut out = one(t.args);
    if !t.then_args.is_empty() {
        out.push_str(&one(t.then_args));
    }
    out
}

fn trigger_xml(tr: &Trigger) -> String {
    match tr {
        Trigger::EveryMinutes(n) => format!(
            "<TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT{n}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>"
        ),
        Trigger::DailyAt(hhmm) => format!(
            "<CalendarTrigger><StartBoundary>2026-01-01T{hhmm}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
        ),
        Trigger::DailyAtMinute(m) => format!(
            "<CalendarTrigger><StartBoundary>2026-01-01T{:02}:{:02}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>",
            (m / 60) % 24,
            m % 60
        ),
        Trigger::AtBoot { delay_minutes: 0 } => "<BootTrigger><Enabled>true</Enabled></BootTrigger>".to_string(),
        Trigger::AtBoot { delay_minutes } => format!("<BootTrigger><Enabled>true</Enabled><Delay>PT{delay_minutes}M</Delay></BootTrigger>"),
    }
}

/// `principal_xml` is `SYSTEM_PRINCIPAL` in production; the sandbox test substitutes the current user.
pub const SYSTEM_PRINCIPAL: &str = "<Principal id=\"Author\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>";

pub fn task_xml(t: &TaskDef, exe: &Path, principal_xml: &str) -> String {
    let triggers: String = t.triggers.iter().map(trigger_xml).collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n  <RegistrationInfo><Description>{}</Description></RegistrationInfo>\n  <Triggers>{}</Triggers>\n  <Principals>{}</Principals>\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>{}</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Hidden>true</Hidden><ExecutionTimeLimit>PT{}M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>\n  <Actions Context=\"Author\">{}</Actions>\n</Task>\n",
        esc(t.description),
        triggers,
        principal_xml,
        t.start_when_available,
        t.time_limit_minutes,
        actions(t, exe)
    )
}

/// UTF-16LE with a byte-order mark: the encoding `schtasks /XML` accepts.
pub fn to_utf16le_bom(xml: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in xml.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

pub fn create_args(task_name: &str, xml_path: &Path) -> Vec<String> {
    ["/Create", "/TN", task_name, "/XML", &xml_path.display().to_string(), "/F"].map(String::from).to_vec()
}
pub fn delete_args(task_name: &str) -> Vec<String> {
    ["/Delete", "/TN", task_name, "/F"].map(String::from).to_vec()
}
/// Only the exit code of this query is used (locale-independent); CSV/NH just keeps the output small.
pub fn query_args(task_name: &str) -> Vec<String> {
    ["/Query", "/TN", task_name, "/FO", "CSV", "/NH"].map(String::from).to_vec()
}

fn schtasks() -> Result<PathBuf, String> {
    Ok(crate::sys::system_dir()?.join("schtasks.exe")) // from the API, never %SystemRoot%
}

/// The real `schtasks.exe`. The `*_via` functions take the runner so the logic is testable without a Task Scheduler.
fn run(args: Vec<String>) -> Result<ToolOutput, String> {
    Cmd::new(schtasks()?).args(args).timeout(Duration::from_secs(60)).run().map_err(|e| e.to_string())
}

type Runner<'a> = &'a dyn Fn(Vec<String>) -> Result<ToolOutput, String>;
/// Judges one path: `Ok(None)` = missing, `Ok(Some(is_dir))` = exists and passed the reparse/owner check.
type Inspect<'a> = &'a dyn Fn(&Path) -> Result<Option<bool>, String>;
/// Decides whether `posctl.exe` may be run as SYSTEM. Production: `production_exe_trust`. Only tests pass anything else.
pub(crate) type ExeTrust<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

fn need_elevation(elevated: bool, what: &str) -> Result<(), String> {
    if elevated {
        Ok(())
    } else {
        Err(format!("{what} the scheduled tasks needs an elevated (Administrator) shell: without it the Task Scheduler cannot be read or changed"))
    }
}

fn lower_parts(p: &Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
}

/// The pure decision: the program is an absolute path with no `..`, inside Program Files, and both it and its
/// folder exist, are not links and are owned by a trusted account (`inspect`). The task runs it as SYSTEM, so a
/// user-writable program would be a privilege escalation.
fn exe_trust(exe: &Path, program_files: &Path, inspect: Inspect) -> Result<(), String> {
    if !exe.is_absolute() {
        return Err(format!("the scheduled tasks need an absolute posctl.exe path, got '{}'", exe.display()));
    }
    if exe.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("'{}' contains '..'; refusing to register it as a SYSTEM task", exe.display()));
    }
    let (e, pf) = (lower_parts(exe), lower_parts(program_files));
    if e.len() <= pf.len() || e[..pf.len()] != pf[..] {
        return Err(format!("posctl.exe must live under {} to run as SYSTEM, got '{}'", program_files.display(), exe.display()));
    }
    let parent = exe.parent().ok_or_else(|| format!("'{}' has no folder", exe.display()))?;
    for (p, want_dir) in [(parent, true), (exe, false)] {
        match inspect(p)? {
            Some(is_dir) if is_dir == want_dir => {}
            Some(_) => return Err(format!("{} is not the kind of item expected", p.display())),
            None => return Err(format!("{} does not exist", p.display())),
        }
    }
    Ok(())
}

pub(crate) fn production_exe_trust(exe: &Path) -> Result<(), String> {
    let pf = crate::sys::known_folder(crate::sys::KnownFolder::ProgramFiles)?;
    exe_trust(exe, &pf, &|p| crate::layout::check_dir_trust(p, &crate::layout::production_owner).map(|o| o.map(|t| t.is_dir)).map_err(|e| e.to_string()))
}

/// Creates the scratch folder; production uses `locked_mkdir`, tests (an unelevated user cannot write into a SYSTEM+Administrators folder) a plain one.
type MkDir<'a> = &'a dyn Fn(&Path) -> std::io::Result<()>;

fn locked_mkdir(dir: &Path) -> std::io::Result<()> {
    crate::sys::create_dir_with_sddl(dir, SCRATCH_SDDL)
}

const SCRATCH_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/// A scratch folder created fresh (never reused, so it cannot be pre-planted) with a protected ACL of SYSTEM +
/// Administrators from its first instant; removed on drop, i.e. on every path.
struct Scratch(PathBuf);
impl Scratch {
    fn create(parent: &Path, mkdir: MkDir) -> Result<Scratch, String> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = parent.join(format!("posctl-tasks-{}-{nanos}", std::process::id()));
        mkdir(&dir).map_err(|e| format!("could not create the scratch folder {}: {e}", dir.display()))?;
        Ok(Scratch(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(bytes)
}

/// Register (or replace, `/F`) every task. Retired tasks are deleted first.
#[allow(clippy::too_many_arguments)]
fn install_via(run: Runner, elevated: bool, trust: ExeTrust, mkdir: MkDir, tasks: &[TaskDef], retired: &[&str], exe: &Path, scratch_parent: &Path, principal_xml: &str) -> Result<Vec<String>, String> {
    need_elevation(elevated, "installing")?;
    trust(exe)?;
    remove_via(run, true, &retired.iter().map(|n| n.to_string()).collect::<Vec<_>>())?;
    let scratch = Scratch::create(scratch_parent, mkdir)?;
    let mut done = Vec::new();
    for t in tasks {
        let xml = scratch.0.join(format!("task-{}.xml", t.name));
        write_new(&xml, &to_utf16le_bom(&task_xml(t, exe, principal_xml))).map_err(|e| format!("could not write {}: {e}", xml.display()))?;
        let o = run(create_args(&full_name(t), &xml));
        let _ = std::fs::remove_file(&xml);
        let o = o?;
        if !o.success() {
            return Err(format!("schtasks /Create {} failed ({}): {}", t.name, o.code, o.text().trim()));
        }
        done.push(t.name.to_string());
    }
    Ok(done)
}

/// Only the sandbox test passes a `trust` other than `production_exe_trust`.
pub(crate) fn install_with(trust: ExeTrust, tasks: &[TaskDef], exe: &Path, principal_xml: &str) -> Result<Vec<String>, String> {
    let parent = crate::sys::known_folder(crate::sys::KnownFolder::ProgramData)?;
    install_via(&run, crate::sys::is_elevated(), trust, &locked_mkdir, tasks, RETIRED, exe, &parent, principal_xml)
}

pub fn install(exe: &Path) -> Result<Vec<String>, String> {
    // BackupVerify runs five minutes after the maintenance window ends: `posctl.json` is read here, so changing the window means
    // running `tasks install` again (as with the executable path).
    let tasks = crate::backup::backup_tasks::with_window(all_tasks(), configured_window());
    install_with(&production_exe_trust, &tasks, exe, SYSTEM_PRINCIPAL)
}

/// Remove the named tasks; returns the ones actually deleted. A task that is not there is fine; one
/// that could not be deleted and is still there (access denied, locked) is an error.
fn remove_via(run: Runner, elevated: bool, names: &[String]) -> Result<Vec<String>, String> {
    need_elevation(elevated, "removing")?;
    let mut removed = Vec::new();
    for n in names {
        let name = format!("{FOLDER}\\{n}");
        let o = run(delete_args(&name))?;
        if o.success() {
            removed.push(n.clone());
        } else if run(query_args(&name))?.success() {
            return Err(format!("schtasks /Delete {n} failed ({}) and the task is still registered: {}", o.code, o.text().trim()));
        }
    }
    Ok(removed)
}

pub fn remove_named(names: &[String]) -> Result<Vec<String>, String> {
    remove_via(&run, crate::sys::is_elevated(), names)
}

/// Current and retired tasks.
pub fn remove() -> Result<Vec<String>, String> {
    let names: Vec<String> = all_tasks().iter().map(|t| t.name).chain(RETIRED.iter().copied()).map(String::from).collect();
    remove_named(&names)
}

fn status_via(run: Runner, elevated: bool) -> Result<Vec<(String, bool)>, String> {
    need_elevation(elevated, "reading")?;
    all_tasks().iter().map(|t| Ok((t.name.to_string(), run(query_args(&full_name(t)))?.success()))).collect()
}

/// `(name, installed)` for every task the product defines. Needs an elevated shell (an unreadable task would read as missing).
pub fn status() -> Result<Vec<(String, bool)>, String> {
    status_via(&run, crate::sys::is_elevated())
}

/// Reads the task's definition (`/XML`); the exit code of `query_args` has already said it exists.
pub fn xml_args(task_name: &str) -> Vec<String> {
    ["/Query", "/TN", task_name, "/XML"].map(String::from).to_vec()
}

/// The flag the scheduled tasks carry so that a run knows it is unattended.
const SCHEDULED_FLAG: &str = "--scheduled";

/// `(name, is current)` for every task that is meant to carry `--scheduled`: current = it carries the flag AND its
/// `ExecutionTimeLimit` is the one this build installs (an older build's shorter limit would cut a long run short). A task that is not
/// registered is stale (`false`), found by the exit code of `query_args` like `status`; only a REGISTERED task is then read. Anything else that goes wrong (the scheduler
/// cannot be run, a registered task's definition cannot be read, no elevation) is an `Err`: unknown, never "current".
#[cfg(test)]
fn scheduled_flag_via(run: Runner, elevated: bool) -> Result<Vec<(String, bool)>, String> {
    scheduled_flag_via_window(run, elevated, crate::update::window::window_from(None))
}

/// `window` is the store's maintenance window: BackupVerify starts five minutes after it ends, so a task installed before the window
/// was changed carries the wrong start time and reads as stale (`tasks install` re-times it).
fn scheduled_flag_via_window(run: Runner, elevated: bool, window: (u32, u32)) -> Result<Vec<(String, bool)>, String> {
    need_elevation(elevated, "reading")?;
    all_tasks().iter().filter(|t| t.args.contains(&SCHEDULED_FLAG)).map(|t| {
        let name = full_name(t);
        if !run(query_args(&name))?.success() { return Ok((t.name.to_string(), false)); }
        let x = run(xml_args(&name))?;
        if !x.success() { return Err(format!("schtasks /Query /XML {name} failed ({})", x.code)); }
        let on_time = t.name != crate::backup::backup_tasks::VERIFY_TASK || start_minute(&x.stdout) == Some(crate::backup::backup_tasks::verify_minute(window));
        Ok((t.name.to_string(), arguments_carry_flag(&x.stdout) && time_limit_minutes(&x.stdout) == Some(t.time_limit_minutes) && on_time))
    }).collect()
}

/// Whether any `<Arguments>` element of the task XML holds the flag as a word. NULs are dropped: UTF-16 text that reached us as
/// bytes is then plain ASCII again.
fn arguments_carry_flag(xml: &str) -> bool {
    let xml = xml.replace('\0', "");
    xml.split("<Arguments>").skip(1).filter_map(|r| r.split("</Arguments>").next()).any(|a| a.split_whitespace().any(|w| w == SCHEDULED_FLAG))
}

/// The task's `<ExecutionTimeLimit>` in whole minutes: the scheduler may echo `PT153M` as `PT2H33M`, so the ISO-8601 duration is parsed
/// (`[nD]T[nH][nM][nS]`), not compared as text. Missing or unreadable is `None`: every task this product installs carries the element,
/// and without it the scheduler's default (72 hours) applies, which is not the limit the code derived. NULs are dropped like above.
fn time_limit_minutes(xml: &str) -> Option<u32> {
    let xml = xml.replace('\0', "");
    let d = xml.split("<ExecutionTimeLimit>").nth(1)?.split("</ExecutionTimeLimit>").next()?.trim().strip_prefix('P')?;
    let (days, time) = match d.split_once('T') { Some((days, time)) => (days, time), None => (d, "") };
    let mut secs = match days { "" => 0, n => n.strip_suffix('D')?.parse::<u64>().ok()? * 86_400 };
    let mut num = String::new();
    for c in time.chars() {
        if c.is_ascii_digit() { num.push(c); continue; }
        let n = std::mem::take(&mut num).parse::<u64>().ok()?;
        secs += n * match c { 'H' => 3600, 'M' => 60, 'S' => 1, _ => return None };
    }
    if !num.is_empty() || secs % 60 != 0 { return None; }
    u32::try_from(secs / 60).ok()
}

/// The first trigger's start time of a task definition, as minutes after midnight (`<StartBoundary>2026-01-01T05:05:00`).
fn start_minute(xml: &str) -> Option<u32> {
    let xml = xml.replace('\0', "");
    let boundary = xml.split("<StartBoundary>").nth(1)?.split("</StartBoundary>").next()?;
    let (h, rest) = boundary.split_once('T')?.1.split_once(':')?;
    Some(h.parse::<u32>().ok()? * 60 + rest.get(..2)?.parse::<u32>().ok()?)
}

/// The maintenance window from `posctl.json` (the default when it is absent or unusable).
fn configured_window() -> (u32, u32) {
    let w = crate::paths::Roots::production().ok().and_then(|r| crate::config::PosctlJson::load(&r).ok().flatten()).and_then(|c| c.maintenance.window);
    crate::update::window::window_from(w.as_ref())
}

pub fn scheduled_flag() -> Result<Vec<(String, bool)>, String> {
    scheduled_flag_via_window(&run, crate::sys::is_elevated(), configured_window())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ToolOutput;
    use std::cell::RefCell;

    fn health() -> TaskDef {
        all_tasks().into_iter().find(|t| t.name == "Health").unwrap()
    }

    fn out(code: i32) -> Result<ToolOutput, String> {
        Ok(ToolOutput { code, stdout: String::new(), stderr: "localized text we must not parse".into() })
    }

    #[test]
    fn plan_05_owns_health_and_canary_with_the_conventions_triggers() {
        let tasks = all_tasks();
        // Plans 07, 08 and 12 append theirs to `all_tasks()`: assert Health and Canary are present once each, in order.
        let names: Vec<_> = tasks.iter().map(|t| t.name).filter(|n| *n == "Health" || *n == "Canary").collect();
        assert_eq!(names, ["Health", "Canary"]);
        assert_eq!(health().triggers, vec![Trigger::EveryMinutes(1)]);
        assert_eq!(health().args, &["health", "--write"]);
        let canary = tasks.iter().find(|t| t.name == "Canary").unwrap();
        assert_eq!(canary.triggers, vec![Trigger::DailyAt("03:00"), Trigger::AtBoot { delay_minutes: 3 }]);
        assert_eq!(canary.args, &["health", "--canary", "--write"]);
        assert_eq!(full_name(&health()), "\\SupermarketPOS\\Health");
    }

    #[test]
    fn the_registry_is_well_formed_for_every_plan_that_appends_to_it() {
        let tasks = all_tasks();
        let mut names: Vec<_> = tasks.iter().map(|t| t.name).collect();
        names.sort();
        let n = names.len();
        names.dedup();
        assert_eq!(names.len(), n, "task names must be unique");
        for t in &tasks {
            assert!(t.name.chars().all(|c| c.is_ascii_alphanumeric()), "{} is used in a file name and a task path", t.name);
            assert!(!t.triggers.is_empty() && !t.args.is_empty() && t.time_limit_minutes > 0, "{}", t.name);
            for a in t.args {
                assert!(!a.is_empty() && !a.contains(char::is_whitespace) && !a.contains('"'), "{}: arg '{a}' would be split or mis-quoted in <Arguments>", t.name);
            }
            for tr in &t.triggers {
                if let Trigger::EveryMinutes(n) = tr {
                    assert!(*n >= 1, "{}: a repetition interval needs at least one minute", t.name);
                }
                if let Trigger::DailyAt(hhmm) = tr {
                    let (h, m) = hhmm.split_once(':').unwrap();
                    assert!(h.len() == 2 && m.len() == 2 && h.parse::<u32>().unwrap() < 24 && m.parse::<u32>().unwrap() < 60, "{hhmm}");
                }
            }
        }
    }

    #[test]
    fn the_system_principal_matches_what_task_scheduler_exports_for_a_system_task() {
        // schtasks rejects <LogonType>ServiceAccount</LogonType> for S-1-5-18 ("(5,91):LogonType:ServiceAccount"); the canonical
        // export is just UserId + RunLevel, in a version 1.2 document.
        assert_eq!(
            SYSTEM_PRINCIPAL,
            "<Principal id=\"Author\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>"
        );
        let xml = task_xml(&health(), Path::new(r"C:\p.exe"), SYSTEM_PRINCIPAL);
        assert!(!xml.contains("LogonType"));
        assert!(xml.contains("<Task version=\"1.2\""), "{xml}");
    }

    #[test]
    fn the_xml_runs_as_system_hidden_one_instance_at_a_time() {
        let xml = task_xml(&health(), Path::new("C:\\Program Files\\Supermarket POS\\posctl\\posctl.exe"), SYSTEM_PRINCIPAL);
        for want in [
            "<UserId>S-1-5-18</UserId>",
            "<RunLevel>HighestAvailable</RunLevel>",
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<Interval>PT1M</Interval>",
            "<StopAtDurationEnd>false</StopAtDurationEnd>",
            "<Hidden>true</Hidden>",
            "<StartWhenAvailable>true</StartWhenAvailable>",
            "<Command>C:\\Program Files\\Supermarket POS\\posctl\\posctl.exe</Command>",
            "<Arguments>health --write</Arguments>",
            "encoding=\"UTF-16\"",
        ] {
            assert!(xml.contains(want), "missing {want}");
        }
        let canary = task_xml(all_tasks().iter().find(|t| t.name == "Canary").unwrap(), Path::new("C:\\p.exe"), SYSTEM_PRINCIPAL);
        assert!(canary.contains("<StartBoundary>2026-01-01T03:00:00</StartBoundary>") && canary.contains("<Delay>PT3M</Delay>"));
    }

    #[test]
    fn a_boot_trigger_without_a_delay_has_no_delay_element() {
        assert!(!trigger_xml(&Trigger::AtBoot { delay_minutes: 0 }).contains("Delay"));
    }

    #[test]
    fn xml_special_characters_are_escaped() {
        let mut t = health();
        t.description = "a & b <c>";
        let xml = task_xml(&t, Path::new("C:\\a&b\\posctl.exe"), SYSTEM_PRINCIPAL);
        assert!(xml.contains("a &amp; b &lt;c&gt;") && xml.contains("C:\\a&amp;b\\posctl.exe"));
    }

    #[test]
    fn the_file_is_utf16le_with_a_bom() {
        let b = to_utf16le_bom("<a>é</a>");
        assert_eq!(&b[..2], &[0xFF, 0xFE]);
        assert_eq!(b.len(), 2 + 2 * "<a>é</a>".encode_utf16().count());
        assert_eq!(&b[2..4], &[b'<', 0]);
    }

    #[test]
    fn schtasks_args_use_only_exit_codes_never_localized_text() {
        assert_eq!(create_args("\\SupermarketPOS\\Health", Path::new("C:\\t.xml")), ["/Create", "/TN", "\\SupermarketPOS\\Health", "/XML", "C:\\t.xml", "/F"]);
        assert_eq!(delete_args("\\SupermarketPOS\\Health"), ["/Delete", "/TN", "\\SupermarketPOS\\Health", "/F"]);
        assert_eq!(query_args("\\SupermarketPOS\\Health"), ["/Query", "/TN", "\\SupermarketPOS\\Health", "/FO", "CSV", "/NH"]);
    }

    fn trusted(_: &Path) -> Result<(), String> {
        Ok(())
    }

    fn plain_mkdir(d: &Path) -> std::io::Result<()> {
        std::fs::create_dir(d)
    }

    fn install_ok(run: Runner, dir: &Path, retired: &[&str]) -> Result<Vec<String>, String> {
        install_via(run, true, &trusted, &plain_mkdir, &all_tasks(), retired, Path::new("C:\\p\\posctl.exe"), dir, SYSTEM_PRINCIPAL)
    }

    #[test]
    fn install_writes_each_xml_runs_create_and_leaves_no_file_or_folder_behind() {
        let dir = tempfile::tempdir().unwrap();
        let seen = RefCell::new(Vec::new());
        let run = |a: Vec<String>| {
            // the XML must exist, as UTF-16 with a BOM, inside a scratch folder of its own, while schtasks reads it
            let xml = std::fs::read(&a[4]).unwrap();
            assert_eq!(&xml[..2], &[0xFF, 0xFE]);
            assert_ne!(Path::new(&a[4]).parent().unwrap(), dir.path());
            seen.borrow_mut().push(a);
            out(0)
        };
        let done = install_ok(&run, dir.path(), &[]).unwrap();
        assert_eq!(done, all_tasks().iter().map(|t| t.name.to_string()).collect::<Vec<_>>());
        assert_eq!(seen.borrow().len(), all_tasks().len());
        assert_eq!(seen.borrow()[0][..3], ["/Create", "/TN", "\\SupermarketPOS\\Health"]);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn install_stops_at_the_first_failure_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let calls = RefCell::new(0);
        let run = |_: Vec<String>| {
            *calls.borrow_mut() += 1;
            out(1)
        };
        let e = install_ok(&run, dir.path(), &[]).unwrap_err();
        assert!(e.contains("Health") && e.contains("(1)"), "{e}");
        assert_eq!(*calls.borrow(), 1);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn install_never_overwrites_an_existing_file_in_its_scratch_folder() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.xml");
        std::fs::write(&f, b"planted").unwrap();
        assert!(write_new(&f, b"new").is_err());
        assert_eq!(std::fs::read(&f).unwrap(), b"planted");
    }

    #[test]
    fn install_refuses_before_touching_anything_when_not_elevated_or_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let run = |_: Vec<String>| -> Result<ToolOutput, String> { panic!("must not run schtasks") };
        let exe = Path::new("C:\\p\\posctl.exe");
        let e = install_via(&run, false, &trusted, &plain_mkdir, &all_tasks(), &[], exe, dir.path(), SYSTEM_PRINCIPAL).unwrap_err();
        assert!(e.contains("elevated"), "{e}");
        let untrusted = |_: &Path| Err("user-writable".to_string());
        assert!(install_via(&run, true, &untrusted, &plain_mkdir, &all_tasks(), &[], exe, dir.path(), SYSTEM_PRINCIPAL).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn install_deletes_retired_tasks_first() {
        let dir = tempfile::tempdir().unwrap();
        let seen = RefCell::new(Vec::new());
        let run = |a: Vec<String>| {
            seen.borrow_mut().push(a[0].clone() + " " + &a[2]);
            out(0)
        };
        install_ok(&run, dir.path(), &["OldTask"]).unwrap();
        assert_eq!(seen.borrow()[0], "/Delete \\SupermarketPOS\\OldTask");
        assert_eq!(seen.borrow()[1], "/Create \\SupermarketPOS\\Health");
    }

    fn all_present(_: &Path) -> Result<Option<bool>, String> {
        Ok(None)
    }

    #[test]
    fn exe_trust_decides_on_location_shape_and_inspection() {
        let pf = Path::new("C:\\Program Files");
        let exe = Path::new("C:\\Program Files\\SupermarketPOS\\posctl\\posctl.exe");
        let ok = |p: &Path| Ok(Some(p.extension().is_none()));
        assert!(exe_trust(exe, pf, &ok).is_ok());
        assert!(exe_trust(Path::new("c:\\PROGRAM FILES\\x\\posctl.exe"), pf, &ok).is_ok(), "case-insensitive");
        for bad in ["posctl.exe", "C:\\Users\\me\\posctl.exe", "C:\\Program Files (x86)\\x\\posctl.exe", "C:\\Program Files\\..\\Users\\posctl.exe", "C:\\Program Files"] {
            assert!(exe_trust(Path::new(bad), pf, &ok).is_err(), "{bad}");
        }
        assert!(exe_trust(exe, pf, &all_present).unwrap_err().contains("does not exist"));
        let link = |_: &Path| Err("is a reparse point".to_string());
        assert!(exe_trust(exe, pf, &link).unwrap_err().contains("reparse"));
        let wrong_kind = |_: &Path| Ok(Some(true)); // the exe itself reported as a folder
        assert!(exe_trust(exe, pf, &wrong_kind).is_err());
    }

    #[test]
    fn remove_treats_a_missing_task_as_fine_but_a_surviving_one_as_an_error() {
        // delete fails and the follow-up query says it is gone: fine, not reported as removed
        let gone = |_: Vec<String>| out(1);
        assert_eq!(remove_via(&gone, true, &["Health".to_string()]).unwrap(), Vec::<String>::new());
        // delete fails but the query still finds it (e.g. access denied): an error, not silence
        let stuck = |a: Vec<String>| if a[0] == "/Delete" { out(1) } else { out(0) };
        assert!(remove_via(&stuck, true, &["Health".to_string()]).unwrap_err().contains("Health"));
        let ok = |_: Vec<String>| out(0);
        assert_eq!(remove_via(&ok, true, &["Health".to_string()]).unwrap(), vec!["Health".to_string()]);
    }

    #[test]
    fn remove_and_status_refuse_when_not_elevated() {
        let run = |_: Vec<String>| -> Result<ToolOutput, String> { panic!("must not run schtasks") };
        assert!(remove_via(&run, false, &["Health".to_string()]).unwrap_err().contains("elevated"));
        assert!(status_via(&run, false).unwrap_err().contains("elevated"));
    }

    #[test]
    fn status_is_the_query_exit_code() {
        let only_health = |a: Vec<String>| if a[2].ends_with("\\Health") { out(0) } else { out(1) };
        let s = status_via(&only_health, true).unwrap();
        assert!(s.iter().find(|(n, _)| n == "Health").unwrap().1);
        assert!(!s.iter().find(|(n, _)| n == "Canary").unwrap().1);
    }

    /// Registers the PRODUCTION XML for Canary and Health (SYSTEM principal, real triggers) under test names, with
    /// a copy of cmd.exe in a folder whose name has spaces as the Command, runs each with `/Run` and waits for the
    /// marker file it writes. WINDOWS SANDBOX ONLY, elevated (scenario 21 runs ignored tests). `install_with` gets
    /// an explicit trust bypass because the copy is not under Program Files.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_real_task_scheduler_runs_the_production_xml_as_system_from_a_spaced_path() {
        let work = tempfile::tempdir().unwrap();
        let spaced = work.path().join("with some spaces");
        std::fs::create_dir(&spaced).unwrap();
        let exe = spaced.join("cmd.exe");
        std::fs::copy("C:\\Windows\\System32\\cmd.exe", &exe).unwrap();
        let mut defs = Vec::new();
        for (real, test_name) in [("Canary", "PosctlUnitTestCanary"), ("Health", "PosctlUnitTestHealth")] {
            let marker = work.path().join(format!("{test_name}.marker"));
            let args: &'static [&'static str] = Box::leak(vec!["/c", "type", "nul", ">", Box::leak(format!("\"{}\"", marker.display()).into_boxed_str()) as &'static str].into_boxed_slice());
            let mut t = all_tasks().into_iter().find(|t| t.name == real).unwrap();
            t.name = test_name;
            t.args = args;
            defs.push((t, marker));
        }
        let tasks: Vec<TaskDef> = defs.iter().map(|(t, _)| t.clone()).collect();
        let names: Vec<String> = tasks.iter().map(|t| t.name.to_string()).collect();
        let result = (|| -> Result<(), String> {
            assert_eq!(install_with(&trusted, &tasks, &exe, SYSTEM_PRINCIPAL)?, names);
            for (t, marker) in &defs {
                assert!(run(query_args(&full_name(t)))?.success());
                let o = run(vec!["/Run".into(), "/TN".into(), full_name(t)])?;
                assert!(o.success(), "/Run {} failed: {}", t.name, o.text());
                let deadline = std::time::Instant::now() + Duration::from_secs(60);
                while !marker.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(500));
                }
                assert!(marker.exists(), "{} never ran its action (marker {} missing)", t.name, marker.display());
            }
            Ok(())
        })();
        let removed = remove_named(&names);
        result.unwrap();
        assert_eq!(removed.unwrap().len(), names.len());
        for t in &tasks {
            assert!(!run(query_args(&full_name(t))).unwrap().success());
        }
    }

    // ---- FR19: a task installed by an older posctl lacks `--scheduled` ----
    fn task(name: &str) -> TaskDef { all_tasks().into_iter().find(|t| t.name == name).unwrap() }
    fn installed_xml(t: &TaskDef) -> String { task_xml(t, Path::new("C:\\p\\posctl.exe"), SYSTEM_PRINCIPAL) }
    /// A scheduler holding `defs`: `(task name, its XML)`; a task not in the list is not registered.
    fn scheduler(defs: Vec<(&'static str, String)>) -> impl Fn(Vec<String>) -> Result<ToolOutput, String> {
        move |a: Vec<String>| {
            let Some((_, xml)) = defs.iter().find(|(n, _)| full_name(&task(n)) == a[2]) else { return out(1) };
            if a.contains(&"/XML".to_string()) { Ok(ToolOutput { code: 0, stdout: xml.clone(), stderr: String::new() }) } else { out(0) }
        }
    }
    fn current_defs() -> Vec<(&'static str, String)> {
        all_tasks().iter().filter(|t| t.args.contains(&SCHEDULED_FLAG)).map(|t| (t.name, installed_xml(t))).collect()
    }

    #[test]
    fn the_unattended_tasks_are_the_ones_that_carry_the_flag() {
        let names: Vec<_> = all_tasks().iter().filter(|t| t.args.contains(&SCHEDULED_FLAG)).map(|t| t.name).collect();
        assert_eq!(names, ["Recover", "UpdateCheck", "Backup", "BackupVerify"]);
        assert_eq!(xml_args("\\SupermarketPOS\\Recover"), ["/Query", "/TN", "\\SupermarketPOS\\Recover", "/XML"]);
    }

    #[test]
    fn backup_verify_reads_fresh_at_the_time_its_window_gives_and_stale_once_the_window_moved() {
        let win = (22 * 60, 6 * 60 + 30);
        let retimed = crate::backup::backup_tasks::with_window(all_tasks(), win);
        let defs: Vec<_> = retimed.iter().filter(|t| t.args.contains(&SCHEDULED_FLAG)).map(|t| (t.name, installed_xml(t))).collect();
        let fresh = scheduled_flag_via_window(&scheduler(defs.clone()), true, win).unwrap();
        assert!(fresh.iter().all(|(_, ok)| *ok), "{fresh:?}");
        // the owner moved the window after the install: only the verify's start time disagrees
        let moved = scheduled_flag_via_window(&scheduler(defs.clone()), true, (60, 300)).unwrap();
        assert_eq!(moved.iter().filter(|(_, ok)| !*ok).map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["BackupVerify"], "{moved:?}");
        // an install made before the window was set (default 05:05) is stale for a custom window and fresh for the default
        let default_defs = current_defs();
        assert!(!scheduled_flag_via_window(&scheduler(default_defs.clone()), true, win).unwrap().iter().all(|(_, ok)| *ok));
        assert!(scheduled_flag_via_window(&scheduler(default_defs), true, (60, 300)).unwrap().iter().all(|(_, ok)| *ok));
        assert_eq!(start_minute("<StartBoundary>2026-01-01T06:35:00</StartBoundary>"), Some(6 * 60 + 35));
        assert_eq!(start_minute("<Task/>"), None);
    }

    #[test]
    fn tasks_that_carry_the_scheduled_flag_read_as_current() {
        let got = scheduled_flag_via(&scheduler(current_defs()), true).unwrap();
        assert_eq!(got, [("Recover".to_string(), true), ("UpdateCheck".to_string(), true), ("Backup".to_string(), true), ("BackupVerify".to_string(), true)]);
    }

    #[test]
    fn a_task_whose_arguments_lack_the_flag_reads_as_stale() {
        let mut defs = current_defs();
        defs[1].1 = defs[1].1.replace(" --scheduled", ""); // what an older posctl installed
        assert!(!defs[1].1.contains("--scheduled") && defs[0].1.contains("--scheduled"));
        let got = scheduled_flag_via(&scheduler(defs), true).unwrap();
        assert_eq!(got, [("Recover".to_string(), true), ("UpdateCheck".to_string(), false), ("Backup".to_string(), true), ("BackupVerify".to_string(), true)]);
    }

    #[test]
    fn a_task_installed_with_an_older_time_limit_reads_as_stale() {
        let t = task("Recover");
        let mut defs = current_defs();
        let limit = format!("<ExecutionTimeLimit>PT{}M</ExecutionTimeLimit>", t.time_limit_minutes);
        assert!(defs[0].1.contains(&limit), "{}", defs[0].1);
        defs[0].1 = defs[0].1.replace(&limit, "<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>"); // what the first FR19 build installed
        let got = scheduled_flag_via(&scheduler(defs), true).unwrap();
        assert_eq!(got, [("Recover".to_string(), false), ("UpdateCheck".to_string(), true), ("Backup".to_string(), true), ("BackupVerify".to_string(), true)]);
    }

    #[test]
    fn the_same_limit_in_another_iso_spelling_is_current_and_a_missing_element_is_stale() {
        let t = task("UpdateCheck");
        let (h, m) = (t.time_limit_minutes / 60, t.time_limit_minutes % 60);
        let limit = format!("<ExecutionTimeLimit>PT{}M</ExecutionTimeLimit>", t.time_limit_minutes);
        let mut defs = current_defs();
        defs[1].1 = defs[1].1.replace(&limit, &format!("<ExecutionTimeLimit>PT{h}H{m}M0S</ExecutionTimeLimit>"));
        assert_eq!(scheduled_flag_via(&scheduler(defs), true).unwrap()[1], ("UpdateCheck".to_string(), true), "the scheduler may echo the duration normalised");
        let mut defs = current_defs();
        defs[1].1 = defs[1].1.replace(&limit, "");
        assert_eq!(scheduled_flag_via(&scheduler(defs), true).unwrap()[1], ("UpdateCheck".to_string(), false), "installed tasks always carry the element");
    }

    #[test]
    fn a_missing_task_counts_as_stale() {
        let defs: Vec<_> = current_defs().into_iter().filter(|(n, _)| *n != "Recover").collect();
        let got = scheduled_flag_via(&scheduler(defs), true).unwrap();
        assert_eq!(got, [("Recover".to_string(), false), ("UpdateCheck".to_string(), true), ("Backup".to_string(), true), ("BackupVerify".to_string(), true)]);
    }

    #[test]
    fn only_the_arguments_element_counts_and_utf16_output_read_as_bytes_still_matches() {
        let mut defs = current_defs();
        defs[0].1 = defs[0].1.replace("--scheduled</Arguments>", "</Arguments>").replace("<Description>", "<Description>--scheduled "); // flag elsewhere only
        let got = scheduled_flag_via(&scheduler(defs), true).unwrap();
        assert!(!got[0].1, "the flag outside <Arguments> is not the flag");
        let wide: String = installed_xml(&task("Recover")).chars().flat_map(|c| [c, '\0']).collect();
        let got = scheduled_flag_via(&scheduler(vec![("Recover", wide), ("UpdateCheck", installed_xml(&task("UpdateCheck")))]), true).unwrap();
        assert!(got[0].1, "UTF-16 text that arrived as bytes with NULs is still read");
    }

    #[test]
    fn a_registered_task_whose_definition_cannot_be_read_is_unknown_never_current() {
        let run = |a: Vec<String>| if a.contains(&"/XML".to_string()) { out(1) } else { out(0) };
        assert!(scheduled_flag_via(&run, true).is_err());
        assert!(scheduled_flag_via(&|_| Err("schtasks missing".into()), true).is_err());
        assert!(scheduled_flag_via(&scheduler(current_defs()), false).is_err(), "without elevation an unreadable task would read as missing");
    }

    /// The installer must `/End` every scheduled task (a running one holds posctl.exe open) before it replaces or removes the files:
    /// the names in windows/hooks.nsh, in both pre-hooks, are exactly `all_tasks()`, in order.
    #[test]
    fn installer_hooks_end_every_task_in_all_tasks_order() {
        let nsh = include_str!("../../windows/hooks.nsh").replace("\r\n", "\n");
        let want: Vec<&str> = all_tasks().iter().map(|t| t.name).collect();
        for hook in ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"] {
            let start = nsh
                .find(&format!("!macro {hook}"))
                .unwrap_or_else(|| panic!("{hook} missing"));
            let body = &nsh[start..start + nsh[start..].find("!macroend").unwrap()];
            let marker = "/End /TN \"\\SupermarketPOS\\";
            let got: Vec<&str> = body
                .match_indices(marker)
                .map(|(i, _)| body[i + marker.len()..].split('"').next().unwrap())
                .collect();
            assert_eq!(got, want, "{hook}");
        }
    }
}
