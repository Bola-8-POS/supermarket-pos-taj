//! The files that describe a provisioned store: `conf\posctl.json` (server only),
//! `state\provisioned.json` (its presence means "provisioned"), `client\store.env` (the mode and
//! backend contract the app reads, conventions section 5) and the data-root decision. It must
//! never hold a secret: these files are read by the tills' installer and by support.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::envelope::{Code, PosctlError};
use crate::paths::Roots;
use crate::util::write_atomic;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PosctlJson {
    pub schema: u32,
    pub mode: String,
    pub store_id: String,
    pub ports: PortsCfg,
    pub server: ServerCfg,
    pub pack: PackCfg,
    pub maintenance: MaintenanceCfg,
    /// review fix (Plan 12, C-12b): sections this version does not know (`backup`, `cloud`, ...) are kept
    /// verbatim across `load` + `save`, so a later plan's settings survive a `posctl` that rewrites the file.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortsCfg {
    pub base: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerCfg {
    pub host: String,
    pub extra_sans: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackCfg {
    pub current: String,
    pub previous: Option<String>,
    pub feed_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceCfg {
    pub max_seconds: u32,
    /// The local-time window `update --window-aware` may fence the tills in; absent means 01:00-05:00 (see `update::window`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<MaintenanceWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MaintenanceWindow {
    pub start: String,
    pub end: String,
}

impl PosctlJson {
    /// review fix: `mode` is a parameter, not a constant: `"offline-only"` for a normal provision and
    /// `"cloud"` for `provision --prepare-for-switch` (the mode stays `cloud` until Plan 09's switch commits).
    pub fn new(mode: &str, store_id: &str, base: u16, host: &str, pack_version: &str) -> Self {
        PosctlJson {
            schema: 1,
            mode: mode.into(),
            store_id: store_id.into(),
            ports: PortsCfg { base },
            server: ServerCfg { host: host.into(), extra_sans: vec![] },
            pack: PackCfg { current: pack_version.into(), previous: None, feed_url: None },
            maintenance: MaintenanceCfg { max_seconds: 900, window: None },
            extra: Default::default(),
        }
    }
    pub fn load(roots: &Roots) -> Result<Option<Self>, String> {
        match std::fs::read_to_string(roots.posctl_json()) {
            Ok(t) => serde_json::from_str(&t).map(Some).map_err(|e| format!("posctl.json is not valid: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn save(&self, roots: &Roots) -> std::io::Result<()> {
        write_atomic(&roots.posctl_json(), serde_json::to_string_pretty(self).map_err(std::io::Error::other)?.as_bytes())
    }
}

/// review fix: takes `mode` (`"cloud"` under `--prepare-for-switch`), `first_admin_id` is `None` when the
/// first-admin step was skipped (serialized as JSON `null`), and `shutdown_timeout_previous` records the
/// `WaitToKillServiceTimeout` text to restore on `unprovision` (`""` = the value was absent; `null` = left unchanged).
#[allow(clippy::too_many_arguments)]
pub fn provisioned_json(mode: &str, store_id: &str, base: u16, host: &str, pack_version: &str, first_admin_id: Option<&str>, shutdown_timeout_previous: Option<&str>, at: &str) -> Value {
    json!({
        "schema": 1, "storeId": store_id, "provisionedAt": at,
        "posctlVersion": crate::envelope::POSCTL_VERSION, "packVersion": pack_version,
        "basePort": base, "serverHost": host, "mode": mode,
        "firstAdminId": first_admin_id,
        "shutdownTimeoutPrevious": shutdown_timeout_previous
    })
}

/// Host names the server may be reached by: an RFC 1123 name (single label or dotted) or an
/// RFC 1918 IPv4 address. No wildcard, no public IP, no scheme, no port.
pub fn validate_server_host(h: &str) -> Result<String, String> {
    let host = h.trim().to_lowercase();
    if host.is_empty() || host.len() > 253 {
        return Err("the server host is empty or too long".into());
    }
    // A last label that is all digits or `0x..` is how a resolver reads a numeric address (inet_aton accepts
    // `0x8080808`, `1.2.3.0x8`, `010.1.1.1` as octal), so such a name is an address and must be a strict dotted quad.
    let last = host.rsplit('.').next().unwrap_or("");
    if last.chars().all(|c| c.is_ascii_digit()) || last.starts_with("0x") {
        let parts: Vec<&str> = host.split('.').collect();
        let octet = |p: &str| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && (p == "0" || !p.starts_with('0'));
        let o: Vec<u8> = if parts.len() == 4 && parts.iter().all(|p| octet(p)) { parts.iter().filter_map(|p| p.parse().ok()).collect() } else { vec![] };
        if o.len() != 4 {
            return Err(format!("'{host}' is not an IPv4 address in plain dotted form (no hex, octal or short forms)"));
        }
        let private = o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168);
        return if private { Ok(host) } else { Err(format!("'{host}' is not a private (RFC 1918) address")) };
    }
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if host.split('.').all(label_ok) {
        Ok(host)
    } else {
        Err(format!("'{host}' is not a valid host name (letters, digits and hyphens only)"))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DataDecision {
    Fresh,
    Resume,
}

/// The decision about an existing data root (S9 REVIEW I2). `owner_trusted` = the folder's owner
/// is Administrators or SYSTEM. Returns the refusal code and message otherwise.
pub fn classify_data_root(exists: bool, owner_trusted: bool, has_provisioned: bool, has_unprovisioned: bool, has_journal: bool, resume: bool) -> Result<DataDecision, (Code, String)> {
    if !exists {
        return Ok(DataDecision::Fresh);
    }
    if !owner_trusted {
        return Err((Code::Precondition, "the data folder already exists and is not owned by Administrators or SYSTEM; it may have been planted. Remove it as an administrator and run provision again".into()));
    }
    if has_provisioned {
        return Err((Code::AlreadyProvisioned, "this PC is already provisioned".into()));
    }
    if has_unprovisioned {
        return Err((Code::Precondition, "the data folder was kept by unprovision --keep-data; re-provisioning onto it is not supported. Restore from a backup, or delete it with unprovision --delete-data".into()));
    }
    if has_journal && resume {
        return Ok(DataDecision::Resume);
    }
    if has_journal {
        return Err((Code::RecoveryNeeded, "a previous provision was interrupted; run provision --resume, or unprovision --delete-data to start over".into()));
    }
    Err((Code::Precondition, "the data folder already exists but is not a posctl installation".into()))
}

/// Conventions 17.E: while `state\update\journal.json` exists an update, switch or restore is in flight or
/// interrupted, and a lifecycle command could un-fence the tills by accident. A plain file check:
/// `RecoveryNeeded` (exit 17). Provisioning keeps its own `provision-journal.json`, which never blocks.
/// FR19 fail-closed: only a definite NotFound means "no operation". Any other answer (the folder is SYSTEM + Administrators only,
/// so a non-elevated caller gets "access denied") is treated as "an operation may be in progress", with the way out in the message.
pub fn guard_no_operation(roots: &Roots) -> Result<(), PosctlError> { guard_no_operation_with(roots, &|p: &std::path::Path| p.try_exists()) }

/// `guard_no_operation` with the existence probe injected (the test seam for an access-denied folder).
pub fn guard_no_operation_with(roots: &Roots, exists: &dyn Fn(&std::path::Path) -> std::io::Result<bool>) -> Result<(), PosctlError> {
    for p in [roots.journal(), roots.legacy_of(&roots.journal())] {
        match exists(&p) {
            Ok(false) => {}
            Ok(true) => return Err(PosctlError::new(
                Code::RecoveryNeeded,
                "an update, switch or restore is in progress or was interrupted (state\\update\\journal.json exists); finish or recover it first",
            )),
            Err(e) => return Err(PosctlError::new(
                Code::RecoveryNeeded,
                format!("cannot tell whether an update, switch or restore is in progress ({}: {e}); {}", p.display(), crate::ops::journal::NEEDS_ELEVATION),
            )),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posctl_json_round_trips_with_the_documented_keys() {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().join("d"), dir.path().join("p"));
        std::fs::create_dir_all(roots.conf()).unwrap();
        let c = PosctlJson::new("offline-only", "11111111-2222-4333-8444-555555555555", 47300, "shop-pc", "1.0.0-r1");
        c.save(&roots).unwrap();
        assert_eq!(PosctlJson::load(&roots).unwrap(), Some(c));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(roots.posctl_json()).unwrap()).unwrap();
        assert_eq!(v["schema"], 1);
        assert_eq!(v["mode"], "offline-only");
        assert_eq!(v["ports"]["base"], 47300);
        assert_eq!(v["server"]["host"], "shop-pc");
        assert_eq!(v["pack"]["current"], "1.0.0-r1");
        assert_eq!(v["maintenance"]["maxSeconds"], 900);
    }

    // review fix (Plan 12, C-12b): `save` keeps sections it does not know.
    #[test]
    fn save_keeps_sections_this_version_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().join("d"), dir.path().join("p"));
        std::fs::create_dir_all(roots.conf()).unwrap();
        PosctlJson::new("offline-only", "11111111-2222-4333-8444-555555555555", 47300, "shop-pc", "1.0.0-r1").save(&roots).unwrap();
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(roots.posctl_json()).unwrap()).unwrap();
        v["backup"] = json!({"enabled": true, "keep": 7});
        v["cloud"] = json!({"x": [1, 2]});
        std::fs::write(roots.posctl_json(), serde_json::to_string(&v).unwrap()).unwrap();
        let mut c = PosctlJson::load(&roots).unwrap().unwrap();
        c.pack.current = "1.0.1-r1".into();
        c.save(&roots).unwrap();
        let after: Value = serde_json::from_str(&std::fs::read_to_string(roots.posctl_json()).unwrap()).unwrap();
        assert_eq!(after["backup"], json!({"enabled": true, "keep": 7}));
        assert_eq!(after["cloud"], json!({"x": [1, 2]}));
        assert_eq!(after["pack"]["current"], "1.0.1-r1");
    }

    #[test]
    fn prepare_for_switch_keeps_the_mode_cloud() {
        let c = PosctlJson::new("cloud", "id", 47300, "shop-pc", "1.0.0-r1");
        assert_eq!(c.mode, "cloud");
        let v = provisioned_json("cloud", "id", 47300, "shop-pc", "1.0.0-r1", None, Some("5000"), "2026-10-02T12:00:00Z");
        assert_eq!((v["mode"].as_str(), v["firstAdminId"].is_null(), v["shutdownTimeoutPrevious"].as_str()), (Some("cloud"), true, Some("5000")));
    }

    #[test]
    fn hosts_are_validated() {
        assert_eq!(validate_server_host("localhost").unwrap(), "localhost"); // review fix: Plan 05b's `dev new` passes "localhost", not 127.0.0.1
        assert!(validate_server_host("127.0.0.1").is_err(), "loopback IPv4 is not RFC 1918");
        assert_eq!(validate_server_host(" Shop-PC ").unwrap(), "shop-pc");
        assert_eq!(validate_server_host("shop.local").unwrap(), "shop.local");
        assert_eq!(validate_server_host("192.168.1.20").unwrap(), "192.168.1.20");
        assert_eq!(validate_server_host("172.20.0.9").unwrap(), "172.20.0.9");
        assert_eq!(validate_server_host("10.0.0.5").unwrap(), "10.0.0.5");
        assert_eq!(validate_server_host("0xshop.local").unwrap(), "0xshop.local"); // `0x` only matters on the LAST label
        for bad in ["8.8.8.8", "172.32.0.1", "*.shop", "shop pc", "https://shop", "shop:47304", "", "-x", "1.2.3", "a..b", "300.1.1.1", "0x8080808", "1.2.3.0x8", "010.1.1.1", "10.01.1.1", "2130706433", "10.0.0.0x1", "0x0a.1.1.1", "10.1.1.1.1"] {
            assert!(validate_server_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn data_root_decisions() {
        use DataDecision::*;
        let c = classify_data_root;
        assert_eq!(c(false, false, false, false, false, false), Ok(Fresh));
        assert_eq!(c(true, false, true, false, true, true).unwrap_err().0, Code::Precondition, "an untrusted owner is refused whatever it contains");
        assert_eq!(c(true, true, true, false, true, false).unwrap_err().0, Code::AlreadyProvisioned);
        assert_eq!(c(true, true, false, true, false, false).unwrap_err().0, Code::Precondition);
        assert_eq!(c(true, true, false, false, true, true), Ok(Resume));
        assert_eq!(c(true, true, false, false, true, false).unwrap_err().0, Code::RecoveryNeeded);
        assert_eq!(c(true, true, false, false, false, true).unwrap_err().0, Code::Precondition, "--resume needs a journal");
        assert_eq!(c(true, true, false, false, false, false).unwrap_err().0, Code::Precondition);
    }

    // Pre-flight ruling (moved from Task 11): while `state\update\journal.json` exists an update, switch or
    // restore is in flight or interrupted, and a lifecycle command could un-fence the tills.
    #[test]
    fn an_operation_journal_blocks_with_exit_17() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        assert!(guard_no_operation(&roots).is_ok());
        std::fs::write(roots.journal(), "{}").unwrap();
        let e = guard_no_operation(&roots).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::RecoveryNeeded, 17));
    }

    #[test]
    fn a_journal_left_by_an_older_posctl_in_state_also_blocks() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        std::fs::write(roots.legacy_of(&roots.journal()), "{}").unwrap();
        assert_eq!(guard_no_operation(&roots).unwrap_err().code, Code::RecoveryNeeded);
    }

    // FR19 fail closed: a folder the caller cannot look into is "state unknown", not "nothing in progress".
    #[test]
    fn an_unreadable_update_folder_blocks_with_exit_17_and_says_to_run_elevated() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.update_dir()).unwrap();
        let denied = |_: &std::path::Path| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        let e = guard_no_operation_with(&roots, &denied).unwrap_err();
        assert_eq!((e.code, e.code.exit()), (Code::RecoveryNeeded, 17));
        assert!(e.message.contains("elevated"), "{}", e.message);
        // only the NEW location being denied is enough; the old one answering "absent" does not clear it
        let new_denied = |p: &std::path::Path| if p == roots.journal() { Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) } else { Ok(false) };
        assert!(guard_no_operation_with(&roots, &new_denied).is_err());
    }

    #[test]
    fn the_provision_journal_does_not_block_lifecycle_commands() {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        std::fs::create_dir_all(roots.state()).unwrap();
        std::fs::write(roots.provision_journal(), "{}").unwrap();
        assert!(guard_no_operation(&roots).is_ok());
    }
}
