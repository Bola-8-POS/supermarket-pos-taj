//! The scheduled tasks this plan owns (conventions 4.2): `Recover` at boot and `UpdateCheck` daily. They are rows of Plan 05's
//! `tasks::all_tasks()` (one registry, one XML renderer, SYSTEM principal), so `tasks install` registers them with Health and
//! Canary; this module only exposes the two for the tests and for callers that register them by name. Nothing here registers
//! a task: `schtasks` runs only through `tasks::install`.
use crate::tasks;
use std::path::Path;

pub const NAMES: [&str; 2] = ["Recover", "UpdateCheck"];

pub struct TaskSpec { pub name: &'static str, pub xml: String }

pub fn specs(exe: &Path) -> Vec<TaskSpec> {
    tasks::all_tasks().into_iter().filter(|t| NAMES.contains(&t.name))
        .map(|t| TaskSpec { name: t.name, xml: tasks::task_xml(&t, exe, tasks::SYSTEM_PRINCIPAL) }).collect()
}

/// UTF-16LE with a byte-order mark: the encoding `schtasks /XML` accepts.
pub fn to_utf16le_with_bom(s: &str) -> Vec<u8> { tasks::to_utf16le_bom(s) }

pub fn register_args(name: &str, xml_path: &Path) -> Vec<String> { tasks::create_args(&format!("{}\\{name}", tasks::FOLDER), xml_path) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    const EXE: &str = r"C:\Program Files\Supermarket POS\posctl\posctl.exe";

    fn spec(name: &str) -> TaskSpec { specs(Path::new(EXE)).into_iter().find(|s| s.name == name).unwrap() }

    #[test]
    fn recover_runs_at_boot_as_system_with_the_recover_flag() {
        let x = spec("Recover").xml;
        assert!(x.contains("<BootTrigger>") && x.contains("<Arguments>update --recover --quiet --scheduled</Arguments>"), "{x}");
        assert!(x.contains("<UserId>S-1-5-18</UserId>") && x.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(x.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(x.contains(r"<Command>C:\Program Files\Supermarket POS\posctl\posctl.exe</Command>"));
        assert!(!x.contains("<Delay>"), "recovery must not wait behind the boot canary");
    }
    #[test]
    fn update_check_runs_every_hour_so_the_window_not_the_trigger_decides() {
        let x = spec("UpdateCheck").xml;
        assert!(x.contains("<Interval>PT60M</Interval>") && x.contains("<TimeTrigger>"), "{x}");
        assert!(!x.contains("<DaysInterval>"), "a fixed daily time never lands inside a window that excludes it");
        assert!(x.contains("<StartWhenAvailable>false</StartWhenAvailable>"));
        assert!(!x.contains("<WakeToRun>true</WakeToRun>"));
        assert!(x.contains("<Arguments>update --if-available --window-aware --quiet --scheduled</Arguments>"));
        assert!(x.contains("<UserId>S-1-5-18</UserId>"));
    }
    #[test]
    fn the_two_tasks_come_from_the_one_registry_plan_05_installs_from() {
        let names: Vec<_> = crate::tasks::all_tasks().iter().map(|t| t.name).collect();
        assert!(names.contains(&"Recover") && names.contains(&"UpdateCheck") && names.contains(&"Health") && names.contains(&"Canary"), "{names:?}");
        assert_eq!(specs(Path::new(EXE)).len(), 2);
    }
    #[test]
    fn paths_are_xml_escaped() {
        let s = specs(Path::new(r"C:\A&B\posctl.exe"));
        assert!(s[0].xml.contains("C:\\A&amp;B\\posctl.exe"));
    }
    #[test]
    fn schtasks_wants_utf16_with_a_bom_and_the_folder_in_the_name() {
        assert_eq!(&to_utf16le_with_bom("A")[..4], &[0xFF, 0xFE, b'A', 0]);
        let a = register_args("Recover", Path::new(r"C:\t\r.xml"));
        assert_eq!(a, ["/Create", "/TN", r"\SupermarketPOS\Recover", "/XML", r"C:\t\r.xml", "/F"]);
    }

    #[test]
    fn w_update_check_does_not_catch_up_after_a_night_off_and_the_other_tasks_still_do() {
        let x = spec("UpdateCheck").xml;
        assert!(x.contains("<StartWhenAvailable>false</StartWhenAvailable>"), "{x}");
        for t in crate::tasks::all_tasks().iter().filter(|t| t.name != "UpdateCheck") {
            let xml = crate::tasks::task_xml(t, Path::new(EXE), crate::tasks::SYSTEM_PRINCIPAL);
            assert!(xml.contains("<StartWhenAvailable>true</StartWhenAvailable>"), "{}", t.name);
        }
    }

    /// FR19 item 7: each task may run at least as long as the code's own timeouts add up to (`update::limits`), so a limit can never
    /// silently drift below them. The XML carries the derived value as ISO-8601 minutes.
    #[test]
    fn each_task_limit_is_at_least_what_the_codes_own_timeouts_add_up_to() {
        use crate::update::limits;
        for (name, derived) in [("Recover", limits::RECOVER_WORST_CASE_SECS), ("UpdateCheck", limits::UPDATE_CHECK_WORST_CASE_SECS)] {
            let t = crate::tasks::all_tasks().into_iter().find(|t| t.name == name).unwrap();
            assert!(u64::from(t.time_limit_minutes) * 60 >= derived, "{name}: {} min is below the derived {derived} s", t.time_limit_minutes);
            let x = spec(name).xml;
            assert!(x.contains(&format!("<ExecutionTimeLimit>PT{}M</ExecutionTimeLimit>", t.time_limit_minutes)), "{x}");
        }
    }
}
