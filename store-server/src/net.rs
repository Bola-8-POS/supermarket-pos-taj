//! Network profile and firewall (conventions 4.3). The LAN listener's rule is scoped to the
//! Private and Domain profiles and to the local subnet, with no program filter (the program path
//! changes with every pack version and Caddy is the only listener on the port). A network Windows
//! marked Public blocks every till, so the provisioner offers to mark the shop network Private
//! (after the owner confirms) and `net check` keeps reporting it. Never add Public to the rule:
//! "local subnet" on a guest Wi-Fi includes customers' phones (S9 REVIEW I3).
//!
//! The builders and parsers are pure. `ensure_rule`, `remove_rule` and `fix_profiles` change the
//! host and run only from `provision`/`net fix` (and in Windows Sandbox scenarios), never from a
//! host unit test. The rule is READ through PowerShell as numbers, never by parsing netsh's
//! localised text (store PCs run es-MX Windows); netsh is kept for add/delete.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::exec::Cmd;
use crate::ports::Ports;

pub const RULE_NAME: &str = "Supermarket POS Store Server (LAN)";

// GetSystemDirectoryW, never %SystemRoot% (an elevated process must not trust the environment).
// `Cmd` clears the child environment, so PSModulePath is never inherited either.
fn netsh() -> Result<PathBuf, String> {
    Ok(crate::sys::system_dir()?.join("netsh.exe"))
}

pub(crate) fn powershell() -> Result<PathBuf, String> {
    Ok(crate::sys::system_dir()?.join("WindowsPowerShell").join("v1.0").join("powershell.exe"))
}

fn rule_args(verb: &str) -> Vec<String> {
    ["advfirewall", "firewall", verb, "rule"].map(String::from).into_iter().chain([format!("name={RULE_NAME}")]).collect()
}

pub fn netsh_delete_args() -> Vec<String> {
    rule_args("delete")
}

pub fn netsh_add_args(ports: &Ports) -> Vec<String> {
    let mut a = rule_args("add");
    a.extend(["dir=in", "action=allow", "protocol=TCP"].map(String::from));
    a.push(format!("localport={}", ports.gateway_lan()));
    a.extend(["profile=private,domain", "remoteip=localsubnet"].map(String::from));
    a
}

/// One firewall rule read back from the persistent store, enums as numbers so the answer does not
/// depend on the Windows display language. Values verified on Windows: Enabled True=1; Direction
/// Inbound=1; Action Allow=2; Profile Private|Domain=3 (Any=0 would include Public);
/// EdgeTraversalPolicy Block=0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirewallRule {
    pub enabled: i64,
    pub direction: i64,
    pub action: i64,
    pub profile: i64,
    pub edge: i64,
    pub protocol: String,
    pub local_ports: Vec<String>,
    pub remote_addrs: Vec<String>,
    pub program: String,
    pub service: String,
}

const READ_RULE_SCRIPT: &str = r"@(NetSecurity\Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName '__RULE__' -EA SilentlyContinue) | % { $p=$_|NetSecurity\Get-NetFirewallPortFilter; $a=$_|NetSecurity\Get-NetFirewallAddressFilter; $g=$_|NetSecurity\Get-NetFirewallApplicationFilter; $s=$_|NetSecurity\Get-NetFirewallServiceFilter; [pscustomobject]@{En=[int]$_.Enabled;Dir=[int]$_.Direction;Act=[int]$_.Action;Prof=[int]$_.Profile;Edge=[int]$_.EdgeTraversalPolicy;Proto=$p.Protocol;LPort=@($p.LocalPort);RAddr=@($a.RemoteAddress);Prog=$g.Program;Svc=$s.Service} } | ConvertTo-Json -Compress";

/// One Windows PowerShell 5.1 call (module-qualified, no `-AsArray`); empty output = no such rule.
pub fn read_rule_script() -> String {
    READ_RULE_SCRIPT.replace("__RULE__", RULE_NAME)
}

fn text_list(v: Option<&Value>) -> Vec<String> {
    match v {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(other) => vec![other.to_string()],
    }
}

