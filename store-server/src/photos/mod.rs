//! Product photos kept on this PC: `photos\<bucket>\<row uuid>` against the `storage.objects` rows (conventions 2.2, Plan 10).
//! `verify` checks the two against each other; `import-from-cloud` copies the files of a hosted project in (Plan 09 calls it
//! after the database was moved).
//! It must never write outside `photos\`, never touch the database, never take `update.lock` (Plan 09 holds it while it
//! calls the importer), and never put the hosted project's key on a command line, in a log or in an envelope.
use std::rc::Rc;

use serde_json::Value;

use crate::backup::ctx::BackupCtx;
use crate::backup::plan08_backup::ctx_from_env;
use crate::backup::run::admin_conn;
use crate::backup::util::Exec;
use crate::envelope::{Code, PosctlError};
use crate::paths::Roots;
use crate::update::Env;

pub mod creds;
pub mod import;
pub mod run;
pub mod verify;

pub use creds::SourceCredentials;
pub use import::ImportArgs;
pub use run::run_import_with;

/// The database both commands read when `--database` is not given: the live one.
pub const DEFAULT_DATABASE: &str = "postgres";
/// The buckets the app uses (`product-photos`, `store-branding`).
pub const DEFAULT_BUCKETS: &str = "product-photos,store-branding";
/// The default bucket list as a vector (`import-from-cloud` and `verify` share it).
pub fn default_buckets() -> Vec<String> {
    DEFAULT_BUCKETS.split(',').map(String::from).collect()
}
/// How many ids an envelope lists (the counts are always complete).
pub const MAX_IDS: usize = 100;

/// One `storage.objects` row, as far as photos care: where the file lives (`bucket`/`id`), what the hosted API calls it
/// (`name`) and how big it should be (`metadata.size`, absent on rows that never recorded one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectRow {
    pub bucket: String,
    pub id: String,
    pub name: String,
    pub size: Option<u64>,
}

impl ObjectRow {
    /// The `bucket/id` key `backup::photos` uses for rows and files alike.
    pub fn key(&self) -> String {
        format!("{}/{}", self.bucket, self.id)
    }
}

/// Where the importer and `verify` get rows from. The one seam to the database; tests answer it without Postgres.
pub trait RowSource {
    /// Rows of `buckets` (all buckets when the slice is empty), ordered by bucket and id.
    fn rows(&self, database: &str, buckets: &[String]) -> Result<Vec<ObjectRow>, String>;
}

/// The local Postgres through `psql` (the Plan 08 runner, `supabase_admin`, read-only session).
pub struct PsqlRows<'a> {
    pub ctx: &'a BackupCtx,
    pub exec: &'a dyn Exec,
}

impl RowSource for PsqlRows<'_> {
    fn rows(&self, database: &str, buckets: &[String]) -> Result<Vec<ObjectRow>, String> {
        let out = crate::backup::pg::sql_scalar(self.exec, self.ctx, &admin_conn(self.ctx, database), &objects_sql(buckets), true).map_err(|e| e.message)?;
        parse_rows(&out)
    }
}

/// One JSON object per line (`json_build_object` escapes line breaks, so a name cannot split a row).
pub fn objects_sql(buckets: &[String]) -> String {
    let filter = if buckets.is_empty() {
        String::new()
    } else {
        format!(" WHERE bucket_id IN ({})", buckets.iter().map(|b| crate::backup::pg::literal(b)).collect::<Vec<_>>().join(", "))
    };
    format!("SELECT json_build_object('bucket', bucket_id, 'id', id::text, 'name', name, 'size', metadata->>'size') FROM storage.objects{filter} ORDER BY bucket_id, id;")
}

pub fn parse_rows(text: &str) -> Result<Vec<ObjectRow>, String> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        // the line is a database row: never quoted back in an error
        let v: Value = serde_json::from_str(line).map_err(|_| "the database answered a photo row that is not JSON".to_string())?;
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        out.push(ObjectRow { bucket: s("bucket"), id: s("id"), name: s("name"), size: v["size"].as_str().and_then(|n| n.trim().parse().ok()) });
    }
    Ok(out)
}

/// The backup context of the pack that is current on this machine (the same recipe as `posctl backup`).
pub(crate) fn real_ctx(roots: &Roots) -> Result<BackupCtx, PosctlError> {
    let env = Env::production(roots, Rc::new(crate::runtime::WindowsServices))?;
    let pack = crate::config::PosctlJson::load(roots)
        .map_err(PosctlError::error)?
        .map(|c| c.pack.current)
        .ok_or_else(|| PosctlError::new(Code::NotProvisioned, "this PC is not provisioned"))?;
    Ok(ctx_from_env(&env, &pack))
}

/// A database name goes to `psql -d`; letters, digits and underscore only.
pub(crate) fn check_database(db: &str) -> Result<(), PosctlError> {
    if db.is_empty() || db.len() > 63 || !db.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(PosctlError::new(Code::Usage, "--database must be a database name: letters, digits and underscore"));
    }
    Ok(())
}

/// A bucket id is a folder name under `photos\` and an SQL literal: lowercase letters, digits, dash and underscore.
pub fn bucket_is_valid(b: &str) -> bool {
    let mut cs = b.chars();
    cs.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && b.len() <= 63 && b.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

pub(crate) fn check_buckets(buckets: &[String]) -> Result<(), PosctlError> {
    if buckets.is_empty() || buckets.iter().any(|b| !bucket_is_valid(b)) {
        return Err(PosctlError::new(Code::Usage, "--buckets must list bucket names: lowercase letters, digits, dash and underscore"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_parse_from_one_json_object_per_line_and_a_missing_size_is_none() {
        let t = "{\"bucket\":\"product-photos\",\"id\":\"a\",\"name\":\"p/1.jpg\",\"size\":\"42\"}\n\n{\"bucket\":\"store-branding\",\"id\":\"b\",\"name\":null,\"size\":null}\n";
        let rows = parse_rows(t).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].key(), rows[0].name.as_str(), rows[0].size), ("product-photos/a".to_string(), "p/1.jpg", Some(42)));
        assert_eq!((rows[1].name.as_str(), rows[1].size), ("", None));
        let e = parse_rows("not json with secret-ish text").unwrap_err();
        assert!(!e.contains("secret-ish"), "a database row is never quoted: {e}");
    }

    #[test]
    fn the_sql_filters_by_quoted_buckets_only_when_asked() {
        assert!(!objects_sql(&[]).contains("WHERE"));
        let q = objects_sql(&["product-photos".to_string(), "it's".to_string()]);
        assert!(q.contains("WHERE bucket_id IN ('product-photos', 'it''s')"), "{q}");
    }

    #[test]
    fn bucket_and_database_names_are_checked() {
        let long = "x".repeat(64);
        assert!(bucket_is_valid("product-photos") && bucket_is_valid("a_1"));
        for bad in ["", "-x", "A", "a/b", "a b", "..", "a'b", long.as_str()] {
            assert!(!bucket_is_valid(bad), "{bad}");
        }
        assert!(check_database("postgres").is_ok() && check_database("pos_next").is_ok());
        for bad in ["", "a-b", "a b", "a;b", "a\"b", long.as_str()] {
            assert_eq!(check_database(bad).unwrap_err().code, Code::Usage, "{bad}");
        }
    }
}
