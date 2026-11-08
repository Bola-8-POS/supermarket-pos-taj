//! The operation journal (`state\update\journal.json`, or `provision-journal.json` for provisioning) that
//! records each step of a multi-step operation (conventions 11.3). The intent of each step is
//! written BEFORE it runs, atomically, so an interrupted run can be understood (and, where safe,
//! resumed) from the file alone. It must never hold a secret: `params` are non-secret only.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::{now_rfc3339, random_uuid_v4, write_atomic};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Started,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepRecord {
    pub name: String,
    pub state: StepState,
    pub at: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub schema: u32,
    pub operation: String,
    pub id: String,
    pub started_at: String,
    /// Non-secret parameters only.
    pub params: Value,
    pub steps: Vec<StepRecord>,
    #[serde(skip)]
    path: PathBuf,
}

/// A step of an operation. `rerunnable` = safe to run again after it was interrupted.
#[derive(Debug, Clone, Copy)]
pub struct StepDef {
    pub name: &'static str,
    pub rerunnable: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ResumeRefusal {
    /// The named step was interrupted and cannot safely run again.
    NotRerunnable(String),
}

impl Journal {
    pub fn begin(path: &Path, operation: &str, params: Value) -> std::io::Result<Journal> {
        let j = Journal {
            schema: 1,
            operation: operation.to_string(),
            id: random_uuid_v4().map_err(std::io::Error::other)?,
            started_at: now_rfc3339(),
            params,
            steps: Vec::new(),
            path: path.to_path_buf(),
        };
        j.save()?;
        Ok(j)
    }

    pub fn load(path: &Path) -> std::io::Result<Option<Journal>> {
        match std::fs::read_to_string(path) {
            Ok(t) => {
                let mut j: Journal = serde_json::from_str(&t).map_err(std::io::Error::other)?;
                j.path = path.to_path_buf();
                Ok(Some(j))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn save(&self) -> std::io::Result<()> {
        write_atomic(&self.path, serde_json::to_string_pretty(self).map_err(std::io::Error::other)?.as_bytes())
    }

    pub fn mark(&mut self, name: &str, state: StepState, detail: Option<String>) -> std::io::Result<()> {
        let rec = StepRecord { name: name.to_string(), state, at: now_rfc3339(), detail };
        match self.steps.iter_mut().find(|s| s.name == name) {
            Some(s) => *s = rec,
            None => self.steps.push(rec),
        }
        self.save()
    }

    pub fn state_of(&self, name: &str) -> Option<StepState> {
        self.steps.iter().find(|s| s.name == name).map(|s| s.state)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
impl Journal {
    /// A fresh `provision-journal.json` in the test roots' `state\` folder.
    pub fn for_test(roots: &crate::paths::Roots) -> Journal {
        Journal::begin(&roots.provision_journal(), "provision", serde_json::json!({})).unwrap()
    }
}

/// Index of the first step that still has to run. Refuses when that step was interrupted
/// (`Started` or `Failed`) and is not rerunnable.
pub fn resume_index(journal: &Journal, steps: &[StepDef]) -> Result<usize, ResumeRefusal> {
    for (i, s) in steps.iter().enumerate() {
        match journal.state_of(s.name) {
            Some(StepState::Done) => continue,
            Some(StepState::Started) | Some(StepState::Failed) if !s.rerunnable => {
                return Err(ResumeRefusal::NotRerunnable(s.name.to_string()))
            }
            _ => return Ok(i),
        }
    }
    Ok(steps.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STEPS: [StepDef; 4] = [
        StepDef { name: "a", rerunnable: true },
        StepDef { name: "b", rerunnable: false },
        StepDef { name: "c", rerunnable: true },
        StepDef { name: "d", rerunnable: false },
    ];

    fn journal() -> (tempfile::TempDir, Journal) {
        let d = tempfile::tempdir().unwrap();
        let j = Journal::begin(&d.path().join("journal.json"), "provision", json!({"basePort": 47300})).unwrap();
        (d, j)
    }

    #[test]
    fn intent_is_on_disk_before_the_step_finishes() {
        let (d, mut j) = journal();
        j.mark("a", StepState::Started, None).unwrap();
        let on_disk = Journal::load(&d.path().join("journal.json")).unwrap().unwrap();
        assert_eq!(on_disk.state_of("a"), Some(StepState::Started));
        j.mark("a", StepState::Done, Some("ok".into())).unwrap();
        let on_disk = Journal::load(&d.path().join("journal.json")).unwrap().unwrap();
        assert_eq!(on_disk.state_of("a"), Some(StepState::Done));
        assert_eq!(on_disk.steps.len(), 1, "a step is updated in place, not appended twice");
        assert_eq!(on_disk.params["basePort"], 47300);
    }

    #[test]
    fn resume_skips_done_steps_and_continues_at_the_first_open_one() {
        let (_d, mut j) = journal();
        assert_eq!(resume_index(&j, &STEPS), Ok(0));
        j.mark("a", StepState::Done, None).unwrap();
        assert_eq!(resume_index(&j, &STEPS), Ok(1));
        j.mark("b", StepState::Done, None).unwrap();
        j.mark("c", StepState::Done, None).unwrap();
        j.mark("d", StepState::Done, None).unwrap();
        assert_eq!(resume_index(&j, &STEPS), Ok(4));
    }

    #[test]
    fn an_interrupted_non_rerunnable_step_refuses_resume_but_a_rerunnable_one_continues() {
        let (_d, mut j) = journal();
        j.mark("a", StepState::Done, None).unwrap();
        j.mark("b", StepState::Started, None).unwrap();
        assert_eq!(resume_index(&j, &STEPS), Err(ResumeRefusal::NotRerunnable("b".into())));
        j.mark("b", StepState::Failed, None).unwrap();
        assert_eq!(resume_index(&j, &STEPS), Err(ResumeRefusal::NotRerunnable("b".into())));
        j.mark("b", StepState::Done, None).unwrap();
        j.mark("c", StepState::Failed, None).unwrap();
        assert_eq!(resume_index(&j, &STEPS), Ok(2), "a rerunnable step runs again");
    }
}
