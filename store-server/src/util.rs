//! Small shared helpers: UTC timestamps, hex, the OS CSPRNG, atomic file writes and
//! secret redaction for logs. No other module re-implements any of these.
//! Must never: print or log a secret, or touch a file other than the one it is handed.

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// `2026-10-02T12:00:00Z` for a Unix timestamp. Howard Hinnant's civil-from-days
/// algorithm, so no date crate is needed for the two places posctl formats time.
pub fn rfc3339_utc(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_rfc3339() -> String {
    rfc3339_utc(now_unix())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Streaming SHA-256 of a file, lower-case hex.
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(hex(&h.finalize()));
        }
        h.update(&buf[..n]);
    }
}

pub fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| format!("the OS random source failed: {e}"))?;
    Ok(buf)
}

/// `n_bytes` of OS randomness as lower-case hex (hex only: safe inside URLs, SQL and env files).
pub fn random_hex(n_bytes: usize) -> Result<String, String> {
    Ok(hex(&random_bytes(n_bytes)?))
}

/// RFC 4122 version-4 UUID, lower case.
pub fn random_uuid_v4() -> Result<String, String> {
    let mut b = random_bytes(16)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// A uniform, zero-padded six-digit string (rejection sampling, no modulo bias).
pub fn random_digits6() -> Result<String, String> {
    const LIMIT: u32 = 4_294_000_000; // 4294 * 1_000_000, the largest multiple of 10^6 below u32::MAX
    loop {
        let b = random_bytes(4)?;
        let x = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if x < LIMIT {
            return Ok(format!("{:06}", x % 1_000_000));
        }
    }
}

/// A six-digit PIN anyone would try first: one repeated digit, or a run that steps +1 or -1 (mod 10) at every
/// position (123456, 654321, 012345, 567890). Refused when supplied, redrawn when generated.
pub fn is_trivial_pin(pin: &str) -> bool {
    let d: Vec<i32> = pin.bytes().map(|b| i32::from(b) - 48).collect();
    if d.len() < 2 || d.iter().any(|x| !(0..=9).contains(x)) {
        return false;
    }
    let step = (d[1] - d[0]).rem_euclid(10);
    matches!(step, 0 | 1 | 9) && d.windows(2).all(|w| (w[1] - w[0]).rem_euclid(10) == step)
}

/// Lower-case RFC 4122 version-4 UUID text (what `random_uuid_v4` makes).
pub fn is_uuid_v4(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(c) })
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}

/// Empties a folder (files, links and sub-folders) and keeps the folder itself.
pub fn clear_dir(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // a symlink/junction is removed as a link, never followed into its target
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?
        } else {
            std::fs::remove_file(entry.path())?
        }
    }
    Ok(())
}

/// Write `bytes` to a sibling temp file, flush it to disk, then rename it over `path`.
/// A reader sees the old file or the new one, never a torn write. The temp name is
/// random and opened with `create_new`, so an existing file or link is never followed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic_prepared(path, bytes, &|_| Ok(()))
}

/// `write_atomic` with a step that runs on the finished temp file just before the rename (for example to restrict its
/// ACL, so the target never exists with the inherited one). If `prepare` fails the temp file is removed and the target
/// is left as it was.
pub fn write_atomic_prepared(path: &Path, bytes: &[u8], prepare: &dyn Fn(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let suffix = random_hex(8).map_err(std::io::Error::other)?;
    write_atomic_via(path, bytes, &path.with_file_name(format!(".{name}.{suffix}.tmp")), prepare)
}

fn write_atomic_via(path: &Path, bytes: &[u8], tmp: &Path, prepare: &dyn Fn(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(tmp)?;
    let written = f.write_all(bytes).and_then(|()| f.sync_all());
    drop(f);
    if let Err(e) = written.and_then(|()| prepare(tmp)) {
        let _ = std::fs::remove_file(tmp);
        return Err(e);
    }
    let mut attempt = 0;
    loop {
        match std::fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            // Windows: a reader holding the target open gives a transient sharing violation.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 10 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                let _ = std::fs::remove_file(tmp);
                return Err(e);
            }
        }
    }
}

