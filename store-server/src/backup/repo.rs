//! Repository handles: the always-present local repository and the configured destinations.
use std::time::Duration;

use super::config::{DestKind, Destination};
use super::ctx::BackupCtx;
use super::keys::ensure_machine_key;
use super::restic::{init_args, run_restic, Password, Repo};
use super::result::{BResult, BackupError};
use super::util::{tail, Exec};

/// `KEY=VALUE` lines of `secrets\r2.env` (comments and blanks skipped, surrounding quotes trimmed). The file is
/// loaded into the restic child's environment, so only `AWS_*` names are accepted: a line such as
/// `RESTIC_PASSWORD_FILE`, `PATH` or `TEMP` would redirect the key file or the child's search path. The error names
/// the variable, never its value.
pub fn load_env_file(path: &std::path::Path) -> BResult<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = Vec::new();
    for (i, l) in text.lines().enumerate().map(|(i, l)| (i, l.trim())).filter(|(_, l)| !l.is_empty() && !l.starts_with('#')) {
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim();
        let ok = k.strip_prefix("AWS_").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'));
        if !ok {
            // Name the variable only when it has the shape of one (UPPER_CASE, at most 40 characters). Anything else may
            // be a pasted secret whose text before its first `=` (base64 padding!) must never reach a log or an error.
            let shaped = k.len() <= 40 && k.bytes().next().is_some_and(|b| b.is_ascii_uppercase() || b == b'_') && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
            let what = if shaped { format!("found '{k}'") } else { format!("line {}", i + 1) };
            return Err(BackupError::precondition(format!("secrets\\r2.env may only set AWS_ variables ({what})")));
        }
        out.push((k.to_string(), v.trim().trim_matches('"').to_string()));
    }
    Ok(out)
}

pub fn local_exists(ctx: &BackupCtx) -> bool {
    ctx.paths.repo().join("config").is_file()
}

pub fn local_repo(ctx: &BackupCtx) -> Repo {
    Repo { location: ctx.paths.repo().to_string_lossy().into_owned(), password: Password::File(ctx.paths.machine_key()), extra_env: vec![] }
}

/// The local repository lives on the system disk: it protects against a bad update or corrupted data,
/// not against losing the disk (destinations do that). Created on first use.
/// `has_destinations`: any configured destination already holds data under the machine key, so a missing key is
/// PRECONDITION even when the local repository is gone too (invariant 5).
pub fn ensure_local_repo(ctx: &BackupCtx, exec: &dyn Exec, has_destinations: bool) -> BResult<Repo> {
    super::acl::ensure_private_backups(ctx)?; // before anything is created under `backups\`: it must not be born with an inherited DACL
    let exists = local_exists(ctx);
    ensure_machine_key(ctx, exists || has_destinations)?;
    let repo = local_repo(ctx);
    if !exists {
        std::fs::create_dir_all(ctx.paths.repo())?;
        let out = run_restic(exec, ctx, &repo, &init_args(None), Duration::from_secs(120))?;
        if !out.ok() {
            return Err(BackupError::backup_failed(format!("cannot create the local backup repository: {}", tail(&out.stderr))));
        }
    }
    Ok(repo)
}

