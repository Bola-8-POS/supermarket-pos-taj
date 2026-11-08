//! `sql\run-order.json` in the pack is the ONLY authority for the database bootstrap order, the
//! role each file runs as and the secrets each file needs (conventions section 17). posctl does
//! not hard-code any of it: this module reads and validates the file, and `provision` executes
//! the steps (stack.mjs `applyRunOrder` is the reference interpreter). It must never accept a
//! field it does not model (a future one fails loudly), and secrets reach SQL only as psql
//! variables set by `\set` lines on psql's stdin, never on a command line and never in a
//! written `.sql` file.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::pack::safe_entry_path;
use crate::secrets::PG_ROLES;

/// When a step runs again: `Never` = first install only, `EveryUpdate` = idempotent, Plan 07
/// re-applies it after updates. (It says nothing about resuming an interrupted provision.)
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Rerun {
    #[default]
    Never,
    EveryUpdate,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Step {
    #[serde(rename = "copy-extension-stubs")]
    CopyExtensionStubs {
        id: String,
        files: Vec<String>,
        to: String,
        #[serde(default, rename = "singleTransaction")]
        single_transaction: bool,
        rerun: Rerun,
        #[serde(default)]
        always: bool,
    },
    #[serde(rename = "sql")]
    Sql {
        id: String,
        file: String,
        #[serde(rename = "runAs")]
        run_as: String,
        #[serde(default)]
        vars: Vec<String>,
        #[serde(default, rename = "singleTransaction")]
        single_transaction: bool,
        rerun: Rerun,
        #[serde(default)]
        always: bool,
    },
    #[serde(rename = "gotrue-migrate")]
    GotrueMigrate {
        id: String,
        #[serde(rename = "runAs")]
        run_as: String,
        #[serde(default, rename = "singleTransaction")]
        single_transaction: bool,
        rerun: Rerun,
        #[serde(default)]
        always: bool,
    },
    #[serde(rename = "db-push")]
    DbPush {
        id: String,
        #[serde(rename = "runAs")]
        run_as: String,
        #[serde(default, rename = "singleTransaction")]
        single_transaction: bool,
        rerun: Rerun,
        #[serde(default)]
        always: bool,
    },
    #[serde(rename = "remove-extension-stubs")]
    RemoveExtensionStubs {
        id: String,
        files: Vec<String>,
        from: String,
        #[serde(default, rename = "singleTransaction")]
        single_transaction: bool,
        rerun: Rerun,
        #[serde(default)]
        always: bool,
    },
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::CopyExtensionStubs { id, .. } | Step::Sql { id, .. } | Step::GotrueMigrate { id, .. } | Step::DbPush { id, .. } | Step::RemoveExtensionStubs { id, .. } => id,
        }
    }
    /// psql runs with `--single-transaction` (only meaningful for `sql` steps).
    pub fn single_transaction(&self) -> bool {
        match self {
            Step::CopyExtensionStubs { single_transaction, .. }
            | Step::Sql { single_transaction, .. }
            | Step::GotrueMigrate { single_transaction, .. }
            | Step::DbPush { single_transaction, .. }
            | Step::RemoveExtensionStubs { single_transaction, .. } => *single_transaction,
        }
    }
    pub fn rerun(&self) -> Rerun {
        match self {
            Step::CopyExtensionStubs { rerun, .. } | Step::Sql { rerun, .. } | Step::GotrueMigrate { rerun, .. } | Step::DbPush { rerun, .. } | Step::RemoveExtensionStubs { rerun, .. } => *rerun,
        }
    }
    /// Runs even after an earlier step failed (cleanup), once its paired copy step ran.
    pub fn always(&self) -> bool {
        match self {
            Step::CopyExtensionStubs { always, .. } | Step::Sql { always, .. } | Step::GotrueMigrate { always, .. } | Step::DbPush { always, .. } | Step::RemoveExtensionStubs { always, .. } => *always,
        }
    }
    /// After a crash an interrupted step may be retried: a `sql` file only when it is idempotent
    /// (`rerun: every-update`) and ran in one transaction; a `rerun: never` file (plain CREATE ROLE)
    /// that committed before the journal write cannot be retried, so resume refuses. The other kinds
    /// always (stub copy and removal, GoTrue's tracked migrations, and `db push`).
    pub fn rerunnable(&self) -> bool {
        !matches!(self, Step::Sql { .. }) || (self.single_transaction() && self.rerun() == Rerun::EveryUpdate)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunOrder {
    pub schema: u32,
    #[serde(default)]
    pub note: Option<String>,
    /// Extra arguments for every psql call (`-v NAME=value` pairs only; see `validate`).
    #[serde(default, rename = "psqlArgs")]
    pub psql_args: Vec<String>,
    #[serde(rename = "varRoles")]
    pub var_roles: BTreeMap<String, String>,
    pub steps: Vec<Step>,
}

pub fn parse(text: &str) -> Result<RunOrder, String> {
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("sql\\run-order.json is not valid: {e}"))
}

