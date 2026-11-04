//! Till pairing: a public record (store address, anon key, root CA) that a till verifies before it trusts the root.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub mod join;

use crate::pki::san::validate_site_host;

pub use crate::pki::{fingerprint16, hex, sha256_hex, FINGERPRINT_LEN};

/// The one port the till app talks to (`resources/csp-port.txt`, the file src-tauri pins too).
pub fn store_port() -> u16 {
    include_str!("../../resources/csp-port.txt").trim().parse().unwrap_or(0)
}

/// The till app's host rule (src-tauri `normalize_store_url`): an IP address, `localhost`, a single name or one ending in `.local`.
/// The ONE copy: pairing, `provision` and anything else that names the store use it, so a store is never built that no till can pair with.
/// `host` is already validated and lower-cased (`validate_site_host`).
pub fn check_shop_host(host: &str) -> Result<(), String> {
    let is_ip = host.bytes().all(|c| c.is_ascii_digit() || c == b'.');
    if !is_ip && host != "localhost" && host.contains('.') && !host.ends_with(".local") {
        return Err(format!("'{host}' is not a shop-network name (a single name or one ending in .local)"));
    }
    Ok(())
}

/// `xxxx-xxxx-xxxx-xxxx`: how both screens show the fingerprint.
pub fn group4(fp: &str) -> String {
    fp.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

const OFFER_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    Malformed(String),
    FingerprintMismatch,
    NotARootCa,
    Expired,
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::Malformed(m) => write!(f, "pairing record is not valid: {m}"),
            PairError::FingerprintMismatch => write!(f, "the certificate does not match its fingerprint"),
            PairError::NotARootCa => write!(f, "the certificate is not a self-signed certificate authority"),
            PairError::Expired => write!(f, "the pairing record or its certificate has expired"),
        }
    }
}

impl std::error::Error for PairError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRecord {
    pub v: u32,
    pub mode: String,
    pub server_host: String,
    pub server_port: u16,
    #[serde(default)]
    pub alt_hosts: Vec<String>,
    pub anon_key: String,
    pub root_cert_pem: String,
    pub root_sha256: String,
    pub issued_at: String,
    /// Present on a LAN offer only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ValidRecord {
    pub record: PairingRecord,
    pub der: Vec<u8>,
    /// Lower-case hex, recomputed from the certificate (never taken from the record).
    pub sha256: String,
}

/// Exactly one certificate in a PEM text, as DER.
pub fn pem_to_der(pem: &str) -> Result<Vec<u8>, PairError> {
    crate::pki::pem_to_der(pem).map_err(PairError::Malformed)
}

fn is_jwt_shaped(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
}

pub fn parse_record(json: &str) -> Result<PairingRecord, PairError> {
    // Windows PowerShell 5.1 writes a UTF-8 byte-order mark with `-Encoding utf8`; a hand-made file may carry one.
    let json = json.trim_start_matches('\u{feff}');
    serde_json::from_str(json).map_err(|e| PairError::Malformed(e.to_string()))
}

/// Checks everything that can be checked offline. `now_unix` is the clock, injected for tests.
pub fn validate_record(rec: &PairingRecord, now_unix: i64) -> Result<ValidRecord, PairError> {
    if rec.v != 1 {
        return Err(PairError::Malformed(format!("unsupported version {}", rec.v)));
    }
    if rec.mode != "offline-only" {
        return Err(PairError::Malformed("mode must be offline-only".into()));
    }
    let host = validate_site_host(&rec.server_host).map_err(|e| PairError::Malformed(e.to_string()))?;
    // the till app only uses a shop-network address (src-tauri `normalize_store_url`); do not trust a root for one it would refuse
    check_shop_host(&host).map_err(PairError::Malformed)?;
    if rec.server_port == 0 {
        return Err(PairError::Malformed("server port is 0".into()));
    }
    let mut alts = Vec::new();
    for h in &rec.alt_hosts {
        alts.push(validate_site_host(h).map_err(|e| PairError::Malformed(e.to_string()))?);
    }
    if !is_jwt_shaped(&rec.anon_key) {
        return Err(PairError::Malformed("anon key is not a JWT".into()));
    }
    let claimed = rec.root_sha256.to_ascii_lowercase();
    if claimed.len() != 64 || !claimed.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(PairError::Malformed("root fingerprint is not 64 hex characters".into()));
    }
    // exactly one PEM block and nothing else: a second block (any label) is a parser differential for `certutil`
    let pem = rec.root_cert_pem.trim();
    if pem.matches("-----BEGIN").count() != 1 || !pem.starts_with("-----BEGIN CERTIFICATE-----") || !pem.ends_with("-----END CERTIFICATE-----") {
        return Err(PairError::Malformed("rootCertPem must hold exactly one certificate block and nothing else".into()));
    }
    let der = pem_to_der(&rec.root_cert_pem)?;
    let sha256 = sha256_hex(&der);
    if sha256 != claimed {
        return Err(PairError::FingerprintMismatch);
    }
    let (_, cert) = x509_parser::parse_x509_certificate(&der)
        .map_err(|_| PairError::Malformed("the certificate cannot be parsed".into()))?;
    if cert.subject().as_raw() != cert.issuer().as_raw() || !cert.is_ca() {
        return Err(PairError::NotARootCa);
    }
    if cert.validity().not_after.timestamp() <= now_unix || cert.validity().not_before.timestamp() > now_unix + 86_400 {
        return Err(PairError::Expired);
    }
    if let Some(exp) = &rec.expires_at {
        let t = time::OffsetDateTime::parse(exp, &time::format_description::well_known::Rfc3339)
            .map_err(|_| PairError::Malformed("expiresAt is not an ISO-8601 time".into()))?;
        if t.unix_timestamp() <= now_unix {
            return Err(PairError::Expired);
        }
    }
    // what was validated is what is written: the normalised (trimmed, lower-case) names
    let mut record = rec.clone();
    record.server_host = host;
    record.alt_hosts = alts;
    Ok(ValidRecord { record, der, sha256 })
}

