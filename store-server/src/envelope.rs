//! The JSON envelope every `posctl` command prints on stdout (exactly one object) and the
//! stable exit-code table (conventions section 11.2). Tills, the app and scheduled tasks
//! branch on `code`, so the numbers here never change.
//! Must never: write a once-only secret into the file copy, or drop it from stdout.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const POSCTL_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    Ok,
    Error,
    Usage,
    NotElevated,
    NotProvisioned,
    AlreadyProvisioned,
    LockHeld,
    Precondition,
    PackInvalid,
    MigrationFailed,
    VerifyFailedRolledBack,
    RolledBack,
    RecoveryNeeded,
    Unhealthy,
    Degraded,
    CanaryFailed,
    BackupFailed,
    RestoreFailed,
    SwitchRefused,
    SwitchFailedRolledBack,
    PairFailed,
    PairFingerprintMismatch,
}

impl Code {
    pub const ALL: [Code; 22] = [
        Code::Ok,
        Code::Error,
        Code::Usage,
        Code::NotElevated,
        Code::NotProvisioned,
        Code::AlreadyProvisioned,
        Code::LockHeld,
        Code::Precondition,
        Code::PackInvalid,
        Code::MigrationFailed,
        Code::VerifyFailedRolledBack,
        Code::RolledBack,
        Code::RecoveryNeeded,
        Code::Unhealthy,
        Code::Degraded,
        Code::CanaryFailed,
        Code::BackupFailed,
        Code::RestoreFailed,
        Code::SwitchRefused,
        Code::SwitchFailedRolledBack,
        Code::PairFailed,
        Code::PairFingerprintMismatch,
    ];

    pub fn exit(self) -> i32 {
        match self {
            Code::Ok => 0,
            Code::Error => 1,
            Code::Usage => 2,
            Code::NotElevated => 3,
            Code::NotProvisioned => 4,
            Code::AlreadyProvisioned => 5,
            Code::LockHeld => 10,
            Code::Precondition => 12,
            Code::PackInvalid => 13,
            Code::MigrationFailed => 14,
            Code::VerifyFailedRolledBack => 15,
            Code::RolledBack => 16,
            Code::RecoveryNeeded => 17,
            Code::Unhealthy => 20,
            Code::Degraded => 21,
            Code::CanaryFailed => 22,
            Code::BackupFailed => 30,
            Code::RestoreFailed => 31,
            Code::SwitchRefused => 40,
            Code::SwitchFailedRolledBack => 41,
            Code::PairFailed => 50,
            Code::PairFingerprintMismatch => 51,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Code::Ok => "OK",
            Code::Error => "ERROR",
            Code::Usage => "USAGE",
            Code::NotElevated => "NOT_ELEVATED",
            Code::NotProvisioned => "NOT_PROVISIONED",
            Code::AlreadyProvisioned => "ALREADY_PROVISIONED",
            Code::LockHeld => "LOCK_HELD",
            Code::Precondition => "PRECONDITION",
            Code::PackInvalid => "PACK_INVALID",
            Code::MigrationFailed => "MIGRATION_FAILED",
            Code::VerifyFailedRolledBack => "VERIFY_FAILED_ROLLED_BACK",
            Code::RolledBack => "ROLLED_BACK",
            Code::RecoveryNeeded => "RECOVERY_NEEDED",
            Code::Unhealthy => "UNHEALTHY",
            Code::Degraded => "DEGRADED",
            Code::CanaryFailed => "CANARY_FAILED",
            Code::BackupFailed => "BACKUP_FAILED",
            Code::RestoreFailed => "RESTORE_FAILED",
            Code::SwitchRefused => "SWITCH_REFUSED",
            Code::SwitchFailedRolledBack => "SWITCH_FAILED_ROLLED_BACK",
            Code::PairFailed => "PAIR_FAILED",
            Code::PairFingerprintMismatch => "PAIR_FINGERPRINT_MISMATCH",
        }
    }
}

/// A command's failure: becomes an envelope with `ok = false`.
#[derive(Debug, Clone)]
pub struct PosctlError {
    pub code: Code,
    pub message: String,
    pub retryable: bool,
    pub data: Value,
}

impl PosctlError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: false, data: Value::Null }
    }
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
    pub fn error(message: impl Into<String>) -> Self {
        Self::new(Code::Error, message)
    }
    pub fn precondition(message: impl Into<String>) -> Self {
        Self::new(Code::Precondition, message)
    }
}