/// Replaces every registered secret value in a text with `***` before it reaches a log
/// or an error message (the kit's `.Replace($secret, '***')`, made systematic).
#[derive(Default, Clone)]
pub struct Redactor {
    secrets: Vec<String>,
    short: Vec<String>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Values shorter than 8 characters are ignored: replacing "0" everywhere would wreck the log.
    /// Use [`Redactor::add_short`] for those.
    pub fn add(&mut self, secret: &str) {
        if secret.len() >= 8 && !self.secrets.iter().any(|s| s == secret) {
            self.secrets.push(secret.to_string());
        }
    }

    /// For short secrets (a six-digit PIN): only whole-token matches are replaced, so the
    /// PIN is hidden but "91234567" is left alone. Callers register the first-admin PIN
    /// and the derived staff password with it.
    pub fn add_short(&mut self, v: &str) {
        if !v.is_empty() && !self.short.iter().any(|s| s == v) {
            self.short.push(v.to_string());
        }
    }

    pub fn redact(&self, text: &str) -> String {
        // (value, whole_token_only), longest first so a secret containing another is hidden whole.
        let mut all: Vec<(&str, bool)> = self.secrets.iter().map(|s| (s.as_str(), false)).collect();
        all.extend(self.short.iter().map(|s| (s.as_str(), true)));
        all.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
        let mut out = text.to_string();
        for (s, whole) in all {
            out = if whole { replace_whole_token(&out, s) } else { out.replace(s, "***") };
        }
        out
    }
}

/// Replace `needle` only where it is not touching an ASCII letter or digit on either side.
fn replace_whole_token(text: &str, needle: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = 0;
    for (i, _) in text.match_indices(needle) {
        if i < rest {
            continue;
        }
        let before = text[..i].chars().next_back();
        let after = text[i + needle.len()..].chars().next();
        if before.is_some_and(|c| c.is_ascii_alphanumeric()) || after.is_some_and(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        out.push_str(&text[rest..i]);
        out.push_str("***");
        rest = i + needle.len();
    }
    out.push_str(&text[rest..]);
    out
}

impl std::fmt::Debug for Redactor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Redactor({} values)", self.secrets.len() + self.short.len())
    }
}

/// File bytes for a secret only posctl reads: `POSDPAPI1` line + DPAPI blob. Never plaintext, never a fallback.
pub fn wrap_secret(text: &str) -> std::io::Result<Vec<u8>> {
    let mut out = crate::dpapi::MAGIC.to_vec();
    out.extend(crate::dpapi::protect(text.as_bytes())?);
    Ok(out)
}

/// Replace `path` atomically with the wrapped form of `text` (it inherits the secrets folder's ACL).
pub fn write_secret_file(path: &Path, text: &str) -> std::io::Result<()> {
    write_atomic(path, &wrap_secret(text)?)
}

/// The one reader of posctl-only secret files. A wrapped file is unwrapped; a legacy plaintext file is returned and
/// rewrapped in place (atomically, so no plaintext is left behind; callers hold the ops lock); a `POSDPAPI1` header
/// over a bad blob is `InvalidData` and the file is left untouched (the caller must not regenerate over it).
pub fn read_secret_file(path: &Path) -> std::io::Result<Secret> {
    let raw = std::fs::read(path)?;
    if let Some(blob) = raw.strip_prefix(crate::dpapi::MAGIC) {
        return crate::dpapi::unprotect(blob);
    }
    if raw.starts_with(&crate::dpapi::MAGIC[..crate::dpapi::MAGIC.len() - 1]) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "the secret file has a damaged DPAPI header"));
    }
    let text = String::from_utf8(raw).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "the secret file is not UTF-8"))?;
    // the new file must keep the original's own DACL (the temp file would otherwise only inherit the folder's)
    write_atomic_prepared(path, &wrap_secret(&text)?, &|tmp| crate::acl::copy_dacl(path, tmp).map_err(std::io::Error::other))?;
    Ok(Secret(text))
}

