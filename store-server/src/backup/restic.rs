//! restic argument builders (pure), output parsers (pure) and the runner. Secrets travel only
//! through environment variables or password files, never through arguments.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::ctx::BackupCtx;
use super::policy::Reason;
use super::result::{BResult, BackupError};
use super::util::{parse_rfc3339, Exec, RunOutput};

pub const HOST: &str = "store";
pub const TAG_BASE: &str = "posctl";
pub const TAG_PROTECT: &str = "protect";
pub const PROTECT_DAYS: i64 = 30;

#[derive(Clone)]
pub enum Password {
    File(PathBuf),
    /// A recovery key supplied by the owner; goes to the child's environment only.
    Plain(String),
}

// Never derive Debug over a secret: a stray `{:?}` in a log line or a panic message would print the key.
impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Password::File(p) => f.debug_tuple("File").field(p).finish(),
            Password::Plain(_) => f.write_str("Plain(<redacted>)"),
        }
    }
}

#[derive(Clone)]
pub struct Repo {
    pub location: String,
    pub password: Password,
    /// For `r2`: the lines of `secrets\r2.env`.
    pub extra_env: Vec<(String, String)>,
}

// `extra_env` holds the R2 keys: show the variable NAMES only.
impl std::fmt::Debug for Repo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.extra_env.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("Repo").field("location", &self.location).field("password", &self.password).field("extra_env", &names).finish()
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

pub fn run_restic(exec: &dyn Exec, ctx: &BackupCtx, repo: &Repo, args: &[String], timeout: Duration) -> BResult<RunOutput> {
    run_restic_with(exec, ctx, repo, args, timeout, crate::exec::Priority::Normal)
}

/// `run_restic` at a scheduling class: maintenance (verify, prune) runs below normal so the till keeps its CPU.
pub fn run_restic_with(exec: &dyn Exec, ctx: &BackupCtx, repo: &Repo, args: &[String], timeout: Duration, priority: crate::exec::Priority) -> BResult<RunOutput> {
    let mut full = vec!["--repo".to_string(), repo.location.clone()];
    full.extend_from_slice(args);
    let tmp = ctx.paths.backups_tmp().to_string_lossy().into_owned();
    let mut env = vec![
        ("RESTIC_CACHE_DIR".to_string(), ctx.paths.cache().to_string_lossy().into_owned()),
        ("TEMP".to_string(), tmp.clone()),
        ("TMP".to_string(), tmp),
    ];
    match &repo.password {
        Password::File(p) => env.push(("RESTIC_PASSWORD_FILE".into(), p.to_string_lossy().into_owned())),
        Password::Plain(k) => env.push(("RESTIC_PASSWORD".into(), k.clone())),
    }
    env.extend(repo.extra_env.iter().cloned());
    exec.run_prio(&ctx.restic_exe(), &full, &env, None, timeout, priority).map_err(BackupError::tool)
}

pub fn snapshot_tags(reason: Reason, schema_max: &str, pack: &str) -> Vec<String> {
    let mut t = vec![TAG_BASE.to_string(), format!("reason:{}", reason.as_str()), format!("schema:{schema_max}"), format!("pack:{pack}")];
    if reason.protected() {
        t.push(TAG_PROTECT.to_string());
    }
    t
}

pub fn backup_args(stage: &Path, photos: Option<&Path>, tags: &[String]) -> Vec<String> {
    let mut a = s(&["backup", "--json", "--host", HOST, "--group-by", "host"]);
    for t in tags {
        a.push("--tag".into());
        a.push(t.clone());
    }
    // The photo upload staging folder is never part of a backup (conventions §2.2).
    a.push("--exclude".into());
    a.push(".tmp".into());
    a.push(stage.to_string_lossy().into_owned());
    if let Some(p) = photos {
        a.push(p.to_string_lossy().into_owned());
    }
    a
}