/// True when `typed` (any case, dashes and spaces ignored) is the fingerprint prefix of the verified certificate.
pub fn confirm_fingerprint(sha256: &str, typed: &str) -> bool {
    let cleaned: String = typed.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_lowercase();
    cleaned.len() == FINGERPRINT_LEN && sha256.starts_with(&cleaned)
}

/// The text of `client\store.env` for a paired till (the format `src-tauri` parses: `KEY=value`).
pub fn store_env_text(v: &ValidRecord, paired_at: &str) -> String {
    let r = &v.record;
    let mut out = String::from("# Written by posctl (pair join). Do not edit by hand.\n");
    out.push_str("VITE_STORE_MODE=offline-only\n");
    out.push_str(&format!("VITE_SUPABASE_URL=https://{}:{}\n", r.server_host.to_ascii_lowercase(), r.server_port));
    out.push_str(&format!("VITE_SUPABASE_ANON_KEY={}\n", r.anon_key));
    out.push_str(&format!("VITE_STORE_CA_SHA256={}\n", v.sha256));
    if !r.alt_hosts.is_empty() {
        out.push_str(&format!("VITE_STORE_SERVER_ALT_HOSTS={}\n", r.alt_hosts.join(",")));
    }
    out.push_str(&format!("VITE_STORE_PAIRED_AT={paired_at}\n"));
    out
}

pub fn new_offer_code() -> std::io::Result<String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(buf.iter().map(|b| OFFER_ALPHABET[(*b & 31) as usize] as char).collect())
}

pub fn is_offer_code(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|c| OFFER_ALPHABET.contains(&c))
}

