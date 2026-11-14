//! The production `World`. Windows services through `fence::Scm`, Postgres through psql, the gateway through a
//! Caddyfile swap. Every mutating method is idempotent (recovery repeats any of them), and every error string is
//! scrubbed at the source because the runner copies World errors into the journal and the outcome.
use crate::ops::fence::*;
use crate::ops::journal::Journal;
use crate::ops::names::{valid_ident, DbNames, LIVE};
use crate::ops::outcome::OpError;
use crate::ops::probe::{http_get, tcp_open};
use crate::ops::proc::run_stderr_only;
use crate::ops::swap::{disk_gate, prune_plan, swap_back_done, swap_done, DiskVerdict, RealDb};
use crate::ops::world::{BackupReason, World, R};
use crate::paths::Roots;
use crate::runtime::Runtime;
use crate::services::Component;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Plan 05's one offset table (`gateway_lan()`, `gateway_internal()`, `mode_probe()` are the lan, internal and mode ports).
pub use crate::ports::Ports;

/// Auth, Rest and Functions each answer their own health probe on the loopback (plain HTTP, bounded).
pub fn stack_healthy_on(p: &Ports) -> bool {
    let t = Duration::from_secs(2);
    let ok = |port: u16, path: &str| http_get(&format!("127.0.0.1:{port}"), path, &[], t).map(|r| r.0 == 200).unwrap_or(false);
    ok(p.gotrue(), "/health") && ok(p.rest_admin(), "/ready") && ok(p.functions(), "/functions/v1/_health")
}

pub trait BackupRunner { fn run(&mut self, reason: BackupReason, timeout_ms: u64) -> R<()>; }

/// Re-points the services at a pack version, in process. Production: `conf_activator`.
pub type Activator = Box<dyn Fn(&Roots, &str) -> Result<(), String>>;

/// The one activation function of the update: `conf::activate(.., set_current)` in this process (the runner already holds
/// the exclusive update.lock; spawning `posctl pack activate` would retake it and exit 10 LOCK_HELD). The world's
/// `activate_pack` calls it with `set_current = false`, the update work's `on_commit` with `true`.
pub type ActivateFn = dyn Fn(&Roots, &str, bool) -> Result<(), String>;
pub fn conf_activate_fn(rt: std::rc::Rc<dyn Runtime>) -> std::rc::Rc<ActivateFn> {
    std::rc::Rc::new(move |roots, version, set_current| crate::conf::activate(roots, rt.as_ref(), version, set_current).map(|_| ()).map_err(|e| e.to_string()))
}
/// The world's view of that function (never moves the `pack.current` pointer).
pub fn activator_from(f: std::rc::Rc<ActivateFn>) -> Activator { Box::new(move |roots, version| f(roots, version, false)) }
/// The production activator.
pub fn conf_activator(rt: Box<dyn Runtime>) -> Activator { activator_from(conf_activate_fn(std::rc::Rc::from(rt))) }

pub struct RealCfg {
    pub roots: Roots,
    pub activate: Activator,
    /// Production: `fence::WindowsScm`.
    pub scm: Box<dyn Scm>,
    /// The TARGET pack's caddy.exe, used for `caddy adapt` before the point of no return.
    pub caddy_exe: PathBuf,
    pub ports: Ports,
    pub db: RealDb,
    /// Production: `fence::SERVICE_DB_ROLES`.
    pub fence_roles: Vec<String>,
    /// Free bytes of the volume holding a path. Production: `ops::swap::free_bytes`; a seam so a test can see the path asked.
    pub free_bytes: fn(&Path) -> R<u64>,
}

const MAX_MESSAGE: usize = 600;

/// Strips what must never reach a journal, an outcome or a log: known secrets, any JWT-shaped token, `://user:pw@`
/// userinfo and `password=...` assignments (including `PGPASSWORD=`); caps the length.
pub fn scrub(msg: &str, secrets: &[String]) -> String {
    let mut s = redact(msg, secrets);
    if s.len() > MAX_MESSAGE {
        let mut cut = MAX_MESSAGE;
        while !s.is_char_boundary(cut) { cut -= 1; }
        s.truncate(cut);
        s.push_str("...");
    }
    s
}