/// `copy_from`: (location of the repository to copy chunker parameters from, its password file).
pub fn init_args(copy_from: Option<(&str, &Path)>) -> Vec<String> {
    let mut a = s(&["init"]);
    if let Some((loc, pw)) = copy_from {
        a.extend(s(&["--copy-chunker-params", "--from-repo", loc, "--from-password-file", &pw.to_string_lossy()]));
    }
    a
}

pub fn copy_args(from_repo: &str, from_password_file: &Path) -> Vec<String> {
    s(&["copy", "--from-repo", from_repo, "--from-password-file", &from_password_file.to_string_lossy(), "--tag", TAG_BASE])
}

pub fn forget_args(prune: bool) -> Vec<String> {
    let mut a = s(&[
        "forget", "--tag", TAG_BASE, "--group-by", "host", "--keep-hourly", "24", "--keep-daily", "30", "--keep-monthly", "12",
        "--keep-tag", TAG_PROTECT,
    ]);
    if prune {
        a.push("--prune".into());
    }
    a
}

/// `forget --prune` for a drive too full to repack: deletes the unreferenced data without rewriting packs.
pub fn forget_prune_unlimited_args() -> Vec<String> {
    let mut a = forget_args(true);
    a.extend(s(&["--max-unused", "unlimited"]));
    a
}

