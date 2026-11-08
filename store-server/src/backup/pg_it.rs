//! cargo test --manifest-path store-server/Cargo.toml -- --ignored pg_it
//! Needs POS_PACK_DIR (an unpacked pack: pg\bin\*.exe). Starts a throwaway trust-auth cluster on a free
//! loopback port; never touches a store's data.
use std::path::PathBuf;
use std::process::{Command, Stdio};

use super::ctx::BackupCtx;
use super::dump::DbInfo;
use super::fingerprint::{diff_catalog, diff_tables, parse_catalog, parse_table_fp};
use super::pg::*;
use super::util::RealExec;

fn pack() -> PathBuf { PathBuf::from(std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR")) }
fn pg(name: &str) -> PathBuf { pack().join("pg").join("bin").join(name) }

struct Cluster { dir: tempfile::TempDir, port: u16 }

impl Cluster {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(Command::new(pg("initdb.exe")).args(["-D", data.to_str().unwrap(), "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"]).status().unwrap().success());
        assert!(Command::new(pg("pg_ctl.exe")).args(["-D", data.to_str().unwrap(), "-o", &format!("-p {port} -c listen_addresses=127.0.0.1"), "-l", dir.path().join("log").to_str().unwrap(), "-w", "start"]).status().unwrap().success());
        Self { dir, port }
    }
    fn base(&self, db: &str) -> Vec<String> {
        ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", &self.port.to_string(), "-U", "postgres", "-d", db].iter().map(|s| s.to_string()).collect()
    }
    fn psql(&self, db: &str, sql: &str) -> String {
        let o = Command::new(pg("psql.exe")).args(self.base(db)).args(["-c", sql]).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
    fn script(&self, db: &str, script: &str) -> Vec<String> {
        use std::io::Write;
        let mut c = Command::new(pg("psql.exe")).args(self.base(db)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        c.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let o = c.wait_with_output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect()
    }
    fn tables(&self, db: &str) -> Vec<super::fingerprint::TableFp> {
        self.script(db, &format!("{}{}", session_settings(false), TABLES_FP_SQL)).iter().map(|l| parse_table_fp(l).unwrap()).collect()
    }
    fn catalog(&self, db: &str) -> std::collections::BTreeMap<String, String> {
        parse_catalog(&self.script(db, &format!("{}{}", session_settings(false), catalog_fp_sql()))).unwrap()
    }
}

fn ctx_for(c: &Cluster) -> BackupCtx {
    let roots = crate::paths::Roots::custom(c.dir.path().join("data-root"), c.dir.path().join("program-root"));
    // the throwaway cluster's port is arbitrary, so build the (validated-at-construction) Ports by field
    BackupCtx::new(&roots, pack(), crate::ports::Ports { base: c.port }, "t".into(), "t".into())
}

impl Drop for Cluster {
    fn drop(&mut self) {
        let _ = Command::new(pg("pg_ctl.exe")).args(["-D", self.dir.path().join("data").to_str().unwrap(), "-m", "immediate", "stop"]).status();
    }
}

const SEED: &str = "CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text primary key);\
 INSERT INTO supabase_migrations.schema_migrations VALUES ('20260101000001'),('20260202000002');\
 CREATE TABLE public.items(id int primary key, note text, at timestamptz);\
 INSERT INTO public.items SELECT g, 'n' || g, '2026-01-01T00:00:00Z' FROM generate_series(1,500) g;\
 ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;\
 CREATE POLICY p_read ON public.items FOR SELECT USING (true);\
 CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'select 1';";

#[test]
#[ignore]
fn fingerprints_survive_a_dump_and_restore_and_catch_tampering() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    let want_tables = c.tables("postgres");
    let want_cat = c.catalog("postgres");
    assert!(want_tables.iter().any(|t| t.name == "public.items" && t.count == 500));

    let dump = c.dir.path().join("t.dump");
    assert!(Command::new(pg("pg_dump.exe")).args(["-h", "127.0.0.1", "-p", &c.port.to_string(), "-U", "postgres", "-Fc", "-Z0", "-f", dump.to_str().unwrap(), "postgres"]).status().unwrap().success());
    c.psql("postgres", "CREATE DATABASE restored TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';");
    assert!(Command::new(pg("pg_restore.exe")).args(["-h", "127.0.0.1", "-p", &c.port.to_string(), "-U", "postgres", "--exit-on-error", "-d", "restored", dump.to_str().unwrap()]).status().unwrap().success());

    assert!(diff_tables(&want_tables, &c.tables("restored")).is_empty());
    let d = diff_catalog(&want_cat, &c.catalog("restored"));
    assert!(d.is_empty(), "{d:?}");

    // negative controls: a changed row, then a dropped policy
    c.psql("restored", "UPDATE public.items SET note = 'x' WHERE id = 7;");
    assert!(!diff_tables(&want_tables, &c.tables("restored")).is_empty());
    c.psql("restored", "DROP POLICY p_read ON public.items;");
    assert!(diff_catalog(&want_cat, &c.catalog("restored")).iter().any(|x| x.contains("policies")));
}

#[test]
#[ignore]
fn the_snapshot_session_keeps_its_view_and_pg_dump_accepts_the_exported_snapshot() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    let ctx = ctx_for(&c);
    let conn = PgConn { host: "127.0.0.1".into(), port: c.port, user: "postgres".into(), db: "postgres".into(), passfile: None };
    let mut s = PsqlSession::open(&ctx, &conn).unwrap();
    let before = s.query("SELECT count(*) FROM public.items;").unwrap();
    c.psql("postgres", "INSERT INTO public.items VALUES (7778, 'late', now());"); // a sale committing mid-backup
    assert_eq!(before, s.query("SELECT count(*) FROM public.items;").unwrap(), "the session must keep seeing its snapshot");
    let out = c.dir.path().join("s.dump");
    let a = super::dump::pg_dump_args(&conn, &s.snapshot_id(), &out);
    assert!(Command::new(pg("pg_dump.exe")).args(&a).status().unwrap().success());
    s.close();
    assert!(out.metadata().unwrap().len() > 0);
    // the late insert must be absent from the dump: restore it and count
    c.psql("postgres", "CREATE DATABASE snaprestored TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';");
    assert!(Command::new(pg("pg_restore.exe")).args(["-h", "127.0.0.1", "-p", &c.port.to_string(), "-U", "postgres", "--exit-on-error", "-d", "snaprestored", out.to_str().unwrap()]).status().unwrap().success());
    assert_eq!(c.psql("snaprestored", "SELECT count(*) FROM public.items;"), "500", "the row committed after the snapshot must not be in the dump");
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM public.items;"), "501");
}

#[test]
#[ignore]
fn a_changed_column_grant_changes_the_catalog_fingerprint() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    c.psql("postgres", "CREATE ROLE appr;");
    let before = c.catalog("postgres");
    c.psql("postgres", "GRANT SELECT (note) ON public.items TO appr;");
    let after = c.catalog("postgres");
    let d = diff_catalog(&before, &after);
    assert!(d.iter().any(|x| x.contains("columns")), "a column grant (the profiles.pin boundary) must be visible: {d:?}");
    c.psql("postgres", "REVOKE SELECT (note) ON public.items FROM appr;");
    assert!(diff_catalog(&before, &c.catalog("postgres")).is_empty(), "revoking restores the fingerprint");
}

