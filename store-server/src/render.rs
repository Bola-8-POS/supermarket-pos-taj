//! Rendering of every config the components read (conventions section 9): GoTrue's env file,
//! PostgREST's conf, the Functions environment (written to the service registry key), the
//! `postgresql.conf` overrides and the Caddyfile template. Pure functions; the provisioner
//! writes the results with the right ACL.
//!
//! This module must never write a file itself, and the secret-bearing outputs (GoTrue env,
//! PostgREST conf, Functions env) must never reach a log, an envelope or `store.env`.

use std::path::PathBuf;

use crate::ports::Ports;
use crate::util::Secret;

pub const HOOK_URI: &str = "pg-functions://postgres/pos_lockout/password_verification_hook";

#[derive(Debug, Clone)]
pub struct RenderInput {
    pub ports: Ports,
    pub server_host: String,
    pub data_root: PathBuf,
    pub jwt_secret: Secret,
    pub anon_key: Secret,
    pub service_role_key: Secret,
    pub pg_authenticator: Secret,
    pub pg_auth_admin: Secret,
    pub pepper: Secret,
    pub store_name: String,
    /// Optional Functions secrets (`NAME`, value), appended to `functions_env`; empty until Task 11 loads them.
    pub optional: Vec<(String, Secret)>,
    /// TLS mode, LAN bind and site hosts of the Gateway. `input_from` gives plain loopback HTTP; the caller that decides
    /// otherwise (provision, a re-render reading `state\gateway.json`) overrides it.
    pub gateway: crate::gateway::GatewaySettings,
}

/// Keys `functions_env` always renders; optional secrets may not reuse them.
pub const FUNCTIONS_BASE_KEYS: [&str; 11] = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "STAFF_PASSWORD_PEPPER",
    "JWT_SECRET",
    "STORAGE_ROOT",
    "BAR_NAME",
    "BAR_ADDRESS",
    "FUNCTIONS_HOST",
    "FUNCTIONS_PORT",
    "ALLOWED_ORIGINS",
];

/// The only address the bootstrap gateway may listen on: its LAN listener is plain HTTP until Plan 06
/// brings TLS, so it must not be reachable from the shop network. (Task 10's `conf` re-exports this.)
pub const BOOTSTRAP_LAN_BIND: &str = "127.0.0.1";