fn is_var_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '_')
}

/// The only `-v` assignments a pack may put on every psql call.
const PSQL_ARG_ALLOWED: [&str; 2] = ["VERBOSITY=terse", "SHOW_CONTEXT=never"];

/// Where the stub extension files live; copy and remove are pinned to it.
const STUB_DIR: &str = "pg/share/extension";

fn pinned_stub_dir(p: &str) -> Result<(), String> {
    if safe_entry_path(p)? == safe_entry_path(STUB_DIR)? {
        Ok(())
    } else {
        Err(format!("'{p}' is not {STUB_DIR}"))
    }
}

fn bare_name(f: &str) -> bool {
    !f.contains('/') && !f.contains('\\') && safe_entry_path(f).is_ok()
}

fn stub_ext_ok(f: &str) -> bool {
    f.ends_with(".control") || f.ends_with(".sql")
}

/// Structural checks that do not need the pack on disk.
pub fn validate(o: &RunOrder) -> Result<(), String> {
    if o.schema != 1 {
        return Err(format!("run-order schema {} is not supported", o.schema));
    }
    // psqlArgs go on every psql call: an exact allowlist of two cosmetic settings, so a pack file
    // cannot add `-c`, `-f`, a host, or override ON_ERROR_STOP / ECHO / AUTOCOMMIT.
    if !o.psql_args.len().is_multiple_of(2) {
        return Err("psqlArgs must be '-v NAME=value' pairs".into());
    }
    for pair in o.psql_args.chunks(2) {
        if pair[0] != "-v" || !PSQL_ARG_ALLOWED.contains(&pair[1].as_str()) {
            return Err(format!("psqlArgs entry '{} {}' is not on the allowlist ({})", pair[0], pair[1], PSQL_ARG_ALLOWED.join(", ")));
        }
    }
    for (var, role) in &o.var_roles {
        if !is_var_name(var) {
            return Err(format!("'{var}' is not a valid psql variable name"));
        }
        if !PG_ROLES.contains(&role.as_str()) {
            return Err(format!("variable {var} names an unknown role '{role}'"));
        }
    }
    let mut ids = HashSet::new();
    let (mut copies, mut removes, mut pushes) = (Vec::<Vec<String>>::new(), Vec::<Vec<String>>::new(), 0);
    for s in &o.steps {
        if !ids.insert(s.id().to_string()) {
            return Err(format!("step id '{}' appears twice", s.id()));
        }
        if s.always() && !matches!(s, Step::RemoveExtensionStubs { .. }) {
            return Err(format!("step {} is 'always' but only stub removal may run after a failure", s.id()));
        }
        match s {
            Step::Sql { file, run_as, vars, .. } => {
                safe_entry_path(file)?;
                if !PG_ROLES.contains(&run_as.as_str()) {
                    return Err(format!("step {} runs as unknown role '{run_as}'", s.id()));
                }
                if let Some(v) = vars.iter().find(|v| !o.var_roles.contains_key(*v)) {
                    return Err(format!("step {} needs variable '{v}', which varRoles does not define", s.id()));
                }
                // the header starts with `SET log_min_error_statement`, which only a superuser may set
                if !vars.is_empty() && run_as != "supabase_admin" {
                    return Err(format!("step {} sets variables, so it must run as supabase_admin", s.id()));
                }
            }
            Step::CopyExtensionStubs { files, to, .. } => {
                if let Some(f) = files.iter().find(|f| !stub_ext_ok(f)) {
                    return Err(format!("step {} copies '{f}': only .control and .sql stub files", s.id()));
                }
                files.iter().try_for_each(|p| safe_entry_path(p).map(|_| ()))?;
                pinned_stub_dir(to).map_err(|e| format!("step {} copies to the wrong place: {e}", s.id()))?;
                copies.push(files.iter().map(|f| f.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string()).collect());
            }
            Step::RemoveExtensionStubs { files, from, .. } => {
                if let Some(f) = files.iter().find(|f| !bare_name(f) || !stub_ext_ok(f)) {
                    return Err(format!("step {} removes '{f}': only bare .control and .sql names", s.id()));
                }
                pinned_stub_dir(from).map_err(|e| format!("step {} removes from the wrong place: {e}", s.id()))?;
                removes.push(files.clone());
            }
            Step::DbPush { run_as, .. } | Step::GotrueMigrate { run_as, .. } => {
                if !PG_ROLES.contains(&run_as.as_str()) {
                    return Err(format!("step {} runs as unknown role '{run_as}'", s.id()));
                }
                if matches!(s, Step::DbPush { .. }) {
                    pushes += 1;
                }
            }
        }
    }
    if pushes != 1 {
        return Err(format!("run-order must contain exactly one db-push step, found {pushes}"));
    }
    // each copy step pairs with a remove step that removes exactly the files it copied
    let mut left = removes;
    for names in &copies {
        match left.iter().position(|r| r == names) {
            Some(i) => {
                left.remove(i);
            }
            None => return Err("every copy-extension-stubs step needs a remove-extension-stubs step for the same files (the vector stub must not stay)".into()),
        }
    }
    if !left.is_empty() {
        return Err("a remove-extension-stubs step removes files that no copy step installed".into());
    }
    Ok(())
}

