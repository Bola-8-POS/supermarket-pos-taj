//! `posctl pack prune` and the database housekeeping behind it and behind `posctl update`.
//! EVERY drop or delete here happens in this order: `update.lock` exclusive (an unreadable lock is not free), then the journal
//! (an unreadable one is RECOVERY_NEEDED, never "no journal"), then the action. The operation in flight keeps its packs and
//! its databases, and no database name reaches SQL without passing `valid_ident`.
use crate::commands::update::Report;
use crate::ops::journal::Journal;
use crate::ops::lock::{acquire_for, probe_readonly_for, LockMode, LockState};
use crate::ops::names::{valid_ident, DbNames};
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::swap::prune_plan;
use crate::ops::world::R;
use crate::update::manifest::pack_version_key;
use crate::update::Env;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

type PackKey = (u32, u32, u32, u32);

/// Versions to delete: everything that is a packVersion, not protected, and not among the `keep` newest (at least 2).
pub fn prune_packs(versions: &[String], protected: &BTreeSet<String>, keep: usize) -> Vec<String> {
    let mut known: Vec<(&String, PackKey)> = versions.iter().filter_map(|v| pack_version_key(v).map(|k| (v, k))).collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.1));
    let keep = keep.max(2);
    let mut out: Vec<String> = known.iter().enumerate()
        .filter(|(i, (v, _))| *i >= keep && !protected.contains(*v)).map(|(_, (v, _))| (*v).clone()).collect();
    out.sort();
    out
}

pub fn remove_unprotected(packs_dir: &Path, protected: &BTreeSet<String>, keep: usize) -> std::io::Result<Vec<String>> {
    let names: Vec<String> = std::fs::read_dir(packs_dir)?.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    let gone = prune_packs(&names, protected, keep);
    for g in &gone { std::fs::remove_dir_all(packs_dir.join(g))?; }
    Ok(gone)
}

/// Everything a prune needs from the machine: the database server and the pack pointers of `posctl.json`.
pub trait PruneDeps {
    fn now_ms(&self) -> u64;
    fn db_names(&self) -> R<BTreeSet<String>>;
    fn drop_db(&self, name: &str) -> R<()>;
    /// `pack.current` and `pack.previous`. An error (not provisioned, unreadable) stops the prune: nothing is guessed.
    fn pack_pointers(&self, env: &Env) -> R<BTreeSet<String>>;
}

/// The databases of an operation in flight (or interrupted): its prev, its failed and its clone.
pub fn journal_names(n: Option<&DbNames>) -> BTreeSet<String> {
    n.map(|n| [n.prev.clone(), n.failed.clone(), n.next.clone()].into()).unwrap_or_default()
}

/// What housekeeping may drop: `prune_plan` (one `pos_prev_*` and one `pos_failed_*`, each at most a week old) minus the
/// operation in flight, and only names that are safe SQL identifiers (the plan is never trusted to have filtered them).
pub fn db_drop_plan(names: &BTreeSet<String>, now_ms: u64, protected: &BTreeSet<String>) -> Vec<String> {
    prune_plan(names, now_ms).into_iter().filter(|n| valid_ident(n) && !protected.contains(n)).collect()
}

/// Every old copy, for the gate that needs the room (`need_drop_old`); same exclusions.
pub fn db_drop_all_old(names: &BTreeSet<String>, protected: &BTreeSet<String>) -> Vec<String> {
    names.iter().filter(|n| (n.starts_with("pos_prev_") || n.starts_with("pos_failed_")) && valid_ident(n) && !protected.contains(*n)).cloned().collect()
}

/// What a housekeeping run did: what it dropped and what it could not (never hidden, never fatal to the rest).
#[derive(Debug, Default)]
pub struct DropReport { pub dropped: Vec<String>, pub errors: Vec<(String, String)>, pub list_error: Option<String> }

