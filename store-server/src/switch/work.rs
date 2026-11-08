//! The cloud to local switch as one `OpWork` on Plan 07's runner. The runner does fence, backup, clone, swap, activate and the
//! reopen; this adds what is specific to a switch: hold the cloud (drain, freeze), copy the data onto the clone, keep the copied staff
//! credentials (the cloud pepper is installed after the swap; accounts without a staff profile are scrambled), verify, and at the end
//! mark the cloud `moved`.
//!
//! Everything that touches a machine or the network sits behind `Machine` (the real one is `machine::RealMachine`) and the cloud
//! marker behind `Fence`, so the order and the rollback rules are tested without either.
//!
//! Rules: the JOURNAL decides whether the cloud may be released (`may_release_cloud`), never `switch-progress.json`. The cloud is
//! never frozen before `moved` ends the operation: any failure before the point of no return releases it. A recovered operation
//! (`from_journal`) has no credentials and no staging: it never resumes a copy, it can only roll back or finish.
use crate::ops::journal::{Journal, Step};
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::world::{BackupReason, OpCtx, OpWork, R};
use crate::switch::cloud::{CloudFence, KeepAlive};
use crate::switch::drain::{evaluate_drain, TillRow};
use crate::switch::facts::{resolve_waivers_for, PlanFacts, Waivers};
use crate::switch::progress::{self, Progress};
use crate::switch::prompt::AdminProof;
use crate::switch::rederive::RederiveReport;
use crate::switch::source::SourceCreds;
use crate::switch::staging::StagingDir;
use crate::switch::verify::Finding;
use crate::update::Env;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

/// The longest `--wait-minutes` a run accepts.
pub const MAX_WAIT_MINUTES: u32 = 120;

/// Added to the wait for the cloud's `draining` window; the drain itself still gives up at `wait_minutes`.
pub const DRAIN_GRACE_MINUTES: u32 = 5;

/// The cloud marker, as the work uses it. `CloudFence` is the real one.
pub trait Fence: Send + Sync {
    fn op_id(&self) -> String;
    fn begin_draining(&self, minutes: u32) -> R<()>;
    fn tills(&self) -> R<Vec<TillRow>>;
    fn expected_labels(&self) -> R<Vec<String>>;
    fn freeze(&self, minutes: u32) -> R<()>;
    fn extend(&self, minutes: u32) -> bool;
    fn lost(&self) -> bool;
    fn state(&self) -> R<String>;
    fn mark_moved(&self, op_id: &str) -> R<()>;
    /// This operation's own hold only; another operation's hold is never touched.
    fn release_held(&self) -> R<bool>;
}

impl Fence for CloudFence {
    fn op_id(&self) -> String {
        self.op_id.clone()
    }
    fn begin_draining(&self, minutes: u32) -> R<()> {
        CloudFence::begin_draining(self, minutes)
    }
    fn tills(&self) -> R<Vec<TillRow>> {
        CloudFence::tills(self)
    }
    fn expected_labels(&self) -> R<Vec<String>> {
        CloudFence::expected_labels(self)
    }
    fn freeze(&self, minutes: u32) -> R<()> {
        CloudFence::freeze(self, minutes)
    }
    fn extend(&self, minutes: u32) -> bool {
        CloudFence::extend(self, minutes)
    }
    fn lost(&self) -> bool {
        CloudFence::lost(self)
    }
    fn state(&self) -> R<String> {
        CloudFence::state(self)
    }
    fn mark_moved(&self, op_id: &str) -> R<()> {
        if op_id != self.op_id {
            return Err(OpError::err(
                "OP_ID_MISMATCH",
                "the cloud hold belongs to another operation",
            ));
        }
        CloudFence::mark_moved(self)
    }
    fn release_held(&self) -> R<bool> {
        CloudFence::release_held(self)
    }
}

/// Everything that touches the machine, the cloud database or a child process.
pub trait Machine {
    /// Non-empty when some role or database of the cloud starts sessions in replica mode (the fence guard would not fire).
    /// Asked again at the freeze, not only at plan time.
    fn default_replica(&mut self) -> R<String>;
    /// Non-empty when a cloud table has no write guard (one created after the plan ran): a freeze would not stop writes to it.
    fn unguarded_tables(&mut self) -> R<String>;
    /// Dump the cloud's copy tables into `dump_dir`, empty the clone's and load the dump (`ctx.names.next`).
    fn copy(&mut self, ctx: &OpCtx, inp: &SwitchInputs, dump_dir: &std::path::Path) -> R<()>;
    /// Re-derive the staff passwords on the clone and prove an admin signs in.
    fn rederive(&mut self, ctx: &OpCtx, keep: &[String]) -> R<RederiveReport>;
    /// Fingerprints, structure, sequences and local-only tables of the clone against the cloud.
    fn verify_clone(&mut self, ctx: &OpCtx, copy: &[String]) -> R<Vec<Finding>>;
    /// Services up behind the fence: the canary, a real admin sign-in, then the photo child process when there is storage.
    fn verify_live(&mut self, ctx: &OpCtx, inp: &SwitchInputs) -> R<()>;
}

/// What a run is given. No secret reaches the journal: `journal_extra` writes ids, counts and names only.
#[derive(Clone)]
pub struct SwitchInputs {
    pub op_id: String,
    pub source: SourceCreds,
    /// Install ids (lower-case uuids), never labels.
    pub waived: BTreeSet<String>,
    pub waive_reason: Option<String>,
    /// The last queue depth each waived till reported (the loss a waiver accepts, made auditable).
    pub waived_queue_depth: BTreeMap<String, u32>,
    pub copy_tables: Vec<String>,
    pub truncate_extra: Vec<String>,
    pub keep_ids: Vec<String>,
    pub wait_minutes: u32,
    pub freeze_minutes: u32,
    pub dev: bool,
}

pub fn waived_depths(tills: &[TillRow], waived: &BTreeSet<String>) -> BTreeMap<String, u32> {
    waived
        .iter()
        .map(|id| {
            let d = tills
                .iter()
                .find(|t| t.terminal_uuid.eq_ignore_ascii_case(id))
                .map(|t| t.queue_depth.max(0).min(u32::MAX as i64) as u32)
                .unwrap_or(0);
            (id.clone(), d)
        })
        .collect()
}

impl SwitchInputs {
    pub fn from_facts(
        p: &PlanFacts,
        w: Option<&Waivers>,
        source: SourceCreds,
        op_id: &str,
        wait_minutes: u32,
        freeze_minutes: u32,
        dev: bool,
    ) -> R<SwitchInputs> {
        let terms: Vec<String> = w.map(|w| w.terminals.clone()).unwrap_or_default();
        let waived = resolve_waivers_for(p, &terms)?;
        Ok(SwitchInputs {
            op_id: op_id.to_string(),
            source,
            waived_queue_depth: waived_depths(&p.tills, &waived),
            waived,
            waive_reason: w.map(|w| w.reason.clone()),
            copy_tables: p.copy_tables.clone(),
            truncate_extra: p.closure_allowed.clone(),
            keep_ids: p.keep_auth_ids.clone(),
            wait_minutes,
            freeze_minutes,
            dev,
        })
    }

    /// `Journal.extra` of a switch: what recovery and the audit need, no credential. The staging paths are recorded so a crashed run's
    /// folders can be named (they are purged under the lock, never resumed from).
    pub fn journal_extra(&self, staging: &StagingDir) -> Value {
        json!({
            "switch": {
                "waived": self.waived,
                "waiveReason": self.waive_reason,
                "waivedQueueDepth": self.waived_queue_depth,
                "copyTables": self.copy_tables,
                "truncateExtra": self.truncate_extra,
                "keepIds": self.keep_ids,
                "hasStorage": self.source.storage.is_some(),
                "stagingPgpass": staging.pgpass_dir().display().to_string(),
                "stagingDump": staging.dump_path().map(|p| p.display().to_string()),
            }
        })
    }
}

/// Warnings that mean the cloud store may be marked `moved` while this server is not switched. A run or a recovery that ends with one
/// of them is exit 17 with the exact `switch rollback` command, whatever the reason it rolled back for.
pub const LOUD_CLOUD_WARNINGS: [&str; 3] = [
    "CLOUD_MAY_BE_MOVED",
    "CLOUD_STILL_MOVED",
    "CLOUD_STATE_UNKNOWN",
];
pub fn loud_cloud_warning(warnings: &[String]) -> Option<&'static str> {
    LOUD_CLOUD_WARNINGS
        .into_iter()
        .find(|c| warnings.iter().any(|w| w == c))
}

/// The journal decides: the cloud may be released only before the point of no return (`Reopen`), whatever the progress file says.
pub fn may_release_cloud(j: &Journal) -> bool {
    let at = if j.step == Step::Rollback {
        j.rollback_from.unwrap_or(Step::Started)
    } else {
        j.step
    };
    at < Step::Reopen
}

/// The journal PROVES `begin_draining` (the first cloud call, the first statement of `work_on_clone`) never ran: the journal is at a step
/// before `Work` (`Work`'s intent is written right before `work_on_clone`, so `Work` itself, either phase, is doubt), or it is rolling back
/// from such a step. A rollback with no recorded origin, and every later step, are doubt. Never decided from `switch-progress.json`.
pub fn proves_never_drained(j: &Journal) -> bool {
    let at = if j.step == Step::Rollback {
        match j.rollback_from {
            Some(s) => s,
            None => return false,
        }
    } else {
        j.step
    };
    at < Step::Work
}

/// Where a recovered switch might have a cloud that is already `moved`. Recovery REWRITES the journal as it goes (a VerifyLive journal
/// becomes Activate/Intent before the live check runs again, and a failed rollback keeps whatever it began from), so Swap, Activate and
/// VerifyLive, and a rollback that began at any of them, are all the window; a first-run crash at Swap or Activate is a false alarm
/// that `switch rollback <op>` clears by freeing a frozen hold. A rollback that began at `Reopen` (a failure after the point of no
/// return, undone by recovery) is the window too: the cloud is moved and only `switch rollback` gives it back. The progress record of
/// THIS operation can only add to the alarm.
fn in_move_window(j: &Journal, env: &Env) -> bool {
    let window =
        |s: Option<Step>| matches!(s, Some(Step::Swap | Step::Activate | Step::VerifyLive));
    window(Some(j.step))
        || window(j.rollback_from)
        || j.rollback_from == Some(Step::Reopen)
        || progress::read(&env.update_dir()).is_some_and(|p| {
            p.op_id.as_deref() == Some(j.op_id.as_str())
                && (matches!(p.cloud.as_str(), "moved" | "unknown") || p.phase == "marking moved")
        })
}

/// `Error`, not `RecoveryNeeded`: recovery rolls back after it (the runner turns an `Error` into a rollback) and the outcome is a
/// successful `RolledBack`, not a failed attempt.
fn not_resumable() -> OpError {
    OpError::new(
        OpCode::Error,
        "SWITCH_NOT_RESUMABLE",
        "a recovered switch has no credentials and no dump; it can only roll back or finish, never copy again",
    )
}

pub struct SwitchWork {
    env: Env,
    /// `None` after a recovery.
    inputs: Option<SwitchInputs>,
    fence: Option<Arc<dyn Fence>>,
    machine: Option<Box<dyn Machine>>,
    staging: Option<StagingDir>,
    keepalive: Option<KeepAlive>,
    /// How often the keepalive renews the freeze (a test shortens it).
    keepalive_every: Duration,
    /// The journal this work was recovered from is at the `Reopen` intent or later, which (the cloud is marked moved at the END of
    /// `verify_live`, before that intent) proves the cloud is moved. Only then may a credential-less `on_commit` flip the mode.
    proves_moved: bool,
    /// The operation id: from the inputs, or from the journal after a recovery.
    op_id: String,
    /// The journal is at (or rolling back from) `VerifyLive`: `mark_moved` may or may not have run, so the cloud MAY be moved.
    at_verify_live: bool,
    /// A recovered work whose journal proves the cloud was never touched (`proves_never_drained`): its rollback writes no progress.
    never_drained: bool,
    /// `mark_moved` was called (its answer may have been lost): a later failure to read or release the cloud is then UNKNOWN.
    mark_attempted: bool,
    /// The waived tills' queue depth read again once the hold is on (`work_on_clone`); handed to the journal once by `journal_patch`.
    drain_depths: Option<BTreeMap<String, u32>>,
    /// Elapsed milliseconds of the phases the work itself runs (`drain`, `copy` = dump + load, `rederive`); handed to the journal once
    /// (`phase_patched`) and kept for the run report.
    phase_ms: BTreeMap<String, u64>,
    phase_patched: bool,
    warnings: Vec<String>,
    pub rederive_report: Option<RederiveReport>,
    sleep: fn(Duration),
    now_ms: fn() -> u64,
    /// The keepalive thread's own wall clock (the operation deadline is wall-clock milliseconds); a test replaces it.
    keepalive_clock: fn() -> u64,
    /// The server PC pairing with itself after the mode flip (`paircmd::server_self_pair`); a test replaces it so no host is touched.
    self_pair: SelfPair,
    /// 11H (Q1): who proved the cloud pepper before the fence, with the typed pepper. `None` after a recovery (nothing to install).
    proof: Option<Arc<AdminProof>>,
    /// This run wrote the `.prev` pepper (the only one a rollback may put back).
    wrote_prev: bool,
}

type SelfPair =
    fn(&crate::paths::Roots, bool, Duration) -> Result<Value, crate::envelope::PosctlError>;

/// The last moment the cloud freeze is renewed: the operation deadline plus one overshoot (`SQL_OVERSHOOT_SECS`).
fn keepalive_limit_ms(deadline_ms: u64) -> u64 {
    deadline_ms.saturating_add(crate::commands::switch::SQL_OVERSHOOT_SECS * 1000)
}

