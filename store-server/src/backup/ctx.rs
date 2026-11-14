//! Everything a backup operation needs to know about this machine, built once by the dispatcher.
use std::path::PathBuf;

use super::paths::BackupPaths;
use crate::paths::Roots;
use crate::ports::Ports;

#[derive(Clone, Debug)]
pub struct BackupCtx {
    pub paths: BackupPaths,
    /// `%ProgramFiles%\SupermarketPOS\packs\<current>\` (contains `bin\restic.exe`, `pg\bin\`, `tools\`, `migrations\`).
    pub pack_dir: PathBuf,
    pub ports: Ports,
    /// Private on purpose: it is the `Roots` flag and nothing else (a settable bool would let any caller switch the
    /// private-folder checks off). Read it with `is_dev()`.
    dev: bool,
    pub pack_version: String,
    pub posctl_version: String,
}

impl BackupCtx {
    /// The only constructor: `--dev` is whatever the roots say.
    pub fn new(roots: &Roots, pack_dir: PathBuf, ports: Ports, pack_version: String, posctl_version: String) -> Self {
        Self { paths: BackupPaths::from_roots(roots), pack_dir, ports, dev: roots.dev, pack_version, posctl_version }
    }
    /// `--dev` (non-default roots): the private-folder ACL checks are skipped.
    pub fn is_dev(&self) -> bool { self.dev }
    pub fn restic_exe(&self) -> PathBuf { self.pack_dir.join("bin").join("restic.exe") }
    pub fn pg_exe(&self, name: &str) -> PathBuf { self.pack_dir.join("pg").join("bin").join(name) }
    pub fn supabase_exe(&self) -> PathBuf { self.pack_dir.join("tools").join("supabase.exe") }
    pub fn pg_port(&self) -> u16 { self.ports.pg() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(roots: &Roots) -> BackupCtx {
        BackupCtx::new(roots, PathBuf::from(r"C:\pack"), Ports::new(47300).unwrap(), "t".into(), "t".into())
    }

    #[test]
    fn dev_comes_from_the_roots_and_nowhere_else() {
        let dev_roots = Roots::custom(PathBuf::from(r"C:\d"), PathBuf::from(r"C:\p"));
        assert!(make(&dev_roots).is_dev());
        let production = Roots { dev: false, ..dev_roots };
        assert!(!make(&production).is_dev(), "production roots must never produce a dev context");
    }
}
