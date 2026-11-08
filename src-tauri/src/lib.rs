mod commands;

use commands::logger::write_log;
use commands::posctl_console::posctl_open_console;
use commands::print_audit::{get_print_job, get_print_jobs, list_printers};
use commands::printer::{open_cash_drawer, print_raw_text, print_receipt, test_print};
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub supabase_url: String,
    pub supabase_anon_key: String,
    /// Licensing server (separate Supabase project). Empty = fall back to VITE_ build-time env.
    pub license_server_url: String,
    pub license_server_anon_key: String,
    /// `cloud` (the default) or `offline-only`. Only `client\store.env`, written by posctl, can set it.
    pub store_mode: String,
    /// SHA-256 (64 lower-case hex) of the store root CA certificate; empty outside Offline only.
    pub store_ca_sha256: String,
    /// Why a present `store.env` was refused (never a URL or key); empty when none was or it was accepted.
    pub store_config_error: String,
    /// A rejected runtime-override URL or an accepted one is recorded here
    /// (naming the field and the offending host, never the key) instead of
    /// `eprintln!`, which a release build's `windows_subsystem = "windows"`
    /// detaches before anyone could see it. Read and logged by AppConfigProvider.
    pub warnings: Vec<String>,
}

/// A runtime-override backend host is only trusted when it is the
/// project's own Supabase host (over https) or a local dev/loopback stack
/// (either scheme) — never an arbitrary host that merely contains
/// "supabase.co" somewhere in it (e.g. `evil.supabase.co.attacker.example`,
/// which does NOT end with ".supabase.co" once parsed and checked on the
/// host alone, not the whole URL string).
fn is_allowed_backend_url(url_str: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url_str) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let is_loopback = host == "localhost" || host == "127.0.0.1";
    match parsed.scheme() {
        "https" => host.ends_with(".supabase.co") || host.ends_with(".supabase.in") || is_loopback,
        "http" => is_loopback,
        _ => false,
    }
}

/// The one port the CSP opens for the store server (`store-server/resources/csp-port.txt`, pinned by a test).
fn csp_port() -> u16 {
    include_str!("../../store-server/resources/csp-port.txt").trim().parse().unwrap_or(0)
}

/// The backend address a store server's `client\store.env` may name in Offline only: https, the CSP port, no
/// userinfo/path/query, and a host on the shop network (a private or loopback IPv4, a `*.local` name, a single-label
/// name or `localhost`). Never a public name, so a damaged or hostile file cannot point a till at the internet.
/// Returns the normalised URL (what the webview will parse), without a trailing slash.
fn normalize_store_url(url_str: &str) -> Option<String> {
    let parsed = url::Url::parse(url_str).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port() != Some(csp_port())
        || !(parsed.path().is_empty() || parsed.path() == "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let host_ok = match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback(),
        Some(url::Host::Domain(d)) => {
            d == "localhost"
                || (d.ends_with(".local") && d.len() > ".local".len())
                || (!d.is_empty() && !d.contains('.'))
        }
        _ => false,
    };
    host_ok.then(|| parsed.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
fn is_allowed_store_url(url_str: &str) -> bool {
    normalize_store_url(url_str).is_some()
}

/// The host to name in a warning — never the full URL, which may carry
/// userinfo (`https://user:pass@host`) that a warning must not repeat back
/// through AppConfigProvider's logger.
fn describe_host(url_str: &str) -> String {
    url::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "unparseable URL".to_string())
}

/// Pure parse of a `.env` file's content into an `AppConfig` — extracted from
/// `read_env_config` so the line-order-independent validation below, and the
/// whole function, are unit-testable without touching the filesystem.
fn parse_env_config(content: &str) -> AppConfig {
    let mut config = AppConfig::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "VITE_SUPABASE_URL" => config.supabase_url = value.trim().to_string(),
                "VITE_SUPABASE_ANON_KEY" => {
                    config.supabase_anon_key = value.trim().to_string()
                }
                "VITE_LICENSE_SERVER_URL" => {
                    config.license_server_url = value.trim().to_string()
                }
                "VITE_LICENSE_SERVER_ANON_KEY" => {
                    config.license_server_anon_key = value.trim().to_string()
                }
                _ => {}
            }
        }
    }

    // Validated AFTER the full line loop, not inline mid-loop: a paired key's
    // line can appear before or after its URL's line in the file, so only a
    // post-loop pass over the fully-populated struct can reliably clear both
    // together — clearing inline could miss a not-yet-parsed key or let a
    // later line silently re-set one already cleared.
    if !config.supabase_url.is_empty() {
        if is_allowed_backend_url(&config.supabase_url) {
            config.warnings.push(format!(
                "Using VITE_SUPABASE_URL override — host: {}",
                describe_host(&config.supabase_url)
            ));
        } else {
            config.warnings.push(format!(
                "Ignored VITE_SUPABASE_URL override — host not allowed: {}",
                describe_host(&config.supabase_url)
            ));
            config.supabase_url = String::new();
            config.supabase_anon_key = String::new();
        }
    }
    if !config.license_server_url.is_empty() {
        if is_allowed_backend_url(&config.license_server_url) {
            config.warnings.push(format!(
                "Using VITE_LICENSE_SERVER_URL override — host: {}",
                describe_host(&config.license_server_url)
            ));
        } else {
            config.warnings.push(format!(
                "Ignored VITE_LICENSE_SERVER_URL override — host not allowed: {}",
                describe_host(&config.license_server_url)
            ));
            config.license_server_url = String::new();
            config.license_server_anon_key = String::new();
        }
    }

    config
}

