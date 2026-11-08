//! Machine key (a file only SYSTEM/Administrators read) and the one-time owner recovery key.
//! The recovery key is the only way to open the USB repository after the PC is gone: it is shown
//! once, never stored, never logged. A copy encrypted to the vendor escrow key (`escrow.rs`) is kept.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::acl::{scrub_and_remove, PrivateDir};
use super::config::BackupConfig;
use super::ctx::BackupCtx;
use super::restic::{key_add_args, key_remove_args, parse_key_id, run_restic, Repo};
use super::result::{BResult, BackupError};
use super::state::{BackupState, RecoveryKeyRef};
use super::util::{hex, lock_down_file, random_bytes, tail, Exec};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// At least 8 distinct byte values: rejects an all-zero buffer from a failed random source.
pub fn entropy_ok(b: &[u8]) -> bool {
    let mut seen = [false; 256];
    for x in b {
        seen[*x as usize] = true;
    }
    seen.iter().filter(|s| **s).count() >= 8
}

/// `N` OS-random bytes that pass `entropy_ok` (the OS source itself is `crate::util::random_bytes`).
fn good_random<const N: usize>() -> BResult<[u8; N]> {
    for _ in 0..8 {
        let mut b = [0u8; N];
        random_bytes(&mut b)?;
        if entropy_ok(&b) {
            return Ok(b);
        }
    }
    Err(BackupError::error("the OS random source returned no usable entropy"))
}

pub fn generate_machine_key() -> BResult<String> {
    Ok(hex(&good_random::<32>()?))
}

/// Create `secrets\restic-password.txt` only when no repository exists. A missing key next to an
/// existing repository means the data is locked: stop, never invent a new key. `repo_exists` is true when the
/// local repository exists OR any destination is configured (a destination already holds data under that key).
/// A new key file is locked down to SYSTEM and Administrators explicitly (skipped for `--dev` roots).
pub fn ensure_machine_key(ctx: &BackupCtx, repo_exists: bool) -> BResult<PathBuf> {
    let paths = &ctx.paths;
    let p = paths.machine_key();
    match std::fs::read_to_string(&p) {
        Ok(t) => {
            let t = t.trim();
            if t.len() < 32 || !entropy_ok(t.as_bytes()) {
                return Err(BackupError::precondition("secrets\\restic-password.txt is damaged; restore it from the owner's records, do not recreate it"));
            }
            Ok(p)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if repo_exists {
                return Err(BackupError::precondition("secrets\\restic-password.txt is missing but a backup repository exists; refusing to create a new key. Use the owner's recovery key (backup restore --repo ... --key-stdin)"));
            }
            let key = generate_machine_key()?;
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p)?;
            f.write_all(key.as_bytes())?;
            f.sync_all()?;
            drop(f);
            if !ctx.is_dev() {
                lock_down_file(&p)?;
            }
            Ok(p)
        }
        Err(e) => Err(e.into()),
    }
}

/// `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`, 150 bits, Crockford base32 (no I, L, O, U).
pub fn new_recovery_key() -> BResult<String> {
    let b = good_random::<30>()?;
    let chars: Vec<char> = b.iter().map(|x| ALPHABET[(*x & 31) as usize] as char).collect();
    Ok(chars.chunks(5).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-"))
}

/// Accepts lower case, spaces, missing dashes and the usual look-alikes (O->0, I/L->1). ASCII only: a wider
/// character must never be truncated into a valid symbol (`'\u{130}' as u8` is `'0'`).
pub fn normalize_recovery_key(input: &str) -> Option<String> {
    if !input.is_ascii() {
        return None;
    }
    let cleaned: Vec<char> = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            x => x,
        })
        .collect();
    if cleaned.len() != 30 || !cleaned.iter().all(|c| ALPHABET.contains(&(*c as u8))) {
        return None;
    }
    Some(cleaned.chunks(5).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-"))
}

pub struct Exported {
    pub key: String,
    pub issued_at: i64,
    pub repos: Vec<String>,
    /// `escrow.age` content (v1.6): the key encrypted to the vendor escrow public key. Safe to store and copy.
    /// The caller writes it (`escrow::publish`) only after this function returned Ok, i.e. after every repository
    /// has the new key; a failed or refused export never touches `backups\escrow.age`.
    pub escrow: Vec<u8>,
    /// Things that did not stop the export but the owner should hear about (an old key that could not be removed).
    pub warnings: Vec<String>,
    /// `(repository, restic key id)` of the recovery keys this export replaces. They are removed by `retire_old_keys`, and only
    /// after the new ids are saved: until then the old key must keep working and stay recorded.
    pub old_ids: Vec<(String, String)>,
}

