//! The `update` operation's own pieces: pack rules, the migration scan, the catalog digest and the update work.
//! The generic procedure (fence, clone, swap, recovery) is `crate::ops`; nothing here may take `update.lock`.
pub mod catalog;
pub mod cluster;
pub mod invariants;
pub mod manifest;
pub mod precheck;
pub mod scan;
#[cfg(feature = "test-hooks")]
pub mod smoke;
#[cfg(test)]
mod sql_lint;
pub mod work;

use crate::ops::real::Ports;
use std::path::PathBuf;

/// Everything the update needs to know about the machine. Built once from Plan 05's roots.
#[derive(Clone)]
pub struct Env {
    pub data: PathBuf,
    pub program: PathBuf,
    pub posctl_exe: PathBuf,
    pub ports: Ports,
    // the in-process `conf::activate`, shared with the world's `activate_pack` (one activation path)
    pub roots: crate::paths::Roots,
    pub activate: std::rc::Rc<crate::ops::real::ActivateFn>,
}
impl Env {
    /// `state\update\`: the journal, the lock, the result files and the fence sidecar (FR19). Not `state\`, which the Gateway can read.
    pub fn update_dir(&self) -> PathBuf { self.roots.update_dir() }
    pub fn conf(&self) -> PathBuf { self.data.join("conf") }
    pub fn secrets(&self) -> PathBuf { self.data.join("secrets") }
    pub fn logs_ops(&self) -> PathBuf { self.data.join("logs").join("posctl").join("ops") }
    pub fn pack_dir(&self, v: &str) -> PathBuf { self.program.join("packs").join(v) }
}
pub mod idle;
pub mod limits;
pub mod result_file;
pub mod prune;
pub mod window;
