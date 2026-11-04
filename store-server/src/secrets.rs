//! Per-store secrets under `DATA\secrets\` (conventions section 6).
//!
//! Rules, each pinned by a test:
//! - every secret is 32 bytes from the OS CSPRNG, hex-encoded, generated once and only if absent
//!   (S9 REVIEW I1: regenerating over an existing cluster desynchronises every password);
//! - a file that exists but is malformed is a hard error, never silently replaced (the broker's
//!   "corrupt config is not a new secret" rule);
//! - a missing Postgres password with an existing cluster is a hard error, because a new password
//!   could never be applied to that cluster;
//! - nothing here logs or prints a value: structs holding secrets use `Secret`, whose `Debug`
//!   prints `Secret(***)`.
//!
//! Callers of `ensure` and `load` hold the exclusive `ops::lock`: nothing here guards against two
//! provisioners racing, and `ensure` requires `secrets\` to exist already (the layout step creates
//! it with its protected ACL; this module never creates its own folder).
//!
//! This module writes the files and relies on the folder's ACL (SYSTEM and Administrators only,
//! applied by the layout step before any secret exists). Files that one service must read
//! (`gotrue.env`, `postgrest.conf`) are written and ACL'd by `provision`, not here.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::jwt::{sign_hs256, verify_hs256};
use crate::staff_password::acceptable_pepper;
use crate::util::{now_unix, random_hex, write_atomic, Secret};

pub const PG_ROLES: [&str; 4] = ["supabase_admin", "postgres", "authenticator", "supabase_auth_admin"];
pub const JWT_ISSUER: &str = "supabase-offline-store";
pub const TEN_YEARS_SECS: u64 = 315_360_000;

pub const JWT_SECRET_FILE: &str = "jwt-secret.txt";
pub const KEYS_FILE: &str = "keys.json";
pub const PEPPER_FILE: &str = "staff-password-pepper.txt";
pub const PGPASS_FILE: &str = "pgpass.conf";

pub fn pg_password_file(role: &str) -> String {
    format!("pg-{role}.pw")
}

#[derive(Debug)]
pub enum SecretsError {
    /// A secret file exists but is malformed: refuse to replace it.
    Corrupt { file: String, why: String },
    /// A Postgres password file is gone but the cluster exists.
    ClusterWithoutPassword { file: String },
    /// jwt-secret.txt, keys.json or the pepper is missing or invalid but the cluster exists:
    /// regenerating would lock out every derived staff password / desynchronise the keys.
    ClusterWithoutSecret { file: String },
    /// The secrets folder does not exist: the layout step owns creating it (with its ACL).
    DirMissing,
    Io(String),
}

impl std::fmt::Display for SecretsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretsError::Corrupt { file, why } => write!(
                f,
                "secret file {file} exists but is not valid ({why}); it was left untouched. Restore it from a backup or run unprovision --delete-data"
            ),
            SecretsError::ClusterWithoutPassword { file } => write!(
                f,
                "{file} is missing but the database cluster already exists; a new password could not be applied to it"
            ),
            SecretsError::ClusterWithoutSecret { file } => write!(
                f,
                "{file} is missing or invalid but the database cluster already exists; it was not regenerated"
            ),
            SecretsError::DirMissing => write!(
                f,
                "the secrets folder does not exist; the layout step must create it (with its access rules) before secrets are written"
            ),
            SecretsError::Io(e) => write!(f, "secrets I/O error: {e}"),
        }
    }
}

impl std::error::Error for SecretsError {}

