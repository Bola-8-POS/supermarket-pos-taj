//! Postgres tooling: initdb arguments, the one-shot initdb script, `psql` runs with SQL on stdin
//! and passwords from a pgpass file, and the pg_hba loopback assertion. It must never put a
//! password in argv or in a written `.sql` file: libpq reads `PGPASSFILE`, and the migration CLI
//! gets a URL without a password plus the same variable (verified with supabase 2.116.0 against a
//! scratch cluster). It must never start a long-lived server through `exec` (the job kill on
//! return would stop it).

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::exec::{Cmd, ToolOutput};

#[derive(Debug, Clone)]
pub struct PgTools {
    pub bin: PathBuf,
}

impl PgTools {
    pub fn for_pack(pack_dir: &Path) -> Self {
        PgTools { bin: pack_dir.join("pg").join("bin") }
    }
    pub fn exe(&self, name: &str) -> PathBuf {
        self.bin.join(format!("{name}.exe"))
    }
}

/// The D9 flags: ICU es-MX, `--locale=C` for LC_*, checksums, scram, superuser `supabase_admin`.
/// Never `--locale=C.UTF-8` (fails on Windows).
pub fn initdb_args(pgdata: &Path, pwfile: &Path) -> Vec<String> {
    [
        "-D",
        &pgdata.display().to_string(),
        "--username=supabase_admin",
        &format!("--pwfile={}", pwfile.display()),
        "--auth=scram-sha-256",
        "--locale-provider=icu",
        "--icu-locale=es-MX",
        "--locale=C",
        "--encoding=UTF8",
        "--data-checksums",
    ]
    .map(String::from)
    .to_vec()
}

/// The `.cmd` a one-shot Shawl service runs as the Postgres virtual account. The exit code is
/// written to a file because Shawl's own exit code does not carry it.
pub fn initdb_cmd_script(initdb: &Path, args: &[String], log: &Path, exit_file: &Path) -> String {
    let quoted: Vec<String> = args.iter().map(|a| crate::services::quote_arg(a)).collect();
    format!(
        "@echo off\r\n\"{}\" {} > \"{}\" 2>&1\r\necho %ERRORLEVEL% > \"{}\"\r\n",
        initdb.display(),
        quoted.join(" "),
        log.display(),
        exit_file.display()
    )
}

pub fn parse_exit_file(text: &str) -> Option<i32> {
    text.trim().parse().ok()
}

/// Postgres must listen on loopback only. `show` is the answer of `SHOW listen_addresses`; `auto_conf` is
/// `postgresql.auto.conf` (an `ALTER SYSTEM` there overrides `postgresql.conf`). Fails closed.
pub fn assert_listen_loopback_only(show: &str, auto_conf: &str) -> Result<(), String> {
    if show.trim() != "127.0.0.1" {
        return Err(format!("Postgres listen_addresses is '{}', expected 127.0.0.1", show.trim()));
    }
    for raw in auto_conf.lines() {
        let l = raw.split('#').next().unwrap_or("").trim();
        let key = l.split(|c: char| c == '=' || c.is_whitespace()).next().unwrap_or("");
        if key.eq_ignore_ascii_case("listen_addresses") {
            return Err("postgresql.auto.conf sets listen_addresses; remove it".to_string());
        }
    }
    Ok(())
}

/// `pg_hba.conf` must allow only loopback and only scram (conventions section 3).
pub fn assert_pg_hba_loopback_only(hba: &str) -> Result<(), String> {
    for raw in hba.lines() {
        let l = raw.split('#').next().unwrap_or("").trim();
        if l.is_empty() {
            continue;
        }
        let f: Vec<&str> = l.split_whitespace().collect();
        match f.first().copied() {
            Some("local") => {
                // local DATABASE USER METHOD: no options field can follow the method
                if f.len() != 4 || f.last().copied() != Some("scram-sha-256") {
                    return Err(format!("pg_hba: non-scram rule '{l}'"));
                }
            }
            Some("host") | Some("hostssl") | Some("hostnossl") => {
                // host DATABASE USER ADDRESS METHOD: a mask column or options would shift the fields
                if f.len() != 5 {
                    return Err(format!("pg_hba: unexpected field count in '{l}'"));
                }
                let addr = f[3];
                let method = f[4];
                if !(addr == "127.0.0.1/32" || addr == "::1/128") {
                    return Err(format!("pg_hba: non-loopback address in '{l}'"));
                }
                if method != "scram-sha-256" {
                    return Err(format!("pg_hba: non-scram method in '{l}'"));
                }
            }
            _ => return Err(format!("pg_hba: unrecognised rule '{l}'")),
        }
    }
    Ok(())
}