#[test]
#[ignore]
fn a_query_that_times_out_kills_the_psql_child_and_close_returns() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    let ctx = ctx_for(&c);
    let conn = PgConn { host: "127.0.0.1".into(), port: c.port, user: "postgres".into(), db: "postgres".into(), passfile: None };
    let mut s = PsqlSession::open(&ctx, &conn).unwrap();
    s.set_query_timeout(std::time::Duration::from_secs(1));
    let started = std::time::Instant::now();
    assert!(s.query("SELECT pg_sleep(60);").is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert!(s.child_exited(), "the child must be gone after a timeout");
    let t = std::time::Instant::now();
    s.close();
    assert!(t.elapsed() < std::time::Duration::from_secs(15), "close() must not hang");
}

#[test]
#[ignore]
fn list_valued_settings_round_trip_through_the_manifest() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    c.psql("postgres", r#"ALTER DATABASE postgres SET search_path TO "$user", public;"#);
    let ctx = ctx_for(&c);
    let conn = PgConn { host: "127.0.0.1".into(), port: c.port, user: "postgres".into(), db: "postgres".into(), passfile: None };
    let info: DbInfo = serde_json::from_str(&sql_scalar(&RealExec, &ctx, &conn, DBINFO_SQL, true).unwrap()).unwrap();
    let script = format!("{}\n{}", create_db_sql(&info, "pos_next").unwrap(), alter_settings_sql("pos_next", &info.settings).unwrap());
    sql_script(&RealExec, &ctx, &conn, &script, std::time::Duration::from_secs(60)).unwrap();
    let on = |db: &str| c.psql("postgres", &format!("SELECT setconfig[1] FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = '{db}');"));
    assert_eq!(on("pos_next"), on("postgres"), "the restored database must carry the same search_path");
}

#[test]
#[ignore]
fn every_sql_text_runs_on_the_pack_postgres_and_the_restore_helpers_build_a_database() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    let ctx = ctx_for(&c);
    let conn = PgConn { host: "127.0.0.1".into(), port: c.port, user: "postgres".into(), db: "postgres".into(), passfile: None };
    let q = |sql: &str| sql_scalar(&RealExec, &ctx, &conn, sql, true).unwrap();

    assert_eq!(q(MIGRATIONS_SQL), "2|20260202000002");
    assert_eq!(q(CAJA_PRESENT_SQL), "f");
    c.psql("postgres", "CREATE TABLE public.caja_sessions(id serial primary key, status text, closed_at timestamptz); INSERT INTO public.caja_sessions(status, closed_at) VALUES ('open', NULL), ('closed', '2026-01-01T00:00:00Z');");
    assert_eq!(q(CAJA_PRESENT_SQL), "t");
    let caja: serde_json::Value = serde_json::from_str(&q(CAJA_SQL)).unwrap();
    assert_eq!((caja["open"].as_bool(), caja["closed"].as_i64()), (Some(true), Some(1_767_225_600)));

    c.psql("postgres", "CREATE SCHEMA storage; CREATE TABLE storage.objects(id uuid, bucket_id text); INSERT INTO storage.objects VALUES ('00000000-0000-0000-0000-000000000001', 'photos');");
    assert_eq!(q(PHOTO_ROWS_SQL), "photos/00000000-0000-0000-0000-000000000001");

    c.psql("postgres", "ALTER DATABASE postgres SET timezone TO 'UTC';");
    let info: DbInfo = serde_json::from_str(&q(DBINFO_SQL)).unwrap();
    assert_eq!((info.name.as_str(), info.provider.as_str(), info.encoding.as_str()), ("postgres", "c", "UTF8"));
    assert_eq!(info.settings, vec!["TimeZone=UTC".to_string()]);

    // the restore helpers: create the database from the manifest's locale, replay settings and the ACL
    c.psql("postgres", "CREATE ROLE appr; GRANT CONNECT ON DATABASE postgres TO appr;");
    let acl = q(&acl_replicate_sql("postgres", "pos_next"));
    assert!(acl.contains("GRANT CONNECT ON DATABASE pos_next TO appr;"), "{acl}");
    assert!(!acl.contains("TO postgres"), "grants to the database owner are skipped: {acl}");
    c.psql("postgres", "GRANT TEMP ON DATABASE postgres TO appr WITH GRANT OPTION;");
    let acl2 = q(&acl_replicate_sql("postgres", "pos_next"));
    assert!(acl2.contains("GRANT TEMPORARY ON DATABASE pos_next TO appr WITH GRANT OPTION;"), "{acl2}");
    assert!(acl2.starts_with("REVOKE ALL ON DATABASE pos_next FROM PUBLIC;"), "{acl2}");
    let script = format!("{}\n{}{}", create_db_sql(&info, "pos_next").unwrap(), alter_settings_sql("pos_next", &info.settings).unwrap(), acl);
    sql_script(&RealExec, &ctx, &conn, &script, std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(q("SELECT datname FROM pg_database WHERE datname = 'pos_next';"), "pos_next");
    assert_eq!(q("SELECT has_database_privilege('appr', 'pos_next', 'CONNECT');"), "t");
    assert_eq!(q("SELECT setconfig[1] FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = 'pos_next');"), "TimeZone=UTC", "the canonical spelling Postgres stores must round-trip through the manifest");
}

