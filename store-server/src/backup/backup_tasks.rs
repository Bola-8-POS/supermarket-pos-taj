//! The two scheduled tasks Plan 08 owns (conventions 4.2), as rows of Plan 05's one registry (`tasks::all_tasks()` appends
//! `defs()`): `tasks install` registers them with every other task, `tasks status` and `TASKS_MISSING` / `TASKS_STALE` cover them,
//! and `update_tasks::TaskSpec` / `tasks::task_xml` render them, so there is one XML dialect, one escaping and one SYSTEM principal.
//! Nothing here registers a task: `schtasks` runs only through `tasks::install`, as an Administrator, on a real PC.
//!
//! Q7 (the virtual account `NT SERVICE\SupermarketPOS-Backup` instead of SYSTEM) is decided after Sandbox scenario 44; this file
//! builds what the plan says for now, and adopting the account changes the principal passed to `task_xml`, not these rows.
#[cfg(test)]
use std::path::Path;

use super::dest::MAX_DESTINATIONS;
use super::maintain::{MIN_REPO_SHARE_SECS, VERIFY_BUDGET_SECS};
use super::pg::QUERY_TIMEOUT;
use super::run::{SCHEDULED_COPY_CAP_SECS, STEP_MAX_SECS};
#[cfg(test)]
use crate::tasks;
use crate::tasks::{TaskDef, Trigger};
use crate::update::limits::limit_minutes;
use crate::update::window::window_from;
#[cfg(test)]
use crate::update_tasks::TaskSpec;

pub const NAMES: [&str; 2] = ["Backup", VERIFY_TASK];
/// The task whose start time follows the maintenance window.
pub const VERIFY_TASK: &str = "BackupVerify";

/// The daily verify and drill start this long after the maintenance window ends: never inside it (an update may hold the
/// lock exclusively until then), and soon enough that the store is rarely open yet.
pub const VERIFY_AFTER_WINDOW_MINUTES: u32 = 5;

/// Sum of the caps of one tick that does everything: the dump and the restic backup (`STEP_MAX_SECS` each), the capped copy,
/// the snapshot session's queries (up to eight, each `QUERY_TIMEOUT`) and the small steps (unlock 120 s, `pg_dumpall` 300 s,
/// version 20 s, forget 600 s, role check, scratch sweep), rounded up to 30 minutes.
pub const OTHER_STEPS_SECS: u64 = 30 * 60;
pub const SESSION_QUERIES: u64 = 8;
pub const BACKUP_WORST_CASE_SECS: u64 = 2 * STEP_MAX_SECS + SCHEDULED_COPY_CAP_SECS as u64 + SESSION_QUERIES * QUERY_TIMEOUT.as_secs() + OTHER_STEPS_SECS;
pub const BACKUP_LIMIT_MINUTES: u32 = limit_minutes(BACKUP_WORST_CASE_SECS);

/// The drill may take `backup.rtoBudgetSeconds` (default 1800); this leaves room to raise it to two hours.
pub const DRILL_ALLOWANCE_SECS: u64 = 2 * 3600;
const fn max_u64(a: u64, b: u64) -> u64 {
    if a > b { a } else { b }
}
/// The verify's budget is `VERIFY_BUDGET_SECS` (4 h) shared by the connected repositories with at least `MIN_REPO_SHARE_SECS`
/// (30 min) each: the local one plus `MAX_DESTINATIONS` copies. Then the drill.
pub const VERIFY_WORST_CASE_SECS: u64 = max_u64(VERIFY_BUDGET_SECS as u64, (1 + MAX_DESTINATIONS as u64) * MIN_REPO_SHARE_SECS as u64) + DRILL_ALLOWANCE_SECS;
pub const VERIFY_LIMIT_MINUTES: u32 = limit_minutes(VERIFY_WORST_CASE_SECS);

/// `HH:MM` as minutes after midnight: the end of the maintenance window plus `VERIFY_AFTER_WINDOW_MINUTES`, around midnight.
pub fn verify_minute((_start, end): (u32, u32)) -> u32 {
    (end + VERIFY_AFTER_WINDOW_MINUTES) % (24 * 60)
}

