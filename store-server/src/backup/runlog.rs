//! The local log of backup commands: one JSON line per command in `logs\posctl\backup-<yyyyMMdd>.log`, written by
//! `commands::backup` (the generic posctl log skips `backup`, so the 5-minute tick does not write 288 "nothing to do" lines a day).
//!
//! Content: when, which command, the result code and message, and for a backup the reason, the outcome, the seconds per step,
//! `dump_bytes`, one result word per destination and the warnings. Built from a whitelist of keys, so a recovery key, a password
//! or a row can never get in by being added to a result later. Photo paths may appear (in the warnings): this file is local, and
//! status.json is the place paths must never reach.
//!
//! A skipped result (nothing due, lock busy, not due) is logged when its reason CHANGES, not at every tick. The last reason of each
//! command is kept in one small file beside the log; a real run clears it, so the next skip is a change again.
use serde_json::{json, Value};

use crate::paths::Roots;

/// The fixed word for a result that did nothing: `{"outcome":"skipped","skip":X}` (run), `{"skipped":X}` (verify, drill) or
/// `{"outcome":"not-due"}` (verify). `None` for a result that did something.
pub fn skip_reason(data: &Value) -> Option<String> {
    if data["outcome"] == "skipped" {
        return Some(data["skip"].as_str().unwrap_or("skipped").to_string());
    }
    if let Some(s) = data["skipped"].as_str() {
        return Some(s.to_string());
    }
    (data["outcome"] == "not-due").then(|| "not-due".to_string())
}

fn result_word(d: &Value) -> &'static str {
    if d["skipped"] == true {
        "skipped"
    } else if d["ok"] == true {
        "ok"
    } else {
        "failed"
    }
}

/// The line, from a whitelist of what a result may say.
pub fn line(at: &str, command: &str, code: &str, message: &str, data: &Value) -> Value {
    let mut v = json!({ "at": at, "command": command, "code": code, "message": message });
    for k in ["reason", "outcome", "snapshotId", "seconds", "dumpBytes"] {
        if !data[k].is_null() {
            v[k] = data[k].clone();
        }
    }
    if let Some(steps) = data["steps"].as_array() {
        let m: serde_json::Map<String, Value> = steps.iter().filter_map(|s| Some((s["step"].as_str()?.to_string(), s["secs"].clone()))).collect();
        v["stepSeconds"] = Value::Object(m);
    }
    if let Some(dests) = data["destinations"].as_array() {
        v["destinations"] = json!(dests.iter().map(|d| json!({ "name": d["name"], "result": result_word(d) })).collect::<Vec<_>>());
    }
    if let Some(repos) = data["repos"].as_array() {
        v["repos"] = json!(repos.iter().map(|r| json!({ "name": r["name"], "outcome": r["outcome"] })).collect::<Vec<_>>());
    }
    if let Some(w) = data["warnings"].as_array() {
        v["warnings"] = json!(w.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>());
    }
    v
}

