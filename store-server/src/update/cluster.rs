//! The cluster digest (FR5b item 2): five `section|sha256` lines taken as supabase_admin on `template1` before and after the work
//! (see `cluster-digest.sql`). A change in any section means the work touched something dropping the clone cannot undo.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use std::collections::BTreeMap;

pub const CLUSTER_SQL: &str = include_str!("cluster-digest.sql");
pub const SECTIONS: [&str; 5] = ["databases", "members", "roles", "settings", "slots"];

/// Exactly the five sections, each once, each with a hash: anything else cannot be compared and is refused.
pub fn parse_cluster(out: &str) -> R<BTreeMap<String, String>> {
    let bad = |m: &str| OpError::new(OpCode::MigrationFailed, "CLUSTER_DIGEST_FAILED", m.to_string());
    let mut m = BTreeMap::new();
    for l in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (s, h) = l.split_once('|').ok_or_else(|| bad("the cluster digest has a line without a section"))?;
        if !SECTIONS.contains(&s) || h.is_empty() || m.insert(s.to_string(), h.to_string()).is_some() {
            return Err(bad("the cluster digest has an unknown, empty or repeated section"));
        }
    }
    if m.len() != SECTIONS.len() { return Err(bad("the cluster digest has fewer than five sections")); }
    Ok(m)
}

/// Names of the sections whose hash differs (names only: never a hash in a message).
pub fn changed_sections(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Vec<String> {
    SECTIONS.iter().filter(|s| before.get(**s) != after.get(**s)).map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_cluster::TestCluster;

    // real_ test: compiled here, run only in Windows Sandbox (owner rule); never on the developer PC.
    #[test]
    #[ignore = "needs POS_PACK_DIR; cargo test -- --ignored"]
    fn real_cluster_digest_sees_each_section() {
        let c = TestCluster::start(2);
        let a = &c.admin;
        let digest = || parse_cluster(&a.scalar("template1", CLUSTER_SQL).unwrap()).unwrap();
        // FR14: one statement per call. `psql -c "a; b"` is ONE implicit transaction, and CREATE DATABASE cannot run inside one (the product never combines them).
        a.exec("template1", "CREATE ROLE anon NOLOGIN").unwrap();
        a.exec("template1", "CREATE DATABASE pos_next").unwrap();
        let mut last = digest();
        let mut step = |section: &str, sql: &str| {
            a.exec("template1", sql).unwrap();
            let now = digest();
            assert_eq!(changed_sections(&last, &now), vec![section.to_string()], "{sql}");
            last = now;
        };
        // the throwaway cluster is initdb'ed with supabase_admin as its only superuser: there is no `postgres` role here (FR14)
        step("settings", "ALTER ROLE supabase_admin SET work_mem TO '9MB'");
        step("roles", "CREATE ROLE z");
        step("databases", "ALTER DATABASE postgres CONNECTION LIMIT 5");
        step("members", "GRANT anon TO z");
        step("slots", "SELECT pg_create_physical_replication_slot('s')");
        // the clone's own settings are visible (FR9); only its `databases` row is left out
        step("settings", "ALTER DATABASE pos_next SET work_mem TO '9MB'");
    }
}
