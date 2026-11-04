//! "Is this folder private to SYSTEM and Administrators?" (conventions 2.2: `backups\` holds plaintext PINs
//! and SCRAM verifiers while a dump exists, S7 REVIEW I4).
//!
//! Plan text shells out to `icacls /save` and parses SDDL. Plan 05 already reads a DACL ACE by ACE with SIDs
//! (`sys::open_trust`: one handle, no reparse-point following, owner + DACL), so this reuses it and keeps only
//! the policy decision here.
use std::path::{Path, PathBuf};

use super::ctx::BackupCtx;
use super::result::{BResult, BackupError};
use super::util::{hex, random_bytes};
use crate::acl::{SID_ADMINISTRATORS, SID_SYSTEM};
use crate::sys::{HandleInfo, PathAcl};


/// Owner Administrators and a protected DACL from the first instant: SYSTEM and Administrators only, inherited by children.
/// The explicit owner matters: without it a creator's default owner could be a user, which `assert_private` refuses on every later run.
/// A caller that cannot own as Administrators (not elevated) fails the create with ERROR_INVALID_OWNER (1307): fail closed, no fallback.
const PRIVATE_SDDL: &str = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/// Host tests run as a standard user and cannot set owner Administrators, so test builds create owner-less unless a test opts in
/// (the elevated test). Production builds have no such path: `private_sddl()` is always `PRIVATE_SDDL`.
#[cfg(test)]
const HOST_TEST_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
#[cfg(test)]
thread_local!(static OWNED_AS_ADMINS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });

fn private_sddl() -> &'static str {
    #[cfg(test)]
    {
        if !OWNED_AS_ADMINS.with(|o| o.get()) {
            return HOST_TEST_SDDL;
        }
    }
    PRIVATE_SDDL
}

/// Pure policy over a DACL: protected, only ALLOW (0) and DENY (1) entries, and every ALLOW entry belongs to
/// SYSTEM or Administrators. Deny entries grant nothing and are otherwise ignored.
pub fn acl_is_private(acl: &PathAcl) -> Result<(), Vec<String>> {
    let mut bad = Vec::new();
    if !acl.protected {
        bad.push("inheritance is not protected".to_string());
    }
    for ace in &acl.aces {
        // `sys::read_acl` reports every entry type other than allow/deny (object, callback, audit, ...) as `<ace type N>`
        if ace.sid.starts_with("<ace type") {
            bad.push(format!("unexpected entry {} (only allow and deny entries are accepted)", ace.sid));
        } else if ace.allow && ace.sid != SID_SYSTEM && ace.sid != SID_ADMINISTRATORS {
            bad.push(format!("{} may access this folder", ace.sid));
        }
    }
    if bad.is_empty() { Ok(()) } else { Err(bad) }
}

/// Pure policy over what one handle saw: not a reparse point, owned by SYSTEM or Administrators, and a private DACL.
pub fn trust_is_private(h: &HandleInfo) -> Result<(), Vec<String>> {
    let mut bad = Vec::new();
    if h.reparse {
        bad.push("it is a reparse point (junction or symlink)".to_string());
    }
    if h.owner != SID_SYSTEM && h.owner != SID_ADMINISTRATORS {
        bad.push(format!("owned by {}", h.owner));
    }
    if let Err(v) = acl_is_private(&h.acl) {
        bad.extend(v);
    }
    if bad.is_empty() { Ok(()) } else { Err(bad) }
}

/// Err(PRECONDITION) when `path` is readable by anyone but SYSTEM and Administrators, is a link, or is owned by
/// someone else. One handle opened without following links supplies owner and DACL (`sys::open_trust`), so a
/// name cannot be swapped between the check and the read. `--dev` roots skip the check (developer profile).
pub fn assert_private(ctx: &BackupCtx, path: &Path) -> BResult<()> {
    if ctx.is_dev() {
        return Ok(());
    }
    let h = crate::sys::open_trust(path).map_err(|e| BackupError::precondition(format!("cannot read the permissions of {}: {e}", path.display())))?;
    trust_is_private(&h).map_err(|v| BackupError::precondition(format!("{} is not private: {}", path.display(), v.join("; "))))
}

