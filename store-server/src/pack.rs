//! The installed backend pack (conventions section 10), as far as Plan 05 needs it: locate the
//! unpacked pack directory, read its manifest, check the required files exist. It must never
//! trust a path or a version string from outside (separators and `..` are refused). Plan 05b adds
//! `fetch`, `verify` (signature and every file hash) and `install` behind `pack::source()`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Only the header Plan 05 needs; the real manifest has more fields (components, builtAt, ...) and
/// this struct is deliberately lenient about them (Plan 05b verifies the whole file by signature).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub pack_version: String,
    pub app_version: String,
    pub platform: String,
    pub migrations: MigrationsInfo,
    /// Every file of the pack except `manifest.json` and its signature (conventions section 10).
    #[serde(default)]
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct MigrationsInfo {
    pub count: u32,
    pub max: String,
}

/// A zip entry name or a pack-relative path as a safe relative path (`/` or `\` separated). Rejects
/// absolute paths, drive letters, `..`, empty names and alternate data streams.
pub fn safe_entry_path(name: &str) -> Result<PathBuf, String> {
    let n = name.replace('\\', "/");
    if n.is_empty() || n.starts_with('/') || n.contains(':') {
        return Err(format!("unsafe path in the pack: '{name}'"));
    }
    let mut out = PathBuf::new();
    for part in n.split('/').filter(|p| !p.is_empty()) {
        if part == ".." || part == "." || windows_hostile(part) {
            return Err(format!("unsafe path in the pack: '{name}'"));
        }
        out.push(part);
    }
    if out.components().any(|c| !matches!(c, std::path::Component::Normal(_))) || out.as_os_str().is_empty() {
        return Err(format!("unsafe path in the pack: '{name}'"));
    }
    Ok(out)
}

/// A path component Windows would reinterpret: a trailing dot or space (silently dropped, so `a.` IS `a`), a device name
/// (`CON`, `NUL.txt`, `COM1`, ...), a control character or one of `<>"|?*`.
fn windows_hostile(part: &str) -> bool {
    if part.ends_with('.') || part.ends_with(' ') || part.chars().any(|c| c < ' ' || c == '\u{7f}' || "<>\"|?*".contains(c)) {
        return true;
    }
    let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}

/// Manifest paths must be unique ignoring case and separator spelling: NTFS would map two spellings onto one file.
pub fn check_unique_paths(files: &[FileEntry]) -> Result<(), String> {
    let mut seen: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
    for fe in files {
        let key = fe.path.replace('\\', "/").to_ascii_lowercase();
        if let Some(first) = seen.insert(key, fe.path.as_str()) {
            return Err(if first == fe.path { format!("the manifest lists {} twice", fe.path) } else { format!("the manifest lists {first} and {}, which differ only in case or separators", fe.path) });
        }
    }
    Ok(())
}

/// Files a provision cannot proceed without (conventions 10 layout; `03c` is Plan 04b's).
pub const REQUIRED_FILES: [&str; 20] = [
    "manifest.json",
    "bin\\auth.exe",
    "bin\\postgrest.exe",
    "bin\\caddy.exe",
    "bin\\functions.exe",
    "bin\\shawl.exe",
    "pg\\bin\\postgres.exe",
    "pg\\bin\\initdb.exe",
    "pg\\bin\\psql.exe",
    "pg\\bin\\pg_isready.exe",
    "tools\\supabase.exe",
    "sql\\run-order.json",
    "sql\\01-pre-gotrue.sql",
    "sql\\02-shim-after-gotrue.sql",
    "sql\\03-owner-role.sql",
    "sql\\03b-storage.sql",
    "sql\\03c-database-grants.sql",
    "sql\\04-nonsuper-fixups.sql",
    "sql\\20-pos-lockout-hook.sql",
    "sql\\30-store-schema-version.sql",
];

#[derive(Debug, Clone)]
pub struct Pack {
    pub dir: PathBuf,
    pub manifest: Manifest,
}

/// The key `load` and `latest_installed` verify with: the embedded updater key (or the test-hook key).
/// `None` only in this crate's own unit tests, whose fake packs are unsigned; the verification itself
/// is exercised through `load_with_key` / `latest_installed_with`.
pub(crate) fn trust_key() -> Option<String> {
    #[cfg(test)]
    {
        TEST_KEY.with(|k| k.borrow().clone())
    }
    #[cfg(not(test))]
    {
        Some(crate::packcmd::updater_pubkey())
    }
}

