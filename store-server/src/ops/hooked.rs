//! Wraps a World so a Sandbox scenario can kill the process before/after any call or after any journal write.
//! Everything that can inject lives behind `--features test-hooks`; a plain build gets `wrap` = `Box::new` and contains
//! none of this module's strings (the labels are only ever built under the feature).
use crate::ops::world::World;

#[cfg(not(feature = "test-hooks"))]
#[inline(always)]
pub fn wrap<W: World + 'static>(w: W) -> Box<dyn World> { Box::new(w) }

#[cfg(feature = "test-hooks")]
pub fn wrap<W: World + 'static>(w: W) -> Box<dyn World> { Box::new(HookedWorld(w)) }

#[cfg(feature = "test-hooks")]
pub struct HookedWorld<W: World>(pub W);

#[cfg(feature = "test-hooks")]
mod imp {
    use super::HookedWorld;
    use crate::ops::hooks::hit;
    use crate::ops::journal::Journal;
    use crate::ops::names::DbNames;
    use crate::ops::world::{BackupReason, World, R};
    use std::collections::BTreeSet;

    pub fn snake<T: serde::Serialize>(v: T) -> String { serde_json::to_value(v).ok().and_then(|x| x.as_str().map(str::to_string)).unwrap_or_default() }
    /// `journal:<step>:<phase>` with serde's snake_case names (`verify_live`, `clone_db`).
    pub fn journal_label(j: &Journal) -> String { format!("journal:{}:{}", snake(j.step), snake(j.phase)) }

    macro_rules! around {
        ($name:literal, $call:expr) => {{ hit(concat!("before:", $name)); let r = $call; hit(concat!("after:", $name)); r }};
    }

    impl<W: World> World for HookedWorld<W> {
        fn now_ms(&self) -> u64 { self.0.now_ms() }
        fn warnings(&self) -> Vec<String> { self.0.warnings() }
        fn journal_write(&mut self, j: &Journal) -> R<()> {
            let r = self.0.journal_write(j);
            hit(&journal_label(j)); // AFTER the write: the process dies with this step on disk
            r
        }
        fn journal_archive(&mut self, j: &Journal) -> R<()> { around!("journal_archive", self.0.journal_archive(j)) }
        fn db_names(&mut self) -> R<BTreeSet<String>> { self.0.db_names() }
        fn fence(&mut self) -> R<()> { around!("fence", self.0.fence()) }
        fn run_backup(&mut self, r: BackupReason, t: u64) -> R<()> { around!("run_backup", self.0.run_backup(r, t)) }
        fn create_clone(&mut self, n: &DbNames) -> R<()> { around!("create_clone", self.0.create_clone(n)) }
        fn drop_db(&mut self, name: &str) -> R<()> { self.0.drop_db(name) }
        fn swap(&mut self, n: &DbNames) -> R<()> { around!("swap", self.0.swap(n)) }
        fn swap_back(&mut self, n: &DbNames) -> R<()> { around!("swap_back", self.0.swap_back(n)) }
        fn activate_pack(&mut self, v: &str) -> R<()> { around!("activate_pack", self.0.activate_pack(v)) }
        fn start_internal_stack(&mut self) -> R<()> { self.0.start_internal_stack() }
        fn stop_internal_stack(&mut self) -> R<()> { self.0.stop_internal_stack() }
        fn reopen_gateway(&mut self) -> R<()> { around!("reopen_gateway", self.0.reopen_gateway()) }
        fn finish_unfence(&mut self) -> R<()> { around!("finish_unfence", self.0.finish_unfence()) }
    }
}

/// Every point a scenario can kill the process at on the forward path: after each journal write (`journal:<step>:<phase>`)
/// the unfence (before and after) and after the gateway reopen. The runner's rollback writes are covered by the crash-at-every-call matrices, not here.
#[cfg(feature = "test-hooks")]
pub fn journal_labels() -> Vec<String> {
    use crate::ops::journal::{Phase, Step};
    let mut v = vec!["journal:started:done".to_string()];
    for s in [Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb, Step::Work, Step::VerifyClone, Step::Swap, Step::Activate, Step::VerifyLive, Step::Reopen] {
        for p in [Phase::Intent, Phase::Done] { v.push(format!("journal:{}:{}", imp::snake(s), imp::snake(p))); }
    }
    v.push("journal:finalize:intent".into());
    v.push("before:finish_unfence".into());
    v.push("after:finish_unfence".into());
    v.push("after:reopen_gateway".into());
    v
}

#[cfg(all(test, feature = "test-hooks"))]
mod tests {
    use super::*;
    use crate::ops::fake::*;
    use crate::ops::journal::{Journal, Phase, Step};
    use crate::ops::names::DbNames;
    use crate::ops::outcome::OpKind;
    use crate::ops::runner::run_operation;
    use crate::ops::world::{BackupReason, OpCtx, R};
    use std::collections::BTreeSet;

