//! The staff-password pepper travels with a backup (two-mode 11H, T15). `profiles.pin` holds a bcrypt hash and the Auth
//! password is derived from (id, PIN, pepper), so a snapshot restored on another PC signs nobody in unless it brings the
//! pepper it was made with. The staged folder carries the pepper as plain text (the stage is private and restic encrypts
//! the snapshot; a DPAPI-wrapped file would be unreadable on another PC) and the manifest carries its SHA-256 fingerprint.
//! Neither the value nor the fingerprint of a different pepper is ever put in an error.
use std::path::Path;

use super::rederive::read_pepper_at;
use super::result::{BResult, BackupError};
use super::util::write_atomic;
use crate::staff_password::acceptable_pepper;
use crate::util::Secret;

/// The name inside the staged folder (and in the snapshot).
pub const STAGE_FILE: &str = "staff-password-pepper.txt";

/// SHA-256 of the trimmed pepper, lower-case hex.
pub fn fingerprint(pepper: &str) -> String {
    crate::util::sha256_hex(pepper.trim().as_bytes())
}

/// Copies this machine's pepper into `stage` and returns its fingerprint for the manifest. A missing or weak pepper fails the
/// backup: a snapshot nobody could sign in to on another PC is worse than a visible failure.
pub fn put_in_stage(local: &Path, stage: &Path) -> BResult<String> {
    let p = read_pepper_at(local).map_err(|e| {
        BackupError::backup_failed(format!(
            "the backup cannot carry the staff password pepper: {}",
            e.message
        ))
    })?;
    write_atomic(&stage.join(STAGE_FILE), p.as_bytes())?;
    Ok(fingerprint(&p))
}

/// The pepper of a fetched stage whose manifest names fingerprint `fp`. The reason is a fixed text: nothing read from the file.
pub fn from_stage(dir: &Path, fp: &str) -> Result<Secret, &'static str> {
    let text = std::fs::read_to_string(dir.join(STAGE_FILE))
        .map_err(|_| "the backup names a staff password pepper but does not contain it")?;
    let p = text.trim().to_string();
    if !acceptable_pepper(&p) {
        return Err("the backup's staff password pepper is not usable");
    }
    if fingerprint(&p) != fp {
        return Err("the backup's staff password pepper does not match its manifest");
    }
    Ok(Secret(p))
}

/// Where the machine's own pepper is kept while another one is installed (`<pepper file>.prev`).
pub fn prev_path(pepper: &Path) -> std::path::PathBuf {
    let name = pepper
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    pepper.with_file_name(format!("{name}.prev"))
}

/// Recovery text of `PEPPER_PREV_PRESENT`: a restore or switch refuses to start while a kept pepper exists. Fixed text, no value.
pub const PREV_PRESENT_MESSAGE: &str = "a kept staff password pepper (the pepper file's `.prev` neighbour) from an earlier operation is present. `.prev` holds the pepper this machine had before that operation and the pepper file holds the one it installed. Decide which one the staff accounts were made with, keep it as the pepper file, delete `.prev`, then run the operation again";

/// Whether an earlier operation left its kept pepper behind. Nothing may delete or overwrite it automatically.
pub fn prev_present(pepper: &Path) -> bool {
    prev_path(pepper).exists()
}

/// Installs `theirs` as the machine's pepper, keeping the machine's own as `.prev` first. `Ok(false)`: it already is the pepper
/// (same PC), nothing is written. The caller re-renders the services' environment afterwards (`conf::activate`). The reasons are
/// fixed texts.
pub fn install(pepper: &Path, theirs: &str) -> Result<bool, &'static str> {
    let mine = read_pepper_at(pepper)
        .map_err(|_| "this machine's staff password pepper is missing or unusable")?;
    if fingerprint(&mine) == fingerprint(theirs) {
        return Ok(false);
    }
    if prev_present(pepper) {
        return Err("a kept staff password pepper from an earlier operation is present");
    }
    crate::util::write_secret_file(&prev_path(pepper), &mine)
        .map_err(|_| "the previous staff password pepper could not be kept")?;
    crate::util::write_secret_file(pepper, theirs.trim())
        .map_err(|_| "the staff password pepper could not be installed")?;
    Ok(true)
}