impl From<std::io::Error> for SecretsError {
    fn from(e: std::io::Error) -> Self {
        SecretsError::Io(e.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Secrets {
    pub jwt_secret: Secret,
    pub anon_key: Secret,
    pub service_role_key: Secret,
    pub pg: BTreeMap<String, Secret>,
    pub pepper: Secret,
}

impl Secrets {
    pub fn pg_password(&self, role: &str) -> &str {
        self.pg.get(role).map(Secret::expose).unwrap_or("")
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnsureReport {
    /// File names written by this call (empty on the second run).
    pub created: Vec<String>,
}

/// 64 lower-case hex characters with real entropy: an all-zero buffer (what a failed RNG call on
/// Windows PowerShell 5.1 silently produces) has one distinct character and is refused.
fn is_hex64(s: &str) -> bool {
    let distinct: std::collections::HashSet<u8> = s.bytes().collect();
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) && distinct.len() >= 8
}

/// Read a hex secret file. `Ok(None)` when absent; `Err(Corrupt)` when present but not 64 hex.
fn read_hex_secret(dir: &Path, file: &str) -> Result<Option<String>, SecretsError> {
    match std::fs::read_to_string(dir.join(file)) {
        Ok(text) => {
            let v = text.trim_start_matches('\u{feff}').trim().to_string();
            if is_hex64(&v) {
                Ok(Some(v))
            } else {
                Err(SecretsError::Corrupt { file: file.into(), why: "expected 64 lower-case hex characters".into() })
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Create a new file atomically and never overwrite: the content goes to a random temp file in
/// the same folder (inherits its ACL), is fsynced, then hard-linked to the final name, which
/// fails with `AlreadyExists` if the name is taken. A crash leaves at most a temp file, never a
/// half-written secret under its real name.
fn write_new(dir: &Path, file: &str, content: &str) -> Result<(), SecretsError> {
    write_new_via(dir, file, content, || Ok(()))
}

/// `between` runs after the temp write and before the link (test seam for a mid-write failure).
fn write_new_via(dir: &Path, file: &str, content: &str, between: impl FnOnce() -> std::io::Result<()>) -> Result<(), SecretsError> {
    let tmp = dir.join(format!(".{file}.{}.tmp", random_hex(8).map_err(SecretsError::Io)?));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        between()?;
        std::fs::hard_link(&tmp, dir.join(file))
    })();
    let _ = std::fs::remove_file(&tmp);
    result.map_err(SecretsError::from)
}

const MAX_REDRAWS: usize = 16;

/// Draw until `ok` accepts, at most `MAX_REDRAWS` times: a dead RNG fails instead of hanging.
fn draw_until(mut draw: impl FnMut() -> Result<String, SecretsError>, ok: impl Fn(&str) -> bool) -> Result<String, SecretsError> {
    for _ in 0..MAX_REDRAWS {
        let v = draw()?;
        if ok(&v) {
            return Ok(v);
        }
    }
    Err(SecretsError::Io("the system random source kept returning unusable values".into()))
}

/// 32 CSPRNG bytes as hex, redrawn until `is_hex64` accepts it (a pathological draw).
fn fresh_hex() -> Result<String, SecretsError> {
    draw_until(|| random_hex(32).map_err(SecretsError::Io), is_hex64)
}

/// Rejection-sampled so `staff_password::acceptable_pepper` always accepts it.
fn generate_pepper() -> Result<String, SecretsError> {
    draw_until(fresh_hex, acceptable_pepper)
}

/// Pepper file: absent is `None`; present but not acceptable is `Corrupt`.
fn read_pepper(dir: &Path) -> Result<Option<String>, SecretsError> {
    match read_hex_secret(dir, PEPPER_FILE)? {
        Some(v) if !acceptable_pepper(&v) => {
            Err(SecretsError::Corrupt { file: PEPPER_FILE.into(), why: "pepper too weak".into() })
        }
        other => Ok(other),
    }
}

fn read_or_create_hex(dir: &Path, file: &str, created: &mut Vec<String>) -> Result<String, SecretsError> {
    if let Some(v) = read_hex_secret(dir, file)? {
        return Ok(v);
    }
    let v = fresh_hex()?;
    write_new(dir, file, &v)?;
    created.push(file.to_string());
    Ok(v)
}

fn mint_keys(jwt_secret: &str) -> (String, String) {
    let iat = now_unix();
    let claims = |role: &str| json!({"iss": JWT_ISSUER, "role": role, "iat": iat, "exp": iat + TEN_YEARS_SECS});
    (sign_hs256(jwt_secret, &claims("anon")), sign_hs256(jwt_secret, &claims("service_role")))
}

fn read_keys(dir: &Path, jwt_secret: &str) -> Result<Option<(String, String)>, SecretsError> {
    let text = match std::fs::read_to_string(dir.join(KEYS_FILE)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let bad = |why: &str| SecretsError::Corrupt { file: KEYS_FILE.into(), why: why.into() };
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| bad("not JSON"))?;
    let get = |k: &str, role: &str| -> Result<String, SecretsError> {
        let tok = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| bad("missing key"))?;
        let claims = verify_hs256(jwt_secret, tok).ok_or_else(|| bad("signature does not match jwt-secret.txt"))?;
        if claims.get("role").and_then(|r| r.as_str()) != Some(role) {
            return Err(bad("wrong role claim"));
        }
        Ok(tok.to_string())
    };
    Ok(Some((get("anon", "anon")?, get("service_role", "service_role")?)))
}

/// Generate whatever is missing, keep whatever is valid. `cluster_exists` is true when
/// `pgdata\PG_VERSION` exists. `dir` must already exist (`DirMissing` otherwise). Caller holds
/// the exclusive `ops::lock`.
pub fn ensure(dir: &Path, cluster_exists: bool) -> Result<EnsureReport, SecretsError> {
    if !dir.is_dir() {
        return Err(SecretsError::DirMissing);
    }
    if cluster_exists {
        // Check before writing anything: no regeneration beside a live cluster.
        let jwt = read_hex_secret(dir, JWT_SECRET_FILE)?
            .ok_or_else(|| SecretsError::ClusterWithoutSecret { file: JWT_SECRET_FILE.into() })?;
        read_keys(dir, &jwt)?.ok_or_else(|| SecretsError::ClusterWithoutSecret { file: KEYS_FILE.into() })?;
        read_pepper(dir)?.ok_or_else(|| SecretsError::ClusterWithoutSecret { file: PEPPER_FILE.into() })?;
    }
    let mut created = Vec::new();
    read_or_create_hex(dir, JWT_SECRET_FILE, &mut created)?;
    let jwt = read_hex_secret(dir, JWT_SECRET_FILE)?.unwrap_or_default();
    if read_keys(dir, &jwt)?.is_none() {
        let (anon, svc) = mint_keys(&jwt);
        write_new(dir, KEYS_FILE, &serde_json::to_string_pretty(&json!({"anon": anon, "service_role": svc})).unwrap_or_default())?;
        created.push(KEYS_FILE.to_string());
    }
    for role in PG_ROLES {
        let file = pg_password_file(role);
        if cluster_exists && read_hex_secret(dir, &file)?.is_none() {
            return Err(SecretsError::ClusterWithoutPassword { file });
        }
        read_or_create_hex(dir, &file, &mut created)?;
    }
    if read_pepper(dir)?.is_none() {
        write_new(dir, PEPPER_FILE, &generate_pepper()?)?;
        created.push(PEPPER_FILE.to_string());
    }
    Ok(EnsureReport { created })
}

/// Caller holds the exclusive `ops::lock`.
pub fn load(dir: &Path) -> Result<Secrets, SecretsError> {
    let need = |file: &str| -> Result<String, SecretsError> {
        read_hex_secret(dir, file)?.ok_or_else(|| SecretsError::Corrupt { file: file.into(), why: "missing".into() })
    };
    let jwt = need(JWT_SECRET_FILE)?;
    let (anon, svc) = read_keys(dir, &jwt)?.ok_or_else(|| SecretsError::Corrupt { file: KEYS_FILE.into(), why: "missing".into() })?;
    let mut pg = BTreeMap::new();
    for role in PG_ROLES {
        pg.insert(role.to_string(), Secret(need(&pg_password_file(role))?));
    }
    Ok(Secrets {
        jwt_secret: Secret(jwt),
        anon_key: Secret(anon),
        service_role_key: Secret(svc),
        pg,
        pepper: Secret(
            read_pepper(dir)?.ok_or_else(|| SecretsError::Corrupt { file: PEPPER_FILE.into(), why: "missing".into() })?,
        ),
    })
}

/// The aggregate libpq password file `posctl` uses for psql, pg_dump and the migration CLI.
pub fn pgpass_content(port: u16, secrets: &Secrets) -> String {
    debug_assert!(PG_ROLES.iter().all(|r| is_hex64(secrets.pg_password(r))), "pgpass fields must be hex");
    PG_ROLES
        .iter()
        .map(|r| format!("127.0.0.1:{port}:*:{r}:{}\n", secrets.pg_password(r)))
        .collect()
}

/// Derived entirely from the individual files, so rewriting it is always safe.
pub fn write_pgpass(dir: &Path, port: u16, secrets: &Secrets) -> Result<PathBuf, SecretsError> {
    let p = dir.join(PGPASS_FILE);
    write_atomic(&p, pgpass_content(port, secrets).as_bytes())?;
    Ok(p)
}

/// Optional secrets of the Functions program (AI import, e-mail receipts). Absent by default; the owner sets
/// them with `posctl secret set <name> --stdin`. Anything outside this list is refused.
pub const OPTIONAL_SECRETS: [&str; 3] = ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "RECEIPT_FROM_EMAIL"];

pub fn optional_file(name: &str) -> String {
    format!("optional-{name}.txt")
}

/// One line, 1..=512 characters, no control characters (so it cannot add a line to a `KEY=value` list).
pub fn check_optional_value(v: &str) -> Result<(), String> {
    if v.is_empty() {
        return Err("the value is empty".into());
    }
    if v.chars().count() > 512 {
        return Err("the value is longer than 512 characters".into());
    }
    if v.chars().any(char::is_control) {
        return Err("the value must be a single line without control characters".into());
    }
    Ok(())
}

/// Every optional secret file that exists, in `OPTIONAL_SECRETS` order. A file that exists but is not a valid
/// value is an error (never silently skipped: a skipped key would turn a feature off without anyone noticing).
pub fn load_optional(dir: &Path) -> Result<Vec<(String, Secret)>, SecretsError> {
    let mut out = Vec::new();
    for name in OPTIONAL_SECRETS {
        let file = optional_file(name);
        match std::fs::read_to_string(dir.join(&file)) {
            Ok(text) => {
                let v = text.trim_start_matches('\u{feff}').trim_end_matches(['\r', '\n']);
                check_optional_value(v).map_err(|why| SecretsError::Corrupt { file: file.clone(), why })?;
                out.push((name.to_string(), Secret(v.to_string())));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(out)
}

/// Name on the allow-list, value acceptable: `USAGE` otherwise. Pure, so the CLI refuses before it resolves any root.
pub fn check_optional_args(name: &str, value: &str) -> Result<(), crate::envelope::PosctlError> {
    use crate::envelope::{Code, PosctlError};
    if !OPTIONAL_SECRETS.contains(&name) {
        return Err(PosctlError::new(Code::Usage, format!("unknown secret name (one of {})", OPTIONAL_SECRETS.join(", "))));
    }
    check_optional_value(value).map_err(|why| PosctlError::new(Code::Usage, format!("{name}: {why}")))
}

/// `posctl secret set <name> --stdin`: validate, take `update.lock` exclusive (like `pack activate`), render the
/// Functions environment WITH the new value first (so a bad value changes nothing), write
/// `secrets\optional-<name>.txt` atomically (it inherits the folder's SYSTEM + Administrators ACL), rewrite the
/// service environment and restart only Functions. The value is never part of the result or of an error.
pub fn set_optional(roots: &crate::paths::Roots, rt: &dyn crate::runtime::Runtime, name: &str, value: &str) -> Result<crate::envelope::Outcome, crate::envelope::PosctlError> {
    set_optional_with(roots, rt, name, value, &crate::lifecycle::real_wait)
}

pub fn set_optional_with(roots: &crate::paths::Roots, rt: &dyn crate::runtime::Runtime, name: &str, value: &str, wait: crate::lifecycle::HealthWait) -> Result<crate::envelope::Outcome, crate::envelope::PosctlError> {
    use crate::envelope::{Code, Outcome, PosctlError};
    check_optional_args(name, value)?;
    let (inst, _lock) = crate::lifecycle::begin(roots)?;
    let cfg = crate::config::PosctlJson::load(roots).map_err(PosctlError::error)?.ok_or_else(|| PosctlError::new(Code::NotProvisioned, "conf\\posctl.json is missing"))?;
    let s = load(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    let mut input = crate::render::input_from(roots, inst.ports, &cfg.server.host, &s);
    input.optional = load_optional(&roots.secrets()).map_err(|e| PosctlError::error(e.to_string()))?;
    match input.optional.iter_mut().find(|(k, _)| k == name) {
        Some(slot) => slot.1 = Secret(value.to_string()),
        None => input.optional.push((name.to_string(), Secret(value.to_string()))),
    }
    let env = crate::render::functions_env(&input).map_err(PosctlError::error)?; // validates
    write_atomic(&roots.secrets().join(optional_file(name)), value.as_bytes())?;
    rt.set_functions_env(roots, &env).map_err(PosctlError::error)?;
    // Functions and what depends on it (the Gateway): the SCM refuses to stop Functions under a running dependent
    crate::lifecycle::restart_locked(roots, rt, &inst, Some("Functions"), wait)?;
    Ok(Outcome::ok("secret set", serde_json::json!({"name": name, "set": true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A7: a refused name is attacker-shaped text; it is not echoed
    #[test]
    fn an_unknown_secret_name_is_not_echoed() {
        let e = check_optional_args("evil-name\u{1b}[31m", "v").unwrap_err();
        assert_eq!(e.code, crate::envelope::Code::Usage);
        assert!(!e.message.contains("evil-name"), "{}", e.message);
        assert!(e.message.contains(OPTIONAL_SECRETS[0]), "the allowed names are listed");
    }

    #[test]
    fn ensure_creates_everything_once_and_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let first = ensure(dir.path(), false).unwrap();
        assert!(first.created.contains(&JWT_SECRET_FILE.to_string()));
        assert!(first.created.contains(&KEYS_FILE.to_string()));
        assert_eq!(first.created.len(), 2 + PG_ROLES.len() + 1); // jwt, keys, one per role, pepper
        let before = load(dir.path()).unwrap();
        let second = ensure(dir.path(), false).unwrap();
        assert!(second.created.is_empty(), "a second run must not create anything: {:?}", second.created);
        let after = load(dir.path()).unwrap();
        assert_eq!(before.jwt_secret, after.jwt_secret);
        assert_eq!(before.pg_password("postgres"), after.pg_password("postgres"));
        assert_eq!(before.pepper, after.pepper);
    }

    #[test]
    fn every_secret_is_distinct_and_64_hex() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let s = load(dir.path()).unwrap();
        let mut all: Vec<&str> = vec![s.jwt_secret.expose(), s.pepper.expose()];
        all.extend(PG_ROLES.iter().map(|r| s.pg_password(r)));
        for v in &all {
            assert!(is_hex64(v));
        }
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
        assert!(s.pepper.expose().len() >= crate::staff_password::MIN_PEPPER_LENGTH);
    }

    #[test]
    fn keys_verify_under_the_jwt_secret_with_the_right_roles() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let s = load(dir.path()).unwrap();
        let a = verify_hs256(s.jwt_secret.expose(), s.anon_key.expose()).unwrap();
        let r = verify_hs256(s.jwt_secret.expose(), s.service_role_key.expose()).unwrap();
        assert_eq!(a["role"], "anon");
        assert_eq!(r["role"], "service_role");
        assert_eq!(a["iss"], JWT_ISSUER);
        assert_eq!(a["exp"].as_u64().unwrap() - a["iat"].as_u64().unwrap(), TEN_YEARS_SECS);
    }

    #[test]
    fn a_corrupt_secret_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let f = dir.path().join(pg_password_file("postgres"));
        std::fs::write(&f, "tampered").unwrap();
        assert!(matches!(ensure(dir.path(), false), Err(SecretsError::Corrupt { .. })));
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "tampered");
    }

    #[test]
    fn an_all_zero_secret_is_refused_as_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        std::fs::write(dir.path().join(PEPPER_FILE), "0".repeat(64)).unwrap();
        assert!(matches!(ensure(dir.path(), false), Err(SecretsError::Corrupt { .. })));
    }

    #[test]
    fn keys_that_do_not_match_the_jwt_secret_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        std::fs::write(dir.path().join(JWT_SECRET_FILE), "0".repeat(64)).unwrap();
        assert!(matches!(ensure(dir.path(), false), Err(SecretsError::Corrupt { .. })));
    }

    #[test]
    fn missing_pg_password_with_an_existing_cluster_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        std::fs::remove_file(dir.path().join(pg_password_file("authenticator"))).unwrap();
        assert!(matches!(ensure(dir.path(), true), Err(SecretsError::ClusterWithoutPassword { .. })));
        // without a cluster the same gap is simply filled
        assert!(ensure(dir.path(), false).unwrap().created.contains(&pg_password_file("authenticator")));
    }

    #[test]
    fn pgpass_lists_the_four_roles_on_the_configured_port() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let s = load(dir.path()).unwrap();
        let text = pgpass_content(47300, &s);
        assert_eq!(text.lines().count(), 4);
        assert!(text.lines().all(|l| l.starts_with("127.0.0.1:47300:*:")));
        let p = write_pgpass(dir.path(), 47300, &s).unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), text);
    }

    #[test]
    fn debug_output_never_contains_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let s = load(dir.path()).unwrap();
        let dbg = format!("{s:?}");
        assert!(!dbg.contains(s.jwt_secret.expose()));
        assert!(!dbg.contains(s.pepper.expose()));
        assert!(!dbg.contains(s.pg_password("postgres")));
    }

