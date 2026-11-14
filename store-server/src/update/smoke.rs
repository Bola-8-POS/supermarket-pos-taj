//! `posctl dev sql-smoke`: the product's OWN SQL, run against the live cluster (Sandbox scenario 68). Compiled only with
//! `--features test-hooks`: a release build has neither this module nor the command, so none of these strings ships.
//!
//! Why it exists: every host test of the updater runs against fakes, and a statement Postgres rejects (the `name || text`
//! operator that failed scenario 69) passes all of them. Here each statement the product sends is executed for real, through
//! the same `PsqlAdmin` the update uses, and its output must have the shape the product parses.
//!
//! Safety: read-only statements run as they are. A statement that mutates runs the product's real method (`RealDb::create_clone`,
//! `swap`, `swap_back`, `set_login`, `repair_collation`, `drop_db`) against throwaway objects it creates and drops itself:
//! databases `pos_smoke_*` cloned from `template0`, and the role `pos_smoke_role`. Nothing of the store is touched; the
//! throwaways are dropped before the case starts (a crashed earlier run) and again when it ends, pass or fail.
use crate::ops::names::DbNames;
use crate::ops::swap::{self, PsqlAdmin, RealDb, StmtClass};
use crate::update::{cluster, idle, invariants, precheck, work};
use serde_json::{json, Value};

type Shape = fn(&str) -> Result<String, String>;

