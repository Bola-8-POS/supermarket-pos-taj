//! The one operation procedure (conventions 11.3). Fence, backup, clone, work, verify the clone, swap,
//! activate, verify behind the fence, then reopen = the point of no return.
//! The caller holds `update.lock` exclusive for the whole run; nothing here takes it.
use crate::ops::journal::{Journal, Phase, Step};
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::{OpCtx, OpWork, World, R};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Timings { last: u64, pub items: Vec<(String, u64)> }
impl Timings {
    fn start(now: u64) -> Self { Timings { last: now, items: vec![] } }
    fn lap(&mut self, now: u64, name: &str) { self.items.push((name.to_string(), now.saturating_sub(self.last))); self.last = now; }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome { pub timings: Timings, pub prev_db: String, pub failed_db: Option<String> }

fn mark(w: &mut dyn World, j: &mut Journal, step: Step, phase: Phase) -> R<()> {
    j.step = step;
    j.phase = phase;
    w.journal_write(j)
}

/// One phase done: the lap goes into the report's timings, and for a work that asks (`wants_timings`) into `j.extra.timingsMs` as well,
/// which the next journal write saves. A work that does not ask leaves the journal byte-identical.
fn lap(t: &mut Timings, w: &dyn World, work: &dyn OpWork, j: &mut Journal, name: &str) {
    t.lap(w.now_ms(), name);
    if !work.wants_timings() { return; }
    let ms = t.items.last().map(|(_, ms)| *ms).unwrap_or(0);
    merge_extra(&mut j.extra, serde_json::json!({ "timingsMs": { name: ms } }));
}

/// A journal patch is an object merged INTO `extra`; anything else is ignored (it can never replace what `extra` already holds).
fn apply_patch(extra: &mut serde_json::Value, patch: serde_json::Value) {
    if patch.is_object() { merge_extra(extra, patch); }
}

/// Object keys of `patch` replace those of `dst`, one level at a time; anything else replaces `dst`.
fn merge_extra(dst: &mut serde_json::Value, patch: serde_json::Value) {
    match patch {
        serde_json::Value::Object(p) => {
            if !dst.is_object() { *dst = serde_json::json!({}); }
            if let Some(d) = dst.as_object_mut() {
                for (k, v) in p { merge_extra(d.entry(k).or_insert(serde_json::Value::Null), v); }
            }
        }
        other => *dst = other,
    }
}

fn deadline(w: &dyn World, ctx: &OpCtx, before: &str) -> R<()> {
    if w.now_ms() > ctx.deadline_ms {
        return Err(OpError::new(OpCode::RolledBack, "MAINTENANCE_BUDGET", format!("maintenance budget exceeded before {before}")));
    }
    Ok(())
}

macro_rules! tri {
    ($w:expr, $work:expr, $ctx:expr, $j:expr, $e:expr) => {
        match $e { Ok(v) => v, Err(err) => return Err(abort($w, $work, $ctx, $j, err)) }
    };
}

pub fn run_operation(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, mut j: Journal) -> R<Outcome> {
    let mut t = Timings::start(w.now_ms());
    mark(w, &mut j, Step::Started, Phase::Done)?; // nothing to undo yet

    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Fence, Phase::Intent));
    tri!(w, work, ctx, &mut j, w.fence());
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Fence, Phase::Done));
    lap(&mut t, w, work, &mut j, "fence");

    tri!(w, work, ctx, &mut j, deadline(w, ctx, "the backup"));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Backup, Phase::Intent));
    let share = ctx.deadline_ms.saturating_sub(w.now_ms()).saturating_mul(2) / 5;
    tri!(w, work, ctx, &mut j, w.run_backup(work.backup_reason(), share));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Backup, Phase::Done));
    lap(&mut t, w, work, &mut j, "backup");

    // PostgreSQL refuses to clone a template with a stale collation version: refresh it on the source first. Idempotent, and a rollback keeps it.
    tri!(w, work, ctx, &mut j, deadline(w, ctx, "the collation repair"));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::RepairCollation, Phase::Intent));
    tri!(w, work, ctx, &mut j, work.repair_source(ctx));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::RepairCollation, Phase::Done));
    lap(&mut t, w, work, &mut j, "repair_collation");

    tri!(w, work, ctx, &mut j, deadline(w, ctx, "the clone"));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::CloneDb, Phase::Intent));
    if work.needs_clone() {
        tri!(w, work, ctx, &mut j, w.create_clone(&ctx.names));
    }
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::CloneDb, Phase::Done));
    lap(&mut t, w, work, &mut j, "clone");

    tri!(w, work, ctx, &mut j, deadline(w, ctx, "the work on the clone"));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Work, Phase::Intent));
    let worked = work.work_on_clone(ctx);
    if let Some(p) = work.journal_patch() { apply_patch(&mut j.extra, p); }
    tri!(w, work, ctx, &mut j, worked);
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Work, Phase::Done));
    lap(&mut t, w, work, &mut j, "work");

    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::VerifyClone, Phase::Intent));
    tri!(w, work, ctx, &mut j, work.verify_clone(ctx));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::VerifyClone, Phase::Done));
    lap(&mut t, w, work, &mut j, "verify_clone");

    tri!(w, work, ctx, &mut j, deadline(w, ctx, "the swap"));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Swap, Phase::Intent));
    tri!(w, work, ctx, &mut j, w.swap(&ctx.names));
    tri!(w, work, ctx, &mut j, mark(w, &mut j, Step::Swap, Phase::Done));
    lap(&mut t, w, work, &mut j, "swap");

    forward_from_swap(w, work, ctx, &mut j, t)
}

