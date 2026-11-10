//! Real-Postgres checks of the staff-account step (cargo feature `fence-db-tests`, run only through tests/support/run-fence-db-tests.ps1).
//! `postgres` is the local server of the throwaway instance. Each test puts `auth.users` back whatever an assertion did.
use crate::staff_password::derive_staff_password;
use crate::switch::rederive::{admin_rows_sql, apply, check_pin, parse_admin_rows, Proof};
use crate::switch::testkit::{admin, LOCAL};

const PEPPER: &str = "test-pepper-not-secret-0123456789abcdef";
const ORPHAN: &str = "00000000-0000-4000-8000-0000000d0b01";
const KEPT_ORPHAN: &str = "00000000-0000-4000-8000-0000000d0b02";
const ADMIN: &str = "00000000-0000-4000-8000-0000000d0a01";
const PIN: &str = "123456";

/// Saves every credential first; on drop puts them back and removes the fixture rows.
struct Undo;
impl Undo {
    fn new() -> Undo {
        let a = admin();
        a.exec(
            LOCAL,
            "DROP SCHEMA IF EXISTS zz_rederive CASCADE; CREATE SCHEMA zz_rederive; \
             CREATE TABLE zz_rederive.u AS SELECT id, encrypted_password, updated_at FROM auth.users",
        )
        .unwrap();
        // one staff admin whose stored credential is the password derived with PEPPER (the trigger hashes the PIN)
        let pw = derive_staff_password(ADMIN, PIN, PEPPER).unwrap();
        a.exec(
            LOCAL,
            &format!(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES ('{ADMIN}', 'zz-admin@example.invalid', extensions.crypt('{pw}', extensions.gen_salt('bf', 8))); \
                 INSERT INTO public.profiles (id, name, role, pin) VALUES ('{ADMIN}', 'zz admin', 'admin', '{PIN}'); \
                 INSERT INTO zz_rederive.u SELECT id, encrypted_password, updated_at FROM auth.users WHERE id = '{ADMIN}'"
            ),
        )
        .unwrap();
        Undo
    }
}
impl Drop for Undo {
    fn drop(&mut self) {
        let _ = admin().exec(
            LOCAL,
            &format!(
                "DELETE FROM public.profiles WHERE id = '{ADMIN}'; DELETE FROM auth.users WHERE id IN ('{ORPHAN}', '{KEPT_ORPHAN}', '{ADMIN}'); \
                 UPDATE auth.users u SET encrypted_password = b.encrypted_password, updated_at = b.updated_at FROM zz_rederive.u b WHERE b.id = u.id; \
                 DROP SCHEMA zz_rederive CASCADE"
            ),
        );
    }
}

fn one(sql: &str) -> String {
    admin().scalar(LOCAL, sql).unwrap()
}

#[test]
pub(super) fn the_admin_pin_proof_matches_the_derived_credential_and_names_what_is_wrong() {
    let _undo = Undo::new();
    let rows = parse_admin_rows(&one(&admin_rows_sql(&[]).unwrap())).unwrap();
    assert_eq!(check_pin(&admin(), &rows, PEPPER, PIN).unwrap(), Proof::Match(ADMIN.to_string()), "the right PIN and the cloud's pepper");
    assert_eq!(check_pin(&admin(), &rows, "another-pepper-not-secret-0123456789abcd", PIN).unwrap(), Proof::WrongPepper, "the control: another pepper does not verify");
    assert_eq!(check_pin(&admin(), &rows, PEPPER, "654321").unwrap(), Proof::WrongPin, "the control: another PIN does not match the stored hash");
}

#[test]
pub(super) fn kept_accounts_are_untouched_and_an_account_without_a_profile_is_scrambled() {
    let _undo = Undo::new();
    let a = admin();
    for id in [ORPHAN, KEPT_ORPHAN] {
        a.exec(LOCAL, &format!("INSERT INTO auth.users (id, email, encrypted_password) VALUES ('{id}', 'zz-{id}@example.invalid', 'hosted-hash')")).unwrap();
    }
    let r = apply(&a, LOCAL, &[KEPT_ORPHAN.to_string()]).unwrap();
    assert_eq!(
        one(&format!("SELECT count(*) FROM auth.users u JOIN zz_rederive.u b USING (id) WHERE u.id = '{ADMIN}' AND u.encrypted_password = b.encrypted_password")),
        "1",
        "a staff account keeps its copied credential"
    );
    assert_eq!(one(&format!("SELECT encrypted_password FROM auth.users WHERE id = '{KEPT_ORPHAN}'")), "hosted-hash", "keep set row count differs");
    assert_eq!(
        one(&format!("SELECT (encrypted_password <> 'hosted-hash' AND confirmation_token = '') FROM auth.users WHERE id = '{ORPHAN}'")),
        "t",
        "the orphan has an unknown password and its token columns are repaired"
    );
    // last, so a mutant that removes a step is caught by the state assertion that names it (not by the count of the step it removed)
    assert!(r.scrambled >= 1 && r.rows >= 1, "{r:?}");
}
