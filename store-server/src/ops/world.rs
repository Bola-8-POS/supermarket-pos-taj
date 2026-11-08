//! The seam between the operation procedure and the machine. The runner and recovery only talk to `World`
//! and `OpWork`, so the whole procedure is testable against a world made of data (ops::fake).
//! It must never grow a method that is not idempotent: recovery calls every mutating method again.
use crate::ops::{journal::Journal, names::DbNames, outcome::{OpError, OpKind}};
use std::collections::BTreeSet;

pub type R<T> = Result<T, OpError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupReason { PreUpdate, PreSwitch, /// Taken before `restore --swap`; best effort (see `backup::plan08_backup`).
    PreRestore }
impl BackupReason {
    pub fn as_arg(self) -> &'static str {
        match self { BackupReason::PreUpdate => "pre-update", BackupReason::PreSwitch => "pre-switch", BackupReason::PreRestore => "pre-restore" }
    }
}

#[derive(Debug, Clone)]
pub struct OpCtx {
    pub op_id: String,
    pub names: DbNames,
    pub pack_from: Option<String>,
    pub pack_to: Option<String>,
    pub deadline_ms: u64, // u64::MAX during recovery
}

/// Everything the runner does to the machine. One real impl (`ops::real::RealWorld`), one fake (tests).
/// Every mutating method is idempotent: the runner and recovery call them again after a crash.
pub trait World {
    fn now_ms(&self) -> u64;
    /// Reason codes of things the world noticed and survived (e.g. `FENCE_SIDECAR_CORRUPT`); never free text.
    fn warnings(&self) -> Vec<String> { vec![] }
    fn journal_write(&mut self, j: &Journal) -> R<()>;
    fn journal_archive(&mut self, j: &Journal) -> R<()>;
    fn db_names(&mut self) -> R<BTreeSet<String>>;
    /// Recovery suspended, maintenance responder up on the LAN port, Functions/Rest/Auth stopped,
    /// service roles NOLOGIN with sessions terminated. Proven or `Err`.
    fn fence(&mut self) -> R<()>;
    /// Pre-operation backup. `timeout_ms` is the share of the maintenance budget the backup may use.
    fn run_backup(&mut self, reason: BackupReason, timeout_ms: u64) -> R<()>;
    fn create_clone(&mut self, n: &DbNames) -> R<()>;          // CREATE DATABASE next TEMPLATE live STRATEGY = FILE_COPY + attribute replay
    fn drop_db(&mut self, name: &str) -> R<()>;                // DROP DATABASE IF EXISTS .. WITH (FORCE)
    fn swap(&mut self, n: &DbNames) -> R<()>;                  // one transaction: live->prev, next->live
    fn swap_back(&mut self, n: &DbNames) -> R<()>;             // one transaction: live->failed, prev->live
    fn activate_pack(&mut self, version: &str) -> R<()>;       // re-point services to the pack (restarts Postgres)
    fn start_internal_stack(&mut self) -> R<()>;               // roles LOGIN, Auth+Rest+Functions up; LAN stays in maintenance
    fn stop_internal_stack(&mut self) -> R<()>;
    fn reopen_gateway(&mut self) -> R<()>;                     // the point of no return for update; restores the live gateway config
    fn finish_unfence(&mut self) -> R<()>;                     // SCM recovery policy restored
}

/// The operation-specific middle. Update implements it in Task 7; Plan 09 implements `SwitchWork`.
pub trait OpWork {
    fn kind(&self) -> OpKind;
    /// Reason codes of things the operation noticed and survived (for the outcome); never free text.
    fn warnings(&self) -> Vec<String> { vec![] }
    fn backup_reason(&self) -> BackupReason;
    /// Behind the fence, after the backup, before the clone: PostgreSQL refuses to clone a template whose recorded collation version
    /// mismatches the running binary, so the SOURCE is repaired first (reindex + refresh). Idempotent, and never undone by a rollback.
    fn repair_source(&mut self, _ctx: &OpCtx) -> R<()> { Ok(()) }
    /// False when `work_on_clone` builds `ctx.names.next` itself (a restore loads a dump into a fresh database): the runner then skips the
    /// full template copy of the live database and its disk gate. Rollback never needs the clone: it swaps `prev` back and drops `next` if present.
    fn needs_clone(&self) -> bool { true }
    /// Runs behind the fence against `ctx.names.next` (update: migrate; switch: load data). Err => clone dropped, live untouched.
    fn work_on_clone(&mut self, ctx: &OpCtx) -> R<()>;
    /// Data the work learned during `work_on_clone` that belongs in the journal's `extra` (a switch re-reads the waived tills' queues
    /// there). The runner takes it right after `work_on_clone`, success or failure, and merges it before its next journal write.
    fn journal_patch(&mut self) -> Option<serde_json::Value> { None }
    /// True when the runner should record the elapsed time of each phase in the journal's `extra.timingsMs` (a switch does, for the runbook).
    fn wants_timings(&self) -> bool { false }
    /// Database-only checks on the clone before the swap. Err => clone dropped.
    fn verify_clone(&mut self, ctx: &OpCtx) -> R<()>;
    /// After the pack is activated and Postgres runs, before Auth/Rest/Functions start.
    fn after_activate(&mut self, _ctx: &OpCtx) -> R<()> { Ok(()) }
    /// The runner is about to undo the operation: called first, before anything local is touched (and so before anything local can hang).
    /// A switch stops renewing the cloud freeze here, so the cloud's dead-man frees a frozen cloud within its window whatever the local
    /// rollback does. The default does nothing.
    fn rollback_started(&mut self) {}
    /// Services up on the INTERNAL listener, LAN still in maintenance. NEVER creates a sale. Err => swap back.
    fn verify_live(&mut self, ctx: &OpCtx) -> R<()>;
    fn verify_after_rollback(&mut self, _ctx: &OpCtx) -> R<()> { Ok(()) }
    /// After the point of no return. Idempotent (recovery may repeat it).
    fn on_commit(&mut self, ctx: &OpCtx) -> R<()>;
}
