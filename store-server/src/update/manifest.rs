//! The parts of Plan 04's manifest.json the updater reads. (Plan 05's `pack::Manifest` is only the header it needs and has
//! no `components` or `catalog`; this one is a superset read from the same file, so the two never disagree on a field.)
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct MigrationsInfo { pub count: u32, pub max: String }
#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry { pub path: String, pub sha256: String, pub size: u64 }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataChangeKind { Delete, Drop }
/// A change the release makes on purpose to existing data; growth (inserts, backfills) needs no declaration.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DataChange { pub table: String, pub kind: DataChangeKind }

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogInfo { pub digest: String }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub pack_version: String,
    pub app_version: String,
    pub platform: String,
    pub migrations: MigrationsInfo,
    #[serde(default)]
    pub components: BTreeMap<String, serde_json::Value>,
    pub files: Vec<FileEntry>,
    /// Expected digest of the catalog after all migrations (Proposed convention addition B). A pack without one cannot be updated to.
    #[serde(default)]
    pub catalog: Option<CatalogInfo>,
    /// Optional: the newest version in GoTrue's own `auth.schema_migrations` that this pack's GoTrue build applies
    /// (Plan 04 does not emit it yet; when present the clone must be exactly there).
    #[serde(default)]
    pub gotrue_migrations_max: Option<String>,
    /// Tables the release deletes from or drops on purpose (`delete` also covers a truncate). Anything else that loses rows is refused.
    #[serde(default)]
    pub data_changes: Vec<DataChange>,
}

/// GoTrue's own migrations only matter when the GoTrue build changed (02/04 are re-run on every update regardless).
pub fn needs_auth_migrate(from: &Manifest, to: &Manifest) -> bool { from.component("gotrue") != to.component("gotrue") }

/// What the GoTrue step does, decided from the labels AND the live database's own `auth.schema_migrations` level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthPlan { Skip, Migrate, Refuse(String) }

