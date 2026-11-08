//! Backup service: encrypted backups, restore, drill, alerts. See the plan
//! docs/superpowers/plans/2026-10-02-two-mode-08-backup-service.md.
pub mod acl;
pub mod args;
pub mod backup_tasks;
pub mod cli;
pub mod config;
pub mod ctx;
pub mod dest;
pub mod drill;
pub mod dump;
pub mod escrow;
pub mod fingerprint;
pub mod keys;
pub mod maintain;
pub mod migrate;
pub mod paths;
pub mod pepper;
pub mod pg;
pub mod photos;
pub mod plan08_backup;
pub mod policy;
pub mod rederive;
pub mod repo;
pub mod restic;
pub mod restore;
pub mod restore_work;
pub mod result;
pub mod run;
pub mod runlog;
pub mod state;
pub mod status;
pub mod util;

pub use ctx::BackupCtx;
pub use run::Deps;

#[cfg(test)]
mod pg_it;