fn is_host(h: &str) -> bool {
    (1..=253).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

impl RenderInput {
    /// Everything that is written into a line-oriented file or a registry multi-string is checked here, so a
    /// host name, store name or optional secret cannot add or replace a setting.
    pub fn validate(&self) -> Result<(), String> {
        if !is_host(&self.server_host) {
            return Err("server_host must be 1-253 characters of letters, digits, '.' and '-'".to_string());
        }
        if self.store_name.chars().any(char::is_control) {
            return Err("store_name must not contain control characters".to_string());
        }
        let mut seen: Vec<&str> = Vec::new();
        for (k, v) in &self.optional {
            let name_ok = k.starts_with(|c: char| c.is_ascii_uppercase()) && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
            if !name_ok {
                return Err(format!("optional secret name {k:?} must match [A-Z][A-Z0-9_]*"));
            }
            if FUNCTIONS_BASE_KEYS.contains(&k.as_str()) {
                return Err(format!("optional secret {k} would replace a base Functions setting"));
            }
            if seen.contains(&k.as_str()) {
                return Err(format!("optional secret {k} is given twice"));
            }
            seen.push(k);
            if v.expose().chars().any(|c| matches!(c, '\n' | '\r' | '\0')) {
                return Err(format!("the value of optional secret {k} contains a line break or NUL"));
            }
        }
        Ok(())
    }
}

pub fn gotrue_env(i: &RenderInput) -> Result<String, String> {
    i.validate()?;
    let p = &i.ports;
    let lines = [
        "GOTRUE_DB_DRIVER=postgres".to_string(),
        format!("DATABASE_URL=postgres://supabase_auth_admin:{}@127.0.0.1:{}/postgres?sslmode=disable", i.pg_auth_admin.expose(), p.pg()),
        "DB_NAMESPACE=auth".into(),
        "GOTRUE_DB_AUTOMIGRATE=false".into(),
        format!("GOTRUE_JWT_SECRET={}", i.jwt_secret.expose()),
        "GOTRUE_JWT_EXP=3600".into(),
        "GOTRUE_JWT_AUD=authenticated".into(),
        "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated".into(),
        "GOTRUE_JWT_ADMIN_ROLES=service_role".into(),
        "GOTRUE_API_HOST=127.0.0.1".into(),
        format!("PORT={}", p.gotrue()),
        format!("API_EXTERNAL_URL=https://{}:{}/auth/v1", i.server_host, p.gateway_lan()),
        "GOTRUE_SITE_URL=http://tauri.localhost".into(),
        "GOTRUE_DISABLE_SIGNUP=true".into(),
        "GOTRUE_EXTERNAL_EMAIL_ENABLED=true".into(),
        "GOTRUE_MAILER_AUTOCONFIRM=true".into(),
        "GOTRUE_EXTERNAL_PHONE_ENABLED=false".into(),
        "GOTRUE_SMS_AUTOCONFIRM=false".into(),
        "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false".into(),
        "GOTRUE_EXTERNAL_GOOGLE_ENABLED=false".into(),
        "GOTRUE_EXTERNAL_GITHUB_ENABLED=false".into(),
        "GOTRUE_EXTERNAL_APPLE_ENABLED=false".into(),
        "GOTRUE_EXTERNAL_AZURE_ENABLED=false".into(),
        "GOTRUE_EXTERNAL_FACEBOOK_ENABLED=false".into(),
        "GOTRUE_SMTP_ADMIN_EMAIL=admin@store.invalid".into(),
        "GOTRUE_PASSWORD_MIN_LENGTH=6".into(),
        "GOTRUE_PASSWORD_HIBP_ENABLED=false".into(),
        "GOTRUE_RATE_LIMIT_HEADER=X-Forwarded-For".into(),
        "GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10".into(),
        "GOTRUE_LOG_LEVEL=info".into(),
        "GOTRUE_LOG_SQL=none".into(),
        "GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=true".into(),
        format!("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={HOOK_URI}"),
    ];
    Ok(lines.join("\n") + "\n")
}

pub fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let (k, v) = l.split_once('=')?;
            Some((k.trim().to_string(), v.trim().to_string()))
        })
        .collect()
}

/// S11 REVIEW I2: losing these two variables silently reopens the PIN-guessing bypass.
/// `provision`, `start` and `health` assert them.
pub fn gotrue_hook_env_ok(content: &str) -> bool {
    let kv = parse_dotenv(content);
    // dotenv readers keep the LAST duplicate: a repeated hook key is never accepted
    let only = |k: &str| {
        let mut it = kv.iter().filter(|(a, _)| a == k);
        match (it.next(), it.next()) {
            (Some((_, v)), None) => Some(v.as_str()),
            _ => None,
        }
    };
    only("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED") == Some("true")
        && only("GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI") == Some(HOOK_URI)
}

pub fn postgrest_conf(i: &RenderInput) -> String {
    let p = &i.ports;
    [
        format!("db-uri = \"postgres://authenticator:{}@127.0.0.1:{}/postgres\"", i.pg_authenticator.expose(), p.pg()),
        "db-schemas = \"public\"".to_string(),
        "db-anon-role = \"anon\"".to_string(),
        "db-extra-search-path = \"public, extensions\"".to_string(),
        "db-max-rows = 1000".to_string(),
        "db-pool = 10".to_string(),
        format!("jwt-secret = \"{}\"", i.jwt_secret.expose()),
        "server-host = \"127.0.0.1\"".to_string(),
        format!("server-port = {}", p.rest()),
        format!("admin-server-port = {}", p.rest_admin()),
        "log-level = \"warn\"".to_string(),
    ]
    .join("\n")
        + "\n"
}

