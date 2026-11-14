//! Per-failure-class retry/backoff policy (D-10), replacing the spike's
//! hardcoded `MAX_ATTEMPTS`/`RECONCILE_AFTER_SECS` constants that used to
//! live in `delivery.rs`. `classify_failure` and `decide` are both pure
//! functions (no DB/IO) so the retry math is unit-testable without real
//! printer hardware — `delivery.rs::worker_tick` is the only caller that
//! turns a `RetryDecision` into SQL.

use serde::{Deserialize, Serialize};

/// Whether a delivery failure is worth retrying. Unrecognized error text is
/// classified `Transient` (fail open toward retrying) rather than
/// `Terminal` — an unrecognized error is more likely a transient spooler
/// hiccup than a permanently misconfigured printer name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    Transient,
    Terminal,
}

/// Classifies a WinSpool/broker error message. Matches this codebase's own
/// error strings (see `delivery.rs`'s `win_print` module):
/// - "invalid" (case-insensitive) — e.g. "The specified printer name is
///   invalid." -> Terminal (retrying can never fix a bad printer name).
/// - "not found" (case-insensitive) -> Terminal.
/// - everything else (spooler stopped, RPC unavailable, incomplete write,
///   any other WinSpool error) -> Transient.
pub fn classify_failure(err_message: &str) -> FailureClass {
    let lower = err_message.to_lowercase();
    if lower.contains("invalid") || lower.contains("not found") {
        FailureClass::Terminal
    } else {
        FailureClass::Transient
    }
}

/// Config-driven per-failure-class retry/backoff policy, loaded from
/// `broker-config.json`. Defaults mirror the spike's original hardcoded
/// values (`MAX_ATTEMPTS=5`, `RECONCILE_AFTER_SECS=3`) — not editing
/// broker-config.json is not a behavior change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts_transient: u32,
    pub backoff_ms: u64,
    pub reconcile_after_secs: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_attempts_transient: 5,
            backoff_ms: 500,
            reconcile_after_secs: 3,
        }
    }
}

/// Outcome of applying `RetryPolicy` to a classified delivery failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryDecision {
    /// Mark the job 'failed' with this final attempts count and event category.
    MarkFailed { attempts: i64, event_category: &'static str },
    /// Record this attempts count and leave the job in 'accepted' for the
    /// next worker tick to retry.
    WillRetry { attempts: i64 },
}

/// Applies a classified failure against the current attempt count and the
/// configured transient-retry ceiling. Terminal failures always mark
/// 'failed' after exactly 1 attempt, regardless of `current_attempts` or
/// policy — a terminal error (e.g. a nonexistent printer name) can never be
/// fixed by retrying (PRN-06).
pub fn decide(class: FailureClass, current_attempts: i64, policy: &RetryPolicy) -> RetryDecision {
    match class {
        FailureClass::Terminal => RetryDecision::MarkFailed {
            attempts: 1,
            event_category: "terminal_failure_no_retry",
        },
        FailureClass::Transient => {
            let new_attempts = current_attempts + 1;
            if new_attempts >= policy.max_attempts_transient as i64 {
                RetryDecision::MarkFailed { attempts: new_attempts, event_category: "retry_exhausted" }
            } else {
                RetryDecision::WillRetry { attempts: new_attempts }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: classify_failure matches this codebase's own error strings.
    #[test]
    fn classify_failure_transient_vs_terminal() {
        assert_eq!(
            classify_failure(
                "StartDocPrinter failed (job id 0) — spooler likely stopped or printer unreachable"
            ),
            FailureClass::Transient
        );
        assert_eq!(
            classify_failure("OpenPrinter('X') failed: The specified printer name is invalid."),
            FailureClass::Terminal
        );
    }

    #[test]
    fn classify_failure_not_found_is_terminal() {
        assert_eq!(classify_failure("printer not found"), FailureClass::Terminal);
        assert_eq!(classify_failure("Printer Not Found"), FailureClass::Terminal);
    }

    #[test]
    fn classify_failure_unrecognized_error_defaults_transient() {
        assert_eq!(classify_failure("RPC server is unavailable"), FailureClass::Transient);
        assert_eq!(
            classify_failure("WritePrinter failed or incomplete write"),
            FailureClass::Transient
        );
    }

    // Test 2: a Terminal-classified failure is marked 'failed' after
    // exactly 1 attempt, never accumulating prior attempts.
    #[test]
    fn terminal_failure_marks_failed_after_exactly_one_attempt() {
        let policy = RetryPolicy::default();
        assert_eq!(
            decide(FailureClass::Terminal, 0, &policy),
            RetryDecision::MarkFailed { attempts: 1, event_category: "terminal_failure_no_retry" }
        );
        assert_eq!(
            decide(FailureClass::Terminal, 3, &policy),
            RetryDecision::MarkFailed { attempts: 1, event_category: "terminal_failure_no_retry" }
        );
    }

    // Test 3: a Transient-classified failure retries up to
    // policy.max_attempts_transient before being marked 'failed'.
    #[test]
    fn transient_failure_retries_up_to_configured_max_attempts() {
        let policy = RetryPolicy { max_attempts_transient: 3, backoff_ms: 500, reconcile_after_secs: 3 };
        assert_eq!(decide(FailureClass::Transient, 0, &policy), RetryDecision::WillRetry { attempts: 1 });
        assert_eq!(decide(FailureClass::Transient, 1, &policy), RetryDecision::WillRetry { attempts: 2 });
        assert_eq!(
            decide(FailureClass::Transient, 2, &policy),
            RetryDecision::MarkFailed { attempts: 3, event_category: "retry_exhausted" }
        );
    }

    #[test]
    fn retry_policy_default_matches_spike_hardcoded_values() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.max_attempts_transient, 5);
        assert_eq!(policy.backoff_ms, 500);
        assert_eq!(policy.reconcile_after_secs, 3);
    }

    // Test 4: RetryPolicy deserializes a custom max_attempts_transient value
    // from a broker-config.json-shaped fixture (worker_tick reads this same
    // struct via config::load_or_init() and passes it straight into
    // `decide`, per Test 3 above — a custom value is honored identically).
    #[test]
    fn retry_policy_deserializes_custom_max_attempts_transient_from_config_fixture() {
        let json = r#"{"max_attempts_transient": 3, "backoff_ms": 250, "reconcile_after_secs": 5}"#;
        let policy: RetryPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.max_attempts_transient, 3);
        assert_eq!(policy.backoff_ms, 250);
        assert_eq!(policy.reconcile_after_secs, 5);
    }
}
