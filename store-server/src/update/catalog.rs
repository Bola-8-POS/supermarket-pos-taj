//! The state-based catalog digest (see catalog-digest.sql): one sha256 over the grants, policies, functions and triggers a migration can silently break.
pub const CATALOG_SQL: &str = include_str!("catalog-digest.sql");

// ---- diagnostics for CATALOG_MISMATCH (FR14) -------------------------------------------------------------------------------------
// The digest is one hash, so a mismatch says nothing about WHAT differs. Both queries below are derived from the digest SQL itself (the union of
// `x` lines between `FROM (` and `) q`), so they can never describe a different catalog than the one that was compared.

/// The union of lines the digest hashes (everything between the first `FROM (` and the last `) q`), on ONE line: a newline in a psql argument breaks
/// the `.cmd` test doubles (Rust refuses it for batch files), and the body holds no `--` comment that a flattened line could swallow.
fn lines_body() -> String {
    let a = CATALOG_SQL.find("FROM (").map(|i| i + "FROM (".len()).expect("catalog-digest.sql: FROM (");
    let b = CATALOG_SQL.rfind(") q").expect("catalog-digest.sql: ) q");
    CATALOG_SQL[a..b].split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

/// One row per section (`fn`, `fnacl`, `authfn`, `rel`, `colacl`, `pol`, `trg`, `ns`): `name|line count|first 8 hex of the section's sha256`.
/// Names and hashes only; no raw line leaves the database. Every `||` operand is cast to text (sql_lint holds this).
pub fn sections_sql() -> String {
    format!(
        r"SET search_path = pg_catalog; SELECT split_part(x, ':', 1)::text || '|' || count(*)::text || '|' || left(encode(sha256(convert_to(string_agg(x, E'\n' ORDER BY x), 'UTF8')), 'hex'), 8)::text FROM ({}) q GROUP BY split_part(x, ':', 1) ORDER BY split_part(x, ':', 1)",
        lines_body()
    )
}

/// Every line the digest hashes, in digest order (the test-hooks build dumps these to a file for a line-by-line diff).
pub fn lines_sql() -> String { format!("SET search_path = pg_catalog; SELECT x FROM ({}) q ORDER BY x", lines_body()) }

/// `name|count|hash` rows -> `name=count:hash, ...` (an unreadable row is kept verbatim but cut, so a psql error shows).
pub fn describe_sections(out: &str) -> String {
    out.lines().map(str::trim).filter(|l| !l.is_empty()).map(|l| {
        let mut p = l.splitn(3, '|');
        match (p.next(), p.next(), p.next()) {
            (Some(n), Some(c), Some(h)) if h.len() == 8 && h.bytes().all(|b| b.is_ascii_hexdigit()) => format!("{n}={c}:{h}"),
            _ => format!("?{}", l.chars().take(40).collect::<String>()),
        }
    }).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_cluster::TestCluster;
    use std::path::PathBuf;

    #[test]
    fn the_sql_pins_the_search_path_so_the_digest_does_not_depend_on_the_session() {
        assert!(CATALOG_SQL.trim_start().to_lowercase().contains("set search_path = pg_catalog"));
    }

    #[test]
    fn the_section_diagnostic_is_the_digest_s_own_union_grouped_by_section() {
        let body = lines_body();
        assert!(!body.contains('\n') && !body.contains('\r'), "one line");
        assert!(body.contains("'fn:'") && body.contains("'ns:'") && body.starts_with("SELECT"), "{body}");
        assert!(!body.contains("encode(sha256"), "the body is only the union of lines");
        let (s, l) = (sections_sql(), lines_sql());
        assert!(s.starts_with("SET search_path = pg_catalog;") && l.starts_with("SET search_path = pg_catalog;"));
        assert!(s.contains(&body) && l.contains(&body), "same lines as the digest, verbatim");
        assert!(s.contains("GROUP BY split_part(x, ':', 1)") && s.contains("ORDER BY x), 'UTF8')"), "{s}");
        assert!(s.contains("left(encode(sha256("), "{s}");
        assert!(l.trim_end().ends_with("ORDER BY x"), "{l}");
        assert!(!s.contains('\n') && !l.contains('\n'), "no newline reaches a psql argument");
        // derived, not copied: every line of the body is a line of catalog-digest.sql
        for part in CATALOG_SQL.lines().map(str::trim).filter(|x| body.contains(*x) && !x.is_empty()) { assert!(CATALOG_SQL.contains(part)); }
        assert!(CATALOG_SQL.lines().map(str::trim).filter(|x| x.starts_with("UNION ALL")).count() >= 7);
    }

    // FR15. The ONE escape lives in catalog-digest.sql; lines_body() reuses it, so the digest, the sections and the lines dump cannot drift.
    // This is the same expression spelled out in Rust: order matters (backslash FIRST, else the backslashes added for \n and \r get doubled).
    const ESCAPE_SQL: &str = r"replace(replace(replace(u.x, E'\\', E'\\\\'), E'\n', E'\\n'), E'\r', E'\\r')";
    fn escape_line(s: &str) -> String { s.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r") }
    /// What the digest SQL computes over already-built rows: escape each, sort, join with a real newline, sha256.
    fn host_digest(rows: &[&str]) -> String {
        let mut e: Vec<String> = rows.iter().map(|r| escape_line(r)).collect();
        e.sort();
        crate::util::sha256_hex(e.join("\n").as_bytes())
    }

    #[test]
    fn the_escape_is_written_once_in_the_digest_sql_and_the_diagnostics_reuse_it() {
        assert_eq!(CATALOG_SQL.matches(ESCAPE_SQL).count(), 1, "the digest SQL carries the escape exactly once");
        let (s, l) = (sections_sql(), lines_sql());
        assert_eq!(s.matches(ESCAPE_SQL).count(), 1, "{s}");
        assert_eq!(l.matches(ESCAPE_SQL).count(), 1, "{l}");
        // backslash first, then newline, then carriage return
        let (b, n, r) = (ESCAPE_SQL.find(r"E'\\', E'\\\\'").unwrap(), ESCAPE_SQL.find(r"E'\n', E'\\n'").unwrap(), ESCAPE_SQL.find(r"E'\r', E'\\r'").unwrap());
        assert!(b < n && n < r, "{ESCAPE_SQL}");
    }

    #[test]
    fn an_escaped_row_never_contains_a_raw_newline_and_digests_the_fixture() {
        let pol = "pol:public:t:p:PERMISSIVE:ALL:(a\nb\r\\c):";
        let e = escape_line(pol);
        assert_eq!(e, r"pol:public:t:p:PERMISSIVE:ALL:(a\nb\r\\c):");
        assert!(!e.contains('\n') && !e.contains('\r'), "one line per row");
        let rows = ["fn:public.f():abc", pol];
        let joined = rows.iter().map(|r| escape_line(r)).collect::<Vec<_>>().join("\n");
        assert_eq!(joined.lines().count(), rows.len(), "one line per row");
        assert_eq!(host_digest(&rows), "1b4c846eb27abe1e5b1894cca2d00b9ce057a8fab9a8f4dee81b4a4b376f387d");
    }

    #[test]
    fn one_row_with_a_newline_no_longer_hashes_like_two_rows() {
        assert_ne!(host_digest(&["a\nb"]), host_digest(&["a", "b"]), "row boundaries are unambiguous");
        assert_ne!(host_digest(&["a\\nb"]), host_digest(&["a\nb"]), "a literal backslash-n is not a newline");
    }

    #[test]
    fn describe_sections_prints_names_counts_and_hashes_only() {
        assert_eq!(describe_sections("authfn|12|0a1b2c3d
fn|229|abcdef01
"), "authfn=12:0a1b2c3d,fn=229:abcdef01");
        assert_eq!(describe_sections(""), "");
        // a psql error is visible but cut, never passed through whole
        let e = describe_sections(&format!("ERROR:  {}", "x".repeat(200)));
        assert!(e.starts_with("?ERROR:") && e.len() <= 41, "{e}");
    }

    #[test]
    fn the_digest_covers_the_sections_a_migration_can_silently_weaken() {
        let q = CATALOG_SQL;
        for tag in ["'fn:'", "'fnacl:'", "'rel:'", "'pol:'", "'trg:'", "'ns:'", "'colacl:'", "'authfn:'"] { assert!(q.contains(tag), "{tag}"); }
        assert!(q.contains("tgenabled"), "a disabled trigger must change the digest");
        assert!(q.contains("permissive"), "restrictive versus permissive must change the digest");
        assert!(q.contains("attacl"), "column grants must change the digest");
        // rel, trg and pol cover pos_lockout as well as public
        let rel = &q[q.find("'rel:'").unwrap()..q.find("'pol:'").unwrap()];
        assert!(rel.contains("pos_lockout"), "rel: {rel}");
        let trg = &q[q.find("'trg:'").unwrap()..q.find("'ns:'").unwrap()];
        assert!(trg.contains("pos_lockout"), "trg: {trg}");
        let pol = &q[q.find("'pol:'").unwrap()..q.find("'trg:'").unwrap()];
        assert!(pol.contains("pos_lockout") && pol.contains("schemaname"), "pol: {pol}");
        assert!(q.contains("nspname = 'auth'") || q.contains("nspname='auth'"), "auth.* function bodies join the digest");
        assert!(!q.to_lowercase().contains("order by 1"));
    }

    // real_ test: compiled here, run only in Windows Sandbox (owner rule); never on the developer PC.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_digest_reacts_to_a_dropped_grant_and_a_changed_function() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        a.exec("postgres", "CREATE SCHEMA IF NOT EXISTS pos_lockout; CREATE TABLE public.t(a int); GRANT SELECT ON public.t TO PUBLIC; \
                            CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'").unwrap();
        let d1 = a.scalar("postgres", CATALOG_SQL).unwrap();
        assert_eq!(d1.len(), 64);
        assert_eq!(d1, a.scalar("postgres", CATALOG_SQL).unwrap(), "deterministic");
        a.exec("postgres", "REVOKE SELECT ON public.t FROM PUBLIC").unwrap();
        let d2 = a.scalar("postgres", CATALOG_SQL).unwrap();
        assert_ne!(d1, d2, "a dropped grant must change the digest");
        a.exec("postgres", "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 2'").unwrap();
        assert_ne!(d2, a.scalar("postgres", CATALOG_SQL).unwrap(), "a changed body must change the digest");
    }

    // real_ test: compiled here, run only in Windows Sandbox (owner rule); never on the developer PC.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_digest_reacts_to_each_extended_section() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        a.exec("postgres", "CREATE ROLE anon NOLOGIN; CREATE SCHEMA IF NOT EXISTS pos_lockout; CREATE SCHEMA IF NOT EXISTS auth; \
                            CREATE TABLE public.t(a int, b int); CREATE POLICY p ON public.t USING (true); ALTER TABLE public.t ENABLE ROW LEVEL SECURITY; \
                            CREATE FUNCTION public.trg() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER tr BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.trg(); \
                            CREATE FUNCTION auth.uid() RETURNS int LANGUAGE sql AS 'SELECT 1'").unwrap();
        let digest = || a.scalar("postgres", CATALOG_SQL).unwrap();
        let mut last = digest();
        let mut step = |what: &str, sql: &str| {
            a.exec("postgres", sql).unwrap();
            let now = a.scalar("postgres", CATALOG_SQL).unwrap();
            assert_ne!(now, last, "{what} must change the digest");
            last = now;
        };
        step("a column grant", "GRANT SELECT (a) ON public.t TO anon");
        step("a restrictive policy", "DROP POLICY p ON public.t; CREATE POLICY p ON public.t AS RESTRICTIVE USING (true)");
        step("a disabled trigger", "ALTER TABLE public.t DISABLE TRIGGER tr");
        step("an auth function body", "CREATE OR REPLACE FUNCTION auth.uid() RETURNS int LANGUAGE sql AS 'SELECT 2'");
        step("a pos_lockout table with RLS", "CREATE TABLE pos_lockout.x(); ALTER TABLE pos_lockout.x ENABLE ROW LEVEL SECURITY");
    }

    // A pack SQL file re-applied by update (every-update steps) must leave the catalog exactly as provision left it, whatever the checkout's line endings:
    // psql reads `-f -` on stdin in text mode but `-f <file>` in binary mode, so a CRLF file once put a carriage return into the `$$` bodies.
    // real_ test: needs POS_PACK_DIR (a throwaway cluster from the pack); cargo test -- --ignored pg_it
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn pg_it_update_reapply_of_a_pack_sql_file_matches_provision_for_lf_and_crlf() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        a.exec("postgres", "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE supabase_auth_admin NOLOGIN; \
                            CREATE TABLE public.pin_attempts(attempt_key text primary key, failed_count int, locked_until timestamptz, updated_at timestamptz); \
                            CREATE FUNCTION public.pin_attempt_record(k text, ok boolean) RETURNS int LANGUAGE sql AS 'SELECT 0'; \
                            CREATE FUNCTION public.pin_attempt_retry_after(k text) RETURNS int LANGUAGE sql AS 'SELECT 0'").unwrap();
        let pack = PathBuf::from(std::env::var("POS_PACK_DIR").unwrap());
        // provision's route (provision.rs exec_run_order_step): the file's text on psql's stdin
        let prov = crate::pg::Psql { tools: crate::pg::PgTools::for_pack(&pack), port: a.port, pgpass: a.pgpass.clone() };
        // embedded at build time: the sandbox guest has no source tree, so CARGO_MANIFEST_DIR is not readable there
        const SHIPPED: &str = include_str!("../../pack/sql/20-pos-lockout-hook.sql");
        let (real, lf, crlf) = (c.dir.path().join("20-real.sql"), c.dir.path().join("20-lf.sql"), c.dir.path().join("20-crlf.sql"));
        let lf_text = SHIPPED.replace("\r\n", "\n"); // whatever the working-tree EOL, the LF and CRLF variants are built explicitly
        std::fs::write(&real, SHIPPED).unwrap();
        std::fs::write(&lf, &lf_text).unwrap();
        std::fs::write(&crlf, lf_text.replace('\n', "\r\n")).unwrap();
        let defs = "SELECT string_agg(md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pos_lockout'";
        let body = || a.scalar("postgres", "SELECT replace(pg_get_functiondef('pos_lockout.mirror(text,integer)'::regprocedure), chr(13), '<CR>')").unwrap();
        let mut digests = vec![];
        for file in [&real, &lf, &crlf] {
            let o = prov.run_with("supabase_admin", "postgres", &[], &std::fs::read_to_string(file).unwrap()).unwrap();
            assert!(o.success(), "{}", o.text());
            let (d_prov, f_prov, b_prov) = (a.scalar("postgres", CATALOG_SQL).unwrap(), a.scalar("postgres", defs).unwrap(), body());
            a.run_file_opts("postgres", file, &[], false, &[]).unwrap(); // update's route (update/work.rs run_step)
            let (d_upd, f_upd, b_upd) = (a.scalar("postgres", CATALOG_SQL).unwrap(), a.scalar("postgres", defs).unwrap(), body());
            assert_eq!(f_prov, f_upd, "{}: function def hashes differ\nprovision body: {b_prov:?}\nupdate body:    {b_upd:?}", file.display());
            assert_eq!(d_prov, d_upd, "{}: catalog digest differs after the update re-apply", file.display());
            digests.push(d_upd);
        }
        assert!(digests.windows(2).all(|w| w[0] == w[1]), "an LF and a CRLF copy of one file must give one digest: {digests:?}");
        // still strict: a foreign grant on a lockout function must move the digest
        a.exec("postgres", "CREATE ROLE intruder NOLOGIN; GRANT EXECUTE ON FUNCTION pos_lockout.clear_mirror(text) TO intruder").unwrap();
        assert_ne!(digests[0], a.scalar("postgres", CATALOG_SQL).unwrap(), "a foreign grant must change the digest");
    }

}
