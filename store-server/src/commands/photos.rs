//! `posctl photos ...`: the thin adapter between the command line and `photos`. Order of refusals: a missing flag or a bad
//! name (USAGE 2), not elevated (3), not provisioned (4), then the credentials from stdin (USAGE 2), then the work. Exits: 0 OK,
//! 60 PHOTOS_INCONSISTENT (`verify`), 61 PHOTOS_IMPORT_FAILED (`import-from-cloud`), 1 anything else.
//! The hosted project's key is read from stdin only; there is no flag, argument or environment variable that carries it.
use std::io::Read;

use clap::{Args, Subcommand};

use crate::envelope::{Code, Outcome, PosctlError};
use crate::paths::Roots;
use crate::photos::{self, ImportArgs, DEFAULT_BUCKETS, DEFAULT_DATABASE};

#[derive(Subcommand, Debug)]
pub enum PhotosTop {
    /// Product photos kept on this PC: check them against the database, or import them from the hosted project.
    Photos(PhotosArgs),
}

#[derive(Args, Debug, Clone)]
pub struct PhotosArgs {
    #[command(subcommand)]
    pub sub: PhotosSub,
}

#[derive(Subcommand, Debug, Clone)]
pub enum PhotosSub {
    /// Every photo row has its file with the recorded size (exit 60 otherwise). Files without a row are only reported.
    Verify {
        #[arg(long, default_value = DEFAULT_DATABASE)]
        database: String,
        /// Comma-separated bucket ids to judge; the same default as `import-from-cloud`. Rows and files of other buckets are ignored.
        #[arg(long, value_delimiter = ',', default_value = DEFAULT_BUCKETS)]
        buckets: Vec<String>,
    },
    /// Copy the photo files of the hosted project into this PC. The project's address and key come on stdin as JSON.
    ImportFromCloud {
        /// Required: read `{"v":1,"projectUrl":...,"serviceRoleKey":...}` from stdin (a key is never an argument).
        #[arg(long)]
        source_credentials_stdin: bool,
        #[arg(long, default_value = DEFAULT_DATABASE)]
        database: String,
        /// Comma-separated bucket ids.
        #[arg(long, value_delimiter = ',', default_value = DEFAULT_BUCKETS)]
        buckets: Vec<String>,
        /// List what would be downloaded; write nothing.
        #[arg(long)]
        dry_run: bool,
    },
}

pub fn run_cli(roots: &Roots, a: &PhotosArgs, stdin: &mut dyn Read) -> Result<Outcome, PosctlError> {
    let elevated = crate::sys::is_elevated(); // asked once
    run_cli_as(roots, a, stdin, elevated)
}

