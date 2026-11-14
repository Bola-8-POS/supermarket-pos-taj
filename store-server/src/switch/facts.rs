//! Everything `switch plan` and `switch run` must know before they touch anything, as plain data (`PlanFacts`), and the
//! pure rules that turn it into findings. `collect` is the only part that talks to databases.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::swap::{disk_ok, free_bytes, DiskVerdict, PsqlAdmin};
use crate::ops::world::R;
use crate::switch::cloud::{parse_labels, parse_tills, CloudDb, SQL_EXPECTED_LABELS, SQL_TILLS};
use crate::switch::drain::TillRow;
use crate::switch::sig::{compare, parse_sig, SchemaSig, SQL_CHECKS, SQL_COLUMNS, SQL_ENUMS};
use crate::switch::tables;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Block,
    Warn,
    Info,
}

/// The hosted fence is TWO migrations: 000001 creates the objects, 000002 turns the statement guard into a write barrier
/// (`FOR SHARE` on the state row). The plan refuses a cloud that has only the first.
pub const FENCE_MIGRATIONS: [&str; 2] = ["20261025000001", "20261025000002"];

/// One till a finding is about: a waiver (`--waive-terminal`) names it by this uuid or label. Both are control-stripped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FindingTill {
    pub uuid: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub code: String,
    pub level: Level,
    pub message: String,
    pub items: Vec<String>,
    /// Set on TILL_QUEUED and TILL_DEAD_LETTERS only: which tills a per-till waiver can clear.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tills: Vec<FindingTill>,
}

/// Till labels, uuids and app versions come from rows any signed-in till can write: nothing from them reaches an operator
/// terminal with a control or bidirectional-override character in it (escape sequences, line breaks, RTL spoofing).
pub fn clean_text(s: &str) -> String {
    s.chars().filter(|c| !is_unsafe_char(*c)).collect()
}
fn is_unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c as u32,
            0x00AD | 0x034F | 0x061C | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F
                | 0x2028..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0
                | 0xFFF9..=0xFFFB | 0xE0000..=0xE0FFF
        )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffRow {
    pub id: String,
    pub role: String,
    pub active: bool,
    pub deleted: bool,
    pub pin_ok: bool,
    pub has_auth: bool,
    pub banned: bool,
}
impl StaffRow {
    pub fn admin_ok(&self) -> bool {
        self.role == "admin"
            && self.active
            && !self.deleted
            && self.pin_ok
            && self.has_auth
            && !self.banned
    }
}

#[derive(Debug, Clone)]
pub struct PlanFacts {
    pub fence_present: bool,
    /// The fence objects exist but `store_fence_guard` is not the barrier of 000002 (no `FOR SHARE`).
    pub fence_outdated: bool,
    pub fence_missing_tables: Vec<String>,
    /// Tables whose `store_fence_guard` trigger is disabled or replica-mode (`tgenabled <> 'O'`): the guard would not fire.
    pub fence_disabled: Vec<String>,
    /// The connecting (operator) role may `SET session_replication_role`: the guard skips THAT session only.
    pub role_can_bypass: bool,
    /// Writer roles (anon, authenticated, service_role) that may `SET session_replication_role`: any till or API client could skip the guard.
    pub writer_roles_can_bypass: Vec<String>,
    /// The cloud is older than PostgreSQL 15: `has_parameter_privilege` does not exist, so the bypass check could not run.
    pub bypass_unchecked: bool,
    /// `role@database` (`*` = all) entries and `system` whose default `session_replication_role` is not `origin`: every session starts in replica mode.
    pub default_replica: Vec<String>,
    pub source_state: String,
    pub pack_migrations: BTreeSet<String>,
    pub source_migrations: BTreeSet<String>,
    pub source_pg_major: u32,
    pub pack_pg_major: u32,
    pub source_gotrue_max: String,
    pub local_gotrue_max: String,
    pub schema_diffs: Vec<String>,
    /// (constraint name, violating rows); -1 rows = the check could not be evaluated.
    pub check_violations: Vec<(String, i64)>,
    pub staff: Vec<StaffRow>,
    pub free_bytes: u64,
    pub source_bytes: u64,
    pub local_bytes: u64,
    pub droppable_bytes: u64,
    pub tills: Vec<TillRow>,
    pub expected_labels: Vec<String>,
    pub closure_unexpected: Vec<String>,
    pub closure_allowed: Vec<String>,
    pub storage_objects: u64,
    pub has_storage_creds: bool,
    pub photo_import_available: bool,
    pub null_token_users: i64,
    pub local_sales: i64,
    pub local_inputs_missing: Vec<String>,
    pub source_collation: String,
    pub local_collation: String,
    pub copy_tables: Vec<String>,
    /// auth.users of THIS server that have no profile (the health canary): they are kept across the load.
    pub keep_auth_ids: Vec<String>,
}

fn capped(mut items: Vec<String>) -> Vec<String> {
    if items.len() > 20 {
        let more = items.len() - 20;
        items.truncate(20);
        items.push(format!("... and {more} more"));
    }
    items
}
fn finding(code: &str, level: Level, message: &str, items: Vec<String>) -> Finding {
    Finding {
        code: code.into(),
        level,
        message: message.into(),
        items: capped(items),
        tills: vec![],
    }
}
fn till_ref(t: &TillRow) -> FindingTill {
    FindingTill {
        uuid: clean_text(&t.terminal_uuid),
        label: clean_text(&t.terminal_label),
    }
}

pub fn has_blockers(findings: &[Finding]) -> bool {
    findings.iter().any(|x| x.level == Level::Block)
}

// ---- per-till waivers (PM ruling D-b) ---------------------------------------------------------------------------

/// The longest waiver reason that is kept.
pub const WAIVE_REASON_MAX: usize = 200;
const WAIVE_TERMINAL_MAX: usize = 64;

/// The owner's reason for waiving a till is untrusted text: it ends up in the journal and the result. Tabs and line breaks become
/// a space, every other control or bidirectional-override character is dropped, the text is trimmed and cut to
/// `WAIVE_REASON_MAX` characters, and what is left must not be empty. It is stored as-is and never put into a shell or SQL text.
pub fn clean_reason(raw: &str) -> R<String> {
    let spaced: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let kept: String = clean_text(&spaced)
        .trim()
        .chars()
        .take(WAIVE_REASON_MAX)
        .collect();
    let kept = kept.trim().to_string();
    if kept.is_empty() {
        return Err(OpError::new(
            OpCode::Usage,
            "WAIVE_REASON_REQUIRED",
            "--waive-reason must say why the till is waived (the text was empty)",
        ));
    }
    Ok(kept)
}

/// `--waive-terminal` values plus the reason, checked before anything is opened or touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waivers {
    pub terminals: Vec<String>,
    pub reason: String,
}