fn real_sleep(d: Duration) {
    std::thread::sleep(d)
}
fn real_now() -> u64 {
    crate::util::now_unix() * 1000
}

impl SwitchWork {
    pub fn new(
        env: Env,
        inputs: SwitchInputs,
        fence: Arc<dyn Fence>,
        staging: StagingDir,
        machine: Box<dyn Machine>,
    ) -> SwitchWork {
        let inputs_op = inputs.op_id.clone();
        SwitchWork {
            env,
            inputs: Some(inputs),
            fence: Some(fence),
            machine: Some(machine),
            staging: Some(staging),
            keepalive: None,
            keepalive_every: Duration::from_secs(60),
            proves_moved: false,
            op_id: inputs_op,
            at_verify_live: false,
            never_drained: false,
            mark_attempted: false,
            drain_depths: None,
            phase_ms: BTreeMap::new(),
            phase_patched: false,
            warnings: vec![],
            rederive_report: None,
            sleep: real_sleep,
            now_ms: real_now,
            keepalive_clock: real_now,
            self_pair: crate::paircmd::server_self_pair,
            proof: None,
            wrote_prev: false,
        }
    }

    /// The admin proof of this run (`commands::switch::execute`): its pepper is installed as the local one after the swap.
    pub fn with_proof(mut self, proof: Arc<AdminProof>) -> SwitchWork {
        self.proof = Some(proof);
        self
    }

    fn pepper_path(&self) -> std::path::PathBuf {
        self.env.secrets().join(crate::secrets::PEPPER_FILE)
    }

    /// Re-renders the services' environment from the secrets folder (the Functions read the pepper from it).
    fn reload_secrets(&self, pack: &str) -> R<()> {
        (self.env.activate)(&self.env.roots, pack, false).map_err(|e| OpError::err("PEPPER_ACTIVATE_FAILED", e))
    }

    /// The cloud's pepper becomes the local one (the machine's own is kept as `.prev` until the commit).
    fn install_pepper(&mut self, ctx: &OpCtx) -> R<()> {
        let Some(proof) = self.proof.clone() else { return Ok(()) };
        if crate::ops::hooks::skip_pepper_install() {
            return Ok(());
        }
        let pack = ctx.pack_to.clone().or_else(|| ctx.pack_from.clone()).ok_or_else(|| OpError::err("PEPPER_INSTALL_FAILED", "the operation names no pack"))?;
        if crate::backup::pepper::install(&self.pepper_path(), proof.pepper.expose()).map_err(|why| OpError::err("PEPPER_INSTALL_FAILED", why))? {
            self.wrote_prev = true;
            self.reload_secrets(&pack)?;
        }
        Ok(())
    }

    /// The rollback side: the machine's own pepper goes back, the services' environment is re-rendered, then `.prev` is dropped. A
    /// failure leaves `.prev` behind and is refused by `verify_after_rollback`.
    fn put_pepper_back(&mut self) -> R<()> {
        // a run that imports a pepper puts back only a `.prev` it wrote itself; a recovery (no proof) finishes what the crashed run did
        if self.proof.is_some() && !self.wrote_prev {
            return Ok(());
        }
        let path = self.pepper_path();
        if crate::backup::pepper::put_previous_back(&path).map_err(|why| OpError::err("PEPPER_ROLLBACK_FAILED", why))? {
            let pack = crate::config::PosctlJson::load(&self.env.roots).ok().flatten().map(|c| c.pack.current).ok_or_else(|| OpError::err("PEPPER_ROLLBACK_FAILED", "posctl.json is unreadable"))?;
            self.reload_secrets(&pack)?;
        }
        crate::backup::pepper::drop_previous(&path).map_err(|_| OpError::err("PEPPER_ROLLBACK_FAILED", "the kept pepper could not be removed"))
    }

    /// Recovery (`update --recover` through `commands::update::work_for`): no credentials, no staging, no machine.
    pub fn from_journal(j: &Journal, env: &Env) -> R<SwitchWork> {
        if j.kind != OpKind::Switch {
            return Err(OpError::new(
                OpCode::RecoveryNeeded,
                "WORK_NOT_REGISTERED",
                "not a switch journal",
            ));
        }
        let at_verify_live = in_move_window(j, env);
        Ok(SwitchWork {
            op_id: j.op_id.clone(),
            at_verify_live,
            // the move window (journal or this op's progress) is a doubt that keeps the alarm
            never_drained: proves_never_drained(j) && !at_verify_live,
            mark_attempted: false,
            drain_depths: None,
            phase_ms: BTreeMap::new(),
            phase_patched: false,
            env: env.clone(),
            inputs: None,
            fence: None,
            machine: None,
            staging: None,
            keepalive: None,
            keepalive_every: Duration::from_secs(60),
            proves_moved: !may_release_cloud(j),
            warnings: vec![],
            rederive_report: None,
            sleep: real_sleep,
            now_ms: real_now,
            keepalive_clock: real_now,
            self_pair: crate::paircmd::server_self_pair,
            proof: None,
            wrote_prev: false,
        })
    }

