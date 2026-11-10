//! Creating the data-root layout with its ACLs, and writing secret files that one service reads.
//! It must never follow a reparse point and never adopt a folder it did not create on a first run.

use std::path::Path;

use crate::acl::{self, Grant};
use crate::envelope::{Code, PosctlError};
use crate::paths::{layout_dirs, Roots};
use crate::services::Component;
use crate::sys;
use crate::util::write_atomic;

pub const TRUSTED_OWNERS: [&str; 3] = ["S-1-5-32-544", "S-1-5-18", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"];

pub(crate) fn production_owner(sid: &str) -> bool {
    TRUSTED_OWNERS.contains(&sid)
}

/// Open `path` itself and judge it on that one handle: not a reparse point, and its owner passes
/// `owner_ok`. `Ok(None)` when it does not exist. Never follows a link and never asks the OS twice
/// about the same name (a name can be swapped for a junction between two by-name calls).
pub(crate) fn check_dir_trust(path: &Path, owner_ok: &dyn Fn(&str) -> bool) -> Result<Option<sys::HandleInfo>, PosctlError> {
    let t = match sys::open_trust(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(PosctlError::error(format!("cannot inspect {}: {e}", path.display()))),
    };
    if t.reparse {
        return Err(PosctlError::precondition(format!("{} is a reparse point (junction or symlink); refusing to follow it", path.display())));
    }
    if !owner_ok(&t.owner) {
        return Err(PosctlError::new(
            Code::Precondition,
            format!("{} exists and is owned by {}, not Administrators or SYSTEM: it may have been planted. Remove it as an administrator and run provision again", path.display(), t.owner),
        ));
    }
    Ok(Some(t))
}

/// True when `data`, `data\logs` and `data\logs\posctl` all exist and each passes the handle-based reparse/owner
/// check (dev roots are owned by the developer; a link is refused everywhere). Any doubt is false.
pub fn log_dir_is_trusted(roots: &Roots) -> bool {
    let owner_ok = |sid: &str| roots.dev || production_owner(sid);
    [roots.data.clone(), roots.logs(), roots.posctl_logs()].iter().all(|p| matches!(check_dir_trust(p, &owner_ok), Ok(Some(t)) if t.is_dir))
}

/// Safety checks on a data root that already exists (S9 REVIEW I2). Production only; dev roots are
/// owned by the developer by definition. The root is opened (not followed) and judged on one handle:
/// reparse point first, then owner (Administrators, SYSTEM or TrustedInstaller); only a root that
/// passes is walked for reparse points, so a planted tree under an untrusted owner is never traversed.
pub fn check_existing_data_root(roots: &Roots) -> Result<(), PosctlError> {
    check_root_with(roots, &production_owner)
}

fn check_root_with(roots: &Roots, owner_ok: &dyn Fn(&str) -> bool) -> Result<(), PosctlError> {
    if roots.dev || check_dir_trust(&roots.data, owner_ok)?.is_none() {
        return Ok(());
    }
    if let Some(hit) = acl::find_reparse_point(&roots.data)? {
        return Err(PosctlError::precondition(format!("{} is a reparse point (junction or symlink); refusing to follow it", hit.display())));
    }
    Ok(())
}

/// Direct children (the files posctl wrote) of `dir`: each opened without being followed and owner-judged.
fn check_children_with(dir: &Path, owner_ok: &dyn Fn(&str) -> bool) -> Result<(), PosctlError> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in rd {
        check_dir_trust(&entry?.path(), owner_ok)?;
    }
    Ok(())
}

/// Resume trust (F8 g): before any ACL is applied, `root`, `state\` and `secrets\` must carry exactly the
/// planned protected DACL, every layout folder that exists must pass the handle-based owner/reparse
/// check, and so must the files inside `secrets\`, `state\` and `conf\`. Re-ACLing a planted folder
/// afterwards would otherwise make it look ours.
fn check_resume_with(roots: &Roots, plan: &[acl::AclEntry], owner_ok: &dyn Fn(&str) -> bool) -> Result<(), PosctlError> {
    for dir in [roots.data.clone(), roots.state(), roots.secrets()] {
        let Some(t) = check_dir_trust(&dir, owner_ok)? else { continue };
        if let Some(e) = plan.iter().find(|e| e.path == dir) {
            acl::verify_dacl(&e.grants, &t.acl).map_err(|m| PosctlError::precondition(format!("{}: the DACL is not what posctl sets ({m}); it may have been planted or changed", dir.display())))?;
        }
    }
    let names: Vec<&str> = Component::ALL.iter().map(|c| c.service_name()).collect();
    for dir in layout_dirs(roots, &names) {
        check_dir_trust(&dir, owner_ok)?;
    }
    for dir in [roots.secrets(), roots.state(), roots.conf()] {
        check_children_with(&dir, owner_ok)?;
    }
    Ok(())
}