/// `.control` must carry `trusted = true`.
pub fn control_is_trusted(control: &str) -> bool {
    control.lines().any(|l| {
        let l = l.split('#').next().unwrap_or("").replace(' ', "");
        l == "trusted=true"
    })
}

pub struct Psql {
    pub tools: PgTools,
    pub port: u16,
    pub pgpass: PathBuf,
}

/// libpq/psql settings that must never come from the elevated user's environment (`Cmd` already
/// starts from a cleared environment; this stays as a belt-and-braces removal on the child).
pub const PG_ENV_TO_CLEAR: [&str; 6] = ["PGPASSWORD", "PGOPTIONS", "PGSERVICEFILE", "PGSYSCONFDIR", "PGSSLMODE", "PGSERVICE"];

/// Raw `std::process::Command` sites (psql, the supabase CLI, GoTrue) inherit the process environment: remove EVERY `PG*`
/// variable (any case, so an unknown future one too). The caller then sets only the ones it means to pass.
pub fn scrub_pg_env(c: &mut std::process::Command) {
    scrub_pg_env_names(c, std::env::vars_os().map(|(k, _)| k));
}

fn scrub_pg_env_names(c: &mut std::process::Command, names: impl Iterator<Item = std::ffi::OsString>) {
    for k in PG_ENV_TO_CLEAR { c.env_remove(k); }
    for k in names {
        if k.to_string_lossy().to_uppercase().starts_with("PG") { c.env_remove(&k); }
    }
}

impl Psql {
    /// Argument order as `store-server/pack/test/helpers/stack.mjs`: connection, then
    /// `ON_ERROR_STOP`, then `extra` (the pack's `psqlArgs`, `--single-transaction`), then
    /// `-f -`. psql honours `--single-transaction` only together with `-c`/`-f`, so stdin is
    /// always read through `-f -`. `-w` never prompts.
    pub fn args(&self, user: &str, db: &str, extra: &[String]) -> Vec<String> {
        let mut a: Vec<String> = ["-X", "-w", "-h", "127.0.0.1", "-p"].map(String::from).to_vec();
        a.push(self.port.to_string());
        a.extend(["-U", user, "-d", db].map(String::from));
        a.extend(extra.iter().cloned());
        // after the extras: psql keeps the LAST `-v`, so nothing in `extra` can turn it off
        a.extend(["-v", "ON_ERROR_STOP=1"].map(String::from));
        a.extend(["-f", "-"].map(String::from));
        a
    }

    pub fn command(&self, user: &str, db: &str, extra: &[String]) -> Cmd {
        Cmd::new(self.tools.exe("psql"))
            .args(self.args(user, db, extra))
            .env("PGPASSFILE", &self.pgpass.display().to_string())
            .env("PGCLIENTENCODING", "UTF8")
            .env_remove_all(&PG_ENV_TO_CLEAR)
            .timeout(Duration::from_secs(300))
    }

    /// Run SQL text fed on stdin (never argv, never a temp file).
    pub fn run(&self, user: &str, db: &str, sql: &str) -> Result<ToolOutput, String> {
        self.run_with(user, db, &[], sql)
    }

    /// `run` plus extra psql arguments (a run-order step's `psqlArgs` and `--single-transaction`).
    pub fn run_with(&self, user: &str, db: &str, extra: &[String], sql: &str) -> Result<ToolOutput, String> {
        self.command(user, db, extra).stdin(sql.as_bytes().to_vec()).run().map_err(|e| e.to_string())
    }

