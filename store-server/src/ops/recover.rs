//! Recovery: decide from the journal and `pg_database` alone (conventions 11.3).
//! The caller holds `update.lock` exclusive and read the journal with `Journal::read` (never `peek`),
//! so a corrupt journal is told apart from an absent one before it gets here.
use crate::ops::journal::{Journal, Phase, Step};
use crate::ops::runner::{forward_from_swap, reopen_and_finalize, rollback, Timings};
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::{OpCtx, OpWork, World, R};
use std::collections::BTreeSet;

#[derive(Debug, PartialEq, Eq)]
pub enum Recovery { RollBack, ResumeAfterSwap, RollForwardReopen, Unresolvable(String) }

#[derive(Debug, PartialEq, Eq)]
pub enum Recovered { Nothing, RolledBack { reason: String }, RolledForward }

pub fn ctx_from_journal(j: &Journal) -> OpCtx {
    OpCtx { op_id: j.op_id.clone(), names: j.db.clone(), pack_from: j.pack_from.clone(), pack_to: j.pack_to.clone(), deadline_ms: u64::MAX }
}

pub fn decide(j: &Journal, names: &BTreeSet<String>) -> Recovery {
    let has = |n: &str| names.contains(n);
    if !has(&j.db.live) { return Recovery::Unresolvable("the live database is missing".into()); }
    // The rename is one transaction: after it `prev` exists; a swap-back moves it on to `failed`.
    let swapped = has(&j.db.prev) && !has(&j.db.failed);
    let unresolved = |m: &str| Recovery::Unresolvable(m.to_string());
    match j.step {
        Step::Rollback => Recovery::RollBack,
        Step::Reopen | Step::Finalize => if swapped { Recovery::RollForwardReopen } else { unresolved("the reopen was reached but the swap is not visible") },
        Step::Swap if j.phase == Phase::Intent => {
            if swapped { Recovery::ResumeAfterSwap }
            else if has(&j.db.next) { Recovery::RollBack }
            else { unresolved("a swap was intended but neither the clone nor the previous database exists") }
        }
        Step::Swap | Step::Activate | Step::VerifyLive => if swapped { Recovery::ResumeAfterSwap } else { unresolved("the swap is journaled but not visible") },
        Step::Started | Step::Fence | Step::Backup | Step::RepairCollation | Step::CloneDb | Step::Work | Step::VerifyClone => Recovery::RollBack,
    }
}

pub fn recover(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, j: &mut Journal) -> R<Recovered> {
    // After a crash, and above all after a reboot, the fence (maintenance gateway, NOLOGIN roles, recovery policy) is not
    // guaranteed to be up. Assert it again, idempotently, before anything touches a database (a sale taken in the window
    // would land in a database that the rollback renames to pos_failed_*).
    w.fence().map_err(|e| OpError::new(OpCode::RecoveryNeeded, "FENCE_FAILED", format!("could not fence the tills before recovering: {}", e.message)))?;
    let names = w.db_names()?;
    match decide(j, &names) {
        Recovery::RollBack => {
            let reason = j.rollback_reason.clone().unwrap_or_else(|| "RECOVERED_AFTER_INTERRUPTION".into());
            rollback(w, work, ctx, j, &reason)?;
            Ok(Recovered::RolledBack { reason })
        }
        Recovery::ResumeAfterSwap => match forward_from_swap(w, work, ctx, j, Timings::default()) {
            Ok(_) => Ok(Recovered::RolledForward),
            Err(e) if e.code == OpCode::RecoveryNeeded => Err(e),
            Err(e) => Ok(Recovered::RolledBack { reason: e.reason }),
        },
        Recovery::RollForwardReopen => {
            // A reboot restores the services to the pack the pointer names, which is still the old one until `on_commit`
            // has run: re-point them to the new pack before the gateway opens, or old services run on the new schema.
            if ctx.pack_from != ctx.pack_to {
                if let Some(to) = &ctx.pack_to {
                    w.activate_pack(to).map_err(|e| OpError::new(OpCode::RecoveryNeeded, "REOPEN_FAILED", format!("after the point of no return, fix forward: {}", e.message)))?;
                }
            }
            reopen_and_finalize(w, work, ctx, j, Timings::default())?;
            Ok(Recovered::RolledForward)
        }
        Recovery::Unresolvable(why) => Err(OpError::new(OpCode::RecoveryNeeded, "UNRESOLVABLE", why)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::OpKind;

    fn j(step: Step, phase: Phase) -> Journal {
        let mut j = Journal::new(OpKind::Update, "op", 1_790_908_215_000, 0, Some("a".into()), Some("b".into()));
        j.step = step; j.phase = phase; j
    }
    fn names(list: &[&str]) -> BTreeSet<String> { list.iter().map(|s| s.to_string()).collect() }
    const PREV: &str = "pos_prev_update_20261002023015";
    const FAILED: &str = "pos_failed_20261002023015";

    #[test]
    fn before_the_swap_everything_rolls_back() {
        for step in [Step::Started, Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb, Step::Work, Step::VerifyClone] {
            for phase in [Phase::Intent, Phase::Done] {
                for n in [names(&["postgres"]), names(&["postgres", "pos_next"])] {
                    assert_eq!(decide(&j(step, phase), &n), Recovery::RollBack, "{step:?}/{phase:?}");
                }
            }
        }
    }

    #[test]
    fn a_swap_intent_is_resolved_by_what_pg_database_shows() {
        let i = j(Step::Swap, Phase::Intent);
        assert_eq!(decide(&i, &names(&["postgres", "pos_next"])), Recovery::RollBack);
        assert_eq!(decide(&i, &names(&["postgres", PREV])), Recovery::ResumeAfterSwap);
        assert!(matches!(decide(&i, &names(&["postgres"])), Recovery::Unresolvable(_)));
    }

    #[test]
    fn after_the_swap_and_before_the_reopen_recovery_resumes_and_re_verifies() {
        for step in [Step::Swap, Step::Activate, Step::VerifyLive] {
            assert_eq!(decide(&j(step, Phase::Done), &names(&["postgres", PREV])), Recovery::ResumeAfterSwap, "{step:?}");
        }
    }

    #[test]
    fn from_the_reopen_intent_on_recovery_only_rolls_forward() {
        for step in [Step::Reopen, Step::Finalize] {
            assert_eq!(decide(&j(step, Phase::Intent), &names(&["postgres", PREV])), Recovery::RollForwardReopen);
        }
    }

    #[test]
    fn an_interrupted_rollback_is_resumed_whatever_the_names_show() {
        let r = j(Step::Rollback, Phase::Intent);
        for n in [names(&["postgres", PREV]), names(&["postgres", FAILED]), names(&["postgres", "pos_next"])] {
            assert_eq!(decide(&r, &n), Recovery::RollBack);
        }
    }

    #[test]
    fn a_missing_live_database_is_never_guessed_at() {
        assert!(matches!(decide(&j(Step::Work, Phase::Done), &names(&["pos_next"])), Recovery::Unresolvable(_)));
    }
}
