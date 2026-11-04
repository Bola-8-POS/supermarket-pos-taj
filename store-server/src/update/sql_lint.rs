//! A lexical guard for the class of bug that host fakes cannot see and a real Postgres rejects (scenario 69, FR11):
//! `Could not choose a best candidate operator` on `name || text` and `"char" || text` under `search_path = pg_catalog`.
//! It reads each product SQL string, finds every `||`, and requires both operands to be a literal, a `::text` cast, a call of a
//! function known to return text, or an alias known to hold text. Limits, stated plainly: it is lexical (no types), so it cannot
//! prove a function's return type, and it only sees these listed strings. The real proof is `posctl dev sql-smoke` in the
//! Sandbox (scenario 68); this test fails the build early for the regression that actually happened.
use crate::ops::names::DbNames;
use crate::ops::swap;
use crate::update::{catalog, cluster, idle, invariants, precheck, work};

/// Functions whose result is text (or varchar), safe as a `||` operand.
const TEXT_FUNCS: [&str; 8] = ["md5", "coalesce", "encode", "array_to_string", "string_agg", "format", "concat_ws", "quote_ident"];
/// Sub-select aliases of the product SQL that are text because they were built from casts.
const TEXT_ALIASES: [&str; 7] = ["l", "s", "g", "t", "x", "v.s", "q.x"];

/// Drop `--` comments and blank every string literal to `'_'`, so `||` inside text and comments is not an operator.
fn clean(sql: &str) -> Vec<char> {
    let b: Vec<char> = sql.chars().collect();
    let (mut out, mut i) = (Vec::with_capacity(b.len()), 0);
    while i < b.len() {
        if b[i] == '-' && b.get(i + 1) == Some(&'-') {
            while i < b.len() && b[i] != '\n' { i += 1; }
        } else if b[i] == '\'' {
            i += 1;
            while i < b.len() { if b[i] == '\'' { if b.get(i + 1) == Some(&'\'') { i += 2; continue; } break; } i += 1; }
            i += 1;
            out.extend(['\'', '_', '\'']);
        } else { out.push(b[i]); i += 1; }
    }
    out
}

fn stop(c: char) -> bool { c.is_whitespace() || matches!(c, ',' | ';' | '|' | '=' | '<' | '>' | '+') }

fn left_operand(s: &[char], end: usize) -> String {
    let mut j = end;
    while j > 0 && s[j - 1].is_whitespace() { j -= 1; }
    let (stop_at, mut depth) = (j, 0i32);
    let mut k = stop_at;
    while k > 0 {
        let c = s[k - 1];
        if c == ')' || c == ']' { depth += 1; }
        else if c == '(' || c == '[' { if depth == 0 { break; } depth -= 1; }
        else if depth == 0 && stop(c) { break; }
        k -= 1;
    }
    s[k..stop_at].iter().collect()
}
fn right_operand(s: &[char], start: usize) -> String {
    let mut j = start;
    while j < s.len() && s[j].is_whitespace() { j += 1; }
    let (from, mut depth) = (j, 0i32);
    while j < s.len() {
        let c = s[j];
        if c == '(' || c == '[' { depth += 1; }
        else if c == ')' || c == ']' { if depth == 0 { break; } depth -= 1; }
        else if depth == 0 && stop(c) { break; }
        j += 1;
    }
    s[from..j].iter().collect()
}

/// Why this operand is not provably text, or `None` if it is.
fn doubtful(op: &str) -> Option<String> {
    let op = op.trim();
    if op.is_empty() || op.starts_with('\'') || op.ends_with("::text") { return None; }
    if op.ends_with(')') {
        let name: String = op.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if op[name.len()..].starts_with('(') && TEXT_FUNCS.contains(&name.to_ascii_lowercase().as_str()) { return None; }
    }
    if TEXT_ALIASES.contains(&op) { return None; }
    Some(op.to_string())
}

pub fn uncast_operands(sql: &str) -> Vec<String> {
    let s = clean(sql);
    let mut bad = vec![];
    let mut i = 0;
    while i + 1 < s.len() {
        if s[i] == '|' && s[i + 1] == '|' {
            for op in [left_operand(&s, i), right_operand(&s, i + 2)] {
                if let Some(d) = doubtful(&op) { bad.push(d); }
            }
            i += 2;
        } else { i += 1; }
    }
    bad
}

