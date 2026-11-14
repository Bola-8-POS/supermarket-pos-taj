//! The signed install manifest and the check that runs before anything in the assistant install dir is started.
//!
//! `manifest.json` lists every file with its SHA-256 and is signed (minisign, `tauri signer sign`) with the same
//! updater key the app and the store pack use. `verify_install` refuses an install whose manifest is not signed by that
//! key, whose files differ from the list, that carries unlisted files, that contains a link, or that is 1 GB or more.
//! Every refusal is a short code; the POS keeps running with the assistant reported unavailable.

use base64::prelude::*;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The whole install dir (manifest, signature, uninstaller and runtime included) must stay under this. Same constant
/// in `scripts/assistant-build-installer.mjs`.
pub const INSTALL_BUDGET_BYTES: u64 = 1_000_000_000;
/// Where the runtime's server binary lives inside the install dir (always a listed file).
pub const RUNTIME_EXE: &str = "runtime/llama-server.exe";
const MANIFEST_FILE: &str = "manifest.json";
const SIGNATURE_FILE: &str = "manifest.json.sig";
/// Files the installer writes that cannot be listed in a manifest that signs itself.
const UNLISTED_OK: [&str; 3] = [MANIFEST_FILE, SIGNATURE_FILE, "uninstall.exe"];
const MAX_MANIFEST_BYTES: u64 = 1 << 20;
const MAX_FILES: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestSpec {
    pub max_tokens: u32,
    pub timeout_ms: u64,
    /// Extra top-level request keys (for example `chat_template_kwargs`), merged by Rust into the fixed body.
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub threads_max: u32,
    pub ctx_size: u32,
    pub cpu_rate_percent: u32,
    pub process_memory_limit_bytes: u64,
    pub min_available_memory_bytes: u64,
    pub sleep_idle_seconds: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub runtime_tag: String,
    pub model_id: String,
    /// Relative path of the model inside the install dir (a listed file).
    pub model_file: String,
    pub files: Vec<FileEntry>,
    pub total_bytes: u64,
    pub server_args: Vec<String>,
    pub request: RequestSpec,
    pub profile: Profile,
}

#[derive(Debug, Clone)]
pub struct VerifiedInstall {
    pub model_id: String,
    pub runtime_tag: String,
    pub manifest: Manifest,
}

/// Filesystem probes, injectable so tests need no 1 GB file and no real link.
pub struct Probes<'a> {
    /// Size counted against the budget for a file whose real length is the second argument.
    pub size_of: &'a dyn Fn(&Path, u64) -> u64,
    pub is_link: &'a dyn Fn(&Path) -> bool,
}

/// The updater public key (base64 of the minisign public key file), read once from `tauri.conf.json` at compile time.
/// Empty if it cannot be read, which fails closed (no signature verifies).
pub fn updater_pubkey() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../tauri.conf.json"))
            .ok()
            .and_then(|v| v["plugins"]["updater"]["pubkey"].as_str().map(str::to_owned))
            .unwrap_or_default()
    })
}

/// Reparse points (junctions, symlinks) redirect a path somewhere an owner check cannot vouch for.
#[cfg(windows)]
pub(crate) fn is_link(path: &Path) -> bool {
    crate::path_is_reparse_point(path)
}
#[cfg(not(windows))]
pub(crate) fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Tauri stores keys and signatures as base64 of the minisign text file; plain minisign text is accepted too.
fn minisign_text(s: &str) -> Result<String, ()> {
    let t = s.trim();
    if t.starts_with("untrusted comment:") {
        return Ok(format!("{t}\n"));
    }
    let bytes = BASE64_STANDARD.decode(t.replace(['\r', '\n'], "")).map_err(|_| ())?;
    String::from_utf8(bytes).map_err(|_| ())
}

