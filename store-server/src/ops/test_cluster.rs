//! A throwaway real cluster from the pack's Postgres, on a test port (47420-47429, native slot 2 per conventions v1.5). Needs POS_PACK_DIR.
//! Only the #[ignore]d `real_` tests use it, and they run in Windows Sandbox, never on the developer PC (owner rule).
use crate::ops::swap::PsqlAdmin;
use std::path::PathBuf;
use std::process::{Child, Command};

pub struct TestCluster { pub dir: tempfile::TempDir, pub admin: PsqlAdmin, child: Child }

impl TestCluster {
    pub fn start(slot: u16) -> TestCluster {
        let pack = PathBuf::from(std::env::var("POS_PACK_DIR").expect("POS_PACK_DIR (unpacked dev pack) is required"));
        let bin = pack.join("pg").join("bin");
        let dir = tempfile::tempdir().unwrap();
        let port = 47420 + slot; // slot 2 block 47420-47429 (slots 0-2 map to 47420-47422); never 47490+ (Plan 12's slot 9)
        let pw = crate::util::random_uuid_v4().unwrap().replace('-', "");
        let pwfile = dir.path().join("pw.txt");
        std::fs::write(&pwfile, &pw).unwrap();
        let pgpass = dir.path().join("pgpass.conf");
        std::fs::write(&pgpass, format!("127.0.0.1:{port}:*:supabase_admin:{pw}\n")).unwrap();
        let data = dir.path().join("data");
        let st = Command::new(bin.join("initdb.exe"))
            .args(["-D", &data.display().to_string(), "--locale-provider=icu", "--icu-locale=es-MX", "--locale=C", "--encoding=UTF8",
                   "--data-checksums", "--auth=scram-sha-256", "--username=supabase_admin", &format!("--pwfile={}", pwfile.display())])
            .status().unwrap();
        assert!(st.success(), "initdb failed");
        let mut child = Command::new(bin.join("postgres.exe"))
            .args(["-D", &data.display().to_string(), "-p", &port.to_string(), "-c", "listen_addresses=127.0.0.1"]).spawn().unwrap();
        let admin = PsqlAdmin::new(bin.join("psql.exe"), port, pgpass);
        for _ in 0..60 {
            if admin.scalar("template1", "SELECT 1").is_ok() { return TestCluster { dir, admin, child }; }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("test cluster did not start");
    }
}
impl Drop for TestCluster { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