    /// Every journal write the happy path makes, taken from the runner itself rather than from a list in this file.
    struct Recorder { inner: FakeWorld, writes: Vec<(Step, Phase)>, calls: Vec<&'static str> }
    impl World for Recorder {
        fn now_ms(&self) -> u64 { self.inner.now_ms() }
        fn journal_write(&mut self, j: &Journal) -> R<()> { self.writes.push((j.step, j.phase)); self.inner.journal_write(j) }
        fn journal_archive(&mut self, j: &Journal) -> R<()> { self.inner.journal_archive(j) }
        fn db_names(&mut self) -> R<BTreeSet<String>> { self.inner.db_names() }
        fn fence(&mut self) -> R<()> { self.inner.fence() }
        fn run_backup(&mut self, r: BackupReason, t: u64) -> R<()> { self.inner.run_backup(r, t) }
        fn create_clone(&mut self, n: &DbNames) -> R<()> { self.inner.create_clone(n) }
        fn drop_db(&mut self, name: &str) -> R<()> { self.inner.drop_db(name) }
        fn swap(&mut self, n: &DbNames) -> R<()> { self.inner.swap(n) }
        fn swap_back(&mut self, n: &DbNames) -> R<()> { self.inner.swap_back(n) }
        fn activate_pack(&mut self, v: &str) -> R<()> { self.inner.activate_pack(v) }
        fn start_internal_stack(&mut self) -> R<()> { self.inner.start_internal_stack() }
        fn stop_internal_stack(&mut self) -> R<()> { self.inner.stop_internal_stack() }
        fn reopen_gateway(&mut self) -> R<()> { self.calls.push("reopen_gateway"); self.inner.reopen_gateway() }
        fn finish_unfence(&mut self) -> R<()> { self.inner.finish_unfence() }
    }

    fn ctx() -> OpCtx {
        OpCtx { op_id: "op".into(), names: DbNames::for_kind(OpKind::Update, T0), pack_from: Some("old".into()), pack_to: Some("new".into()), deadline_ms: T0 + 900_000 }
    }
    fn journal() -> Journal { Journal::new(OpKind::Update, "op", T0, T0 + 900_000, Some("old".into()), Some("new".into())) }
    fn snake<T: serde::Serialize>(v: T) -> String { serde_json::to_value(v).unwrap().as_str().unwrap().to_string() }

    fn happy_path_writes() -> Vec<(Step, Phase)> {
        let s = fresh();
        let mut w = Recorder { inner: FakeWorld(s.clone()), writes: vec![], calls: vec![] };
        run_operation(&mut w, &mut FakeWork(s), &ctx(), journal()).expect("the happy path completes");
        w.writes
    }

    #[test]
    fn every_journal_step_and_the_gateway_reopen_has_a_kill_label() {
        let l = journal_labels();
        assert_eq!(l.len(), 25);
        assert_eq!(l.first().map(String::as_str), Some("journal:started:done"));
        assert_eq!(l.iter().collect::<BTreeSet<_>>().len(), l.len(), "no label twice");
        // EVERY label the module defines, not a sample: the 20 step labels, the finalize intent, the unfence and the gateway reopen
        let mut want: Vec<String> = vec!["journal:started:done".into()];
        for s in [Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb, Step::Work, Step::VerifyClone, Step::Swap, Step::Activate, Step::VerifyLive, Step::Reopen] {
            for p in [Phase::Intent, Phase::Done] { want.push(format!("journal:{}:{}", snake(s), snake(p))); }
        }
        want.push("journal:finalize:intent".into());
        want.push("before:finish_unfence".into());
        want.push("after:finish_unfence".into());
        want.push("after:reopen_gateway".into());
        for w in &want { assert!(l.iter().any(|x| x == w), "missing kill label {w}"); }
        assert_eq!(want.len(), l.len(), "a label nobody asked for");
        // and the runner never writes a journal state that has no label (a new Step/Phase must grow this list)
        for (s, p) in happy_path_writes() {
            let label = format!("journal:{}:{}", snake(s), snake(p));
            assert!(l.contains(&label), "the runner writes {label} but it has no kill label");
        }
    }

    /// Drives the happy path once per label with `pause_at` (0 ms) and proves the wrapper really reaches every one.
    #[test]
    fn the_hooked_world_reaches_every_kill_label_on_the_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(journal_labels().len(), 25);
        for label in journal_labels() {
            let flag = dir.path().join("flag");
            let _ = std::fs::remove_file(&flag);
            std::env::set_var("POSCTL_TEST_HOOKS", serde_json::json!({ "pause_at": { "label": label, "flag": flag, "ms": 0 } }).to_string());
            let s = fresh();
            let mut w = HookedWorld(FakeWorld(s.clone()));
            run_operation(&mut w, &mut FakeWork(s), &ctx(), journal()).expect("the happy path completes");
            assert_eq!(std::fs::read_to_string(&flag).ok().as_deref(), Some(label.as_str()), "{label} was never hit");
        }
        std::env::remove_var("POSCTL_TEST_HOOKS");
    }
}
