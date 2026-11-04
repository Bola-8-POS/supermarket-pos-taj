//! First admin and the lockout canary, both through the INTERNAL gateway listener with the
//! service-role key (the LAN listener refuses `/auth/v1/admin/*`). Never raw SQL into
//! `auth.users`.
//!
//! First admin: a new store has no staff and `create-staff` needs an admin, so the provisioner
//! makes the first one out of band. The Auth password is the derived one (D7), `profiles.pin`
//! stays the plaintext PIN the client pre-checks, and `must_change_pin = true` forces a change at
//! first sign-in. The PIN is shown once by the caller and written nowhere.

use std::time::Duration;

use serde_json::{json, Value};

use crate::http::{request, Resp};
use crate::staff_password::derive_staff_password;
use crate::util::{random_hex, random_uuid_v4, Redactor, Secret};

const T: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Endpoint {
    /// `http://127.0.0.1:<base+5>`
    pub internal_url: String,
    pub anon_key: Secret,
    pub service_key: Secret,
}

impl Endpoint {
    fn call(&self, method: &str, path: &str, body: Option<&Value>, extra: &[(&str, &str)]) -> Result<Resp, String> {
        self.call_for(method, path, body, extra, T)
    }

    /// `call` with the caller's own timeout (the canary bounds every request by what is left of its budget).
    fn call_for(&self, method: &str, path: &str, body: Option<&Value>, extra: &[(&str, &str)], t: Duration) -> Result<Resp, String> {
        let bearer = format!("Bearer {}", self.service_key.expose());
        let mut h: Vec<(&str, &str)> = vec![("apikey", self.service_key.expose()), ("Authorization", &bearer), ("Content-Type", "application/json")];
        h.extend_from_slice(extra);
        request(method, &format!("{}{path}", self.internal_url), &h, body, t)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FirstAdmin {
    Created { id: String, email: String },
    /// An active admin already exists: nothing was changed and no PIN is shown.
    AlreadyExists { id: String },
}

#[derive(Debug)]
pub enum FirstAdminError {
    Transport(String),
    /// A step failed; `orphan` is the auth user id when the rollback delete also failed.
    Step { step: &'static str, status: u16, orphan: Option<String> },
    Derive(String),
    /// Created, but the sign-in checks did not hold.
    Verify(String),
    /// A PIN reset failed; the text says whether both stores were put back.
    Reset(String),
}

impl std::fmt::Display for FirstAdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FirstAdminError::Transport(e) => write!(f, "{e}"),
            FirstAdminError::Step { step, status, orphan } => {
                write!(f, "first admin step '{step}' failed with HTTP {status}")?;
                if let Some(o) = orphan {
                    write!(f, "; AND the rollback failed: auth user {o} is orphaned")?;
                }
                Ok(())
            }
            FirstAdminError::Derive(e) => write!(f, "{e}"),
            FirstAdminError::Verify(e) => write!(f, "first admin verification failed: {e}"),
            FirstAdminError::Reset(e) => write!(f, "first admin PIN reset failed: {e}"),
        }
    }
}

/// Hands a secret value to a [`Redactor`] (short whole-token match AND long substring match). `create_first_admin`
/// and `reset_first_admin_pin` call the registrar with the PIN and the derived Auth password BEFORE their first
/// request, so no error text or log line produced from that point can carry either value.
pub fn registrar(red: &mut Redactor) -> impl FnMut(&str) + '_ {
    move |s| {
        red.add_short(s);
        red.add(s);
    }
}

pub fn profile_row(id: &str, name: &str, pin: &str, email: &str) -> Value {
    json!({"id": id, "name": name, "role": "admin", "pin": pin, "email": email,
           "is_active": true, "must_change_pin": true, "locale": "es-MX"})
}

