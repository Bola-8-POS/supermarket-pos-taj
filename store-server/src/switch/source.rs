//! The source (cloud) credentials. They arrive as JSON on STDIN only (conventions 11.1), live in memory only and
//! never reach a log line, an envelope, the journal or a command line.
use crate::ops::outcome::{OpCode, OpError};
use crate::ops::world::R;
use serde::Deserialize;
use std::fmt;

#[derive(Clone)]
pub struct Secret(String);
impl Secret {
    pub fn new(s: impl Into<String>) -> Secret {
        Secret(s.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(Clone, Debug)]
pub struct PgTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Secret,
    pub dbname: String,
    pub sslmode: String,
    /// Operator's CA file (`sslrootcert=` in the URL); `None` means the bundled Supabase root CA.
    pub sslrootcert: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StorageSource {
    pub project_url: String,
    pub service_role_key: Secret,
}

#[derive(Clone, Debug)]
pub struct SourceCreds {
    pub pg: PgTarget,
    pub storage: Option<StorageSource>,
}

// No Debug derive on the raw shapes: they hold the secrets in the clear.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDb {
    url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawStorage {
    project_url: String,
    service_role_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStdin {
    v: u32,
    db: RawDb,
    #[serde(default)]
    storage: Option<RawStorage>,
}

fn usage(reason: &str, msg: &str) -> OpError {
    OpError::new(OpCode::Usage, reason, msg.to_string())
}

fn v4_is_local(v: std::net::Ipv4Addr) -> bool {
    v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified()
}

/// No DNS resolution here (deferred): a name is judged by its spelling only.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    let h = h.strip_suffix('.').unwrap_or(h).to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h.ends_with(".localhost") || h == "host.docker.internal" {
        return true;
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v)) => v4_is_local(v),
        Ok(std::net::IpAddr::V6(v)) => match v.to_ipv4_mapped() {
            Some(m) => v4_is_local(m),
            None => {
                v.is_loopback()
                    || v.is_unspecified()
                    || (v.segments()[0] & 0xfe00) == 0xfc00
                    || (v.segments()[0] & 0xffc0) == 0xfe80
            }
        },
        Err(_) => !h.contains('.'), // a single-label name is a LAN name
    }
}

/// Letters, digits, dot and dash, or a bracketed IPv6 literal. This refuses a comma list (libpq tries the next host),
/// %-encoded hosts and control characters; a numeric-looking host must be a canonical four-part IPv4.
fn host_is_valid(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<std::net::Ipv6Addr>().is_ok();
    }
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return false;
    }
    let h = host.strip_suffix('.').unwrap_or(host);
    let numeric_looking = !h.is_empty()
        && h.chars()
            .all(|c| c.is_ascii_hexdigit() || c == 'x' || c == 'X' || c == '.');
    !numeric_looking || h.parse::<std::net::Ipv4Addr>().is_ok()
}