/// Activate the new pack, start the internal stack, verify behind the fence, then cross the point of no return.
/// Shared by the first run and by recovery. A failure before `Reopen` rolls back (swap back).
pub(crate) fn forward_from_swap(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, j: &mut Journal, mut t: Timings) -> R<Outcome> {
    tri!(w, work, ctx, j, deadline(w, ctx, "the activation"));
    tri!(w, work, ctx, j, mark(w, j, Step::Activate, Phase::Intent));
    if ctx.pack_from != ctx.pack_to {
        if let Some(to) = &ctx.pack_to { tri!(w, work, ctx, j, w.activate_pack(to)); }
    }
    tri!(w, work, ctx, j, work.after_activate(ctx));
    tri!(w, work, ctx, j, mark(w, j, Step::Activate, Phase::Done));
    lap(&mut t, w, work, j, "activate");

    tri!(w, work, ctx, j, w.start_internal_stack());
    tri!(w, work, ctx, j, mark(w, j, Step::VerifyLive, Phase::Intent));
    tri!(w, work, ctx, j, work.verify_live(ctx));
    tri!(w, work, ctx, j, mark(w, j, Step::VerifyLive, Phase::Done));
    lap(&mut t, w, work, j, "verify_live");

    // No budget check here: the budget only stops NEW phases, it never undoes an update that verify_live has passed.
    // The intent below is the point of no return: from here recovery rolls FORWARD only.
    tri!(w, work, ctx, j, mark(w, j, Step::Reopen, Phase::Intent));
    reopen_and_finalize(w, work, ctx, j, t)
}

fn after_ponr(e: OpError) -> OpError {
    // an error that already says "fix forward" (SELF_PAIR_FAILED, MODE_NOT_SAVED, ...) keeps its own reason
    if e.code == OpCode::RecoveryNeeded { return e; }
    OpError::new(OpCode::RecoveryNeeded, "REOPEN_FAILED", format!("after the point of no return, fix forward: {}", e.message))
}

/// Everything after the point of no return. Idempotent: recovery re-enters here.
pub(crate) fn reopen_and_finalize(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, j: &mut Journal, mut t: Timings) -> R<Outcome> {
    w.start_internal_stack().map_err(after_ponr)?;
    work.on_commit(ctx).map_err(after_ponr)?;
    mark(w, j, Step::Reopen, Phase::Done).map_err(after_ponr)?;
    // Lift the fence, THEN open the gateway: the tills never see a live gateway on a fenced stack (as `complete_unfence`).
    w.finish_unfence().map_err(after_ponr)?;
    w.reopen_gateway().map_err(after_ponr)?;
    mark(w, j, Step::Finalize, Phase::Intent).map_err(after_ponr)?;
    lap(&mut t, w, work, j, "reopen");
    w.journal_archive(j).map_err(after_ponr)?;
    Ok(Outcome { timings: t, prev_db: ctx.names.prev.clone(), failed_db: None })
}

fn abort(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, j: &mut Journal, mut cause: OpError) -> OpError {
    if cause.code == OpCode::Error { cause.code = OpCode::RolledBack; }
    match rollback(w, work, ctx, j, &cause.reason) {
        Ok(()) => { cause.from = j.rollback_from; cause }
        Err(e) => OpError::new(OpCode::RecoveryNeeded, "ROLLBACK_FAILED", format!("{} (while rolling back after: {})", e.message, cause.message)),
    }
}

