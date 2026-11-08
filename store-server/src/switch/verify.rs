//! Is the clone the cloud's data? After the load and the re-derive, every copied table must carry the cloud's rows (compared by
//! fingerprint over the columns both sides have, without the columns the switch rewrites on purpose), the structure must still
//! fit, owned sequences must not lag behind their data, and the tables that stay local must not have been copied.
//! The two sides are closures that run one SQL text and return psql's output, so the cloud (`CloudDb`) and the local server
//! (`PsqlAdmin`) fit the same code.
use crate::backup::rederive::TOKEN_COLUMNS;
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use crate::switch::mutants::{on as mutant_on, M};
use crate::switch::sig::{self, SchemaSig};
use crate::switch::tables::{ident_ok, valid_table, SKIP_COPY};
use std::collections::BTreeMap;

pub const FINGERPRINT_MISMATCH: &str = "FINGERPRINT_MISMATCH";
pub const STRUCTURE_MISMATCH: &str = "STRUCTURE_MISMATCH";
pub const SEQUENCE_BEHIND: &str = "SEQUENCE_BEHIND";
pub const COPIED_LOCAL_ONLY_TABLE: &str = "COPIED_LOCAL_ONLY_TABLE";

/// One thing the verification found wrong. `detail` names tables, columns and counts; never a value from a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub code: &'static str,
    pub detail: String,
}

/// Columns a fingerprint ignores because the cloud keeps changing them or the switch rewrites them on purpose: `auth.users` gets new
/// passwords (and a new `updated_at`) and both GoTrue tables record sign-ins, so the cloud drifts after the dump.
pub fn fp_volatile(table: &str) -> Vec<&'static str> {
    if mutant_on(M::VolatileEmpty) {
        return vec![];
    }
    match table {
        "auth.users" => vec!["encrypted_password", "updated_at", "last_sign_in_at"],
        "auth.identities" => vec!["last_sign_in_at", "updated_at"],
        _ => vec![],
    }
}

/// GoTrue token columns: the clone blanks a NULL to `''`, so a NULL on the cloud side is fingerprinted as `''` (a real token
/// value still counts).
pub fn fp_blank_null(table: &str) -> Vec<&'static str> {
    if mutant_on(M::BlankNullOff) {
        return vec![];
    }
    if table == "auth.users" {
        TOKEN_COLUMNS.to_vec()
    } else {
        vec![]
    }
}

fn unsafe_name(what: &str) -> OpError {
    OpError::new(
        OpCode::Precondition,
        "TABLE_NAME_UNSAFE",
        format!("{what} outside lower-case letters, digits and underscore was found"),
    )
}

/// `count|md5` of the table's rows over `cols` minus the volatile ones. Row order does not matter. `filter` is a SQL condition
/// built by this crate (tests narrow a table to their own rows); the public entry point passes `true`.
pub(crate) fn fingerprint_sql_where(table: &str, cols: &[String], filter: &str) -> R<String> {
    if !valid_table(table) {
        return Err(unsafe_name("a table name"));
    }
    if cols.iter().any(|c| !ident_ok(c)) {
        return Err(unsafe_name("a column name"));
    }
    let vol = fp_volatile(table);
    let keep: Vec<String> = cols
        .iter()
        .filter(|c| !vol.contains(&c.as_str()))
        .map(|c| format!("'{c}'"))
        .collect();
    if keep.is_empty() {
        return Err(OpError::err(
            "FINGERPRINT_NO_COLUMNS",
            "a table has no column to fingerprint",
        ));
    }
    let list = keep.join(", ");
    let blank = fp_blank_null(table)
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let value = if blank.is_empty() {
        "e.value".to_string()
    } else {
        format!("CASE WHEN e.key = ANY(ARRAY[{blank}]) AND e.value = 'null'::jsonb THEN '\"\"'::jsonb ELSE e.value END")
    };
    // the session settings pin every output format (time zone, float digits, bytea, interval) so the two servers print alike;
    // LOCAL keeps them inside the statement's transaction (also inside the cloud's read-only one)
    Ok(format!(
        "{}SELECT count(*)::text || '|' || coalesce(md5(string_agg(h, '' ORDER BY h COLLATE \"C\")), '') FROM \
         (SELECT md5((SELECT jsonb_object_agg(e.key, {value}) FROM jsonb_each(to_jsonb(t)) e WHERE e.key = ANY(ARRAY[{list}]))::text) AS h \
         FROM {table} t WHERE {filter}) s",
        crate::backup::pg::session_settings(true)
    ))
}