#[cfg(test)]
thread_local! {
    static TEST_KEY: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Unit tests only: make `load`, `load_light` and `latest_installed` verify with `key` on this thread (the default is
/// "unsigned fake packs load"). Lets lifecycle and status tests run the real verification against the signed fixture.
#[cfg(test)]
pub(crate) fn set_test_key(key: Option<&str>) {
    TEST_KEY.with(|k| *k.borrow_mut() = key.map(str::to_string));
}

/// How much of an installed pack is checked on load.
/// `Full`: signature, every listed file's size AND SHA-256, nothing unlisted, no reparse point. For every operation that is
/// about to RUN something from the pack (install/activate, verify, provision, update, start).
/// `Light`: signature, structure, every listed file's size (a stat, no read), nothing unlisted, no reparse point. For the
/// read-mostly commands that run every minute (status, health, version): hashing 250 MB each minute is not affordable.
/// A same-size byte flip passes `Light` by design; the next `Full` load (any start) catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Full,
    Light,
}

/// An installed pack, VERIFIED: the manifest signature must be valid for the updater key, every listed file must
/// match its size and SHA-256, and nothing unlisted may sit in the folder. A pack edited on disk is not loaded.
pub fn load(dir: &Path) -> Result<Pack, String> {
    load_checked(dir, trust_key().as_deref(), Tier::Full)
}

/// `load` at the `Light` tier (status, health, version).
pub fn load_light(dir: &Path) -> Result<Pack, String> {
    load_checked(dir, trust_key().as_deref(), Tier::Light)
}

/// `load` against an explicit key (install, tests).
pub fn load_with_key(dir: &Path, pubkey: &str) -> Result<Pack, String> {
    load_checked(dir, Some(pubkey), Tier::Full)
}

pub fn load_light_with_key(dir: &Path, pubkey: &str) -> Result<Pack, String> {
    load_checked(dir, Some(pubkey), Tier::Light)
}

/// Structure only (required files, schema, platform); NO signature or hash check. Only for a folder whose
/// every byte `packcmd::process_zip` has just verified while extracting it.
pub(crate) fn load_unverified(dir: &Path) -> Result<Pack, String> {
    load_checked(dir, None, Tier::Full)
}

fn load_checked(dir: &Path, key: Option<&str>, tier: Tier) -> Result<Pack, String> {
    let bytes = std::fs::read(dir.join("manifest.json")).map_err(|e| format!("{}: cannot read manifest.json: {e}", dir.display()))?;
    if let Some(k) = key {
        let sig = std::fs::read_to_string(dir.join("manifest.json.minisig")).map_err(|_| "the pack is not signed (manifest.json.minisig is missing)".to_string())?;
        crate::packcmd::verify_signature(&bytes, &sig, k)?;
    }
    let text = String::from_utf8(bytes).map_err(|_| "manifest.json is not UTF-8".to_string())?;
    let manifest: Manifest = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("manifest.json is not valid: {e}"))?;
    if manifest.schema != 1 {
        return Err(format!("manifest schema {} is not supported", manifest.schema));
    }
    if manifest.platform != "win-x64" {
        return Err(format!("the pack is for {}, not win-x64", manifest.platform));
    }
    let missing: Vec<&str> = REQUIRED_FILES.iter().copied().filter(|f| !dir.join(f).is_file()).collect();
    if !missing.is_empty() {
        return Err(format!("the pack is missing: {}", missing.join(", ")));
    }
    if !dir.join("migrations").is_dir() {
        return Err("the pack has no migrations folder".into());
    }
    if key.is_some() {
        verify_files(dir, &manifest, tier)?;
    }
    Ok(Pack { dir: dir.to_path_buf(), manifest })
}