/// First-run data root: created by `CreateDirectoryW` with the planned protected DACL (and the owner, when
/// given) in the same call, so there is no moment at which it has an inherited ACL for a planted hard link to
/// ride on. "Already exists" is a planted folder.
fn create_root_dir(path: &Path, grants: &[Grant], owner: Option<&str>) -> Result<(), PosctlError> {
    let sddl = acl::sddl_for(owner, grants).map_err(PosctlError::error)?;
    match sys::create_dir_with_sddl(path, &sddl) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(PosctlError::precondition(format!("{} already exists on a first run: it may have been planted", path.display()))),
        Err(e) => Err(e.into()),
    }
}

/// Create every folder, parents first, and (outside dev) set owner and ACL right after creating
/// each one so a child never exists with a looser ACL than its parent. The ACLs come from
/// `acl::data_acl_plan` / `program_acl_plan` and go through `acl::apply_one` (owner Administrators,
/// protected DACL, read back). `secrets\` is created here (`secrets::ensure` does not).
///
/// Order of the callers: `create_layout` runs BEFORE `ops::lock` is taken (the lock lives in `state\`, which
/// this creates), so the lock is not what keeps two provisions apart here; the first-run `create_dir` /
/// `create_root_dir` (which fail on "already exists") are. `ops::lock` is acquired right after it returns.
///
/// review fix (planted-folder window): `fresh` is true on a first run (no journal). Then every folder is
/// made with `create_dir` (never `create_dir_all`) and "already exists" is `PRECONDITION` (exit 12): a
/// standard user can create folders under ProgramData until the first ACL lands, and anything planted
/// there would otherwise be adopted. Outside dev the data root itself is born with its DACL
/// (`create_root_dir`). Right after the data root is ACL'd, `check_existing_data_root` runs again (owner and
/// reparse scan), and only then are the children created. On resume (`fresh == false`) existing folders are
/// accepted, but only after `check_existing_data_root` and `check_resume_with` (exact DACL, owners) ran
/// BEFORE any ACL or owner was applied: re-ACLing would otherwise make a planted folder look ours.
pub fn create_layout(roots: &Roots, fresh: bool) -> Result<(), PosctlError> {
    let plan = acl::data_acl_plan(roots);
    if !fresh {
        check_existing_data_root(roots)?;
        if !roots.dev {
            check_resume_with(roots, &plan, &production_owner)?;
        }
    }
    let names: Vec<&str> = Component::ALL.iter().map(|c| c.service_name()).collect();
    for dir in layout_dirs(roots, &names) {
        if fresh && !roots.dev && dir == roots.data {
            let grants = plan.iter().find(|e| e.path == dir).map(|e| e.grants.clone()).unwrap_or_default();
            create_root_dir(&dir, &grants, sys::is_elevated().then_some(acl::SID_ADMINISTRATORS))?;
        } else {
            match std::fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && !fresh => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(PosctlError::precondition(format!("{} already exists on a first run: it may have been planted", dir.display())));
                }
                Err(e) => return Err(e.into()),
            }
        }
        if !roots.dev {
            if let Some(e) = plan.iter().find(|e| e.path == dir) {
                acl::apply_one(&e.path, &e.grants).map_err(PosctlError::error)?;
            }
            if dir == roots.data {
                check_existing_data_root(roots)?; // second look, after the ACL and owner are ours
            }
        }
    }
    if !roots.dev {
        std::fs::create_dir_all(&roots.program)?;
        for e in acl::program_acl_plan(roots) {
            acl::apply_one(&e.path, &e.grants).map_err(PosctlError::error)?;
        }
    }
    Ok(())
}

