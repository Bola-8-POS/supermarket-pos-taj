//! `pack fetch | verify | install | list` (conventions section 10).
//!
//! A pack is a ZIP with a signed manifest. Install order, every step fail-closed (exit 13):
//! read and verify the manifest signature BEFORE extracting anything, extract into a staging
//! folder while hashing every byte written against the manifest, require exactly the files the
//! manifest lists, refuse a downgrade or a pack older than the live database, then rename the
//! staging folder into `packs\<packVersion>`. Any failure deletes the staging folder.
//!
//! The same verification runs every time an installed pack is loaded (`pack::load`, FULL: signature, every hash), so a pack
//! edited on disk after install is not run; status, health and version use `pack::load_light` (signature, sizes, nothing
//! unlisted) because they run every minute, and `stop` loads no pack at all.
//!
//! `source()` is the single place that decides where a pack comes from (Objection O2): an
//! explicit file, a pack bundled next to `posctl.exe` (`backend.pospack`, only if the owner
//! decides to ship it in the installer), or a download from the feed. Moving to a bundled pack
//! is shipping that one resource; nothing else changes.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::envelope::{Code, PosctlError};
use crate::pack::{self, Manifest};
use crate::paths::Roots;
use crate::util::{hex, random_hex};

/// The Tauri updater public key (base64 of the minisign public key file), embedded at build time.
pub const UPDATER_PUBKEY: &str = include_str!(concat!(env!("OUT_DIR"), "/updater_pubkey.txt"));

/// The public key that signs packs. Production: the Tauri updater key embedded at build time. With the `test-hooks`
/// feature (never in a release) the environment variable `POSCTL_TEST_UPDATER_PUBKEY` replaces it, so the Windows Sandbox
/// scenarios can install a pack signed with a throwaway key. `hook_env` lists every hook compiled in.
#[cfg(feature = "test-hooks")]
pub fn updater_pubkey() -> String {
    std::env::var("POSCTL_TEST_UPDATER_PUBKEY").unwrap_or_else(|_| UPDATER_PUBKEY.to_string())
}
#[cfg(not(feature = "test-hooks"))]
pub fn updater_pubkey() -> String {
    UPDATER_PUBKEY.to_string()
}

#[cfg(feature = "test-hooks")]
pub fn hook_env() -> Vec<&'static str> {
    vec!["POSCTL_TEST_UPDATER_PUBKEY", "POSCTL_TEST_SKIP_PACK_SIGNATURE", "POSCTL_TEST_HOOKS", "POSCTL_TEST_ESCROW_PUBKEY"]
}
#[cfg(not(feature = "test-hooks"))]
pub fn hook_env() -> Vec<&'static str> {
    Vec::new()
}

pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 20_000;
/// A pack's central directory is a few hundred KB; this is the cap before the zip crate is allowed to parse it.
const MAX_CENTRAL_DIRECTORY: u32 = 8 * 1024 * 1024;
const MANIFEST: &str = "manifest.json";
const SIGNATURE: &str = "manifest.json.minisig";
const STAGING_PREFIX: &str = ".staging-";

fn invalid(msg: impl Into<String>) -> PosctlError {
    PosctlError::new(Code::PackInvalid, msg)
}

/// Tauri stores both keys and signatures as base64 of the minisign file; plain minisign text
/// is accepted too.
fn minisign_text(s: &str) -> Result<String, String> {
    let t = s.trim();
    if t.starts_with("untrusted comment:") {
        return Ok(format!("{t}\n"));
    }
    let bytes = STANDARD.decode(t.replace(['\r', '\n'], "")).map_err(|_| "not a minisign file and not base64".to_string())?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8 text".to_string())
}

#[cfg(feature = "test-hooks")]
fn skip_signature(v: Option<&str>) -> bool { v == Some("1") }

pub fn verify_signature(manifest: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    // Test-hooks builds only: the Sandbox edits a pack after signing it. Every file hash is still checked by the callers.
    #[cfg(feature = "test-hooks")]
    if skip_signature(std::env::var("POSCTL_TEST_SKIP_PACK_SIGNATURE").ok().as_deref()) { return Ok(()); }
    if pubkey.trim().is_empty() {
        return Err("no updater public key is embedded in this posctl build".into());
    }
    let pk = PublicKey::decode(&minisign_text(pubkey).map_err(|e| format!("public key: {e}"))?).map_err(|e| format!("public key: {e}"))?;
    let sig = Signature::decode(&minisign_text(signature).map_err(|e| format!("signature: {e}"))?).map_err(|e| format!("signature: {e}"))?;
    pk.verify(manifest, &sig, false).map_err(|e| format!("the manifest signature is not valid for the updater key: {e}"))
}

pub use crate::pack::safe_entry_path;

fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

/// Reads the end-of-central-directory record and refuses an entry count or directory size above the caps BEFORE the zip
/// crate parses (and allocates for) the directory. Zip64 (count 0xFFFF) is refused: a pack never has 65 535 files.
fn check_central_directory(f: &mut File) -> Result<(), PosctlError> {
    use std::io::{Seek, SeekFrom};
    let len = f.metadata().map_err(|e| invalid(e.to_string()))?.len();
    let tail = len.min(22 + 65_535);
    f.seek(SeekFrom::Start(len - tail)).map_err(|e| invalid(e.to_string()))?;
    let mut buf = vec![0u8; tail as usize];
    f.read_exact(&mut buf).map_err(|e| invalid(e.to_string()))?;
    f.seek(SeekFrom::Start(0)).map_err(|e| invalid(e.to_string()))?;
    let at = buf.windows(4).rposition(|w| w == [0x50, 0x4b, 0x05, 0x06]).filter(|i| i + 22 <= buf.len()).ok_or_else(|| invalid("not a valid pack archive: no end-of-central-directory record"))?;
    let entries = u16::from_le_bytes([buf[at + 10], buf[at + 11]]);
    let dir_size = u32::from_le_bytes([buf[at + 12], buf[at + 13], buf[at + 14], buf[at + 15]]);
    if entries == 0xFFFF || entries as usize > MAX_ENTRIES {
        return Err(invalid("the pack has too many entries"));
    }
    if dir_size > MAX_CENTRAL_DIRECTORY {
        return Err(invalid("the pack's central directory is too large"));
    }
    Ok(())
}

