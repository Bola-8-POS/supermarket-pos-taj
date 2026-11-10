//! Private staging for the data move: the dump folder and the cloud `pgpass` folder. Both are born with a protected DACL (SYSTEM and
//! Administrators only), refuse a reparse point above them, and are removed on drop. `purge` sweeps what a crash left behind.
use crate::acl::{apply_one, find_reparse_point, is_reparse, sddl_for, Grant};
use crate::ops::lock::{LockGuard, LockMode};
use crate::ops::outcome::OpError;
use crate::ops::world::R;
use crate::paths::Roots;
use std::path::{Path, PathBuf};

const DUMP_PREFIX: &str = "switch-";
const PGPASS_PREFIX: &str = "cloud-pgpass-";

/// SYSTEM and Administrators, full control, inherited by what is written inside (the one list in `acl`).
pub(crate) fn grants() -> Vec<Grant> {
    crate::acl::base()
}

fn err(reason: &str, m: String) -> OpError {
    OpError::err(reason, m)
}

/// A parent that is a link would send the new folder somewhere else; refused before anything is created.
fn refuse_link(parent: &Path) -> R<()> {
    match std::fs::symlink_metadata(parent) {
        Ok(m) if is_reparse(&m) => Err(err(
            "STAGING_REPARSE",
            format!(
                "{} is a reparse point (junction or symlink)",
                parent.display()
            ),
        )),
        Ok(_) => Ok(()),
        Err(e) => Err(err(
            "STAGING_UNWRITABLE",
            format!("{}: {}", parent.display(), e.kind()),
        )),
    }
}

/// One new folder, private from its first instant (dev roots just create it). Read back, and refused if anything under it is a link.
fn make_private(dir: &Path, roots: &Roots) -> R<()> {
    let fail = |m: String| err("STAGING_UNWRITABLE", format!("{}: {m}", dir.display()));
    if roots.dev {
        return std::fs::create_dir(dir).map_err(|e| fail(e.kind().to_string()));
    }
    let g = grants();
    let sddl = sddl_for(None, &g).map_err(fail)?;
    crate::sys::create_dir_with_sddl(dir, &sddl).map_err(|e| fail(e.to_string()))?;
    apply_one(dir, &g).map_err(fail)?; // owner Administrators and the exact DACL, read back
    match find_reparse_point(dir) {
        Ok(None) => Ok(()),
        Ok(Some(p)) => Err(err(
            "STAGING_REPARSE",
            format!("{} is a reparse point", p.display()),
        )),
        Err(e) => Err(fail(e.kind().to_string())),
    }
}

/// Plan 08's policy (`backup::acl::trust_is_private`) over an existing folder: a `backups\` that is not owned by SYSTEM or
/// Administrators, or that anyone else can read, would expose the dump. Dev roots skip it (developer profile).
fn require_private(dir: &Path, roots: &Roots) -> R<()> {
    if roots.dev {
        return Ok(());
    }
    let h = crate::sys::open_trust(dir).map_err(|e| {
        err(
            "STAGING_UNWRITABLE",
            format!("{}: {}", dir.display(), e.kind()),
        )
    })?;
    trust_verdict(dir, &h)
}

/// The `icacls` calls that make an unsafe folder acceptable: the owner first (the check wants SYSTEM or Administrators), then no
/// inheritance and only SYSTEM and Administrators. The message prints these and the elevated Sandbox test executes exactly these.
pub(crate) fn fix_commands(dir: &Path) -> Vec<Vec<String>> {
    let d = dir.display().to_string();
    vec![
        vec![d.clone(), "/setowner".into(), "*S-1-5-32-544".into()],
        vec![
            d,
            "/inheritance:r".into(),
            "/grant:r".into(),
            "*S-1-5-18:(OI)(CI)F".into(),
            "*S-1-5-32-544:(OI)(CI)F".into(),
        ],
    ]
}