pub enum Kind {
    /// One statement on one database; the output must pass `shape`.
    Read { db: &'static str, sql: String, shape: Shape },
    /// A sequence of product calls on throwaway objects.
    Flow(fn(&PsqlAdmin) -> Result<String, String>),
}
pub struct Case { pub name: &'static str, pub kind: Kind }
pub struct CaseResult { pub name: &'static str, pub ok: bool, pub shape: String, pub error: Option<String> }

const ABSENT: &str = "pos_smoke_absent";
const ROLE: &str = "pos_smoke_role";

pub fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn no_error(out: &str) -> Result<(), String> {
    if out.to_ascii_lowercase().contains("error") { Err(format!("output mentions an error: {out}")) } else { Ok(()) }
}
fn count_and_max(out: &str, needs_rows: bool) -> Result<String, String> {
    let (c, m) = out.trim().split_once('|').ok_or_else(|| format!("not `count|max`: {out}"))?;
    let n: u64 = c.parse().map_err(|_| format!("count is not a number: {out}"))?;
    if needs_rows && (n == 0 || m.is_empty()) { return Err(format!("no migrations are recorded: {out}")); }
    Ok(format!("count={n} max={m}"))
}

fn s_catalog(o: &str) -> Result<String, String> { if is_hex64(o.trim()) { Ok(format!("sha256 {}", o.trim())) } else { Err(format!("not a 64-hex digest: {o:?}")) } }
fn s_sections(o: &str) -> Result<String, String> {   // FR14 diagnostic: name|count|hash8 rows (empty on a bare database is fine)
    let t = crate::update::catalog::describe_sections(o);
    if t.contains('?') { Err(format!("unreadable section row: {t}")) } else { Ok(format!("sections: {t}")) }
}
fn s_lines(o: &str) -> Result<String, String> {   // every line the digest hashes starts with its section tag (the namespace line alone makes a bare database non-empty)
    let tags = ["fn:", "fnacl:", "authfn:", "rel:", "colacl:", "pol:", "trg:", "ns:"];
    let bad = o.lines().map(str::trim).filter(|l| !l.is_empty()).find(|l| !tags.iter().any(|t| l.starts_with(t)));
    match (bad, o.trim().is_empty()) {
        (Some(l), _) => Err(format!("not a catalog line: {:?}", l.chars().take(40).collect::<String>())),
        (None, true) => Err("empty".into()),
        (None, false) => Ok(format!("{} line(s)", o.lines().count())),
    }
}
fn s_cluster(o: &str) -> Result<String, String> {
    let m = cluster::parse_cluster(o).map_err(|e| e.message)?;
    if let Some((s, h)) = m.iter().find(|(_, h)| !is_hex64(h)) { return Err(format!("section {s} is not 64 hex: {h:?}")); }
    Ok("5 sections, each 64 hex".into())
}
fn s_invariants(o: &str) -> Result<String, String> {
    // '' = all hold; otherwise only the five tags the query can print (a broken store is a finding, not a SQL fault)
    no_error(o)?;
    let t = o.trim();
    if t.is_empty() { return Ok("all hold".into()); }
    let known = ["RLS_OFF ", "PIN_GRANT ", "SLOTS", "ROLE_SET ", "SUPERUSERS "];
    if t.split(';').all(|p| known.iter().any(|k| p.starts_with(k))) { Ok(format!("reports: {t}")) } else { Err(format!("unknown invariant output: {t}")) }
}
fn s_rows(o: &str) -> Result<String, String> {
    invariants::rows_lost(o, o, &[])?;
    if !o.contains("auth.users|") || !o.lines().any(|l| l.starts_with("public.")) { return Err(format!("expected public.* and auth.users rows: {o}")); }
    Ok(format!("{} tables", o.lines().filter(|l| !l.trim().is_empty()).count()))
}
fn s_idle(o: &str) -> Result<String, String> { idle::parse_idle(o).map(|i| format!("openCaja={} age={}", i.open_caja, i.last_payment_age_s)).map_err(|e| e.message) }
fn s_slots(o: &str) -> Result<String, String> { precheck::slot_gate(o).map(|_| "0 slots".into()).map_err(|e| e.message) }
fn s_applied(o: &str) -> Result<String, String> {
    let l: Vec<&str> = o.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if l.is_empty() || l.iter().any(|v| !v.bytes().all(|b| b.is_ascii_digit())) { return Err(format!("expected numeric migration versions: {o}")); }
    Ok(format!("{} versions", l.len()))
}
fn s_level(o: &str) -> Result<String, String> { count_and_max(o, true) }
fn s_store_version(o: &str) -> Result<String, String> {
    let (m, a) = o.trim().split_once('|').ok_or_else(|| format!("not `max|applied`: {o}"))?;
    if m.is_empty() || a.parse::<u64>().is_err() { return Err(format!("unreadable store_schema_version: {o}")); }
    Ok(format!("max={m} applied={a}"))
}
fn s_true(o: &str) -> Result<String, String> { if o.trim() == "t" { Ok("t".into()) } else { Err(format!("expected t, got {o:?}")) } }
fn s_bool(o: &str) -> Result<String, String> { if matches!(o.trim(), "t" | "f") { Ok(o.trim().into()) } else { Err(format!("expected t or f, got {o:?}")) } }
fn s_names(o: &str) -> Result<String, String> {
    let l: Vec<&str> = o.lines().map(str::trim).collect();
    if l.contains(&"postgres") && l.contains(&"template1") { Ok(format!("{} databases", l.len())) } else { Err(format!("postgres/template1 missing: {o}")) }
}
fn s_size(o: &str) -> Result<String, String> { match o.trim().parse::<u64>() { Ok(n) if n > 0 => Ok(format!("{n} bytes")), _ => Err(format!("not a size: {o:?}")) } }
fn s_nonempty(o: &str) -> Result<String, String> { if o.trim().is_empty() { Err("empty".into()) } else { Ok(o.trim().into()) } }
fn s_zero(o: &str) -> Result<String, String> { if o.trim() == "0" { Ok("0".into()) } else { Err(format!("expected 0, got {o:?}")) } }

fn read(name: &'static str, db: &'static str, sql: impl Into<String>, shape: Shape) -> Case { Case { name, kind: Kind::Read { db, sql: sql.into(), shape } } }

/// Every statement and product call the smoke runs, in order. Names are unique (a test holds that).
pub fn cases() -> Vec<Case> {
    vec![
        read("catalog-digest", "postgres", crate::update::catalog::CATALOG_SQL, s_catalog),
        read("catalog-sections", "postgres", crate::update::catalog::sections_sql(), s_sections),
        read("catalog-lines", "postgres", crate::update::catalog::lines_sql(), s_lines),
        read("cluster-digest", "template1", cluster::CLUSTER_SQL, s_cluster),
        read("invariants", "postgres", invariants::INVARIANTS_SQL, s_invariants),
        read("row-counts", "postgres", invariants::ROWS_SQL, s_rows),
        read("idle", "postgres", idle::IDLE_SQL, s_idle),
        read("slot-gate", "template1", precheck::SLOT_COUNT_SQL, s_slots),
        read("applied-migrations", "postgres", precheck::APPLIED_SQL, s_applied),
        read("level", "postgres", work::LEVEL_SQL, s_level),
        read("auth-level", "postgres", work::AUTH_LEVEL_SQL, s_level),
        read("store-schema-version", "postgres", work::STORE_VERSION_SQL, s_store_version),
        read("lockout-hook", "postgres", work::HOOK_SQL, s_true),
        read("names", "template1", swap::NAMES_SQL, s_names),
        read("size", "template1", swap::size_sql("postgres"), s_size),
        read("owner", "template1", swap::owner_sql("postgres"), s_nonempty),
        read("collation", "template1", swap::collation_sql("postgres"), s_bool),
        read("terminate-absent-db", "template1", swap::terminate_sql(&[ABSENT]), s_zero),
        read("terminate-empty-db-list", "template1", swap::terminate_sql(&[]), s_zero),
        read("terminate-empty-role-list", "template1", swap::terminate_roles_sql(&[]), s_zero),
        Case { name: "drop-absent-db", kind: Kind::Flow(flow_drop_absent) },
        Case { name: "clone-replay-collation", kind: Kind::Flow(flow_clone) },
        Case { name: "swap-and-back", kind: Kind::Flow(flow_swap) },
        Case { name: "set-login", kind: Kind::Flow(flow_login) },
    ]
}

fn names(live: &str, next: &str) -> DbNames {
    DbNames { live: live.into(), next: next.into(), prev: "pos_smoke_prev".into(), failed: "pos_smoke_failed".into() }
}
const THROWAWAY: [&str; 4] = ["pos_smoke_live", "pos_smoke_next", "pos_smoke_prev", "pos_smoke_failed"];
fn drop_throwaways(db: &RealDb) -> Result<(), String> {
    for d in THROWAWAY { db.drop_db(d).map_err(|e| e.message)?; }
    Ok(())
}
/// Body, then cleanup whatever the body did; the body's error wins, a cleanup error is reported if the body passed.
fn guarded(db: &RealDb, body: impl FnOnce(&RealDb) -> Result<String, String>) -> Result<String, String> {
    drop_throwaways(db)?;
    let r = body(db);
    let c = drop_throwaways(db);
    match (r, c) { (Err(e), _) => Err(e), (Ok(_), Err(e)) => Err(format!("cleanup failed: {e}")), (Ok(s), Ok(())) => Ok(s) }
}

fn flow_drop_absent(a: &PsqlAdmin) -> Result<String, String> {
    RealDb { admin: a.clone() }.drop_db(ABSENT).map_err(|e| e.message)?;
    Ok("DROP DATABASE IF EXISTS .. WITH (FORCE) on an absent name".into())
}
fn flow_clone(a: &PsqlAdmin) -> Result<String, String> {
    guarded(&RealDb { admin: a.clone() }, |db| {
        let n = names("template0", "pos_smoke_next");
        db.create_clone(&n).map_err(|e| format!("create_clone: {}", e.message))?; // CREATE DATABASE .. FILE_COPY + the DO replay
        if !db.names().map_err(|e| e.message)?.contains("pos_smoke_next") { return Err("the clone is not in pg_database".into()); }
        let size = db.size_bytes("pos_smoke_next").map_err(|e| e.message)?;
        let owner = db.owner("pos_smoke_next").map_err(|e| e.message)?;
        let mismatch = db.collation_mismatch("pos_smoke_next").map_err(|e| e.message)?;
        db.repair_collation("pos_smoke_next").map_err(|e| format!("repair_collation: {}", e.message))?; // REINDEX + REFRESH on that database
        Ok(format!("clone {size} bytes, owner {owner}, collation mismatch {mismatch}, REINDEX and REFRESH ran"))
    })
}
fn flow_swap(a: &PsqlAdmin) -> Result<String, String> {
    guarded(&RealDb { admin: a.clone() }, |db| {
        db.create_clone(&names("template0", "pos_smoke_live")).map_err(|e| format!("create live: {}", e.message))?;
        db.create_clone(&names("template0", "pos_smoke_next")).map_err(|e| format!("create next: {}", e.message))?;
        let n = names("pos_smoke_live", "pos_smoke_next");
        db.swap(&n).map_err(|e| format!("swap: {}", e.message))?;
        if !swap::swap_done(&db.names().map_err(|e| e.message)?, &n) { return Err("swap did not leave prev in place of next".into()); }
        db.swap_back(&n).map_err(|e| format!("swap_back: {}", e.message))?;
        if !swap::swap_back_done(&db.names().map_err(|e| e.message)?, &n) { return Err("swap_back did not leave failed in place of prev".into()); }
        Ok("live->prev, next->live, then live->failed, prev->live".into())
    })
}
fn flow_login(a: &PsqlAdmin) -> Result<String, String> {
    let db = RealDb { admin: a.clone() };
    let drop = |a: &PsqlAdmin| a.exec("template1", &format!("DROP ROLE IF EXISTS {ROLE}")).map_err(|e| e.message);
    drop(a)?;
    let body = (|| -> Result<String, String> {
        a.exec("template1", &format!("CREATE ROLE {ROLE} NOLOGIN")).map_err(|e| e.message)?;
        let can = || a.scalar_class("template1", &format!("SELECT rolcanlogin FROM pg_roles WHERE rolname = '{ROLE}'"), StmtClass::Quick).map_err(|e| e.message);
        db.set_login(&[ROLE.to_string()], true).map_err(|e| format!("set_login(true): {}", e.message))?;
        if can()? != "t" { return Err("LOGIN did not take".into()); }
        db.set_login(&[ROLE.to_string()], false).map_err(|e| format!("set_login(false): {}", e.message))?; // + terminate_roles_sql
        if can()? != "f" { return Err("NOLOGIN did not take".into()); }
        Ok("ALTER ROLE .. LOGIN then NOLOGIN (+ terminate) on a throwaway role".into())
    })();
    let c = drop(a);
    match (body, c) { (Err(e), _) => Err(e), (Ok(_), Err(e)) => Err(format!("cleanup failed: {e}")), (Ok(s), Ok(())) => Ok(s) }
}

pub fn run_cases(a: &PsqlAdmin, cases: Vec<Case>) -> Vec<CaseResult> {
    cases.into_iter().map(|c| {
        let r = match c.kind {
            Kind::Read { db, sql, shape } => a.scalar_class(db, &sql, StmtClass::Default).map_err(|e| format!("{}: {}", e.reason, e.message)).and_then(|o| shape(&o)),
            Kind::Flow(f) => f(a),
        };
        match r {
            Ok(shape) => CaseResult { name: c.name, ok: true, shape, error: None },
            Err(e) => CaseResult { name: c.name, ok: false, shape: String::new(), error: Some(e) },
        }
    }).collect()
}
pub fn run(a: &PsqlAdmin) -> Vec<CaseResult> { run_cases(a, cases()) }

pub fn to_json(rs: &[CaseResult]) -> Value {
    json!({
        "allOk": !rs.is_empty() && rs.iter().all(|r| r.ok),
        "results": rs.iter().map(|r| json!({"name": r.name, "ok": r.ok, "shape": r.shape, "error": r.error})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn the_registry_is_not_empty_and_every_name_is_unique_and_every_statement_is_there() {
        let cs = cases();
        assert!(cs.len() >= 20, "{}", cs.len());
        let names: BTreeSet<&str> = cs.iter().map(|c| c.name).collect();
        assert_eq!(names.len(), cs.len(), "a duplicate case name");
        for must in ["catalog-digest", "cluster-digest", "invariants", "row-counts", "slot-gate", "level", "auth-level", "names", "size", "owner", "collation",
                     "clone-replay-collation", "swap-and-back", "set-login", "terminate-empty-role-list"] {
            assert!(names.contains(must), "{must}");
        }
        for c in &cs {
            if let Kind::Read { sql, .. } = &c.kind { assert!(!sql.trim().is_empty(), "{}", c.name); }
        }
    }

    #[test]
    fn the_lines_check_accepts_escaped_definitions_and_still_refuses_a_malformed_line() {
        // an escaped policy line (the \n, \r and backslash are two characters each) is ONE tagged line
        let ok = "fn:public.f():abc\npol:public:t:p:PERMISSIVE:ALL:(a\\nb\\r\\\\c):\nns:public:";
        assert_eq!(s_lines(ok).unwrap(), "3 line(s)");
        // the FR15 failure: a raw newline inside a row leaves a tail that carries no tag
        assert!(s_lines("pol:public:t:p:PERMISSIVE:ALL:(SELECT 1\nFROM public.role_permissions):").unwrap_err().contains("not a catalog line"));
        assert!(s_lines("ERROR:  boom").is_err() && s_lines("").is_err());
    }

    #[test]
    fn the_shape_checks_accept_the_expected_output_and_refuse_an_error_or_an_empty_answer() {
        let h = "a".repeat(64);
        assert!(s_catalog(&h).is_ok() && s_catalog(&format!("ERROR: {h}")).is_err() && s_catalog("").is_err() && s_catalog(&h.to_uppercase()).is_err());
        let cl = ["databases", "members", "roles", "settings", "slots"].iter().map(|s| format!("{s}|{h}")).collect::<Vec<_>>().join("\n");
        assert!(s_cluster(&cl).is_ok() && s_cluster(&cl.replace(&h, "short")).is_err() && s_cluster("").is_err());
        assert!(s_rows("auth.users|1\npublic.products|3").is_ok() && s_rows("").is_err() && s_rows("public.products|3").is_err());
        assert!(s_level("12|20260101000000").is_ok() && s_level("0|").is_err() && s_level("x").is_err());
        assert!(s_store_version("20260101000000|12").is_ok() && s_store_version("|12").is_err());
        assert!(s_slots("0").is_ok() && s_slots("1").is_err());
        assert!(s_idle(r#"{"openCaja":0,"lastPaymentAgeSeconds":7200}"#).is_ok() && s_idle("psql: error").is_err());
        assert!(s_invariants("").is_ok() && s_invariants("RLS_OFF public.x").is_ok() && s_invariants("ERROR: boom").is_err());
        assert!(s_true("t").is_ok() && s_true("f").is_err() && s_bool("f").is_ok() && s_bool("true").is_err());
        assert!(s_names("postgres\ntemplate1\ntemplate0").is_ok() && s_names("postgres").is_err());
        assert!(s_size("7340032").is_ok() && s_size("0").is_err() && s_zero("0").is_ok() && s_zero("1").is_err());
        assert!(s_applied("20260101000000\n20260102000000").is_ok() && s_applied("").is_err() && s_applied("x1").is_err());
    }

    #[test]
    fn against_a_psql_that_fails_every_case_reports_its_error_and_none_panics_or_passes() {
        let d = tempfile::tempdir().unwrap();
        let psql = d.path().join("psql.cmd");
        std::fs::write(&psql, "@echo off\r\necho psql: simulated failure 1>&2\r\nexit /b 2\r\n").unwrap();
        let pgpass = d.path().join("pgpass.conf");
        std::fs::write(&pgpass, "x").unwrap();
        let a = PsqlAdmin::new(psql, 47300, pgpass);
        let rs = run(&a);
        assert_eq!(rs.len(), cases().len());
        assert!(rs.iter().all(|r| !r.ok && r.error.as_deref().is_some_and(|e| !e.is_empty())), "{:?}", rs.iter().map(|r| (r.name, r.ok)).collect::<Vec<_>>());
        let j = to_json(&rs);
        assert_eq!(j["allOk"], json!(false));
        assert_eq!(j["results"].as_array().map(Vec::len), Some(rs.len()));
        // (a multi-line statement is refused by the .cmd shim itself before psql runs: a fake-only artifact, still an error)
        assert!(j["results"].as_array().unwrap().iter().any(|r| r["error"].as_str().is_some_and(|e| e.contains("simulated failure"))), "{j}");
    }

    #[test]
    fn against_a_psql_that_prints_garbage_every_read_case_fails_its_shape_check() {
        let d = tempfile::tempdir().unwrap();
        let psql = d.path().join("psql.cmd");
        std::fs::write(&psql, "@echo off\r\necho garbage\r\n").unwrap();
        let pgpass = d.path().join("pgpass.conf");
        std::fs::write(&pgpass, "x").unwrap();
        let a = PsqlAdmin::new(psql, 47300, pgpass);
        let reads: Vec<Case> = cases().into_iter().filter(|c| matches!(c.kind, Kind::Read { .. })).collect();
        let n = reads.len();
        let rs = run_cases(&a, reads);
        assert_eq!(rs.len(), n);
        // `owner` accepts any non-empty text; every other read case has a shape that "garbage" is not
        for r in &rs { assert!(r.ok == (r.name == "owner"), "{}: {:?}", r.name, r.error); }
    }

    #[test]
    fn allok_is_false_for_no_results() { assert_eq!(to_json(&[])["allOk"], json!(false)); }
}
