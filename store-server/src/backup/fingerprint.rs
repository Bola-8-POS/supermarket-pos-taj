//! Row and catalog fingerprints: computed at backup time inside the exported snapshot,
//! recomputed on a restored database and compared. SQL text lives in `pg.rs`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableFp {
    pub name: String,
    pub count: i64,
    pub hash: String,
}

/// `schema.table|rowcount|hash` (psql `-A -t` output of `TABLES_FP_SQL`).
pub fn parse_table_fp(line: &str) -> Result<TableFp, String> {
    let p: Vec<&str> = line.trim().split('|').collect();
    if p.len() != 3 {
        return Err(format!("not a table fingerprint line: {line}"));
    }
    let count = p[1].parse::<i64>().map_err(|_| format!("bad row count in: {line}"))?;
    Ok(TableFp { name: p[0].to_string(), count, hash: p[2].to_string() })
}

pub fn parse_catalog(lines: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut m = BTreeMap::new();
    for l in lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        let (k, v) = l.split_once('|').ok_or_else(|| format!("not a catalog line: {l}"))?;
        m.insert(k.to_string(), v.to_string());
    }
    Ok(m)
}

pub fn diff_tables(want: &[TableFp], got: &[TableFp]) -> Vec<String> {
    let w: BTreeMap<&str, &TableFp> = want.iter().map(|t| (t.name.as_str(), t)).collect();
    let g: BTreeMap<&str, &TableFp> = got.iter().map(|t| (t.name.as_str(), t)).collect();
    let mut out = Vec::new();
    for (n, t) in &w {
        match g.get(n) {
            None => out.push(format!("table {n} is missing from the restored database")),
            Some(x) if x.count != t.count || x.hash != t.hash => {
                out.push(format!("table {n} changed (rows {} -> {})", t.count, x.count))
            }
            _ => {}
        }
    }
    for n in g.keys() {
        if !w.contains_key(n) {
            out.push(format!("table {n} is unexpected in the restored database"));
        }
    }
    out
}

pub fn diff_catalog(want: &BTreeMap<String, String>, got: &BTreeMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    for (k, v) in want {
        match got.get(k) {
            None => out.push(format!("catalog '{k}' is missing")),
            Some(x) if x != v => out.push(format!("catalog '{k}' differs")),
            _ => {}
        }
    }
    for k in got.keys() {
        if !want.contains_key(k) {
            out.push(format!("catalog '{k}' is unexpected"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn table_lines_parse_and_reject_noise() {
        let t = parse_table_fp("public.caja_sessions|12|98234782347").unwrap();
        assert_eq!((t.name.as_str(), t.count, t.hash.as_str()), ("public.caja_sessions", 12, "98234782347"));
        assert!(parse_table_fp("public.x|notanumber|1").is_err());
        assert!(parse_table_fp("only|two").is_err());
    }

    fn t(n: &str, c: i64, h: &str) -> TableFp { TableFp { name: n.into(), count: c, hash: h.into() } }

    #[test]
    fn a_missing_changed_or_extra_table_is_reported_by_name() {
        let want = vec![t("public.a", 1, "1"), t("public.b", 2, "2"), t("public.c", 3, "3")];
        let got = vec![t("public.a", 1, "1"), t("public.b", 2, "9"), t("public.d", 4, "4")];
        let d = diff_tables(&want, &got);
        assert_eq!(d.len(), 3);
        assert!(d.iter().any(|x| x.contains("public.b") && x.contains("changed")));
        assert!(d.iter().any(|x| x.contains("public.c") && x.contains("missing")));
        assert!(d.iter().any(|x| x.contains("public.d") && x.contains("unexpected")));
        assert!(diff_tables(&want, &want).is_empty());
    }

    #[test]
    fn catalog_kinds_compare_by_hash() {
        let mut a = BTreeMap::new();
        a.insert("functions".to_string(), "aa".to_string());
        a.insert("policies".to_string(), "bb".to_string());
        let mut b = a.clone();
        assert!(diff_catalog(&a, &b).is_empty());
        b.insert("policies".to_string(), "cc".to_string());
        assert_eq!(diff_catalog(&a, &b), vec!["catalog 'policies' differs"]);
        b.remove("functions");
        assert!(diff_catalog(&a, &b).iter().any(|x| x.contains("functions")));
        assert_eq!(parse_catalog(&["functions|aa".into(), "".into(), "policies|bb".into()]).unwrap(), a);
    }
}
