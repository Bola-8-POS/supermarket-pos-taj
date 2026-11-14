//! What the switch shows while it runs: `state\update\switch-progress.json` (admin-only, like the journal; never `state\`, which the
//! Gateway can read). It is DISPLAY ONLY. Whether the cloud may be released after a failure is decided from the journal
//! (`work::may_release_cloud`), never from this file, so a torn or edited file cannot release a cloud that has `moved`.
use crate::ops::world::R;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = "switch-progress.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Progress {
    pub phase: String,
    /// `held` (draining or frozen), `released` (back to active), `moved` (the data lives here now), `unknown` (the cloud
    /// may be moved while this server is not switched: `posctl switch rollback <op>`).
    pub cloud: String,
    pub updated_ms: u64,
    /// The operation id that owns the cloud marker (written before `mark_moved`, so a crash leaves a recoverable record).
    #[serde(default)]
    pub op_id: Option<String>,
}

pub fn path(update_dir: &Path) -> PathBuf {
    update_dir.join(FILE)
}

pub fn write(update_dir: &Path, p: &Progress) -> R<()> {
    let bytes = serde_json::to_vec_pretty(p)
        .map_err(|e| crate::ops::outcome::OpError::err("PROGRESS_IO", e.to_string()))?;
    crate::util::write_atomic(&path(update_dir), &bytes).map_err(|e| {
        crate::ops::outcome::OpError::err(
            "PROGRESS_IO",
            format!("switch-progress.json: {}", e.kind()),
        )
    })
}

/// A missing, torn or unreadable file is `None`: callers must not decide anything from it.
pub fn read(update_dir: &Path) -> Option<Progress> {
    serde_json::from_slice(&std::fs::read(path(update_dir)).ok()?).ok()
}

/// `(code, message, since_ms)` for `status`. `journal_open`: an operation's journal is on disk; `op_running`: the lock says it is
/// being run right now. Unlike the other two, `unknown` survives the journal being archived.
/// - `held` is the normal state of a run in progress (and of a crashed one, which `RECOVERY_NEEDED` already reports): it alerts only
///   when NO journal is open, i.e. a switch stopped without giving the cloud back.
/// - `unknown`, and `moved` or `marking moved` with an open journal nobody is running, are `SWITCH_CLOUD_MAY_BE_MOVED`: the cloud may
///   be marked moved while this server is not switched. (The same two states during a live run are not an alert.)
pub fn status_alert(
    update_dir: &Path,
    journal_open: bool,
    op_running: bool,
) -> Option<(String, String, u64)> {
    status_alert_for(update_dir, journal_open, op_running, Holder::Nobody)
}

/// Who holds the operation lock while `status` judges that nobody is running an operation: a hung `posctl.exe` keeps it, and
/// `switch rollback` and `update --recover` then answer exit 10 until that process is stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    /// The lock is free: the process is gone.
    Nobody,
    /// A holder older than any legal run (a hung process), with its process id from the lock info.
    Pid(u32),
    /// Something holds the lock but the holder's id could not be read.
    Unreadable,
}

/// What to do about a hung holder, ending in ", then " (empty when nobody holds the lock). A hung process keeps the lock and recovery
/// answers exit 10 until it is stopped. Never by image name (other posctl processes run on this machine); and the id comes from a file that
/// can be stale, so the PID is confirmed to be a posctl.exe first (a reused PID is another program).
pub fn stop_text(holder: Holder) -> String {
    match holder {
        Holder::Nobody => String::new(),
        Holder::Pid(pid) => format!("stop the hung posctl.exe by its process id {pid} (never by image name; first confirm that PID is posctl.exe, for example `tasklist /FI \"PID eq {pid}\"`) or restart the server, then "),
        Holder::Unreadable => "if a hung posctl.exe still holds the operation lock, stop it by its process id (not readable here: look it up in update.lock.info in the update folder; never by image name; first confirm that PID is posctl.exe with `tasklist`) or restart the server, then ".to_string(),
    }
}