/// `live` is the `count|max` string `auth_level` reads. A pack that declares `gotrueMigrationsMax` is migrated to whenever the label
/// changed OR the live level trails it (compared numerically, they are 14-digit versions); a live level ABOVE it is refused, never
/// migrated down. A pack that declares nothing keeps the label-only rule.
pub fn auth_plan(from: &Manifest, to: &Manifest, live: &str) -> AuthPlan {
    let label_changed = needs_auth_migrate(from, to);
    let Some(want) = to.gotrue_migrations_max.as_deref() else { return if label_changed { AuthPlan::Migrate } else { AuthPlan::Skip } };
    let live_max = live.split_once('|').map(|(_, m)| m).unwrap_or("");
    // an empty auth.schema_migrations is level 0; anything else unreadable falls back to the label rule
    let level = |v: &str| if v.is_empty() { Some(0u64) } else { v.parse::<u64>().ok() };
    match (level(live_max), level(want)) {
        (Some(l), Some(w)) if l > w => AuthPlan::Refuse(format!("the live auth.schema_migrations is at {live_max}, newer than the pack's {want}; GoTrue is never migrated down")),
        (Some(l), Some(w)) if l < w => AuthPlan::Migrate,
        _ if label_changed => AuthPlan::Migrate,
        _ => AuthPlan::Skip,
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// "1.11.0-r2" -> (1, 11, 0, 2). Plan 04 restricts appVersion to MAJOR.MINOR.PATCH.
pub fn pack_version_key(v: &str) -> Option<(u32, u32, u32, u32)> {
    let (app, rev) = v.rsplit_once("-r")?;
    let mut p = app.split('.');
    let (a, b, c) = (p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?);
    if p.next().is_some() { return None; }
    Some((a, b, c, rev.parse().ok()?))
}

impl Manifest {
    /// Parsed only from bytes whose minisign signature verifies for the updater key (the same key and check as
    /// `pack::load`), on the normal path and on recovery alike: `verify_files` then trusts the hashes in it.
    pub fn read(pack_dir: &Path) -> R<Manifest> { Self::read_with_key(pack_dir, crate::pack::trust_key().as_deref()) }
    pub fn read_with_key(pack_dir: &Path, key: Option<&str>) -> R<Manifest> {
        let bytes = std::fs::read(pack_dir.join("manifest.json")).map_err(|e| OpError::new(OpCode::PackInvalid, "MANIFEST_UNREADABLE", e.to_string()))?;
        if let Some(k) = key {
            let sig = std::fs::read_to_string(pack_dir.join("manifest.json.minisig"))
                .map_err(|_| OpError::new(OpCode::PackInvalid, "MANIFEST_UNSIGNED", "the pack is not signed (manifest.json.minisig is missing)"))?;
            crate::packcmd::verify_signature(&bytes, &sig, k).map_err(|e| OpError::new(OpCode::PackInvalid, "MANIFEST_SIGNATURE", e))?;
        }
        let text = String::from_utf8(bytes).map_err(|_| OpError::new(OpCode::PackInvalid, "MANIFEST_INVALID", "manifest.json is not UTF-8"))?;
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| OpError::new(OpCode::PackInvalid, "MANIFEST_INVALID", e.to_string()))
    }
    pub fn component(&self, name: &str) -> Option<String> {
        self.components.get(name).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
    }
    pub fn pg_major(&self) -> Option<u32> { self.component("postgres")?.split('.').next()?.parse().ok() }
    #[cfg(test)]
    pub fn for_test(pv: &str, av: &str, count: u32, max: &str) -> Manifest {
        Manifest { pack_version: pv.into(), app_version: av.into(), platform: "win-x64".into(),
            migrations: MigrationsInfo { count, max: max.into() }, components: BTreeMap::new(), files: vec![], catalog: None, gotrue_migrations_max: None, data_changes: vec![] }
    }
    #[cfg(test)]
    pub fn set_component(&mut self, k: &str, v: &str) { self.components.insert(k.into(), serde_json::Value::String(v.into())); }
    #[cfg(test)]
    pub fn add_file(&mut self, p: &str, h: &str) { self.files.push(FileEntry { path: p.into(), sha256: h.into(), size: 0 }); }
}

/// Re-hash the files the updater is about to EXECUTE (migrations, pack SQL, the CLI) against the manifest.
pub fn verify_files(pack_dir: &Path, m: &Manifest, prefixes: &[&str]) -> R<()> {
    for f in m.files.iter().filter(|f| prefixes.iter().any(|p| f.path.starts_with(p))) {
        let bytes = std::fs::read(pack_dir.join(&f.path))
            .map_err(|e| OpError::new(OpCode::PackInvalid, "PACK_FILE_MISSING", format!("{}: {e}", f.path)))?;
        if hex(&Sha256::digest(&bytes)) != f.sha256.to_lowercase() {
            return Err(OpError::new(OpCode::PackInvalid, "PACK_FILE_CHANGED", format!("{} does not match the signed manifest", f.path)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pack_versions_order_by_app_version_then_revision() {
        let k = |s| pack_version_key(s).unwrap();
        assert!(k("1.11.0-r2") > k("1.11.0-r1"));
        assert!(k("1.12.0-r1") > k("1.11.9-r7"));
        assert!(k("1.9.0-r1") < k("1.10.0-r1"), "numeric, not lexicographic");
        assert_eq!(pack_version_key("1.11.0"), None);
        assert_eq!(pack_version_key("v1.11.0-r1"), None);
    }
    #[test]
    fn a_manifest_parses_and_reports_components() {
        let m: Manifest = serde_json::from_str(r#"{"schema":1,"packVersion":"1.11.0-r1","appVersion":"1.11.0","platform":"win-x64",
          "migrations":{"count":236,"max":"20260929000008"},"components":{"postgres":"17.10","gotrue":"2.196.0"},
          "files":[{"path":"sql/01-pre-gotrue.sql","sha256":"aa","size":3}]}"#).unwrap();
        assert_eq!((m.pg_major(), m.component("gotrue").as_deref()), (Some(17), Some("2.196.0")));
        assert!(m.catalog.is_none());
    }
    #[test]
    fn verify_files_catches_a_changed_migration() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("migrations")).unwrap();
        std::fs::write(d.path().join("migrations/1_a.sql"), "select 1;").unwrap();
        let good = hex(&sha2::Sha256::digest(b"select 1;"));
        let mk = |h: &str| Manifest { files: vec![FileEntry { path: "migrations/1_a.sql".into(), sha256: h.into(), size: 9 }], ..Manifest::for_test("1.0.0-r1", "1.0.0", 1, "1") };
        verify_files(d.path(), &mk(&good), &["migrations/"]).unwrap();
        assert_eq!(verify_files(d.path(), &mk("00"), &["migrations/"]).unwrap_err().code, OpCode::PackInvalid);
    }

    #[test]
    fn a_manifest_whose_signature_no_longer_matches_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let roots = crate::packcmd::fixtures::signed_root(&d, true);
        let dir = roots.pack_dir("1.0.0-r1").unwrap();
        let ok = Manifest::read(&dir);
        let mp = dir.join("manifest.json");
        let text = std::fs::read_to_string(&mp).unwrap();
        assert!(text.contains("win-x64"));
        std::fs::write(&mp, text.replace("win-x64", "win-x65")).unwrap();
        let tampered = Manifest::read(&dir);
        crate::pack::set_test_key(None);
        ok.unwrap();
        assert_eq!(tampered.unwrap_err().code, OpCode::PackInvalid, "unsigned bytes must never be parsed");
    }
}