fn fix_hint(dir: &Path) -> String {
    fix_commands(dir)
        .iter()
        .map(|a| format!("icacls \"{}\" {}", a[0], a[1..].join(" ")))
        .collect::<Vec<_>>()
        .join(" , then ")
}

fn trust_verdict(dir: &Path, h: &crate::sys::HandleInfo) -> R<()> {
    crate::backup::acl::trust_is_private(h).map_err(|v| {
        err(
            "STAGING_NOT_PRIVATE",
            format!(
                "{} is not private: {}. Nothing was written there. Run as an administrator: {}; then run the command again",
                dir.display(),
                v.join("; "),
                fix_hint(dir)
            ),
        )
    })
}

/// `state\update\cloud-pgpass-<id>` (the cloud password file) from `create`, and `backups\switch-<id>` (the dump) only once a run
/// holds the exclusive lock (`ensure_dump`). A plan therefore never touches `backups\`. Both are removed on drop.
pub struct StagingDir {
    id: String,
    dump: Option<PathBuf>,
    pgpass: PathBuf,
}

impl StagingDir {
    /// The pgpass folder only: `plan` and `run` need the cloud password file before anything else.
    pub fn create(roots: &Roots) -> R<StagingDir> {
        let id = crate::util::random_uuid_v4().map_err(|e| err("RANDOM_UNAVAILABLE", e))?;
        crate::acl::protect_update_dir(roots).map_err(|m| err("STAGING_UNWRITABLE", m))?;
        refuse_link(&roots.update_dir())?;
        let s = StagingDir {
            pgpass: roots.update_dir().join(format!("{PGPASS_PREFIX}{id}")),
            id,
            dump: None,
        };
        make_private(&s.pgpass, roots)?;
        Ok(s)
    }

    /// The dump folder, created under the exclusive lock (a shared guard is refused): `backups\` must be a real folder that only
    /// SYSTEM and Administrators can read (Plan 08's rule), and a junction there is refused before anything is written.
    pub fn ensure_dump(&mut self, roots: &Roots, lock: &LockGuard) -> R<&Path> {
        if lock.mode() != LockMode::Exclusive {
            return Err(err(
                "STAGING_NEEDS_EXCLUSIVE_LOCK",
                "the dump folder is only created under the exclusive operation lock".into(),
            ));
        }
        if self.dump.is_none() {
            let backups = roots.backups();
            if !backups.exists() {
                make_private(&backups, roots)?; // provisioning makes it; this only covers a store that lost it
            }
            refuse_link(&backups)?;
            require_private(&backups, roots)?;
            let dump = backups.join(format!("{DUMP_PREFIX}{}", self.id));
            make_private(&dump, roots)?;
            self.dump = Some(dump);
        }
        self.dump
            .as_deref()
            .ok_or_else(|| err("STAGING_UNWRITABLE", "the dump folder is missing".into()))
    }

    /// `None` until `ensure_dump` ran.
    pub fn dump_path(&self) -> Option<&Path> {
        self.dump.as_deref()
    }
    pub fn pgpass_dir(&self) -> &Path {
        &self.pgpass
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        for p in self.dump.iter().chain(std::iter::once(&self.pgpass)) {
            if let Err(e) = std::fs::remove_dir_all(p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    // the next `purge` (under the lock) removes it; the path holds no secret in its name
                    eprintln!(
                        "{{\"warn\":\"STAGING_REMOVE_FAILED\",\"path\":{:?},\"kind\":\"{:?}\"}}",
                        p.display().to_string(),
                        e.kind()
                    );
                }
            }
        }
    }
}

