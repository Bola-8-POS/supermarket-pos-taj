//! Pure scheduling policy: what, if anything, is due right now. No I/O.
use super::config::{BackupConfig, DestKind, Destination};
use super::state::BackupState;

pub const HOURLY_AFTER_SECS: i64 = 55 * 60;
/// A store with no open caja still backs up twice a day, so staleness alerts never trip overnight.
pub const IDLE_KEEPALIVE_SECS: i64 = 12 * 3600;
pub const RETRY_BACKOFF_SECS: i64 = 10 * 60;
pub const R2_COPY_RETRY_SECS: i64 = 30 * 60;
/// After a failed copy to a drive, the next tick leaves it alone for this long (re-insertion resets it).
pub const DEVICE_COPY_RETRY_SECS: i64 = 30 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Hourly,
    CajaClose,
    PreUpdate,
    PreSwitch,
    Manual,
    /// Taken by `restore --swap` before it replaces the live database (not a CLI value).
    PreRestore,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Hourly => "hourly",
            Reason::CajaClose => "caja-close",
            Reason::PreUpdate => "pre-update",
            Reason::PreSwitch => "pre-switch",
            Reason::Manual => "manual",
            Reason::PreRestore => "pre-restore",
        }
    }
    pub fn parse(s: &str) -> Option<Reason> {
        Some(match s {
            "hourly" => Reason::Hourly,
            "caja-close" => Reason::CajaClose,
            "pre-update" => Reason::PreUpdate,
            "pre-switch" => Reason::PreSwitch,
            "manual" => Reason::Manual,
            "pre-restore" => Reason::PreRestore,
            _ => return None,
        })
    }
    /// Protected snapshots carry the restic tag `protect` and survive 30 days beyond the keep rules.
    pub fn protected(self) -> bool {
        matches!(self, Reason::PreUpdate | Reason::PreSwitch | Reason::PreRestore)
    }
}