impl Waivers {
    /// `None` when no terminal is waived. A terminal without a reason, or a reason without a terminal, is a usage error.
    pub fn parse(terminals: &[String], reason: Option<&str>) -> R<Option<Waivers>> {
        let usage = |r: &str, m: &str| OpError::new(OpCode::Usage, r, m.to_string());
        if terminals.is_empty() {
            return match reason {
                None => Ok(None),
                Some(_) => Err(usage(
                    "WAIVE_REASON_WITHOUT_TERMINAL",
                    "--waive-reason needs at least one --waive-terminal",
                )),
            };
        }
        let reason = clean_reason(reason.ok_or_else(|| {
            usage(
                "WAIVE_REASON_REQUIRED",
                "--waive-terminal needs --waive-reason \"<why>\"",
            )
        })?)?;
        let mut out: Vec<String> = vec![];
        for t in terminals {
            let t = t.trim();
            if t.is_empty()
                || t.chars().count() > WAIVE_TERMINAL_MAX
                || t.chars().any(is_unsafe_char)
            {
                return Err(usage("WAIVE_TERMINAL_INVALID", "--waive-terminal must be an install id or a till label (1 to 64 characters, no control characters)"));
            }
            if !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
        Ok(Some(Waivers {
            terminals: out,
            reason,
        }))
    }
}

/// The install ids a waiver names. A term matches a till exactly by uuid (compared in lower case) or by a label that no other
/// reporting till shares; a label two tills share is a usage error that lists their ids. A term that matches no till but is a
/// terminal that opened a caja recently is valid and clears nothing (TILL_NEVER_REPORTED is only a warning).
pub fn resolve_waivers(
    tills: &[TillRow],
    expected_labels: &[String],
    terms: &[String],
) -> R<BTreeSet<String>> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for w in terms {
        let lower = w.to_lowercase();
        if tills
            .iter()
            .any(|t| t.terminal_uuid.to_lowercase() == lower)
        {
            ids.insert(lower);
            continue;
        }
        let by_label: BTreeSet<String> = tills
            .iter()
            .filter(|t| clean_text(&t.terminal_label) == clean_text(w))
            .map(|t| t.terminal_uuid.to_lowercase())
            .collect();
        match by_label.len() {
            0 if expected_labels.iter().any(|l| clean_text(l) == clean_text(w)) => {}
            0 => return Err(OpError::new(OpCode::Usage, "WAIVE_UNKNOWN", format!("{} names no till that reported and no terminal that opened a caja in the last 30 days", clean_text(w)))),
            1 => ids.extend(by_label),
            n => return Err(OpError::new(OpCode::Usage, "WAIVE_AMBIGUOUS",
                format!("{n} tills report the label {}; waive the one you mean by its install id: {}", clean_text(w), by_label.into_iter().map(|u| clean_text(&u)).collect::<Vec<_>>().join(", ")))),
        }
    }
    Ok(ids)
}

/// `resolve_waivers`, except on a cloud without the fence: it has no till reports to waive, so FENCE_NOT_INSTALLED is the answer.
pub fn resolve_waivers_for(p: &PlanFacts, terms: &[String]) -> R<BTreeSet<String>> {
    if !p.fence_present {
        return Ok(BTreeSet::new());
    }
    resolve_waivers(&p.tills, &p.expected_labels, terms)
}

pub fn evaluate(p: &PlanFacts) -> Vec<Finding> {
    evaluate_waived(p, &BTreeSet::new())
}

