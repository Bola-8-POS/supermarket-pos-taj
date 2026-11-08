//! The staff accounts of a switch (two-mode 11H, T15). Staff Auth rows are copied from the cloud as they are: the cloud's pepper is
//! imported as the local one (typed on the console, installed after the swap by `work::after_activate`), so the copied passwords
//! stay valid and nothing is re-derived. What this module does:
//!
//! * `apply` scrambles the `auth.users` rows that belong to no staff profile (outside the KEEP set), in one transaction;
//! * `admin_proof` / `check_pin` prove BEFORE the fence that the typed pepper is the cloud's: one active admin's typed PIN must
//!   match their stored bcrypt hash AND the password derived from (admin id, PIN, pepper) must verify against the copied
//!   `auth.users` row. Both checks run in the local database (`crypt()`), the cloud is only read; the PIN, the pepper and the
//!   derived password travel on psql's stdin behind the QUIET prelude and are registered for redaction.
use crate::backup::rederive::{QUIET, TOKEN_COLUMNS};
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::swap::{PsqlAdmin, StmtClass};
use crate::ops::world::R;
use crate::staff_password::{acceptable_pepper, derive_staff_password, is_uuid};
use crate::switch::cloud::{CloudDb, CloudFence};
use crate::switch::mutants::{on as mutant_on, M};
use crate::switch::prompt::{register, zero_string, AdminProof, Console, Entered};
use crate::update::Env;

/// Counts only: no id, PIN or password is in a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RederiveReport {
    /// Staff accounts whose copied cloud credential was kept as it is.
    pub rows: usize,
    /// Staff profiles with no `auth.users` row (they cannot sign in).
    pub skipped: usize,
    /// `auth.users` rows without a staff profile (outside the KEEP set), given a random password nobody knows.
    pub scrambled: usize,
    /// Staff profiles whose `pin` is not a bcrypt hash. Named in the runbook; the hosted migration makes this zero.
    pub without_valid_pin: usize,
}

/// `AND id NOT IN (...)` for the KEEP set; the ids are checked as UUIDs, so nothing else can reach the SQL.
fn keep_clause(keep: &[String], col: &str) -> R<String> {
    if keep.iter().any(|k| !is_uuid(k)) {
        return Err(OpError::err("KEEP_ID_INVALID", "a kept account id is not a UUID"));
    }
    if keep.is_empty() {
        return Ok(String::new());
    }
    let list = keep.iter().map(|k| format!("'{}'", k.to_lowercase())).collect::<Vec<_>>().join(", ");
    Ok(format!(" AND {col} NOT IN ({list})"))
}

/// `profiles.pin` / `auth.users.encrypted_password` values written by bcrypt.
const BCRYPT: &str = r"'^\$2[aby]\$'";

/// Every `auth.users` row that belongs to no staff profile and is not kept gets a password nobody knows, so a credential from the
/// hosted project cannot survive the move. Staff rows are left exactly as copied. Prints the number changed.
pub fn scramble_sql(keep: &[String]) -> R<String> {
    Ok(format!("{QUIET}SET search_path = extensions, public, pg_catalog;\n{}", scramble_stmt(keep)?))
}

/// The scramble statement alone (no prelude), so it can ride inside the transaction.
fn scramble_stmt(keep: &[String]) -> R<String> {
    let backfill = TOKEN_COLUMNS.iter().map(|c| format!("{c} = coalesce({c}, '')")).collect::<Vec<_>>().join(", ");
    let keep = keep_clause(keep, "u.id")?;
    Ok(format!(
        "WITH s AS (UPDATE auth.users u SET encrypted_password = crypt(gen_random_uuid()::text || gen_random_uuid()::text, gen_salt('bf', 10)), updated_at = now(), {backfill} \
         WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id){keep} RETURNING 1) SELECT count(*) FROM s;\n"
    ))
}

/// ONE script, ONE transaction: the scramble, then COMMIT. All or nothing.
pub fn full_script(keep: &[String]) -> R<String> {
    Ok(format!("{QUIET}SET search_path = extensions, public, pg_catalog;\nBEGIN;\n{}COMMIT;\n", scramble_stmt(keep)?))
}