/// Windows PowerShell 5.1 prints one object (not an array) when there is one rule.
pub fn parse_rules(json: &str) -> Result<Vec<FirewallRule>, String> {
    let t = json.trim().trim_start_matches('\u{feff}');
    if t.is_empty() {
        return Ok(vec![]);
    }
    let v: Value = serde_json::from_str(t).map_err(|e| format!("cannot read the firewall rule: {e}"))?;
    let items = match v {
        Value::Array(a) => a,
        one => vec![one],
    };
    items
        .iter()
        .map(|o| {
            let n = |k: &str| o.get(k).and_then(Value::as_i64).ok_or_else(|| format!("firewall rule field {k} missing"));
            Ok(FirewallRule {
                enabled: n("En")?,
                direction: n("Dir")?,
                action: n("Act")?,
                profile: n("Prof")?,
                edge: n("Edge")?,
                protocol: text_list(o.get("Proto")).concat(),
                local_ports: text_list(o.get("LPort")),
                remote_addrs: text_list(o.get("RAddr")),
                program: text_list(o.get("Prog")).concat(),
                service: text_list(o.get("Svc")).concat(),
            })
        })
        .collect()
}

/// Right only when there is exactly one rule of this name (a second could widen it) and it allows
/// inbound TCP on exactly the LAN port, for Private+Domain only, to the local subnet, with no
/// program, service or edge-traversal opening.
pub fn rule_ok(rules: &[FirewallRule], ports: &Ports) -> bool {
    let [r] = rules else { return false };
    r.enabled == 1
        && r.direction == 1
        && r.action == 2
        && r.profile == 3
        && r.edge == 0
        && r.protocol.eq_ignore_ascii_case("TCP")
        && r.local_ports == [ports.gateway_lan().to_string()]
        && r.remote_addrs.len() == 1
        && r.remote_addrs[0].eq_ignore_ascii_case("LocalSubnet")
        && r.program.eq_ignore_ascii_case("Any")
        && r.service.eq_ignore_ascii_case("Any")
}

pub fn read_rule() -> Result<Vec<FirewallRule>, String> {
    let o = Cmd::new(powershell()?).args(["-NoProfile", "-NonInteractive", "-Command", &read_rule_script()]).timeout(Duration::from_secs(60)).run().map_err(|e| e.to_string())?;
    if !o.success() {
        return Err(format!("Get-NetFirewallRule failed ({}): {}", o.code, o.stderr.trim()));
    }
    parse_rules(&o.stdout)
}

/// Delete-then-add: netsh's `add` is not idempotent by name (same pattern as windows/hooks.nsh).
pub fn ensure_rule(ports: &Ports) -> Result<(), String> {
    let netsh = netsh()?;
    let _ = Cmd::new(&netsh).args(netsh_delete_args()).run().map_err(|e| e.to_string())?; // exit 1 = no such rule
    let o = Cmd::new(&netsh).args(netsh_add_args(ports)).run().map_err(|e| e.to_string())?;
    if !o.success() {
        return Err(format!("netsh add rule failed ({}): {}", o.code, o.text().trim()));
    }
    Ok(())
}

