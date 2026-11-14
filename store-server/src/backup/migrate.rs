//! Schema levels of a snapshot against the installed pack. A newer snapshot is refused. An older one is migrated forward on the
//! restored clone by Plan 07's own sequence (`update::work::UpdateWork::migrate_restored`: the pack's every-update SQL steps,
//! GoTrue's migrate and `supabase db push --db-url`, all with `PGPASSFILE`, never a password in a URL or argv), driven by
//! `backup::restore_work`. This module only decides which case a snapshot is.
use std::path::Path;

use super::ctx::BackupCtx;
use super::result::{BResult, BackupError};

#[derive(Debug, PartialEq, Eq)]
pub enum Relation {
    Same,
    Older,
    Newer,
}

pub fn relation(snap_max: &str, snap_count: i64, pack_max: &str, pack_count: i64) -> Relation {
    match snap_max.cmp(pack_max) {
        std::cmp::Ordering::Greater => Relation::Newer,
        std::cmp::Ordering::Less => Relation::Older,
        std::cmp::Ordering::Equal if snap_count < pack_count => Relation::Older,
        std::cmp::Ordering::Equal if snap_count > pack_count => Relation::Newer,
        std::cmp::Ordering::Equal => Relation::Same,
    }
}

pub fn pack_level(pack_dir: &Path) -> BResult<(i64, String)> {
    let t = std::fs::read_to_string(pack_dir.join("manifest.json")).map_err(|e| BackupError::precondition(format!("the installed pack's manifest is unreadable: {e}")))?;
    let v: serde_json::Value = serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|e| BackupError::precondition(format!("the installed pack's manifest is invalid: {e}")))?;
    let count = v["migrations"]["count"].as_i64().ok_or_else(|| BackupError::precondition("pack manifest has no migrations.count"))?;
    let max = v["migrations"]["max"].as_str().ok_or_else(|| BackupError::precondition("pack manifest has no migrations.max"))?.to_string();
    Ok((count, max))
}

/// Older and same are fine (older is migrated forward before verify and swap); a snapshot from a newer schema than the
/// installed pack is refused: the installed software could not run it.
pub fn require_not_newer(ctx: &BackupCtx, snap_count: i64, snap_max: &str) -> BResult<Relation> {
    let (pack_count, pack_max) = pack_level(&ctx.pack_dir)?;
    match relation(snap_max, snap_count, &pack_max, pack_count) {
        Relation::Newer => Err(BackupError::precondition("this backup was made by a newer version of the software than the one installed; install the newer update first, then restore")),
        r => Ok(r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::util::fake::temp_ctx;
    use crate::envelope::Code;

    #[test]
    fn schema_levels_compare_by_version_then_count() {
        assert_eq!(relation("20260930000001", 237, "20260930000001", 237), Relation::Same);
        assert_eq!(relation("20260927000004", 228, "20260930000001", 237), Relation::Older);
        assert_eq!(relation("20261001000001", 240, "20260930000001", 237), Relation::Newer);
        assert_eq!(relation("20260930000001", 230, "20260930000001", 237), Relation::Older, "same max but fewer applied still needs migrating");
        assert_eq!(relation("20260930000001", 240, "20260930000001", 237), Relation::Newer, "same max but more applied is newer");
    }

    #[test]
    fn the_pack_level_is_read_from_its_manifest() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("manifest.json"), r#"{"schema":1,"migrations":{"count":237,"max":"20260930000001"}}"#).unwrap();
        assert_eq!(pack_level(d.path()).unwrap(), (237, "20260930000001".to_string()));
        assert!(pack_level(&d.path().join("none")).is_err());
    }

    #[test]
    fn a_snapshot_from_a_newer_schema_is_refused_before_anything_is_touched() {
        let (_d, c) = temp_ctx();
        std::fs::write(c.pack_dir.join("manifest.json"), r#"{"schema":1,"migrations":{"count":3,"max":"20260930000001"}}"#).unwrap();
        let err = require_not_newer(&c, 4, "20261001000001").unwrap_err();
        assert_eq!(err.code, Code::Precondition);
        assert!(err.message.contains("newer"), "{}", err.message);
        assert_eq!(require_not_newer(&c, 3, "20260930000001").unwrap(), Relation::Same);
        assert_eq!(require_not_newer(&c, 2, "20260927000004").unwrap(), Relation::Older);
    }
}