fn loopback_literal(host: &str) -> bool {
    let h = host
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    h == "localhost"
        || h.parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

pub fn parse_pg_url(raw: &str) -> R<PgTarget> {
    let bad = |msg: &str| usage("SOURCE_URL_INVALID", msg);
    let u = url::Url::parse(raw.trim()).map_err(|_| bad("the database URL could not be parsed"))?;
    if !matches!(u.scheme(), "postgres" | "postgresql") {
        return Err(bad("the database URL must start with postgresql://"));
    }
    let host = u
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| bad("the database URL has no host"))?
        .to_string();
    if !host_is_valid(&host) {
        return Err(bad(
            "the database host must be a plain host name or IP address",
        ));
    }
    let dec = |s: &str| -> R<String> {
        let d = percent_encoding::percent_decode_str(s)
            .decode_utf8()
            .map_err(|_| bad("the database user or password is not valid UTF-8"))?
            .to_string();
        if d.chars().any(char::is_control) {
            return Err(bad("the database user or password has a control character"));
        }
        Ok(d)
    };
    let user = dec(u.username())?;
    if user.is_empty() {
        return Err(bad("the database URL has no user"));
    }
    let password = match u.password() {
        Some(p) => dec(p)?,
        None => String::new(),
    };
    if password.is_empty() {
        return Err(bad("the database URL has no password"));
    }
    if u.port() == Some(0) {
        return Err(bad("the database port is not valid"));
    }
    let path = u.path().trim_start_matches('/');
    let dbname = if path.is_empty() {
        "postgres".to_string()
    } else {
        path.to_string()
    };
    if !dbname
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(bad(
            "the database name has characters outside letters, digits and underscore",
        ));
    }
    let query = |name: &str| {
        u.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.to_string())
    };
    // A cloud host is verified by default; a loopback source (the Sandbox, tests) keeps the old default.
    let sslmode = query("sslmode").unwrap_or_else(|| {
        if is_local_host(&host) {
            "require"
        } else {
            "verify-full"
        }
        .to_string()
    });
    if !matches!(
        sslmode.as_str(),
        "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full"
    ) {
        return Err(bad("unknown sslmode"));
    }
    let sslrootcert = query("sslrootcert");
    if sslrootcert
        .as_deref()
        .is_some_and(|p| p.is_empty() || p.chars().any(char::is_control))
    {
        return Err(bad(
            "the sslrootcert path is empty or has a control character",
        ));
    }
    Ok(PgTarget {
        host,
        port: u.port().unwrap_or(5432),
        user,
        password: Secret::new(password),
        dbname,
        sslmode,
        sslrootcert,
    })
}

fn parse_storage(s: RawStorage) -> R<StorageSource> {
    let bad = || {
        usage("SOURCE_STORAGE_URL", "the storage URL must be https (http only for localhost) with a host and no credentials, query or fragment")
    };
    let u = url::Url::parse(s.project_url.trim()).map_err(|_| bad())?;
    let host = u.host_str().filter(|h| !h.is_empty()).ok_or_else(bad)?;
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && loopback_literal(host));
    if !scheme_ok
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(bad());
    }
    let key = s.service_role_key.trim();
    if key.is_empty() {
        return Err(usage(
            "SOURCE_STORAGE_KEY",
            "the storage service key is empty",
        ));
    }
    Ok(StorageSource {
        project_url: u.origin().ascii_serialization(),
        service_role_key: Secret::new(key),
    })
}

pub fn parse_stdin(text: &str) -> R<SourceCreds> {
    // serde's messages can quote the offending value, so none of them is passed on.
    let raw: RawStdin = serde_json::from_str(text)
        .map_err(|_| usage("SOURCE_STDIN_INVALID", "stdin must be one JSON object: {\"v\":1,\"db\":{\"url\":...},\"storage\":{\"projectUrl\":...,\"serviceRoleKey\":...}}"))?;
    if raw.v != 1 {
        return Err(usage("SOURCE_STDIN_VERSION", "unsupported stdin version"));
    }
    let pg = parse_pg_url(&raw.db.url)?;
    let storage = raw.storage.map(parse_storage).transpose()?;
    Ok(SourceCreds { pg, storage })
}

/// Ports of the developer stacks that tests must never use as a source: selfhosted 54321-54329, 55321-55329,
/// and the developer machine's own Postgres services 5432-5433. dev2 (56321-56329) is allowed read-only.
const REFUSED_PORTS: [(u16, u16); 3] = [(54321, 54329), (55321, 55329), (5432, 5433)];

