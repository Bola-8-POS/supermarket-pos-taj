//! Per-path ACLs by SID (conventions section 2.2 and 6).
//!
//! Service virtual-account SIDs are computed from the service name (SHA-1 of the upper-cased
//! UTF-16LE name, five little-endian words), so ACLs can be written before the services exist:
//! no stub services. The plan is turned into one SDDL string (pure) and applied with a single
//! `SetNamedSecurityInfo` (owner + protected DACL), then read back and compared ACE by ACE with the plan;
//! no external tool is involved. This module must never follow a
//! reparse point with an elevated tool, never grant a service anything on `secrets\` beyond one
//! read-only ACE on its own file, and never give `pgpass.conf` a service ACE.

use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use crate::paths::Roots;
use crate::services::Component;

pub const SID_SYSTEM: &str = "S-1-5-18";
pub const SID_ADMINISTRATORS: &str = "S-1-5-32-544";
pub const SID_USERS: &str = "S-1-5-32-545";

/// The service SID of a Windows service name: `S-1-5-80-a-b-c-d-e`.
/// (Reference value used by the tests: `TrustedInstaller` is
/// `S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464`.)
pub fn service_sid(service_name: &str) -> String {
    let utf16: Vec<u8> = service_name.to_uppercase().encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let digest = Sha1::digest(&utf16);
    let words: Vec<String> = digest.as_slice().as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c).to_string()).collect();
    format!("S-1-5-80-{}", words.join("-"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inherit {
    /// This folder only (or this file).
    No,
    /// `(OI)(CI)`: this folder, its subfolders and files.
    ObjectContainer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub sid: String,
    /// icacls simple rights: `F`, `M`, `RX`, `R`.
    pub rights: &'static str,
    pub inherit: Inherit,
}

impl Grant {
    pub fn new(sid: impl Into<String>, rights: &'static str, inherit: Inherit) -> Self {
        Grant { sid: sid.into(), rights, inherit }
    }
    /// `*S-1-5-18:(OI)(CI)F`
    pub fn spec(&self) -> String {
        let flags = if self.inherit == Inherit::ObjectContainer { "(OI)(CI)" } else { "" };
        format!("*{}:{}{}", self.sid, flags, self.rights)
    }
}

/// icacls simple right to an access mask (`FILE_ALL_ACCESS`, modify, read+execute, read).
fn rights_mask(rights: &str) -> Result<u32, String> {
    match rights {
        "F" => Ok(0x001f_01ff),
        "M" => Ok(0x0013_01bf),
        "RX" => Ok(0x0012_00a9),
        "R" => Ok(0x0012_0089),
        other => Err(format!("unknown ACL right {other:?}")),
    }
}

fn grant_flags(i: Inherit) -> u8 {
    if i == Inherit::ObjectContainer { 0x03 } else { 0x00 } // OBJECT_INHERIT | CONTAINER_INHERIT
}

fn is_plain_sid(s: &str) -> bool {
    s.starts_with("S-1-") && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
}

/// `O:<sid>D:P(A;OICI;0x1f01ff;;;<sid>)...`: protected DACL of exactly the grants (numeric masks, full
/// SID strings: no alias or composite right that could expand differently), optional owner.
pub fn sddl_for(owner: Option<&str>, grants: &[Grant]) -> Result<String, String> {
    let mut out = String::new();
    if let Some(o) = owner {
        if !is_plain_sid(o) {
            return Err(format!("{o:?} is not a SID string"));
        }
        out.push_str(&format!("O:{o}"));
    }
    out.push_str("D:P");
    for g in grants {
        if !is_plain_sid(&g.sid) {
            return Err(format!("{:?} is not a SID string", g.sid));
        }
        let flags = if g.inherit == Inherit::ObjectContainer { "OICI" } else { "" };
        out.push_str(&format!("(A;{flags};0x{:x};;;{})", rights_mask(g.rights)?, g.sid));
    }
    Ok(out)
}

/// Compare a DACL read back from the OS with the plan: protected, and exactly the planned allow ACEs
/// (SID, mask and inheritance flags), nothing else (an explicit Everyone ACE, an inherited ACE, a deny).
pub fn verify_dacl(planned: &[Grant], actual: &crate::sys::PathAcl) -> Result<(), String> {
    if !actual.protected {
        return Err("the DACL is not protected (inheritance was not removed)".to_string());
    }
    let mut want = Vec::new();
    for g in planned {
        want.push((g.sid.clone(), rights_mask(g.rights)?, grant_flags(g.inherit)));
    }
    let mut have = Vec::new();
    for a in &actual.aces {
        if !a.allow {
            return Err(format!("unexpected non-allow ACE for {}", a.sid));
        }
        have.push((a.sid.clone(), a.mask, a.flags));
    }
    want.sort();
    have.sort();
    if want == have {
        return Ok(());
    }
    let fmt = |v: &[(String, u32, u8)]| v.iter().map(|(s, m, f)| format!("{s}:0x{m:x}/0x{f:x}")).collect::<Vec<_>>().join(", ");
    let extra: Vec<_> = have.iter().filter(|h| !want.contains(h)).cloned().collect();
    let missing: Vec<_> = want.iter().filter(|w| !have.contains(w)).cloned().collect();
    Err(format!("DACL differs from the plan: unexpected [{}], missing [{}]", fmt(&extra), fmt(&missing)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEntry {
    pub path: PathBuf,
    pub grants: Vec<Grant>,
}

pub(crate) fn base() -> Vec<Grant> {
    vec![
        Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer),
        Grant::new(SID_ADMINISTRATORS, "F", Inherit::ObjectContainer),
    ]
}

fn with(mut v: Vec<Grant>, extra: Grant) -> Vec<Grant> {
    v.push(extra);
    v
}

fn entry(path: PathBuf, grants: Vec<Grant>) -> AclEntry {
    AclEntry { path, grants }
}

/// `secrets\`: owner Administrators, inheritance removed, SYSTEM and Administrators full control
/// (OI)(CI) and nobody else. Services never get an ACE on the folder; each reads only its own file
/// (`gotrue_env_grants` and friends). `pgpass.conf` (the supabase_admin password) gets no service ACE.
pub fn secrets_dir_acl(roots: &Roots) -> AclEntry {
    entry(roots.secrets(), base())
}

/// The ACL of every folder in the data root, parents first (conventions 2.2). All with
/// inheritance removed. Rulings recorded in the plan: `state\` gives the Gateway read on the whole
/// folder (an atomic replace of `status.json` creates a new file, which would lose a per-file ACE
/// every minute), and `pki\caddy\` gives only the Gateway modify.
pub fn data_acl_plan(roots: &Roots) -> Vec<AclEntry> {
    let comp = |c: Component| c.sid();
    let mut root_grants = base();
    for c in Component::ALL {
        // read/execute on the root folder only: initdb and Shawl stat() every parent
        root_grants.push(Grant::new(comp(c), "RX", Inherit::No));
    }
    let mut plan = vec![
        entry(roots.data.clone(), root_grants),
        entry(roots.conf(), base()),
        entry(roots.pgdata(), with(base(), Grant::new(comp(Component::Postgres), "M", Inherit::ObjectContainer))),
        secrets_dir_acl(roots),
        entry(roots.photos(), with(base(), Grant::new(comp(Component::Functions), "M", Inherit::ObjectContainer))),
        entry(roots.logs(), base()),
        entry(roots.posctl_logs(), base()),
        entry(roots.tmp(), base()),
        entry(roots.backups(), base()),
        entry(roots.state(), with(base(), Grant::new(comp(Component::Gateway), "RX", Inherit::ObjectContainer))),
        // FR19: the updater's control files. Protected, so the Gateway ACE of `state\` is not inherited into it.
        update_dir_acl(roots),
        entry(roots.pki(), base()),
        entry(roots.pki_caddy(), with(base(), Grant::new(comp(Component::Gateway), "M", Inherit::ObjectContainer))),
        // the Gateway serves from client\ and client\pairing\, so each carries Gateway RX, this folder only
        entry(roots.client(), with(with(base(), Grant::new(SID_USERS, "RX", Inherit::ObjectContainer)), Grant::new(comp(Component::Gateway), "RX", Inherit::No))),
        entry(roots.client().join("pairing"), with(with(base(), Grant::new(SID_USERS, "RX", Inherit::ObjectContainer)), Grant::new(comp(Component::Gateway), "RX", Inherit::No))),
        // the exported PUBLIC root (`pki export-root`): any local user may read it, only administrators write it
        entry(roots.client().join("pki"), with(base(), Grant::new(SID_USERS, "RX", Inherit::ObjectContainer))),
        // pairing offers may carry a short-lived pairing code: not for Users, read-only for the Gateway that serves them
        entry(roots.pairing_offers(), with(base(), Grant::new(comp(Component::Gateway), "R", Inherit::ObjectContainer))),
        entry(roots.packs_cache(), base()),
        entry(roots.work(), base()),
    ];
    for c in Component::ALL {
        plan.push(entry(roots.logs_for(c.service_name()), with(base(), Grant::new(comp(c), "M", Inherit::ObjectContainer))));
        plan.push(entry(roots.tmp_for(c.service_name()), with(base(), Grant::new(comp(c), "M", Inherit::ObjectContainer))));
    }
    plan
}

/// The program root: administrators write, users and the services read/execute.
pub fn program_acl_plan(roots: &Roots) -> Vec<AclEntry> {
    let mut g = with(base(), Grant::new(SID_USERS, "RX", Inherit::ObjectContainer));
    for c in Component::ALL {
        g.push(Grant::new(c.sid(), "RX", Inherit::ObjectContainer));
    }
    vec![entry(roots.program.clone(), g)]
}

/// `state\update\`: SYSTEM and Administrators only, inheritance removed. `state\` hands the Gateway read on everything in it (for
/// `status.json`), so the updater's control files (journal, result, fence sidecar, lock) live one level down, out of its reach.
pub fn update_dir_acl(roots: &Roots) -> AclEntry {
    entry(roots.update_dir(), base())
}

/// Make sure `state\update\` exists and carries exactly `update_dir_acl` (created or repaired). Elevated callers only; in a dev root
/// the folder is just created. `create_dir`, never `create_dir_all`, and `apply_one` refuses a reparse point.
pub fn protect_update_dir(roots: &Roots) -> Result<(), String> {
    let dir = roots.update_dir();
    let e = update_dir_acl(roots);
    // outside dev the folder is BORN with its protected DACL (no moment with the Gateway ACE of `state\` inherited)
    let made = if roots.dev { std::fs::create_dir(&dir) } else { crate::sys::create_dir_with_sddl(&dir, &sddl_for(None, &e.grants)?) };
    match made {
        Ok(()) => {}
        Err(x) if x.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(x) => return Err(format!("cannot create {}: {x}", dir.display())),
    }
    if roots.dev {
        return Ok(());
    }
    apply_one(&e.path, &e.grants) // repair: owner Administrators, exactly the planned DACL, read back
}

/// `update.lock` (in `state\update\`): SYSTEM and Administrators only. The folder is already closed to everyone else; the file keeps its
/// own protected DACL as a second layer (applied by `ops::lock::acquire_for`).
pub fn lock_file_acl(roots: &Roots) -> AclEntry {
    entry(roots.update_lock(), vec![Grant::new(SID_SYSTEM, "F", Inherit::No), Grant::new(SID_ADMINISTRATORS, "F", Inherit::No)])
}

/// Per-file grants for the files one service must read (that file only, read-only).
pub fn gotrue_env_grants() -> Vec<Grant> {
    secret_file_grants(Component::Auth)
}
pub fn postgrest_conf_grants() -> Vec<Grant> {
    secret_file_grants(Component::Rest)
}
fn secret_file_grants(reader: Component) -> Vec<Grant> {
    vec![
        Grant::new(SID_SYSTEM, "F", Inherit::No),
        Grant::new(SID_ADMINISTRATORS, "F", Inherit::No),
        Grant::new(reader.sid(), "R", Inherit::No),
    ]
}
pub fn caddy_file_grants() -> Vec<Grant> {
    secret_file_grants(Component::Gateway)
}
/// The initdb `--pwfile` (the supabase_admin password): SYSTEM and the Postgres account (which runs initdb) only,
/// not even Administrators; `provision` deletes it as soon as initdb returns, whatever the outcome.
pub fn initdb_pwfile_grants() -> Vec<Grant> {
    vec![Grant::new(SID_SYSTEM, "F", Inherit::No), Grant::new(Component::Postgres.sid(), "R", Inherit::No)]
}

#[cfg(test)]
pub(crate) fn icacls_exe_for_test() -> PathBuf {
    // tests only: used to plant an ACE on a temp folder the test created
    crate::sys::system_dir().expect("system directory").join("icacls.exe")
}

pub(crate) fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Set owner (Administrators) and the protected DACL on one path, then read both back. Any failure
/// is an error (fail closed, unlike NSIS `BrokerStep`). A target that is itself a reparse point is
/// refused before anything is changed. Owner and DACL go in one `SetNamedSecurityInfo`, so an explicit
/// ACE planted on the folder before this call cannot survive it; the read-back then requires exactly
/// the planned SIDs, masks and inheritance flags. Setting Administrators as owner needs the
/// SeTakeOwnership privilege, i.e. an elevated process.
pub fn apply_one(path: &Path, grants: &[Grant]) -> Result<(), String> {
    apply_one_with_owner(path, grants, Some(SID_ADMINISTRATORS))
}

/// `apply_one` with the owner as a parameter: `None` leaves the owner alone (the test seam for a
/// non-elevated process; production always passes Administrators).
pub fn apply_one_with_owner(path: &Path, grants: &[Grant], owner: Option<&str>) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if is_reparse(&meta) {
        return Err(format!("{} is a reparse point (junction or symlink); refusing to change its ACL", path.display()));
    }
    let sddl = sddl_for(owner, grants)?;
    crate::sys::set_path_security(path, &sddl).map_err(|e| format!("cannot set the ACL of {}: {e}", path.display()))?;
    if let Some(want) = owner {
        let got = crate::sys::path_owner_sid(path)?;
        if got != want {
            return Err(format!("owner of {} is {got} after the ACL was set, expected {want}", path.display()));
        }
    }
    let back = crate::sys::path_acl(path)?;
    verify_dacl(grants, &back).map_err(|e| format!("{}: {e}", path.display()))
}

/// The SDDL (protected DACL only) that reproduces `acl` exactly: for copying one file's DACL onto another. Allow ACEs
/// with plain SIDs and OI/CI/NP/IO flags only; anything else (a deny, an inherited ACE, a bad SID) is an error.
pub fn sddl_copy_of(acl: &crate::sys::PathAcl) -> Result<String, String> {
    let mut out = String::from("D:P");
    for a in &acl.aces {
        if !a.allow || a.flags & !0x0f != 0 || !is_plain_sid(&a.sid) {
            return Err(format!("cannot copy the ACE for {} (flags 0x{:x})", a.sid, a.flags));
        }
        let flags: String = [(0x1, "OI"), (0x2, "CI"), (0x4, "NP"), (0x8, "IO")].iter().filter(|(bit, _)| a.flags & bit != 0).map(|(_, n)| *n).collect();
        out.push_str(&format!("(A;{flags};0x{:x};;;{})", a.mask, a.sid));
    }
    Ok(out)
}

/// Give `to` the DACL `from` has, when `from` has its own (protected) one. An unprotected `from` only inherits its
/// folder's ACL, which a new file in the same folder gets anyway, so there is nothing to copy. Read back and compared.
pub fn copy_dacl(from: &Path, to: &Path) -> Result<(), String> {
    let want = crate::sys::path_acl(from)?;
    if !want.protected {
        return Ok(());
    }
    crate::sys::set_path_security(to, &sddl_copy_of(&want)?).map_err(|e| format!("cannot set the ACL of {}: {e}", to.display()))?;
    if crate::sys::path_acl(to)? != want {
        return Err(format!("{}: the copied DACL differs from the original", to.display()));
    }
    Ok(())
}

pub fn apply_plan(plan: &[AclEntry]) -> Result<(), String> {
    for e in plan {
        apply_one(&e.path, &e.grants)?;
    }
    Ok(())
}

/// Guarantee for `secrets::ensure`: `secrets\` exists (the layout step owns creating it), holds no
/// reparse point anywhere below it, and carries the protected SYSTEM + Administrators ACL with
/// Administrators as owner. Call before the first secret is written, because `write_atomic`'s temp
/// file inherits the folder ACL.
pub fn protect_secrets_dir(roots: &Roots) -> Result<(), String> {
    let dir = roots.secrets();
    if !dir.is_dir() {
        return Err(format!("{} does not exist; the layout step must create it before secrets are written", dir.display()));
    }
    if let Some(hit) = find_reparse_point(&dir).map_err(|e| format!("cannot scan {}: {e}", dir.display()))? {
        return Err(format!("{} is a reparse point (junction or symlink); refusing to protect the secrets folder", hit.display()));
    }
    let e = secrets_dir_acl(roots);
    apply_one(&e.path, &e.grants)
}

/// A reparse point (junction, symlink, mount point, OneDrive placeholder, ...) anywhere under
/// `root`. The provisioner refuses a data folder that contains one: an elevated `icacls` or
/// `initdb` would follow it to an arbitrary path.
pub fn find_reparse_point(root: &Path) -> std::io::Result<Option<PathBuf>> {
    // an explicit stack, not recursion: a planted tree thousands of levels deep must not overflow ours
    let mut todo = vec![root.to_path_buf()];
    while let Some(p) = todo.pop() {
        let meta = std::fs::symlink_metadata(&p)?;
        if is_reparse(&meta) {
            return Ok(Some(p));
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(&p)? {
                todo.push(entry?.path());
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    #[test]
    fn sddl_copy_of_reproduces_a_protected_acl_and_refuses_what_it_cannot() {
        use crate::sys::{Ace, PathAcl};
        let ace = |flags, mask, sid: &str| Ace { allow: true, flags, mask, sid: sid.into() };
        let acl = PathAcl { protected: true, aces: vec![ace(0, 0x1f01ff, "S-1-5-18"), ace(0x3, 0x1200a9, "S-1-5-32-544")] };
        assert_eq!(sddl_copy_of(&acl).unwrap(), "D:P(A;;0x1f01ff;;;S-1-5-18)(A;OICI;0x1200a9;;;S-1-5-32-544)");
        for bad in [Ace { allow: false, ..ace(0, 1, "S-1-5-18") }, ace(0x10, 1, "S-1-5-18"), ace(0, 1, "evil)(A;;GA;;;WD")] {
            assert!(sddl_copy_of(&PathAcl { protected: true, aces: vec![bad] }).is_err());
        }
    }

    use super::*;

    fn roots() -> Roots {
        Roots::custom(PathBuf::from("C:\\ProgramData\\SupermarketPOS"), PathBuf::from("C:\\Program Files\\SupermarketPOS"))
    }

    #[test]
    fn service_sid_matches_the_documented_trustedinstaller_value() {
        assert_eq!(
            service_sid("TrustedInstaller"),
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
        );
        // case-insensitive, like the OS
        assert_eq!(service_sid("trustedinstaller"), service_sid("TrustedInstaller"));
        // pinned so a refactor cannot change what the ACLs are written for
        assert_eq!(service_sid("SupermarketPOS-Postgres"), "S-1-5-80-2037229416-2234681911-3031819809-170528146-4058927519");
    }

    #[test]
    fn grant_specs_use_star_sid_syntax() {
        assert_eq!(Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer).spec(), "*S-1-5-18:(OI)(CI)F");
        assert_eq!(Grant::new("S-1-5-80-1-2-3-4-5", "R", Inherit::No).spec(), "*S-1-5-80-1-2-3-4-5:R");
    }

    #[test]
    fn the_sddl_is_a_protected_dacl_of_exactly_the_planned_grants_with_numeric_masks() {
        let g = [
            Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer),
            Grant::new(SID_ADMINISTRATORS, "RX", Inherit::No),
            Grant::new("S-1-5-80-1-2-3-4-5", "M", Inherit::ObjectContainer),
            Grant::new(SID_USERS, "R", Inherit::No),
        ];
        assert_eq!(
            sddl_for(Some(SID_ADMINISTRATORS), &g).unwrap(),
            "O:S-1-5-32-544D:P(A;OICI;0x1f01ff;;;S-1-5-18)(A;;0x1200a9;;;S-1-5-32-544)(A;OICI;0x1301bf;;;S-1-5-80-1-2-3-4-5)(A;;0x120089;;;S-1-5-32-545)"
        );
        assert_eq!(sddl_for(None, &g[..1]).unwrap(), "D:P(A;OICI;0x1f01ff;;;S-1-5-18)");
        // nothing but a plain SID string and a known right can reach the SDDL
        assert!(sddl_for(None, &[Grant::new("S-1-5-18)(A;;GA;;;WD", "F", Inherit::No)]).is_err());
        assert!(sddl_for(None, &[Grant::new(SID_SYSTEM, "GA", Inherit::No)]).is_err());
        assert!(sddl_for(Some("WD"), &g).is_err());
    }

    fn ace(sid: &str, mask: u32, flags: u8) -> crate::sys::Ace {
        crate::sys::Ace { allow: true, flags, mask, sid: sid.to_string() }
    }
    fn acl_of(protected: bool, aces: Vec<crate::sys::Ace>) -> crate::sys::PathAcl {
        crate::sys::PathAcl { protected, aces }
    }

    #[test]
    fn read_back_accepts_exactly_the_planned_aces_in_any_order() {
        let g = [Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer), Grant::new(SID_USERS, "RX", Inherit::No)];
        let ok = acl_of(true, vec![ace(SID_USERS, 0x1200a9, 0), ace(SID_SYSTEM, 0x1f01ff, 3)]);
        assert!(verify_dacl(&g, &ok).is_ok());
    }

    #[test]
    fn read_back_rejects_a_planted_extra_ace_a_wrong_mask_wrong_flags_a_missing_ace_and_an_unprotected_dacl() {
        let g = [Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer), Grant::new(SID_USERS, "RX", Inherit::No)];
        let good = vec![ace(SID_SYSTEM, 0x1f01ff, 3), ace(SID_USERS, 0x1200a9, 0)];
        let mut extra = good.clone();
        extra.push(ace("S-1-1-0", 0x1f01ff, 3)); // Everyone:(OI)(CI)F
        assert!(verify_dacl(&g, &acl_of(true, extra)).unwrap_err().contains("S-1-1-0"));
        let mut wrong_mask = good.clone();
        wrong_mask[1].mask = 0x1f01ff;
        assert!(verify_dacl(&g, &acl_of(true, wrong_mask)).is_err());
        let mut wrong_flags = good.clone();
        wrong_flags[1].flags = 3;
        assert!(verify_dacl(&g, &acl_of(true, wrong_flags)).is_err());
        let mut inherited = good.clone();
        inherited[0].flags |= 0x10; // INHERITED_ACE
        assert!(verify_dacl(&g, &acl_of(true, inherited)).is_err());
        assert!(verify_dacl(&g, &acl_of(true, good[..1].to_vec())).is_err());
        let mut deny = good.clone();
        deny[0].allow = false;
        assert!(verify_dacl(&g, &acl_of(true, deny)).is_err());
        assert!(verify_dacl(&g, &acl_of(false, good)).unwrap_err().contains("protected"));
    }

    // F5 a: a folder that already carries a planted explicit Everyone:(OI)(CI)F ends with only the planned ACEs.
    // Owner stays the current user here (setting Administrators as owner needs SeTakeOwnership, i.e. elevation);
    // the elevated variant below is #[ignore]. Temp dir created by the test only.
    #[cfg(windows)]
    fn plant_everyone(dir: &Path) {
        let o = std::process::Command::new(icacls_exe_for_test()).arg(dir).args(["/grant", "*S-1-1-0:(OI)(CI)F"]).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
        let before = crate::sys::path_acl(dir).unwrap();
        assert!(before.aces.iter().any(|a| a.sid == "S-1-1-0"), "the planted Everyone ACE must be there first");
    }

    #[cfg(windows)]
    fn planned_for_test(dir: &Path) -> Vec<Grant> {
        let me = crate::sys::path_owner_sid(dir).unwrap();
        let mut g = base();
        if me != SID_ADMINISTRATORS && me != SID_SYSTEM {
            g.push(Grant::new(me, "F", Inherit::ObjectContainer)); // keep the test user able to clean up
        }
        g
    }

    #[cfg(windows)]
    #[test]
    fn apply_removes_planted_explicit_aces_and_leaves_exactly_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("secrets");
        std::fs::create_dir(&sub).unwrap();
        plant_everyone(&sub);
        let plan = planned_for_test(&sub);
        apply_one_with_owner(&sub, &plan, None).unwrap();
        let after = crate::sys::path_acl(&sub).unwrap();
        assert!(after.protected, "inheritance must be removed");
        assert!(after.aces.iter().all(|a| a.sid != "S-1-1-0"), "{:?}", after.aces);
        verify_dacl(&plan, &after).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn apply_also_replaces_an_inherited_everyone_grant_and_a_file_gets_exactly_its_grants() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("gotrue.env");
        std::fs::write(&f, b"x").unwrap();
        plant_everyone(dir.path()); // inherited by files created afterwards
        std::fs::write(dir.path().join("later.env"), b"y").unwrap();
        let me = crate::sys::path_owner_sid(&f).unwrap();
        let mut plan = vec![Grant::new(SID_SYSTEM, "F", Inherit::No), Grant::new(SID_ADMINISTRATORS, "F", Inherit::No)];
        if me != SID_ADMINISTRATORS {
            plan.push(Grant::new(me, "F", Inherit::No));
        }
        let later = dir.path().join("later.env");
        apply_one_with_owner(&later, &plan, None).unwrap();
        let after = crate::sys::path_acl(&later).unwrap();
        assert!(after.aces.iter().all(|a| a.sid != "S-1-1-0"), "{:?}", after.aces);
        verify_dacl(&plan, &after).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs an elevated process: owner Administrators requires SeTakeOwnership"]
    fn elevated_apply_sets_administrators_as_owner_and_the_exact_dacl() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("secrets");
        std::fs::create_dir(&sub).unwrap();
        plant_everyone(&sub);
        apply_one(&sub, &base()).unwrap();
        assert_eq!(crate::sys::path_owner_sid(&sub).unwrap(), SID_ADMINISTRATORS);
        verify_dacl(&base(), &crate::sys::path_acl(&sub).unwrap()).unwrap();
    }

    // F8 j: no Gateway (or Users) access to update.lock, and nothing inheritable on a file.
    #[test]
    fn the_lock_file_acl_is_system_and_administrators_only() {
        let e = lock_file_acl(&roots());
        assert_eq!(e.path, roots().update_lock());
        let sids: Vec<&str> = e.grants.iter().map(|g| g.sid.as_str()).collect();
        assert_eq!(sids, vec![SID_SYSTEM, SID_ADMINISTRATORS]);
        assert!(e.grants.iter().all(|g| g.rights == "F" && g.inherit == Inherit::No));
    }

    // F8 b: a planted tree thousands of levels deep must not overflow the (deliberately small) stack.
    #[cfg(windows)]
    #[test]
    fn the_reparse_scan_survives_a_very_deep_tree() {
        let d = tempfile::tempdir().unwrap();
        let mut p = d.path().to_path_buf();
        for _ in 0..1500 {
            p.push("d");
        }
        std::fs::create_dir_all(&p).unwrap();
        let root = d.path().to_path_buf();
        let hit = std::thread::Builder::new().stack_size(32 * 1024).spawn(move || find_reparse_point(&root).unwrap()).unwrap().join().unwrap();
        assert_eq!(hit, None);
        let verbatim = format!(r"\\?\{}", d.path().display());
        let _ = std::process::Command::new("cmd").args(["/c", "rd", "/s", "/q", &verbatim]).output();
    }

    fn find<'a>(plan: &'a [AclEntry], path: &Path) -> &'a AclEntry {
        plan.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("no ACL entry for {}", path.display()))
    }
    fn sids(e: &AclEntry) -> Vec<&str> {
        e.grants.iter().map(|g| g.sid.as_str()).collect()
    }

    #[test]
    fn every_entry_grants_system_and_administrators_full_and_nobody_gets_users_except_client() {
        let r = roots();
        let plan = data_acl_plan(&r);
        for e in &plan {
            let s = sids(e);
            assert!(s.contains(&SID_SYSTEM) && s.contains(&SID_ADMINISTRATORS), "{}", e.path.display());
            let users = s.contains(&SID_USERS);
            assert_eq!(
                users,
                e.path == r.client() || e.path == r.client().join("pairing") || e.path == r.client().join("pki"),
                "only client\\ and client\\pairing\\ are readable by Users: {}",
                e.path.display()
            );
        }
    }

    #[test]
    fn secrets_backups_work_and_packs_cache_have_no_service_access() {
        let r = roots();
        let plan = data_acl_plan(&r);
        for p in [r.secrets(), r.backups(), r.work(), r.packs_cache(), r.pki(), r.conf(), r.posctl_logs()] {
            assert_eq!(sids(find(&plan, &p)).len(), 2, "{}", p.display());
        }
    }

    // Task 4 carry: secrets\ is SYSTEM + Administrators full control (OI)(CI), nothing else, and the
    // owner is forced to Administrators by apply_one. pgpass.conf (the supabase_admin password) has no
    // per-file service grant builder at all.
    #[test]
    fn the_secrets_folder_is_system_and_administrators_only_and_owned_by_administrators() {
        let r = roots();
        let want = vec![Grant::new(SID_SYSTEM, "F", Inherit::ObjectContainer), Grant::new(SID_ADMINISTRATORS, "F", Inherit::ObjectContainer)];
        assert_eq!(secrets_dir_acl(&r).path, r.secrets());
        assert_eq!(secrets_dir_acl(&r).grants, want);
        assert_eq!(find(&data_acl_plan(&r), &r.secrets()).grants, want);
        for g in gotrue_env_grants().iter().chain(&postgrest_conf_grants()).chain(&caddy_file_grants()) {
            assert!(!g.sid.is_empty() && g.inherit == Inherit::No, "per-file grants are for that file only");
        }
    }

    #[test]
    fn each_service_gets_modify_only_on_its_own_folders() {
        let r = roots();
        let plan = data_acl_plan(&r);
        for c in Component::ALL {
            for p in [r.logs_for(c.service_name()), r.tmp_for(c.service_name())] {
                let e = find(&plan, &p);
                let own: Vec<_> = e.grants.iter().filter(|g| g.sid == c.sid()).collect();
                assert_eq!(own.len(), 1);
                assert_eq!((own[0].rights, own[0].inherit), ("M", Inherit::ObjectContainer));
                for other in Component::ALL.into_iter().filter(|o| *o != c) {
                    assert!(!sids(e).contains(&other.sid().as_str()));
                }
            }
        }
        let pg = find(&plan, &r.pgdata());
        assert!(pg.grants.iter().any(|g| g.sid == Component::Postgres.sid() && g.rights == "M"));
        assert_eq!(sids(pg).len(), 3);
        let photos = find(&plan, &r.photos());
        assert!(photos.grants.iter().any(|g| g.sid == Component::Functions.sid() && g.rights == "M"));
        let caddy = find(&plan, &r.pki_caddy());
        assert!(caddy.grants.iter().any(|g| g.sid == Component::Gateway.sid() && g.rights == "M"));
        assert_eq!(sids(caddy).len(), 3, "no other principal reaches the root CA key");
    }

    #[test]
    fn the_data_root_gives_services_read_execute_on_that_folder_only() {
        let r = roots();
        let root = find(&data_acl_plan(&r), &r.data).clone();
        for c in Component::ALL {
            let g = root.grants.iter().find(|g| g.sid == c.sid()).expect("service on the root");
            assert_eq!((g.rights, g.inherit), ("RX", Inherit::No));
        }
    }

    // FR19: `state\update\` holds the updater's control files; nobody but SYSTEM and Administrators may even look inside.
    #[test]
    fn the_update_folder_is_system_and_administrators_only_and_protected() {
        let r = roots();
        let plan = data_acl_plan(&r);
        let e = find(&plan, &r.update_dir());
        assert_eq!(sids(e), vec![SID_SYSTEM, SID_ADMINISTRATORS], "no Gateway, no Users, no service");
        assert!(e.grants.iter().all(|g| g.rights == "F" && g.inherit == Inherit::ObjectContainer));
        let sddl = sddl_for(Some(SID_ADMINISTRATORS), &e.grants).unwrap();
        assert!(sddl.contains("D:P("), "inheritance is disabled (protected DACL): {sddl}");
        assert_eq!(sddl.matches("(A;").count(), 2, "{sddl}");
        let pos = |p: &PathBuf| plan.iter().position(|x| &x.path == p).unwrap();
        assert!(pos(&r.state()) < pos(&r.update_dir()), "parent first");
        // status.json's reader keeps its ACE on state\ itself
        assert!(find(&plan, &r.state()).grants.iter().any(|g| g.sid == Component::Gateway.sid()));
        assert_eq!(update_dir_acl(&r), *e);
    }

    #[test]
    fn the_lock_file_sits_in_the_update_folder() {
        assert_eq!(lock_file_acl(&roots()).path, roots().update_lock());
    }

    // Host tests never apply a SYSTEM + Administrators-only DACL to a real folder (it would lock the developer out of their own
    // temp dir): this one runs elevated in the sandbox (scenario 21 runs the --ignored tests).
    #[cfg(windows)]
    #[test]
    #[ignore = "needs an elevated process (runs in the Windows Sandbox, scenario 21): it really applies the SYSTEM + Administrators-only DACL"]
    fn elevated_protect_update_dir_creates_and_repairs_the_exact_dacl() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        r.dev = false;
        std::fs::create_dir_all(r.state()).unwrap();
        protect_update_dir(&r).unwrap(); // creates
        verify_dacl(&update_dir_acl(&r).grants, &crate::sys::path_acl(&r.update_dir()).unwrap()).unwrap();
        plant_everyone(&r.update_dir());
        protect_update_dir(&r).unwrap(); // repairs
        let after = crate::sys::path_acl(&r.update_dir()).unwrap();
        assert!(after.aces.iter().all(|a| a.sid != "S-1-1-0"), "{:?}", after.aces);
        verify_dacl(&update_dir_acl(&r).grants, &after).unwrap();
    }

    #[test]
    fn state_is_readable_by_the_gateway_and_client_by_users() {
        let r = roots();
        let plan = data_acl_plan(&r);
        let state = find(&plan, &r.state());
        let gw = state.grants.iter().find(|g| g.sid == Component::Gateway.sid()).unwrap();
        assert_eq!((gw.rights, gw.inherit), ("RX", Inherit::ObjectContainer));
        let client = find(&plan, &r.client());
        let users = client.grants.iter().find(|g| g.sid == SID_USERS).unwrap();
        assert_eq!((users.rights, users.inherit), ("RX", Inherit::ObjectContainer));
    }

    #[test]
    fn program_root_is_readable_by_users_and_services_writable_only_by_admins() {
        let r = roots();
        let e = &program_acl_plan(&r)[0];
        assert_eq!(e.path, r.program);
        assert!(e.grants.iter().any(|g| g.sid == SID_USERS && g.rights == "RX"));
        assert!(e.grants.iter().all(|g| g.rights != "M" && g.rights != "F" || g.sid == SID_SYSTEM || g.sid == SID_ADMINISTRATORS));
        assert_eq!(e.grants.len(), 3 + Component::ALL.len());
    }

    #[test]
    fn pairing_offers_are_readable_by_the_gateway_only() {
        let r = roots();
        let plan = data_acl_plan(&r);
        let offers = find(&plan, &r.pairing_offers());
        let gw = offers.grants.iter().find(|g| g.sid == Component::Gateway.sid()).unwrap();
        assert_eq!((gw.rights, gw.inherit), ("R", Inherit::ObjectContainer));
        assert_eq!(sids(offers).len(), 3);
        assert!(!sids(offers).contains(&SID_USERS));
    }

    #[test]
    fn per_file_secret_grants_name_exactly_one_reader() {
        let g = gotrue_env_grants();
        assert_eq!(g.len(), 3);
        assert_eq!(g[2], Grant::new(Component::Auth.sid(), "R", Inherit::No));
        assert_eq!(postgrest_conf_grants()[2].sid, Component::Rest.sid());
        assert_eq!(caddy_file_grants()[2].sid, Component::Gateway.sid());
    }

    // both folders the Gateway serves from carry a Gateway RX entry, this folder only.
    #[test]
    fn client_and_client_pairing_give_the_gateway_read_execute_on_that_folder_only() {
        let r = roots();
        let plan = data_acl_plan(&r);
        for p in [r.client(), r.client().join("pairing")] {
            let e = find(&plan, &p);
            let gw = e.grants.iter().find(|g| g.sid == Component::Gateway.sid()).unwrap_or_else(|| panic!("no Gateway entry on {}", p.display()));
            assert_eq!((gw.rights, gw.inherit), ("RX", Inherit::No), "{}", p.display());
            assert!(e.grants.iter().any(|g| g.sid == SID_USERS && g.rights == "RX" && g.inherit == Inherit::ObjectContainer), "{}", p.display());
        }
    }

    #[cfg(windows)]
    fn mklink_junction(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()])
            .output()
            .unwrap();
        assert!(st.status.success(), "mklink failed: {}", String::from_utf8_lossy(&st.stdout));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_tree_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir(&tree).unwrap();
        assert_eq!(find_reparse_point(&tree).unwrap(), None);
        let link = tree.join("planted");
        mklink_junction(&link, &real);
        assert_eq!(find_reparse_point(&tree).unwrap(), Some(link));
    }

    // Task 4 carry: no reparse point may be followed by an elevated icacls. The refusal happens before any tool
    // runs, so this touches only a temp dir this test created.
    #[cfg(windows)]
    #[test]
    fn apply_one_refuses_a_target_that_is_a_reparse_point() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        mklink_junction(&link, &real);
        let err = apply_one(&link, &base()).unwrap_err();
        assert!(err.contains("reparse"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn protecting_the_secrets_folder_refuses_a_missing_folder_and_a_planted_junction() {
        let dir = tempfile::tempdir().unwrap();
        let r = Roots::custom(dir.path().join("data"), dir.path().join("prog"));
        assert!(protect_secrets_dir(&r).unwrap_err().contains("does not exist"), "secrets\\ must be created by the layout step, not here");
        std::fs::create_dir_all(r.secrets()).unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        mklink_junction(&r.secrets().join("planted"), &real);
        assert!(protect_secrets_dir(&r).unwrap_err().contains("reparse"));
    }
}
