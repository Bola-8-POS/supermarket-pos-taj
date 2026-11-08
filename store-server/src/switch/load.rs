//! The pieces of the data move that need no database of their own: the pg_dump / pg_restore argument lists, the check of what a
//! dump holds, and the SQL that repairs GoTrue's token columns afterwards.
//! Passwords never reach an argument or the environment: the cloud's goes through the `pgpass` file of `cloud::write_pgpass`.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::switch::tables::valid_table;
use std::collections::BTreeSet;
use std::path::Path;

/// The one list of the seven GoTrue token columns (`backup/rederive.rs`); the verify step and the repair below read it from here.
pub(crate) use crate::backup::rederive::TOKEN_COLUMNS;

fn unsafe_name(what: &str) -> OpError {
    OpError::new(
        OpCode::Precondition,
        "TABLE_NAME_UNSAFE",
        format!("{what} is outside lower-case letters, digits and underscore"),
    )
}

/// `pg_dump` of the copy tables, data only, one custom-format file. The connection comes from the `PG*` variables of
/// `cloud::libpq_env`, never from an argument. Tables are `schema.table` and checked; `-w` never prompts.
pub fn dump_args(file: &str, tables: &[String]) -> R<Vec<String>> {
    if tables.iter().any(|t| !valid_table(t)) {
        return Err(unsafe_name("a table name"));
    }
    let mut a: Vec<String> = [
        "-w",
        "--format=custom",
        "--data-only",
        "--no-owner",
        "--no-privileges",
        "--strict-names",
        "--file",
    ]
    .map(String::from)
    .to_vec();
    a.push(file.to_string());
    for t in tables {
        a.push("--table".into());
        a.push(t.clone());
    }
    Ok(a)
}

/// `pg_restore --list`: the table of contents of a dump file.
pub fn list_args(file: &str) -> Vec<String> {
    vec!["--list".into(), file.into()]
}

/// `pg_restore` into the local server, one transaction, stop at the first error. `--disable-triggers` is what lets a data-only
/// restore load tables that reference each other (the local role is a superuser).
pub fn restore_args(file: &str, port: u16, db: &str) -> R<Vec<String>> {
    if db.is_empty() || !db.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(unsafe_name("the database name"));
    }
    let mut a: Vec<String> = [
        "-w",
        "--data-only",
        "--no-owner",
        "--no-privileges",
        "--disable-triggers",
        "--exit-on-error",
        "--single-transaction",
        "-h",
        "127.0.0.1",
        "-p",
    ]
    .map(String::from)
    .to_vec();
    a.extend([
        port.to_string(),
        "-U".into(),
        "supabase_admin".into(),
        "-d".into(),
        db.into(),
        file.into(),
    ]);
    Ok(a)
}

/// Runs a pg tool with a cleared environment (`exec::Cmd` starts from system locations only, so an inherited `PGPASSWORD`,
/// `PGSERVICE` or `PGHOST` cannot outrank the pgpass file) plus exactly the variables in `env`.
pub fn pg_cmd(exe: &Path, args: Vec<String>, env: &[(String, String)]) -> crate::exec::Cmd {
    env.iter()
        .fold(crate::exec::Cmd::new(exe).args(args), |c, (k, v)| {
            c.env(k, v)
        })
}

/// What the dump's table of contents holds: the `TABLE DATA` entries must be exactly `expected` (`schema.table`).
/// An extra entry (a table that must stay local) or a missing one fails; sequence and other entries are ignored.
pub fn verify_restore_list(listing: &str, expected: &[String]) -> Result<(), String> {
    let mut have = BTreeSet::new();
    for l in listing.lines().filter(|l| !l.starts_with(';')) {
        if let Some((_, rest)) = l.split_once(" TABLE DATA ") {
            let mut w = rest.split_whitespace();
            if let (Some(s), Some(n)) = (w.next(), w.next()) {
                have.insert(format!("{s}.{n}"));
            }
        }
    }
    let want: BTreeSet<String> = expected.iter().cloned().collect();
    let extra: Vec<&String> = have.difference(&want).collect();
    let missing: Vec<&String> = want.difference(&have).collect();
    if extra.is_empty() && missing.is_empty() && !have.is_empty() {
        return Ok(());
    }
    Err(format!(
        "the dump does not hold the planned tables: unexpected {extra:?}, missing {missing:?}"
    ))
}

