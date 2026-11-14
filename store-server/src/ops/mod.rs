//! Shared building blocks for the operations that fence the tills and swap databases: update
//! (Plan 07), restore (Plan 08) and the cloud-to-local switch (Plan 09). Plan 05 creates the
//! module with the two pieces its own commands need (provision and unprovision take the lock
//! exclusive, conventions 11.3 and rule H): `outcome` and `lock`, written to EXACTLY the API of
//! Plan 07 "Shared operation API". Plan 07 verifies and extends them, and adds `journal`,
//! `world`, `runner`, `recover`, `swap`, `fence`, `names`, `real`, `hooked` beside them.
//! It must never let two of these operations hold `update.lock` at once.

pub mod lock;
pub mod outcome;
pub mod names;
pub mod journal;
pub mod world;
pub mod runner;
pub mod recover;
#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod matrix_tests;
pub mod swap;
pub mod proc;
#[cfg(test)]
pub mod test_cluster;
pub mod fence;
pub mod probe;
pub mod real;
pub mod hooks;
pub mod hooked;
