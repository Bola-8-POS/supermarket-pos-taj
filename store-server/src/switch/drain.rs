//! Has every till said, after the drain began, that it has seen the fence and holds nothing unsent?
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// One row of public.till_sync_report as the switch reads it (SQL_TILLS).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TillRow {
    pub terminal_uuid: String,
    pub terminal_label: String,
    pub queue_depth: i64,
    pub dead_letter_depth: i64,
    pub seen_state: String,
    pub app_version: Option<String>,
    /// auth.uid() of the signed-in account that sent the report: shown in the TILL_* items so a forged row is attributable.
    pub reported_by: String,
    pub age_s: i64,
    pub after_drain: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Pending {
    Queued {
        label: String,
        uuid: String,
        depth: i64,
    },
    /// Unsent work parked for a person: the old tab dead-letter queue and offline sales in manager review. It never drains by
    /// itself, whatever the till reported about the fence.
    DeadLetters {
        label: String,
        uuid: String,
        depth: i64,
    },
    NotSeenDrain {
        label: String,
        uuid: String,
    },
    NeverReported {
        label: String,
    },
}

/// What still blocks the freeze. Empty = every non-waived till is drained. `expected` are the caja terminal labels that
/// opened a caja in the last 30 days: a label that never reported (an older build, or never signed in since) blocks too,
/// because its queue is unknowable. The owner waives a till explicitly, by install id or by a label that is unique among the
/// reports; a waiver covers that till only (its queue and its dead letters). A label shared by two tills is a usage error
/// (WAIVE_AMBIGUOUS): the owner must name the install id. A waived label that never reported waives its NeverReported item.
pub fn evaluate_drain(
    rows: &[TillRow],
    expected: &[String],
    waived: &BTreeSet<String>,
) -> R<Vec<Pending>> {
    let mut skip_uuids: BTreeSet<&str> = BTreeSet::new();
    let mut skip_labels: BTreeSet<&str> = BTreeSet::new();
    // reports store lower(uuid): an install id typed in upper case still names its till
    let waived: BTreeSet<String> = waived
        .iter()
        .map(|w| {
            if is_uuid_shaped(w) {
                w.to_lowercase()
            } else {
                w.clone()
            }
        })
        .collect();
    for w in &waived {
        if rows.iter().any(|r| &r.terminal_uuid == w) {
            skip_uuids.insert(w.as_str());
            continue;
        }
        let uuids: BTreeSet<&str> = rows
            .iter()
            .filter(|r| &r.terminal_label == w)
            .map(|r| r.terminal_uuid.as_str())
            .collect();
        match uuids.len() {
            0 if expected.iter().any(|l| l == w) => {
                skip_labels.insert(w.as_str());
            }
            0 => {
                return Err(OpError::new(
                    OpCode::Usage,
                    "WAIVE_UNKNOWN",
                    format!("{w} names no till that reported and no terminal that opened a caja in the last 30 days"),
                ))
            }
            1 => skip_uuids.extend(uuids),
            _ => {
                return Err(OpError::new(
                    OpCode::Usage,
                    "WAIVE_AMBIGUOUS",
                    format!(
                        "{} tills report the label {w}; waive the one you mean by its install id: {}",
                        uuids.len(),
                        uuids.iter().copied().collect::<Vec<_>>().join(", ")
                    ),
                ))
            }
        }
    }
    let mut out: Vec<Pending> = vec![];
    for r in rows
        .iter()
        .filter(|r| !skip_uuids.contains(r.terminal_uuid.as_str()))
    {
        let seen = r.after_drain && matches!(r.seen_state.as_str(), "draining" | "frozen");
        if !seen {
            out.push(Pending::NotSeenDrain {
                label: r.terminal_label.clone(),
                uuid: r.terminal_uuid.clone(),
            });
        } else if r.queue_depth > 0 {
            out.push(Pending::Queued {
                label: r.terminal_label.clone(),
                uuid: r.terminal_uuid.clone(),
                depth: r.queue_depth,
            });
        }
        if r.dead_letter_depth > 0 {
            out.push(Pending::DeadLetters {
                label: r.terminal_label.clone(),
                uuid: r.terminal_uuid.clone(),
                depth: r.dead_letter_depth,
            });
        }
    }
    for l in expected {
        let covered = rows.iter().any(|r| &r.terminal_label == l);
        if !covered && !skip_labels.contains(l.as_str()) {
            out.push(Pending::NeverReported { label: l.clone() });
        }
    }
    out.sort();
    out.dedup(); // one line per till: the install id is part of every item
    Ok(out)
}

