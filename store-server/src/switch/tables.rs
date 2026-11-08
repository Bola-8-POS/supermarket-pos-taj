//! Which tables move. Default is COPY; three public tables are never copied (the lock table, and the two that carry
//! the fence itself); the explicit TRUNCATE list is the copy list plus the GoTrue/storage tables that reference it.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use std::collections::BTreeSet;

pub const SKIP_COPY: [&str; 3] = ["pin_attempts", "store_switch_state", "till_sync_report"];
pub const KEEP_LOCAL: [&str; 2] = ["store_switch_state", "till_sync_report"];
/// Not copied, but emptied locally (lock keys of the installer's staff mean nothing for the cloud's).
pub const TRUNCATE_ONLY: [&str; 1] = ["public.pin_attempts"];
pub const EXTRA_COPY: [&str; 4] = [
    "auth.users",
    "auth.identities",
    "storage.buckets",
    "storage.objects",
];

pub const SQL_PUBLIC_TABLES: &str = "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1";

pub(crate) fn ident_ok(s: &str) -> bool {
    let mut ch = s.chars();
    matches!(ch.next(), Some(c) if c.is_ascii_lowercase() || c == '_')
        && s.len() <= 63
        && ch.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
/// `schema.table`, lower-case snake only: the only shape that is ever put into SQL text.
pub fn valid_table(t: &str) -> bool {
    let mut p = t.split('.');
    matches!((p.next(), p.next(), p.next()), (Some(s), Some(n), None) if ident_ok(s) && ident_ok(n))
}

pub fn copy_tables(public: &[String]) -> Vec<String> {
    let mut v: Vec<String> = public
        .iter()
        .filter(|t| !SKIP_COPY.contains(&t.as_str()))
        .map(|t| format!("public.{t}"))
        .collect();
    v.sort();
    v.extend(EXTRA_COPY.iter().map(|s| s.to_string()));
    v
}

/// `regclass::text` omits `public.` for tables on the search path.
pub fn normalize_regclass(s: &str) -> String {
    if s.contains('.') {
        s.to_string()
    } else {
        format!("public.{s}")
    }
}

fn checked(list: &[String]) -> R<()> {
    match list.iter().find(|t| !valid_table(t)) {
        Some(_) => Err(OpError::new(
            OpCode::Precondition,
            "TABLE_NAME_UNSAFE",
            "a table name outside lower-case letters, digits and underscore was found",
        )),
        None => Ok(()),
    }
}

/// Every table that references (transitively) one of the copy tables, copy tables included.
pub fn closure_sql(copy: &[String]) -> R<String> {
    checked(copy)?;
    let array = copy
        .iter()
        .map(|t| format!("'{t}'::regclass"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("WITH RECURSIVE refs(oid) AS (SELECT unnest(ARRAY[{array}]::oid[]) UNION SELECT c.conrelid FROM pg_constraint c JOIN refs r ON c.confrelid = r.oid WHERE c.contype = 'f') \
                SELECT oid::regclass::text FROM refs ORDER BY 1"))
}

/// (allowed extras, unexpected extras). GoTrue and storage tables that reference the copied ones are disposable state
/// (sessions, tokens, uploads); a PUBLIC table outside the list is business data and must never be emptied blind.
pub fn classify_closure(copy: &[String], closure: &[String]) -> (Vec<String>, Vec<String>) {
    let copy_set: BTreeSet<&str> = copy.iter().map(String::as_str).collect();
    let (mut allowed, mut unexpected) = (BTreeSet::new(), BTreeSet::new());
    for raw in closure {
        let t = normalize_regclass(raw);
        if copy_set.contains(t.as_str()) {
            continue;
        }
        if t.starts_with("auth.") || t.starts_with("storage.") {
            allowed.insert(t);
        } else {
            unexpected.insert(t);
        }
    }
    (
        allowed.into_iter().collect(),
        unexpected.into_iter().collect(),
    )
}

pub fn truncate_list(copy: &[String], allowed_extra: &[String]) -> R<Vec<String>> {
    checked(copy)?;
    checked(allowed_extra)?;
    let mut all: BTreeSet<String> = copy.iter().cloned().collect();
    all.extend(allowed_extra.iter().cloned());
    all.extend(TRUNCATE_ONLY.iter().map(|s| s.to_string()));
    Ok(all.into_iter().collect())
}

/// No CASCADE: PostgreSQL itself refuses if a table that references the list is missing from it.
pub fn truncate_sql(list: &[String]) -> String {
    format!("TRUNCATE TABLE {} RESTART IDENTITY", list.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public() -> Vec<String> {
        [
            "products",
            "profiles",
            "pin_attempts",
            "store_switch_state",
            "till_sync_report",
            "rpc_idempotency",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn copy_is_everything_public_except_the_skip_list_plus_the_four_auth_and_storage_tables() {
        let c = copy_tables(&public());
        assert_eq!(
            &c[..3],
            [
                "public.products".to_string(),
                "public.profiles".to_string(),
                "public.rpc_idempotency".to_string()
            ]
        );
        for t in [
            "auth.users",
            "auth.identities",
            "storage.buckets",
            "storage.objects",
        ] {
            assert!(c.contains(&t.to_string()), "{t}");
        }
        for t in [
            "public.pin_attempts",
            "public.store_switch_state",
            "public.till_sync_report",
        ] {
            assert!(!c.contains(&t.to_string()), "{t}");
        }
        assert!(
            c.contains(&"public.rpc_idempotency".to_string()),
            "the idempotency ledger is copied verbatim"
        );
        assert!(
            !c.iter().any(|t| t.contains("schema_migrations")),
            "the migration ledger is never copied"
        );
    }

    #[test]
    fn names_are_validated_before_they_reach_sql() {
        for ok in ["public.products", "auth.users", "storage.objects"] {
            assert!(valid_table(ok), "{ok}");
        }
        for bad in [
            "products",
            "public.Products",
            "public.a-b",
            "public.a b",
            "public.a;drop",
            "a.b.c",
            "public.",
            ".x",
            "public.\"x\"",
        ] {
            assert!(!valid_table(bad), "{bad}");
        }
        assert!(closure_sql(&["public.x;drop table y".to_string()]).is_err());
    }

    #[test]
    fn the_closure_query_is_built_from_the_copy_list() {
        let sql = closure_sql(&["public.products".to_string(), "auth.users".to_string()]).unwrap();
        assert!(sql.contains("ARRAY['public.products'::regclass, 'auth.users'::regclass]"));
        assert!(sql.contains("WITH RECURSIVE"));
    }

    #[test]
    fn auth_and_storage_tables_that_reference_the_copied_ones_are_allowed_extras_public_ones_are_not(
    ) {
        let copy = copy_tables(&public());
        let closure: Vec<String> = [
            "auth.users",
            "auth.sessions",
            "auth.refresh_tokens",
            "storage.s3_multipart_uploads",
            "products",
            "orders",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (allowed, unexpected) = classify_closure(&copy, &closure);
        assert_eq!(
            allowed,
            vec![
                "auth.refresh_tokens".to_string(),
                "auth.sessions".to_string(),
                "storage.s3_multipart_uploads".to_string()
            ]
        );
        assert_eq!(
            unexpected,
            vec!["public.orders".to_string()],
            "a public table outside the list would be truncated blind"
        );
    }

    #[test]
    fn truncate_never_cascades_and_lists_copy_extras_and_the_lock_table() {
        let copy = copy_tables(&public());
        let list = truncate_list(&copy, &["auth.sessions".to_string()]).unwrap();
        assert!(
            list.contains(&"public.pin_attempts".to_string()),
            "stale lock keys are cleared locally"
        );
        assert!(
            !list.contains(&"public.store_switch_state".to_string())
                && !list.contains(&"public.till_sync_report".to_string())
        );
        let sql = truncate_sql(&list);
        assert!(
            sql.starts_with("TRUNCATE TABLE ")
                && sql.ends_with(" RESTART IDENTITY")
                && !sql.to_uppercase().contains("CASCADE")
        );
        assert!(truncate_list(&["public.x;y".to_string()], &[]).is_err());
    }
}