/// Appends the line (see the module comment for what is skipped). Best effort: a log that cannot be written never changes the
/// result of the command. Nothing is written through a planted link or an untrusted folder.
pub fn write(roots: &Roots, command: &str, at: &str, code: &str, message: &str, data: &Value) {
    if !crate::layout::log_dir_is_trusted(roots) {
        return;
    }
    let dir = roots.posctl_logs();
    let memo = dir.join(format!("backup-skip-{}.txt", command.replace(' ', "-")));
    // a refusal (PRECONDITION) is logged like any other failure on purpose: the backup log is where "why not" shows
    let skip = if code == "OK" { skip_reason(data) } else { None };
    match &skip {
        Some(reason) => {
            if std::fs::read_to_string(&memo).is_ok_and(|last| last.trim() == reason) {
                return;
            }
            let _ = crate::util::write_atomic(&memo, reason.as_bytes());
        }
        None => {
            let _ = std::fs::remove_file(&memo);
        }
    }
    let day = at.get(..10).unwrap_or("0000-00-00").replace('-', "");
    let text = serde_json::to_string(&line(at, command, code, message, data)).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("backup-{day}.log"))) {
        use std::io::Write;
        let _ = writeln!(f, "{text}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(r.posctl_logs()).unwrap();
        (d, r)
    }

    fn all_lines(r: &Roots) -> Vec<Value> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(r.posctl_logs()).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with("backup-2") {
                out.extend(std::fs::read_to_string(e.path()).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()));
            }
        }
        out
    }

    fn completed() -> Value {
        json!({ "outcome": "completed", "reason": "hourly", "snapshotId": "cafebabe", "seconds": 61, "dumpBytes": 123456,
                "steps": [{"step": "dump", "secs": 40}, {"step": "restic", "secs": 20}, {"step": "copy", "secs": 1}],
                "destinations": [{"name": "usb-e", "ok": true, "skipped": false}, {"name": "cloud", "ok": false, "skipped": false, "error": "boom"}, {"name": "old", "ok": false, "skipped": true}],
                "warnings": ["photos_unreadable: 1 photo file(s) could not be read (the database is safe): C:/x/a.jpg"] })
    }

    #[test]
    fn a_backup_line_says_what_ran_how_long_each_step_took_and_the_result_of_each_destination() {
        let l = line("2026-10-22T10:00:00Z", "backup run", "OK", "backup completed", &completed());
        assert_eq!((l["reason"].as_str(), l["outcome"].as_str(), l["seconds"].as_i64(), l["dumpBytes"].as_i64()), (Some("hourly"), Some("completed"), Some(61), Some(123456)));
        assert_eq!(l["stepSeconds"], json!({ "dump": 40, "restic": 20, "copy": 1 }));
        assert_eq!(l["destinations"], json!([{ "name": "usb-e", "result": "ok" }, { "name": "cloud", "result": "failed" }, { "name": "old", "result": "skipped" }]));
        assert!(l["warnings"][0].as_str().unwrap().contains("a.jpg"), "paths are allowed in the local log");
        assert_eq!(l["code"], "OK");
    }

    #[test]
    fn only_whitelisted_keys_reach_the_log() {
        let mut d = completed();
        d["recoveryKey"] = json!("SECRETKEY");
        d["password"] = json!("SECRETPW");
        d["rows"] = json!([{"pin": "SECRETROW"}]);
        d["destinations"][0]["error"] = json!("SECRETERR");
        let text = line("2026-10-22T10:00:00Z", "backup run", "OK", "m", &d).to_string();
        for s in ["SECRETKEY", "SECRETPW", "SECRETROW", "SECRETERR"] {
            assert!(!text.contains(s), "{s} must not be in the log: {text}");
        }
    }

    #[test]
    fn skip_reasons_are_the_fixed_words_of_each_command() {
        assert_eq!(skip_reason(&json!({ "outcome": "skipped", "skip": "not-due" })).as_deref(), Some("not-due"));
        assert_eq!(skip_reason(&json!({ "skipped": "update-in-progress" })).as_deref(), Some("update-in-progress"));
        assert_eq!(skip_reason(&json!({ "outcome": "not-due", "notConnected": ["usb"] })).as_deref(), Some("not-due"));
        assert_eq!(skip_reason(&completed()), None);
        assert_eq!(skip_reason(&json!({ "outcome": "verified" })), None);
    }

    #[test]
    fn a_skipped_tick_is_logged_only_when_its_reason_changes_and_a_real_run_resets_that() {
        let (_d, r) = roots();
        let skip = |why: &str| json!({ "outcome": "skipped", "skip": why });
        let at = "2026-10-22T10:00:00Z";
        for why in ["not-due", "not-due", "not-due"] {
            write(&r, "backup run", at, "OK", "nothing to do", &skip(why));
        }
        assert_eq!(all_lines(&r).len(), 1, "three identical skips, one line");
        write(&r, "backup run", at, "OK", "nothing to do", &skip("busy"));
        write(&r, "backup run", at, "OK", "nothing to do", &skip("busy"));
        assert_eq!(all_lines(&r).len(), 2, "a new reason is a line");
        write(&r, "backup run", at, "OK", "backup completed", &completed());
        write(&r, "backup run", at, "OK", "nothing to do", &skip("busy"));
        assert_eq!(all_lines(&r).len(), 4, "a real run in between: the same reason is a change again");
        // another command keeps its own memory
        write(&r, "backup verify", at, "OK", "x", &json!({ "outcome": "not-due" }));
        write(&r, "backup verify", at, "OK", "x", &json!({ "outcome": "not-due" }));
        assert_eq!(all_lines(&r).len(), 5);
    }

    #[test]
    fn a_failure_is_always_logged_and_clears_the_memory() {
        let (_d, r) = roots();
        let at = "2026-10-22T10:00:00Z";
        write(&r, "backup run", at, "OK", "n", &json!({ "outcome": "skipped", "skip": "busy" }));
        write(&r, "backup run", at, "BACKUP_FAILED", "pg_dump failed", &json!({}));
        write(&r, "backup run", at, "BACKUP_FAILED", "pg_dump failed", &json!({}));
        let lines = all_lines(&r);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2]["code"], "BACKUP_FAILED");
        write(&r, "backup run", at, "OK", "n", &json!({ "outcome": "skipped", "skip": "busy" }));
        assert_eq!(all_lines(&r).len(), 4, "the failure ended the skip streak");
    }

    #[test]
    fn nothing_is_written_when_the_log_folder_is_missing() {
        let d = tempfile::tempdir().unwrap();
        let r = Roots::custom(d.path().join("data"), d.path().join("prog"));
        write(&r, "backup run", "2026-10-22T10:00:00Z", "OK", "m", &completed());
        assert!(!r.posctl_logs().exists());
    }
}