pub(crate) fn is_reparse(md: &std::fs::Metadata) -> bool {
    if md.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        md.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT: junctions and mount points too
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The files `copy-extension-stubs` steps put in the pack: `pg/share/extension/<n>` (folder from the run-order's `to`, name
/// from the file) mapped to the listed `sql/stub-extensions/<n>` entry it must equal. Read from the pack's own run-order.
fn stub_copies<'a>(dir: &Path, listed: &std::collections::HashMap<String, &'a FileEntry>) -> Result<std::collections::HashMap<String, &'a FileEntry>, String> {
    let text = std::fs::read_to_string(dir.join("sql").join("run-order.json")).map_err(|e| format!("cannot read sql\\run-order.json: {e}"))?;
    let order = crate::runorder::parse(&text)?;
    let mut out = std::collections::HashMap::new();
    for step in &order.steps {
        if let crate::runorder::Step::CopyExtensionStubs { files, to, .. } = step {
            let to = safe_entry_path(to)?.to_string_lossy().replace('\\', "/");
            for f in files {
                let src = safe_entry_path(f)?.to_string_lossy().replace('\\', "/");
                let Some(entry) = listed.get(&src) else { return Err(format!("the run-order copies {f}, which the signed manifest does not list")) };
                let name = src.rsplit('/').next().unwrap_or("");
                out.insert(format!("{to}/{name}"), *entry);
            }
        }
    }
    Ok(out)
}

/// Every listed file matches its size (and, at `Full`, its SHA-256), no reparse point anywhere, no unlisted file. The ONLY
/// unlisted files allowed are the temporary copies a provision makes of the pack's own stub extensions: each must have
/// exactly the size (and at `Full` the hash) of the listed `sql/stub-extensions/<n>` it was copied from, in the folder the
/// run-order names (`copy-extension-stubs`), so nothing unhashed can sit where the database loads extensions from.
fn verify_files(dir: &Path, m: &Manifest, tier: Tier) -> Result<(), String> {
    check_unique_paths(&m.files)?;
    let mut listed: std::collections::HashMap<String, &FileEntry> = std::collections::HashMap::new();
    for fe in &m.files {
        let rel = safe_entry_path(&fe.path)?;
        let full = dir.join(&rel);
        let md = std::fs::symlink_metadata(&full).map_err(|_| format!("{} is missing from the installed pack", fe.path))?;
        if is_reparse(&md) || !md.is_file() {
            return Err(format!("{} is not a plain file", fe.path));
        }
        if md.len() != fe.size {
            return Err(format!("{} has {} bytes, the signed manifest says {}", fe.path, md.len(), fe.size));
        }
        if tier == Tier::Full && crate::util::file_sha256(&full).map_err(|e| format!("{}: {e}", fe.path))? != fe.sha256.to_lowercase() {
            return Err(format!("{} does not match its SHA-256 in the signed manifest", fe.path));
        }
        listed.insert(fe.path.replace('\\', "/"), fe);
    }
    let copies = stub_copies(dir, &listed)?;
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, prefix)) = stack.pop() {
        for e in std::fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))? {
            let e = e.map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = format!("{prefix}{name}");
            let md = std::fs::symlink_metadata(e.path()).map_err(|e| e.to_string())?;
            if is_reparse(&md) {
                return Err(format!("{rel} is a link or junction inside the pack"));
            }
            if md.is_dir() {
                stack.push((e.path(), format!("{rel}/")));
            } else if listed.contains_key(&rel) || rel == "manifest.json" || rel == "manifest.json.minisig" {
                continue;
            } else if let Some(src) = copies.get(&rel) {
                if md.len() != src.size || (tier == Tier::Full && crate::util::file_sha256(&e.path()).map_err(|e| format!("{rel}: {e}"))? != src.sha256.to_lowercase()) {
                    return Err(format!("{rel} is not the stub file {} the signed manifest lists", src.path));
                }
            } else {
                return Err(format!("{rel} is in the installed pack but not in the signed manifest"));
            }
        }
    }
    Ok(())
}

/// `1.11.0-r2` as a sortable tuple. Anything else is not a pack version: digits only (no sign,
/// no space), so a value that parses can never hold a separator or `..` and is safe to join
/// onto `packs\`.
pub fn parse_pack_version(v: &str) -> Option<(u32, u32, u32, u32)> {
    fn num(s: &str) -> Option<u32> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    }
    let (core, rev) = v.split_once("-r")?;
    let mut it = core.split('.');
    let (a, b, c) = (num(it.next()?)?, num(it.next()?)?, num(it.next()?)?);
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c, num(rev)?))
}