/// Drops one pair of matching surrounding quotes (hand-edited files) and the spaces inside them.
fn unquote(v: &str) -> &str {
    let b = v.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        v[1..v.len() - 1].trim()
    } else {
        v
    }
}

/// Bytes of a `store.env` to text: UTF-8 (BOM dropped) or UTF-16 LE/BE with a BOM (Notepad "Unicode" saves). Anything
/// else, including BOM-less UTF-16 (NUL bytes), is unreadable.
fn decode_store_bytes(bytes: &[u8]) -> Result<String, ()> {
    let utf16 = |rest: &[u8], le: bool| -> Result<String, ()> {
        if !rest.len().is_multiple_of(2) {
            return Err(());
        }
        let units = rest.as_chunks::<2>().0.iter().map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) });
        char::decode_utf16(units).collect::<Result<String, _>>().map_err(|_| ())
    };
    let text = match bytes {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, true)?,
        [0xFE, 0xFF, rest @ ..] => utf16(rest, false)?,
        _ => String::from_utf8(bytes.to_vec()).map_err(|_| ())?,
    };
    if text.contains('\0') {
        return Err(());
    }
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Why a `store.env` that exists was not used: records the stable code, keeps the till in `cloud` mode and leaves no
/// URL, key or fingerprint behind (the pairing screen reads the code; nothing is ever silent).
fn refuse_store_env(config: &mut AppConfig, code: &str, warning: String) {
    config.store_mode = "cloud".to_string();
    config.store_config_error = code.to_string();
    config.supabase_url = String::new();
    config.supabase_anon_key = String::new();
    config.store_ca_sha256 = String::new();
    config.warnings.push(warning);
}

/// Layers `client\store.env` (written only by posctl) over the `.env` result. Only Offline only reads anything from
/// it: in cloud mode the file can say `cloud` and nothing else (the till always uses the build-time or `.env` cloud
/// URL, so a planted file cannot redirect sign-ins). In Offline only the file is accepted whole or not at all: the URL
/// must pass `normalize_store_url`, the anon key must be present and the CA fingerprint must be 64 hex. A file that
/// has any `VITE_SUPABASE_*` / `VITE_STORE_*` key without a valid `VITE_STORE_MODE` (blank, misspelled, missing, file
/// truncated) is refused with `STORE_MODE_UNKNOWN`; a file with no store keys at all names nothing to protect and is
/// ignored with a warning, the till stays in cloud mode (B1, extends P11-3).
fn apply_store_env(config: &mut AppConfig, content: &str) {
    let (mut mode, mut url, mut anon, mut ca) = (String::new(), String::new(), String::new(), String::new());
    let mut seen: Vec<&str> = Vec::new();
    let mut store_keys = false;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // B1: any store key, misspelled or cut off mid-line, means this file was meant to configure a store
        let name = line.split_once('=').map_or(line, |(k, _)| k.trim());
        store_keys |= ["VITE_SUPABASE_", "VITE_STORE_"].iter().any(|p| name.starts_with(p) || (name.len() >= 5 && p.starts_with(name)));
        if let Some((key, value)) = line.split_once('=') {
            let (key, value) = (key.trim(), unquote(value.trim()).to_string());
            // last value wins; only the key name is ever logged (the values are secrets)
            if matches!(key, "VITE_STORE_MODE" | "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY" | "VITE_STORE_CA_SHA256") {
                if seen.contains(&key) {
                    config.warnings.push(format!("store.env has a duplicate {key} line, the last one is used"));
                }
                seen.push(key);
            }
            match key {
                "VITE_STORE_MODE" => mode = value.to_ascii_lowercase(),
                "VITE_SUPABASE_URL" => url = value,
                "VITE_SUPABASE_ANON_KEY" => anon = value,
                "VITE_STORE_CA_SHA256" => ca = value.to_ascii_lowercase(),
                _ => {}
            }
        }
    }
    match mode.as_str() {
        "cloud" => {
            config.store_mode = "cloud".to_string();
            if !url.is_empty() {
                config.warnings.push("Ignored store.env VITE_SUPABASE_URL — cloud mode keeps its own backend".to_string());
            }
        }
        "offline-only" => match normalize_store_url(&url) {
            None => refuse_store_env(
                config,
                "STORE_URL_REJECTED",
                format!("Ignored store.env — store address not allowed: {}", describe_host(&url)),
            ),
            Some(_) if anon.is_empty() => {
                refuse_store_env(config, "STORE_KEY_MISSING", "Ignored store.env — anon key missing".to_string())
            }
            Some(_) if !is_sha256_hex(&ca) => refuse_store_env(
                config,
                "STORE_CA_MISSING",
                "Ignored store.env — CA fingerprint missing or malformed".to_string(),
            ),
            Some(norm) => {
                config.warnings.push(format!("Using store.env (offline-only) — host: {}", describe_host(&norm)));
                config.store_mode = "offline-only".to_string();
                config.supabase_url = norm;
                config.supabase_anon_key = anon;
                config.store_ca_sha256 = ca;
            }
        },
        // a mode key with a value we do not know (`offlin-only`, blank), or store keys with no valid mode at all
        // (misspelled or truncated file), may be an offline store: block, never guess
        _ if store_keys => {
            refuse_store_env(config, "STORE_MODE_UNKNOWN", "Ignored store.env — unknown VITE_STORE_MODE value".to_string())
        }
        // no store keys at all (empty or unrelated file) = nothing to protect: cloud mode without a blocking code
        _ => {
            config.store_mode = "cloud".to_string();
            config.warnings.push("Ignored store.env: no store settings for offline-only, this till stays in cloud mode".to_string());
        }
    }
}