/// Removes one snapshot by id (no prune): used for an incomplete backup.
pub fn forget_snapshot_args(id: &str) -> Vec<String> { s(&["forget", id]) }
pub fn snapshots_args() -> Vec<String> { s(&["snapshots", "--json", "--tag", TAG_BASE]) }
pub fn unlock_args() -> Vec<String> { s(&["unlock"]) }
pub fn cat_config_args() -> Vec<String> { s(&["cat", "config"]) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadData {
    No,
    Full,
    Subset(u8),
}

pub fn check_args(rd: ReadData) -> Vec<String> {
    match rd {
        ReadData::No => s(&["check"]),
        ReadData::Full => s(&["check", "--read-data"]),
        ReadData::Subset(p) => vec!["check".into(), format!("--read-data-subset={p}%")],
    }
}

pub fn restore_args(snapshot: &str, subpath: &str, target: &Path, overwrite_if_changed: bool) -> Vec<String> {
    let mut a = vec!["restore".to_string(), format!("{snapshot}:{subpath}"), "--target".into(), target.to_string_lossy().into_owned()];
    if overwrite_if_changed {
        a.extend(s(&["--overwrite", "if-changed"]));
    }
    a
}

/// One file of a snapshot's folder on stdout (`restic dump <id>:<folder> <file>`): used to read the small manifest before the
/// dump itself is fetched.
pub fn dump_file_args(snapshot: &str, subpath: &str, file: &str) -> Vec<String> {
    vec!["dump".to_string(), format!("{snapshot}:{subpath}"), file.to_string()]
}

pub fn ls_args(snapshot: &str, subpath: &str) -> Vec<String> {
    s(&["ls", "--json", "--recursive", snapshot, subpath])
}

pub fn key_add_args(new_password_file: &Path) -> Vec<String> {
    s(&["key", "add", "--new-password-file", &new_password_file.to_string_lossy()])
}

pub fn key_remove_args(id: &str) -> Vec<String> { s(&["key", "remove", id]) }

pub fn tag_remove_args(tag: &str, ids: &[String]) -> Vec<String> {
    let mut a = s(&["tag", "--remove", tag]);
    a.extend(ids.iter().cloned());
    a
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snap {
    pub id: String,
    pub time: i64,
    pub tags: Vec<String>,
    pub paths: Vec<String>,
    /// Set by `restic copy` (the source snapshot's id) and kept by `restic tag`: the id the snapshot had where it was made.
    pub original: Option<String>,
}

/// The two ids name the same snapshot. restic shows ids in two lengths (`short_id` is 8 digits, `id` is 64; 0.19 prints
/// the long one in the backup summary, other commands and older versions the short one), so equal means one is a prefix of
/// the other; ids shorter than 8 digits never match (an empty id matches nothing).
pub fn same_snapshot(a: &str, b: &str) -> bool {
    a.len() >= 8 && b.len() >= 8 && (a.starts_with(b) || b.starts_with(a))
}

impl Snap {
    /// The id this snapshot has in the repository where it was first made (a copy's `original`, else its own).
    pub fn source_id(&self) -> String {
        self.original.clone().unwrap_or_else(|| self.id.clone())
    }
    /// This snapshot is `id`, or the copy / tag-rewrite of it.
    pub fn is(&self, id: &str) -> bool {
        same_snapshot(&self.id, id) || self.original.as_deref().is_some_and(|o| same_snapshot(o, id))
    }

    fn tag_value(&self, prefix: &str) -> Option<String> {
        self.tags.iter().find_map(|t| t.strip_prefix(prefix).map(|v| v.to_string()))
    }
    pub fn reason(&self) -> Option<String> { self.tag_value("reason:") }
    pub fn schema(&self) -> Option<String> { self.tag_value("schema:") }
    pub fn protected(&self) -> bool { self.tags.iter().any(|t| t == TAG_PROTECT) }
}

pub fn parse_snapshots(json: &str) -> Result<Vec<Snap>, String> {
    let v: Value = serde_json::from_str(json.trim()).map_err(|e| format!("restic snapshots output is not JSON: {e}"))?;
    if v.is_null() {
        return Ok(Vec::new());
    }
    let arr = v.as_array().ok_or("restic snapshots output is not a list")?;
    arr.iter()
        .map(|o| {
            let id = o.get("id").and_then(Value::as_str).ok_or("snapshot without id")?.to_string();
            let time = o.get("time").and_then(Value::as_str).and_then(parse_rfc3339).ok_or("snapshot without a valid time")?;
            let strs = |k: &str| -> Vec<String> {
                o.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
            };
            let original = o.get("original").and_then(Value::as_str).filter(|x| !x.is_empty()).map(String::from);
            Ok(Snap { id, time, tags: strs("tags"), paths: strs("paths"), original })
        })
        .collect()
}

pub fn latest(snaps: &[Snap]) -> Option<&Snap> {
    latest_where(snaps, |_| true)
}

pub fn latest_where(snaps: &[Snap], keep: impl Fn(&Snap) -> bool) -> Option<&Snap> {
    snaps.iter().filter(|s| keep(s)).max_by_key(|s| s.time)
}

/// Snapshots whose `protect` tag is older than 30 days (the tag is then removed so the keep rules apply).
pub fn expired_protected(snaps: &[Snap], now: i64) -> Vec<String> {
    snaps.iter().filter(|s| s.protected() && now - s.time > PROTECT_DAYS * 86_400).map(|s| s.id.clone()).collect()
}

#[derive(Debug, PartialEq)]
pub struct BackupSummary {
    pub snapshot_id: String,
    pub total_bytes_processed: u64,
    pub data_added: u64,
}

pub fn parse_backup_summary(stdout: &str) -> Option<BackupSummary> {
    stdout.lines().rev().find_map(|l| {
        let v: Value = serde_json::from_str(l.trim()).ok()?;
        if v.get("message_type")?.as_str()? != "summary" {
            return None;
        }
        Some(BackupSummary {
            snapshot_id: v.get("snapshot_id")?.as_str()?.to_string(),
            total_bytes_processed: v.get("total_bytes_processed").and_then(Value::as_u64).unwrap_or(0),
            data_added: v.get("data_added").and_then(Value::as_u64).unwrap_or(0),
        })
    })
}

/// restic prints `saved new key with ID <hex>`. The id goes back onto a command line (`key remove <id>`), so it must
/// be lowercase hex of a sane length (restic prints 64 digits; a short prefix is accepted too), never an option.
pub fn parse_key_id(stdout: &str) -> Option<String> {
    let mut it = stdout.split_whitespace();
    while let Some(w) = it.next() {
        if w == "ID" {
            let id = it.next()?;
            let ok = (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            return ok.then(|| id.to_string());
        }
    }
    None
}

/// Human text for restic's documented exit codes.
pub fn describe_exit(out: &RunOutput) -> String {
    if out.timed_out {
        return "timed out".into();
    }
    match out.code {
        0 => "ok".into(),
        1 => "fatal error".into(),
        3 => "incomplete: some source files could not be read".into(),
        10 => "repository does not exist".into(),
        11 => "repository is locked by another process".into(),
        12 => "wrong key (password)".into(),
        130 => "interrupted".into(),
        c => format!("exit {c}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::policy::Reason;
    use std::path::Path;

    #[test]
    fn forget_args_are_the_agreed_retention_and_prune_is_opt_in() {
        let a = forget_args(false);
        let joined = a.join(" ");
        assert!(joined.contains("--group-by host"));
        assert!(joined.contains("--keep-hourly 24 --keep-daily 30 --keep-monthly 12"));
        assert!(joined.contains("--keep-tag protect"));
        assert!(!a.contains(&"--prune".to_string()));
        assert!(forget_args(true).contains(&"--prune".to_string()));
    }

    #[test]
    fn the_full_drive_prune_keeps_every_retention_flag() {
        let j = forget_prune_unlimited_args().join(" ");
        assert!(j.contains("--prune") && j.ends_with("--max-unused unlimited") && j.contains("--keep-tag protect") && j.contains("--group-by host"));
    }

    #[test]
    fn backup_args_exclude_the_photo_temp_folder_and_carry_tags_but_never_a_secret() {
        let tags = snapshot_tags(Reason::PreUpdate, "20260930000001", "1.11.0-r1");
        assert_eq!(tags, vec!["posctl", "reason:pre-update", "schema:20260930000001", "pack:1.11.0-r1", "protect"]);
        let a = backup_args(Path::new(r"C:\d\stage"), Some(Path::new(r"C:\d\photos")), &tags);
        let j = a.join(" ");
        assert!(j.contains("--json") && j.contains("--host store") && j.contains("--exclude .tmp"));
        // the per-run stage path must not defeat parent selection for the photos folder
        assert!(j.contains("--group-by host"), "{j}");
        assert!(j.contains(r"C:\d\stage") && j.contains(r"C:\d\photos"));
        assert!(!j.to_lowercase().contains("password"));
        let plain = snapshot_tags(Reason::Hourly, "x", "p");
        assert!(!plain.contains(&"protect".to_string()));
    }

    #[test]
    fn restore_uses_the_snapshot_subfolder_form() {
        let a = restore_args("1a2b3c4d", "/C/ProgramData/SupermarketPOS/photos", Path::new(r"C:\t"), true);
        assert_eq!(a[0], "restore");
        assert_eq!(a[1], "1a2b3c4d:/C/ProgramData/SupermarketPOS/photos");
        assert!(a.join(" ").contains("--overwrite if-changed"));
    }

    #[test]
    fn a_copied_snapshot_is_matched_by_its_source_id_in_either_id_length() {
        // ids come in two lengths; `copy` sets `original`, `tag` keeps it
        let full = format!("cafebabe{}", "0".repeat(56));
        let json = format!(r#"[{{"id":"d00dfeed{}","original":"{full}","time":"2026-10-02T09:00:00Z","tags":["posctl"],"paths":[]}},
                              {{"id":"11112222{}","time":"2026-10-02T08:00:00Z","tags":["posctl"],"paths":[]}}]"#, "1".repeat(56), "2".repeat(56));
        let s = parse_snapshots(&json).unwrap();
        assert_eq!(s[0].original.as_deref(), Some(full.as_str()));
        assert_eq!(s[1].original, None);
        assert!(s[0].is("cafebabe") && s[0].is(&full) && s[0].is("d00dfeed"), "own id, source id, either length");
        assert!(!s[1].is("cafebabe") && !s[0].is("deadbeef"));
        assert_eq!(s[0].source_id(), full);
        assert_eq!(s[1].source_id(), s[1].id);
        assert!(same_snapshot("cafebabe", &full) && same_snapshot(&full, "cafebabe") && same_snapshot("cafebabe", "cafebabe"));
        assert!(!same_snapshot("cafebabe", "cafebabf") && !same_snapshot("", "") && !same_snapshot("cafe", "cafebabe"), "empty and too-short ids never match");
    }

    #[test]
    fn init_for_a_copy_target_copies_the_chunker_parameters() {
        let a = init_args(Some(("D:\\local-repo", Path::new(r"C:\k\restic-password.txt"))));
        let j = a.join(" ");
        assert!(j.contains("--copy-chunker-params") && j.contains("--from-repo D:\\local-repo") && j.contains("--from-password-file"));
        assert_eq!(init_args(None), vec!["init"]);
    }

    #[test]
    fn snapshots_json_is_parsed_with_tags_and_paths() {
        let json = r#"[{"id":"aaaa1111bbbb2222","short_id":"aaaa1111","time":"2026-10-02T09:00:00.123456789+03:00","hostname":"store","tags":["posctl","reason:hourly","schema:20260930000001","protect"],"paths":["C:\\ProgramData\\SupermarketPOS\\backups\\stage\\current","C:\\ProgramData\\SupermarketPOS\\photos"]},
                       {"id":"cccc3333dddd4444","time":"2026-10-02T10:00:00Z","tags":null,"paths":[]}]"#;
        let s = parse_snapshots(json).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].reason().as_deref(), Some("hourly"));
        assert_eq!(s[0].schema().as_deref(), Some("20260930000001"));
        assert!(s[0].protected() && !s[1].protected());
        assert_eq!(latest(&s).unwrap().id, "cccc3333dddd4444");
        assert!(parse_snapshots("null").unwrap().is_empty());
        assert!(parse_snapshots("{").is_err());
    }

    #[test]
    fn the_backup_summary_line_is_found_among_progress_lines() {
        let out = "{\"message_type\":\"status\",\"percent_done\":0.5}\n{\"message_type\":\"summary\",\"snapshot_id\":\"deadbeef\",\"total_bytes_processed\":1234,\"data_added\":99}\n";
        let s = parse_backup_summary(out).unwrap();
        assert_eq!((s.snapshot_id.as_str(), s.total_bytes_processed, s.data_added), ("deadbeef", 1234, 99));
        assert!(parse_backup_summary("garbage").is_none());
    }

    #[test]
    fn key_ids_are_read_from_restic_output() {
        assert_eq!(parse_key_id("saved new key with ID 8b3f2a91c0d4e5f6\n").as_deref(), Some("8b3f2a91c0d4e5f6"));
        assert_eq!(parse_key_id("nothing here"), None);
    }

    #[test]
    fn a_key_id_is_lowercase_hex_of_a_sane_length_because_it_goes_back_onto_a_command_line() {
        let full = "ab".repeat(32);
        assert_eq!(parse_key_id(&format!("saved new key with ID {full}\n")).as_deref(), Some(full.as_str()));
        for bad in ["--password-command=evil", "ABCDEF12", "8b3f2a9g", "8b3f2a", &"a".repeat(65), "8b3f2a91\u{ff10}c"] {
            assert_eq!(parse_key_id(&format!("saved new key with ID {bad}\n")), None, "{bad}");
        }
    }

    #[test]
    fn only_old_protected_snapshots_lose_their_tag() {
        let now = 1_790_000_000;
        let mk = |id: &str, age_days: i64, protect: bool| Snap {
            id: id.into(),
            time: now - age_days * 86_400,
            tags: if protect { vec!["posctl".into(), "protect".into()] } else { vec!["posctl".into()] },
            paths: vec![],
            original: None,
        };
        let v = vec![mk("old-protected", 31, true), mk("new-protected", 29, true), mk("old-plain", 90, false)];
        assert_eq!(expired_protected(&v, now), vec!["old-protected".to_string()]);
    }

    #[test]
    fn check_args_cover_metadata_full_and_subset() {
        assert_eq!(check_args(ReadData::No), vec!["check"]);
        assert_eq!(check_args(ReadData::Full), vec!["check", "--read-data"]);
        assert_eq!(check_args(ReadData::Subset(5)), vec!["check", "--read-data-subset=5%"]);
    }

    #[test]
    fn secrets_travel_only_through_the_environment() {
        use crate::backup::util::fake::{test_ctx, FakeExec};
        use std::time::Duration;
        let key = format!("recovery-{}", 7);
        let exec = FakeExec::default().on("restic.exe snapshots", 0, "[]");
        let repo = Repo { location: r"D:\r".into(), password: Password::Plain(key.clone()), extra_env: vec![("AWS_ACCESS_KEY_ID".into(), "id".into())] };
        run_restic(&exec, &test_ctx(), &repo, &snapshots_args(), Duration::from_secs(5)).unwrap();
        let file = Repo { password: Password::File(r"C:\k\restic-password.txt".into()), extra_env: vec![], ..repo };
        run_restic(&exec, &test_ctx(), &file, &snapshots_args(), Duration::from_secs(5)).unwrap();
        let calls = exec.calls.borrow();
        assert!(calls.iter().all(|c| !c.contains(&key) && !c.contains("restic-password.txt")), "no secret or key path on argv: {calls:?}");
        assert!(calls[0].starts_with("restic.exe --repo D:\\r snapshots"));
        let envs = exec.envs.borrow();
        for k in ["RESTIC_PASSWORD", "RESTIC_CACHE_DIR", "AWS_ACCESS_KEY_ID", "TEMP", "TMP"] {
            assert!(envs[0].iter().any(|x| x == k), "{k} missing from env 0");
        }
        assert!(envs[1].iter().any(|x| x == "RESTIC_PASSWORD_FILE") && !envs[1].iter().any(|x| x == "RESTIC_PASSWORD"));
    }

    #[test]
    fn a_missing_restic_is_a_precondition_not_a_backup_failure() {
        use crate::backup::util::fake::test_ctx;
        use crate::envelope::Code;
        struct Gone;
        impl crate::backup::util::Exec for Gone {
            fn run(&self, _: &Path, _: &[String], _: &[(String, String)], _: Option<&[u8]>, _: std::time::Duration) -> std::io::Result<crate::backup::util::RunOutput> {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no restic"))
            }
        }
        let repo = Repo { location: "x".into(), password: Password::Plain("k".into()), extra_env: vec![] };
        let e = run_restic(&Gone, &test_ctx(), &repo, &unlock_args(), std::time::Duration::from_secs(1)).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
    }

    #[test]
    fn debug_output_never_contains_a_password_or_an_environment_value() {
        let secret = format!("owner-{}-{}", 4242, "recovery");
        let env_secret = format!("r2-{}-{}", 9191, "token");
        let p = Password::Plain(secret.clone());
        assert!(!format!("{p:?}").contains(&secret));
        let repo = Repo { location: "s3:example/bucket".into(), password: p, extra_env: vec![("AWS_SECRET_ACCESS_KEY".into(), env_secret.clone())] };
        let shown = format!("{repo:?} {:?}", Some(&repo));
        assert!(!shown.contains(&secret) && !shown.contains(&env_secret), "{shown}");
        assert!(shown.contains("s3:example/bucket") && shown.contains("AWS_SECRET_ACCESS_KEY"), "the location and variable NAMES stay useful");
        assert!(format!("{:?}", Password::File(r"C:\k\restic-password.txt".into())).contains("restic-password.txt"));
    }

    #[test]
    fn exit_codes_one_and_130_have_words() {
        let out = |code| RunOutput { code, ..Default::default() };
        assert!(describe_exit(&out(1)).contains("fatal"));
        assert!(describe_exit(&out(130)).contains("interrupted"));
        assert_eq!(describe_exit(&out(77)), "exit 77");
    }
}
