//! The names a store server's TLS certificates cover (conventions section 8.3) and who may ask for one.

use std::net::Ipv4Addr;

#[derive(Debug, PartialEq, Eq)]
pub enum SanError {
    Empty,
    Wildcard,
    TooLong,
    BadLabel(String),
    NotPrivate(String),
}

impl std::fmt::Display for SanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SanError::Empty => write!(f, "host name is empty"),
            SanError::Wildcard => write!(f, "wildcard host names are not allowed"),
            SanError::TooLong => write!(f, "host name is longer than 253 characters"),
            SanError::BadLabel(l) => write!(f, "'{l}' is not a valid host name label"),
            SanError::NotPrivate(ip) => write!(f, "{ip} is not a private shop-network address"),
        }
    }
}

impl std::error::Error for SanError {}

fn valid_label(label: &str) -> bool {
    let b = label.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// Normalises (lower-case) and validates one site host: an RFC 1123 host name or a private IPv4 address
/// (127.0.0.1 included). No wildcard, no public address, no link-local address. The name/address rules are
/// `config::validate_server_host`'s (one validator: octal/hex/short address tricks are already closed there);
/// this adds only the loopback names a test instance and the server's own browser use.
pub fn validate_site_host(raw: &str) -> Result<String, SanError> {
    let host = raw.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Err(SanError::Empty);
    }
    if host.contains('*') {
        return Err(SanError::Wildcard);
    }
    if host.len() > 253 {
        return Err(SanError::TooLong);
    }
    if host == "localhost" || host == "127.0.0.1" {
        return Ok(host);
    }
    match crate::config::validate_server_host(&host) {
        Ok(h) => Ok(h),
        Err(_) if host.parse::<Ipv4Addr>().is_ok() => Err(SanError::NotPrivate(host)),
        Err(_) => {
            let bad = host.split('.').find(|l| !valid_label(l)).or_else(|| host.rsplit('.').next()).unwrap_or(&host);
            Err(SanError::BadLabel(bad.to_string()))
        }
    }
}

/// The full, ordered, de-duplicated site-host list: `<computer>`, `<computer>.local`, `localhost`, `127.0.0.1`, every
/// private non-loopback IPv4 of the machine, then the owner's extra names. An extra name that is invalid is an error
/// (never silently dropped: the owner asked for it).
pub fn compute_site_hosts(
    computer_name: &str,
    local_ips: &[Ipv4Addr],
    extra: &[String],
) -> Result<Vec<String>, SanError> {
    let name = validate_site_host(computer_name)?;
    let mut hosts: Vec<String> = vec![
        name.clone(),
        format!("{name}.local"),
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];
    let mut ips: Vec<Ipv4Addr> = local_ips
        .iter()
        .copied()
        .filter(|ip| ip.is_private() && !ip.is_loopback())
        .collect();
    ips.sort();
    hosts.extend(ips.iter().map(|ip| ip.to_string()));
    for e in extra {
        hosts.push(validate_site_host(e)?);
    }
    let mut seen = std::collections::HashSet::new();
    hosts.retain(|h| seen.insert(h.clone()));
    Ok(hosts)
}

/// Parses `Get-NetIPAddress ... | ConvertTo-Json -Compress` output: one string for one address, an array for several,
/// nothing at all for none.
pub fn parse_ipv4_json(stdout: &str) -> Vec<Ipv4Addr> {
    let text = stdout.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    items
        .into_iter()
        .filter_map(|v| v.as_str())
        .filter_map(|s| s.parse::<Ipv4Addr>().ok())
        .collect()
}

/// The preferred IPv4 addresses of this machine. Windows PowerShell 5.1 is enough (no pwsh 7); absolute path, cleared environment.
pub fn detect_local_ipv4s() -> std::io::Result<Vec<Ipv4Addr>> {
    let script = "NetTCPIP\\Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Select-Object -ExpandProperty IPAddress | ConvertTo-Json -Compress";
    let ps = crate::net::powershell().map_err(std::io::Error::other)?;
    let out = crate::exec::Cmd::new(ps)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .timeout(std::time::Duration::from_secs(60))
        .run()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    if !out.success() {
        return Err(std::io::Error::other(format!("Get-NetIPAddress failed with exit code {}", out.code)));
    }
    Ok(parse_ipv4_json(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_names_and_private_addresses() {
        assert_eq!(validate_site_host(" STOREPC ").unwrap(), "storepc");
        assert_eq!(validate_site_host("storepc.local").unwrap(), "storepc.local");
        assert_eq!(validate_site_host("192.168.1.20").unwrap(), "192.168.1.20");
        assert_eq!(validate_site_host("10.0.0.5").unwrap(), "10.0.0.5");
        assert_eq!(validate_site_host("172.16.4.9").unwrap(), "172.16.4.9");
        assert_eq!(validate_site_host("127.0.0.1").unwrap(), "127.0.0.1");
    }

    #[test]
    fn refuses_wildcards_public_and_link_local_addresses() {
        assert_eq!(validate_site_host("*.local"), Err(SanError::Wildcard));
        assert!(matches!(validate_site_host("8.8.8.8"), Err(SanError::NotPrivate(_))));
        assert!(matches!(validate_site_host("169.254.10.1"), Err(SanError::NotPrivate(_))));
        assert!(matches!(validate_site_host("127.0.0.2"), Err(SanError::NotPrivate(_))));
        assert!(matches!(validate_site_host("172.32.0.1"), Err(SanError::NotPrivate(_))));
    }

    #[test]
    fn refuses_hostile_or_malformed_names() {
        for bad in [
            "",
            "a b",
            "host\nname",
            "host`name",
            "host{name}",
            "ho\"st",
            "-leading",
            "trailing-",
            "under_score",
            "double..dot",
            "host.",
            "300.300.300.300",
            "10.1",
            "@@PKI_DIR@@",
        ] {
            assert!(validate_site_host(bad).is_err(), "{bad:?} must be refused");
        }
        assert_eq!(validate_site_host(&"a".repeat(64)).unwrap_err(), SanError::BadLabel("a".repeat(64)));
    }

    #[test]
    fn computes_the_full_set_in_order_without_duplicates() {
        let ips = [
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(169, 254, 3, 3),
            Ipv4Addr::new(8, 8, 4, 4),
            Ipv4Addr::new(10, 0, 0, 7),
            Ipv4Addr::new(192, 168, 1, 20),
        ];
        let hosts = compute_site_hosts("StorePC", &ips, &["till-server".to_string(), "storepc".to_string()]).unwrap();
        assert_eq!(
            hosts,
            vec![
                "storepc",
                "storepc.local",
                "localhost",
                "127.0.0.1",
                "10.0.0.7",
                "192.168.1.20",
                "till-server"
            ]
        );
    }

    #[test]
    fn an_invalid_extra_name_is_an_error_not_a_silent_drop() {
        let err = compute_site_hosts("storepc", &[], &["*.shop".to_string()]).unwrap_err();
        assert_eq!(err, SanError::Wildcard);
        assert!(compute_site_hosts("bad_name", &[], &[]).is_err());
    }

    #[test]
    fn parses_powershell_json_for_none_one_and_many() {
        assert!(parse_ipv4_json("").is_empty());
        assert!(parse_ipv4_json("not json").is_empty());
        assert_eq!(parse_ipv4_json("\"192.168.1.5\""), vec![Ipv4Addr::new(192, 168, 1, 5)]);
        assert_eq!(
            parse_ipv4_json("[\"192.168.1.5\",\"10.0.0.2\",\"fe80::1\"]"),
            vec![Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(10, 0, 0, 2)]
        );
    }
}