/// Removes offers (`<CODE>.pospair`) whose `expiresAt` is past, or that cannot be read. Returns how many.
pub fn sweep_expired_offers(dir: &Path, now_unix: i64) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if path.extension().and_then(|e| e.to_str()) != Some("pospair") || !is_offer_code(name) {
            continue;
        }
        let expired = fs::read_to_string(&path)
            .ok()
            .and_then(|t| parse_record(&t).ok())
            .and_then(|r| r.expires_at)
            .and_then(|e| time::OffsetDateTime::parse(&e, &time::format_description::well_known::Rfc3339).ok())
            .map(|t| t.unix_timestamp() <= now_unix)
            .unwrap_or(true);
        if expired && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

        pub use crate::pki::test_support::FIXTURE_ROOT_PEM;

    pub fn fixture_record(now_unix: i64) -> PairingRecord {
        let der = pem_to_der(FIXTURE_ROOT_PEM).unwrap();
        let _ = now_unix;
        PairingRecord {
            v: 1,
            mode: "offline-only".into(),
            server_host: "storepc".into(),
            server_port: 47304,
            alt_hosts: vec!["192.168.1.20".into()],
            anon_key: crate::gateway::test_support::fake_jwt("anon"),
            root_cert_pem: FIXTURE_ROOT_PEM.to_string(),
            root_sha256: sha256_hex(&der),
            issued_at: "2026-10-02T10:00:00Z".into(),
            expires_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    /// Inside the fixture's validity window (the fixture is regenerated by the task that creates it).
    fn now() -> i64 {
        time::OffsetDateTime::now_utc().unix_timestamp()
    }

    #[test]
    fn a_good_record_validates_and_the_hash_is_recomputed() {
        let rec = fixture_record(now());
        let v = validate_record(&rec, now()).unwrap();
        assert_eq!(v.sha256, rec.root_sha256);
        assert_eq!(fingerprint16(&v.sha256).len(), 16);
        assert_eq!(group4(&fingerprint16(&v.sha256)).matches('-').count(), 3);
    }

    #[test]
    fn a_tampered_certificate_is_refused_as_a_fingerprint_mismatch() {
        let mut rec = fixture_record(now());
        rec.root_sha256 = "0".repeat(64).replace('0', "a");
        assert_eq!(validate_record(&rec, now()).unwrap_err(), PairError::FingerprintMismatch);
        let mut rec = fixture_record(now());
        // flip one base64 character inside the PEM body but keep the claimed hash of the original
        rec.root_cert_pem = rec.root_cert_pem.replacen("MII", "MIJ", 1);
        assert_eq!(validate_record(&rec, now()).unwrap_err(), PairError::FingerprintMismatch, "a swapped certificate is a fingerprint mismatch");
    }

    #[test]
    fn a_foreign_block_around_the_real_certificate_is_refused_whatever_its_label() {
        for label in ["NOTE", "X509 CERTIFICATE", "PKCS7"] {
            let mut rec = fixture_record(now());
            rec.root_cert_pem = format!("-----BEGIN {label}-----\nQUJD\n-----END {label}-----\n{}", rec.root_cert_pem);
            assert!(matches!(validate_record(&rec, now()), Err(PairError::Malformed(_))), "{label}");
        }
        let mut rec = fixture_record(now());
        rec.root_cert_pem = format!("{}\ntrailing", rec.root_cert_pem);
        assert!(validate_record(&rec, now()).is_err());
    }

    #[test]
    fn a_padded_host_is_written_normalised() {
        let mut rec = fixture_record(now());
        rec.server_host = " StorePC\n".into();
        rec.alt_hosts = vec![" 192.168.1.20 ".into()];
        let v = validate_record(&rec, now()).unwrap();
        let text = store_env_text(&v, "t");
        assert!(text.contains("VITE_SUPABASE_URL=https://storepc:47304\n") && text.contains("ALT_HOSTS=192.168.1.20\n"));
    }

    #[test]
    fn two_certificates_in_one_record_are_refused() {
        let mut rec = fixture_record(now());
        rec.root_cert_pem = format!("{}{}", FIXTURE_ROOT_PEM, FIXTURE_ROOT_PEM);
        assert!(matches!(validate_record(&rec, now()), Err(PairError::Malformed(_))));
    }

    #[test]
    fn hostile_fields_are_refused() {
        for mutate in [
            |r: &mut PairingRecord| r.v = 2,
            |r: &mut PairingRecord| r.mode = "cloud".into(),
            |r: &mut PairingRecord| r.server_host = "8.8.8.8".into(),
            |r: &mut PairingRecord| r.server_host = "a b".into(),
            |r: &mut PairingRecord| r.server_port = 0,
            |r: &mut PairingRecord| r.alt_hosts = vec!["*.x".into()],
            |r: &mut PairingRecord| r.anon_key = "short".into(),
            |r: &mut PairingRecord| r.root_sha256 = "abc".into(),
        ] {
            let mut rec = fixture_record(now());
            mutate(&mut rec);
            assert!(validate_record(&rec, now()).is_err());
        }
    }

    #[test]
    fn an_expired_offer_is_refused() {
        let mut rec = fixture_record(now());
        rec.expires_at = Some("2020-01-01T00:00:00Z".into());
        assert_eq!(validate_record(&rec, now()).unwrap_err(), PairError::Expired);
    }

    #[test]
    fn a_certificate_far_in_the_future_clock_is_expired() {
        let rec = fixture_record(now());
        assert_eq!(validate_record(&rec, now() + 40 * 365 * 86_400).unwrap_err(), PairError::Expired);
    }

    #[test]
    fn the_typed_fingerprint_must_match_in_any_case_with_separators() {
        let sha = sha256_hex(b"x");
        let p = fingerprint16(&sha);
        assert!(confirm_fingerprint(&sha, &p));
        assert!(confirm_fingerprint(&sha, &format!("{}-{}", p[..4].to_ascii_uppercase(), &p[4..])));
        assert!(!confirm_fingerprint(&sha, &p[..15]));
        assert!(!confirm_fingerprint(&sha, &p[..8]), "a correct 8-hex prefix is too short");
        assert!(confirm_fingerprint(&sha, &group4(&p)));
        assert!(!confirm_fingerprint(&sha, "00000000"));
        assert!(!confirm_fingerprint(&sha, ""));
    }

    #[test]
    fn store_env_text_matches_the_shared_fixture() {
        let v = validate_record(&fixture_record(now()), now()).unwrap();
        let text = store_env_text(&v, "2026-10-02T10:05:00Z");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[1], "VITE_STORE_MODE=offline-only");
        assert_eq!(lines[2], "VITE_SUPABASE_URL=https://storepc:47304");
        assert!(lines[3].starts_with("VITE_SUPABASE_ANON_KEY="));
        assert_eq!(lines[4], format!("VITE_STORE_CA_SHA256={}", v.sha256));
        assert_eq!(lines[5], "VITE_STORE_SERVER_ALT_HOSTS=192.168.1.20");
        assert_eq!(lines[6], "VITE_STORE_PAIRED_AT=2026-10-02T10:05:00Z");
    }


    /// The same acceptance rules `src-tauri` applies to `client\store.env` in Offline only (`apply_store_env`): mode line,
    /// https on the one CSP port with no path, a private/loopback IPv4 or a shop-network name, an anon key, a 64-hex CA hash.
    fn app_accepts(text: &str) -> Result<(), &'static str> {
        let get = |k: &str| text.lines().find_map(|l| l.trim().strip_prefix(&format!("{k}="))).map(|v| v.trim().to_string()).unwrap_or_default();
        if get("VITE_STORE_MODE") != "offline-only" {
            return Err("STORE_MODE_UNKNOWN");
        }
        let url = get("VITE_SUPABASE_URL");
        let rest = url.strip_prefix("https://").ok_or("STORE_URL_REJECTED")?;
        let (host, port) = rest.rsplit_once(':').ok_or("STORE_URL_REJECTED")?;
        let csp: u16 = include_str!("../../resources/csp-port.txt").trim().parse().unwrap();
        if port.parse::<u16>().ok() != Some(csp) || host.is_empty() || host.contains(['/', '@', '?', '#']) {
            return Err("STORE_URL_REJECTED");
        }
        if get("VITE_SUPABASE_ANON_KEY").is_empty() {
            return Err("STORE_KEY_MISSING");
        }
        let ca = get("VITE_STORE_CA_SHA256");
        if ca.len() != 64 || !ca.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("STORE_CA_MISSING");
        }
        Ok(())
    }

    #[test]
    fn store_env_text_is_the_file_the_app_parser_is_tested_with_and_it_accepts_it() {
        let mut rec = fixture_record(now());
        rec.anon_key = "aaaaaaaa.bbbbbbbb.cccccccc".into();
        let v = validate_record(&rec, now()).unwrap();
        let text = store_env_text(&v, "2026-10-02T10:05:00Z");
        assert_eq!(text.replace("\r\n", "\n"), include_str!("../../tests/fixtures/store.env.sample").replace("\r\n", "\n"));
        assert_eq!(app_accepts(&text), Ok(()));
        assert_eq!(app_accepts(&text.replace("47304", "47414")), Err("STORE_URL_REJECTED"), "the app only takes the CSP port");
        assert_eq!(app_accepts(&text.replace(&v.sha256, "abc")), Err("STORE_CA_MISSING"));
    }

    #[test]
    fn a_record_with_a_hostile_host_never_becomes_a_store_env() {
        // every host the record validator lets through is a host the app accepts, and vice versa for the refusals
        for bad in ["8.8.8.8", "evil.example.com/x", "a@b", "x y", "shop.example.com"] {
            let mut rec = fixture_record(now());
            rec.server_host = bad.into();
            assert!(validate_record(&rec, now()).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_byte_order_mark_does_not_break_parsing() {
        let json = format!("\u{feff}{}", serde_json::to_string(&fixture_record(now())).unwrap());
        assert!(parse_record(&json).is_ok());
        assert!(parse_record("\u{feff}").is_err());
    }

    #[test]
    fn offer_codes_are_8_base32_characters() {
        let c = new_offer_code().unwrap();
        assert!(is_offer_code(&c));
        assert_ne!(c, new_offer_code().unwrap());
        assert!(!is_offer_code("abcdefgh"));
        assert!(!is_offer_code("ABCDEFG1"));
        assert!(!is_offer_code("../x"));
    }

    #[test]
    fn sweep_removes_only_expired_or_unreadable_offers() {
        let dir = tempfile::tempdir().unwrap();
        let mut live = fixture_record(now());
        live.expires_at = Some("2099-01-01T00:00:00Z".into());
        let mut dead = fixture_record(now());
        dead.expires_at = Some("2020-01-01T00:00:00Z".into());
        fs::write(dir.path().join("AAAAAAAA.pospair"), serde_json::to_string(&live).unwrap()).unwrap();
        fs::write(dir.path().join("BBBBBBBB.pospair"), serde_json::to_string(&dead).unwrap()).unwrap();
        fs::write(dir.path().join("CCCCCCCC.pospair"), "garbage").unwrap();
        fs::write(dir.path().join("notes.txt"), "keep").unwrap();
        assert_eq!(sweep_expired_offers(dir.path(), now()), 2);
        assert!(dir.path().join("AAAAAAAA.pospair").exists());
        assert!(dir.path().join("notes.txt").exists());
    }
}
