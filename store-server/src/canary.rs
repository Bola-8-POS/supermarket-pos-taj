//! The lockout canary (S11 REVIEW I2), shared by `provision` (final step) and `health --canary`.
//! A dedicated auth user with no `profiles` row is created once through the GoTrue admin API;
//! five wrong password grants straight at GoTrue must end in `LOCKED:<n>` by the fifth; the
//! lock keys are deleted before and after so the canary never leaves a lock behind.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::envelope::{Code, PosctlError};
use crate::firstadmin::{self, CanaryVerdict, Endpoint};
use crate::paths::Roots;
use crate::pg::Psql;
use crate::ports::Ports;
use crate::util::{now_rfc3339, write_atomic};

fn load_account(roots: &Roots) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(roots.canary_json()).ok()?).ok()?;
    Some((v.get("userId")?.as_str()?.to_string(), v.get("email")?.as_str()?.to_string()))
}

/// The longest a whole canary may take, whatever budget the caller has left.
pub(crate) const MAX_BUDGET: Duration = Duration::from_secs(120);
const REQUEST_CAP: Duration = Duration::from_secs(30);
const CLEANUP_CAP: Duration = Duration::from_secs(300);

/// What one call may take: its own `cap`, or what is left of the canary's budget when that is less. A spent budget is
/// `Unhealthy` (it says nothing about the hook): recomputed before EVERY call, so the whole canary can never outlive
/// `deadline` by more than the one call that was already running.
fn call_timeout(cap: Duration, deadline: Instant, now: Instant) -> Result<Duration, PosctlError> {
    let left = deadline.saturating_duration_since(now);
    if left.is_zero() {
        return Err(PosctlError::new(Code::Unhealthy, "the canary ran out of time before it could finish"));
    }
    Ok(cap.min(left))
}

fn cleanup(psql: &Psql, id: &str, t: Duration) -> Result<(), PosctlError> {
    let sql = firstadmin::canary_cleanup_sql(id).map_err(|e| PosctlError::new(Code::Unhealthy, e))?;
    let o = psql.command("postgres", "postgres", &[]).timeout(t).stdin(sql.into_bytes()).run().map_err(|e| PosctlError::new(Code::Unhealthy, e.to_string()))?;
    if o.success() {
        Ok(())
    } else {
        Err(PosctlError::new(Code::Unhealthy, format!("canary cleanup failed: {}", o.stderr.trim())))
    }
}

/// `Ok(())` = the hook locked the account and the lock keys are gone. `Code::CanaryFailed` (exit 22) is returned ONLY
/// for positive evidence that the hook is off or answers an error; a transport error, a 5xx, a failed lookup or an
/// unreadable answer is `Code::Unhealthy` (exit 20): it says nothing about the hook and must not gate sign-in.
/// The account's password is random and never stored (`firstadmin::create_canary`); the five grants send a fixed
/// wrong password, so nothing about the verdict depends on any secret. The whole run is bounded by
/// `min(limit, 120 s)`. A failure verdict is recorded in `canary.json` (`lastOk: false`).
pub fn run(roots: &Roots, ports: &Ports, psql: &Psql, ep: &Endpoint, limit: Duration) -> Result<(), PosctlError> {
    run_with(roots, ep, limit, true, &|id, t| cleanup(psql, id, t), &|email, t| firstadmin::run_canary_grants(ports.gotrue(), email, t))
}

/// The update's own proof (`UpdateWork::lockout_canary`): the same check, but a failure verdict is NOT written to
/// `canary.json`. A failed update rolls back, and a `lastOk: false` left behind would outlive the rollback and make the
/// next `health --write` gate sign-in on a stack that is fine. A pass still stamps `lastRunAt`/`lastOk: true`.
pub fn run_for_update(roots: &Roots, ports: &Ports, psql: &Psql, ep: &Endpoint, limit: Duration) -> Result<(), PosctlError> {
    run_with(roots, ep, limit, false, &|id, t| cleanup(psql, id, t), &|email, t| firstadmin::run_canary_grants(ports.gotrue(), email, t))
}

type Grants<'a> = &'a dyn Fn(&str, &dyn Fn() -> Result<Duration, String>) -> Result<Vec<(u16, String)>, String>;