/// `scrub` without the length cap (for log files).
pub fn redact(msg: &str, secrets: &[String]) -> String {
    let mut s = msg.to_string();
    for sec in secrets.iter().filter(|x| !x.is_empty()) { s = s.replace(sec.as_str(), "***"); }
    // userinfo of a URL: everything between "://" and the last '@' of the authority
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            out.push_str("***");
            rest = &rest[at..];
        }
    }
    out.push_str(rest);
    // `password=value` (case-insensitive; ASCII lowercasing keeps byte offsets)
    let mut s = out;
    let mut from = 0;
    while let Some(i) = s.to_ascii_lowercase()[from..].find("password=") {
        let v = from + i + "password=".len();
        let end = s[v..].find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ';' | '&')).map(|e| v + e).unwrap_or(s.len());
        s.replace_range(v..end, "***");
        from = v + 3;
    }
    redact_jwts(&s)
}

/// `eyJ...` runs with at least two dots: a signed token is never worth keeping, known or not.
fn redact_jwts(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("eyJ") {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let len = tail.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))).unwrap_or(tail.len());
        if tail[..len].matches('.').count() >= 2 { out.push_str("***"); } else { out.push_str(&tail[..len]); }
        rest = &tail[len..];
    }
    out.push_str(rest);
    out
}

fn live_invalid_message() -> &'static str {
    "the live gateway config does not parse; Caddy's own output is in logs\\posctl\\ops\\caddy-adapt.err.log"
}

/// Every secret the machine holds: the pgpass passwords and everything under `secrets\` (JWT secret, anon and
/// service-role keys, the PIN pepper, the Postgres role passwords, optional Functions secrets). An unreadable file
/// is an error, never an empty list: error text that cannot be scrubbed must not be reported.
pub fn load_all_secrets(roots: &Roots, pgpass: &Path) -> R<Vec<String>> {
    let bad = |what: &str| OpError::err("SCRUB_SECRETS_UNREADABLE", format!("cannot read {what} to scrub error text"));
    let mut out: Vec<String> = std::fs::read_to_string(pgpass).map_err(|_| bad("the pgpass file"))?.lines()
        .filter_map(|l| { let p: Vec<&str> = l.splitn(5, ':').collect(); p.get(4).map(|x| x.trim().to_string()) })
        .filter(|p| !p.is_empty()).collect();
    let dir = roots.secrets();
    let s = crate::secrets::load(&dir).map_err(|_| bad("the secrets folder"))?;
    out.extend([s.jwt_secret.expose(), s.anon_key.expose(), s.service_role_key.expose(), s.pepper.expose()].map(String::from));
    out.extend(s.pg.values().map(|v| v.expose().to_string()));
    out.extend(crate::secrets::load_optional(&dir).map_err(|_| bad("the optional secrets"))?.iter().map(|(_, v)| v.expose().to_string()));
    Ok(out)
}

/// How long the world waits: for Postgres to answer after a start, for Auth/Rest/Functions to answer after their start, for the live
/// gateway to open the LAN port, and for `caddy adapt` to parse the live config.
pub const PG_WAIT_SECS: u64 = 120;
pub const STACK_HEALTH_WAIT_SECS: u64 = 90;
pub const GATEWAY_LIVE_WAIT_SECS: u64 = 40;
pub const CADDY_ADAPT_SECS: u64 = 30;
/// How long a fence waits for the maintenance responder to answer.
pub const FENCE_RESPONDER_WAIT_SECS: u64 = 30;

pub struct RealWorld { cfg: RealCfg, backup: Box<dyn BackupRunner>, caddy: CaddyFiles, pg_wait_secs: u64, warnings: Vec<String> }

impl RealWorld {
    pub fn new(cfg: RealCfg, backup: Box<dyn BackupRunner>) -> RealWorld {
        let caddy = CaddyFiles { conf: cfg.roots.conf() };
        RealWorld { cfg, backup, caddy, pg_wait_secs: PG_WAIT_SECS, warnings: vec![] }
    }
    fn addr(&self, port: u16) -> String { format!("127.0.0.1:{port}") }
    fn logs_ops(&self) -> PathBuf { self.cfg.roots.posctl_logs().join("ops") }