pub fn check_target(pg: &PgTarget, allow_local: bool, local_pg_port: u16) -> R<()> {
    let pre = |reason: &str, m: &str| OpError::new(OpCode::Precondition, reason, m.to_string());
    // Defence in depth: a hand-built target gets the same host charset/numeric guard parse_pg_url applies.
    if !host_is_valid(&pg.host) {
        return Err(usage("SOURCE_URL_INVALID", "the source host is not valid"));
    }
    // these land in the pgpass line: a newline would start a second entry, a NUL would end the first
    if [pg.user.as_str(), pg.dbname.as_str(), pg.password.expose()]
        .iter()
        .any(|v| v.chars().any(char::is_control))
    {
        return Err(usage(
            "SOURCE_URL_INVALID",
            "the source user, database or password has a control character",
        ));
    }
    if pg.port == 6543 {
        return Err(pre("SOURCE_POOLER_PORT", "port 6543 is the transaction pooler; use the session pooler (5432) or the direct connection"));
    }
    if is_local_host(&pg.host) {
        if !allow_local {
            return Err(pre(
                "SOURCE_IS_LOCAL",
                "the source database is on this network; a cloud project is never local",
            ));
        }
        if REFUSED_PORTS
            .iter()
            .any(|(a, b)| (*a..=*b).contains(&pg.port))
        {
            return Err(pre(
                "SOURCE_PORT_REFUSED",
                "that port belongs to a development stack that tests never use as a source",
            ));
        }
        let reserved = pg.dbname == "postgres"
            || pg.dbname == "pos_next"
            || pg.dbname.starts_with("pos_prev_")
            || pg.dbname.starts_with("pos_failed_");
        if pg.port == local_pg_port && reserved {
            return Err(pre(
                "SOURCE_IS_TARGET",
                "the source is this server's own live, clone or previous database",
            ));
        }
    } else if !matches!(pg.sslmode.as_str(), "require" | "verify-ca" | "verify-full") {
        return Err(pre(
            "SOURCE_SSL_REQUIRED",
            "a cloud database must be reached over TLS (sslmode=require or stronger)",
        ));
    }
    Ok(())
}