/// What the tick saw in the database (read-only): see `run::observe`.
#[derive(Clone, Copy, Debug)]
pub struct Observed {
    pub now: i64,
    pub db_reachable: bool,
    pub caja_open: bool,
    /// `max(closed_at)` of `public.caja_sessions` where `status = 'closed'`, epoch seconds, 0 when none.
    pub max_caja_closed_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Backup(Reason),
    /// No new dump: some destination is missing snapshots the local repository already has.
    CopyOnly,
    Skip(&'static str),
}

/// A reachable destination that does not yet hold the newest local snapshot and is not inside its retry window.
/// Compared by snapshot id, never by time: a clock that went backwards must not make a missing copy look present.
/// The one per-destination predicate: `copy_pending` and the copy-only run both use it.
pub fn dest_copy_due(state: &BackupState, d: &Destination, now: i64) -> bool {
    let Some(local) = &state.local else { return false };
    let ds = state.destinations.get(&d.name);
    let reachable = ds.map(|s| s.reachable).unwrap_or(d.kind == DestKind::R2);
    let has_newest = ds.and_then(|s| s.last_success.as_ref()).is_some_and(|s| crate::backup::restic::same_snapshot(&s.id, &local.id));
    reachable && !has_newest && now >= ds.map(|s| s.next_copy_attempt_at).unwrap_or(0)
}

pub fn copy_pending(state: &BackupState, cfg: &BackupConfig, now: i64) -> bool {
    cfg.destinations.iter().any(|d| dest_copy_due(state, d, now))
}

/// Clock rules: every comparison against a stored time treats a negative difference as "unknown, act", never as
/// "recent, wait". A backwards clock can therefore cause one extra backup but never a silent gap.
pub fn decide(state: &BackupState, obs: &Observed, copy_pending: bool) -> Decision {
    // backing off only applies while 0 <= elapsed < RETRY_BACKOFF_SECS; an attempt stamped in the future does not count
    let since_attempt = obs.now - state.last_attempt_at;
    let backoff = state.last_attempt_at > 0 && !state.last_attempt_ok && (0..RETRY_BACKOFF_SECS).contains(&since_attempt);
    let due = if !obs.db_reachable || backoff {
        None
    } else if obs.max_caja_closed_at > 0 && obs.max_caja_closed_at != state.caja_close_watermark {
        // Caja rule: the newest closed caja differs from the one the last caja-close backup covered. Inequality, not
        // ">", so a watermark that came from a clock running ahead cannot hide a real close; after that backup the run
        // stores the observed value as the watermark and the trigger settles. Cost of a deleted newest caja: one extra backup.
        Some(Reason::CajaClose)
    } else if state.backup_due_now {
        // a restore could not take its own backup while the tills were fenced: take it now (backoff and an unreachable database still apply)
        Some(Reason::Hourly)
    } else {
        match &state.local {
            None => Some(Reason::Hourly),
            Some(l) => {
                let age = obs.now - l.at;
                if age < 0 || (obs.caja_open && age >= HOURLY_AFTER_SECS) || age >= IDLE_KEEPALIVE_SECS {
                    Some(Reason::Hourly)
                } else {
                    None
                }
            }
        }
    };
    match due {
        Some(r) => Decision::Backup(r),
        None if copy_pending => Decision::CopyOnly,
        None => Decision::Skip(if !obs.db_reachable { "db-unreachable" } else if backoff { "backoff" } else { "not-due" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::config::{BackupConfig, DestKind, Destination};
    use crate::backup::state::{BackupState, DestState, SnapRef};

    const NOW: i64 = 1_790_000_000;

    fn snap(age: i64) -> Option<SnapRef> {
        Some(SnapRef { id: "a1b2c3d4".into(), at: NOW - age, reason: "hourly".into() })
    }
    /// An older snapshot, different from the local one (a different id, as restic would give it).
    fn older(age: i64) -> Option<SnapRef> {
        Some(SnapRef { id: "00000000".into(), at: NOW - age, reason: "hourly".into() })
    }
    fn obs(caja_open: bool, closed_at: i64) -> Observed {
        Observed { now: NOW, db_reachable: true, caja_open, max_caja_closed_at: closed_at }
    }
    fn st(age: Option<i64>) -> BackupState {
        BackupState { local: age.and_then(snap), last_attempt_ok: true, ..Default::default() }
    }

    #[test]
    fn a_flagged_state_is_due_at_once_even_with_a_fresh_snapshot_but_still_respects_backoff_and_an_unreachable_database() {
        let mut s = st(Some(120));
        s.backup_due_now = true;
        assert_eq!(decide(&s, &obs(false, 0), false), Decision::Backup(Reason::Hourly));
        let mut down = obs(false, 0);
        down.db_reachable = false;
        assert_eq!(decide(&s, &down, false), Decision::Skip("db-unreachable"));
        s.last_attempt_at = NOW - 60;
        s.last_attempt_ok = false;
        assert_eq!(decide(&s, &obs(false, 0), false), Decision::Skip("backoff"));
    }

    #[test]
    fn the_first_run_is_due_immediately() {
        assert_eq!(decide(&st(None), &obs(false, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_caja_closed_after_the_watermark_triggers_a_caja_close_backup_even_if_one_ran_minutes_ago() {
        let mut s = st(Some(120));
        s.caja_close_watermark = NOW - 3600;
        assert_eq!(decide(&s, &obs(false, NOW - 60), false), Decision::Backup(Reason::CajaClose));
    }

    #[test]
    fn a_caja_close_already_covered_by_the_watermark_does_not_repeat() {
        let mut s = st(Some(120));
        s.caja_close_watermark = NOW - 60;
        assert_eq!(decide(&s, &obs(false, NOW - 60), false), Decision::Skip("not-due"));
    }

    #[test]
    fn while_the_caja_is_open_the_hourly_backup_is_due_after_55_minutes() {
        assert_eq!(decide(&st(Some(54 * 60)), &obs(true, 0), false), Decision::Skip("not-due"));
        assert_eq!(decide(&st(Some(55 * 60)), &obs(true, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_closed_store_still_backs_up_every_12_hours_so_the_alerts_never_trip_overnight() {
        assert_eq!(decide(&st(Some(11 * 3600 + 59 * 60)), &obs(false, 0), false), Decision::Skip("not-due"));
        assert_eq!(decide(&st(Some(12 * 3600)), &obs(false, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_failed_attempt_backs_off_ten_minutes() {
        let mut s = st(Some(2 * 3600));
        s.last_attempt_at = NOW - 5 * 60;
        s.last_attempt_ok = false;
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Skip("backoff"));
        s.last_attempt_at = NOW - 11 * 60;
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_backup_exactly_ten_minutes_after_a_failed_attempt_is_no_longer_backed_off() {
        let mut s = st(Some(2 * 3600));
        s.last_attempt_ok = false;
        s.last_attempt_at = NOW - RETRY_BACKOFF_SECS + 1;
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Skip("backoff"));
        s.last_attempt_at = NOW - RETRY_BACKOFF_SECS;
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn during_backoff_a_pending_copy_still_runs() {
        let mut s = st(Some(2 * 3600));
        s.last_attempt_at = NOW - 60;
        s.last_attempt_ok = false;
        assert_eq!(decide(&s, &obs(true, 0), true), Decision::CopyOnly);
    }

    #[test]
    fn a_clock_that_went_backwards_never_silences_the_backup() {
        // the newest snapshot claims to be an hour in the future: age is negative, the backup is due, and it resets the reference
        let s = st(Some(-3600));
        assert_eq!(decide(&s, &obs(false, 0), false), Decision::Backup(Reason::Hourly));
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_failed_attempt_stamped_in_the_future_does_not_back_off() {
        let mut s = st(Some(2 * 3600));
        s.last_attempt_at = NOW + 3600;
        s.last_attempt_ok = false;
        assert_eq!(decide(&s, &obs(true, 0), false), Decision::Backup(Reason::Hourly));
    }

    #[test]
    fn a_caja_closed_under_a_skewed_watermark_still_triggers_and_then_settles() {
        // the watermark came from a clock that ran ahead; the real close is earlier than it but is a different value
        let mut s = st(Some(120));
        s.caja_close_watermark = NOW + 86_400;
        assert_eq!(decide(&s, &obs(false, NOW - 60), false), Decision::Backup(Reason::CajaClose));
        // after that backup the run stores the observed value as the watermark, so it does not repeat
        s.caja_close_watermark = NOW - 60;
        assert_eq!(decide(&s, &obs(false, NOW - 60), false), Decision::Skip("not-due"));
    }

    #[test]
    fn copy_pending_compares_snapshot_ids_not_times() {
        let cfg = cfg_with(DestKind::Device);
        let mk = |dest_id: &str, dest_at: i64| {
            let mut s = st(Some(600)); // local: id a1b2c3d4, at NOW-600
            s.destinations.insert("usb-e".into(), DestState { reachable: true, last_success: Some(SnapRef { id: dest_id.into(), at: dest_at, reason: "hourly".into() }), ..Default::default() });
            s
        };
        // same id: nothing pending, whether the destination's recorded time is older or newer than the local one
        assert!(!copy_pending(&mk("a1b2c3d4", NOW - 7200), &cfg, NOW));
        assert!(!copy_pending(&mk("a1b2c3d4", NOW + 7200), &cfg, NOW));
        // different id: pending, even though the destination's recorded time is NEWER (the clock went backwards)
        assert!(copy_pending(&mk("ffffffff", NOW + 7200), &cfg, NOW));
        assert!(copy_pending(&mk("ffffffff", NOW - 7200), &cfg, NOW));
    }

    #[test]
    fn with_the_database_down_pending_copies_still_run() {
        let o = Observed { now: NOW, db_reachable: false, caja_open: false, max_caja_closed_at: 0 };
        assert_eq!(decide(&st(Some(10)), &o, true), Decision::CopyOnly);
        assert_eq!(decide(&st(Some(10)), &o, false), Decision::Skip("db-unreachable"));
    }

    fn cfg_with(kind: DestKind) -> BackupConfig {
        BackupConfig {
            destinations: vec![Destination { name: "usb-e".into(), kind, path: Some(r"E:\b".into()), repo: Some("s3:x".into()), volume_serial: None, added_at: 0, extra: Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn a_reinserted_usb_gets_the_missing_snapshots_without_a_new_dump() {
        let mut s = st(Some(600));
        s.destinations.insert("usb-e".into(), DestState { reachable: false, last_success: older(7200), ..Default::default() });
        let cfg = cfg_with(DestKind::Device);
        assert!(!copy_pending(&s, &cfg, NOW), "unplugged: nothing to do");
        s.destinations.get_mut("usb-e").unwrap().reachable = true;
        assert!(copy_pending(&s, &cfg, NOW));
        assert_eq!(decide(&s, &obs(false, 0), copy_pending(&s, &cfg, NOW)), Decision::CopyOnly);
    }

    #[test]
    fn an_up_to_date_destination_has_nothing_pending_and_r2_retries_are_spaced() {
        let mut s = st(Some(600));
        s.destinations.insert("usb-e".into(), DestState { reachable: true, last_success: snap(600), ..Default::default() });
        assert!(!copy_pending(&s, &cfg_with(DestKind::Device), NOW));
        let mut s2 = st(Some(600));
        s2.destinations.insert("usb-e".into(), DestState { reachable: true, last_success: older(7200), next_copy_attempt_at: NOW + R2_COPY_RETRY_SECS, ..Default::default() });
        assert!(!copy_pending(&s2, &cfg_with(DestKind::R2), NOW));
    }

    #[test]
    fn reasons_round_trip_and_only_pre_update_pre_switch_and_pre_restore_are_protected() {
        for r in [Reason::Hourly, Reason::CajaClose, Reason::PreUpdate, Reason::PreSwitch, Reason::Manual, Reason::PreRestore] {
            assert_eq!(Reason::parse(r.as_str()), Some(r));
        }
        assert!(Reason::PreUpdate.protected() && Reason::PreSwitch.protected() && Reason::PreRestore.protected());
        assert!(!Reason::Hourly.protected() && !Reason::Manual.protected() && !Reason::CajaClose.protected());
        assert_eq!(Reason::parse("nightly"), None);
    }
}
