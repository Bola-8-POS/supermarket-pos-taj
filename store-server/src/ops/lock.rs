//! The one operation lock (conventions 11.3). OS-exclusive via std's `File::try_lock` (LockFileEx on
//! Windows). Locks are per handle, so two handles in one process conflict, which the tests rely on.
//! An advisory lock inside Postgres is rejected: it is lost on a Postgres crash (S8).
//!
//! F8 f (hardened; Plan 07's copy adopts this version): the lock NEVER creates a folder (`state\` must
//! already exist, made and ACL'd by the layout step) and never follows a link in its place. FR19: the lock
//! file lives in `state\update\`; `acquire_for` creates or repairs that folder, `acquire` / `probe` never do. They judge
//! the folder they are given on one handle (a reparse point is refused). `acquire_for` / `probe_for` are what
//! production callers use: they additionally judge the data root and `state\` by owner (Administrators,
//! SYSTEM, TrustedInstaller) and give `update.lock` its own SYSTEM + Administrators DACL.
use crate::ops::outcome::{OpCode, OpError};
use crate::paths::Roots;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockMode { Exclusive, Shared }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockInfo { pub pid: u32, pub op_id: String, pub kind: String, pub started_ms: u64 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockState {
    Free,
    SharedHeld,
    ExclusiveHeld(LockInfo),
    /// The lock file could not be opened or tried: never reported as `Free`.
    Unknown(String),
}

#[derive(Debug)]
pub struct LockGuard { _file: File, info_path: Option<PathBuf>, mode: LockMode }
impl LockGuard {
    /// The mode this guard was taken in (a caller that needs the exclusive lock asserts it; the guard type alone cannot say).
    pub fn mode(&self) -> LockMode { self.mode }
}
impl Drop for LockGuard {
    fn drop(&mut self) { if let Some(p) = &self.info_path { let _ = fs::remove_file(p); } }
}

fn lock_path(state: &Path) -> PathBuf { state.join("update.lock") }
fn info_path(state: &Path) -> PathBuf { state.join("update.lock.info") }
fn read_info(state: &Path) -> Option<LockInfo> {
    serde_json::from_slice(&fs::read(info_path(state)).ok()?).ok()
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn io_err(what: &Path, e: impl std::fmt::Display) -> OpError {
    OpError::err("LOCK_IO", format!("{}: {e}", what.display()))
}
/// `state\` must exist and must not be a link: judged on one handle, then the lock file is opened inside it.
fn open(state: &Path) -> Result<File, OpError> {
    let t = crate::sys::open_trust(state).map_err(|e| io_err(state, e))?;
    if t.reparse || !t.is_dir {
        return Err(io_err(state, "is a reparse point or not a folder; refusing to use it for update.lock"));
    }
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path(state)).map_err(|e| io_err(state, e))
}
/// Production gate: the data root and `state\` are not links and are owned by a trusted account.
fn trusted(roots: &Roots) -> Result<(), OpError> {
    if !roots.dev {
        for dir in [roots.data.clone(), roots.state()] {
            crate::layout::check_dir_trust(&dir, &|o| crate::layout::TRUSTED_OWNERS.contains(&o)).map_err(|e| OpError::new(OpCode::Precondition, "LOCK_UNTRUSTED", e.message))?;
        }
    } else {
        // a dev root may be owned by the developer, but a link in place of the data root is never fine
        let t = crate::sys::open_trust(&roots.data).map_err(|e| io_err(&roots.data, e))?;
        if t.reparse {
            return Err(io_err(&roots.data, "is a reparse point; refusing to use it for update.lock"));
        }
    }
    Ok(())
}
fn held(holder: Option<LockInfo>) -> OpError {
    let msg = match holder {
        Some(i) => format!("another {} (process {}) holds update.lock", i.kind, i.pid),
        None => "a backup or verify run holds update.lock".to_string(),
    };
    OpError::new(OpCode::LockHeld, "LOCK_HELD", msg)
}

/// Production entry point: trust checks first, then `state\update\` is created or repaired (protected DACL), then `acquire`, then the
/// lock file's own ACL. An EXCLUSIVE holder then moves what a pre-FR19 store left in `state\` into `state\update\` (under the lock, so
/// nothing is writing it). Every caller of this is elevated (the DACL is applied here each time), like `protect_lock_file` always was.
pub fn acquire_for(roots: &Roots, mode: LockMode, kind: &str, op_id: &str, wait: Duration) -> Result<LockGuard, OpError> {
    trusted(roots)?;
    crate::acl::protect_update_dir(roots).map_err(|m| OpError::new(OpCode::Precondition, "LOCK_IO", format!("{m}; {}", crate::ops::journal::NEEDS_ELEVATION)))?;
    let guard = acquire(&roots.update_dir(), mode, kind, op_id, wait)?;
    protect_lock_file(roots)?;
    if mode == LockMode::Exclusive {
        crate::ops::journal::migrate_legacy(roots)?;
    }
    Ok(guard)
}

/// `update.lock` gets SYSTEM + Administrators only (the Gateway ACE that `state\` hands to its files would let
/// it lock the file and stall every update). Elevated callers only, so skipped in dev.
fn protect_lock_file(roots: &Roots) -> Result<(), OpError> {
    if roots.dev {
        return Ok(());
    }
    let e = crate::acl::lock_file_acl(roots);
    crate::acl::apply_one(&e.path, &e.grants).map_err(|m| OpError::err("LOCK_IO", m))
}

/// `probe_readonly` behind the same trust check as `probe_for`.
pub fn probe_readonly_for(roots: &Roots) -> LockState {
    match trusted(roots) { Ok(()) => probe_readonly(&roots.update_dir()), Err(e) => LockState::Unknown(e.message) }
}

pub fn probe_for(roots: &Roots) -> LockState {
    match trusted(roots) {
        Ok(()) => probe(&roots.update_dir()),
        Err(e) => LockState::Unknown(e.message),
    }
}

pub fn acquire(state: &Path, mode: LockMode, kind: &str, op_id: &str, wait: Duration) -> Result<LockGuard, OpError> {
    let file = open(state)?;
    let started = Instant::now();
    loop {
        let r = match mode { LockMode::Exclusive => file.try_lock(), LockMode::Shared => file.try_lock_shared() };
        match r {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                let holder = read_info(state);
                // An exclusive holder (it writes the info file) never finishes soon: fail fast.
                if holder.is_some() || started.elapsed() >= wait { return Err(held(holder)); }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(TryLockError::Error(e)) => return Err(io_err(state, e)),
        }
    }
    match mode {
        LockMode::Exclusive => {
            let info = LockInfo { pid: std::process::id(), op_id: op_id.into(), kind: kind.into(), started_ms: now_ms() };
            // atomic: a probe racing this write reads the old file or the whole new one, never half
            crate::util::write_atomic(&info_path(state), &serde_json::to_vec(&info).unwrap_or_default()).map_err(|e| io_err(state, e))?;
            Ok(LockGuard { _file: file, info_path: Some(info_path(state)), mode })
        }
        LockMode::Shared => {
            // We got a shared lock, so no exclusive holder exists: any info file is stale.
            let _ = fs::remove_file(info_path(state));
            Ok(LockGuard { _file: file, info_path: None, mode })
        }
    }
}

pub fn probe(state: &Path) -> LockState {
    let file = match open(state) {
        Ok(f) => f,
        Err(e) => return LockState::Unknown(e.message),
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = file.unlock();
            let _ = fs::remove_file(info_path(state));
            LockState::Free
        }
        Err(TryLockError::WouldBlock) => match read_info(state) { Some(i) => LockState::ExclusiveHeld(i), None => LockState::SharedHeld },
        Err(TryLockError::Error(e)) => LockState::Unknown(e.to_string()),
    }
}

