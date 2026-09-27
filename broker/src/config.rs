//! Broker install-time configuration: per-store secret generation (D-04) and
//! `BrokerConfig` persisted to `%ProgramData%\PrintBroker\broker-config.json`.
//! `load_or_init()` is idempotent — it only generates a new secret when no
//! config file exists yet; regenerating on every install-hook run would
//! silently invalidate every already-configured LAN client's credentials
//! (see this plan's `prohibitions`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ledger::data_dir;
use crate::retry::RetryPolicy;

/// Payload-BLOB retention window in days (D-14), confirmed by this plan's
/// `checkpoint:decision` — the human explicitly chose 7 days (not the
/// RESEARCH.md provisional default of 14). Metadata rows (job_id, status,
/// timestamps, attempts, last_error) are never purged regardless of this
/// value — see `ledger::purge_expired_payloads`.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerConfig {
    pub port: u16,
    pub bearer_secret: String,
    pub retention_days: u32,
    pub retry: RetryPolicy,
}

fn config_path() -> PathBuf {
    data_dir().join("broker-config.json")
}

fn secret_path() -> PathBuf {
    data_dir().join("client-secret.txt")
}

/// Two concatenated UUIDv4 `.simple()` strings — 64 hex chars, ~256 bits of
/// entropy sourced from the already-audited `uuid` crate's OS-CSPRNG-backed
/// v4 generation. Do NOT add a `rand`/`getrandom` dependency for this; ASVS
/// V6 is satisfied by reusing uuid's existing CSPRNG path (19-RESEARCH.md).
fn generate_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Loads `broker-config.json` if present; otherwise builds a default config
/// (generating a fresh per-store secret) and writes both `broker-config.json`
/// and `client-secret.txt` (the artifact `resolve_secret()` reads). Returns
/// `Err` when the config file exists but cannot be read or parsed — a
/// corrupt config used to be silently overwritten with a brand-new secret,
/// which invalidates every already-configured LAN client's credential
/// without telling anyone; now the operator sees an error instead.
pub fn load_or_init() -> Result<BrokerConfig, String> {
    load_or_init_at(&config_path(), &secret_path())
}