    /// What `verify_after_rollback` always did: stop renewing and give back THIS operation's hold.
    fn release_cloud_after_rollback(&mut self, _ctx: &OpCtx) -> R<()> {
        self.stop_keepalive();
        let Some(f) = self.fence.clone() else {
            // the journal proves the cloud was never touched: nothing to release, so the record says `released` (no alert). Another
            // operation's record is left alone, an alert of its own above all.
            if self.never_drained {
                let others = progress::read(&self.env.update_dir())
                    .is_some_and(|p| p.op_id.as_deref() != Some(self.op_id.as_str()));
                if !others {
                    self.show("rolled back", "released");
                }
                return Ok(());
            }
            if self.at_verify_live {
                self.warn("CLOUD_MAY_BE_MOVED");
                self.show("rolled back, the cloud may be moved", "unknown");
                eprintln!(
                    "{{\"warn\":\"CLOUD_MAY_BE_MOVED\",\"op\":{:?},\"fix\":\"posctl switch rollback {}\"}}",
                    self.op_id, self.op_id
                );
            } else {
                self.show("rolled back", "held");
            }
            return Ok(());
        };
        match f.release_held() {
            Ok(true) => self.show("rolled back", "released"),
            // freed nothing: that is not "released". Read the row: only `active` (or a hold that is not ours) is verified; a row that
            // reads `moved|<this op>` (the reply of mark_moved was lost) or cannot be read is UNKNOWN and keeps alerting.
            Ok(false) => match f.state() {
                Ok(s) if s.starts_with(&format!("moved|{}|", self.op_id)) => {
                    self.warn("CLOUD_STILL_MOVED");
                    self.show("rolled back, the cloud is moved", "unknown");
                }
                // someone else's moved row or hold: not ours to report on, the record is left alone
                Ok(s)
                    if s.starts_with("moved|")
                        || s.starts_with("draining|")
                        || s.starts_with("frozen|") => {}
                Ok(s) if !s.is_empty() => self.show("rolled back", "released"),
                _ => {
                    self.warn("CLOUD_STATE_UNKNOWN");
                    self.show("rolled back, the cloud state is unknown", "unknown");
                }
            },
            Err(_) if self.mark_attempted => {
                // the answer to mark_moved was ambiguous and the cloud cannot be read or released now: it may be moved
                self.warn("CLOUD_STATE_UNKNOWN");
                self.show("rolled back, the cloud state is unknown", "unknown");
            }
            Err(_) => {
                self.warn("CLOUD_RELEASE_FAILED");
                self.show("rolled back", "held");
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_keepalive_clock(mut self, now_ms: fn() -> u64) -> SwitchWork {
        self.keepalive_clock = now_ms;
        self
    }

    #[cfg(test)]
    fn with_self_pair(mut self, f: SelfPair) -> SwitchWork {
        self.self_pair = f;
        self
    }

    #[cfg(test)]
    fn with_keepalive_every(mut self, d: Duration) -> SwitchWork {
        self.keepalive_every = d;
        self
    }

    /// Elapsed milliseconds per phase the work ran itself (for the run report; the runner's own phases are in its timings).
    pub fn phase_ms(&self) -> &BTreeMap<String, u64> {
        &self.phase_ms
    }

    fn phase_done(&mut self, name: &str, started: u64) {
        let ms = (self.now_ms)().saturating_sub(started);
        self.phase_ms.insert(name.to_string(), ms);
    }

    #[cfg(test)]
    fn with_clock(mut self, sleep: fn(Duration), now_ms: fn() -> u64) -> SwitchWork {
        self.sleep = sleep;
        self.now_ms = now_ms;
        self
    }

    /// The cloud row must still be this operation's frozen hold; the op id is recorded BEFORE the call so a crash leaves a record.
    fn mark_cloud_moved(&mut self, ctx: &OpCtx) -> R<()> {
        let f = self.fence.clone().ok_or_else(not_resumable)?;
        self.fence_ok("before the cloud was marked moved")?;
        if f.op_id() != ctx.op_id {
            return Err(OpError::err(
                "OP_ID_MISMATCH",
                "the cloud hold belongs to another operation",
            ));
        }
        let row = f.state()?;
        let mut parts = row.split('|');
        let (state, op, effective) = (parts.next(), parts.next(), parts.next());
        if state != Some("frozen") || op != Some(ctx.op_id.as_str()) || effective != Some("frozen")
        {
            return Err(OpError::err(
                "CLOUD_NOT_HELD_BY_THIS_OP",
                "the cloud store is not frozen by this operation (it expired, was released or belongs to another switch)",
            ));
        }
        self.show("marking moved", "held");
        crate::ops::hooks::hit("before_mark_moved");
        self.mark_attempted = true;
        if let Err(e) = f.mark_moved(&ctx.op_id) {
            // A refusal (CLOUD_FENCE_LOST) is final. Anything else may be a lost reply to a statement that DID commit: read the row
            // again, and only `moved|<this op>` is proof (then the move stands and the operation goes on).
            let moved = e.reason != "CLOUD_FENCE_LOST"
                && f.state()
                    .is_ok_and(|s| s.starts_with(&format!("moved|{}|", ctx.op_id)));
            if !moved {
                return Err(e);
            }
        }
        crate::ops::hooks::hit("after_mark_moved");
        self.stop_keepalive();
        self.show("moved", "moved");
        Ok(())
    }

    /// `verify_live` on a recovered work: in the window where `mark_moved` may have run the cloud MAY be moved, and that is said
    /// loudly (reason, warning, progress `unknown` with the op id); before it, it is the ordinary not-resumable rollback.
    fn cannot_verify_live(&mut self) -> OpError {
        if !self.at_verify_live {
            return not_resumable();
        }
        self.warn("CLOUD_MAY_BE_MOVED");
        OpError::err(
            "CLOUD_MAY_BE_MOVED",
            format!(
                "the cloud store may be marked moved: run `posctl switch rollback {}` with the cloud credentials to give it back",
                self.op_id
            ),
        )
    }

    /// Stop renewing the cloud freeze WITHOUT waiting for the keepalive thread: it may be inside an `extend` on a silent link (the cloud
    /// call has no client-side limit), and a rollback must not wait for that. A late `extend` is harmless: after the release the guarded
    /// statement matches no row and is refused (PS001), it never re-freezes.
    fn stop_keepalive(&mut self) {
        if let Some(k) = self.keepalive.take() {
            k.stop_detached();
        }
    }

    fn warn(&mut self, code: &str) {
        if !self.warnings.iter().any(|w| w == code) {
            self.warnings.push(code.to_string());
        }
    }

    /// Display only. The op id is ALWAYS written: the record outlives the journal (archived on a finished recovery) and is how the
    /// operator finds `posctl switch rollback <op>`.
    fn show(&self, phase: &str, cloud: &str) {
        if let Some(old) = progress::read(&self.env.update_dir()) {
            let mine = old.op_id.as_deref() == Some(self.op_id.as_str());
            // another operation's alert is never overwritten, and an alarm of this operation is never downgraded to held/released
            if (old.cloud == "unknown" && !mine)
                || (mine
                    && matches!(old.cloud.as_str(), "unknown" | "moved")
                    && !matches!(cloud, "unknown" | "moved"))
            {
                return;
            }
        }
        // display only: a failed write never changes the outcome
        let _ = progress::write(
            &self.env.update_dir(),
            &Progress {
                phase: phase.into(),
                cloud: cloud.into(),
                updated_ms: (self.now_ms)(),
                op_id: Some(self.op_id.clone()),
            },
        );
    }

    fn fence_ok(&self, what: &str) -> R<()> {
        match &self.fence {
            Some(f) if f.lost() => Err(OpError::err(
                "CLOUD_FENCE_LOST",
                format!("the cloud hold was lost {what}; the cloud may have been released"),
            )),
            _ => Ok(()),
        }
    }

    /// Waits until every non-waived till has seen the fence and holds nothing unsent, or `wait_minutes` pass.
    fn drain(&mut self) -> R<()> {
        let (fence, inp) = (
            self.fence.clone().ok_or_else(not_resumable)?,
            self.inputs.clone().ok_or_else(not_resumable)?,
        );
        let start = (self.now_ms)();
        loop {
            let pending = evaluate_drain(&fence.tills()?, &fence.expected_labels()?, &inp.waived)?;
            if pending.is_empty() {
                return Ok(());
            }
            if (self.now_ms)().saturating_sub(start) >= u64::from(inp.wait_minutes) * 60_000 {
                return Err(OpError::err(
                    "DRAIN_TIMEOUT",
                    format!("{} till(s) still hold unsent work or have not seen the hold after {} minutes", pending.len(), inp.wait_minutes),
                ));
            }
            self.fence_ok("while waiting for the tills")?;
            (self.sleep)(Duration::from_secs(10));
        }
    }
}

impl OpWork for SwitchWork {
    fn kind(&self) -> OpKind {
        OpKind::Switch
    }
    fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }
    fn backup_reason(&self) -> BackupReason {
        BackupReason::PreSwitch
    }

    /// Hold the cloud, copy, re-derive. Runs behind the local fence on the clone `ctx.names.next`.
    fn work_on_clone(&mut self, ctx: &OpCtx) -> R<()> {
        // a kept pepper from an earlier operation is never deleted, overwritten or rolled back to: the operator decides (before the
        // cloud is held)
        if self.proof.is_some() && crate::backup::pepper::prev_present(&self.pepper_path()) {
            return Err(OpError::new(OpCode::Precondition, "PEPPER_PREV_PRESENT", crate::backup::pepper::PREV_PRESENT_MESSAGE));
        }
        let inp = self.inputs.clone().ok_or_else(not_resumable)?;
        let fence = self.fence.clone().ok_or_else(not_resumable)?;
        let dump = self
            .staging
            .as_ref()
            .and_then(|s| s.dump_path().map(|p| p.to_path_buf()))
            .ok_or_else(not_resumable)?;
        // the drain window outlives the wait by a few minutes, so a drain that completes at the very end of the wait can still be frozen
        fence.begin_draining(inp.wait_minutes + DRAIN_GRACE_MINUTES)?;
        // the number a waiver accepts losing: the pre-check's reading may be minutes old, this one is taken with the hold on
        if !inp.waived.is_empty() {
            self.drain_depths = Some(waived_depths(&fence.tills()?, &inp.waived));
        }
        self.show("draining", "held");
        let started = (self.now_ms)();
        self.drain()?;
        self.phase_done("drain", started);
        // the plan checked this once; a role can change in between, and the hold would then not stop writers
        let replica = self
            .machine
            .as_mut()
            .ok_or_else(not_resumable)?
            .default_replica()?;
        if !replica.trim().is_empty() {
            return Err(OpError::err(
                "FENCE_DEFAULT_REPLICA",
                "a role or database of the cloud starts its sessions in replica mode, so the hold would not stop its writers",
            ));
        }
        // a table created since the plan ran has no guard either (M18)
        let late = self
            .machine
            .as_mut()
            .ok_or_else(not_resumable)?
            .unguarded_tables()?;
        if !late.trim().is_empty() {
            return Err(OpError::err(
                "FENCE_TABLES_UNGUARDED",
                "a cloud table has no write guard (created since the plan ran), so the hold would not stop writes to it",
            ));
        }
        self.show("freezing", "held");
        fence.freeze(inp.freeze_minutes)?;
        let (f2, minutes) = (fence.clone(), inp.freeze_minutes);
        // The renewal has a limit of its own: past the deadline plus one overshoot it stops, whatever the main thread is doing (a hang in
        // a place no cap reaches). An expired freeze is then refused by `mark_moved`, and the switch rolls back (the safe side).
        // The time left to the limit is read from the wall clock ONCE and turned into a monotonic instant, so a host clock step during
        // the run cannot stretch the cloud bound.
        let left = keepalive_limit_ms(ctx.deadline_ms).saturating_sub((self.keepalive_clock)());
        let stop_at = std::time::Instant::now().checked_add(Duration::from_millis(left));
        self.keepalive = Some(KeepAlive::start(self.keepalive_every, move || {
            stop_at.is_none_or(|t| std::time::Instant::now() <= t) && f2.extend(minutes)
        }));
        self.show("copying", "held");
        let started = (self.now_ms)();
        let m = self.machine.as_mut().ok_or_else(not_resumable)?;
        m.copy(ctx, &inp, &dump)?;
        self.phase_done("copy", started);
        self.fence_ok("while copying")?;
        self.show("preparing staff accounts", "held");
        let started = (self.now_ms)();
        let m = self.machine.as_mut().ok_or_else(not_resumable)?;
        self.rederive_report = Some(m.rederive(ctx, &inp.keep_ids)?);
        self.phase_done("rederive", started);
        self.fence_ok("while preparing the staff accounts")
    }

    /// Postgres runs on the copied data, the stack has not started: the cloud's pepper goes in now, so the very first start already
    /// derives with it. A pre-swap failure never touches the machine's pepper.
    fn after_activate(&mut self, ctx: &OpCtx) -> R<()> {
        self.install_pepper(ctx)
    }

    /// The first thing a rollback does, before its journal write and before the local stack is touched: stop renewing the cloud freeze.
    /// From here the cloud's dead-man (`FREEZE_MINUTES` after the last renewal) frees it whatever the local rollback does or however
    /// long it hangs; the release in `verify_after_rollback` still works (a hold the dead-man already freed reads `active`, which is a
    /// verified release).
    fn rollback_started(&mut self) {
        self.stop_keepalive();
    }

    /// The last queue depth of each waived till goes into the journal (`waivedQueueDepth`, replacing the plan-time reading, which is kept
    /// as `waivedQueueDepthAtPlan`). Taken once; the runner merges it right after `work_on_clone`, even when that failed.
    fn journal_patch(&mut self) -> Option<Value> {
        let mut sw = serde_json::Map::new();
        if let Some(at_drain) = self.drain_depths.take() {
            let at_plan = self
                .inputs
                .as_ref()
                .map(|i| i.waived_queue_depth.clone())
                .unwrap_or_default();
            sw.insert("waivedQueueDepth".into(), json!(at_drain));
            sw.insert("waivedQueueDepthAtPlan".into(), json!(at_plan));
        }
        // the elapsed time of the drain, the dump + load and the re-derive: what the runbook and the owner's plan need to size a store
        if !self.phase_patched && !self.phase_ms.is_empty() {
            self.phase_patched = true;
            sw.insert("phaseMs".into(), json!(self.phase_ms));
        }
        (!sw.is_empty()).then(|| json!({ "switch": sw }))
    }

    fn wants_timings(&self) -> bool {
        true
    }

    /// Any finding rolls the switch back, while the cloud is still held.
    fn verify_clone(&mut self, ctx: &OpCtx) -> R<()> {
        self.fence_ok("before the clone was verified")?;
        let inp = self.inputs.clone().ok_or_else(not_resumable)?;
        // The runner checks the deadline before the work and before the swap, not before this step: the statements of the verification are
        // capped to what is left, so a budget that is already gone ends here, as a rollback, not as one more minute-floor statement.
        // (After the not-resumable check: a recovered work has no machine and a recovery has no deadline.)
        if (self.now_ms)() >= ctx.deadline_ms {
            return Err(OpError::new(
                OpCode::RolledBack,
                "MAINTENANCE_BUDGET",
                "the maintenance budget was used up before the copy was verified",
            ));
        }
        self.show("verifying", "held");
        let findings = self
            .machine
            .as_mut()
            .ok_or_else(not_resumable)?
            .verify_clone(ctx, &inp.copy_tables)?;
        if findings.is_empty() {
            return Ok(());
        }
        let codes: BTreeSet<&str> = findings.iter().map(|f| f.code).collect();
        Err(OpError::err(
            "CLONE_VERIFY_FAILED",
            format!(
                "the copy does not match the cloud ({} finding(s): {})",
                findings.len(),
                codes.into_iter().collect::<Vec<_>>().join(", ")
            ),
        ))
    }

    /// Services up behind the fence, then the LAST thing before the point of no return: mark the cloud `moved`. From the `Reopen`
    /// intent on, the journal therefore proves the cloud is moved by this operation, and a credential-less recovery may roll forward.
    /// A refused `mark_moved` (the hold expired, another operation's) is a normal rollback that releases the cloud.
    fn verify_live(&mut self, ctx: &OpCtx) -> R<()> {
        self.fence_ok("before the live check")?;
        crate::ops::hooks::fail("verify_live")?;
        let Some(inp) = self.inputs.clone() else {
            return Err(self.cannot_verify_live());
        };
        self.show("checking", "held");
        self.machine
            .as_mut()
            .ok_or_else(not_resumable)?
            .verify_live(ctx, &inp)?;
        self.mark_cloud_moved(ctx)
    }

    /// The operation failed before the point of no return: give back THIS operation's hold (never another's, never a `moved` row).
    /// Never fails the rollback of the local side; a cloud that could not be released stays visible in `status` (progress `held`)
    /// and expires with its own hold.
    fn verify_after_rollback(&mut self, ctx: &OpCtx) -> R<()> {
        // the cloud is released first (the dead-man frees it whatever happens here); the machine's own pepper goes back after
        let released = self.release_cloud_after_rollback(ctx);
        let pepper = self.put_pepper_back();
        released.and(pepper)
    }

    /// After the point of no return. Idempotent: recovery may repeat it. The cloud was marked moved at the end of `verify_live`, so
    /// nothing here contacts it. A recovered work (no fence) flips the mode only when its journal proves that. Then the server pairs
    /// with itself (`SELF_PAIR_FAILED` is fix-forward).
    fn on_commit(&mut self, _ctx: &OpCtx) -> R<()> {
        self.stop_keepalive();
        // the switch is past the point of no return: the machine's previous pepper is not wanted any more (idempotent)
        if crate::backup::pepper::drop_previous(&self.pepper_path()).is_err() {
            self.warn("PEPPER_PREV_LEFT");
        }
        if self.fence.is_none() && !self.proves_moved {
            self.warn("CLOUD_MARK_PENDING");
            return Err(OpError::new(
                OpCode::RecoveryNeeded,
                "CLOUD_MARK_PENDING",
                "the journal does not prove the cloud store was marked moved, so this server is not switched",
            ));
        }
        self.show("committed", "moved");
        // after the point of no return a missing or unreadable posctl.json is a failure to fix forward, never skipped
        let mut c = crate::config::PosctlJson::load(&self.env.roots)
            .ok()
            .flatten()
            .ok_or_else(|| {
                OpError::new(
                    OpCode::RecoveryNeeded,
                    "MODE_NOT_SAVED",
                    "posctl.json is missing or unreadable, so the new mode could not be recorded",
                )
            })?;
        if c.mode != "offline-only" {
            c.mode = "offline-only".into();
            c.save(&self.env.roots).map_err(|e| {
                OpError::new(
                    OpCode::RecoveryNeeded,
                    "MODE_NOT_SAVED",
                    format!("posctl.json: {e}"),
                )
            })?;
        }
        // Step 3 of the switch: the server PC pairs with itself (installs the store root, writes client\store.env). Idempotent. The mode
        // is already flipped, so a failure is fixed forward: the operator re-runs `update --recover`, which lands here again.
        (self.self_pair)(&self.env.roots, !self.env.roots.dev, Duration::from_secs(30)).map_err(|e| {
            OpError::new(
                OpCode::RecoveryNeeded,
                "SELF_PAIR_FAILED",
                format!("the switch is committed but this server could not pair with itself: {}; run `posctl update --recover`", e.message),
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::fake::{fresh, FakeWorld, T0};
    use crate::ops::names::DbNames;
    use crate::ops::runner::run_operation;
    use crate::ops::world::OpCtx;
    use crate::switch::source::{parse_stdin, Secret, StorageSource};
    use std::cell::RefCell;
    use std::sync::Mutex;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";
    const SECRET_PW: &str = "Zq9-secret-Zq9";

    fn creds(storage: bool) -> SourceCreds {
        // assembled at run time: a literal user:password@host string trips the repository's secret scan
        let url = format!(
            "postgresql://postgres:{}@db.abc.supabase.co:5432/postgres",
            SECRET_PW
        );
        let mut c = parse_stdin(&format!(r#"{{"v":1,"db":{{"url":"{url}"}}}}"#)).unwrap();
        if storage {
            c.storage = Some(StorageSource {
                project_url: "https://abc.supabase.co".into(),
                service_role_key: Secret::new("K"),
            });
        }
        c
    }

    fn till(uuid: &str, label: &str, depth: i64) -> TillRow {
        TillRow {
            terminal_uuid: uuid.into(),
            terminal_label: label.into(),
            queue_depth: depth,
            dead_letter_depth: 0,
            seen_state: "draining".into(),
            app_version: None,
            reported_by: "x".into(),
            age_s: 1,
            after_drain: true,
        }
    }

    fn inputs(waived: &[&str]) -> SwitchInputs {
        let tills = [till(A, "POS-1", 3), till(B, "POS-2", 0)];
        let waived: BTreeSet<String> = waived.iter().map(|s| s.to_string()).collect();
        SwitchInputs {
            op_id: "op".into(),
            source: creds(false),
            waived_queue_depth: waived_depths(&tills, &waived),
            waived,
            waive_reason: Some("till 2 is broken".into()),
            copy_tables: vec!["public.categories".into()],
            truncate_extra: vec![],
            keep_ids: vec![],
            wait_minutes: 1,
            freeze_minutes: 30,
            dev: true,
        }
    }

    type Log = Arc<Mutex<Vec<String>>>;

    struct FakeFence {
        log: Log,
        /// `(call, minutes)` of every begin_draining, freeze and extend, in order
        windows: Mutex<Vec<(&'static str, u32)>>,
        update_dir: std::path::PathBuf,
        tills: Vec<TillRow>,
        state: Mutex<String>,
        fail_mark: Mutex<bool>,
        other_hold: Mutex<bool>,
        lost: std::sync::atomic::AtomicBool,
        freeze_err: Mutex<bool>,
        release_err: Mutex<bool>,
        expired: Mutex<bool>,
        progress_at_begin: Mutex<Option<Option<Progress>>>,
        reply_lost: Mutex<bool>,
        op: Mutex<String>,
        marked_with: Mutex<Option<String>>,
        progress_seen_at_mark: Mutex<Option<Progress>>,
        extend_block: std::sync::atomic::AtomicBool,
    }
    impl Fence for FakeFence {
        fn op_id(&self) -> String {
            self.op.lock().unwrap().clone()
        }
        fn begin_draining(&self, minutes: u32) -> R<()> {
            self.windows.lock().unwrap().push(("begin_draining", minutes));
            self.log.lock().unwrap().push("begin_draining".into());
            // what the progress record said at the instant the hold was requested (it must not yet claim a hold)
            *self.progress_at_begin.lock().unwrap() = Some(progress::read(&self.update_dir));
            if *self.other_hold.lock().unwrap() {
                return Err(OpError::err(
                    "CLOUD_NOT_ACTIVE",
                    "another switch holds the cloud",
                ));
            }
            let mut st = self.state.lock().unwrap();
            if st.starts_with("moved") {
                return Err(OpError::err(
                    "CLOUD_NOT_ACTIVE",
                    "the cloud store is not active",
                ));
            }
            if st.starts_with("active") {
                *st = "draining|op|draining".into();
            }
            Ok(())
        }
        fn tills(&self) -> R<Vec<TillRow>> {
            Ok(self.tills.clone())
        }
        fn expected_labels(&self) -> R<Vec<String>> {
            Ok(vec![])
        }
        fn freeze(&self, minutes: u32) -> R<()> {
            self.windows.lock().unwrap().push(("freeze", minutes));
            self.log.lock().unwrap().push("freeze".into());
            if *self.freeze_err.lock().unwrap() {
                return Err(OpError::err(
                    "CLOUD_FREEZE_BLOCKED",
                    "a writer holds the state table",
                ));
            }
            let mut st = self.state.lock().unwrap();
            if st.starts_with("draining|op|") {
                *st = "frozen|op|frozen".into();
            }
            Ok(())
        }
        fn extend(&self, minutes: u32) -> bool {
            self.windows.lock().unwrap().push(("extend", minutes));
            self.log.lock().unwrap().push("extend".into());
            // a cloud call on a silent link: blocks until released (at most 3 s, so a failing test ends)
            let t = std::time::Instant::now();
            while self.extend_block.load(std::sync::atomic::Ordering::SeqCst) && t.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(5));
            }
            true
        }
        fn lost(&self) -> bool {
            self.lost.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn state(&self) -> R<String> {
            Ok(self.state.lock().unwrap().clone())
        }
        fn mark_moved(&self, op_id: &str) -> R<()> {
            *self.marked_with.lock().unwrap() = Some(op_id.to_string());
            // what was on disk at the moment of the call: the op id must already be recorded
            *self.progress_seen_at_mark.lock().unwrap() = progress::read(&self.update_dir);
            self.log.lock().unwrap().push("mark_moved".into());
            if std::mem::take(&mut *self.fail_mark.lock().unwrap()) {
                return Err(OpError::err("KILLED", "killed before the cloud answered"));
            }
            // like the guarded UPDATE: only this operation's live frozen row moves
            let live = self.state.lock().unwrap().starts_with("frozen|op|")
                && !*self.expired.lock().unwrap();
            if !live {
                return Err(OpError::new(
                    OpCode::Precondition,
                    "CLOUD_FENCE_LOST",
                    "the freeze expired or is not this operation's",
                ));
            }
            *self.state.lock().unwrap() = "moved|op|moved".into();
            if std::mem::take(&mut *self.reply_lost.lock().unwrap()) {
                return Err(OpError::new(
                    OpCode::Precondition,
                    "CLOUD_QUERY_FAILED",
                    "the answer was lost",
                ));
            }
            Ok(())
        }
        fn release_held(&self) -> R<bool> {
            self.log.lock().unwrap().push("release_held".into());
            if *self.release_err.lock().unwrap() {
                return Err(OpError::err(
                    "CLOUD_QUERY_FAILED",
                    "the cloud did not answer",
                ));
            }
            // scoped to this operation, like the SQL: only our own draining/frozen row is freed
            let mut st = self.state.lock().unwrap();
            if st.starts_with("draining|op|") || st.starts_with("frozen|op|") {
                *st = "active||active".into();
                return Ok(true);
            }
            Ok(false)
        }
    }

    #[derive(Default, Clone)]
    struct Knobs {
        replica: String,
        unguarded: String,
        order_log: Option<Log>,
        findings: Vec<&'static str>,
        fail_live: bool,
        fail_copy: bool,
        /// the data move's child was killed at the budget deadline (`machine::capped`)
        budget_copy: bool,
        fail_rederive: bool,
        calls: Arc<Mutex<Vec<&'static str>>>,
    }
    struct FakeMachine(Knobs);
    impl Machine for FakeMachine {
        fn default_replica(&mut self) -> R<String> {
            self.0.calls.lock().unwrap().push("default_replica");
            Ok(self.0.replica.clone())
        }
        fn unguarded_tables(&mut self) -> R<String> {
            self.0.calls.lock().unwrap().push("unguarded_tables");
            // into the fence's own log too (when a test asks), so the order against begin_draining and freeze can be asserted
            if let Some(l) = &self.0.order_log {
                l.lock().unwrap().push("unguarded_tables".into());
            }
            Ok(self.0.unguarded.clone())
        }
        fn copy(&mut self, _: &OpCtx, _: &SwitchInputs, _: &std::path::Path) -> R<()> {
            self.0.calls.lock().unwrap().push("copy");
            if self.0.fail_copy {
                return Err(OpError::err("RESTORE_FAILED", "exited with 1"));
            }
            if self.0.budget_copy {
                return Err(OpError::new(OpCode::RolledBack, "MAINTENANCE_BUDGET", "the maintenance budget was used up before the data move finished"));
            }
            Ok(())
        }
        fn rederive(&mut self, _: &OpCtx, _: &[String]) -> R<RederiveReport> {
            self.0.calls.lock().unwrap().push("rederive");
            if self.0.fail_rederive {
                return Err(OpError::err("ADMIN_SIGN_IN_FAILED", "does not verify"));
            }
            Ok(RederiveReport {
                rows: 1,
                skipped: 0,
                scrambled: 0,
                without_valid_pin: 0,
            })
        }
        fn verify_clone(&mut self, _: &OpCtx, _: &[String]) -> R<Vec<Finding>> {
            self.0.calls.lock().unwrap().push("verify_clone");
            Ok(self
                .0
                .findings
                .iter()
                .map(|c| Finding {
                    code: c,
                    detail: "x".into(),
                })
                .collect())
        }
        fn verify_live(&mut self, _: &OpCtx, _: &SwitchInputs) -> R<()> {
            self.0.calls.lock().unwrap().push("verify_live");
            if self.0.fail_live {
                return Err(OpError::err("PHOTOS_IMPORT_FAILED", "x"));
            }
            Ok(())
        }
    }

    struct Rig {
        _d: tempfile::TempDir,
        env: Env,
        log: Log,
        fence: Arc<FakeFence>,
        knobs: Knobs,
    }

    fn rig(fence_tills: Vec<TillRow>) -> Rig {
        let d = tempfile::tempdir().unwrap();
        let (data, program) = (d.path().join("data"), d.path().join("prog"));
        let roots = crate::paths::Roots::custom(data.clone(), program.clone());
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::create_dir_all(roots.backups()).unwrap();
        std::fs::create_dir_all(roots.conf()).unwrap();
        crate::config::PosctlJson::new("cloud", "id", 47300, "shop", "1.0.0-r1")
            .save(&roots)
            .unwrap();
        let env = Env {
            data,
            program,
            posctl_exe: d.path().join("posctl.exe"),
            ports: crate::ports::Ports::new(47300).unwrap(),
            roots: roots.clone(),
            activate: std::rc::Rc::new(|_, _, _| Ok(())),
        };
        let log: Log = Arc::default();
        let fence = Arc::new(FakeFence {
            log: log.clone(),
            windows: Default::default(),
            update_dir: roots.update_dir(),
            tills: fence_tills,
            state: Mutex::new("frozen|op|frozen".into()),
            fail_mark: Mutex::new(false),
            other_hold: Mutex::new(false),
            lost: Default::default(),
            freeze_err: Mutex::new(false),
            release_err: Mutex::new(false),
            expired: Mutex::new(false),
            progress_at_begin: Mutex::new(None),
            reply_lost: Mutex::new(false),
            op: Mutex::new("op".into()),
            marked_with: Mutex::new(None),
            progress_seen_at_mark: Mutex::new(None),
            extend_block: Default::default(),
        });
        Rig {
            _d: d,
            env,
            log,
            fence,
            knobs: Knobs::default(),
        }
    }

    fn work(r: &Rig, inp: SwitchInputs) -> SwitchWork {
        let mut staging = StagingDir::create(&r.env.roots).unwrap();
        let lock = crate::ops::lock::acquire_for(
            &r.env.roots,
            crate::ops::lock::LockMode::Exclusive,
            "test",
            "op",
            Duration::ZERO,
        )
        .unwrap();
        staging.ensure_dump(&r.env.roots, &lock).unwrap();
        SwitchWork::new(
            r.env.clone(),
            inp,
            r.fence.clone(),
            staging,
            Box::new(FakeMachine(r.knobs.clone())),
        )
        .with_clock(
            |_| {},
            || {
                thread_local!(static T: RefCell<u64> = const { RefCell::new(0) });
                T.with(|t| {
                    *t.borrow_mut() += 1_000;
                    *t.borrow()
                })
            },
        )
        // the keepalive thread's clock: inside every legal window unless a test moves it
        .with_keepalive_clock(|| T0)
        .with_self_pair(|_, _, _| Ok(json!({})))
    }

    /// A recovered work whose self-pairing is faked (the host is never touched).
    fn recovered(j: &Journal, env: &Env) -> SwitchWork {
        SwitchWork::from_journal(j, env).unwrap().with_self_pair(|_, _, _| Ok(json!({})))
    }
    fn ctx() -> OpCtx {
        OpCtx {
            op_id: "op".into(),
            names: DbNames::for_kind(OpKind::Switch, T0),
            pack_from: Some("p".into()),
            pack_to: Some("p".into()),
            deadline_ms: T0 + 900_000,
        }
    }
    fn journal() -> Journal {
        Journal::new(
            OpKind::Switch,
            "op",
            T0,
            T0 + 900_000,
            Some("p".into()),
            Some("p".into()),
        )
    }
    fn run(_r: &Rig, w: &mut SwitchWork) -> R<crate::ops::runner::Outcome> {
        let s = fresh();
        run_operation(&mut FakeWorld(s), w, &ctx(), journal())
    }
    fn mode(r: &Rig) -> String {
        crate::config::PosctlJson::load(&r.env.roots)
            .unwrap()
            .unwrap()
            .mode
    }

    // ---- inputs and the journal

    #[test]
    fn waived_ids_are_install_ids_not_labels() {
        let mut p = crate::switch::facts::tests::clean();
        p.tills = vec![till(A, "POS-1", 3), till(B, "POS-2", 0)];
        let w = Waivers::parse(
            &["POS-2".to_string(), A.to_uppercase()],
            Some("both tills are broken"),
        )
        .unwrap();
        let inp =
            SwitchInputs::from_facts(&p, w.as_ref(), creds(false), "op", 5, 30, true).unwrap();
        assert_eq!(
            inp.waived,
            BTreeSet::from([A.to_string(), B.to_string()]),
            "a label and an upper-case id both become install ids"
        );
        assert_eq!(
            inp.waived_queue_depth,
            BTreeMap::from([(A.to_string(), 3), (B.to_string(), 0)])
        );
        assert_eq!(inp.waive_reason.as_deref(), Some("both tills are broken"));
        assert_eq!(inp.copy_tables, p.copy_tables);
    }

    #[test]
    fn journal_records_last_queue_depth_per_waived_till() {
        let r = rig(vec![]);
        let staging = StagingDir::create(&r.env.roots).unwrap();
        let x = inputs(&[A, B]).journal_extra(&staging);
        assert_eq!(x["switch"]["waivedQueueDepth"], json!({ A: 3, B: 0 }));
        assert_eq!(x["switch"]["waiveReason"], "till 2 is broken");
        assert!(
            x["switch"]["waived"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v.as_str().unwrap().len() == 36),
            "ids, not labels"
        );
        let text = x.to_string();
        assert!(
            !text.contains(SECRET_PW) && !text.contains("supabase.co"),
            "no credential in the journal: {text}"
        );
    }

    #[test]
    fn the_waived_queue_depth_is_read_again_at_begin_draining_and_goes_to_the_journal_once() {
        // plan time said A held 3 and B held 0; with the hold on, A holds 7
        let r = rig(vec![till(A, "POS-1", 7), till(B, "POS-2", 0)]);
        let mut w = work(&r, inputs(&[A, B]));
        w.work_on_clone(&ctx()).unwrap(); // the runner takes the patch itself, so the work is driven directly
        let p = w.journal_patch().expect("a patch after a run with waivers");
        assert!(p["switch"]["phaseMs"]["copy"].as_u64().unwrap() > 0, "{p}");
        assert_eq!(p["switch"]["waivedQueueDepth"], json!({ A: 7, B: 0 }));
        assert_eq!(p["switch"]["waivedQueueDepthAtPlan"], json!({ A: 3, B: 0 }));
        assert!(w.journal_patch().is_none(), "taken once");
        // no waiver: nothing to record
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        w.work_on_clone(&ctx()).unwrap(); // the runner takes the patch itself, so the work is driven directly
        let p = w.journal_patch().expect("the phase times are always recorded");
        assert!(p["switch"].get("waivedQueueDepth").is_none(), "{p}");
        assert!(w.journal_patch().is_none());
    }

    #[test]
    fn the_work_records_the_elapsed_time_of_each_phase_it_runs_with_an_injected_clock() {
        // the test clock moves 1000 ms per reading, no sleeping: every phase spans at least one reading
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        w.work_on_clone(&ctx()).unwrap(); // the runner takes the patch itself, so the work is driven directly
        for k in ["drain", "copy", "rederive"] {
            assert!(w.phase_ms().get(k).is_some_and(|ms| *ms >= 1000), "{k}: {:?}", w.phase_ms());
        }
        let p = w.journal_patch().unwrap();
        assert_eq!(p["switch"]["phaseMs"], json!(w.phase_ms()), "the journal carries exactly what the report will");
        assert!(w.wants_timings(), "the runner records its own phases (backup, clone, work, verify...) for a switch");
    }

    const _: () = assert!(DRAIN_GRACE_MINUTES > 0 && MAX_WAIT_MINUTES + DRAIN_GRACE_MINUTES <= crate::switch::cloud::MAX_FENCE_MINUTES);

    #[test]
    fn the_freeze_is_a_lease_renewed_with_the_full_window_and_the_wait_is_spent_before_it() {
        // behaviour, through the counting fence: wait 1 minute, freeze window 30
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[])).with_keepalive_every(Duration::from_millis(25));
        w.work_on_clone(&ctx()).unwrap();
        let windows = |r: &Rig| r.fence.windows.lock().unwrap().clone();
        // the keepalive is renewing: wait until the first renewal shows
        let t = std::time::Instant::now();
        while !windows(&r).iter().any(|(c, _)| *c == "extend") && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let seen = windows(&r);
        let pos = |c: &str| seen.iter().position(|(k, _)| *k == c).unwrap_or_else(|| panic!("{c} missing: {seen:?}"));
        // the cloud is held for the wait plus the grace, THEN frozen with its own fresh window: the wait never counts against the freeze
        assert_eq!(seen[pos("begin_draining")], ("begin_draining", 1 + DRAIN_GRACE_MINUTES));
        assert_eq!(seen[pos("freeze")], ("freeze", 30));
        assert!(pos("begin_draining") < pos("freeze") && pos("freeze") < pos("extend"), "{seen:?}");
        // every renewal sets the same full window again (a lease from now, not a cap on the first freeze)
        assert!(seen.iter().filter(|(c, _)| *c == "extend").all(|(_, m)| *m == 30), "{seen:?}");
        drop(w);
        // and it renews once a minute in production
        assert_eq!(work(&r, inputs(&[])).keepalive_every, Duration::from_secs(60));
        let j = journal();
        assert_eq!(SwitchWork::from_journal(&j, &r.env).unwrap().keepalive_every, Duration::from_secs(60));
    }

    #[test]
    fn no_extend_is_sent_after_a_rollback_starts_and_the_release_still_works() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[])).with_keepalive_every(Duration::from_millis(25));
        w.work_on_clone(&ctx()).unwrap();
        let extends = |r: &Rig| r.log.lock().unwrap().iter().filter(|l| l.as_str() == "extend").count();
        // the keepalive is alive: it renews while the work runs
        let t = std::time::Instant::now();
        while extends(&r) == 0 && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(extends(&r) > 0, "the keepalive renews the freeze while the operation runs");
        // a rollback begins; the local part of it hangs (a stop or a restart that never returns) for as long as we like: no more renewals
        w.rollback_started();
        let at_start = extends(&r);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(extends(&r), at_start, "no extend after the rollback started, so the dead-man can fire");
        // and the release at the end of the rollback is unaffected
        w.verify_after_rollback(&ctx()).unwrap();
        assert!(r.log.lock().unwrap().contains(&"release_held".to_string()));
        assert_eq!(extends(&r), at_start);
    }

    #[test]
    fn the_keepalive_stops_extending_past_the_deadline_plus_one_overshoot_whatever_the_main_thread_does() {
        use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
        static CLOCK: AtomicU64 = AtomicU64::new(0);
        let r = rig(vec![till(A, "POS-1", 0)]);
        let c = ctx();
        let limit = c.deadline_ms + crate::commands::switch::SQL_OVERSHOOT_SECS * 1000;
        // 1.5 s before the limit when the keepalive starts: the time left is read once and kept as a monotonic instant
        CLOCK.store(limit - 1_500, SeqCst);
        let mut w = work(&r, inputs(&[]))
            .with_keepalive_every(Duration::from_millis(25))
            .with_keepalive_clock(|| CLOCK.load(SeqCst));
        w.work_on_clone(&c).unwrap();
        let extends = |r: &Rig| r.log.lock().unwrap().iter().filter(|l| l.as_str() == "extend").count();
        let t = std::time::Instant::now();
        while extends(&r) == 0 && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(extends(&r) > 0, "before the limit the keepalive renews");
        // the main thread now hangs somewhere no cap reaches: no rollback_started, no drop. Once the limit has passed, renewals stop
        // (a host clock step now changes nothing: the instant was fixed at the start).
        CLOCK.store(0, SeqCst);
        std::thread::sleep(Duration::from_millis(2_000)); // a tick in flight at the limit may still land
        let at_limit = extends(&r);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(extends(&r), at_limit, "no extend after deadline + overshoot, though nothing stopped the keepalive");
        // the freeze then runs out by itself: the cloud's own mark_moved refuses it, which is a normal rollback (covered by
        // a_refused_mark_moved_is_a_normal_rollback_that_releases_the_cloud)
        drop(w);
    }

    #[test]
    fn a_rollback_never_waits_for_a_cloud_call_the_keepalive_is_stuck_in() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[])).with_keepalive_every(Duration::from_millis(25));
        r.fence.extend_block.store(true, std::sync::atomic::Ordering::SeqCst);
        w.work_on_clone(&ctx()).unwrap();
        let extends = |r: &Rig| r.log.lock().unwrap().iter().filter(|l| l.as_str() == "extend").count();
        let t = std::time::Instant::now();
        while extends(&r) == 0 && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(extends(&r), 1, "the keepalive is inside its first (stuck) extend");
        let at = std::time::Instant::now();
        w.rollback_started();
        assert!(at.elapsed() < Duration::from_millis(1_000), "rollback_started returned after {:?}: it waited for the stuck extend", at.elapsed());
        // the rollback goes on: the release works with the extend still stuck
        w.verify_after_rollback(&ctx()).unwrap();
        assert!(r.log.lock().unwrap().contains(&"release_held".to_string()));
        r.fence.extend_block.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    #[test]
    fn verify_clone_refuses_once_the_budget_is_gone_and_runs_before_it() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let calls = r.knobs.calls.clone();
        let mut w = work(&r, inputs(&[]));
        let mut gone = ctx();
        gone.deadline_ms = 1; // the injected work clock reads 1000 or more
        let e = w.verify_clone(&gone).unwrap_err();
        assert!(e.code == OpCode::RolledBack && e.reason == "MAINTENANCE_BUDGET", "{e:?}");
        assert!(!calls.lock().unwrap().contains(&"verify_clone"), "the machine was not asked");
        w.verify_clone(&ctx()).unwrap();
        assert!(calls.lock().unwrap().contains(&"verify_clone"), "before the deadline it runs");
    }