fn run_with(
    roots: &Roots,
    ep: &Endpoint,
    limit: Duration,
    record_failure: bool,
    cleanup: &dyn Fn(&str, Duration) -> Result<(), PosctlError>,
    grants: Grants,
) -> Result<(), PosctlError> {
    let deadline = Instant::now() + limit.min(MAX_BUDGET);
    let left = |cap: Duration| call_timeout(cap, deadline, Instant::now());
    // review fix: a recorded account that no longer exists in Auth (restore onto another PC, Plan 09's swap,
    // Plan 08's C7) would make all five grants answer a plain 400 and be misreported as "hook not active".
    // So the account is looked up first (`GET /auth/v1/admin/users/<id>` on the internal listener); ONLY a 404
    // deletes `state\canary.json` and falls through to creation. Any other answer fails the canary.
    let mut recorded = load_account(roots);
    if let Some((id, _)) = &recorded {
        if !firstadmin::canary_account_exists(ep, id, left(REQUEST_CAP)?).map_err(|e| PosctlError::new(Code::Unhealthy, e))? {
            let _ = std::fs::remove_file(roots.canary_json());
            recorded = None;
        }
    }
    let (id, email) = match recorded {
        Some(x) => x,
        None => {
            let a = firstadmin::create_canary(ep, left(REQUEST_CAP)?).map_err(|e| PosctlError::new(Code::Unhealthy, e))?;
            write_atomic(&roots.canary_json(), serde_json::to_string_pretty(&json!({"userId": a.id, "email": a.email, "createdAt": now_rfc3339()}))?.as_bytes())?;
            (a.id, a.email)
        }
    };
    cleanup(&id, left(CLEANUP_CAP)?)?;
    let got = grants(&email, &|| left(REQUEST_CAP).map_err(|e| e.message));
    let after = left(CLEANUP_CAP).and_then(|t| cleanup(&id, t)); // always, even when the grants failed (a spent budget fails it as Unhealthy)
    let got = got.map_err(|e| PosctlError::new(Code::Unhealthy, e))?;
    after?; // a lock key left behind fails the canary, and `lastOk` is not written
    let verdict = firstadmin::classify_canary(&got);
    if let CanaryVerdict::Unexpected(m) = &verdict {
        // not evidence about the hook (a 5xx, a rate limit, a short answer): nothing is recorded and nothing gates
        return Err(PosctlError::new(Code::Unhealthy, format!("unexpected canary result: {m}")));
    }
    if record_failure || verdict == CanaryVerdict::Ok {
        let mut v = std::fs::read_to_string(roots.canary_json()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({}));
        v["lastRunAt"] = json!(now_rfc3339());
        v["lastOk"] = json!(verdict == CanaryVerdict::Ok);
        let _ = write_atomic(&roots.canary_json(), serde_json::to_string_pretty(&v)?.as_bytes());
    }
    match verdict {
        CanaryVerdict::Ok => Ok(()),
        CanaryVerdict::HookInactive { .. } => Err(PosctlError::new(Code::CanaryFailed, "the PIN lockout hook is not active: five wrong passwords did not lock the account")),
        CanaryVerdict::HookAnswered(m) => Err(PosctlError::new(Code::CanaryFailed, format!("the lockout hook answered {m}: password sign-in is failing closed"))),
        CanaryVerdict::Unexpected(_) => unreachable!("returned above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock;
    use crate::util::Secret;
    use std::cell::RefCell;

    const LIMIT: Duration = Duration::from_secs(120);
    const ID: &str = "00000000-0000-4000-8000-0000000000aa";

    fn ep(m: &mock::Mock) -> Endpoint {
        Endpoint { internal_url: m.url(), anon_key: Secret("anon".into()), service_key: Secret("service".into()) }
    }
    fn roots(t: &tempfile::TempDir) -> Roots {
        let r = Roots { data: t.path().join("data"), program: t.path().join("prog"), posctl_dir: t.path().join("prog"), dev: true, pack_override: None };
        std::fs::create_dir_all(r.state()).unwrap();
        std::fs::write(r.canary_json(), json!({"userId": ID, "email": format!("{ID}@barpos.local")}).to_string()).unwrap();
        r
    }
    fn locked_grants() -> Result<Vec<(u16, String)>, String> {
        let plain = (400, "{\"msg\":\"Invalid login credentials\"}".to_string());
        let mut v = vec![plain; 5];
        v[4] = (400, "{\"msg\":\"LOCKED:30\"}".to_string());
        Ok(v)
    }

    #[test]
    fn only_a_404_recreates_the_account_any_other_lookup_answer_fails_the_canary() {
        for (status, recreated) in [(404u16, true), (500, false), (403, false)] {
            let t = tempfile::tempdir().unwrap();
            let r = roots(&t);
            let m = mock::start(move |q| if q.method == "GET" { (status, "{}".into()) } else { (200, "{}".into()) });
            let out = run_with(&r, &ep(&m), LIMIT, true, &|_, _| Ok(()), &|_, _| locked_grants());
            let posted = m.requests().iter().any(|q| q.method == "POST" && q.path == "/auth/v1/admin/users");
            assert_eq!(posted, recreated, "status {status}");
            assert_eq!(out.is_ok(), recreated, "status {status}");
            if !recreated {
                assert_eq!(out.unwrap_err().code, Code::Unhealthy, "an unreadable lookup says nothing about the hook");
            }
        }
    }

    #[test]
    fn the_canary_account_password_is_random_and_not_written_to_canary_json() {
        let mut pws = Vec::new();
        for _ in 0..2 {
            let t = tempfile::tempdir().unwrap();
            let r = roots(&t);
            let m = mock::start(|q| if q.method == "GET" { (404, "{}".into()) } else { (200, "{}".into()) });
            run_with(&r, &ep(&m), LIMIT, true, &|_, _| Ok(()), &|_, _| locked_grants()).unwrap();
            let body: Value = serde_json::from_str(&m.requests().iter().find(|q| q.method == "POST").unwrap().body).unwrap();
            let pw = body["password"].as_str().unwrap().to_string();
            assert!(pw.len() >= 32);
            assert!(!std::fs::read_to_string(r.canary_json()).unwrap().contains(&pw));
            pws.push(pw);
        }
        assert_ne!(pws[0], pws[1]);
    }

    #[test]
    fn a_failed_lock_key_cleanup_fails_the_canary_and_never_records_last_ok() {
        for fail_on_call in [1, 2] {
            let t = tempfile::tempdir().unwrap();
            let r = roots(&t);
            let m = mock::start(|_| (200, "{}".into()));
            let n = RefCell::new(0);
            let out = run_with(
                &r,
                &ep(&m),
                LIMIT,
                true,
                &|_, _| {
                    *n.borrow_mut() += 1;
                    if *n.borrow() == fail_on_call { Err(PosctlError::error("psql exited 1")) } else { Ok(()) }
                },
                &|_, _| locked_grants(),
            );
            assert!(out.is_err(), "cleanup call {fail_on_call}");
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(r.canary_json()).unwrap()).unwrap();
            assert!(saved.get("lastOk").is_none(), "{saved}");
        }
        let t = tempfile::tempdir().unwrap();
        let r = roots(&t);
        let m = mock::start(|_| (200, "{}".into()));
        run_with(&r, &ep(&m), LIMIT, true, &|_, _| Ok(()), &|_, _| locked_grants()).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(r.canary_json()).unwrap()).unwrap();
        assert_eq!(saved["lastOk"], json!(true));
    }

    // F3 I5: only a positive verdict (the hook is off, or it answered an error) is CANARY_FAILED and gates;
    // a transport error, a 5xx or an unreadable answer is not evidence about the hook.
    #[test]
    fn only_a_positive_verdict_is_a_canary_failure_and_records_last_ok_false() {
        let plain = |m: &str| (400u16, format!("{{\"msg\":\"{m}\"}}"));
        type Case = (&'static str, Result<Vec<(u16, String)>, String>, Code, Option<bool>);
        let cases: Vec<Case> = vec![
            ("hook off", Ok(vec![plain("Invalid login credentials"); 5]), Code::CanaryFailed, Some(false)),
            ("hook answered", Ok(vec![plain("HOOK_ERROR"); 5]), Code::CanaryFailed, Some(false)),
            ("transport", Err("timed out".into()), Code::Unhealthy, None),
            ("5xx", Ok(vec![(500, "{}".to_string()); 5]), Code::Unhealthy, None),
            ("short answer", Ok(vec![plain("x")]), Code::Unhealthy, None),
        ];
        for (name, grants, code, last_ok) in cases {
            let t = tempfile::tempdir().unwrap();
            let r = roots(&t);
            let m = mock::start(|_| (200, "{}".into()));
            let e = run_with(&r, &ep(&m), LIMIT, true, &|_, _| Ok(()), &|_, _| grants.clone()).unwrap_err();
            assert_eq!(e.code, code, "{name}");
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(r.canary_json()).unwrap()).unwrap();
            assert_eq!(saved.get("lastOk").and_then(Value::as_bool), last_ok, "{name}");
            assert_eq!(saved.get("lastRunAt").is_some(), last_ok.is_some(), "{name}");
        }
    }

    // FR17 #1: the update's in-process canary must not leave a failure record behind (a rollback follows a failure).
    #[test]
    fn a_failed_verdict_for_an_update_leaves_canary_json_byte_identical() {
        for grants in [vec![(400u16, "{\"msg\":\"Invalid login credentials\"}".to_string()); 5], vec![(400, "{\"msg\":\"HOOK_ERROR\"}".to_string()); 5]] {
            let t = tempfile::tempdir().unwrap();
            let r = roots(&t);
            let before = std::fs::read(r.canary_json()).unwrap();
            let m = mock::start(|_| (200, "{}".into()));
            let e = run_with(&r, &ep(&m), LIMIT, false, &|_, _| Ok(()), &|_, _| Ok(grants.clone())).unwrap_err();
            assert_eq!(e.code, Code::CanaryFailed);
            assert_eq!(std::fs::read(r.canary_json()).unwrap(), before, "a failed update canary must not touch canary.json");
        }
    }

    #[test]
    fn ok_verdict_for_an_update_still_stamps_last_run_at_and_last_ok_true() {
        let t = tempfile::tempdir().unwrap();
        let r = roots(&t);
        let m = mock::start(|_| (200, "{}".into()));
        run_with(&r, &ep(&m), LIMIT, false, &|_, _| Ok(()), &|_, _| locked_grants()).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(r.canary_json()).unwrap()).unwrap();
        assert_eq!(saved["lastOk"], json!(true));
        assert!(saved["lastRunAt"].as_str().is_some_and(|s| !s.is_empty()), "{saved}");
    }

    // FR17 #2: every call is bounded by min(its own cap, what is left of the budget); a spent budget fails before any I/O.
    #[test]
    fn call_timeout_is_min_of_cap_and_remaining_and_errs_when_spent() {
        let t0 = Instant::now();
        let deadline = t0 + Duration::from_secs(100);
        let cap = Duration::from_secs(30);
        assert_eq!(call_timeout(cap, deadline, t0).unwrap(), cap);
        assert_eq!(call_timeout(cap, deadline, t0 + Duration::from_secs(80)).unwrap(), Duration::from_secs(20));
        assert_eq!(call_timeout(Duration::from_secs(300), deadline, t0).unwrap(), Duration::from_secs(100));
        for spent in [deadline, deadline + Duration::from_secs(5)] {
            assert_eq!(call_timeout(cap, deadline, spent).unwrap_err().code, Code::Unhealthy);
        }
    }

    #[test]
    fn a_spent_canary_budget_fails_unhealthy_before_any_request() {
        let t = tempfile::tempdir().unwrap();
        let r = roots(&t);
        let before = std::fs::read(r.canary_json()).unwrap();
        let m = mock::start(|_| (200, "{}".into()));
        let called = RefCell::new(false);
        let e = run_with(&r, &ep(&m), Duration::ZERO, true, &|_, _| { *called.borrow_mut() = true; Ok(()) }, &|_, _| { *called.borrow_mut() = true; locked_grants() }).unwrap_err();
        assert_eq!(e.code, Code::Unhealthy, "{}", e.message);
        assert!(m.requests().is_empty(), "{:?}", m.requests().len());
        assert!(!*called.borrow(), "no cleanup and no grants either");
        assert_eq!(std::fs::read(r.canary_json()).unwrap(), before);
    }
}