/// Write a file inside `secrets\` or `conf\` (it inherits SYSTEM and Administrators only), then
/// grant its single reader. There is no moment at which the file is more exposed than finished.
pub fn write_protected(roots: &Roots, rt: &dyn crate::runtime::Runtime, path: &Path, content: &str, grants: &[Grant]) -> Result<(), PosctlError> {
    write_atomic(path, content.as_bytes())?;
    if !roots.dev {
        rt.protect_file(path, grants).map_err(PosctlError::error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dev_layout_creates_every_folder() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        create_layout(&roots, true).unwrap();
        create_layout(&roots, false).unwrap(); // resume is idempotent
        for p in [roots.secrets(), roots.pgdata(), roots.state(), roots.update_dir(), roots.client_run(), roots.work_migrations(), roots.logs_for("SupermarketPOS-Gateway"), roots.tmp_for("SupermarketPOS-Functions"), roots.caddy_xdg()] {
            assert!(p.is_dir(), "{}", p.display());
        }
    }

    // review fix: a first run never adopts a folder that is already there.
    #[test]
    fn a_first_run_refuses_a_pre_existing_folder_but_a_resume_accepts_it() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir(&roots.data).unwrap(); // "planted" before posctl ran
        assert_eq!(create_layout(&roots, true).unwrap_err().code, Code::Precondition);
        assert!(create_layout(&roots, false).is_ok());
    }

    #[test]
    fn a_dev_root_skips_the_ownership_check() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().to_path_buf(), d.path().join("p"));
        assert!(check_existing_data_root(&roots).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_production_style_root_owned_by_the_current_user_is_refused_unless_that_user_is_trusted() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().to_path_buf(), d.path().join("p"));
        roots.dev = false;
        let owner = sys::path_owner_sid(d.path()).unwrap();
        let result = check_existing_data_root(&roots);
        if TRUSTED_OWNERS.contains(&owner.as_str()) {
            assert!(result.is_ok()); // an elevated shell creates Administrators-owned folders
        } else {
            assert_eq!(result.unwrap_err().code, Code::Precondition);
        }
    }

    // Review Focus 1: a data folder that pre-existed (not ours, junction inside) is refused with exit 12
    // on a resume too, BEFORE any ACL or owner is applied to it, and the junction is never followed.
    #[cfg(windows)]
    #[test]
    fn a_pre_existing_untrusted_root_is_refused_on_resume_without_being_touched() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        roots.dev = false;
        std::fs::create_dir_all(&roots.data).unwrap();
        let owner = sys::path_owner_sid(&roots.data).unwrap();
        if TRUSTED_OWNERS.contains(&owner.as_str()) {
            return; // elevated test run: the untrusted-owner path cannot be reached
        }
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let link = roots.data.join("secrets");
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let before = sys::path_acl(&target).unwrap();
        let e = create_layout(&roots, false).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::Precondition, 12));
        assert!(!roots.conf().exists(), "nothing was created inside the refused root");
        assert!(!roots.program.exists(), "the program root was not created either");
        assert_eq!(sys::path_acl(&target).unwrap(), before, "the junction target keeps its ACL");
        assert!(target.is_dir() && std::fs::read_dir(&target).unwrap().next().is_none(), "the junction target is untouched");
    }

    // a root + state\ + secrets\ that match the plan exactly (plus the test user, so cleanup works)
    #[cfg(windows)]
    fn applied_root(d: &Path) -> (Roots, Vec<acl::AclEntry>) {
        let mut roots = Roots::custom(d.join("data"), d.join("p"));
        roots.dev = false;
        let me = sys::path_owner_sid(d).unwrap();
        let mut plan = acl::data_acl_plan(&roots);
        for e in plan.iter_mut() {
            // An elevated user owns the folder as Administrators, which the plan already grants: a second ACE would make the DACL differ from the plan.
            if !e.grants.iter().any(|g| g.sid == me) {
                e.grants.push(Grant::new(me.clone(), "F", acl::Inherit::ObjectContainer));
            }
        }
        for dir in [roots.data.clone(), roots.state(), roots.secrets()] {
            std::fs::create_dir_all(&dir).unwrap();
            let e = plan.iter().find(|e| e.path == dir).unwrap();
            acl::apply_one_with_owner(&e.path, &e.grants, None).unwrap();
        }
        (roots, plan)
    }

    // F8 g: an existing root / state\ / secrets\ is only adopted when its DACL is exactly the plan.
    #[cfg(windows)]
    #[test]
    fn a_resume_accepts_folders_whose_dacl_is_exactly_the_plan() {
        let d = tempfile::tempdir().unwrap();
        let (roots, plan) = applied_root(d.path());
        check_resume_with(&roots, &plan, &|_| true).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_resume_refuses_a_planted_ace_or_an_unprotected_folder_or_an_untrusted_owner() {
        let d = tempfile::tempdir().unwrap();
        let (roots, plan) = applied_root(d.path());
        let o = std::process::Command::new(acl::icacls_exe_for_test()).arg(roots.secrets()).args(["/grant", "*S-1-1-0:(OI)(CI)F"]).output().unwrap();
        assert!(o.status.success());
        let e = check_resume_with(&roots, &plan, &|_| true).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("DACL"), "{}", e.message);
        // inherited (unprotected) state\ in a fresh tree
        let d2 = tempfile::tempdir().unwrap();
        let (roots2, plan2) = applied_root(d2.path());
        std::fs::remove_dir(roots2.state()).unwrap();
        std::fs::create_dir(roots2.state()).unwrap();
        assert!(check_resume_with(&roots2, &plan2, &|_| true).unwrap_err().message.contains("DACL"));
        // owner predicate
        let d3 = tempfile::tempdir().unwrap();
        let (roots3, plan3) = applied_root(d3.path());
        let e = check_resume_with(&roots3, &plan3, &|_| false).unwrap_err();
        assert!(e.message.contains("owned by"), "{}", e.message);
    }

    // children (the files posctl wrote) are owner-checked too, and each is opened without being followed
    #[cfg(windows)]
    #[test]
    fn files_inside_a_folder_are_owner_checked() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("x.env"), b"x").unwrap();
        assert!(check_children_with(d.path(), &|_| true).is_ok());
        let e = check_children_with(d.path(), &|_| false).unwrap_err();
        assert!(e.message.contains("owned by"), "{}", e.message);
        assert!(check_children_with(&d.path().join("missing"), &|_| false).is_ok());
    }

    // F8 b: the root is opened (not followed) and its owner judged BEFORE the deep scan runs, so a
    // planted tree under an untrusted owner is refused on the owner, not walked.
    #[cfg(windows)]
    #[test]
    fn the_owner_is_judged_before_the_deep_scan() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        roots.dev = false;
        std::fs::create_dir_all(&roots.data).unwrap();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &roots.data.join("secrets").display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let e = check_root_with(&roots, &|_| false).unwrap_err();
        assert!(e.message.contains("owned by"), "{}", e.message);
        let e = check_root_with(&roots, &|_| true).unwrap_err();
        assert!(e.message.contains("reparse point"), "{}", e.message);
    }

    #[cfg(windows)]
    #[test]
    fn a_data_root_that_is_itself_a_junction_is_refused_without_being_followed() {
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        roots.dev = false;
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &roots.data.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let e = check_root_with(&roots, &|_| true).unwrap_err();
        assert!(e.message.contains("reparse point"), "{}", e.message);
    }

    // F8 i: the first-run root is created with its protected DACL in the same call.
    #[cfg(windows)]
    #[test]
    fn the_first_run_root_is_created_with_the_exact_dacl_and_a_second_creation_is_a_planted_folder() {
        let d = tempfile::tempdir().unwrap();
        let me = sys::path_owner_sid(d.path()).unwrap();
        let grants = vec![Grant::new("S-1-5-18", "F", acl::Inherit::ObjectContainer), Grant::new(me, "F", acl::Inherit::ObjectContainer)];
        let p = d.path().join("data");
        create_root_dir(&p, &grants, None).unwrap();
        acl::verify_dacl(&grants, &sys::path_acl(&p).unwrap()).unwrap();
        assert_eq!(create_root_dir(&p, &grants, None).unwrap_err().code, Code::Precondition);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_in_a_trusted_root_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("p"));
        roots.dev = false;
        std::fs::create_dir_all(&roots.data).unwrap();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let link = roots.data.join("secrets");
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let e = check_root_with(&roots, &|_| true).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("reparse point"), "{}", e.message);
    }
}