/// The rows, with the verify at the default window's end + 5 minutes (05:05). `tasks::install` re-times it from `posctl.json`
/// with `with_window`.
pub fn defs() -> Vec<TaskDef> {
    vec![
        TaskDef {
            name: "Backup",
            description: "Backs up the store every hour while open and at caja close, and copies to the connected drives",
            // the tick decides what is due from the database; a PC that was off at the trigger runs it once when it is back
            triggers: vec![Trigger::EveryMinutes(5)],
            args: &["backup", "run", "--reason", "hourly", "--scheduled", "--quiet"],
            then_args: &[],
            time_limit_minutes: BACKUP_LIMIT_MINUTES,
            start_when_available: true,
        },
        TaskDef {
            name: "BackupVerify",
            description: "Daily check of the due backup copies (reading every byte) and the restore drill",
            triggers: vec![Trigger::DailyAtMinute(verify_minute(window_from(None)))],
            // two actions in one task: the scheduler runs them in order, and the drill does not depend on the verify's exit code
            args: &["backup", "verify", "--read-data", "--scheduled", "--quiet"],
            then_args: &["backup", "drill", "--scheduled", "--quiet"],
            time_limit_minutes: VERIFY_LIMIT_MINUTES,
            start_when_available: true,
        },
    ]
}

/// The registry with `BackupVerify` timed from the store's maintenance window.
pub fn with_window(mut tasks: Vec<TaskDef>, window: (u32, u32)) -> Vec<TaskDef> {
    for t in tasks.iter_mut().filter(|t| t.name == "BackupVerify") {
        t.triggers = vec![Trigger::DailyAtMinute(verify_minute(window))];
    }
    tasks
}

