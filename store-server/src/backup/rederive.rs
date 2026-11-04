//! Re-derive every staff member's Auth password from `profiles.pin` with THIS machine's pepper
//! (conventions 6, 15 item 1; Plan 01 contract, Plan 05 `staff_password`). Needed after a restore onto another PC and
//! harmless after a same-PC restore.
//!
//! What touches `auth.users`, and nothing else does: one `UPDATE auth.users SET encrypted_password = ..., updated_at,
//! <the seven GoTrue token columns> = coalesce(col, '') WHERE id = '<uuid>'` per staff member, on the restored database
//! that is not live yet. Never an INSERT (repo rule: an `auth.users` row is only ever created by GoTrue's admin API; a
//! NULL in a token column crashes every GoTrue endpoint, so the `20260830000001_auth_users_token_defaults.sql` backfill
//! rides in the same statement). The PINs are read into memory only; the pepper never leaves this process; the script
//! carries derived passwords, travels on psql's stdin behind a prelude that switches statement logging off, and is
//! never written to disk or logged. Errors and the report carry counts and account ids only.
use serde_json::{json, Value};
use std::time::Duration;

use super::ctx::BackupCtx;
use super::pg::{sql_scalar, sql_script};
use super::restore::Rx;
use super::result::{BResult, BackupError};
use super::run::admin_conn;
use crate::staff_password::{acceptable_pepper, derive_staff_password};

/// The first line of `run::ROLE_SQL` (a test pins that): no server log line may carry a statement or its duration,
/// and an error may not quote the statement.
pub(crate) const QUIET: &str = "SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET log_min_duration_statement = -1; SET pgaudit.log = 'none'; SET auto_explain.log_min_duration = -1;\n";

/// The GoTrue token columns `20260830000001_auth_users_token_defaults.sql` backfills.
const TOKEN_COLUMNS: [&str; 7] = ["confirmation_token", "recovery_token", "email_change_token_new", "email_change_token_current", "email_change", "reauthentication_token", "phone_change_token"];

/// No `Debug`: `script` holds derived passwords.
pub struct Plan {
    pub script: String,
    pub updated: usize,
    pub skipped: Vec<String>,
}

pub fn build_script(rows: &[(String, String)], pepper: &str) -> Plan {
    let backfill = TOKEN_COLUMNS.iter().map(|c| format!("{c} = coalesce({c}, '')")).collect::<Vec<_>>().join(", ");
    let mut body = String::new();
    let (mut updated, mut skipped) = (0usize, Vec::new());
    for (id, pin) in rows {
        match derive_staff_password(id, pin, pepper) {
            // base64url plus the `v1.` prefix: nothing that needs escaping, checked rather than assumed
            Ok(pw) if pw.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')) => {
                body.push_str(&format!("UPDATE auth.users SET encrypted_password = crypt('{pw}', gen_salt('bf', 10)), updated_at = now(), {backfill} WHERE id = '{id}';\n"));
                updated += 1;
            }
            _ => skipped.push(id.clone()),
        }
    }
    let script = if updated == 0 { String::new() } else { format!("{QUIET}SET search_path = extensions, public, pg_catalog;\nBEGIN;\n{body}COMMIT;\n") };
    Plan { script, updated, skipped }
}

fn read_pepper(ctx: &BackupCtx) -> BResult<String> {
    let p = std::fs::read_to_string(ctx.paths.pepper()).map_err(|_| BackupError::precondition("secrets\\staff-password-pepper.txt is missing or unreadable"))?;
    let p = p.trim().to_string();
    if !acceptable_pepper(&p) {
        return Err(BackupError::precondition("secrets\\staff-password-pepper.txt is too weak to use (32 or more characters, at least 8 different ones)"));
    }
    Ok(p)
}

fn count(ctx: &BackupCtx, rx: &Rx, db: &str, sql: &str) -> BResult<i64> {
    Ok(sql_scalar(rx.exec, ctx, &admin_conn(ctx, db), sql, true)?.trim().parse().unwrap_or(0))
}