#[test]
#[ignore]
fn run_backup_end_to_end() {
    use super::dump::{read_manifest, verify_files};
    use super::paths::restic_path;
    use super::policy::Reason;
    use super::repo::local_repo;
    use super::restic::{parse_snapshots, restore_args, run_restic};
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    use std::time::Duration;

    let c = Cluster::start();
    c.psql("postgres", "CREATE ROLE supabase_admin SUPERUSER LOGIN;");
    c.psql("postgres", SEED);
    c.psql("postgres", "CREATE TABLE public.caja_sessions(id int, status text, closed_at timestamptz); INSERT INTO public.caja_sessions VALUES (1, 'closed', now());");
    let ctx = ctx_for(&c);
    for p in [ctx.paths.secrets(), ctx.paths.backups(), ctx.paths.state_dir(), ctx.paths.photos(), ctx.paths.conf_file().parent().unwrap().to_path_buf()] {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(ctx.paths.conf_file(), r#"{"schema":1}"#).unwrap();
    std::fs::write(ctx.paths.photos().join("a"), b"photo").unwrap();

    let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None };
    let rep = run_backup(&ctx, &Deps::real(), &opts).unwrap();
    assert_eq!(rep.outcome, "completed", "{rep:?}");
    assert!(c.psql("postgres", "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'pos_backup'") == "t");
    let leftovers: Vec<_> = std::fs::read_dir(ctx.paths.backups_tmp()).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("run-")).collect();
    assert!(leftovers.is_empty(), "the plaintext stage must be gone: {leftovers:?}");

    // the snapshot: tags, the staged folder, and a restore that proves the manifest against the files
    let repo = local_repo(&ctx);
    let out = run_restic(&RealExec, &ctx, &repo, &super::restic::snapshots_args(), Duration::from_secs(120)).unwrap();
    assert!(out.ok(), "{}", out.stderr);
    let snaps = parse_snapshots(&out.stdout).unwrap();
    assert_eq!(snaps.len(), 1);
    assert!(snaps[0].tags.iter().any(|t| t == "reason:manual") && snaps[0].tags.iter().any(|t| t == "posctl"), "{:?}", snaps[0].tags);
    assert_eq!(Some(snaps[0].id.chars().take(8).collect::<String>()), rep.snapshot_id.map(|s| s.chars().take(8).collect()));
    let sub = snaps[0].paths.iter().find(|p| p.replace('\\', "/").to_lowercase().ends_with("/stage/current")).map(|p| restic_path(std::path::Path::new(p))).expect("the snapshot holds a stage/current folder");
    let dir = c.dir.path().join("fetched");
    std::fs::create_dir_all(&dir).unwrap();
    let r = run_restic(&RealExec, &ctx, &repo, &restore_args(&snaps[0].id, &sub, &dir, false), Duration::from_secs(300)).unwrap();
    assert!(r.ok(), "{}", r.stderr);
    let m = read_manifest(&dir).unwrap();
    verify_files(&dir, &m).unwrap();
    assert!(m.tables.iter().any(|t| t.name == "public.items" && t.count == 500));

    // and the dump really restores to what the manifest fingerprinted
    c.psql("postgres", "CREATE DATABASE restored TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';");
    assert!(Command::new(pg("pg_restore.exe")).args(["-h", "127.0.0.1", "-p", &c.port.to_string(), "-U", "postgres", "--exit-on-error", "-d", "restored", dir.join("pos.dump").to_str().unwrap()]).status().unwrap().success());
    assert!(diff_tables(&m.tables, &c.tables("restored")).is_empty());
    let d = diff_catalog(&m.catalog, &c.catalog("restored"));
    assert!(d.is_empty(), "{d:?}");

    // A second run while one photo is held open exclusively: restic cannot read it. This proves restic's real `item`
    // path form matches `is_inside` (so the photos-only exit-3 rule triggers) and that `--group-by host` lets the
    // second snapshot find the first as its parent although the stage path differs per run.
    use std::os::windows::fs::OpenOptionsExt;
    let first_id = snaps[0].id.clone();
    let locked = ctx.paths.photos().join("a");
    // restic does not open a file whose size and mtime match the parent snapshot, so change it first
    std::fs::write(&locked, b"photo, edited since the first backup").unwrap();
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&locked).expect("hold the photo open exclusively");
    let rep2 = run_backup(&ctx, &Deps::real(), &opts).unwrap();
    drop(held);
    assert_eq!(rep2.outcome, "completed", "{rep2:?}");
    let st = super::state::BackupState::load(&ctx.paths.state_file(), 0).unwrap();
    let out = run_restic(&RealExec, &ctx, &repo, &super::restic::snapshots_args(), Duration::from_secs(120)).unwrap();
    let all: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
    let second = all.as_array().unwrap().iter().find(|s| s["id"].as_str() != Some(first_id.as_str())).expect("a second snapshot");
    // The invariant is "no silent loss": a photo locked during backup 2 is EITHER reported in photos_unreadable OR snapshot 2 holds its
    // CURRENT content (restic read it through the lock). Which one happens depends on the OS/token, so both are accepted and the branch is logged.
    let second_id = second["id"].as_str().expect("snapshot id");
    let dumped = run_restic(&RealExec, &ctx, &repo, &super::restic::dump_file_args(second_id, &restic_path(&ctx.paths.photos()), "a"), Duration::from_secs(60)).unwrap();
    let held_now = if !dumped.ok() { "absent" } else if dumped.stdout == "photo, edited since the first backup" { "the new bytes" } else if dumped.stdout == "photo" { "the old bytes" } else { "other bytes" };
    let reported = st.photos_unreadable.as_ref().is_some_and(|pu| pu.paths.iter().any(|p| p.eq_ignore_ascii_case(&locked.to_string_lossy())));
    let read_through = held_now == "the new bytes";
    assert!(
        reported || read_through,
        "locked photo silently lost: not reported and snapshot {second_id} has photos/a as {held_now}; warnings={:?} photos_unreadable={:?} snapshot_id={:?} dump_stderr={}",
        rep2.warnings, st.photos_unreadable, rep2.snapshot_id, dumped.stderr.trim()
    );
    eprintln!("{}", if reported { "locked photo: reported unreadable" } else { "locked photo: read through lock, snapshot has current content" });
    assert_eq!(second["parent"].as_str(), Some(first_id.as_str()), "--group-by host: {second}");
}

