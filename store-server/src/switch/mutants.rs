//! Plan 09 T12 negative controls: ONE seam, `on(M)`. A production safety control asks `on(M::X)` where it would otherwise run; a
//! control test arms one mutant, runs the test that PINS the control and requires it to go RED with the expected text
//! (`expect_red`). The pinned test itself, unarmed, is the GREEN half.
//!
//! In every non-test build `on` is `const fn ... -> bool { false }`, `#[inline(always)]`, with no runtime flag and no environment
//! read: each call site `if on(M::X) { mutated } else { original }` is the original code with a constant-false condition.
//! The test machinery below (thread-local state, arming, `expect_red`) exists only under `#[cfg(test)]`.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum M {
    /// verify::fp_blank_null returns no column (a NULL cloud token no longer reads as '').
    BlankNullOff,
    /// verify::fp_volatile returns no column (the re-derived password and updated_at are fingerprinted).
    VolatileEmpty,
    /// rederive::apply plans the re-derive with an empty keep set.
    KeepSkipOff,
    /// rederive::apply never runs the re-derive script.
    ScriptSkipped,
    /// verify::verify_clone no longer checks till_sync_report for a copy.
    SkipCopyLosesTillSyncReport,
    /// verify::verify_clone no longer runs the sequence check.
    SequenceCheckDeleted,
    /// verify::sequence_findings stops reporting `next == max` (`<=` becomes `<`).
    SequenceBoundary,
    /// rederive::refuse_if_switched lets an unknown mode through (default arm becomes `{}`).
    RefuseDefaultArmOpen,
    /// facts::SQL_UNGUARDED stops requiring `tgtype = 62` (a guard that misses TRUNCATE or fires AFTER counts as a guard).
    GuardNoTgtype,
    /// facts::SQL_UNGUARDED stops requiring `tgqual IS NULL` (a guard with a WHEN condition counts as a guard).
    GuardNoTgqual,
    /// facts::SQL_UNGUARDED stops requiring no `UPDATE OF` column list (a column-scoped guard counts as a guard).
    GuardNoTgattr,
    /// facts::COVERED sees only ordinary tables (`relkind = 'r'`): a partitioned table needs no guard.
    CoveredOrdinaryOnly,
    /// facts::SQL_DEFAULT_REPLICA drops its `system` branch (a replica default read by the checking session is not reported).
    DefaultReplicaNoSystem,
}

/// Non-test builds: a constant `false`.
#[cfg(not(test))]
#[inline(always)]
pub const fn on(_m: M) -> bool {
    false
}

#[cfg(test)]
pub use armed::{expect_red, on};

#[cfg(test)]
mod armed {
    use super::M;
    use std::cell::Cell;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    thread_local! { static ARMED: Cell<Option<M>> = const { Cell::new(None) }; }

    pub fn on(m: M) -> bool {
        ARMED.with(|a| a.get() == Some(m))
    }

    /// Disarms on drop (also when the pinned test panicked).
    pub struct Armed;
    impl Drop for Armed {
        fn drop(&mut self) {
            ARMED.with(|a| a.set(None));
        }
    }
    pub fn arm(m: M) -> Armed {
        ARMED.with(|a| {
            assert!(a.get().is_none(), "a mutant is already armed");
            a.set(Some(m));
        });
        Armed
    }

    fn text(p: Box<dyn std::any::Any + Send>) -> String {
        p.downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "(non-text panic)".into())
    }

    /// Arms `m`, runs `pinned` and requires it to panic with `expect` in the message. Prints `failed as expected` (RED proven).
    pub fn expect_red(m: M, expect: &str, pinned: impl FnOnce()) {
        let msg = {
            let _armed = arm(m);
            match catch_unwind(AssertUnwindSafe(pinned)) {
                Ok(()) => panic!(
                    "control {m:?} NOT pinned: the test stayed green with the control removed"
                ),
                Err(p) => text(p),
            }
        };
        assert!(
            msg.contains(expect),
            "control {m:?} went red for the wrong reason (wanted {expect:?}): {msg}"
        );
        println!(
            "failed as expected [{m:?}]: {}",
            msg.lines().next().unwrap_or("")
        );
    }

    #[test]
    fn a_mutant_is_disarmed_after_the_guard_drops() {
        {
            let _g = arm(M::KeepSkipOff);
            assert!(on(M::KeepSkipOff) && !on(M::BlankNullOff));
        }
        assert!(!on(M::KeepSkipOff));
    }
}
