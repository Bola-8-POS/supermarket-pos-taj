//! The real `Machine` of a switch: pg_dump / pg_restore with a verified table of contents, the staff password re-derive, the clone
//! verification, and the live check (canary, a real admin sign-in, the photo child process). It is proven end to end by the real
//! database tests (Task 12) and the Windows Sandbox scenarios (Task 13); the order and rollback rules are tested in `work.rs`.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::swap::{PsqlAdmin, StmtClass};
use crate::ops::world::{OpCtx, R};
use crate::switch::cloud::{libpq_env, CloudDb};
use crate::switch::facts::SQL_DEFAULT_REPLICA;
use crate::switch::load::{
    dump_args, list_args, pg_cmd, repair_tokens_sql, restore_args, verify_restore_list,
};
use crate::switch::prompt::AdminProof;
use crate::switch::rederive::{self, RederiveReport};
use crate::switch::tables::{truncate_list, truncate_sql};
use crate::switch::verify::{self, Finding};
use crate::switch::work::{Machine, SwitchInputs};
use crate::update::Env;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const DUMP_TIMEOUT: Duration = Duration::from_secs(3 * 3600);
const RESTORE_TIMEOUT: Duration = Duration::from_secs(3 * 3600);

pub struct RealMachine {
    env: Env,
    pack_dir: std::path::PathBuf,
    cloud: CloudDb,
    admin: PsqlAdmin,
    /// The directory of the cloud `pgpass` file (the staging folder).
    cloud_pgpass: std::path::PathBuf,
    /// The admin and the typed PIN and pepper of the pre-fence proof (11H, Q1): the real sign-in after the swap uses them. Dropped
    /// (and zeroed) with the machine.
    proof: Option<Arc<AdminProof>>,
    #[cfg(test)]
    pub canary_fn: Option<Box<dyn Fn() -> R<()>>>,
    /// Test seam: the admin sign-in needs a running Auth, which a unit test does not have (cfg(test) only).
    #[cfg(test)]
    pub sign_in_fn: Option<Box<dyn Fn() -> R<()>>>,
}

/// A child may run for its own limit but never past the operation's deadline (`ctx.deadline_ms` minus now), so the maintenance budget is a
/// real cap on the data move and a hung `pg_dump`, `pg_restore` or importer is killed in time and the switch rolls back (cloud released).
/// With nothing left the child is not started at all.
pub(crate) fn capped(own: Duration, deadline_ms: u64, now_ms: u64) -> R<Duration> {
    let left = deadline_ms.saturating_sub(now_ms);
    if left == 0 {
        return Err(OpError::new(
            OpCode::RolledBack,
            "MAINTENANCE_BUDGET",
            "the maintenance budget was used up before the data move finished",
        ));
    }
    Ok(own.min(Duration::from_millis(left)))
}

fn now_wall_ms() -> u64 {
    crate::util::now_unix() * 1000
}

/// Run one read only if the budget is not gone: nothing starts once the deadline has passed. This is a check BEFORE each read, not a cap
/// on it: a read that is already running is bounded by its own limit (the local psql by the remaining-budget statement cap and its kill
/// margin, a cloud read by the fixed 600 s server-side statement timeout).
pub(crate) fn within_budget<T>(deadline_ms: u64, now_ms: u64, read: impl FnOnce() -> R<T>) -> R<T> {
    capped(Duration::from_secs(1), deadline_ms, now_ms)?;
    read()
}

fn fail(reason: &str, what: &str) -> OpError {
    OpError::err(reason, what.to_string())
}

impl RealMachine {
    pub fn new(
        env: Env,
        pack_dir: std::path::PathBuf,
        cloud: CloudDb,
        admin: PsqlAdmin,
    ) -> RealMachine {
        let cloud_pgpass = cloud.pgpass.clone();
        RealMachine {
            env,
            pack_dir,
            cloud,
            admin,
            cloud_pgpass,
            proof: None,
            #[cfg(test)]
            canary_fn: None,
            #[cfg(test)]
            sign_in_fn: None,
        }
    }

    pub fn with_proof(mut self, proof: Arc<AdminProof>) -> RealMachine {
        self.proof = Some(proof);
        self
    }

