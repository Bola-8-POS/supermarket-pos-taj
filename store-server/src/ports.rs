//! Port plan (conventions section 3): every listener derives from one base, default 47300, in
//! blocks of ten below Windows' ephemeral range. Test instances use `47400 + 10 * slot`.
//! It must never plan a port outside the store's block, or hand one out that Windows reserves.

use crate::sys;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

pub const DEFAULT_BASE: u16 = 47300;
pub const EPHEMERAL_START: u16 = 49152;
pub const DEV_BASE: u16 = 47400;
pub const DEV_SLOTS: u8 = 10;
/// The black-box gateway contract fixture's base (`dev render-gateway`): blocks 47980-47989.
pub const CONTRACT_BASE: u16 = 47980;

/// A production `--base-port` may not take a block that test instances or the contract fixture use.
pub fn check_production_base(base: u16) -> Result<(), String> {
    let dev = DEV_BASE..DEV_BASE + 10 * u16::from(DEV_SLOTS);
    let contract = CONTRACT_BASE..CONTRACT_BASE + 10;
    let (lo, hi) = (base, base.saturating_add(9));
    for (name, r) in [("test instances", dev), ("the gateway contract fixture", contract)] {
        if lo < r.end && hi >= r.start {
            return Err(format!("base port {base}: the block {lo}-{hi} overlaps the ports of {name} ({}-{}); choose another", r.start, r.end - 1));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ports {
    pub base: u16,
}

impl Ports {
    pub fn new(base: u16) -> Result<Self, String> {
        validate_base(base)?;
        Ok(Ports { base })
    }
    pub fn pg(&self) -> u16 { self.base }
    pub fn gotrue(&self) -> u16 { self.base + 1 }
    pub fn rest(&self) -> u16 { self.base + 2 }
    pub fn functions(&self) -> u16 { self.base + 3 }
    pub fn gateway_lan(&self) -> u16 { self.base + 4 }
    pub fn gateway_internal(&self) -> u16 { self.base + 5 }
    pub fn rest_admin(&self) -> u16 { self.base + 6 }
    /// Loopback probe that only the maintenance gateway config serves (`GET /_mode` -> `maintenance`).
    pub fn mode_probe(&self) -> u16 { self.base + 8 }
    pub fn block(&self) -> std::ops::RangeInclusive<u16> { self.base..=self.base + 9 }
}

/// The base must be a multiple of ten whose whole block sits below the ephemeral range.
pub fn validate_base(base: u16) -> Result<(), String> {
    if base < 10_000 || !base.is_multiple_of(10) {
        return Err(format!("base port {base} must be a multiple of 10 and at least 10000"));
    }
    if u32::from(base) + 9 >= u32::from(EPHEMERAL_START) {
        return Err(format!(
            "base port {base}: the block {base}-{} reaches Windows' ephemeral range ({EPHEMERAL_START} and up)",
            u32::from(base) + 9
        ));
    }
    Ok(())
}

pub fn dev_base(slot: u8) -> Result<u16, String> {
    if slot >= DEV_SLOTS {
        return Err(format!("slot {slot} is out of range 0-{}", DEV_SLOTS - 1));
    }
    Ok(DEV_BASE + 10 * u16::from(slot))
}

/// Parse `netsh int ipv4 show excludedportrange protocol=tcp`.
pub fn parse_excluded_ranges(netsh_output: &str) -> Vec<(u16, u16)> {
    netsh_output
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let a = it.next()?.parse::<u16>().ok()?;
            let b = it.next()?.parse::<u16>().ok()?;
            // an optional trailing `*` marks an administered exclusion
            match it.next() {
                None | Some("*") => Some((a, b)),
                _ => None,
            }
        })
        .collect()
}

/// The first excluded range that overlaps the base's block, if any.
pub fn excluded_overlap(ports: &Ports, excluded: &[(u16, u16)]) -> Option<(u16, u16)> {
    let (lo, hi) = (*ports.block().start(), *ports.block().end());
    excluded.iter().copied().find(|&(a, b)| a <= hi && b >= lo)
}

/// Ports of the block that something is already listening on. The TCP listener table is the
/// source (any local address counts: a wildcard listener collides with the LAN listener, a loopback
/// one with the loopback listeners). posctl never binds a non-loopback address: a wildcard listen
/// by a program with no firewall rule raises the Windows Defender "allow access" dialog. Only if the
/// table cannot be read does it fall back to a loopback-only bind probe.
pub fn busy_ports(ports: &Ports) -> Vec<u16> {
    busy_ports_with(ports, sys::listening_tcp_ports, |a| TcpListener::bind(a).is_err())
}

fn busy_ports_with(ports: &Ports, table: impl FnOnce() -> Result<Vec<u16>, String>, mut bind_fails: impl FnMut(SocketAddrV4) -> bool) -> Vec<u16> {
    match table() {
        Ok(listening) => ports.block().filter(|p| listening.contains(p)).collect(),
        // ponytail: loopback-only fallback cannot see a LAN-only wildcard listener; the table path is the real check
        Err(_) => ports.block().filter(|p| bind_fails(SocketAddrV4::new(Ipv4Addr::LOCALHOST, *p))).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_match_the_conventions_table() {
        let p = Ports::new(47300).unwrap();
        assert_eq!(
            (p.pg(), p.gotrue(), p.rest(), p.functions(), p.gateway_lan(), p.gateway_internal(), p.rest_admin()),
            (47300, 47301, 47302, 47303, 47304, 47305, 47306)
        );
        assert_eq!(*p.block().end(), 47309);
        assert_eq!(p.mode_probe(), 47308);
    }

    #[test]
    fn base_validation() {
        assert!(validate_base(47300).is_ok());
        assert!(validate_base(47305).is_err());
        assert!(validate_base(9990).is_err());
        assert!(validate_base(49150).is_err());
        assert!(validate_base(49140).is_ok());
        assert!(Ports::new(65530).is_err());
    }

    #[test]
    fn dev_slots_map_to_blocks_of_ten() {
        assert_eq!(dev_base(0).unwrap(), 47400);
        assert_eq!(dev_base(9).unwrap(), 47490);
        assert!(dev_base(10).is_err());
    }

    #[test]
    fn a_production_base_port_refuses_the_test_instance_and_contract_blocks() {
        for b in [47400, 47410, 47490, 47980] {
            assert!(check_production_base(b).is_err(), "{b}");
        }
        for b in [47300, 47390, 47500, 47970, 47990, 48000] {
            assert!(check_production_base(b).is_ok(), "{b}");
        }
    }

    #[test]
    fn netsh_excluded_ranges_parse_and_overlap() {
        let out = "\nProtocol tcp Port Exclusion Ranges\n\nStart Port    End Port\n----------    --------\n      1234        1333\n     47295       47304     *\n     50000       50059\n\n* - Administered port exclusions.\n";
        let ranges = parse_excluded_ranges(out);
        assert_eq!(ranges, vec![(1234, 1333), (47295, 47304), (50000, 50059)]);
        let p = Ports::new(47300).unwrap();
        assert_eq!(excluded_overlap(&p, &ranges), Some((47295, 47304)));
        assert_eq!(excluded_overlap(&Ports::new(47400).unwrap(), &ranges), None);
    }

    #[test]
    fn a_listening_port_is_reported_busy() {
        let base = 47990; // outside every block the product or the test slots use
        let free = Ports { base };
        let _held = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, base + 2)).unwrap();
        assert_eq!(busy_ports(&free), vec![base + 2]);
    }

    #[test]
    fn the_bind_fallback_only_ever_binds_loopback() {
        let mut seen = Vec::new();
        let busy = busy_ports_with(&Ports { base: 47980 }, || Err("no table".into()), |a| {
            seen.push(*a.ip());
            false
        });
        assert!(busy.is_empty());
        assert_eq!(seen.len(), 10);
        assert!(seen.iter().all(|ip| ip.is_loopback()), "non-loopback bind probed: {seen:?}");
    }

    #[test]
    fn the_table_path_never_binds() {
        let busy = busy_ports_with(&Ports { base: 47980 }, || Ok(vec![47982, 50000]), |_| panic!("bound despite a readable table"));
        assert_eq!(busy, vec![47982]);
    }

    #[cfg(windows)]
    #[test]
    fn the_real_listener_table_reports_a_loopback_listener() {
        let held = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let listening = sys::listening_tcp_ports().unwrap();
        assert!(listening.contains(&port), "{port} missing from {listening:?}");
        let base = port - port % 10;
        assert!(busy_ports(&Ports { base }).contains(&port));
    }
}
