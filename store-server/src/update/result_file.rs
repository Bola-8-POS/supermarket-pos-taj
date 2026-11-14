//! `state\update\update-result.json`: what the last update did, and which pack is waiting for a quiet moment.
//! It holds reason codes and scrubbed messages only, never a secret.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub pack_version: String, pub since_ms: u64, pub deferred_reason: String,
    /// A signature-verified pack for this version has been fetched or installed. The feed document itself is unsigned, so until then
    /// the version is only a claim and the alert is capped at warn (absent in an older file = not verified).
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResultFile {
    pub last_at_ms: u64,
    pub last_result: String, // updated | rolled_back | failed | refused | none
    pub last_code: String,
    #[serde(default)]
    pub last_reason: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
    pub pack_from: Option<String>,
    pub pack_to: Option<String>,
    pub failed_db: Option<String>,
    pub pending: Option<Pending>,
}

/// The pack the last update rolled back from, so the scheduled check does not try it again every hour and night. Reason codes
/// and times only. `pack_version` is the identity: the pack's manifest carries no hash of its own, and the version names one build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolledBack {
    pub pack_version: String,
    pub since_ms: u64,
    pub code: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl RolledBack {
    /// `path` is `Roots::rolled_back_record()` (status reads it through `Roots::read_path`). Missing or unreadable means no record (a retry is the safe direction).
    pub fn read(path: &Path) -> Option<Self> { std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()) }
    pub fn write(&self, path: &Path) -> std::io::Result<()> { crate::util::write_atomic(path, &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?) }
    pub fn clear(path: &Path) { let _ = std::fs::remove_file(path); }
}

impl UpdateResultFile {
    /// `dir` is `Roots::update_dir()`.
    pub fn read(dir: &Path) -> Self { Self::read_file(&dir.join("update-result.json")) }
    /// Not under the lock (status): the file in `state\update\`, else a pre-FR19 one in `state\`.
    pub fn read_roots(roots: &crate::paths::Roots) -> Self { Self::read_file(&roots.read_path(&roots.update_result())) }
    fn read_file(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn write(&self, dir: &Path) -> std::io::Result<()> {
        crate::util::write_atomic(&dir.join("update-result.json"), &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)
    }
    /// `verified`: the pack was fetched/installed through the signature check (a peek at the feed is not). It only ever goes up for the
    /// same version; a different version starts again from what the caller knows.
    pub fn note_pending(&mut self, pack: &str, reason: &str, now_ms: u64, verified: bool) {
        let (since, was) = match &self.pending { Some(p) if p.pack_version == pack => (p.since_ms, p.verified), _ => (now_ms, false) };
        self.pending = Some(Pending { pack_version: pack.into(), since_ms: since, deferred_reason: reason.into(), verified: verified || was });
    }
    pub fn clear_pending(&mut self) { self.pending = None; }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_missing_file_is_default() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(UpdateResultFile::read(d.path()), UpdateResultFile::default());
        let mut r = UpdateResultFile { last_result: "updated".into(), last_code: "OK".into(), ..Default::default() };
        r.note_pending("1.1.0-r1", "OPEN_CAJA", 1000, true);
        r.write(d.path()).unwrap();
        assert_eq!(UpdateResultFile::read(d.path()), r);
    }
    #[test]
    fn pending_keeps_its_first_seen_time_for_the_same_pack() {
        let mut r = UpdateResultFile::default();
        r.note_pending("1.1.0-r1", "OPEN_CAJA", 1000, false);
        r.note_pending("1.1.0-r1", "RECENT_SALE", 5000, false);
        let p = r.pending.clone().unwrap();
        assert_eq!((p.since_ms, p.deferred_reason.as_str()), (1000, "RECENT_SALE"));
        r.note_pending("1.2.0-r1", "OPEN_CAJA", 9000, false);
        assert_eq!(r.pending.unwrap().since_ms, 9000);
    }
    #[test]
    fn verified_only_goes_up_for_the_same_pack_and_restarts_for_a_new_one() {
        let mut r = UpdateResultFile::default();
        r.note_pending("1.1.0-r1", "OUTSIDE_WINDOW", 1000, false);
        assert!(!r.pending.as_ref().unwrap().verified, "a peek at the unsigned feed proves nothing");
        r.note_pending("1.1.0-r1", "OPEN_CAJA", 2000, true);
        assert!(r.pending.as_ref().unwrap().verified);
        r.note_pending("1.1.0-r1", "OUTSIDE_WINDOW", 3000, false);
        assert!(r.pending.as_ref().unwrap().verified, "a later peek does not take it back");
        r.note_pending("1.2.0-r1", "OUTSIDE_WINDOW", 4000, false);
        assert!(!r.pending.as_ref().unwrap().verified, "a different version is a new claim");
    }
    #[test]
    fn an_older_file_without_the_flag_reads_as_not_verified() {
        let r: UpdateResultFile = serde_json::from_str(r#"{"lastAtMs":0,"lastResult":"none","lastCode":"","packFrom":null,"packTo":null,"failedDb":null,"pending":{"packVersion":"1.1.0-r1","sinceMs":5,"deferredReason":"OPEN_CAJA"}}"#).unwrap();
        assert!(!r.pending.unwrap().verified);
    }
}