/// Read, parse and validate; also check that every referenced file exists in the pack.
pub fn load(pack_dir: &Path) -> Result<RunOrder, String> {
    let text = std::fs::read_to_string(pack_dir.join("sql").join("run-order.json")).map_err(|e| format!("cannot read sql\\run-order.json: {e}"))?;
    let o = parse(&text)?;
    validate(&o)?;
    for s in &o.steps {
        let files: Vec<&String> = match s {
            Step::Sql { file, .. } => vec![file],
            Step::CopyExtensionStubs { files, .. } => files.iter().collect(),
            _ => vec![],
        };
        for f in files {
            if !pack_dir.join(safe_entry_path(f)?).is_file() {
                return Err(format!("run-order step {} refers to {f}, which is not in the pack", s.id()));
            }
        }
    }
    Ok(o)
}

/// The extra psql arguments of one step: the pack's `psqlArgs`, then `--single-transaction` when
/// the step asks for it (pass to `pg::Psql::run_with`).
pub fn psql_extra_args(o: &RunOrder, step: &Step) -> Vec<String> {
    let mut a = o.psql_args.clone();
    if step.single_transaction() {
        a.push("--single-transaction".to_string());
    }
    a
}

/// `\set name 'value'` lines. Values are restricted to ASCII letters and digits (the generated
/// secrets are hex), so no quoting or escaping can go wrong: psql interprets backslashes inside
/// a single-quoted `\set` value, which makes escaping unsafe; refusing is the safe answer.
pub fn psql_header(vars: &[(String, String)]) -> Result<String, String> {
    let mut out = String::new();
    if !vars.is_empty() {
        out.push_str("SET log_min_error_statement = panic;\n"); // keep `\set` secrets out of the server log
    }
    for (name, value) in vars {
        if !is_var_name(name) {
            return Err(format!("bad psql variable name '{name}'"));
        }
        if value.is_empty() || !value.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("the value of {name} must be letters and digits only"));
        }
        out.push_str(&format!("\\set {name} '{value}'\n"));
    }
    Ok(out)
}

