//! `posctl unprovision [--keep-data] [--delete-data --confirm <token>]`.
//!
//! Default and `--keep-data`: stop and unregister the services (and whatever later plans
//! register through `TEARDOWN`), leave the data folder untouched and mark it `unprovisioned`.
//! Re-provisioning onto kept data is not supported in v1 (provision refuses it): restore from a
//! backup, or delete. `--delete-data` removes the whole data folder, including the database and
//! the secrets, and needs `--confirm <first 8 characters of the store id>`.
//!
//! The data root is judged on one handle (`layout::check_existing_data_root`) BEFORE the lock is
//! taken and before anything is touched. It must never follow a reparse point while deleting, and
//! never touch a service before the confirmation token is right.

use serde_json::{json, Value};

use crate::acl;
use crate::envelope::{Code, Outcome, PosctlError};
use crate::layout;
use crate::ops::lock::{acquire_for, LockMode};
use crate::paths::Roots;
use crate::runtime::Runtime;
use crate::services::Component;
use crate::sys;
use crate::util::{now_rfc3339, random_uuid_v4, write_atomic};

/// Teardown work owned by other plans (firewall rule and tasks in 05b, tunnel in Plan 12). A failure is reported but
/// does not stop the rest. The scheduled tasks go FIRST: the health task would otherwise run into the stopping stack
/// and gate (or write a status for) services that are being removed. The rest runs after the services are gone.
pub type TeardownFn = fn(&Roots) -> Result<(), String>;
pub const TEARDOWN_BEFORE_SERVICES: &[(&str, TeardownFn)] = &[("scheduled tasks", teardown_tasks)];
pub const TEARDOWN: &[(&str, TeardownFn)] = &[("firewall rule", teardown_firewall), ("store certificate authority trust", teardown_trust)];

// A dev root never created either, and must never touch the real ones.
fn teardown_firewall(roots: &Roots) -> Result<(), String> {
    if roots.dev { Ok(()) } else { crate::net::remove_rule() }
}

/// Provision made this PC trust the store's own certificate authority (`store_trust`); the root leaves with the store. Only the
/// root the data folder holds is removed, and only if it is trusted now. No root file = nothing was ever trusted by this store.
fn teardown_trust(roots: &Roots) -> Result<(), String> {
    use crate::pki::trust::{CertutilStore, RootStore};
    if roots.dev {
        return Ok(());
    }
    let Ok(root) = crate::pki::read_root(&roots.data) else { return Ok(()) };
    let der = crate::pki::pem_to_der(&root.pem)?;
    if CertutilStore.contains(&der, &root.sha256)? {
        CertutilStore.remove(&der)?;
    }
    Ok(())
}

fn teardown_tasks(roots: &Roots) -> Result<(), String> {
    if roots.dev { Ok(()) } else { crate::tasks::remove().map(|_| ()) }
}

#[derive(Debug, Clone, Default)]
pub struct UnprovisionArgs {
    pub delete_data: bool,
    pub confirm: Option<String>,
}

pub fn confirm_token(store_id: &str) -> String {
    store_id.chars().filter(|c| *c != '-').take(8).collect()
}

/// Three sources, in order. Before `finalize` neither `provisioned.json` nor `unprovisioned.json`
/// exists, yet provision's own error messages tell the owner to run `unprovision --delete-data`; so
/// `provision-journal.json` `params.storeId` is the third source. (`unprovisioned.json` also carries
/// the store id, written below, so a later `--delete-data` still works.)
fn read_store_id(roots: &Roots) -> Option<String> {
    let from = |p: std::path::PathBuf, pointer: &str| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.pointer(pointer).and_then(Value::as_str).map(String::from));
    from(roots.provisioned_json(), "/storeId").or_else(|| from(roots.unprovisioned_json(), "/storeId")).or_else(|| from(roots.provision_journal(), "/params/storeId"))
}

/// `before`, then every service (reverse order), then `after`; returns what failed.
fn tear_down(roots: &Roots, rt: &dyn Runtime, before: &[(&str, TeardownFn)], after: &[(&str, TeardownFn)]) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    for (name, f) in before {
        if let Err(e) = f(roots) {
            problems.push(format!("{name}: {e}"));
        }
    }
    for c in Component::ALL.iter().rev() {
        if let Err(e) = rt.unregister(*c) {
            problems.push(format!("{}: {e}", c.service_name()));
        }
    }
    for (name, f) in after {
        if let Err(e) = f(roots) {
            problems.push(format!("{name}: {e}"));
        }
    }
    problems
}