/// Number of hard links to the file behind `f` (Windows `nNumberOfLinks`); 1 elsewhere.
#[cfg(windows)]
pub(crate) fn link_count(f: &std::fs::File) -> std::io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is valid while `f` lives and `info` is a valid out pointer.
    unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.map_err(std::io::Error::other)?;
    Ok(info.nNumberOfLinks)
}

#[cfg(not(windows))]
pub(crate) fn link_count(_f: &std::fs::File) -> std::io::Result<u32> {
    Ok(1)
}

/// Overwrite a secret file IN PLACE with zeros (streamed, so a multi-GB dump is not held in memory), then delete it. A read-only
/// attribute is cleared first. A file with more than one hard link is only unlinked: zero-filling it would destroy the other
/// name. Any failure to open, write or sync is an Err and the file is NOT deleted, so a success always means the plaintext is gone.
#[allow(clippy::permissions_set_readonly_false)] // the lint is about Unix; here it clears the Windows read-only attribute
pub fn scrub_and_remove(path: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let md = std::fs::symlink_metadata(path)?;
    if md.permissions().readonly() {
        let mut perm = md.permissions();
        perm.set_readonly(false);
        std::fs::set_permissions(path, perm)?;
    }
    let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
    if link_count(&f)? > 1 {
        drop(f);
        return std::fs::remove_file(path);
    }
    let zeros = vec![0u8; 1 << 20];
    let mut left = md.len();
    while left > 0 {
        let n = left.min(zeros.len() as u64) as usize;
        f.write_all(&zeros[..n])?;
        left -= n as u64;
    }
    f.sync_all()?;
    drop(f);
    std::fs::remove_file(path)
}