/// Resolve a step's variables to `(name, secret)` using `varRoles` and a role-to-password lookup.
pub fn step_vars(o: &RunOrder, vars: &[String], password_of: &dyn Fn(&str) -> String) -> Vec<(String, String)> {
    vars.iter().map(|v| (v.clone(), password_of(o.var_roles.get(v).map(String::as_str).unwrap_or("")))).collect()
}

/// Copy the pack's stub extension files into `to` (pack-relative). Every `.control` is checked for
/// `trusted = true` BEFORE anything is copied: the non-superuser owner could not create it otherwise.
pub fn copy_stubs(pack_dir: &Path, files: &[String], to: &str) -> Result<(), String> {
    let dest = pack_dir.join(safe_entry_path(to)?);
    let mut plan: Vec<(PathBuf, std::ffi::OsString)> = Vec::new();
    for f in files {
        let src: PathBuf = pack_dir.join(safe_entry_path(f)?);
        let name = src.file_name().ok_or("bad stub name")?.to_os_string();
        if name.to_string_lossy().ends_with(".control") && !crate::pg::control_is_trusted(&std::fs::read_to_string(&src).map_err(|e| format!("cannot read {f}: {e}"))?) {
            return Err(format!("{f} is not marked 'trusted = true': the non-superuser owner could not create the extension"));
        }
        plan.push((src, name));
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for (src, name) in plan {
        std::fs::copy(&src, dest.join(&name)).map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
    }
    Ok(())
}

/// Remove stub files (bare names) from `from` (pack-relative). Missing is fine: removal is idempotent.
pub fn remove_stubs(pack_dir: &Path, files: &[String], from: &str) -> Result<(), String> {
    let dir = pack_dir.join(safe_entry_path(from)?);
    for f in files {
        let name = safe_entry_path(f)?;
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {f}: {e}")),
        }
    }
    Ok(())
}

#[cfg(test)]
/// The real file the pack ships (Plan 04b): the interpreter is tested against it, not a sketch.
pub const SAMPLE: &str = include_str!("../pack/sql/run-order.json");

#[cfg(test)]
mod tests {
    use super::*;

    const IDS: [&str; 12] = [
        "stubs-install", "01-pre-gotrue", "03-owner-role", "03b-storage", "03c-database-grants", "auth-migrate",
        "02-shim-after-gotrue", "04-nonsuper-fixups", "db-push", "stubs-remove", "20-pos-lockout-hook", "30-store-schema-version",
    ];

    #[test]
    fn the_proven_order_parses_and_validates() {
        let o = parse(SAMPLE).unwrap();
        validate(&o).unwrap();
        let ids: Vec<&str> = o.steps.iter().map(Step::id).collect();
        assert_eq!(ids, IDS);
        assert!(o.note.is_some());
        assert_eq!(o.psql_args, ["-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never"]);
        // after a crash only idempotent steps may be retried: the three `rerun: never` sql steps may not
        let not_rerunnable: Vec<&str> = o.steps.iter().filter(|s| !s.rerunnable()).map(Step::id).collect();
        assert_eq!(not_rerunnable, ["01-pre-gotrue", "03-owner-role", "03b-storage"]);
        assert!(o.steps.iter().filter(|s| matches!(s, Step::Sql { .. })).all(|s| s.single_transaction()));
        assert!(!o.steps[0].single_transaction() && !o.steps[5].single_transaction());
        let always: Vec<&str> = o.steps.iter().filter(|s| s.always()).map(Step::id).collect();
        assert_eq!(always, ["stubs-remove"]);
        let never: Vec<&str> = o.steps.iter().filter(|s| s.rerun() == Rerun::Never).map(Step::id).collect();
        assert_eq!(never, ["01-pre-gotrue", "03-owner-role", "03b-storage"]);
        assert_eq!(o.steps[4].rerun(), Rerun::EveryUpdate, "03c re-grants on every clone");
    }