/// Real restic (no PostgreSQL): a snapshot copied to a second repository gets a NEW id and `original` = the source id.
/// `verify --read-data` must keep (or restore) the SOURCE id in the destination's remembered state, so an up-to-date
/// drive is not copied to again every week, and must pass restic's own checks on both repositories.
#[test]
#[ignore]
fn verify_read_data_keeps_the_source_snapshot_id_of_a_real_copy() {
    use super::config::{self, BackupConfig, DestKind, Destination};
    use super::policy::{copy_pending, Reason};
    use super::repo::{dest_repo, ensure_local_repo, local_repo};
    use super::restic::{backup_args, copy_args, init_args, parse_backup_summary, parse_snapshots, run_restic, snapshot_tags, snapshots_args};
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    use super::state::{BackupState, DestState, SnapRef};
    use std::time::Duration;

    let d = tempfile::tempdir().unwrap();
    let roots = crate::paths::Roots::custom(d.path().join("data-root"), d.path().join("program-root"));
    let ctx = BackupCtx::new(&roots, pack(), crate::ports::Ports::new(47300).unwrap(), "t".into(), "t".into());
    for p in [ctx.paths.secrets(), ctx.paths.backups(), ctx.paths.backups_tmp(), ctx.paths.state_dir(), ctx.paths.conf_file().parent().unwrap().to_path_buf()] {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(ctx.paths.conf_file(), r#"{"schema":1}"#).unwrap();
    let t = Duration::from_secs(300);

    // a local repository with one snapshot (`short` is the id the backup summary printed, which is what the state remembers)
    let local = ensure_local_repo(&ctx, &RealExec, false).unwrap();
    let src = d.path().join("stage");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("pos.dump"), b"not really a dump").unwrap();
    let out = run_restic(&RealExec, &ctx, &local, &backup_args(&src, None, &snapshot_tags(Reason::Hourly, "x", "p")), t).unwrap();
    assert!(out.ok(), "{}", out.stderr);
    let short = parse_backup_summary(&out.stdout).unwrap().snapshot_id; // restic 0.19 prints all 64 digits here

    // a second repository on a "device", initialised like `dest add` does and filled by `restic copy`
    let usb = d.path().join("usb");
    std::fs::create_dir_all(&usb).unwrap();
    let dest = Destination { name: "usb-e".into(), kind: DestKind::Device, path: Some(usb.to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() };
    let drepo = dest_repo(&ctx, &dest).unwrap();
    let o = run_restic(&RealExec, &ctx, &drepo, &init_args(Some((&ctx.paths.repo().to_string_lossy(), &ctx.paths.machine_key()))), t).unwrap();
    assert!(o.ok(), "{}", o.stderr);
    let o = run_restic(&RealExec, &ctx, &drepo, &copy_args(&ctx.paths.repo().to_string_lossy(), &ctx.paths.machine_key()), t).unwrap();
    assert!(o.ok(), "{}", o.stderr);
    config::save(&ctx.paths.conf_file(), &BackupConfig { destinations: vec![dest], ..Default::default() }).unwrap();

    let on_usb = parse_snapshots(&run_restic(&RealExec, &ctx, &drepo, &snapshots_args(), t).unwrap().stdout).unwrap();
    assert_eq!(on_usb.len(), 1);
    assert_ne!(on_usb[0].id, parse_snapshots(&run_restic(&RealExec, &ctx, &local_repo(&ctx), &snapshots_args(), t).unwrap().stdout).unwrap()[0].id, "restic copy assigns a new id");
    let original = on_usb[0].original.clone().expect("restic copy records the source id in `original`");
    assert_eq!(original, short);

    let cfg = config::load(&ctx.paths.conf_file()).unwrap();
    let prefix: String = short.chars().take(8).collect();
    for remembered in [short.as_str(), prefix.as_str(), "ghost"] {
        let mut st = BackupState::load(&ctx.paths.state_file(), 1).unwrap();
        st.local = Some(SnapRef { id: prefix.clone(), at: 1, reason: "hourly".into() });
        st.destinations.insert("usb-e".into(), DestState { reachable: true, ok: true, last_success: Some(SnapRef { id: remembered.into(), at: 1, reason: "hourly".into() }), ..Default::default() });
        st.save_in(&ctx).unwrap();

        let rep = super::maintain::verify(&ctx, &Deps::real(), true).unwrap();
        assert_eq!(rep["repos"].as_array().unwrap().iter().filter(|r| r["ok"] == true && r["skipped"] == false).count(), 2, "{rep}");

        let st = BackupState::load(&ctx.paths.state_file(), 0).unwrap();
        if remembered == "ghost" {
            // not on the drive: forgotten, never adopted from the drive's newest snapshot
            assert!(st.destinations["usb-e"].last_success.is_none());
            assert!(copy_pending(&st, &cfg, 1_000_000));
            // the next tick (no database here, so it is copy-only) makes the no-op copy and records the SOURCE id
            let opts = RunOptions { reason: Reason::Hourly, only_dest: None, scheduled: true, lock: LockPolicy::Acquire, deadline: None };
            let rep = run_backup(&ctx, &Deps::real(), &opts).unwrap();
            assert_eq!(rep.outcome, "copied", "{rep:?}");
            let st = BackupState::load(&ctx.paths.state_file(), 0).unwrap();
            assert_eq!(st.destinations["usb-e"].last_success.as_ref().unwrap().id, prefix);
            assert!(!copy_pending(&st, &cfg, 1_000_000));
            let on_usb = parse_snapshots(&run_restic(&RealExec, &ctx, &drepo, &snapshots_args(), t).unwrap().stdout).unwrap();
            assert_eq!(on_usb.len(), 1, "the copy added nothing");
            continue;
        }
        let kept = &st.destinations["usb-e"].last_success.as_ref().expect("a drive that holds the copy keeps a success").id;
        assert!(kept.starts_with(&prefix), "the SOURCE id, not the copy's own: {kept}");
        assert_ne!(*kept, on_usb[0].id);
        assert!(!copy_pending(&st, &cfg, 1_000_000), "no spurious copy after a verify (remembered {remembered})");
        assert_eq!(st.local.as_ref().unwrap().id, prefix, "the local snapshot is still there, id untouched");
        assert!(st.verify.as_ref().unwrap().ok);
    }
}

/// The minimum of a Supabase store the restore proof needs, on a bare throwaway cluster: the roles, pgcrypto in
/// `extensions`, a stand-in `auth.users` (the real one belongs to GoTrue; this cluster has none, and nothing here is a
/// store), `profiles`, the lockout hook with its grant, `storage.objects`, and an RLS-protected `caja_sessions`.
const AUTH_SEED: &str = "CREATE ROLE supabase_admin SUPERUSER LOGIN; CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;\
 CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions;\
 CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key, encrypted_password text, deleted_at timestamptz, banned_until timestamptz, updated_at timestamptz, confirmation_token text, recovery_token text, email_change_token_new text, email_change_token_current text, email_change text, reauthentication_token text, phone_change_token text);\
 CREATE TYPE public.user_role AS ENUM ('admin','manager','cashier');\
 CREATE TABLE public.profiles(id uuid primary key, name text, role public.user_role, pin varchar(6), is_active boolean default true, created_at timestamptz default now());\
 CREATE SCHEMA pos_lockout; CREATE FUNCTION pos_lockout.password_verification_hook(event jsonb) RETURNS jsonb LANGUAGE sql AS 'select event';\
 REVOKE ALL ON FUNCTION pos_lockout.password_verification_hook(jsonb) FROM PUBLIC; GRANT USAGE ON SCHEMA pos_lockout TO supabase_auth_admin; GRANT EXECUTE ON FUNCTION pos_lockout.password_verification_hook(jsonb) TO supabase_auth_admin;\
 CREATE SCHEMA storage; CREATE TABLE storage.objects(id uuid primary key, bucket_id text);\
 CREATE TABLE public.caja_sessions(id int, status text, closed_at timestamptz); INSERT INTO public.caja_sessions VALUES (1, 'closed', now());\
 ALTER TABLE public.caja_sessions ENABLE ROW LEVEL SECURITY; CREATE POLICY p_auth ON public.caja_sessions FOR SELECT TO authenticated USING (true); GRANT SELECT ON public.caja_sessions TO authenticated;";

const ADMIN_ID: &str = "00000000-0000-4000-8000-000000000001";
const CASHIER_ID: &str = "00000000-0000-4000-8000-000000000002";
const ORPHAN_ID: &str = "00000000-0000-4000-8000-000000000003";
const PHOTO_ID: &str = "00000000-0000-4000-8000-0000000000aa";

/// Seeds the cluster; returns the admin's and the cashier's PIN (random, built here, never a literal).
fn seed_store(c: &Cluster) -> (String, String) {
    c.psql("postgres", AUTH_SEED);
    c.psql("postgres", SEED);
    let (admin_pin, cashier_pin) = (super::util::fake::rand_pin(), super::util::fake::rand_pin());
    // the two accounts start with a stale credential and NULL token columns: what a restore onto a new PC would meet
    c.psql(
        "postgres",
        &format!(
            "INSERT INTO auth.users(id, encrypted_password) VALUES ('{ADMIN_ID}', 'stale'), ('{CASHIER_ID}', 'stale');\
             INSERT INTO public.profiles(id, name, role, pin) VALUES ('{ADMIN_ID}', 'a', 'admin', '{admin_pin}'), ('{CASHIER_ID}', 'c', 'cashier', '{cashier_pin}'), ('{ORPHAN_ID}', 'o', 'cashier', '{cashier_pin}');\
             INSERT INTO storage.objects VALUES ('{PHOTO_ID}', 'product-photos');"
        ),
    );
    (admin_pin, cashier_pin)
}

fn store_ctx(c: &Cluster) -> (BackupCtx, String) {
    let ctx = ctx_for(c);
    for p in [ctx.paths.secrets(), ctx.paths.backups(), ctx.paths.state_dir(), ctx.paths.photos().join("product-photos"), ctx.paths.conf_file().parent().unwrap().to_path_buf()] {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(ctx.paths.conf_file(), r#"{"schema":1,"backup":{"rtoBudgetSeconds":1800}}"#).unwrap();
    std::fs::write(ctx.paths.photos().join("product-photos").join(PHOTO_ID), b"photo").unwrap();
    let pepper = super::util::fake::rand_pepper();
    std::fs::write(ctx.paths.pepper(), &pepper).unwrap();
    (ctx, pepper)
}

#[test]
#[ignore]
fn rederive_updates_existing_accounts_only_and_repairs_the_token_columns() {
    use super::restore::Rx;
    use super::run::Deps;
    let c = Cluster::start();
    let (admin_pin, cashier_pin) = seed_store(&c);
    let (ctx, pepper) = store_ctx(&c);
    let deps = Deps::real();
    let rx = Rx::new(&deps);
    let before = c.psql("postgres", "SELECT count(*) FROM auth.users");

    let out = super::rederive::legacy_run(&ctx, &rx, "postgres").unwrap();
    assert_eq!((out["rederived"].as_u64(), out["withoutAuthUser"].as_i64()), (Some(3), Some(1)), "{out}");
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM auth.users"), before, "never an INSERT into auth.users: the profile without an account stays without one");
    assert_eq!(
        c.psql("postgres", "SELECT count(*) FROM auth.users WHERE confirmation_token IS NULL OR recovery_token IS NULL OR email_change_token_new IS NULL OR email_change_token_current IS NULL OR email_change IS NULL OR reauthentication_token IS NULL OR phone_change_token IS NULL"),
        "0",
        "the seven token columns are repaired in the same statement"
    );
    for (id, pin) in [(ADMIN_ID, &admin_pin), (CASHIER_ID, &cashier_pin)] {
        let pw = crate::staff_password::derive_staff_password(id, pin, &pepper).unwrap();
        let sql = format!("SET search_path = extensions, public; SELECT encrypted_password = crypt('{pw}', encrypted_password) FROM auth.users WHERE id = '{id}'");
        assert_eq!(c.psql("postgres", &sql), "t", "{id}");
    }
    assert_eq!(super::rederive::legacy_admin_credential_check(&ctx, &rx, "postgres").unwrap(), ADMIN_ID);
    // a second run is harmless
    let again = super::rederive::legacy_run(&ctx, &rx, "postgres").unwrap();
    assert_eq!(again["rederived"].as_u64(), Some(3));
}

#[test]
#[ignore]
fn a_restored_drill_database_cannot_be_connected_to_by_an_app_role() {
    use super::policy::Reason;
    use super::restore::{create_and_load, drop_database, fetch_stage, pick_snapshot, resolve_source, Rx};
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    let c = Cluster::start();
    seed_store(&c);
    let (ctx, _) = store_ctx(&c);
    let deps = Deps::real();
    let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None };
    run_backup(&ctx, &deps, &opts).unwrap();
    c.psql("postgres", "CREATE ROLE appr LOGIN");
    assert_eq!(c.psql("postgres", "SELECT has_database_privilege('appr', 'postgres', 'CONNECT')"), "t", "the live database is open to PUBLIC, so the control means something");
    let rx = Rx::new(&deps);
    let src = resolve_source(&ctx, None, None).unwrap();
    let snap = pick_snapshot(&ctx, &rx, &src, "latest").unwrap();
    let f = fetch_stage(&ctx, &rx, &src, &snap).unwrap();
    let db = "pos_drill_20261022010203";
    create_and_load(&ctx, &rx, &f, db).unwrap();
    assert_eq!(c.psql("postgres", &format!("SELECT has_database_privilege('appr', '{db}', 'CONNECT')")), "f");
    drop_database(&ctx, &rx, db).unwrap();
}

#[test]
#[ignore]
fn drill_end_to_end() {
    use super::policy::Reason;
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    use super::state::BackupState;
    let c = Cluster::start();
    let (admin_pin, cashier_pin) = seed_store(&c);
    let (ctx, pepper) = store_ctx(&c);
    let deps = Deps::real();
    let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None };
    assert_eq!(run_backup(&ctx, &deps, &opts).unwrap().outcome, "completed");

    // from here every statement is logged by the server, so the log shows whether a PIN or a derived password leaks
    c.psql("postgres", "ALTER SYSTEM SET log_statement = 'all'");
    c.psql("postgres", "SELECT pg_reload_conf()");
    let out = super::drill::run_drill(&ctx, &deps).unwrap();
    assert_eq!(out["source"], "local");
    assert_eq!(out["photosVerdict"], "Ok", "{out}");
    assert_eq!(out["scratchDropped"], true);
    assert_eq!(out["structure"]["migrations"], "2|20260202000002");
    assert_eq!(out["rederive"]["rederived"].as_u64(), Some(3));
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'pos_drill_%'"), "0", "the scratch database is gone");
    let leftovers: Vec<_> = std::fs::read_dir(ctx.paths.backups_tmp()).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("run-")).collect();
    assert!(leftovers.is_empty(), "the plaintext restore folder must be gone: {leftovers:?}");
    let d = BackupState::load(&ctx.paths.state_file(), 0).unwrap().drill.unwrap();
    assert!(d.ok && d.last_pass_at > 0 && d.detail == "ok", "{d:?}");
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM public.items"), "500", "a drill never touches the live database");

    // statement logging was on for the drill: neither a PIN nor any derived password may be in the server log
    let log = std::fs::read_to_string(c.dir.path().join("log")).unwrap();
    assert!(log.contains("pos_drill_"), "the log must show the drill ran (otherwise this proves nothing)");
    for secret in [admin_pin.as_str(), cashier_pin.as_str(), pepper.as_str()] {
        assert!(!log.contains(secret), "a secret reached the server log");
    }
    let derived = crate::staff_password::derive_staff_password(ADMIN_ID, &admin_pin, &pepper).unwrap();
    assert!(!log.contains(&derived) && !log.contains("crypt('v1."), "a derived password reached the server log");

    // negative control: a live database that has lost the lockout hook's grant is a backup the drill must refuse
    c.psql("postgres", "REVOKE EXECUTE ON FUNCTION pos_lockout.password_verification_hook(jsonb) FROM supabase_auth_admin");
    assert_eq!(run_backup(&ctx, &deps, &opts).unwrap().outcome, "completed");
    let err = super::drill::run_drill(&ctx, &deps).unwrap_err();
    assert_eq!(err.code, crate::envelope::Code::RestoreFailed);
    assert!(err.message.contains("lockout hook"), "{}", err.message);
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'pos_drill_%'"), "0", "a failed drill still drops its scratch database");
    let d = BackupState::load(&ctx.paths.state_file(), 0).unwrap().drill.unwrap();
    assert!(!d.ok && d.last_pass_at > 0, "the failure is recorded and the last pass time kept: {d:?}");
}

/// Task 9 on real binaries, host-safe: a loopback trust cluster, a real backup, then the restore work (everything
/// `run_restore` does between the fence and the swap) into `pos_next`. No service is registered and nothing is swapped;
/// the runner, the fence, GoTrue and `db push` are Sandbox-only (Task 13).
#[test]
#[ignore]
fn restore_work_loads_proves_and_rederives_a_real_snapshot_into_pos_next_and_logs_no_secret() {
    use super::policy::Reason;
    use super::restore::{fetch_stage, pick_snapshot, resolve_source, Rx};
    use super::restore_work::RestoreWork;
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    use crate::ops::names::DbNames;
    use crate::ops::outcome::OpKind;
    use crate::ops::world::{OpCtx, OpWork};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    let c = Cluster::start();
    let (admin_pin, cashier_pin) = seed_store(&c);
    let (ctx, pepper) = store_ctx(&c);
    let deps = Deps::real();
    let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None };
    assert_eq!(run_backup(&ctx, &deps, &opts).unwrap().outcome, "completed");
    // some live drift after the backup: the restore must replace it, not merge with it
    c.psql("postgres", "DELETE FROM public.items WHERE id > 100");
    c.psql("postgres", "ALTER SYSTEM SET log_statement = 'all'");
    c.psql("postgres", "SELECT pg_reload_conf()");

    let roots = crate::paths::Roots::custom(c.dir.path().join("data-root"), c.dir.path().join("program-root"));
    let env = crate::update::Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe: c.dir.path().join("posctl.exe"), ports: ctx.ports, roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
    let (src, f) = {
        let rx = Rx::new(&deps);
        let src = resolve_source(&ctx, None, None).unwrap();
        let snap = pick_snapshot(&ctx, &rx, &src, "latest").unwrap();
        // the manifest alone, from the real repository (`restic dump <id>:<folder> <file>`), before any plaintext is written
        let peek = super::restore::peek_manifest(&ctx, &rx, &src, &snap).unwrap();
        let f = fetch_stage(&ctx, &rx, &src, &snap).unwrap();
        assert_eq!((peek.migrations_count, &peek.migrations_max, peek.files.len()), (f.manifest.migrations_count, &f.manifest.migrations_max, f.manifest.files.len()));
        assert_eq!(peek.files.iter().map(|x| x.bytes).collect::<Vec<_>>(), f.manifest.files.iter().map(|x| x.bytes).collect::<Vec<_>>());
        (src, f)
    };
    let mut w = RestoreWork::new(env, ctx.clone(), Deps::real(), Arc::new(AtomicU64::new(u64::MAX)), Some((src, f)), (2, "20260202000002".into()));
    let octx = OpCtx { op_id: "restore-it".into(), names: DbNames::for_kind(OpKind::Restore, 1_790_000_000_000), pack_from: None, pack_to: None, deadline_ms: u64::MAX };
    w.work_on_clone(&octx).unwrap();
    w.verify_clone(&octx).unwrap();

    // the server log as the restore left it: read BEFORE this test's own queries (it logs them too, derived password included)
    let log = std::fs::read_to_string(c.dir.path().join("log")).unwrap();
    assert!(log.contains("pos_next"), "the log must show the restore ran (otherwise this proves nothing)");
    let derived = crate::staff_password::derive_staff_password(ADMIN_ID, &admin_pin, &pepper).unwrap();
    assert_eq!(c.psql("pos_next", "SELECT count(*) FROM public.items"), "500", "the snapshot's rows, not the drifted live ones");
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM public.items"), "100", "the live database is untouched until the swap");
    assert_eq!(c.psql("postgres", "SELECT count(*) FROM pg_database WHERE datname = 'pos_next'"), "1");
    assert_eq!(
        c.psql("postgres", "SELECT has_database_privilege('public', 'pos_next', 'CONNECT') = has_database_privilege('public', 'postgres', 'CONNECT')"),
        "t",
        "the clone carries the live database's grants"
    );
    assert!(w.photo_report.as_ref().is_some_and(|r| r["dangling"] == 0), "{:?}", w.photo_report);
    let sql = format!("SET search_path = extensions, public; SELECT encrypted_password = crypt('{derived}', encrypted_password) FROM auth.users WHERE id = '{ADMIN_ID}'");
    assert_eq!(c.psql("pos_next", &sql), "t", "the restored admin signs in with THIS machine's pepper");
    drop(w);
    let leftovers: Vec<_> = std::fs::read_dir(ctx.paths.backups_tmp()).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("run-")).collect();
    assert!(leftovers.is_empty(), "the plaintext stage is gone when the work is dropped: {leftovers:?}");

    for secret in [admin_pin.as_str(), cashier_pin.as_str(), pepper.as_str(), derived.as_str()] {
        assert!(!log.contains(secret), "a secret reached the server log");
    }
}