pub fn run(roots: &Roots, rt: &dyn Runtime, args: &UnprovisionArgs) -> Result<Outcome, PosctlError> {
    if !roots.dev && !sys::is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "unprovision must run as an administrator"));
    }
    // The data folder may be gone (deleted by hand) while the auto-start services still exist: they are removed
    // anyway. Only `--delete-data` has nothing to act on.
    let has_data = roots.data.exists();
    if !has_data && args.delete_data {
        return Err(PosctlError::new(Code::Usage, "there is no data folder to delete; run unprovision without --delete-data to remove the services"));
    }
    let store_id = read_store_id(roots);
    if args.delete_data {
        let want = store_id.as_deref().map(confirm_token);
        match (&args.confirm, &want) {
            (Some(got), Some(w)) if got == w => {}
            (_, Some(w)) => return Err(PosctlError::new(Code::Usage, format!("--delete-data destroys the database and every secret; pass --confirm {w}"))),
            (_, None) => return Err(PosctlError::new(Code::Usage, "the store id is unknown (no provisioned.json); remove the folder by hand if you are sure")),
        }
    }
    // Handle-based trust check (owner, reparse point) before the lock and before any service is touched.
    if has_data {
        layout::check_existing_data_root(roots)?;
    }
    if args.delete_data && roots.dev {
        // a production root was scanned by the call above; a dev root is scanned here, so deletion never meets a link
        if let Some(hit) = acl::find_reparse_point(&roots.data)? {
            return Err(PosctlError::precondition(format!("{} is a reparse point (junction or symlink); refusing to delete through it", hit.display())));
        }
    }
    let lock = if has_data { Some(acquire_for(roots, LockMode::Exclusive, "unprovision", &random_uuid_v4().map_err(PosctlError::error)?, std::time::Duration::from_secs(0))?) } else { None };

    let mut problems = tear_down(roots, rt, TEARDOWN_BEFORE_SERVICES, TEARDOWN);
    // put `WaitToKillServiceTimeout` back to what it was before provision raised it
    // (`state\shutdown-timeout.json`; nothing to do when the file is absent)
    let timeout_file = roots.state().join("shutdown-timeout.json");
    if let Some(prev) = std::fs::read_to_string(&timeout_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("previous").and_then(Value::as_str).map(String::from)) {
        match rt.restore_shutdown_timeout(Some(&prev)) {
            // restored once: a later `--delete-data` after `--keep-data` must not overwrite a value the owner changed since
            Ok(()) => {
                let _ = std::fs::remove_file(&timeout_file);
            }
            Err(e) => problems.push(format!("WaitToKillServiceTimeout: {e}")),
        }
    }
    if !problems.is_empty() {
        return Err(PosctlError::error(format!("could not remove everything: {}", problems.join("; "))).with_data(json!({"problems": problems})));
    }

    if args.delete_data {
        drop(lock);
        // `state\` holds the store id the confirmation token comes from: it goes last, so a deletion that fails
        // halfway can be repeated. `remove_dir_all` removes a link as a link and never descends into its target.
        let state = roots.state();
        for entry in std::fs::read_dir(&roots.data)? {
            let path = entry?.path();
            if path == state {
                continue;
            }
            if std::fs::symlink_metadata(&path)?.is_file() { std::fs::remove_file(&path)? } else { std::fs::remove_dir_all(&path)? }
        }
        std::fs::remove_dir_all(&state)?;
        std::fs::remove_dir_all(&roots.data)?;
        return Ok(Outcome::ok("unprovisioned and the data folder was deleted", json!({"dataDeleted": true})));
    }
    if !has_data {
        return Ok(Outcome::ok("unprovisioned; there was no data folder", json!({"dataDeleted": false, "dataRoot": roots.data.display().to_string()})));
    }
    write_atomic(&roots.unprovisioned_json(), serde_json::to_string_pretty(&json!({"schema": 1, "storeId": store_id, "unprovisionedAt": now_rfc3339()}))?.as_bytes())?;
    let _ = std::fs::remove_file(roots.provisioned_json());
    Ok(Outcome::ok("unprovisioned; the data folder was kept", json!({"dataDeleted": false, "dataRoot": roots.data.display().to_string()})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl::Grant;
    use std::cell::RefCell;
    use std::path::Path;
    use std::time::Duration;

    #[derive(Default)]
    struct Fake {
        unregistered: RefCell<Vec<Component>>,
        restored: RefCell<Vec<Option<String>>>,
    }
    impl Runtime for Fake {
        fn name(&self) -> &'static str { "fake" }
        fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { Ok(()) }
        fn stop(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn set_functions_env(&self, _: &Roots, _: &[String]) -> Result<(), String> { Ok(()) }
        fn unregister(&self, c: Component) -> Result<(), String> { self.unregistered.borrow_mut().push(c); LOG.with(|l| l.borrow_mut().push("service")); Ok(()) }
        fn protect_file(&self, _: &Path, _: &[Grant]) -> Result<(), String> { Ok(()) }
        fn restore_shutdown_timeout(&self, previous: Option<&str>) -> Result<(), String> { self.restored.borrow_mut().push(previous.map(String::from)); Ok(()) }
    }

    // a half-provisioned PC (no provisioned.json yet) can still be cleaned up with posctl.
    #[test]
    fn a_root_that_holds_only_the_journal_can_be_deleted_with_its_token() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.state()).unwrap();
        std::fs::write(roots.provision_journal(), r#"{"params":{"storeId":"11111111-2222-4333-8444-555555555555"}}"#).unwrap();
        assert_eq!(read_store_id(&roots).as_deref(), Some("11111111-2222-4333-8444-555555555555"));
        let rt = Fake::default();
        run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) }).unwrap();
        assert!(!roots.data.exists());
    }

    // the WaitToKillServiceTimeout recorded by provision is restored on unprovision.
    #[test]
    fn unprovision_restores_the_recorded_shutdown_timeout() {
        let (_d, roots) = provisioned_root();
        std::fs::write(roots.state().join("shutdown-timeout.json"), r#"{"previous":"5000"}"#).unwrap();
        let rt = Fake::default();
        run(&roots, &rt, &UnprovisionArgs::default()).unwrap();
        assert_eq!(*rt.restored.borrow(), vec![Some("5000".to_string())]);
        assert!(!roots.state().join("shutdown-timeout.json").exists(), "restored once only");
    }

    fn provisioned_root() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.state()).unwrap();
        std::fs::write(roots.provisioned_json(), "{\"storeId\":\"11111111-2222-4333-8444-555555555555\"}").unwrap();
        std::fs::create_dir_all(roots.secrets()).unwrap();
        std::fs::write(roots.secrets().join("jwt-secret.txt"), "x").unwrap();
        (d, roots)
    }

    #[test]
    fn keep_data_unregisters_in_reverse_order_and_leaves_the_data() {
        let (_d, roots) = provisioned_root();
        let rt = Fake::default();
        let out = run(&roots, &rt, &UnprovisionArgs::default()).unwrap();
        assert_eq!(out.data["dataDeleted"], false);
        let order = rt.unregistered.borrow().clone();
        assert_eq!(order, vec![Component::Gateway, Component::Functions, Component::Rest, Component::Auth, Component::Postgres]);
        assert!(roots.secrets().join("jwt-secret.txt").exists());
        assert!(!roots.provisioned_json().exists() && roots.unprovisioned_json().exists());
    }

    #[test]
    fn delete_data_needs_the_confirmation_token() {
        let (_d, roots) = provisioned_root();
        let rt = Fake::default();
        assert_eq!(confirm_token("11111111-2222-4333-8444-555555555555"), "11111111");
        let no = run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: None }).unwrap_err();
        assert_eq!(no.code, Code::Usage);
        assert!(no.message.contains("--confirm 11111111"));
        assert!(rt.unregistered.borrow().is_empty(), "nothing is touched before the confirmation is right");
        let wrong = run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("00000000".into()) }).unwrap_err();
        assert_eq!(wrong.code, Code::Usage);
        assert!(roots.data.exists());
        run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) }).unwrap();
        assert!(!roots.data.exists());
    }

    #[test]
    fn a_kept_folder_can_still_be_deleted_afterwards() {
        let (_d, roots) = provisioned_root();
        let rt = Fake::default();
        run(&roots, &rt, &UnprovisionArgs::default()).unwrap();
        run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) }).unwrap();
        assert!(!roots.data.exists());
    }

    // A3: the data folder was deleted by hand but five auto-start services still exist: unprovision must remove them
    #[test]
    fn without_a_data_folder_the_services_are_still_unregistered_and_only_delete_data_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("missing"), d.path().join("prog"));
        let rt = Fake::default();
        let e = run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) }).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert!(rt.unregistered.borrow().is_empty(), "a refused command touches nothing");
        let out = run(&roots, &rt, &UnprovisionArgs::default()).unwrap();
        assert_eq!(out.data["dataDeleted"], false);
        assert_eq!(rt.unregistered.borrow().len(), 5);
        assert!(!roots.data.exists(), "no data folder is created by unprovision");
    }

    // A5: the store id lives in state\; if deleting the rest fails, a rerun must still know the token
    #[cfg(windows)]
    #[test]
    fn a_half_failed_delete_data_keeps_state_so_a_rerun_can_finish() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_d, roots) = provisioned_root();
        let held = std::fs::OpenOptions::new().create(true).truncate(true).write(true).share_mode(0).open(roots.data.join("zz-held.bin")).unwrap();
        let rt = Fake::default();
        let args = UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) };
        assert!(run(&roots, &rt, &args).is_err());
        assert!(roots.provisioned_json().exists(), "the state folder is removed last");
        drop(held);
        run(&roots, &rt, &args).unwrap();
        assert!(!roots.data.exists());
    }

    #[test]
    fn a_held_lock_refuses_before_any_service_is_touched() {
        let (_d, roots) = provisioned_root();
        let held = acquire_for(&roots, LockMode::Exclusive, "update", "op", Duration::from_secs(0)).unwrap();
        let rt = Fake::default();
        assert_eq!(run(&roots, &rt, &UnprovisionArgs::default()).unwrap_err().code, Code::LockHeld);
        assert!(rt.unregistered.borrow().is_empty());
        drop(held);
    }

    // deletion never goes through a link: the target of a junction inside the data root survives, and
    // posctl refuses before touching a service.
    #[cfg(windows)]
    #[test]
    fn delete_data_refuses_a_data_root_holding_a_junction_and_spares_its_target() {
        let (d, roots) = provisioned_root();
        let target = d.path().join("outside");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "precious").unwrap();
        let link = roots.data.join("link");
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success());
        let rt = Fake::default();
        let e = run(&roots, &rt, &UnprovisionArgs { delete_data: true, confirm: Some("11111111".into()) }).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(rt.unregistered.borrow().is_empty());
        assert!(target.join("keep.txt").exists());
        assert!(roots.data.exists());
    }

    #[test]
    fn the_teardown_tables_name_the_tasks_before_the_services_and_the_firewall_rule_after() {
        let first: Vec<_> = TEARDOWN_BEFORE_SERVICES.iter().map(|(n, _)| *n).collect();
        let after: Vec<_> = TEARDOWN.iter().map(|(n, _)| *n).collect();
        assert_eq!((first, after), (vec!["scheduled tasks"], vec!["firewall rule", "store certificate authority trust"]));
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        for (n, f) in TEARDOWN_BEFORE_SERVICES.iter().chain(TEARDOWN) {
            f(&roots).unwrap_or_else(|e| panic!("{n} reached the host for a dev root: {e}"));
        }
    }

    #[test]
    fn a_store_that_never_made_a_ca_root_has_nothing_to_untrust() {
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false; // the certificate store is only reached when a root file exists, which it does not
        assert!(teardown_trust(&roots).is_ok());
    }

    thread_local!(static LOG: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) });
    fn log_tasks(_: &Roots) -> Result<(), String> {
        LOG.with(|l| l.borrow_mut().push("tasks"));
        Ok(())
    }
    fn log_rule(_: &Roots) -> Result<(), String> {
        LOG.with(|l| l.borrow_mut().push("rule"));
        Err("rule gone wrong".into())
    }

    #[test]
    fn scheduled_tasks_are_removed_before_the_first_service_stops_and_a_failure_does_not_stop_the_rest() {
        let (_d, roots) = provisioned_root();
        let rt = Fake::default();
        let problems = tear_down(&roots, &rt, &[("scheduled tasks", log_tasks)], &[("firewall rule", log_rule)]);
        LOG.with(|l| assert_eq!(*l.borrow(), ["tasks", "service", "service", "service", "service", "service", "rule"]));
        assert_eq!(problems, ["firewall rule: rule gone wrong"]);
    }
}
