//! A world made of data. Crash injection: `crash_at = Some(k)` panics at the start of the k-th World/OpWork call,
//! so calls 1..k-1 have taken effect and call k has not (a process killed between two actions).
use crate::ops::journal::{Journal, Step};
use crate::ops::names::DbNames;
use crate::ops::outcome::{OpCode, OpError, OpKind};
use crate::ops::world::*;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gw { Live, Maintenance }

#[derive(Clone, Debug)]
pub struct FakeState {
    pub dbs: BTreeMap<String, &'static str>, // name -> "old" | "new" (the schema level inside)
    pub journal: Option<Journal>,
    pub gateway: Gw,
    pub roles_login: bool,
    pub recovery_suspended: bool,
    pub stack_up: bool,
    pub pack: &'static str,         // the pack the services run
    pub pack_current: &'static str, // posctl.json pointer
    pub calls: usize,
    pub crash_at: Option<usize>,
    pub now: u64,
    pub fail_work: bool,
    pub fail_backup: bool,
    pub fail_verify_live: bool,
    pub fail_swap_back: bool,
    pub jump_at: Option<(usize, u64)>, // (call number, ms): the clock leaps this far at that call (a budget that runs out at a chosen step)
    pub verify_live_takes_ms: u64,   // the clock moves this far while verify_live runs (a verification that eats the budget)
    pub violations: Vec<String>,
    pub order: Vec<&'static str>,    // on_commit / finish_unfence / reopen_gateway in the order they ran
    pub rows: BTreeMap<String, u32>, // sales stored in each database (they ride along when a database is renamed)
    pub accepted: u32,               // sales the till was allowed to ring up
    pub events: Vec<&'static str>,   // "fence" and the keep-awake guard's "awake" / "asleep" (the order of THOSE three)
    pub collation_mismatch: bool,    // the live database records a collation version the binary does not have (cloning it is refused)
    pub trace: Vec<&'static str>,   // "backup" / "repair_source" / "clone" in the order they ran
    pub fence_leaks: bool,           // mutation switch: a fence that does not close the gateway (proves the sales model bites)
}

pub type Shared = Rc<RefCell<FakeState>>;

pub const T0: u64 = 1_790_908_215_000;

pub fn fresh() -> Shared {
    let mut dbs = BTreeMap::new();
    dbs.insert("postgres".to_string(), "old");
    Rc::new(RefCell::new(FakeState {
        dbs, journal: None, gateway: Gw::Live, roles_login: true, recovery_suspended: false, stack_up: true,
        pack: "old", pack_current: "old", calls: 0, crash_at: None, now: T0,
        fail_work: false, fail_backup: false, fail_verify_live: false, fail_swap_back: false, verify_live_takes_ms: 0, jump_at: None, violations: vec![], order: vec![],
        rows: BTreeMap::new(), accepted: 0, events: vec![], collation_mismatch: false, trace: vec![], fence_leaks: false,
    }))
}

fn tick(s: &Shared) -> Done {
    let mut st = s.borrow_mut();
    st.calls += 1;
    st.now += 1000;
    if let Some((n, ms)) = st.jump_at { if st.calls == n { st.now += ms; } }
    if st.crash_at == Some(st.calls) {
        drop(st);
        panic!("CRASH");
    }
    drop(st);
    Done(s.clone())
}

/// After every call has taken effect the till tries to ring up a sale (the state between two calls is what a customer sees).
struct Done(Shared);
impl Drop for Done {
    fn drop(&mut self) { if !std::thread::panicking() { try_sale(&self.0); } }
}

