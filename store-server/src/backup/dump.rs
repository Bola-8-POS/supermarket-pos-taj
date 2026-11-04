//! pg_dump / pg_dumpall argument builders and the manifest stored inside every snapshot.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::fingerprint::TableFp;
use super::pg::PgConn;
use super::util::{sha256_file, write_atomic};

pub const DUMP_FILE: &str = "pos.dump";
pub const GLOBALS_FILE: &str = "globals.sql";
pub const MANIFEST_FILE: &str = "backup-manifest.json";

pub fn pg_dump_args(conn: &PgConn, snapshot: &str, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-h", &conn.host, "-p", &conn.port.to_string(), "-U", &conn.user, "-w", "-Fc", "-Z0", "--lock-wait-timeout=30s", "--snapshot", snapshot, "-f"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    a.push(out.to_string_lossy().into_owned());
    a.push(conn.db.clone());
    a
}

pub fn pg_dumpall_args(conn: &PgConn, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-h", &conn.host, "-p", &conn.port.to_string(), "-U", &conn.user, "-w", "--globals-only", "--no-role-passwords", "-f"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    a.push(out.to_string_lossy().into_owned());
    a
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbInfo {
    pub name: String,
    pub owner: String,
    pub encoding: String,
    pub provider: String,
    pub locale: String,
    pub collate: String,
    pub ctype: String,
    pub collversion: String,
    pub bytes: i64,
    pub settings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Manifest {
    pub schema: u32,
    pub taken_at: i64,
    pub reason: String,
    pub posctl_version: String,
    pub pack_version: String,
    pub pg_dump_version: String,
    pub database: DbInfo,
    pub migrations_count: i64,
    pub migrations_max: String,
    pub caja_max_closed_at: i64,
    pub files: Vec<FileEntry>,
    pub tables: Vec<TableFp>,
    pub catalog: BTreeMap<String, String>,
    /// Staged folder and photos folder as restic spells them (`/C/...`).
    pub stage_subpath: String,
    pub photos_subpath: Option<String>,
}

pub fn file_entries(dir: &Path) -> std::io::Result<Vec<FileEntry>> {
    [DUMP_FILE, GLOBALS_FILE]
        .iter()
        .map(|n| {
            let p = dir.join(n);
            Ok(FileEntry { name: (*n).to_string(), bytes: std::fs::metadata(&p)?.len(), sha256: sha256_file(&p)? })
        })
        .collect()
}

pub fn write_manifest(dir: &Path, m: &Manifest) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(m).map_err(std::io::Error::other)?;
    write_atomic(&dir.join(MANIFEST_FILE), text.as_bytes())
}

pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_FILE)).map_err(|e| format!("backup-manifest.json unreadable: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("backup-manifest.json is invalid: {e}"))
}

/// Re-hash the files named in the manifest; the error names the first file that differs. The manifest is read
/// from a snapshot, so it is not trusted: its file list must be exactly the dump and the globals (an exact name
/// match also refuses any separator, `..`, drive or absolute prefix), and both size and checksum must agree.
pub fn verify_files(dir: &Path, m: &Manifest) -> Result<(), String> {
    let mut names: Vec<&str> = m.files.iter().map(|f| f.name.as_str()).collect();
    names.sort_unstable();
    let mut want = [DUMP_FILE, GLOBALS_FILE];
    want.sort_unstable();
    if names != want {
        return Err(format!("the manifest must list exactly {DUMP_FILE} and {GLOBALS_FILE}"));
    }
    for f in &m.files {
        let p = dir.join(&f.name);
        let len = std::fs::metadata(&p).map_err(|e| format!("{} unreadable: {e}", f.name))?.len();
        if len != f.bytes {
            return Err(format!("{} does not match its recorded size", f.name));
        }
        let h = sha256_file(&p).map_err(|e| format!("{} unreadable: {e}", f.name))?;
        if h != f.sha256 {
            return Err(format!("{} does not match its recorded checksum", f.name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::pg::PgConn;
    use std::path::Path;

    fn conn() -> PgConn {
        PgConn { host: "127.0.0.1".into(), port: 47300, user: "pos_backup".into(), db: "postgres".into(), passfile: None }
    }

    #[test]
    fn pg_dump_uses_the_exported_snapshot_custom_format_and_no_compression() {
        let a = pg_dump_args(&conn(), "00000003-0000001B-1", Path::new(r"C:\s\pos.dump.partial"));
        let j = a.join(" ");
        assert!(j.contains("-Fc") && j.contains("-Z0"), "S7: default compression barely dedups");
        assert!(j.contains("--snapshot 00000003-0000001B-1"));
        assert!(j.contains("--lock-wait-timeout=30s"));
        assert!(j.ends_with("postgres"));
    }

    #[test]
    fn globals_never_contain_role_passwords() {
        let j = pg_dumpall_args(&conn(), Path::new(r"C:\s\globals.sql")).join(" ");
        assert!(j.contains("--globals-only") && j.contains("--no-role-passwords"));
    }

    #[test]
    fn the_manifest_round_trips_and_detects_a_tampered_file() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(DUMP_FILE), b"dump bytes").unwrap();
        std::fs::write(d.path().join(GLOBALS_FILE), b"globals").unwrap();
        let files = file_entries(d.path()).unwrap();
        assert_eq!(files.len(), 2);
        let m = Manifest { schema: 1, taken_at: 5, reason: "manual".into(), files, ..Manifest::default() };
        write_manifest(d.path(), &m).unwrap();
        let back = read_manifest(d.path()).unwrap();
        assert_eq!(back.reason, "manual");
        verify_files(d.path(), &back).unwrap();
        std::fs::write(d.path().join(DUMP_FILE), b"dump bytez").unwrap();
        assert!(verify_files(d.path(), &back).unwrap_err().contains(DUMP_FILE));
    }

    fn staged(d: &Path) -> Manifest {
        std::fs::write(d.join(DUMP_FILE), b"dump bytes").unwrap();
        std::fs::write(d.join(GLOBALS_FILE), b"globals").unwrap();
        Manifest { schema: 1, files: file_entries(d).unwrap(), ..Manifest::default() }
    }

    fn refused(m: &Manifest, d: &Path) -> String {
        verify_files(d, m).unwrap_err()
    }

    #[test]
    fn an_empty_file_list_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files.clear();
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn a_missing_name_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files.retain(|f| f.name != GLOBALS_FILE);
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn an_extra_name_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        std::fs::write(d.path().join("extra.txt"), b"x").unwrap();
        m.files.push(FileEntry { name: "extra.txt".into(), bytes: 1, sha256: sha256_file(&d.path().join("extra.txt")).unwrap() });
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn a_duplicated_name_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files[1] = m.files[0].clone();
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn a_name_with_a_path_separator_is_refused_even_when_the_file_exists() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        std::fs::create_dir(d.path().join("sub")).unwrap();
        std::fs::copy(d.path().join(DUMP_FILE), d.path().join("sub").join(DUMP_FILE)).unwrap();
        m.files[0].name = format!("sub{}{}", std::path::MAIN_SEPARATOR, DUMP_FILE);
        assert!(refused(&m, d.path()).contains("manifest"));
        m.files[0].name = format!("sub/{DUMP_FILE}");
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn a_dot_dot_name_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files[0].name = format!("../{DUMP_FILE}");
        assert!(refused(&m, d.path()).contains("manifest"));
    }

    #[test]
    fn a_drive_or_absolute_name_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files[0].name = d.path().join(DUMP_FILE).to_string_lossy().into_owned();
        assert!(refused(&m, d.path()).contains("manifest"), "absolute path");
        m.files[0].name = format!("C:{}x", std::path::MAIN_SEPARATOR);
        assert!(refused(&m, d.path()).contains("manifest"), "drive prefix");
    }

    #[test]
    fn a_recorded_size_that_does_not_match_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let mut m = staged(d.path());
        m.files[0].bytes += 1;
        let e = refused(&m, d.path());
        assert!(e.contains(&m.files[0].name) && e.contains("size"), "{e}");
    }
}