/// Removes the replaced recovery keys. Called only after the new ids are saved: a failure here leaves a stale but harmless extra
/// key behind, so it is a warning, never an error.
pub fn retire_old_keys(ctx: &BackupCtx, exec: &dyn Exec, repos: &[(String, Repo)], old: &[(String, String)]) -> Vec<String> {
    let mut warnings = Vec::new();
    for (name, id) in old {
        let Some((_, repo)) = repos.iter().find(|(n, _)| n == name) else { continue };
        match run_restic(exec, ctx, repo, &key_remove_args(id), Duration::from_secs(120)) {
            Ok(o) if o.ok() => {}
            Ok(o) => warnings.push(format!("could not remove the previous recovery key {id} from '{name}': {}", tail(&o.stderr))),
            Err(e) => warnings.push(format!("could not remove the previous recovery key {id} from '{name}': {}", e.message)),
        }
    }
    warnings
}

// Debug must never print the recovery key.
impl std::fmt::Debug for Exported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Exported").field("key", &"<redacted>").field("issued_at", &self.issued_at).field("repos", &self.repos).field("escrow_bytes", &self.escrow.len()).finish()
    }
}

struct Scrub(PathBuf);
impl Drop for Scrub {
    fn drop(&mut self) {
        if scrub_and_remove(&self.0).is_err() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Runs `f` with the path of a file that holds `key`, inside a private per-run folder (checked private first);
/// the file is zeroed and removed, and the folder removed, on every exit path. restic reads it with
/// `--new-password-file`, so the key never appears on a command line.
pub fn with_key_file<T>(ctx: &BackupCtx, key: &str, f: impl FnOnce(&Path) -> BResult<T>) -> BResult<T> {
    let dir = PrivateDir::create(ctx)?;
    let mut r = [0u8; 8];
    random_bytes(&mut r)?;
    let file = dir.path().join(format!("rk-{}.tmp", hex(&r)));
    std::fs::write(&file, key.as_bytes())?;
    let _scrub = Scrub(file.clone());
    f(&file)
}

/// Adds a freshly generated recovery key to every repository in `repos` (name + handle). Rotation is refused
/// unless `repos` covers every configured destination (an unplugged drive left on the old key would be locked
/// out of the new one); the replaced keys are NOT removed here: `Exported::old_ids` goes to `retire_old_keys` after the caller has saved the new ids.
/// State changes only on success and `key_ids` of repositories not processed here are kept.
#[allow(clippy::too_many_arguments)]
pub fn export_recovery_key(
    ctx: &BackupCtx,
    exec: &dyn Exec,
    state: &mut BackupState,
    repos: &[(String, Repo)],
    cfg: &BackupConfig,
    rotate: bool,
    now: i64,
    escrow_pub: &str,
) -> BResult<Exported> {
    if state.recovery_key.is_some() && !rotate {
        return Err(BackupError::usage("a recovery key was already issued; --rotate replaces it and the old one stops working"));
    }
    if rotate {
        let missing: Vec<&str> = cfg.destinations.iter().map(|d| d.name.as_str()).filter(|n| !repos.iter().any(|(r, _)| r == n)).collect();
        if !missing.is_empty() {
            return Err(BackupError::precondition(format!(
                "cannot rotate the recovery key: destination(s) {} are not covered (plug them in); they would stay locked to the old key",
                missing.join(", ")
            )));
        }
    }
    let key = new_recovery_key()?;
    // v1.6: encrypt to the vendor escrow public key BEFORE any repository changes; a bad or placeholder key aborts here.
    let escrow = super::escrow::encrypt_for(escrow_pub, &key)?;
    let ids = with_key_file(ctx, &key, |file| {
        let mut ids = std::collections::BTreeMap::new();
        for (name, repo) in repos {
            let step = (|| {
                let out = run_restic(exec, ctx, repo, &key_add_args(file), Duration::from_secs(120))?;
                if !out.ok() {
                    return Err(BackupError::precondition(format!("cannot add the recovery key to '{name}': {}", tail(&out.stderr))));
                }
                parse_key_id(&out.stdout).ok_or_else(|| BackupError::error(format!("restic did not report the new key id for '{name}'")))
            })();
            match step {
                Ok(id) => {
                    ids.insert(name.clone(), id);
                }
                Err(e) => {
                    // best effort: do not leave keys the owner never saw
                    for (done, id) in &ids {
                        if let Some((_, rp)) = repos.iter().find(|(n, _)| n == done) {
                            let _ = run_restic(exec, ctx, rp, &key_remove_args(id), Duration::from_secs(120));
                        }
                    }
                    return Err(e);
                }
            }
        }
        Ok(ids)
    })?;
    // The old keys stay in the repositories (and in the caller's saved state) until the caller has saved the new ids.
    let mut merged = state.recovery_key.as_ref().map(|k| k.key_ids.clone()).unwrap_or_default();
    let old_ids: Vec<(String, String)> = repos.iter().filter_map(|(n, _)| merged.get(n).map(|id| (n.clone(), id.clone()))).collect();
    merged.extend(ids);
    state.recovery_key = Some(RecoveryKeyRef { issued_at: now, key_ids: merged });
    Ok(Exported { key, issued_at: now, repos: repos.iter().map(|(n, _)| n.clone()).collect(), escrow, warnings: Vec::new(), old_ids })
}

/// Configured destinations that hold no recovery key (added while none was issued, or never given one).
/// Nothing is missing before the first `key-export`.
// CARRY T9: status::fragment turns a non-empty result into a BACKUP_KEY_NOT_ON_DEST warning (name the destinations).
pub fn dests_without_recovery_key(cfg: &BackupConfig, state: &BackupState) -> Vec<String> {
    match &state.recovery_key {
        None => Vec::new(),
        Some(k) => cfg.destinations.iter().filter(|d| !k.key_ids.contains_key(&d.name)).map(|d| d.name.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{DestKind, Destination};
    use crate::backup::restic::{Password, Repo};
    use crate::backup::util::fake::{test_ctx, FakeExec};
    use crate::envelope::Code;

    /// A throwaway vendor key made at run time; the private half never leaves the test.
    fn test_escrow() -> (age::x25519::Identity, String) {
        let id = age::x25519::Identity::generate();
        let public = id.to_public().to_string();
        (id, public)
    }

    fn hex_to_bytes(h: &str) -> Vec<u8> {
        (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    fn ctx_in(d: &std::path::Path) -> BackupCtx {
        let mut c = test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.join("d"), d.join("p")));
        c.pack_dir = d.join("pack");
        c
    }
    fn non_dev_ctx(d: &std::path::Path) -> BackupCtx {
        let roots = crate::paths::Roots { dev: false, ..crate::paths::Roots::custom(d.join("d"), d.join("p")) };
        BackupCtx::new(&roots, d.join("pack"), crate::ports::Ports::new(47300).unwrap(), "t".into(), "t".into())
    }
    fn repo(n: &str) -> (String, Repo) {
        (n.to_string(), Repo { location: format!("D:\\{n}"), password: Password::Plain("x".into()), extra_env: vec![] })
    }
    fn dest(n: &str) -> Destination {
        Destination { name: n.into(), kind: DestKind::Device, path: Some(format!("D:\\{n}")), repo: None, volume_serial: None, added_at: 0, extra: Default::default() }
    }
    fn cfg_with(names: &[&str]) -> BackupConfig {
        BackupConfig { destinations: names.iter().map(|n| dest(n)).collect(), ..Default::default() }
    }
    fn state_with(ids: &[(&str, &str)]) -> BackupState {
        BackupState {
            recovery_key: Some(RecoveryKeyRef { issued_at: 1, key_ids: ids.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() }),
            ..Default::default()
        }
    }

    #[test]
    fn a_zero_filled_buffer_is_not_a_key() {
        assert!(!entropy_ok(&[0u8; 32]));
        assert!(entropy_ok(&(0u8..32).collect::<Vec<_>>()));
        let k = generate_machine_key().unwrap();
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(entropy_ok(&hex_to_bytes(&k)));
    }

    fn secrets_ctx() -> (tempfile::TempDir, BackupCtx) {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        std::fs::create_dir_all(c.paths.secrets()).unwrap();
        (d, c)
    }

    #[test]
    fn the_machine_key_is_created_once_and_never_over_an_existing_repository() {
        let (_d, c) = secrets_ctx();
        let p = ensure_machine_key(&c, false).unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert_eq!(ensure_machine_key(&c, false).unwrap(), p);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), first, "an existing key must never be rewritten");
        std::fs::remove_file(&p).unwrap();
        let e = ensure_machine_key(&c, true).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(!p.exists(), "no new key may be created for a repository that already exists");
    }

    #[test]
    fn a_new_machine_key_file_is_locked_down_to_system_and_administrators_on_a_real_root() {
        let d = tempfile::tempdir().unwrap();
        let c = non_dev_ctx(d.path());
        std::fs::create_dir_all(c.paths.secrets()).unwrap();
        let p = ensure_machine_key(&c, false).unwrap();
        let acl = crate::sys::path_acl(&p).unwrap();
        assert!(crate::backup::acl::acl_is_private(&acl).is_ok(), "{acl:?}");
    }

    #[test]
    fn a_damaged_key_file_is_refused() {
        let (_d, c) = secrets_ctx();
        std::fs::write(c.paths.machine_key(), "00").unwrap();
        assert_eq!(ensure_machine_key(&c, true).unwrap_err().code, Code::Precondition);
    }

    #[test]
    fn recovery_keys_are_30_symbols_in_groups_and_normalise_forgivingly() {
        let k = new_recovery_key().unwrap();
        let groups: Vec<&str> = k.split('-').collect();
        assert_eq!(groups.len(), 6);
        assert!(groups.iter().all(|g| g.len() == 5));
        assert!(!k.contains(['I', 'L', 'O', 'U']));
        assert_ne!(new_recovery_key().unwrap(), k);
        let sloppy = format!(" {} ", k.to_lowercase().replace('-', " "));
        assert_eq!(normalize_recovery_key(&sloppy).as_deref(), Some(k.as_str()));
        assert_eq!(normalize_recovery_key("ABCDE-FGHJK").as_deref(), None);
        assert_eq!(normalize_recovery_key("O0O0O-0O0O0-O0O0O-0O0O0-O0O0O-0O0O0").as_deref(), Some("00000-00000-00000-00000-00000-00000"));
    }

    #[test]
    fn non_ascii_characters_are_never_truncated_into_a_valid_symbol() {
        // U+0130 is 0x0130; `as u8` would turn it into 0x30, the digit '0'
        let sneaky = "\u{130}0000-00000-00000-00000-00000-00000";
        assert_eq!(normalize_recovery_key(sneaky), None);
        assert_eq!(normalize_recovery_key("0000\u{FF10}-00000-00000-00000-00000-00000"), None);
    }

    #[test]
    fn exporting_adds_one_key_per_repository_records_ids_and_leaves_no_key_file() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (identity, public) = test_escrow();
        let exec = FakeExec::default().on("D:\\local key add", 0, "saved new key with ID aaaa1111\n").on("D:\\usb key add", 0, "saved new key with ID bbbb2222\n");
        let mut st = BackupState::default();
        let out = export_recovery_key(&c, &exec, &mut st, &[repo("local"), repo("usb")], &cfg_with(&["usb"]), false, 1000, &public).unwrap();
        assert_eq!(out.repos, vec!["local", "usb"]);
        assert_eq!(st.recovery_key.as_ref().unwrap().key_ids["usb"], "bbbb2222");
        assert_eq!(std::fs::read_dir(c.paths.backups_tmp()).unwrap().count(), 0, "the temporary key file and its folder must be deleted");
        assert!(normalize_recovery_key(&out.key).is_some());
        // the escrow blob opens with the vendor identity and holds exactly the key
        let plain = age::decrypt(&identity, &out.escrow).unwrap();
        assert_eq!(plain, out.key.as_bytes());
        assert!(!format!("{out:?}").contains(&out.key), "Debug must not print the recovery key");
        // no key on any command line
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&out.key) && !l.contains(&out.key.replace('-', ""))), "the key must not appear on argv");
        let again = export_recovery_key(&c, &exec, &mut st, &[repo("local"), repo("usb")], &cfg_with(&["usb"]), false, 2000, &public).unwrap_err();
        assert_eq!(again.code, Code::Usage);
    }

    #[test]
    fn the_key_file_lives_in_a_private_per_run_folder_not_in_the_shared_tmp() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (_id, public) = test_escrow();
        let exec = FakeExec::default().on("key add", 0, "saved new key with ID aaaa1111\n");
        let mut st = BackupState::default();
        export_recovery_key(&c, &exec, &mut st, &[repo("local")], &cfg_with(&[]), false, 1000, &public).unwrap();
        let line = exec.calls.borrow()[0].clone();
        let file = std::path::PathBuf::from(line.split("--new-password-file ").nth(1).unwrap().trim());
        assert!(file.file_name().unwrap().to_string_lossy().starts_with("rk-"));
        let run = file.parent().unwrap();
        assert!(run.file_name().unwrap().to_string_lossy().starts_with("run-"), "{}", file.display());
        assert_eq!(run.parent().unwrap(), c.paths.backups_tmp());
    }

    #[test]
    fn rotating_removes_the_previous_keys_and_a_failed_add_changes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (_id, public) = test_escrow();
        let exec = FakeExec::default().on("key add", 0, "saved new key with ID cccc3333\n");
        let mut st = BackupState::default();
        export_recovery_key(&c, &exec, &mut st, &[repo("local")], &cfg_with(&[]), false, 1000, &public).unwrap();
        let before = st.recovery_key.clone();
        let out = export_recovery_key(&c, &exec, &mut st, &[repo("local")], &cfg_with(&[]), true, 2000, &public).unwrap();
        assert!(exec.index_of("key remove").is_none(), "nothing is removed by the export itself: the caller saves first");
        assert_eq!(out.old_ids, vec![("local".to_string(), "cccc3333".to_string())]);
        assert!(retire_old_keys(&c, &exec, &[repo("local")], &out.old_ids).is_empty());
        assert!(exec.index_of("key remove cccc3333").is_some());
        assert_eq!(st.recovery_key.as_ref().unwrap().issued_at, 2000);
        let failing = FakeExec::default().on("key add", 1, "");
        let mut st2 = BackupState { recovery_key: before.clone(), ..Default::default() };
        assert!(export_recovery_key(&c, &failing, &mut st2, &[repo("local")], &cfg_with(&[]), true, 3000, &public).is_err());
        assert_eq!(st2.recovery_key, before);
    }

    #[test]
    fn a_rotation_that_would_leave_an_unplugged_destination_on_the_old_key_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (_id, public) = test_escrow();
        let exec = FakeExec::default().on("key add", 0, "saved new key with ID dddd4444\n");
        let mut st = state_with(&[("local", "aaaa1111"), ("usb", "bbbb2222"), ("nas", "cccc3333")]);
        let before = st.recovery_key.clone();
        let e = export_recovery_key(&c, &exec, &mut st, &[repo("local"), repo("usb")], &cfg_with(&["usb", "nas"]), true, 5000, &public).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("nas"), "{}", e.message);
        assert_eq!(exec.count_of("key add") + exec.count_of("key remove"), 0, "nothing may change in any repository");
        assert_eq!(st.recovery_key, before);
    }

    #[test]
    fn rotation_keeps_the_key_ids_of_repositories_it_did_not_touch_and_reports_a_failed_removal() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (_id, public) = test_escrow();
        let exec = FakeExec::default().on("key add", 0, "saved new key with ID eeee5555\n").on("key remove", 1, "");
        let mut st = state_with(&[("local", "aaaa1111"), ("retired", "ffff6666")]);
        let out = export_recovery_key(&c, &exec, &mut st, &[repo("local")], &cfg_with(&[]), true, 5000, &public).unwrap();
        let ids = &st.recovery_key.as_ref().unwrap().key_ids;
        assert_eq!(ids["local"], "eeee5555");
        assert_eq!(ids.get("retired").map(String::as_str), Some("ffff6666"), "the map must never be replaced wholesale");
        assert_eq!(out.old_ids, vec![("local".to_string(), "aaaa1111".to_string())], "only the repositories this export covered");
        let warnings = retire_old_keys(&c, &exec, &[repo("local")], &out.old_ids);
        assert!(warnings.iter().any(|w| w.contains("local") && w.contains("aaaa1111")), "{warnings:?}");
    }

    #[test]
    fn destinations_missing_from_the_recovery_key_ids_are_listed_for_the_status() {
        assert!(dests_without_recovery_key(&cfg_with(&["usb"]), &BackupState::default()).is_empty(), "no key issued yet: nothing is missing");
        let st = state_with(&[("local", "a1"), ("usb", "b2")]);
        assert_eq!(dests_without_recovery_key(&cfg_with(&["usb", "nas", "cloud"]), &st), vec!["nas", "cloud"]);
    }

    #[test]
    fn a_failure_on_the_second_repository_removes_the_key_already_added_to_the_first() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        let (_id, public) = test_escrow();
        let exec = FakeExec::default().on("D:\\local key add", 0, "saved new key with ID aaaa1111\n").on("D:\\usb key add", 1, "");
        let mut st = BackupState::default();
        assert!(export_recovery_key(&c, &exec, &mut st, &[repo("local"), repo("usb")], &cfg_with(&["usb"]), false, 1000, &public).is_err());
        assert!(exec.index_of("D:\\local key remove aaaa1111").is_some());
        assert!(st.recovery_key.is_none());
    }

    #[test]
    fn a_placeholder_or_malformed_escrow_key_aborts_before_any_repository_changes() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        for bad in ["PLACEHOLDER-NO-VENDOR-KEY", "age1garbage", ""] {
            let exec = FakeExec::default();
            let mut st = BackupState::default();
            let e = export_recovery_key(&c, &exec, &mut st, &[repo("local")], &cfg_with(&[]), false, 1000, bad).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "{bad}");
            assert_eq!(exec.count_of("key add"), 0);
            assert!(st.recovery_key.is_none());
        }
    }
}