/// GoTrue crashes on a NULL in any of these columns; a cloud row can carry one, so the copy is repaired afterwards.
pub fn repair_tokens_sql() -> String {
    let set = TOKEN_COLUMNS
        .iter()
        .map(|c| format!("{c} = coalesce({c}, '')"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("UPDATE auth.users SET {set}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs() -> Vec<String> {
        vec!["public.categories".into(), "auth.users".into()]
    }

    #[test]
    fn dump_args_never_contain_a_password() {
        let a = dump_args("C:\\x\\cloud.dump", &tabs()).unwrap();
        assert!(a.contains(&"auth.users".to_string()) && a.iter().any(|x| x == "--data-only"));
        for x in &a {
            let l = x.to_lowercase();
            assert!(
                !l.contains("password") && !l.contains('@') && !l.contains("://"),
                "{x}"
            );
        }
        assert!(
            dump_args("f", &["public.x; drop table y".into()]).is_err(),
            "a table name outside the safe shape is refused"
        );
    }

    #[test]
    fn restore_args_name_the_local_server_and_the_file_only() {
        let a = restore_args("C:\\x\\cloud.dump", 47300, "postgres").unwrap();
        assert!(
            a.windows(2).any(|w| w == ["-p", "47300"])
                && a.windows(2).any(|w| w == ["-d", "postgres"])
        );
        assert!(
            a.iter().any(|x| x == "--exit-on-error") && a.iter().any(|x| x == "--disable-triggers")
        );
        assert_eq!(a.last().unwrap(), "C:\\x\\cloud.dump");
        assert!(restore_args("f", 1, "post gres").is_err());
        assert_eq!(list_args("f"), vec!["--list".to_string(), "f".to_string()]);
    }

    fn listing(rows: &[&str]) -> String {
        let mut s = String::from(";\n; Archive created at 2026-10-30\n;     dbname: cloud\n");
        for (i, r) in rows.iter().enumerate() {
            s.push_str(&format!(
                "{}; 0 {} TABLE DATA {} postgres\n",
                300 + i,
                16000 + i,
                r
            ));
        }
        s.push_str("3999; 0 0 SEQUENCE SET public some_seq_seq postgres\n");
        s
    }

    #[test]
    fn restore_list_verifier_rejects_extra_and_missing_entries() {
        let want = tabs();
        assert!(
            verify_restore_list(&listing(&["public categories", "auth users"]), &want).is_ok(),
            "exact set, sequence entries ignored"
        );
        let extra = verify_restore_list(
            &listing(&[
                "public categories",
                "auth users",
                "public store_switch_state",
            ]),
            &want,
        )
        .unwrap_err();
        assert!(
            extra.contains("public.store_switch_state") && extra.contains("unexpected"),
            "{extra}"
        );
        let missing = verify_restore_list(&listing(&["public categories"]), &want).unwrap_err();
        assert!(
            missing.contains("auth.users") && missing.contains("missing"),
            "{missing}"
        );
        assert!(
            verify_restore_list("", &want).is_err(),
            "an empty listing is a failure, not a pass"
        );
    }

    #[test]
    fn repair_names_all_seven_token_columns() {
        let s = repair_tokens_sql();
        for c in TOKEN_COLUMNS {
            assert!(s.contains(&format!("{c} = coalesce({c}, '')")), "{c}");
        }
        assert!(s.starts_with("UPDATE auth.users SET "));
    }

    /// Puts the process environment back even when an assertion panics.
    struct EnvGuard(Vec<&'static str>);
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for k in &self.0 {
                std::env::remove_var(k);
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn pg_tool_command_env_is_scrubbed() {
        let _g = EnvGuard(vec!["PGPASSWORD", "PGSERVICE", "PGHOST"]);
        std::env::set_var("PGPASSWORD", "leak-me");
        std::env::set_var("PGSERVICE", "leak-svc");
        std::env::set_var("PGHOST", "leak-host");
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let cmd = pg_cmd(
            std::path::Path::new(&format!(r"{sys}\System32\cmd.exe")),
            vec!["/c".into(), "set".into()],
            &[("PGPASSFILE".into(), r"C:\x\pgpass".into())],
        );
        let out = cmd.run().unwrap().stdout;
        assert!(out.contains(r"PGPASSFILE=C:\x\pgpass"), "{out}");
        for k in ["PGPASSWORD", "PGSERVICE", "PGHOST", "leak-"] {
            assert!(!out.contains(k), "{k} leaked into the child");
        }
    }

    #[test]
    fn token_columns_has_one_definition() {
        // the one test of this kind: the array of the seven GoTrue token columns is written in exactly one source file
        let needle = format!("[\"{}\", \"{}\"", "confirmation_token", "recovery_token");
        let mut hits = vec![];
        let mut todo = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(d) = todo.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    todo.push(p);
                } else if p.extension().is_some_and(|x| x == "rs")
                    && std::fs::read_to_string(&p)
                        .unwrap_or_default()
                        .contains(&needle)
                {
                    hits.push(p);
                }
            }
        }
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].ends_with("rederive.rs"));
    }
}