/// A migration version (`YYYYMMDDHHMMSS`) as a number. Exactly 14 ASCII digits: anything else is not a version, so a
/// comparison can never be fooled by a shorter or longer string.
pub fn schema_version(s: &str) -> Option<u64> {
    if s.len() == 14 && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// The installed pack with the highest version under `packs\`, verified at `tier`. `Ok(None)` only when no pack folder
/// exists. Only the highest folder is loaded; when it does not verify the answer is an ERROR naming it, never a silent
/// fallback to an older pack (that would run a version nobody chose while hiding the damage).
pub fn latest_installed(packs_dir: &Path, tier: Tier) -> Result<Option<Pack>, String> {
    latest_installed_with(packs_dir, trust_key().as_deref(), tier)
}

pub fn latest_installed_with(packs_dir: &Path, key: Option<&str>, tier: Tier) -> Result<Option<Pack>, String> {
    let Some((_, name)) = highest_installed_version(packs_dir) else { return Ok(None) };
    let pack = load_checked(&packs_dir.join(&name), key, tier).map_err(|e| format!("pack {name}: {e}"))?;
    // the folder name is what `packs\` is keyed by: a manifest that says otherwise is not that pack
    if pack.manifest.pack_version != name {
        return Err(format!("pack {name}: the folder holds pack {}", pack.manifest.pack_version));
    }
    Ok(Some(pack))
}

/// The highest version by FOLDER NAME alone (no loading): the downgrade guard must not be defeated by a newer pack that
/// fails verification.
pub fn highest_installed_version(packs_dir: &Path) -> Option<((u32, u32, u32, u32), String)> {
    std::fs::read_dir(packs_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            parse_pack_version(&n).map(|v| (v, n))
        })
        .max()
}