/// `run_cli` with the elevation answer given.
fn run_cli_as(roots: &Roots, a: &PhotosArgs, stdin: &mut dyn Read, elevated: bool) -> Result<Outcome, PosctlError> {
    match &a.sub {
        PhotosSub::Verify { database, buckets } => {
            photos::check_database(database)?;
            photos::check_buckets(buckets)?;
            crate::commands::update::gate(roots, elevated)?;
            Ok(photos::verify::run(roots, database, buckets))
        }
        PhotosSub::ImportFromCloud { source_credentials_stdin, database, buckets, dry_run } => {
            if !source_credentials_stdin {
                return Err(PosctlError::new(Code::Usage, "import-from-cloud reads the project address and key from stdin: pass --source-credentials-stdin (a key is never an argument)"));
            }
            photos::check_database(database)?;
            photos::check_buckets(buckets)?;
            crate::commands::update::gate(roots, elevated)?;
            let creds = photos::creds::read_credentials(stdin)?;
            Ok(photos::run_import_with(roots, &ImportArgs { database: database.clone(), buckets: buckets.clone(), dry_run: *dry_run }, creds))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::run_cli_with;
    use serde_json::Value;
    use std::ffi::OsString;

    const KEY: &str = "sb-test-key-0123456789";

    fn run(d: &tempfile::TempDir, rest: &[&str], stdin: &str) -> (i32, String, Value) {
        let mut args: Vec<String> = ["posctl", "--dev", "--data-root"].iter().map(|s| s.to_string()).collect();
        args.push(d.path().join("data").display().to_string());
        args.push("--program-root".into());
        args.push(d.path().join("prog").display().to_string());
        args.extend(rest.iter().map(|s| s.to_string()));
        let mut out = Vec::new();
        let code = run_cli_with(args.into_iter().map(OsString::from).collect(), &mut stdin.as_bytes(), &mut out, false);
        let out = String::from_utf8(out).unwrap();
        let v = serde_json::from_str(out.lines().next().unwrap_or("null")).unwrap_or(Value::Null);
        (code, out, v)
    }

    fn provisioned(d: &tempfile::TempDir) {
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.provisioned_json().parent().unwrap()).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
    }

    fn body(url: &str, v: u32) -> String {
        format!("{{\"v\":{v},\"projectUrl\":\"{url}\",\"serviceRoleKey\":\"{KEY}\"}}")
    }

    #[test]
    fn the_flags_parse_with_their_defaults() {
        use clap::Parser;
        #[derive(Parser)]
        struct W {
            #[command(flatten)]
            a: PhotosArgs,
        }
        let PhotosSub::ImportFromCloud { source_credentials_stdin, database, buckets, dry_run } = W::try_parse_from(["posctl", "import-from-cloud", "--source-credentials-stdin"]).unwrap().a.sub else { panic!() };
        assert_eq!((source_credentials_stdin, database.as_str(), buckets, dry_run), (true, "postgres", vec!["product-photos".to_string(), "store-branding".to_string()], false));
        let PhotosSub::ImportFromCloud { buckets, dry_run, database, .. } =
            W::try_parse_from(["posctl", "import-from-cloud", "--source-credentials-stdin", "--buckets", "a,b", "--dry-run", "--database", "pos_next"]).unwrap().a.sub
        else {
            panic!()
        };
        assert_eq!((buckets, dry_run, database.as_str()), (vec!["a".to_string(), "b".to_string()], true, "pos_next"));
        // there is no flag that carries a key or an address
        for bad in ["--service-role-key", "--project-url", "--key"] {
            assert!(W::try_parse_from(["posctl", "import-from-cloud", "--source-credentials-stdin", bad, "x"]).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_standard_user_gets_3_before_4_and_before_the_credentials_are_read() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        let a = PhotosArgs { sub: PhotosSub::ImportFromCloud { source_credentials_stdin: true, database: "postgres".into(), buckets: vec!["product-photos".into()], dry_run: false } };
        let mut stdin = std::io::Cursor::new(b"{not read".to_vec());
        let e = run_cli_as(&roots, &a, &mut stdin, false).unwrap_err();
        assert_eq!(e.code.exit(), 3);
        assert_eq!(stdin.position(), 0, "stdin is not touched before the gate");
        let v = PhotosArgs { sub: PhotosSub::Verify { database: "postgres".into(), buckets: photos::default_buckets() } };
        assert_eq!(run_cli_as(&roots, &v, &mut std::io::empty(), false).unwrap_err().code.exit(), 3);
        // an administrator on a PC that is not provisioned
        assert_eq!(run_cli_as(&roots, &v, &mut std::io::empty(), true).unwrap_err().code.exit(), 4);
    }

    #[test]
    fn bad_stdin_is_usage_after_the_gate_and_never_echoes_the_key() {
        let d = tempfile::tempdir().unwrap();
        provisioned(&d);
        for input in [body("https://abc.supabase.co", 2), body("http://example.com", 1), body("https://u:p@abc.supabase.co", 1), "not json".to_string(), String::new()] {
            let (code, out, v) = run(&d, &["photos", "import-from-cloud", "--source-credentials-stdin"], &input);
            assert_eq!((code, v["code"].as_str()), (2, Some("USAGE")), "{input}: {out}");
            assert!(!out.contains(KEY), "{out}");
        }
    }

    #[test]
    fn photos_verify_on_an_unprovisioned_pc_is_exit_4_and_a_bad_database_is_usage() {
        let d = tempfile::tempdir().unwrap();
        let (code, _, v) = run(&d, &["photos", "verify"], "");
        assert_eq!((code, v["code"].as_str(), v["command"].as_str()), (4, Some("NOT_PROVISIONED"), Some("photos")));
        let (code, _, v) = run(&d, &["photos", "verify", "--database", "bad;name"], "");
        assert_eq!((code, v["code"].as_str()), (2, Some("USAGE")));
    }
}
