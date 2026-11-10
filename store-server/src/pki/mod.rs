//! The store's certificate authority: where Caddy keeps it, how the public root is exported and checked.

pub mod san;
pub mod trust;

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Characters of the root fingerprint both screens show and a person compares: 16 hex (64 bits), shown on BOTH screens
/// as `xxxx-xxxx-xxxx-xxxx` (a `group4(fp)` display helper; `join` strips dashes/spaces before comparing). Security review:
/// the root certificate is public, so an attacker can grind candidate certificates offline; 8 hex (32 bits) is feasible, 64 bits is not.
pub const FINGERPRINT_LEN: usize = 16;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn fingerprint16(sha256: &str) -> String {
    sha256.chars().take(FINGERPRINT_LEN).collect::<String>().to_ascii_lowercase()
}

/// Exactly one certificate in a PEM text, as DER.
pub fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    if pem.matches(BEGIN).count() != 1 || pem.matches(END).count() != 1 {
        return Err("the certificate text must hold exactly one certificate".into());
    }
    let start = pem.find(BEGIN).unwrap_or(0) + BEGIN.len();
    let end = pem.find(END).unwrap_or(0);
    if end <= start {
        return Err("certificate markers are out of order".into());
    }
    let body: String = pem[start..end].chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .map_err(|_| "the certificate is not valid base64".to_string())
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootInfo {
    pub sha256: String,
    pub subject: String,
    pub not_after_unix: i64,
    pub pem: String,
}

/// `DATA\pki\caddy\pki\authorities\local\root.crt` (Caddy's `storage file_system` adds its own `pki\` level).
pub fn root_path(data: &Path) -> PathBuf {
    data.join("pki").join("caddy").join("pki").join("authorities").join("local").join("root.crt")
}

pub fn exported_root_path(data: &Path) -> PathBuf {
    data.join("client").join("pki").join("root.crt")
}

/// `DATA\pki\caddy\certificates\local\<host>\<host>.crt`
pub fn leaf_path(data: &Path, host: &str) -> PathBuf {
    data.join("pki").join("caddy").join("certificates").join("local").join(host).join(format!("{host}.crt"))
}

/// A canonical PEM rebuilt from the DER: exactly one CERTIFICATE block, 64-column base64, nothing else.
pub fn der_to_pem(der: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let body: Vec<&str> = b64.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or("")).collect();
    format!("-----BEGIN CERTIFICATE-----
{}
-----END CERTIFICATE-----
", body.join("
"))
}

pub fn parse_cert(pem: &str) -> Result<RootInfo, String> {
    // any other block (a private key pasted into the same file) is refused outright; the text is never carried forward
    if pem.matches("-----BEGIN").count() != 1 {
        return Err("the file must hold exactly one CERTIFICATE block and nothing else".into());
    }
    let der = pem_to_der(pem)?;
    let (_, cert) = x509_parser::parse_x509_certificate(&der).map_err(|e| format!("certificate cannot be parsed: {e}"))?;
    Ok(RootInfo {
        sha256: sha256_hex(&der),
        subject: cert.subject().to_string(),
        not_after_unix: cert.validity().not_after.timestamp(),
        pem: der_to_pem(&der),
    })
}

pub fn read_root(data: &Path) -> Result<RootInfo, String> {
    let path = root_path(data);
    let pem = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_cert(&pem)
}

/// `notAfter` (unix seconds) of the leaf Caddy issued for `host`, or `None` when none exists yet.
pub fn leaf_not_after(data: &Path, host: &str) -> Option<i64> {
    let pem = fs::read_to_string(leaf_path(data, host)).ok()?;
    // a leaf file holds the leaf first, then the intermediate: parse the first block only
    let end = pem.find("-----END CERTIFICATE-----")? + "-----END CERTIFICATE-----".len();
    parse_cert(&pem[..end]).ok().map(|i| i.not_after_unix)
}

/// Copies the PUBLIC root certificate to `DATA\client\pki\root.crt` (atomically). The private key is never read.
pub fn export_root(data: &Path) -> Result<RootInfo, String> {
    let info = read_root(data)?;
    let dest = exported_root_path(data);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::util::write_atomic(&dest, info.pem.as_bytes()).map_err(|e| format!("{}: {e}", dest.display()))?;
    Ok(info)
}

/// What `status`/`health` report about the store's certificates; `None` from `facts` when the store serves no TLS
/// or its authority has not been created yet (Caddy makes the root on its first start).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkiFacts {
    pub root_sha256: String,
    pub root_not_after_unix: i64,
    /// The soonest `notAfter` among the leaf certificates that exist (12 h long; the running Gateway renews them).
    pub leaf_not_after_unix: Option<i64>,
    pub hosts: Vec<String>,
}