/// Testable core: takes explicit paths so tests can point at a tempdir
/// without touching the real `%ProgramData%\PrintBroker\` directory.
pub fn load_or_init_at(config_file: &Path, secret_file: &Path) -> Result<BrokerConfig, String> {
    match std::fs::read_to_string(config_file) {
        Ok(content) => serde_json::from_str::<BrokerConfig>(&content).map_err(|e| {
            format!(
                "broker config unreadable: {}: {e}",
                config_file.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let cfg = BrokerConfig {
                port: crate::http::PORT,
                bearer_secret: generate_secret(),
                retention_days: DEFAULT_RETENTION_DAYS,
                retry: RetryPolicy::default(),
            };

            if let Ok(json) = serde_json::to_string_pretty(&cfg) {
                let _ = std::fs::write(config_file, json);
            }
            let _ = std::fs::write(secret_file, format!("{}\n", cfg.bearer_secret));

            Ok(cfg)
        }
        Err(e) => Err(format!(
            "broker config unreadable: {}: {e}",
            config_file.display()
        )),
    }
}

/// Resolves the broker's bearer secret from the default `%ProgramData%`
/// paths. Thin wrapper over `resolve_secret_at`.
pub fn resolve_secret() -> Result<String, String> {
    resolve_secret_at(&config_path(), &secret_path())
}

/// The secret-resolution priority `http.rs::resolve_broker_secret` used to
/// apply, minus the insecure literal fallback: the config's `bearer_secret`
/// if non-blank, else the first non-blank line of the secret file, else an
/// `Err` naming the missing path. A blank `bearer_secret` with no usable
/// secret file is now a hard failure instead of a silently-accepted default.
pub fn resolve_secret_at(config_file: &Path, secret_file: &Path) -> Result<String, String> {
    if let Ok(content) = std::fs::read_to_string(config_file) {
        if let Ok(cfg) = serde_json::from_str::<BrokerConfig>(&content) {
            if !cfg.bearer_secret.trim().is_empty() {
                return Ok(cfg.bearer_secret);
            }
        }
    }
    if let Ok(content) = std::fs::read_to_string(secret_file) {
        if let Some(non_blank) = content.lines().map(str::trim).find(|l| !l.is_empty()) {
            return Ok(non_blank.to_string());
        }
    }
    Err(format!("broker secret missing: {}", secret_file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "print-broker-test-config-{name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("broker-config.json"), dir.join("client-secret.txt"))
    }

    // Test 1: calling load_or_init_at twice against the same fresh temp
    // directory only creates client-secret.txt on the first call; the second
    // call reads back the existing value unchanged (idempotent-across-upgrade
    // proof).
    #[test]
    fn secret_generated_once_and_stable_across_repeat_calls() {
        let (config_file, secret_file) = temp_paths("idempotent");
        let _ = std::fs::remove_file(&config_file);
        let _ = std::fs::remove_file(&secret_file);

        assert!(!secret_file.exists());
        let first = load_or_init_at(&config_file, &secret_file).unwrap();
        assert!(secret_file.exists(), "client-secret.txt must be created on first call");
        let first_secret_on_disk = std::fs::read_to_string(&secret_file).unwrap();

        let second = load_or_init_at(&config_file, &secret_file).unwrap();
        let second_secret_on_disk = std::fs::read_to_string(&secret_file).unwrap();

        assert_eq!(first.bearer_secret, second.bearer_secret, "secret must not change across repeat calls");
        assert_eq!(first_secret_on_disk, second_secret_on_disk);

        let _ = std::fs::remove_file(&config_file);
        let _ = std::fs::remove_file(&secret_file);
    }

    // Test 2: the generated secret is 64 hex characters (two concatenated
    // UUIDv4 .simple() strings), matching ^[0-9a-f]{64}$, with no two
    // consecutive generations equal.
    #[test]
    fn generated_secret_is_64_lowercase_hex_chars_and_unique_per_generation() {
        fn is_64_lowercase_hex(s: &str) -> bool {
            s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }

        let a = generate_secret();
        let b = generate_secret();
        assert!(is_64_lowercase_hex(&a), "not 64 lowercase hex chars: {a}");
        assert!(is_64_lowercase_hex(&b), "not 64 lowercase hex chars: {b}");
        assert_ne!(a, b, "two consecutive generations must not be equal");
    }

    // Test 3: resolve_secret_at prefers a non-blank config secret; falls
    // back to the secret file's first line when the config's is blank; and
    // errors (message contains "secret missing") when both are blank.
    #[test]
    fn resolve_secret_at_prefers_config_then_file_then_errors() {
        let (config_file, secret_file) = temp_paths("resolve-priority");
        let _ = std::fs::remove_file(&config_file);
        let _ = std::fs::remove_file(&secret_file);

        let cfg_with_secret = BrokerConfig {
            port: 8973,
            bearer_secret: "config-secret-value".to_string(),
            retention_days: 7,
            retry: RetryPolicy::default(),
        };
        std::fs::write(&config_file, serde_json::to_string(&cfg_with_secret).unwrap()).unwrap();
        std::fs::write(&secret_file, "file-secret-value\n").unwrap();
        assert_eq!(
            resolve_secret_at(&config_file, &secret_file).unwrap(),
            "config-secret-value"
        );

        let cfg_blank = BrokerConfig {
            port: 8973,
            bearer_secret: "   ".to_string(),
            retention_days: 7,
            retry: RetryPolicy::default(),
        };
        std::fs::write(&config_file, serde_json::to_string(&cfg_blank).unwrap()).unwrap();
        assert_eq!(
            resolve_secret_at(&config_file, &secret_file).unwrap(),
            "file-secret-value"
        );

        std::fs::write(&secret_file, "\n").unwrap();
        let err = resolve_secret_at(&config_file, &secret_file).unwrap_err();
        assert!(err.contains("secret missing"), "unexpected error message: {err}");

        let _ = std::fs::remove_file(&config_file);
        let _ = std::fs::remove_file(&secret_file);
    }

    // The secret file's first non-blank line is used, not strictly its
    // first line — a leading blank line (a stray newline before the real
    // value) must not turn a present secret into a missing one.
    #[test]
    fn resolve_secret_at_skips_a_leading_blank_line_in_the_secret_file() {
        let (config_file, secret_file) = temp_paths("leading-blank-line");
        let _ = std::fs::remove_file(&config_file);
        std::fs::write(&secret_file, "\nsecret\n").unwrap();

        assert_eq!(resolve_secret_at(&config_file, &secret_file).unwrap(), "secret");

        let _ = std::fs::remove_file(&secret_file);
    }

    // Test 4: an unparseable config file (present but invalid JSON) is an
    // error, and the file is left byte-identical — no silent regeneration
    // that would invalidate an already-configured LAN client's secret.
    #[test]
    fn load_or_init_at_errors_on_unparseable_config_and_keeps_files() {
        let (config_file, secret_file) = temp_paths("unparseable");
        let _ = std::fs::remove_file(&config_file);
        let _ = std::fs::remove_file(&secret_file);

        std::fs::write(&config_file, "{").unwrap();
        let before = std::fs::read_to_string(&config_file).unwrap();

        let result = load_or_init_at(&config_file, &secret_file);
        assert!(result.is_err(), "unparseable config must be an error, not a silent regeneration");

        let after = std::fs::read_to_string(&config_file).unwrap();
        assert_eq!(before, after, "an unparseable config file must not be rewritten");
        assert!(!secret_file.exists(), "no secret file should be written on an unparseable config error");

        let _ = std::fs::remove_file(&config_file);
    }
}