pub fn status_alert_for(
    update_dir: &Path,
    journal_open: bool,
    op_running: bool,
    holder: Holder,
) -> Option<(String, String, u64)> {
    let p = read(update_dir)?;
    let op = p.op_id.as_deref().unwrap_or("<op id>");
    let in_move = p.cloud == "moved" || p.phase == "marking moved";
    if p.cloud == "unknown" {
        return Some((
            "SWITCH_CLOUD_MAY_BE_MOVED".into(),
            format!(
                "the cloud store may be marked moved while this server is not switched; run `posctl switch rollback {op}` with the cloud credentials"
            ),
            p.updated_ms,
        ));
    }
    if in_move && journal_open && !op_running {
        let stop = stop_text(holder);
        return Some((
            "SWITCH_CLOUD_MAY_BE_MOVED".into(),
            format!(
                "a switch stopped while the cloud store was being marked moved; {stop}run `posctl update --recover`; if it ends with exit 17, run the `posctl switch rollback {op}` it prints, with the cloud credentials"
            ),
            p.updated_ms,
        ));
    }
    if p.cloud == "held" && !journal_open {
        return Some((
            "SWITCH_CLOUD_NOT_RELEASED".into(),
            format!(
                "a switch stopped while the cloud store was held; run `posctl switch rollback {op}` with the cloud credentials"
            ),
            p.updated_ms,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(cloud: &str) -> Progress {
        Progress {
            phase: "x".into(),
            cloud: cloud.into(),
            updated_ms: 7,
            op_id: None,
        }
    }

    #[test]
    fn status_alert_reports_cloud_not_released() {
        let d = tempfile::tempdir().unwrap();
        assert!(status_alert(d.path(), false, false).is_none());
        write(d.path(), &p("held")).unwrap();
        let (code, _, since) = status_alert(d.path(), false, false).unwrap();
        assert_eq!((code.as_str(), since), ("SWITCH_CLOUD_NOT_RELEASED", 7));
        write(d.path(), &p("released")).unwrap();
        assert!(status_alert(d.path(), false, false).is_none());
        write(d.path(), &p("moved")).unwrap();
        assert!(
            status_alert(d.path(), false, false).is_none(),
            "moved with no journal is the normal end"
        );
        let mut u = p("unknown");
        u.op_id = Some("op-9".into());
        write(d.path(), &u).unwrap();
        let (code, msg, _) = status_alert(d.path(), false, false).unwrap();
        assert_eq!(code, "SWITCH_CLOUD_MAY_BE_MOVED");
        assert!(msg.contains("posctl switch rollback op-9"), "{msg}");
    }

    #[test]
    fn the_held_alert_is_suppressed_while_a_journal_is_open_and_moved_alerts_only_with_one() {
        let d = tempfile::tempdir().unwrap();
        let mut held = p("held");
        held.op_id = Some("op-3".into());
        write(d.path(), &held).unwrap();
        assert!(
            status_alert(d.path(), true, false).is_none() && status_alert(d.path(), true, true).is_none(),
            "a normal run (or a crashed one, which RECOVERY_NEEDED reports) shows held"
        );
        // marking moved, journal open, nobody running it: the cloud may be moved
        let mut marking = p("held");
        marking.phase = "marking moved".into();
        marking.op_id = Some("op-3".into());
        write(d.path(), &marking).unwrap();
        let (code, msg, _) = status_alert(d.path(), true, false).unwrap();
        assert_eq!(code, "SWITCH_CLOUD_MAY_BE_MOVED");
        assert!(msg.contains("posctl switch rollback op-3"), "{msg}");
        assert!(status_alert(d.path(), true, true).is_none(), "the same state during a live run is not an alert");
        let (code, msg, _) = status_alert(d.path(), false, false).unwrap();
        assert_eq!(code, "SWITCH_CLOUD_NOT_RELEASED", "no journal: the held cloud is the old alert");
        assert!(msg.contains("posctl switch rollback op-3"), "the held alert names the operation: {msg}");
        let mut moved = p("moved");
        moved.op_id = Some("op-3".into());
        write(d.path(), &moved).unwrap();
        assert_eq!(status_alert(d.path(), true, false).unwrap().0, "SWITCH_CLOUD_MAY_BE_MOVED");
        assert!(status_alert(d.path(), true, true).is_none() && status_alert(d.path(), false, false).is_none());
        // unknown survives the journal and a live run
        let mut u = p("unknown");
        u.op_id = Some("op-3".into());
        write(d.path(), &u).unwrap();
        for (open, running) in [(false, false), (true, false), (true, true)] {
            assert_eq!(status_alert(d.path(), open, running).unwrap().0, "SWITCH_CLOUD_MAY_BE_MOVED", "{open} {running}");
        }
    }

    #[test]
    fn the_stopped_in_move_alert_names_the_hung_pid_and_the_recovery_steps() {
        let d = tempfile::tempdir().unwrap();
        let mut moved = p("moved");
        moved.op_id = Some("op-8".into());
        write(d.path(), &moved).unwrap();
        let msg = |h: Holder| status_alert_for(d.path(), true, false, h).unwrap().1;
        for h in [Holder::Nobody, Holder::Pid(4242), Holder::Unreadable] {
            let m = msg(h);
            assert!(m.contains("posctl update --recover") && m.contains("exit 17") && m.contains("`posctl switch rollback op-8`"), "{h:?}: {m}");
        }
        let m = msg(Holder::Pid(4242));
        assert!(m.contains("process id 4242") && m.contains("never by image name"), "{m}");
        assert!(m.contains("confirm that PID is posctl.exe") && m.contains("tasklist /FI \"PID eq 4242\""), "a stale info file or a reused PID is another program: {m}");
        assert!(m.find("4242").unwrap() < m.find("update --recover").unwrap(), "stop the process first: {m}");
        let m = msg(Holder::Unreadable);
        assert!(m.contains("update.lock.info") && m.contains("never by image name") && !m.contains("process id 4242"), "{m}");
        assert!(!msg(Holder::Nobody).contains("process id"), "no holder: nothing to stop");
        // the plain entry point is the no-holder alert
        assert_eq!(status_alert(d.path(), true, false).unwrap().1, msg(Holder::Nobody));
    }

    #[test]
    fn a_torn_progress_file_reads_as_nothing() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(path(d.path()), b"{\"phase\":\"x\",\"cloud\":\"mov").unwrap();
        assert!(read(d.path()).is_none() && status_alert(d.path(), true, false).is_none());
        std::fs::write(path(d.path()), b"").unwrap();
        assert!(read(d.path()).is_none());
    }
}