/// Drops the planned databases, one by one: a failed drop is recorded and the others still go. The caller holds `update.lock` and
/// has read the journal (`locked`).
pub fn drop_old_dbs(deps: &dyn PruneDeps, protected: &BTreeSet<String>, all_old: bool) -> DropReport {
    let mut out = DropReport::default();
    let names = match deps.db_names() { Ok(n) => n, Err(e) => { out.list_error = Some(e.reason); return out; } };
    let plan = if all_old { db_drop_all_old(&names, protected) } else { db_drop_plan(&names, deps.now_ms(), protected) };
    for n in plan {
        match deps.drop_db(&n) { Ok(()) => out.dropped.push(n), Err(e) => out.errors.push((n, e.reason)) }
    }
    out
}

/// The one door to any delete: lock exclusive (wait 0; an unreadable lock is NOT free), THEN the journal (corrupt, too new
/// or unreadable is RECOVERY_NEEDED), then `f` with the journal if there is one.
pub fn locked<T>(env: &Env, kind: &str, f: impl FnOnce(Option<&Journal>) -> R<T>) -> R<T> {
    if let LockState::Unknown(m) = probe_readonly_for(&env.roots) {
        return Err(OpError::new(OpCode::Precondition, "LOCK_STATE_UNKNOWN", format!("cannot tell whether another operation runs: {m}")));
    }
    let id = crate::util::random_uuid_v4().unwrap_or_else(|_| kind.into());
    let _guard = acquire_for(&env.roots, LockMode::Exclusive, kind, &id, Duration::from_secs(0))?;
    let j = Journal::read(&env.update_dir()).map_err(|e| OpError::new(OpCode::RecoveryNeeded, "JOURNAL_UNREADABLE", format!("the journal cannot be read ({e:?}); run `posctl update --recover`")))?;
    f(j.as_ref())
}