/// Repro of the Sandbox 40 regression: a store whose objects are owned by a non-superuser role that has ALTER DEFAULT PRIVILEGES
/// (hosted-Supabase shape), restored the way the runner does it, with or without the template clone made first.
fn restore_catalog_after(with_clone: bool) -> Result<(), String> {
    use super::policy::Reason;
    use super::restore::{fetch_stage, pick_snapshot, resolve_source, Rx};
    use super::restore_work::RestoreWork;
    use super::run::{run_backup, Deps, LockPolicy, RunOptions};
    use crate::ops::names::DbNames;
    use crate::ops::outcome::OpKind;
    use crate::ops::world::{OpCtx, OpWork};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    let c = Cluster::start();
    let _ = seed_store(&c);
    c.psql("postgres", "CREATE ROLE service_role NOLOGIN; CREATE ROLE appowner NOSUPERUSER CREATEDB CREATEROLE; GRANT anon, authenticated, service_role TO appowner; GRANT CREATE ON SCHEMA public TO appowner");
    c.psql("postgres", "ALTER DEFAULT PRIVILEGES FOR ROLE appowner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES FOR ROLE appowner IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES FOR ROLE appowner IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role");
    c.psql("postgres", "SET ROLE appowner; CREATE TABLE public.t_owned(id serial primary key, v text); CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS 'select 2'; REVOKE ALL ON FUNCTION public.g() FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.g() TO authenticated; REVOKE DELETE ON public.t_owned FROM anon");
    c.psql("postgres", "ALTER DEFAULT PRIVILEGES FOR ROLE appowner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon");
    let (ctx, _) = store_ctx(&c);
    let deps = Deps::real();
    let opts = RunOptions { reason: Reason::Manual, only_dest: None, scheduled: false, lock: LockPolicy::CallerHoldsExclusive, deadline: None };
    assert_eq!(run_backup(&ctx, &deps, &opts).unwrap().outcome, "completed");
    let roots = crate::paths::Roots::custom(c.dir.path().join("data-root"), c.dir.path().join("program-root"));
    let env = crate::update::Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe: c.dir.path().join("posctl.exe"), ports: ctx.ports, roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
    let (src, f) = {
        let rx = Rx::new(&deps);
        let src = resolve_source(&ctx, None, None).unwrap();
        let snap = pick_snapshot(&ctx, &rx, &src, "latest").unwrap();
        let f = fetch_stage(&ctx, &rx, &src, &snap).unwrap();
        (src, f)
    };
    if with_clone {
        c.psql("postgres", "CREATE DATABASE pos_next TEMPLATE postgres");
    }
    let mut w = RestoreWork::new(env, ctx.clone(), Deps::real(), Arc::new(AtomicU64::new(u64::MAX)), Some((src, f)), (2, "20260202000002".into()));
    let octx = OpCtx { op_id: "restore-it".into(), names: DbNames::for_kind(OpKind::Restore, 1_790_000_000_000), pack_from: None, pack_to: None, deadline_ms: u64::MAX };
    let r = w.work_on_clone(&octx);
    r.map_err(|e| e.message)
}