/// Applies the outcome of `read_store_file` (no file = a cloud till; a file that exists but cannot be used = cloud
/// with a stable code, never silent).
fn apply_store_file(config: &mut AppConfig, file: Result<Option<String>, &'static str>) {
    match file {
        Ok(None) => config.store_mode = "cloud".to_string(),
        Ok(Some(content)) => apply_store_env(config, &content),
        Err(code) => refuse_store_env(config, code, format!("Ignored store.env — {code}")),
    }
}

/// True only when every owner was read and is `BUILTIN\Administrators` or `SYSTEM`. A standard user can create files
/// and folders under ProgramData but can never make Administrators the owner.
fn owners_trusted(owners: &[Result<String, String>]) -> bool {
    !owners.is_empty() && owners.iter().all(|o| matches!(o.as_deref(), Ok("S-1-5-32-544") | Ok("S-1-5-18")))
}

/// Reads `client\store.env` if it exists. The file, `client\` and `SupermarketPOS\` must all be owned by
/// Administrators or SYSTEM (`owner_of` returns an SID string), else the file is ignored with
/// `STORE_ENV_UNTRUSTED_OWNER`. A present file that is not UTF-8 (UTF-16 "Unicode" saves) or cannot be read is
/// `STORE_FILE_UNREADABLE`. A UTF-8 BOM is dropped and UTF-16 with a BOM is decoded.
fn read_store_file(
    path: &std::path::Path,
    owner_of: &dyn Fn(&std::path::Path) -> Result<String, String>,
    is_reparse: &dyn Fn(&std::path::Path) -> bool,
) -> Result<Option<String>, &'static str> {
    // junction/symlink anywhere in store.env -> client\ -> SupermarketPOS\ (checked before exists(), which follows them)
    if path.ancestors().take(3).any(is_reparse) {
        return Err("STORE_ENV_UNTRUSTED_PATH");
    }
    if !path.exists() {
        return Ok(None);
    }
    let owners: Vec<_> = path.ancestors().take(3).map(owner_of).collect();
    if !owners_trusted(&owners) {
        return Err("STORE_ENV_UNTRUSTED_OWNER");
    }
    let bytes = std::fs::read(path).map_err(|_| "STORE_FILE_UNREADABLE")?;
    decode_store_bytes(&bytes).map(Some).map_err(|()| "STORE_FILE_UNREADABLE")
}

#[cfg(windows)]
fn path_owner_sid(path: &std::path::Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows::Win32::Security::{OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID};
    let w: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut owner = PSID::default();
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `w` is NUL-terminated and outlives the call; the out pointers are valid; the returned descriptor and
    // string are freed with LocalFree below.
    unsafe {
        let rc = GetNamedSecurityInfoW(PCWSTR(w.as_ptr()), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, Some(&mut owner), None, None, None, &mut sd);
        if rc.0 != 0 {
            return Err(format!("GetNamedSecurityInfo failed ({})", rc.0));
        }
        let mut s = PWSTR::null();
        let out = match ConvertSidToStringSidW(owner, &mut s) {
            Ok(()) => Ok(s.to_string().unwrap_or_default()),
            Err(_) => Err("ConvertSidToStringSid failed".to_string()),
        };
        if !s.is_null() {
            let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
        }
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        out
    }
}

/// Reparse points (junctions, symlinks) redirect a path to another volume whose owner SIDs mean nothing here.
#[cfg(windows)]
fn path_is_reparse_point(path: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path).map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0).unwrap_or(false)
}

/// The ProgramData base must be a local fixed drive: no UNC / network path, no removable or remote volume.
fn vet_base(base: &std::path::Path, is_fixed: &dyn Fn(&std::path::Path) -> bool) -> Result<(), &'static str> {
    if base.to_string_lossy().starts_with(r"\\") || !is_fixed(base) {
        return Err("STORE_ENV_UNTRUSTED_PATH");
    }
    Ok(())
}

#[cfg(windows)]
fn drive_is_fixed(path: &std::path::Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_FIXED: u32 = 3;
    let root: Vec<u16> = path.components().next().map(|c| c.as_os_str().to_owned()).into_iter().flat_map(|c| c.encode_wide().collect::<Vec<_>>()).chain([92u16, 0]).collect();
    // SAFETY: `root` is NUL-terminated and outlives the call.
    unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) == DRIVE_FIXED }
}

/// `SHGetKnownFolderPath(FOLDERID_ProgramData)`: the user cannot redirect it with an environment variable.
#[cfg(windows)]
fn known_program_data() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    // SAFETY: the returned PWSTR is copied then freed with CoTaskMemFree.
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, None).ok()?;
        let out = p.to_string().ok().map(std::path::PathBuf::from);
        CoTaskMemFree(Some(p.0 as *const _));
        out
    }
}