pub fn dest_repo(ctx: &BackupCtx, d: &Destination) -> BResult<Repo> {
    let extra_env = match d.kind {
        DestKind::Device => {
            // run, verify, prune, drill, key-export and status all build their repository here: refuse a swapped folder before restic sees it
            #[cfg(windows)]
            if super::dest::device_refused_now(std::path::Path::new(d.location()), d.volume_serial.as_deref()) {
                return Err(BackupError::precondition(super::dest::DEVICE_REFUSED_MSG));
            }
            vec![]
        }
        DestKind::R2 => {
            let env = load_env_file(&ctx.paths.r2_env())?;
            if env.is_empty() {
                return Err(BackupError::precondition("secrets\\r2.env is missing or empty"));
            }
            env
        }
    };
    Ok(Repo { location: d.location().to_string(), password: Password::File(ctx.paths.machine_key()), extra_env })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{DestKind, Destination};
    use crate::backup::util::fake::{test_ctx, FakeExec};
    use crate::envelope::Code;

    fn ctx_in(d: &std::path::Path) -> BackupCtx {
        let mut c = test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.join("d"), d.join("p")));
        c
    }

    #[test]
    fn env_files_skip_comments_and_blanks_and_trim_quotes() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r2.env");
        std::fs::write(&p, "# c\n\nAWS_A = \"v1\"\nAWS_B=v=2\nnoequals\n").unwrap();
        assert_eq!(load_env_file(&p).unwrap(), vec![("AWS_A".into(), "v1".into()), ("AWS_B".into(), "v=2".into())]);
        assert!(load_env_file(&d.path().join("none")).unwrap().is_empty());
    }

    #[test]
    fn the_local_repository_is_created_once_with_a_machine_key() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        std::fs::create_dir_all(c.paths.secrets()).unwrap();
        let exec = FakeExec::default();
        let r = ensure_local_repo(&c, &exec, false).unwrap();
        assert_eq!(exec.count_of(" init"), 1);
        assert!(c.paths.machine_key().exists());
        assert!(matches!(r.password, Password::File(_)));
        // once the repository exists, a missing key is refused instead of regenerated
        std::fs::write(c.paths.repo().join("config"), b"x").unwrap();
        std::fs::remove_file(c.paths.machine_key()).unwrap();
        assert_eq!(ensure_local_repo(&c, &exec, false).unwrap_err().code, Code::Precondition);
        assert!(!c.paths.machine_key().exists());
    }

    #[test]
    fn configured_destinations_count_as_an_existing_repository_for_the_machine_key_rule() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        std::fs::create_dir_all(c.paths.secrets()).unwrap();
        let exec = FakeExec::default();
        // no local repo, key lost, but a destination already holds data encrypted with that key
        let e = ensure_local_repo(&c, &exec, true).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(!c.paths.machine_key().exists(), "no new key may be invented");
        assert_eq!(exec.count_of(" init"), 0);
        assert!(ensure_local_repo(&c, &exec, false).is_ok(), "a first-time setup still works");
    }

    #[test]
    fn a_pasted_secret_line_is_never_echoed_in_the_error() {
        use base64::Engine;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r2.env");
        // a bare base64 secret pasted without a variable name; padding puts the first `=` near the end of the line
        let random = crate::util::random_bytes(29).unwrap();
        let fixed = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl==".to_string();
        let generated = format!("{}=", base64::engine::general_purpose::STANDARD.encode(&random[..28]));
        for secret in [fixed, generated] {
            std::fs::write(&p, format!("AWS_ACCESS_KEY_ID=k\n{secret}\n")).unwrap();
            let e = load_env_file(&p).unwrap_err();
            assert_eq!(e.code, Code::Precondition);
            assert!(e.message.contains("line 2"), "{}", e.message);
            assert!(!e.message.contains(&secret[..8]), "the error must not echo any part of the line: {}", e.message);
        }
        // a real-looking variable name is still named, so the owner can fix it
        std::fs::write(&p, "RESTIC_PASSWORD_FILE=C:\\x\n").unwrap();
        assert!(load_env_file(&p).unwrap_err().message.contains("RESTIC_PASSWORD_FILE"));
    }

    #[test]
    fn an_r2_env_file_can_only_carry_aws_variables() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r2.env");
        for bad in ["RESTIC_PASSWORD_FILE=C:\\x\\key.txt", "PATH=C:\\evil", "TEMP=C:\\evil", "TMP=x", "RESTIC_CACHE_DIR=x", "aws_lower=1", "AWS KEY=1"] {
            std::fs::write(&p, format!("AWS_ACCESS_KEY_ID=k\n{bad}\n")).unwrap();
            let e = load_env_file(&p).unwrap_err();
            assert_eq!(e.code, Code::Precondition, "{bad}");
            assert!(!e.message.contains("evil"), "values must never be echoed: {}", e.message);
        }
        std::fs::write(&p, "AWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\nAWS_DEFAULT_REGION=auto\n").unwrap();
        assert_eq!(load_env_file(&p).unwrap().len(), 3);
    }

    #[test]
    fn r2_needs_its_env_file_and_passes_it_to_the_child_only() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx_in(d.path());
        std::fs::create_dir_all(c.paths.secrets()).unwrap();
        let dest = Destination { name: "cloud".into(), kind: DestKind::R2, path: None, repo: Some("s3:https://h/b/f".into()), volume_serial: None, added_at: 0, extra: Default::default() };
        assert_eq!(dest_repo(&c, &dest).unwrap_err().code, Code::Precondition);
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k\n").unwrap();
        let r = dest_repo(&c, &dest).unwrap();
        assert_eq!(r.location, "s3:https://h/b/f");
        assert_eq!(r.extra_env.len(), 1);
    }
}
