//! `posctl photos verify`: every `storage.objects` row has its file, and the file has the size the row recorded.
//! A file without a row (an orphan) is reported and never fails; nothing is deleted, the operator prunes orphans.
//! The row set and the report shape are the backup service's (`restore::photo_rows`, `restore::photo_report`); this module
//! only adds the strict verdict (any dangling row fails, `backup::photos::verdict` tolerates a few) and the size check.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::json;

use super::{PsqlRows, RowSource, MAX_IDS};
use crate::backup::ctx::BackupCtx;
use crate::backup::restore::{photo_report, photo_rows, Rx};
use crate::backup::util::{now_secs, Exec, RealExec};
use crate::envelope::{Code, Outcome, PosctlError};
use crate::paths::Roots;

/// What the comparison found; `data` is the envelope body.
#[derive(Debug)]
pub struct Report {
    pub data: serde_json::Value,
    pub dangling: usize,
    pub size_mismatches: usize,
}

impl Report {
    pub fn is_consistent(&self) -> bool {
        self.dangling == 0 && self.size_mismatches == 0
    }
}

/// Pure: `rows`/`files` are `bucket/id` keys; `row_sizes` the size each row recorded (rows without one are absent),
/// `file_sizes` the size on disk of the files that have a row (`None`: the file is listed but its size cannot be read, which
/// counts as a mismatch). A row whose file is missing is dangling, not a size mismatch.
pub fn compare(rows: &BTreeSet<String>, files: &BTreeSet<String>, row_sizes: &BTreeMap<String, u64>, file_sizes: &BTreeMap<String, Option<u64>>) -> Report {
    let (mut data, _tolerant_verdict) = photo_report(rows, files);
    let (dangling, _orphans) = crate::backup::photos::dangling(rows, files);
    let mismatched: Vec<&String> = row_sizes.iter().filter(|(k, want)| file_sizes.get(*k).is_some_and(|have| *have != Some(**want))).map(|(k, _)| k).collect();
    data["danglingSample"] = json!(dangling.iter().take(MAX_IDS).collect::<Vec<_>>());
    data["sizeMismatches"] = json!(mismatched.len());
    data["sizeMismatchSample"] = json!(mismatched.iter().take(MAX_IDS).collect::<Vec<_>>());
    Report { data, dangling: dangling.len(), size_mismatches: mismatched.len() }
}

/// The CLI entry: the local database through the Plan 08 runner. The caller has checked elevation and provisioning.
/// Only the rows and files of `buckets` are judged (the app's buckets by default, like the importer).
pub fn run(roots: &Roots, database: &str, buckets: &[String]) -> Outcome {
    match super::real_ctx(roots) {
        Ok(ctx) => run_with(&ctx, &RealExec, &roots.photos(), database, buckets),
        Err(e) => e.into(),
    }
}