/// `evaluate`, with the tills in `waived` (install ids from `resolve_waivers`) left out of TILL_QUEUED and TILL_DEAD_LETTERS:
/// a waiver covers that till's unsent work and failed work, and nothing else (not the fence, not another till).
pub fn evaluate_waived(p: &PlanFacts, waived: &BTreeSet<String>) -> Vec<Finding> {
    use Level::{Block, Info, Warn};
    let mut v: Vec<Finding> = vec![];
    if !p.fence_present {
        v.push(finding("FENCE_NOT_INSTALLED", Block,
            "the cloud project does not have the store fence yet: the owner must deploy migrations 20261025000001 and 20261025000002 first (docs/two-mode/cloud-to-local-switch.md)", vec![]));
    } else {
        if p.fence_outdated {
            v.push(finding("FENCE_OUTDATED", Block,
                "the cloud has the first fence migration only: its write guard is not yet a barrier, so a write in flight could be lost; deploy migration 20261025000002 first", vec![]));
        }
        if !p.fence_missing_tables.is_empty() {
            v.push(finding(
                "FENCE_TABLES_UNGUARDED",
                Block,
                "these cloud tables have no write guard, so a freeze would not stop writes to them",
                p.fence_missing_tables.clone(),
            ));
        }
        if !p.fence_disabled.is_empty() {
            v.push(finding("FENCE_GUARD_DISABLED", Block, "the write guard trigger is disabled or replica-only on these cloud tables, so a freeze would not stop writes to them", p.fence_disabled.clone()));
        }
        if !p.writer_roles_can_bypass.is_empty() {
            v.push(finding("FENCE_WRITER_BYPASS", Block,
                "these cloud roles may SET session_replication_role, so any client using them can skip the write guard and write through a freeze", p.writer_roles_can_bypass.clone()));
        }
        if !p.default_replica.is_empty() {
            v.push(finding("FENCE_DEFAULT_REPLICA", Block,
                "sessions of these cloud roles, databases or the whole server start with session_replication_role set to anything other than origin (`local` skips the write guard just like `replica`; the test is IS DISTINCT FROM origin), so the write guard is skipped for them; an entry named `system` is a default set at the role, database or server level that the checking session itself reads", p.default_replica.clone()));
        }
        if p.bypass_unchecked {
            v.push(finding("FENCE_BYPASS_UNCHECKABLE", Block,
                "the cloud runs PostgreSQL older than 15, where it cannot be checked which roles may skip the write guard", vec![]));
        }
        if p.role_can_bypass {
            let tail = if p.writer_roles_can_bypass.is_empty() {
                "; the tills and API clients use other roles and stay stopped"
            } else {
                ""
            };
            v.push(finding("FENCE_BYPASS_POSSIBLE", Warn,
                &format!("the cloud role used for the switch may SET session_replication_role, which would make the write guard skip this session's own writes{tail}"), vec![]));
        }
        if p.source_state != "active" {
            v.push(finding("CLOUD_NOT_ACTIVE", Block, "the cloud store is not active: another switch is running, or the store already moved", vec![p.source_state.clone()]));
        }
    }
    let behind: Vec<String> = p
        .pack_migrations
        .difference(&p.source_migrations)
        .cloned()
        .collect();
    let ahead: Vec<String> = p
        .source_migrations
        .difference(&p.pack_migrations)
        .cloned()
        .collect();
    if !behind.is_empty() {
        v.push(finding("SCHEMA_LEVEL_BEHIND", Block, "the cloud project lacks migrations this server carries: deploy them to the cloud first", behind));
    }
    if !ahead.is_empty() {
        v.push(finding("SCHEMA_LEVEL_AHEAD", Block, "the cloud project is ahead of this server's backend pack: install the newer pack first", ahead));
    }
    if !p.schema_diffs.is_empty() {
        v.push(finding(
            "SCHEMA_SHAPE_MISMATCH",
            Block,
            "the cloud tables are not shaped like this server's",
            p.schema_diffs.clone(),
        ));
    }
    if p.source_pg_major > p.pack_pg_major {
        v.push(finding(
            "SOURCE_PG_NEWER",
            Block,
            "the cloud database runs a newer PostgreSQL than this pack's pg_dump",
            vec![format!(
                "cloud {} > pack {}",
                p.source_pg_major, p.pack_pg_major
            )],
        ));
    }
    if p.source_gotrue_max > p.local_gotrue_max {
        v.push(finding(
            "GOTRUE_NEWER",
            Block,
            "the cloud's sign-in service is newer than the one in this pack",
            vec![format!("{} > {}", p.source_gotrue_max, p.local_gotrue_max)],
        ));
    }
    if !p.check_violations.is_empty() {
        let items = p
            .check_violations
            .iter()
            .map(|(n, c)| {
                if *c < 0 {
                    format!("{n}: could not be evaluated")
                } else {
                    format!("{n}: {c} rows")
                }
            })
            .collect();
        v.push(finding(
            "CHECK_VIOLATIONS",
            Block,
            "cloud rows break a CHECK constraint (a NOT VALID one) and would be rejected at load",
            items,
        ));
    }
    if !p.staff.iter().any(StaffRow::admin_ok) {
        v.push(finding("NO_VALID_ADMIN", Block, "no active, undeleted, unbanned admin with a stored PIN hash and a sign-in account exists in the cloud: nobody could sign in afterwards", vec![]));
    }
    let no_pin: Vec<String> = p
        .staff
        .iter()
        .filter(|s| !s.pin_ok)
        .map(|s| format!("{} ({})", s.id, s.role))
        .collect();
    if !no_pin.is_empty() {
        v.push(finding("STAFF_NO_VALID_PIN", Warn, "these staff have no stored PIN hash in the cloud: they cannot sign in until their PIN is reset after the switch", no_pin));
    }
    let no_auth: Vec<String> = p
        .staff
        .iter()
        .filter(|s| !s.has_auth)
        .map(|s| format!("{} ({})", s.id, s.role))
        .collect();
    if !no_auth.is_empty() {
        v.push(finding(
            "STAFF_NO_AUTH_USER",
            Warn,
            "these profiles have no sign-in account in the cloud and cannot sign in",
            no_auth,
        ));
    }
    match disk_ok(
        p.free_bytes,
        p.source_bytes + p.local_bytes,
        p.droppable_bytes,
    ) {
        DiskVerdict::Ok => {}
        DiskVerdict::OkAfterDroppingOld => v.push(finding(
            "OLD_DATABASES_DROPPED",
            Info,
            "older previous databases will be dropped to make room",
            vec![],
        )),
        DiskVerdict::Short { need } => v.push(finding(
            "DISK_LOW",
            Block,
            "not enough free disk for the copy",
            vec![format!("free {} bytes, need {need}", p.free_bytes)],
        )),
    }

    let waived_till = |t: &&TillRow| waived.contains(&t.terminal_uuid.to_lowercase());
    let queued_tills: Vec<&TillRow> = p
        .tills
        .iter()
        .filter(|t| t.queue_depth > 0 && t.age_s <= 86_400)
        .filter(|t| !waived_till(t))
        .collect();
    if !queued_tills.is_empty() {
        let items = queued_tills
            .iter()
            .map(|t| {
                format!(
                    "{}: {} unsent (reported by {})",
                    clean_text(&t.terminal_label),
                    t.queue_depth,
                    clean_text(&t.reported_by)
                )
            })
            .collect();
        let mut f = finding("TILL_QUEUED", Block, "these tills hold offline work that has not reached the cloud: wait for it to sync, then plan again", items);
        f.tills = queued_tills.iter().map(|t| till_ref(t)).collect();
        v.push(f);
    }
    let stale: Vec<String> = p
        .tills
        .iter()
        .filter(|t| t.queue_depth > 0 && t.age_s > 86_400)
        .map(|t| {
            format!(
                "{}: {} unsent, last report {} days ago (reported by {})",
                clean_text(&t.terminal_label),
                t.queue_depth,
                t.age_s / 86_400,
                clean_text(&t.reported_by)
            )
        })
        .collect();
    if !stale.is_empty() {
        v.push(finding("TILL_QUEUED_STALE", Warn, "these tills last reported unsent work more than a day ago: confirm the till is off or empty, then waive it at run time", stale));
    }
    // PM ruling D-a (plan deviation): failed offline actions and offline sales in manager review never drain by themselves and are
    // not moved, so they block like unsent work does. A manager clears them in the app; a per-till waiver is the last resort.
    let dead_tills: Vec<&TillRow> = p
        .tills
        .iter()
        .filter(|t| t.dead_letter_depth > 0)
        .filter(|t| !waived_till(t))
        .collect();
    if !dead_tills.is_empty() {
        let items = dead_tills
            .iter()
            .map(|t| {
                format!(
                    "{}: {} failed (reported by {})",
                    clean_text(&t.terminal_label),
                    t.dead_letter_depth,
                    clean_text(&t.reported_by)
                )
            })
            .collect();
        let mut f = finding("TILL_DEAD_LETTERS", Block, "these tills hold offline actions that failed for good or offline sales in manager review; clear them in the app first, they are not moved", items);
        f.tills = dead_tills.iter().map(|t| till_ref(t)).collect();
        v.push(f);
    }
    let silent: Vec<String> = p
        .tills
        .iter()
        .filter(|t| t.queue_depth == 0 && t.age_s > 900)
        .map(|t| {
            format!(
                "{} (last report {} min ago, reported by {})",
                clean_text(&t.terminal_label),
                t.age_s / 60,
                clean_text(&t.reported_by)
            )
        })
        .collect();
    if !silent.is_empty() {
        v.push(finding("TILL_SILENT", Warn, "these tills have not reported recently; each must report during the drain or be waived", silent));
    }
    let never: Vec<String> = p
        .expected_labels
        .iter()
        .filter(|l| !p.tills.iter().any(|t| &t.terminal_label == *l))
        .map(|l| clean_text(l))
        .collect();
    if !never.is_empty() {
        v.push(finding("TILL_NEVER_REPORTED", Warn, "these tills opened a caja in the last 30 days but never reported (an older app build?): update them or waive them at run time", never));
    }

    if !p.closure_unexpected.is_empty() {
        v.push(finding("CLOSURE_UNEXPECTED", Block, "these public tables reference the copied tables but are not in the copy list: they would be emptied blind", p.closure_unexpected.clone()));
    }
    if p.storage_objects > 0 && !p.has_storage_creds {
        v.push(finding("STORAGE_CREDENTIALS_NEEDED", Block, "the cloud holds stored files (product photos, logo): the storage URL and service key are needed to copy them", vec![format!("{} files", p.storage_objects)]));
    }
    // Plan 10 is a hard prerequisite (D2-a): without its real `photos import-from-cloud` command the stored files cannot move. A store with
    // no stored files is not blocked.
    if p.storage_objects > 0 && !p.photo_import_available {
        v.push(finding(
            "PLAN10_REQUIRED",
            Block,
            "this posctl cannot copy stored files yet (Plan 10's photos import-from-cloud is not part of this build)",
            vec![format!("{} files", p.storage_objects)],
        ));
    }
    if p.local_sales > 0 {
        v.push(finding(
            "LOCAL_HAS_SALES",
            Block,
            "this server already holds sales; a switch would hide them in the previous database",
            vec![format!("{} rows", p.local_sales)],
        ));
    }
    if !p.local_inputs_missing.is_empty() {
        v.push(finding(
            "LOCAL_SERVER_NOT_READY",
            Block,
            "this server lacks values its own app configuration needs; finish provisioning first",
            p.local_inputs_missing.clone(),
        ));
    }
    if p.null_token_users > 0 {
        v.push(finding(
            "NULL_TOKENS_REPAIRED",
            Info,
            "cloud sign-in accounts with NULL token columns will be repaired during the copy",
            vec![format!("{} accounts", p.null_token_users)],
        ));
    }
    if p.source_collation != p.local_collation {
        v.push(finding("COLLATION_DIFFERS", Info, "name sorting follows this server's locale (es-MX) after the switch; accented names may sort differently from the cloud",
            vec![format!("cloud {}, here {}", p.source_collation, p.local_collation)]));
    }
    v.sort_by_key(|x| match x.level {
        Block => 0,
        Warn => 1,
        Info => 2,
    });
    v
}

// ---- collection -------------------------------------------------------------------------------------------------

/// The fence OBJECTS of migration 000001 exist (the state table, the report table, the effective-state function, the guard function).
pub const SQL_FENCE_PRESENT: &str = "SELECT (to_regclass('public.store_switch_state') IS NOT NULL AND to_regclass('public.till_sync_report') IS NOT NULL \
    AND to_regprocedure('public.store_switch_effective_state()') IS NOT NULL AND to_regprocedure('public.store_fence_guard()') IS NOT NULL)";
/// Migration 000002 is in: the statement guard takes `FOR SHARE` on the state row (the write barrier). Without it a write that
/// passed the guard before the freeze can commit after the dump snapshot.
pub const SQL_FENCE_BARRIER: &str = "SELECT COALESCE((SELECT position('FOR SHARE' IN upper(p.prosrc)) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.store_fence_guard()')), false)";
/// The tables the fence must guard: every ordinary or partitioned public table except the fence's own and the lock table.
/// `fence_sql_tests.rs` imports this constant, so the tests and the plan share one predicate.
macro_rules! covered {
    () => {
        "n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname NOT IN ('store_switch_state','till_sync_report','pin_attempts')"
    };
}
pub const COVERED: &str = covered!();
/// Tables without THE guard: a trigger named `store_fence_guard` that runs `store_fence_guard()` as a BEFORE statement trigger on
/// INSERT, UPDATE, DELETE and TRUNCATE (`tgtype` 62) and is enabled for ordinary sessions. Name alone is not proof.
pub const SQL_UNGUARDED: &str = concat!(
    "SELECT COALESCE(string_agg(c.relname, ',' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ",
    covered!(),
    " AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'store_fence_guard' AND t.tgenabled = 'O' \
     AND t.tgqual IS NULL AND cardinality(t.tgattr::int2[]) = 0 AND t.tgfoid = to_regprocedure('public.store_fence_guard()') AND t.tgtype = 62)"
);
/// A guard trigger that exists but does not fire in a normal session: disabled (`D`) or replica-only (`R`).
pub const SQL_GUARD_DISABLED: &str = "SELECT COALESCE(string_agg(c.relname || ' (' || t.tgenabled::text || ')', ',' ORDER BY c.relname), '') FROM pg_trigger t \
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE n.nspname = 'public' AND t.tgname = 'store_fence_guard' AND NOT t.tgisinternal AND t.tgenabled <> 'O'";
/// PostgreSQL 15+. A role with this privilege can make the guard skip its own session (`session_replication_role = replica`).
pub const SQL_ROLE_CAN_BYPASS: &str =
    "SELECT has_parameter_privilege(current_user, 'session_replication_role', 'SET')";