    /// Every secret the machine holds: the pgpass passwords and everything under `secrets\` (JWT secret, anon and
    /// service-role keys, the PIN pepper, the Postgres role passwords, optional Functions secrets). An unreadable file
    /// is an error, never an empty list: error text that cannot be scrubbed must not be reported.
    fn secrets(&self) -> R<Vec<String>> { load_all_secrets(&self.cfg.roots, &self.cfg.db.admin.pgpass) }
    fn g<T>(&self, r: R<T>) -> R<T> {
        r.map_err(|mut e| {
            e.message = match self.secrets() {
                Ok(sec) => scrub(&e.message, &sec),
                Err(w) => format!("details withheld: {}", w.message),
            };
            e
        })
    }
    fn wait_until(&self, what: &str, secs: u64, mut ok: impl FnMut() -> bool) -> R<()> {
        let t = std::time::Instant::now();
        while t.elapsed() < Duration::from_secs(secs) { if ok() { return Ok(()); } std::thread::sleep(Duration::from_millis(400)); }
        Err(OpError::err("WAIT_TIMEOUT", format!("{what} not ready after {secs} s")))
    }
    fn sidecar(&self) -> PathBuf { self.cfg.roots.fence_start_types() }
    /// The SCM half of the fence; applied again after anything that re-registers the services.
    fn scm_fence(&self) -> R<()> { scm_fence(self.cfg.scm.as_ref(), &self.sidecar()) }
    fn ensure_postgres(&self) -> R<()> {
        self.cfg.scm.start(Component::Postgres)?;
        self.wait_until("postgres", self.pg_wait_secs, || self.cfg.db.admin.scalar("template1", "SELECT 1").is_ok())
    }
    fn stack_healthy(&self) -> bool { stack_healthy_on(&self.cfg.ports) }
    fn gateway_mode_is_maintenance(&self) -> bool {
        http_get(&self.addr(self.cfg.ports.mode_probe()), "/_mode", &[], Duration::from_secs(2)).map(|r| r.1.trim() == "maintenance").unwrap_or(false)
    }
    fn lan_open(&self) -> bool { tcp_open(&self.addr(self.cfg.ports.gateway_lan()), Duration::from_secs(1)) }
    fn restart_gateway(&self) -> R<()> { self.cfg.scm.stop(Component::Gateway)?; self.cfg.scm.start(Component::Gateway) }
    fn stop_internal(&self) -> R<()> { for c in &STOP_ORDER[1..] { self.cfg.scm.stop(*c)?; } Ok(()) }

    /// The names are interpolated into SQL by `swap`; refuse here, as an error, what `swap` would panic on.
    fn check_names(n: &DbNames) -> R<()> {
        if [&n.live, &n.next, &n.prev, &n.failed].into_iter().all(|x| valid_ident(x)) { Ok(()) }
        else { Err(OpError::err("BAD_DB_NAME", "a database name for this operation is not a safe identifier")) }
    }
    fn list_names(&self) -> R<BTreeSet<String>> { self.g(self.cfg.db.names()) }

    fn fence_inner(&mut self) -> R<()> {
        // 1. the SCM half: recovery off (PostgREST exits 252 on stop; the SCM would restart what we stop), the gateway's
        //    dependencies cleared, Auth/Rest/Functions on demand. Persistent: the SCM registry.
        self.scm_fence()?;
        // 2. the maintenance responder replaces the live gateway config (persistent: conf\Caddyfile + Caddyfile.live);
        //    tills now get 503 STORE_UPDATING. A repeat that finds it already serving does not bounce the gateway.
        self.caddy.enter_maintenance()?;
        if !(self.gateway_mode_is_maintenance() && self.lan_open()) { self.restart_gateway()?; }
        self.wait_until("the maintenance responder", FENCE_RESPONDER_WAIT_SECS, || self.gateway_mode_is_maintenance() && self.lan_open())
            .map_err(|_| OpError::err("FENCE_FAILED", "the maintenance responder did not come up"))?;
        // 3. stop what talks to the database, then close the database door for the service roles (persistent: pg_authid)
        self.stop_internal()?;
        self.ensure_postgres()?;
        self.cfg.db.set_login(&self.cfg.fence_roles, false)
    }

