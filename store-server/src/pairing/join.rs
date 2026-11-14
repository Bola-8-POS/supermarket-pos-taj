//! `pair join`: verify a pairing record, install its root CA, write the till's `store.env`.
//! Nothing is installed or written until every check has passed.

use std::fs;
use std::path::{Path, PathBuf};

use super::{confirm_fingerprint, fingerprint16, parse_record, store_env_text, validate_record, PairError};
pub use crate::pki::trust::{CertutilStore, RootStore};

pub enum Confirm {
    /// What a person read off the server screen (any case; dashes and spaces ignored).
    Fingerprint(String),
    /// The file came from the owner on a channel the owner trusts (USB stick). Never used for a LAN-fetched offer.
    TrustFile,
}

pub struct JoinInput<'a> {
    pub record_json: &'a str,
    pub confirm: Confirm,
    pub client_dir: &'a Path,
    pub now_unix: i64,
    pub paired_at: &'a str,
    /// False under `--dev`: the machine's certificate store is never touched.
    pub install_trust: bool,
}

#[derive(Debug)]
pub struct JoinOutput {
    pub server_url: String,
    pub root_sha256: String,
    pub fingerprint16: String,
    pub trust_installed: bool,
    pub store_env: PathBuf,
    /// SHA-256 of the root of a store this till was paired with before, when it differs from the new one.
    pub previous_root: Option<String>,
    /// What became of that old root: `removed`, `absent` (not in the trusted roots), `unproven` (no copy of it on disk to prove
    /// it was ours) or `failed: <why>` (the till IS paired to the new store; the old root is still trusted).
    pub previous_root_outcome: Option<String>,
}

#[derive(Debug)]
pub struct LeaveOutput {
    pub was_paired: bool,
    pub root_sha256: Option<String>,
    /// `removed`, `absent`, `unproven`, or `untouched` (--dev: the certificate store is never called).
    pub root_outcome: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinError {
    /// Exit 50 `PAIR_FAILED`.
    Failed(String),
    /// Exit 51 `PAIR_FINGERPRINT_MISMATCH`.
    Mismatch(String),
}

impl JoinError {
    pub fn exit(&self) -> i32 {
        match self {
            JoinError::Failed(_) => 50,
            JoinError::Mismatch(_) => 51,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            JoinError::Failed(_) => "PAIR_FAILED",
            JoinError::Mismatch(_) => "PAIR_FINGERPRINT_MISMATCH",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            JoinError::Failed(m) | JoinError::Mismatch(m) => m,
        }
    }
}

impl From<PairError> for JoinError {
    fn from(e: PairError) -> Self {
        match e {
            PairError::FingerprintMismatch => JoinError::Mismatch(e.to_string()),
            other => JoinError::Failed(other.to_string()),
        }
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::util::write_atomic(path, text.as_bytes())
}

/// Every check that needs no write: parse, validate, and (for a typed fingerprint) compare. `pair join` runs this before it
/// creates or protects any folder, and `join` runs it again before it installs anything.
pub fn verify(input: &JoinInput<'_>) -> Result<super::ValidRecord, JoinError> {
    let record = parse_record(input.record_json)?;
    let valid = validate_record(&record, input.now_unix)?;
    match &input.confirm {
        Confirm::Fingerprint(typed) => {
            if !confirm_fingerprint(&valid.sha256, typed) {
                return Err(JoinError::Mismatch("the fingerprint you typed does not match the certificate".into()));
            }
        }
        // a LAN offer always carries expiresAt (and a USB file never does): a file with one came over the network, so a
        // person must compare the fingerprint; `--trust-file` would skip the only check that protects that path
        Confirm::TrustFile if valid.record.expires_at.is_some() => {
            return Err(JoinError::Failed("this file came over the network (it has an expiry): use --confirm-fingerprint with the code shown on the server, not --trust-file".into()));
        }
        Confirm::TrustFile => {}
    }
    // the till app only talks to the one store port; --dev instances (no certificate store involved) use their own
    if input.install_trust && valid.record.server_port != super::store_port() {
        return Err(JoinError::Failed(format!("the store port must be {}", super::store_port())));
    }
    Ok(valid)
}

/// The root hash a `store.env` records (`VITE_STORE_CA_SHA256`), when it is a well-formed SHA-256.
fn recorded_root(store_env: &Path) -> Option<String> {
    let text = fs::read_to_string(store_env).ok()?;
    let v = text.lines().find_map(|l| l.strip_prefix("VITE_STORE_CA_SHA256="))?.trim().to_ascii_lowercase();
    (v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit())).then_some(v)
}

/// The DER of the root this till installed for `hash`: the copy `join` kept at `pki/root.crt`, accepted only when it hashes to
/// the recorded value. Nothing else is ever removed from the certificate store.
fn proven_root(client_dir: &Path, hash: &str) -> Option<Vec<u8>> {
    let text = fs::read_to_string(client_dir.join("pki").join("root.crt")).ok()?;
    let der = crate::pki::pem_to_der(&text).ok()?;
    (crate::pki::sha256_hex(&der) == hash).then_some(der)
}

/// Removes the root a till installed for `hash`: `removed`, `absent`, or `unproven`. A certificate-store error is an `Err`.
fn drop_root(client_dir: &Path, hash: &str, store: &dyn RootStore) -> Result<&'static str, String> {
    let Some(der) = proven_root(client_dir, hash) else { return Ok("unproven") };
    if store.contains(&der, hash)? {
        store.remove(&der)?;
        Ok("removed")
    } else {
        Ok("absent")
    }
}