pub fn fingerprint_sql(table: &str, cols: &[String]) -> R<String> {
    fingerprint_sql_where(table, cols, "true")
}

/// Tables whose fingerprint is missing on the clone or differs.
pub fn compare_fingerprints(
    src: &BTreeMap<String, String>,
    dst: &BTreeMap<String, String>,
) -> Vec<String> {
    src.iter()
        .filter(|(t, fp)| dst.get(*t) != Some(*fp))
        .map(|(t, _)| t.clone())
        .collect()
}

/// One row per sequence owned by a column of a public table: `schema.sequence|last_value|is_called|max(column)`. A value that cannot
/// be read comes back as `?`, which `sequence_findings` rejects (a row is never silently dropped). Increment 1 is assumed (every
/// sequence in this schema is a serial or identity column).
pub fn sequence_check_sql() -> &'static str {
    "SELECT sn.nspname || '.' || s.relname || '|' || \
     coalesce((xpath('/row/lv/text()', query_to_xml(format('SELECT last_value AS lv FROM %I.%I', sn.nspname, s.relname), false, true, '')))[1]::text, '?') || '|' || \
     coalesce((xpath('/row/ic/text()', query_to_xml(format('SELECT is_called AS ic FROM %I.%I', sn.nspname, s.relname), false, true, '')))[1]::text, '?') || '|' || \
     coalesce((xpath('/row/m/text()', query_to_xml(format('SELECT coalesce(max(%I), 0) AS m FROM %I.%I', a.attname, tn.nspname, t.relname), false, true, '')))[1]::text, '?') \
     FROM pg_class s JOIN pg_namespace sn ON sn.oid = s.relnamespace \
     JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') \
     JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace \
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
     WHERE s.relkind = 'S' AND tn.nspname = 'public' ORDER BY 1"
}

/// A sequence whose NEXT value would not be above the largest value in its column would hand out a duplicate key: with
/// `is_called` the next value is `last_value + 1`, without it `last_value` itself (so `setval(s, max + 1, false)` is fine and
/// a never-called sequence over existing ids is not). A line that does not parse is an error (a verification that cannot read
/// its own answer must not pass).
pub fn sequence_findings(out: &str) -> R<Vec<Finding>> {
    let mut v = vec![];
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let p: Vec<&str> = l.split('|').collect();
        let parsed = match p.as_slice() {
            [_, last, called @ ("true" | "false"), max] => last
                .parse::<i64>()
                .ok()
                .zip(max.parse::<i64>().ok())
                .map(|(l, m)| (l, *called == "true", m)),
            _ => None,
        };
        let Some((last, called, max)) = parsed else {
            return Err(OpError::err(
                "SEQUENCE_CHECK_UNREADABLE",
                "the sequence check returned a line that cannot be read",
            ));
        };
        let next = if called { last.saturating_add(1) } else { last };
        if next <= max && !(mutant_on(M::SequenceBoundary) && next == max) {
            v.push(Finding {
                code: SEQUENCE_BEHIND,
                detail: format!(
                    "{} would next hand out {next} but its column holds {max}",
                    p[0]
                ),
            });
        }
    }
    Ok(v)
}

/// A table that must stay local was copied: the source has rows and the clone's fingerprint is the source's.
pub fn copied_local_only(table: &str, src_fp: &str, dst_fp: &str) -> Option<Finding> {
    let rows = src_fp
        .split('|')
        .next()
        .and_then(|n| n.parse::<u64>().ok())?;
    (rows > 0 && src_fp == dst_fp).then(|| Finding {
        code: COPIED_LOCAL_ONLY_TABLE,
        detail: format!("{table} holds the cloud's {rows} row(s) but must stay local"),
    })
}

fn sig_of(run: &dyn Fn(&str) -> R<String>) -> R<SchemaSig> {
    Ok(sig::parse_sig(
        &run(sig::SQL_COLUMNS)?,
        &run(sig::SQL_ENUMS)?,
        &run(sig::SQL_CHECKS)?,
    ))
}

