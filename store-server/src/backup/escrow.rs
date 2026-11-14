//! Vendor escrow of the recovery key (conventions v1.6, owner decision). `backup key-export` encrypts the
//! recovery key to the vendor's age (X25519) public key and keeps the ciphertext (`escrow.age`) next to every
//! backup copy, so the vendor can recover a store whose owner lost the key. The private half exists only with
//! the vendor (offline ceremony before release); nothing in this repo or on a store PC can decrypt it.
use std::path::Path;

use super::config::{DestKind, Destination};
use super::ctx::BackupCtx;
use super::result::{BResult, BackupError};
use super::util::{lock_down_file, write_atomic};

pub const PLACEHOLDER: &str = "PLACEHOLDER-NO-VENDOR-KEY";
/// SHA-256 (lowercase hex) of the trimmed throwaway recipient of `scripts/write-escrow-pubkey.mjs --dev` (its private half is known
/// to nobody). Only the digest is compiled in: a release posctl.exe must not contain the key's text (the release string check
/// would fail on it). A release build refuses that recipient; a `test-hooks` build (the Sandbox) accepts it. A test pins the digest.
const DEV_ESCROW_PUBKEY_SHA256: &str = "cf7e5682313150685bf16e42c4ea48e168e16e8206c5c4ad37c72d013cb6a5f4";
pub const FILE_NAME: &str = "escrow.age";

/// The vendor PUBLIC key baked into the binary. Plan 04 never created this resource, so it lives in
/// `store-server/resources/` (the placeholder until the vendor ceremony). Trimmed.
fn embedded_pubkey() -> &'static str {
    include_str!("../../resources/escrow-pubkey.txt").trim()
}

/// With the `test-hooks` feature (never in a release) `POSCTL_TEST_ESCROW_PUBKEY` replaces the embedded recipient, so the Windows Sandbox can issue a recovery
/// key from a build that carries the committed placeholder (the `POSCTL_TEST_UPDATER_PUBKEY` precedent: no validation here, `check_recipient` judges it at use).
#[cfg(feature = "test-hooks")]
pub fn build_pubkey() -> String {
    std::env::var("POSCTL_TEST_ESCROW_PUBKEY").unwrap_or_else(|_| embedded_pubkey().to_string())
}
#[cfg(not(feature = "test-hooks"))]
pub fn build_pubkey() -> String {
    embedded_pubkey().to_string()
}

/// Binary age ciphertext of exactly `recovery_key`, for an `age1...` X25519 recipient. A malformed
/// recipient or the placeholder is a precondition: this build cannot escrow, so nothing may change.
pub fn encrypt_for(recipient: &str, recovery_key: &str) -> BResult<Vec<u8>> {
    let r = parse_recipient(recipient)?;
    age::encrypt(&r, recovery_key.as_bytes()).map_err(|e| BackupError::error(format!("escrow encryption failed: {e}")))
}

fn parse_recipient(recipient: &str) -> BResult<age::x25519::Recipient> {
    let no_key = || BackupError::precondition("this build has no vendor escrow key");
    let recipient = recipient.trim();
    if recipient == PLACEHOLDER || (cfg!(not(feature = "test-hooks")) && crate::util::sha256_hex(recipient.as_bytes()) == DEV_ESCROW_PUBKEY_SHA256) {
        return Err(no_key());
    }
    recipient.parse().map_err(|_| no_key())
}

/// The recipient alone is judged: the placeholder or a malformed key refuses before anything else is touched.
pub fn check_recipient(recipient: &str) -> BResult<()> {
    parse_recipient(recipient).map(|_| ())
}

/// Where an escrow copy goes besides the file system (R2): Plan 12 supplies the SigV4 client.
pub trait ObjectPut {
    fn put(&self, dest: &Destination, name: &str, bytes: &[u8]) -> Result<(), String>;
}

struct NoR2;
impl ObjectPut for NoR2 {
    fn put(&self, _: &Destination, _: &str, _: &[u8]) -> Result<(), String> {
        Err("r2 client not available".into())
    }
}

/// Until Plan 12 Task 7 registers the real client an R2 copy is reported as a warning, never an error.
pub fn real_put() -> Box<dyn ObjectPut> {
    Box::new(NoR2)
}

pub fn stored_path(ctx: &BackupCtx) -> std::path::PathBuf {
    ctx.paths.backups().join(FILE_NAME)
}

/// A device keeps `escrow.age` beside its repository folder (the folder holds only the restic repo).
fn put_one(dest: &Destination, blob: &[u8], put: &dyn ObjectPut) -> Result<(), String> {
    match dest.kind {
        DestKind::R2 => put.put(dest, FILE_NAME, blob),
        DestKind::Device => {
            let parent = Path::new(dest.location()).parent().ok_or_else(|| "the destination has no parent folder".to_string())?;
            write_atomic(&parent.join(FILE_NAME), blob).map_err(|e| e.to_string())
        }
    }
}

