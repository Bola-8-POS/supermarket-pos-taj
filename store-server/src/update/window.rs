//! The hard local-time maintenance window: `update --window-aware` may only fence the tills inside it. Checked before anything else,
//! because the database being idle at 09:00 (the PC was off at 02:30 and the caja is not open yet) says nothing about staff arriving.
use crate::config::MaintenanceWindow;

pub const DEFAULT_START: &str = "01:00";
pub const DEFAULT_END: &str = "05:00";

/// `HH:MM` to minutes after local midnight.
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && s.trim().len() == 5).then_some(h * 60 + m)
}

/// The configured window when it can be used: both ends `HH:MM`, not empty (start == end), and containing at least one whole hour.
/// The hourly UpdateCheck fires at HH:00 only, so a window such as 03:15-03:45 would never run.
fn usable(cfg: Option<&MaintenanceWindow>) -> Option<(u32, u32)> {
    let (s, e) = cfg.and_then(|w| Some((parse_hhmm(&w.start)?, parse_hhmm(&w.end)?)))?;
    (s != e && (0..24).any(|h| in_window(h * 60, (s, e)))).then_some((s, e))
}

/// `(start, end)` in minutes. A missing or unusable window (see `usable`) is the default, never "always open".
pub fn window_from(cfg: Option<&MaintenanceWindow>) -> (u32, u32) {
    usable(cfg).unwrap_or_else(|| (parse_hhmm(DEFAULT_START).unwrap_or(60), parse_hhmm(DEFAULT_END).unwrap_or(300)))
}

/// A window that IS configured but cannot be used (not `HH:MM`, an en dash, 25:00, start == end, or no whole hour inside it).
/// `window_from` falls back to the default for it; health warns so it does not stay silent. Not configured at all is not a problem.
pub fn window_problem(cfg: Option<&MaintenanceWindow>) -> bool { cfg.is_some() && usable(cfg).is_none() }

/// Start inclusive, end exclusive; `start > end` wraps midnight (22:00-06:00).
pub fn in_window(minute: u32, (start, end): (u32, u32)) -> bool {
    if start < end { minute >= start && minute < end } else { minute >= start || minute < end }
}

/// Minutes after local midnight for a UTC instant and the local offset in force AT THAT INSTANT (so a DST change moves the answer).
pub fn local_minute_of_day(unix_s: u64, offset_s: i64) -> u32 {
    let local = unix_s as i64 + offset_s;
    (local.rem_euclid(86_400) / 60) as u32
}

/// The unix second at which the window that is open now (or opened last) began: the stable key of "this maintenance window".
/// Derived from the same `(start, end)` minutes and local minute-of-day as `in_window`, no second window definition.
pub fn window_start_unix(now_unix: i64, minute_of_day: u32, (start, _end): (u32, u32)) -> i64 {
    let since_start = (i64::from(minute_of_day) + 1440 - i64::from(start)) % 1440;
    now_unix - now_unix.rem_euclid(60) - since_start * 60
}

/// The OS clock in local time, DST included (the offset is the one in force right now).
#[cfg(windows)]
pub fn os_local_minute_of_day() -> u32 {
    // SAFETY: GetLocalTime has no preconditions and returns a plain struct.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    u32::from(t.wHour) * 60 + u32::from(t.wMinute)
}
#[cfg(not(windows))]
pub fn os_local_minute_of_day() -> u32 { local_minute_of_day(crate::util::now_unix(), 0) }

#[cfg(test)]
mod tests {
    #[test]
    fn the_window_start_key_is_stable_inside_a_window_and_moves_to_the_next_one() {
        use super::window_start_unix as k;
        let day = 1_790_000_000 - 1_790_000_000 % 86_400; // a UTC midnight; offset 0 so local minute = UTC minute
        let w = (60, 300); // 01:00-05:00
        let at = |h: i64, m: i64| day + h * 3600 + m * 60;
        assert_eq!(k(at(1, 0), 60, w), at(1, 0));
        assert_eq!(k(at(2, 30) + 17, 150, w), at(1, 0), "same window, any second of it");
        assert_eq!(k(at(4, 59), 299, w), at(1, 0));
        assert_eq!(k(at(9, 0), 540, w), at(1, 0), "a manual run after the window still belongs to the last one");
        assert_eq!(k(at(0, 30) + 86_400, 30, w), at(1, 0), "before the next start: still last night's");
        assert_eq!(k(at(1, 0) + 86_400, 60, w), at(1, 0) + 86_400, "the next night is a new window");
        assert_eq!(k(at(23, 30), 1410, (1350, 360)), at(22, 30), "a window wrapping midnight (22:30-06:00)");
        assert_eq!(k(at(2, 0) + 86_400, 120, (1350, 360)), at(22, 30), "after midnight inside a wrapping window");
    }