/// Scrambles the accounts that are not staff and reports counts. Staff keep their copied cloud credentials.
pub fn apply(admin: &PsqlAdmin, db: &str, keep: &[String]) -> R<RederiveReport> {
    keep_clause(keep, "id")?;
    let skip: &[String] = if mutant_on(M::KeepSkipOff) { &[] } else { keep };
    let script = full_script(skip)?;
    let run = || admin.script(db, &script, &[], StmtClass::Default);
    let ran = if mutant_on(M::ScriptSkipped) { Ok("0\n".to_string()) } else { run() };
    let out = ran.map_err(|e| OpError::err("REDERIVE_FAILED", format!("preparing the staff accounts failed: {}", e.message)))?;
    let scrambled: usize = out
        .lines()
        .last()
        .and_then(|l| l.trim().parse().ok())
        .ok_or_else(|| OpError::err("REDERIVE_FAILED", "the staff account step did not report how many accounts it scrambled"))?;
    let count = |sql: String| -> R<usize> {
        admin
            .scalar_class(db, &sql, StmtClass::Quick)?
            .trim()
            .parse()
            .map_err(|_| OpError::err("REDERIVE_FAILED", "a staff account count is not a number"))
    };
    Ok(RederiveReport {
        rows: count("SELECT count(*) FROM public.profiles p WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);".into())?,
        skipped: count("SELECT count(*) FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);".into())?,
        scrambled,
        without_valid_pin: count(format!("SELECT count(*) FROM public.profiles WHERE pin IS NULL OR pin !~ {BCRYPT};"))?,
    })
}

fn refuse(reason: &str, msg: &str) -> OpError {
    OpError::new(OpCode::Precondition, reason, msg.to_string())
}

/// An active cloud admin: id, stored PIN hash, copied Auth hash. Never printed.
pub struct AdminRow {
    id: String,
    pin_hash: String,
    auth_hash: String,
}

fn is_bcrypt(h: &str) -> bool {
    let b = h.as_bytes();
    h.len() == 60 && h.starts_with("$2") && matches!(b[2], b'a' | b'b' | b'y') && b[3] == b'$' && h[4..].bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'/' | b'$'))
}

/// The cloud's active, undeleted, unbanned admins that have a sign-in account (read-only query on the cloud).
pub fn admin_rows_sql(keep: &[String]) -> R<String> {
    let keep = keep_clause(keep, "p.id")?;
    Ok(format!(
        "SELECT p.id || ',' || p.pin || ',' || u.encrypted_password FROM public.profiles p JOIN auth.users u ON u.id = p.id \
         WHERE p.role::text = 'admin' AND p.is_active AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until < now()){keep} ORDER BY p.created_at"
    ))
}

pub fn parse_admin_rows(out: &str) -> R<Vec<AdminRow>> {
    let mut rows = Vec::new();
    let mut unhashed = 0;
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let mut it = l.splitn(3, ',');
        let (Some(id), Some(pin), Some(auth)) = (it.next(), it.next(), it.next()) else { continue };
        if !is_uuid(id) {
            continue;
        }
        if !is_bcrypt(pin) {
            unhashed += 1;
            continue;
        }
        if is_bcrypt(auth) {
            rows.push(AdminRow { id: id.to_string(), pin_hash: pin.to_string(), auth_hash: auth.to_string() });
        }
    }
    if rows.is_empty() {
        return Err(if unhashed > 0 {
            refuse("CLOUD_PINS_NOT_HASHED", "the cloud store still holds plaintext PINs; apply the hosted PIN-hash migration before switching")
        } else {
            refuse("NO_ADMIN_TO_SIGN_IN", "the cloud store has no active admin with a stored PIN hash and a sign-in account, so nobody could sign in afterwards")
        });
    }
    Ok(rows)
}

pub fn fetch_admin_rows(cloud: &CloudDb, keep: &[String]) -> R<Vec<AdminRow>> {
    parse_admin_rows(&cloud.ro(&admin_rows_sql(keep)?)?)
}

/// The verdict of one typed (pepper, PIN) pair.
#[derive(Debug, PartialEq, Eq)]
pub enum Proof {
    /// The PIN matches this admin's stored hash and the derived password verifies against their copied Auth row.
    Match(String),
    /// No admin's stored hash matches the PIN.
    WrongPin,
    /// The PIN matches an admin's stored hash but the password derived with the typed pepper does not verify: not the cloud's pepper.
    WrongPepper,
}