fn signature_ok(manifest: &[u8], signature: &str, pubkey: &str) -> bool {
    let Ok(pk) = minisign_text(pubkey).and_then(|t| PublicKey::decode(&t).map_err(|_| ())) else { return false };
    let Ok(sig) = minisign_text(signature).and_then(|t| Signature::decode(&t).map_err(|_| ())) else { return false };
    pk.verify(manifest, &sig, false).is_ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// A manifest path is relative, forward-slash, and has no empty, `.`, `..` or drive/colon component.
fn safe_rel_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.contains(['\\', ':']) && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

fn read_capped(path: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    match std::fs::File::open(path) {
        Ok(f) => {
            let mut out = Vec::new();
            f.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut out).map_err(|_| "MANIFEST_INVALID")?;
            if out.len() as u64 > MAX_MANIFEST_BYTES {
                return Err("MANIFEST_INVALID");
            }
            Ok(Some(out))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("MANIFEST_INVALID"),
    }
}

/// Every file under `dir` (relative path with `/`, real length). A link anywhere is `UNTRUSTED_PATH`.
fn walk(dir: &Path, is_link: &dyn Fn(&Path) -> bool) -> Result<BTreeMap<String, (PathBuf, u64)>, &'static str> {
    fn rec(root: &Path, dir: &Path, is_link: &dyn Fn(&Path) -> bool, out: &mut BTreeMap<String, (PathBuf, u64)>) -> Result<(), &'static str> {
        for entry in std::fs::read_dir(dir).map_err(|_| "MANIFEST_INVALID")? {
            let path = entry.map_err(|_| "MANIFEST_INVALID")?.path();
            if is_link(&path) {
                return Err("UNTRUSTED_PATH");
            }
            let meta = std::fs::symlink_metadata(&path).map_err(|_| "MANIFEST_INVALID")?;
            if meta.is_dir() {
                rec(root, &path, is_link, out)?;
            } else if meta.is_file() {
                let rel = path.strip_prefix(root).map_err(|_| "MANIFEST_INVALID")?.to_string_lossy().replace('\\', "/");
                if out.len() >= MAX_FILES {
                    return Err("MANIFEST_INVALID");
                }
                out.insert(rel, (path, meta.len()));
            } else {
                return Err("MANIFEST_INVALID");
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    rec(dir, dir, is_link, &mut out)?;
    Ok(out)
}

/// Verifies the install at `dir` against `pubkey`. Order: signature, manifest shape, link-free walk, listed/unlisted,
/// budget (cheap, before hashing a model), SHA-256 of every listed file. `Err("NOT_INSTALLED")` only when there is no
/// manifest at all.
pub fn verify_install_with(dir: &Path, pubkey: &str, probes: &Probes) -> Result<VerifiedInstall, &'static str> {
    if (probes.is_link)(dir) {
        return Err("UNTRUSTED_PATH");
    }
    let Some(manifest_bytes) = read_capped(&dir.join(MANIFEST_FILE))? else { return Err("NOT_INSTALLED") };
    let sig_text = read_capped(&dir.join(SIGNATURE_FILE))?.and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
    if !signature_ok(&manifest_bytes, &sig_text, pubkey) {
        return Err("SIGNATURE_INVALID");
    }
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|_| "MANIFEST_INVALID")?;
    let mut listed = BTreeSet::new();
    let shape_ok = manifest.schema_version == 1
        && manifest.files.len() <= MAX_FILES
        && manifest.files.iter().all(|f| safe_rel_path(&f.path) && !UNLISTED_OK.contains(&f.path.as_str()) && listed.insert(f.path.as_str()))
        && listed.contains(manifest.model_file.as_str())
        && listed.contains(RUNTIME_EXE)
        && manifest.files.iter().fold(0u64, |a, f| a.saturating_add(f.bytes)) == manifest.total_bytes;
    if !shape_ok {
        return Err("MANIFEST_INVALID");
    }
    let found = walk(dir, probes.is_link)?;
    if found.keys().any(|p| !listed.contains(p.as_str()) && !UNLISTED_OK.contains(&p.as_str())) || listed.iter().any(|p| !found.contains_key(*p)) {
        return Err("MANIFEST_INVALID");
    }
    if manifest.files.iter().any(|f| found[&f.path].1 != f.bytes) {
        return Err("MANIFEST_INVALID");
    }
    let total = found.values().fold(0u64, |acc, (path, len)| acc.saturating_add((probes.size_of)(path, *len)));
    if total >= INSTALL_BUDGET_BYTES {
        return Err("OVER_BUDGET");
    }
    for f in &manifest.files {
        let (path, _) = &found[&f.path];
        match sha256_file(path) {
            Ok(h) if h.eq_ignore_ascii_case(&f.sha256) => {}
            _ => return Err("HASH_MISMATCH"),
        }
    }
    Ok(VerifiedInstall { model_id: manifest.model_id.clone(), runtime_tag: manifest.runtime_tag.clone(), manifest })
}