/// Zero-fills and deletes every regular file under `dir`, recursively and without ever following a link (a link is removed
/// itself and its name returned), then removes the folders. Err when something is still there afterwards.
pub fn scrub_tree(dir: &Path) -> std::io::Result<Vec<String>> {
    // the root itself is never followed either: a junction here would send the zero-fill to its target
    if link_state(dir) != Some(false) {
        return Err(std::io::Error::other(format!("{} is a link or cannot be inspected; not scrubbed", dir.display())));
    }
    let mut links = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let p = e.path();
            match link_state(&p) {
                Some(false) if p.is_dir() => {
                    dirs.push(p.clone());
                    todo.push(p);
                }
                Some(false) => scrub_and_remove(&p)?,
                state => {
                    remove_link(&p);
                    if state == Some(true) {
                        links.push(e.file_name().to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    for d in dirs.iter().rev() {
        std::fs::remove_dir(d)?;
    }
    Ok(links)
}


/// `backups\` itself, for a caller that can run before any backup preflight (the local repository is created under it). Provisioning
/// normally made it; if it is missing it is born private rather than inherited, and it must pass `assert_private` either way.
pub fn ensure_private_backups(ctx: &BackupCtx) -> BResult<()> {
    let backups = ctx.paths.backups();
    if ctx.is_dev() {
        std::fs::create_dir_all(&backups)?;
        return Ok(());
    }
    create_private_dir(&backups)?;
    assert_private(ctx, &backups)
}

/// `backups\tmp\`, born private. `create_dir_all` would give it the inherited DACL and `assert_private` would then refuse
/// it on the very first run. `backups\` itself is provisioned private (`data_acl_plan`), so it is checked first and never
/// created here: an unsafe or missing `backups\` creates nothing. `--dev` roots just create the folders.
fn ensure_private_tmp(ctx: &BackupCtx) -> BResult<PathBuf> {
    let tmp = ctx.paths.backups_tmp();
    if ctx.is_dev() {
        std::fs::create_dir_all(&tmp)?;
        return Ok(tmp);
    }
    assert_private(ctx, &ctx.paths.backups())?;
    create_private_dir(&tmp)?;
    Ok(tmp)
}

/// One level, protected DACL from birth. An existing folder is left for the caller's `assert_private` to judge.
fn create_private_dir(dir: &Path) -> BResult<()> {
    match crate::sys::create_dir_with_sddl(dir, private_sddl()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(BackupError::precondition(format!("cannot create {}: {e}", dir.display()))),
    }
}

/// A per-run scratch folder under `backups\tmp\`, private from its first instant, removed when dropped.
/// The recovery-key file and anything else secret lives here, never loose in the shared `tmp`.
///
/// Every `PrivateDir` user must hold `backup.lock` (via `run::gated`): a backup run's startup sweep removes every
/// `run-*` folder, so a user without the lock can have its folder deleted underneath it.
pub struct PrivateDir(PathBuf);

impl PrivateDir {
    pub fn create(ctx: &BackupCtx) -> BResult<Self> {
        let mut r = [0u8; 6];
        random_bytes(&mut r)?;
        let parent = ensure_private_tmp(ctx)?;
        // the new folder is only as private as the chain above it: check `backups\` and `backups\tmp` (a no-op for
        // `--dev` roots); the passing case needs SYSTEM/Administrators ownership and is covered in Windows Sandbox (Task 13)
        assert_private(ctx, &ctx.paths.backups())?;
        assert_private(ctx, &parent)?;
        let dir = parent.join(format!("run-{}", hex(&r)));
        if ctx.is_dev() {
            std::fs::create_dir(&dir)?;
            return Ok(PrivateDir(dir));
        }
        // new folder only (AlreadyExists is an error), protected DACL from birth; then the same check as any private path
        crate::sys::create_dir_with_sddl(&dir, private_sddl()).map_err(|e| BackupError::precondition(format!("cannot create {}: {e}", dir.display())))?; // AlreadyExists stays an error here
        let guard = PrivateDir(dir);
        assert_private(ctx, &guard.0)?;
        Ok(guard)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `Some(true)`: inspected and a reparse point. `Some(false)`: inspected and not one. `None`: could not be inspected (only the
/// first is a finding worth reporting; the last is treated as a link for safety, but nothing is claimed about it).
pub(crate) fn link_state(p: &Path) -> Option<bool> {
    std::fs::symlink_metadata(p).ok().map(|m| crate::pack::is_reparse(&m))
}

/// Removes a link ITSELF without following it (`RemoveDirectoryW` on a junction deletes the reparse point, never the target's
/// content); a file symlink goes with `remove_file`. Whatever the outcome, the target is untouched.
pub(crate) fn remove_link(p: &Path) {
    if std::fs::remove_dir(p).is_err() {
        let _ = std::fs::remove_file(p);
    }
}

/// The warning for a link found among the scratch entries (it was removed, never followed).
pub fn link_warning(name: &str) -> String {
    format!("a link named {name} was found in the backup scratch folders and was removed without being followed")
}

/// Startup sweep (invariant 3): a dump, a recovery-key file or a scratch folder left by a crashed run. Returns warnings (ready to show):
/// a link found among the entries (removed without being followed) and a folder that could not be zero-filled (then deleted without it).
// CARRY T5: `run_backup` calls this first, before it takes `backup.lock` work, on every start (scheduled or manual).
pub fn sweep_stale(ctx: &BackupCtx) -> BResult<Vec<String>> {
    assert_scratch_roots_private(ctx)?;
    let mut warnings = Vec::new();
    if let Ok(rd) = std::fs::read_dir(ctx.paths.backups_tmp()) {
        for e in rd.flatten() {
            let (name, p) = (e.file_name().to_string_lossy().into_owned(), e.path());
            let state = link_state(&p);
            if state != Some(false) {
                if name.starts_with("run-") || name.starts_with("rk-") {
                    remove_link(&p); // fail closed, also for an entry that cannot be inspected
                    if state == Some(true) {
                        warnings.push(link_warning(&name));
                    }
                }
            } else if name.starts_with("run-") && p.is_dir() {
                // every file at every depth (stage\pos.dump is nested) is zero-filled; links inside are removed, never followed
                match scrub_tree(&p) {
                    Ok(inner) => warnings.extend(inner.iter().map(|n| link_warning(n))),
                    Err(_) => {
                        warnings.push(format!("the scratch folder {name} could not be zero-filled; it was deleted without that, or left in place if it could not be deleted"));
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            } else if name.starts_with("rk-") && name.ends_with(".tmp") && scrub_and_remove(&p).is_err() {
                warnings.push(format!("the recovery-key temp file {name} could not be zero-filled"));
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    if let Some(is_link) = link_state(&ctx.paths.stage()) {
        if is_link {
            remove_link(&ctx.paths.stage());
        } else if scrub_tree(&ctx.paths.stage()).is_err() {
            warnings.push("the old stage folder could not be zero-filled".to_string());
            let _ = std::fs::remove_dir_all(ctx.paths.stage());
        }
    }
    Ok(warnings)
}

/// Zero-fills and deletes everything a dead restore or run left in the scratch folders: every `run-*` / `rk-*` entry of `backups\tmp`, everything in
/// `backups\restore`, and the old stage. Never follows a link. Safe only while no run is live: the caller holds `update.lock` exclusively
/// (backup runs and drills hold it shared, a restore exclusively). An entry that cannot be scrubbed is an error and is KEPT, so the next
/// run-start sweep or restore-start scrub retries it.
pub fn scrub_scratch(ctx: &BackupCtx) -> BResult<Vec<String>> {
    assert_scratch_roots_private(ctx)?;
    let fail = |p: &Path, e: std::io::Error| BackupError::error(format!("cannot clear {}: {e}", p.display()));
    let mut links = Vec::new();
    let mut each = |root: PathBuf, only: &dyn Fn(&str) -> bool| -> BResult<()> {
        // a link as the root itself would send the zero-fill to its target (`assert_private` does not run for --dev roots)
        match std::fs::symlink_metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(fail(&root, e)),
            Ok(_) if link_state(&root) != Some(false) => return Err(fail(&root, std::io::Error::other("is a link"))),
            Ok(_) => {}
        }
        let Ok(rd) = std::fs::read_dir(&root) else { return Ok(()) };
        for e in rd.flatten() {
            let (name, p) = (e.file_name().to_string_lossy().into_owned(), e.path());
            if !only(&name) {
                continue;
            }
            match link_state(&p) {
                Some(false) if p.is_dir() => links.extend(scrub_tree(&p).map_err(|e| fail(&p, e))?),
                Some(false) => scrub_and_remove(&p).map_err(|e| fail(&p, e))?,
                state => {
                    remove_link(&p);
                    if state == Some(true) {
                        links.push(name);
                    }
                }
            }
        }
        Ok(())
    };
    each(ctx.paths.backups_tmp(), &|n| n.starts_with("run-") || n.starts_with("rk-"))?;
    each(ctx.paths.restore_root(), &|_| true)?;
    if ctx.paths.stage().exists() {
        scrub_tree(&ctx.paths.stage()).map_err(|e| fail(&ctx.paths.stage(), e))?;
    }
    Ok(links)
}

/// The roots a sweep deletes under (`backups\`, `restore\`, `tmp\`) are judged before anything under them is touched: a folder others can
/// write to, or a link, is not swept. A refusal is a PRECONDITION, as for `PrivateDir`: the run is refused rather than trusting what
/// may have been planted. Every sweep (a run's, a drill's) goes through this; `--dev` roots skip it inside `assert_private`.
pub fn assert_scratch_roots_private(ctx: &BackupCtx) -> BResult<()> {
    for root in [ctx.paths.backups(), ctx.paths.restore_root(), ctx.paths.backups_tmp()] {
        if std::fs::symlink_metadata(&root).is_ok() {
            assert_private(ctx, &root)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sys::Ace;

    /// The bytes a deleted-but-still-open file shows (Windows lets std delete a file another handle has open).
    fn open_then<F: FnOnce()>(p: &Path, f: F) -> Vec<u8> {
        use std::io::Read;
        let mut h = std::fs::File::open(p).unwrap();
        f();
        let mut b = Vec::new();
        h.read_to_end(&mut b).unwrap();
        b
    }

    #[cfg(windows)]
    fn mkjunction(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn a_restore_folder_that_is_itself_a_junction_is_refused_and_its_target_survives() {
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let victim = tempfile::tempdir().unwrap();
        std::fs::write(victim.path().join("keep.txt"), b"precious").unwrap();
        mkjunction(&c.paths.restore_root(), victim.path());
        assert!(scrub_scratch(&c).is_err(), "a junction as the restore root must be refused");
        assert_eq!(std::fs::read(victim.path().join("keep.txt")).unwrap(), b"precious", "the target's file was zero-filled or deleted through the root junction");
        let stage_victim = tempfile::tempdir().unwrap();
        std::fs::write(stage_victim.path().join("keep.txt"), b"precious").unwrap();
        assert!(scrub_tree(&c.paths.restore_root()).is_err(), "scrub_tree refuses a link as its own root");
        assert_eq!(std::fs::read(victim.path().join("keep.txt")).unwrap(), b"precious");
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_dump_is_zero_filled_or_the_scrub_fails_never_silently_deleted() {
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let stage = c.paths.backups_tmp().join("run-dead").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        let dump = stage.join("pos.dump");
        std::fs::write(&dump, b"admin pin 123456").unwrap();
        let mut perm = std::fs::metadata(&dump).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&dump, perm).unwrap();
        let mut res = None;
        let seen = open_then(&dump, || res = Some(scrub_scratch(&c)));
        if res.unwrap().is_ok() {
            assert!(seen.iter().all(|b| *b == 0), "a read-only dump was deleted with its plaintext intact: {seen:?}");
            assert!(!c.paths.backups_tmp().join("run-dead").exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_hard_linked_file_is_unlinked_without_zero_filling_the_other_name() {
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("other.txt"), b"keepme").unwrap();
        let stage = c.paths.backups_tmp().join("run-dead").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::hard_link(other.path().join("other.txt"), stage.join("pos.dump")).unwrap();
        scrub_scratch(&c).unwrap();
        assert!(!c.paths.backups_tmp().join("run-dead").exists());
        assert_eq!(std::fs::read(other.path().join("other.txt")).unwrap(), b"keepme", "the other name of a hard link was zero-filled");
    }

    #[cfg(windows)]
    #[test]
    fn a_scratch_folder_that_cannot_be_zero_filled_is_reported_not_deleted_silently() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let stage = c.paths.backups_tmp().join("run-dead").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("pos.dump"), b"admin pin").unwrap();
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(stage.join("pos.dump")).unwrap(); // nobody else may open it
        let warnings = sweep_stale(&c).unwrap();
        assert!(warnings.iter().any(|w| w.contains("run-dead")), "the failed zero-fill is surfaced: {warnings:?}");
    }

    #[cfg(windows)]
    #[test]
    fn the_startup_sweep_zero_fills_a_dump_nested_in_a_run_folder() {
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let stage = c.paths.backups_tmp().join("run-dead").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("pos.dump"), b"admin pin 123456").unwrap();
        let seen = open_then(&stage.join("pos.dump"), || {
            sweep_stale(&c).unwrap();
        });
        assert!(!c.paths.backups_tmp().join("run-dead").exists());
        assert!(seen.iter().all(|b| *b == 0) && seen.len() == 16, "the nested dump was deleted without being zero-filled: {seen:?}");
    }

    #[cfg(windows)]
    #[test]
    fn scrubbing_the_scratch_leaves_no_dump_and_never_follows_a_link() {
        let (_d, c) = crate::backup::util::fake::temp_ctx();
        let victim = tempfile::tempdir().unwrap();
        std::fs::write(victim.path().join("keep.txt"), b"precious").unwrap();
        let stage = c.paths.backups_tmp().join("run-dead").join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("pos.dump"), b"admin pin 123456").unwrap();
        std::fs::create_dir_all(c.paths.restore_root()).unwrap();
        std::fs::write(c.paths.restore_root().join("pos.dump"), b"admin pin 123456").unwrap();
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &c.paths.restore_root().join("evil").display().to_string(), &victim.path().display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let links = scrub_scratch(&c).unwrap();
        assert!(!c.paths.backups_tmp().join("run-dead").exists(), "the run folder is gone");
        assert!(std::fs::read_dir(c.paths.restore_root()).unwrap().next().is_none(), "the restore folder is empty");
        assert_eq!(std::fs::read(victim.path().join("keep.txt")).unwrap(), b"precious", "a link was followed");
        assert_eq!(links, ["evil"]);
    }


    fn ace(sid: &str, allow: bool) -> Ace {
        Ace { allow, flags: 0x3, mask: 0x1f01ff, sid: sid.into() }
    }
    fn acl(protected: bool, aces: Vec<Ace>) -> PathAcl {
        PathAcl { protected, aces }
    }
    fn trust(owner: &str, reparse: bool, a: PathAcl) -> HandleInfo {
        HandleInfo { reparse, is_dir: true, owner: owner.into(), acl: a }
    }
    fn good() -> PathAcl {
        acl(true, vec![ace(SID_SYSTEM, true), ace(SID_ADMINISTRATORS, true)])
    }
    fn non_dev(d: &Path) -> BackupCtx {
        let roots = crate::paths::Roots { dev: false, ..crate::paths::Roots::custom(d.join("d"), d.join("p")) };
        BackupCtx::new(&roots, d.join("pack"), crate::ports::Ports::new(47300).unwrap(), "t".into(), "t".into())
    }

    #[test]
    fn only_system_and_administrators_with_protected_inheritance_pass() {
        assert!(acl_is_private(&good()).is_ok());
        assert!(acl_is_private(&acl(true, vec![ace(SID_SYSTEM, true)])).is_ok());
    }

    #[test]
    fn users_everyone_authenticated_and_service_accounts_are_refused_by_sid() {
        let e = acl_is_private(&acl(true, vec![ace(SID_SYSTEM, true), ace("S-1-5-32-545", true)])).unwrap_err();
        assert!(e.iter().any(|x| x.contains("S-1-5-32-545")));
        assert!(acl_is_private(&acl(true, vec![ace("S-1-1-0", true)])).is_err());
        assert!(acl_is_private(&acl(true, vec![ace("S-1-5-11", true)])).is_err());
        assert!(acl_is_private(&acl(true, vec![ace("S-1-5-80-1234-5678", true)])).is_err());
    }

    #[test]
    fn inherited_dacls_are_refused() {
        let e = acl_is_private(&acl(false, vec![ace(SID_SYSTEM, true)])).unwrap_err();
        assert!(e.iter().any(|x| x.contains("inheritance")));
    }

    #[test]
    fn deny_entries_do_not_count_as_access_but_other_entry_types_are_refused() {
        assert!(acl_is_private(&acl(true, vec![ace("S-1-5-32-545", false), ace(SID_SYSTEM, true)])).is_ok());
        // read_acl reports object/callback/audit/... entries as `<ace type N>`
        let e = acl_is_private(&acl(true, vec![ace(SID_SYSTEM, true), ace("<ace type 5>", false)])).unwrap_err();
        assert!(e.iter().any(|x| x.contains("<ace type 5>")), "{e:?}");
    }

    #[test]
    fn trust_refuses_links_foreign_owners_and_loose_dacls_but_accepts_system_and_admin_owners() {
        assert!(trust_is_private(&trust(SID_ADMINISTRATORS, false, good())).is_ok());
        assert!(trust_is_private(&trust(SID_SYSTEM, false, good())).is_ok());
        let e = trust_is_private(&trust(SID_ADMINISTRATORS, true, good())).unwrap_err();
        assert!(e.iter().any(|x| x.contains("reparse point")), "{e:?}");
        let e = trust_is_private(&trust("S-1-5-21-1-2-3-1001", false, good())).unwrap_err();
        assert!(e.iter().any(|x| x.contains("owned by S-1-5-21-1-2-3-1001")), "{e:?}");
        assert!(trust_is_private(&trust(SID_ADMINISTRATORS, false, acl(false, vec![ace(SID_SYSTEM, true)]))).is_err());
        assert!(trust_is_private(&trust(SID_ADMINISTRATORS, false, acl(true, vec![ace("S-1-1-0", true)]))).is_err());
        assert!(trust_is_private(&trust(SID_ADMINISTRATORS, false, acl(true, vec![ace("<ace type 9>", false)]))).is_err());
    }

    #[test]
    fn a_dev_root_skips_the_check_and_a_real_root_reads_the_live_handle() {
        let d = tempfile::tempdir().unwrap();
        let dev = crate::backup::util::fake::test_ctx();
        assert!(dev.is_dev() && assert_private(&dev, d.path()).is_ok());
        // a fresh temp folder inherits the profile's ACL and is owned by the user: not private
        let c = non_dev(d.path());
        let e = assert_private(&c, d.path()).unwrap_err();
        assert_eq!(e.code, crate::envelope::Code::Precondition);
        assert!(e.message.contains("not private"), "{}", e.message);
        assert!(e.message.contains("owned by"), "the owner check must run: {}", e.message);
        assert!(assert_private(&c, &d.path().join("missing")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_is_refused_even_when_its_target_would_pass() {
        let d = tempfile::tempdir().unwrap();
        let real = d.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = d.path().join("link");
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &real.display().to_string()]).output().unwrap();
        assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stdout));
        let e = assert_private(&non_dev(d.path()), &link).unwrap_err();
        assert!(e.message.contains("reparse point"), "{}", e.message);
    }

    // The parent chain check (backups\ and backups\tmp) is exercised here only up to its refusal: a real private chain needs
    // SYSTEM/Administrators ownership, so the passing case is covered in Windows Sandbox (Task 13).
    #[test]
    fn a_scratch_folder_is_refused_when_its_parent_chain_is_not_private_and_nothing_is_created() {
        let d = tempfile::tempdir().unwrap();
        let c = non_dev(d.path());
        std::fs::create_dir_all(c.paths.backups()).unwrap(); // provisioning makes `backups\`; here it is a plain temp folder
        let e = PrivateDir::create(&c).err().expect("the temp parents are not private");
        assert_eq!(e.code, crate::envelope::Code::Precondition);
        let backups = c.paths.backups();
        assert!(e.message.starts_with(&format!("{} is not private", backups.display())), "the parent is named first: {}", e.message);
        assert!(!c.paths.backups_tmp().exists(), "`tmp` itself may not be created under an unsafe parent");
    }

    // Sandbox scenario 44 regression: the first run found `backups\tmp` inherited and exited 12. Fails on the old code: that
    // created the folder with `create_dir_all` (inherited DACL, `protected == false`), and `create_private_dir` did not exist.
    #[cfg(windows)]
    #[test]
    fn a_private_folder_is_born_protected_when_it_is_absent() {
        let d = tempfile::tempdir().unwrap();
        let tmp = d.path().join("backups").join("tmp"); // `backups` absent too: not created, so the call must fail cleanly
        assert!(create_private_dir(&tmp).is_err());
        std::fs::create_dir_all(d.path().join("backups")).unwrap();
        assert!(!tmp.exists());
        create_private_dir(&tmp).unwrap();
        let a = crate::sys::path_acl(&tmp).unwrap();
        assert!(a.protected, "inheritance must be protected from birth");
        acl_is_private(&a).unwrap();
        create_private_dir(&tmp).unwrap(); // already there (a second run): left for assert_private to judge
    }

    // Production creates owner Administrators; a host test cannot (error 1307 when not elevated), so only the string is pinned here.
    #[test]
    fn the_production_descriptor_names_administrators_as_owner_with_a_protected_dacl() {
        assert!(PRIVATE_SDDL.starts_with("O:BAD:P("), "{PRIVATE_SDDL}");
        assert!(!HOST_TEST_SDDL.contains("O:"), "the host seam is the owner-less variant of the same DACL");
        assert_eq!(PRIVATE_SDDL.trim_start_matches("O:BA"), HOST_TEST_SDDL);
    }

    // F5: `ensure_local_repo` used to `create_dir_all(repo)` first, birthing `backups\` with an inherited DACL. The run ends in an
    // error here (a temp folder is user-owned, so `assert_private` refuses it) but `backups\` must already be born protected.
    #[cfg(windows)]
    #[test]
    fn the_local_repository_step_never_births_backups_with_an_inherited_dacl() {
        let d = tempfile::tempdir().unwrap();
        let c = non_dev(d.path());
        std::fs::create_dir_all(c.paths.backups().parent().unwrap()).unwrap(); // the data root exists after provisioning; `backups\` does not
        assert!(!c.paths.backups().exists());
        let _ = crate::backup::repo::ensure_local_repo(&c, &crate::backup::util::fake::FakeExec::default(), false);
        let a = crate::sys::path_acl(&c.paths.backups()).unwrap();
        assert!(a.protected, "backups must be born with a protected DACL");
        acl_is_private(&a).unwrap();
        assert!(!c.paths.repo().exists(), "no repository is created under a backups folder that is not private");
    }

    // Scenario 21 runs every #[ignore] test elevated: here owner Administrators can really be set.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs an elevated process (runs in the Windows Sandbox, scenario 21): owner Administrators requires an admin token"]
    fn elevated_private_dir_and_its_parents_are_owned_by_administrators_and_pass_assert_private() {
        OWNED_AS_ADMINS.with(|o| o.set(true));
        let d = tempfile::tempdir().unwrap();
        let c = non_dev(d.path());
        std::fs::create_dir_all(c.paths.backups().parent().unwrap()).unwrap();
        ensure_private_backups(&c).unwrap();
        let run = PrivateDir::create(&c).unwrap();
        for p in [c.paths.backups(), c.paths.backups_tmp(), run.path().to_path_buf()] {
            assert_eq!(crate::sys::path_owner_sid(&p).unwrap(), SID_ADMINISTRATORS, "{}", p.display());
            assert_private(&c, &p).unwrap();
        }
    }

    #[test]
    fn a_scratch_folder_is_new_per_run_and_removed_on_drop() {
        let d = tempfile::tempdir().unwrap();
        let mut c = crate::backup::util::fake::test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.path().join("d"), d.path().join("p")));
        let (a, b) = (PrivateDir::create(&c).unwrap(), PrivateDir::create(&c).unwrap());
        assert_ne!(a.path(), b.path());
        assert_eq!(a.path().parent().unwrap(), c.paths.backups_tmp());
        assert!(a.path().file_name().unwrap().to_string_lossy().starts_with("run-"));
        let pa = a.path().to_path_buf();
        assert!(pa.is_dir());
        drop(a);
        assert!(!pa.exists());
    }

    #[test]
    fn the_startup_sweep_removes_stale_dumps_key_files_and_scratch_folders_only() {
        let d = tempfile::tempdir().unwrap();
        let mut c = crate::backup::util::fake::test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.path().join("d"), d.path().join("p")));
        let tmp = c.paths.backups_tmp();
        std::fs::create_dir_all(tmp.join("run-deadbeef")).unwrap();
        std::fs::write(tmp.join("run-deadbeef").join("rk-1.tmp"), b"k").unwrap();
        std::fs::write(tmp.join("rk-old.tmp"), b"k").unwrap();
        std::fs::write(tmp.join("keep.txt"), b"x").unwrap();
        std::fs::create_dir_all(c.paths.stage()).unwrap();
        std::fs::write(c.paths.stage().join("pos.dump"), b"d").unwrap();
        sweep_stale(&c).unwrap();
        assert!(!tmp.join("run-deadbeef").exists() && !tmp.join("rk-old.tmp").exists());
        assert!(!c.paths.stage().exists(), "a leftover dump must go");
        assert!(tmp.join("keep.txt").exists());
        sweep_stale(&c).unwrap(); // nothing left: still fine
    }
}