/// The two tasks rendered for `exe` (tests only).
#[cfg(test)]
fn specs(exe: &Path) -> Vec<TaskSpec> {
    tasks::all_tasks().into_iter().filter(|t| NAMES.contains(&t.name)).map(|t| TaskSpec { name: t.name, xml: tasks::task_xml(&t, exe, tasks::SYSTEM_PRINCIPAL) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::pg::QUERY_TIMEOUT;
    use std::path::Path;
    const EXE: &str = r"C:\Program Files\Supermarket POS\posctl\posctl.exe";

    fn spec(name: &str) -> String {
        specs(Path::new(EXE)).into_iter().find(|s| s.name == name).unwrap().xml
    }

    #[test]
    fn backup_ticks_every_five_minutes_as_system_and_catches_up_after_a_night_off() {
        let x = spec("Backup");
        assert!(x.contains("<Interval>PT5M</Interval>") && x.contains("<StopAtDurationEnd>false</StopAtDurationEnd>"), "{x}");
        assert!(x.contains("<Arguments>backup run --reason hourly --scheduled --quiet</Arguments>"), "{x}");
        assert!(x.contains("<UserId>S-1-5-18</UserId>") && x.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(x.contains("<StartWhenAvailable>true</StartWhenAvailable>") && x.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(x.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>") && x.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(!x.contains("<WakeToRun>true</WakeToRun>"));
        assert!(x.contains(&format!("<ExecutionTimeLimit>PT{BACKUP_LIMIT_MINUTES}M</ExecutionTimeLimit>")), "{x}");
    }

    #[test]
    fn backup_verify_is_daily_five_minutes_after_the_window_ends_and_runs_verify_then_the_drill() {
        let x = spec("BackupVerify");
        assert!(x.contains("<CalendarTrigger>") && x.contains("<DaysInterval>1</DaysInterval>") && x.contains("T05:05:00"), "{x}");
        assert!(!x.contains("<ScheduleByWeek>"), "daily, not weekly: a due check exits at once");
        let verify = x.find("<Arguments>backup verify --read-data --scheduled --quiet</Arguments>").expect("verify action");
        let drill = x.find("<Arguments>backup drill --scheduled --quiet</Arguments>").expect("drill action");
        assert!(verify < drill, "actions run in order");
        assert_eq!(x.matches("<Exec>").count(), 2);
        assert!(x.contains("<StartWhenAvailable>true</StartWhenAvailable>") && x.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(x.contains(&format!("<ExecutionTimeLimit>PT{VERIFY_LIMIT_MINUTES}M</ExecutionTimeLimit>")), "{x}");
        assert!(x.contains("<UserId>S-1-5-18</UserId>"));
    }

    #[test]
    fn the_verify_time_follows_the_maintenance_window() {
        assert_eq!(verify_minute((60, 300)), 5 * 60 + 5);
        assert_eq!(verify_minute((22 * 60, 6 * 60 + 30)), 6 * 60 + 35);
        assert_eq!(verify_minute((23 * 60, 23 * 60 + 58)), 3, "past midnight wraps");
        let retimed = with_window(tasks::all_tasks(), (22 * 60, 6 * 60 + 30));
        let v = retimed.iter().find(|t| t.name == "BackupVerify").unwrap();
        assert_eq!(v.triggers, vec![Trigger::DailyAtMinute(6 * 60 + 35)]);
        let xml = tasks::task_xml(v, Path::new(EXE), tasks::SYSTEM_PRINCIPAL);
        assert!(xml.contains("T06:35:00"), "{xml}");
        // nothing else is touched
        for (a, b) in tasks::all_tasks().iter().zip(retimed.iter()).filter(|(a, _)| a.name != "BackupVerify") {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn the_task_names_are_the_conventions_names_in_the_one_registry_and_paths_are_escaped() {
        let all: Vec<_> = tasks::all_tasks().iter().map(|t| t.name).collect();
        for n in NAMES {
            assert_eq!(all.iter().filter(|a| **a == n).count(), 1, "{n} is registered exactly once: {all:?}");
        }
        assert_eq!(specs(Path::new(EXE)).iter().map(|s| s.name).collect::<Vec<_>>(), ["Backup", "BackupVerify"]);
        assert!(specs(Path::new(r"C:\A&B\posctl.exe"))[0].xml.contains("C:\\A&amp;B\\posctl.exe"));
        assert_eq!(defs().iter().map(|t| t.name).collect::<Vec<_>>(), NAMES);
    }

    #[test]
    fn both_tasks_carry_the_scheduled_flag_so_a_stale_install_is_noticed() {
        for t in defs() {
            assert!(t.args.contains(&"--scheduled"), "{}", t.name);
            assert!(t.args.iter().chain(t.then_args).all(|a| !a.is_empty() && !a.contains(char::is_whitespace)), "{}", t.name);
        }
    }

    /// The limits are the code's own timeouts added up, so a limit cannot drift below them (as Plan 07 pins its two).
    #[test]
    fn each_task_limit_is_at_least_what_the_codes_own_timeouts_add_up_to() {
        let b = defs().into_iter().find(|t| t.name == "Backup").unwrap();
        let v = defs().into_iter().find(|t| t.name == "BackupVerify").unwrap();
        // the dump and the restic backup at their cap, the capped copy and the session queries
        let tick = 2 * crate::backup::run::STEP_MAX_SECS + SCHEDULED_COPY_CAP_SECS as u64 + SESSION_QUERIES * QUERY_TIMEOUT.as_secs();
        assert!(u64::from(b.time_limit_minutes) * 60 >= tick + 600, "Backup: {} min", b.time_limit_minutes);
        // the verify budget (or the per-repository floors of a full house) plus the drill
        let floors = (1 + MAX_DESTINATIONS as u64) * MIN_REPO_SHARE_SECS as u64;
        let verify = max_u64(VERIFY_BUDGET_SECS as u64, floors);
        assert!(u64::from(v.time_limit_minutes) * 60 >= verify + DRILL_ALLOWANCE_SECS + 600, "BackupVerify: {} min", v.time_limit_minutes);
        assert!(DRILL_ALLOWANCE_SECS >= crate::backup::config::BackupConfig::default().rto_budget_seconds, "the default drill budget fits");
        assert!(v.time_limit_minutes >= 4 * 60 && b.time_limit_minutes >= 60);
    }
}