    #[test]
    fn a_rerun_never_step_is_not_rerunnable_even_in_one_transaction() {
        let o = parse(SAMPLE).unwrap();
        assert!(o.steps[1].single_transaction() && o.steps[1].rerun() == Rerun::Never);
        assert!(!o.steps[1].rerunnable(), "plain CREATE ROLE cannot be retried");
        assert!(o.steps[4].rerunnable(), "03c is idempotent");
        assert!(o.steps[0].rerunnable() && o.steps[8].rerunnable(), "non-sql kinds stay rerunnable");
    }

    #[test]
    fn a_non_transactional_sql_step_is_not_rerunnable() {
        let mut o = parse(SAMPLE).unwrap();
        if let Step::Sql { single_transaction, .. } = &mut o.steps[1] {
            *single_transaction = false;
        }
        assert!(!o.steps[1].rerunnable());
    }

    #[test]
    fn unknown_fields_and_kinds_fail_loudly() {
        let with_extra = SAMPLE.replacen("\"rerun\": \"never\"", "\"rerun\": \"never\", \"surprise\": 1", 1);
        assert!(parse(&with_extra).is_err(), "a future step field is refused, never dropped");
        let top = SAMPLE.replacen("\"schema\": 1,", "\"schema\": 1, \"surprise\": 1,", 1);
        assert!(parse(&top).is_err());
        let bad_rerun = SAMPLE.replacen("\"rerun\": \"never\"", "\"rerun\": \"sometimes\"", 1);
        assert!(parse(&bad_rerun).is_err());
        assert!(parse("{\"schema\":1,\"varRoles\":{},\"steps\":[{\"id\":\"x\",\"kind\":\"shell\"}]}").is_err(), "an unknown kind is refused, never skipped");
        assert!(parse("{\"schema\":1}").is_err());
    }