/// Writer roles that may skip the guard (PostgreSQL 15+). Roles that do not exist are not listed.
pub const SQL_WRITERS_CAN_BYPASS: &str = "SELECT COALESCE(string_agg(rolname, ',' ORDER BY rolname), '') FROM pg_roles \
    WHERE rolname IN ('anon','authenticated','service_role') AND has_parameter_privilege(rolname, 'session_replication_role', 'SET')";
/// Session defaults that put sessions in replica mode: ALTER ROLE/DATABASE ... SET (`pg_db_role_setting`) and the server level (`reset_val`).
pub const SQL_DEFAULT_REPLICA: &str = "SELECT COALESCE(string_agg(x, ',' ORDER BY x), '') FROM (\
    SELECT COALESCE(r.rolname, '*') || '@' || COALESCE(d.datname, '*') AS x FROM pg_db_role_setting s \
    LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase \
    WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c ILIKE 'session_replication_role=%' AND lower(c) IS DISTINCT FROM 'session_replication_role=origin') \
    UNION ALL SELECT 'system' WHERE COALESCE((SELECT reset_val FROM pg_settings WHERE name = 'session_replication_role'), 'origin') IS DISTINCT FROM 'origin') q";
/// `SQL_UNGUARDED` as `collect` runs it. Test builds only: a T14 negative control (`mutants::M`) weakens one clause, and the DB test
/// that pins the clause must go red. In a non-test build `on` is a constant false, so this is the constant itself.
fn sql_unguarded() -> String {
    use crate::switch::mutants::{on, M};
    let (m, cut) = if on(M::GuardNoTgtype) {
        (M::GuardNoTgtype, " AND t.tgtype = 62")
    } else if on(M::GuardNoTgqual) {
        (M::GuardNoTgqual, " AND t.tgqual IS NULL")
    } else if on(M::GuardNoTgattr) {
        (M::GuardNoTgattr, " AND cardinality(t.tgattr::int2[]) = 0")
    } else if on(M::CoveredOrdinaryOnly) {
        return SQL_UNGUARDED.replace("relkind IN ('r','p')", "relkind = 'r'");
    } else {
        return SQL_UNGUARDED.to_string();
    };
    assert!(
        SQL_UNGUARDED.contains(cut),
        "mutant {m:?} no longer matches SQL_UNGUARDED"
    );
    SQL_UNGUARDED.replace(cut, "")
}
/// `SQL_DEFAULT_REPLICA` as `collect` runs it (same T14 seam).
fn sql_default_replica() -> String {
    if crate::switch::mutants::on(crate::switch::mutants::M::DefaultReplicaNoSystem) {
        let at = SQL_DEFAULT_REPLICA
            .find(" UNION ALL SELECT 'system'")
            .expect("mutant DefaultReplicaNoSystem no longer matches");
        return format!("{}) q", &SQL_DEFAULT_REPLICA[..at]);
    }
    SQL_DEFAULT_REPLICA.to_string()
}
pub const SQL_STAFF: &str = "SELECT COALESCE(json_agg(json_build_object('id', p.id, 'role', p.role::text, 'active', p.is_active, 'deleted', p.deleted_at IS NOT NULL, \
    'pinOk', COALESCE(p.pin ~ '^\\$2[aby]\\$', false), 'hasAuth', u.id IS NOT NULL, 'banned', COALESCE(u.banned_until > now(), false))), '[]'::json) \
    FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id";
pub const SQL_NULL_TOKENS: &str = "SELECT count(*) FROM auth.users WHERE confirmation_token IS NULL OR recovery_token IS NULL OR email_change_token_new IS NULL \
    OR email_change IS NULL OR email_change_token_current IS NULL OR reauthentication_token IS NULL OR phone_change_token IS NULL";
pub const SQL_LOCAL_CHECKS: &str = "SELECT c.conrelid::regclass::text || '|' || c.conname || '|' || pg_get_expr(c.conbin, c.conrelid) FROM pg_constraint c \
    JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'c' AND n.nspname = 'public' ORDER BY 1";
/// Version-proof: pg_database has no `datlocale` before PostgreSQL 17 and no `datlocprovider` before 15.
pub const SQL_COLLATION: &str = "SELECT COALESCE(to_jsonb(d)->>'datlocprovider', '?') || '|' || COALESCE(to_jsonb(d)->>'datlocale', to_jsonb(d)->>'daticulocale', to_jsonb(d)->>'datcollate', '?') \
    FROM pg_database d WHERE datname = current_database()";
pub const SQL_KEEP_IDS: &str = "SELECT COALESCE(string_agg(u.id::text, ',' ORDER BY u.id), '') FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)";
pub const SQL_DROPPABLE: &str = "SELECT COALESCE(sum(pg_database_size(datname)), 0) FROM pg_database WHERE datname LIKE 'pos\\_prev\\_%' OR datname LIKE 'pos\\_failed\\_%'";

pub struct CollectCtx<'a> {
    pub local: &'a PsqlAdmin,
    pub local_db: &'a str,
    pub cloud: &'a CloudDb,
    pub pack_dir: &'a Path,
    pub pack_pg_major: u32,
    /// A folder on the disk that holds the database (the free-space query needs an existing path).
    pub free_path: &'a Path,
    pub has_storage_creds: bool,
    pub photo_import_available: bool,
    pub local_inputs_missing: Vec<String>,
}

fn lines_set(s: &str) -> BTreeSet<String> {
    s.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}
fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}
fn num<T: std::str::FromStr>(s: &str, what: &str) -> R<T> {
    s.trim()
        .parse()
        .map_err(|_| OpError::err("FACT_UNREADABLE", format!("{what} is not a number")))
}

fn pack_migration_versions(pack_dir: &Path) -> R<BTreeSet<String>> {
    let rd = std::fs::read_dir(pack_dir.join("migrations"))
        .map_err(|e| OpError::new(OpCode::PackInvalid, "MIGRATIONS_UNREADABLE", e.to_string()))?;
    Ok(rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".sql"))
        .filter_map(|n| n.split_once('_').map(|(v, _)| v.to_string()))
        .collect())
}

pub(crate) fn read_sig(run: &dyn Fn(&str) -> R<String>) -> R<SchemaSig> {
    Ok(parse_sig(
        &run(SQL_COLUMNS)?,
        &run(SQL_ENUMS)?,
        &run(SQL_CHECKS)?,
    ))
}

