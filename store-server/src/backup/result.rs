//! One error type that carries the posctl `Code` (conventions 11.2; Plan 05 amendment: reuse `envelope::Code`).
use crate::envelope::{Code, PosctlError};

#[derive(Debug, Clone)]
pub struct BackupError {
    pub code: Code,
    pub message: String,
    pub retryable: bool,
}

pub type BResult<T> = Result<T, BackupError>;

impl BackupError {
    fn new(code: Code, retryable: bool, m: impl Into<String>) -> Self {
        Self { code, message: m.into(), retryable }
    }
    /// The process exit number of this error (the one table lives in `envelope::Code`).
    pub fn exit(&self) -> i32 { self.code.exit() }
    pub fn error(m: impl Into<String>) -> Self { Self::new(Code::Error, false, m) }
    pub fn usage(m: impl Into<String>) -> Self { Self::new(Code::Usage, false, m) }
    pub fn not_elevated() -> Self { Self::new(Code::NotElevated, false, "this action needs an Administrator session") }
    pub fn not_provisioned() -> Self { Self::new(Code::NotProvisioned, false, "this PC is not provisioned as a store server") }
    pub fn lock_held() -> Self { Self::new(Code::LockHeld, true, "another operation holds update.lock") }
    pub fn precondition(m: impl Into<String>) -> Self { Self::new(Code::Precondition, false, m) }
    pub fn recovery_needed(m: impl Into<String>) -> Self { Self::new(Code::RecoveryNeeded, false, m) }
    pub fn backup_failed(m: impl Into<String>) -> Self { Self::new(Code::BackupFailed, true, m) }
    pub fn restore_failed(m: impl Into<String>) -> Self { Self::new(Code::RestoreFailed, false, m) }
    /// An error from running an external tool: a program that is not there (`RealExec` maps a failed spawn to
    /// `NotFound`) is a precondition, anything else a plain error.
    pub fn tool(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            Self::precondition(format!("cannot start a required tool: {e}"))
        } else {
            Self::error(format!("I/O error: {e}"))
        }
    }
}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        Self::error(format!("I/O error: {e}"))
    }
}

impl From<BackupError> for PosctlError {
    fn from(e: BackupError) -> Self {
        let mut p = PosctlError::new(e.code, e.message);
        p.retryable = e.retryable;
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_envelope_codes_and_failures_never_exit_zero() {
        assert_eq!(BackupError::backup_failed("x").code, Code::BackupFailed);
        assert_eq!(BackupError::restore_failed("x").code, Code::RestoreFailed);
        assert_eq!(BackupError::lock_held().code, Code::LockHeld);
        assert_eq!(BackupError::precondition("x").code, Code::Precondition);
        assert_eq!(BackupError::usage("x").code, Code::Usage);
        assert_eq!(BackupError::recovery_needed("x").code, Code::RecoveryNeeded);
        assert_eq!(BackupError::not_provisioned().code, Code::NotProvisioned);
        assert_eq!(BackupError::backup_failed("x").exit(), 30);
        assert!([BackupError::error("x"), BackupError::not_provisioned()].iter().all(|e| e.exit() != 0));
    }

    #[test]
    fn not_elevated_is_exit_3_and_names_the_remedy() {
        let e = BackupError::not_elevated();
        assert_eq!((e.code, e.exit(), e.retryable), (Code::NotElevated, 3, false));
        assert!(e.message.contains("Administrator"), "{}", e.message);
    }

    #[test]
    fn converts_to_a_posctl_error_with_code_message_and_retry_flag() {
        let p: PosctlError = BackupError::backup_failed("restic died").into();
        assert_eq!(p.code, Code::BackupFailed);
        assert_eq!(p.message, "restic died");
        assert!(p.retryable);
    }

    #[test]
    fn a_missing_tool_is_a_precondition_other_io_is_an_error() {
        let nf = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        assert_eq!(BackupError::tool(nf).code, Code::Precondition);
        let other = std::io::Error::other("boom");
        assert_eq!(BackupError::tool(other).code, Code::Error);
    }
}