/// Puts the kept pepper back into the pepper file (`.prev` stays until `drop_previous`, so a failed reload can be refused).
/// `Ok(false)`: nothing was kept.
pub fn put_previous_back(pepper: &Path) -> Result<bool, &'static str> {
    let prev = prev_path(pepper);
    if !prev.exists() {
        return Ok(false);
    }
    let old = crate::util::read_secret_file(&prev)
        .map_err(|_| "the previous staff password pepper is unreadable")?;
    crate::util::write_secret_file(pepper, old.expose())
        .map_err(|_| "the previous staff password pepper could not be put back")?;
    Ok(true)
}

/// Drops the kept pepper (a commit, or a rollback that has re-rendered the services). Idempotent.
pub fn drop_previous(pepper: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(prev_path(pepper)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::util::fake::{rand_pepper, temp_ctx};

    #[test]
    fn the_stage_carries_the_local_pepper_as_plain_text_and_the_fingerprint_matches_it() {
        let (_d, c) = temp_ctx();
        let stage = c.paths.backups_tmp().join("s");
        std::fs::create_dir_all(&stage).unwrap();
        let fp = put_in_stage(&c.paths.pepper(), &stage).unwrap();
        let local = crate::util::read_secret_file(&c.paths.pepper()).unwrap();
        assert_eq!(
            std::fs::read_to_string(stage.join(STAGE_FILE)).unwrap(),
            local.expose(),
            "a snapshot must be readable on another PC: no DPAPI wrap"
        );
        assert_eq!(fp, fingerprint(local.expose()));
        assert_eq!(from_stage(&stage, &fp).unwrap(), local);
    }

    #[test]
    fn a_missing_or_weak_local_pepper_fails_the_backup_without_echoing_it() {
        let (_d, c) = temp_ctx();
        let stage = c.paths.backups_tmp().join("s");
        std::fs::create_dir_all(&stage).unwrap();
        crate::util::write_secret_file(&c.paths.pepper(), "q9q9q9").unwrap();
        let e = put_in_stage(&c.paths.pepper(), &stage).unwrap_err();
        assert!(!e.message.contains("q9q9q9"), "{}", e.message);
        std::fs::remove_file(c.paths.pepper()).unwrap();
        assert!(put_in_stage(&c.paths.pepper(), &stage).is_err());
        assert!(!stage.join(STAGE_FILE).exists());
    }

    #[test]
    fn a_stage_without_the_pepper_or_with_another_one_is_refused_with_a_fixed_text() {
        let dir = tempfile::tempdir().unwrap();
        let (mine, other) = (rand_pepper(), rand_pepper());
        assert!(
            from_stage(dir.path(), &fingerprint(&mine)).is_err(),
            "no file"
        );
        std::fs::write(dir.path().join(STAGE_FILE), &other).unwrap();
        let why = from_stage(dir.path(), &fingerprint(&mine)).unwrap_err();
        assert!(!why.contains(&other) && !why.contains(&fingerprint(&other)));
        std::fs::write(dir.path().join(STAGE_FILE), "short").unwrap();
        assert!(
            from_stage(dir.path(), &fingerprint("short")).is_err(),
            "a weak pepper is unusable even with a matching fingerprint"
        );
    }
    #[test]
    fn install_keeps_the_machines_own_pepper_and_a_rollback_puts_it_back() {
        let (_d, c) = temp_ctx();
        let path = c.paths.pepper();
        let (mine, theirs) = (crate::util::read_secret_file(&path).unwrap(), rand_pepper());
        assert_eq!(install(&path, &theirs), Ok(true));
        assert_eq!(
            crate::util::read_secret_file(&path).unwrap().expose(),
            theirs
        );
        assert_eq!(
            crate::util::read_secret_file(&prev_path(&path)).unwrap(),
            mine
        );
        assert_eq!(put_previous_back(&path), Ok(true));
        assert_eq!(crate::util::read_secret_file(&path).unwrap(), mine);
        assert!(
            prev_path(&path).exists(),
            "kept until the services have been re-rendered"
        );
        drop_previous(&path).unwrap();
        drop_previous(&path).unwrap();
        assert_eq!(put_previous_back(&path), Ok(false));
        // the same pepper (same PC): nothing is written
        assert_eq!(install(&path, mine.expose()), Ok(false));
        assert!(!prev_path(&path).exists());
    }

    #[test]
    fn install_never_overwrites_a_kept_pepper() {
        let (_d, c) = temp_ctx();
        let path = c.paths.pepper();
        crate::util::write_secret_file(&prev_path(&path), &rand_pepper()).unwrap();
        let kept = std::fs::read(prev_path(&path)).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(install(&path, &rand_pepper()).is_err());
        assert_eq!(std::fs::read(prev_path(&path)).unwrap(), kept);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