    fn create_clone_inner(&mut self, n: &DbNames) -> R<()> {
        Self::check_names(n)?;
        let names = self.cfg.db.names()?;
        // a repeat after the swap (or its undoing) must not clone the new live database again
        if swap_done(&names, n) || swap_back_done(&names, n) { return Ok(()); }
        let db_bytes = self.cfg.db.size_bytes(&n.live)?;
        let plan = prune_plan(&names, self.now_ms());
        let mut droppable = 0u64;
        // an earlier half-built clone is rebuilt, so its space comes back too
        for d in plan.iter().chain(names.contains(&n.next).then_some(&n.next)) {
            droppable = droppable.saturating_add(self.cfg.db.size_bytes(d)?);
        }
        // the Postgres data directory's volume (not the exe's): that is where the clone, its WAL and the dump land
        let free = (self.cfg.free_bytes)(&self.cfg.roots.pgdata())?;
        if disk_gate(free, db_bytes, droppable)? == DiskVerdict::OkAfterDroppingOld {
            for d in &plan { self.cfg.db.drop_db(d)?; }
        }
        self.cfg.db.create_clone(n)
    }

    /// Proves the live config at least parses before the tills are let in. The adapted JSON on stdout carries the anon key
    /// and the service-role payload, so stdout is never kept; stderr (which quotes the offending line) is scrubbed on disk.
    fn adapt_live(&self) -> R<()> {
        let live = self.cfg.roots.conf().join("Caddyfile.live");
        let mut c = Command::new(&self.cfg.caddy_exe);
        c.args(["adapt", "--config", &live.display().to_string(), "--adapter", "caddyfile"]);
        let prefix = self.logs_ops().join("caddy-adapt");
        let _ = std::fs::remove_file(prefix.with_extension("out.log")); // left by an older build that kept stdout
        let r = run_stderr_only(c, &prefix, Duration::from_secs(CADDY_ADAPT_SECS))?;
        let err_log = prefix.with_extension("err.log");
        match (std::fs::read_to_string(&err_log), self.secrets()) {
            (Ok(text), Ok(sec)) => { let _ = std::fs::write(&err_log, redact(&text, &sec)); }
            _ => { let _ = std::fs::remove_file(&err_log); } // cannot scrub it: do not keep it
        }
        if r.code != Some(0) { return Err(OpError::err("LIVE_CADDYFILE_INVALID", live_invalid_message())); }
        Ok(())
    }

    fn reopen_inner(&mut self) -> R<()> {
        if self.caddy.fenced() {
            self.caddy.read_live()?; // torn (empty/zero-filled) is refused as TORN before caddy can call it invalid
            self.adapt_live()?; // a broken live config cannot be undone after this
            self.caddy.restore_live()?;
        } else if self.lan_open() && !self.gateway_mode_is_maintenance() {
            return self.cfg.scm.sc(&sc_gateway_depend(true)); // a repeat after success: do not bounce the live gateway
        }
        self.cfg.scm.stop(Component::Gateway)?;
        self.cfg.scm.sc(&sc_gateway_depend(true))?;
        self.cfg.scm.start(Component::Gateway)?;
        self.wait_until("the live gateway", GATEWAY_LIVE_WAIT_SECS, || self.lan_open() && !self.gateway_mode_is_maintenance())?;
        self.caddy.drop_marker()
    }
}

impl World for RealWorld {
    fn now_ms(&self) -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
    fn journal_write(&mut self, j: &Journal) -> R<()> {
        j.write(&self.cfg.roots.update_dir()).map_err(|e| OpError::err("JOURNAL_IO", e.to_string()))
    }
    fn journal_archive(&mut self, j: &Journal) -> R<()> {
        j.archive(&self.cfg.roots.update_dir(), &self.logs_ops()).map_err(|e| OpError::err("JOURNAL_IO", e.to_string()))
    }
    fn db_names(&mut self) -> R<BTreeSet<String>> {
        let r = self.ensure_postgres();
        self.g(r)?;
        self.list_names()
    }

    fn fence(&mut self) -> R<()> { let r = self.fence_inner(); self.g(r) }

    fn run_backup(&mut self, reason: BackupReason, timeout_ms: u64) -> R<()> { let r = self.backup.run(reason, timeout_ms); self.g(r) }

    fn create_clone(&mut self, n: &DbNames) -> R<()> { let r = self.create_clone_inner(n); self.g(r) }
    fn drop_db(&mut self, name: &str) -> R<()> {
        // DROP ... IF EXISTS is already idempotent; the live database is never a valid target
        let r = if name == LIVE || !valid_ident(name) {
            Err(OpError::err("DROP_REFUSED", "refusing to drop the live database or an unsafe name"))
        } else { self.cfg.db.drop_db(name) };
        self.g(r)
    }
    fn swap(&mut self, n: &DbNames) -> R<()> { let r = Self::check_names(n).and_then(|_| self.cfg.db.swap(n)); self.g(r) }
    fn swap_back(&mut self, n: &DbNames) -> R<()> { let r = Self::check_names(n).and_then(|_| self.cfg.db.swap_back(n)); self.g(r) }

