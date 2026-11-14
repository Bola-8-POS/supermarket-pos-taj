//! `state\backup.json`: what the backup service remembers between runs. Written under
//! `backups\backup.lock`; read by `status::fragment`. Epoch seconds everywhere.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::result::{BResult, BackupError};
use super::util::write_atomic_prepared;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapRef {
    pub id: String,
    pub at: i64,
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DestState {
    pub reachable: bool,
    pub ok: bool,
    pub last_success: Option<SnapRef>,
    pub last_error: Option<String>,
    pub down_since: Option<i64>,
    pub next_copy_attempt_at: i64,
    /// Last time this repository passed a verify / was pruned (epoch seconds, 0 = never). Per repository: a drive that
    /// is away for a month must not hold back the others, and a drive that comes back is maintained on its own clock.
    pub verified_at: i64,
    pub pruned_at: i64,
    /// Last full read that ran out of time (see `BackupState::local_verify_attempt_at`).
    pub verify_attempt_at: i64,
    /// A different drive sits where this destination was set up (volume serial mismatch): never written, never
    /// retried as a normal failure, reported distinctly.
    pub foreign: bool,
    /// When this reachable destination's copy started failing (a real failure, not a time-capped copy that resumes);
    /// cleared by the next good copy. Gives BACKUP_DEST_FAILING a stored, stable since.
    pub failing_since: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckRef {
    pub at: i64,
    pub ok: bool,
    pub last_pass_at: i64,
    pub detail: String,
    /// Not a failure of the repository: a read that ran out of time ("could not finish reading ...").
    /// Still `ok: false`, the repository is not verified.
    pub incomplete: bool,
    /// When this check started failing for real (not merely unfinished); kept across the interrupted marker and repeated failed
    /// runs, cleared by a pass. It is the stable since of BACKUP_VERIFY_FAILED.
    pub failing_since: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DrillRef {
    pub at: i64,
    pub ok: bool,
    pub last_pass_at: i64,
    pub seconds: u64,
    pub source: String,
    pub detail: String,
    /// As CheckRef::failing_since, for the drill.
    pub failing_since: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecoveryKeyRef {
    pub issued_at: i64,
    /// restic key id per repository name (`local`, destination names), to remove them on rotation.
    pub key_ids: BTreeMap<String, String>,
}

/// Photo files restic could not read in the last backup that otherwise succeeded (paths only, first 20).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhotosUnreadableRef {
    pub at: i64,
    pub total: usize,
    pub paths: Vec<String>,
}

/// The last `restore --swap` that started (normal or recovered): kept apart from `update-result.json`, because a restore is
/// not an update event. `result` is `restored` | `rolled_back` | `failed` (the runner could not undo it: recovery pending).
/// Snapshot id only; never a key, path or password.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LastRestore {
    pub at: i64,
    pub result: String,
    pub reason: Option<String>,
    pub snapshot: String,
    /// Warning codes the restore ended with (PHOTOS_SOME_MISSING, POST_RESTORE_BACKUP_FAILED, PREV_COPY_REVOKE_FAILED,
    /// CANARY_AFTER_RESTORE, ...): fixed upper-case codes only, so status.backup can show them.
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupState {
    pub first_seen_at: i64,
    pub local: Option<SnapRef>,
    pub destinations: BTreeMap<String, DestState>,
    pub caja_close_watermark: i64,
    pub last_attempt_at: i64,
    pub last_attempt_ok: bool,
    pub last_error: Option<String>,
    pub last_db_bytes: u64,
    /// The local repository's own maintenance clocks (see `DestState::verified_at`). The pre-per-repo global `pruneAt`
    /// key of an older state file is ignored on load: every repository is simply due once.
    pub local_verified_at: i64,
    pub local_pruned_at: i64,
    /// Set when a full read of the local repository did not finish (timed out). A scheduled verify is due only when BOTH
    /// `local_verified_at` and this are six days old, so an unfinishable read is tried weekly, not daily; `local_verified_at`
    /// stays old, so the overdue alert stays raised meanwhile.
    pub local_verify_attempt_at: i64,
    pub verify: Option<CheckRef>,
    pub drill: Option<DrillRef>,
    pub recovery_key: Option<RecoveryKeyRef>,
    pub alert_since: BTreeMap<String, i64>,
    /// Set by a backup that kept its snapshot although some photos were unreadable; cleared by the next clean one.
    pub photos_unreadable: Option<PhotosUnreadableRef>,
    /// Start (unix seconds, `update::window::window_start_unix`) of the maintenance window in which a pre-update or
    /// pre-switch backup failed while the newest snapshot was already stale. 0 = none. One fenced attempt per window.
    pub pre_update_failed_window: i64,
    /// The last restore (see `LastRestore`).
    pub last_restore: Option<LastRestore>,
    /// Set by a restore whose post-restore backup did not finish while the store was fenced: the next scheduled tick backs up
    /// at once (`policy::decide`). Cleared by the next completed backup.
    pub backup_due_now: bool,
}

/// Creation time of `posctl.json` (falls back to its modified time where the file system keeps no creation time), never later
/// than `now`; `now` when there is no such file.
pub(crate) fn config_created(paths: &super::paths::BackupPaths, now: i64) -> i64 {
    let secs = std::fs::metadata(paths.conf_file())
        .and_then(|m| m.created().or_else(|_| m.modified()))
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    secs.map_or(now, |c| c.clamp(1, now.max(1)))
}

impl BackupState {
    fn fresh(first_seen_at: i64) -> Self {
        Self { first_seen_at, ..Default::default() }
    }

    /// Never makes the store look healthier than it is:
    /// - file missing: a fresh state, first seen `now`;
    /// - any other read error: `Err`, the caller saves nothing (a fresh state must not overwrite unreadable history);
    /// - corrupt or truncated JSON: the file is renamed to `backup.json.corrupt-<stamp>` (evidence kept) and the state
    ///   starts fresh with `first_seen_at = 0`, i.e. unknown history, which the alerts read as already stale;
    ///   if the rename fails that is an `Err` too.
    pub fn load(path: &Path, now: i64) -> BResult<Self> {
        Self::load_with(path, now, now)
    }

    /// `load` for callers that know the backup paths. A MISSING file is first seen when the backup configuration was created
    /// (as `status::read` has always aged it), not at the moment of this call: otherwise a service whose first run never
    /// happened looks young for ever, one run at a time.
    pub fn load_in(paths: &super::paths::BackupPaths, now: i64) -> BResult<Self> {
        Self::load_with(&paths.state_file(), now, config_created(paths, now))
    }

    fn load_with(path: &Path, now: i64, first_seen_if_missing: i64) -> BResult<Self> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::fresh(first_seen_if_missing)),
            Err(e) => return Err(BackupError::error(format!("cannot read {}: {e}", path.display()))),
        };
        match serde_json::from_str::<BackupState>(&text) {
            Ok(s) => Ok(s),
            Err(_) => {
                let mut aside = path.as_os_str().to_owned();
                aside.push(format!(".corrupt-{}", super::util::stamp_utc(now)));
                std::fs::rename(path, &aside).map_err(|e| BackupError::error(format!("cannot set aside the corrupt {}: {e}", path.display())))?;
                Ok(Self::fresh(0))
            }
        }
    }

    /// Atomic write only. Tests use this one: `save` strips every ACE but SYSTEM and Administrators, which would
    /// lock a non-elevated test process out of its own temp file.
    #[cfg(test)]
    pub(crate) fn save_unprotected(&self, path: &Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        super::util::write_atomic(path, text.as_bytes())
    }

    /// C4 (conventions v1.6): `state\` grants the Gateway RX with inheritance (Plan 05); this file must not
    /// inherit it. The temp file is restricted BEFORE the rename, so the target never exists readable by anyone else.
    /// `status::fragment` is the only thing that publishes a subset, via `status.json`.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        write_atomic_prepared(path, text.as_bytes(), &super::util::lock_down_file)
    }

    /// `save` for code that has a `BackupCtx`: `--dev` roots live under the developer's profile and skip the
    /// lock-down (same rule as `acl::assert_private`), which also keeps non-elevated tests able to read the file back.
    pub fn save_in(&self, ctx: &super::ctx::BackupCtx) -> std::io::Result<()> {
        let path = ctx.paths.state_file();
        if ctx.is_dev() {
            let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
            super::util::write_atomic(&path, text.as_bytes())
        } else {
            self.save(&path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_state_remembers_when_it_was_first_seen() {
        let d = tempfile::tempdir().unwrap();
        let s = BackupState::load(&d.path().join("backup.json"), 1_000).unwrap();
        assert_eq!(s.first_seen_at, 1_000);
        assert!(s.local.is_none());
    }

    #[test]
    fn a_missing_state_file_ages_from_the_backup_config_not_from_now() {
        let d = tempfile::tempdir().unwrap();
        let roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("program"));
        let paths = super::super::paths::BackupPaths::from_roots(&roots);
        std::fs::create_dir_all(paths.conf_file().parent().unwrap()).unwrap();
        std::fs::write(paths.conf_file(), "{}").unwrap();
        // the config was created "just now" (real clock); the caller's clock is far later
        let later = crate::util::now_unix() as i64 + 5_000_000;
        let s = BackupState::load_in(&paths, later).unwrap();
        assert!(s.first_seen_at > 0 && s.first_seen_at < later - 4_000_000, "first_seen_at {} must be the config's creation time, not {later}", s.first_seen_at);
        // no config file either: nothing older to go by, so now
        let bare = super::super::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.path().join("d2"), d.path().join("p2")));
        assert_eq!(BackupState::load_in(&bare, 1_234).unwrap().first_seen_at, 1_234);
        // an existing file keeps its own first_seen_at
        std::fs::create_dir_all(paths.state_dir()).unwrap();
        let st = BackupState { first_seen_at: 77, ..Default::default() };
        st.save_unprotected(&paths.state_file()).unwrap();
        assert_eq!(BackupState::load_in(&paths, later).unwrap().first_seen_at, 77);
    }

    #[test]
    fn state_round_trips_and_keeps_the_first_seen_time() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        let mut s = BackupState::load(&p, 1_000).unwrap();
        s.local = Some(SnapRef { id: "abc".into(), at: 2_000, reason: "manual".into() });
        s.alert_since.insert("BACKUP_STALE_24H".into(), 3_000);
        s.save_unprotected(&p).unwrap();
        let back = BackupState::load(&p, 99_999).unwrap();
        assert_eq!(back.first_seen_at, 1_000);
        assert_eq!(back.local.unwrap().id, "abc");
        assert_eq!(back.alert_since["BACKUP_STALE_24H"], 3_000);
    }

    #[test]
    fn a_corrupt_file_is_set_aside_with_a_stamp_and_history_reads_as_unknown() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::write(&p, "{not json").unwrap();
        let s = BackupState::load(&p, 1_790_000_000).unwrap();
        // first_seen_at 0 = unknown history: the staleness alerts fire at once instead of after 24 h
        assert_eq!(s.first_seen_at, 0);
        assert!(s.local.is_none());
        let kept = d.path().join(format!("backup.json.corrupt-{}", crate::backup::util::stamp_utc(1_790_000_000)));
        assert_eq!(std::fs::read_to_string(kept).unwrap(), "{not json", "the evidence is kept");
        assert!(!p.exists());
    }

    #[test]
    fn a_truncated_file_counts_as_corrupt() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        BackupState::load(&p, 1).unwrap().save_unprotected(&p).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, &text[..text.len() / 2]).unwrap();
        assert_eq!(BackupState::load(&p, 50).unwrap().first_seen_at, 0);
        assert!(std::fs::read_dir(d.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("backup.json.corrupt-")));
    }

    #[test]
    fn a_read_error_other_than_missing_is_an_error_not_a_fresh_state() {
        // a directory at the state path cannot be read as a file on any platform, and needs no elevation to set up
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::create_dir(&p).unwrap();
        assert!(BackupState::load(&p, 7).is_err());
        assert!(p.is_dir(), "nothing was renamed or replaced");
    }

    #[test]
    fn a_failed_rename_of_a_corrupt_file_is_an_error() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::write(&p, "{not json").unwrap();
        // the aside name is taken by a non-empty directory, so the rename cannot succeed
        let aside = d.path().join(format!("backup.json.corrupt-{}", crate::backup::util::stamp_utc(5)));
        std::fs::create_dir(&aside).unwrap();
        std::fs::write(aside.join("x"), b"x").unwrap();
        assert!(BackupState::load(&p, 5).is_err());
        assert!(p.exists(), "the bad file is still there");
    }

    #[test]
    fn an_old_state_with_only_the_global_prune_clock_still_loads_and_every_repository_is_due() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("backup.json");
        std::fs::write(&p, r#"{"firstSeenAt":5,"pruneAt":99,"local":{"id":"cafebabe","at":7,"reason":"hourly"},"destinations":{"usb-e":{"reachable":true,"ok":true}}}"#).unwrap();
        let st = BackupState::load(&p, 1).unwrap();
        assert_eq!((st.first_seen_at, st.local_verified_at, st.local_pruned_at), (5, 0, 0));
        assert_eq!(st.local.as_ref().unwrap().id, "cafebabe");
        let ds = &st.destinations["usb-e"];
        assert!(ds.reachable && ds.ok);
        assert_eq!((ds.verified_at, ds.pruned_at), (0, 0));
    }
}