/// `verify_install_with` against the real filesystem and the embedded updater key.
pub fn verify_install(dir: &Path) -> Result<VerifiedInstall, &'static str> {
    verify_install_with(dir, updater_pubkey(), &Probes { size_of: &|_, len| len, is_link: &is_link })
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! A manifest signed with a throwaway key (`tauri signer sign`); OTHER_PUB is a second, unrelated key. The file
    //! hashes are those of the two tiny files `write_install` creates. Nothing here is a secret: both are public keys.
    pub const MANIFEST: &str = r#"{"schema_version":1,"runtime_tag":"b0000","model_id":"test-model","model_file":"models/m.gguf","files":[{"path":"models/m.gguf","sha256":"5496d6743cdde4fe98674e290e44b3220f5a42bf0c442eb207e88fd041e34d48","bytes":10},{"path":"runtime/llama-server.exe","sha256":"fecb0723792619aa19aab3f8642bf2f3334f6aa38cbaf2bb6ab34d8589aeddbf","bytes":8}],"total_bytes":18,"server_args":["--n-predict","160","--no-slots"],"request":{"max_tokens":160,"timeout_ms":8000,"extra":{"chat_template_kwargs":{"enable_thinking":false}}},"profile":{"threads_max":4,"ctx_size":2048,"cpu_rate_percent":50,"process_memory_limit_bytes":1400000000,"min_available_memory_bytes":1500000000,"sleep_idle_seconds":300}}"#;
    pub const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRT0E5OGpvUkRCdDdIV3JiMzU5c0VCTWkxaUtZUzJZWFYxbnBHclNja1RsL3V6dlhVQitXdkVselYvNHBEalRoOENkTkNsYllxWTM1MnA1a05KQWdaMWFsRStqTXlVa0FVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MTU3MTA4CWZpbGU6bWFuaWZlc3QuanNvbgpLbnNJQ3YyUTE1V1pnS3RqS3pERWZ3Lzd6anJsclBGSkRyenpmbm54Y1pRVjdrQVBHcVJKZkY3b2Q1YjNNK3lrY2cxUHpMWFhrU1o3dk1EeFdaaG1DQT09Cg==";
    pub const SIGNER_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI3QzExMEExMjNERjAzMEUKUldRT0E5OGpvUkRCdHdTZjJFdm9UYks4MTRCcnlZUGNrRDZFU3NNSVU5R2lRSkh0NWtBaEMwNnkK";
    pub const OTHER_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk3QjBBQTk2MkY0Qzk4RTcKUldUbm1Fd3ZscXF3bDkvZUtUcElyOGxGWWdBcklueE4xNjlYaFBIekhZUjBlMDhwWWlHKzlGVTIK";
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    /// A fresh temp dir holding the signed fixture install; removed on drop.
    struct Install(PathBuf);
    impl Install {
        fn new() -> Install {
            let root = std::env::temp_dir().join(format!("pos-assistant-test-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(root.join("models")).unwrap();
            std::fs::create_dir_all(root.join("runtime")).unwrap();
            std::fs::write(root.join("models/m.gguf"), b"fake-model").unwrap();
            std::fs::write(root.join("runtime/llama-server.exe"), b"fake-exe").unwrap();
            std::fs::write(root.join(MANIFEST_FILE), MANIFEST).unwrap();
            std::fs::write(root.join(SIGNATURE_FILE), SIGNATURE).unwrap();
            Install(root)
        }
        fn verify(&self, pubkey: &str) -> Result<VerifiedInstall, &'static str> {
            verify_install_with(&self.0, pubkey, &Probes { size_of: &|_, len| len, is_link: &|_| false })
        }
    }
    impl Drop for Install {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn verify_install_accepts_a_signed_untouched_install() {
        let i = Install::new();
        let v = i.verify(SIGNER_PUB).expect("valid install");
        assert_eq!((v.model_id.as_str(), v.runtime_tag.as_str()), ("test-model", "b0000"));
        assert_eq!(v.manifest.profile.threads_max, 4);
    }

    #[test]
    fn verify_install_allows_the_uninstaller_unlisted() {
        let i = Install::new();
        std::fs::write(i.0.join("uninstall.exe"), b"x").unwrap();
        assert!(i.verify(SIGNER_PUB).is_ok());
    }

    #[test]
    fn tampered_file_refuses() {
        let i = Install::new();
        std::fs::write(i.0.join("models/m.gguf"), b"fake-modeL").unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "HASH_MISMATCH");
        let i = Install::new();
        std::fs::write(i.0.join("runtime/llama-server.exe"), b"fake-exE").unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "HASH_MISMATCH");
    }

    #[test]
    fn edited_manifest_refuses() {
        let i = Install::new();
        std::fs::write(i.0.join(MANIFEST_FILE), MANIFEST.replace("\"b0000\"", "\"b0001\"")).unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "SIGNATURE_INVALID");
    }

    #[test]
    fn foreign_key_signature_refuses() {
        let i = Install::new();
        assert_eq!(i.verify(OTHER_PUB).unwrap_err(), "SIGNATURE_INVALID");
        assert_eq!(i.verify("").unwrap_err(), "SIGNATURE_INVALID");
    }

    #[test]
    fn missing_or_garbage_signature_refuses() {
        let i = Install::new();
        std::fs::write(i.0.join(SIGNATURE_FILE), "not a signature").unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "SIGNATURE_INVALID");
        std::fs::remove_file(i.0.join(SIGNATURE_FILE)).unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "SIGNATURE_INVALID");
    }

    #[test]
    fn no_manifest_is_not_installed() {
        let i = Install::new();
        std::fs::remove_file(i.0.join(MANIFEST_FILE)).unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "NOT_INSTALLED");
    }

    #[test]
    fn unlisted_file_refuses() {
        let i = Install::new();
        std::fs::write(i.0.join("runtime/extra.dll"), b"x").unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "MANIFEST_INVALID");
    }

    #[test]
    fn missing_listed_file_refuses() {
        let i = Install::new();
        std::fs::remove_file(i.0.join("models/m.gguf")).unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "MANIFEST_INVALID");
    }

    #[test]
    fn link_entry_refuses() {
        let i = Install::new();
        let r = verify_install_with(&i.0, SIGNER_PUB, &Probes { size_of: &|_, len| len, is_link: &|p| p.ends_with("llama-server.exe") });
        assert_eq!(r.unwrap_err(), "UNTRUSTED_PATH");
        let r = verify_install_with(&i.0, SIGNER_PUB, &Probes { size_of: &|_, len| len, is_link: &|p| p == i.0 });
        assert_eq!(r.unwrap_err(), "UNTRUSTED_PATH");
    }

    #[test]
    fn over_budget_refuses() {
        let i = Install::new();
        let big = |p: &Path, len: u64| if p.ends_with("m.gguf") { INSTALL_BUDGET_BYTES - 10 } else { len };
        let r = verify_install_with(&i.0, SIGNER_PUB, &Probes { size_of: &big, is_link: &|_| false });
        assert_eq!(r.unwrap_err(), "OVER_BUDGET", "10 + 8 + manifest + sig bytes is at least the budget");
        let just_under = |p: &Path, len: u64| if p.ends_with("m.gguf") { INSTALL_BUDGET_BYTES - 1_000_000 } else { len };
        assert!(verify_install_with(&i.0, SIGNER_PUB, &Probes { size_of: &just_under, is_link: &|_| false }).is_ok());
    }

    #[test]
    fn inconsistent_sizes_refuse() {
        let i = Install::new();
        // a file whose length differs from the signed list (same signed manifest, different content length)
        std::fs::write(i.0.join("models/m.gguf"), b"fake-model!").unwrap();
        assert_eq!(i.verify(SIGNER_PUB).unwrap_err(), "MANIFEST_INVALID");
    }

    #[test]
    fn manifest_paths_must_be_relative_and_plain() {
        for bad in ["", "/etc/x", "../x", "a/../b", "a\\b", "C:/x", "a//b", "./a"] {
            assert!(!safe_rel_path(bad), "{bad:?}");
        }
        assert!(safe_rel_path("runtime/llama-server.exe"));
    }

    #[test]
    fn unknown_manifest_key_is_refused_by_the_type() {
        let with_extra = MANIFEST.replacen("\"schema_version\":1", "\"schema_version\":1,\"evil\":true", 1);
        assert!(serde_json::from_str::<Manifest>(&with_extra).is_err());
        assert!(serde_json::from_str::<Manifest>(MANIFEST).is_ok());
    }

    #[test]
    fn embedded_updater_key_is_a_decodable_minisign_key() {
        let text = minisign_text(updater_pubkey()).expect("tauri.conf.json carries the updater pubkey");
        assert!(PublicKey::decode(&text).is_ok());
    }
}