    fn activate_pack(&mut self, version: &str) -> R<()> {
        let first = (|| {
            self.stop_internal()?;
            self.cfg.scm.stop(Component::Postgres)?;
            (self.cfg.activate)(&self.cfg.roots, version).map_err(|e| OpError::err("ACTIVATE_FAILED", format!("activate {version}: {e}")))?;
            self.ensure_postgres()
        })();
        // `conf::activate` re-registers every service (start=auto, restart actions, failureflag 1, gateway dependencies), even when it
        // then fails, and a Postgres that does not come back leaves the same mess: put the SCM fence back ALWAYS. The start types
        // recorded before the first fence are kept. The first error is the one reported.
        let fence = self.scm_fence();
        self.g(first.and(fence))
    }

    fn start_internal_stack(&mut self) -> R<()> {
        let r = (|| {
            self.ensure_postgres()?;
            self.cfg.db.set_login(&self.cfg.fence_roles, true)?;
            for c in START_ORDER { self.cfg.scm.start(c)?; }
            self.wait_until("Auth, Rest and Functions", STACK_HEALTH_WAIT_SECS, || self.stack_healthy())
        })();
        self.g(r)
    }
    fn stop_internal_stack(&mut self) -> R<()> { let r = self.stop_internal(); self.g(r) }

    fn reopen_gateway(&mut self) -> R<()> { let r = self.reopen_inner(); self.g(r) }

