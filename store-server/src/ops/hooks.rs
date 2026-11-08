//! Crash/fail/pause injection for the Sandbox scenarios.
//! Compiled to nothing unless `--features test-hooks`; a release build contains none of its strings and never reads
//! the environment (the only call sites are the no-op stubs below), so hooks cannot be switched on in production.
#[cfg(not(feature = "test-hooks"))]
use crate::ops::world::R;

#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn hit(_label: &str) {}
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn fail(_label: &str) -> R<()> { Ok(()) }
/// Plan 09: lets `switch` accept a source database on this machine (the Sandbox and dev instances use one). Never in a release build.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn allow_local_source() -> bool { false }
/// Plan 09: lets an unelevated test run use a staging folder that is not locked to Administrators. Never in a release build.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn skip_staging_acl() -> bool { false }
/// 11H: the restore does not install the snapshot's pepper (the red-once control of Sandbox 94b). Never in a release build.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn skip_pepper_install() -> bool { false }
/// 11H: the backup leaves the pepper out of its snapshot, like a pre-11H posctl did (Sandbox 94a makes its legacy snapshot with it). Never in a release build.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn legacy_snapshot() -> bool { false }
/// 11H: the restore of a legacy snapshot skips the re-derive (the red-once control of Sandbox 94a). Never in a release build.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn skip_legacy_rederive() -> bool { false }
/// 11H: a file holding the console answers of a switch (pepper line, admin PIN line), for the Sandbox where no person types. Never in a
/// release build; the real prompt reads a hidden console and never a file, an argument or the environment.
#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn switch_console_file() -> Option<String> { None }

#[cfg(feature = "test-hooks")]
mod imp {
    use crate::ops::outcome::{OpCode, OpError};
    use crate::ops::world::R;
    use serde::Deserialize;

    #[derive(Deserialize, Default)]
    struct Pause { label: String, flag: String, ms: u64 }
    #[derive(Deserialize, Default)]
    struct Cfg { exit_at: Option<String>, fail_at: Option<String>, pause_at: Option<Pause>, backup: Option<String>, allow_local_source: Option<bool>, skip_staging_acl: Option<bool>, skip_pepper_install: Option<bool>, legacy_snapshot: Option<bool>, skip_legacy_rederive: Option<bool>, switch_console_file: Option<String> }
    fn parse(s: &str) -> Cfg { serde_json::from_str(s).unwrap_or_default() }
    fn cfg() -> Cfg { std::env::var("POSCTL_TEST_HOOKS").map(|s| parse(&s)).unwrap_or_default() }

    /// A hard stop like a power cut for the process: no destructors, the lock handle is released by the OS.
    pub fn hit(label: &str) {
        let c = cfg();
        if c.exit_at.as_deref() == Some(label) { std::process::exit(137); }
        if let Some(p) = c.pause_at {
            if p.label == label {
                let _ = std::fs::write(&p.flag, label);
                std::thread::sleep(std::time::Duration::from_millis(p.ms));
            }
        }
    }
    pub fn fail(label: &str) -> R<()> { fail_with(&cfg(), label) }
    fn fail_with(c: &Cfg, label: &str) -> R<()> {
        if c.fail_at.as_deref() != Some(label) { return Ok(()); }
        let code = match label { "migrate" => OpCode::MigrationFailed, "verify_live" => OpCode::VerifyFailedRolledBack, _ => OpCode::Error };
        Err(OpError::new(code, "TEST_HOOK_FAILURE", format!("injected failure at {label}")))
    }
    pub fn backup_mode() -> Option<String> { cfg().backup }
    pub fn allow_local_source() -> bool { cfg().allow_local_source.unwrap_or(false) }
    pub fn skip_staging_acl() -> bool { cfg().skip_staging_acl.unwrap_or(false) }
    pub fn skip_pepper_install() -> bool { cfg().skip_pepper_install.unwrap_or(false) }
    pub fn legacy_snapshot() -> bool { cfg().legacy_snapshot.unwrap_or(false) }
    pub fn skip_legacy_rederive() -> bool { cfg().skip_legacy_rederive.unwrap_or(false) }
    pub fn switch_console_file() -> Option<String> { cfg().switch_console_file }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn the_json_is_parsed_and_a_bad_one_means_no_hook() {
            let c = parse(r#"{"exit_at":"journal:swap:done","fail_at":"migrate","pause_at":{"label":"after:fence","flag":"f","ms":5},"backup":"ok"}"#);
            assert_eq!((c.exit_at.as_deref(), c.fail_at.as_deref(), c.backup.as_deref()), (Some("journal:swap:done"), Some("migrate"), Some("ok")));
            assert_eq!(c.pause_at.map(|p| (p.label, p.ms)), Some(("after:fence".to_string(), 5)));
            let h = parse(r#"{"skip_pepper_install":true,"switch_console_file":"C:\\answers.txt"}"#);
            assert_eq!((h.skip_pepper_install, h.switch_console_file.as_deref()), (Some(true), Some("C:\\answers.txt")));
            let none = parse("not json");
            assert!(none.exit_at.is_none() && none.fail_at.is_none() && none.pause_at.is_none() && none.backup.is_none());
        }
        #[test]
        fn the_two_plan_09_switches_default_to_off_and_read_true_only_when_set() {
            assert_eq!((parse("{}").allow_local_source, parse("{}").skip_staging_acl), (None, None));
            let c = parse(r#"{"allow_local_source":true,"skip_staging_acl":false}"#);
            assert_eq!((c.allow_local_source.unwrap_or(false), c.skip_staging_acl.unwrap_or(false)), (true, false));
            assert_eq!(parse(r#"{"allow_local_source":"yes"}"#).allow_local_source, None, "a bad value means no hook");
        }
        #[test]
        fn fail_at_fails_only_the_named_step_with_the_matching_code() {
            let c = parse(r#"{"fail_at":"verify_live"}"#);
            assert!(fail_with(&c, "migrate").is_ok());
            let e = fail_with(&c, "verify_live").unwrap_err();
            assert_eq!((e.code, e.reason.as_str()), (OpCode::VerifyFailedRolledBack, "TEST_HOOK_FAILURE"));
            assert_eq!(fail_with(&parse(r#"{"fail_at":"migrate"}"#), "migrate").unwrap_err().code, OpCode::MigrationFailed);
            assert!(fail_with(&parse("{}"), "migrate").is_ok());
        }
    }
}
#[cfg(feature = "test-hooks")]
pub use imp::{allow_local_source, backup_mode, fail, hit, legacy_snapshot, skip_legacy_rederive, skip_pepper_install, skip_staging_acl, switch_console_file};