/// `host:port/db`: the only description of the source that may appear in a journal, log or envelope.
pub fn label(pg: &PgTarget) -> String {
    format!("{}:{}/{}", pg.host, pg.port, pg.dbname)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::outcome::OpCode;

    fn pw() -> String {
        ["Zq", "9x", "Lm", "4v"].concat()
    }
    fn stdin_json(url: &str) -> String {
        serde_json::json!({ "v": 1, "db": { "url": url } }).to_string()
    }

    #[test]
    fn a_cloud_url_parses_into_parts_and_decodes_the_password() {
        let enc = "a%40b%2Fc";
        let url = format!("postgresql://postgres.abcdefghij:{enc}@aws-0-eu.pooler.example.invalid:5432/postgres?sslmode=require");
        let t = parse_pg_url(&url).unwrap();
        assert_eq!(
            (
                t.host.as_str(),
                t.port,
                t.user.as_str(),
                t.dbname.as_str(),
                t.sslmode.as_str()
            ),
            (
                "aws-0-eu.pooler.example.invalid",
                5432,
                "postgres.abcdefghij",
                "postgres",
                "require"
            )
        );
        assert_eq!(t.password.expose(), "a@b/c");
    }

    #[test]
    fn defaults_are_port_5432_database_postgres_and_a_verified_tls_session() {
        let url = format!("postgres://u:{}@db.example.invalid", pw());
        let t = parse_pg_url(&url).unwrap();
        assert_eq!(
            (t.port, t.dbname.as_str(), t.sslmode.as_str()),
            (5432, "postgres", "verify-full")
        );
        assert_eq!(t.sslrootcert, None);
        // a loopback source (the Sandbox) keeps the old default
        let l = parse_pg_url(&format!("postgres://u:{}@127.0.0.1:5999/db", pw())).unwrap();
        assert_eq!(l.sslmode, "require");
    }

    #[test]
    fn an_operator_can_name_the_root_certificate_and_the_mode() {
        let p = |q: &str| {
            parse_pg_url(&format!(
                "postgres://u:{}@db.example.invalid/postgres?{q}",
                pw()
            ))
        };
        let t = p("sslmode=verify-ca&sslrootcert=C%3A%5Cpki%5Cmy%20ca.crt").unwrap();
        assert_eq!(t.sslmode, "verify-ca");
        assert_eq!(t.sslrootcert.as_deref(), Some(r"C:\pki\my ca.crt"));
        // an explicit require stays accepted (encrypts, does not verify the server)
        assert_eq!(p("sslmode=require").unwrap().sslmode, "require");
        for bad in ["sslrootcert=", "sslrootcert=a%0Ab.crt"] {
            assert!(p(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn malformed_urls_are_usage_errors_that_never_echo_the_input() {
        let secret = pw();
        for bad in [
            format!("mysql://u:{secret}@h/db"),
            format!("postgresql://:{secret}@h/db"),
            "postgresql://u@h/db".to_string(),
            format!("postgresql://u:{secret}@/db"),
            format!("postgresql://u:{secret}@h/db;drop"),
            format!("postgresql://u:{secret}@h/db?sslmode=banana"),
        ] {
            let e = parse_pg_url(&bad).unwrap_err();
            assert_eq!(e.code, OpCode::Usage, "{bad}");
            assert!(!e.message.contains(&secret) && !e.reason.contains(&secret));
        }
    }

    #[test]
    fn stdin_must_be_the_exact_json_shape_and_errors_do_not_quote_it() {
        let secret = pw();
        let url = format!("postgresql://u:{secret}@db.example.invalid/postgres");
        assert!(parse_stdin(&stdin_json(&url)).is_ok());
        for bad in [
            format!("not json {secret}"),
            serde_json::json!({ "v": 2, "db": { "url": url } }).to_string(),
            serde_json::json!({ "v": 1, "db": { "url": url }, "extra": secret }).to_string(),
            serde_json::json!({ "v": secret, "db": { "url": url } }).to_string(),
        ] {
            let e = parse_stdin(&bad).unwrap_err();
            assert_eq!(e.code, OpCode::Usage);
            assert!(
                !e.message.contains(&secret) && !e.reason.contains(&secret),
                "{}",
                e.message
            );
        }
    }

    #[test]
    fn storage_credentials_are_optional_and_https_unless_local() {
        let url = format!("postgresql://u:{}@db.example.invalid/postgres", pw());
        let ok = serde_json::json!({ "v": 1, "db": { "url": url }, "storage": { "projectUrl": "https://x.example.invalid/", "serviceRoleKey": "k".repeat(20) } }).to_string();
        let c = parse_stdin(&ok).unwrap();
        assert_eq!(
            c.storage.as_ref().unwrap().project_url,
            "https://x.example.invalid"
        );
        let http = serde_json::json!({ "v": 1, "db": { "url": url }, "storage": { "projectUrl": "http://x.example.invalid", "serviceRoleKey": "k".repeat(20) } }).to_string();
        assert_eq!(parse_stdin(&http).unwrap_err().code, OpCode::Usage);
    }

    #[test]
    fn debug_output_never_shows_a_secret() {
        let secret = pw();
        let url = format!("postgresql://u:{secret}@db.example.invalid/postgres");
        let c = parse_stdin(&stdin_json(&url)).unwrap();
        let shown = format!("{c:?} {:?}", c.pg);
        assert!(!shown.contains(&secret) && shown.contains("***"));
        assert_eq!(label(&c.pg), "db.example.invalid:5432/postgres");
    }

    fn target(host: &str, port: u16, db: &str, ssl: &str) -> PgTarget {
        PgTarget {
            host: host.into(),
            port,
            user: "u".into(),
            password: Secret::new("x"),
            dbname: db.into(),
            sslmode: ssl.into(),
            sslrootcert: None,
        }
    }

    #[test]
    fn a_cloud_source_needs_tls_and_never_the_transaction_pooler() {
        assert!(check_target(
            &target("db.example.invalid", 5432, "postgres", "require"),
            false,
            47300
        )
        .is_ok());
        assert!(check_target(
            &target("db.example.invalid", 5432, "postgres", "verify-full"),
            false,
            47300
        )
        .is_ok());
        for ssl in ["disable", "prefer", "allow"] {
            assert_eq!(
                check_target(
                    &target("db.example.invalid", 5432, "postgres", ssl),
                    false,
                    47300
                )
                .unwrap_err()
                .reason,
                "SOURCE_SSL_REQUIRED"
            );
        }
        assert_eq!(
            check_target(
                &target("db.example.invalid", 6543, "postgres", "require"),
                false,
                47300
            )
            .unwrap_err()
            .reason,
            "SOURCE_POOLER_PORT"
        );
    }

    #[test]
    fn a_local_source_is_refused_unless_a_dev_or_test_run_allows_it() {
        assert_eq!(
            check_target(
                &target("127.0.0.1", 56322, "cloud_src", "disable"),
                false,
                47300
            )
            .unwrap_err()
            .reason,
            "SOURCE_IS_LOCAL"
        );
        assert!(check_target(
            &target("127.0.0.1", 47300, "cloud_src", "disable"),
            true,
            47300
        )
        .is_ok());
        assert!(
            check_target(
                &target("127.0.0.1", 56322, "postgres", "disable"),
                true,
                47300
            )
            .is_ok(),
            "dev2 is allowed as a READ-ONLY source"
        );
    }

    #[test]
    fn the_selfhosted_dev_stack_and_the_servers_own_live_database_are_never_a_source() {
        for port in [54321u16, 54322, 55325, 5432, 5433] {
            assert_eq!(
                check_target(
                    &target("127.0.0.1", port, "postgres", "disable"),
                    true,
                    47300
                )
                .unwrap_err()
                .reason,
                "SOURCE_PORT_REFUSED",
                "{port}"
            );
        }
        assert_eq!(
            check_target(
                &target("localhost", 47300, "postgres", "disable"),
                true,
                47300
            )
            .unwrap_err()
            .reason,
            "SOURCE_IS_TARGET"
        );
        for db in [
            "pos_next",
            "pos_prev_switch_20261002023015",
            "pos_failed_20261002023015",
        ] {
            assert_eq!(
                check_target(&target("127.0.0.1", 47300, db, "disable"), true, 47300)
                    .unwrap_err()
                    .reason,
                "SOURCE_IS_TARGET",
                "{db}"
            );
        }
    }

    #[test]
    fn local_host_detection() {
        for h in [
            "localhost",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.9",
            "[::1]",
            "posserver",
        ] {
            assert!(is_local_host(h), "{h}");
        }
        for h in [
            "db.abcdefghij.supabase.co",
            "aws-0-eu.pooler.supabase.com",
            "34.120.0.1",
        ] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn local_host_detection_covers_the_tricky_spellings() {
        for h in [
            "localhost.",
            "LOCALHOST",
            "a.localhost",
            "a.b.LocalHost.",
            "host.docker.internal",
            "127.0.0.1.",
            "[::ffff:127.0.0.1]",
            "[::ffff:10.0.0.1]",
            "[fd00::1]",
            "[fc00::1]",
            "[fe80::1]",
            "[::]",
        ] {
            assert!(is_local_host(h), "{h}");
        }
        for h in [
            "",
            ".",
            "[::ffff:8.8.8.8]",
            "[2001:db8::1]",
            "localhost.example.invalid",
            "notlocalhost.invalid",
        ] {
            assert!(!is_local_host(h), "{h:?}");
        }
    }

    fn assert_bad_url(url: &str) {
        let e = parse_pg_url(url).unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (OpCode::Usage, "SOURCE_URL_INVALID"),
            "{url}"
        );
        assert!(
            !e.message.contains(&pw()) && !e.reason.contains(&pw()),
            "{url}"
        );
    }

    #[test]
    fn only_plain_hostnames_and_bracketed_ipv6_are_hosts() {
        let p = pw();
        for host in [
            "nothing.invalid,127.0.0.1",
            "a%2eb.invalid",
            "a%01b.invalid",
            "a%7fb.invalid",
            "db_x.invalid",
            "[abc]",
        ] {
            assert_bad_url(&format!("postgresql://u:{p}@{host}/db"));
        }
        assert_bad_url(&format!(
            "postgresql://u:{p}@nothing.invalid,127.0.0.1:5432/db"
        ));
        for host in [
            "db.example.invalid",
            "[::1]",
            "127.0.0.1.",
            "a-b.example.invalid",
        ] {
            assert!(
                parse_pg_url(&format!("postgresql://u:{p}@{host}/db")).is_ok(),
                "{host}"
            );
        }
    }

    #[test]
    fn numeric_looking_hosts_that_are_not_a_canonical_ipv4_are_refused() {
        let p = pw();
        for host in [
            "127.1",
            "0x7f.0.0.1",
            "2130706433",
            "0x7f000001",
            "1.2.3",
            "1.2.3.4.5",
            "0177.0.0.1",
        ] {
            assert_bad_url(&format!("postgresql://u:{p}@{host}/db"));
        }
        assert!(parse_pg_url(&format!("postgresql://u:{p}@127.0.0.1/db")).is_ok());
    }

    #[test]
    fn user_and_password_must_be_strict_utf8_without_control_characters_and_the_port_is_not_zero() {
        let p = pw();
        for bad in [
            format!("postgresql://u%ff:{p}@db.example.invalid/db"),
            format!("postgresql://u:{p}%ff@db.example.invalid/db"),
            format!("postgresql://u%01:{p}@db.example.invalid/db"),
            format!("postgresql://u:{p}%0a@db.example.invalid/db"),
            format!("postgresql://u:{p}%7f@db.example.invalid/db"),
            format!("postgresql://u:{p}@db.example.invalid:0/db"),
        ] {
            assert_bad_url(&bad);
        }
    }

    #[test]
    fn a_stdin_version_other_than_one_is_reported_as_a_version_error() {
        let url = format!("postgresql://u:{}@db.example.invalid/postgres", pw());
        let e = parse_stdin(&serde_json::json!({ "v": 2, "db": { "url": url } }).to_string())
            .unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (OpCode::Usage, "SOURCE_STDIN_VERSION")
        );
    }

    fn with_storage(project_url: &str, key: &str) -> R<SourceCreds> {
        let url = format!("postgresql://u:{}@db.example.invalid/postgres", pw());
        parse_stdin(&serde_json::json!({ "v": 1, "db": { "url": url }, "storage": { "projectUrl": project_url, "serviceRoleKey": key } }).to_string())
    }

    #[test]
    fn a_storage_url_must_be_https_or_http_on_a_loopback_literal_with_a_host_and_no_extras() {
        let key = "k".repeat(20);
        for bad in [
            "http://x.example.invalid",
            "http://intranet",
            "http://10.0.0.5",
            "http://192.168.1.9",
            "file:///etc/hosts",
            "data:text/plain,x",
            "javascript:alert(1)",
            "https://u:p@x.example.invalid",
            "https://u@x.example.invalid",
            "https://x.example.invalid/?a=1",
            "https://x.example.invalid/#f",
            "ftp://x.example.invalid",
            "",
            "   ",
        ] {
            let e = with_storage(bad, &key).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "SOURCE_STORAGE_URL"),
                "{bad:?}"
            );
        }
        for good in [
            "http://127.0.0.1:54321",
            "http://127.9.9.9",
            "http://localhost:8000",
            "http://LOCALHOST",
            "http://[::1]:8000",
        ] {
            assert!(with_storage(good, &key).is_ok(), "{good}");
        }
    }

    #[test]
    fn a_password_only_storage_url_is_refused_like_any_userinfo() {
        // The plan's storage sketch allows no userinfo at all (Task 1 Step 7), so a password with an empty username fails closed.
        let key = "k".repeat(20);
        let pw = pw();
        let e = with_storage(&format!("https://:{pw}@x.example.invalid"), &key).unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (OpCode::Usage, "SOURCE_STORAGE_URL")
        );
    }

    #[test]
    fn a_hand_built_target_cannot_bypass_the_host_guard() {
        for host in ["a,127.0.0.1", "", "h%41", "0x7f.1"] {
            let e = check_target(&target(host, 5432, "db", "require"), true, 47300).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "SOURCE_URL_INVALID"),
                "{host:?}"
            );
        }
    }

    #[test]
    fn the_storage_url_and_key_are_trimmed_and_the_origin_is_stored() {
        let c = with_storage(
            "  https://X.example.invalid:8443/  ",
            &format!("  {}  ", "k".repeat(20)),
        )
        .unwrap();
        let s = c.storage.unwrap();
        assert_eq!(s.project_url, "https://x.example.invalid:8443");
        assert_eq!(s.service_role_key.expose(), "k".repeat(20));
    }

    #[test]
    fn an_empty_or_whitespace_storage_key_is_refused() {
        for key in ["", "   ", "\t\n"] {
            let e = with_storage("https://x.example.invalid", key).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (OpCode::Usage, "SOURCE_STORAGE_KEY"),
                "{key:?}"
            );
        }
    }
}
