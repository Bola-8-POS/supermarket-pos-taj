//! Shared broker bearer-secret resolver for `printer.rs` and
//! `print_audit.rs` — one implementation instead of two independent copies
//! of the same logic, and no insecure literal fallback: a missing, unreadable
//! or blank secret file is now a hard error returned to the caller, never a
//! known default value silently sent to the broker.

use std::path::{Path, PathBuf};

/// Resolves the broker's bearer secret from the default
/// `%ProgramData%\PrintBroker\client-secret.txt` path.
pub(crate) fn resolve_broker_secret() -> Result<String, String> {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let path = PathBuf::from(base)
        .join("PrintBroker")
        .join("client-secret.txt");
    resolve_broker_secret_at(&path)
}

/// Testable core: takes an explicit path so tests can point at a tempdir
/// instead of the real `%ProgramData%\PrintBroker\` directory. The error
/// message's `broker unreachable` substring is what `mapPrintInvokeError`
/// (`src/shared/lib/pos-printer.ts`) matches, so a missing secret surfaces to
/// staff as the same "printer unreachable" message as an actual network
/// failure — not a distinct, more alarming error for what is, from the
/// counter's point of view, the same outcome (no print happened).
pub(crate) fn resolve_broker_secret_at(path: &Path) -> Result<String, String> {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Some(non_blank) = content.lines().map(str::trim).find(|l| !l.is_empty()) {
            return Ok(non_blank.to_string());
        }
    }
    Err("broker unreachable: secret file missing".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_broker_secret_at_missing_file_is_err() {
        let path = std::env::temp_dir().join(format!(
            "broker-secret-test-missing-{}.txt",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let result = resolve_broker_secret_at(&path);
        let err = result.expect_err("a missing secret file must be an error");
        assert!(err.contains("broker unreachable"), "unexpected error message: {err}");
    }

    #[test]
    fn resolve_broker_secret_at_reads_first_non_blank_line() {
        let path = std::env::temp_dir().join(format!(
            "broker-secret-test-present-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "the-secret-value\nsecond-line\n").unwrap();
        let result = resolve_broker_secret_at(&path).unwrap();
        assert_eq!(result, "the-secret-value");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolve_broker_secret_at_skips_a_leading_blank_line() {
        let path = std::env::temp_dir().join(format!(
            "broker-secret-test-leading-blank-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "\nsecret\n").unwrap();
        let result = resolve_broker_secret_at(&path).unwrap();
        assert_eq!(result, "secret");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolve_broker_secret_at_blank_first_line_is_err() {
        let path = std::env::temp_dir().join(format!(
            "broker-secret-test-blank-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "   \n").unwrap();
        let result = resolve_broker_secret_at(&path);
        assert!(result.is_err());
        let _ = std::fs::remove_file(&path);
    }
}