    fn pg_exe(&self, name: &str) -> std::path::PathBuf {
        crate::pg::PgTools::for_pack(&self.pack_dir).exe(name)
    }

    fn keys(&self) -> R<(String, String)> {
        let t = crate::util::read_secret_file(&self.env.secrets().join("keys.json"))
            .map_err(|_| fail("KEYS_UNREADABLE", "keys.json is unreadable"))?;
        let v: Value = serde_json::from_str(t.expose())
            .map_err(|_| fail("KEYS_UNREADABLE", "keys.json is invalid"))?;
        let get = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| fail("KEYS_UNREADABLE", "keys.json is incomplete"))
        };
        Ok((get("anon")?, get("service_role")?))
    }

    fn canary(&self) -> R<()> {
        #[cfg(test)]
        if let Some(f) = &self.canary_fn {
            return f();
        }
        let (anon, svc) = self.keys()?;
        let psql = crate::pg::Psql {
            tools: crate::pg::PgTools::for_pack(&self.pack_dir),
            port: self.env.ports.pg(),
            pgpass: self.env.roots.pgpass(),
        };
        let ep = crate::firstadmin::Endpoint {
            internal_url: format!("http://127.0.0.1:{}", self.env.ports.gateway_internal()),
            anon_key: crate::util::Secret(anon),
            service_key: crate::util::Secret(svc),
        };
        // in process: a `health --canary` child would find the journal open and the lock held
        crate::canary::run_for_update(
            &self.env.roots,
            &self.env.ports,
            &psql,
            &ep,
            Duration::from_secs(120),
        )
        .map_err(|e| OpError::err("CANARY_FAILED", e.message))
    }

    /// A REAL sign-in of the copied admin through Auth on the internal listener (the same proof as a restore), then a logout. The
    /// password is derived from the PIN and pepper the person typed before the fence; nothing is read from the database.
    fn admin_sign_in(&self) -> R<()> {
        #[cfg(test)]
        if let Some(f) = &self.sign_in_fn {
            return f();
        }
        let (anon, _) = self.keys()?;
        let proof = self.proof.as_ref().ok_or_else(|| {
            OpError::new(OpCode::Precondition, "PIN_PROMPT_REQUIRED", "the administrator proof was not given".to_string())
        })?;
        let mut pw = rederive::admin_password(proof)?;
        crate::switch::prompt::register(&pw);
        let id = &proof.admin_id;
        let internal = format!("127.0.0.1:{}", self.env.ports.gateway_internal());
        let t = Duration::from_secs(10);
        let mut payload =
            json!({ "email": crate::firstadmin::staff_email(id), "password": pw }).to_string();
        let sent = crate::backup::restore_work::http_post_json(
            &internal,
            "/auth/v1/token?grant_type=password",
            &[("apikey", &anon)],
            &payload,
            t,
        );
        crate::switch::prompt::zero_string(&mut payload);
        crate::switch::prompt::zero_string(&mut pw);
        let (s, body) = sent?;
        if s != 200 || !body.contains("access_token") {
            return Err(OpError::err(
                "ADMIN_SIGN_IN_FAILED",
                format!("the admin could not sign in to the new store (status {s})"),
            ));
        }
        let token = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["access_token"].as_str().map(String::from))
            .unwrap_or_default();
        let bearer = format!("Bearer {token}");
        // best effort: do not leave the probe's session behind
        let _ = crate::backup::restore_work::http_post_json(
            &internal,
            "/auth/v1/logout",
            &[("apikey", &anon), ("Authorization", &bearer)],
            "{}",
            t,
        );
        Ok(())
    }
}

fn run_pg(
    exe: &Path,
    args: Vec<String>,
    env: &[(String, String)],
    limit: Duration,
    reason: &str,
) -> R<String> {
    let out = pg_cmd(exe, args, env)
        .timeout(limit)
        .run()
        .map_err(|_| fail(reason, "the tool could not run"))?;
    if out.code != 0 {
        // the tool's output is not passed on: it can name a table or quote a value
        return Err(OpError::err(reason, format!("exited with {}", out.code)));
    }
    Ok(out.stdout)
}