/// A customer pays: accepted only when the gateway serves, the sign-in roles can log in and the stack is up. A sale is a row
/// in the live database. Accepting one between the clone and the reopen is a violation: it would land in a database that
/// the swap or the rollback is about to rename away.
fn try_sale(s: &Shared) {
    let mut st = s.borrow_mut();
    if st.gateway == Gw::Live && st.roles_login && st.stack_up && st.dbs.contains_key("postgres") {
        let step = st.journal.as_ref().map(|j| j.step);
        if let Some(step) = step {
            if step >= Step::CloneDb && step < Step::Reopen { st.violations.push(format!("sale accepted during {step:?}, before the point of no return")); }
        }
        st.accepted += 1;
        *st.rows.entry("postgres".to_string()).or_insert(0) += 1;
    }
}

/// A machine restart (note: the instant between the boot and recovery's first `fence()` is deliberately not modelled;
/// that the fence survives a reboot is proven by Sandbox scenario 75, not here):
/// everything volatile falls back to its boot default (the gateway serves, the roles can log in,
/// the services run the pack the pointer names). Databases, the journal and the pointer are durable.
pub fn reboot(s: &Shared) {
    let mut st = s.borrow_mut();
    st.gateway = Gw::Live; st.roles_login = true; st.stack_up = true; st.recovery_suspended = false;
    st.pack = st.pack_current;
}

fn level(v: &str) -> &'static str { if v == "old" { "old" } else { "new" } }

pub struct FakeWorld(pub Shared);
pub struct FakeWork(pub Shared);

impl World for FakeWorld {
    fn now_ms(&self) -> u64 { self.0.borrow().now }
    fn journal_write(&mut self, j: &Journal) -> R<()> { let _d = tick(&self.0); self.0.borrow_mut().journal = Some(j.clone()); Ok(()) }
    fn journal_archive(&mut self, _j: &Journal) -> R<()> { let _d = tick(&self.0); self.0.borrow_mut().journal = None; Ok(()) }
    fn db_names(&mut self) -> R<BTreeSet<String>> { let _d = tick(&self.0); let names = self.0.borrow().dbs.keys().cloned().collect(); Ok(names) }
    fn fence(&mut self) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        s.events.push("fence");
        s.recovery_suspended = true; s.stack_up = false; s.roles_login = false;
        if !s.fence_leaks { s.gateway = Gw::Maintenance; }
        Ok(())
    }
    fn run_backup(&mut self, _r: BackupReason, _t: u64) -> R<()> {
        let _d = tick(&self.0);
        self.0.borrow_mut().trace.push("backup");
        if self.0.borrow().fail_backup { return Err(OpError::new(OpCode::RolledBack, "PRE_UPDATE_BACKUP_FAILED", "backup failed")); }
        Ok(())
    }
    fn create_clone(&mut self, n: &DbNames) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        s.trace.push("clone");
        if s.collation_mismatch { return Err(OpError::new(OpCode::RolledBack, "CLONE_FAILED", "template database \"postgres\" has a collation version mismatch")); }
        let tag = s.dbs[&n.live];
        let r = s.rows.get(&n.live).copied().unwrap_or(0);
        s.dbs.insert(n.next.clone(), tag);
        s.rows.insert(n.next.clone(), r);
        Ok(())
    }
    fn drop_db(&mut self, name: &str) -> R<()> { let _d = tick(&self.0); let mut s = self.0.borrow_mut(); s.dbs.remove(name); s.rows.remove(name); Ok(()) }
    fn swap(&mut self, n: &DbNames) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        if !s.dbs.contains_key(&n.next) || s.dbs.contains_key(&n.prev) { return Err(OpError::err("SWAP_PRECONDITION", "clone missing or prev exists")); }
        let live = s.dbs.remove(&n.live).unwrap();
        let next = s.dbs.remove(&n.next).unwrap();
        let (rl, rn) = (s.rows.remove(&n.live).unwrap_or(0), s.rows.remove(&n.next).unwrap_or(0));
        s.dbs.insert(n.prev.clone(), live);
        s.dbs.insert(n.live.clone(), next);
        s.rows.insert(n.prev.clone(), rl);
        s.rows.insert(n.live.clone(), rn);
        Ok(())
    }
    fn swap_back(&mut self, n: &DbNames) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        if s.fail_swap_back { return Err(OpError::err("SWAP_BACK_FAILED", "injected")); }
        let live = s.dbs.remove(&n.live).unwrap();
        let prev = s.dbs.remove(&n.prev).unwrap();
        let (rl, rp) = (s.rows.remove(&n.live).unwrap_or(0), s.rows.remove(&n.prev).unwrap_or(0));
        s.dbs.insert(n.failed.clone(), live);
        s.dbs.insert(n.live.clone(), prev);
        s.rows.insert(n.failed.clone(), rl);
        s.rows.insert(n.live.clone(), rp);
        Ok(())
    }
    fn activate_pack(&mut self, v: &str) -> R<()> { let _d = tick(&self.0); self.0.borrow_mut().pack = level(v); Ok(()) }
    fn start_internal_stack(&mut self) -> R<()> { let _d = tick(&self.0); let mut s = self.0.borrow_mut(); s.roles_login = true; s.stack_up = true; Ok(()) }
    fn stop_internal_stack(&mut self) -> R<()> { let _d = tick(&self.0); self.0.borrow_mut().stack_up = false; Ok(()) }
    fn reopen_gateway(&mut self) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        s.order.push("reopen_gateway");
        if s.recovery_suspended { s.violations.push("gateway reopened while the recovery policy is still suspended (unfence not finished)".into()); }
        let before_ponr = s.journal.as_ref().map(|j| j.step < Step::Reopen).unwrap_or(true);
        if before_ponr { s.violations.push("gateway reopened before the point of no return".into()); }
        if s.dbs.get("postgres").copied() != Some(s.pack) { s.violations.push("gateway reopened on a database/pack level mismatch".into()); }
        s.gateway = Gw::Live;
        Ok(())
    }
    fn finish_unfence(&mut self) -> R<()> { let _d = tick(&self.0); let mut s = self.0.borrow_mut(); s.order.push("finish_unfence"); s.recovery_suspended = false; Ok(()) }
}