/// The status writer's probe: it opens an EXISTING lock file (never creates one), tries the lock shared and lets go at once, and
/// never touches `.info` (only an acquirer cleans a stale one). No lock file means free; an exclusive holder is named from its
/// `.info`. A shared holder (a backup) is not an operation and reads as free here.
pub fn probe_readonly(state: &Path) -> LockState {
    let file = match OpenOptions::new().read(true).open(lock_path(state)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LockState::Free,
        Err(e) => return LockState::Unknown(format!("{}: {e}", lock_path(state).display())),
    };
    match file.try_lock_shared() {
        Ok(()) => { let _ = file.unlock(); LockState::Free }
        Err(TryLockError::WouldBlock) => match read_info(state) { Some(i) => LockState::ExclusiveHeld(i), None => LockState::SharedHeld },
        Err(TryLockError::Error(e)) => LockState::Unknown(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn dir() -> tempfile::TempDir { tempfile::tempdir().unwrap() }
    const NOW: Duration = Duration::from_millis(0);

    #[test]
    fn second_exclusive_is_refused_immediately_with_lock_held() {
        let d = dir();
        let _a = acquire(d.path(), LockMode::Exclusive, "update", "op-1", NOW).unwrap();
        let e = acquire(d.path(), LockMode::Exclusive, "update", "op-2", Duration::from_secs(30)).unwrap_err();
        assert_eq!((e.code, e.retryable), (OpCode::LockHeld, true));
    }

    #[test]
    fn shared_holders_coexist_and_block_exclusive_until_released() {
        let d = dir();
        let a = acquire(d.path(), LockMode::Shared, "backup", "b-1", NOW).unwrap();
        let _b = acquire(d.path(), LockMode::Shared, "backup", "b-2", NOW).unwrap();
        assert!(acquire(d.path(), LockMode::Exclusive, "update", "u", NOW).is_err());
        drop(a);
        assert!(acquire(d.path(), LockMode::Exclusive, "update", "u", NOW).is_err()); // b-2 still holds
    }

    #[test]
    fn exclusive_waits_for_a_shared_holder_that_finishes() {
        let d = dir();
        let s = acquire(d.path(), LockMode::Shared, "backup", "b", NOW).unwrap();
        let p = d.path().to_path_buf();
        let h = std::thread::spawn(move || acquire(&p, LockMode::Exclusive, "update", "u", Duration::from_secs(5)).is_ok());
        std::thread::sleep(Duration::from_millis(600));
        drop(s);
        assert!(h.join().unwrap());
    }

    #[test]
    fn shared_is_refused_while_an_exclusive_holder_runs() {
        let d = dir();
        let _x = acquire(d.path(), LockMode::Exclusive, "update", "u", NOW).unwrap();
        let e = acquire(d.path(), LockMode::Shared, "backup", "b", Duration::from_secs(30)).unwrap_err();
        assert_eq!(e.code, OpCode::LockHeld);
    }

    #[test]
    fn probe_reports_the_exclusive_holder_and_release_clears_it() {
        let d = dir();
        assert_eq!(probe(d.path()), LockState::Free);
        let g = acquire(d.path(), LockMode::Exclusive, "switch", "op-9", NOW).unwrap();
        match probe(d.path()) {
            LockState::ExclusiveHeld(i) => assert_eq!((i.kind.as_str(), i.op_id.as_str()), ("switch", "op-9")),
            other => panic!("{other:?}"),
        }
        drop(g);
        assert_eq!(probe(d.path()), LockState::Free);
        assert!(!d.path().join("update.lock.info").exists());
    }

    // F8 f: the lock never creates folders, and never follows a link in place of state\ or the data root.
    #[test]
    fn a_missing_state_folder_is_an_error_and_nothing_is_created() {
        let d = dir();
        let state = d.path().join("data").join("state");
        let e = acquire(&state, LockMode::Exclusive, "update", "u", NOW).unwrap_err();
        assert_eq!(e.reason, "LOCK_IO");
        assert!(!d.path().join("data").exists());
        assert!(matches!(probe(&state), LockState::Unknown(_)), "probe must not say Free for a folder it cannot open");
        assert!(!d.path().join("data").exists());
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn a_state_folder_that_is_a_junction_is_refused() {
        let d = dir();
        let target = d.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let state = d.path().join("state");
        junction(&state, &target);
        let e = acquire(&state, LockMode::Exclusive, "update", "u", NOW).unwrap_err();
        assert_eq!(e.reason, "LOCK_IO");
        assert!(e.message.contains("reparse"), "{}", e.message);
        assert!(!target.join("update.lock").exists(), "nothing was created through the link");
        assert!(matches!(probe(&state), LockState::Unknown(_)));
    }

    #[cfg(windows)]
    #[test]
    fn a_data_root_that_is_a_junction_is_refused_by_the_roots_variant() {
        let d = dir();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(target.join("state")).unwrap();
        let data = d.path().join("data");
        junction(&data, &target);
        let roots = Roots::custom(data, d.path().join("p"));
        let e = acquire_for(&roots, LockMode::Exclusive, "update", "u", NOW).unwrap_err();
        assert!(e.message.contains("reparse"), "{}", e.message);
        assert!(!target.join("state").join("update.lock").exists());
        assert!(matches!(probe_for(&roots), LockState::Unknown(_)));
    }

    #[cfg(windows)]
    #[test]
    fn a_production_variant_refuses_a_state_folder_with_an_untrusted_owner() {
        let d = dir();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        std::fs::create_dir_all(roots.state()).unwrap();
        let owner = crate::sys::path_owner_sid(&roots.state()).unwrap();
        // dev root: not checked
        assert!(acquire_for(&roots, LockMode::Exclusive, "update", "u", NOW).is_ok());
        roots.dev = false;
        if crate::layout::TRUSTED_OWNERS.contains(&owner.as_str()) {
            return; // elevated run: the folder is Administrators-owned, the refusal path is unreachable
        }
        let e = acquire_for(&roots, LockMode::Exclusive, "update", "u", NOW).unwrap_err();
        assert!(e.message.contains("owned by"), "{}", e.message);
        assert!(matches!(probe_for(&roots), LockState::Unknown(_)));
    }

    #[test]
    fn the_info_file_is_written_whole_and_leaves_no_temp_file() {
        let d = dir();
        let _g = acquire(d.path(), LockMode::Exclusive, "update", "op-1", NOW).unwrap();
        assert_eq!(read_info(d.path()).unwrap().op_id, "op-1");
        let mut names: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["update.lock".to_string(), "update.lock.info".to_string()]);
    }

    #[test]
    fn a_stale_info_file_does_not_make_a_shared_holder_look_exclusive() {
        let d = dir();
        std::fs::write(d.path().join("update.lock.info"), r#"{"pid":1,"op_id":"x","kind":"update","started_ms":0}"#).unwrap();
        let _s = acquire(d.path(), LockMode::Shared, "backup", "b", NOW).unwrap(); // success removes the stale info
        assert_eq!(probe(d.path()), LockState::SharedHeld);
    }

    // ---- FR7 P ----
    #[test]
    fn a_readonly_probe_creates_nothing_and_leaves_a_stale_info_file_alone() {
        let d = dir();
        assert_eq!(probe_readonly(d.path()), LockState::Free, "no lock file: free");
        assert!(!d.path().join("update.lock").exists(), "a status probe must not create the lock file");
        std::fs::write(d.path().join("update.lock"), "").unwrap();
        std::fs::write(d.path().join("update.lock.info"), b"{\"pid\":1,\"op_id\":\"x\",\"kind\":\"update\",\"started_ms\":1}").unwrap();
        assert_eq!(probe_readonly(d.path()), LockState::Free);
        assert!(d.path().join("update.lock.info").exists(), "only an acquirer cleans stale info");
    }

    #[test]
    fn a_readonly_probe_names_the_live_holder_and_leaves_its_info_intact() {
        let d = dir();
        let _x = acquire(d.path(), LockMode::Exclusive, "update", "op-9", NOW).unwrap();
        match probe_readonly(d.path()) {
            LockState::ExclusiveHeld(i) => assert_eq!((i.kind.as_str(), i.op_id.as_str()), ("update", "op-9")),
            other => panic!("{other:?}"),
        }
        assert!(d.path().join("update.lock.info").exists());
        assert!(matches!(acquire(d.path(), LockMode::Exclusive, "update", "again", NOW), Err(e) if e.code == OpCode::LockHeld));
    }

    // ---- FR19: the lock and the journal live in state\update\ ----
    #[test]
    fn the_production_lock_lives_in_state_update_and_an_exclusive_one_migrates_a_leftover_journal_under_it() {
        let d = dir();
        let roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        std::fs::create_dir_all(roots.state()).unwrap();
        std::fs::write(roots.legacy_of(&roots.journal()), b"{}").unwrap(); // a pre-FR19 leftover
        let shared = acquire_for(&roots, LockMode::Shared, "backup", "b", NOW).unwrap();
        assert!(roots.legacy_of(&roots.journal()).exists(), "a shared holder does not move anything");
        drop(shared);
        let g = acquire_for(&roots, LockMode::Exclusive, "update", "u", NOW).unwrap();
        assert!(roots.update_lock().exists() && !roots.state().join("update.lock").exists());
        assert!(roots.journal().exists() && !roots.legacy_of(&roots.journal()).exists(), "moved while the lock was held");
        assert!(matches!(probe_readonly_for(&roots), LockState::ExclusiveHeld(_)));
        drop(g);
        assert_eq!(probe_for(&roots), LockState::Free);
    }
}
