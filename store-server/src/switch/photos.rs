//! The photo step of a switch (decision D2-a): Plan 10's importer runs as a CHILD PROCESS, `posctl photos import-from-cloud`, with
//! the cloud storage credentials on its stdin only (never argv, never the environment). It runs after swap, activate and the live
//! check, so the rows are already in `postgres` and no `--database` is passed. ANY non-zero exit makes the switch roll back; after
//! a clean import `posctl photos verify` must also exit 0 (60 = inconsistent rolls back too).
//! The contract is `docs/superpowers/plans/2026-10-30-two-mode-10-local-photo-storage.md` section 3.1.
use crate::exec::Cmd;
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::switch::source::StorageSource;
use std::path::Path;
use std::time::Duration;

/// One hour: the importer streams every object over the network.
pub const IMPORT_TIMEOUT: Duration = Duration::from_secs(3600);
pub const VERIFY_TIMEOUT: Duration = Duration::from_secs(600);

/// The one JSON object the child reads on stdin.
pub fn credentials_json(s: &StorageSource) -> String {
    serde_json::json!({ "v": 1, "projectUrl": s.project_url, "serviceRoleKey": s.service_role_key.expose() }).to_string()
}

/// Global flags that point the child at the same store as this process. Paths only; nothing secret. The roots are a dev/test option
/// (`cli::roots_for` refuses them without `--dev`), so in production none are passed and the child uses `Roots::production()`.
pub(crate) fn global_args(data: &Path, program: &Path, dev: bool) -> Vec<String> {
    let mut a = vec!["--json".to_string()];
    if dev {
        a.push("--dev".into());
        a.push("--data-root".into());
        a.push(data.display().to_string());
        a.push("--program-root".into());
        a.push(program.display().to_string());
    }
    a
}

pub fn import_args(
    data: &Path,
    program: &Path,
    dev: bool,
    buckets: &[String],
    dry_run: bool,
) -> Vec<String> {
    let mut a = vec![
        "photos".to_string(),
        "import-from-cloud".into(),
        "--source-credentials-stdin".into(),
    ];
    if !buckets.is_empty() {
        a.push("--buckets".into());
        a.push(buckets.join(","));
    }
    if dry_run {
        a.push("--dry-run".into());
    }
    a.extend(global_args(data, program, dev));
    a
}

pub fn verify_args(data: &Path, program: &Path, dev: bool) -> Vec<String> {
    let mut a = vec!["photos".to_string(), "verify".into()];
    a.extend(global_args(data, program, dev));
    a
}

/// The reason code of a child exit code (Plan 10 section 3.1). Never the child's output: it could name a path or an object.
pub fn exit_reason(code: i32) -> &'static str {
    match code {
        61 => "PHOTOS_IMPORT_FAILED",
        60 => "PHOTOS_INCONSISTENT",
        2 => "PHOTOS_IMPORT_USAGE",
        3 => "PHOTOS_IMPORT_NOT_ELEVATED",
        4 => "PHOTOS_IMPORT_NOT_PROVISIONED",
        _ => "PHOTOS_IMPORT_ERROR",
    }
}

fn run_child(
    exe: &Path,
    args: Vec<String>,
    stdin: Option<String>,
    limit: Duration,
    what: &str,
) -> R<()> {
    let mut cmd = Cmd::new(exe).args(args).timeout(limit);
    if let Some(s) = stdin {
        cmd = cmd.stdin(s.into_bytes());
    }
    let out = cmd
        .run()
        .map_err(|_| OpError::err("PHOTOS_IMPORT_SPAWN", format!("{what} could not run")))?;
    if out.code == 0 {
        return Ok(());
    }
    Err(OpError::new(
        OpCode::Error,
        exit_reason(out.code),
        format!("{what} exited with {}", out.code),
    ))
}

/// The importer, then the verifier. `Ok` only when both exit 0.
pub fn run_import(
    exe: &Path,
    data: &Path,
    program: &Path,
    dev: bool,
    storage: &StorageSource,
    buckets: &[String],
) -> R<()> {
    run_import_within(exe, data, program, dev, storage, buckets, &|d| Ok(d))
}

/// `run_import` where `cap` turns each child's own limit into the limit it really gets (the switch caps it at the operation's deadline,
/// so a hung importer is killed in time and the switch rolls back); an `Err` from `cap` is the budget used up and stops before the child.
pub fn run_import_within(
    exe: &Path,
    data: &Path,
    program: &Path,
    dev: bool,
    storage: &StorageSource,
    buckets: &[String],
    cap: &dyn Fn(Duration) -> R<Duration>,
) -> R<()> {
    run_child(
        exe,
        import_args(data, program, dev, buckets, false),
        Some(credentials_json(storage)),
        cap(IMPORT_TIMEOUT)?,
        "the photo import",
    )?;
    run_child(
        exe,
        verify_args(data, program, dev),
        None,
        cap(VERIFY_TIMEOUT)?,
        "the photo check",
    )
}

