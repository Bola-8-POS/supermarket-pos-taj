//! The hosted project's address and service key, read from stdin only (`--source-credentials-stdin`).
//! The URL rules are Plan 09's `switch/source.rs` `parse_storage` and `loopback_literal`, copied so a project that passes
//! Plan 09's check cannot be refused here after the swap (the accept/reject tables below pin both).
//! It must never put the key on a command line, in a log, in an error, in an envelope or in `Debug` output.
use std::io::Read;

use serde::Deserialize;

use crate::envelope::{Code, PosctlError};
use crate::util::Secret;

/// The most stdin the command reads. A longer input is refused, not cut.
pub const MAX_STDIN: u64 = 64 * 1024;

pub struct SourceCredentials {
    /// The origin only (`https://abc.supabase.co`): scheme, host, port. No path, user info, query or fragment.
    pub project_url: String,
    pub service_role_key: Secret,
}

impl std::fmt::Debug for SourceCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceCredentials").field("project_url", &self.project_url).field("service_role_key", &self.service_role_key).finish()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Raw {
    v: u64,
    project_url: String,
    service_role_key: String,
}

fn usage(m: &str) -> PosctlError {
    PosctlError::new(Code::Usage, m)
}

/// Copied from Plan 09 `switch/source.rs`: `localhost` or a loopback IP literal.
fn loopback_literal(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    h == "localhost" || h.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// At most 64 KiB of stdin, then `parse_credentials`.
pub fn read_credentials(stdin: &mut dyn Read) -> Result<SourceCredentials, PosctlError> {
    // one byte more than the limit: `read_stdin_text` cuts at its limit, so an over-long input shows as over-long here
    let text = crate::cli::read_stdin_text(stdin, MAX_STDIN + 1)?;
    if text.len() as u64 > MAX_STDIN {
        return Err(usage("stdin is longer than 64 KiB"));
    }
    parse_credentials(&text)
}

/// `{"v":1,"projectUrl":"<url>","serviceRoleKey":"<key>"}`. Every refusal is `USAGE` (2) and none of them quotes the input
/// (serde's messages can repeat the offending value).
pub fn parse_credentials(text: &str) -> Result<SourceCredentials, PosctlError> {
    // a PowerShell pipe puts a byte order mark in front
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw: Raw = serde_json::from_str(text)
        .map_err(|_| usage("stdin must be one JSON object: {\"v\":1,\"projectUrl\":...,\"serviceRoleKey\":...} with no other key"))?;
    if raw.v != 1 {
        return Err(usage("unsupported stdin version"));
    }
    let bad = || usage("the project URL must be https (http only for localhost) with a host and no credentials, query or fragment");
    let u = url::Url::parse(raw.project_url.trim()).map_err(|_| bad())?;
    let host = u.host_str().filter(|h| !h.is_empty()).ok_or_else(bad)?;
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && loopback_literal(host));
    if !scheme_ok || !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return Err(bad());
    }
    let key = raw.service_role_key.trim();
    if key.is_empty() {
        return Err(usage("the storage service key is empty"));
    }
    // a key is a header value: no space, control or non-ASCII character can be part of one
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(usage("the storage service key has a character that cannot be part of a key"));
    }
    Ok(SourceCredentials { project_url: u.origin().ascii_serialization(), service_role_key: Secret(key.to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sb-test-key-0123456789";

    fn input(url: &str) -> String {
        format!("{{\"v\":1,\"projectUrl\":\"{url}\",\"serviceRoleKey\":\"{KEY}\"}}")
    }

    #[test]
    fn accepts_any_https_host_and_loopback_http() {
        for (url, origin) in [
            ("https://abc.supabase.co", "https://abc.supabase.co"),
            ("https://abc.supabase.co/", "https://abc.supabase.co"),
            ("https://abc.supabase.co/storage/v1", "https://abc.supabase.co"),
            ("https://store.example.com:8443", "https://store.example.com:8443"),
            ("  https://abc.supabase.co  ", "https://abc.supabase.co"),
            ("http://localhost:54321", "http://localhost:54321"),
            ("http://127.0.0.1:47301", "http://127.0.0.1:47301"),
            ("http://[::1]:8000", "http://[::1]:8000"),
        ] {
            let c = parse_credentials(&input(url)).unwrap_or_else(|e| panic!("{url}: {}", e.message));
            assert_eq!((c.project_url.as_str(), c.service_role_key.expose()), (origin, KEY), "{url}");
        }
    }

    #[test]
    fn rejects_userinfo_query_fragment_and_remote_http() {
        for url in [
            "https://user@abc.supabase.co",
            "https://user:pw@abc.supabase.co",
            "https://abc.supabase.co/?a=1",
            "https://abc.supabase.co/#frag",
            "http://example.com",
            "http://10.0.0.5:8000",
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.example",
            "http://127example.com",
            "http://127.0.0.1.nip.io:8000",
            "http://0127.0.0.1",
            "http://localhost@evil.example",
            "ftp://abc.supabase.co",
            "abc.supabase.co",
            "https://",
            "",
        ] {
            let e = parse_credentials(&input(url)).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::Usage, 2), "{url}");
            assert!(!e.message.contains(KEY), "{url}: {}", e.message);
        }
        let blank_key = "{\"v\":1,\"projectUrl\":\"https://abc.supabase.co\",\"serviceRoleKey\":\"  \"}";
        assert_eq!(parse_credentials(blank_key).unwrap_err().code, Code::Usage);
        // a key with a space, a control character or a non-ASCII character is refused, and never quoted
        for key in ["a b", "a\\u0007b", "a\\u00e9b", "a\\nb"] {
            let t = format!("{{\"v\":1,\"projectUrl\":\"https://abc.supabase.co\",\"serviceRoleKey\":\"{key}\"}}");
            let e = parse_credentials(&t).unwrap_err();
            assert_eq!(e.code, Code::Usage, "{key:?}");
            assert!(!e.message.contains(key), "{}", e.message);
        }
    }

    #[test]
    fn requires_v_1_and_no_extra_keys() {
        let ok = input("https://abc.supabase.co");
        assert!(parse_credentials(&ok).is_ok());
        assert!(parse_credentials(&format!("\u{feff}{ok}")).is_ok(), "a PowerShell pipe's byte order mark is the pipe's");
        for bad in [
            ok.replace("\"v\":1", "\"v\":2"),
            ok.replace("\"v\":1,", ""),
            ok.replace("\"v\":1", "\"v\":\"1\""),
            ok.replace('}', ",\"db\":\"x\"}"),
            ok.replace("serviceRoleKey", "service_role_key"),
            "not json".to_string(),
            "[]".to_string(),
            String::new(),
        ] {
            let e = parse_credentials(&bad).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::Usage, 2), "{bad}");
            assert!(!e.message.contains(KEY) && !e.message.contains("abc.supabase.co"), "the input is never quoted: {}", e.message);
        }
    }

    #[test]
    fn debug_redacts_the_key() {
        let c = parse_credentials(&input("https://abc.supabase.co")).unwrap();
        let d = format!("{c:?} {c:#?}");
        assert!(!d.contains(KEY), "{d}");
        assert!(d.contains("Secret(***)") && d.contains("https://abc.supabase.co"));
    }

    #[test]
    fn stdin_over_64kib_is_usage() {
        let pad = " ".repeat(MAX_STDIN as usize);
        let long = format!("{}{pad}", input("https://abc.supabase.co"));
        let e = read_credentials(&mut long.as_bytes()).unwrap_err();
        assert_eq!((e.code, e.message.contains("64 KiB")), (Code::Usage, true));
        // exactly at the limit is fine
        let at_limit = format!("{}{}", input("https://abc.supabase.co"), " ".repeat(MAX_STDIN as usize - input("https://abc.supabase.co").len()));
        assert_eq!(at_limit.len() as u64, MAX_STDIN);
        assert!(read_credentials(&mut at_limit.as_bytes()).is_ok());
    }
}