/// `KEY=value` entries for the Functions service's registry `Environment` value.
pub fn functions_env(i: &RenderInput) -> Result<Vec<String>, String> {
    i.validate()?;
    let p = &i.ports;
    let mut env = vec![
        format!("SUPABASE_URL=http://127.0.0.1:{}", p.gateway_internal()),
        format!("SUPABASE_ANON_KEY={}", i.anon_key.expose()),
        format!("SUPABASE_SERVICE_ROLE_KEY={}", i.service_role_key.expose()),
        format!("STAFF_PASSWORD_PEPPER={}", i.pepper.expose()),
        format!("JWT_SECRET={}", i.jwt_secret.expose()),
        format!("STORAGE_ROOT={}", i.data_root.join("photos").display()),
        format!("BAR_NAME={}", i.store_name),
        "BAR_ADDRESS=".to_string(),
        "FUNCTIONS_HOST=127.0.0.1".to_string(),
        format!("FUNCTIONS_PORT={}", p.functions()),
        "ALLOWED_ORIGINS=http://tauri.localhost,tauri://localhost".to_string(),
    ];
    env.extend(i.optional.iter().map(|(k, v)| format!("{k}={}", v.expose())));
    Ok(env)
}

/// Appended to the `postgresql.conf` initdb wrote (conventions section 7).
pub fn postgresql_conf_overrides(port: u16) -> String {
    format!(
        "\n# --- store backend overrides (posctl) ---\nlisten_addresses = '127.0.0.1'\nport = {port}\nmax_connections = 100\ntimezone = 'UTC'\nlog_timezone = 'UTC'\npassword_encryption = 'scram-sha-256'\nlog_line_prefix = '%m [%p] %q%u@%d '\nlog_min_messages = warning\n"
    )
}