impl std::fmt::Display for PosctlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.name(), self.message)
    }
}

impl std::error::Error for PosctlError {}

impl From<std::io::Error> for PosctlError {
    fn from(e: std::io::Error) -> Self {
        Self::error(format!("I/O error: {e}"))
    }
}
impl From<serde_json::Error> for PosctlError {
    fn from(e: serde_json::Error) -> Self {
        Self::error(format!("JSON error: {e}"))
    }
}
// review fix (compile order): the `impl From<crate::ops::outcome::OpError> for PosctlError` that used to
// stand here is APPENDED to this file in Task 8 Step 5, together with the `ops` module it names. With it
// here, every `cargo test` from Task 1 through Task 7 failed to compile (`ops` does not exist yet).
impl From<String> for PosctlError {
    fn from(e: String) -> Self {
        Self::error(e)
    }
}

/// A value that is shown once on stdout and must never reach a file (the first admin's PIN).
#[derive(Clone)]
pub struct SecretOnce {
    pub section: &'static str,
    pub field: &'static str,
    pub value: String,
}

impl std::fmt::Debug for SecretOnce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretOnce({}.{}=***)", self.section, self.field)
    }
}

/// What a command returns on success (or on a non-OK health-style result).
#[derive(Debug, Clone)]
pub struct Outcome {
    pub code: Code,
    pub message: String,
    pub retryable: bool,
    pub data: Value,
    pub journal: Option<String>,
    pub secret_once: Option<SecretOnce>,
}

impl Outcome {
    pub fn ok(message: impl Into<String>, data: Value) -> Self {
        Self { code: Code::Ok, message: message.into(), retryable: false, data, journal: None, secret_once: None }
    }
    pub fn with_code(code: Code, message: impl Into<String>, data: Value) -> Self {
        Self { code, message: message.into(), retryable: false, data, journal: None, secret_once: None }
    }
    pub fn journal(mut self, path: impl Into<String>) -> Self {
        self.journal = Some(path.into());
        self
    }
    pub fn secret_once(mut self, s: SecretOnce) -> Self {
        self.secret_once = Some(s);
        self
    }
}