#[cfg(all(test, windows))]
pub(crate) mod tests {
    use super::*;
    use crate::switch::source::Secret;

    fn storage() -> StorageSource {
        StorageSource {
            project_url: "https://abc.supabase.co".into(),
            service_role_key: Secret::new("SERVICE-KEY-123"),
        }
    }

    /// A stand-in `posctl`: records its argv and stdin per call and exits with the code named for that subcommand.
    pub(crate) fn stub(
        import_code: i32,
        verify_code: i32,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("posctl.cmd");
        let body = format!(
            "@echo off\r\necho %*>>\"%~dp0argv.txt\"\r\nif \"%2\"==\"import-from-cloud\" (findstr \"^\" >\"%~dp0stdin.txt\" & exit /b {import_code})\r\nexit /b {verify_code}\r\n"
        );
        std::fs::write(&exe, body).unwrap();
        (d, exe)
    }

    fn run(exe: &Path) -> R<()> {
        run_import(
            exe,
            Path::new("C:\\data"),
            Path::new("C:\\prog"),
            false,
            &storage(),
            &[],
        )
    }

    #[test]
    fn photo_import_child_gets_stdin_json_and_no_secret_in_argv() {
        let (d, exe) = stub(0, 0);
        run(&exe).unwrap();
        let argv = std::fs::read_to_string(d.path().join("argv.txt")).unwrap();
        let stdin = std::fs::read_to_string(d.path().join("stdin.txt")).unwrap();
        let v: serde_json::Value = serde_json::from_str(stdin.trim()).unwrap();
        assert_eq!(
            (
                v["v"].as_i64(),
                v["projectUrl"].as_str(),
                v["serviceRoleKey"].as_str()
            ),
            (
                Some(1),
                Some("https://abc.supabase.co"),
                Some("SERVICE-KEY-123")
            )
        );
        assert!(argv.contains("--source-credentials-stdin"));
        assert!(
            !argv.contains("SERVICE-KEY-123") && !argv.contains("supabase.co"),
            "{argv}"
        );
    }

    #[test]
    fn photo_import_passes_no_database_flag() {
        let (d, exe) = stub(0, 0);
        run(&exe).unwrap();
        let argv = std::fs::read_to_string(d.path().join("argv.txt")).unwrap();
        assert!(!argv.contains("--database"), "{argv}");
        assert!(import_args(
            Path::new("d"),
            Path::new("p"),
            true,
            &["a".into(), "b".into()],
            true
        )
        .join(" ")
        .contains("--buckets a,b --dry-run"));
    }

    /// `roots_for` accepts the two roots only together with `--dev`, so production must push none of them.
    #[test]
    fn root_args_are_pushed_only_under_dev() {
        let (d, p) = (Path::new("C:\\data"), Path::new("C:\\prog"));
        let b = ["a".to_string()];
        for args in [
            import_args(d, p, false, &b, false),
            verify_args(d, p, false),
        ] {
            let j = args.join(" ");
            assert!(
                !j.contains("--data-root") && !j.contains("--program-root") && !j.contains("--dev"),
                "{j}"
            );
        }
        for args in [import_args(d, p, true, &b, false), verify_args(d, p, true)] {
            let j = args.join(" ");
            assert!(
                j.contains("--dev")
                    && j.contains("--data-root C:\\data")
                    && j.contains("--program-root C:\\prog"),
                "{j}"
            );
        }
    }

    #[test]
    fn photo_import_exit_0_continues() {
        let (d, exe) = stub(0, 0);
        run(&exe).unwrap();
        let argv = std::fs::read_to_string(d.path().join("argv.txt")).unwrap();
        assert_eq!(
            argv.lines().count(),
            2,
            "the import, then the check: {argv}"
        );
    }

    #[test]
    fn every_non_zero_import_exit_is_a_failure_with_its_own_reason() {
        for (code, reason) in [
            (61, "PHOTOS_IMPORT_FAILED"),
            (2, "PHOTOS_IMPORT_USAGE"),
            (3, "PHOTOS_IMPORT_NOT_ELEVATED"),
            (4, "PHOTOS_IMPORT_NOT_PROVISIONED"),
            (1, "PHOTOS_IMPORT_ERROR"),
        ] {
            let (d, exe) = stub(code, 0);
            let e = run(&exe).unwrap_err();
            assert_eq!(e.reason, reason, "exit {code}");
            let argv = std::fs::read_to_string(d.path().join("argv.txt")).unwrap();
            assert_eq!(
                argv.lines().count(),
                1,
                "the check does not run after a failed import (exit {code})"
            );
        }
    }

    #[test]
    fn photo_verify_exit_60_rolls_back() {
        let (_d, exe) = stub(0, 60);
        assert_eq!(run(&exe).unwrap_err().reason, "PHOTOS_INCONSISTENT");
    }
}
