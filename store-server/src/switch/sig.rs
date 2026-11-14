//! Does the cloud's data fit this server's schema? Public tables must match exactly; for the GoTrue and storage tables
//! the cloud's columns must exist here with the same type, and extra columns here must be fillable by default (pg_dump's
//! COPY names its columns, so a newer GoTrue on this side is fine and an older one is not).
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Col {
    pub table: String,
    pub name: String,
    pub ty: String,
    pub not_null: bool,
    pub generated: String,
    pub has_default: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SchemaSig {
    pub cols: Vec<Col>,
    pub enums: Vec<String>,
    pub checks: Vec<String>,
}

pub const SQL_COLUMNS: &str = "SELECT n.nspname || '.' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attgenerated::text || '|' || a.atthasdef::text \
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' \
      AND (n.nspname = 'public' OR (n.nspname = 'auth' AND c.relname IN ('users','identities')) OR (n.nspname = 'storage' AND c.relname IN ('buckets','objects'))) ORDER BY 1";
pub const SQL_ENUMS: &str = "SELECT t.typname || '|' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid \
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY 1";
pub const SQL_CHECKS: &str = "SELECT c.conrelid::regclass::text || '|' || c.conname || '|' || pg_get_constraintdef(c.oid) FROM pg_constraint c \
    JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'c' AND n.nspname = 'public' ORDER BY 1";

fn not_valid_stripped(s: &str) -> String {
    s.strip_suffix(" NOT VALID").unwrap_or(s).to_string()
}

pub fn parse_sig(cols: &str, enums: &str, checks: &str) -> SchemaSig {
    let cols = cols
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('|').collect();
            (p.len() == 6).then(|| Col {
                table: p[0].into(),
                name: p[1].into(),
                ty: p[2].into(),
                not_null: p[3] == "true",
                generated: p[4].into(),
                has_default: p[5] == "true",
            })
        })
        .collect();
    let enums = enums
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    let checks = checks
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(not_valid_stripped)
        .collect();
    SchemaSig {
        cols,
        enums,
        checks,
    }
}

fn by_key(s: &SchemaSig) -> BTreeMap<(String, String), &Col> {
    s.cols
        .iter()
        .map(|c| ((c.table.clone(), c.name.clone()), c))
        .collect()
}

pub fn compare(source: &SchemaSig, local: &SchemaSig) -> Vec<String> {
    let (src, loc) = (by_key(source), by_key(local));
    let mut out: Vec<String> = vec![];
    for (k, s) in &src {
        let name = format!("{}.{}", k.0, k.1);
        let public = k.0.starts_with("public.");
        match loc.get(k) {
            None => out.push(format!("{name}: only in the cloud")),
            Some(l) if s.ty != l.ty => out.push(format!(
                "{name}: type differs ({} in the cloud, {} here)",
                s.ty, l.ty
            )),
            Some(l) if s.generated != l.generated => {
                out.push(format!("{name}: generated-column kind differs"))
            }
            Some(l) if public && s.not_null != l.not_null => {
                out.push(format!("{name}: nullability differs"))
            }
            Some(l) if !public && !s.not_null && l.not_null => {
                out.push(format!("{name}: required here but optional in the cloud"))
            }
            Some(_) => {}
        }
    }
    for (k, l) in &loc {
        if src.contains_key(k) {
            continue;
        }
        let name = format!("{}.{}", k.0, k.1);
        if k.0.starts_with("public.") {
            out.push(format!("{name}: only on this server"));
        } else if l.not_null && !l.has_default && l.generated.is_empty() {
            out.push(format!("{name}: required on this server's GoTrue/storage and the cloud rows cannot fill it"));
        }
    }
    let (a, b): (BTreeSet<&String>, BTreeSet<&String>) =
        (source.enums.iter().collect(), local.enums.iter().collect());
    out.extend(
        a.symmetric_difference(&b)
            .map(|x| format!("enum {x}: differs")),
    );
    let (a, b): (BTreeSet<&String>, BTreeSet<&String>) = (
        source.checks.iter().collect(),
        local.checks.iter().collect(),
    );
    out.extend(
        a.symmetric_difference(&b)
            .map(|x| format!("check {x}: differs")),
    );
    out
}