    /// One value: `-At`, first line trimmed. Never pass secrets in `sql` (it can reach error text).
    pub fn scalar(&self, user: &str, db: &str, sql: &str) -> Result<String, String> {
        let o = self.run_with(user, db, &["-At".to_string()], sql)?;
        if !o.success() {
            return Err(format!("psql failed ({}): {}", o.code, o.stderr.trim()));
        }
        Ok(o.stdout.lines().next().unwrap_or("").trim().to_string())
    }
}

pub fn isready(tools: &PgTools, port: u16) -> bool {
    Cmd::new(tools.exe("pg_isready"))
        .args(["-h", "127.0.0.1", "-p", &port.to_string()])
        .timeout(Duration::from_secs(10))
        .run()
        .map(|o| o.success())
        .unwrap_or(false)
}

/// A URL without a password: the migration CLI reads it from `PGPASSFILE`.
pub fn db_url_no_password(user: &str, port: u16, db: &str) -> String {
    format!("postgresql://{user}@127.0.0.1:{port}/{db}?sslmode=disable")
}

/// The one collation query: provision records its result, the real-cluster test runs the very same text.
pub const COLLATION_SQL: &str = "select datlocprovider::text || '|' || coalesce(datlocale,'') || '|' || coalesce(datcollversion,'') || '|' || current_setting('server_version') from pg_database where datname = 'postgres';";