pub fn collect(c: &CollectCtx<'_>) -> R<PlanFacts> {
    let cloud = |sql: &str| c.cloud.ro(sql);
    let local = |sql: &str| c.local.scalar(c.local_db, sql);

    let fence_present = cloud(SQL_FENCE_PRESENT)? == "t";
    let (mut source_state, mut fence_missing_tables, mut tills, mut expected_labels) =
        ("missing".to_string(), vec![], vec![], vec![]);
    let (mut fence_outdated, mut fence_disabled, mut role_can_bypass, mut writer_roles_can_bypass) =
        (false, vec![], false, vec![]);
    let source_pg_major: u32 = num(
        &cloud("SELECT current_setting('server_version_num')::int / 10000")?,
        "the cloud PostgreSQL version",
    )?;
    let (mut bypass_unchecked, mut default_replica) = (false, vec![]);
    if fence_present {
        source_state = cloud("SELECT (SELECT state FROM public.store_switch_effective_state())")?;
        fence_outdated = cloud(SQL_FENCE_BARRIER)? != "t";
        fence_missing_tables = split_csv(&cloud(&sql_unguarded())?);
        fence_disabled = split_csv(&cloud(SQL_GUARD_DISABLED)?);
        default_replica = split_csv(&cloud(&sql_default_replica())?);
        if source_pg_major < 15 {
            bypass_unchecked = true;
        } else {
            role_can_bypass = cloud(SQL_ROLE_CAN_BYPASS)? == "t";
            writer_roles_can_bypass = split_csv(&cloud(SQL_WRITERS_CAN_BYPASS)?);
        }
        tills = parse_tills(&cloud(SQL_TILLS)?)?;
        expected_labels = parse_labels(&cloud(SQL_EXPECTED_LABELS)?)?;
    }

    let source_migrations = lines_set(&cloud(
        "SELECT version FROM supabase_migrations.schema_migrations ORDER BY 1",
    )?);
    let pack_migrations = pack_migration_versions(c.pack_dir)?;
    let gotrue = "SELECT COALESCE(max(version), '') FROM auth.schema_migrations";
    let (source_gotrue_max, local_gotrue_max) = (cloud(gotrue)?, local(gotrue)?);

    let source_sig = read_sig(&|q| c.cloud.ro(q))?;
    let local_sig = read_sig(&|q| c.local.scalar(c.local_db, q))?;
    let schema_diffs = compare(&source_sig, &local_sig);

    // S3 review I1: COPY enforces every CHECK, including a NOT VALID one, so evaluate each of THIS server's checks on the cloud rows.
    let mut check_violations: Vec<(String, i64)> = vec![];
    for line in local(SQL_LOCAL_CHECKS)?.lines() {
        let mut p = line.splitn(3, '|');
        let (Some(table), Some(name), Some(expr)) = (p.next(), p.next(), p.next()) else {
            continue;
        };
        let table = tables::normalize_regclass(table);
        if !tables::valid_table(&table) {
            check_violations.push((format!("{name} (table {table})"), -1));
            continue;
        }
        match cloud(&format!(
            "SELECT count(*) FROM {table} WHERE ({expr}) IS FALSE"
        ))
        .and_then(|n| num::<i64>(&n, "a violation count"))
        {
            Ok(0) => {}
            Ok(n) => check_violations.push((name.to_string(), n)),
            Err(_) => check_violations.push((name.to_string(), -1)),
        }
    }

    let staff: Vec<StaffRow> = serde_json::from_str(&cloud(SQL_STAFF)?)
        .map_err(|_| OpError::err("STAFF_UNREADABLE", "the staff list could not be read"))?;

    let public: Vec<String> = local(tables::SQL_PUBLIC_TABLES)?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let copy_tables = tables::copy_tables(&public);
    let closure: Vec<String> = local(&tables::closure_sql(&copy_tables)?)?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let (closure_allowed, closure_unexpected) = tables::classify_closure(&copy_tables, &closure);

    Ok(PlanFacts {
        fence_present, fence_outdated, fence_missing_tables, fence_disabled, role_can_bypass, writer_roles_can_bypass, bypass_unchecked, default_replica, source_state, pack_migrations, source_migrations,
        source_pg_major, pack_pg_major: c.pack_pg_major, source_gotrue_max, local_gotrue_max, schema_diffs, check_violations, staff,
        free_bytes: free_bytes(c.free_path)?,
        source_bytes: num(&cloud("SELECT pg_database_size(current_database())")?, "the cloud database size")?,
        local_bytes: num(&c.local.scalar("template1", &format!("SELECT pg_database_size('{}')", c.local_db))?, "the local database size")?,
        droppable_bytes: num(&c.local.scalar("template1", SQL_DROPPABLE)?, "the old database sizes")?,
        tills, expected_labels, closure_unexpected, closure_allowed,
        storage_objects: num(&cloud("SELECT count(*) FROM storage.objects")?, "the storage object count")?,
        has_storage_creds: c.has_storage_creds, photo_import_available: c.photo_import_available,
        null_token_users: num(&cloud(SQL_NULL_TOKENS)?, "the NULL token count")?,
        local_sales: num(&local("SELECT (SELECT count(*) FROM public.payments) + (SELECT count(*) FROM public.tabs)")?, "the local sales count")?,
        local_inputs_missing: c.local_inputs_missing.clone(),
        source_collation: cloud(SQL_COLLATION)?, local_collation: local(SQL_COLLATION)?,
        copy_tables,
        keep_auth_ids: split_csv(&local(SQL_KEEP_IDS)?),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::switch::drain::TillRow;

    const GIB: u64 = 1 << 30;
    const UUID_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const UUID_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fn staff(role: &str) -> StaffRow {
        StaffRow {
            id: "00000000-0000-4000-8000-000000000001".into(),
            role: role.into(),
            active: true,
            deleted: false,
            pin_ok: true,
            has_auth: true,
            banned: false,
        }
    }
    fn till(label: &str, depth: i64, age: i64) -> TillRow {
        TillRow {
            terminal_uuid: format!("u-{label}"),
            terminal_label: label.into(),
            queue_depth: depth,
            dead_letter_depth: 0,
            seen_state: "active".into(),
            app_version: None,
            reported_by: format!("u-{label}"),
            age_s: age,
            after_drain: false,
        }
    }
    fn till_with_id(label: &str, uuid: &str, depth: i64, dead: i64) -> TillRow {
        TillRow {
            terminal_uuid: uuid.into(),
            terminal_label: label.into(),
            queue_depth: depth,
            dead_letter_depth: dead,
            seen_state: "active".into(),
            app_version: None,
            reported_by: "r".into(),
            age_s: 60,
            after_drain: false,
        }
    }
    fn versions(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    /// Removes `version` from the cloud's ledger AND proves the fixture really held it: a misspelt version would remove nothing and
    /// the BEHIND test would pass or fail for the wrong reason.
    fn drop_version(f: &mut PlanFacts, version: &str) {
        assert!(
            f.source_migrations.remove(version),
            "the fixture's cloud ledger has no {version}"
        );
    }

    pub(crate) fn clean() -> PlanFacts {
        PlanFacts {
            fence_present: true,
            fence_outdated: false,
            fence_missing_tables: vec![],
            fence_disabled: vec![],
            role_can_bypass: false,
            writer_roles_can_bypass: vec![],
            bypass_unchecked: false,
            default_replica: vec![],
            source_state: "active".into(),
            pack_migrations: versions(&[
                "20260101000000",
                FENCE_MIGRATIONS[0],
                FENCE_MIGRATIONS[1],
            ]),
            source_migrations: versions(&[
                "20260101000000",
                FENCE_MIGRATIONS[0],
                FENCE_MIGRATIONS[1],
            ]),
            source_pg_major: 17,
            pack_pg_major: 17,
            source_gotrue_max: "20260625000000".into(),
            local_gotrue_max: "20260625000000".into(),
            schema_diffs: vec![],
            check_violations: vec![],
            staff: vec![staff("admin"), staff("cashier")],
            free_bytes: 100 * GIB,
            source_bytes: GIB,
            local_bytes: 100 << 20,
            droppable_bytes: 0,
            tills: vec![till("POS-1", 0, 60)],
            expected_labels: vec!["POS-1".into()],
            closure_unexpected: vec![],
            storage_objects: 0,
            has_storage_creds: false,
            photo_import_available: true,
            null_token_users: 0,
            local_sales: 0,
            local_inputs_missing: vec![],
            source_collation: "i|en-US".into(),
            local_collation: "i|es-MX".into(),
            copy_tables: vec!["public.products".into()],
            closure_allowed: vec![],
            keep_auth_ids: vec![],
        }
    }
    fn codes(f: &PlanFacts, level: Level) -> Vec<String> {
        evaluate(f)
            .into_iter()
            .filter(|x| x.level == level)
            .map(|x| x.code)
            .collect()
    }

    #[test]
    fn a_clean_store_has_no_blocker_and_only_information() {
        let f = evaluate(&clean());
        assert!(!has_blockers(&f), "{f:?}");
        assert!(f
            .iter()
            .any(|x| x.code == "COLLATION_DIFFERS" && x.level == Level::Info));
    }

    #[test]
    fn each_blocker_is_reported_with_its_code() {
        type Mutate = Box<dyn Fn(&mut PlanFacts)>;
        let cases: Vec<(&str, Mutate)> = vec![
            ("FENCE_NOT_INSTALLED", Box::new(|f| f.fence_present = false)),
            ("FENCE_OUTDATED", Box::new(|f| f.fence_outdated = true)),
            (
                "FENCE_DEFAULT_REPLICA",
                Box::new(|f| f.default_replica = vec!["authenticated@*".into()]),
            ),
            (
                "FENCE_BYPASS_UNCHECKABLE",
                Box::new(|f| f.bypass_unchecked = true),
            ),
            (
                "FENCE_WRITER_BYPASS",
                Box::new(|f| f.writer_roles_can_bypass = vec!["authenticated".into()]),
            ),
            (
                "FENCE_TABLES_UNGUARDED",
                Box::new(|f| f.fence_missing_tables = vec!["new_table".into()]),
            ),
            (
                "FENCE_GUARD_DISABLED",
                Box::new(|f| f.fence_disabled = vec!["products (D)".into()]),
            ),
            (
                "CLOUD_NOT_ACTIVE",
                Box::new(|f| f.source_state = "moved".into()),
            ),
            (
                "SCHEMA_LEVEL_BEHIND",
                Box::new(|f| drop_version(f, FENCE_MIGRATIONS[1])),
            ),
            (
                "SCHEMA_LEVEL_AHEAD",
                Box::new(|f| {
                    f.source_migrations.insert("20270101000000".into());
                }),
            ),
            (
                "SCHEMA_SHAPE_MISMATCH",
                Box::new(|f| f.schema_diffs = vec!["public.x.y: only in the cloud".into()]),
            ),
            ("SOURCE_PG_NEWER", Box::new(|f| f.source_pg_major = 18)),
            (
                "GOTRUE_NEWER",
                Box::new(|f| f.source_gotrue_max = "20270101000000".into()),
            ),
            (
                "CHECK_VIOLATIONS",
                Box::new(|f| f.check_violations = vec![("stock_movements_reason_check".into(), 3)]),
            ),
            (
                "NO_VALID_ADMIN",
                Box::new(|f| f.staff = vec![staff("cashier")]),
            ),
            ("DISK_LOW", Box::new(|f| f.free_bytes = GIB)),
            (
                "TILL_QUEUED",
                Box::new(|f| f.tills = vec![till("POS-1", 2, 60)]),
            ),
            (
                "TILL_DEAD_LETTERS",
                Box::new(|f| f.tills[0].dead_letter_depth = 1),
            ),
            (
                "CLOSURE_UNEXPECTED",
                Box::new(|f| f.closure_unexpected = vec!["public.orders".into()]),
            ),
            (
                "STORAGE_CREDENTIALS_NEEDED",
                Box::new(|f| f.storage_objects = 4),
            ),
            (
                "PLAN10_REQUIRED",
                Box::new(|f| {
                    f.storage_objects = 4;
                    f.has_storage_creds = true;
                    f.photo_import_available = false;
                }),
            ),
            ("LOCAL_HAS_SALES", Box::new(|f| f.local_sales = 1)),
            (
                "LOCAL_SERVER_NOT_READY",
                Box::new(|f| f.local_inputs_missing = vec!["pki.rootSha256".into()]),
            ),
        ];
        for (code, mutate) in cases {
            let mut f = clean();
            mutate(&mut f);
            assert!(
                codes(&f, Level::Block).contains(&code.to_string()),
                "{code} not blocking: {:?}",
                evaluate(&f)
            );
        }
    }

    #[test]
    fn plan10_missing_blocks_with_a_code() {
        // stored files in the cloud and no real importer: blocked, with or without the storage credentials
        for creds in [true, false] {
            let mut f = clean();
            f.storage_objects = 12;
            f.has_storage_creds = creds;
            f.photo_import_available = false;
            assert!(
                codes(&f, Level::Block).contains(&"PLAN10_REQUIRED".to_string()),
                "creds={creds}: {:?}",
                evaluate(&f)
            );
            assert!(
                !codes(&f, Level::Block).contains(&"PHOTO_IMPORT_UNAVAILABLE".to_string()),
                "the old code is gone"
            );
        }
        // a store with no stored files is never blocked by a missing importer
        let mut f = clean();
        f.photo_import_available = false;
        assert!(!codes(&f, Level::Block).contains(&"PLAN10_REQUIRED".to_string()));
    }

    #[test]
    fn plan10_present_does_not_block() {
        let mut f = clean();
        f.storage_objects = 12;
        f.has_storage_creds = true;
        f.photo_import_available = true;
        assert!(!codes(&f, Level::Block).contains(&"PLAN10_REQUIRED".to_string()));
        assert!(codes(&f, Level::Block).is_empty(), "{:?}", evaluate(&f));
    }

    #[test]
    fn the_fence_is_the_pair_of_migrations_and_both_are_real_files() {
        assert_eq!(FENCE_MIGRATIONS, ["20261025000001", "20261025000002"]);
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("supabase")
            .join("migrations");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        for v in FENCE_MIGRATIONS {
            assert!(
                names
                    .iter()
                    .any(|n| n.starts_with(&format!("{v}_")) && n.ends_with(".sql")),
                "{v} is not a migration file in {}",
                dir.display()
            );
        }
        // the old plan-text version is superseded everywhere
        assert!(!names.iter().any(|n| n.starts_with("20261003000001_")));
        let mut f = clean();
        assert!(
            !f.source_migrations.remove("20261003000001"),
            "the superseded version must not be in any fixture"
        );
    }

    #[test]
    fn the_cloud_missing_only_the_hardening_migration_is_both_behind_and_outdated() {
        let mut f = clean();
        drop_version(&mut f, FENCE_MIGRATIONS[1]);
        f.fence_outdated = true;
        let c = codes(&f, Level::Block);
        assert!(
            c.contains(&"SCHEMA_LEVEL_BEHIND".to_string())
                && c.contains(&"FENCE_OUTDATED".to_string()),
            "{c:?}"
        );
        let behind = evaluate(&f)
            .into_iter()
            .find(|x| x.code == "SCHEMA_LEVEL_BEHIND")
            .unwrap();
        assert_eq!(behind.items, vec![FENCE_MIGRATIONS[1].to_string()]);
    }

    #[test]
    fn a_missing_fence_is_not_also_reported_outdated_or_unguarded() {
        let mut f = clean();
        f.fence_present = false;
        f.fence_outdated = true;
        f.fence_disabled = vec!["products (D)".into()];
        let c = codes(&f, Level::Block);
        assert!(c.contains(&"FENCE_NOT_INSTALLED".to_string()));
        assert!(
            !c.contains(&"FENCE_OUTDATED".to_string())
                && !c.contains(&"FENCE_GUARD_DISABLED".to_string())
        );
    }

    #[test]
    fn clean_text_strips_invisible_and_override_characters_and_keeps_real_text() {
        assert_eq!(
            clean_text("a\u{061C}b\u{2066}c\u{E0001}d\u{00AD}e"),
            "abcde"
        );
        for keep in [
            "\u{0915}\u{094D}\u{0937}",
            "\u{4E2D}\u{6587}",
            "Caj\u{00E9} 1",
            "POS-1",
        ] {
            assert_eq!(clean_text(keep), keep);
        }
    }

    #[test]
    fn a_fence_less_cloud_waives_nothing_and_reports_the_missing_fence() {
        let mut f = clean();
        f.fence_present = false;
        assert!(resolve_waivers_for(&f, &["anything".to_string()])
            .unwrap()
            .is_empty());
        assert!(evaluate_waived(&f, &BTreeSet::new())
            .iter()
            .any(|x| x.code == "FENCE_NOT_INSTALLED"));
    }

    #[test]
    fn a_role_that_can_set_session_replication_role_is_a_warning_not_a_refusal() {
        let mut f = clean();
        f.role_can_bypass = true;
        let out = evaluate(&f);
        let w = out
            .iter()
            .find(|x| x.code == "FENCE_BYPASS_POSSIBLE")
            .unwrap();
        assert_eq!(w.level, Level::Warn);
        assert!(
            w.message.contains("session_replication_role") && w.message.contains("this session")
        );
        f.writer_roles_can_bypass = vec!["anon".into()];
        let w2 = evaluate(&f)
            .into_iter()
            .find(|x| x.code == "FENCE_BYPASS_POSSIBLE")
            .unwrap();
        assert!(!w2.message.contains("stay stopped"));
        assert!(!has_blockers(&out), "{out:?}");
    }

    #[test]
    fn fence_default_replica_message_names_local_distinct_from_origin_and_system() {
        let mut f = clean();
        f.default_replica = vec!["authenticated@*".into()];
        let m = evaluate(&f)
            .into_iter()
            .find(|x| x.code == "FENCE_DEFAULT_REPLICA")
            .expect("the finding")
            .message;
        for needle in [
            "`local`",
            "IS DISTINCT FROM origin",
            "`system`",
            "role, database or server level",
        ] {
            assert!(m.contains(needle), "{needle}: {m}");
        }
        // the SQL really uses the test the message states, at role/database level and at server level
        assert_eq!(
            SQL_DEFAULT_REPLICA.matches("IS DISTINCT FROM").count(),
            2,
            "{SQL_DEFAULT_REPLICA}"
        );
        assert!(!SQL_DEFAULT_REPLICA.contains("<>"));
        // an unset (NULL) server value is not flagged: only a value that is present and not `origin` is
        assert!(
            SQL_DEFAULT_REPLICA.contains("COALESCE((SELECT reset_val FROM pg_settings"),
            "{SQL_DEFAULT_REPLICA}"
        );
    }

    #[test]
    fn the_catalog_queries_cover_partitioned_tables_the_barrier_and_the_trigger_state() {
        assert!(
            SQL_UNGUARDED.contains("relkind IN ('r','p')")
                && !SQL_UNGUARDED.contains("relkind = 'r'")
        );
        assert!(
            SQL_UNGUARDED.contains(COVERED),
            "one predicate, shared with the fence tests"
        );
        assert!(
            SQL_UNGUARDED.contains("tgfoid = to_regprocedure('public.store_fence_guard()')")
                && SQL_UNGUARDED.contains("tgtype = 62")
        );
        assert!(
            SQL_UNGUARDED.contains("tgqual IS NULL")
                && SQL_UNGUARDED.contains("cardinality(t.tgattr::int2[]) = 0")
        );
        assert!(
            SQL_DEFAULT_REPLICA.contains("pg_db_role_setting")
                && SQL_DEFAULT_REPLICA.contains("reset_val")
        );
        assert!(SQL_WRITERS_CAN_BYPASS.contains("'anon','authenticated','service_role'"));
        assert!(COVERED.contains("relkind IN ('r','p')"));
        assert!(
            SQL_FENCE_BARRIER.contains("FOR SHARE")
                && SQL_FENCE_BARRIER.contains("store_fence_guard")
        );
        assert!(
            SQL_FENCE_PRESENT.contains("store_fence_guard()")
                && SQL_FENCE_PRESENT.contains("store_switch_effective_state()")
        );
        assert!(
            SQL_GUARD_DISABLED.contains("tgenabled <> 'O'")
                && SQL_GUARD_DISABLED.contains("store_fence_guard")
        );
        assert!(SQL_ROLE_CAN_BYPASS
            .contains("has_parameter_privilege(current_user, 'session_replication_role', 'SET')"));
    }

    #[test]
    fn the_admin_must_be_active_not_deleted_not_banned_have_a_stored_pin_hash_and_an_auth_user() {
        for broken in [
            StaffRow {
                active: false,
                ..staff("admin")
            },
            StaffRow {
                deleted: true,
                ..staff("admin")
            },
            StaffRow {
                banned: true,
                ..staff("admin")
            },
            StaffRow {
                pin_ok: false,
                ..staff("admin")
            },
            StaffRow {
                has_auth: false,
                ..staff("admin")
            },
        ] {
            let mut f = clean();
            f.staff = vec![broken, staff("manager")];
            assert!(codes(&f, Level::Block).contains(&"NO_VALID_ADMIN".to_string()));
        }
    }

    #[test]
    fn pin_ok_means_a_stored_hash() {
        // SQL_STAFF is a normal string, so the regex's `\$` is written `\\$` in the source and is `\$` in the SQL
        assert!(SQL_STAFF.contains(r"'pinOk', COALESCE(p.pin ~ '^\$2[aby]\$', false)"), "pinOk is the bcrypt shape of the stored value");
        assert!(!SQL_STAFF.contains("[0-9]{6}"), "no six-digit PIN is read or expected any more");
    }

    #[test]
    fn staff_who_cannot_be_derived_are_warned_about_by_id_never_by_pin() {
        let mut f = clean();
        f.staff.push(StaffRow {
            id: "00000000-0000-4000-8000-000000000009".into(),
            pin_ok: false,
            ..staff("cashier")
        });
        let w = evaluate(&f)
            .into_iter()
            .find(|x| x.code == "STAFF_NO_VALID_PIN")
            .unwrap();
        assert_eq!(w.level, Level::Warn);
        assert_eq!(
            w.items,
            vec!["00000000-0000-4000-8000-000000000009 (cashier)".to_string()]
        );
        assert!(!has_blockers(&evaluate(&f)));
    }

    #[test]
    fn tills_distinguish_a_recent_queue_from_a_stale_one_and_report_silence() {
        let mut f = clean();
        f.tills = vec![
            till("POS-1", 3, 120),
            till("POS-2", 5, 3 * 86_400),
            till("POS-3", 0, 7_200),
        ];
        f.expected_labels = vec!["POS-1".into(), "POS-4".into()];
        f.tills[2].dead_letter_depth = 2;
        let out = evaluate(&f);
        let level = |c: &str| out.iter().find(|x| x.code == c).map(|x| x.level);
        assert_eq!(level("TILL_QUEUED"), Some(Level::Block));
        assert_eq!(level("TILL_QUEUED_STALE"), Some(Level::Warn));
        assert_eq!(level("TILL_SILENT"), Some(Level::Warn));
        assert_eq!(
            level("TILL_DEAD_LETTERS"),
            Some(Level::Block),
            "PM ruling D-a: failed work blocks"
        );
        assert_eq!(level("TILL_NEVER_REPORTED"), Some(Level::Warn));
        assert_eq!(
            out.iter().find(|x| x.code == "TILL_QUEUED").unwrap().items,
            vec!["POS-1: 3 unsent (reported by u-POS-1)".to_string()]
        );
    }

    #[test]
    fn the_till_findings_carry_the_install_id_and_label_a_waiver_needs() {
        let mut f = clean();
        f.tills = vec![
            till_with_id("POS-1", UUID_A, 3, 0),
            till_with_id("POS-2", UUID_B, 0, 2),
        ];
        let out = evaluate(&f);
        let q = out.iter().find(|x| x.code == "TILL_QUEUED").unwrap();
        let d = out.iter().find(|x| x.code == "TILL_DEAD_LETTERS").unwrap();
        assert_eq!(
            q.tills,
            vec![FindingTill {
                uuid: UUID_A.into(),
                label: "POS-1".into()
            }]
        );
        assert_eq!(
            d.tills,
            vec![FindingTill {
                uuid: UUID_B.into(),
                label: "POS-2".into()
            }]
        );
        let json = serde_json::to_value(q).unwrap();
        assert_eq!(json["tills"][0]["uuid"], UUID_A);
        assert!(
            serde_json::to_value(out.iter().find(|x| x.code == "COLLATION_DIFFERS").unwrap())
                .unwrap()
                .get("tills")
                .is_none(),
            "other findings stay as they were"
        );
    }

    #[test]
    fn what_a_till_wrote_never_reaches_the_terminal_with_a_control_character() {
        assert_eq!(clean_text("POS\u{1b}[2J-1\r\n\u{0}"), "POS[2J-1");
        assert_eq!(clean_text("a\u{202e}b\u{200b}c\u{feff}d"), "abcd");
        assert_eq!(
            clean_text("Caja Ñ ü 1"),
            "Caja Ñ ü 1",
            "ordinary text, accents and spaces survive"
        );
        let mut f = clean();
        let evil = "POS\u{1b}[31m\n-9";
        f.tills = vec![TillRow {
            terminal_uuid: format!("{UUID_A}\u{7}"),
            reported_by: "who\u{1b}]0;x".into(),
            ..till_with_id(evil, UUID_A, 2, 1)
        }];
        f.expected_labels = vec![format!("{evil}-never")];
        for x in evaluate(&f) {
            for i in &x.items {
                assert!(!i.chars().any(char::is_control), "{x:?}");
            }
            for t in &x.tills {
                assert!(
                    !t.uuid.chars().any(char::is_control) && !t.label.chars().any(char::is_control),
                    "{x:?}"
                );
            }
        }
    }

    #[test]
    fn a_waiver_clears_only_its_own_till_and_only_its_unsent_and_failed_work() {
        let mut f = clean();
        f.tills = vec![
            till_with_id("POS-1", UUID_A, 3, 1),
            till_with_id("POS-2", UUID_B, 2, 4),
        ];
        let a: BTreeSet<String> = [UUID_A.to_string()].into();
        let out = evaluate_waived(&f, &a);
        let q = out.iter().find(|x| x.code == "TILL_QUEUED").unwrap();
        let d = out.iter().find(|x| x.code == "TILL_DEAD_LETTERS").unwrap();
        assert_eq!(
            q.tills.iter().map(|t| t.uuid.as_str()).collect::<Vec<_>>(),
            vec![UUID_B],
            "POS-1 cleared, POS-2 still blocks"
        );
        assert_eq!(
            d.tills.iter().map(|t| t.uuid.as_str()).collect::<Vec<_>>(),
            vec![UUID_B]
        );
        assert!(has_blockers(&out));
        let both: BTreeSet<String> = [UUID_A.to_string(), UUID_B.to_string()].into();
        let cleared = evaluate_waived(&f, &both);
        assert!(
            !cleared
                .iter()
                .any(|x| x.code == "TILL_QUEUED" || x.code == "TILL_DEAD_LETTERS"),
            "{cleared:?}"
        );
        assert!(!has_blockers(&cleared), "{cleared:?}");
        // a waiver never reaches the fence findings
        f.fence_outdated = true;
        assert!(codes_waived(&f, &both).contains(&"FENCE_OUTDATED".to_string()));
    }
    fn codes_waived(f: &PlanFacts, w: &BTreeSet<String>) -> Vec<String> {
        evaluate_waived(f, w)
            .into_iter()
            .filter(|x| x.level == Level::Block)
            .map(|x| x.code)
            .collect()
    }

    #[test]
    fn a_waiver_names_a_till_by_install_id_in_any_case_or_by_a_unique_label() {
        let tills = vec![
            till_with_id("POS-1", UUID_A, 1, 0),
            till_with_id("POS-2", UUID_B, 1, 0),
            till_with_id("POS-2", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", 1, 0),
        ];
        let exp = vec!["POS-9".to_string()];
        let one = |t: &str| resolve_waivers(&tills, &exp, &[t.to_string()]);
        assert_eq!(one("POS-1").unwrap(), [UUID_A.to_string()].into());
        assert_eq!(
            one(&UUID_A.to_uppercase()).unwrap(),
            [UUID_A.to_string()].into(),
            "install ids compare in lower case"
        );
        assert_eq!(
            one(UUID_B).unwrap(),
            [UUID_B.to_string()].into(),
            "an id names one of two tills that share a label"
        );
        let amb = one("POS-2").unwrap_err();
        assert_eq!(
            (amb.code, amb.reason.as_str()),
            (OpCode::Usage, "WAIVE_AMBIGUOUS")
        );
        assert!(amb.message.contains(UUID_B), "{}", amb.message);
        assert_eq!(one("POS-404").unwrap_err().reason, "WAIVE_UNKNOWN");
        assert!(
            one("POS-9").unwrap().is_empty(),
            "a terminal that opened a caja but never reported: valid, clears nothing"
        );
    }

    #[test]
    fn the_waiver_reason_is_untrusted_text_that_is_trimmed_stripped_and_capped() {
        assert_eq!(
            clean_reason("  till 2 is broken  ").unwrap(),
            "till 2 is broken"
        );
        let multi = clean_reason("line one\nline two\r\n\t# rm -rf /\u{1b}[31m").unwrap();
        assert!(
            !multi.contains('\n') && !multi.contains('\r') && !multi.contains('\u{1b}'),
            "{multi:?}"
        );
        assert!(multi.starts_with("line one line two"), "{multi:?}");
        let long = "x".repeat(WAIVE_REASON_MAX + 50);
        assert_eq!(
            clean_reason(&long).unwrap().chars().count(),
            WAIVE_REASON_MAX
        );
        let accents = "ñ".repeat(WAIVE_REASON_MAX + 5);
        assert_eq!(
            clean_reason(&accents).unwrap().chars().count(),
            WAIVE_REASON_MAX,
            "the cap counts characters, never splits one"
        );
        for empty in ["", "   ", "\n\t\r", "\u{1b}\u{7}", "\u{200b}"] {
            let e = clean_reason(empty).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "WAIVE_REASON_REQUIRED"),
                "{empty:?}"
            );
        }
    }

    #[test]
    fn waiver_flags_need_each_other_and_are_checked_before_anything_is_opened() {
        let t = |s: &str| s.to_string();
        assert_eq!(Waivers::parse(&[], None).unwrap(), None);
        assert_eq!(
            Waivers::parse(&[t("POS-1")], Some("  off for repair ")).unwrap(),
            Some(Waivers {
                terminals: vec![t("POS-1")],
                reason: t("off for repair")
            })
        );
        assert_eq!(
            Waivers::parse(&[t("POS-1")], None).unwrap_err().reason,
            "WAIVE_REASON_REQUIRED"
        );
        assert_eq!(
            Waivers::parse(&[t("POS-1")], Some("   "))
                .unwrap_err()
                .reason,
            "WAIVE_REASON_REQUIRED"
        );
        assert_eq!(
            Waivers::parse(&[], Some("why")).unwrap_err().reason,
            "WAIVE_REASON_WITHOUT_TERMINAL"
        );
        for bad in ["", "  ", "POS\n1", "POS\u{1b}1", &"x".repeat(65)] {
            let e = Waivers::parse(&[t(bad)], Some("why")).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "WAIVE_TERMINAL_INVALID"),
                "{bad:?}"
            );
        }
        let dup = Waivers::parse(&[t("POS-1"), t(" POS-1 ")], Some("why"))
            .unwrap()
            .unwrap();
        assert_eq!(dup.terminals, vec![t("POS-1")]);
    }

    #[test]
    fn dropping_old_databases_to_make_room_is_information_not_a_refusal() {
        let mut f = clean();
        f.free_bytes = 4 * GIB;
        f.droppable_bytes = 10 * GIB;
        let out = evaluate(&f);
        assert!(!has_blockers(&out));
        assert!(out
            .iter()
            .any(|x| x.code == "OLD_DATABASES_DROPPED" && x.level == Level::Info));
    }

    #[test]
    fn long_item_lists_are_capped() {
        let mut f = clean();
        f.schema_diffs = (0..60).map(|i| format!("d{i}")).collect();
        let d = evaluate(&f)
            .into_iter()
            .find(|x| x.code == "SCHEMA_SHAPE_MISMATCH")
            .unwrap();
        assert_eq!(d.items.len(), 21);
        assert!(d.items[20].contains("40 more"));
    }

    #[test]
    fn blockers_sort_first_and_serialize_in_lower_case() {
        let mut f = clean();
        f.local_sales = 1;
        let out = evaluate(&f);
        assert_eq!(out[0].level, Level::Block);
        assert!(serde_json::to_string(&out[0])
            .unwrap()
            .contains(r#""level":"block""#));
    }
}