/// Updates the staff accounts of `db`. The report is counts (and, for accounts that could not be derived, their ids).
pub fn run(ctx: &BackupCtx, rx: &Rx, db: &str) -> BResult<Value> {
    let pepper = read_pepper(ctx)?;
    let conn = admin_conn(ctx, db);
    let out = sql_scalar(rx.exec, ctx, &conn, "SELECT id || ',' || pin FROM public.profiles WHERE pin ~ '^[0-9]{6}$' ORDER BY id;", true)?;
    let rows: Vec<(String, String)> = out.lines().filter_map(|l| l.split_once(',')).map(|(a, b)| (a.trim().to_string(), b.trim().to_string())).collect();
    let no_pin = count(ctx, rx, db, "SELECT count(*) FROM public.profiles WHERE pin IS NULL OR NOT (pin ~ '^[0-9]{6}$');")?;
    let plan = build_script(&rows, &pepper);
    if !plan.script.is_empty() {
        let t = rx.cap(Duration::from_secs(300), "re-deriving staff passwords")?;
        sql_script(rx.exec, ctx, &conn, &plan.script, t).map_err(|e| BackupError::restore_failed(format!("re-deriving staff passwords failed: {}", e.message)))?;
    }
    // a staff member with no auth.users row is reported, never created (that is GoTrue's job)
    let no_auth = count(ctx, rx, db, "SELECT count(*) FROM public.profiles p WHERE p.pin ~ '^[0-9]{6}$' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);")?;
    Ok(json!({ "rederived": plan.updated, "skipped": plan.skipped.len(), "skippedIds": plan.skipped.iter().take(10).collect::<Vec<_>>(), "withoutValidPin": no_pin, "withoutAuthUser": no_auth }))
}

/// The active admin's id and the password derived for them with this machine's pepper
/// (the PIN itself never leaves this function).
pub fn admin_login(ctx: &BackupCtx, rx: &Rx, db: &str) -> BResult<(String, String)> {
    let pepper = read_pepper(ctx)?;
    let row = sql_scalar(
        rx.exec,
        ctx,
        &admin_conn(ctx, db),
        "SELECT id || ',' || pin FROM public.profiles WHERE role::text = 'admin' AND is_active AND pin ~ '^[0-9]{6}$' ORDER BY created_at LIMIT 1;",
        true,
    )?;
    let (id, pin) = row.split_once(',').ok_or_else(|| BackupError::restore_failed("the backup contains no active admin with a valid sign-in code; the restored store could not be signed in to"))?;
    let (id, pin) = (id.trim().to_string(), pin.trim().to_string());
    let pw = derive_staff_password(&id, &pin, &pepper).map_err(|_| BackupError::restore_failed("cannot derive the admin's password (not a valid account id or sign-in code)"))?;
    Ok((id, pw))
}