/// The check script of one admin: `1,1` when both hold. It carries the PIN and the derived password, so it goes through
/// `PsqlAdmin::script` (stdin, QUIET first), never a command line. Every value is validated before it is spliced in.
pub fn proof_sql(pin: &str, pin_hash: &str, pw: &str, auth_hash: &str) -> R<String> {
    let pw_ok = pw.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if pin.len() != 6 || !pin.bytes().all(|b| b.is_ascii_digit()) || !pw_ok || !is_bcrypt(pin_hash) || !is_bcrypt(auth_hash) {
        return Err(OpError::err("PROOF_INPUT_INVALID", "the proof inputs are not in the expected shape"));
    }
    Ok(format!(
        "{QUIET}SET search_path = extensions, public, pg_catalog;\nSELECT (crypt('{pin}', '{pin_hash}') = '{pin_hash}')::int || ',' || (crypt('{pw}', '{auth_hash}') = '{auth_hash}')::int;\n"
    ))
}

/// Checks one typed pair against the cloud's admins. Registers every value for redaction first.
pub fn check_pin(local: &PsqlAdmin, rows: &[AdminRow], pepper: &str, pin: &str) -> R<Proof> {
    register(pin);
    let mut wrong_pepper = false;
    for row in rows {
        let Ok(mut pw) = derive_staff_password(&row.id, pin, pepper) else { continue };
        register(&pw);
        let mut script = match proof_sql(pin, &row.pin_hash, &pw, &row.auth_hash) {
            Ok(s) => s,
            Err(e) => {
                zero_string(&mut pw);
                return Err(e);
            }
        };
        let out = local.script("postgres", &script, &[pin, &pw, pepper], StmtClass::Quick);
        zero_string(&mut script);
        zero_string(&mut pw);
        match out?.trim() {
            "1,1" => return Ok(Proof::Match(row.id.clone())),
            "1,0" => wrong_pepper = true,
            _ => {}
        }
    }
    Ok(if wrong_pepper { Proof::WrongPepper } else { Proof::WrongPin })
}

/// The pre-fence admin proof (Q1): asks for the pepper once and the PIN up to three times, hidden. A match returns what the run
/// keeps; a wrong pepper or three wrong PINs refuse with a code (nothing fenced, nothing written, the cloud untouched); no console
/// refuses `PIN_PROMPT_REQUIRED`.
pub fn admin_proof(console: &mut dyn Console, check: &mut dyn FnMut(&str, &str) -> R<Proof>) -> R<AdminProof> {
    let need = || refuse("PIN_PROMPT_REQUIRED", "the switch asks for the cloud pepper and one administrator PIN on the console; run it in a console window");
    let pepper = console.read_hidden("Cloud staff password pepper (hidden):").ok_or_else(need)?;
    register(pepper.expose());
    // the same rule `secrets::load` applies to the local pepper file: 64 lower-case hex characters with real entropy
    let typed = pepper.expose().trim();
    if !(crate::secrets::is_hex64(typed) && acceptable_pepper(typed)) {
        return Err(refuse("PEPPER_UNUSABLE", "that is not a usable staff password pepper (64 lower-case hex characters, at least 8 different ones)"));
    }
    for _ in 0..3 {
        let pin = console.read_hidden("Administrator PIN (hidden):").ok_or_else(need)?;
        register(pin.expose());
        // a typed value that is not six digits is a wrong attempt like any other (no SQL is built from it)
        let verdict = if pin.expose().len() == 6 && pin.expose().bytes().all(|b| b.is_ascii_digit()) { check(pepper.expose().trim(), pin.expose())? } else { Proof::WrongPin };
        match verdict {
            Proof::Match(admin_id) => return Ok(AdminProof { admin_id, pepper: Entered::new(pepper.expose().trim().to_string()), pin }),
            Proof::WrongPepper => return Err(refuse("PEPPER_MISMATCH", "the PIN is right but the pepper is not the cloud's: the copied passwords would not verify; nothing was changed")),
            Proof::WrongPin => {}
        }
    }
    Err(refuse("ADMIN_PIN_WRONG", "three wrong administrator PINs; the switch did not start and nothing was changed"))
}

/// The password the new store's Auth holds for the admin: derived from what the person typed.
pub fn admin_password(p: &AdminProof) -> R<String> {
    derive_staff_password(&p.admin_id, p.pin.expose(), p.pepper.expose()).map_err(|_| OpError::err("ADMIN_PASSWORD_UNDERIVABLE", "cannot derive the admin's password"))
}