pub fn run(env: &Env, keep: usize, deps: &dyn PruneDeps) -> Report {
    let go = locked(env, "prune", |j| {
        let mut protected = deps.pack_pointers(env)?;
        if let Some(j) = j { protected.extend(j.pack_from.clone()); protected.extend(j.pack_to.clone()); }
        let removed = remove_unprotected(&env.program.join("packs"), &protected, keep).map_err(|e| OpError::err("PRUNE_IO", e.to_string()))?;
        let dropped = drop_old_dbs(deps, &journal_names(j.map(|j| &j.db)), false);
        Ok((removed, dropped))
    });
    match go {
        Ok((removed, d)) => {
            let errs: Vec<serde_json::Value> = d.errors.iter().map(|(n, r)| serde_json::json!({ "name": n, "reason": r })).collect();
            let failed = !errs.is_empty() || d.list_error.is_some();
            let msg = if failed { "pruned, but some database drops failed (see dropErrors)" } else { "pruned" };
            Report::new(OpCode::Ok, None, msg, serde_json::json!({
                "removedPacks": removed, "droppedDatabases": d.dropped, "dropErrors": errs, "databaseListError": d.list_error,
            }), false)
        }
        Err(e) => Report::from_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::OpKind;
    use std::cell::RefCell;

    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn keeps_the_newest_and_everything_protected_and_never_touches_foreign_folders() {
        let all = v(&["1.0.0-r1", "1.1.0-r1", "1.2.0-r1", "1.2.0-r2", "notes", "tmp-staging"]);
        let protected: BTreeSet<String> = ["1.1.0-r1".to_string()].into();
        assert_eq!(prune_packs(&all, &protected, 2), v(&["1.0.0-r1"]));
        assert!(prune_packs(&all, &protected, 10).is_empty());
    }
    #[test]
    fn at_least_two_are_always_kept() {
        let all = v(&["1.0.0-r1", "1.1.0-r1", "1.2.0-r1"]);
        assert_eq!(prune_packs(&all, &BTreeSet::new(), 0), v(&["1.0.0-r1"]));
    }
    #[test]
    fn the_filesystem_run_deletes_only_what_the_plan_says() {
        let d = tempfile::tempdir().unwrap();
        for n in ["1.0.0-r1", "1.1.0-r1", "1.2.0-r1", "keepme"] { std::fs::create_dir_all(d.path().join(n)).unwrap(); }
        let removed = remove_unprotected(d.path(), &["1.1.0-r1".to_string()].into_iter().collect(), 1).unwrap();
        assert_eq!(removed, v(&["1.0.0-r1"]));
        assert!(d.path().join("keepme").exists() && d.path().join("1.2.0-r1").exists() && d.path().join("1.1.0-r1").exists());
    }

    // ---- database housekeeping ----
    const NOW: u64 = 1_790_908_215_000; // 2026-10-02
    fn set(a: &[&str]) -> BTreeSet<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn the_plan_never_names_the_databases_of_the_operation_in_flight() {
        // a stuck operation started 20 days ago: its prev is older than the one-week rule, so prune_plan alone would drop it
        let stuck = DbNames::for_kind(OpKind::Update, NOW - 20 * 86_400_000);
        let names = set(&["postgres", &stuck.prev, &stuck.failed, "pos_prev_update_20200101000000"]);
        assert!(prune_plan(&names, NOW).contains(&stuck.prev), "the test must reproduce the hazard");
        let plan = db_drop_plan(&names, NOW, &journal_names(Some(&stuck)));
        assert!(!plan.contains(&stuck.prev) && !plan.contains(&stuck.failed), "{plan:?}");
        assert!(plan.contains(&"pos_prev_update_20200101000000".to_string()));
        assert!(!plan.contains(&"postgres".to_string()));
    }

    #[test]
    fn every_candidate_is_a_safe_identifier_before_it_is_sized_or_dropped() {
        let names = set(&["pos_prev_UPDATE_20200101000000", "pos_prev_update_20200101000000", "pos_failed_20200101000000"]);
        assert!(!prune_plan(&names, NOW).contains(&"pos_prev_UPDATE_20200101000000".to_string()), "prune_plan itself refuses it now");
        let plan = db_drop_plan(&names, NOW, &BTreeSet::new());
        assert!(plan.iter().all(|n| crate::ops::names::valid_ident(n)), "{plan:?}");
        assert_eq!(plan.len(), 2);
        let all = db_drop_all_old(&names, &BTreeSet::new());
        assert!(all.iter().all(|n| crate::ops::names::valid_ident(n)) && all.len() == 2, "{all:?}");
    }

    struct FakeDbs { names: RefCell<BTreeSet<String>>, dropped: RefCell<Vec<String>>, pointers: BTreeSet<String>, fail_on: Option<String> }
    impl PruneDeps for FakeDbs {
        fn now_ms(&self) -> u64 { NOW }
        fn db_names(&self) -> R<BTreeSet<String>> { Ok(self.names.borrow().clone()) }
        fn drop_db(&self, n: &str) -> R<()> {
            if self.fail_on.as_deref() == Some(n) { return Err(OpError::err("PSQL_FAILED", "locked")); }
            self.dropped.borrow_mut().push(n.to_string());
            Ok(())
        }
        fn pack_pointers(&self, _: &Env) -> R<BTreeSet<String>> { Ok(self.pointers.clone()) }
    }
    fn fake(names: &[&str], pointers: &[&str]) -> FakeDbs { FakeDbs { names: RefCell::new(set(names)), dropped: RefCell::new(vec![]), pointers: set(pointers), fail_on: None } }

    fn store() -> (tempfile::TempDir, Env) {
        let d = tempfile::tempdir().unwrap();
        let (data, prog) = (d.path().join("data"), d.path().join("prog"));
        let roots = crate::paths::Roots::custom(data.clone(), prog.clone());
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        for p in ["1.0.0-r1", "1.1.0-r1", "1.2.0-r1", "1.3.0-r1"] { std::fs::create_dir_all(prog.join("packs").join(p)).unwrap(); }
        let env = Env { data, program: prog, posctl_exe: d.path().join("posctl.exe"), ports: crate::ports::Ports::new(47300).unwrap(), roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
        (d, env)
    }
    fn packs(e: &Env) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(e.program.join("packs")).unwrap().flatten().map(|x| x.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    const OLD: &str = "pos_prev_update_20200101000000";

    #[test]
    fn another_holder_of_update_lock_means_lock_held_and_nothing_is_removed_or_dropped() {
        let (_d, env) = store();
        let _other = crate::ops::lock::acquire_for(&env.roots, crate::ops::lock::LockMode::Exclusive, "update", "op1", Duration::from_secs(0)).unwrap();
        let dbs = fake(&["postgres", OLD], &["1.3.0-r1", "1.2.0-r1"]);
        let r = run(&env, 2, &dbs);
        assert_eq!(r.code, OpCode::LockHeld, "{}", r.message);
        assert!(dbs.dropped.borrow().is_empty());
        assert_eq!(packs(&env).len(), 4);
    }

    #[test]
    fn an_unreadable_journal_refuses_with_recovery_needed_and_removes_nothing() {
        let (_d, env) = store();
        std::fs::write(env.update_dir().join("journal.json"), "{ not json").unwrap();
        let dbs = fake(&["postgres", OLD], &["1.3.0-r1", "1.2.0-r1"]);
        let r = run(&env, 2, &dbs);
        assert_eq!(r.code, OpCode::RecoveryNeeded, "{}", r.message);
        assert!(dbs.dropped.borrow().is_empty());
        assert_eq!(packs(&env).len(), 4);
    }

    #[test]
    fn a_journal_protects_both_of_its_packs_and_its_databases() {
        let (_d, env) = store();
        let j = Journal::new(OpKind::Update, "op", NOW - 20 * 86_400_000, NOW, Some("1.0.0-r1".into()), Some("1.1.0-r1".into()));
        j.write(&env.update_dir()).unwrap();
        let dbs = fake(&["postgres", &j.db.prev, OLD], &["1.3.0-r1", "1.2.0-r1"]);
        let r = run(&env, 2, &dbs);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert_eq!(packs(&env), ["1.0.0-r1", "1.1.0-r1", "1.2.0-r1", "1.3.0-r1"], "both packs of the journal stay");
        assert_eq!(*dbs.dropped.borrow(), [OLD]);
    }

    #[test]
    fn without_a_journal_old_packs_and_databases_go_and_the_pointers_stay() {
        let (_d, env) = store();
        let dbs = fake(&["postgres", OLD], &["1.0.0-r1"]);
        let r = run(&env, 2, &dbs);
        assert_eq!(r.code, OpCode::Ok, "{}", r.message);
        assert_eq!(packs(&env), ["1.0.0-r1", "1.2.0-r1", "1.3.0-r1"], "1.0.0-r1 is pack.previous");
        assert_eq!(*dbs.dropped.borrow(), [OLD]);
        assert_eq!(r.data["removedPacks"], serde_json::json!(["1.1.0-r1"]));
    }

    #[test]
    fn the_locked_helper_does_not_run_its_action_while_another_holder_has_the_lock() {
        let (_d, env) = store();
        let _other = crate::ops::lock::acquire_for(&env.roots, crate::ops::lock::LockMode::Exclusive, "update", "op1", Duration::from_secs(0)).unwrap();
        let ran = std::cell::Cell::new(false);
        let e = locked(&env, "housekeeping", |_| { ran.set(true); Ok(()) }).unwrap_err();
        assert_eq!(e.code, OpCode::LockHeld);
        assert!(!ran.get());
    }

    #[test]
    fn lb_a_failed_drop_is_reported_in_the_data_and_the_others_still_go() {
        let (_d, env) = store();
        let mut dbs = fake(&["postgres", OLD, "pos_failed_20200101000000"], &["1.3.0-r1", "1.2.0-r1"]);
        dbs.fail_on = Some(OLD.to_string());
        let r = run(&env, 2, &dbs);
        assert_eq!(*dbs.dropped.borrow(), ["pos_failed_20200101000000"], "the other drop still happened");
        let errs = r.data["dropErrors"].as_array().cloned().unwrap_or_default();
        assert_eq!(errs.len(), 1, "{:?}", r.data);
        assert_eq!(errs[0]["name"], OLD);
        assert!(r.message.contains("failed"), "{}", r.message);
    }
}