/// Removes every `backups\switch-*` and, separately, every `cloud-pgpass-*` under the update folder (a crash leaves them behind).
/// Needs the lock guard, so it cannot run beside another operation. Returns how many folders it removed.
///
/// `keep` is the staging of the run that is purging: its own folders are skipped (the run created them before the lock).
pub fn purge(roots: &Roots, lock: &LockGuard, keep: Option<&StagingDir>) -> R<usize> {
    if lock.mode() != LockMode::Exclusive {
        return Err(err(
            "STAGING_NEEDS_EXCLUSIVE_LOCK",
            "staging is only purged under the exclusive operation lock".into(),
        ));
    }
    let mut n = 0;
    for (dir, prefix) in [
        (roots.backups(), DUMP_PREFIX),
        (roots.update_dir(), PGPASS_PREFIX),
    ] {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(err(
                    "STAGING_UNWRITABLE",
                    format!("{}: {}", dir.display(), e.kind()),
                ))
            }
        };
        for e in rd
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        {
            let p = e.path();
            if keep.is_some_and(|k| p == k.pgpass_dir() || Some(p.as_path()) == k.dump_path()) {
                continue;
            }
            let link = std::fs::symlink_metadata(&p)
                .map(|m| is_reparse(&m))
                .unwrap_or(false);
            // a link is removed itself, never followed
            let done = if link {
                std::fs::remove_dir(&p).or_else(|_| std::fs::remove_file(&p))
            } else {
                std::fs::remove_dir_all(&p)
            };
            done.map_err(|x| {
                err(
                    "STAGING_PURGE_FAILED",
                    format!("{}: {}", p.display(), x.kind()),
                )
            })?;
            n += 1;
        }
    }
    Ok(n)
}