/// Sorting an ACL must not make "no ACL yet" (NULL = the default grants) equal to "explicitly nothing" (`{}`): a function whose
/// REVOKE was lost on restore would pass. NULL is expanded to `acldefault` before the sort.
#[test]
#[ignore]
fn an_acl_revoked_to_nothing_or_changed_changes_the_catalog_fingerprint_for_schemas_tables_and_functions() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    c.psql("postgres", "CREATE ROLE appr; CREATE SCHEMA pos_lockout; CREATE TABLE public.t2(id int); CREATE FUNCTION public.sd() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1';");
        assert_eq!(c.psql("postgres", "SELECT proacl IS NULL FROM pg_proc WHERE proname = 'sd'"), "t", "the control starts on the default (NULL) ACL");
    let before = c.catalog("postgres");
    let differs = |kind: &str, why: &str| {
        let d = diff_catalog(&before, &c.catalog("postgres"));
        assert!(d.iter().any(|x| x.contains(kind)), "{why}: {d:?}");
    };
    // functions: revoke everything (PUBLIC and the owner) -> proacl becomes {} instead of NULL
    c.psql("postgres", "REVOKE ALL ON FUNCTION public.sd() FROM PUBLIC, postgres");
    differs("functions", "a function revoked to nothing must differ from its default ACL");
    c.psql("postgres", "GRANT EXECUTE ON FUNCTION public.sd() TO PUBLIC, postgres");
    c.psql("postgres", "GRANT EXECUTE ON FUNCTION public.sd() TO appr");
    differs("functions", "a different grant must differ");
    c.psql("postgres", "REVOKE EXECUTE ON FUNCTION public.sd() FROM appr");
    assert!(diff_catalog(&before, &c.catalog("postgres")).is_empty(), "back to the default grants reads as the default again");
    // tables
    c.psql("postgres", "REVOKE ALL ON public.t2 FROM postgres");
    differs("relations", "a table revoked to nothing must differ from its default ACL");
    c.psql("postgres", "GRANT ALL ON public.t2 TO postgres");
    c.psql("postgres", "GRANT SELECT ON public.t2 TO appr");
    differs("relations", "a different table grant must differ");
    c.psql("postgres", "REVOKE SELECT ON public.t2 FROM appr");
    // schemas (pos_lockout is one of the fingerprinted namespaces)
    c.psql("postgres", "REVOKE ALL ON SCHEMA pos_lockout FROM postgres");
    differs("schemas", "a schema revoked to nothing must differ from its default ACL");
}

