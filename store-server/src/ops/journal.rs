//! The operation journal: each step's intent is written (atomically) BEFORE the step runs.
//! Recovery reads it together with `pg_database`, which stays the source of truth.
//! It must never hold a secret: `extra` carries non-secret operation inputs only.
//! (The older top-level `crate::journal` is the provisioning step log and stays for `provision`.)
use crate::ops::names::DbNames;
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::paths::Roots;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const JOURNAL_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Step { Started, Fence, Backup, RepairCollation, CloneDb, Work, VerifyClone, Swap, Activate, VerifyLive, Reopen, Finalize, Rollback }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase { Intent, Done }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Journal {
    pub schema: u32,
    pub op_id: String,
    pub kind: OpKind,
    pub started_ms: u64,
    pub deadline_ms: u64,
    pub pack_from: Option<String>,
    pub pack_to: Option<String>,
    pub db: DbNames,
    /// The service roles set to NOLOGIN by the fence (recorded for the operator; unfence restores them idempotently).
    pub fence_roles: Vec<String>,
    pub step: Step,
    pub phase: Phase,
    pub rollback_from: Option<Step>,
    pub rollback_reason: Option<String>,
    /// Operation-specific data (Plan 09 stores its switch inputs here).
    pub extra: serde_json::Value,
}

/// What a failed read of the update state tells the operator: the folder is for SYSTEM and Administrators only.
pub const NEEDS_ELEVATION: &str = "if this is an access error, run the command elevated (as an administrator)";
/// `std::fs::read` as a plain function (the real answer to a `ReadFn`).
pub fn fs_read(p: &Path) -> std::io::Result<Vec<u8>> { std::fs::read(p) }
pub type ReadFn<'a> = &'a dyn Fn(&Path) -> std::io::Result<Vec<u8>>;

#[derive(Debug)]
pub enum JournalError { Corrupt(String), TooNew(u32), Io(String) }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalSummary { pub kind: OpKind, pub step: Step, pub phase: Phase, pub op_id: String, pub started_ms: u64 }

pub fn path(state: &Path) -> PathBuf { state.join("journal.json") }

impl Journal {
    pub fn new(kind: OpKind, op_id: &str, started_ms: u64, deadline_ms: u64, pack_from: Option<String>, pack_to: Option<String>) -> Journal {
        Journal {
            schema: JOURNAL_SCHEMA, op_id: op_id.into(), kind, started_ms, deadline_ms, pack_from, pack_to,
            db: DbNames::for_kind(kind, started_ms),
            fence_roles: vec!["authenticator".into(), "supabase_auth_admin".into()],
            step: Step::Started, phase: Phase::Intent, rollback_from: None, rollback_reason: None,
            extra: serde_json::Value::Null,
        }
    }

    /// Temp file, fsync, then rename over the journal: a reader sees the old or the new journal, never half.
    pub fn write(&self, state: &Path) -> std::io::Result<()> {
        // no create_dir_all: `state\update\` is made (and protected) by `acl::protect_update_dir`, never as a side effect of a write
        // write_atomic: create_new temp, fsync, rename with the Windows sharing-violation retry, temp cleanup on failure.
        // (No directory fsync: std cannot open a directory handle on Windows.)
        crate::util::write_atomic(&path(state), &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)
    }

    pub fn read(state: &Path) -> Result<Option<Journal>, JournalError> { Self::read_via(state, &crate::ops::journal::fs_read) }

