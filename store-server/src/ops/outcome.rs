//! Result codes shared by update, switch and restore (conventions 11.2).
//! It must never renumber a result code: the exit codes are a contract with the app and the installer.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind { Update, Switch, Restore }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum OpCode {
    Ok, Error, Usage, LockHeld, Precondition, PackInvalid, MigrationFailed,
    VerifyFailedRolledBack, RolledBack, RecoveryNeeded,
}

impl OpCode {
    pub fn exit(self) -> i32 {
        match self {
            OpCode::Ok => 0, OpCode::Error => 1, OpCode::Usage => 2, OpCode::LockHeld => 10,
            OpCode::Precondition => 12, OpCode::PackInvalid => 13, OpCode::MigrationFailed => 14,
            OpCode::VerifyFailedRolledBack => 15, OpCode::RolledBack => 16, OpCode::RecoveryNeeded => 17,
        }
    }
    /// The exit code for a stored `name()` (the result file keeps names); `None` for a name this build does not know.
    pub fn exit_for_name(name: &str) -> Option<i32> {
        use OpCode::*;
        [Ok, Error, Usage, LockHeld, Precondition, PackInvalid, MigrationFailed, VerifyFailedRolledBack, RolledBack, RecoveryNeeded]
            .into_iter().find(|c| c.name() == name).map(OpCode::exit)
    }
    pub fn name(self) -> &'static str {
        match self {
            OpCode::Ok => "OK", OpCode::Error => "ERROR", OpCode::Usage => "USAGE",
            OpCode::LockHeld => "LOCK_HELD", OpCode::Precondition => "PRECONDITION",
            OpCode::PackInvalid => "PACK_INVALID", OpCode::MigrationFailed => "MIGRATION_FAILED",
            OpCode::VerifyFailedRolledBack => "VERIFY_FAILED_ROLLED_BACK",
            OpCode::RolledBack => "ROLLED_BACK", OpCode::RecoveryNeeded => "RECOVERY_NEEDED",
        }
    }
}

/// `reason` is a stable machine key (`PRE_UPDATE_BACKUP_FAILED`); `message` is for humans and logs and
/// must never contain a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError { pub code: OpCode, pub reason: String, pub message: String, pub retryable: bool, /// The journal step a rollback began from (set when the runner rolled this error back).
    pub from: Option<crate::ops::journal::Step> }

impl OpError {
    pub fn new(code: OpCode, reason: &str, message: impl Into<String>) -> Self {
        OpError { code, reason: reason.to_string(), message: message.into(), retryable: matches!(code, OpCode::LockHeld), from: None }
    }
    pub fn err(reason: &str, message: impl Into<String>) -> Self { Self::new(OpCode::Error, reason, message) }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.reason, self.message) }
}
impl std::error::Error for OpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_match_conventions_11_2() {
        let table = [
            (OpCode::Ok, 0, "OK"), (OpCode::Error, 1, "ERROR"), (OpCode::Usage, 2, "USAGE"),
            (OpCode::LockHeld, 10, "LOCK_HELD"), (OpCode::Precondition, 12, "PRECONDITION"),
            (OpCode::PackInvalid, 13, "PACK_INVALID"), (OpCode::MigrationFailed, 14, "MIGRATION_FAILED"),
            (OpCode::VerifyFailedRolledBack, 15, "VERIFY_FAILED_ROLLED_BACK"),
            (OpCode::RolledBack, 16, "ROLLED_BACK"), (OpCode::RecoveryNeeded, 17, "RECOVERY_NEEDED"),
        ];
        for (c, e, n) in table { assert_eq!((c.exit(), c.name()), (e, n)); }
    }

    #[test]
    fn error_and_rolled_back_never_share_an_exit_code() {
        assert_ne!(OpCode::Error.exit(), OpCode::RolledBack.exit());
        assert_ne!(OpCode::Error.exit(), OpCode::Ok.exit());
    }

    // Task 8 Step 5: every OpCode maps onto the PosctlError code with the same exit number.
    #[test]
    fn an_op_error_becomes_a_posctl_error_with_the_same_exit_code() {
        for c in [OpCode::Ok, OpCode::Error, OpCode::Usage, OpCode::LockHeld, OpCode::Precondition, OpCode::PackInvalid, OpCode::MigrationFailed, OpCode::VerifyFailedRolledBack, OpCode::RolledBack, OpCode::RecoveryNeeded] {
            let p: crate::envelope::PosctlError = OpError::new(c, "R", "m").into();
            assert_eq!(p.code.exit(), c.exit(), "{c:?}");
            assert_eq!(p.data["reason"], "R");
        }
        let p: crate::envelope::PosctlError = OpError::new(OpCode::LockHeld, "LOCK_HELD", "m").into();
        assert!(p.retryable);
    }
}