    #[test]
    fn every_generated_pepper_is_acceptable() {
        for _ in 0..2000 {
            let p = generate_pepper().unwrap();
            assert!(crate::staff_password::acceptable_pepper(&p) && is_hex64(&p));
        }
    }

    #[test]
    fn missing_pepper_or_jwt_or_keys_with_a_cluster_creates_nothing() {
        for file in [PEPPER_FILE, JWT_SECRET_FILE, KEYS_FILE] {
            let dir = tempfile::tempdir().unwrap();
            ensure(dir.path(), false).unwrap();
            std::fs::remove_file(dir.path().join(file)).unwrap();
            let list = |d: &std::path::Path| {
                let mut v: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name()).collect();
                v.sort();
                v
            };
            let before = list(dir.path());
            assert!(matches!(ensure(dir.path(), true), Err(SecretsError::ClusterWithoutSecret { .. })), "{file}");
            assert_eq!(list(dir.path()), before, "{file}: nothing may be created");
        }
    }

    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn write_new_failing_after_the_temp_write_leaves_no_final_and_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let err = write_new_via(dir.path(), "a.pw", "x", || Err(std::io::Error::other("boom")));
        assert!(err.is_err());
        assert!(names(dir.path()).is_empty(), "{:?}", names(dir.path()));
    }

    #[test]
    fn write_new_never_replaces_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        write_new(dir.path(), "a.pw", "first").unwrap();
        assert!(write_new(dir.path(), "a.pw", "second").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("a.pw")).unwrap(), "first");
        assert_eq!(names(dir.path()), vec!["a.pw".to_string()]);
    }

    #[test]
    fn ensure_does_not_create_a_missing_secrets_folder() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("secrets");
        let err = ensure(&missing, false).unwrap_err();
        assert!(matches!(err, SecretsError::DirMissing), "{err:?}");
        assert!(!missing.exists());
        assert!(!err.to_string().contains(dir.path().to_str().unwrap()));
    }

    #[test]
    fn redraw_loops_give_up_instead_of_hanging() {
        assert!(matches!(draw_until(|| Ok("0".repeat(64)), is_hex64), Err(SecretsError::Io(_))));
        assert!(matches!(draw_until(|| Ok("a".repeat(64)), |_| false), Err(SecretsError::Io(_))));
    }

    #[test]
    fn a_leading_bom_on_a_hex_file_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        ensure(dir.path(), false).unwrap();
        let f = dir.path().join(pg_password_file("postgres"));
        let v = std::fs::read_to_string(&f).unwrap();
        std::fs::write(&f, format!("\u{feff}{v}\r\n")).unwrap();
        assert_eq!(load(dir.path()).unwrap().pg_password("postgres"), v);
    }

    // ---- optional secrets (Task 11, step 3b) ----

    use crate::envelope::Code;
    use crate::paths::Roots;
    use crate::runtime::Runtime;
    use crate::services::Component;
    use std::cell::RefCell;
    use std::time::Duration;

    #[derive(Default)]
    struct Rec {
        calls: RefCell<Vec<String>>,
        env: RefCell<Vec<String>>,
    }
    impl Runtime for Rec {
        fn name(&self) -> &'static str { "rec" }
        fn prepare(&self, _: &Roots, _: &Path, _: Component) -> Result<(), String> { Ok(()) }
        fn run_script_as_postgres(&self, _: &Roots, _: &Path, _: &Path, _: Duration) -> Result<(), String> { Ok(()) }
        // fails on purpose: the health gate is a real 90 s network wait that a unit test must never reach
        fn start(&self, _: &Roots, _: &Path, c: Component) -> Result<(), String> { self.calls.borrow_mut().push(format!("start {}", c.short())); Err("no service in a unit test".into()) }
        fn stop(&self, c: Component) -> Result<(), String> { self.calls.borrow_mut().push(format!("stop {}", c.short())); Ok(()) }
        fn set_functions_env(&self, _: &Roots, e: &[String]) -> Result<(), String> { *self.env.borrow_mut() = e.to_vec(); Ok(()) }
        fn unregister(&self, _: Component) -> Result<(), String> { Ok(()) }
        fn protect_file(&self, _: &Path, _: &[crate::acl::Grant]) -> Result<(), String> { Ok(()) }
    }

    fn installed() -> (tempfile::TempDir, Roots) {
        let d = tempfile::tempdir().unwrap();
        let roots = Roots::custom(d.path().join("data"), d.path().join("prog"));
        for p in [roots.state(), roots.conf(), roots.secrets()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(roots.provisioned_json(), "{}").unwrap();
        let p = roots.pack_dir("1.0.0-r1").unwrap();
        std::fs::create_dir_all(&p).unwrap();
        crate::pack::make_fake_pack(&p, "1.0.0-r1");
        crate::config::PosctlJson::new("offline-only", "id", 47300, "shop", "1.0.0-r1").save(&roots).unwrap();
        ensure(&roots.secrets(), false).unwrap();
        // restarting Functions is a sign-in start (SEC-I1): the lockout hook variables must be there
        std::fs::write(roots.gotrue_env(), format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true
GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={}
", crate::render::HOOK_URI)).unwrap();
        (d, roots)
    }

    fn a_value(tag: &str) -> String {
        format!("{tag}-{}", crate::util::random_hex(8).unwrap())
    }

    #[test]
    fn an_unknown_name_or_a_bad_value_is_usage_and_changes_nothing() {
        let (_d, roots) = installed();
        let rt = Rec::default();
        assert_eq!(set_optional(&roots, &rt, "JWT_SECRET", "x").unwrap_err().code, Code::Usage);
        assert_eq!(set_optional(&roots, &rt, "anthropic_api_key", "x").unwrap_err().code, Code::Usage);
        for bad in ["", "two\nlines", "tab\there", "nul\0byte", &"a".repeat(513)] {
            assert_eq!(set_optional(&roots, &rt, "ANTHROPIC_API_KEY", bad).unwrap_err().code, Code::Usage, "{bad:?}");
        }
        assert!(rt.calls.borrow().is_empty() && rt.env.borrow().is_empty());
        assert!(load_optional(&roots.secrets()).unwrap().is_empty());
    }

    #[test]
    fn a_good_value_lands_in_its_file_and_in_the_functions_environment_and_only_functions_restarts() {
        let (_d, roots) = installed();
        let rt = Rec::default();
        let v1 = a_value("one");
        let e = set_optional(&roots, &rt, "ANTHROPIC_API_KEY", &v1).unwrap_err(); // the Rec runtime refuses to start
        assert!(!e.message.contains(&v1), "the value is never part of a message");
        assert_eq!(std::fs::read_to_string(roots.secrets().join("optional-ANTHROPIC_API_KEY.txt")).unwrap(), v1);
        assert!(rt.env.borrow().contains(&format!("ANTHROPIC_API_KEY={v1}")));
        assert_eq!(*rt.calls.borrow(), vec!["stop Gateway".to_string(), "stop Functions".to_string(), "start Functions".to_string()], "Functions and what depends on it, nothing else");
        // a second set replaces the value and keeps the other optional ones
        let other = a_value("mail");
        let _ = set_optional(&roots, &rt, "RECEIPT_FROM_EMAIL", &other);
        let v2 = a_value("two");
        let _ = set_optional(&roots, &rt, "ANTHROPIC_API_KEY", &v2);
        let env = rt.env.borrow().clone();
        assert!(env.contains(&format!("ANTHROPIC_API_KEY={v2}")) && env.contains(&format!("RECEIPT_FROM_EMAIL={other}")));
        assert!(!env.iter().any(|l| l.contains(&v1)));
        assert_eq!(env.iter().filter(|l| l.starts_with("ANTHROPIC_API_KEY=")).count(), 1);
    }

    // C1 + I3: on a running store, secret set succeeds: Gateway stops first, Functions and Gateway come back healthy
    #[test]
    fn secret_set_on_a_running_store_restarts_functions_and_its_dependents() {
        use crate::lifecycle::test_support::Scm;
        let (_d, roots) = installed();
        let scm = Scm::all_running();
        let waited = RefCell::new(Vec::new());
        let healthy = |c: Component, _: &crate::lifecycle::Installed| {
            waited.borrow_mut().push(c.short().to_string());
            Some(1u64)
        };
        let v = a_value("live");
        let out = set_optional_with(&roots, &scm, "ANTHROPIC_API_KEY", &v, &healthy).unwrap();
        assert_eq!(out.code, Code::Ok);
        assert!(!out.message.contains(&v));
        assert_eq!(*scm.calls.borrow(), vec!["stop Gateway", "stop Functions", "start Functions", "start Gateway"]);
        assert_eq!(*waited.borrow(), vec!["Functions", "Gateway"]);
        assert_eq!(scm.running.borrow().len(), 5);
        assert!(scm.env.borrow().contains(&format!("ANTHROPIC_API_KEY={v}")));
    }

    #[test]
    fn functions_env_is_unchanged_without_optional_files_and_a_corrupt_one_is_an_error() {
        let (_d, roots) = installed();
        let s = load(&roots.secrets()).unwrap();
        let base = crate::render::input_from(&roots, crate::ports::Ports { base: 47300 }, "shop", &s);
        assert!(load_optional(&roots.secrets()).unwrap().is_empty());
        assert_eq!(crate::render::functions_env(&base).unwrap().len(), crate::render::FUNCTIONS_BASE_KEYS.len());
        std::fs::write(roots.secrets().join(optional_file("RESEND_API_KEY")), "a\nb").unwrap();
        assert!(matches!(load_optional(&roots.secrets()), Err(SecretsError::Corrupt { .. })));
    }
}