/// Columns present on both sides, sorted: what a fingerprint may compare.
pub fn common_columns(source: &SchemaSig, local: &SchemaSig, table: &str) -> Vec<String> {
    let s: BTreeSet<&str> = source
        .cols
        .iter()
        .filter(|c| c.table == table)
        .map(|c| c.name.as_str())
        .collect();
    let l: BTreeSet<&str> = local
        .cols
        .iter()
        .filter(|c| c.table == table)
        .map(|c| c.name.as_str())
        .collect();
    s.intersection(&l).map(|x| x.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(t: &str, c: &str, ty: &str, nn: bool, gen: &str, def: bool) -> String {
        format!("{t}|{c}|{ty}|{nn}|{gen}|{def}")
    }
    fn sig(cols: &[String], enums: &[&str], checks: &[&str]) -> SchemaSig {
        parse_sig(&cols.join("\n"), &enums.join("\n"), &checks.join("\n"))
    }
    fn base() -> Vec<String> {
        vec![
            line("public.products", "id", "uuid", true, "", true),
            line(
                "public.products",
                "name",
                "character varying(255)",
                true,
                "",
                false,
            ),
            line("auth.users", "id", "uuid", true, "", false),
            line(
                "auth.users",
                "email",
                "character varying(255)",
                false,
                "",
                false,
            ),
        ]
    }

    #[test]
    fn identical_schemas_have_no_differences() {
        assert!(compare(
            &sig(
                &base(),
                &["order_status|open,paid"],
                &["products|c1|CHECK ((price >= 0))"]
            ),
            &sig(
                &base(),
                &["order_status|open,paid"],
                &["products|c1|CHECK ((price >= 0))"]
            )
        )
        .is_empty());
    }

    #[test]
    fn public_tables_must_match_exactly_in_both_directions() {
        let mut cloud = base();
        cloud.push(line("public.products", "extra", "text", false, "", false));
        let d = compare(&sig(&cloud, &[], &[]), &sig(&base(), &[], &[]));
        assert_eq!(
            d,
            vec!["public.products.extra: only in the cloud".to_string()]
        );
        let d2 = compare(&sig(&base(), &[], &[]), &sig(&cloud, &[], &[]));
        assert_eq!(
            d2,
            vec!["public.products.extra: only on this server".to_string()]
        );
    }

    #[test]
    fn a_type_or_nullability_change_is_a_difference() {
        let mut cloud = base();
        cloud[1] = line("public.products", "name", "text", true, "", false);
        assert!(
            compare(&sig(&cloud, &[], &[]), &sig(&base(), &[], &[]))[0].contains("type differs")
        );
        let mut cloud2 = base();
        cloud2[1] = line(
            "public.products",
            "name",
            "character varying(255)",
            false,
            "",
            false,
        );
        assert!(
            compare(&sig(&cloud2, &[], &[]), &sig(&base(), &[], &[]))[0].contains("nullability")
        );
    }

    #[test]
    fn auth_and_storage_may_have_extra_columns_here_when_they_can_be_left_empty() {
        let mut local = base();
        local.push(line("auth.users", "new_nullable", "text", false, "", false));
        local.push(line("auth.users", "new_defaulted", "text", true, "", true));
        local.push(line(
            "auth.users",
            "new_generated",
            "text",
            true,
            "s",
            false,
        ));
        assert!(compare(&sig(&base(), &[], &[]), &sig(&local, &[], &[])).is_empty());
        let mut strict = base();
        strict.push(line("auth.users", "new_required", "text", true, "", false));
        let d = compare(&sig(&base(), &[], &[]), &sig(&strict, &[], &[]));
        assert!(d[0].contains("auth.users.new_required"), "{d:?}");
    }

    #[test]
    fn a_cloud_column_this_server_lacks_is_a_difference_even_in_auth() {
        let mut cloud = base();
        cloud.push(line(
            "auth.users",
            "newer_gotrue_col",
            "text",
            false,
            "",
            false,
        ));
        let d = compare(&sig(&cloud, &[], &[]), &sig(&base(), &[], &[]));
        assert_eq!(
            d,
            vec!["auth.users.newer_gotrue_col: only in the cloud".to_string()]
        );
    }

    #[test]
    fn enum_labels_and_check_text_must_match_but_not_valid_is_ignored() {
        let d = compare(
            &sig(&base(), &["order_status|open,paid,void"], &[]),
            &sig(&base(), &["order_status|open,paid"], &[]),
        );
        assert!(d[0].contains("order_status"));
        let a = sig(&base(), &[], &["stock_movements|stock_movements_reason_check|CHECK ((reason = ANY (ARRAY['a'::text]))) NOT VALID"]);
        let b = sig(&base(), &[], &["stock_movements|stock_movements_reason_check|CHECK ((reason = ANY (ARRAY['a'::text])))"]);
        assert!(compare(&a, &b).is_empty());
        let c = sig(&base(), &[], &["stock_movements|stock_movements_reason_check|CHECK ((reason = ANY (ARRAY['b'::text])))"]);
        assert!(!compare(&a, &c).is_empty());
    }

    #[test]
    fn common_columns_are_sorted_and_only_the_shared_ones() {
        let mut cloud = base();
        cloud.push(line("auth.users", "cloud_only", "text", false, "", false));
        let mut local = base();
        local.push(line("auth.users", "local_only", "text", false, "", false));
        assert_eq!(
            common_columns(&sig(&cloud, &[], &[]), &sig(&local, &[], &[]), "auth.users"),
            vec!["email".to_string(), "id".to_string()]
        );
    }
}