/// `%ProgramData%\SupermarketPOS\client\store.env`. Offline only is a Windows product; elsewhere there is no file.
/// `Err` = the base is not a trusted local fixed drive (ignored with `STORE_ENV_UNTRUSTED_PATH`).
fn store_env_path() -> Option<Result<std::path::PathBuf, &'static str>> {
    #[cfg(windows)]
    {
        let Some(base) = known_program_data() else { return Some(Err("STORE_ENV_UNTRUSTED_PATH")) };
        Some(vet_base(&base, &drive_is_fixed).map(|()| base.join("SupermarketPOS").join("client").join("store.env")))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn read_env_config() -> AppConfig {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let env_path = exe_dir.join(".env");

    let content = std::fs::read_to_string(&env_path).unwrap_or_default();
    let mut config = parse_env_config(&content);
    #[cfg(windows)]
    let file = match store_env_path() {
        Some(Ok(path)) => read_store_file(&path, &path_owner_sid, &path_is_reparse_point),
        Some(Err(code)) => Err(code),
        None => Ok(None),
    };
    #[cfg(not(windows))]
    let file = Ok(None);
    apply_store_file(&mut config, file);
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_a_customer_supabase_host_over_https() {
        assert!(is_allowed_backend_url("https://abcdefgh.supabase.co"));
        assert!(is_allowed_backend_url("https://abcdefgh.supabase.in"));
    }

    #[test]
    fn allows_loopback_over_either_scheme() {
        assert!(is_allowed_backend_url("http://localhost:54321"));
        assert!(is_allowed_backend_url("https://localhost:54321"));
        assert!(is_allowed_backend_url("http://127.0.0.1:54321"));
        assert!(is_allowed_backend_url("https://127.0.0.1:54321"));
    }

    #[test]
    fn rejects_a_host_suffix_match_that_is_not_a_real_suffix() {
        // A `contains`/`ends_with`-on-the-whole-URL check would wrongly allow
        // this; the check must be on the parsed host alone.
        assert!(!is_allowed_backend_url(
            "https://evil.supabase.co.attacker.example"
        ));
    }

    #[test]
    fn rejects_a_supabase_host_over_plain_http() {
        assert!(!is_allowed_backend_url("http://abcdefgh.supabase.co"));
    }

    #[test]
    fn rejects_garbage_and_unparseable_urls() {
        assert!(!is_allowed_backend_url("not a url"));
        assert!(!is_allowed_backend_url(""));
        assert!(!is_allowed_backend_url("ftp://abcdefgh.supabase.co"));
    }

    #[test]
    fn parses_keys_and_skips_comments_and_blank_lines() {
        let content = "\n# comment\nVITE_SUPABASE_URL=https://abcdefgh.supabase.co\n\nVITE_SUPABASE_ANON_KEY=anon-key-1\nVITE_LICENSE_SERVER_URL=https://ijklmnop.supabase.co\nVITE_LICENSE_SERVER_ANON_KEY=anon-key-2\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "https://abcdefgh.supabase.co");
        assert_eq!(config.supabase_anon_key, "anon-key-1");
        assert_eq!(config.license_server_url, "https://ijklmnop.supabase.co");
        assert_eq!(config.license_server_anon_key, "anon-key-2");
        // Both overrides are allowed hosts, so both get a warning.
        assert_eq!(config.warnings.len(), 2);
    }

    #[test]
    fn clears_a_rejected_url_and_its_paired_key_when_the_key_line_comes_after() {
        let content = "VITE_SUPABASE_URL=https://evil.supabase.co.attacker.example\nVITE_SUPABASE_ANON_KEY=some-anon-key\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "");
        assert_eq!(config.supabase_anon_key, "");
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn rejects_a_userinfo_host_trick() {
        // The `url` crate parses the host of `scheme://user@host` as `host`,
        // not the string before the first `.`/`@` — confirms the allow-list
        // check runs on the parsed host, not a raw string match.
        assert!(!is_allowed_backend_url(
            "https://x.supabase.co@evil.example/"
        ));
    }

    #[test]
    fn clears_a_rejected_url_and_its_paired_key_when_the_key_line_comes_before() {
        // .env line order is arbitrary — the paired key's line can precede
        // the URL's own line.
        let content = "VITE_LICENSE_SERVER_ANON_KEY=some-anon-key\nVITE_LICENSE_SERVER_URL=https://evil.supabase.co.attacker.example\n";
        let config = parse_env_config(content);
        assert_eq!(config.license_server_url, "");
        assert_eq!(config.license_server_anon_key, "");
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn keeps_an_allowed_override_and_its_paired_key() {
        let content = "VITE_SUPABASE_URL=https://abcdefgh.supabase.co\nVITE_SUPABASE_ANON_KEY=some-anon-key\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "https://abcdefgh.supabase.co");
        assert_eq!(config.supabase_anon_key, "some-anon-key");
        // An accepted override still gets a warning — it's real logged
        // behavior a dev/support session should be able to see, unlike a
        // silent default.
        assert_eq!(config.warnings.len(), 1);
        assert!(config.warnings[0].contains("abcdefgh.supabase.co"));
    }
    // ---- Offline only: client\store.env ----

    const CA: &str = "9f3c0a5e7b1d4c2a8e6f0b3d5a7c9e1f2b4d6a8c0e3f5a7b9d1c3e5f7a9b0c2d";

    fn store_env(mode: &str, url: &str, anon: &str, ca: &str) -> String {
        format!("VITE_STORE_MODE={mode}\nVITE_SUPABASE_URL={url}\nVITE_SUPABASE_ANON_KEY={anon}\nVITE_STORE_CA_SHA256={ca}\n")
    }

    fn applied(content: &str) -> AppConfig {
        let mut config = parse_env_config("");
        apply_store_file(&mut config, Ok(Some(content.to_string())));
        config
    }

    #[test]
    fn allows_shop_network_addresses_over_https_with_a_port() {
        for ok in [
            "https://192.168.1.20:47304",
            "https://10.0.0.5:47304",
            "https://172.16.4.9:47304",
            "https://127.0.0.1:47304",
            "https://localhost:47304",
            "https://storepc:47304",
            "https://storepc.local:47304",
            "https://STOREPC:47304",
            "https://192.168.1.20:47304/",
        ] {
            assert!(is_allowed_store_url(ok), "{ok} must be allowed");
        }
    }

    #[test]
    fn refuses_everything_else_in_offline_only() {
        for bad in [
            "http://192.168.1.20:47304",
            "https://192.168.1.20",
            "https://192.168.1.20:443",
            "https://192.168.1.20:8443",
            "https://192.168.1.20:0",
            "https://134744072:47304",
            "https://0x08080808:47304",
            "https://010.010.010.010:47304",
            "https://[::1]:47304",
            "https://[::ffff:192.168.1.1]:47304",
            "https://100.64.0.1:47304",
            "https://0.0.0.0:47304",
            "https://172.32.0.1:47304",
            "https://storepc%2Eevil%2Ecom:47304",
            "https://storepc\u{3002}evil\u{3002}com:47304",
            "https://8.8.8.8:47304",
            "https://169.254.1.1:47304",
            "https://abcdefgh.supabase.co:47304",
            "https://evil.example.com:47304",
            "https://storepc.local.attacker.example:47304",
            "https://.local:47304",
            "https://user:pw@192.168.1.20:47304",
            "https://x.local@evil.example:47304",
            "https://192.168.1.20:47304/rest/v1",
            "https://192.168.1.20:47304/?a=1",
            "https://192.168.1.20:47304/#x",
            "ftp://192.168.1.20:47304",
            "",
            "not a url",
        ] {
            assert!(!is_allowed_store_url(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_valid_offline_only_file_sets_mode_url_key_and_fingerprint() {
        let c = applied(&store_env("offline-only", "https://storepc:47304", "anon-key-1", &CA.to_ascii_uppercase()));
        assert_eq!(c.store_mode, "offline-only");
        assert_eq!(c.supabase_url, "https://storepc:47304");
        assert_eq!(c.supabase_anon_key, "anon-key-1");
        assert_eq!(c.store_ca_sha256, CA);
        assert_eq!(c.store_config_error, "");
    }

    #[test]
    fn store_env_wins_over_the_dot_env_override() {
        let mut config = parse_env_config("VITE_SUPABASE_URL=https://abcdefgh.supabase.co\nVITE_SUPABASE_ANON_KEY=cloud-key\n");
        apply_store_file(&mut config, Ok(Some(store_env("offline-only", "https://storepc:47304", "store-key", CA))));
        assert_eq!(config.supabase_url, "https://storepc:47304");
        assert_eq!(config.supabase_anon_key, "store-key");
    }

    #[test]
    fn a_refused_offline_only_file_changes_nothing_and_says_why() {
        for (content, code) in [
            (store_env("offline-only", "https://evil.example.com:47304", "k", CA), "STORE_URL_REJECTED"),
            (store_env("offline-only", "http://storepc:47304", "k", CA), "STORE_URL_REJECTED"),
            (store_env("offline-only", "https://storepc:47304", "", CA), "STORE_KEY_MISSING"),
            (store_env("offline-only", "https://storepc:47304", "k", ""), "STORE_CA_MISSING"),
            (store_env("offline-only", "https://storepc:47304", "k", "abc"), "STORE_CA_MISSING"),
            (store_env("offline-only", "https://storepc:47304", "k", &"g".repeat(64)), "STORE_CA_MISSING"),
            (store_env("offline-only", "https://storepc:8443", "k", CA), "STORE_URL_REJECTED"),
        ] {
            let c = applied(&content);
            assert_eq!(c.store_mode, "cloud", "{code}");
            assert_eq!(c.store_config_error, code);
            assert_eq!(c.supabase_url, "", "{code}: a refused file must not leave a URL behind");
            assert_eq!(c.supabase_anon_key, "", "{code}");
            assert_eq!(c.store_ca_sha256, "", "{code}");
            assert_eq!(c.warnings.len(), 1, "{code}");
        }
    }

    #[test]
    fn a_mode_value_we_do_not_know_blocks() {
        for content in [
            store_env("offlin-only", "https://storepc:47304", "k", CA),
            store_env("hybrid", "https://storepc:47304", "k", CA),
            store_env("", "https://storepc:47304", "k", CA),
        ] {
            let c = applied(&content);
            assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("cloud", "STORE_MODE_UNKNOWN"), "{content:?}");
            assert_eq!((c.supabase_url.as_str(), c.supabase_anon_key.as_str(), c.store_ca_sha256.as_str()), ("", "", ""));
            assert_eq!(c.warnings.len(), 1);
        }
    }

    #[test]
    fn malformed_store_env_without_a_mode_key_falls_back_to_cloud() {
        for content in [
            String::new(),
            "no store settings here\n".to_string(),
            "FOO=bar\n".to_string(),
        ] {
            let c = applied(&content);
            assert_eq!(c.store_mode, "cloud");
            assert_eq!(c.store_config_error, "", "{content:?}");
            assert_eq!((c.supabase_url.as_str(), c.supabase_anon_key.as_str(), c.store_ca_sha256.as_str()), ("", "", ""));
            assert_eq!(c.warnings.len(), 1);
        }
    }

    #[test]
    fn store_keys_without_a_valid_mode_block_even_when_truncated_or_misspelled() {
        let full = store_env("offline-only", "https://storepc:47304", "k", CA);
        let mut cases = vec![
            "VITE_STORE_MOD=offline-only\nVITE_SUPABASE_URL=https://storepc:47304\nVITE_SUPABASE_ANON_KEY=k\n".to_string(),
            format!("\u{feff}{full}"),
            "VITE_SUPABASE_URL=https://storepc:47304\n".to_string(),
            "VITE_SUPABASE_URL=https://storepc:47304\nVITE_SUPABASE_ANON_KEY=k\nVITE_STORE_CA_SHA256=abc\n".to_string(),
            "VITE_SUPABASE_ANON_KEY=k\n".to_string(),
            "VITE_SUPABASE_URL=https://storepc:47304\nVITE_STORE_MO".to_string(),
            "VITE_SUPABASE_UR".to_string(),
            "VITE_STORE_".to_string(),
        ];
        // `store_env` writes the mode line first: a copy cut anywhere inside it, or right after it, is never silently cloud
        let mode_line_end = full.find('\n').unwrap();
        for n in 5..mode_line_end {
            cases.push(full[..n].to_string());
        }
        for content in cases {
            let c = applied(&content);
            assert_eq!(c.store_config_error, "STORE_MODE_UNKNOWN", "{content:?}");
            assert_eq!((c.supabase_url.as_str(), c.supabase_anon_key.as_str(), c.store_ca_sha256.as_str()), ("", "", ""));
        }
    }

    #[test]
    fn offline_store_env_with_bad_field_still_blocks() {
        let c = applied(&store_env("offline-only", "https://storepc:47304", "k", "abc"));
        assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("cloud", "STORE_CA_MISSING"));
    }

    #[test]
    fn a_store_env_url_never_appears_in_a_warning() {
        let c = applied(&store_env("offline-only", "https://user:secretpw@evil.example.com:47304", "k", CA));
        assert!(!c.warnings.join(" ").contains("secretpw"));
    }

    #[test]
    fn cloud_mode_never_takes_a_backend_url_from_store_env() {
        for url in ["https://abcdefgh.supabase.co", "https://storepc:47304"] {
            let c = applied(&format!("VITE_STORE_MODE=cloud\nVITE_SUPABASE_URL={url}\nVITE_SUPABASE_ANON_KEY=k\n"));
            assert_eq!(c.store_mode, "cloud");
            assert_eq!(c.supabase_url, "", "{url}");
            assert_eq!(c.supabase_anon_key, "", "{url}");
        }
        // and it overrides nothing the .env already set
        let mut c = parse_env_config("VITE_SUPABASE_URL=https://abcdefgh.supabase.co\nVITE_SUPABASE_ANON_KEY=cloud-key\n");
        apply_store_file(&mut c, Ok(Some("VITE_STORE_MODE=cloud\nVITE_SUPABASE_URL=https://zzzzzzzz.supabase.co\n".to_string())));
        assert_eq!(c.supabase_url, "https://abcdefgh.supabase.co");
    }

    #[test]
    fn the_stored_url_is_the_normalised_one() {
        let c = applied(&store_env("offline-only", "https://0xC0A80114:47304/", "k", CA));
        assert_eq!(c.supabase_url, "https://192.168.1.20:47304");
    }

    #[test]
    fn owners_must_all_be_administrators_or_system() {
        let ok = |s: &str| Ok(s.to_string());
        assert!(owners_trusted(&[ok("S-1-5-32-544"), ok("S-1-5-18"), ok("S-1-5-18")]));
        assert!(!owners_trusted(&[ok("S-1-5-32-544"), ok("S-1-5-21-1-2-3-1001")]));
        assert!(!owners_trusted(&[ok("S-1-5-32-544"), Err("denied".to_string())]));
        assert!(!owners_trusted(&[]));
    }

    fn tree(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t10-{name}-{}", std::process::id())).join("SupermarketPOS").join("client");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("store.env");
        std::fs::write(&f, bytes).unwrap();
        f
    }

    fn no_reparse(_: &std::path::Path) -> bool {
        false
    }

    #[test]
    fn a_reparse_point_anywhere_in_the_chain_is_untrusted() {
        let f = tree("reparse", b"VITE_STORE_MODE=cloud\n");
        let admin = |_: &std::path::Path| Ok("S-1-5-18".to_string());
        for victim in [f.clone(), f.parent().unwrap().to_path_buf(), f.parent().unwrap().parent().unwrap().to_path_buf()] {
            let is_rp = |p: &std::path::Path| p == victim;
            assert_eq!(read_store_file(&f, &admin, &is_rp), Err("STORE_ENV_UNTRUSTED_PATH"));
        }
        let gone = f.with_file_name("nope.env");
        assert_eq!(read_store_file(&gone, &admin, &no_reparse), Ok(None));
    }

    #[cfg(windows)]
    #[test]
    fn a_real_junction_is_detected_and_a_plain_dir_is_not() {
        let f = tree("junction", b"VITE_STORE_MODE=cloud\n");
        let client = f.parent().unwrap().to_path_buf();
        assert!(!path_is_reparse_point(&client));
        let real = client.with_file_name("client-real");
        std::fs::rename(&client, &real).unwrap();
        let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&client).arg(&real).output().unwrap();
        assert!(out.status.success(), "mklink failed");
        assert!(path_is_reparse_point(&client));
        let admin = |_: &std::path::Path| Ok("S-1-5-18".to_string());
        assert_eq!(read_store_file(&f, &admin, &path_is_reparse_point), Err("STORE_ENV_UNTRUSTED_PATH"));
    }

    #[test]
    fn the_programdata_base_must_be_a_local_fixed_drive() {
        let fixed = |_: &std::path::Path| true;
        let removable = |_: &std::path::Path| false;
        let p = std::path::Path::new;
        assert_eq!(vet_base(p(r"C:\ProgramData"), &fixed), Ok(()));
        assert_eq!(vet_base(p(r"C:\ProgramData"), &removable), Err("STORE_ENV_UNTRUSTED_PATH"));
        assert_eq!(vet_base(p(r"\\10.0.0.66\x"), &fixed), Err("STORE_ENV_UNTRUSTED_PATH"));
        assert_eq!(vet_base(p(r"\\?\UNC\10.0.0.66\x"), &fixed), Err("STORE_ENV_UNTRUSTED_PATH"));
    }

    #[test]
    fn a_store_env_in_a_user_owned_folder_is_ignored_with_a_code() {
        let f = tree("owner", b"VITE_STORE_MODE=cloud\n");
        let admin = |_: &std::path::Path| Ok("S-1-5-32-544".to_string());
        assert_eq!(read_store_file(&f, &admin, &no_reparse), Ok(Some("VITE_STORE_MODE=cloud\n".to_string())));
        // the grandparent (SupermarketPOS) is user owned
        let user_dir = f.parent().unwrap().parent().unwrap().to_path_buf();
        let mixed = |p: &std::path::Path| Ok(if p == user_dir { "S-1-5-21-1-2-3-1001" } else { "S-1-5-18" }.to_string());
        assert_eq!(read_store_file(&f, &mixed, &no_reparse), Err("STORE_ENV_UNTRUSTED_OWNER"));
        let mut c = parse_env_config("");
        apply_store_file(&mut c, read_store_file(&f, &mixed, &no_reparse));
        assert_eq!(c.store_mode, "cloud");
        assert_eq!(c.store_config_error, "STORE_ENV_UNTRUSTED_OWNER");
    }

    #[test]
    fn a_missing_file_is_cloud_and_a_present_unreadable_one_is_an_error() {
        let admin = |_: &std::path::Path| Ok("S-1-5-18".to_string());
        let gone = std::env::temp_dir().join("t10-no-such-dir").join("store.env");
        assert_eq!(read_store_file(&gone, &admin, &no_reparse), Ok(None));
        let mut c = parse_env_config("");
        apply_store_file(&mut c, Ok(None));
        assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("cloud", ""));
        // UTF-16 text without a BOM is NUL-laced UTF-8 and stays unreadable
        let nobom: Vec<u8> = "VITE_STORE_MODE=offline-only\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let f = tree("utf16", &nobom);
        assert_eq!(read_store_file(&f, &admin, &no_reparse), Err("STORE_FILE_UNREADABLE"));
        let mut c = parse_env_config("");
        apply_store_file(&mut c, read_store_file(&f, &admin, &no_reparse));
        assert_eq!(c.store_config_error, "STORE_FILE_UNREADABLE");
        assert_eq!(c.warnings.len(), 1);
        // a UTF-8 BOM at the start of the file is tolerated
        let f = tree("bom", b"\xEF\xBB\xBFVITE_STORE_MODE=cloud\n");
        assert_eq!(read_store_file(&f, &admin, &no_reparse), Ok(Some("VITE_STORE_MODE=cloud\n".to_string())));
    }

    #[test]
    fn no_store_env_means_cloud() {
        assert_eq!(applied("").store_mode, "cloud");
        assert_eq!(applied("# only a comment\n").store_mode, "cloud");
    }

    fn utf16(text: &str, bom: &[u8], le: bool) -> Vec<u8> {
        let mut out = bom.to_vec();
        out.extend(text.encode_utf16().flat_map(|u| if le { u.to_le_bytes() } else { u.to_be_bytes() }));
        out
    }

    #[test]
    fn utf16_with_a_bom_is_decoded() {
        let admin = |_: &std::path::Path| Ok("S-1-5-18".to_string());
        let text = store_env("offline-only", "https://storepc:47304", "k", CA);
        for (name, bytes) in [("le", utf16(&text, &[0xFF, 0xFE], true)), ("be", utf16(&text, &[0xFE, 0xFF], false))] {
            let f = tree(&format!("utf16bom-{name}"), &bytes);
            let mut c = parse_env_config("");
            apply_store_file(&mut c, read_store_file(&f, &admin, &no_reparse));
            assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("offline-only", ""), "{name}");
        }
        // an odd byte count or a lone surrogate is still unreadable
        for bytes in [vec![0xFF, 0xFE, 0x41], vec![0xFF, 0xFE, 0x00, 0xD8]] {
            let f = tree("utf16bad", &bytes);
            assert_eq!(read_store_file(&f, &admin, &no_reparse), Err("STORE_FILE_UNREADABLE"));
        }
    }

    #[test]
    fn crlf_quotes_whitespace_and_a_cased_mode_are_tolerated() {
        let text = format!(
            "# written by hand\r\n  VITE_STORE_MODE = \"OFFLINE-Only\" \r\nVITE_SUPABASE_URL='https://storepc:47304'\r\nVITE_SUPABASE_ANON_KEY=\" k1 \"\r\nVITE_STORE_CA_SHA256={CA}\r\n"
        );
        let c = applied(&text);
        assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("offline-only", ""), "{:?}", c.warnings);
        assert_eq!(c.supabase_anon_key, "k1");
        assert_eq!(applied("VITE_STORE_MODE=Cloud\r\n").store_mode, "cloud");
    }

    #[test]
    fn a_duplicate_key_takes_the_last_value_and_warns_by_name_only() {
        let text = format!("VITE_STORE_MODE=offline-only\nVITE_SUPABASE_URL=https://old:47304\nVITE_SUPABASE_URL=https://storepc:47304\nVITE_SUPABASE_ANON_KEY=sekret-1\nVITE_SUPABASE_ANON_KEY=sekret-2\nVITE_STORE_CA_SHA256={CA}\n");
        let c = applied(&text);
        assert_eq!(c.supabase_url, "https://storepc:47304");
        assert_eq!(c.supabase_anon_key, "sekret-2");
        let w = c.warnings.join("|");
        assert!(w.contains("duplicate") && w.contains("VITE_SUPABASE_ANON_KEY"), "{w}");
        assert!(!w.contains("sekret") && !w.contains(CA), "{w}");
    }

    #[test]
    fn a_file_without_store_keys_is_cloud_with_a_warning() {
        for content in ["", "\r\n\r\n", "# only a comment\n", "FOO=bar\nVITE_OTHER=1\n"] {
            let c = applied(content);
            assert_eq!((c.store_mode.as_str(), c.store_config_error.as_str()), ("cloud", ""), "{content:?}");
            assert!(c.warnings.iter().any(|w| w.contains("no store settings")), "{content:?}");
        }
    }

    #[test]
    fn a_file_that_names_offline_only_stays_fail_closed() {
        // P11-3: a blank or misspelled mode value blocks; no mode key at all is cloud with no blocking code
        for content in ["VITE_STORE_MODE=\nVITE_STORE_CA_SHA256=abc\n", "VITE_STORE_MODE=offline_only\nVITE_SUPABASE_ANON_KEY=k\n"] {
            assert_eq!(applied(content).store_config_error, "STORE_MODE_UNKNOWN", "{content:?}");
        }
        for content in ["VITE_SUPABASE_URL=https://storepc:47304\n", "VITE_SUPABASE_ANON_KEY=k\n"] {
            assert_eq!(applied(content).store_config_error, "STORE_MODE_UNKNOWN", "{content:?}");
        }
        // declared offline-only but incomplete
        assert_eq!(applied("VITE_STORE_MODE=offline-only\n").store_config_error, "STORE_URL_REJECTED");
        assert_eq!(applied("VITE_STORE_MODE=OFFLINE-ONLY\nVITE_SUPABASE_URL=https://storepc:47304\n").store_config_error, "STORE_KEY_MISSING");
        assert_eq!(
            applied("VITE_STORE_MODE=offline-only\nVITE_SUPABASE_URL=https://storepc:47304\nVITE_SUPABASE_ANON_KEY=k\n").store_config_error,
            "STORE_CA_MISSING"
        );
    }

    #[test]
    fn the_dot_env_file_cannot_switch_the_mode() {
        let c = parse_env_config(&store_env("offline-only", "https://storepc:47304", "k", CA));
        assert_eq!(c.store_mode, "");
        assert_eq!(c.store_ca_sha256, "");
        // the URL line itself still goes through the cloud rule and is refused
        assert_eq!(c.supabase_url, "");
    }

    #[test]
    fn the_license_server_url_never_accepts_a_lan_address() {
        let c = parse_env_config("VITE_LICENSE_SERVER_URL=https://storepc:47304\nVITE_LICENSE_SERVER_ANON_KEY=k\n");
        assert_eq!(c.license_server_url, "");
    }

    #[test]
    fn the_file_posctl_writes_is_the_file_this_parser_reads() {
        let sample = include_str!("../../store-server/tests/fixtures/store.env.sample");
        let c = applied(sample);
        assert_eq!(c.store_mode, "offline-only", "{:?}", c.warnings);
        assert_eq!(c.supabase_url, "https://storepc:47304");
        assert_eq!(c.store_ca_sha256.len(), 64);
        assert_eq!(c.store_config_error, "");
    }


    const TAURI_CONF: &str = include_str!("../tauri.conf.json");

    fn csp_directive(csp: &str, name: &str) -> Vec<String> {
        csp.split(';')
            .map(str::trim)
            .find(|d| d.split_whitespace().next() == Some(name))
            .map(|d| d.split_whitespace().skip(1).map(String::from).collect())
            .unwrap_or_default()
    }

    #[test]
    fn both_csps_allow_exactly_the_store_lan_port_and_nothing_wider() {
        let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
        let port = include_str!("../../store-server/resources/csp-port.txt").trim();
        assert_eq!(port, "47304");
        let want = format!("https://*:{port}");
        for key in ["csp", "devCsp"] {
            let csp = conf["app"]["security"][key].as_str().unwrap();
            for directive in ["img-src", "connect-src"] {
                let sources = csp_directive(csp, directive);
                assert!(sources.contains(&want), "{key} {directive} must allow {want}: {sources:?}");
                // a bare scheme, a bare wildcard or a wildcard port would let the app talk to any host
                for wide in ["https:", "https://*", "*", "http:", "http://*", "https://*:*", "http://*:*"] {
                    assert!(!sources.iter().any(|s| s == wide), "{key} {directive} must not allow {wide}");
                }
            }
            assert!(!csp_directive(csp, "script-src").iter().any(|s| s.contains(&want)));
            assert!(!csp_directive(csp, "default-src").iter().any(|s| s.contains("https:") && s != "'self'"));
        }
    }

    #[test]
    fn the_csp_port_file_ships_with_the_installer() {
        let conf: serde_json::Value = serde_json::from_str(TAURI_CONF).unwrap();
        assert_eq!(conf["bundle"]["resources"]["../store-server/resources/csp-port.txt"], "posctl/csp-port.txt");
    }
}

#[tauri::command]
fn get_runtime_config(state: tauri::State<AppConfig>) -> AppConfig {
    state.inner().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = read_env_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.manage(config);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            print_receipt,
            print_raw_text,
            open_cash_drawer,
            test_print,
            get_print_jobs,
            get_print_job,
            list_printers,
            get_runtime_config,
            write_log,
            posctl_open_console
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