    #[test]
    fn a_rollback_that_began_at_reopen_is_in_the_move_window_and_one_from_an_earlier_step_is_not() {
        let r = rig(vec![]);
        let mut j = journal();
        j.step = Step::Rollback;
        j.rollback_from = Some(Step::Reopen);
        assert!(SwitchWork::from_journal(&j, &r.env).unwrap().at_verify_live, "the cloud is moved: a LOUD recovery");
        j.rollback_from = Some(Step::Started);
        assert!(!SwitchWork::from_journal(&j, &r.env).unwrap().at_verify_live);
    }

    #[test]
    fn only_the_three_cloud_warnings_are_loud() {
        let ws = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            loud_cloud_warning(&ws(&["CLOUD_RELEASE_FAILED", "CLOUD_STILL_MOVED"])),
            Some("CLOUD_STILL_MOVED")
        );
        for c in LOUD_CLOUD_WARNINGS {
            assert_eq!(loud_cloud_warning(&ws(&[c])), Some(c));
        }
        // a failed release of a hold that was never moved is not this alarm (the `held` alert covers it)
        assert_eq!(
            loud_cloud_warning(&ws(&["CLOUD_RELEASE_FAILED", "CLOUD_MARK_PENDING"])),
            None
        );
        assert_eq!(loud_cloud_warning(&[]), None);
    }

    #[test]
    fn journal_and_lock_live_in_update_dir() {
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        assert_eq!(progress::path(&u), u.join("switch-progress.json"));
        assert!(crate::ops::journal::path(&u).starts_with(&u));
        assert!(u.ends_with("update"), "{u:?}");
    }

    // ---- the cloud is released by the journal, never by the progress file

    #[test]
    fn rollback_decision_uses_the_journal_not_progress() {
        let mut j = journal();
        for (step, ok) in [
            (Step::Started, true),
            (Step::Work, true),
            (Step::VerifyLive, true),
            (Step::Reopen, false),
            (Step::Finalize, false),
        ] {
            j.step = step;
            assert_eq!(may_release_cloud(&j), ok, "{step:?}");
        }
        j.step = Step::Rollback;
        j.rollback_from = Some(Step::Reopen);
        assert!(
            !may_release_cloud(&j),
            "a rollback that began after the point of no return never releases"
        );
        j.rollback_from = Some(Step::Work);
        assert!(may_release_cloud(&j));
    }

    #[test]
    fn torn_progress_json_cannot_release_moved() {
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        progress::write(
            &u,
            &Progress {
                phase: "x".into(),
                cloud: "released".into(),
                updated_ms: 1,
                op_id: None,
            },
        )
        .unwrap();
        std::fs::write(progress::path(&u), b"{\"cloud\":\"rel").unwrap();
        let mut j = journal();
        j.step = Step::Reopen;
        assert!(progress::read(&u).is_none());
        assert!(
            !may_release_cloud(&j),
            "the decision never reads the progress file"
        );
    }

    // ---- the run

    #[test]
    fn a_clean_run_holds_copies_verifies_and_marks_moved_last() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        run(&r, &mut w).unwrap();
        assert_eq!(
            *r.log.lock().unwrap(),
            ["begin_draining", "freeze", "mark_moved"]
        );
        assert_eq!(
            *r.knobs.calls.lock().unwrap(),
            [
                "default_replica",
                "unguarded_tables",
                "copy",
                "rederive",
                "verify_clone",
                "verify_live"
            ]
        );
        assert_eq!(mode(&r), "offline-only");
        assert_eq!(
            progress::read(&r.env.roots.update_dir()).unwrap().cloud,
            "moved"
        );
    }

    #[test]
    fn the_late_table_check_runs_after_begin_draining_and_before_freeze() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.order_log = Some(r.log.clone());
        let mut w = work(&r, inputs(&[]));
        run(&r, &mut w).unwrap();
        assert_eq!(
            *r.log.lock().unwrap(),
            ["begin_draining", "unguarded_tables", "freeze", "mark_moved"],
            "the hold is taken first (a table created before it is still seen), the check precedes the freeze"
        );
    }

    #[test]
    fn freeze_rechecks_late_tables_without_a_guard() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.unguarded = "zz_late".into();
        let mut w = work(&r, inputs(&[]));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(e.reason, "FENCE_TABLES_UNGUARDED");
        let log = r.log.lock().unwrap().clone();
        assert!(!log.contains(&"freeze".to_string()), "{log:?}");
        assert!(log.contains(&"release_held".to_string()), "{log:?}");
        assert_eq!(
            r.fence.state.lock().unwrap().as_str(),
            "active||active",
            "the refusal leaves the cloud active, not draining"
        );
        assert_eq!(mode(&r), "cloud");
    }

    #[test]
    fn freeze_rechecks_default_replica() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.replica = "anon@*".into();
        let mut w = work(&r, inputs(&[]));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(e.reason, "FENCE_DEFAULT_REPLICA");
        let log = r.log.lock().unwrap().clone();
        assert!(
            !log.contains(&"freeze".to_string()),
            "no freeze after a bad default: {log:?}"
        );
        assert!(
            log.contains(&"release_held".to_string()),
            "the cloud is given back: {log:?}"
        );
        assert_eq!(mode(&r), "cloud");
    }

    #[test]
    fn op_id_is_persisted_before_mark_moved() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        run(&r, &mut w).unwrap();
        let log = r.log.lock().unwrap().clone();
        assert_eq!(log.last().map(String::as_str), Some("mark_moved"));
        let seen = r
            .fence
            .progress_seen_at_mark
            .lock()
            .unwrap()
            .clone()
            .expect("a record existed when mark_moved was called");
        assert_eq!(seen.op_id.as_deref(), Some("op"));
        assert_eq!(
            seen.cloud, "held",
            "recorded while the cloud is still only held"
        );
        // the durable record is the journal: the id it holds is the id the cloud was marked with
        assert_eq!(
            r.fence.marked_with.lock().unwrap().clone(),
            Some(journal().op_id)
        );
    }

    #[test]
    fn on_commit_without_a_fence_is_idempotent_and_flips_the_mode_once() {
        let r = rig(vec![]);
        let mut j = journal();
        j.step = Step::Reopen;
        let mut recovered = recovered(&j, &r.env);
        recovered.on_commit(&ctx()).unwrap();
        recovered.on_commit(&ctx()).unwrap();
        assert_eq!(mode(&r), "offline-only");
        assert!(
            r.log.lock().unwrap().is_empty(),
            "a recovered commit never reaches the cloud"
        );
    }

    #[test]
    fn a_refused_mark_moved_is_a_normal_rollback_that_releases_the_cloud() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.fail_mark.lock().unwrap() = true;
        let mut w = work(&r, inputs(&[]));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(e.code, OpCode::RolledBack, "{e:?}");
        assert_eq!(mode(&r), "cloud");
        assert!(r.log.lock().unwrap().contains(&"release_held".to_string()));
    }

    #[test]
    fn kill_around_mark_moved_rolls_back_loudly_and_only_the_reopen_intent_rolls_forward() {
        // Both labels are inside verify_live, so the journal is at VerifyLive either way and recovery cannot tell them apart: it
        // rolls the local side back and says LOUDLY that the cloud MAY be moved (the real hook-kill of each label is Sandbox T13).
        // before_mark_moved: the cloud is only frozen; its dead-man timer returns it. after_mark_moved: the cloud IS moved and
        // `posctl switch rollback <op>` is the way back.
        for (label, phase_on_disk, cloud_on_disk) in [
            ("before_mark_moved", "marking moved", "held"),
            ("after_mark_moved", "moved", "moved"),
        ] {
            let r = rig(vec![]);
            progress::write(
                &r.env.roots.update_dir(),
                &Progress {
                    phase: phase_on_disk.into(),
                    cloud: cloud_on_disk.into(),
                    updated_ms: 1,
                    op_id: Some("op".into()),
                },
            )
            .unwrap();
            let out = recover_at(&r, Step::VerifyLive, Phase::Intent, true).unwrap();
            assert_eq!(
                out,
                Recovered::RolledBack {
                    reason: "CLOUD_MAY_BE_MOVED".into()
                },
                "{label}"
            );
            assert_eq!(mode(&r), "cloud", "{label}: local is not switched");
            let p = unknown_for(&r);
            assert!(p.phase.contains("may be moved"), "{label}: {p:?}");
            let (code, msg, _) = progress::status_alert(&r.env.roots.update_dir(), false, false).unwrap();
            assert_eq!(code, "SWITCH_CLOUD_MAY_BE_MOVED", "{label}");
            assert!(msg.contains("posctl switch rollback op"), "{label}: {msg}");
        }
        let r = rig(vec![]);
        assert_eq!(
            recover_at(&r, Step::Reopen, Phase::Intent, true).unwrap(),
            Recovered::RolledForward
        );
        assert_eq!(mode(&r), "offline-only");
    }

    #[test]
    fn recovery_never_resumes_from_a_dump() {
        let r = rig(vec![]);
        let mut recovered = SwitchWork::from_journal(&journal(), &r.env).unwrap();
        let e = recovered.work_on_clone(&ctx()).unwrap_err();
        assert_eq!(
            (e.reason.as_str(), e.code),
            ("SWITCH_NOT_RESUMABLE", OpCode::Error)
        );
        assert_eq!(
            recovered.verify_clone(&ctx()).unwrap_err().reason,
            "SWITCH_NOT_RESUMABLE"
        );
        let mut not_switch = journal();
        not_switch.kind = OpKind::Update;
        assert!(SwitchWork::from_journal(&not_switch, &r.env).is_err());
    }

    #[test]
    fn any_failure_before_mark_moved_returns_the_cloud() {
        // a finding in the clone, and a failing live check/photo step
        for (findings, fail_live, reason) in [
            (vec!["FINGERPRINT_MISMATCH"], false, "CLONE_VERIFY_FAILED"),
            (vec![], true, "PHOTOS_IMPORT_FAILED"),
        ] {
            let mut r = rig(vec![till(A, "POS-1", 0)]);
            r.knobs.findings = findings;
            r.knobs.fail_live = fail_live;
            let mut w = work(&r, inputs(&[]));
            let e = run(&r, &mut w).unwrap_err();
            assert_eq!(e.reason, reason);
            let log = r.log.lock().unwrap().clone();
            assert!(
                log.contains(&"release_held".to_string())
                    && !log.contains(&"mark_moved".to_string()),
                "{log:?}"
            );
            assert_eq!(mode(&r), "cloud");
            assert_eq!(
                progress::read(&r.env.roots.update_dir()).unwrap().cloud,
                "released"
            );
        }
    }

    #[test]
    fn a_till_that_never_drains_times_out_and_the_cloud_is_returned() {
        let mut busy = till(A, "POS-1", 2);
        busy.after_drain = true;
        let r = rig(vec![busy]);
        let mut w = work(&r, inputs(&[]));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(e.reason, "DRAIN_TIMEOUT");
        assert!(r.log.lock().unwrap().contains(&"release_held".to_string()));
    }

    #[test]
    fn a_waived_till_does_not_hold_the_drain() {
        let r = rig(vec![till(A, "POS-1", 2)]);
        let mut w = work(&r, inputs(&[A]));
        run(&r, &mut w).unwrap();
    }

    // ---- review M1/M2/M3, S1, S2: the cloud is marked moved LAST before the point of no return

    use crate::ops::journal::Phase;
    use crate::ops::recover::{ctx_from_journal, recover, Recovered};

    #[test]
    fn mark_moved_is_the_last_thing_verify_live_does() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        w.verify_live(&ctx()).unwrap();
        assert_eq!(
            *r.log.lock().unwrap(),
            ["mark_moved"],
            "verify_live ends by marking the cloud moved"
        );
        assert_eq!(
            *r.knobs.calls.lock().unwrap(),
            ["verify_live"],
            "after the live check and the photos"
        );
    }

    #[test]
    fn on_commit_never_contacts_the_cloud() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[]));
        w.on_commit(&ctx()).unwrap();
        assert!(
            r.log.lock().unwrap().is_empty(),
            "the cloud was marked before the point of no return"
        );
        assert_eq!(mode(&r), "offline-only");
    }

    thread_local!(static PAIRED: RefCell<Vec<(String, bool)>> = const { RefCell::new(Vec::new()) });
    fn pair_ok(
        r: &crate::paths::Roots,
        install_trust: bool,
        _: Duration,
    ) -> Result<Value, crate::envelope::PosctlError> {
        let seen = crate::config::PosctlJson::load(r).unwrap().unwrap().mode;
        PAIRED.with(|p| p.borrow_mut().push((seen, install_trust)));
        Ok(json!({}))
    }
    fn pair_fails(
        r: &crate::paths::Roots,
        install_trust: bool,
        w: Duration,
    ) -> Result<Value, crate::envelope::PosctlError> {
        pair_ok(r, install_trust, w)?;
        Err(crate::envelope::PosctlError::new(
            crate::envelope::Code::PairFailed,
            "no root.crt",
        ))
    }

    #[test]
    fn on_commit_pairs_the_server_with_itself_after_the_mode_flip() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let mut w = work(&r, inputs(&[])).with_self_pair(pair_ok);
        w.on_commit(&ctx()).unwrap();
        // the pairing saw the mode already flipped; a non-dev root installs the trust (the temp root is dev: trust off)
        assert_eq!(
            PAIRED.with(|p| p.borrow().clone()),
            vec![("offline-only".to_string(), !r.env.roots.dev)]
        );
    }

    #[test]
    fn a_failed_self_pair_is_recovery_needed_with_the_mode_already_flipped_and_a_repeat_is_harmless(
    ) {
        let r = rig(vec![]);
        let mut j = journal();
        j.step = Step::Reopen;
        let mut w = SwitchWork::from_journal(&j, &r.env)
            .unwrap()
            .with_self_pair(pair_fails);
        let e = w.on_commit(&ctx()).unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (OpCode::RecoveryNeeded, "SELF_PAIR_FAILED"),
            "{e:?}"
        );
        assert_eq!(
            mode(&r),
            "offline-only",
            "the switch is committed; recovery fixes forward"
        );
        let e = w.on_commit(&ctx()).unwrap_err();
        assert_eq!(e.reason, "SELF_PAIR_FAILED");
        // the operator re-runs recovery once the cause is gone
        let mut again = SwitchWork::from_journal(&j, &r.env)
            .unwrap()
            .with_self_pair(pair_ok);
        again.on_commit(&ctx()).unwrap();
        again.on_commit(&ctx()).unwrap();
        assert_eq!(mode(&r), "offline-only");
    }

    /// `update --recover` after a failed post-commit self-pairing: a journal at the reopen intent with the swap visible.
    #[test]
    fn recovery_after_a_failed_self_pair_keeps_its_reason_and_retries_the_pairing() {
        let r = rig(vec![]);
        let s = fresh();
        let mut j = journal();
        j.step = Step::Reopen;
        j.phase = Phase::Intent;
        {
            let mut st = s.borrow_mut();
            st.journal = Some(j.clone());
            st.dbs.insert(j.db.prev.clone(), "new");
        }
        let c = ctx_from_journal(&j);
        PAIRED.with(|p| p.borrow_mut().clear());
        // pairing keeps failing: every recovery is RecoveryNeeded / SELF_PAIR_FAILED and the journal stays open
        for attempt in 1..=2 {
            let mut w = SwitchWork::from_journal(&j, &r.env).unwrap().with_self_pair(pair_fails);
            let e = recover(&mut FakeWorld(s.clone()), &mut w, &c, &mut j).unwrap_err();
            assert_eq!((e.code, e.reason.as_str()), (OpCode::RecoveryNeeded, "SELF_PAIR_FAILED"), "attempt {attempt}: {e:?}");
            assert!(e.message.contains("posctl update --recover"), "{}", e.message);
            assert!(s.borrow().journal.is_some(), "attempt {attempt}: the journal must stay open");
        }
        assert_eq!(PAIRED.with(|p| p.borrow().len()), 2);
        // the cause is gone: recovery rolls forward, pairs again and archives the journal
        let mut w = SwitchWork::from_journal(&j, &r.env).unwrap().with_self_pair(pair_ok);
        let out = recover(&mut FakeWorld(s.clone()), &mut w, &c, &mut j);
        assert!(matches!(out, Ok(Recovered::RolledForward)), "{out:?}");
        assert!(s.borrow().journal.is_none(), "rolled forward: the journal is archived");
        assert_eq!(PAIRED.with(|p| p.borrow().clone()), vec![("offline-only".to_string(), !r.env.roots.dev); 3]);
        assert_eq!(mode(&r), "offline-only");
    }

    #[test]
    fn a_recovered_on_commit_without_proof_refuses_and_leaves_the_mode() {
        let r = rig(vec![]);
        for step in [
            Step::Work,
            Step::VerifyClone,
            Step::Swap,
            Step::Activate,
            Step::VerifyLive,
        ] {
            let mut j = journal();
            j.step = step;
            let mut w = SwitchWork::from_journal(&j, &r.env).unwrap();
            let e = w.on_commit(&ctx()).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::RecoveryNeeded, "CLOUD_MARK_PENDING"),
                "{step:?}"
            );
            assert_eq!(mode(&r), "cloud", "{step:?}: the mode is untouched");
        }
        let mut j = journal();
        j.step = Step::Reopen;
        recovered(&j, &r.env).on_commit(&ctx()).unwrap();
        assert_eq!(
            mode(&r),
            "offline-only",
            "from the Reopen intent on the journal proves the cloud is moved"
        );
    }

    #[test]
    fn another_switchs_hold_survives_our_rollback() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.other_hold.lock().unwrap() = true;
        *r.fence.state.lock().unwrap() = "frozen|someone-else|frozen".into();
        let mut w = work(&r, inputs(&[]));
        assert_eq!(run(&r, &mut w).unwrap_err().reason, "CLOUD_NOT_ACTIVE");
        assert_eq!(
            r.fence.state.lock().unwrap().as_str(),
            "frozen|someone-else|frozen",
            "our rollback must not free a hold that is not ours"
        );
        assert!(*r.fence.other_hold.lock().unwrap());
    }

    #[test]
    fn a_cloud_moved_by_another_op_is_an_error_and_never_flips_the_mode() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.state.lock().unwrap() = "moved|someone-else|moved".into();
        let mut w = work(&r, inputs(&[]));
        assert!(run(&r, &mut w).is_err());
        assert_eq!(mode(&r), "cloud");
        assert!(!r.log.lock().unwrap().contains(&"mark_moved".to_string()));
    }

    /// Crash points: what `update --recover` does with a switch journal left at each step (no credentials, no fence).
    fn recover_at(r: &Rig, step: Step, phase: Phase, swapped: bool) -> R<Recovered> {
        let s = fresh();
        let mut j = journal();
        j.step = step;
        j.phase = phase;
        {
            let mut st = s.borrow_mut();
            st.journal = Some(j.clone());
            if swapped {
                st.dbs.insert(j.db.prev.clone(), "new");
            } else {
                st.dbs.insert(j.db.next.clone(), "new");
            }
        }
        let mut w = recovered(&j, &r.env);
        let c = ctx_from_journal(&j);
        recover(&mut FakeWorld(s), &mut w, &c, &mut j)
    }

    #[test]
    fn a_recovered_switch_that_rolled_back_is_a_rolled_back_outcome_not_an_error() {
        let r = rig(vec![]);
        let out = recover_at(&r, Step::VerifyLive, Phase::Done, true);
        assert!(matches!(out, Ok(Recovered::RolledBack { .. })), "{out:?}");
        assert_eq!(mode(&r), "cloud");
    }

    #[test]
    fn crash_points_table() {
        // (step, phase, swapped) -> rolled forward?
        let table = [
            (Step::Work, Phase::Intent, false, false),
            (Step::Work, Phase::Done, false, false),
            (Step::VerifyClone, Phase::Intent, false, false),
            (Step::Swap, Phase::Intent, false, false),
            (Step::Swap, Phase::Done, true, false),
            (Step::Activate, Phase::Intent, true, false),
            (Step::VerifyLive, Phase::Intent, true, false),
            (Step::VerifyLive, Phase::Done, true, false),
            (Step::Reopen, Phase::Intent, true, true),
            (Step::Finalize, Phase::Intent, true, true),
            (Step::Rollback, Phase::Intent, false, false),
        ];
        for (step, phase, swapped, forward) in table {
            let r = rig(vec![]);
            let out = recover_at(&r, step, phase, swapped)
                .unwrap_or_else(|e| panic!("{step:?}/{phase:?}: {e:?}"));
            assert_eq!(
                matches!(out, Recovered::RolledForward),
                forward,
                "{step:?}/{phase:?}: {out:?}"
            );
            assert_eq!(
                mode(&r),
                if forward { "offline-only" } else { "cloud" },
                "{step:?}/{phase:?}"
            );
        }
    }

    #[test]
    fn only_a_journal_before_the_work_step_proves_begin_draining_never_ran() {
        let at = |step: Step, phase: Phase, from: Option<Step>| {
            let mut j = journal();
            j.step = step;
            j.phase = phase;
            j.rollback_from = from;
            proves_never_drained(&j)
        };
        for phase in [Phase::Intent, Phase::Done] {
            for s in [Step::Started, Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb] {
                assert!(at(s, phase, None), "{s:?}/{phase:?}");
                assert!(at(Step::Rollback, phase, Some(s)), "rolling back from {s:?}/{phase:?}");
            }
            // Work's intent is written right before begin_draining: it may or may not have run. Everything later is doubt too.
            for s in [Step::Work, Step::VerifyClone, Step::Swap, Step::Activate, Step::VerifyLive, Step::Reopen, Step::Finalize] {
                assert!(!at(s, phase, None), "{s:?}/{phase:?}");
                assert!(!at(Step::Rollback, phase, Some(s)), "rolling back from {s:?}/{phase:?}");
            }
            assert!(!at(Step::Rollback, phase, None), "a rollback with no origin is doubt");
        }
    }

    #[test]
    fn a_recovered_switch_that_never_began_draining_records_released_and_raises_no_alert() {
        for step in [Step::Started, Step::Fence, Step::Backup, Step::RepairCollation, Step::CloneDb] {
            for phase in [Phase::Intent, Phase::Done] {
                let r = rig(vec![]);
                let out = recover_at(&r, step, phase, false).unwrap();
                assert!(matches!(out, Recovered::RolledBack { .. }), "{step:?}/{phase:?}: {out:?}");
                let p = progress::read(&r.env.roots.update_dir()).unwrap_or_else(|| panic!("{step:?}/{phase:?}: released must be written"));
                assert_eq!((p.cloud.as_str(), p.op_id.as_deref()), ("released", Some("op")), "{step:?}/{phase:?}");
                assert!(progress::status_alert(&r.env.roots.update_dir(), false, false).is_none(), "{step:?}/{phase:?}: no SWITCH_CLOUD_NOT_RELEASED");
            }
        }
        // another operation's record is not touched: a finished one, and above all an alert of its own
        for cloud in ["released", "held"] {
            let r = rig(vec![]);
            let old = Progress { phase: "p".into(), cloud: cloud.into(), updated_ms: 5, op_id: Some("old-op".into()) };
            progress::write(&r.env.roots.update_dir(), &old).unwrap();
            recover_at(&r, Step::CloneDb, Phase::Done, false).unwrap();
            assert_eq!(progress::read(&r.env.roots.update_dir()), Some(old), "{cloud}");
        }
    }

    #[test]
    fn a_recovered_switch_that_may_have_begun_draining_still_writes_held() {
        for (step, phase, from) in [
            (Step::Work, Phase::Intent, None),
            (Step::Work, Phase::Done, None),
            (Step::VerifyClone, Phase::Intent, None),
            (Step::Rollback, Phase::Intent, Some(Step::Work)),
            (Step::Rollback, Phase::Intent, None), // a rollback whose origin is not recorded is doubt
        ] {
            let r = rig(vec![]);
            let s = fresh();
            let mut j = journal();
            j.step = step;
            j.phase = phase;
            j.rollback_from = from;
            s.borrow_mut().journal = Some(j.clone());
            s.borrow_mut().dbs.insert(j.db.next.clone(), "new");
            let mut w = SwitchWork::from_journal(&j, &r.env).unwrap();
            assert!(!w.never_drained, "{step:?}/{from:?}");
            let c = ctx_from_journal(&j);
            recover(&mut FakeWorld(s), &mut w, &c, &mut j).unwrap();
            let p = progress::read(&r.env.roots.update_dir()).unwrap_or_else(|| panic!("{step:?}/{from:?}: held must be written"));
            assert_eq!((p.cloud.as_str(), p.op_id.as_deref()), ("held", Some("op")), "{step:?}/{from:?}");
            let (code, _, _) = progress::status_alert(&r.env.roots.update_dir(), false, false).expect("a cloud that may be held alerts");
            assert_eq!(code, "SWITCH_CLOUD_NOT_RELEASED", "{step:?}/{from:?}");
        }
    }

    #[test]
    fn the_move_window_in_this_ops_progress_beats_the_never_drained_proof() {
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        let mut j = journal();
        j.step = Step::CloneDb;
        assert!(SwitchWork::from_journal(&j, &r.env).unwrap().never_drained);
        for cloud in ["moved", "unknown"] {
            progress::write(&u, &Progress { phase: "x".into(), cloud: cloud.into(), updated_ms: 1, op_id: Some("op".into()) }).unwrap();
            assert!(!SwitchWork::from_journal(&j, &r.env).unwrap().never_drained, "{cloud}: any doubt keeps the alarm");
        }
    }

    // ---- failure paths: each ends with the cloud given back and the mode untouched

    fn assert_released_and_unswitched(r: &Rig, reason: &str, e: &OpError) {
        assert_eq!(e.reason, reason, "{e:?}");
        assert_eq!(mode(r), "cloud");
        assert!(
            r.log.lock().unwrap().contains(&"release_held".to_string()),
            "{:?}",
            r.log.lock().unwrap()
        );
        assert!(!r.log.lock().unwrap().contains(&"mark_moved".to_string()));
    }

    #[test]
    fn a_blocked_freeze_returns_the_cloud() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.freeze_err.lock().unwrap() = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_released_and_unswitched(&r, "CLOUD_FREEZE_BLOCKED", &e);
    }

    // ---- 11H: the cloud pepper is imported, nothing is re-derived ----

    fn proof_with(pepper: &str) -> Arc<AdminProof> {
        Arc::new(AdminProof { admin_id: A.into(), pepper: crate::switch::prompt::Entered::new(pepper.to_string()), pin: crate::switch::prompt::Entered::new("135790".into()) })
    }
    fn local_pepper_is(r: &Rig, v: &str) -> bool {
        crate::util::read_secret_file(&r.env.secrets().join(crate::secrets::PEPPER_FILE)).is_ok_and(|p| p.expose() == v)
    }
    fn put_local_pepper(r: &Rig, v: &str) {
        std::fs::create_dir_all(r.env.secrets()).unwrap();
        crate::util::write_secret_file(&r.env.secrets().join(crate::secrets::PEPPER_FILE), v).unwrap();
    }
    fn counting(r: &mut Rig) -> std::rc::Rc<std::cell::Cell<u32>> {
        let n = std::rc::Rc::new(std::cell::Cell::new(0));
        let n2 = n.clone();
        r.env.activate = std::rc::Rc::new(move |_, _, _| {
            n2.set(n2.get() + 1);
            Ok(())
        });
        n
    }

    #[test]
    fn switch_imports_the_cloud_pepper_and_skips_rederive() {
        let mut r = rig(vec![]);
        let n = counting(&mut r);
        let (local, cloud) = ("local-pepper-0123456789abcdefghijklmnop", "cloud-pepper-0123456789abcdefghijklmnop");
        put_local_pepper(&r, local);
        let mut w = work(&r, inputs(&[])).with_proof(proof_with(cloud));
        run(&r, &mut w).unwrap();
        assert!(local_pepper_is(&r, cloud), "the cloud's pepper is the local one after the switch");
        assert!(!crate::backup::pepper::prev_path(&r.env.secrets().join(crate::secrets::PEPPER_FILE)).exists(), "the commit dropped the kept pepper");
        assert_eq!(n.get(), 1, "the services' environment is re-rendered once, after the swap");
        assert!(r.knobs.calls.lock().unwrap().contains(&"rederive"), "the staff-account step ran");
        let report = w.rederive_report.expect("the report of the staff-account step");
        assert_eq!((report.rows, report.scrambled), (1, 0), "counts only: staff credentials are kept, nothing is derived");
    }

    #[test]
    fn a_switch_that_rolls_back_puts_the_machines_own_pepper_back() {
        let mut r = rig(vec![]);
        let n = counting(&mut r);
        let (local, cloud) = ("local-pepper-0123456789abcdefghijklmnop", "cloud-pepper-0123456789abcdefghijklmnop");
        put_local_pepper(&r, local);
        r.knobs.fail_live = true;
        let mut w = work(&r, inputs(&[])).with_proof(proof_with(cloud));
        assert!(run(&r, &mut w).is_err());
        assert!(local_pepper_is(&r, local), "the machine's own pepper is back");
        assert!(!crate::backup::pepper::prev_path(&r.env.secrets().join(crate::secrets::PEPPER_FILE)).exists());
        assert_eq!(n.get(), 2, "installed, then re-rendered again for the old pepper");
        assert!(!w.warnings().iter().any(|x| x.contains("PEPPER")), "{:?}", w.warnings());
    }

    #[test]
    fn a_switch_refuses_to_start_over_a_kept_pepper_and_never_touches_it() {
        let mut r = rig(vec![]);
        let n = counting(&mut r);
        let (local, cloud, stale) = ("local-pepper-0123456789abcdefghijklmnop", "cloud-pepper-0123456789abcdefghijklmnop", "stale-pepper-0123456789abcdefghijklmnop");
        put_local_pepper(&r, local);
        let prev = crate::backup::pepper::prev_path(&r.env.secrets().join(crate::secrets::PEPPER_FILE));
        crate::util::write_secret_file(&prev, stale).unwrap();
        let mut w = work(&r, inputs(&[])).with_proof(proof_with(cloud));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(e.reason, "PEPPER_PREV_PRESENT", "{e:?}");
        assert!(local_pepper_is(&r, local), "the machine's pepper is untouched");
        assert_eq!(crate::util::read_secret_file(&prev).unwrap().expose(), stale, "the kept file is neither deleted nor put back");
        assert_eq!(n.get(), 0);
        assert!(!w.warnings().iter().any(|x| x.contains("PEPPER")), "{:?}", w.warnings());
    }

    #[test]
    fn a_switch_whose_cloud_pepper_is_the_local_one_never_rolls_back_to_a_stale_prev() {
        let mut r = rig(vec![]);
        let _ = counting(&mut r);
        let same = "same-pepper-0123456789abcdefghijklmnopqr";
        put_local_pepper(&r, same);
        r.knobs.fail_live = true;
        let mut w = work(&r, inputs(&[])).with_proof(proof_with(same));
        assert!(run(&r, &mut w).is_err());
        let prev = crate::backup::pepper::prev_path(&r.env.secrets().join(crate::secrets::PEPPER_FILE));
        assert!(!prev.exists() && local_pepper_is(&r, same));
        // a `.prev` that appears after the start is not this run's: the rollback leaves it alone
        let mut w = work(&r, inputs(&[])).with_proof(proof_with(same));
        crate::util::write_secret_file(&prev, "late-0123456789abcdefghijklmnopqrstuv").unwrap();
        w.put_pepper_back().unwrap();
        assert!(local_pepper_is(&r, same) && prev.exists());
    }

    #[test]
    fn a_failed_copy_or_rederive_returns_the_cloud() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.fail_copy = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_released_and_unswitched(&r, "RESTORE_FAILED", &e);
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.fail_rederive = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_released_and_unswitched(&r, "ADMIN_SIGN_IN_FAILED", &e);
    }

    #[test]
    fn a_data_move_child_killed_at_the_budget_deadline_ends_in_a_rollback_with_the_cloud_released() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.budget_copy = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_eq!(e.code, OpCode::RolledBack);
        assert_released_and_unswitched(&r, "MAINTENANCE_BUDGET", &e);
    }

    #[test]
    fn a_hold_lost_mid_copy_aborts_before_the_clone_is_used() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        r.fence
            .lost
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_released_and_unswitched(&r, "CLOUD_FENCE_LOST", &e);
    }

    #[test]
    fn a_release_that_fails_is_a_warning_and_the_progress_stays_held() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.release_err.lock().unwrap() = true;
        let mut w = work(&r, inputs(&[]));
        let mut k = r.knobs.clone();
        k.fail_copy = true;
        w.machine = Some(Box::new(FakeMachine(k)));
        let e = run(&r, &mut w).unwrap_err();
        assert_eq!(
            e.reason, "RESTORE_FAILED",
            "the local rollback still finished"
        );
        assert!(w.warnings().contains(&"CLOUD_RELEASE_FAILED".to_string()));
        assert_eq!(
            progress::read(&r.env.roots.update_dir()).unwrap().cloud,
            "held",
            "status keeps alerting"
        );
    }

    #[test]
    fn a_hold_that_belongs_to_another_op_id_is_refused_before_the_cloud_is_marked() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.op.lock().unwrap() = "someone-else".into();
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_released_and_unswitched(&r, "OP_ID_MISMATCH", &e);
    }

    // ---- re-review M-a / M-b: a cloud that may be moved is never reported as released

    fn unknown_for(r: &Rig) -> Progress {
        let p = progress::read(&r.env.roots.update_dir()).expect("a progress record");
        assert_eq!(
            (p.cloud.as_str(), p.op_id.as_deref()),
            ("unknown", Some("op")),
            "{p:?}"
        );
        p
    }

    #[test]
    fn a_mark_moved_whose_reply_was_lost_but_committed_rolls_forward() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.reply_lost.lock().unwrap() = true;
        let mut w = work(&r, inputs(&[]));
        run(&r, &mut w).unwrap();
        assert_eq!(
            mode(&r),
            "offline-only",
            "the cloud row reads moved|op, which is proof"
        );
        assert_eq!(
            progress::read(&r.env.roots.update_dir()).unwrap().cloud,
            "moved"
        );
    }

    #[test]
    fn a_refusal_of_mark_moved_is_not_re_read_as_success() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.expired.lock().unwrap() = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_eq!(e.reason, "CLOUD_FENCE_LOST", "{e:?}");
        assert_eq!(
            r.fence.state.lock().unwrap().as_str(),
            "active||active",
            "our own expired hold is freed by the rollback"
        );
        assert_eq!(mode(&r), "cloud");
    }

    #[test]
    fn a_release_that_freed_nothing_on_a_moved_cloud_is_unknown_never_released() {
        let r = rig(vec![]);
        *r.fence.state.lock().unwrap() = "moved|op|moved".into();
        let mut w = work(&r, inputs(&[]));
        w.verify_after_rollback(&ctx()).unwrap();
        unknown_for(&r);
        assert!(
            w.warnings().contains(&"CLOUD_STILL_MOVED".to_string()),
            "{:?}",
            w.warnings()
        );
        assert!(
            progress::status_alert(&r.env.roots.update_dir(), false, false).is_some(),
            "status keeps alerting"
        );
    }

    #[test]
    fn a_release_that_freed_nothing_on_an_active_cloud_is_verified_before_it_is_called_released() {
        let r = rig(vec![]);
        *r.fence.state.lock().unwrap() = "active||active".into();
        let mut w = work(&r, inputs(&[]));
        w.verify_after_rollback(&ctx()).unwrap();
        assert_eq!(
            progress::read(&r.env.roots.update_dir()).unwrap().cloud,
            "released"
        );
        // and a state that cannot be read is unknown, not released
        *r.fence.state.lock().unwrap() = String::new();
        let mut w = work(&r, inputs(&[]));
        w.verify_after_rollback(&ctx()).unwrap();
        assert_eq!(
            progress::read(&r.env.roots.update_dir()).unwrap().cloud,
            "unknown"
        );
    }

    #[test]
    fn rolling_back_never_erases_the_op_id_from_the_progress_record() {
        let mut r = rig(vec![till(A, "POS-1", 0)]);
        r.knobs.fail_copy = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_eq!(e.reason, "RESTORE_FAILED");
        let p = progress::read(&r.env.roots.update_dir()).unwrap();
        assert_eq!(
            (p.cloud.as_str(), p.op_id.as_deref()),
            ("released", Some("op"))
        );
        // and a fence-less rollback (an early step) keeps it too
        let rr = rig(vec![]);
        let mut j = journal();
        j.step = Step::Work;
        SwitchWork::from_journal(&j, &rr.env)
            .unwrap()
            .verify_after_rollback(&ctx())
            .unwrap();
        assert_eq!(
            progress::read(&rr.env.roots.update_dir())
                .unwrap()
                .op_id
                .as_deref(),
            Some("op")
        );
    }

    #[test]
    fn a_recovery_in_the_verify_live_window_is_loud_and_names_the_operation() {
        // the journal alone cannot say whether mark_moved ran: before or after it, the cloud MAY be moved
        for (step, phase, from) in [
            (Step::VerifyLive, Phase::Intent, None),
            (Step::VerifyLive, Phase::Done, None),
            (Step::Rollback, Phase::Intent, Some(Step::VerifyLive)),
        ] {
            let r = rig(vec![]);
            let s = fresh();
            let mut j = journal();
            j.step = step;
            j.phase = phase;
            j.rollback_from = from;
            {
                let mut st = s.borrow_mut();
                st.journal = Some(j.clone());
                st.dbs.insert(j.db.prev.clone(), "new");
            }
            let mut w = SwitchWork::from_journal(&j, &r.env).unwrap();
            let c = ctx_from_journal(&j);
            let out = recover(&mut FakeWorld(s), &mut w, &c, &mut j).unwrap();
            // a journal already rolling back keeps its own reason; the progress record and the warning carry the alert
            let want = if step == Step::Rollback {
                "RECOVERED_AFTER_INTERRUPTION"
            } else {
                "CLOUD_MAY_BE_MOVED"
            };
            assert_eq!(
                out,
                Recovered::RolledBack {
                    reason: want.into()
                },
                "{step:?}"
            );
            unknown_for(&r);
            assert!(w.warnings().contains(&"CLOUD_MAY_BE_MOVED".to_string()));
            assert_eq!(mode(&r), "cloud");
        }
        // steps before the swap are not in the window: the cloud was only held
        let r = rig(vec![]);
        let out = recover_at(&r, Step::VerifyClone, Phase::Intent, false).unwrap();
        assert_eq!(
            out,
            Recovered::RolledBack {
                reason: "RECOVERED_AFTER_INTERRUPTION".into()
            }
        );
        assert_ne!(
            progress::read(&r.env.roots.update_dir()).map(|p| p.cloud),
            Some("unknown".into())
        );
    }

    #[test]
    fn a_missing_or_unreadable_posctl_json_after_the_point_of_no_return_is_recovery_needed() {
        let r = rig(vec![]);
        let mut j = journal();
        j.step = Step::Reopen;
        let mut w = SwitchWork::from_journal(&j, &r.env).unwrap();
        std::fs::remove_file(r.env.roots.conf().join("posctl.json")).unwrap();
        let e = w.on_commit(&ctx()).unwrap_err();
        assert_eq!(e.code, OpCode::RecoveryNeeded, "{e:?}");
        std::fs::write(r.env.roots.conf().join("posctl.json"), b"{ torn").unwrap();
        assert_eq!(
            w.on_commit(&ctx()).unwrap_err().code,
            OpCode::RecoveryNeeded
        );
    }

    #[test]
    fn the_clouds_effective_state_must_also_read_frozen() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.state.lock().unwrap() = "frozen|op|active".into(); // frozen row whose dead-man timer already ran out
        let e = work(&r, inputs(&[])).verify_live(&ctx()).unwrap_err();
        assert_eq!(e.reason, "CLOUD_NOT_HELD_BY_THIS_OP");
    }

    // ---- round-3 review: the "cloud may be moved" window survives every re-entry of recovery

    fn recover_journal(r: &Rig, mut j: Journal) -> R<Recovered> {
        let s = fresh();
        {
            let mut st = s.borrow_mut();
            st.journal = Some(j.clone());
            st.dbs.insert(j.db.prev.clone(), "new");
        }
        let mut w = recovered(&j, &r.env);
        let c = ctx_from_journal(&j);
        recover(&mut FakeWorld(s), &mut w, &c, &mut j)
    }

    #[test]
    fn the_window_stays_loud_when_recovery_re_enters_at_swap_or_activate() {
        // recovery of a VerifyLive journal first rewrites it to Activate/Intent; a crash there, or a failed rollback, leaves that behind
        for (step, from) in [
            (Step::Swap, None),
            (Step::Activate, None),
            (Step::Rollback, Some(Step::Activate)),
            (Step::Rollback, Some(Step::Swap)),
        ] {
            let r = rig(vec![]);
            let mut j = journal();
            j.step = step;
            j.rollback_from = from;
            recover_journal(&r, j).unwrap();
            let p = progress::read(&r.env.roots.update_dir()).unwrap();
            assert_eq!(
                (p.cloud.as_str(), p.op_id.as_deref()),
                ("unknown", Some("op")),
                "{step:?}/{from:?}"
            );
            assert_eq!(mode(&r), "cloud");
        }
    }

    #[test]
    fn a_second_recovery_never_downgrades_an_unknown_or_moved_record_of_the_same_op() {
        for kept in ["unknown", "moved"] {
            let r = rig(vec![]);
            progress::write(
                &r.env.roots.update_dir(),
                &Progress {
                    phase: "x".into(),
                    cloud: kept.into(),
                    updated_ms: 1,
                    op_id: Some("op".into()),
                },
            )
            .unwrap();
            // a journal that is NOT in the window (the record is what proves it) and one that is
            for step in [Step::Work, Step::Activate] {
                let mut j = journal();
                j.step = step;
                let _ = recover_journal(&r, j);
                let p = progress::read(&r.env.roots.update_dir()).unwrap();
                assert_eq!(
                    p.cloud, "unknown",
                    "{kept} at {step:?}: a fence-less work never says held after that"
                );
                assert_eq!(p.op_id.as_deref(), Some("op"));
            }
        }
    }

    #[test]
    fn an_ambiguous_mark_moved_followed_by_a_failed_release_is_unknown_not_held() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.fail_mark.lock().unwrap() = true; // the call was made and its answer is unusable
        *r.fence.release_err.lock().unwrap() = true;
        let mut w = work(&r, inputs(&[]));
        assert!(run(&r, &mut w).is_err());
        assert!(
            w.warnings().contains(&"CLOUD_STATE_UNKNOWN".to_string()),
            "{:?}",
            w.warnings()
        );
        let p = progress::read(&r.env.roots.update_dir()).unwrap();
        assert_eq!(
            (p.cloud.as_str(), p.op_id.as_deref()),
            ("unknown", Some("op"))
        );
    }

    #[test]
    fn a_new_run_refused_by_a_moved_cloud_leaves_the_old_operations_alert_alone() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        let u = r.env.roots.update_dir();
        let old = Progress {
            phase: "rolled back, the cloud is moved".into(),
            cloud: "unknown".into(),
            updated_ms: 5,
            op_id: Some("old-op".into()),
        };
        progress::write(&u, &old).unwrap();
        *r.fence.state.lock().unwrap() = "moved|old-op|moved".into();
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_eq!(e.reason, "CLOUD_NOT_ACTIVE");
        assert_eq!(
            progress::read(&u).unwrap(),
            old,
            "the old record (alert and op id) is untouched"
        );
    }

    #[test]
    fn a_release_never_calls_a_moved_row_released_whoever_owns_it() {
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        let old = Progress {
            phase: "p".into(),
            cloud: "unknown".into(),
            updated_ms: 5,
            op_id: Some("old-op".into()),
        };
        progress::write(&u, &old).unwrap();
        *r.fence.state.lock().unwrap() = "moved|old-op|moved".into();
        work(&r, inputs(&[])).verify_after_rollback(&ctx()).unwrap();
        assert_eq!(progress::read(&u).unwrap(), old);
        // a hold that belongs to another operation: also left alone
        *r.fence.state.lock().unwrap() = "frozen|someone-else|frozen".into();
        work(&r, inputs(&[])).verify_after_rollback(&ctx()).unwrap();
        assert_eq!(progress::read(&u).unwrap(), old);
    }

    #[test]
    fn an_alarm_of_this_operation_is_never_downgraded_by_a_later_write() {
        // a work WITH a fence whose release fails (and mark_moved was never attempted) would otherwise write `held` over `unknown`
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        let alarm = Progress {
            phase: "x".into(),
            cloud: "unknown".into(),
            updated_ms: 1,
            op_id: Some("op".into()),
        };
        progress::write(&u, &alarm).unwrap();
        *r.fence.release_err.lock().unwrap() = true;
        work(&r, inputs(&[])).verify_after_rollback(&ctx()).unwrap();
        assert_eq!(progress::read(&u).unwrap().cloud, "unknown");
    }

    #[test]
    fn another_operations_moved_record_is_left_alone_by_a_rollback_that_finds_its_moved_row() {
        let r = rig(vec![]);
        let u = r.env.roots.update_dir();
        let old = Progress {
            phase: "p".into(),
            cloud: "moved".into(),
            updated_ms: 5,
            op_id: Some("old-op".into()),
        };
        progress::write(&u, &old).unwrap();
        *r.fence.state.lock().unwrap() = "moved|old-op|moved".into();
        work(&r, inputs(&[])).verify_after_rollback(&ctx()).unwrap();
        assert_eq!(
            progress::read(&u).unwrap(),
            old,
            "never `released` for a moved row"
        );
    }

    #[test]
    fn no_hold_record_is_written_before_the_hold_is_taken() {
        let r = rig(vec![till(A, "POS-1", 0)]);
        run(&r, &mut work(&r, inputs(&[]))).unwrap();
        // at the moment begin_draining was called there was no record claiming a hold
        let seen = r
            .fence
            .progress_at_begin
            .lock()
            .unwrap()
            .clone()
            .expect("begin_draining was called");
        assert!(
            seen.as_ref().is_none_or(|p| p.cloud != "held"),
            "a hold was recorded before it was taken: {seen:?}"
        );
        // and a refused hold leaves no `held` record behind
        let r = rig(vec![till(A, "POS-1", 0)]);
        *r.fence.other_hold.lock().unwrap() = true;
        let e = run(&r, &mut work(&r, inputs(&[]))).unwrap_err();
        assert_eq!(e.reason, "CLOUD_NOT_ACTIVE");
        let seen = r
            .fence
            .progress_at_begin
            .lock()
            .unwrap()
            .clone()
            .expect("begin_draining was called");
        assert!(seen.as_ref().is_none_or(|p| p.cloud != "held"), "{seen:?}");
        let p = progress::read(&r.env.roots.update_dir());
        assert!(
            p.as_ref().is_none_or(|p| p.cloud != "held"),
            "a refused hold left a record: {p:?}"
        );
    }
}