/// The pure rule. Only a server prepared for the switch (`cloud` mode) may switch: `offline-only` already runs on its own data, and any
/// other or unreadable mode is refused too (fail closed). A cloud already `moved` is refused. `cloud_state` is the fence's state
/// line (`state|op|effective`).
pub fn refuse_if_switched(mode: &str, cloud_state: Option<&str>) -> R<()> {
    let refuse = |m: &str| Err(OpError::new(OpCode::Precondition, "ALREADY_SWITCHED", m));
    match mode {
        "cloud" => {}
        "offline-only" => {
            return refuse(
                "this server already runs on its own data (Offline-only); there is nothing to switch",
            )
        }
        _ => {
            if !mutant_on(M::RefuseDefaultArmOpen) {
                return refuse(
                    "this server is not prepared for a switch (its mode is not cloud, or posctl.json cannot be read)",
                );
            }
        }
    }
    match cloud_state.and_then(|s| s.split('|').next()) {
        None | Some("active" | "draining" | "frozen") => {}
        Some("") => {
            return Err(OpError::new(
                OpCode::Precondition,
                "CLOUD_FENCE_MISSING",
                "the cloud store has no switch fence row (the hosted fence migrations are not applied), so it cannot be switched",
            ))
        }
        Some("moved") => {
            return refuse("the cloud store is already marked moved; a second switch is refused")
        }
        Some(_) => return refuse("the cloud store is in a state a switch cannot start from"),
    }
    Ok(())
}

/// The mode first (the cloud is not contacted when it already refuses), then the cloud marker. Nothing is changed either way.
pub fn check_with(
    mode: impl FnOnce() -> Result<Option<String>, String>,
    state: impl FnOnce() -> R<String>,
) -> R<()> {
    let mode = mode().ok().flatten().unwrap_or_default();
    refuse_if_switched(&mode, None)?;
    refuse_if_switched(&mode, Some(&state()?))
}