/// Verify (and optionally extract) a pack zip. Returns the verified manifest.
pub fn process_zip(file: &Path, pubkey: &str, extract_to: Option<&Path>) -> Result<Manifest, PosctlError> {
    let mut f = File::open(file).map_err(|e| invalid(format!("cannot open {}: {e}", file.display())))?;
    check_central_directory(&mut f)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| invalid(format!("not a valid pack archive: {e}")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(invalid("the pack has too many entries"));
    }
    // One pass over the directory: normalised name -> index, links refused, duplicates (also by case) refused.
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut lowered: HashSet<String> = HashSet::new();
    let mut declared: u64 = 0;
    for i in 0..zip.len() {
        let e = zip.by_index_raw(i).map_err(|e| invalid(e.to_string()))?;
        let name = norm(e.name());
        if e.is_symlink() || e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(invalid(format!("{name} is a link; packs contain plain files only")));
        }
        declared = declared.saturating_add(e.size());
        if e.is_dir() {
            safe_entry_path(&name).map_err(invalid)?;
            continue;
        }
        safe_entry_path(&name).map_err(invalid)?;
        if !lowered.insert(name.to_ascii_lowercase()) {
            return Err(invalid(format!("{name} appears twice in the archive (names that differ only in case are the same file on Windows)")));
        }
        index.insert(name.clone(), i);
    }
    if declared > MAX_TOTAL_BYTES {
        return Err(invalid("the pack expands to more than 2 GiB"));
    }

    let read_entry = |zip: &mut zip::ZipArchive<File>, name: &str| -> Result<Vec<u8>, PosctlError> {
        let i = *index.get(name).ok_or_else(|| invalid(format!("the pack has no {name}")))?;
        let mut e = zip.by_index(i).map_err(|e| invalid(e.to_string()))?;
        let mut buf = Vec::new();
        e.by_ref().take(4 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| invalid(e.to_string()))?;
        Ok(buf)
    };
    let manifest_bytes = read_entry(&mut zip, MANIFEST)?;
    let sig_bytes = read_entry(&mut zip, SIGNATURE)?;
    verify_signature(&manifest_bytes, &String::from_utf8_lossy(&sig_bytes), pubkey).map_err(invalid)?;
    let manifest: Manifest = serde_json::from_slice(manifest_bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&manifest_bytes)).map_err(|e| invalid(format!("manifest.json is not valid: {e}")))?;

    pack::check_unique_paths(&manifest.files).map_err(invalid)?;
    let mut expected: HashMap<String, (&str, u64)> = HashMap::new();
    let mut listed_bytes: u64 = 0;
    for fe in &manifest.files {
        safe_entry_path(&fe.path).map_err(invalid)?;
        listed_bytes = listed_bytes.saturating_add(fe.size);
        if expected.insert(norm(&fe.path), (fe.sha256.as_str(), fe.size)).is_some() {
            return Err(invalid(format!("the manifest lists {} twice", fe.path)));
        }
    }
    if listed_bytes > MAX_TOTAL_BYTES {
        return Err(invalid("the manifest lists more than 2 GiB"));
    }
    if let Some(extra) = index.keys().find(|k| k.as_str() != MANIFEST && k.as_str() != SIGNATURE && !expected.contains_key(*k)) {
        return Err(invalid(format!("the pack contains {extra}, which the manifest does not list")));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for (name, (want_hash, want_size)) in &expected {
        let rel = safe_entry_path(name).map_err(invalid)?;
        let i = *index.get(name).ok_or_else(|| invalid(format!("the pack is missing {name}, which the manifest lists")))?;
        let mut e = zip.by_index(i).map_err(|e| invalid(e.to_string()))?;
        seen.insert(name);
        let mut sink: Option<File> = match extract_to {
            Some(root) => {
                let dest = root.join(&rel);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| PosctlError::error(e.to_string()))?;
                }
                // create_new: never write through an existing file or link
                Some(std::fs::OpenOptions::new().write(true).create_new(true).open(dest).map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        invalid(format!("{name} collides with another entry"))
                    } else {
                        PosctlError::error(e.to_string())
                    }
                })?)
            }
            None => None,
        };
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        let mut limited = e.by_ref().take(want_size + 1);
        loop {
            let n = limited.read(&mut buf).map_err(|e| invalid(format!("{name}: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            total += n as u64;
            if let Some(s) = sink.as_mut() {
                s.write_all(&buf[..n]).map_err(|e| PosctlError::error(e.to_string()))?;
            }
        }
        if total != *want_size {
            return Err(invalid(format!("{name} has {total} bytes, the manifest says {want_size}")));
        }
        if hex(&hasher.finalize()) != want_hash.to_lowercase() {
            return Err(invalid(format!("{name} does not match its SHA-256 in the manifest")));
        }
    }
    debug_assert_eq!(seen.len(), expected.len());
    if let Some(root) = extract_to {
        std::fs::write(root.join(MANIFEST), &manifest_bytes).map_err(|e| PosctlError::error(e.to_string()))?;
        std::fs::write(root.join(SIGNATURE), &sig_bytes).map_err(|e| PosctlError::error(e.to_string()))?;
    }
    Ok(manifest)
}

const RENAME_RETRIES: u32 = 10;
const RENAME_BACKOFF: Duration = Duration::from_millis(500);

/// Moves a freshly extracted folder into place. Defender (or the indexer) often holds a handle on new executables for a
/// moment, and Windows then refuses the directory rename with ACCESS_DENIED (5) or SHARING_VIOLATION (32): retry those up
/// to 10 times, 500 ms apart. Any other error is final. `sleep` is injected so tests do not wait.
fn rename_retrying(rename: &mut dyn FnMut() -> std::io::Result<()>, sleep: &dyn Fn(Duration)) -> std::io::Result<()> {
    let mut retries = 0;
    loop {
        match rename() {
            Err(e) if retries < RENAME_RETRIES && matches!(e.raw_os_error(), Some(5) | Some(32)) => {
                retries += 1;
                sleep(RENAME_BACKOFF);
            }
            other => return other,
        }
    }
}

/// Lower-case host of an `http(s)://` URL (no userinfo, no IPv6 literal), without the port.
fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains(['@', '[']) {
        return None;
    }
    let host = authority.split(':').next()?.to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

fn scheme_of(url: &str) -> &str {
    url.split("://").next().unwrap_or("")
}

/// The pack may only be downloaded from the host that served the feed, over the same scheme: a feed (or whoever
/// tampers with it) cannot send the download elsewhere. The SHA-256 and signature checks still follow.
fn download_allowed(feed_url: &str, download_url: &str, dev: bool) -> bool {
    feed_url_allowed(download_url, dev) && scheme_of(feed_url) == scheme_of(download_url) && host_of(feed_url).is_some() && host_of(feed_url) == host_of(download_url)
}

#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    /// Plan 07's `update --allow-downgrade`; the `pack install` command never sets it.
    pub allow_downgrade: bool,
    /// `max_version` of the live database, when provisioned: a pack older than the data is refused. Plan 05b Task 6
    /// (`update`, `pack fetch` on a provisioned PC) MUST pass it: left `None` the check is skipped, so an old pack could
    /// be installed under a newer database.
    pub live_schema_max: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Installed {
    New { pack_version: String },
    AlreadyInstalled { pack_version: String },
}

/// Remove `.staging-*` folders a crashed install left behind (callers hold the operation lock).
fn sweep_staging(packs: &Path) {
    if let Ok(rd) = std::fs::read_dir(packs) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

pub fn install_file(roots: &Roots, file: &Path, pubkey: &str, opts: &InstallOptions) -> Result<Installed, PosctlError> {
    let packs = roots.packs();
    std::fs::create_dir_all(&packs)?;
    sweep_staging(&packs);
    // Staged inside `packs\` (same volume: the final rename is atomic, and the folder keeps the ACL inherited from the
    // program root rather than one carried over from another tree).
    let staging = packs.join(format!("{STAGING_PREFIX}{}", random_hex(6).map_err(PosctlError::error)?));
    std::fs::create_dir_all(&staging)?;
    let result = (|| -> Result<Installed, PosctlError> {
        let manifest = process_zip(file, pubkey, Some(&staging))?;
        let version = manifest.pack_version.clone();
        let parsed = pack::parse_pack_version(&version).ok_or_else(|| invalid(format!("'{version}' is not a pack version like 1.11.0-r1")))?;
        if manifest.platform != "win-x64" {
            return Err(invalid(format!("the pack is for {}", manifest.platform)));
        }
        let final_dir = roots.pack_dir(&version).map_err(invalid)?;
        if final_dir.exists() {
            // "already installed" only counts when what is on disk still verifies AND is the same manifest
            let same = std::fs::read(final_dir.join(MANIFEST)).ok() == std::fs::read(staging.join(MANIFEST)).ok();
            if !same {
                return Err(invalid(format!("pack {version} is already installed with different content")));
            }
            return match pack::load_with_key(&final_dir, pubkey) {
                Ok(_) => Ok(Installed::AlreadyInstalled { pack_version: version }),
                Err(e) => Err(invalid(format!("the installed pack {version} no longer verifies ({e}); it must be removed or replaced by an operator, posctl will not overwrite it"))),
            };
        }
        if let Some((latest, latest_name)) = pack::highest_installed_version(&packs) {
            if !opts.allow_downgrade && parsed < latest {
                return Err(invalid(format!("pack {version} is older than the installed {latest_name}; a downgrade needs an explicit update --allow-downgrade")));
            }
        }
        // Versions are 14-digit numbers, compared as numbers; a malformed one is refused, never compared as text.
        let pack_max = pack::schema_version(&manifest.migrations.max).ok_or_else(|| invalid(format!("the pack's newest migration '{}' is not a 14-digit version", manifest.migrations.max)))?;
        if let Some(live) = &opts.live_schema_max {
            let live_max = pack::schema_version(live).ok_or_else(|| invalid(format!("the database version '{live}' is not a 14-digit version")))?;
            if pack_max < live_max {
                return Err(invalid(format!("pack {version} carries migrations up to {}, but the database is already at {live}", manifest.migrations.max)));
            }
        }
        // process_zip hashed every byte it wrote against the signed manifest: only the structure is left to check
        pack::load_unverified(&staging).map_err(invalid)?;
        crate::runorder::load(&staging).map_err(invalid)?;
        rename_retrying(&mut || std::fs::rename(&staging, &final_dir), &std::thread::sleep)?;
        Ok(Installed::New { pack_version: version })
    })();
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackSource {
    File(PathBuf),
    Bundled(PathBuf),
    Download { feed_url: String },
}

/// Where the pack for this operation comes from (Objection O2: one function decides).
pub fn source(roots: &Roots, explicit_file: Option<&Path>, feed: Option<&str>) -> Result<PackSource, String> {
    if let Some(f) = explicit_file {
        return Ok(PackSource::File(f.to_path_buf()));
    }
    // an explicit --feed is what the operator asked for; an EMPTY bundled file is the CI/dev placeholder, not a pack
    if let Some(u) = feed {
        return Ok(PackSource::Download { feed_url: u.to_string() });
    }
    let bundled = roots.posctl_dir.join("backend.pospack");
    if std::fs::metadata(&bundled).is_ok_and(|m| m.is_file() && m.len() > 0) {
        return Ok(PackSource::Bundled(bundled));
    }
    if let Ok(t) = std::fs::read_to_string(roots.posctl_dir.join("pack-feed-url.txt")) {
        if let Some(l) = t.lines().map(|l| l.trim().trim_start_matches('\u{feff}')).find(|l| !l.is_empty()) {
            return Ok(PackSource::Download { feed_url: l.to_string() });
        }
    }
    if let Ok(Some(c)) = crate::config::PosctlJson::load(roots) {
        if let Some(u) = c.pack.feed_url {
            return Ok(PackSource::Download { feed_url: u });
        }
    }
    Err("no pack source: pass --feed or --file, or install posctl\\pack-feed-url.txt".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub pack_version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// https always; plain http only for a dev root and only to this machine (exact host, no userinfo).
pub fn feed_url_allowed(url: &str, dev: bool) -> bool {
    if url.contains('@') || url.chars().any(char::is_whitespace) {
        return false;
    }
    url.starts_with("https://") || (dev && ["http://127.0.0.1:", "http://127.0.0.1/", "http://localhost:", "http://localhost/"].iter().any(|p| url.starts_with(p)))
}

/// The cache must be a real folder (not a junction someone planted to redirect the download), and leftovers of a crashed
/// download are removed. Only our own `download-*.part` files are touched.
fn prepare_cache(roots: &Roots) -> Result<(), PosctlError> {
    let cache = roots.packs_cache();
    let is_link = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|md| pack::is_reparse(&md));
    if is_link(&cache) {
        return Err(invalid(format!("{} is a link or junction; refusing to download into it", cache.display())));
    }
    std::fs::create_dir_all(&cache)?;
    if is_link(&cache) {
        return Err(invalid(format!("{} is a link or junction; refusing to download into it", cache.display())));
    }
    for e in std::fs::read_dir(&cache)?.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("download-") && name.ends_with(".part") {
            let _ = std::fs::remove_file(e.path());
        }
    }
    Ok(())
}

/// The pack version the feed offers, from a plain GET of the feed document: nothing is downloaded, cached or installed.
pub fn peek_latest(roots: &Roots, feed_url: &str) -> Result<String, PosctlError> {
    if !feed_url_allowed(feed_url, roots.dev) {
        return Err(invalid("the pack feed must be an https URL"));
    }
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(30)).build();
    let mut body = String::new();
    match agent.get(feed_url).set("Accept", "application/json").call() {
        Ok(r) => { r.into_reader().take(1024 * 1024).read_to_string(&mut body).map_err(|e| PosctlError::error(format!("the pack feed could not be read: {e}")).retryable())?; }
        Err(ureq::Error::Status(code, _)) => return Err(PosctlError::error(format!("the pack feed answered HTTP {code}")).retryable()),
        Err(e) => return Err(PosctlError::error(format!("the pack feed could not be reached: {e}")).retryable()),
    }
    let feed: Feed = serde_json::from_str(&body).map_err(|e| invalid(format!("the pack feed is not valid: {e}")))?;
    pack::parse_pack_version(&feed.pack_version).ok_or_else(|| invalid("the pack feed names an invalid pack version"))?;
    Ok(feed.pack_version)
}

/// Returns what was installed and the feed's `latest` pack version.
pub fn fetch(roots: &Roots, feed_url: &str, pubkey: &str, opts: &InstallOptions) -> Result<(Installed, String), PosctlError> {
    if !feed_url_allowed(feed_url, roots.dev) {
        return Err(invalid("the pack feed must be an https URL"));
    }
    prepare_cache(roots)?;
    let transport = |e: ureq::Error| PosctlError::error(format!("download failed: {e}")).retryable();
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(30)).build();
    let body = match agent.get(feed_url).set("Accept", "application/json").call() {
        Ok(r) => {
            let mut s = String::new();
            r.into_reader().take(1024 * 1024).read_to_string(&mut s).map_err(|e| PosctlError::error(format!("the pack feed could not be read: {e}")).retryable())?;
            s
        }
        Err(ureq::Error::Status(code, _)) => return Err(PosctlError::error(format!("the pack feed answered HTTP {code}")).retryable()),
        Err(e) => return Err(transport(e)),
    };
    let feed: Feed = serde_json::from_str(&body).map_err(|e| invalid(format!("the pack feed is not valid: {e}")))?;
    pack::parse_pack_version(&feed.pack_version).ok_or_else(|| invalid("the pack feed names an invalid pack version"))?;
    if !download_allowed(feed_url, &feed.url, roots.dev) {
        return Err(invalid("the pack download URL must be https and on the same host as the feed"));
    }
    if feed.size == 0 || feed.size > MAX_TOTAL_BYTES {
        return Err(invalid("the feed announces an impossible pack size"));
    }
    // a fixed shape, never derived from feed text
    let part = roots.packs_cache().join(format!("download-{}.part", random_hex(6).map_err(PosctlError::error)?));
    let download = (|| -> Result<(), PosctlError> {
        // No redirects (the host check above would mean nothing), and connect + read timeouts instead of one limit for the
        // whole request: a 250 MB pack on a slow line may take longer than any fixed total, a stalled one must not hang.
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).build();
        let r = agent.get(&feed.url).call().map_err(transport)?;
        if r.status() != 200 {
            return Err(PosctlError::error(format!("the pack download answered HTTP {} (redirects are not followed)", r.status())));
        }
        let mut out = File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut reader = r.into_reader().take(feed.size + 1);
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| PosctlError::error(format!("download failed: {e}")).retryable())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            total += n as u64;
        }
        out.sync_all()?;
        if total != feed.size {
            return Err(invalid(format!("downloaded {total} bytes, the feed says {}", feed.size)));
        }
        if hex(&hasher.finalize()) != feed.sha256.to_lowercase() {
            return Err(invalid("the download does not match the SHA-256 in the feed (transport check)"));
        }
        Ok(())
    })();
    let result = download.and_then(|_| install_file(roots, &part, pubkey, opts));
    let _ = std::fs::remove_file(&part);
    result.map(|i| (i, feed.pack_version.clone()))
}