/// A dropped `ALTER DEFAULT PRIVILEGES` row is a catalog change: `default_acls` lists the `pg_default_acl` rows.
#[test]
#[ignore]
fn a_dropped_default_privileges_row_changes_the_catalog_fingerprint() {
    let c = Cluster::start();
    c.psql("postgres", SEED);
    c.psql("postgres", "CREATE ROLE appr; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO appr");
    let before = c.catalog("postgres");
    c.psql("postgres", "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM appr");
    let d = diff_catalog(&before, &c.catalog("postgres"));
    assert!(d.iter().any(|x| x.contains("default_acls")), "a lost default-privileges row must be visible: {d:?}");
}

/// Sandbox 40 regression. `pg_restore` re-grants an object's privileges in its own order (owner first), so the same grants read back as
/// a differently ordered `aclitem[]`: the catalog fingerprint must compare ACLs as sets. Red before `pg::acl_sorted`, with and without
/// the template clone in front (the clone is not what the restore proof depends on: `create_and_load` drops it and builds pos_next).
#[test]
#[ignore]
fn a_restored_database_matches_the_backup_catalog_whatever_order_pg_restore_grants_in() {
    for with_clone in [false, true] {
        let r = restore_catalog_after(with_clone);
        assert!(r.is_ok(), "with_clone={with_clone}: {r:?}");
    }
}