fn all_sql() -> Vec<(&'static str, String)> {
    let n = DbNames { live: "postgres".into(), next: "pos_next".into(), prev: "pos_prev_update_20261002023015".into(), failed: "pos_failed_20261002023015".into() };
    vec![
        ("catalog-digest.sql", catalog::CATALOG_SQL.into()), ("catalog sections_sql", catalog::sections_sql()), ("catalog lines_sql", catalog::lines_sql()), ("cluster-digest.sql", cluster::CLUSTER_SQL.into()),
        ("invariants.sql", invariants::INVARIANTS_SQL.into()), ("ROWS_SQL", invariants::ROWS_SQL.into()), ("IDLE_SQL", idle::IDLE_SQL.into()),
        ("SLOT_COUNT_SQL", precheck::SLOT_COUNT_SQL.into()), ("APPLIED_SQL", precheck::APPLIED_SQL.into()),
        ("LEVEL_SQL", work::LEVEL_SQL.into()), ("AUTH_LEVEL_SQL", work::AUTH_LEVEL_SQL.into()), ("STORE_VERSION_SQL", work::STORE_VERSION_SQL.into()),
        ("HOOK_SQL", work::HOOK_SQL.into()), ("NAMES_SQL", swap::NAMES_SQL.into()), ("size_sql", swap::size_sql("postgres")),
        ("owner_sql", swap::owner_sql("postgres")), ("collation_sql", swap::collation_sql("postgres")),
        ("replay_attrs_sql", swap::replay_attrs_sql(&n)), ("create_clone_sql", swap::create_clone_sql(&n, "postgres")), ("swap_sql", swap::swap_sql(&n)),
        ("swap_back_sql", swap::swap_back_sql(&n)), ("drop_sql", swap::drop_sql("pos_next")), ("terminate_sql", swap::terminate_sql(&["postgres"])),
        ("terminate_sql(empty)", swap::terminate_sql(&[])), ("terminate_roles_sql", swap::terminate_roles_sql(&["authenticator".into()])),
        ("terminate_roles_sql(empty)", swap::terminate_roles_sql(&[])), ("login_sql", swap::login_sql(&["authenticator".into()], false)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_product_sql_concatenates_an_operand_that_is_not_provably_text() {
        for (name, sql) in all_sql() {
            assert!(uncast_operands(&sql).is_empty(), "{name}: uncast operand(s) of `||`: {:?}", uncast_operands(&sql));
        }
    }

    #[test]
    fn the_lint_itself_bites_on_the_statements_that_failed_in_the_sandbox() {
        // verbatim shapes from the pre-FR11 catalog-digest.sql / cluster-digest.sql / invariants.sql / work.rs
        for bad in [
            "SELECT 'rel:' || n.nspname || '.' || c.relkind || ':' || c.relname FROM pg_class c",
            "SELECT 'trg:' || t.tgname || ':' || t.tgenabled FROM pg_trigger t",
            "SELECT 'pol:' || schemaname || ':' || permissive FROM pg_policies",
            "SELECT a.rolname||':'||a.rolsuper||a.rolinherit FROM pg_authid a",
            "SELECT count(*) || '|' || COALESCE(max(version), '') FROM t",
            "SELECT 'x' || pg_get_userbyid(d.datdba) FROM pg_database d",
        ] {
            assert!(!uncast_operands(bad).is_empty(), "the lint missed: {bad}");
        }
        for good in [
            "SELECT 'rel:' || n.nspname::text || '.' || c.relkind::text FROM pg_class c",
            "SELECT count(*)::text || '|' || COALESCE(max(version)::text, '') FROM t",
            "SELECT 'a' || md5(x) || ':' || COALESCE(p.proacl::text, '') FROM t -- n.nspname || c.relkind in a comment",
            "SELECT 'it''s || c.relkind' || n.nspname::text FROM t",
        ] {
            assert!(uncast_operands(good).is_empty(), "false positive: {good}: {:?}", uncast_operands(good));
        }
    }

    #[test]
    fn an_empty_name_list_never_becomes_an_empty_in_list() {
        for sql in [swap::terminate_sql(&[]), swap::terminate_roles_sql(&[])] {
            assert!(!clean(&sql).iter().collect::<String>().replace(' ', "").contains("IN()"), "{sql}");
            assert!(sql.contains("IN (NULL)"), "{sql}");
        }
        assert!(swap::terminate_sql(&["postgres"]).contains("IN ('postgres')"));
    }
}
