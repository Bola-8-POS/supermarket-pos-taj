//! Database names (conventions 7) and UTC stamps without a date-time dependency.
//! It must never produce a database name outside `valid_ident`'s alphabet: names are spliced into SQL.
use crate::ops::outcome::OpKind;
use serde::{Deserialize, Serialize};

pub const LIVE: &str = "postgres";
pub const NEXT: &str = "pos_next";

pub fn valid_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// yyyyMMddHHmmss in UTC (Howard Hinnant's civil_from_days).
pub fn utc_stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}{h:02}{mi:02}{s:02}")
}

pub fn parse_stamp(s: &str) -> Option<u64> {
    if s.len() != 14 || !s.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let n = |a: usize, b: usize| s[a..b].parse::<i64>().ok();
    let (y, m, d, h, mi, sec) = (n(0, 4)?, n(4, 6)?, n(6, 8)?, n(8, 10)?, n(10, 12)?, n(12, 14)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 { return None; }
    // days_from_civil
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    if days < 0 { return None; }
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) as u64) * 1000)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbNames { pub live: String, pub next: String, pub prev: String, pub failed: String }

impl DbNames {
    pub fn for_kind(kind: OpKind, ts_ms: u64) -> DbNames {
        let stamp = utc_stamp(ts_ms);
        let word = match kind { OpKind::Update => "update", OpKind::Switch => "switch", OpKind::Restore => "restore" };
        DbNames { live: LIVE.into(), next: NEXT.into(), prev: format!("pos_prev_{word}_{stamp}"), failed: format!("pos_failed_{stamp}") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::OpKind;

    #[test]
    fn stamp_known_answers() {
        assert_eq!(utc_stamp(0), "19700101000000");
        assert_eq!(utc_stamp(1_790_908_215_000), "20261002023015");
    }

    #[test]
    fn stamp_round_trips() {
        for ms in [0u64, 951_782_400_000, 1_790_908_215_000, 4_102_444_799_000] {
            assert_eq!(parse_stamp(&utc_stamp(ms)), Some(ms));
        }
        assert_eq!(parse_stamp("2026100202301"), None);
        assert_eq!(parse_stamp("20261302023015"), None);
    }

    #[test]
    fn db_names_follow_conventions_7() {
        let n = DbNames::for_kind(OpKind::Update, 1_790_908_215_000);
        assert_eq!((n.live.as_str(), n.next.as_str()), ("postgres", "pos_next"));
        assert_eq!(n.prev, "pos_prev_update_20261002023015");
        assert_eq!(n.failed, "pos_failed_20261002023015");
        assert_eq!(DbNames::for_kind(OpKind::Switch, 0).prev, "pos_prev_switch_19700101000000");
    }

    #[test]
    fn identifiers_are_restricted_to_a_safe_alphabet() {
        assert!(valid_ident("pos_next") && valid_ident("pos_prev_update_20261002023015"));
        for bad in ["", "Pos", "a-b", "a b", "a\"b", "a;b", &"x".repeat(64)] { assert!(!valid_ident(bad), "{bad}"); }
    }
}
