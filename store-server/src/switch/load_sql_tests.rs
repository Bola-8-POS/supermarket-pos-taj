//! Real-Postgres checks of the load helpers (cargo feature `fence-db-tests`, run only through tests/support/run-fence-db-tests.ps1).
//! `postgres` is the local server of the throwaway instance. Each test undoes its own rows.
use crate::switch::load::repair_tokens_sql;
use crate::switch::testkit::{admin, LOCAL};

/// Runs on drop: the fixture is put back whatever an assertion did.
struct Undo(Vec<String>);
impl Drop for Undo {
    fn drop(&mut self) {
        for s in self.0.iter().rev() {
            let _ = admin().exec(LOCAL, s);
        }
    }
}

#[test]
fn token_repair_turns_null_into_empty_string() {
    let a = admin();
    let id = "00000000-0000-4000-8000-0000000000a1";
    let _undo = Undo(vec![format!("DELETE FROM auth.users WHERE id = '{id}'")]);
    a.exec(
        LOCAL,
        &format!("INSERT INTO auth.users (id, email) VALUES ('{id}', 'zz-load@example.invalid')"),
    )
    .unwrap();
    a.exec(LOCAL, &format!("UPDATE auth.users SET confirmation_token = NULL, recovery_token = NULL, email_change_token_new = NULL, email_change_token_current = NULL, email_change = NULL, reauthentication_token = NULL, phone_change_token = NULL WHERE id = '{id}'")).unwrap();
    let nulls = "SELECT count(*) FROM auth.users WHERE confirmation_token IS NULL OR recovery_token IS NULL OR email_change_token_new IS NULL OR email_change_token_current IS NULL OR email_change IS NULL OR reauthentication_token IS NULL OR phone_change_token IS NULL";
    assert_eq!(
        a.scalar(LOCAL, nulls).unwrap(),
        "1",
        "the control: the seeded row has NULL tokens"
    );
    a.exec(LOCAL, &repair_tokens_sql()).unwrap();
    assert_eq!(a.scalar(LOCAL, nulls).unwrap(), "0");
}