/// What a crashed switch left behind, read-only (no lock): every `state\update\cloud-pgpass-<id>` and `backups\switch-<id>`. Only those two
/// names count (prefix plus a non-empty id, files and links too, as `purge` removes them); a folder that cannot be read adds nothing here.
/// `status` alerts on it: the pgpass folder holds the CLOUD database password.
pub fn leftovers(roots: &Roots) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for (dir, prefix) in [(roots.backups(), DUMP_PREFIX), (roots.update_dir(), PGPASS_PREFIX)] {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            found.extend(
                rd.flatten()
                    .filter(|e| e.file_name().to_string_lossy().strip_prefix(prefix).is_some_and(|id| !id.is_empty()))
                    .map(|e| e.path()),
            );
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Roots;

    fn store() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.backups()).unwrap();
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        (d, roots)
    }
    fn lock(roots: &Roots) -> crate::ops::lock::LockGuard {
        crate::ops::lock::acquire_for(
            roots,
            crate::ops::lock::LockMode::Exclusive,
            "test",
            "op-test",
            std::time::Duration::ZERO,
        )
        .unwrap()
    }

    #[test]
    fn staging_creates_the_pgpass_folder_and_the_dump_folder_only_under_the_lock() {
        let (_d, roots) = store();
        let (dump, pgpass) = {
            let mut s = StagingDir::create(&roots).unwrap();
            assert!(
                s.dump_path().is_none(),
                "a plan never creates the dump folder"
            );
            assert_eq!(
                std::fs::read_dir(roots.backups()).unwrap().count(),
                0,
                "and never touches backups"
            );
            assert!(s.pgpass_dir().is_dir() && s.pgpass_dir().starts_with(roots.update_dir()));
            assert!(s
                .pgpass_dir()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cloud-pgpass-"));
            let shared = crate::ops::lock::acquire(
                &roots.update_dir(),
                LockMode::Shared,
                "test",
                "op-s",
                std::time::Duration::ZERO,
            )
            .unwrap();
            assert_eq!(
                s.ensure_dump(&roots, &shared).unwrap_err().reason,
                "STAGING_NEEDS_EXCLUSIVE_LOCK"
            );
            drop(shared);
            let g = lock(&roots);
            let d = s.ensure_dump(&roots, &g).unwrap().to_path_buf();
            assert!(d.is_dir() && d.starts_with(roots.backups()));
            assert!(d
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("switch-"));
            assert_eq!(
                s.ensure_dump(&roots, &g).unwrap(),
                d,
                "asking twice gives the same folder"
            );
            (d, s.pgpass_dir().to_path_buf())
        };
        assert!(!dump.exists() && !pgpass.exists());
    }

    #[cfg(windows)]
    #[test]
    fn staging_refuses_a_reparse_point() {
        let (d, roots) = store();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::remove_dir(roots.backups()).unwrap();
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(roots.backups())
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            ok.status.success(),
            "{}",
            String::from_utf8_lossy(&ok.stdout)
        );
        let mut s = StagingDir::create(&roots)
            .expect("a plan does not look at backups, so a junction there is not its problem");
        let g = lock(&roots);
        let e = s.ensure_dump(&roots, &g).map(|_| ()).unwrap_err();
        assert_eq!(e.reason, "STAGING_REPARSE", "{e:?}");
        assert_eq!(
            std::fs::read_dir(&target).unwrap().count(),
            0,
            "nothing was written through the link"
        );
    }

    #[test]
    fn staging_dacl_is_owner_and_system_only() {
        // the plan: exactly SYSTEM and Administrators, full control, inherited, protected (no other ACE, no inherited ACE)
        let g = grants();
        let sids: Vec<&str> = g.iter().map(|x| x.sid.as_str()).collect();
        assert_eq!(
            sids,
            [crate::acl::SID_SYSTEM, crate::acl::SID_ADMINISTRATORS]
        );
        assert!(g
            .iter()
            .all(|x| x.rights == "F" && x.inherit == crate::acl::Inherit::ObjectContainer));
        let sddl = crate::acl::sddl_for(None, &g).unwrap();
        assert!(sddl.starts_with("D:P("), "protected: {sddl}");
        assert_eq!(sddl.matches("(A;OICI;").count(), 2, "{sddl}");
    }

    // ---- elevated, real Windows ACLs (Sandbox scenario 21 runs every #[ignore] test elevated and records the SDDL lines below)

    /// What the product sees of a folder (owner, protection, every ACE) in SDDL syntax, plus `icacls` as the OS prints it. The lines
    /// `SDDL|<label>|...` and `ICACLS|<label>|...` are collected into the scenario's result.json.
    #[cfg(windows)]
    fn emit(label: &str, p: &Path) {
        let h = crate::sys::open_trust(p).unwrap();
        let aces: String = h
            .acl
            .aces
            .iter()
            .map(|a| {
                format!(
                    "({};0x{:02x};0x{:x};;;{})",
                    if a.allow { "A" } else { "other" },
                    a.flags,
                    a.mask,
                    a.sid
                )
            })
            .collect();
        println!(
            "SDDL|{label}|O:{}D:{}{aces}",
            h.owner,
            if h.acl.protected { "P" } else { "" }
        );
        let out = std::process::Command::new("icacls")
            .arg(p)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        println!("ICACLS|{label}|{text}");
    }

    /// The folder exactly as provisioning makes it: created, then the production `data_acl_plan` entry applied.
    #[cfg(windows)]
    fn production_backups(roots: &Roots) {
        std::fs::create_dir_all(roots.backups()).unwrap();
        let e = crate::acl::data_acl_plan(roots)
            .into_iter()
            .find(|e| e.path == roots.backups())
            .expect("data_acl_plan has a backups entry");
        crate::acl::apply_one(&e.path, &e.grants).unwrap();
    }

    #[cfg(windows)]
    fn elevated_store(with_backups: bool) -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        if with_backups {
            production_backups(&roots);
        }
        (d, roots)
    }

    #[cfg(windows)]
    fn assert_private_children(roots: &Roots, s: &StagingDir) {
        for p in [s.dump_path().unwrap(), s.pgpass_dir()] {
            crate::acl::verify_dacl(&grants(), &crate::sys::path_acl(p).unwrap()).unwrap();
            let h = crate::sys::open_trust(p).unwrap();
            assert!(crate::backup::acl::trust_is_private(&h).is_ok(), "{p:?}");
        }
        assert!(trust_verdict(
            &roots.backups(),
            &crate::sys::open_trust(&roots.backups()).unwrap()
        )
        .is_ok());
    }

    /// `backups\` made by the PRODUCTION entry passes the check; the dump and pgpass folders are private; the SDDL is recorded.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs elevation; Windows Sandbox scenario 21 (runs every --ignored test elevated) records the SDDL"]
    fn staging_real_dacl_read_back() {
        let (_d, roots) = elevated_store(true);
        emit("backups-production-entry", &roots.backups());
        let mut s = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        s.ensure_dump(&roots, &g).unwrap();
        assert_private_children(&roots, &s);
        emit("dump-switch-folder", s.dump_path().unwrap());
        emit("pgpass-folder", s.pgpass_dir());
    }

    /// An ABSENT `backups\` is created private by the shared path (owner Administrators, protected, SYSTEM and Administrators only).
    #[cfg(windows)]
    #[test]
    #[ignore = "needs elevation; Windows Sandbox scenario 21 (runs every --ignored test elevated) records the SDDL"]
    fn staging_creates_an_absent_backups_folder_private() {
        let (_d, roots) = elevated_store(false);
        assert!(!roots.backups().exists());
        let mut s = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        s.ensure_dump(&roots, &g).unwrap();
        emit("backups-absent-created", &roots.backups());
        crate::acl::verify_dacl(&grants(), &crate::sys::path_acl(&roots.backups()).unwrap())
            .unwrap();
        let h = crate::sys::open_trust(&roots.backups()).unwrap();
        assert!(h.acl.protected);
        assert_eq!(h.owner, crate::acl::SID_ADMINISTRATORS);
        assert_private_children(&roots, &s);
        emit("absent-case-dump-folder", s.dump_path().unwrap());
    }

    /// S4 on real Windows: an existing `backups\` that inherits its ACL is REFUSED, with nothing written under it.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs elevation; Windows Sandbox scenario 21 (runs every --ignored test elevated) is the only real-Windows proof of S4"]
    fn an_inherited_backups_folder_is_refused_and_nothing_is_written() {
        let (_d, roots) = elevated_store(false);
        std::fs::create_dir_all(roots.backups()).unwrap(); // an ordinary folder: inherits the temp parent
        emit("backups-inherited-refused", &roots.backups());
        let mut s = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        let e = s.ensure_dump(&roots, &g).map(|_| ()).unwrap_err();
        assert_eq!(e.reason, "STAGING_NOT_PRIVATE", "{e:?}");
        assert!(e.message.contains("icacls"), "{}", e.message);
        assert_eq!(
            std::fs::read_dir(roots.backups()).unwrap().count(),
            0,
            "nothing was created under the refused folder"
        );
        assert!(s.dump_path().is_none());
    }

    /// The printed fix works: an unsafe folder (inherited ACL AND an owner that is not Administrators) passes the check after the exact
    /// `icacls` calls the message prints, and a dump folder can then be made in it.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs elevation; Windows Sandbox scenario 21 (runs every --ignored test elevated) proves the hint"]
    fn the_printed_icacls_fix_makes_an_unsafe_folder_pass() {
        let (_d, roots) = elevated_store(false);
        std::fs::create_dir_all(roots.backups()).unwrap();
        let user = std::env::var("USERNAME").expect("USERNAME");
        let out = std::process::Command::new("icacls")
            .arg(roots.backups())
            .args(["/setowner", &user])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "could not build the wrong-owner fixture: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        emit("hint-before-wrong-owner-inherited", &roots.backups());
        let before = crate::sys::open_trust(&roots.backups()).unwrap();
        let verdict = trust_verdict(&roots.backups(), &before).unwrap_err();
        assert!(
            verdict.message.contains("owned by")
                && verdict.message.contains("inheritance is not protected"),
            "{}",
            verdict.message
        );
        for args in fix_commands(&roots.backups()) {
            let out = std::process::Command::new("icacls")
                .args(&args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        emit("hint-after", &roots.backups());
        let after = crate::sys::open_trust(&roots.backups()).unwrap();
        assert!(
            trust_verdict(&roots.backups(), &after).is_ok(),
            "the printed fix did not make the folder pass"
        );
        let mut s = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        s.ensure_dump(&roots, &g).unwrap();
        assert_private_children(&roots, &s);
    }

    #[test]
    fn purge_removes_cloud_pgpass_leftovers() {
        let (_d, roots) = store();
        let g = lock(&roots);
        let left = roots.update_dir().join("cloud-pgpass-x");
        std::fs::create_dir(&left).unwrap();
        std::fs::write(left.join("pgpass"), "secret").unwrap();
        let dump = roots.backups().join("switch-old");
        std::fs::create_dir(&dump).unwrap();
        std::fs::write(dump.join("cloud.dump"), "x").unwrap();
        let keep = roots.backups().join("repo");
        std::fs::create_dir(&keep).unwrap();
        let keep_upd = roots.update_dir().join("journal.json");
        std::fs::write(&keep_upd, "{}").unwrap();
        assert_eq!(purge(&roots, &g, None).unwrap(), 2);
        assert!(!left.exists() && !dump.exists());
        assert!(
            keep.exists() && keep_upd.exists(),
            "only the two prefixes are touched"
        );
    }

    #[test]
    fn leftovers_lists_exactly_the_two_staging_names() {
        let (_d, roots) = store();
        assert!(leftovers(&roots).is_empty(), "nothing left: nothing listed");
        let pg = roots.update_dir().join("cloud-pgpass-abc");
        let dump = roots.backups().join("switch-abc");
        for p in [&pg, &dump] {
            std::fs::create_dir(p).unwrap();
        }
        // look-alikes that are not staging: the progress file, the bare prefixes, a dump name in the update folder, a pgpass name in backups
        std::fs::write(roots.update_dir().join("switch-progress.json"), "{}").unwrap();
        std::fs::create_dir(roots.update_dir().join("cloud-pgpass-")).unwrap();
        std::fs::create_dir(roots.backups().join("switch-")).unwrap();
        std::fs::create_dir(roots.update_dir().join("switch-abc")).unwrap();
        std::fs::create_dir(roots.backups().join("cloud-pgpass-abc")).unwrap();
        std::fs::create_dir(roots.backups().join("repo")).unwrap();
        let mut want = vec![pg, dump];
        want.sort();
        assert_eq!(leftovers(&roots), want);
    }

    #[test]
    fn leftovers_is_empty_when_the_folders_are_missing() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        assert!(leftovers(&roots).is_empty());
    }

    #[test]
    fn purge_requires_the_lock_guard() {
        let _: fn(
            &crate::paths::Roots,
            &crate::ops::lock::LockGuard,
            Option<&StagingDir>,
        ) -> crate::ops::world::R<usize> = purge;
    }

    #[test]
    fn purge_skips_the_staging_of_the_run_that_is_purging() {
        let (_d, roots) = store();
        let mut mine = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        let dump = mine.ensure_dump(&roots, &g).unwrap().to_path_buf();
        let stale = roots.backups().join("switch-crashed");
        std::fs::create_dir(&stale).unwrap();
        let stale_pg = roots.update_dir().join("cloud-pgpass-crashed");
        std::fs::create_dir(&stale_pg).unwrap();
        assert_eq!(purge(&roots, &g, Some(&mine)).unwrap(), 2);
        assert!(!stale.exists() && !stale_pg.exists());
        assert!(
            dump.is_dir() && mine.pgpass_dir().is_dir(),
            "its own folders stay"
        );
    }

    #[test]
    fn purge_requires_the_exclusive_lock_not_just_a_guard() {
        let (_d, roots) = store();
        let left = roots.backups().join("switch-old");
        std::fs::create_dir(&left).unwrap();
        let shared = crate::ops::lock::acquire(
            &roots.update_dir(),
            LockMode::Shared,
            "test",
            "op-shared",
            std::time::Duration::ZERO,
        )
        .unwrap();
        assert_eq!(shared.mode(), LockMode::Shared);
        let e = purge(&roots, &shared, None).unwrap_err();
        assert_eq!(e.reason, "STAGING_NEEDS_EXCLUSIVE_LOCK");
        assert!(left.exists(), "nothing was removed under a shared lock");
        drop(shared);
        let g = lock(&roots);
        assert_eq!(g.mode(), LockMode::Exclusive);
        assert_eq!(purge(&roots, &g, None).unwrap(), 1);
    }

    #[test]
    fn a_backups_folder_owned_or_readable_by_others_is_refused() {
        use crate::sys::{Ace, HandleInfo, PathAcl};
        let h = |owner: &str, sid: &str| HandleInfo {
            reparse: false,
            is_dir: true,
            owner: owner.into(),
            acl: PathAcl {
                protected: true,
                aces: vec![Ace {
                    allow: true,
                    flags: 3,
                    mask: 0x1f01ff,
                    sid: sid.into(),
                }],
            },
        };
        let p = Path::new("backups");
        assert!(trust_verdict(
            p,
            &h(crate::acl::SID_ADMINISTRATORS, crate::acl::SID_SYSTEM)
        )
        .is_ok());
        let e = trust_verdict(p, &h("S-1-5-21-1-2-3-1001", crate::acl::SID_SYSTEM)).unwrap_err();
        assert_eq!(e.reason, "STAGING_NOT_PRIVATE");
        // the operator is told how to fix it, and that the folder is left alone
        assert!(
            e.message.contains("icacls") && e.message.contains("inheritance:r"),
            "{}",
            e.message
        );
        let inherited = HandleInfo {
            reparse: false,
            is_dir: true,
            owner: crate::acl::SID_ADMINISTRATORS.into(),
            acl: PathAcl {
                protected: false,
                aces: vec![Ace {
                    allow: true,
                    flags: 0x12,
                    mask: 0x1f01ff,
                    sid: "S-1-5-21-1-2-3-504".into(),
                }],
            },
        };
        let e = trust_verdict(p, &inherited).unwrap_err();
        assert!(
            e.message.contains("inheritance is not protected") && e.message.contains("icacls"),
            "{}",
            e.message
        );
        assert_eq!(e.reason, "STAGING_NOT_PRIVATE");
        assert!(
            trust_verdict(p, &h(crate::acl::SID_SYSTEM, "S-1-5-32-545")).is_err(),
            "Users may read it"
        );
    }

    #[test]
    fn plan_never_calls_purge() {
        let src = include_str!("../commands/switch.rs");
        for name in ["fn plan_inner", "fn open(", "fn gather("] {
            let from = src.find(name).unwrap_or_else(|| panic!("{name}"));
            let body = &src[from..];
            let end = body[10..]
                .find("\nfn ")
                .into_iter()
                .chain(body[10..].find("\npub"))
                .min()
                .map(|i| i + 10)
                .unwrap_or(body.len());
            let b = &body[..end];
            assert!(!b.contains("purge("), "{name} must not delete anything");
            assert!(
                !b.contains("acquire") && !b.contains("LockGuard"),
                "{name} acquires no lock guard"
            );
        }
    }

    #[test]
    fn an_absent_backups_folder_is_created_by_the_shared_private_path_not_by_create_dir_all() {
        // dev roots only create the folder; the non-dev branch of make_private (create_dir_with_sddl + apply_one + read-back) is the
        // same function that makes the dump and pgpass folders, so the three can never differ (asserted in Sandbox scenario 21)
        let (_d, roots) = store();
        std::fs::remove_dir(roots.backups()).unwrap();
        let mut s = StagingDir::create(&roots).unwrap();
        let g = lock(&roots);
        let dump = s.ensure_dump(&roots, &g).unwrap().to_path_buf();
        assert!(roots.backups().is_dir() && dump.starts_with(roots.backups()));
        let src = include_str!("staging.rs");
        let body = &src[src.find("pub fn ensure_dump").unwrap()
            ..src.find("/// `None` until `ensure_dump` ran.").unwrap()];
        assert!(
            body.contains("make_private(&backups, roots)") && !body.contains("create_dir_all"),
            "{body}"
        );
    }
}