#[cfg(test)]
pub fn make_fake_pack(dir: &Path, version: &str) {
    for f in REQUIRED_FILES {
        let p = dir.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        if f != "manifest.json" {
            std::fs::write(p, b"x").unwrap();
        }
    }
    std::fs::create_dir_all(dir.join("migrations")).unwrap();
    // The real manifest carries more fields than the struct models (builtAt, components, ...).
    std::fs::write(
        dir.join("manifest.json"),
        format!("{{\"schema\":1,\"packVersion\":\"{version}\",\"appVersion\":\"1.0.0\",\"platform\":\"win-x64\",\"builtAt\":\"x\",\"components\":{{\"postgres\":\"17\"}},\"migrations\":{{\"count\":2,\"max\":\"20260101000002\"}}}}"),
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_pack_loads_and_a_missing_file_is_named() {
        let d = tempfile::tempdir().unwrap();
        make_fake_pack(d.path(), "1.0.0-r1");
        let p = load(d.path()).unwrap();
        assert_eq!(p.manifest.pack_version, "1.0.0-r1");
        assert_eq!(p.manifest.migrations.count, 2);
        std::fs::remove_file(d.path().join("bin").join("auth.exe")).unwrap();
        assert!(load(d.path()).unwrap_err().contains("bin\\auth.exe"));
    }

    #[test]
    fn latest_installed_skips_a_pack_whose_manifest_version_differs_from_its_folder() {
        let d = tempfile::tempdir().unwrap();
        make_fake_pack(&d.path().join("1.0.0-r1"), "1.0.0-r1");
        assert_eq!(latest_installed(d.path(), Tier::Full).unwrap().unwrap().manifest.pack_version, "1.0.0-r1");
        make_fake_pack(&d.path().join("2.0.0-r1"), "1.5.0-r1"); // folder lies about the version: an error, not a fallback
        assert!(latest_installed(d.path(), Tier::Full).unwrap_err().contains("2.0.0-r1"));
    }

    #[test]
    fn the_required_list_includes_the_03c_grants_file() {
        assert_eq!(REQUIRED_FILES.len(), 20);
        assert!(REQUIRED_FILES.contains(&"sql\\03c-database-grants.sql"));
        let d = tempfile::tempdir().unwrap();
        make_fake_pack(d.path(), "1.0.0-r1");
        std::fs::remove_file(d.path().join("sql").join("03c-database-grants.sql")).unwrap();
        assert!(load(d.path()).unwrap_err().contains("03c-database-grants.sql"));
    }

    #[test]
    fn unsafe_paths_are_refused_and_safe_ones_normalised() {
        for bad in ["../x", "..\\x", "/etc/x", "C:/x", "a/../../x", "a:b", "", "./", "a/./b"] {
            assert!(safe_entry_path(bad).is_err(), "{bad}");
        }
        assert_eq!(safe_entry_path("pg\\bin/postgres.exe").unwrap(), PathBuf::from("pg").join("bin").join("postgres.exe"));
    }

    #[test]
    fn windows_hostile_names_are_refused() {
        for bad in [
            "a.", "dir./f", "a /b", "bin/a ", "con", "CON.txt", "nul", "Aux", "prn.x", "com1", "COM9.dll", "lpt3", "bin/lpt1.exe", "x/NUL.tar.gz", "a\u{1}b", "a\tb", "x\u{7f}", "a<b", "a|b", "a?b", "a*b", "a\"b",
        ] {
            assert!(safe_entry_path(bad).is_err(), "{bad:?}");
        }
        for ok in ["con1", "comx", "bin/console.exe", "conf/a.b.c", "pg/share/.keep", "com0", "licenses/README.txt", "migrations/20260101000001_a.sql"] {
            assert!(safe_entry_path(ok).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn manifest_paths_must_be_unique_ignoring_case_and_separators() {
        let f = |p: &str| FileEntry { path: p.into(), sha256: "00".into(), size: 1 };
        assert!(check_unique_paths(&[f("bin/a.exe"), f("bin/b.exe")]).is_ok());
        assert!(check_unique_paths(&[f("bin/a.exe"), f("BIN\\A.exe")]).unwrap_err().contains("case"));
        assert!(check_unique_paths(&[f("bin/a.exe"), f("bin\\a.exe")]).is_err());
    }

    #[test]
    fn wrong_schema_or_platform_is_refused() {
        let d = tempfile::tempdir().unwrap();
        make_fake_pack(d.path(), "1.0.0-r1");
        let m = std::fs::read_to_string(d.path().join("manifest.json")).unwrap();
        std::fs::write(d.path().join("manifest.json"), m.replace("win-x64", "linux")).unwrap();
        assert!(load(d.path()).unwrap_err().contains("win-x64"));
        std::fs::write(d.path().join("manifest.json"), m.replace("\"schema\":1", "\"schema\":2")).unwrap();
        assert!(load(d.path()).is_err());
    }

    #[test]
    fn pack_versions_parse_and_sort_numerically() {
        assert_eq!(parse_pack_version("1.11.0-r1"), Some((1, 11, 0, 1)));
        assert!(parse_pack_version("1.11.0").is_none() && parse_pack_version("1.11-r1").is_none() && parse_pack_version("1.2.3.4-r1").is_none());
        assert!(parse_pack_version("1.9.0-r1") < parse_pack_version("1.11.0-r1"));
        assert!(parse_pack_version("1.11.0-r2") > parse_pack_version("1.11.0-r1"));
        assert!(parse_pack_version("1.11.0-r10") > parse_pack_version("1.11.0-r9"));
    }

    #[test]
    fn a_version_with_separators_or_dots_or_signs_is_not_a_version() {
        for bad in ["..", "..\\1.0.0-r1", "1.0.0-r1\\x", "1.0.0-r1/..", "../1.0.0-r1", "C:\\1.0.0-r1", "1.0.0-r+1", "+1.0.0-r1", "1.0.0-r", "", " 1.0.0-r1"] {
            assert!(parse_pack_version(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_latest_installed_pack_wins() {
        let d = tempfile::tempdir().unwrap();
        for v in ["1.9.0-r1", "1.11.0-r1", "1.10.0-r3"] {
            let p = d.path().join(v);
            std::fs::create_dir_all(&p).unwrap();
            make_fake_pack(&p, v);
        }
        assert_eq!(latest_installed(d.path(), Tier::Full).unwrap().unwrap().manifest.pack_version, "1.11.0-r1");
        std::fs::create_dir_all(d.path().join("1.12.0-r1")).unwrap(); // empty = not a pack, and the highest: an error
        assert!(latest_installed(d.path(), Tier::Full).unwrap_err().contains("1.12.0-r1"));
        assert!(latest_installed(&d.path().join("none"), Tier::Full).unwrap().is_none());
    }

    #[test]
    #[ignore = "needs POS_PACK_DIR (a built pack)"]
    fn the_real_pack_loads() {
        let dir = std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR");
        let p = load_unverified(Path::new(&dir)).unwrap(); // a dev pack is not signed
        assert!(parse_pack_version(&p.manifest.pack_version).is_some(), "{}", p.manifest.pack_version);
        assert!(p.manifest.migrations.count > 0);
    }
}
