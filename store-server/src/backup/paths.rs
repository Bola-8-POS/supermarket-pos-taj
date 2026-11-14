//! Folder layout under the data root (conventions 2.2) and restic's spelling of a Windows path.
//! The entries Plan 05 already names come from `Roots`; only backup's own paths are spelled here.
use std::path::{Path, PathBuf};

use crate::paths::Roots;

#[derive(Clone, Debug)]
pub struct BackupPaths {
    roots: Roots,
}

impl BackupPaths {
    pub fn from_roots(roots: &Roots) -> Self {
        Self { roots: roots.clone() }
    }
    pub fn roots(&self) -> &Roots { &self.roots }
    pub fn data(&self) -> &Path { &self.roots.data }
    // shared with Plan 05/07: one spelling, in `Roots`
    pub fn conf_file(&self) -> PathBuf { self.roots.posctl_json() }
    pub fn state_dir(&self) -> PathBuf { self.roots.state() }
    pub fn update_lock(&self) -> PathBuf { self.roots.update_lock() }
    pub fn secrets(&self) -> PathBuf { self.roots.secrets() }
    pub fn pgpass_admin(&self) -> PathBuf { self.roots.pgpass() }
    pub fn photos(&self) -> PathBuf { self.roots.photos() }
    pub fn backups(&self) -> PathBuf { self.roots.backups() }
    pub fn work(&self) -> PathBuf { self.roots.work() }
    // backup's own
    pub fn state_file(&self) -> PathBuf { self.state_dir().join("backup.json") }
    pub fn machine_key(&self) -> PathBuf { self.secrets().join("restic-password.txt") }
    pub fn pgpass_backup(&self) -> PathBuf { self.secrets().join("pgpass-backup.conf") }
    pub fn pos_backup_pw(&self) -> PathBuf { self.secrets().join("pg-pos_backup.pw") }
    pub fn r2_env(&self) -> PathBuf { self.secrets().join("r2.env") }
    pub fn pepper(&self) -> PathBuf { self.secrets().join("staff-password-pepper.txt") }
    pub fn repo(&self) -> PathBuf { self.backups().join("repo") }
    pub fn stage(&self) -> PathBuf { self.backups().join("stage").join("current") }
    pub fn cache(&self) -> PathBuf { self.backups().join("cache") }
    /// `backups\tmp` (not `Roots::tmp`, which is `data\tmp`).
    pub fn backups_tmp(&self) -> PathBuf { self.backups().join("tmp") }
    /// Any code that creates this folder must use `create_private_dir`: the backup sweep refuses to run while it is not private.
    pub fn restore_root(&self) -> PathBuf { self.backups().join("restore") }
    pub fn backup_lock(&self) -> PathBuf { self.backups().join("backup.lock") }
}

/// restic stores `C:\ProgramData\x` as `/C/ProgramData/x`.
pub fn restic_path(p: &Path) -> String {
    let p = crate::provision::strip_verbatim(p.to_path_buf());
    let s = p.to_string_lossy().replace('\\', "/");
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        format!("/{}{}", (b[0] as char).to_ascii_uppercase(), &s[2..])
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restic_path_uses_the_drive_letter_form() {
        assert_eq!(
            restic_path(Path::new(r"C:\ProgramData\SupermarketPOS\backups\stage\current")),
            "/C/ProgramData/SupermarketPOS/backups/stage/current"
        );
        assert_eq!(restic_path(Path::new(r"d:\x")), "/D/x");
    }

    #[test]
    fn restic_path_strips_the_verbatim_prefix() {
        assert_eq!(restic_path(Path::new(r"\\?\C:\ProgramData\x")), "/C/ProgramData/x");
    }

    fn roots() -> Roots {
        Roots::custom(PathBuf::from(r"C:\ProgramData\SupermarketPOS"), PathBuf::from(r"C:\Program Files\SupermarketPOS"))
    }

    #[test]
    fn layout_matches_the_conventions() {
        let p = BackupPaths::from_roots(&roots());
        assert!(p.machine_key().ends_with(r"secrets\restic-password.txt"));
        assert!(p.stage().ends_with(r"backups\stage\current"));
        assert!(p.update_lock().ends_with(r"state\update\update.lock"));
        assert!(p.photos().ends_with("photos"));
    }

    #[test]
    fn shared_entries_are_the_roots_entries_not_a_second_spelling() {
        let r = roots();
        let p = BackupPaths::from_roots(&r);
        assert_eq!(p.conf_file(), r.posctl_json());
        assert_eq!(p.state_dir(), r.state());
        assert_eq!(p.update_lock(), r.update_lock());
        assert_eq!(p.secrets(), r.secrets());
        assert_eq!(p.pgpass_admin(), r.pgpass());
        assert_eq!(p.photos(), r.photos());
        assert_eq!(p.backups(), r.backups());
        assert_eq!(p.work(), r.work());
        // backup's own scratch folder is not Roots::tmp (data\tmp)
        assert_ne!(p.backups_tmp(), r.tmp());
        assert!(p.backups_tmp().ends_with(r"backups\tmp"));
    }
}