/// Installed packs and whether each still verifies (signature, every file hash, nothing unlisted).
pub fn list(roots: &Roots) -> Vec<(String, bool)> {
    list_with(roots, pack::trust_key().as_deref())
}

fn list_with(roots: &Roots, key: Option<&str>) -> Vec<(String, bool)> {
    let mut v: Vec<(String, bool)> = std::fs::read_dir(roots.packs())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| pack::parse_pack_version(n).is_some())
                .map(|n| {
                    let ok = roots.pack_dir(&n).ok().is_some_and(|d| match key {
                        Some(k) => pack::load_with_key(&d, k).is_ok(),
                        None => pack::load_unverified(&d).is_ok(),
                    });
                    (n, ok)
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|(n, _)| pack::parse_pack_version(n));
    v
}

/// Shared by this module's tests and by the lifecycle and status tests: the signed fixture pack and a provisioned root
/// that holds it, installed through the real `install_file`.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/pack-ok.pospack");
    pub const SIGNER_PUB: &str = include_str!("../tests/fixtures/signer.pub");
    pub const OTHER_PUB: &str = include_str!("../tests/fixtures/other.pub");

    /// A provisioned dev root whose pack `1.0.0-r1` is the signed fixture; `pack::load*` verify with the fixture's signer on
    /// this thread. `hook_ok` writes the lockout hook variables into gotrue.env.
    pub fn signed_root(d: &tempfile::TempDir, hook_ok: bool) -> Roots {
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        for p in [roots.state(), roots.conf(), roots.secrets(), roots.packs_cache()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let zip = d.path().join("ok.pospack");
        std::fs::write(&zip, FIXTURE).unwrap();
        install_file(&roots, &zip, SIGNER_PUB, &InstallOptions::default()).unwrap();
        crate::config::PosctlJson::new("offline-only", "id", 47990, "shop", "1.0.0-r1").save(&roots).unwrap();
        let env = if hook_ok { format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true
GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}
", crate::render::HOOK_URI) } else { "OTHER=1
".to_string() };
        std::fs::write(roots.gotrue_env(), env).unwrap();
        pack::set_test_key(Some(SIGNER_PUB));
        roots
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{FIXTURE, OTHER_PUB, SIGNER_PUB};
    use super::*;
    use std::io::Cursor;

    fn roots() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(r.packs_cache()).unwrap();
        (d, r)
    }

    fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// Rewrite the fixture zip, letting the closure change or drop entries and add new ones.
    fn mutate(f: impl Fn(&str, Vec<u8>) -> Option<Vec<u8>>, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut src = zip::ZipArchive::new(Cursor::new(FIXTURE)).unwrap();
        let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..src.len() {
            let mut e = src.by_index(i).unwrap();
            if e.is_dir() {
                continue;
            }
            let name = e.name().to_string();
            let mut data = Vec::new();
            e.read_to_end(&mut data).unwrap();
            if let Some(d) = f(&name.replace('\\', "/"), data) {
                out.start_file(name, opts).unwrap();
                out.write_all(&d).unwrap();
            }
        }
        for (n, d) in extra {
            out.start_file(*n, opts).unwrap();
            out.write_all(d).unwrap();
        }
        out.finish().unwrap().into_inner()
    }

    /// An installed, verified fixture pack under `roots`.
    fn installed(r: &Roots, scratch: &Path) -> PathBuf {
        let f = write_fixture(scratch, "ok.pospack", FIXTURE);
        install_file(r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap();
        r.pack_dir("1.0.0-r1").unwrap()
    }

    fn no_staging(r: &Roots) -> bool {
        !std::fs::read_dir(r.packs()).map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with(".staging"))).unwrap_or(false)
    }

    #[test]
    fn the_embedded_updater_key_is_a_valid_minisign_public_key() {
        // build.rs copied it from src-tauri/tauri.conf.json: this fails if that file changes shape.
        assert!(!UPDATER_PUBKEY.is_empty());
        let text = minisign_text(UPDATER_PUBKEY).unwrap();
        assert!(PublicKey::decode(&text).is_ok(), "{text}");
    }

    #[test]
    fn a_correctly_signed_pack_verifies_and_installs_with_every_file_in_place() {
        let (d, r) = roots();
        let f = write_fixture(d.path(), "pack.pospack", FIXTURE);
        let m = process_zip(&f, SIGNER_PUB, None).unwrap();
        assert_eq!(m.pack_version, "1.0.0-r1");
        assert_eq!(m.files.len(), 26);
        assert_eq!(install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap(), Installed::New { pack_version: "1.0.0-r1".into() });
        let dir = r.pack_dir("1.0.0-r1").unwrap();
        assert!(dir.join("bin").join("auth.exe").is_file() && dir.join("manifest.json.minisig").is_file());
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_ok());
        assert_eq!(crate::runorder::load(&dir).unwrap().steps.len(), 12, "the installed pack carries a valid, complete run-order");
        assert!(no_staging(&r), "staging is gone");
        // installing the same pack again is a no-op, not an error
        assert_eq!(install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap(), Installed::AlreadyInstalled { pack_version: "1.0.0-r1".into() });
        assert_eq!(list_with(&r, Some(SIGNER_PUB)), vec![("1.0.0-r1".to_string(), true)]);
    }

    // The committed signature vector from Plan 04 (store-server/pack/test/fixtures/signed-sample): the contract the Rust verifier is held to.
    const VECTOR_MANIFEST: &[u8] = include_bytes!("../pack/test/fixtures/signed-sample/manifest.json");
    const VECTOR_SIG: &str = include_str!("../pack/test/fixtures/signed-sample/manifest.json.minisig");
    const VECTOR_PUB: &str = include_str!("../pack/test/fixtures/signed-sample/pubkey.txt");

    #[test]
    fn the_plan_04_signature_vector_verifies_and_a_one_byte_change_does_not() {
        verify_signature(VECTOR_MANIFEST, VECTOR_SIG, VECTOR_PUB).expect("the committed vector must verify");
        let mut changed = VECTOR_MANIFEST.to_vec();
        changed[3] ^= 0x01;
        assert!(verify_signature(&changed, VECTOR_SIG, VECTOR_PUB).is_err());
        assert!(verify_signature(VECTOR_MANIFEST, VECTOR_SIG, OTHER_PUB).is_err(), "another key must not verify it");
        assert!(verify_signature(VECTOR_MANIFEST, "not a signature", VECTOR_PUB).is_err());
    }

    #[test]
    fn a_wrong_key_is_refused_and_nothing_is_left_behind() {
        let (d, r) = roots();
        let f = write_fixture(d.path(), "pack.pospack", FIXTURE);
        let e = install_file(&r, &f, OTHER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(e.message.contains("signature"));
        assert!(list_with(&r, None).is_empty());
        assert!(std::fs::read_dir(r.packs()).unwrap().next().is_none(), "the staging folder was removed");
        assert_eq!(install_file(&r, &f, "", &InstallOptions::default()).unwrap_err().code, Code::PackInvalid);
    }

    #[test]
    fn a_tampered_manifest_file_or_extra_or_missing_file_is_refused() {
        let (d, r) = roots();
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("manifest edited", mutate(|n, mut b| { if n == "manifest.json" { b.extend_from_slice(b" "); } Some(b) }, &[])),
            ("file byte changed", mutate(|n, mut b| { if n == "bin/auth.exe" { b[0] ^= 1; } Some(b) }, &[])),
            ("file truncated", mutate(|n, b| Some(if n == "bin/auth.exe" { b[..2].to_vec() } else { b }), &[])),
            ("unlisted file added", mutate(|_, b| Some(b), &[("bin/evil.exe", b"x")])),
            ("listed file removed", mutate(|n, b| if n == "bin/caddy.exe" { None } else { Some(b) }, &[])),
            ("signature removed", mutate(|n, b| if n == "manifest.json.minisig" { None } else { Some(b) }, &[])),
            ("alternate data stream name", mutate(|_, b| Some(b), &[("bin/auth.exe:evil", b"x")])),
            ("same entry twice (backslash spelling)", mutate(|_, b| Some(b), &[("bin\\auth.exe", b"x ")])),
        ];
        for (label, bytes) in cases {
            let f = write_fixture(d.path(), "bad.pospack", &bytes);
            let e = install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).expect_err(label);
            assert_eq!(e.code, Code::PackInvalid, "{label}: {}", e.message);
            assert!(list_with(&r, None).is_empty() && no_staging(&r), "{label}");
        }
        assert!(std::fs::read_dir(r.packs()).unwrap().next().is_none(), "nothing at all was left under packs");
    }

    #[test]
    fn zip_slip_absolute_paths_and_link_entries_are_refused_even_with_a_valid_signature_elsewhere() {
        for bad in ["../x", "..\\x", "/etc/x", "C:/x", "a/../../x", "a:b", "", "./", "a/./b"] {
            assert!(safe_entry_path(bad).is_err(), "{bad}");
        }
        assert_eq!(safe_entry_path("pg\\bin/postgres.exe").unwrap(), PathBuf::from("pg").join("bin").join("postgres.exe"));
        let (d, r) = roots();
        for bad in ["../escape.txt", "..\\escape.txt", "/abs.txt", "C:/abs.txt", "C:\\abs.txt"] {
            let f = write_fixture(d.path(), "slip.pospack", &mutate(|_, b| Some(b), &[(bad, b"x")]));
            assert_eq!(install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err().code, Code::PackInvalid, "{bad}");
        }
        assert!(!d.path().join("prog").join("escape.txt").exists() && !d.path().join("escape.txt").exists());
        // a symlink entry
        let mut src = zip::ZipArchive::new(Cursor::new(FIXTURE)).unwrap();
        let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..src.len() {
            let mut e = src.by_index(i).unwrap();
            let mut data = Vec::new();
            e.read_to_end(&mut data).unwrap();
            out.start_file(e.name().to_string(), opts).unwrap();
            out.write_all(&data).unwrap();
        }
        out.add_symlink("bin/link.exe", "C:\\Windows\\System32\\cmd.exe", opts).unwrap();
        let f = write_fixture(d.path(), "link.pospack", &out.finish().unwrap().into_inner());
        let e = install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(e.message.contains("link"), "{}", e.message);
        assert!(std::fs::read_dir(r.packs()).unwrap().next().is_none());
    }

    #[test]
    fn downgrades_and_packs_older_than_the_database_are_refused() {
        let (d, r) = roots();
        let newer = r.pack_dir("1.1.0-r1").unwrap();
        std::fs::create_dir_all(&newer).unwrap();
        pack::make_fake_pack(&newer, "1.1.0-r1");
        let f = write_fixture(d.path(), "pack.pospack", FIXTURE);
        let e = install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert!(e.message.contains("older than the installed"), "{}", e.message);
        assert_eq!(e.code, Code::PackInvalid);
        assert!(install_file(&r, &f, SIGNER_PUB, &InstallOptions { allow_downgrade: true, live_schema_max: None }).is_ok());
        let (d2, r2) = roots();
        let f2 = write_fixture(d2.path(), "pack.pospack", FIXTURE);
        let e = install_file(&r2, &f2, SIGNER_PUB, &InstallOptions { allow_downgrade: false, live_schema_max: Some("20260101000003".into()) }).unwrap_err();
        assert!(e.message.contains("database is already at"));
        assert!(std::fs::read_dir(r2.packs()).unwrap().next().is_none(), "nothing left behind");
        assert!(install_file(&r2, &f2, SIGNER_PUB, &InstallOptions { allow_downgrade: false, live_schema_max: Some("20260101000002".into()) }).is_ok());
    }

    #[test]
    fn a_newer_pack_that_fails_verification_still_blocks_a_downgrade() {
        // the guard reads folder names, so corrupting the newer pack cannot be used to slip an older one in
        let (d, r) = roots();
        let newer = r.pack_dir("2.0.0-r1").unwrap();
        std::fs::create_dir_all(&newer).unwrap(); // not even a pack
        let f = write_fixture(d.path(), "pack.pospack", FIXTURE);
        assert!(install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err().message.contains("older than the installed 2.0.0-r1"));
    }

    #[test]
    fn a_pack_edited_on_disk_after_install_no_longer_loads() {
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        let latest = |key| pack::latest_installed_with(&r.packs(), key, pack::Tier::Full).ok().flatten().map(|p| p.manifest.pack_version);
        assert_eq!(latest(Some(SIGNER_PUB)).as_deref(), Some("1.0.0-r1"));
        assert!(pack::load_with_key(&dir, OTHER_PUB).is_err(), "another key");
        // tampered file
        let auth = dir.join("bin").join("auth.exe");
        std::fs::write(&auth, b"evil").unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("bin/auth.exe"));
        assert_eq!(latest(Some(SIGNER_PUB)), None, "latest_installed returns verified packs only");
        assert_eq!(list_with(&r, Some(SIGNER_PUB)), vec![("1.0.0-r1".to_string(), false)]);
        std::fs::remove_dir_all(&dir).unwrap();
        // unsigned
        let dir = installed(&r, d.path());
        std::fs::remove_file(dir.join("manifest.json.minisig")).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("not signed"));
        assert_eq!(latest(None).as_deref(), Some("1.0.0-r1"), "the unverified view still sees the structure");
        std::fs::remove_dir_all(&dir).unwrap();
        // an unlisted file dropped next to the binaries (DLL planting)
        let dir = installed(&r, d.path());
        std::fs::write(dir.join("bin").join("version.dll"), b"x").unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("bin/version.dll"));
        std::fs::remove_file(dir.join("bin").join("version.dll")).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_ok());
        // a listed file removed
        std::fs::remove_file(dir.join("bin").join("caddy.exe")).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_err());
    }

    #[test]
    fn the_temporary_stub_extension_copies_are_tolerated_but_nothing_else_in_that_folder() {
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        let ext = dir.join("pg").join("share").join("extension");
        // what the run-order's copy-extension-stubs step puts there while provisioning
        let stubs = dir.join("sql").join("stub-extensions");
        std::fs::copy(stubs.join("vector.control"), ext.join("vector.control")).unwrap();
        std::fs::copy(stubs.join("vector--0.0.1.sql"), ext.join("vector--0.0.1.sql")).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_ok(), "the stub copies are expected while a provision runs");
        std::fs::write(ext.join("evil.control"), b"x").unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("evil.control"));
        std::fs::remove_file(ext.join("evil.control")).unwrap();
        // the stub names are tolerated only in pg/share/extension
        std::fs::write(dir.join("bin").join("vector.control"), b"x").unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_err());
    }

    #[test]
    fn a_tampered_stub_source_file_is_caught_and_an_already_installed_tampered_pack_is_not_overwritten() {
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        std::fs::write(dir.join("sql").join("stub-extensions").join("vector.control"), b"trusted = true\nevil\n").unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).is_err());
        let f = write_fixture(d.path(), "again.pospack", FIXTURE);
        let e = install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(e.message.contains("no longer verifies"), "{}", e.message);
        assert!(std::fs::read(dir.join("sql").join("stub-extensions").join("vector.control")).unwrap().ends_with(b"evil\n"), "posctl did not touch it");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_an_installed_pack_is_refused() {
        // `mklink /J` needs no elevation; it is how a folder could be redirected out of the signed tree
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("bin").join("junction")).arg(&target).output().unwrap().status.success();
        assert!(ok, "mklink /J failed");
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("junction"));
    }

    #[test]
    #[ignore = "needs POS_SIGNED_PACK (a .pospack signed with a throwaway key) and POS_SIGNED_PUB (its public key file)"]
    fn a_real_signed_pack_installs_and_loads() {
        let zip = std::env::var("POS_SIGNED_PACK").expect("POS_SIGNED_PACK");
        let key = std::fs::read_to_string(std::env::var("POS_SIGNED_PUB").expect("POS_SIGNED_PUB")).unwrap();
        let (_d, r) = roots();
        let got = install_file(&r, Path::new(&zip), &key, &InstallOptions::default()).unwrap();
        let Installed::New { pack_version } = got else { panic!("expected a new install") };
        let dir = r.pack_dir(&pack_version).unwrap();
        pack::load_with_key(&dir, &key).unwrap();
        crate::runorder::load(&dir).unwrap();
        // the stub copies of a provision in progress must not break loading
        let ext = dir.join("pg").join("share").join("extension");
        for n in ["vector.control", "vector--0.0.1.sql"] {
            std::fs::copy(dir.join("sql").join("stub-extensions").join(n), ext.join(n)).unwrap();
        }
        pack::load_with_key(&dir, &key).unwrap();
        assert_eq!(list_with(&r, Some(&key)), vec![(pack_version, true)]);
    }

    #[test]
    fn a_stale_staging_folder_from_a_crashed_install_is_swept() {
        let (d, r) = roots();
        let stale = r.packs().join(".staging-deadbeef");
        std::fs::create_dir_all(stale.join("bin")).unwrap();
        std::fs::write(stale.join("bin").join("x"), b"x").unwrap();
        installed(&r, d.path());
        assert!(!stale.exists());
    }

    #[test]
    fn the_source_decision_is_made_in_one_place() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        r.posctl_dir = d.path().join("posctl");
        std::fs::create_dir_all(&r.posctl_dir).unwrap();
        assert!(source(&r, None, None).is_err());
        std::fs::write(r.posctl_dir.join("pack-feed-url.txt"), "\nhttps://example.invalid/pack-latest.json\n").unwrap();
        assert_eq!(source(&r, None, None).unwrap(), PackSource::Download { feed_url: "https://example.invalid/pack-latest.json".into() });
        assert_eq!(source(&r, None, Some("https://other.invalid/f.json")).unwrap(), PackSource::Download { feed_url: "https://other.invalid/f.json".into() });
        std::fs::write(r.posctl_dir.join("backend.pospack"), b"x").unwrap();
        // an empty bundled file is the CI/dev placeholder, not a pack: fall through to the feed
        std::fs::write(r.posctl_dir.join("backend.pospack"), b"").unwrap();
        assert_eq!(source(&r, None, None).unwrap(), PackSource::Download { feed_url: "https://example.invalid/pack-latest.json".into() }, "an empty bundled pack falls through");
        std::fs::write(r.posctl_dir.join("backend.pospack"), b"x").unwrap();
        assert_eq!(source(&r, None, None).unwrap(), PackSource::Bundled(r.posctl_dir.join("backend.pospack")), "a bundled pack wins over the feed file");
        assert_eq!(source(&r, None, Some("https://other.invalid/f.json")).unwrap(), PackSource::Download { feed_url: "https://other.invalid/f.json".into() }, "an explicit --feed wins over the bundled pack");
        assert_eq!(source(&r, Some(Path::new("C:\\usb\\p.pospack")), None).unwrap(), PackSource::File(PathBuf::from("C:\\usb\\p.pospack")));
    }

    fn feed_server(sha: String, size: usize) -> crate::http::mock::Mock {
        crate::http::mock::start_bytes(move |req| {
            if req.path == "/feed.json" {
                let host = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("host")).map(|(_, v)| v.clone()).unwrap();
                (200, format!("{{\"packVersion\":\"1.0.0-r1\",\"appVersion\":\"1.0.0\",\"url\":\"http://{host}/pack.pospack\",\"sha256\":\"{sha}\",\"size\":{size},\"manifestSha256\":\"\"}}").into_bytes())
            } else {
                (200, FIXTURE.to_vec())
            }
        })
    }

    #[test]
    fn fetch_downloads_checks_the_hash_then_installs_and_cleans_the_cache() {
        let (_d, r) = roots();
        let m = feed_server(hex(&Sha256::digest(FIXTURE)), FIXTURE.len());
        let (got, latest) = fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap();
        assert_eq!((got, latest.as_str()), (Installed::New { pack_version: "1.0.0-r1".into() }, "1.0.0-r1"));
        assert!(std::fs::read_dir(r.packs_cache()).unwrap().next().is_none());
    }

    #[test]
    fn a_download_that_does_not_match_the_feed_hash_is_refused() {
        let (_d, r) = roots();
        let m = feed_server("ab".repeat(32), FIXTURE.len());
        let e = fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(list_with(&r, None).is_empty() && std::fs::read_dir(r.packs_cache()).unwrap().next().is_none());
    }

    #[test]
    fn a_download_signed_by_another_key_is_refused_even_when_the_feed_hash_matches() {
        let (_d, r) = roots();
        let m = feed_server(hex(&Sha256::digest(FIXTURE)), FIXTURE.len());
        let e = fetch(&r, &format!("{}/feed.json", m.url()), OTHER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(std::fs::read_dir(r.packs()).unwrap().next().is_none() && std::fs::read_dir(r.packs_cache()).unwrap().next().is_none());
    }

    #[test]
    fn a_feed_with_a_path_like_pack_version_is_refused() {
        let (_d, r) = roots();
        let m = crate::http::mock::start(|_| (200, r#"{"packVersion":"..\\..\\x","url":"http://127.0.0.1:1/p","sha256":"00","size":10}"#.into()));
        assert_eq!(fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap_err().code, Code::PackInvalid);
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn the_signature_skip_needs_exactly_one() {
        assert!(skip_signature(Some("1")));
        assert!(!skip_signature(None) && !skip_signature(Some("0")) && !skip_signature(Some("true")) && !skip_signature(Some("")));
    }

    #[test]
    fn hook_env_match_the_feature_and_the_default_key_is_the_embedded_one() {
        #[cfg(not(feature = "test-hooks"))]
        {
            assert!(hook_env().is_empty());
            assert_eq!(updater_pubkey(), UPDATER_PUBKEY);
        }
        #[cfg(feature = "test-hooks")]
        // Plan 12 adds its own labels under the same feature, so assert a superset
        assert!(hook_env().contains(&"POSCTL_TEST_UPDATER_PUBKEY"));
    }

    #[test]
    fn a_production_root_refuses_a_plain_http_feed() {
        let (_d, mut r) = roots();
        r.dev = false;
        assert!(!feed_url_allowed("http://127.0.0.1:1/f.json", false));
        assert_eq!(fetch(&r, "http://127.0.0.1:1/f.json", SIGNER_PUB, &InstallOptions::default()).unwrap_err().code, Code::PackInvalid);
        assert!(feed_url_allowed("https://a.example/f.json", false) && feed_url_allowed("http://127.0.0.1:9/f", true));
        assert!(!feed_url_allowed("http://127.0.0.1.evil.example/f", true) && !feed_url_allowed("http://127.0.0.1:1@evil.example/f", true));
    }

    // ---- F4: verification tiers, stub copies, rename retry, schema versions, download hardening

    fn flip_same_size(dir: &Path, rel: &str) {
        let p = dir.join(rel);
        let mut b = std::fs::read(&p).unwrap();
        b[0] ^= 1;
        std::fs::write(p, b).unwrap();
    }

    #[test]
    fn light_passes_a_same_size_hash_mismatch_and_full_refuses_it() {
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        pack::load_light_with_key(&dir, SIGNER_PUB).unwrap();
        flip_same_size(&dir, "bin/auth.exe");
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).is_ok(), "a stat cannot see a same-size flip: that is what Full is for");
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("SHA-256"));
        // everything a stat or the signature CAN see, Light refuses
        std::fs::write(dir.join("bin").join("auth.exe"), b"a different length entirely").unwrap();
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).unwrap_err().contains("bin/auth.exe"));
        std::fs::remove_dir_all(&dir).unwrap();
        let dir = installed(&r, d.path());
        assert!(pack::load_light_with_key(&dir, OTHER_PUB).is_err(), "another key");
        std::fs::write(dir.join("bin").join("version.dll"), b"x").unwrap();
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).unwrap_err().contains("version.dll"), "unlisted");
        std::fs::remove_file(dir.join("bin").join("version.dll")).unwrap();
        std::fs::remove_file(dir.join("bin").join("caddy.exe")).unwrap();
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).is_err(), "listed file removed");
        std::fs::remove_dir_all(&dir).unwrap();
        let dir = installed(&r, d.path());
        std::fs::remove_file(dir.join("manifest.json.minisig")).unwrap();
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).unwrap_err().contains("not signed"));
    }

    #[test]
    fn the_latest_pack_is_the_highest_folder_and_a_highest_that_does_not_verify_is_an_error_naming_it() {
        let (d, r) = roots();
        let _ = installed(&r, d.path());
        let latest = |tier| pack::latest_installed_with(&r.packs(), Some(SIGNER_PUB), tier);
        for tier in [pack::Tier::Full, pack::Tier::Light] {
            assert_eq!(latest(tier).unwrap().unwrap().manifest.pack_version, "1.0.0-r1");
        }
        std::fs::create_dir_all(r.pack_dir("0.9.0-r1").unwrap()).unwrap(); // a broken LOWER pack is never even read
        assert_eq!(latest(pack::Tier::Full).unwrap().unwrap().manifest.pack_version, "1.0.0-r1");
        std::fs::create_dir_all(r.pack_dir("2.0.0-r1").unwrap()).unwrap(); // the highest is not a pack
        for tier in [pack::Tier::Full, pack::Tier::Light] {
            let e = latest(tier).unwrap_err();
            assert!(e.contains("2.0.0-r1"), "no silent fallback to 1.0.0-r1: {e}");
        }
        assert!(pack::latest_installed_with(&d.path().join("none"), Some(SIGNER_PUB), pack::Tier::Full).unwrap().is_none());
    }

    #[test]
    fn a_stub_copy_is_accepted_only_when_it_equals_the_listed_stub_file() {
        let (d, r) = roots();
        let dir = installed(&r, d.path());
        let ext = dir.join("pg").join("share").join("extension");
        let stubs = dir.join("sql").join("stub-extensions");
        for n in ["vector.control", "vector--0.0.1.sql"] {
            std::fs::copy(stubs.join(n), ext.join(n)).unwrap(); // what copy-extension-stubs does
        }
        pack::load_with_key(&dir, SIGNER_PUB).expect("identical copies are expected while a provision runs");
        pack::load_light_with_key(&dir, SIGNER_PUB).unwrap();
        // same name, other content: an unhashed file in the folder the database loads extensions from
        let original = std::fs::read(ext.join("vector.control")).unwrap();
        let mut other = original.clone();
        other[0] ^= 1;
        std::fs::write(ext.join("vector.control"), &other).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("vector.control"));
        std::fs::write(ext.join("vector.control"), [original.as_slice(), b"; evil"].concat()).unwrap();
        assert!(pack::load_light_with_key(&dir, SIGNER_PUB).unwrap_err().contains("vector.control"), "Light checks the size of a copy");
        std::fs::write(ext.join("vector.control"), &original).unwrap();
        // the run-order names pg/share/extension as the only place the copies go
        std::fs::write(dir.join("pg").join("share").join("vector.control"), &original).unwrap();
        assert!(pack::load_with_key(&dir, SIGNER_PUB).unwrap_err().contains("pg/share/vector.control"));
    }

    #[test]
    fn the_directory_rename_retries_on_access_denied_and_sharing_violation_and_nothing_else() {
        use std::cell::{Cell, RefCell};
        let sleeps: RefCell<Vec<Duration>> = RefCell::default();
        let sleep = |d: Duration| sleeps.borrow_mut().push(d);
        let tries = Cell::new(0);
        let mut flaky = || {
            tries.set(tries.get() + 1);
            match tries.get() {
                1 | 3 => Err(std::io::Error::from_raw_os_error(5)), // ERROR_ACCESS_DENIED (Defender is scanning the new folder)
                2 => Err(std::io::Error::from_raw_os_error(32)),    // ERROR_SHARING_VIOLATION
                _ => Ok(()),
            }
        };
        rename_retrying(&mut flaky, &sleep).unwrap();
        assert_eq!((tries.get(), sleeps.borrow().clone()), (4, vec![Duration::from_millis(500); 3]));
        // gives up after 10 retries
        sleeps.borrow_mut().clear();
        let tries = Cell::new(0);
        let mut locked = || {
            tries.set(tries.get() + 1);
            Err(std::io::Error::from_raw_os_error(5))
        };
        assert!(rename_retrying(&mut locked, &sleep).is_err());
        assert_eq!((tries.get(), sleeps.borrow().len()), (11, 10));
        // any other error is final
        sleeps.borrow_mut().clear();
        let mut gone = || Err(std::io::Error::from_raw_os_error(2));
        assert!(rename_retrying(&mut gone, &sleep).is_err());
        assert!(sleeps.borrow().is_empty());
    }

    #[test]
    fn migration_versions_are_14_digit_numbers_and_the_downgrade_check_compares_them_as_numbers() {
        assert_eq!(pack::schema_version("20260101000002"), Some(20260101000002));
        for bad in ["", "2026010100000", "202601010000022", "2026010100000a", "+2026010100002", " 2026010100002", "2026-01-01 00:00"] {
            assert_eq!(pack::schema_version(bad), None, "{bad:?}");
        }
        let (d, r) = roots();
        let f = write_fixture(d.path(), "ok.pospack", FIXTURE);
        let live = |v: &str| InstallOptions { live_schema_max: Some(v.into()), ..Default::default() };
        // a malformed live version is refused (a string comparison would let the pack through), as is a newer one
        for bad in ["2026010100000", "20260101000003", "garbage"] {
            let e = install_file(&r, &f, SIGNER_PUB, &live(bad)).unwrap_err();
            assert_eq!(e.code, Code::PackInvalid, "{bad}");
        }
        assert!(no_staging(&r) && list_with(&r, None).is_empty());
        install_file(&r, &f, SIGNER_PUB, &live("20260101000001")).unwrap();
        assert_eq!(install_file(&r, &f, SIGNER_PUB, &live("20260101000002")).unwrap(), Installed::AlreadyInstalled { pack_version: "1.0.0-r1".into() });
    }

    #[test]
    fn the_download_host_is_parsed_and_must_equal_the_feed_host() {
        assert_eq!(host_of("https://Host.Example:8443/p?x#y").as_deref(), Some("host.example"));
        assert_eq!(host_of("http://127.0.0.1:9/f").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_of("https://a.example").as_deref(), Some("a.example"));
        assert_eq!(host_of("ftp://a.example/x"), None);
        assert_eq!(host_of("https:///x"), None);
        assert!(download_allowed("https://a.example/feed.json", "https://a.example/p.pospack", false));
        assert!(download_allowed("https://a.example/feed.json", "https://A.EXAMPLE:443/p.pospack", false));
        assert!(!download_allowed("https://a.example/feed.json", "https://b.example/p.pospack", false));
        assert!(!download_allowed("https://a.example/feed.json", "https://a.example.evil/p.pospack", false));
        assert!(!download_allowed("https://a.example/feed.json", "http://a.example/p.pospack", false), "https stays https");
    }

    fn feed_body(host: &str, sha: &str, size: usize) -> String {
        format!("{{\"packVersion\":\"1.0.0-r1\",\"url\":\"http://{host}/pack.pospack\",\"sha256\":\"{sha}\",\"size\":{size}}}")
    }

    #[test]
    fn a_download_redirect_is_not_followed() {
        let (_d, r) = roots();
        let elsewhere = crate::http::mock::start(|_| (200, "x".into()));
        let target = format!("{}/stolen", elsewhere.url());
        let m = crate::http::mock::start(move |req| {
            if req.path == "/feed.json" {
                let host = req.headers.iter().find(|(k, _)| k == "host").map(|(_, v)| v.clone()).unwrap();
                (200, feed_body(&host, &hex(&Sha256::digest(FIXTURE)), FIXTURE.len()))
            } else {
                (302, target.clone())
            }
        });
        let e = fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert!(e.message.contains("302"), "{}", e.message);
        assert!(elsewhere.requests().is_empty(), "the redirect target was contacted");
    }

    #[test]
    fn a_download_url_on_another_host_than_the_feed_is_refused_without_connecting() {
        let (_d, r) = roots();
        let other = crate::http::mock::start_bytes(|_| (200, FIXTURE.to_vec()));
        let other_url = format!("localhost:{}", other.port);
        let m = crate::http::mock::start(move |_| (200, feed_body(&other_url, &hex(&Sha256::digest(FIXTURE)), FIXTURE.len())));
        let e = fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(e.message.contains("host"), "{}", e.message);
        assert!(other.requests().is_empty());
    }

    #[test]
    fn an_entry_count_or_directory_size_beyond_the_caps_is_refused_before_the_archive_is_parsed() {
        let (d, _r) = roots();
        let eocd = FIXTURE.windows(4).rposition(|w| w == [0x50, 0x4b, 0x05, 0x06]).expect("end of central directory");
        for (label, off, v, width) in [("30000 entries", 8usize, 30_000u32, 2usize), ("0xFFFF entries (zip64)", 8, 0xFFFF, 2), ("9 MB directory", 12, 9_000_000, 4)] {
            let mut b = FIXTURE.to_vec();
            b[eocd + off..eocd + off + width].copy_from_slice(&v.to_le_bytes()[..width]);
            if off == 8 {
                b[eocd + 10..eocd + 12].copy_from_slice(&v.to_le_bytes()[..2]);
            }
            let f = write_fixture(d.path(), "huge.pospack", &b);
            let e = process_zip(&f, SIGNER_PUB, None).unwrap_err();
            assert!(e.message.contains("too many entries") || e.message.contains("central directory"), "{label}: {}", e.message);
        }
    }

    #[test]
    fn names_that_differ_only_in_case_are_refused_in_the_archive() {
        let (d, r) = roots();
        let f = write_fixture(d.path(), "case.pospack", &mutate(|_, b| Some(b), &[("BIN/AUTH.EXE", b"x")]));
        let e = install_file(&r, &f, SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert!(e.message.contains("case"), "{}", e.message);
    }

    #[test]
    fn a_stale_download_part_is_swept_when_a_fetch_starts() {
        let (_d, r) = roots();
        std::fs::write(r.packs_cache().join("download-deadbeef.part"), b"partial").unwrap();
        std::fs::write(r.packs_cache().join("keep.txt"), b"not ours").unwrap();
        assert!(fetch(&r, "http://127.0.0.1:1/feed.json", SIGNER_PUB, &InstallOptions::default()).is_err());
        assert!(!r.packs_cache().join("download-deadbeef.part").exists());
        assert!(r.packs_cache().join("keep.txt").exists(), "only our own part files");
    }

    #[cfg(windows)]
    #[test]
    fn a_packs_cache_that_is_a_junction_is_refused() {
        let (d, r) = roots();
        std::fs::remove_dir_all(r.packs_cache()).unwrap();
        let target = d.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(r.packs_cache()).arg(&target).output().unwrap().status.success();
        assert!(ok, "mklink /J failed");
        let m = feed_server(hex(&Sha256::digest(FIXTURE)), FIXTURE.len());
        let e = fetch(&r, &format!("{}/feed.json", m.url()), SIGNER_PUB, &InstallOptions::default()).unwrap_err();
        assert_eq!(e.code, Code::PackInvalid);
        assert!(e.message.contains("junction"), "{}", e.message);
        assert!(std::fs::read_dir(&target).unwrap().next().is_none(), "nothing was written through the junction");
    }
}