impl Machine for RealMachine {
    fn default_replica(&mut self) -> R<String> {
        self.cloud.ro(SQL_DEFAULT_REPLICA)
    }

    fn unguarded_tables(&mut self) -> R<String> {
        self.cloud.ro(crate::switch::facts::SQL_UNGUARDED)
    }

    fn copy(&mut self, ctx: &OpCtx, inp: &SwitchInputs, dump_dir: &Path) -> R<()> {
        let file = dump_dir.join("cloud.dump");
        let file_s = file.display().to_string();
        let cloud_env = libpq_env(&inp.source.pg, &self.cloud_pgpass);
        run_pg(
            &self.pg_exe("pg_dump"),
            dump_args(&file_s, &inp.copy_tables)?,
            &cloud_env,
            capped(DUMP_TIMEOUT, ctx.deadline_ms, now_wall_ms())?,
            "DUMP_FAILED",
        )?;
        // what the file holds must be exactly the planned tables, before anything local is emptied
        let listing = run_pg(
            &self.pg_exe("pg_restore"),
            list_args(&file_s),
            &[],
            capped(Duration::from_secs(300), ctx.deadline_ms, now_wall_ms())?,
            "DUMP_LIST_FAILED",
        )?;
        verify_restore_list(&listing, &inp.copy_tables)
            .map_err(|m| OpError::err("DUMP_CONTENT_UNEXPECTED", m))?;
        let db = &ctx.names.next;
        let list = truncate_list(&inp.copy_tables, &inp.truncate_extra)?;
        self.admin
            .exec_class(db, &truncate_sql(&list), StmtClass::Heavy)?;
        let local_env = [(
            "PGPASSFILE".to_string(),
            self.env.roots.pgpass().display().to_string(),
        )];
        run_pg(
            &self.pg_exe("pg_restore"),
            restore_args(&file_s, self.env.ports.pg(), db)?,
            &local_env,
            capped(RESTORE_TIMEOUT, ctx.deadline_ms, now_wall_ms())?,
            "RESTORE_FAILED",
        )?;
        self.admin
            .exec_class(db, &repair_tokens_sql(), StmtClass::Heavy)?;
        // the dump is plaintext customer data: gone as soon as it is loaded
        let _ = std::fs::remove_file(&file);
        Ok(())
    }

    fn rederive(&mut self, ctx: &OpCtx, keep: &[String]) -> R<RederiveReport> {
        // nothing starts once the budget is gone (the statements below carry their own caps)
        capped(Duration::from_secs(1), ctx.deadline_ms, now_wall_ms())?;
        // 11H: the staff Auth rows came with the data and stay as they are (the cloud pepper is installed after the swap); only the
        // accounts that belong to no staff profile are scrambled. The admin proof was made before the fence.
        rederive::apply(&self.admin, &ctx.names.next, keep)
    }

    fn verify_clone(&mut self, ctx: &OpCtx, copy: &[String]) -> R<Vec<Finding>> {
        let db = ctx.names.next.clone();
        let admin = self.admin.clone();
        let cloud = self.cloud.clone();
        // the deadline is checked before EVERY read of both sides (the per-table loop runs many), not once
        let deadline = ctx.deadline_ms;
        let src = move |sql: &str| within_budget(deadline, now_wall_ms(), || cloud.ro(sql));
        let dst = move |sql: &str| within_budget(deadline, now_wall_ms(), || admin.scalar_class(&db, sql, StmtClass::Heavy));
        verify::verify_clone(&src, &dst, copy)
    }