/// `pair leave`: the till stops using its store. Removes the root it installed (proven by `pki/root.crt` matching the hash
/// `store.env` records), then `store.env` and the root file. `store.env.prev` stays. A certificate-store error fails the
/// command before anything is deleted, so it can be run again.
pub fn leave(client_dir: &Path, install_trust: bool, store: &dyn RootStore) -> Result<LeaveOutput, JoinError> {
    let store_env = client_dir.join("store.env");
    let hash = recorded_root(&store_env);
    let was_paired = store_env.exists();
    let mut root_outcome = "untouched";
    if install_trust {
        if let Some(h) = &hash {
            root_outcome = drop_root(client_dir, h, store).map_err(JoinError::Failed)?;
        }
    }
    if was_paired {
        fs::remove_file(&store_env).map_err(|e| JoinError::Failed(format!("cannot remove store.env: {e}")))?;
    }
    let _ = fs::remove_file(client_dir.join("pki").join("root.crt"));
    Ok(LeaveOutput { was_paired, root_sha256: hash, root_outcome: root_outcome.to_string() })
}

pub fn join(input: &JoinInput<'_>, store: &dyn RootStore) -> Result<JoinOutput, JoinError> {
    let valid = verify(input)?;
    let record = &valid.record;

    // a store this till was paired with before: read what proves it BEFORE root.crt is overwritten
    let previous_root = recorded_root(&input.client_dir.join("store.env")).filter(|h| *h != valid.sha256);
    let previous_der = previous_root.as_deref().and_then(|h| proven_root(input.client_dir, h));

    // the file the certificate store reads is rebuilt from the VERIFIED DER, never the record text
    let root_file = input.client_dir.join("pki").join("root.crt");
    write_atomic(&root_file, &crate::pki::der_to_pem(&valid.der)).map_err(|e| JoinError::Failed(format!("cannot write the root certificate: {e}")))?;

    // only a root THIS run adds is ever removed again
    let mut added = false;
    if input.install_trust {
        let present = store.contains(&valid.der, &valid.sha256).map_err(JoinError::Failed)?;
        store.add_root(&root_file).map_err(JoinError::Failed)?;
        added = !present;
        let undo = |why: String| {
            if added {
                let _ = store.remove(&valid.der);
            }
            JoinError::Failed(why)
        };
        match store.contains(&valid.der, &valid.sha256) {
            Ok(true) => {}
            Ok(false) => return Err(undo("the root certificate was not found in the trusted roots after installing it".into())),
            Err(e) => return Err(undo(e)),
        }
    }

    // the old store.env is copied aside (never moved: a failed write must not leave the till without one) and then replaced atomically
    let store_env = input.client_dir.join("store.env");
    if store_env.exists() {
        let _ = fs::copy(&store_env, input.client_dir.join("store.env.prev"));
    }
    if let Err(e) = write_atomic(&store_env, &store_env_text(&valid, input.paired_at)) {
        if added {
            let _ = store.remove(&valid.der);
        }
        return Err(JoinError::Failed(format!("cannot write store.env: {e}")));
    }
    // the new root is installed and store.env names it: only now is the old store's root dropped (never one this till cannot prove it installed)
    let previous_root_outcome = match (&previous_root, input.install_trust) {
        (Some(h), true) => Some(match previous_der {
            None => "unproven".to_string(),
            Some(der) => match store.contains(&der, h).and_then(|present| if present { store.remove(&der).map(|()| "removed") } else { Ok("absent") }) {
                Ok(o) => o.to_string(),
                Err(e) => format!("failed: {e}"),
            },
        }),
        _ => None,
    };
    Ok(JoinOutput {
        previous_root,
        previous_root_outcome,
        server_url: format!("https://{}:{}", record.server_host.to_ascii_lowercase(), record.server_port),
        fingerprint16: fingerprint16(&valid.sha256),
        root_sha256: valid.sha256,
        trust_installed: input.install_trust,
        store_env,
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::group4;
    use crate::pki::test_support::FIXTURE_ROOT_PEM;
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeStore {
        calls: RefCell<Vec<String>>,
        found: bool,
        /// `contains` answers this before the first `add` (the root was already trusted)
        before: bool,
    }

    impl RootStore for FakeStore {
        fn add_root(&self, file: &Path) -> Result<(), String> {
            let text = fs::read_to_string(file).expect("the root file must exist before it is added");
            // what the certificate store would decode: exactly one block, and its hash is the verified one
            assert_eq!(text.matches("-----BEGIN").count(), 1, "{text}");
            let der = crate::pki::pem_to_der(&text).unwrap();
            assert_eq!(crate::pki::sha256_hex(&der), crate::pki::sha256_hex(&crate::pki::pem_to_der(FIXTURE_ROOT_PEM).unwrap()));
            self.calls.borrow_mut().push("add".into());
            Ok(())
        }
        fn contains(&self, _der: &[u8], _sha: &str) -> Result<bool, String> {
            let first = !self.calls.borrow().iter().any(|c| c == "add");
            self.calls.borrow_mut().push("contains".into());
            Ok(if first { self.before } else { self.found })
        }
        fn remove(&self, _der: &[u8]) -> Result<(), String> {
            self.calls.borrow_mut().push("remove".into());
            Ok(())
        }
    }

    fn now() -> i64 {
        time::OffsetDateTime::now_utc().unix_timestamp()
    }

    fn input<'a>(json: &'a str, confirm: Confirm, dir: &'a Path) -> JoinInput<'a> {
        JoinInput { record_json: json, confirm, client_dir: dir, now_unix: now(), paired_at: "2026-10-02T10:05:00Z", install_trust: true }
    }

    fn good_json() -> String {
        serde_json::to_string(&fixture_record(now())).unwrap()
    }

    #[test]
    fn a_good_record_installs_the_root_once_and_writes_store_env() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        let fp = fingerprint16(&fixture_record(now()).root_sha256);
        let out = join(&input(&json, Confirm::Fingerprint(group4(&fp).to_ascii_uppercase()), dir.path()), &store).unwrap();
        assert_eq!(*store.calls.borrow(), vec!["contains", "add", "contains"]);
        assert!(out.trust_installed);
        assert_eq!(out.server_url, "https://storepc:47304");
        let env = fs::read_to_string(dir.path().join("store.env")).unwrap();
        assert!(env.contains("VITE_STORE_MODE=offline-only") && env.contains("VITE_STORE_CA_SHA256="));
        assert!(dir.path().join("pki").join("root.crt").exists());
    }

    #[test]
    fn a_tampered_record_installs_nothing_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        rec.root_sha256 = "a".repeat(64);
        let json = serde_json::to_string(&rec).unwrap();
        let err = join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 51);
        assert_eq!(err.code(), "PAIR_FINGERPRINT_MISMATCH");
        assert!(store.calls.borrow().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_wrong_typed_fingerprint_is_refused_before_anything_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        let err = join(&input(&json, Confirm::Fingerprint("0000000000000000".into()), dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 51);
        assert!(store.calls.borrow().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_swapped_certificate_with_the_stated_hash_kept_is_a_51_and_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        rec.root_cert_pem = rec.root_cert_pem.replacen("MII", "MIJ", 1);
        let json = serde_json::to_string(&rec).unwrap();
        let err = join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!((err.exit(), err.code()), (51, "PAIR_FINGERPRINT_MISMATCH"));
        assert!(store.calls.borrow().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_correct_8_hex_prefix_is_refused_as_too_short() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        let fp = fingerprint16(&fixture_record(now()).root_sha256);
        let err = join(&input(&json, Confirm::Fingerprint(fp[..8].to_string()), dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 51);
        assert!(store.calls.borrow().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_foreign_block_in_front_of_the_real_certificate_installs_nothing_even_with_the_right_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        let fp = fingerprint16(&rec.root_sha256);
        rec.root_cert_pem = format!("-----BEGIN NOTE-----\nQUJD\n-----END NOTE-----\n{}", rec.root_cert_pem);
        let json = serde_json::to_string(&rec).unwrap();
        let err = join(&input(&json, Confirm::Fingerprint(fp), dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 50);
        assert!(store.calls.borrow().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_installed_file_is_rebuilt_from_the_verified_certificate_not_copied_from_the_record() {
        // a record whose PEM text has odd whitespace: the file the store reads is the canonical form (FakeStore asserts the hash)
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        rec.root_cert_pem = format!("\n  {}  \n", rec.root_cert_pem.trim().replace('\n', "\r\n"));
        let json = serde_json::to_string(&rec).unwrap();
        join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap();
        let on_disk = fs::read_to_string(dir.path().join("pki").join("root.crt")).unwrap();
        assert!(!on_disk.contains('\r') && on_disk.starts_with("-----BEGIN CERTIFICATE-----\n"));
    }

    #[test]
    fn a_trust_file_with_an_expiry_is_refused_because_it_came_over_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        rec.expires_at = Some("2099-01-01T00:00:00Z".into());
        let err = join(&input(&serde_json::to_string(&rec).unwrap(), Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 50);
        assert!(store.calls.borrow().is_empty() && fs::read_dir(dir.path()).unwrap().count() == 0);
        // the same file with the typed fingerprint is fine
        let fp = fingerprint16(&rec.root_sha256);
        join(&input(&serde_json::to_string(&rec).unwrap(), Confirm::Fingerprint(fp), dir.path()), &store).unwrap();
    }

    #[test]
    fn only_the_store_port_is_accepted_when_the_certificate_store_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let mut rec = fixture_record(now());
        rec.server_port = 8443;
        let json = serde_json::to_string(&rec).unwrap();
        assert_eq!(join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap_err().exit(), 50);
        let mut i = input(&json, Confirm::TrustFile, dir.path());
        i.install_trust = false; // --dev instances use their own ports
        assert!(join(&i, &store).is_ok());
    }

    #[test]
    fn a_failed_store_env_write_never_removes_a_root_that_was_already_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, before: true, ..Default::default() };
        // a directory where store.env must go: the atomic write fails
        fs::create_dir_all(dir.path().join("store.env")).unwrap();
        let json = good_json();
        let err = join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 50);
        assert!(!store.calls.borrow().iter().any(|c| c == "remove"), "{:?}", store.calls.borrow());
        // and a root this run did add IS removed again
        let dir2 = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir2.path().join("store.env")).unwrap();
        let store2 = FakeStore { found: true, before: false, ..Default::default() };
        join(&input(&json, Confirm::TrustFile, dir2.path()), &store2).unwrap_err();
        assert!(store2.calls.borrow().iter().any(|c| c == "remove"));
    }

    #[test]
    fn a_refused_second_join_leaves_the_previous_store_env_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap();
        let first = fs::read_to_string(dir.path().join("store.env")).unwrap();
        let mut rec = fixture_record(now());
        rec.root_cert_pem = "garbage".into();
        let bad = serde_json::to_string(&rec).unwrap();
        assert!(join(&input(&bad, Confirm::TrustFile, dir.path()), &store).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("store.env")).unwrap(), first);
    }

    #[test]
    fn a_root_that_is_not_found_after_install_is_rolled_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: false, ..Default::default() };
        let json = good_json();
        let err = join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 50);
        assert_eq!(*store.calls.borrow(), vec!["contains", "add", "contains", "remove"]);
        assert!(!dir.path().join("store.env").exists());
    }

    #[test]
    fn under_dev_the_certificate_store_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        let mut i = input(&json, Confirm::TrustFile, dir.path());
        i.install_trust = false;
        let out = join(&i, &store).unwrap();
        assert!(store.calls.borrow().is_empty());
        assert!(!out.trust_installed);
        assert!(dir.path().join("store.env").exists());
    }

    #[test]
    fn a_second_join_keeps_the_previous_store_env() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore { found: true, ..Default::default() };
        let json = good_json();
        join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap();
        fs::write(dir.path().join("store.env"), "VITE_STORE_MODE=offline-only\n# marker\n").unwrap();
        join(&input(&json, Confirm::TrustFile, dir.path()), &store).unwrap();
        assert!(fs::read_to_string(dir.path().join("store.env.prev")).unwrap().contains("# marker"));
    }

    #[test]
    fn garbage_is_a_pair_failed_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        for bad in ["", "not json", "{}", "[]"] {
            let err = join(&input(bad, Confirm::TrustFile, dir.path()), &store).unwrap_err();
            assert_eq!(err.exit(), 50, "{bad:?}");
        }
    }

    // ---- re-pair replaces the previous store's root; `pair leave` (Final review CODE I4) ----

    /// A trusted-roots set: certificates by DER, with switches for the failures a real store can have.
    #[derive(Default)]
    struct SetStore {
        trusted: RefCell<Vec<Vec<u8>>>,
        adds: RefCell<usize>,
        fail_contains: bool,
        fail_remove: bool,
    }

    impl RootStore for SetStore {
        fn add_root(&self, file: &Path) -> Result<(), String> {
            let der = crate::pki::pem_to_der(&fs::read_to_string(file).unwrap()).unwrap();
            self.trusted.borrow_mut().push(der);
            *self.adds.borrow_mut() += 1;
            Ok(())
        }
        fn contains(&self, der: &[u8], _sha: &str) -> Result<bool, String> {
            if self.fail_contains {
                return Err("certutil -store failed with exit code 5".into());
            }
            Ok(self.trusted.borrow().iter().any(|d| d == der))
        }
        fn remove(&self, der: &[u8]) -> Result<(), String> {
            if self.fail_remove {
                return Err("certutil -delstore failed".into());
            }
            self.trusted.borrow_mut().retain(|d| d != der);
            Ok(())
        }
    }

    fn fixture_der() -> Vec<u8> {
        crate::pki::pem_to_der(FIXTURE_ROOT_PEM).unwrap()
    }

    /// A till already paired to some other store: store.env names the old root's hash and pki/root.crt holds it (when `keep_file`).
    fn paired_before(dir: &Path, keep_file: bool) -> (Vec<u8>, String) {
        let old = b"an older store root".to_vec();
        let hash = crate::pki::sha256_hex(&old);
        fs::create_dir_all(dir.join("pki")).unwrap();
        fs::write(dir.join("store.env"), format!("VITE_STORE_MODE=offline-only\nVITE_STORE_CA_SHA256={hash}\n")).unwrap();
        if keep_file {
            fs::write(dir.join("pki").join("root.crt"), crate::pki::der_to_pem(&old)).unwrap();
        }
        (old, hash)
    }

    #[test]
    fn a_re_pair_to_a_different_store_removes_the_old_root_after_the_new_one_is_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (old, old_hash) = paired_before(dir.path(), true);
        let store = SetStore::default();
        store.trusted.borrow_mut().push(old.clone());
        let out = join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
        assert_eq!(*store.trusted.borrow(), vec![fixture_der()]);
        assert_eq!((out.previous_root.as_deref(), out.previous_root_outcome.as_deref()), (Some(old_hash.as_str()), Some("removed")));
        assert!(fs::read_to_string(dir.path().join("store.env.prev")).unwrap().contains(&old_hash));
    }

    #[test]
    fn a_root_the_till_cannot_prove_it_installed_is_never_removed() {
        for keep_file in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (old, _) = paired_before(dir.path(), keep_file);
            if keep_file {
                // the file on disk does not hash to what store.env records: not proof
                fs::write(dir.path().join("pki").join("root.crt"), crate::pki::der_to_pem(b"something else")).unwrap();
            }
            let store = SetStore::default();
            store.trusted.borrow_mut().push(old.clone());
            let out = join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
            assert!(store.trusted.borrow().contains(&old), "keep_file={keep_file}");
            assert_eq!(out.previous_root_outcome.as_deref(), Some("unproven"));
        }
    }

    #[test]
    fn re_pairing_to_the_same_root_removes_nothing_and_under_dev_the_store_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let store = SetStore::default();
        join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
        let out = join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
        assert_eq!((out.previous_root, out.previous_root_outcome), (None, None));
        assert!(store.trusted.borrow().contains(&fixture_der()));
        let dir2 = tempfile::tempdir().unwrap();
        let (old, _) = paired_before(dir2.path(), true);
        let store2 = SetStore::default();
        store2.trusted.borrow_mut().push(old.clone());
        let json = good_json();
        let mut i = input(&json, Confirm::TrustFile, dir2.path());
        i.install_trust = false;
        let out = join(&i, &store2).unwrap();
        assert_eq!(*store2.trusted.borrow(), vec![old]);
        assert_eq!(out.previous_root_outcome, None);
    }

    #[test]
    fn a_failure_removing_the_old_root_is_reported_but_the_till_stays_paired() {
        let dir = tempfile::tempdir().unwrap();
        let (old, _) = paired_before(dir.path(), true);
        let store = SetStore { fail_remove: true, ..Default::default() };
        store.trusted.borrow_mut().push(old);
        let out = join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
        assert!(out.previous_root_outcome.as_deref().unwrap().starts_with("failed:"));
        assert!(fs::read_to_string(dir.path().join("store.env")).unwrap().contains(&crate::pki::sha256_hex(&fixture_der())));
    }

    #[test]
    fn a_certificate_store_read_error_is_an_error_never_absence() {
        let dir = tempfile::tempdir().unwrap();
        let store = SetStore { fail_contains: true, ..Default::default() };
        let err = join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap_err();
        assert_eq!(err.exit(), 50);
        assert_eq!(*store.adds.borrow(), 0, "nothing is added when the store cannot even be read");
        assert!(!dir.path().join("store.env").exists());
    }

    #[test]
    fn leave_removes_the_paired_root_and_store_env_and_keeps_the_previous_copy() {
        let dir = tempfile::tempdir().unwrap();
        let store = SetStore::default();
        join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap();
        join(&input(&good_json(), Confirm::TrustFile, dir.path()), &store).unwrap(); // makes a .prev
        let out = leave(dir.path(), true, &store).unwrap();
        assert_eq!((out.was_paired, out.root_outcome.as_str()), (true, "removed"));
        assert!(store.trusted.borrow().iter().all(|d| *d != fixture_der()));
        assert!(!dir.path().join("store.env").exists() && !dir.path().join("pki").join("root.crt").exists());
        assert!(dir.path().join("store.env.prev").exists());
        // and leaving again is a quiet no-op
        let again = leave(dir.path(), true, &store).unwrap();
        assert_eq!((again.was_paired, again.root_sha256), (false, None));
    }

    #[test]
    fn leave_fails_untouched_when_the_certificate_store_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let ok = SetStore::default();
        join(&input(&good_json(), Confirm::TrustFile, dir.path()), &ok).unwrap();
        let bad = SetStore { fail_contains: true, ..Default::default() };
        assert_eq!(leave(dir.path(), true, &bad).unwrap_err().exit(), 50);
        assert!(dir.path().join("store.env").exists() && dir.path().join("pki").join("root.crt").exists());
    }

    #[test]
    fn leave_never_removes_an_unproven_root_and_under_dev_never_calls_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (old, _) = paired_before(dir.path(), false);
        let store = SetStore::default();
        store.trusted.borrow_mut().push(old.clone());
        let out = leave(dir.path(), true, &store).unwrap();
        assert_eq!(out.root_outcome, "unproven");
        assert_eq!(*store.trusted.borrow(), vec![old]);
        assert!(!dir.path().join("store.env").exists());
        let dir2 = tempfile::tempdir().unwrap();
        paired_before(dir2.path(), true);
        let bad = SetStore { fail_contains: true, ..Default::default() };
        assert_eq!(leave(dir2.path(), false, &bad).unwrap().root_outcome, "untouched");
    }
}
