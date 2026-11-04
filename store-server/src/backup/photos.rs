//! Photo files vs `storage.objects` rows. Files are `photos\<bucket>\<row uuid>` (conventions 2.2).
//! The folder is scanned after the dump, so a photo deleted in between leaves a dangling row (seconds
//! of window); extra files are harmless orphans.
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

pub fn dangling(rows: &BTreeSet<String>, files: &BTreeSet<String>) -> (Vec<String>, usize) {
    let dang: Vec<String> = rows.difference(files).cloned().collect();
    let orphans = files.difference(rows).count();
    (dang, orphans)
}

pub fn list_dir(root: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Ok(buckets) = std::fs::read_dir(root) else { return out };
    for b in buckets.flatten() {
        let bn = b.file_name().to_string_lossy().into_owned();
        if bn.starts_with('.') || !b.path().is_dir() {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(b.path()) {
            for f in files.flatten() {
                let fname = f.file_name().to_string_lossy().into_owned();
                if !fname.starts_with('.') && f.path().is_file() {
                    out.insert(format!("{bn}/{fname}"));
                }
            }
        }
    }
    out
}

/// `restic ls --json --recursive <id> <photos path>` lines to `bucket/id`.
pub fn from_restic_ls(ndjson: &str, photos_sub: &str) -> BTreeSet<String> {
    let prefix = format!("{}/", photos_sub.trim_end_matches('/'));
    ndjson
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .filter(|v| v["type"] == "file")
        .filter_map(|v| v["path"].as_str().map(String::from))
        .filter_map(|p| p.strip_prefix(&prefix).map(String::from))
        .filter(|rest| {
            let parts: Vec<&str> = rest.split('/').collect();
            parts.len() == 2 && !parts[0].starts_with('.') && !parts[1].starts_with('.')
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Warn,
    Fail,
}

/// A handful of dangling rows is the delete-during-backup window; a large share is a broken backup.
pub fn verdict(rows: usize, dangling: usize) -> Verdict {
    if dangling == 0 {
        Verdict::Ok
    } else if dangling <= 3usize.max(rows / 20) {
        Verdict::Warn
    } else {
        Verdict::Fail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rows_without_a_file_are_dangling_and_files_without_a_row_are_harmless_orphans() {
        let rows = set(&["product-photos/a", "product-photos/b", "store-branding/c"]);
        let files = set(&["product-photos/a", "store-branding/c", "product-photos/zzz"]);
        let (dang, orphans) = dangling(&rows, &files);
        assert_eq!(dang, vec!["product-photos/b".to_string()]);
        assert_eq!(orphans, 1);
    }

    #[test]
    fn a_few_dangling_rows_warn_but_a_large_share_fails_the_drill() {
        assert_eq!(verdict(100, 0), Verdict::Ok);
        assert_eq!(verdict(100, 3), Verdict::Warn);
        // the plan's own table said (100, 4) = Fail, which contradicts its formula max(3, 5%) = 5 at 100 rows and its (1000, 50) = Warn
        assert_eq!(verdict(100, 5), Verdict::Warn);
        assert_eq!(verdict(100, 6), Verdict::Fail, "more than max(3, 5%) of 100 rows is a broken backup");
        assert_eq!(verdict(20, 3), Verdict::Warn, "the floor of 3 protects a small store");
        assert_eq!(verdict(20, 4), Verdict::Fail);
        assert_eq!(verdict(1000, 50), Verdict::Warn);
        assert_eq!(verdict(1000, 51), Verdict::Fail);
        assert_eq!(verdict(0, 0), Verdict::Ok);
    }

    #[test]
    fn a_folder_walk_reads_bucket_and_id_and_skips_the_temp_folder() {
        let d = tempfile::tempdir().unwrap();
        for f in ["product-photos/aaa", "store-branding/bbb", ".tmp/half", "product-photos/.hidden"] {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        assert_eq!(list_dir(d.path()), set(&["product-photos/aaa", "store-branding/bbb"]));
        assert!(list_dir(&d.path().join("missing")).is_empty());
    }

    #[test]
    fn restic_ls_output_is_reduced_to_bucket_and_id_under_the_photos_folder() {
        let sub = "/C/ProgramData/SupermarketPOS/photos";
        let out = format!(
            "{{\"message_type\":\"snapshot\",\"id\":\"x\"}}\n{{\"name\":\"product-photos\",\"type\":\"dir\",\"path\":\"{sub}/product-photos\",\"message_type\":\"node\"}}\n{{\"name\":\"aaa\",\"type\":\"file\",\"path\":\"{sub}/product-photos/aaa\",\"message_type\":\"node\"}}\n{{\"name\":\"half\",\"type\":\"file\",\"path\":\"{sub}/.tmp/half\",\"message_type\":\"node\"}}\n{{\"name\":\"other\",\"type\":\"file\",\"path\":\"/C/elsewhere/x/y\",\"message_type\":\"node\"}}\n"
        );
        assert_eq!(from_restic_ls(&out, sub), set(&["product-photos/aaa"]));
    }
}