/// Writes `backups\escrow.age` (SYSTEM and Administrators only; `--dev` roots skip the ACL like every private
/// check) and copies it to every destination. One entry per destination; a failure never stops the others.
pub fn publish(ctx: &BackupCtx, blob: &[u8], dests: &[Destination], put: &dyn ObjectPut) -> BResult<Vec<(String, Result<(), String>)>> {
    let stored = stored_path(ctx);
    super::acl::ensure_private_backups(ctx)?; // the file's folder is `backups\`: never born inherited here either
    write_atomic(&stored, blob)?;
    if !ctx.is_dev() {
        lock_down_file(&stored)?;
    }
    Ok(dests.iter().map(|d| (d.name.clone(), put_one(d, blob, put))).collect())
}

/// `backup dest add` calls this so a destination added after `key-export` carries the file too.
/// Nothing stored yet (key never exported) is Ok: there is nothing to copy.
pub fn ensure_on(ctx: &BackupCtx, dest: &Destination, put: &dyn ObjectPut) -> Result<(), String> {
    match std::fs::read(stored_path(ctx)) {
        Ok(blob) => put_one(dest, &blob, put),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// POSCTL_TEST_ESCROW_PUBKEY is process-wide and tests run on parallel threads: the test that sets it and every test that reaches `build_pubkey`
/// through the CLI hold this lock (the dev.rs / sys.rs env_lock pattern).
#[cfg(test)]
static ESCROW_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ESCROW_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::util::fake::test_ctx;
    use crate::envelope::Code;
    use std::cell::RefCell;

    const KEY: &str = "ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567";

    fn id() -> (age::x25519::Identity, String) {
        let i = age::x25519::Identity::generate();
        let p = i.to_public().to_string();
        (i, p)
    }

    #[test]
    fn the_ciphertext_opens_with_the_vendor_identity_to_exactly_the_key() {
        let (i, public) = id();
        let blob = encrypt_for(&public, KEY).unwrap();
        assert_eq!(age::decrypt(&i, &blob).unwrap(), KEY.as_bytes());
    }

    #[test]
    fn the_ciphertext_does_not_contain_the_key_and_two_encryptions_differ() {
        let (_i, public) = id();
        let a = encrypt_for(&public, KEY).unwrap();
        let b = encrypt_for(&public, KEY).unwrap();
        assert_ne!(a, b, "a fresh ephemeral key per encryption");
        let has = |hay: &[u8], needle: &str| hay.windows(needle.len()).any(|w| w == needle.as_bytes());
        let bare = KEY.replace('-', "");
        assert!(!has(&a, KEY) && !has(&a, &bare));
    }

    #[test]
    fn the_placeholder_and_garbage_are_a_precondition() {
        for bad in [PLACEHOLDER, "age1garbage", "", "  PLACEHOLDER-NO-VENDOR-KEY\n"] {
            let e = encrypt_for(bad, KEY).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "{bad:?}");
            assert!(e.message.contains("no vendor escrow key"));
        }
    }

    /// The development recipient, read from the release script at test time (never compiled into a non-test build).
    fn dev_key() -> String {
        let mjs = include_str!("../../../scripts/write-escrow-pubkey.mjs");
        let at = mjs.find("DEV_ESCROW_PUBKEY = '").expect("the script defines the dev key") + "DEV_ESCROW_PUBKEY = '".len();
        mjs[at..].split('\'').next().unwrap().to_string()
    }

    #[test]
    fn the_dev_escrow_key_digest_is_the_one_of_the_key_in_the_release_script() {
        assert!(dev_key().starts_with("age1"));
        assert_eq!(crate::util::sha256_hex(dev_key().as_bytes()), DEV_ESCROW_PUBKEY_SHA256, "the digest drifted from the script");
    }

    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn a_release_build_refuses_the_development_escrow_key_with_the_placeholder_wording() {
        for bad in [dev_key(), format!(" {}
", dev_key())] {
            let e = check_recipient(&bad).unwrap_err();
            assert_eq!(e.code, Code::Precondition);
            assert_eq!(e.message, check_recipient(PLACEHOLDER).unwrap_err().message);
            assert!(encrypt_for(&bad, KEY).is_err());
        }
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn a_test_hooks_build_still_accepts_the_development_escrow_key() {
        assert!(check_recipient(&dev_key()).is_ok());
        assert!(encrypt_for(&dev_key(), KEY).is_ok());
    }

    #[test]
    fn the_recipient_can_be_judged_without_a_key_to_encrypt() {
        for bad in [PLACEHOLDER, "age1garbage", "", "  PLACEHOLDER-NO-VENDOR-KEY\n"] {
            let e = check_recipient(bad).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "{bad:?}");
            assert!(e.message.contains("no vendor escrow key"));
        }
        let (_id, public) = id();
        assert!(check_recipient(&public).is_ok());
        assert!(check_recipient(&format!(" {public}\n")).is_ok(), "trimmed like encrypt_for");
    }

    #[test]
    fn the_embedded_pubkey_resource_is_the_placeholder_until_the_vendor_ceremony() {
        // Replaced by the vendor's real public key before release; either way it must be one line.
        let k = embedded_pubkey();
        assert!(!k.is_empty() && !k.contains('\n'));
        assert!(k == PLACEHOLDER || k.starts_with("age1"), "unexpected escrow resource: {k}");
        assert!(!k.starts_with("AGE-SECRET-KEY"), "a private key must never be embedded");
    }

    /// The committed resource stays the placeholder (the vendor ceremony writes the real key into a release build only).
    #[test]
    fn the_committed_escrow_resource_is_exactly_the_placeholder() {
        assert_eq!(include_str!("../../resources/escrow-pubkey.txt").trim(), PLACEHOLDER);
    }

    /// With `test-hooks` the Sandbox passes a throwaway recipient in POSCTL_TEST_ESCROW_PUBKEY (the POSCTL_TEST_UPDATER_PUBKEY precedent).
    /// One test owns the variable so no sibling test sees it.
    #[cfg(feature = "test-hooks")]
    #[test]
    fn with_test_hooks_the_override_recipient_replaces_the_embedded_key() {
        let _g = crate::backup::escrow::env_lock(); // POSCTL_TEST_ESCROW_PUBKEY is process-wide: every test that sets it or reaches build_pubkey holds this
        let (_i, public) = id();
        std::env::remove_var("POSCTL_TEST_ESCROW_PUBKEY");
        assert_eq!(&*build_pubkey(), PLACEHOLDER, "no override: the embedded resource");
        std::env::set_var("POSCTL_TEST_ESCROW_PUBKEY", &public);
        let got = build_pubkey().to_string();
        std::env::remove_var("POSCTL_TEST_ESCROW_PUBKEY");
        assert_eq!(got, public);
        assert!(crate::packcmd::hook_env().contains(&"POSCTL_TEST_ESCROW_PUBKEY"), "listed in dev hook-env so the release-clean check covers it");
    }

    /// Without the feature the override code does not exist: the variable changes nothing and no hook is listed.
    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn without_test_hooks_the_variable_is_ignored() {
        let (_i, public) = id();
        std::env::set_var("POSCTL_TEST_ESCROW_PUBKEY", &public);
        let got = build_pubkey().to_string();
        std::env::remove_var("POSCTL_TEST_ESCROW_PUBKEY");
        assert_ne!(got, public);
        assert!(crate::packcmd::hook_env().is_empty());
    }

    struct Recording(RefCell<Vec<String>>, bool);
    impl ObjectPut for Recording {
        fn put(&self, d: &Destination, name: &str, _: &[u8]) -> Result<(), String> {
            self.0.borrow_mut().push(format!("{}/{name}", d.name));
            if self.1 { Err("boom".into()) } else { Ok(()) }
        }
    }

    fn dev(name: &str, path: &Path) -> Destination {
        Destination { name: name.into(), kind: DestKind::Device, path: Some(path.to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() }
    }
    fn r2(name: &str) -> Destination {
        Destination { name: name.into(), kind: DestKind::R2, path: None, repo: Some("s3:https://x/b/f".into()), volume_serial: None, added_at: 0, extra: Default::default() }
    }

    fn ctx_in(d: &Path) -> BackupCtx {
        let mut c = test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.join("d"), d.join("p")));
        c
    }

    #[test]
    fn publish_writes_beside_each_device_repo_and_a_failing_r2_does_not_stop_the_others() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let root = d.path().join("usbroot");
        std::fs::create_dir_all(root.join("repo")).unwrap();
        let blob = b"cipher".to_vec();
        let put = Recording(RefCell::new(vec![]), true);
        let out = publish(&c, &blob, &[r2("cloud"), dev("usb", &root.join("repo"))], &put).unwrap();
        assert!(stored_path(&c).exists());
        assert_eq!(std::fs::read(root.join("escrow.age")).unwrap(), blob);
        assert!(out[0].1.is_err() && out[1].1.is_ok());
        assert_eq!(put.0.borrow().as_slice(), ["cloud/escrow.age"]);
        // the default R2 client is a warning-only stub
        let o2 = publish(&c, &blob, &[r2("cloud")], real_put().as_ref()).unwrap();
        assert_eq!(o2[0].1, Err("r2 client not available".to_string()));
    }

    #[test]
    fn a_destination_added_later_gets_the_stored_file_and_nothing_stored_is_not_an_error() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let root = d.path().join("late");
        std::fs::create_dir_all(root.join("repo")).unwrap();
        let late = dev("late", &root.join("repo"));
        ensure_on(&c, &late, real_put().as_ref()).unwrap();
        assert!(!root.join("escrow.age").exists());
        publish(&c, b"cipher", &[], real_put().as_ref()).unwrap();
        ensure_on(&c, &late, real_put().as_ref()).unwrap();
        assert_eq!(std::fs::read(root.join("escrow.age")).unwrap(), b"cipher");
    }
}