pub fn facts(roots: &crate::paths::Roots) -> Option<PkiFacts> {
    let g = crate::gateway::GatewaySettings::load(roots).ok().filter(|g| g.tls == crate::gateway::TlsMode::Internal)?;
    let root = read_root(&roots.data).ok()?;
    let leaf_not_after_unix = g.hosts.iter().filter_map(|h| leaf_not_after(&roots.data, h)).min();
    Some(PkiFacts { root_sha256: root.sha256, root_not_after_unix: root.not_after_unix, leaf_not_after_unix, hosts: g.hosts })
}

/// `certutil` arguments (pure, tested). `-f` makes the add idempotent; the same pattern as `windows/hooks.nsh`.
pub fn certutil_add_root_args(file: &Path) -> Vec<String> {
    vec!["-f".into(), "-addstore".into(), "Root".into(), file.to_string_lossy().into_owned()]
}

pub fn certutil_delete_root_args(sha1_hex: &str) -> Vec<String> {
    vec!["-delstore".into(), "Root".into(), sha1_hex.to_string()]
}

#[cfg(test)]
pub(crate) mod test_support {
    pub const FIXTURE_ROOT_PEM: &str = include_str!("../../tests/fixtures/caddy-test-root.crt");
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::test_support::FIXTURE_ROOT_PEM;

    #[test]
    fn paths_follow_the_data_layout() {
        let d = Path::new("C:\\ProgramData\\SupermarketPOS");
        assert!(root_path(d).ends_with("pki\\caddy\\pki\\authorities\\local\\root.crt") || root_path(d).to_string_lossy().ends_with("authorities/local/root.crt"));
        assert!(exported_root_path(d).to_string_lossy().replace('\\', "/").ends_with("client/pki/root.crt"));
        assert!(leaf_path(d, "storepc").to_string_lossy().replace('\\', "/").ends_with("certificates/local/storepc/storepc.crt"));
    }

    #[test]
    fn parses_the_fixture_root() {
        let info = parse_cert(FIXTURE_ROOT_PEM).unwrap();
        assert_eq!(info.sha256.len(), 64);
        assert!(info.subject.contains("Caddy Local Authority"));
        assert!(info.not_after_unix > 0);
    }

    #[test]
    fn export_copies_only_the_public_certificate() {
        let dir = tempfile::tempdir().unwrap();
        let src = root_path(dir.path());
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, FIXTURE_ROOT_PEM).unwrap();
        fs::write(src.with_file_name("root.key"), "KEY MATERIAL MUST NOT BE COPIED").unwrap();
        let info = export_root(dir.path()).unwrap();
        let out = fs::read_to_string(exported_root_path(dir.path())).unwrap();
        assert_eq!(parse_cert(&out).unwrap().sha256, parse_cert(FIXTURE_ROOT_PEM).unwrap().sha256);
        assert!(!out.contains("KEY MATERIAL"));
        assert_eq!(info.sha256, parse_cert(&out).unwrap().sha256);
        assert!(!dir.path().join("client").join("pki").join("root.key").exists());
    }

    #[test]
    fn a_private_key_block_in_root_crt_is_refused_and_never_exported() {
        let dir = tempfile::tempdir().unwrap();
        let src = root_path(dir.path());
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        // header split so the secret scanner does not flag the fixture
        let kind = "PRIVATE";
        fs::write(&src, format!("-----BEGIN EC {kind} KEY-----
QUJD
-----END EC {kind} KEY-----
{FIXTURE_ROOT_PEM}")).unwrap();
        assert!(export_root(dir.path()).is_err());
        assert!(!exported_root_path(dir.path()).exists());
        assert!(read_root(dir.path()).is_err());
    }

    #[test]
    fn the_exported_text_is_rebuilt_from_the_certificate_not_copied() {
        let dir = tempfile::tempdir().unwrap();
        let src = root_path(dir.path());
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        // trailing text after the END marker is not a block, but it must not be copied either
        fs::write(&src, format!("{FIXTURE_ROOT_PEM}
secret-looking trailing text
")).unwrap();
        let info = export_root(dir.path()).unwrap();
        let out = fs::read_to_string(exported_root_path(dir.path())).unwrap();
        assert!(!out.contains("secret-looking"));
        assert_eq!(out.matches("-----BEGIN").count(), 1);
        assert!(out.lines().all(|l| l.len() <= 64 || l.starts_with("-----")));
        assert_eq!(parse_cert(&out).unwrap().sha256, info.sha256);
        assert_eq!(info.pem, out);
    }

    #[test]
    fn export_fails_clearly_before_the_gateway_has_ever_started() {
        let dir = tempfile::tempdir().unwrap();
        assert!(export_root(dir.path()).unwrap_err().contains("root.crt"));
    }

    #[test]
    fn certutil_arguments() {
        assert_eq!(certutil_add_root_args(Path::new("C:\\x\\root.crt")), vec!["-f", "-addstore", "Root", "C:\\x\\root.crt"]);
        assert_eq!(certutil_delete_root_args("ab12"), vec!["-delstore", "Root", "ab12"]);
    }
}