fn is_uuid_shaped(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(label: &str, depth: i64, after: bool, seen: &str) -> TillRow {
        TillRow {
            terminal_uuid: format!("uuid-{label}"),
            terminal_label: label.into(),
            queue_depth: depth,
            dead_letter_depth: 0,
            seen_state: seen.into(),
            app_version: Some("1.0.0".into()),
            reported_by: "u".into(),
            age_s: 3,
            after_drain: after,
        }
    }
    fn eval(rows: &[TillRow], expected: &[String], waived: &BTreeSet<String>) -> Vec<Pending> {
        evaluate_drain(rows, expected, waived).unwrap()
    }
    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn drained_means_reported_after_the_drain_began_having_seen_it_with_an_empty_queue() {
        let rows = [
            row("POS-1", 0, true, "draining"),
            row("POS-2", 0, true, "frozen"),
        ];
        assert!(eval(&rows, &["POS-1".into(), "POS-2".into()], &none()).is_empty());
    }

    #[test]
    fn a_till_still_holding_work_is_pending_with_its_depth() {
        let p = eval(&[row("POS-1", 4, true, "draining")], &[], &none());
        assert_eq!(
            p,
            vec![Pending::Queued {
                label: "POS-1".into(),
                uuid: "uuid-POS-1".into(),
                depth: 4
            }]
        );
    }

    #[test]
    fn an_old_report_does_not_count_even_if_it_was_empty() {
        let p = eval(&[row("POS-1", 0, false, "active")], &[], &none());
        assert_eq!(
            p,
            vec![Pending::NotSeenDrain {
                label: "POS-1".into(),
                uuid: "uuid-POS-1".into()
            }]
        );
    }

    #[test]
    fn a_report_after_the_drain_that_still_says_active_means_the_till_never_saw_the_fence() {
        let p = eval(&[row("POS-1", 0, true, "active")], &[], &none());
        assert_eq!(
            p,
            vec![Pending::NotSeenDrain {
                label: "POS-1".into(),
                uuid: "uuid-POS-1".into()
            }]
        );
    }

    #[test]
    fn a_till_that_sold_in_the_last_30_days_but_never_reported_blocks_until_waived() {
        let expected = ["POS-1".to_string(), "POS-9".to_string()];
        let rows = [row("POS-1", 0, true, "draining")];
        assert_eq!(
            eval(&rows, &expected, &none()),
            vec![Pending::NeverReported {
                label: "POS-9".into()
            }]
        );
        let waived: BTreeSet<String> = ["POS-9".to_string()].into();
        assert!(eval(&rows, &expected, &waived).is_empty());
    }

    #[test]
    fn waiving_by_install_id_works_too_and_waiving_one_till_does_not_hide_another() {
        let rows = [
            row("POS-1", 5, true, "draining"),
            row("POS-2", 7, true, "draining"),
        ];
        let waived: BTreeSet<String> = ["uuid-POS-1".to_string()].into();
        assert_eq!(
            eval(&rows, &[], &waived),
            vec![Pending::Queued {
                label: "POS-2".into(),
                uuid: "uuid-POS-2".into(),
                depth: 7
            }]
        );
    }

    #[test]
    fn the_result_is_ordered_and_free_of_duplicates() {
        let rows = [
            row("POS-2", 1, true, "draining"),
            row("POS-1", 1, true, "draining"),
            row("POS-1", 1, true, "draining"),
        ];
        let p = eval(&rows, &[], &none());
        assert_eq!(p.len(), 2);
        assert!(p[0] < p[1]);
    }

    fn dead(label: &str, uuid: &str, dead: i64) -> TillRow {
        TillRow {
            terminal_uuid: uuid.into(),
            dead_letter_depth: dead,
            ..row(label, 0, true, "draining")
        }
    }

    #[test]
    fn dead_letters_keep_a_till_pending_even_when_it_has_seen_the_fence_and_its_queue_is_empty() {
        let rows = [dead("POS-1", "u1", 1)];
        assert_eq!(
            eval(&rows, &[], &none()),
            vec![Pending::DeadLetters {
                label: "POS-1".into(),
                uuid: "u1".into(),
                depth: 1
            }]
        );
        let mut frozen = dead("POS-1", "u1", 2);
        frozen.seen_state = "frozen".into();
        assert_eq!(eval(&[frozen], &[], &none()).len(), 1);
    }

    #[test]
    fn a_waiver_by_exact_install_id_clears_both_the_queue_and_the_dead_letters_of_that_till_only() {
        let mut busy = dead("POS-1", "u1", 3);
        busy.queue_depth = 4;
        let other = dead("POS-2", "u2", 1);
        let waived: BTreeSet<String> = ["u1".to_string()].into();
        assert_eq!(
            eval(&[busy, other], &[], &waived),
            vec![Pending::DeadLetters {
                label: "POS-2".into(),
                uuid: "u2".into(),
                depth: 1
            }]
        );
    }

    #[test]
    fn a_label_shared_by_two_tills_cannot_be_waived_by_label() {
        let rows = [dead("POS-1", "u1", 1), dead("POS-1", "u2", 1)];
        let waived: BTreeSet<String> = ["POS-1".to_string()].into();
        let e = evaluate_drain(&rows, &[], &waived).unwrap_err();
        assert_eq!(
            (e.reason.as_str(), e.code),
            ("WAIVE_AMBIGUOUS", OpCode::Usage)
        );
        // naming one install id is exact
        let by_id: BTreeSet<String> = ["u1".to_string()].into();
        assert_eq!(eval(&rows, &[], &by_id).len(), 1);
    }

    #[test]
    fn a_unique_label_waives_its_till() {
        let rows = [dead("POS-1", "u1", 1), dead("POS-2", "u2", 1)];
        let waived: BTreeSet<String> = ["POS-1".to_string()].into();
        assert_eq!(eval(&rows, &[], &waived).len(), 1);
    }

    #[test]
    fn two_tills_sharing_a_label_and_depth_stay_two_lines_each_naming_its_install_id() {
        let rows = [dead("POS-1", "u1", 2), dead("POS-1", "u2", 2)];
        let p = eval(&rows, &[], &none());
        assert_eq!(p.len(), 2);
        assert!(p
            .iter()
            .any(|x| matches!(x, Pending::DeadLetters { uuid, .. } if uuid == "u1")));
        assert!(p
            .iter()
            .any(|x| matches!(x, Pending::DeadLetters { uuid, .. } if uuid == "u2")));
    }

    #[test]
    fn the_ambiguous_label_message_lists_the_install_ids_to_choose_from() {
        let rows = [dead("POS-1", "u1", 1), dead("POS-1", "u2", 1)];
        let waived: BTreeSet<String> = ["POS-1".to_string()].into();
        let e = evaluate_drain(&rows, &[], &waived).unwrap_err();
        assert!(
            e.message.contains("u1") && e.message.contains("u2"),
            "{}",
            e.message
        );
    }

    #[test]
    fn an_upper_case_install_id_waives_the_till_whose_report_stores_it_in_lower_case() {
        let id = "0a1b2c3d-0000-4000-8000-00000000abcd";
        let rows = [dead("POS-1", id, 1)];
        let waived: BTreeSet<String> = [id.to_uppercase()].into();
        assert!(eval(&rows, &[], &waived).is_empty());
    }

    #[test]
    fn a_waiver_that_names_no_report_and_no_expected_label_is_a_usage_error() {
        let rows = [dead("POS-1", "u1", 1)];
        let waived: BTreeSet<String> = ["POS-7".to_string()].into();
        let e = evaluate_drain(&rows, &["POS-1".into()], &waived).unwrap_err();
        assert_eq!(
            (e.reason.as_str(), e.code),
            ("WAIVE_UNKNOWN", OpCode::Usage)
        );
        // an expected label that never reported is still a known name
        let ok: BTreeSet<String> = ["POS-9".to_string()].into();
        assert!(evaluate_drain(&[], &["POS-9".into()], &ok)
            .unwrap()
            .is_empty());
    }
}