pub fn staff_email(id: &str) -> String {
    format!("{id}@barpos.local")
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn is_2xx(r: &Resp) -> bool {
    (200..300).contains(&r.status)
}

/// Delete the profile row first, then the Auth user; both are always attempted. Returns (profile gone, user gone).
fn rollback(ep: &Endpoint, id: &str) -> (bool, bool) {
    let p = ep.call("DELETE", &format!("/rest/v1/profiles?id=eq.{id}"), None, &[]).map(|r| is_2xx(&r)).unwrap_or(false);
    let u = ep.call("DELETE", &format!("/auth/v1/admin/users/{id}"), None, &[]).map(|r| is_2xx(&r)).unwrap_or(false);
    (p, u)
}

fn password_grant(ep: &Endpoint, email: &str, pw: &str) -> Result<Resp, FirstAdminError> {
    request(
        "POST",
        &format!("{}/auth/v1/token?grant_type=password", ep.internal_url),
        &[("apikey", ep.anon_key.expose()), ("Content-Type", "application/json")],
        Some(&json!({"email": email, "password": pw})),
        T,
    )
    .map_err(FirstAdminError::Transport)
}

/// Revoke the session a verification grant opened (best effort): the access token is never kept.
fn revoke_session(ep: &Endpoint, grant: &Resp) {
    if let Some(t) = grant.json().get("access_token").and_then(Value::as_str) {
        let bearer = format!("Bearer {t}");
        let _ = request("POST", &format!("{}/auth/v1/logout", ep.internal_url), &[("apikey", ep.anon_key.expose()), ("Authorization", &bearer)], None, T);
    }
}

/// D7 negative control, then the positive one. The raw PIN must NOT be the Auth password; the derived password must
/// be. One wrong guess is counted by the lockout hook and cleared by the successful grant that follows. Each
/// session a grant opens is revoked at once. A 429 (or any non-400) on the negative control is a failure: the
/// check fails closed and a rate-limit answer is never read as a lock or as "refused".
fn verify_signin(ep: &Endpoint, id: &str, pin: &str, password: &str) -> Result<(), FirstAdminError> {
    let email = staff_email(id);
    let raw = password_grant(ep, &email, pin)?;
    if raw.status != 400 {
        revoke_session(ep, &raw);
        return Err(FirstAdminError::Verify(format!("the raw PIN was accepted as the Auth password (HTTP {})", raw.status)));
    }
    let good = password_grant(ep, &email, password)?;
    let has_token = good.json().get("access_token").is_some();
    revoke_session(ep, &good);
    if good.status != 200 || !has_token {
        return Err(FirstAdminError::Verify(format!("the derived password was refused (HTTP {})", good.status)));
    }
    let row = ep.call("GET", &format!("/rest/v1/profiles?select=pin,must_change_pin&id=eq.{id}"), None, &[]).map_err(FirstAdminError::Transport)?;
    let r0 = row.json().get(0).cloned().unwrap_or(Value::Null);
    if r0.get("pin").and_then(Value::as_str) != Some(pin) || r0.get("must_change_pin") != Some(&json!(true)) {
        return Err(FirstAdminError::Verify("profiles.pin or must_change_pin does not match".into()));
    }
    Ok(())
}

/// `register` receives the PIN and the derived password before the first request is sent.
pub fn create_first_admin(ep: &Endpoint, pepper: &Secret, name: &str, pin: &str, register: &mut dyn FnMut(&str)) -> Result<FirstAdmin, FirstAdminError> {
    let tr = |e: String| FirstAdminError::Transport(e);
    let id = random_uuid_v4().map_err(FirstAdminError::Derive)?;
    let email = staff_email(&id);
    let password = derive_staff_password(&id, pin, pepper.expose()).map_err(|e| FirstAdminError::Derive(e.to_string()))?;
    register(pin);
    register(&password);

    let existing = ep.call("GET", "/rest/v1/profiles?select=id&role=eq.admin&is_active=eq.true&limit=1", None, &[]).map_err(tr)?;
    if existing.status != 200 {
        return Err(FirstAdminError::Step { step: "list-admins", status: existing.status, orphan: None });
    }
    if let Some(id) = existing.json().get(0).and_then(|r| r.get("id")).and_then(Value::as_str) {
        return Ok(FirstAdmin::AlreadyExists { id: id.to_string() });
    }

    let created = match ep.call("POST", "/auth/v1/admin/users", Some(&json!({"id": id, "email": email, "password": password, "email_confirm": true, "user_metadata": {"name": name, "role": "admin"}})), &[]) {
        Ok(r) => r,
        Err(e) => {
            // the request may have been processed before the connection failed: best-effort delete of the Auth user
            let _ = ep.call("DELETE", &format!("/auth/v1/admin/users/{id}"), None, &[]);
            return Err(tr(e));
        }
    };
    if !is_2xx(&created) {
        return Err(FirstAdminError::Step { step: "create-auth-user", status: created.status, orphan: None });
    }

    // Any failure here, a transport error included (the insert may have landed), rolls back profile then Auth user.
    let failed = match ep.call("POST", "/rest/v1/profiles", Some(&profile_row(&id, name, pin, &email)), &[("Prefer", "return=minimal")]) {
        Ok(r) if is_2xx(&r) => None,
        Ok(r) => Some(r.status),
        Err(_) => Some(0),
    };
    if let Some(status) = failed {
        let (p, u) = rollback(ep, &id);
        return Err(FirstAdminError::Step { step: "insert-profile", status, orphan: if p && u { None } else { Some(id) } });
    }

    // review fix: a `Verify` failure (a transport error mid-verification included) leaves no half-made admin behind;
    // otherwise the next run reports `AlreadyExists` and no PIN is ever shown. A failed delete is appended to the
    // error text so the owner knows an orphan remains.
    if let Err(e) = verify_signin(ep, &id, pin, &password) {
        let why = e.to_string();
        let why = why.strip_prefix("first admin verification failed: ").unwrap_or(&why).to_string();
        let (p, u) = rollback(ep, &id);
        let note = if p && u { String::new() } else { format!("; AND the rollback failed (profile deleted: {p}, auth user deleted: {u}) for {id}") };
        return Err(FirstAdminError::Verify(format!("{why}{note}")));
    }
    Ok(FirstAdmin::Created { id, email })
}

/// Reset an existing admin's PIN in BOTH stores in one operation: `profiles.pin` (PostgREST) and the Auth password
/// = the derived one (admin API `PUT /auth/v1/admin/users/<id>`, never raw SQL on `auth.users`). Then the same
/// sign-in checks as creation (derived accepted, raw PIN refused). The old state is read first; if any later step
/// fails, the stores are put back to it, and the error says whether that restore worked, so they never stay
/// split silently. `register` receives the new PIN, the derived password and the old PIN before they are used.
pub fn reset_first_admin_pin(ep: &Endpoint, id: &str, pin: &str, pepper: &Secret, register: &mut dyn FnMut(&str)) -> Result<(), FirstAdminError> {
    if !is_uuid(id) {
        return Err(FirstAdminError::Derive("admin id is not a UUID".into()));
    }
    let password = derive_staff_password(id, pin, pepper.expose()).map_err(|e| FirstAdminError::Derive(e.to_string()))?;
    register(pin);
    register(&password);
    let row = ep.call("GET", &format!("/rest/v1/profiles?select=pin,must_change_pin&id=eq.{id}"), None, &[]).map_err(FirstAdminError::Transport)?;
    let old = row.json().get(0).cloned().unwrap_or(Value::Null);
    let old_pin = match (old.get("pin").and_then(Value::as_str), row.status) {
        (Some(p), 200) => p.to_string(),
        _ => return Err(FirstAdminError::Step { step: "read-profile", status: row.status, orphan: None }),
    };
    register(&old_pin);
    let old_must = old.get("must_change_pin").cloned().unwrap_or(json!(true));
    let set_profile = |p: &str, must: &Value| ep.call("PATCH", &format!("/rest/v1/profiles?id=eq.{id}"), Some(&json!({"pin": p, "must_change_pin": must})), &[("Prefer", "return=minimal")]).map(|r| is_2xx(&r)).unwrap_or(false);
    let set_auth = |pw: &str| ep.call("PUT", &format!("/auth/v1/admin/users/{id}"), Some(&json!({"password": pw})), &[]).map(|r| is_2xx(&r)).unwrap_or(false);
    let restore = |auth_too: bool| -> String {
        let p = set_profile(&old_pin, &old_must);
        let a = !auth_too || derive_staff_password(id, &old_pin, pepper.expose()).map(|pw| set_auth(&pw)).unwrap_or(false);
        if p && a {
            "both stores were restored to the previous PIN".into()
        } else {
            format!("AND the restore failed (profile restored: {p}, auth password restored: {a}); run the reset again")
        }
    };
    if !set_profile(pin, &json!(true)) {
        return Err(FirstAdminError::Reset(format!("updating profiles.pin failed; {}", restore(false))));
    }
    if !set_auth(&password) {
        return Err(FirstAdminError::Reset(format!("updating the Auth password failed; {}", restore(false))));
    }
    if let Err(e) = verify_signin(ep, id, pin, &password) {
        return Err(FirstAdminError::Reset(format!("{e}; {}", restore(true))));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Canary (S11 REVIEW I2): prove the password-verification hook is active.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum CanaryVerdict {
    Ok,
    /// The hook let wrong guesses through: the PIN-guessing bypass is open.
    HookInactive { first_lock_at: Option<usize> },
    /// The hook answered `HOOK_ERROR` or `HOOK_REJECTED` (it fails closed and never raises): sign-in is
    /// broken, not merely unprotected. Surfaced as the `AUTH_HOOK_ERROR` alert by Plan 11.
    HookAnswered(String),
    Unexpected(String),
}

/// GoTrue puts a hook reject message in the JSON body's `msg` (also `message`, `error_description`).
pub fn response_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    ["msg", "message", "error_description"].iter().find_map(|k| v.get(*k).and_then(Value::as_str)).unwrap_or("").to_string()
}

/// `LOCKED:<seconds>` exactly (04b hook answers: `HOOK_ERROR`, `HOOK_REJECTED`, `LOCKED:<seconds>`).
pub fn is_locked_message(m: &str) -> bool {
    m.strip_prefix("LOCKED:").map(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())).unwrap_or(false)
}

/// A 429 (rate limit) from `/token` is `Unexpected` (not HTTP 400) and fails closed: it is never counted as a lock.
/// Five wrong grants straight at GoTrue: 1-4 plain HTTP 400 (not locked), the 5th HTTP 400 with
/// `LOCKED:<n>` (S11 D1; reference algorithm `store-server/pack/test/helpers/canary.mjs`).
pub fn classify_canary(responses: &[(u16, String)]) -> CanaryVerdict {
    if responses.len() != 5 {
        return CanaryVerdict::Unexpected(format!("expected 5 responses, got {}", responses.len()));
    }
    if let Some((i, (s, _))) = responses.iter().enumerate().find(|(_, (s, _))| *s != 400) {
        return CanaryVerdict::Unexpected(format!("response {} was HTTP {s}", i + 1));
    }
    let messages: Vec<String> = responses.iter().map(|(_, b)| response_message(b)).collect();
    if let Some(m) = messages.iter().find(|m| m.as_str() == "HOOK_ERROR" || m.as_str() == "HOOK_REJECTED") {
        return CanaryVerdict::HookAnswered(m.clone());
    }
    let locked: Vec<bool> = messages.iter().map(|m| is_locked_message(m)).collect();
    if locked[..4].iter().any(|l| *l) {
        return CanaryVerdict::Unexpected("locked before the fifth wrong guess".into());
    }
    if locked[4] {
        CanaryVerdict::Ok
    } else {
        CanaryVerdict::HookInactive { first_lock_at: None }
    }
}

/// Clears the canary's lock keys. `id` must be a UUID (checked) because it is interpolated.
pub fn canary_cleanup_sql(id: &str) -> Result<String, String> {
    if !is_uuid(id) {
        return Err("canary id is not a UUID".into());
    }
    Ok(format!("DELETE FROM public.pin_attempts WHERE attempt_key = 'gt:{id}' OR attempt_key LIKE 'login:{id}%';\n"))
}

pub struct CanaryAccount {
    pub id: String,
    pub email: String,
}

/// Create the canary auth user once (no `profiles` row: it cannot sign in to the app). Its password is random,
/// used only in this request and never stored anywhere: nobody can sign in as the canary.
pub fn create_canary(ep: &Endpoint, t: Duration) -> Result<CanaryAccount, String> {
    let id = random_uuid_v4()?;
    let email = format!("{id}@barpos.local"); // review fix: the shape Plan 04b's proven reference canary uses (not `canary-<id>@store.invalid`)
    let password = random_hex(32)?;
    let r = ep.call_for("POST", "/auth/v1/admin/users", Some(&json!({"id": id, "email": email, "password": password, "email_confirm": true})), &[], t)?;
    if !(200..300).contains(&r.status) {
        return Err(format!("creating the canary account failed with HTTP {}", r.status));
    }
    Ok(CanaryAccount { id, email })
}

/// `Ok(true)` = HTTP 200, `Ok(false)` = HTTP 404 (the only answer that means "gone, create a new canary").
/// Anything else (401/403/5xx, a transport failure) is an `Err`: it must fail the canary, not silently mint accounts.
pub fn canary_account_exists(ep: &Endpoint, id: &str, t: Duration) -> Result<bool, String> {
    match ep.call_for("GET", &format!("/auth/v1/admin/users/{id}"), None, &[], t) {
        Ok(r) if r.status == 200 => Ok(true),
        Ok(r) if r.status == 404 => Ok(false),
        Ok(r) => Err(format!("the canary account lookup answered HTTP {}", r.status)),
        Err(e) => Err(format!("the canary account lookup failed: {e}")),
    }
}

/// Five wrong password grants against GoTrue directly (loopback, no gateway in between). `timeout` is asked before
/// EVERY grant (min of 30 s and what is left of the caller's budget); an `Err` from it ends the run.
pub fn run_canary_grants(gotrue_port: u16, email: &str, timeout: &dyn Fn() -> Result<Duration, String>) -> Result<Vec<(u16, String)>, String> {
    (0..5)
        .map(|_| {
            let t = timeout()?;
            let r = request(
                "POST",
                &format!("http://127.0.0.1:{gotrue_port}/token?grant_type=password"),
                &[("Content-Type", "application/json")],
                Some(&json!({"email": email, "password": "not-the-canary-password"})),
                t,
            )?;
            Ok((r.status, r.body))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::mock;
    use std::sync::{Arc, Mutex};

    const PEPPER: &str = "test-pepper-not-secret-0123456789abcdef";

    fn ep(m: &mock::Mock) -> Endpoint {
        Endpoint { internal_url: m.url(), anon_key: Secret("anon-key".into()), service_key: Secret("service-key".into()) }
    }

    #[test]
    fn a_fresh_store_gets_an_admin_whose_auth_password_is_derived_not_the_pin() {
        let pin: &'static str = Box::leak(format!("{}", 135_790).into_boxed_str());
        let state: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::new(Mutex::new((None, None)));
        let st = state.clone();
        let m = mock::start(move |r| {
            let mut s = st.lock().unwrap();
            match (r.method.as_str(), r.path.as_str()) {
                ("GET", p) if p.starts_with("/rest/v1/profiles?select=id&role=eq.admin") => (200, "[]".into()),
                ("POST", "/auth/v1/admin/users") => {
                    let v: Value = serde_json::from_str(&r.body).unwrap();
                    s.0 = v["password"].as_str().map(String::from);
                    s.1 = v["id"].as_str().map(String::from);
                    (200, "{}".into())
                }
                ("POST", "/rest/v1/profiles") => (201, "".into()),
                ("POST", "/auth/v1/logout") => (204, "".into()),
                ("POST", "/auth/v1/token?grant_type=password") => {
                    let v: Value = serde_json::from_str(&r.body).unwrap();
                    if v["password"].as_str() == s.0.as_deref() { (200, "{\"access_token\":\"t\"}".into()) } else { (400, "{\"msg\":\"Invalid login credentials\"}".into()) }
                }
                ("GET", p) if p.starts_with("/rest/v1/profiles?select=pin,must_change_pin") => (200, format!("[{{\"pin\":\"{pin}\",\"must_change_pin\":true}}]")),
                other => panic!("unexpected {other:?}"),
            }
        });
        let out = create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", pin, &mut |_| {}).unwrap();
        let FirstAdmin::Created { id, email } = out else { panic!("expected Created") };
        assert_eq!(email, format!("{id}@barpos.local"));
        let (password, sent_id) = state.lock().unwrap().clone();
        assert_eq!(sent_id.as_deref(), Some(id.as_str()));
        assert_eq!(password.unwrap(), derive_staff_password(&id, pin, PEPPER).unwrap());
        let reqs = m.requests();
        let profile = reqs.iter().find(|r| r.path == "/rest/v1/profiles").unwrap();
        let row: Value = serde_json::from_str(&profile.body).unwrap();
        assert_eq!((row["role"].clone(), row["must_change_pin"].clone(), row["pin"].clone()), (json!("admin"), json!(true), json!(pin)));
        assert!(reqs.iter().all(|r| r.headers.iter().any(|(k, v)| k == "apikey" && !v.is_empty())));
    }

    #[test]
    fn an_existing_admin_is_left_alone() {
        let m = mock::start(|r| if r.method == "GET" { (200, "[{\"id\":\"abc\"}]".into()) } else { panic!("must not write") });
        assert_eq!(create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}).unwrap(), FirstAdmin::AlreadyExists { id: "abc".into() });
    }

    #[test]
    fn a_failed_profile_insert_deletes_the_auth_user_and_reports_an_orphan_when_that_fails_too() {
        for (delete_status, expect_orphan) in [(200u16, false), (500, true)] {
            let m = mock::start(move |r| match r.method.as_str() {
                "GET" => (200, "[]".into()),
                "POST" if r.path == "/auth/v1/admin/users" => (200, "{}".into()),
                "POST" => (409, "{}".into()),
                "DELETE" => (delete_status, "{}".into()),
                _ => (500, "".into()),
            });
            match create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}) {
                Err(FirstAdminError::Step { step: "insert-profile", orphan, .. }) => assert_eq!(orphan.is_some(), expect_orphan),
                other => panic!("unexpected {other:?}"),
            }
            assert!(m.requests().iter().any(|r| r.method == "DELETE" && r.path.starts_with("/auth/v1/admin/users/")));
        }
    }

    #[test]
    fn an_auth_password_equal_to_the_raw_pin_fails_verification() {
        let m = mock::start(|r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", _) => (200, "[]".into()),
            ("POST", "/auth/v1/admin/users") | ("POST", "/rest/v1/profiles") => (200, "{}".into()),
            _ => (200, "{\"access_token\":\"t\"}".into()), // accepts anything, including the raw PIN
        });
        assert!(matches!(create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}), Err(FirstAdminError::Verify(_))));
        // review fix: the failed verification deleted the profile row first and the auth user second
        let dels: Vec<String> = m.requests().iter().filter(|r| r.method == "DELETE").map(|r| r.path.clone()).collect();
        assert_eq!(dels.len(), 2, "{dels:?}");
        assert!(dels[0].starts_with("/rest/v1/profiles?id=eq."), "{dels:?}");
        assert!(dels[1].starts_with("/auth/v1/admin/users/"), "{dels:?}");
    }

    #[test]
    fn canary_account_lookup_distinguishes_200_404_and_everything_else() {
        let id = "00000000-0000-4000-8000-000000000009";
        for (status, want) in [(200u16, Ok(true)), (404, Ok(false)), (500, Err(())), (403, Err(()))] {
            let m = mock::start(move |_| (status, "{}".into()));
            assert_eq!(canary_account_exists(&ep(&m), id, T).map_err(|_| ()), want, "{status}");
        }
        assert!(canary_account_exists(&Endpoint { internal_url: "http://127.0.0.1:1".into(), anon_key: Secret("a".into()), service_key: Secret("s".into()) }, id, T).is_err());
    }

    #[test]
    fn a_short_pepper_fails_before_anything_is_written() {
        let m = mock::start(|r| if r.method == "GET" { (200, "[]".into()) } else { panic!("must not write") });
        assert!(matches!(create_first_admin(&ep(&m), &Secret("short".into()), "Admin", "135790", &mut |_| {}), Err(FirstAdminError::Derive(_))));
    }

    fn r(status: u16, body: &str) -> (u16, String) {
        (status, body.to_string())
    }

    #[test]
    fn canary_verdicts() {
        let plain = r(400, "{\"error_code\":\"invalid_credentials\",\"msg\":\"Invalid login credentials\"}");
        let locked = r(400, "{\"error_code\":\"invalid_credentials\",\"msg\":\"LOCKED:30\"}");
        let good = vec![plain.clone(), plain.clone(), plain.clone(), plain.clone(), locked.clone()];
        assert_eq!(classify_canary(&good), CanaryVerdict::Ok);
        let inactive = vec![plain.clone(); 5];
        assert_eq!(classify_canary(&inactive), CanaryVerdict::HookInactive { first_lock_at: None });
        let early = vec![plain.clone(), plain.clone(), locked.clone(), plain.clone(), locked.clone()];
        assert!(matches!(classify_canary(&early), CanaryVerdict::Unexpected(_)));
        let mut server_error = good.clone();
        server_error[2] = r(500, "{}");
        assert!(matches!(classify_canary(&server_error), CanaryVerdict::Unexpected(_)));
        assert!(matches!(classify_canary(&good[..4]), CanaryVerdict::Unexpected(_)));
    }

    #[test]
    fn hook_answers_other_than_a_lock_are_recognised_and_a_lookalike_lock_is_not_a_lock() {
        let plain = r(400, "{\"msg\":\"Invalid login credentials\"}");
        let broken = r(400, "{\"msg\":\"HOOK_ERROR\"}");
        let rejected = r(400, "{\"message\":\"HOOK_REJECTED\"}");
        let mut v = vec![plain.clone(); 5];
        v[4] = broken;
        assert_eq!(classify_canary(&v), CanaryVerdict::HookAnswered("HOOK_ERROR".into()));
        v[4] = rejected;
        assert_eq!(classify_canary(&v), CanaryVerdict::HookAnswered("HOOK_REJECTED".into()));
        assert!(is_locked_message("LOCKED:30") && !is_locked_message("LOCKED:") && !is_locked_message("LOCKED:3x") && !is_locked_message("xLOCKED:30") && !is_locked_message(""));
        let mut lookalike = vec![plain.clone(); 5];
        lookalike[4] = r(400, "{\"msg\":\"user LOCKED:30 out\"}");
        assert_eq!(classify_canary(&lookalike), CanaryVerdict::HookInactive { first_lock_at: None });
        assert_eq!(response_message("not json"), "");
    }

    #[test]
    fn canary_cleanup_sql_accepts_only_a_uuid() {
        let id = "00000000-0000-4000-8000-0000000000aa";
        let sql = canary_cleanup_sql(id).unwrap();
        assert!(sql.contains(&format!("'gt:{id}'")) && sql.contains(&format!("'login:{id}%'")));
        assert!(canary_cleanup_sql("x'; drop table t; --").is_err());
    }

    #[test]
    fn the_canary_posts_five_wrong_grants_to_gotrue_and_reports_what_it_saw() {
        let n = Arc::new(Mutex::new(0));
        let n2 = n.clone();
        let m = mock::start(move |_| {
            let mut c = n2.lock().unwrap();
            *c += 1;
            if *c == 5 { (400, "{\"msg\":\"LOCKED:30\"}".into()) } else { (400, "{\"msg\":\"Invalid login credentials\"}".into()) }
        });
        let got = run_canary_grants(m.port, "canary@store.invalid", &|| Ok(T)).unwrap();
        assert_eq!(classify_canary(&got), CanaryVerdict::Ok);
        assert!(m.requests().iter().all(|q| q.path == "/token?grant_type=password"));
    }

    #[test]
    fn no_error_text_carries_the_pin_or_the_derived_password_and_both_are_registered_for_redaction() {
        let pin = format!("{}", 246_813);
        let m = mock::start(|r| match r.method.as_str() {
            "GET" => (200, "[]".into()),
            "POST" if r.path == "/auth/v1/admin/users" => (200, "{}".into()),
            "POST" => (409, "{}".into()),
            _ => (500, "".into()),
        });
        let err = create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", &pin, &mut |_| {}).unwrap_err().to_string();
        let id = m.requests().iter().find(|q| q.path == "/auth/v1/admin/users").map(|q| serde_json::from_str::<Value>(&q.body).unwrap()["id"].as_str().unwrap().to_string()).unwrap();
        let derived = derive_staff_password(&id, &pin, PEPPER).unwrap();
        assert!(!err.contains(&pin) && !err.contains(&derived), "{err}");
        let mut red = crate::util::Redactor::new();
        {
            let mut reg = registrar(&mut red);
            reg(&pin);
            reg(&derived);
        }
        let leak = format!("pin {pin} pw {derived}");
        let out = red.redact(&leak);
        assert!(!out.contains(&pin) && !out.contains(&derived), "{out}");
    }

    #[test]
    fn a_transport_failure_during_verification_also_rolls_the_admin_back() {
        let n = Arc::new(Mutex::new(0));
        let m = mock::start(move |r| {
            match (r.method.as_str(), r.path.as_str()) {
                ("GET", _) => (200, "[]".into()),
                ("POST", "/auth/v1/admin/users") | ("POST", "/rest/v1/profiles") => (200, "{}".into()),
                ("DELETE", _) => (200, "{}".into()),
                _ => {
                    *n.lock().unwrap() += 1;
                    (0, "".into()) // an unparsable status line: the client sees a transport error
                }
            }
        });
        let _ = create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {});
        let dels = m.requests().iter().filter(|r| r.method == "DELETE").count();
        assert_eq!(dels, 2);
    }

    #[test]
    fn secrets_are_registered_before_the_first_http_request() {
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let l2 = log.clone();
        let m = mock::start(move |r| {
            l2.lock().unwrap().push(format!("http {} {}", r.method, r.path));
            (500, "{}".into())
        });
        let l3 = log.clone();
        let _ = create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |s| l3.lock().unwrap().push(format!("register {}", s.len())));
        let log = log.lock().unwrap().clone();
        assert!(log.len() >= 3 && log[0] == "register 6" && log[1].starts_with("register ") && log[2].starts_with("http "), "{log:?}");
    }

    #[test]
    fn every_failure_at_the_profile_insert_including_transport_rolls_back_profile_then_auth_user() {
        for transport in [false, true] {
            let m = mock::start(move |r| match (r.method.as_str(), r.path.as_str()) {
                ("GET", _) => (200, "[]".into()),
                ("POST", "/auth/v1/admin/users") => (200, "{}".into()),
                ("POST", "/rest/v1/profiles") => (if transport { 0 } else { 500 }, "".into()),
                _ => (200, "{}".into()),
            });
            assert!(matches!(create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}), Err(FirstAdminError::Step { step: "insert-profile", orphan: None, .. })), "transport {transport}");
            let dels: Vec<String> = m.requests().iter().filter(|q| q.method == "DELETE").map(|q| q.path.clone()).collect();
            assert!(dels.len() == 2 && dels[0].starts_with("/rest/v1/profiles?id=eq.") && dels[1].starts_with("/auth/v1/admin/users/"), "{dels:?}");
        }
    }

    #[test]
    fn a_transport_error_creating_the_auth_user_deletes_it_best_effort() {
        let m = mock::start(|r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", _) => (200, "[]".into()),
            ("POST", "/auth/v1/admin/users") => (0, "".into()),
            _ => (200, "{}".into()),
        });
        assert!(matches!(create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}), Err(FirstAdminError::Transport(_))));
        assert!(m.requests().iter().any(|q| q.method == "DELETE" && q.path.starts_with("/auth/v1/admin/users/")));
    }

    #[test]
    fn the_verification_sessions_are_revoked_with_their_own_access_token() {
        let pin = format!("{}", 135_790);
        let pin_row = pin.clone();
        let pw: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let p2 = pw.clone();
        let m = mock::start(move |r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", q) if q.starts_with("/rest/v1/profiles?select=id") => (200, "[]".into()),
            ("POST", "/auth/v1/admin/users") => {
                *p2.lock().unwrap() = serde_json::from_str::<Value>(&r.body).unwrap()["password"].as_str().map(String::from);
                (200, "{}".into())
            }
            ("POST", "/rest/v1/profiles") => (201, "".into()),
            ("POST", "/auth/v1/token?grant_type=password") => {
                if serde_json::from_str::<Value>(&r.body).unwrap()["password"].as_str() == p2.lock().unwrap().as_deref() { (200, "{\"access_token\":\"tok-1\"}".into()) } else { (400, "{}".into()) }
            }
            ("GET", _) => (200, format!("[{{\"pin\":\"{pin_row}\",\"must_change_pin\":true}}]")),
            _ => (204, "".into()),
        });
        create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", &pin, &mut |_| {}).unwrap();
        let out = m.requests().into_iter().find(|q| q.path == "/auth/v1/logout").expect("a logout request");
        assert!(out.headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer tok-1"));
    }

    #[test]
    fn a_429_on_the_negative_control_fails_closed_and_is_not_a_lock() {
        let m = mock::start(|r| match (r.method.as_str(), r.path.as_str()) {
            ("GET", _) => (200, "[]".into()),
            ("POST", "/auth/v1/token?grant_type=password") => (429, "{\"msg\":\"LOCKED:30\"}".into()),
            _ => (200, "{}".into()),
        });
        assert!(matches!(create_first_admin(&ep(&m), &Secret(PEPPER.into()), "Admin", "135790", &mut |_| {}), Err(FirstAdminError::Verify(_))));
        let rate = (429u16, "{\"msg\":\"LOCKED:30\"}".to_string());
        let plain = (400u16, "{}".to_string());
        assert!(matches!(classify_canary(&[plain.clone(), plain.clone(), plain.clone(), plain, rate]), CanaryVerdict::Unexpected(_)));
    }

    /// Stateful mock of the two stores for the PIN-reset tests.
    struct Stores {
        pin: String,
        password: Option<String>,
    }
    fn reset_mock(id: &str, old_pin: &str, put_status: u16, accept_any_password: bool) -> (mock::Mock, Arc<Mutex<Stores>>) {
        let st = Arc::new(Mutex::new(Stores { pin: old_pin.to_string(), password: Some(derive_staff_password(id, old_pin, PEPPER).unwrap()) }));
        let s2 = st.clone();
        let m = mock::start(move |r| {
            let mut s = s2.lock().unwrap();
            let body: Value = serde_json::from_str(&r.body).unwrap_or(Value::Null);
            match (r.method.as_str(), r.path.as_str()) {
                ("GET", p) if p.starts_with("/rest/v1/profiles?select=pin,must_change_pin") => (200, format!("[{{\"pin\":\"{}\",\"must_change_pin\":true}}]", s.pin)),
                ("PATCH", p) if p.starts_with("/rest/v1/profiles") => {
                    s.pin = body["pin"].as_str().unwrap().to_string();
                    (204, "".into())
                }
                ("PUT", p) if p.starts_with("/auth/v1/admin/users/") => {
                    if put_status < 300 {
                        s.password = body["password"].as_str().map(String::from);
                    }
                    (put_status, "{}".into())
                }
                ("POST", "/auth/v1/token?grant_type=password") => {
                    if accept_any_password || body["password"].as_str() == s.password.as_deref() { (200, "{\"access_token\":\"t\"}".into()) } else { (400, "{}".into()) }
                }
                ("POST", "/auth/v1/logout") => (204, "".into()),
                other => panic!("unexpected {other:?}"),
            }
        });
        (m, st)
    }
    const RID: &str = "00000000-0000-4000-8000-0000000000bb";

    #[test]
    fn reset_updates_profile_pin_and_the_derived_auth_password_through_the_admin_api() {
        let (m, st) = reset_mock(RID, "111222", 200, false);
        let mut seen = Vec::new();
        reset_first_admin_pin(&ep(&m), RID, "135790", &Secret(PEPPER.into()), &mut |s| seen.push(s.to_string())).unwrap();
        let s = st.lock().unwrap();
        assert_eq!((s.pin.as_str(), s.password.clone()), ("135790", Some(derive_staff_password(RID, "135790", PEPPER).unwrap())));
        assert!(seen.contains(&"135790".to_string()) && seen.contains(&"111222".to_string()));
        assert!(m.requests().iter().all(|q| !q.path.contains("auth.users")));
    }

    #[test]
    fn a_failed_auth_update_restores_the_profile_pin_so_the_stores_do_not_split() {
        let (m, st) = reset_mock(RID, "111222", 500, false);
        let err = reset_first_admin_pin(&ep(&m), RID, "135790", &Secret(PEPPER.into()), &mut |_| {}).unwrap_err().to_string();
        assert!(err.contains("restored"), "{err}");
        let s = st.lock().unwrap();
        assert_eq!((s.pin.as_str(), s.password.clone()), ("111222", Some(derive_staff_password(RID, "111222", PEPPER).unwrap())));
    }

    #[test]
    fn a_failed_verification_restores_both_stores_to_the_old_pin() {
        let (m, st) = reset_mock(RID, "111222", 200, true); // accepts the raw PIN too, so verify fails
        assert!(matches!(reset_first_admin_pin(&ep(&m), RID, "135790", &Secret(PEPPER.into()), &mut |_| {}), Err(FirstAdminError::Reset(_))));
        let s = st.lock().unwrap();
        assert_eq!((s.pin.as_str(), s.password.clone()), ("111222", Some(derive_staff_password(RID, "111222", PEPPER).unwrap())));
    }

    #[test]
    fn reset_registers_secrets_before_any_request_and_refuses_a_non_uuid_id() {
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let l2 = log.clone();
        let m = mock::start(move |r| {
            l2.lock().unwrap().push(format!("http {}", r.method));
            (500, "{}".into())
        });
        let l3 = log.clone();
        let _ = reset_first_admin_pin(&ep(&m), RID, "135790", &Secret(PEPPER.into()), &mut |_| l3.lock().unwrap().push("register".into()));
        let log = log.lock().unwrap().clone();
        assert_eq!(&log[..3], &["register", "register", "http GET"], "{log:?}");
        assert!(reset_first_admin_pin(&ep(&m), "x/../y", "135790", &Secret(PEPPER.into()), &mut |_| {}).is_err());
    }
}