    fn finish_unfence(&mut self) -> R<()> {
        let r = scm_unfence(self.cfg.scm.as_ref(), &self.sidecar()).map(|w| { if let Some(w) = w { self.warnings.push(w.to_string()); } });
        self.g(r)
    }
    fn warnings(&self) -> Vec<String> { self.warnings.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::names::DbNames;
    use crate::ops::outcome::{OpCode, OpKind};
    use crate::ops::fence::fake_scm::FakeScm;
    use crate::ops::swap::PsqlAdmin;
    use std::cell::RefCell;
    use std::rc::Rc;

    const PW: &str = "PLACEHOLDER-PASSWORD-XYZ";

    type Asked = Rc<RefCell<Vec<PathBuf>>>;
    struct NoBackup;
    impl BackupRunner for NoBackup { fn run(&mut self, _: BackupReason, _: u64) -> R<()> { Ok(()) } }

    struct Rig { _t: tempfile::TempDir, d: PathBuf, w: RealWorld, asked: Asked, scm: FakeScm, activated: Rc<RefCell<Vec<String>>> }
    impl Rig {
        fn calls(&self) -> usize { std::fs::read_to_string(self.d.join("calls.log")).map(|s| s.lines().count()).unwrap_or(0) }
        fn roots(&self) -> crate::paths::Roots { crate::paths::Roots::custom(self.d.join("data"), self.d.join("prog")) }
    }

    /// A fake `psql`: a batch file that logs each call, prints `out` on stdout and `err` on stderr, exits `code`.
    /// (No quoted SQL reaches it in these tests: a batch file cannot take double-quoted arguments.)
    fn rig(out: &str, err: &str, code: i32, free: u64) -> Rig {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("out.txt"), out).unwrap();
        std::fs::write(d.path().join("err.txt"), err).unwrap();
        let psql = d.path().join("psql.cmd");
        std::fs::write(&psql, format!("@echo off\r\necho x>>\"%~dp0calls.log\"\r\ntype \"%~dp0out.txt\"\r\ntype \"%~dp0err.txt\" 1>&2\r\nexit /b {code}\r\n")).unwrap();
        let pgpass = d.path().join("pgpass.conf");
        std::fs::write(&pgpass, format!("127.0.0.1:47300:*:supabase_admin:{PW}\n")).unwrap();
        let asked = Rc::new(RefCell::new(vec![]));
        let a2 = asked.clone();
        thread_local! { static FREE: RefCell<Option<(u64, Asked)>> = const { RefCell::new(None) }; }
        FREE.with(|f| *f.borrow_mut() = Some((free, a2)));
        fn fake_free(p: &Path) -> R<u64> {
            FREE.with(|f| { let b = f.borrow(); let (n, a) = b.as_ref().unwrap(); a.borrow_mut().push(p.to_path_buf()); Ok(*n) })
        }
        let roots = crate::paths::Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.secrets()).unwrap();
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        crate::secrets::ensure(&roots.secrets(), false).unwrap();
        let scm = FakeScm::registered();
        let activated = Rc::new(RefCell::new(vec![]));
        let (a3, s3) = (activated.clone(), scm.clone());
        let cfg = RealCfg {
            roots, scm: Box::new(scm.clone()), caddy_exe: d.path().join("caddy.cmd"),
            activate: Box::new(move |_, v| { a3.borrow_mut().push(v.to_string()); s3.re_register(); Ok(()) }),
            ports: Ports::new(47300).unwrap(), db: RealDb { admin: PsqlAdmin::new(psql, 47300, pgpass) },
            fence_roles: SERVICE_DB_ROLES.iter().map(|r| r.to_string()).collect(), free_bytes: fake_free,
        };
        Rig { w: RealWorld::new(cfg, Box::new(NoBackup)), d: d.path().to_path_buf(), _t: d, asked, scm, activated }
    }

    fn names() -> DbNames { DbNames::for_kind(OpKind::Update, 1_790_908_215_000) }

    #[test]
    fn ports_are_plan_05s_one_offset_table() {
        let p = Ports::new(47300).unwrap();
        assert_eq!((p.gateway_lan(), p.gateway_internal(), p.mode_probe(), p.rest_admin()), (47304, 47305, 47308, 47306));
    }

    #[test]
    fn scrub_removes_connection_strings_password_assignments_and_known_secrets() {
        let s = scrub("could not connect to postgresql://supabase_admin:hunter2@127.0.0.1:47300/postgres; PGPASSWORD=abc123 password=s3cret next, and TOPSECRET here", &["TOPSECRET".into()]);
        for leak in ["hunter2", "abc123", "s3cret", "TOPSECRET"] { assert!(!s.contains(leak), "{leak} leaked in {s}"); }
        assert!(s.contains("127.0.0.1:47300"), "the rest of the message is kept: {s}");
    }

    #[test]
    fn scrub_caps_a_runaway_message() { assert!(scrub(&"x".repeat(5000), &[]).len() < 1000); }

    #[test]
    fn an_error_from_the_database_tool_never_carries_the_password() {
        let mut r = rig("", &format!("FATAL: password authentication failed; postgresql://supabase_admin:{PW}@127.0.0.1/x PGPASSWORD={PW}"), 1, u64::MAX);
        let e = r.w.create_clone(&names()).unwrap_err();
        let all = format!("{} {} {}", e.reason, e.message, e);
        assert!(!all.contains(PW), "password leaked: {all}");
        assert!(all.contains("authentication failed"), "the useful part survives: {all}");
        let e = r.w.list_names().unwrap_err();
        assert!(!format!("{e}").contains(PW));
    }

    #[test]
    fn the_disk_gate_measures_the_postgres_data_volume_and_refuses_before_touching_anything() {
        let mut r = rig("1000", "", 0, 5_000); // db = 1000 bytes, 5000 free: short of 3x + the floor
        let e = r.w.create_clone(&names()).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (OpCode::Precondition, "DISK_SHORT"));
        assert_eq!(*r.asked.borrow(), vec![r.roots().pgdata()], "the data directory's volume, not the exe's");
        assert_eq!(r.calls(), 2, "only the names and size queries ran: no drop, no clone");
    }

    #[test]
    fn a_clone_whose_swap_already_happened_or_was_undone_is_not_built_again() {
        let n = names();
        for listing in [format!("postgres\r\n{}\r\n", n.prev), format!("postgres\r\n{}\r\n", n.failed)] {
            let mut r = rig(&listing, "", 0, 0);
            r.w.create_clone(&n).unwrap();
            assert_eq!(r.calls(), 1, "only the names query ran");
        }
    }

    #[test]
    fn swap_and_swap_back_are_no_ops_when_already_done() {
        let n = names();
        let mut r = rig(&format!("postgres\r\n{}\r\n", n.prev), "", 0, 0);
        r.w.swap(&n).unwrap(); r.w.swap(&n).unwrap();
        assert_eq!(r.calls(), 2, "one names query per call and no SQL");
        let mut r = rig(&format!("postgres\r\n{}\r\n", n.failed), "", 0, 0);
        r.w.swap_back(&n).unwrap(); r.w.swap_back(&n).unwrap();
        assert_eq!(r.calls(), 2);
    }

    #[test]
    fn the_live_database_can_never_be_dropped_and_a_bad_name_is_refused_without_a_panic() {
        let mut r = rig("", "", 0, 0);
        assert_eq!(r.w.drop_db("postgres").unwrap_err().reason, "DROP_REFUSED");
        assert_eq!(r.w.drop_db("x\"; DROP DATABASE postgres; --").unwrap_err().reason, "DROP_REFUSED");
        assert_eq!(r.calls(), 0);
    }

    #[test]
    fn the_caddy_adapt_failure_does_not_echo_caddy_output() {
        assert!(!live_invalid_message().contains("Caddyfile:"), "Caddy's own text can quote a header value");
    }

    // ---- FR4 ----
    fn keys(r: &Rig) -> crate::secrets::Secrets { crate::secrets::load(&r.roots().secrets()).unwrap() }

    #[test]
    fn the_scm_fence_survives_the_activation_that_re_registers_every_service() {
        use crate::services::Component as C;
        let mut r = rig("", "", 0, u64::MAX);
        r.scm.set_type(C::Rest, crate::ops::fence::StartType::Demand);
        scm_fence(&r.scm, &r.w.sidecar()).unwrap();
        assert!(r.scm.is_fenced());
        r.w.activate_pack("2.0.0").unwrap();
        assert_eq!(*r.activated.borrow(), ["2.0.0"]);
        assert!(r.scm.is_fenced(), "activate re-registered the services; the fence must be back: {:?}", r.scm.0.borrow());
        // rollback re-activates the old pack through the same method
        r.w.activate_pack("1.0.0").unwrap();
        assert!(r.scm.is_fenced());
        r.w.finish_unfence().unwrap();
        assert!(r.scm.policy_restored());
        assert_eq!(r.scm.type_of(C::Rest), Some(crate::ops::fence::StartType::Demand), "the recorded type, not a blind auto");
    }

    #[test]
    fn the_set_current_activation_after_the_reopen_is_undone_by_the_unfence_to_the_recorded_types() {
        use crate::services::Component as C;
        let mut r = rig("", "", 0, u64::MAX);
        r.scm.set_type(C::Auth, crate::ops::fence::StartType::Demand);
        scm_fence(&r.scm, &r.w.sidecar()).unwrap();
        r.scm.re_register(); // UpdateWork::on_commit -> conf::activate(.., set_current = true)
        r.w.finish_unfence().unwrap();
        assert_eq!(r.scm.type_of(C::Auth), Some(crate::ops::fence::StartType::Demand));
        assert_eq!(r.scm.type_of(C::Rest), Some(crate::ops::fence::StartType::Auto));
        assert!(r.scm.policy_restored());
    }

    #[test]
    fn the_production_fence_roles_are_what_the_stack_logs_in_as() {
        let r = rig("", "", 0, 0);
        assert_eq!(r.w.cfg.fence_roles, ["authenticator", "supabase_auth_admin"]);
    }

    #[test]
    fn scrub_removes_any_jwt_shaped_token_and_keeps_ordinary_dotted_text() {
        let s = scrub("bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln failed at 127.0.0.1.x", &[]);
        assert!(!s.contains("eyJ") && s.contains("127.0.0.1.x"), "{s}");
    }

    #[test]
    fn the_stack_keys_and_the_pepper_never_reach_an_error() {
        let mut r = rig("", "", 1, u64::MAX);
        let k = keys(&r);
        let (anon, svc, pepper) = (k.anon_key.expose().to_string(), k.service_role_key.expose().to_string(), k.pepper.expose().to_string());
        std::fs::write(r.d.join("err.txt"), format!("FATAL: anon {anon} service {svc} pepper {pepper} jwt {}", k.jwt_secret.expose())).unwrap();
        let e = r.w.create_clone(&names()).unwrap_err();
        let all = format!("{} {}", e.reason, e.message);
        for leak in [&anon, &svc, &pepper, &k.jwt_secret.expose().to_string()] { assert!(!all.contains(leak.as_str()), "leaked {leak} in {all}"); }
        assert!(all.contains("FATAL"), "{all}");
    }

    #[test]
    fn an_unreadable_pgpass_is_an_error_and_the_text_it_could_not_scrub_is_withheld() {
        let mut r = rig("", &format!("FATAL: {PW}"), 1, u64::MAX);
        std::fs::remove_file(r.d.join("pgpass.conf")).unwrap();
        assert_eq!(r.w.secrets().unwrap_err().reason, "SCRUB_SECRETS_UNREADABLE");
        let e = r.w.create_clone(&names()).unwrap_err();
        assert!(!e.message.contains(PW) && e.message.contains("details withheld"), "{}", e.message);
    }

    #[test]
    fn caddy_adapt_output_never_lands_on_disk_unscrubbed() {
        let r = rig("", "", 0, 0);
        let anon = keys(&r).anon_key.expose().to_string();
        std::fs::write(r.d.join("caddy.cmd"), format!("@echo off\r\necho {{\"anon\":\"{anon}\"}}\r\necho bad line {anon} 1>&2\r\nexit /b 1\r\n")).unwrap();
        let prefix = r.roots().posctl_logs().join("ops").join("caddy-adapt");
        std::fs::create_dir_all(prefix.parent().unwrap()).unwrap();
        std::fs::write(prefix.with_extension("out.log"), &anon).unwrap(); // left by an older build
        let e = r.w.adapt_live().unwrap_err();
        assert_eq!(e.reason, "LIVE_CADDYFILE_INVALID");
        assert!(!prefix.with_extension("out.log").exists(), "stdout (the adapted config) is not kept");
        let err_log = std::fs::read_to_string(prefix.with_extension("err.log")).unwrap_or_default();
        assert!(!err_log.contains(&anon) && err_log.contains("bad line"), "{err_log}");
    }

    fn fenced_with_live(r: &Rig, bytes: &[u8], adapt_exit: i32) {
        let conf = r.roots().conf();
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("Caddyfile.live"), bytes).unwrap();
        std::fs::write(r.d.join("caddy.cmd"), format!("@echo off\r\nexit /b {adapt_exit}\r\n")).unwrap();
    }

    #[test]
    fn a_torn_live_caddyfile_is_reported_torn_not_invalid_on_reopen() {
        for torn in [&b""[..], &[0u8; 16][..]] {
            let mut r = rig("", "", 0, 0);
            fenced_with_live(&r, torn, 1); // caddy would reject it: the torn check must come first
            let e = r.w.reopen_inner().unwrap_err();
            assert_eq!(e.reason, "LIVE_CADDYFILE_TORN", "{torn:?}: {e:?}");
            assert_eq!(e.code, OpCode::RecoveryNeeded);
        }
    }

    #[test]
    fn a_non_empty_invalid_live_caddyfile_is_still_invalid_on_reopen() {
        let mut r = rig("", "", 0, 0);
        fenced_with_live(&r, b"not a caddyfile {", 1);
        assert_eq!(r.w.reopen_inner().unwrap_err().reason, "LIVE_CADDYFILE_INVALID");
    }

    #[test]
    fn activate_failure_still_refences() {
        use crate::services::Component as C;
        let mut r = rig("", "", 0, u64::MAX);
        r.scm.set_type(C::Rest, crate::ops::fence::StartType::Demand);
        scm_fence(&r.scm, &r.w.sidecar()).unwrap();
        // conf::activate re-registers every service and THEN fails
        let scm = r.scm.clone();
        r.w.cfg.activate = Box::new(move |_, _| { scm.re_register(); Err("boom".into()) });
        let e = r.w.activate_pack("2.0.0").unwrap_err();
        assert_eq!(e.reason, "ACTIVATE_FAILED", "the first error is the one reported: {e:?}");
        assert!(r.scm.is_fenced(), "a failed activation must not leave the services on automatic start: {:?}", r.scm.0.borrow());
    }

    #[test]
    fn a_postgres_that_does_not_come_back_still_refences() {
        use crate::services::Component as C;
        let mut r = rig("", "", 1, u64::MAX); // every psql call fails
        r.w.pg_wait_secs = 1;
        scm_fence(&r.scm, &r.w.sidecar()).unwrap();
        let e = r.w.activate_pack("2.0.0").unwrap_err();
        assert_eq!(e.reason, "WAIT_TIMEOUT", "{e:?}");
        assert!(r.scm.is_fenced(), "{:?}", r.scm.0.borrow());
        assert!(crate::ops::fence::DEMAND_WHILE_FENCED.iter().all(|c| r.scm.type_of(*c) == Some(crate::ops::fence::StartType::Demand)));
        let _ = C::Auth;
    }
}
