//! The signing contract through the REAL key path (the library compiled without `cfg(test)`, so `pack::load` verifies
//! against `packcmd::updater_pubkey()` exactly as the shipped binary does).
//!
//! - release build (no `test-hooks`): a pack signed with a throwaway key is refused, an unsigned folder is refused;
//! - `--features test-hooks`: `POSCTL_TEST_UPDATER_PUBKEY` makes the same throwaway-signed pack install and load, which is
//!   how the Windows Sandbox scenarios and dev instances run a pack without the owner-held private key. There is no
//!   other way to load an unsigned pack.

use posctl::envelope::Code;
use posctl::packcmd::{self, InstallOptions};
use posctl::paths::Roots;
use posctl::pack;

const FIXTURE: &[u8] = include_bytes!("fixtures/pack-ok.pospack");

fn roots(d: &tempfile::TempDir) -> (Roots, std::path::PathBuf) {
    let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
    let zip = d.path().join("throwaway-signed.pospack");
    std::fs::write(&zip, FIXTURE).unwrap();
    (r, zip)
}

#[cfg(not(feature = "test-hooks"))]
#[test]
fn a_release_build_refuses_a_throwaway_signed_pack_and_an_unsigned_folder() {
    let d = tempfile::tempdir().unwrap();
    let (r, zip) = roots(&d);
    assert!(packcmd::hook_env().is_empty());
    let e = packcmd::install_file(&r, &zip, &packcmd::updater_pubkey(), &InstallOptions::default()).unwrap_err();
    assert_eq!((e.code, e.code.exit()), (Code::PackInvalid, 13), "{}", e.message);
    assert!(e.message.contains("signature"), "{}", e.message);
    // a folder with a manifest but no signature never loads, at either tier
    let dir = r.pack_dir("1.0.0-r1").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), b"{}").unwrap();
    assert!(pack::load(&dir).is_err() && pack::load_light(&dir).is_err());
    assert!(pack::latest_installed(&r.packs(), pack::Tier::Light).is_err(), "the folder is the highest pack and does not verify");
}

#[cfg(feature = "test-hooks")]
#[test]
fn the_test_hook_key_lets_a_throwaway_signed_pack_install_and_load_and_still_refuses_unsigned() {
    let d = tempfile::tempdir().unwrap();
    let (r, zip) = roots(&d);
    let signer = include_str!("fixtures/signer.pub").trim().to_string();
    // without the variable the embedded updater key applies and the throwaway pack is refused
    std::env::remove_var("POSCTL_TEST_UPDATER_PUBKEY");
    assert_eq!(packcmd::install_file(&r, &zip, &packcmd::updater_pubkey(), &InstallOptions::default()).unwrap_err().code, Code::PackInvalid);
    std::env::set_var("POSCTL_TEST_UPDATER_PUBKEY", &signer);
    assert_eq!(packcmd::updater_pubkey(), signer);
    packcmd::install_file(&r, &zip, &packcmd::updater_pubkey(), &InstallOptions::default()).unwrap();
    let dir = r.pack_dir("1.0.0-r1").unwrap();
    assert_eq!(pack::load(&dir).unwrap().manifest.pack_version, "1.0.0-r1");
    assert_eq!(pack::load_light(&dir).unwrap().manifest.pack_version, "1.0.0-r1");
    assert_eq!(pack::latest_installed(&r.packs(), pack::Tier::Full).unwrap().unwrap().manifest.pack_version, "1.0.0-r1");
    // the hook key replaces the trust anchor, it does not switch verification off
    std::fs::remove_file(dir.join("manifest.json.minisig")).unwrap();
    assert!(pack::load(&dir).is_err() && pack::load_light(&dir).is_err());
    std::env::remove_var("POSCTL_TEST_UPDATER_PUBKEY");
}