impl From<PosctlError> for Outcome {
    fn from(e: PosctlError) -> Self {
        Outcome {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            data: if e.data.is_null() { json!({}) } else { e.data },
            journal: None,
            secret_once: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub ok: bool,
    pub command: String,
    pub code: String,
    pub exit: i32,
    pub message: String,
    pub retryable: bool,
    pub data: Value,
    pub journal: Option<String>,
    pub started_at: String,
    pub finished_at: String,
    pub posctl_version: String,
}

impl Envelope {
    pub fn from_outcome(command: &str, started_at: &str, finished_at: &str, o: &Outcome) -> Self {
        Envelope {
            ok: o.code == Code::Ok,
            command: command.to_string(),
            code: o.code.name().to_string(),
            exit: o.code.exit(),
            message: o.message.clone(),
            retryable: o.retryable,
            data: if o.data.is_null() { json!({}) } else { o.data.clone() },
            journal: o.journal.clone(),
            started_at: started_at.to_string(),
            finished_at: finished_at.to_string(),
            posctl_version: POSCTL_VERSION.to_string(),
        }
    }

    /// The copy written to `--result-file` and to the log: never carries the once-only secret.
    pub fn to_file_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// The single line printed on stdout: the same object, plus the once-only secret.
    pub fn to_stdout_json(&self, secret: Option<&SecretOnce>) -> String {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(s) = secret {
            // The secret is shown exactly once: a non-object `data` or section is replaced, never skipped.
            if !v["data"].is_object() {
                v["data"] = json!({});
            }
            let section = &mut v["data"][s.section];
            if !section.is_object() {
                *section = json!({});
            }
            section[s.field] = Value::String(s.value.clone());
        }
        serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string())
    }
}

// Task 8 Step 5: the shared operation API (ops) reports OpError; a command turns it into an envelope code by exit number.
impl From<crate::ops::outcome::OpError> for PosctlError {
    fn from(e: crate::ops::outcome::OpError) -> Self {
        let code = Code::ALL.into_iter().find(|c| c.exit() == e.code.exit()).unwrap_or(Code::Error);
        PosctlError { code, message: e.message, retryable: e.retryable, data: serde_json::json!({"reason": e.reason}) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_code_table_is_pinned() {
        let want: [(Code, i32, &str); 22] = [
            (Code::Ok, 0, "OK"),
            (Code::Error, 1, "ERROR"),
            (Code::Usage, 2, "USAGE"),
            (Code::NotElevated, 3, "NOT_ELEVATED"),
            (Code::NotProvisioned, 4, "NOT_PROVISIONED"),
            (Code::AlreadyProvisioned, 5, "ALREADY_PROVISIONED"),
            (Code::LockHeld, 10, "LOCK_HELD"),
            (Code::Precondition, 12, "PRECONDITION"),
            (Code::PackInvalid, 13, "PACK_INVALID"),
            (Code::MigrationFailed, 14, "MIGRATION_FAILED"),
            (Code::VerifyFailedRolledBack, 15, "VERIFY_FAILED_ROLLED_BACK"),
            (Code::RolledBack, 16, "ROLLED_BACK"),
            (Code::RecoveryNeeded, 17, "RECOVERY_NEEDED"),
            (Code::Unhealthy, 20, "UNHEALTHY"),
            (Code::Degraded, 21, "DEGRADED"),
            (Code::CanaryFailed, 22, "CANARY_FAILED"),
            (Code::BackupFailed, 30, "BACKUP_FAILED"),
            (Code::RestoreFailed, 31, "RESTORE_FAILED"),
            (Code::SwitchRefused, 40, "SWITCH_REFUSED"),
            (Code::SwitchFailedRolledBack, 41, "SWITCH_FAILED_ROLLED_BACK"),
            (Code::PairFailed, 50, "PAIR_FAILED"),
            (Code::PairFingerprintMismatch, 51, "PAIR_FINGERPRINT_MISMATCH"),
        ];
        for (code, exit, name) in want {
            assert_eq!(code.exit(), exit, "{name}");
            assert_eq!(code.name(), name);
        }
        assert_eq!(Code::ALL.len(), want.len());
    }

    #[test]
    fn only_ok_exits_zero_and_exits_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for c in Code::ALL {
            assert!(seen.insert(c.exit()), "duplicate exit {}", c.exit());
            assert_eq!(c.exit() == 0, c == Code::Ok);
        }
    }

    #[test]
    fn envelope_has_the_documented_fields() {
        let o = Outcome::ok("done", json!({"a": 1}));
        let e = Envelope::from_outcome("version", "2026-10-02T12:00:00Z", "2026-10-02T12:00:01Z", &o);
        let v: Value = serde_json::from_str(&e.to_stdout_json(None)).unwrap();
        for k in [
            "ok", "command", "code", "exit", "message", "retryable", "data", "journal",
            "startedAt", "finishedAt", "posctlVersion",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["ok"], true);
        assert_eq!(v["exit"], 0);
    }

    #[test]
    fn once_only_secret_is_on_stdout_and_never_in_the_file_copy() {
        let o = Outcome::ok("done", json!({"firstAdmin": {"id": "x"}}));
        let e = Envelope::from_outcome("provision", "t0", "t1", &o);
        let secret = SecretOnce { section: "firstAdmin", field: "pin", value: "shown-once-value".into() };
        assert!(e.to_stdout_json(Some(&secret)).contains("\"pin\":\"shown-once-value\""));
        assert!(!e.to_file_json().contains("shown-once-value"));
        assert!(!format!("{secret:?}").contains("shown-once-value"));
    }

    #[test]
    fn error_converts_to_a_non_ok_outcome() {
        let e = PosctlError::precondition("port 47300 is in use").retryable();
        let o: Outcome = e.into();
        assert_eq!(o.code, Code::Precondition);
        assert!(o.retryable);
        let env = Envelope::from_outcome("provision", "a", "b", &o);
        assert!(!env.ok);
        assert_eq!(env.exit, 12);
    }
    #[test]
    fn once_only_secret_survives_non_object_data() {
        let secret = SecretOnce { section: "firstAdmin", field: "pin", value: "shown-once-value".into() };
        for data in [json!(null), json!([1, 2]), json!({"firstAdmin": "text"})] {
            let o = Outcome::ok("done", data);
            let e = Envelope::from_outcome("provision", "t0", "t1", &o);
            let v: Value = serde_json::from_str(&e.to_stdout_json(Some(&secret))).unwrap();
            assert_eq!(v["data"]["firstAdmin"]["pin"], "shown-once-value");
            assert!(!e.to_file_json().contains("shown-once-value"));
        }
    }

}