/// Undo everything before the point of no return and bring the OLD level back, still behind the fence until it is verified.
pub(crate) fn rollback(w: &mut dyn World, work: &mut dyn OpWork, ctx: &OpCtx, j: &mut Journal, reason: &str) -> R<()> {
    // FIRST, before the journal write (which can hang or fail): whatever renews a hold for the operation stops now
    work.rollback_started();
    if j.step != Step::Rollback {
        j.rollback_from = Some(j.step);
        j.rollback_reason = Some(reason.to_string());
    }
    j.step = Step::Rollback;
    j.phase = Phase::Intent;
    w.journal_write(j)?;
    let from = j.rollback_from.unwrap_or(Step::Started);

    w.stop_internal_stack()?;
    if from >= Step::Activate && ctx.pack_from != ctx.pack_to {
        if let Some(f) = &ctx.pack_from { w.activate_pack(f)?; }
    }
    let names = w.db_names()?;
    if names.contains(&ctx.names.prev) && !names.contains(&ctx.names.failed) { w.swap_back(&ctx.names)?; }
    if w.db_names()?.contains(&ctx.names.next) { w.drop_db(&ctx.names.next)?; }

    w.start_internal_stack()?;
    work.verify_after_rollback(ctx)?;
    w.finish_unfence()?;
    w.reopen_gateway()?;
    j.phase = Phase::Done;
    w.journal_write(j)?;
    w.journal_archive(j)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_patch, merge_extra, reopen_and_finalize, Timings};
    use crate::ops::fake::{fresh, FakeWorld, T0};
    use crate::ops::journal::{Journal, Step};
    use crate::ops::names::DbNames;
    use crate::ops::outcome::{OpCode, OpError, OpKind};
    use crate::ops::world::{BackupReason, OpCtx, OpWork, R};
    use serde_json::json;

    /// A work whose `on_commit` fails with a chosen error.
    struct CommitFails(OpError);
    impl OpWork for CommitFails {
        fn kind(&self) -> OpKind { OpKind::Update }
        fn backup_reason(&self) -> BackupReason { BackupReason::PreUpdate }
        fn work_on_clone(&mut self, _: &OpCtx) -> R<()> { Ok(()) }
        fn verify_clone(&mut self, _: &OpCtx) -> R<()> { Ok(()) }
        fn verify_live(&mut self, _: &OpCtx) -> R<()> { Ok(()) }
        fn on_commit(&mut self, _: &OpCtx) -> R<()> { Err(self.0.clone()) }
    }
    fn commit_error(e: OpError) -> OpError {
        let ctx = OpCtx { op_id: "op".into(), names: DbNames::for_kind(OpKind::Update, T0), pack_from: None, pack_to: None, deadline_ms: u64::MAX };
        let mut j = Journal::new(OpKind::Update, "op", T0, 0, None, None);
        j.step = Step::Reopen;
        let s = fresh();
        reopen_and_finalize(&mut FakeWorld(s), &mut CommitFails(e), &ctx, &mut j, Timings::default()).unwrap_err()
    }

    #[test]
    fn a_recovery_needed_on_commit_error_keeps_its_own_reason() {
        let e = commit_error(OpError::new(OpCode::RecoveryNeeded, "SELF_PAIR_FAILED", "x; run `posctl update --recover`"));
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RecoveryNeeded, "SELF_PAIR_FAILED"), "{e:?}");
    }

    #[test]
    fn any_other_on_commit_error_is_still_reported_as_reopen_failed() {
        let e = commit_error(OpError::err("BOOM", "x"));
        assert_eq!((e.code, e.reason.as_str()), (OpCode::RecoveryNeeded, "REOPEN_FAILED"), "{e:?}");
    }

    #[test]
    fn a_patch_that_is_not_an_object_is_ignored_and_never_replaces_extra() {
        let keep = json!({ "recoverAttempts": [1], "switch": { "k": 1 } });
        for bad in [json!(null), json!(5), json!("x"), json!([1, 2])] {
            let mut x = keep.clone();
            apply_patch(&mut x, bad);
            assert_eq!(x, keep);
        }
        let mut x = keep.clone();
        apply_patch(&mut x, json!({ "switch": { "k": 2 } }));
        assert_eq!(x["switch"]["k"], 2);
    }

    #[test]
    fn a_journal_patch_replaces_leaves_one_level_at_a_time_and_keeps_the_rest() {
        let mut x = json!({ "switch": { "waived": ["a"], "waivedQueueDepth": { "a": 3 } }, "recoverAttempts": [] });
        merge_extra(&mut x, json!({ "switch": { "waivedQueueDepth": { "a": 7 }, "waivedQueueDepthAtPlan": { "a": 3 } } }));
        assert_eq!(x["switch"]["waivedQueueDepth"], json!({ "a": 7 }));
        assert_eq!(x["switch"]["waivedQueueDepthAtPlan"], json!({ "a": 3 }));
        assert_eq!(x["switch"]["waived"], json!(["a"]), "untouched keys stay");
        assert_eq!(x["recoverAttempts"], json!([]));
        let mut empty = serde_json::Value::Null;
        merge_extra(&mut empty, json!({ "k": 1 }));
        assert_eq!(empty, json!({ "k": 1 }), "a journal without extra still takes a patch");
    }
}