/// `run` with the process runner and the photos folder given (tests answer `exec` without Postgres).
pub fn run_with(ctx: &BackupCtx, exec: &dyn Exec, photos: &Path, database: &str, buckets: &[String]) -> Outcome {
    let failed = |m: String| Outcome::from(PosctlError::error(m));
    let rx = Rx { exec, now: now_secs, deadline: None };
    let all_rows = match photo_rows(ctx, &rx, database) {
        Ok(r) => r,
        Err(e) => return failed(format!("could not read the photo rows: {}", e.message)),
    };
    let objects = match (PsqlRows { ctx, exec }).rows(database, &[]) {
        Ok(o) => o,
        Err(m) => return failed(format!("could not read the photo sizes: {m}")),
    };
    let in_scope = |k: &String| k.split('/').next().is_some_and(|b| buckets.iter().any(|x| x == b));
    let rows: BTreeSet<String> = all_rows.into_iter().filter(in_scope).collect();
    let files: BTreeSet<String> = crate::backup::photos::list_dir(photos).into_iter().filter(in_scope).collect();
    // a row without a bucket or an id can never have a file (`photo_rows` cannot even list it): visible, and a failure
    let bad_rows = objects.iter().filter(|o| o.bucket.is_empty() || o.id.is_empty()).count();
    let scoped: Vec<_> = objects.iter().filter(|o| buckets.contains(&o.bucket) && !o.id.is_empty()).collect();
    let unsized_rows = scoped.iter().filter(|o| o.size.is_none()).count();
    let row_sizes: BTreeMap<String, u64> = scoped.iter().filter_map(|o| o.size.map(|s| (o.key(), s))).collect();
    let file_sizes: BTreeMap<String, Option<u64>> =
        row_sizes.keys().filter(|k| files.contains(*k)).map(|k| (k.clone(), std::fs::metadata(photos.join(k)).ok().map(|m| m.len()))).collect();
    let mut r = compare(&rows, &files, &row_sizes, &file_sizes);
    r.data["unsizedRows"] = json!(unsized_rows);
    r.data["badRows"] = json!(bad_rows);
    r.data["buckets"] = json!(buckets);
    if r.is_consistent() && bad_rows == 0 {
        Outcome::ok(format!("all {} photo rows have their file", rows.len()), r.data)
    } else {
        Outcome::with_code(
            Code::PhotosInconsistent,
            format!("{} photo rows have no file, {} files have a different size than their row, {bad_rows} rows have no bucket or id", r.dangling, r.size_mismatches),
            r.data,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::util::fake::{test_ctx, FakeExec};
    use crate::photos::default_buckets;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";

    /// A photos folder with the given `(bucket, id, bytes)` files.
    fn folder(files: &[(&str, &str, &[u8])]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (b, id, bytes) in files {
            std::fs::create_dir_all(d.path().join(b)).unwrap();
            std::fs::write(d.path().join(b).join(id), bytes).unwrap();
        }
        d
    }

    /// Fake psql: the key-set query and the object query answer from `rows` (`bucket`, `id`, `size`).
    fn db(rows: &[(&str, &str, Option<u64>)]) -> FakeExec {
        db_with(rows, "")
    }

    /// `extra` is raw object-query output (a row `photo_rows` cannot list, such as one with a NULL bucket).
    fn db_with(rows: &[(&str, &str, Option<u64>)], extra: &str) -> FakeExec {
        let keys: String = rows.iter().map(|(b, id, _)| format!("{b}/{id}\n")).collect();
        let objs: String = rows
            .iter()
            .map(|(b, id, s)| format!("{{\"bucket\":\"{b}\",\"id\":\"{id}\",\"name\":\"n/{id}.jpg\",\"size\":{}}}\n", s.map_or("null".to_string(), |n| format!("\"{n}\""))))
            .collect::<String>()
            + extra;
        // PHOTO_ROWS_SQL concatenates with `||`, the object query is a json_build_object: the needles cannot overlap
        FakeExec::default().on("bucket_id || '/'", 0, &keys).on("json_build_object", 0, &objs)
    }

    #[test]
    fn verify_ok_when_every_row_has_a_file() {
        let d = folder(&[("product-photos", A, b"abc"), ("store-branding", B, b"hello")]);
        let fx = db(&[("product-photos", A, Some(3)), ("store-branding", B, None)]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!((o.code, o.code.exit()), (Code::Ok, 0), "{}", o.message);
        assert_eq!((o.data["rows"].clone(), o.data["files"].clone(), o.data["dangling"].clone(), o.data["orphans"].clone(), o.data["sizeMismatches"].clone()), (json!(2), json!(2), json!(0), json!(0), json!(0)));
        assert!(fx.count_of("-d postgres") >= 2, "both queries ran against the named database: {:?}", fx.calls.borrow());
    }

    #[test]
    fn verify_exit_60_on_dangling_row() {
        let d = folder(&[("product-photos", A, b"abc")]);
        let fx = db(&[("product-photos", A, Some(3)), ("product-photos", B, Some(9))]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!((o.code, o.code.exit()), (Code::PhotosInconsistent, 60));
        assert_eq!(o.data["dangling"], 1);
        assert_eq!(o.data["danglingSample"], json!([format!("product-photos/{B}")]));
        assert!(!o.retryable);
    }

    #[test]
    fn orphans_are_reported_but_do_not_fail() {
        let d = folder(&[("product-photos", A, b"abc"), ("product-photos", C, b"left over")]);
        let fx = db(&[("product-photos", A, Some(3))]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        assert_eq!((o.data["orphans"].clone(), o.data["dangling"].clone()), (json!(1), json!(0)));
        // nothing was deleted
        assert!(d.path().join("product-photos").join(C).exists());
    }

    #[test]
    fn size_mismatch_fails() {
        let d = folder(&[("product-photos", A, b"abcd")]);
        let fx = db(&[("product-photos", A, Some(3))]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!(o.code, Code::PhotosInconsistent);
        assert_eq!((o.data["sizeMismatches"].clone(), o.data["dangling"].clone()), (json!(1), json!(0)));
        assert_eq!(o.data["sizeMismatchSample"], json!([format!("product-photos/{A}")]));
    }

    #[test]
    fn at_most_100_ids_are_listed_but_the_counts_are_complete() {
        let rows: BTreeSet<String> = (0..150).map(|i| format!("product-photos/{i:04}")).collect();
        let r = compare(&rows, &BTreeSet::new(), &BTreeMap::new(), &BTreeMap::new());
        assert_eq!((r.dangling, r.data["dangling"].clone(), r.data["danglingSample"].as_array().unwrap().len()), (150, json!(150), 100));
        assert!(!r.is_consistent());
        let mut want = BTreeMap::new();
        want.insert("product-photos/x".to_string(), 3u64);
        let files: BTreeSet<String> = ["product-photos/x".to_string()].into();
        let rows2: BTreeSet<String> = files.clone();
        let unreadable = BTreeMap::from([("product-photos/x".to_string(), None)]);
        let r = compare(&rows2, &files, &want, &unreadable);
        assert_eq!((r.size_mismatches, r.dangling), (1, 0), "a file whose size cannot be read is a mismatch");
    }

    #[test]
    fn an_unreadable_file_size_counts_as_a_mismatch() {
        let key = "product-photos/x".to_string();
        let files: BTreeSet<String> = [key.clone()].into();
        let want = BTreeMap::from([(key.clone(), 3u64)]);
        let r = compare(&files, &files, &want, &BTreeMap::from([(key.clone(), None)]));
        assert_eq!((r.size_mismatches, r.dangling, r.is_consistent()), (1, 0, false));
        let r = compare(&files, &files, &want, &BTreeMap::from([(key, Some(3))]));
        assert!(r.is_consistent());
    }

    #[test]
    fn a_database_failure_is_exit_1_and_the_folder_is_not_judged() {
        let d = folder(&[]);
        let fx = FakeExec::default().on_stderr("bucket_id || '/'", 2, "connection refused");
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!((o.code, o.code.exit()), (Code::Error, 1));
    }

    #[test]
    fn only_the_requested_buckets_are_judged_and_unsized_rows_are_counted() {
        let d = folder(&[("product-photos", A, b"abc"), ("other", C, b"zz")]);
        // `other` has a row without a file: out of scope, so not dangling; B in scope has no size
        let fx = db(&[("product-photos", A, Some(3)), ("product-photos", B, None), ("other", B, Some(1))]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!(o.code, Code::PhotosInconsistent, "B has no file");
        assert_eq!((o.data["rows"].clone(), o.data["files"].clone(), o.data["dangling"].clone(), o.data["unsizedRows"].clone()), (json!(2), json!(1), json!(1), json!(1)));
        let fx = db(&[("product-photos", A, Some(3)), ("other", B, Some(1))]);
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!(o.code, Code::Ok, "{}", o.message);
        // asking for `other` judges it
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &["other".to_string()]);
        assert_eq!((o.code, o.data["dangling"].clone()), (Code::PhotosInconsistent, json!(1)));
    }

    #[test]
    fn a_row_with_a_null_bucket_is_visible_and_fails() {
        let d = folder(&[("product-photos", A, b"abc")]);
        let fx = db_with(&[("product-photos", A, Some(3))], "{\"bucket\":null,\"id\":\"99999999-9999-4999-8999-999999999999\",\"name\":\"x\",\"size\":null}
");
        let o = run_with(&test_ctx(), &fx, d.path(), "postgres", &default_buckets());
        assert_eq!((o.code, o.data["badRows"].clone(), o.data["dangling"].clone()), (Code::PhotosInconsistent, json!(1), json!(0)));
    }

    #[test]
    fn usage_and_elevation_exits() {
        use crate::commands::update::gate;
        use crate::photos::check_database;
        // a bad database name is USAGE (2) before anything else is asked
        assert_eq!(check_database("bad name;").unwrap_err().code.exit(), 2);
        // elevation answers before provisioning: a standard user on a provisioned or unprovisioned PC is 3, never 4
        let d = tempfile::tempdir().unwrap();
        let mut roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        roots.dev = false;
        assert_eq!(gate(&roots, false).unwrap_err().code.exit(), 3);
        // an administrator on an unprovisioned PC is 4
        assert_eq!(gate(&roots, true).unwrap_err().code.exit(), 4);
        // a dev root counts as elevated, like the backup commands
        roots.dev = true;
        assert_eq!(gate(&roots, false).unwrap_err().code.exit(), 4);
        std::fs::create_dir_all(roots.provisioned_json().parent().unwrap()).unwrap();
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        assert!(gate(&roots, false).is_ok());
    }
}