/// A secret string whose `Debug` never prints the value. Wrap every secret held in a
/// struct that derives `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(pub String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_known_instants() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_790_942_400), "2026-10-02T12:00:00Z");
        assert_eq!(rfc3339_utc(951_868_799), "2000-02-29T23:59:59Z"); // leap day
    }

    #[test]
    fn hex_and_sha256_match_known_answers() {
        assert_eq!(hex(&[0x00, 0xab, 0xff]), "00abff");
        // SHA-256 of the empty input
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn random_hex_has_the_requested_length_and_differs() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn uuid_v4_has_version_and_variant_bits() {
        let u = random_uuid_v4().unwrap();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn digits6_is_always_six_digits() {
        for _ in 0..500 {
            let d = random_digits6().unwrap();
            assert_eq!(d.len(), 6);
            assert!(d.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("status.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["status.json".to_string()]);
    }

    #[test]
    fn redactor_hides_registered_values_only() {
        let mut r = Redactor::new();
        let value = "abcdef0123456789";
        r.add(value);
        r.add("short");
        assert_eq!(r.redact(&format!("url=db://u:{value}@h short")), "url=db://u:***@h short");
    }

    #[cfg(windows)]
    mod secret_files {
        use super::super::*;
        const FAKE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        #[test]
        fn wrapped_file_has_the_magic_line_and_no_hex_secret() {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("s.txt");
            write_secret_file(&p, FAKE).unwrap();
            let raw = std::fs::read(&p).unwrap();
            assert!(raw.starts_with(b"POSDPAPI1
"), "magic line first");
            assert!(!raw.windows(64).any(|w| w.iter().all(|b| b.is_ascii_hexdigit())), "no 64-hex run on disk");
            assert_eq!(read_secret_file(&p).unwrap().expose(), FAKE);
        }

        #[test]
        fn the_rewrap_keeps_the_original_files_dacl() {
            // a tempdir file (not a real store file), protected DACL of SYSTEM and the file's owner only
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("s.txt");
            std::fs::write(&p, FAKE).unwrap();
            use crate::acl::{apply_one_with_owner, Grant, Inherit, SID_SYSTEM};
            let me = crate::sys::path_owner_sid(&p).unwrap();
            apply_one_with_owner(&p, &[Grant::new(SID_SYSTEM, "F", Inherit::No), Grant::new(me, "F", Inherit::No)], None).unwrap();
            let before = crate::sys::path_acl(&p).unwrap();
            assert!(before.protected && before.aces.len() == 2);
            assert_eq!(read_secret_file(&p).unwrap().expose(), FAKE);
            assert!(std::fs::read(&p).unwrap().starts_with(crate::dpapi::MAGIC), "rewrapped");
            assert_eq!(crate::sys::path_acl(&p).unwrap(), before, "the rewrap must not drop the per-file DACL");
        }

        #[test]
        fn legacy_plaintext_is_read_once_and_rewrapped() {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("s.txt");
            std::fs::write(&p, FAKE).unwrap();
            assert_eq!(read_secret_file(&p).unwrap().expose(), FAKE);
            let raw = std::fs::read(&p).unwrap();
            assert!(raw.starts_with(b"POSDPAPI1
"), "the plaintext was replaced");
            assert!(!raw.windows(FAKE.len()).any(|w| w == FAKE.as_bytes()), "no plaintext leftover");
            assert_eq!(read_secret_file(&p).unwrap().expose(), FAKE, "second read goes through the blob");
            let leftovers: Vec<_> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(leftovers.len(), 1, "no temp file left: {leftovers:?}");
        }

        #[test]
        fn bad_blob_is_a_hard_error_never_a_regenerate() {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("s.txt");
            let junk = b"POSDPAPI1
not a real blob".to_vec();
            std::fs::write(&p, &junk).unwrap();
            let e = read_secret_file(&p).unwrap_err();
            assert_eq!(e.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(std::fs::read(&p).unwrap(), junk, "the file is left untouched");
        }

        #[test]
        fn an_absent_file_stays_not_found() {
            let d = tempfile::tempdir().unwrap();
            assert_eq!(read_secret_file(&d.path().join("none")).unwrap_err().kind(), std::io::ErrorKind::NotFound);
        }
    }

    #[test]
    fn secret_debug_never_prints_the_value() {
        let s = Secret("topsecretvalue".into());
        assert!(!format!("{s:?}").contains("topsecret"));
        assert_eq!(s.expose(), "topsecretvalue");
    }
    #[test]
    fn write_atomic_never_touches_a_preexisting_temp_name() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("status.json");
        let tmp = dir.path().join(".status.json.fixed.tmp");
        std::fs::write(&tmp, b"victim").unwrap();
        let err = write_atomic_via(&p, b"new", &tmp, &|_| Ok(())).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&tmp).unwrap(), b"victim");
        assert!(!p.exists());
    }

    #[test]
    fn write_atomic_leaves_no_temp_after_a_failed_rename() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a-directory");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("child"), b"x").unwrap(); // non-empty dir: rename over it fails
        assert!(write_atomic(&target, b"data").is_err());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a-directory".to_string()]);
    }

    #[test]
    fn write_atomic_concurrent_writers_both_succeed_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("status.json");
        let handles: Vec<_> = (0..2)
            .map(|i| {
                let p = p.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        write_atomic(&p, format!("writer-{i}").as_bytes()).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body == "writer-0" || body == "writer-1");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn short_secret_is_redacted_as_a_whole_token_only() {
        let mut r = Redactor::new();
        r.add_short("123456");
        assert_eq!(r.redact("pin 123456 ok, code: 123456."), "pin *** ok, code: ***.");
        assert_eq!(r.redact("order 91234567 and 1234567"), "order 91234567 and 1234567");
    }

    #[test]
    fn overlapping_secrets_are_fully_hidden_longest_first() {
        let mut r = Redactor::new();
        r.add("abcdefgh");
        r.add("abcdefgh-tail1");
        assert_eq!(r.redact("x abcdefgh-tail1 y"), "x *** y");
        let mut r = Redactor::new();
        r.add_short("123456");
        r.add("123456-and-more");
        assert_eq!(r.redact("v=123456-and-more"), "v=***");
    }

    #[test]
    fn trivial_pins_are_recognised() {
        for t in ["000000", "777777", "123456", "654321", "234567", "012345", "987654", "567890", "098765"] {
            assert!(is_trivial_pin(t), "{t}");
        }
        for ok in ["135790", "123450", "121212", "100001", "482915"] {
            assert!(!is_trivial_pin(ok), "{ok}");
        }
    }

    #[test]
    fn uuid_v4_check_is_strict() {
        assert!(is_uuid_v4(&random_uuid_v4().unwrap()));
        for bad in ["", "11111111-2222-3333-8444-555555555555", "11111111-2222-4333-7444-555555555555", "11111111222243338444555555555555", "11111111-2222-4333-8444-55555555555g", "../../etc/passwd"] {
            assert!(!is_uuid_v4(bad), "{bad}");
        }
    }

    #[test]
    fn clear_dir_removes_files_and_subfolders_but_keeps_the_folder() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("sub/deeper")).unwrap();
        std::fs::write(d.path().join("sub/deeper/x.sql"), "x").unwrap();
        std::fs::write(d.path().join("a.sql"), "x").unwrap();
        clear_dir(d.path()).unwrap();
        assert!(d.path().is_dir() && std::fs::read_dir(d.path()).unwrap().next().is_none());
    }
}