    fn verify_live(&mut self, ctx: &OpCtx, inp: &SwitchInputs) -> R<()> {
        self.canary()?;
        self.admin_sign_in()?;
        if let Some(storage) = &inp.source.storage {
            let deadline = ctx.deadline_ms;
            crate::switch::photos::run_import_within(
                &self.env.posctl_exe,
                &self.env.data,
                &self.env.program,
                inp.dev,
                storage,
                &[],
                &move |own| capped(own, deadline, now_wall_ms()),
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_limit_is_its_own_or_what_is_left_of_the_budget_whichever_is_shorter() {
        let own = Duration::from_secs(3 * 3600);
        // 2 h 5 min left: the 3 h own limit shrinks to what is left
        assert_eq!(capped(own, 10_000_000, 2_500_000).unwrap(), Duration::from_millis(7_500_000));
        // plenty left: the child keeps its own limit
        assert_eq!(capped(Duration::from_secs(300), 10_000_000, 2_500_000).unwrap(), Duration::from_secs(300));
        // nothing left (equal or past): no child at all, and it is a rollback reason, not a hang
        for now in [10_000_000, 10_000_001] {
            let e = capped(own, 10_000_000, now).unwrap_err();
            assert_eq!((e.code, e.reason.as_str()), (OpCode::RolledBack, "MAINTENANCE_BUDGET"));
        }
    }

    #[test]
    fn a_read_starts_only_while_the_budget_lasts() {
        let mut ran = 0;
        assert_eq!(within_budget(10_000, 9_999, || { ran += 1; Ok(7) }).unwrap(), 7);
        for now in [10_000, 10_001] {
            let e = within_budget(10_000, now, || { ran += 1; Ok(7) }).unwrap_err();
            assert!(e.code == OpCode::RolledBack && e.reason == "MAINTENANCE_BUDGET", "{e:?}");
        }
        assert_eq!(ran, 1, "the two late reads never ran");
    }

    use crate::switch::source::{PgTarget, Secret};

    #[test]
    fn verify_clone_reads_nothing_from_the_cloud_once_the_deadline_has_passed() {
        use crate::ops::{names::DbNames, outcome::OpKind};
        use std::sync::atomic::{AtomicU32, Ordering};
        let d = tempfile::tempdir().unwrap();
        let mut m = machine(d.path());
        let calls = std::sync::Arc::new(AtomicU32::new(0));
        let c2 = calls.clone();
        type CountingHook = std::sync::Arc<dyn Fn(&str) -> Result<String, crate::switch::cloud::RunFail> + Send + Sync>;
        let hook: CountingHook =
            std::sync::Arc::new(move |_: &str| {
                c2.fetch_add(1, Ordering::SeqCst);
                Ok(String::new())
            });
        m.cloud = m.cloud.clone().with_hook(hook);
        let ctx = OpCtx {
            op_id: "op".into(),
            names: DbNames::for_kind(OpKind::Switch, 1_790_908_215_000),
            pack_from: None,
            pack_to: None,
            deadline_ms: 1,
        };
        let e = m.verify_clone(&ctx, &["public.categories".to_string()]).unwrap_err();
        assert_eq!(e.reason, "MAINTENANCE_BUDGET", "{e:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no cloud read after the deadline");
    }

    fn machine(d: &Path) -> RealMachine {
        let roots = crate::paths::Roots::custom(d.join("data"), d.join("prog"));
        let env = Env {
            data: d.join("data"),
            program: d.join("prog"),
            posctl_exe: d.join("posctl.exe"),
            ports: crate::ports::Ports::new(47300).unwrap(),
            roots,
            activate: std::rc::Rc::new(|_, _, _| Ok(())),
        };
        let pg = PgTarget {
            host: "db.abc.supabase.co".into(),
            port: 5432,
            user: "postgres".into(),
            password: Secret::new("pw"),
            dbname: "postgres".into(),
            sslmode: "require".into(),
            sslrootcert: None,
        };
        let cloud = CloudDb::new("psql.exe".into(), pg, d.join("pgpass"));
        RealMachine::new(
            env,
            d.join("pack"),
            cloud,
            PsqlAdmin::new("psql.exe".into(), 47300, d.join("pgpass")),
        )
    }

    #[cfg(windows)]
    #[test]
    fn keys_reads_the_dpapi_wrapped_keys_json_that_secrets_ensure_writes() {
        let d = tempfile::tempdir().unwrap();
        let m = machine(d.path());
        std::fs::create_dir_all(m.env.secrets()).unwrap();
        crate::secrets::ensure(&m.env.secrets(), false).unwrap();
        let want = crate::secrets::load(&m.env.secrets()).unwrap();
        let (anon, svc) = m.keys().unwrap();
        assert_eq!((anon.as_str(), svc.as_str()), (want.anon_key.expose(), want.service_role_key.expose()));
    }

    #[test]
    fn the_canary_runs_in_process_never_as_a_child() {
        let d = tempfile::tempdir().unwrap();
        let mut m = machine(d.path());
        m.canary_fn = Some(Box::new(|| Err(OpError::err("CANARY_FAILED", "stand-in"))));
        assert_eq!(
            m.canary().unwrap_err().reason,
            "CANARY_FAILED",
            "the canary runs through the in-process function"
        );
        // never a `health --canary` child: it would find the journal open and the lock held
        let src = include_str!("machine.rs");
        let spawned = format!("\"{}\"", "--canary");
        assert!(!src[..src.find("#[cfg(test)]\nmod tests").unwrap()].contains(&spawned));
        assert!(src.contains("canary::run_for_update"));
    }

    /// A stand-in `posctl` (Plan 10's photo importer is a child process) drives the REAL `RealMachine::verify_live`.
    #[cfg(windows)]
    fn live_machine(d: &Path, exe: std::path::PathBuf) -> RealMachine {
        let mut m = machine(d);
        m.env.posctl_exe = exe;
        m.canary_fn = Some(Box::new(|| Ok(())));
        m.sign_in_fn = Some(Box::new(|| Ok(())));
        m
    }

    #[cfg(windows)]
    fn ctx() -> OpCtx {
        use crate::ops::{names::DbNames, outcome::OpKind};
        OpCtx {
            op_id: "op".into(),
            names: DbNames::for_kind(OpKind::Switch, 1_790_908_215_000),
            pack_from: None,
            pack_to: None,
            deadline_ms: u64::MAX,
        }
    }

    #[cfg(windows)]
    fn inputs(storage: bool) -> SwitchInputs {
        let mut source = crate::switch::source::parse_stdin(&format!(
            r#"{{"v":1,"db":{{"url":"postgresql://postgres:{}@db.abc.supabase.co:5432/postgres"}}}}"#,
            "Zq9-fixture-Zq9"
        ))
        .unwrap();
        if storage {
            source.storage = Some(crate::switch::source::StorageSource {
                project_url: "https://abc.supabase.co".into(),
                service_role_key: Secret::new("K"),
            });
        }
        SwitchInputs {
            op_id: "op".into(),
            source,
            waived: Default::default(),
            waive_reason: None,
            waived_queue_depth: Default::default(),
            copy_tables: vec![],
            truncate_extra: vec![],
            keep_ids: vec![],
            wait_minutes: 1,
            freeze_minutes: 30,
            dev: true,
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_failing_photo_import_or_check_fails_verify_live_so_the_switch_rolls_back() {
        for (import, verify, reason) in [
            (61, 0, Some("PHOTOS_IMPORT_FAILED")),
            (2, 0, Some("PHOTOS_IMPORT_USAGE")),
            (3, 0, Some("PHOTOS_IMPORT_NOT_ELEVATED")),
            (4, 0, Some("PHOTOS_IMPORT_NOT_PROVISIONED")),
            (1, 0, Some("PHOTOS_IMPORT_ERROR")),
            (0, 60, Some("PHOTOS_INCONSISTENT")),
            (0, 0, None),
        ] {
            let (stub_dir, exe) = crate::switch::photos::tests::stub(import, verify);
            let d = tempfile::tempdir().unwrap();
            let mut m = live_machine(d.path(), exe);
            let got = m.verify_live(&ctx(), &inputs(true));
            match reason {
                Some(r) => assert_eq!(
                    got.unwrap_err().reason,
                    r,
                    "import {import} verify {verify}"
                ),
                None => got.unwrap(),
            }
            drop(stub_dir);
        }
        // no storage credentials: the importer is not run at all (a stub that would fail is never reached)
        let (_s, exe) = crate::switch::photos::tests::stub(61, 60);
        let d = tempfile::tempdir().unwrap();
        live_machine(d.path(), exe)
            .verify_live(&ctx(), &inputs(false))
            .unwrap();
    }
}