impl OpWork for FakeWork {
    fn kind(&self) -> OpKind { OpKind::Update }
    fn backup_reason(&self) -> BackupReason { BackupReason::PreUpdate }
    fn repair_source(&mut self, _c: &OpCtx) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        s.trace.push("repair_source");
        s.collation_mismatch = false;
        Ok(())
    }
    fn work_on_clone(&mut self, c: &OpCtx) -> R<()> {
        let _d = tick(&self.0);
        let mut s = self.0.borrow_mut();
        if s.fail_work { return Err(OpError::new(OpCode::MigrationFailed, "MIGRATION_FAILED", "injected")); }
        s.dbs.insert(c.names.next.clone(), "new");
        Ok(())
    }
    fn verify_clone(&mut self, _c: &OpCtx) -> R<()> { let _d = tick(&self.0); Ok(()) }
    fn verify_live(&mut self, _c: &OpCtx) -> R<()> {
        let _d = tick(&self.0);
        { let mut st = self.0.borrow_mut(); st.now += st.verify_live_takes_ms; }
        let s = self.0.borrow();
        if s.fail_verify_live { return Err(OpError::new(OpCode::VerifyFailedRolledBack, "VERIFY_FAILED", "injected")); }
        if s.dbs.get("postgres").copied() != Some(s.pack) { return Err(OpError::new(OpCode::VerifyFailedRolledBack, "LEVEL_MISMATCH", "database and pack differ")); }
        Ok(())
    }
    fn verify_after_rollback(&mut self, _c: &OpCtx) -> R<()> {
        let _d = tick(&self.0);
        let s = self.0.borrow();
        if s.dbs.get("postgres").copied() != Some(s.pack) { return Err(OpError::err("LEVEL_MISMATCH", "after rollback")); }
        Ok(())
    }
    fn on_commit(&mut self, _c: &OpCtx) -> R<()> { let _d = tick(&self.0); let mut s = self.0.borrow_mut(); s.order.push("on_commit"); s.pack_current = "new"; Ok(()) }
}