    use super::*;

    #[test]
    fn hhmm_parses_strictly() {
        assert_eq!(parse_hhmm("01:00"), Some(60));
        assert_eq!(parse_hhmm("23:59"), Some(1439));
        for bad in ["24:00", "1:00", "01:60", "0100", "", "ab:cd", "01:00:00"] { assert_eq!(parse_hhmm(bad), None, "{bad}"); }
    }

    #[test]
    fn the_default_window_is_one_to_five_in_the_morning() {
        assert_eq!(window_from(None), (60, 300));
        let w = |s: &str, e: &str| MaintenanceWindow { start: s.into(), end: e.into() };
        assert_eq!(window_from(Some(&w("22:00", "06:00"))), (1320, 360));
        assert_eq!(window_from(Some(&w("nonsense", "06:00"))), (60, 300), "an unreadable window is the default, never open");
        assert_eq!(window_from(Some(&w("03:00", "03:00"))), (60, 300), "an empty window is not 'always'");
    }

    #[test]
    fn inside_and_outside_a_plain_window() {
        let w = (60, 300);
        assert!(in_window(150, w) && in_window(60, w), "02:30 and the start are inside");
        assert!(!in_window(300, w) && !in_window(540, w) && !in_window(0, w), "the end, 09:00 and midnight are outside");
    }

    #[test]
    fn a_window_that_wraps_midnight() {
        let w = (22 * 60, 6 * 60);
        for m in [22 * 60, 23 * 60 + 30, 0, 2 * 60, 5 * 60 + 59] { assert!(in_window(m, w), "{m}"); }
        for m in [6 * 60, 12 * 60, 21 * 60 + 59] { assert!(!in_window(m, w), "{m}"); }
    }

    #[test]
    fn local_time_follows_the_offset_in_force_at_the_instant_so_a_dst_change_moves_it() {
        let t = 1_790_908_215; // 2026-10-02 02:30:15 UTC
        assert_eq!(local_minute_of_day(t, 0), 2 * 60 + 30);
        assert_eq!(local_minute_of_day(t, -6 * 3600), 20 * 60 + 30, "CST: the previous evening");
        assert_eq!(local_minute_of_day(t, -5 * 3600), 21 * 60 + 30, "the same instant under DST is an hour later on the clock");
        assert_eq!(local_minute_of_day(t, 3600 * 24 + 60), 2 * 60 + 31, "whole days do not matter");
    }

    #[test]
    fn an_unusable_window_is_a_problem_but_a_missing_one_is_not() {
        let w = |s: &str, e: &str| MaintenanceWindow { start: s.into(), end: e.into() };
        assert!(!window_problem(None), "no window configured is the default, not a problem");
        assert!(!window_problem(Some(&w("22:00", "02:00"))));
        for (s, e) in [("1:00", "05:00"), ("01:00", "05\u{2013}00"), ("25:00", "05:00"), ("03:00", "03:00"), ("", "")] {
            assert!(window_problem(Some(&w(s, e))), "{s}-{e}");
        }
    }

    #[test]
    fn a_window_with_no_whole_hour_in_it_is_a_problem_and_falls_back_to_the_default() {
        let w = |s: &str, e: &str| MaintenanceWindow { start: s.into(), end: e.into() };
        // the hourly UpdateCheck fires at HH:00 only, so 03:15-03:45 would never run
        for (s, e) in [("03:15", "03:45"), ("23:15", "23:59"), ("00:01", "00:59"), ("10:30", "10:31")] {
            assert!(window_problem(Some(&w(s, e))), "{s}-{e}");
            assert_eq!(window_from(Some(&w(s, e))), (60, 300), "{s}-{e} runs as the default");
        }
        // one whole hour inside is enough, start inclusive and end exclusive
        for (s, e) in [("03:00", "03:01"), ("03:15", "04:05"), ("02:59", "03:01"), ("22:30", "00:30"), ("23:30", "00:10"), ("22:00", "00:00")] {
            assert!(!window_problem(Some(&w(s, e))), "{s}-{e}");
            assert_eq!(window_from(Some(&w(s, e))), (parse_hhmm(s).unwrap(), parse_hhmm(e).unwrap()), "{s}-{e}");
        }
        // a wrap-midnight window contains midnight, a whole hour, so it is always usable
        assert!(!window_problem(Some(&w("23:50", "23:10"))));
    }
}