pub fn check_not_switched(env: &Env, fence: &CloudFence) -> R<()> {
    check_with(
        || crate::config::PosctlJson::load(&env.roots).map(|c| c.map(|c| c.mode)),
        || fence.state(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::switch::prompt::scripted::Script;

    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const PEPPER: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// A bcrypt-shaped value (60 characters): shape is all the SQL builders look at.
    fn hash() -> String {
        format!("$2a$08${}", "x".repeat(53))
    }

    #[test]
    fn switch_keeps_staff_auth_rows_and_scrambles_only_non_staff() {
        let s = scramble_sql(&[B.to_uppercase()]).unwrap();
        assert!(s.starts_with(QUIET), "log_statement must be off before anything is sent");
        assert!(s.contains("WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)"), "only rows with no staff profile: {s}");
        assert!(s.contains(&format!("u.id NOT IN ('{B}')")), "the KEEP set is spared: {s}");
        assert!(s.contains("gen_random_uuid()") && !s.contains("v1."), "random passwords, nothing derived: {s}");
        assert!(!s.to_uppercase().contains("INSERT"), "never an INSERT into auth.users");
        for c in TOKEN_COLUMNS {
            assert!(s.contains(&format!("{c} = coalesce({c}, '')")), "{c}");
        }
        assert!(!scramble_sql(&[]).unwrap().contains("NOT IN ('"));
        // one transaction, nothing re-derived from a PIN
        let one = full_script(&[]).unwrap();
        assert_eq!((one.matches("BEGIN;").count(), one.matches("COMMIT;").count()), (1, 1));
        assert!(one.find("WITH s AS (UPDATE auth.users").unwrap() < one.find("COMMIT;").unwrap());
        assert!(!one.contains("pin ~") && !one.contains("crypt('v1."));
    }

    #[test]
    fn a_kept_id_that_is_not_a_uuid_never_reaches_sql() {
        let bad = vec!["x'; drop table profiles; --".to_string()];
        assert_eq!(scramble_sql(&bad).unwrap_err().reason, "KEEP_ID_INVALID");
        assert_eq!(keep_clause(&bad, "id").unwrap_err().reason, "KEEP_ID_INVALID");
        assert_eq!(admin_rows_sql(&bad).err().unwrap().reason, "KEEP_ID_INVALID");
    }

    #[test]
    fn the_cloud_admin_query_is_read_only_shaped_and_skips_the_keep_set() {
        let q = admin_rows_sql(&[A.to_string()]).unwrap();
        assert!(q.contains("p.role::text = 'admin' AND p.is_active") && q.contains("u.deleted_at IS NULL") && q.contains(&format!("p.id NOT IN ('{A}')")), "{q}");
        assert!(!q.to_uppercase().contains("UPDATE") && !q.to_uppercase().contains("INSERT"));
    }

    #[test]
    fn plaintext_pins_in_the_cloud_refuse_with_a_code_and_no_admin_refuses_too() {
        let plain = format!("{A},123456,{}\n", hash());
        assert_eq!(parse_admin_rows(&plain).err().unwrap().reason, "CLOUD_PINS_NOT_HASHED");
        assert_eq!(parse_admin_rows("").err().unwrap().reason, "NO_ADMIN_TO_SIGN_IN");
        let ok = format!("{A},{},{}\n", hash(), hash());
        assert_eq!(parse_admin_rows(&ok).unwrap().len(), 1);
    }

    #[test]
    fn the_proof_script_is_quiet_validated_and_carries_secrets_on_stdin_only() {
        let (h1, h2) = (hash(), hash());
        let s = proof_sql("123456", &h1, "v1.abc-_", &h2).unwrap();
        assert!(s.starts_with(QUIET) && s.contains("crypt('123456'") && s.contains("crypt('v1.abc-_'"));
        for (pin, pw, a, b) in [("12345", "v1.a", h1.as_str(), h2.as_str()), ("12a456", "v1.a", &h1, &h2), ("123456", "x'; --", &h1, &h2), ("123456", "v1.a", "short", &h2), ("123456", "v1.a", &h1, "x'--")] {
            assert_eq!(proof_sql(pin, a, pw, b).unwrap_err().reason, "PROOF_INPUT_INVALID", "{pin} {pw}");
        }
    }

    fn proof_check(verdicts: Vec<Proof>) -> impl FnMut(&str, &str) -> R<Proof> {
        let mut v = verdicts.into_iter();
        move |_, _| Ok(v.next().expect("asked too often"))
    }

    #[test]
    fn switch_wrong_admin_pin_refuses_before_the_fence() {
        let mut c = Script::new(&[PEPPER, "111111", "222222", "333333", "444444"]);
        let e = admin_proof(&mut c, &mut proof_check(vec![Proof::WrongPin, Proof::WrongPin, Proof::WrongPin])).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "ADMIN_PIN_WRONG"));
        assert_eq!(c.asked, 4, "the pepper once and exactly three PIN attempts, then the run ends");
        // a PIN that is not six digits counts as an attempt and never reaches the check
        let mut c = Script::new(&[PEPPER, "abc", "12", "", "999999"]);
        let e = admin_proof(&mut c, &mut |_, _| panic!("no check for a malformed PIN")).unwrap_err();
        assert_eq!(e.reason, "ADMIN_PIN_WRONG");
        // the right PIN on the third try proceeds
        let mut c = Script::new(&[PEPPER, "111111", "222222", "333333"]);
        let ok = admin_proof(&mut c, &mut proof_check(vec![Proof::WrongPin, Proof::WrongPin, Proof::Match(A.into())])).unwrap();
        assert_eq!((ok.admin_id.as_str(), ok.pin.expose(), ok.pepper.expose()), (A, "333333", PEPPER));
    }

    #[test]
    fn switch_refuses_pepper_mismatch_before_the_fence() {
        let mut c = Script::new(&[PEPPER, "111111", "222222"]);
        let e = admin_proof(&mut c, &mut proof_check(vec![Proof::WrongPepper])).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "PEPPER_MISMATCH"));
        assert_eq!(c.asked, 2, "a wrong pepper is not retried with more PINs");
        // a pepper that is not even usable is refused before any PIN is asked
        let mut c = Script::new(&["short", "111111"]);
        assert_eq!(admin_proof(&mut c, &mut |_, _| panic!("no check")).unwrap_err().reason, "PEPPER_UNUSABLE");
        assert_eq!(c.asked, 1);
        // long and varied enough, but not 64 lower-case hex: the local pepper file would be refused too
        for bad in ["test-pepper-not-secret-0123456789abcdef", &PEPPER.to_uppercase(), &PEPPER[..63], &format!("{PEPPER}0"), &"0".repeat(64)] {
            let mut c = Script::new(&[bad, "111111"]);
            assert_eq!(admin_proof(&mut c, &mut |_, _| panic!("no check")).unwrap_err().reason, "PEPPER_UNUSABLE", "{bad}");
            assert_eq!(c.asked, 1);
        }
    }

    #[test]
    fn switch_non_interactive_refuses_pin_prompt_required() {
        for mut c in [Script::none(), Script::new(&[PEPPER])] {
            let e = admin_proof(&mut c, &mut |_, _| panic!("no check without a console")).unwrap_err();
            assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "PIN_PROMPT_REQUIRED"));
        }
    }

    #[test]
    fn switch_pin_never_reaches_argv_env_or_output() {
        let before: Vec<(String, String)> = std::env::vars().collect();
        let mut c = Script::new(&[PEPPER, "135790"]);
        let ok = admin_proof(&mut c, &mut proof_check(vec![Proof::Match(A.into())])).unwrap();
        assert_eq!(format!("{ok:?}"), "AdminProof(***)");
        assert_eq!(std::env::vars().collect::<Vec<_>>(), before, "the prompt sets no environment variable");
        // every typed value and the password derived from it is registered, so the run's report scrubber masks it
        let pw = admin_password(&ok).unwrap();
        crate::switch::prompt::register(&pw);
        let mut secrets = crate::switch::prompt::take_registered();
        for v in [PEPPER, "135790", pw.as_str()] {
            assert!(secrets.iter().any(|s| s == v), "{v} is registered for redaction");
        }
        let leaky = crate::commands::switch::SwitchReport::refused("X", &format!("pin 135790 pepper {PEPPER} pw {pw}"), serde_json::json!({ "echo": "135790" }));
        let out = crate::commands::switch::finalize_report(leaky, &secrets);
        let text = format!("{} {}", out.message, out.data);
        assert!(!text.contains("135790") && !text.contains(PEPPER) && !text.contains(&pw), "{text}");
        crate::switch::prompt::zero_strings(&mut secrets);
        assert!(secrets.iter().all(|s| s.bytes().all(|b| b == 0)));
    }

    #[test]
    fn already_switched_refuses_before_any_change_for_mode() {
        let e = refuse_if_switched("offline-only", None).unwrap_err();
        assert_eq!(
            (e.reason.as_str(), e.code),
            ("ALREADY_SWITCHED", OpCode::Precondition)
        );
        assert!(
            refuse_if_switched("cloud", None).is_ok(),
            "a server prepared for the switch may switch"
        );
        let calls = std::cell::Cell::new(0);
        let state = || {
            calls.set(calls.get() + 1);
            Ok("active||active".to_string())
        };
        let e = check_with(|| Ok(Some("offline-only".into())), state).unwrap_err();
        assert_eq!(e.reason, "ALREADY_SWITCHED");
        assert_eq!(
            calls.get(),
            0,
            "the fence is never contacted for an offline-only server"
        );
        assert!(check_with(|| Ok(Some("cloud".into())), state).is_ok());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn an_unreadable_or_missing_config_refuses_and_never_contacts_the_fence() {
        let state = || -> R<String> { panic!("the fence must not be contacted") };
        for m in [
            Err("corrupt".to_string()),
            Ok(None),
            Ok(Some(String::new())),
            Ok(Some("weird".to_string())),
        ] {
            let e = check_with(|| m, state).unwrap_err();
            assert_eq!(e.reason, "ALREADY_SWITCHED");
        }
    }

    #[test]
    fn already_switched_refuses_when_cloud_is_moved() {
        for ok in [
            "active||active",
            "frozen|op1|frozen",
            "draining|op1|draining",
        ] {
            assert!(refuse_if_switched("cloud", Some(ok)).is_ok(), "{ok}");
        }
        let e = refuse_if_switched("cloud", Some("moved|op1|moved")).unwrap_err();
        assert_eq!(e.reason, "ALREADY_SWITCHED");
    }

    #[test]
    fn an_unexpected_cloud_state_refuses() {
        for bad in ["released|op1|active", "", "weird||x", "moved"] {
            assert!(refuse_if_switched("cloud", Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_missing_fence_row_says_so() {
        let e = refuse_if_switched("cloud", Some("")).unwrap_err();
        assert_eq!(e.reason, "CLOUD_FENCE_MISSING");
        assert!(e.message.contains("fence"), "{}", e.message);
        let e = refuse_if_switched("cloud", Some("released|op1|active")).unwrap_err();
        assert_eq!(e.reason, "ALREADY_SWITCHED");
    }

    /// T12 control 7: the unknown-mode refusal. Mutation: the default arm of `refuse_if_switched` becomes `{}`.
    /// The pinned test then reaches the fence, which it forbids.
    #[test]
    fn control_refuse_default_arm_is_pinned() {
        use crate::switch::mutants::{expect_red, M};
        expect_red(
            M::RefuseDefaultArmOpen,
            "the fence must not be contacted",
            an_unreadable_or_missing_config_refuses_and_never_contacts_the_fence,
        );
    }
}