pub fn input_from(roots: &crate::paths::Roots, ports: Ports, host: &str, s: &crate::secrets::Secrets) -> RenderInput {
    RenderInput {
        ports,
        server_host: host.to_string(),
        data_root: roots.data.clone(),
        jwt_secret: s.jwt_secret.clone(),
        anon_key: s.anon_key.clone(),
        service_role_key: s.service_role_key.clone(),
        pg_authenticator: Secret(s.pg_password("authenticator").to_string()),
        pg_auth_admin: Secret(s.pg_password("supabase_auth_admin").to_string()),
        pepper: s.pepper.clone(),
        store_name: "Supermarket POS".to_string(),
        optional: Vec::new(),
        gateway: crate::gateway::GatewaySettings::default(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> RenderInput {
        RenderInput {
            ports: Ports { base: 47300 },
            server_host: "shop-pc".into(),
            data_root: PathBuf::from("C:\\ProgramData\\SupermarketPOS"),
            jwt_secret: Secret("j".repeat(64)),
            anon_key: Secret("anon-token".into()),
            service_role_key: Secret("service-token".into()),
            pg_authenticator: Secret("a".repeat(64)),
            pg_auth_admin: Secret("b".repeat(64)),
            pepper: Secret("p".repeat(64)),
            store_name: "Test Store".into(),
            optional: vec![],
            gateway: crate::gateway::GatewaySettings::default(),
        }
    }

    // FR4 F5: the updater fences exactly the roles the services log in as
    #[test]
    fn every_database_user_in_the_rendered_service_configs_is_a_fence_role() {
        let i = input();
        let mut text = gotrue_env(&i).unwrap();
        text.push_str(&postgrest_conf(&i));
        text.push_str(&functions_env(&i).unwrap().join("
"));
        let mut users: Vec<String> = text.match_indices("postgres://").map(|(at, _)| text[at + 11..].split(':').next().unwrap().to_string()).collect();
        users.sort();
        users.dedup();
        let mut roles: Vec<String> = crate::ops::fence::SERVICE_DB_ROLES.iter().map(|r| r.to_string()).collect();
        roles.sort();
        assert_eq!(users, roles, "a service role missing from SERVICE_DB_ROLES would stay able to log in behind the fence");
    }

    #[test]
    fn gotrue_env_carries_every_required_setting() {
        let kv = parse_dotenv(&gotrue_env(&input()).unwrap());
        let get = |k: &str| kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        for (k, v) in [
            ("GOTRUE_DB_AUTOMIGRATE", "false"),
            ("GOTRUE_JWT_EXP", "3600"),
            ("GOTRUE_API_HOST", "127.0.0.1"),
            ("PORT", "47301"),
            ("API_EXTERNAL_URL", "https://shop-pc:47304/auth/v1"),
            ("GOTRUE_DISABLE_SIGNUP", "true"),
            ("GOTRUE_PASSWORD_MIN_LENGTH", "6"),
            ("GOTRUE_PASSWORD_HIBP_ENABLED", "false"),
            ("GOTRUE_RATE_LIMIT_HEADER", "X-Forwarded-For"),
            ("GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL", "10"),
            ("GOTRUE_LOG_SQL", "none"),
            ("GOTRUE_EXTERNAL_PHONE_ENABLED", "false"),
            ("GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED", "false"),
        ] {
            assert_eq!(get(k).as_deref(), Some(v), "{k}");
        }
        assert!(get("DATABASE_URL").unwrap().ends_with("@127.0.0.1:47300/postgres?sslmode=disable"));
        assert!(kv.iter().all(|(k, _)| !k.contains("ENCRYPT")), "DB encryption must stay off");
    }

    #[test]
    fn the_lockout_hook_variables_are_asserted() {
        let good = gotrue_env(&input()).unwrap();
        assert!(gotrue_hook_env_ok(&good));
        assert!(!gotrue_hook_env_ok(&good.replace("ATTEMPT_ENABLED=true", "ATTEMPT_ENABLED=false")));
        assert!(!gotrue_hook_env_ok(&good.replace("pos_lockout", "other")));
        let without: String = good.lines().filter(|l| !l.contains("HOOK_PASSWORD")).collect::<Vec<_>>().join("\n");
        assert!(!gotrue_hook_env_ok(&without));
    }

    #[test]
    fn postgrest_conf_binds_loopback_and_exposes_only_public() {
        let c = postgrest_conf(&input());
        assert!(c.contains("db-schemas = \"public\"\n"));
        assert!(c.contains("server-host = \"127.0.0.1\"") && c.contains("server-port = 47302") && c.contains("admin-server-port = 47306"));
        assert!(c.contains("@127.0.0.1:47300/postgres\""));
    }

    #[test]
    fn functions_env_matches_section_9_and_uses_the_internal_listener() {
        let e = functions_env(&input()).unwrap();
        let get = |k: &str| e.iter().find(|l| l.starts_with(&format!("{k}="))).map(|l| l[k.len() + 1..].to_string());
        assert_eq!(get("SUPABASE_URL").as_deref(), Some("http://127.0.0.1:47305"));
        assert_eq!(get("FUNCTIONS_PORT").as_deref(), Some("47303"));
        assert_eq!(get("STORAGE_ROOT").as_deref(), Some("C:\\ProgramData\\SupermarketPOS\\photos"));
        assert!(get("STAFF_PASSWORD_PEPPER").unwrap().len() >= 32);
        assert!(get("SPIKE_TEST_ROUTES").is_none());
    }

    #[test]
    fn optional_secrets_are_appended_to_the_functions_env() {
        let mut i = input();
        i.optional.push(("RESEND_API_KEY".into(), Secret("k".repeat(12))));
        assert!(functions_env(&i).unwrap().last().unwrap().starts_with("RESEND_API_KEY="));
        assert_eq!(functions_env(&input()).unwrap().len(), functions_env(&i).unwrap().len() - 1);
    }

    #[test]
    fn postgresql_overrides_are_loopback_utc_scram() {
        let c = postgresql_conf_overrides(47300);
        for want in ["listen_addresses = '127.0.0.1'", "port = 47300", "timezone = 'UTC'", "log_timezone = 'UTC'", "password_encryption = 'scram-sha-256'", "max_connections = 100"] {
            assert!(c.contains(want), "{want}");
        }
    }







    // F6 c: values that are written into an env file / registry multi-string must not break the line.
    #[test]
    fn server_host_must_be_a_plain_host_name_or_address() {
        let with_host = |h: &str| RenderInput { server_host: h.into(), ..input() };
        for ok in ["shop-pc", "192.168.1.5", "a.b-c.local", "A"] {
            assert!(gotrue_env(&with_host(ok)).is_ok(), "{ok}");
        }
        for bad in ["", "a b", "a\nb", "a/b", "a:443", "a@@b", "a_b", "tienda\u{e9}", &"a".repeat(254)] {
            assert!(gotrue_env(&with_host(bad)).is_err(), "{bad:?}");
            assert!(functions_env(&with_host(bad)).is_err(), "{bad:?}");
        }
        assert!(gotrue_env(&with_host(&"a".repeat(253))).is_ok());
    }

    #[test]
    fn the_store_name_cannot_carry_a_control_character() {
        let named = |n: &str| RenderInput { store_name: n.into(), ..input() };
        assert!(functions_env(&named("Tienda Don Pepe & Hijos")).is_ok());
        for bad in ["a\nSUPABASE_URL=evil", "a\rb", "a\0b", "a\tb", "a\u{7f}b"] {
            assert!(functions_env(&named(bad)).is_err(), "{bad:?}");
        }
    }

    // F6 d
    #[test]
    fn optional_secret_names_and_values_are_validated() {
        let with = |k: &str, v: &str| {
            let mut i = input();
            i.optional.push((k.into(), Secret(v.into())));
            functions_env(&i)
        };
        assert!(with("RESEND_API_KEY", "value with spaces = and = signs").is_ok());
        assert!(with("A", "x").is_ok() && with("A1_B2", "x").is_ok());
        for bad in ["", "lower", "1A", "_A", "A-B", "A=B", "A B", "A\nB", "RESEND_API_KEY\n", "SUPABASE_URL", "JWT_SECRET", "STAFF_PASSWORD_PEPPER", "FUNCTIONS_PORT", "ALLOWED_ORIGINS"] {
            assert!(with(bad, "x").is_err(), "{bad:?}");
        }
        for bad in ["a\nJWT_SECRET=evil", "a\0b", "a\rb"] {
            assert!(with("RESEND_API_KEY", bad).is_err(), "{bad:?}");
        }
        let mut dup = input();
        dup.optional.push(("RESEND_API_KEY".into(), Secret("1".into())));
        dup.optional.push(("RESEND_API_KEY".into(), Secret("2".into())));
        assert!(functions_env(&dup).is_err(), "duplicate names are ambiguous");
    }

    #[test]
    fn the_reserved_name_list_covers_every_base_functions_setting() {
        for line in functions_env(&input()).unwrap() {
            let k = line.split('=').next().unwrap();
            assert!(FUNCTIONS_BASE_KEYS.contains(&k), "{k} is rendered but not reserved");
        }
        assert_eq!(FUNCTIONS_BASE_KEYS.len(), functions_env(&input()).unwrap().len());
    }

    // F6 e: dotenv readers keep the last duplicate, so a second hook line could flip the lockout hook off.
    #[test]
    fn a_duplicate_hook_key_fails_the_hook_check() {
        let good = gotrue_env(&input()).unwrap();
        let off = "\nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED=false\n";
        assert!(!gotrue_hook_env_ok(&format!("{good}{off}")));
        assert!(!gotrue_hook_env_ok(&format!("{good}\nGOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI={HOOK_URI}\n")), "even an identical duplicate");
        assert!(gotrue_hook_env_ok(&good));
    }
}