/// An active admin whose stored credential verifies (bcrypt, through pgcrypto) against the code derived with this
/// machine's pepper. Returns the admin's id (used for the RLS probe).
pub fn admin_credential_check(ctx: &BackupCtx, rx: &Rx, db: &str) -> BResult<String> {
    let (id, pw) = admin_login(ctx, rx, db)?;
    let script = format!("{QUIET}SET search_path = extensions, public, pg_catalog;\nSELECT (encrypted_password = crypt('{pw}', encrypted_password) AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until < now())) FROM auth.users WHERE id = '{id}';\n");
    let t = rx.cap(Duration::from_secs(60), "checking the admin credential")?;
    let out = sql_script(rx.exec, ctx, &admin_conn(ctx, db), &script, t)?;
    if out.trim() != "t" {
        return Err(BackupError::restore_failed("the restored admin's stored credential does not verify"));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::restore::Rx;
    use crate::backup::run::Deps;
    use crate::backup::util::fake::{rand_pepper, rand_pin, temp_ctx, FakeExec};
    use std::rc::Rc;

    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const NOW: i64 = 1_790_000_000;
    const TOKEN_COLUMNS: [&str; 7] = ["confirmation_token", "recovery_token", "email_change_token_new", "email_change_token_current", "email_change", "reauthentication_token", "phone_change_token"];

    fn deps(e: Rc<FakeExec>) -> Deps {
        Deps { exec: Box::new(e), opener: Box::new(crate::backup::pg::PsqlOpener), now: || NOW, free_bytes: |_| Ok(1 << 40) }
    }

    #[test]
    fn every_valid_staff_member_gets_one_update_and_the_script_never_contains_a_pin() {
        let rows = vec![(A.to_string(), rand_pin()), (B.to_string(), rand_pin())];
        let plan = build_script(&rows, &rand_pepper());
        assert_eq!(plan.updated, 2);
        assert!(plan.skipped.is_empty());
        assert_eq!(plan.script.matches("UPDATE auth.users").count(), 2);
        assert!(plan.script.starts_with(QUIET), "statement logging is switched off before any derived password is sent");
        assert!(plan.script.contains("SET search_path = extensions, public, pg_catalog;\nBEGIN;\n"));
        assert!(plan.script.trim_end().ends_with("COMMIT;"));
        for (_, p) in &rows {
            assert!(!plan.script.contains(p.as_str()), "the derived password may be in the script, the PIN may not");
        }
        assert!(plan.script.contains("crypt('v1."), "derived passwords carry the v1 prefix");
    }

    #[test]
    fn auth_users_is_only_ever_updated_and_every_update_repairs_the_seven_token_columns_in_the_same_statement() {
        let plan = build_script(&[(A.to_string(), rand_pin()), (B.to_string(), rand_pin())], &rand_pepper());
        let upper = plan.script.to_uppercase();
        assert!(!upper.contains("INSERT") && !upper.contains("DELETE") && !upper.contains("TRUNCATE"), "never an INSERT into auth.users");
        let updates: Vec<&str> = plan.script.lines().filter(|l| l.starts_with("UPDATE auth.users")).collect();
        assert_eq!(updates.len(), 2);
        for u in updates {
            for col in TOKEN_COLUMNS {
                assert!(u.contains(&format!("{col} = coalesce({col}, '')")), "{col} must be backfilled in the same statement: {u}");
            }
            assert!(u.contains("WHERE id = '"), "matched by id, existing rows only: {u}");
            assert_eq!(u.matches(';').count(), 1, "one statement per account");
        }
    }

    #[test]
    fn an_account_that_cannot_be_derived_is_skipped_and_named_never_guessed() {
        let rows = vec![("not-a-uuid".to_string(), rand_pin()), (A.to_string(), "12".to_string())];
        let plan = build_script(&rows, &rand_pepper());
        assert_eq!(plan.updated, 0);
        assert_eq!(plan.skipped.len(), 2);
        assert!(plan.script.is_empty());
    }

    #[test]
    fn a_short_pepper_changes_nothing() {
        let plan = build_script(&[(A.to_string(), rand_pin())], "short");
        assert_eq!(plan.updated, 0);
        assert!(plan.script.is_empty());
    }

    #[test]
    fn the_quiet_prelude_is_the_one_the_role_script_uses() {
        assert!(crate::backup::run::ROLE_SQL.starts_with(QUIET.trim_end()));
        for g in ["log_statement = 'none'", "log_min_error_statement = 'panic'", "log_min_duration_statement = -1", "pgaudit.log = 'none'", "auto_explain.log_min_duration = -1"] {
            assert!(QUIET.contains(g), "{g}");
        }
    }

    #[test]
    fn run_reads_the_pins_in_memory_derives_with_this_pepper_and_sends_only_derived_passwords_on_stdin() {
        let (_d, c) = temp_ctx();
        let pepper = std::fs::read_to_string(c.paths.pepper()).unwrap();
        let (p1, p2) = (rand_pin(), rand_pin());
        let e = Rc::new(FakeExec::default().on("WHERE pin ~", 0, &format!("{A},{p1}\n{B},{p2}\n")).on("NOT (pin ~", 0, "1\n").on("NOT EXISTS (SELECT 1 FROM auth.users", 0, "0\n"));
        let d = deps(e.clone());
        let out = run(&c, &Rx::new(&d), "pos_next").unwrap();
        assert_eq!((out["rederived"].as_u64(), out["withoutValidPin"].as_i64(), out["withoutAuthUser"].as_i64()), (Some(2), Some(1), Some(0)));
        let calls = e.calls.borrow().clone();
        assert!(calls.iter().any(|l| l.contains(" <<") && l.contains("UPDATE auth.users")));
        let expect_pw = crate::staff_password::derive_staff_password(A, &p1, pepper.trim()).unwrap();
        for l in &calls {
            let argv = l.split(" <<").next().unwrap();
            assert!(!argv.contains("v1.") && !argv.contains(pepper.trim()) && !argv.contains(&p1) && !argv.contains(&p2), "nothing secret on a command line: {argv}");
            assert!(!l.contains(pepper.trim()), "the pepper never leaves posctl");
            assert!(!l.contains(&p1) && !l.contains(&p2), "a PIN is never sent anywhere");
        }
        assert!(calls.iter().any(|l| l.contains(&expect_pw)), "the password derived with this machine's pepper is what gets stored");
        assert!(!out.to_string().contains(&p1) && !out.to_string().contains(&expect_pw));
    }

    #[test]
    fn a_failing_update_reports_without_any_pin_or_derived_password() {
        let (_d, c) = temp_ctx();
        let p1 = rand_pin();
        let e = Rc::new(FakeExec::default().on("WHERE pin ~", 0, &format!("{A},{p1}\n")).on_stderr("UPDATE auth.users", 3, "ERROR: boom"));
        let d = deps(e);
        let err = run(&c, &Rx::new(&d), "pos_next").unwrap_err();
        assert!(!err.message.contains(&p1) && !err.message.contains("v1."), "{}", err.message);
    }

    #[test]
    fn a_missing_or_weak_pepper_is_a_precondition_that_never_echoes_it() {
        let (_d, c) = temp_ctx();
        let d = deps(Rc::new(FakeExec::default()));
        std::fs::write(c.paths.pepper(), "q9q9q9").unwrap();
        let err = run(&c, &Rx::new(&d), "pos_next").unwrap_err();
        assert_eq!(err.code, crate::envelope::Code::Precondition);
        assert!(!err.message.contains("q9q9q9"));
        std::fs::remove_file(c.paths.pepper()).unwrap();
        assert_eq!(run(&c, &Rx::new(&d), "pos_next").unwrap_err().code, crate::envelope::Code::Precondition);
    }

    #[test]
    fn an_admin_whose_stored_credential_does_not_verify_fails_the_check() {
        let (_d, c) = temp_ctx();
        let row = format!("{A},{}\n", rand_pin());
        let ok = deps(Rc::new(FakeExec::default().on("role::text = 'admin'", 0, &row).on("encrypted_password = crypt", 0, "t\n")));
        assert_eq!(admin_credential_check(&c, &Rx::new(&ok), "pos_next").unwrap(), A);
        let bad = deps(Rc::new(FakeExec::default().on("role::text = 'admin'", 0, &row).on("encrypted_password = crypt", 0, "f\n")));
        assert!(admin_credential_check(&c, &Rx::new(&bad), "pos_next").is_err());
        let none = deps(Rc::new(FakeExec::default().on("role::text = 'admin'", 0, "")));
        assert!(admin_credential_check(&c, &Rx::new(&none), "pos_next").unwrap_err().message.contains("no active admin"));
    }

    #[test]
    fn the_credential_check_script_is_quiet_and_keeps_the_derived_password_off_the_command_line() {
        let (_d, c) = temp_ctx();
        let pin = rand_pin();
        let e = Rc::new(FakeExec::default().on("role::text = 'admin'", 0, &format!("{A},{pin}\n")).on("encrypted_password = crypt", 0, "t\n"));
        let d = deps(e.clone());
        admin_credential_check(&c, &Rx::new(&d), "pos_next").unwrap();
        let line = e.calls.borrow().iter().find(|l| l.contains("encrypted_password = crypt")).cloned().unwrap();
        assert!(line.contains(" <<") && line.contains("log_statement = 'none'"));
        assert!(!line.split(" <<").next().unwrap().contains("v1."));
        assert!(!line.contains(&pin));
    }
}