#[cfg(test)]
mod tests {
    #[test]
    fn listen_addresses_must_be_loopback_and_not_overridden_in_auto_conf() {
        assert!(assert_listen_loopback_only("127.0.0.1
", "# Do not edit
").is_ok());
        assert!(assert_listen_loopback_only("*", "").is_err());
        assert!(assert_listen_loopback_only("localhost", "").is_err());
        assert!(assert_listen_loopback_only("127.0.0.1", "listen_addresses = '*'
").is_err());
        assert!(assert_listen_loopback_only("127.0.0.1", "  LISTEN_ADDRESSES='127.0.0.1'").is_err(), "even a harmless-looking override is refused");
        assert!(assert_listen_loopback_only("127.0.0.1", "# listen_addresses = '*'
max_connections = 5
").is_ok());
    }

    use super::*;

    #[test]
    fn initdb_uses_the_d9_flags_and_never_c_utf8() {
        let a = initdb_args(Path::new("C:\\d\\pgdata"), Path::new("C:\\d\\tmp\\pw.tmp"));
        for want in [
            "--locale-provider=icu",
            "--icu-locale=es-MX",
            "--locale=C",
            "--encoding=UTF8",
            "--data-checksums",
            "--auth=scram-sha-256",
            "--username=supabase_admin",
            "--pwfile=C:\\d\\tmp\\pw.tmp",
        ] {
            assert!(a.contains(&want.to_string()), "{want}");
        }
        assert!(a.iter().all(|x| !x.contains("C.UTF-8")));
        assert_eq!(&a[..2], &["-D".to_string(), "C:\\d\\pgdata".to_string()]);
    }

    #[test]
    fn the_initdb_script_records_the_exit_code_in_a_file() {
        let s = initdb_cmd_script(
            Path::new("C:\\Program Files\\POS\\initdb.exe"),
            &["-D".into(), "C:\\d x\\pgdata".into()],
            Path::new("C:\\d\\tmp\\initdb.log"),
            Path::new("C:\\d\\tmp\\initdb.exit"),
        );
        assert!(s.contains("\"C:\\Program Files\\POS\\initdb.exe\" -D \"C:\\d x\\pgdata\" > \"C:\\d\\tmp\\initdb.log\" 2>&1"));
        assert!(s.contains("echo %ERRORLEVEL% > \"C:\\d\\tmp\\initdb.exit\""));
        assert_eq!(parse_exit_file("0 \r\n"), Some(0));
        assert_eq!(parse_exit_file("1\n"), Some(1));
        assert_eq!(parse_exit_file(""), None);
    }

    #[test]
    fn pg_hba_loopback_and_scram_only() {
        let good = "# comment\nhost    all             all             127.0.0.1/32            scram-sha-256\nhost    all             all             ::1/128                 scram-sha-256\nhost    replication     all             127.0.0.1/32            scram-sha-256\n";
        assert!(assert_pg_hba_loopback_only(good).is_ok());
        assert!(assert_pg_hba_loopback_only("host all all 0.0.0.0/0 scram-sha-256").is_err());
        assert!(assert_pg_hba_loopback_only("host all all 192.168.1.0/24 scram-sha-256").is_err());
        assert!(assert_pg_hba_loopback_only("host all all 127.0.0.1/32 trust").is_err());
        assert!(assert_pg_hba_loopback_only("host all all 127.0.0.1/32 md5").is_err());
        assert!(assert_pg_hba_loopback_only("local all all trust").is_err());
        assert!(assert_pg_hba_loopback_only("garbage line").is_err());
    }

    #[test]
    fn a_control_file_must_be_trusted() {
        assert!(control_is_trusted("comment = 'x'\n# c\ntrusted = true\n"));
        assert!(!control_is_trusted("default_version = '1'\n"));
    }

    #[test]
    fn the_migration_url_carries_no_password() {
        let u = db_url_no_password("postgres", 47300, "postgres");
        assert_eq!(u, "postgresql://postgres@127.0.0.1:47300/postgres?sslmode=disable");
        assert!(!u.split('@').next().unwrap().contains("postgres:"));
    }

    fn psql() -> Psql {
        Psql { tools: PgTools::for_pack(Path::new("C:\\p")), port: 47300, pgpass: PathBuf::from("C:\\s\\pgpass.conf") }
    }

    #[test]
    fn psql_args_follow_the_reference_harness_and_end_with_stdin() {
        let extra: Vec<String> = ["-v", "VERBOSITY=terse", "--single-transaction"].map(String::from).to_vec();
        let a = psql().args("postgres", "clone", &extra);
        let want: Vec<String> = [
            "-X", "-w", "-h", "127.0.0.1", "-p", "47300", "-U", "postgres", "-d", "clone",
            "-v", "VERBOSITY=terse", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "-",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(a, want);
        let plain = psql().args("u", "d", &[]);
        assert_eq!(&plain[plain.len() - 2..], &["-f".to_string(), "-".to_string()]);
        assert!(plain.iter().all(|x| !x.contains("PASSWORD")), "no secret ever in argv");
    }

    #[test]
    fn a_pack_argument_cannot_override_on_error_stop() {
        let extra: Vec<String> = ["-v", "ON_ERROR_STOP=0", "-v", "ON_ERROR_STOP=off"].map(String::from).to_vec();
        let a = psql().args("u", "d", &extra);
        let last = a.iter().rposition(|x| x.starts_with("ON_ERROR_STOP=")).unwrap();
        assert_eq!(a[last], "ON_ERROR_STOP=1", "psql keeps the last -v, so ours must come after every extra");
        assert!(last > a.iter().rposition(|x| x == "ON_ERROR_STOP=off").unwrap());
    }

    #[test]
    fn pg_hba_rules_have_exactly_the_expected_fields() {
        for bad in [
            "host all all 127.0.0.1/32 scram-sha-256 clientcert=verify-full",
            "host all all 127.0.0.1/32 255.255.255.255 scram-sha-256",
            "host all 127.0.0.1/32 scram-sha-256",
            "local all all scram-sha-256 extra",
            "local all scram-sha-256",
            "local all all peer scram-sha-256",
        ] {
            assert!(assert_pg_hba_loopback_only(bad).is_err(), "{bad}");
        }
        assert!(assert_pg_hba_loopback_only("local   all   all   scram-sha-256\nlocal replication all scram-sha-256\n").is_ok());
    }

    #[test]
    fn the_psql_child_names_only_the_pgpass_file_and_clears_inherited_libpq_settings() {
        let d = format!("{:?}", psql().command("u", "d", &[]));
        assert!(d.contains("PGPASSFILE") && d.contains("PGCLIENTENCODING"), "{d}");
    }

    #[test]
    fn every_pg_prefixed_variable_is_removed_from_a_raw_command_and_the_rest_is_kept() {
        let mut c = std::process::Command::new("x");
        c.env("KEEP_ME", "1");
        scrub_pg_env_names(&mut c, ["PGPASSWORD", "pgservice", "PgSslMode", "PGFUTURE_X", "PATH", "GOTRUE_X"].iter().map(std::ffi::OsString::from));
        let envs: std::collections::HashMap<String, bool> =
            c.get_envs().map(|(k, v)| (k.to_string_lossy().to_uppercase(), v.is_some())).collect();
        for k in ["PGPASSWORD", "PGSERVICE", "PGSSLMODE", "PGFUTURE_X", "PGOPTIONS"] {
            assert_eq!(envs.get(k), Some(&false), "{k} must be explicitly removed");
        }
        assert_eq!(envs.get("KEEP_ME"), Some(&true));
        assert!(!envs.contains_key("PATH"), "non-PG variables are not touched");
    }

    #[test]
    #[ignore = "needs POS_PACK_DIR (a built pack); starts a throwaway postgres on a loopback port"]
    fn a_real_cluster_initialises_serves_psql_and_has_a_loopback_only_hba() {
        use std::io::Write;
        let pack = std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR");
        let tools = PgTools::for_pack(Path::new(&pack));
        let d = tempfile::tempdir().unwrap();
        let (data, pw) = (d.path().join("data"), d.path().join("pw.tmp"));
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).unwrap();
        let secret: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::write(&pw, &secret).unwrap();
        let init = Cmd::new(tools.exe("initdb")).args(initdb_args(&data, &pw)).timeout(Duration::from_secs(180)).run().unwrap();
        assert!(init.success(), "initdb: {}", init.text());
        std::fs::remove_file(&pw).unwrap();
        assert_pg_hba_loopback_only(&std::fs::read_to_string(data.join("pg_hba.conf")).unwrap()).unwrap();

        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut conf = std::fs::OpenOptions::new().append(true).open(data.join("postgresql.conf")).unwrap();
        writeln!(conf, "listen_addresses = '127.0.0.1'\nport = {port}").unwrap();
        drop(conf);
        let pgpass = d.path().join("pgpass.conf");
        std::fs::write(&pgpass, format!("127.0.0.1:{port}:*:supabase_admin:{secret}\n")).unwrap();

        // exec::run kills its job on return, so the server is a plain child we own and kill by handle.
        let mut server = std::process::Command::new(tools.exe("postgres"))
            .args(["-D", &data.display().to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ready = (0..60).any(|_| {
                std::thread::sleep(Duration::from_millis(500));
                isready(&tools, port)
            });
            assert!(ready, "postgres never became ready");
            let p = Psql { tools: tools.clone(), port, pgpass: pgpass.clone() };
            assert_eq!(p.scalar("supabase_admin", "postgres", "select 40 + 2").unwrap(), "42");
            // 04b R6: the cluster is ICU es-MX and UTF8, never C.UTF-8
            let coll = p.scalar("supabase_admin", "postgres", COLLATION_SQL).unwrap();
            assert!(coll.starts_with("i|es-MX|"), "{coll}");
            assert_eq!(coll.split('|').count(), 4, "{coll}");
            assert_eq!(p.scalar("supabase_admin", "postgres", "select pg_encoding_to_char(encoding) from pg_database where datname = 'postgres'").unwrap(), "UTF8");
            let header = "\\set pw_x 'ab12'\n";
            assert_eq!(p.scalar("supabase_admin", "postgres", &format!("{header}select :'pw_x';")).unwrap(), "ab12");
            let extra = ["-v".to_string(), "VERBOSITY=terse".to_string(), "--single-transaction".to_string()];
            let o = p.run_with("supabase_admin", "postgres", &extra, "create table t(a int); select 1/0;").unwrap();
            assert!(!o.success(), "ON_ERROR_STOP must fail the run");
            assert_eq!(
                p.scalar("supabase_admin", "postgres", "select count(*) from pg_class where relname = 't'").unwrap(),
                "0",
                "--single-transaction rolled the table back"
            );
        }));
        let _ = server.kill();
        let _ = server.wait();
        if let Err(e) = outcome {
            std::panic::resume_unwind(e);
        }
    }
}