    /// `read` with the file read injected (the test seam for an access-denied journal). Only NotFound means "no journal": any
    /// other error is `Io` (fail closed, never "nothing in progress").
    pub fn read_via(state: &Path, read: ReadFn) -> Result<Option<Journal>, JournalError> {
        let bytes = match read(&path(state)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(JournalError::Io(format!("{e}; {NEEDS_ELEVATION}"))),
        };
        // Check the schema before the typed parse: a newer journal may carry a Step/OpKind this build cannot name.
        let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| JournalError::Corrupt(e.to_string()))?;
        if let Some(s) = v.get("schema").and_then(|s| s.as_u64()) {
            if s > u64::from(JOURNAL_SCHEMA) { return Err(JournalError::TooNew(u32::try_from(s).unwrap_or(u32::MAX))); }
        }
        let j: Journal = serde_json::from_value(v).map_err(|e| JournalError::Corrupt(e.to_string()))?;
        Ok(Some(j))
    }

    /// The journal of a store: `state\update\`, else (a store from before FR19, not yet migrated) `state\`.
    pub fn read_roots(roots: &Roots) -> Result<Option<Journal>, JournalError> { Self::read_roots_via(roots, &crate::ops::journal::fs_read) }
    pub fn read_roots_via(roots: &Roots, read: ReadFn) -> Result<Option<Journal>, JournalError> {
        match Self::read_via(&roots.update_dir(), read)? {
            Some(j) => Ok(Some(j)),
            None => Self::read_via(&roots.state(), read),
        }
    }

    pub fn archive(&self, state: &Path, ops_log_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(ops_log_dir)?;
        let dest = ops_log_dir.join(format!("{}.journal.json", self.op_id));
        crate::util::write_atomic(&dest, &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)?;
        match std::fs::remove_file(path(state)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

/// Moves what a pre-FR19 store left in `state\` into `state\update\` (journal, result, fence sidecar, rolled-back record). The caller
/// holds `update.lock` exclusive, so no operation is writing them. Each file is REWRITTEN, not renamed: a rename keeps the old
/// file's DACL (with the Gateway ACE `state\` handed it), a new file inherits the protected folder's. When both places hold a file the
/// new one wins and the old one is dropped; only two DIFFERENT journals are refused (which one is the interrupted operation?).
pub fn migrate_legacy(roots: &Roots) -> Result<(), OpError> {
    let io = |p: &Path, e: std::io::Error| OpError::new(OpCode::RecoveryNeeded, "JOURNAL_IO", format!("{}: {e}; {NEEDS_ELEVATION}", p.display()));
    let nf = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;
    for new in [roots.journal(), roots.update_result(), roots.fence_start_types(), roots.rolled_back_record()] {
        let old = roots.legacy_of(&new);
        let old_bytes = match std::fs::read(&old) { Ok(b) => b, Err(e) if nf(&e) => continue, Err(e) => return Err(io(&old, e)) };
        match std::fs::read(&new) {
            Err(e) if nf(&e) => crate::util::write_atomic(&new, &old_bytes).map_err(|e| io(&new, e))?,
            Err(e) => return Err(io(&new, e)),
            Ok(cur) if cur != old_bytes && new == roots.journal() => {
                return Err(OpError::new(OpCode::RecoveryNeeded, "JOURNAL_CONFLICT", format!("two different journals exist ({} and {}); keep the right one and delete the other, then run `posctl update --recover`", old.display(), new.display())));
            }
            Ok(_) => {}
        }
        std::fs::remove_file(&old).map_err(|e| io(&old, e))?;
    }
    Ok(())
}

pub fn peek(state: &Path) -> Option<JournalSummary> {
    let j = Journal::read(state).ok()??;
    Some(JournalSummary { kind: j.kind, step: j.step, phase: j.phase, op_id: j.op_id, started_ms: j.started_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Journal {
        Journal::new(OpKind::Update, "op-1", 1_790_908_215_000, 1_790_909_115_000, Some("1.0.0-r1".into()), Some("1.0.1-r1".into()))
    }

    #[test]
    fn steps_are_ordered_as_the_runner_executes_them() {
        use Step::*;
        let order = [Started, Fence, Backup, RepairCollation, CloneDb, Work, VerifyClone, Swap, Activate, VerifyLive, Reopen, Finalize, Rollback];
        for w in order.windows(2) { assert!(w[0] < w[1], "{:?} < {:?}", w[0], w[1]); }
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_file() {
        let d = tempfile::tempdir().unwrap();
        let mut j = sample();
        j.step = Step::Swap; j.phase = Phase::Intent;
        j.write(d.path()).unwrap();
        assert_eq!(Journal::read(d.path()).unwrap(), Some(j));
        // write_atomic names its temp `.journal.json.<hex>.tmp`; none may survive a successful write
        let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["journal.json".to_string()]);
    }

    #[test]
    fn absent_is_none_and_corrupt_is_an_error_not_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Journal::read(d.path()).unwrap(), None);
        std::fs::write(path(d.path()), b"{ torn").unwrap();
        assert!(matches!(Journal::read(d.path()), Err(JournalError::Corrupt(_))));
        assert!(peek(d.path()).is_none());
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut j = sample(); j.schema = JOURNAL_SCHEMA + 1;
        j.write(d.path()).unwrap();
        assert!(matches!(Journal::read(d.path()), Err(JournalError::TooNew(_))));
    }

    #[test]
    fn a_leftover_temp_file_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("journal.json.tmp"), b"garbage").unwrap();
        assert_eq!(Journal::read(d.path()).unwrap(), None);
    }

    #[test]
    fn archive_moves_the_journal_into_the_ops_log() {
        let d = tempfile::tempdir().unwrap();
        let logs = d.path().join("logs");
        let j = sample();
        j.write(d.path()).unwrap();
        j.archive(d.path(), &logs).unwrap();
        assert!(!path(d.path()).exists());
        assert!(logs.join("op-1.journal.json").exists());
    }

    #[test]
    fn a_newer_journal_with_an_unknown_step_is_too_new_not_corrupt() {
        let d = tempfile::tempdir().unwrap();
        let mut v = serde_json::to_value(sample()).unwrap();
        v["schema"] = serde_json::json!(JOURNAL_SCHEMA + 1);
        v["step"] = serde_json::json!("a_step_from_the_future");
        v["kind"] = serde_json::json!("a_kind_from_the_future");
        std::fs::write(path(d.path()), serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(matches!(Journal::read(d.path()), Err(JournalError::TooNew(s)) if s == JOURNAL_SCHEMA + 1));
    }

    // ---- FR19: the control files moved to state\update\ ----
    fn roots_in(d: &tempfile::TempDir) -> Roots {
        let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(r.update_dir()).unwrap();
        r
    }

    #[test]
    fn a_journal_left_in_state_is_found_until_it_is_migrated() {
        let d = tempfile::tempdir().unwrap();
        let r = roots_in(&d);
        assert_eq!(Journal::read_roots(&r).unwrap(), None);
        let j = sample();
        j.write(&r.state()).unwrap(); // where a pre-FR19 posctl wrote it
        assert_eq!(Journal::read_roots(&r).unwrap(), Some(j));
    }

    #[test]
    fn migrate_moves_the_old_files_into_the_update_folder_and_the_old_copies_go() {
        let d = tempfile::tempdir().unwrap();
        let r = roots_in(&d);
        let j = sample();
        j.write(&r.state()).unwrap();
        std::fs::write(r.legacy_of(&r.update_result()), br#"{"lastResult":"updated"}"#).unwrap();
        std::fs::write(r.legacy_of(&r.fence_start_types()), b"{}").unwrap();
        std::fs::write(r.legacy_of(&r.rolled_back_record()), b"{}").unwrap();
        migrate_legacy(&r).unwrap();
        assert_eq!(Journal::read(&r.update_dir()).unwrap(), Some(j));
        for new in [r.journal(), r.update_result(), r.fence_start_types(), r.rolled_back_record()] {
            assert!(new.exists(), "{}", new.display());
            assert!(!r.legacy_of(&new).exists(), "{} was left behind in state\\", new.display());
        }
        migrate_legacy(&r).unwrap(); // idempotent
    }

    #[test]
    fn migrate_refuses_two_different_journals_and_keeps_both() {
        let d = tempfile::tempdir().unwrap();
        let r = roots_in(&d);
        sample().write(&r.state()).unwrap();
        let mut other = sample(); other.op_id = "op-2".into();
        other.write(&r.update_dir()).unwrap();
        let e = migrate_legacy(&r).unwrap_err();
        assert_eq!(e.code, crate::ops::outcome::OpCode::RecoveryNeeded);
        assert!(r.legacy_of(&r.journal()).exists() && r.journal().exists());
    }

    #[test]
    fn an_access_denied_journal_is_an_io_error_that_says_to_run_elevated_never_none() {
        let d = tempfile::tempdir().unwrap();
        let r = roots_in(&d);
        let denied = |_: &Path| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        match Journal::read_roots_via(&r, &denied) {
            Err(JournalError::Io(m)) => assert!(m.contains("elevated"), "{m}"),
            other => panic!("{other:?}"),
        }
        // a denied NEW location is not retried against the old one
        let calls = std::cell::Cell::new(0);
        let counting = |_: &Path| { calls.set(calls.get() + 1); Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) };
        assert!(Journal::read_roots_via(&r, &counting).is_err());
        assert_eq!(calls.get(), 1);
    }
}
