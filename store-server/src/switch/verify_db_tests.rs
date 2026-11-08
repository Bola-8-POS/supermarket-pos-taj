//! Real-Postgres checks of the clone verification (cargo feature `fence-db-tests`, run only through tests/support/run-fence-db-tests.ps1).
//! `cloud_src` is the test "cloud", `postgres` the local server. Each test undoes its own rows.
use crate::switch::sig::{self, SchemaSig};
use crate::switch::testkit::{admin, CLOUD, LOCAL};
use crate::switch::verify::{
    fingerprint_sql_where, sequence_check_sql, sequence_findings, SEQUENCE_BEHIND,
};

const USER: &str = "00000000-0000-4000-8000-0000000f0a01";

/// Runs on drop: the fixture is put back whatever an assertion did.
struct Undo(Vec<(&'static str, String)>);
impl Drop for Undo {
    fn drop(&mut self) {
        for (db, s) in self.0.iter().rev() {
            let _ = admin().exec(db, s);
        }
    }
}

fn sig_of(db: &str) -> SchemaSig {
    let a = admin();
    sig::parse_sig(
        &a.scalar(db, sig::SQL_COLUMNS).unwrap(),
        &a.scalar(db, sig::SQL_ENUMS).unwrap(),
        &a.scalar(db, sig::SQL_CHECKS).unwrap(),
    )
}

#[test]
pub(super) fn null_token_cloud_row_matches_blanked_clone() {
    let a = admin();
    let del = format!("DELETE FROM auth.users WHERE id = '{USER}'");
    let _undo = Undo(vec![(CLOUD, del.clone()), (LOCAL, del)]);
    // the cloud row carries NULL tokens and its own password; the clone has the blanked tokens and a re-derived password
    a.exec(CLOUD, &format!("INSERT INTO auth.users (id, email, encrypted_password) VALUES ('{USER}', 'zz-verify@example.invalid', 'cloud-hash')")).unwrap();
    a.exec(CLOUD, &format!("UPDATE auth.users SET confirmation_token = NULL, recovery_token = NULL, email_change_token_new = NULL, email_change_token_current = NULL, email_change = NULL, reauthentication_token = NULL, phone_change_token = NULL WHERE id = '{USER}'")).unwrap();
    a.exec(LOCAL, &format!("INSERT INTO auth.users (id, email, encrypted_password, confirmation_token, recovery_token, email_change_token_new, email_change_token_current, email_change, reauthentication_token, phone_change_token) VALUES ('{USER}', 'zz-verify@example.invalid', 'local-derived-hash', '', '', '', '', '', '', '')")).unwrap();
    let (s, d) = (sig_of(CLOUD), sig_of(LOCAL));
    let cols = sig::common_columns(&s, &d, "auth.users");
    assert!(
        cols.contains(&"confirmation_token".to_string()),
        "the control: the token columns exist on both sides"
    );
    let sql = fingerprint_sql_where("auth.users", &cols, &format!("id = '{USER}'")).unwrap();
    let (fc, fl) = (
        a.scalar(CLOUD, &sql).unwrap(),
        a.scalar(LOCAL, &sql).unwrap(),
    );
    assert!(fc.starts_with("1|"), "{fc}");
    assert_eq!(
        fc, fl,
        "NULL tokens and a different password are not a mismatch"
    );
    // the control: a REAL token that differs is detected (NULL equals '' but 'abc' does not equal '')
    a.exec(
        CLOUD,
        &format!("UPDATE auth.users SET recovery_token = 'abc' WHERE id = '{USER}'"),
    )
    .unwrap();
    assert_ne!(
        a.scalar(CLOUD, &sql).unwrap(),
        fl,
        "a real differing token is a mismatch"
    );
    a.exec(
        CLOUD,
        &format!("UPDATE auth.users SET recovery_token = NULL WHERE id = '{USER}'"),
    )
    .unwrap();
    a.exec(
        LOCAL,
        &format!("UPDATE auth.users SET email = 'zz-other@example.invalid' WHERE id = '{USER}'"),
    )
    .unwrap();
    assert_ne!(
        fc,
        a.scalar(LOCAL, &sql).unwrap(),
        "the control: a changed e-mail is a mismatch"
    );
}

#[test]
fn sequence_behind_is_reported() {
    let a = admin();
    let _undo = Undo(vec![(LOCAL, "DROP TABLE IF EXISTS public.zz_seq_t".into())]);
    a.exec(LOCAL, "DROP TABLE IF EXISTS public.zz_seq_t; CREATE TABLE public.zz_seq_t (id bigserial PRIMARY KEY); INSERT INTO public.zz_seq_t (id) VALUES (100)").unwrap();
    let mine = |out: &str| {
        sequence_findings(out)
            .unwrap()
            .into_iter()
            .filter(|f| f.detail.contains("zz_seq_t"))
            .collect::<Vec<_>>()
    };
    let f = mine(&a.scalar(LOCAL, sequence_check_sql()).unwrap());
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].code, SEQUENCE_BEHIND);
    a.exec(LOCAL, "SELECT setval('public.zz_seq_t_id_seq', 100)")
        .unwrap();
    assert!(
        mine(&a.scalar(LOCAL, sequence_check_sql()).unwrap()).is_empty(),
        "caught up"
    );
}

#[test]
fn a_non_utc_cloud_timezone_does_not_change_fingerprints() {
    let a = admin();
    let id = "00000000-0000-4000-8000-0000000f0a02";
    let del = format!("DELETE FROM auth.users WHERE id = '{id}'");
    let _undo = Undo(vec![
        (CLOUD, del.clone()),
        (LOCAL, del),
        (
            "postgres",
            "ALTER DATABASE cloud_src RESET timezone".to_string(),
        ),
    ]);
    let ins = format!("INSERT INTO auth.users (id, email, encrypted_password, created_at) VALUES ('{id}', 'zz-tz@example.invalid', 'x', '2026-01-01 00:00:00+00')");
    a.exec(CLOUD, &ins).unwrap();
    a.exec(LOCAL, &ins).unwrap();
    a.exec(
        "postgres",
        "ALTER DATABASE cloud_src SET timezone = 'America/Mexico_City'",
    )
    .unwrap();
    let cols = sig::common_columns(&sig_of(CLOUD), &sig_of(LOCAL), "auth.users");
    let sql = fingerprint_sql_where("auth.users", &cols, &format!("id = '{id}'")).unwrap();
    assert_eq!(
        a.scalar(CLOUD, &sql).unwrap(),
        a.scalar(LOCAL, &sql).unwrap(),
        "the pinned session settings make a non-UTC cloud print like the local server"
    );
    let bare = sql.replace(&crate::backup::pg::session_settings(true), "");
    assert_ne!(
        a.scalar(CLOUD, &bare).unwrap(),
        a.scalar(LOCAL, &bare).unwrap(),
        "the control: without the settings the two time zones differ"
    );
}
