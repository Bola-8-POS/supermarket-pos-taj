//! The `backup` section of `conf\posctl.json` (conventions §5.2). Other keys are never touched.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use super::result::{BResult, BackupError};
use super::util::write_atomic;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DestKind {
    /// A second local device (USB drive, second internal drive) or a UNC share, as a restic repository folder.
    Device,
    /// A restic S3 repository on Cloudflare R2 (Plan 12 supplies the repository URL and `r2.env`).
    R2,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub name: String,
    pub kind: DestKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume_serial: Option<String>,
    pub added_at: i64,
    /// Keys this version does not know survive a load + save (same pattern as `PosctlJson::extra`).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Destination {
    /// What restic receives as `--repo`.
    pub fn location(&self) -> &str {
        match self.kind {
            DestKind::Device => self.path.as_deref().unwrap_or(""),
            DestKind::R2 => self.repo.as_deref().unwrap_or(""),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupConfig {
    pub enabled: bool,
    pub rto_budget_seconds: u64,
    pub destinations: Vec<Destination>,
    /// Keys this version does not know survive a load + save (same pattern as `PosctlJson::extra`).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self { enabled: true, rto_budget_seconds: 1800, destinations: Vec::new(), extra: Default::default() }
    }
}

pub fn valid_dest_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && n != "local"
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn load(conf: &Path) -> BResult<BackupConfig> {
    let text = match std::fs::read_to_string(conf) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(BackupError::not_provisioned()),
        Err(e) => return Err(e.into()),
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| BackupError::error(format!("posctl.json is not valid JSON: {e}")))?;
    match v.get("backup") {
        None => Ok(BackupConfig::default()),
        Some(b) => serde_json::from_value(b.clone()).map_err(|e| BackupError::error(format!("posctl.json backup section is invalid: {e}"))),
    }
}

pub fn save(conf: &Path, cfg: &BackupConfig) -> BResult<()> {
    let text = std::fs::read_to_string(conf)?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| BackupError::error(format!("posctl.json is not valid JSON: {e}")))?;
    if !v.is_object() {
        return Err(BackupError::error("posctl.json is not a JSON object"));
    }
    v["backup"] = serde_json::to_value(cfg).map_err(|e| BackupError::error(e.to_string()))?;
    let out = serde_json::to_string_pretty(&v).map_err(|e| BackupError::error(e.to_string()))?;
    write_atomic(conf, out.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_backup_section_means_defaults() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("posctl.json");
        std::fs::write(&p, r#"{"schema":1,"mode":"offline-only"}"#).unwrap();
        let c = load(&p).unwrap();
        assert!(c.enabled);
        assert_eq!(c.rto_budget_seconds, 1800);
        assert!(c.destinations.is_empty());
    }

    #[test]
    fn a_missing_file_is_not_provisioned() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(&d.path().join("none.json")).unwrap_err().code, crate::envelope::Code::NotProvisioned);
    }

    #[test]
    fn save_keeps_every_other_key() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("posctl.json");
        std::fs::write(&p, r#"{"schema":1,"ports":{"base":47300},"cloud":{"tunnel":false}}"#).unwrap();
        let mut c = load(&p).unwrap();
        c.destinations.push(Destination { name: "usb-e".into(), kind: DestKind::Device, path: Some(r"E:\SupermarketPOS-Backup".into()), repo: None, volume_serial: Some("ABCD-1234".into()), added_at: 5, extra: Default::default() });
        save(&p, &c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["ports"]["base"], 47300);
        assert_eq!(v["cloud"]["tunnel"], false);
        assert_eq!(v["backup"]["destinations"][0]["kind"], "device");
        assert_eq!(v["backup"]["destinations"][0]["volumeSerial"], "ABCD-1234");
        assert_eq!(load(&p).unwrap(), c);
    }

    #[test]
    fn destination_names_are_short_lowercase_and_never_local() {
        assert!(valid_dest_name("usb-e") && valid_dest_name("r2") && valid_dest_name("share-1"));
        assert!(!valid_dest_name("local") && !valid_dest_name("") && !valid_dest_name("USB") && !valid_dest_name("a b"));
        assert!(!valid_dest_name(&"x".repeat(33)));
    }

    #[test]
    fn unknown_keys_in_the_backup_section_and_in_a_destination_survive_a_save() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("posctl.json");
        std::fs::write(&p, r#"{"schema":1,"backup":{"enabled":false,"futureKnob":7,"destinations":[{"name":"usb-e","kind":"device","path":"E:\\b","addedAt":1,"label":"office"}]}}"#).unwrap();
        let mut c = load(&p).unwrap();
        assert!(!c.enabled);
        c.rto_budget_seconds = 900;
        save(&p, &c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["backup"]["futureKnob"], 7);
        assert_eq!(v["backup"]["destinations"][0]["label"], "office");
        assert_eq!(v["backup"]["rtoBudgetSeconds"], 900);
    }

    #[test]
    fn an_unknown_destination_kind_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("posctl.json");
        std::fs::write(&p, r#"{"schema":1,"backup":{"destinations":[{"name":"x","kind":"ftp","addedAt":1}]}}"#).unwrap();
        assert_eq!(load(&p).unwrap_err().code, crate::envelope::Code::Error);
    }

    #[test]
    fn save_refuses_invalid_json_and_a_non_object_without_touching_the_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("posctl.json");
        for bad in ["{not json", "[1,2]"] {
            std::fs::write(&p, bad).unwrap();
            assert!(save(&p, &BackupConfig::default()).is_err());
            assert_eq!(std::fs::read_to_string(&p).unwrap(), bad);
        }
    }
}