/// Runs every check against the clone. `copy` is the copy list (`schema.table`). Findings are returned, never raised: the
/// caller decides (the switch fails and rolls back on any).
pub fn verify_clone(
    src: &dyn Fn(&str) -> R<String>,
    dst: &dyn Fn(&str) -> R<String>,
    copy: &[String],
) -> R<Vec<Finding>> {
    let (s, d) = (sig_of(src)?, sig_of(dst)?);
    let mut out: Vec<Finding> = sig::compare(&s, &d)
        .into_iter()
        .map(|detail| Finding {
            code: STRUCTURE_MISMATCH,
            detail,
        })
        .collect();
    // the fingerprint SQL starts with `SET LOCAL ...`: it must travel as ONE `-c` string (one implicit transaction), never `-f`/stdin
    let fp = |run: &dyn Fn(&str) -> R<String>, t: &str| -> R<String> {
        run(&fingerprint_sql(t, &sig::common_columns(&s, &d, t))?)
    };
    let (mut a, mut b) = (BTreeMap::new(), BTreeMap::new());
    for t in copy {
        if sig::common_columns(&s, &d, t).is_empty() {
            out.push(Finding {
                code: STRUCTURE_MISMATCH,
                detail: format!(
                    "{t}: no column exists on both sides, so its rows cannot be compared"
                ),
            });
            continue;
        }
        a.insert(t.clone(), fp(src, t)?);
        b.insert(t.clone(), fp(dst, t)?);
    }
    out.extend(compare_fingerprints(&a, &b).into_iter().map(|t| Finding {
        code: FINGERPRINT_MISMATCH,
        detail: format!("{t}: the clone's rows differ from the cloud's"),
    }));
    if !mutant_on(M::SequenceCheckDeleted) {
        out.extend(sequence_findings(&dst(sequence_check_sql())?)?);
    }
    for name in SKIP_COPY {
        if name == "till_sync_report" && mutant_on(M::SkipCopyLosesTillSyncReport) {
            continue;
        }
        let t = format!("public.{name}");
        if sig::common_columns(&s, &d, &t).is_empty() {
            continue;
        }
        out.extend(copied_local_only(&t, &fp(src, &t)?, &fp(dst, &t)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    const USER_COLS: [&str; 3] = ["id", "email", "encrypted_password"];

    #[test]
    fn fingerprint_reads_a_null_token_as_empty_and_ignores_the_password_columns() {
        // a NULL token on the cloud side must equal the clone's '': the columns are compared through a NULL-to-'' rule
        let all: Vec<String> = USER_COLS
            .iter()
            .map(|s| s.to_string())
            .chain(TOKEN_COLUMNS.iter().map(|s| s.to_string()))
            .collect();
        let sql = fingerprint_sql("auth.users", &all).unwrap();
        assert!(
            sql.contains("e.value = 'null'::jsonb THEN '\"\"'::jsonb"),
            "{sql}"
        );
        for c in TOKEN_COLUMNS {
            assert!(
                sql.matches(&format!("'{c}'")).count() == 2,
                "{c}: in the list and in the NULL rule"
            );
        }
        for c in ["encrypted_password", "updated_at", "last_sign_in_at"] {
            assert!(
                !sql.contains(&format!("'{c}'")),
                "{c} must not be fingerprinted"
            );
        }
        assert!(sql.contains("'id'") && sql.contains("'email'"));
        let other = fingerprint_sql("public.profiles", &cols(&["id", "updated_at"])).unwrap();
        assert!(
            other.contains("'updated_at'") && !other.contains("CASE WHEN"),
            "only auth.users has volatile or NULL-blanked columns"
        );
    }

    #[test]
    fn names_are_validated_before_they_reach_sql() {
        assert!(fingerprint_sql("public.x; drop", &cols(&["id"])).is_err());
        assert!(fingerprint_sql("public.x", &cols(&["id'; drop"])).is_err());
        assert_eq!(
            fingerprint_sql("auth.users", &cols(&["encrypted_password"]))
                .unwrap_err()
                .reason,
            "FINGERPRINT_NO_COLUMNS"
        );
    }

    #[test]
    fn fingerprints_compare_by_table_and_a_missing_one_is_a_difference() {
        let m = |v: &[(&str, &str)]| -> BTreeMap<String, String> {
            v.iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect()
        };
        let src = m(&[("public.a", "1|x"), ("public.b", "2|y"), ("public.c", "0|")]);
        assert!(compare_fingerprints(&src, &src.clone()).is_empty());
        let dst = m(&[("public.a", "1|x"), ("public.b", "2|z")]);
        assert_eq!(compare_fingerprints(&src, &dst), ["public.b", "public.c"]);
    }

    #[test]
    fn sequence_behind_is_reported() {
        assert!(
            sequence_findings("noise\n").is_err(),
            "an unreadable line is an error"
        );
        assert!(
            sequence_findings("public.a_seq|?|true|3\n").is_err(),
            "a value the query could not read is an error, never skipped"
        );
        let f = sequence_findings(
            "public.a_id_seq|10|true|10\npublic.b_id_seq|3|true|9\npublic.c_id_seq|1|false|0\n",
        )
        .unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].code, SEQUENCE_BEHIND);
        assert!(f[0].detail.contains("b_id_seq") && f[0].detail.contains("holds 9"));
        assert!(
            sequence_check_sql().contains("deptype IN ('a', 'i')"),
            "serial and identity sequences"
        );
    }

    #[test]
    fn a_sequence_reset_just_past_the_data_is_fine_and_a_never_called_one_with_ids_is_not() {
        // setval(s, max + 1, false): the next value is max + 1, not behind
        let ok = sequence_findings("public.a_seq|10|false|9\npublic.b_seq|9|true|9\n").unwrap();
        assert!(ok.is_empty(), "{ok:?}");
        // never called (value 1, is_called false) while the column already holds ids: the next insert would collide
        let bad = sequence_findings("public.c_seq|1|false|100\n").unwrap();
        assert_eq!(bad.len(), 1, "{bad:?}");
        assert_eq!(bad[0].code, SEQUENCE_BEHIND);
        // setval(s, max, false): the next value is max itself
        assert_eq!(
            sequence_findings("public.d_seq|9|false|9\n").unwrap().len(),
            1
        );
    }

    fn sig_lines(extra: &str) -> String {
        format!("public.t|id|bigint|true||false\npublic.t|name|text|false||false\n{extra}")
    }

    /// A stand-in server: answers the signature queries from `cols` and every fingerprint with `fp`.
    fn server(cols: String, fp: &'static str) -> impl Fn(&str) -> R<String> {
        move |sql: &str| {
            Ok(if sql == sig::SQL_COLUMNS {
                cols.clone()
            } else if sql.contains("count(*)::text") {
                fp.to_string()
            } else {
                String::new()
            })
        }
    }

    #[test]
    fn structure_compare_uses_sig_compare() {
        let src = server(sig_lines("public.t|extra|text|false||false\n"), "1|a");
        let dst = server(sig_lines(""), "1|a");
        let f = verify_clone(&src, &dst, &["public.t".to_string()]).unwrap();
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].code, STRUCTURE_MISMATCH);
        assert!(f[0].detail.contains("public.t.extra"), "{f:?}");
        assert!(verify_clone(
            &server(sig_lines(""), "1|a"),
            &dst,
            &["public.t".to_string()]
        )
        .unwrap()
        .is_empty());
        let other = server(sig_lines(""), "1|b");
        let f = verify_clone(&src_same(), &other, &["public.t".to_string()]).unwrap();
        assert_eq!(
            f.iter().map(|x| x.code).collect::<Vec<_>>(),
            [FINGERPRINT_MISMATCH]
        );
    }
    fn src_same() -> impl Fn(&str) -> R<String> {
        server(sig_lines(""), "1|a")
    }

    #[test]
    fn local_only_tables_not_copied() {
        // store_switch_state, till_sync_report and pin_attempts stay local
        for t in SKIP_COPY {
            let name = format!("public.{t}");
            assert!(
                copied_local_only(&name, "3|abc", "3|abc").is_some(),
                "{t}: rows copied"
            );
            assert!(
                copied_local_only(&name, "3|abc", "1|zzz").is_none(),
                "{t}: the clone keeps its own"
            );
            assert!(
                copied_local_only(&name, "0|", "0|").is_none(),
                "{t}: nothing to copy"
            );
        }
        let sig = "public.till_sync_report|id|bigint|true||false\n".to_string();
        let f = verify_clone(&server(sig.clone(), "2|same"), &server(sig, "2|same"), &[]).unwrap();
        assert_eq!(
            f.iter().map(|x| x.code).collect::<Vec<_>>(),
            [COPIED_LOCAL_ONLY_TABLE]
        );
    }

    #[test]
    fn fingerprint_sql_pins_the_session_settings() {
        let sql = fingerprint_sql("public.t", &cols(&["id"])).unwrap();
        assert!(
            sql.starts_with(&crate::backup::pg::session_settings(true)),
            "{sql}"
        );
        assert!(
            sql.contains("SET LOCAL TIME ZONE 'UTC'") && sql.contains("COLLATE \"C\""),
            "{sql}"
        );
    }

    #[test]
    fn verify_clone_reports_a_lagging_sequence() {
        let seq = |sql: &str| -> R<String> {
            Ok(if sql == sequence_check_sql() {
                "public.x_seq|3|true|9\n".to_string()
            } else {
                String::new()
            })
        };
        let ok = |_: &str| -> R<String> { Ok(String::new()) };
        let f = verify_clone(&ok, &seq, &[]).unwrap();
        assert_eq!(
            f.iter().map(|x| x.code).collect::<Vec<_>>(),
            [SEQUENCE_BEHIND],
            "{f:?}"
        );
    }

    #[test]
    fn a_table_missing_on_the_clone_is_a_structure_finding_not_an_error() {
        let src = server(sig_lines(""), "1|a");
        let dst = server(String::new(), "1|a");
        let f = verify_clone(&src, &dst, &["public.t".to_string()]).unwrap();
        assert!(
            f.iter()
                .any(|x| x.code == STRUCTURE_MISMATCH && x.detail.contains("public.t.id")),
            "{f:?}"
        );
        assert!(
            f.iter().all(|x| x.code != FINGERPRINT_MISMATCH),
            "no fingerprint for a table that is not there: {f:?}"
        );
    }

    #[test]
    fn a_copied_table_with_no_common_columns_is_a_structure_finding_itself() {
        // both sides answer with no columns at all: sig::compare has nothing to say, the skip itself must be reported
        let none = server(String::new(), "1|a");
        let f = verify_clone(&none, &none, &["public.t".to_string()]).unwrap();
        assert!(
            f.iter()
                .any(|x| x.code == STRUCTURE_MISMATCH && x.detail.contains("public.t")),
            "{f:?}"
        );
    }

    #[test]
    fn identities_ignore_their_cloud_drift_columns_like_users() {
        let sql = fingerprint_sql(
            "auth.identities",
            &cols(&["id", "last_sign_in_at", "updated_at", "provider"]),
        )
        .unwrap();
        assert!(
            !sql.contains("'last_sign_in_at'") && !sql.contains("'updated_at'"),
            "{sql}"
        );
        assert!(sql.contains("'id'") && sql.contains("'provider'"));
    }

    // T12 negative controls: each arms one mutant (see switch/mutants.rs) and requires the pinning test to go red.

    /// Control 3. Mutation: `verify_clone` skips `till_sync_report` in its local-only loop.
    #[test]
    fn control_local_only_check_is_pinned() {
        use crate::switch::mutants::{expect_red, M};
        expect_red(
            M::SkipCopyLosesTillSyncReport,
            "COPIED_LOCAL_ONLY_TABLE",
            local_only_tables_not_copied,
        );
    }

    /// Control 5. Mutation: the `sequence_findings(&dst(sequence_check_sql())?)?` call in `verify_clone` is not made.
    #[test]
    fn control_sequence_check_wiring_is_pinned() {
        use crate::switch::mutants::{expect_red, M};
        expect_red(
            M::SequenceCheckDeleted,
            "SEQUENCE_BEHIND",
            verify_clone_reports_a_lagging_sequence,
        );
    }

    /// Control 8. Mutation: `next <= max` becomes `next < max` in `sequence_findings`.
    #[test]
    fn control_sequence_boundary_is_pinned() {
        use crate::switch::mutants::{expect_red, M};
        expect_red(
            M::SequenceBoundary,
            "left: 0",
            a_sequence_reset_just_past_the_data_is_fine_and_a_never_called_one_with_ids_is_not,
        );
    }
}
