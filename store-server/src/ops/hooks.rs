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

#[cfg(feature = "test-hooks")]
mod imp {
    use crate::ops::outcome::{OpCode, OpError};
    use crate::ops::world::R;
    use serde::Deserialize;

    #[derive(Deserialize, Default)]
    struct Pause { label: String, flag: String, ms: u64 }
    #[derive(Deserialize, Default)]
    struct Cfg { exit_at: Option<String>, fail_at: Option<String>, pause_at: Option<Pause>, backup: Option<String> }
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

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn the_json_is_parsed_and_a_bad_one_means_no_hook() {
            let c = parse(r#"{"exit_at":"journal:swap:done","fail_at":"migrate","pause_at":{"label":"after:fence","flag":"f","ms":5},"backup":"ok"}"#);
            assert_eq!((c.exit_at.as_deref(), c.fail_at.as_deref(), c.backup.as_deref()), (Some("journal:swap:done"), Some("migrate"), Some("ok")));
            assert_eq!(c.pause_at.map(|p| (p.label, p.ms)), Some(("after:fence".to_string(), 5)));
            let none = parse("not json");
            assert!(none.exit_at.is_none() && none.fail_at.is_none() && none.pause_at.is_none() && none.backup.is_none());
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
pub use imp::{backup_mode, fail, hit};