pub fn remove_rule() -> Result<(), String> {
    let o = Cmd::new(netsh()?).args(netsh_delete_args()).run().map_err(|e| e.to_string())?;
    if o.success() || o.code == 1 {
        Ok(())
    } else {
        Err(format!("netsh delete rule failed ({}): {}", o.code, o.text().trim()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawProfile {
    interface_index: u32,
    interface_alias: String,
    network_category: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Public,
    Private,
    Domain,
}

impl Category {
    pub fn name(self) -> &'static str {
        match self {
            Category::Public => "Public",
            Category::Private => "Private",
            Category::Domain => "DomainAuthenticated",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub interface_index: u32,
    pub alias: String,
    pub category: Category,
}

pub const GET_PROFILES_SCRIPT: &str = r"NetConnection\Get-NetConnectionProfile | % { [pscustomobject]@{InterfaceIndex=[int]$_.InterfaceIndex;InterfaceAlias=[string]$_.InterfaceAlias;NetworkCategory=[int]$_.NetworkCategory} } | ConvertTo-Json -Compress";

/// Windows PowerShell 5.1 prints one object (not an array) when there is one profile. The query
/// casts the category to a number; a string (PowerShell 7) is still accepted.
pub fn parse_profiles(json: &str) -> Result<Vec<Profile>, String> {
    let t = json.trim().trim_start_matches('\u{feff}');
    if t.is_empty() {
        return Ok(vec![]);
    }
    let v: Value = serde_json::from_str(t).map_err(|e| format!("cannot read the network profiles: {e}"))?;
    let items = match v {
        Value::Array(a) => a,
        one => vec![one],
    };
    items
        .into_iter()
        .map(|item| {
            let raw: RawProfile = serde_json::from_value(item).map_err(|e| format!("unexpected network profile shape: {e}"))?;
            let category = match &raw.network_category {
                Value::Number(n) if n.as_u64() == Some(0) => Category::Public,
                Value::Number(n) if n.as_u64() == Some(1) => Category::Private,
                Value::Number(n) if n.as_u64() == Some(2) => Category::Domain,
                Value::String(s) if s.eq_ignore_ascii_case("Public") => Category::Public,
                Value::String(s) if s.eq_ignore_ascii_case("Private") => Category::Private,
                Value::String(s) if s.starts_with("Domain") => Category::Domain,
                other => return Err(format!("unknown network category {other}")),
            };
            Ok(Profile { interface_index: raw.interface_index, alias: raw.interface_alias, category })
        })
        .collect()
}

pub fn read_profiles() -> Result<Vec<Profile>, String> {
    let o = Cmd::new(powershell()?).args(["-NoProfile", "-NonInteractive", "-Command", GET_PROFILES_SCRIPT]).timeout(Duration::from_secs(60)).run().map_err(|e| e.to_string())?;
    if !o.success() {
        return Err(format!("Get-NetConnectionProfile failed ({}): {}", o.code, o.stderr.trim()));
    }
    parse_profiles(&o.stdout)
}

/// True when at least one connected network is Public (the provisioner prompt and the
/// `NETWORK_PROFILE_PUBLIC` alert key off this).
pub fn any_public(p: &[Profile]) -> bool {
    p.iter().any(|x| x.category == Category::Public)
}

pub fn set_private_script(interface_index: u32) -> String {
    format!(r"NetConnection\Set-NetConnectionProfile -InterfaceIndex {interface_index} -NetworkCategory Private")
}

/// What the owner confirmed with `--confirm-private-network[=<alias>...]`. Task 6 maps the CLI
/// flag onto this (bare flag -> `Bare`, values -> `Aliases`); this module only consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confirmation {
    /// Bare flag: allowed only when exactly one network is Public.
    Bare,
    /// Exactly the named (Public) networks, matched by alias, case-insensitive.
    Aliases(Vec<String>),
}

/// The interface indices to mark Private. Only Public networks qualify. With several Public
/// networks (a guest Wi-Fi next to the shop LAN) a bare confirmation is refused and each network
/// must be named: "local subnet" on a guest Wi-Fi includes customers' phones.
pub fn choose_targets(profiles: &[Profile], c: &Confirmation) -> Result<Vec<u32>, String> {
    let public: Vec<&Profile> = profiles.iter().filter(|p| p.category == Category::Public).collect();
    match c {
        Confirmation::Bare if public.len() <= 1 => Ok(public.iter().map(|p| p.interface_index).collect()),
        Confirmation::Bare => Err(format!(
            "{} networks are Public ({}); name the shop network: --confirm-private-network=<name>",
            public.len(),
            public.iter().map(|p| p.alias.as_str()).collect::<Vec<_>>().join(", ")
        )),
        Confirmation::Aliases(names) => names
            .iter()
            .map(|n| public.iter().find(|p| p.alias.eq_ignore_ascii_case(n)).map(|p| p.interface_index).ok_or_else(|| format!("'{n}' is not a Public network")))
            .collect(),
    }
}

/// Re-reads the profiles and marks Private only the networks the owner confirmed that are still
/// Public. Returns the aliases changed.
pub fn fix_profiles(confirmation: &Confirmation) -> Result<Vec<String>, String> {
    let ps = powershell()?;
    let profiles = read_profiles()?;
    let mut fixed = Vec::new();
    for idx in choose_targets(&profiles, confirmation)? {
        let alias = profiles.iter().find(|p| p.interface_index == idx).map(|p| p.alias.clone()).unwrap_or_default();
        let o = Cmd::new(&ps)
            .args(["-NoProfile", "-NonInteractive", "-Command", &set_private_script(idx)])
            .timeout(Duration::from_secs(60))
            .run()
            .map_err(|e| e.to_string())?;
        if !o.success() {
            return Err(format!("Set-NetConnectionProfile failed for '{alias}' ({}): {}", o.code, o.stderr.trim()));
        }
        fixed.push(alias);
    }
    Ok(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rule_args_are_scoped_and_have_no_program() {
        let a = netsh_add_args(&Ports { base: 47300 });
        assert_eq!(
            a,
            [
                "advfirewall", "firewall", "add", "rule", "name=Supermarket POS Store Server (LAN)", "dir=in", "action=allow", "protocol=TCP",
                "localport=47304", "profile=private,domain", "remoteip=localsubnet"
            ]
        );
        assert!(a.iter().all(|x| !x.starts_with("program=") && !x.to_lowercase().contains("public")));
        assert_eq!(netsh_delete_args()[3], "rule");
        assert_eq!(netsh_delete_args()[4], "name=Supermarket POS Store Server (LAN)");
    }

    /// A rule as Windows PowerShell 5.1 prints it, with selected fields replaced by raw JSON.
    fn rule_json(over: &[(&str, &str)]) -> String {
        let base = [
            ("En", "1"),
            ("Dir", "1"),
            ("Act", "2"),
            ("Prof", "3"),
            ("Edge", "0"),
            ("Proto", r#""TCP""#),
            ("LPort", r#"["47304"]"#),
            ("RAddr", r#"["LocalSubnet"]"#),
            ("Prog", r#""Any""#),
            ("Svc", r#""Any""#),
        ];
        let body: Vec<String> = base.iter().map(|(k, v)| format!("\"{k}\":{}", over.iter().find(|o| o.0 == *k).map_or(*v, |o| o.1))).collect();
        format!("{{{}}}", body.join(","))
    }

    fn ok_with(over: &[(&str, &str)]) -> bool {
        rule_ok(&parse_rules(&rule_json(over)).unwrap(), &Ports { base: 47300 })
    }

    #[test]
    fn the_read_script_is_one_module_qualified_5_1_call() {
        let s = read_rule_script();
        assert!(s.contains("-DisplayName 'Supermarket POS Store Server (LAN)'") && s.contains("-PolicyStore PersistentStore"));
        assert!(!s.contains("-AsArray") && s.contains(r"NetSecurity\Get-NetFirewallServiceFilter") && s.ends_with("ConvertTo-Json -Compress"));
        assert!(GET_PROFILES_SCRIPT.contains("[int]$_.NetworkCategory") && GET_PROFILES_SCRIPT.starts_with(r"NetConnection\"));
    }

    #[test]
    fn the_right_rule_is_ok_and_every_deviation_is_not() {
        assert!(ok_with(&[]));
        assert!(!ok_with(&[("LPort", r#"["47305"]"#)]), "wrong port");
        assert!(!ok_with(&[("LPort", r#"["47304","80"]"#)]), "extra port");
        assert!(!ok_with(&[("Prof", "0")]), "Any includes Public");
        assert!(!ok_with(&[("Prof", "7")]), "Public included");
        assert!(!ok_with(&[("Prof", "2")]), "Domain missing");
        assert!(!ok_with(&[("En", "0")]));
        assert!(!ok_with(&[("Dir", "2")]));
        assert!(!ok_with(&[("Act", "4")]));
        assert!(!ok_with(&[("Edge", "1")]), "edge traversal");
        assert!(!ok_with(&[("Proto", r#""UDP""#)]));
        assert!(!ok_with(&[("RAddr", r#"["Any"]"#)]));
        assert!(!ok_with(&[("RAddr", r#"["LocalSubnet","10.0.0.0/8"]"#)]));
        assert!(!ok_with(&[("Prog", r#""C:\\x.exe""#)]), "program set");
        assert!(!ok_with(&[("Svc", r#""Spooler""#)]), "service set");
        let p = Ports { base: 47300 };
        assert!(!rule_ok(&parse_rules(&format!("[{0},{0}]", rule_json(&[]))).unwrap(), &p), "two rules");
        assert!(!rule_ok(&parse_rules(&format!("[{},{}]", rule_json(&[]), rule_json(&[("Prof", "0")]))).unwrap(), &p));
        assert!(!rule_ok(&parse_rules(&rule_json(&[])).unwrap(), &Ports { base: 47400 }), "different base port");
    }

    #[test]
    fn rules_parse_from_a_single_object_an_array_a_scalar_port_and_nothing() {
        let p = Ports { base: 47300 };
        let one = parse_rules(&rule_json(&[("LPort", r#""47304""#), ("RAddr", r#""LocalSubnet""#)])).unwrap();
        assert!(one.len() == 1 && rule_ok(&one, &p));
        assert_eq!(parse_rules(&format!("[{}]", rule_json(&[]))).unwrap().len(), 1);
        assert_eq!(parse_rules("").unwrap(), vec![]);
        assert!(!rule_ok(&[], &p), "missing rule");
        assert!(parse_rules("nope").is_err());
        assert!(parse_rules(r#"{"En":1}"#).is_err());
    }

    #[test]
    fn profiles_parse_from_ps5_and_ps7_shapes() {
        let one_ps5 = r#"{"InterfaceIndex":12,"InterfaceAlias":"Ethernet","NetworkCategory":0}"#;
        let p = parse_profiles(one_ps5).unwrap();
        assert_eq!(p, vec![Profile { interface_index: 12, alias: "Ethernet".into(), category: Category::Public }]);
        let many_ps7 = r#"[{"InterfaceIndex":3,"InterfaceAlias":"Wi-Fi","NetworkCategory":"Private"},{"InterfaceIndex":9,"InterfaceAlias":"Corp","NetworkCategory":"DomainAuthenticated"}]"#;
        let p = parse_profiles(many_ps7).unwrap();
        assert_eq!((p[0].category, p[1].category), (Category::Private, Category::Domain));
        assert!(!any_public(&p));
        assert!(any_public(&parse_profiles(one_ps5).unwrap()));
        assert_eq!(parse_profiles("").unwrap(), vec![]);
        assert!(parse_profiles("not json").is_err());
        assert!(parse_profiles(r#"{"InterfaceIndex":1,"InterfaceAlias":"x","NetworkCategory":7}"#).is_err());
    }

    #[test]
    fn the_fix_script_names_one_interface_and_only_ever_sets_private() {
        let s = set_private_script(12);
        assert_eq!(s, r"NetConnection\Set-NetConnectionProfile -InterfaceIndex 12 -NetworkCategory Private");
        assert!(!s.contains("Public"));
    }

    fn prof(i: u32, alias: &str, category: Category) -> Profile {
        Profile { interface_index: i, alias: alias.into(), category }
    }

    #[test]
    fn a_bare_confirmation_covers_one_public_network_only() {
        let shop = prof(3, "Ethernet", Category::Public);
        let guest = prof(9, "Guest Wi-Fi", Category::Public);
        let lan = prof(4, "Office", Category::Private);
        assert_eq!(choose_targets(&[shop.clone(), lan.clone()], &Confirmation::Bare).unwrap(), vec![3]);
        assert_eq!(choose_targets(std::slice::from_ref(&lan), &Confirmation::Bare).unwrap(), Vec::<u32>::new());
        assert!(choose_targets(&[shop.clone(), guest.clone()], &Confirmation::Bare).is_err());
        let named = Confirmation::Aliases(vec!["ethernet".into()]);
        assert_eq!(choose_targets(&[shop.clone(), guest], &named).unwrap(), vec![3], "the guest network stays Public");
        assert!(choose_targets(&[shop.clone(), lan], &Confirmation::Aliases(vec!["Office".into()])).is_err(), "not Public any more");
        assert!(choose_targets(&[shop], &Confirmation::Aliases(vec!["Nope".into()])).is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "host read-only check; sandbox scenario 21 runs ignored tests"]
    fn this_machines_real_profiles_can_be_read_without_elevation() {
        // Read-only: real Windows PowerShell 5.1 output through the real parser (no assertion on the category).
        let profiles = read_profiles().expect("Get-NetConnectionProfile must run and parse");
        for p in &profiles {
            assert!(!p.alias.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "host read-only check; sandbox scenario 21 runs ignored tests"]
    fn the_real_rule_query_runs_and_parses_without_elevation() {
        // Read-only query through the real Windows PowerShell 5.1 and the real parser. Only one rule
        // of this name may exist; on a machine without it the answer is "no rule", never ok.
        let rules = read_rule().expect("Get-NetFirewallRule must run and parse");
        assert!(rules.len() <= 1);
    }
}