/// PM ruling: after a restore commits, the `pos_prev_restore_*` safety copy (the OLD store, plaintext PINs) is closed to PUBLIC and
/// every non-owner grantee; the owner can still connect. Exercised directly on a database made for the test (the swap itself is
/// the runner's, Sandbox-only).
#[test]
#[ignore]
fn the_previous_restore_copy_is_closed_to_app_roles_but_not_to_its_owner() {
    use super::restore_work::RestoreWork;
    use super::run::Deps;
    use crate::ops::world::OpWork;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    let c = Cluster::start();
    let (ctx, _) = store_ctx(&c);
    let prev = "pos_prev_restore_20261022010203";
    c.psql("postgres", "CREATE ROLE supabase_admin SUPERUSER LOGIN; CREATE ROLE appr LOGIN; CREATE ROLE other LOGIN; CREATE ROLE \"Odd Role\" LOGIN");
    c.psql("postgres", &format!("CREATE DATABASE {prev}"));
    c.psql("postgres", &format!("GRANT CONNECT ON DATABASE {prev} TO appr, other, \"Odd Role\""));
    let can = |role: &str, db: &str| c.psql("postgres", &format!("SELECT has_database_privilege('{role}', '{db}', 'CONNECT')"));
    for r in ["appr", "other", "Odd Role", "postgres"] {
        assert_eq!(can(r, prev), "t", "{r} can connect before the revoke (so the control means something)");
    }
    let roots = crate::paths::Roots::custom(c.dir.path().join("data-root"), c.dir.path().join("program-root"));
    let env = crate::update::Env { data: roots.data.clone(), program: roots.program.clone(), posctl_exe: c.dir.path().join("posctl.exe"), ports: ctx.ports, roots, activate: std::rc::Rc::new(|_, _, _| Ok(())) };
    let mut w = RestoreWork::new(env, ctx, Deps::real(), Arc::new(AtomicU64::new(u64::MAX)), None, (2, "20260202000002".into()));
    w.close_previous_copy(prev);
    assert!(w.warnings().is_empty(), "{:?}", w.warnings());
    for r in ["appr", "other", "Odd Role"] {
        assert_eq!(can(r, prev), "f", "{r} is locked out of the old store");
    }
    assert_eq!(can("postgres", prev), "t", "the owner keeps access");
    assert_eq!(can("appr", "postgres"), "t", "the live database is untouched");
    // anything that is not a restore copy is never revoked
    w.close_previous_copy("postgres");
    assert_eq!(can("appr", "postgres"), "t");
}
