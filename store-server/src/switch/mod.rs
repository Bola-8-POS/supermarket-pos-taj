//! Cloud to local switch (two-mode plan 09). One `OpWork` (`work::SwitchWork`) on Plan 07's runner.
pub mod cloud;
pub mod drain;
pub mod facts;
pub mod load;
pub mod machine;
#[cfg(all(test, feature = "fence-db-tests"))]
mod load_sql_tests;
#[cfg(all(test, feature = "fence-db-tests"))]
mod fence_sql_tests;
#[cfg(all(test, feature = "fence-db-tests"))]
mod plan_tests;
pub(crate) mod mutants;
pub mod photos;
pub mod progress;
pub mod prompt;
pub mod redact;
pub mod rederive;
#[cfg(all(test, feature = "fence-db-tests"))]
mod rederive_db;
pub mod sig;
pub mod source;
pub mod staging;
pub mod store_env;
pub mod tables;
pub mod verify;
pub mod work;
#[cfg(all(test, feature = "fence-db-tests"))]
mod verify_db_tests;
#[cfg(all(test, feature = "fence-db-tests"))]
mod work_tests;
#[cfg(all(test, feature = "fence-db-tests"))]
pub mod testkit;