    #[test]
    fn broken_files_are_refused() {
        let ok = parse(SAMPLE).unwrap();
        let mut bad = ok.clone();
        bad.schema = 2;
        assert!(validate(&bad).is_err());
        let mut bad = ok.clone();
        bad.var_roles.insert("pw_x".into(), "root".into());
        assert!(validate(&bad).unwrap_err().contains("unknown role"));
        let mut bad = ok.clone();
        if let Step::Sql { vars, .. } = &mut bad.steps[1] {
            vars.push("pw_missing".into());
        }
        assert!(validate(&bad).unwrap_err().contains("pw_missing"));
        let mut bad = ok.clone();
        bad.steps.retain(|s| s.id() != "db-push");
        assert!(validate(&bad).unwrap_err().contains("db-push"));
        let mut bad = ok.clone();
        bad.steps.retain(|s| s.id() != "stubs-remove");
        assert!(validate(&bad).unwrap_err().contains("must not stay"));
        let mut bad = ok.clone();
        bad.steps.push(bad.steps[1].clone());
        assert!(validate(&bad).unwrap_err().contains("twice"));
        let mut bad = ok.clone();
        if let Step::Sql { file, .. } = &mut bad.steps[2] {
            *file = "../outside.sql".into();
        }
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn psql_args_must_be_plain_variable_assignments() {
        let ok = parse(SAMPLE).unwrap();
        for bad in [vec!["-c", "select 1"], vec!["-v"], vec!["-v", "X"], vec!["-v", "bad name=1"], vec!["-f", "evil.sql"], vec!["-v", "A=1", "-h"]] {
            let mut o = ok.clone();
            o.psql_args = bad.iter().map(|s| s.to_string()).collect();
            assert!(validate(&o).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn psql_args_are_an_exact_allowlist_so_a_pack_cannot_override_error_handling() {
        let ok = parse(SAMPLE).unwrap();
        for bad in ["ON_ERROR_STOP=0", "ECHO=all", "AUTOCOMMIT=off", "VERBOSITY=verbose", "SHOW_CONTEXT=always", "ON_ERROR_ROLLBACK=on"] {
            let mut o = ok.clone();
            o.psql_args = vec!["-v".into(), bad.into()];
            assert!(validate(&o).is_err(), "{bad}");
        }
        let mut o = ok.clone();
        o.psql_args = vec![];
        validate(&o).unwrap();
    }

    #[test]
    fn variables_need_the_superuser_role() {
        let mut bad = parse(SAMPLE).unwrap();
        if let Step::Sql { run_as, .. } = &mut bad.steps[1] {
            *run_as = "postgres".into();
        }
        assert!(validate(&bad).unwrap_err().contains("supabase_admin"));
    }

    #[test]
    fn copy_and_remove_steps_are_pinned_and_paired() {
        let ok = parse(SAMPLE).unwrap();
        let edit = |f: &dyn Fn(&mut RunOrder)| {
            let mut o = ok.clone();
            f(&mut o);
            validate(&o)
        };
        assert!(edit(&|o| if let Step::CopyExtensionStubs { to, .. } = &mut o.steps[0] { *to = "pg/bin".into() }).is_err(), "copy target pinned");
        assert!(edit(&|o| if let Step::RemoveExtensionStubs { from, .. } = &mut o.steps[9] { *from = "pg/bin".into() }).is_err(), "remove source pinned");
        assert!(edit(&|o| if let Step::CopyExtensionStubs { files, .. } = &mut o.steps[0] { files.push("sql/stub-extensions/evil.dll".into()) }).is_err(), "only .control/.sql");
        assert!(edit(&|o| if let Step::RemoveExtensionStubs { files, .. } = &mut o.steps[9] { files.push("postgres.exe".into()) }).is_err(), "remove list must equal the copied names");
        assert!(edit(&|o| if let Step::RemoveExtensionStubs { files, .. } = &mut o.steps[9] { files[0] = "../x.control".into() }).is_err());
        assert!(edit(&|o| if let Step::RemoveExtensionStubs { files, .. } = &mut o.steps[9] { files.pop(); }).is_err(), "unpaired");
    }

    #[test]
    fn psql_variables_are_set_on_stdin_and_restricted_to_safe_values() {
        let h = psql_header(&[("pw_authr".into(), "ab12".into()), ("pw_owner".into(), "CD34".into())]).unwrap();
        // a failing statement that interpolates a `\set` password is logged by Postgres at the default
        // `log_min_error_statement`; steps that carry variables therefore start with it turned off
        assert_eq!(h, "SET log_min_error_statement = panic;\n\\set pw_authr 'ab12'\n\\set pw_owner 'CD34'\n");
        assert_eq!(psql_header(&[]).unwrap(), "", "a step without variables gets no header");
        assert!(psql_header(&[("pw".into(), "a'b".into())]).is_err());
        assert!(psql_header(&[("pw".into(), "a\\nb".into())]).is_err());
        assert!(psql_header(&[("pw".into(), "".into())]).is_err());
        assert!(psql_header(&[("PW".into(), "ab".into())]).is_err());
        assert!(psql_header(&[("pw;drop".into(), "ab".into())]).is_err());
    }

    #[test]
    fn variables_resolve_through_var_roles() {
        let o = parse(SAMPLE).unwrap();
        let v = step_vars(&o, &["pw_authadm".to_string(), "pw_authr".to_string()], &|role| format!("secret-of-{role}"));
        assert_eq!(v, vec![("pw_authadm".to_string(), "secret-of-supabase_auth_admin".to_string()), ("pw_authr".to_string(), "secret-of-authenticator".to_string())]);
    }

    #[test]
    fn a_step_psql_invocation_adds_pack_args_and_single_transaction() {
        let o = parse(SAMPLE).unwrap();
        assert_eq!(psql_extra_args(&o, &o.steps[1]), ["-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never", "--single-transaction"]);
        assert_eq!(psql_extra_args(&o, &o.steps[0]), ["-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never"]);
    }

    fn pack_with_stubs(dir: &Path, trusted: bool) {
        let s = dir.join("sql").join("stub-extensions");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("vector.control"), if trusted { "comment = 'x'\ntrusted = true\n" } else { "comment = 'x'\n" }).unwrap();
        std::fs::write(s.join("vector--0.0.1.sql"), "-- stub").unwrap();
        std::fs::create_dir_all(dir.join("pg").join("share").join("extension")).unwrap();
        std::fs::write(dir.join("pg").join("share").join("extension").join("pg_net.control"), "trusted = true\n").unwrap();
    }

    #[test]
    fn the_vector_stub_is_copied_then_removed_and_pg_net_stays() {
        let d = tempfile::tempdir().unwrap();
        pack_with_stubs(d.path(), true);
        let files = vec!["sql/stub-extensions/vector.control".to_string(), "sql/stub-extensions/vector--0.0.1.sql".to_string()];
        copy_stubs(d.path(), &files, "pg/share/extension").unwrap();
        let ext = d.path().join("pg").join("share").join("extension");
        assert!(ext.join("vector.control").is_file() && ext.join("vector--0.0.1.sql").is_file());
        let names = vec!["vector.control".to_string(), "vector--0.0.1.sql".to_string()];
        remove_stubs(d.path(), &names, "pg/share/extension").unwrap();
        remove_stubs(d.path(), &names, "pg/share/extension").unwrap();
        assert!(!ext.join("vector.control").exists() && !ext.join("vector--0.0.1.sql").exists());
        assert!(ext.join("pg_net.control").is_file(), "the pg_net stub is permanent");
        assert!(d.path().join("sql").join("stub-extensions").join("vector.control").is_file(), "the pack's own copy is never touched");
    }

    #[test]
    fn an_untrusted_control_file_is_refused_before_anything_is_copied() {
        let d = tempfile::tempdir().unwrap();
        pack_with_stubs(d.path(), false);
        let files = vec!["sql/stub-extensions/vector.control".to_string()];
        assert!(copy_stubs(d.path(), &files, "pg/share/extension").unwrap_err().contains("trusted"));
        assert!(!d.path().join("pg").join("share").join("extension").join("vector.control").exists());
    }

    #[test]
    fn load_requires_every_referenced_file_to_exist() {
        let d = tempfile::tempdir().unwrap();
        pack_with_stubs(d.path(), true);
        std::fs::write(d.path().join("sql").join("run-order.json"), SAMPLE).unwrap();
        assert!(load(d.path()).unwrap_err().contains("01-pre-gotrue"));
        for f in ["01-pre-gotrue", "02-shim-after-gotrue", "03-owner-role", "03b-storage", "03c-database-grants", "04-nonsuper-fixups", "20-pos-lockout-hook", "30-store-schema-version"] {
            std::fs::write(d.path().join("sql").join(format!("{f}.sql")), "select 1;").unwrap();
        }
        assert_eq!(load(d.path()).unwrap().steps.len(), 12);
    }

    #[test]
    #[ignore = "needs POS_PACK_DIR (a built pack)"]
    fn the_real_pack_run_order_loads_and_matches_the_shipped_source() {
        let dir = std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR");
        let o = load(Path::new(&dir)).unwrap();
        let ids: Vec<&str> = o.steps.iter().map(Step::id).collect();
        assert_eq!(ids, IDS);
    }

    #[test]
    fn a_step_without_rerun_is_refused_not_read_as_never() {
        let mut v: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        for i in 0..v["steps"].as_array().unwrap().len() {
            let mut w = v.clone();
            w["steps"][i].as_object_mut().unwrap().remove("rerun");
            assert!(parse(&w.to_string()).is_err(), "step {i} without `rerun` must be refused");
        }
        v["steps"][0].as_object_mut().unwrap().insert("rerun".into(), serde_json::json!("every-update"));
        assert!(parse(&v.to_string()).is_ok());
    }
}
