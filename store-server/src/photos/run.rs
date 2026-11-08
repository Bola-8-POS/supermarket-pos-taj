//! The in-process entry of `photos import-from-cloud` (Plan 09's contract test calls it): the local database through `psql`
//! for the rows, the hosted project over HTTPS for the files. Elevation and provisioning are the command's gate
//! (`commands::photos`), checked before the credentials are even read.
use super::creds::SourceCredentials;
use super::import::{import_objects, ImportArgs, UreqSource};
use super::{real_ctx, PsqlRows};
use crate::backup::util::RealExec;
use crate::envelope::Outcome;
use crate::paths::Roots;

pub fn run_import_with(roots: &Roots, args: &ImportArgs, creds: SourceCredentials) -> Outcome {
    let ctx = match real_ctx(roots) {
        Ok(c) => c,
        Err(e) => return e.into(),
    };
    let rows = PsqlRows { ctx: &ctx, exec: &RealExec };
    let source = UreqSource::new(&creds);
    import_objects(roots, args, &rows, &source)
}
