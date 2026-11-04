//! `posctl pair create | fetch | join | prune` (two-mode Plan 06 Task 8).
//!
//! `pairing::store_env_text` is the ONLY text of `client\store.env`; `server_self_pair` (the server PC pairing with itself,
//! called by provision in Task 9) and `pair join` (a till) both write it through `pairing::join::join`.
//! `pair fetch` downloads an offer without trusting the server and installs nothing; `pair join` verifies everything before
//! it touches the certificate store (see `pairing::join`). Under `--dev` the machine's certificate store is never called.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration as StdDuration, Instant};

use clap::Subcommand;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::acl::{self, Grant, Inherit};
use crate::config::PosctlJson;
use crate::envelope::{Code, Outcome, PosctlError};
use crate::exec::Cmd;
use crate::pairing::join::{join, leave, verify, Confirm, JoinError, JoinInput};
use crate::pairing::{fingerprint16, group4, is_offer_code, new_offer_code, parse_record, sweep_expired_offers, validate_record, PairError, PairingRecord};
use crate::paths::Roots;
use crate::pki::trust::CertutilStore;
use crate::pki::{self, san::validate_site_host};
use crate::{sys, util};

/// Flattened into `cli::Command`, so the words are `posctl pair ...`.
#[derive(Subcommand, Debug)]
pub enum PairTop {
    /// Till pairing: a record of the store's address and root certificate that a till verifies before trusting it.
    #[command(subcommand)]
    Pair(PairCmd),
}

#[derive(Subcommand, Debug)]
pub enum PairCmd {
    /// Write a pairing file (and, with --lan, a short-lived offer the tills can fetch over the shop network).
    Create {
        #[arg(long, default_value = "10m")]
        ttl: String,
        #[arg(long)]
        lan: bool,
    },
    /// On a till: download a LAN offer WITHOUT trusting the server. Installs nothing.
    Fetch {
        #[arg(long)]
        host: String,
        #[arg(long)]
        port: u16,
        #[arg(long)]
        code: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// On a till (elevated): verify a pairing file, trust its root, write store.env.
    Join {
        #[arg(long)]
        file: PathBuf,
        /// The 16 characters shown on the server screen (dashes optional). Required for a file that came over the LAN.
        #[arg(long)]
        confirm_fingerprint: Option<String>,
        /// The file reached this PC on a channel the owner trusts (a USB stick).
        #[arg(long)]
        trust_file: bool,
    },
    /// On a till (elevated): stop using the store. Removes the root certificate this till trusted for it and `store.env`.
    Leave,
    /// Delete expired LAN offers.
    Prune,
}

fn usage(m: impl Into<String>) -> PosctlError {
    PosctlError::new(Code::Usage, m)
}

fn pair_failed(m: impl Into<String>) -> PosctlError {
    PosctlError::new(Code::PairFailed, m)
}

fn pair_error(e: PairError) -> PosctlError {
    match e {
        PairError::FingerprintMismatch => PosctlError::new(Code::PairFingerprintMismatch, e.to_string()),
        other => pair_failed(other.to_string()),
    }
}

fn join_error(e: JoinError) -> PosctlError {
    match e {
        JoinError::Mismatch(m) => PosctlError::new(Code::PairFingerprintMismatch, m),
        JoinError::Failed(m) => pair_failed(m),
    }
}

/// `30s`, `10m`, `2h`; between 1 minute and 60 minutes.
pub fn parse_ttl(text: &str) -> Result<Duration, PosctlError> {
    let t = text.trim();
    let (num, unit) = t.split_at(t.len().saturating_sub(1));
    let bad = || usage(format!("--ttl {text:?}: use 90s, 10m or 1h"));
    let n: i64 = num.parse().map_err(|_| bad())?;
    let d = match unit {
        "s" => Duration::seconds(n),
        "m" => Duration::minutes(n),
        "h" => Duration::hours(n),
        _ => return Err(bad()),
    };
    if d < Duration::minutes(1) || d > Duration::minutes(60) {
        return Err(usage("--ttl must be between 1 minute and 60 minutes"));
    }
    Ok(d)
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn iso(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn read_json(path: &Path) -> Result<Value, PosctlError> {
    let text = fs::read_to_string(path).map_err(|e| PosctlError::precondition(format!("{}: {e}", path.display())))?;
    serde_json::from_str(&text).map_err(|e| PosctlError::error(format!("{}: {e}", path.display())))
}

/// The record a till needs, from what the server already wrote. `allow_loopback` is true only under `--dev`: a throwaway
/// instance has no shop-network name, so its record names 127.0.0.1.
pub fn build_record(roots: &Roots, issued_at: &str, expires_at: Option<String>, allow_loopback: bool) -> Result<PairingRecord, PosctlError> {
    let gateway = read_json(&roots.state().join("gateway.json"))?;
    if gateway["tls"].as_str() != Some("internal") {
        return Err(PosctlError::precondition("this store does not serve TLS yet (state\\gateway.json), so there is nothing to pair with"));
    }
    let hosts: Vec<String> = gateway["hosts"].as_array().map(|a| a.iter().filter_map(|h| h.as_str().map(String::from)).collect()).unwrap_or_default();
    let port = gateway["extPort"].as_u64().and_then(|p| u16::try_from(p).ok()).ok_or_else(|| PosctlError::precondition("state\\gateway.json has no extPort"))?;
    let shop_hosts: Vec<&String> = hosts.iter().filter(|h| h.as_str() != "localhost" && h.as_str() != "127.0.0.1").collect();
    // the configured name wins only when the certificates cover it
    let configured = PosctlJson::load(roots).ok().flatten().map(|c| c.server.host).and_then(|h| validate_site_host(&h).ok()).filter(|h| crate::pairing::check_shop_host(h).is_ok() && hosts.contains(h));
    let server_host = configured
        .or_else(|| shop_hosts.first().map(|h| (*h).clone()))
        .or_else(|| if allow_loopback && hosts.iter().any(|h| h == "127.0.0.1") { Some("127.0.0.1".to_string()) } else { None })
        .ok_or_else(|| PosctlError::precondition("no shop-network host name is configured for this server"))?;
    let alt_hosts: Vec<String> = shop_hosts.into_iter().filter(|h| **h != server_host).cloned().collect();
    let keys = read_json(&roots.secrets().join("keys.json"))?;
    let anon_key = keys["anon"].as_str().ok_or_else(|| PosctlError::precondition("secrets\\keys.json has no anon key"))?.to_string();
    let root = pki::read_root(&roots.data).map_err(PosctlError::precondition)?;
    Ok(PairingRecord {
        v: 1,
        mode: "offline-only".into(),
        server_host,
        server_port: port,
        alt_hosts,
        anon_key,
        root_cert_pem: root.pem,
        root_sha256: root.sha256,
        issued_at: issued_at.to_string(),
        expires_at,
    })
}

fn write_text(path: &Path, text: &str) -> Result<(), PosctlError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| PosctlError::error(format!("{}: {e}", parent.display())))?;
    }
    util::write_atomic(path, text.as_bytes()).map_err(|e| PosctlError::error(format!("{}: {e}", path.display())))
}

/// `curl.exe` arguments for fetching an offer. `-k` is deliberate: the till has no reason to trust the server yet, and the
/// person comparing the 16-character fingerprint on both screens is the integrity check. https only, a small body only.
pub fn curl_fetch_args(host: &str, port: u16, code: &str) -> Vec<String> {
    ["-q", "-sS", "-k", "--fail", "--proto", "=https", "--max-filesize", "65536", "--max-time", "10"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(format!("https://{host}:{port}/_store/pair/{code}")))
        .collect()
}

/// A pairing file is a few KB; refuse anything over 64 KiB before reading it whole.
fn read_capped(file: &Path) -> Result<String, PosctlError> {
    let len = fs::metadata(file).map_err(|e| pair_failed(format!("{}: {e}", file.display())))?.len();
    if len > 65_536 {
        return Err(pair_failed(format!("{} is too large to be a pairing file", file.display())));
    }
    fs::read_to_string(file).map_err(|e| pair_failed(format!("{}: {e}", file.display())))
}

fn require_admin(roots: &Roots) -> Result<(), PosctlError> {
    if !roots.dev && !sys::is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "this command must run as an administrator"));
    }
    Ok(())
}

/// A folder that already exists must be owned by Administrators or SYSTEM: the app ignores a `store.env` under one a standard
/// user owns (Task 10), and that user could rename `client\` away. Never taken over silently: the operator deletes it first.
/// `owner_of` is the seam (the real one reads the OS owner).
fn check_owners(roots: &Roots, owner_of: &dyn Fn(&Path) -> Result<String, String>) -> Result<(), PosctlError> {
    for dir in [roots.data.clone(), roots.client()] {
        if !dir.exists() {
            continue;
        }
        let owner = owner_of(&dir).map_err(|e| PosctlError::precondition(format!("cannot read the owner of {}: {e}", dir.display())))?;
        if owner != acl::SID_ADMINISTRATORS && owner != acl::SID_SYSTEM {
            return Err(PosctlError::precondition(format!(
                "{} exists and is owned by {owner}, not Administrators; delete the folder (as an administrator) and pair again",
                dir.display()
            )));
        }
    }
    Ok(())
}

/// A till's `client\` and `client\pki\`: SYSTEM and Administrators full, Users read-only, Administrators the owner, the DACL
/// protected (`acl::apply_one` sets owner and DACL in one call and reads them back). `src-tauri` ignores a `store.env`
/// that sits under a folder a standard user owns, and a user must not be able to replace the root certificate file.
/// Not applied on a provisioned store server: its `client\` already carries the plan's ACL, which adds the Gateway.
fn protect_till_client_dir(roots: &Roots) -> Result<(), PosctlError> {
    if roots.dev || roots.provisioned_json().exists() {
        return Ok(());
    }
    check_owners(roots, &|p| sys::path_owner_sid(p))?;
    let grants = [
        Grant::new(acl::SID_SYSTEM, "F", Inherit::ObjectContainer),
        Grant::new(acl::SID_ADMINISTRATORS, "F", Inherit::ObjectContainer),
        Grant::new(acl::SID_USERS, "RX", Inherit::ObjectContainer),
    ];
    for dir in [roots.client(), roots.client().join("pki")] {
        fs::create_dir_all(&dir).map_err(|e| PosctlError::error(format!("{}: {e}", dir.display())))?;
        acl::apply_one(&dir, &grants).map_err(|e| PosctlError::error(format!("could not protect the client folder: {e}")))?;
    }
    Ok(())
}

fn join_output(out: &crate::pairing::join::JoinOutput) -> Value {
    json!({
        "previousRootSha256": out.previous_root,
        "previousRoot": out.previous_root_outcome,
        "serverUrl": out.server_url,
        "rootSha256": out.root_sha256,
        "fingerprint": out.fingerprint16,
        "fingerprintDisplay": group4(&out.fingerprint16),
        "trustInstalled": out.trust_installed,
        "storeEnv": out.store_env,
    })
}

/// The server PC trusts its own store CA exactly as a till does (conventions 8.3) and gets its own `client\store.env`.
/// Provision calls this once the Gateway is healthy (Caddy issues its root asynchronously, so it waits up to `wait` for
/// `root.crt`). Elevated when `install_trust` is true; provision passes `!roots.dev`.
pub fn server_self_pair(roots: &Roots, install_trust: bool, wait: StdDuration) -> Result<Value, PosctlError> {
    if install_trust && !sys::is_elevated() {
        return Err(PosctlError::new(Code::NotElevated, "trusting the store certificate must run as an administrator"));
    }
    let deadline = Instant::now() + wait;
    while !pki::root_path(&roots.data).exists() && Instant::now() < deadline {
        std::thread::sleep(StdDuration::from_millis(250));
    }
    let issued = now();
    let record = build_record(roots, &iso(issued), None, roots.dev)?;
    let text = serde_json::to_string(&record).map_err(|e| PosctlError::error(e.to_string()))?;
    let client = roots.client();
    fs::create_dir_all(client.join("pki")).map_err(|e| PosctlError::error(e.to_string()))?;
    let input = JoinInput { record_json: &text, confirm: Confirm::TrustFile, client_dir: &client, now_unix: issued.unix_timestamp(), paired_at: &iso(issued), install_trust };
    let out = join(&input, &CertutilStore).map_err(join_error)?;
    Ok(join_output(&out))
}

pub fn run(roots: &Roots, cmd: &PairCmd) -> Result<Outcome, PosctlError> {
    let offers = roots.pairing_offers();
    match cmd {
        PairCmd::Create { ttl, lan } => {
            require_admin(roots)?;
            let ttl = parse_ttl(ttl)?;
            let swept = sweep_expired_offers(&offers, now().unix_timestamp());
            let issued = now();
            let expires = if *lan { Some(iso(issued + ttl)) } else { None };
            // the USB file never carries an expiry (a file with one came over the network and needs the typed fingerprint);
            // only the LAN offer does
            let record = build_record(roots, &iso(issued), None, roots.dev)?;
            let text = serde_json::to_string_pretty(&record).map_err(|e| PosctlError::error(e.to_string()))?;
            let file = roots.client().join("pairing").join(format!("pair-{}.pospair", issued.unix_timestamp()));
            write_text(&file, &text)?;
            let mut code = Value::Null;
            if *lan {
                let offer = PairingRecord { expires_at: expires.clone(), ..record.clone() };
                let offer_text = serde_json::to_string_pretty(&offer).map_err(|e| PosctlError::error(e.to_string()))?;
                let c = new_offer_code().map_err(|e| PosctlError::error(e.to_string()))?;
                write_text(&offers.join(format!("{c}.pospair")), &offer_text)?;
                code = Value::String(c);
            }
            let fp = fingerprint16(&record.root_sha256);
            Ok(Outcome::ok(
                "pairing file written",
                json!({
                    "file": file,
                    "serverHost": record.server_host,
                    "serverPort": record.server_port,
                    "rootSha256": record.root_sha256,
                    "fingerprint": fp,
                    "fingerprintDisplay": group4(&fp),
                    "code": code,
                    "expiresAt": expires,
                    "sweptOffers": swept,
                }),
            ))
        }
        PairCmd::Fetch { host, port, code, out } => {
            let host = validate_site_host(host).map_err(|e| usage(e.to_string()))?;
            if roots.dev && host != "127.0.0.1" && host != "localhost" {
                return Err(usage("under --dev only a loopback host may be fetched from"));
            }
            if !is_offer_code(code) {
                return Err(usage("--code is 8 characters from A-Z and 2-7"));
            }
            let curl = sys::system_dir().map_err(PosctlError::precondition)?.join("curl.exe");
            let output = Cmd::new(curl).args(curl_fetch_args(&host, *port, code)).timeout(StdDuration::from_secs(15)).run();
            let output = match output {
                Ok(o) if o.success() => o,
                Ok(_) => return Err(pair_failed("the server did not return a pairing offer (wrong code, expired, or unreachable)")),
                Err(e) => return Err(pair_failed(format!("curl.exe could not run: {e}"))),
            };
            let record = parse_record(&output.stdout).map_err(pair_error)?;
            let valid = validate_record(&record, now().unix_timestamp()).map_err(pair_error)?;
            if record.expires_at.is_none() {
                return Err(pair_failed("the server answered with something that is not a pairing offer (no expiry)"));
            }
            write_text(out, &output.stdout)?;
            let fp = fingerprint16(&valid.sha256);
            Ok(Outcome::ok(
                "pairing offer downloaded; nothing is trusted yet",
                json!({
                    "file": out,
                    "serverHost": record.server_host,
                    "fingerprint": fp,
                    "fingerprintDisplay": group4(&fp),
                    "rootSha256": valid.sha256,
                    "note": "Compare the fingerprint with the one on the server screen, then run pair join --confirm-fingerprint.",
                }),
            ))
        }
        PairCmd::Join { file, confirm_fingerprint, trust_file } => {
            let confirm = match (confirm_fingerprint, trust_file) {
                (Some(f), false) => Confirm::Fingerprint(f.clone()),
                (None, true) => Confirm::TrustFile,
                _ => return Err(usage("give exactly one of --confirm-fingerprint <16 characters> or --trust-file")),
            };
            require_admin(roots)?;
            let text = read_capped(file)?;
            let client = roots.client();
            let input = JoinInput { record_json: &text, confirm, client_dir: &client, now_unix: now().unix_timestamp(), paired_at: &iso(now()), install_trust: !roots.dev };
            // nothing is created, protected or installed until the record and the fingerprint have passed
            verify(&input).map_err(join_error)?;
            protect_till_client_dir(roots)?;
            let out = join(&input, &CertutilStore).map_err(join_error)?;
            let failed = out.previous_root_outcome.as_deref().is_some_and(|o| o.starts_with("failed"));
            let message = if failed { "till paired; the previous store's root certificate could NOT be removed (see previousRoot)" } else { "till paired" };
            Ok(Outcome::ok(message, join_output(&out)))
        }
        PairCmd::Leave => {
            require_admin(roots)?;
            // a store server pairs with itself during provision and unprovision undoes that; leaving would strand its own app
            if !roots.dev && roots.provisioned_json().exists() {
                return Err(PosctlError::precondition("this PC runs the store server; use unprovision, not pair leave"));
            }
            if !roots.dev {
                check_owners(roots, &|p| sys::path_owner_sid(p))?;
            }
            let out = leave(&roots.client(), !roots.dev, &CertutilStore).map_err(join_error)?;
            let message = if out.was_paired { "till left the store" } else { "this till was not paired; nothing to remove" };
            Ok(Outcome::ok(message, json!({ "wasPaired": out.was_paired, "rootSha256": out.root_sha256, "root": out.root_outcome })))
        }
        PairCmd::Prune => {
            require_admin(roots)?;
            Ok(Outcome::ok("expired offers removed", json!({ "removed": sweep_expired_offers(&offers, now().unix_timestamp()) })))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pki::test_support::FIXTURE_ROOT_PEM;

    fn server_root() -> (tempfile::TempDir, Roots) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().to_path_buf(), dir.path().join("program"));
        let root = pki::root_path(dir.path());
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&root, FIXTURE_ROOT_PEM).unwrap();
        fs::create_dir_all(dir.path().join("state")).unwrap();
        fs::write(
            dir.path().join("state").join("gateway.json"),
            r#"{"schema":1,"tls":"internal","extPort":47304,"hosts":["storepc","storepc.local","localhost","127.0.0.1","192.168.1.20"]}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("secrets")).unwrap();
        fs::write(
            dir.path().join("secrets").join("keys.json"),
            format!(r#"{{"anon":"{}","service_role":"x"}}"#, crate::gateway::test_support::fake_jwt("anon")),
        )
        .unwrap();
        (dir, roots)
    }

    fn till() -> (tempfile::TempDir, Roots) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::custom(dir.path().to_path_buf(), dir.path().join("program"));
        (dir, roots)
    }

    fn data(o: &Outcome) -> &Value {
        &o.data
    }

    #[test]
    fn ttl_parses_and_is_bounded() {
        assert_eq!(parse_ttl("10m").unwrap(), Duration::minutes(10));
        assert_eq!(parse_ttl("90s").unwrap(), Duration::seconds(90));
        assert_eq!(parse_ttl("1h").unwrap(), Duration::hours(1));
        for bad in ["", "m", "10", "10d", "30s", "2h", "-5m", "abc"] {
            assert!(parse_ttl(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn create_writes_a_valid_file_and_a_lan_offer_that_expires() {
        let (dir, roots) = server_root();
        let v = run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: true }).unwrap();
        let v = data(&v);
        let record = parse_record(&fs::read_to_string(v["file"].as_str().unwrap()).unwrap()).unwrap();
        let valid = validate_record(&record, now().unix_timestamp()).unwrap();
        assert_eq!(record.server_host, "storepc");
        assert_eq!(record.alt_hosts, vec!["storepc.local".to_string(), "192.168.1.20".to_string()]);
        assert_eq!(v["fingerprint"].as_str().unwrap(), fingerprint16(&valid.sha256));
        assert_eq!(v["fingerprintDisplay"].as_str().unwrap().len(), 19);
        let code = v["code"].as_str().unwrap();
        assert!(is_offer_code(code));
        let offer = parse_record(&fs::read_to_string(dir.path().join("client/pairing/offers").join(format!("{code}.pospair"))).unwrap()).unwrap();
        assert!(offer.expires_at.is_some());
        // without --lan there is no offer and no code
        let v2 = run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap();
        assert!(data(&v2)["code"].is_null());
    }

    #[test]
    fn a_loopback_only_instance_publishes_127_0_0_1_under_dev_and_is_refused_outside_it() {
        let (dir, roots) = server_root();
        fs::write(
            dir.path().join("state").join("gateway.json"),
            r#"{"schema":1,"tls":"internal","extPort":47414,"hosts":["127.0.0.1","localhost"]}"#,
        )
        .unwrap();
        let v = run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: true }).unwrap();
        assert_eq!(data(&v)["serverHost"], "127.0.0.1");
        assert_eq!(data(&v)["serverPort"], 47414);
        let e = build_record(&roots, "2026-10-02T10:00:00Z", None, false).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
    }

    #[test]
    fn a_plain_http_store_has_nothing_to_pair_with() {
        let (dir, roots) = server_root();
        fs::write(dir.path().join("state").join("gateway.json"), r#"{"schema":1,"tls":"off","extPort":47304,"hosts":[]}"#).unwrap();
        assert_eq!(run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap_err().code, Code::Precondition);
    }

    #[test]
    fn the_configured_host_is_used_only_when_the_certificates_cover_it() {
        let (dir, roots) = server_root();
        fs::create_dir_all(roots.conf()).unwrap();
        let cfg = |host: &str| PosctlJson::new("offline-only", "s", 47300, host, "1.0.0").save(&roots).map(|_| host.to_string());
        cfg("192.168.1.20").unwrap();
        assert_eq!(build_record(&roots, "t", None, false).unwrap().server_host, "192.168.1.20");
        cfg("192.168.1.99").unwrap(); // not in gateway.json hosts: the cert would not cover it
        assert_eq!(build_record(&roots, "t", None, false).unwrap().server_host, "storepc");
        drop(dir);
    }

    #[test]
    fn the_usb_file_has_no_expiry_and_only_the_lan_offer_does() {
        let (dir, roots) = server_root();
        let v = run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: true }).unwrap();
        let usb = parse_record(&fs::read_to_string(data(&v)["file"].as_str().unwrap()).unwrap()).unwrap();
        assert!(usb.expires_at.is_none());
        let code = data(&v)["code"].as_str().unwrap();
        let offer = parse_record(&fs::read_to_string(dir.path().join("client/pairing/offers").join(format!("{code}.pospair"))).unwrap()).unwrap();
        assert!(offer.expires_at.is_some() && offer.root_sha256 == usb.root_sha256);
        // the USB file joins with --trust-file; the offer does not
        let (_t, till) = till();
        run(&till, &PairCmd::Join { file: PathBuf::from(data(&v)["file"].as_str().unwrap()), confirm_fingerprint: None, trust_file: true }).unwrap();
        let offer_file = dir.path().join("client/pairing/offers").join(format!("{code}.pospair"));
        let e = run(&till, &PairCmd::Join { file: offer_file, confirm_fingerprint: None, trust_file: true }).unwrap_err();
        assert_eq!(e.code.exit(), 50);
    }

    #[test]
    fn owners_other_than_administrators_or_system_are_refused_with_a_hint() {
        let (_d, roots) = server_root();
        fs::create_dir_all(roots.client()).unwrap();
        let owner = |sid: &'static str| move |_: &Path| -> Result<String, String> { Ok(sid.to_string()) };
        assert!(check_owners(&roots, &owner("S-1-5-32-544")).is_ok());
        assert!(check_owners(&roots, &owner("S-1-5-18")).is_ok());
        let e = check_owners(&roots, &owner("S-1-5-21-1-2-3-1001")).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("delete the folder"), "{}", e.message);
        // only the client folder is user-owned: still refused; a missing folder is fine
        let only_client = |p: &Path| -> Result<String, String> { Ok(if p.ends_with("client") { "S-1-5-21-9".into() } else { "S-1-5-32-544".into() }) };
        assert!(check_owners(&roots, &only_client).is_err());
        let (_t, fresh) = till();
        assert!(check_owners(&Roots { data: fresh.data.join("nope"), ..fresh.clone() }, &owner("S-1-5-21-9")).is_ok());
        assert!(check_owners(&roots, &|_| Err("denied".into())).is_err());
    }

    #[test]
    fn a_pairing_file_over_64_kib_is_refused_unread() {
        let (d, till) = till();
        let big = d.path().join("big.pospair");
        fs::write(&big, vec![b' '; 70_000]).unwrap();
        let e = run(&till, &PairCmd::Join { file: big, confirm_fingerprint: None, trust_file: true }).unwrap_err();
        assert_eq!(e.code.exit(), 50);
    }

    #[test]
    fn create_without_a_gateway_is_a_precondition_failure() {
        let (_d, roots) = till();
        assert_eq!(run(&roots, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap_err().code, Code::Precondition);
    }

    #[test]
    fn the_server_pc_pairs_with_itself_and_writes_its_own_store_env() {
        let (dir, roots) = server_root();
        let v = server_self_pair(&roots, false, StdDuration::ZERO).unwrap();
        assert_eq!(v["serverUrl"], "https://storepc:47304");
        assert_eq!(v["trustInstalled"], false);
        let env = fs::read_to_string(dir.path().join("client").join("store.env")).unwrap();
        assert!(env.contains("VITE_STORE_MODE=offline-only") && env.contains("VITE_SUPABASE_URL=https://storepc:47304"));
        assert!(env.contains("VITE_STORE_CA_SHA256=") && env.contains("VITE_STORE_SERVER_ALT_HOSTS=storepc.local,192.168.1.20"));
        assert!(dir.path().join("client").join("pki").join("root.crt").exists());
    }

    #[test]
    fn the_self_pair_waits_for_the_root_and_then_fails_clearly_when_it_never_comes() {
        let (dir, roots) = server_root();
        fs::remove_file(pki::root_path(dir.path())).unwrap();
        let t = Instant::now();
        let e = server_self_pair(&roots, false, StdDuration::from_millis(600)).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(t.elapsed() >= StdDuration::from_millis(600));
        assert!(!dir.path().join("client").join("store.env").exists());
    }

    #[test]
    fn join_under_dev_trusts_the_file_without_touching_the_machine() {
        let (_s, server) = server_root();
        let v = run(&server, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap();
        let file = PathBuf::from(data(&v)["file"].as_str().unwrap());
        let (till_dir, till) = till();
        let j = run(&till, &PairCmd::Join { file: file.clone(), confirm_fingerprint: None, trust_file: true }).unwrap();
        assert_eq!(data(&j)["trustInstalled"], false);
        assert!(till_dir.path().join("client/store.env").exists());
        // the typed fingerprint path, with and without dashes
        let fp = data(&v)["fingerprint"].as_str().unwrap().to_string();
        run(&till, &PairCmd::Join { file: file.clone(), confirm_fingerprint: Some(fp.clone()), trust_file: false }).unwrap();
        run(&till, &PairCmd::Join { file, confirm_fingerprint: Some(group4(&fp).to_ascii_uppercase()), trust_file: false }).unwrap();
    }

    #[test]
    fn leave_removes_store_env_and_is_quiet_when_nothing_is_paired() {
        let (_sd, server) = server_root();
        let v = run(&server, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap();
        let file = PathBuf::from(data(&v)["file"].as_str().unwrap());
        let (till_dir, till) = till();
        let j = run(&till, &PairCmd::Join { file, confirm_fingerprint: None, trust_file: true }).unwrap();
        assert_eq!((data(&j)["previousRoot"].clone(), data(&j)["previousRootSha256"].clone()), (Value::Null, Value::Null));
        let l = run(&till, &PairCmd::Leave).unwrap();
        assert_eq!((data(&l)["wasPaired"].clone(), data(&l)["root"].as_str()), (Value::Bool(true), Some("untouched")));
        assert!(!till_dir.path().join("client/store.env").exists() && !till_dir.path().join("client/pki/root.crt").exists());
        let again = run(&till, &PairCmd::Leave).unwrap();
        assert_eq!(data(&again)["wasPaired"], Value::Bool(false));
    }

    #[test]
    fn join_needs_exactly_one_confirmation() {
        let (_d, till) = till();
        let f = PathBuf::from("x.pospair");
        for (fp, tf) in [(None, false), (Some("abcd1234abcd1234".to_string()), true)] {
            let e = run(&till, &PairCmd::Join { file: f.clone(), confirm_fingerprint: fp, trust_file: tf }).unwrap_err();
            assert_eq!(e.code.exit(), 2);
        }
    }

    #[test]
    fn join_with_the_wrong_fingerprint_exits_51_and_leaves_the_till_unchanged() {
        let (_s, server) = server_root();
        let v = run(&server, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap();
        let file = PathBuf::from(data(&v)["file"].as_str().unwrap());
        let (till_dir, till) = till();
        for typed in ["0000000000000000".to_string(), data(&v)["fingerprint"].as_str().unwrap()[..8].to_string()] {
            let e = run(&till, &PairCmd::Join { file: file.clone(), confirm_fingerprint: Some(typed), trust_file: false }).unwrap_err();
            assert_eq!((e.code.exit(), e.code.name()), (51, "PAIR_FINGERPRINT_MISMATCH"));
        }
        assert!(!till_dir.path().join("client").join("store.env").exists());
        assert!(!till_dir.path().join("client").join("pki").exists(), "nothing is written before every check passed");
    }

    #[test]
    fn a_pairing_file_with_a_swapped_certificate_exits_51_and_writes_nothing() {
        let (_s, server) = server_root();
        let v = run(&server, &PairCmd::Create { ttl: "10m".into(), lan: false }).unwrap();
        let text = fs::read_to_string(data(&v)["file"].as_str().unwrap()).unwrap();
        let mut rec = parse_record(&text).unwrap();
        rec.root_cert_pem = rec.root_cert_pem.replacen("MII", "MIJ", 1);
        let (till_dir, till) = till();
        let tampered = till_dir.path().join("tampered.pospair");
        fs::write(&tampered, serde_json::to_string(&rec).unwrap()).unwrap();
        let e = run(&till, &PairCmd::Join { file: tampered, confirm_fingerprint: None, trust_file: true }).unwrap_err();
        assert_eq!(e.code.exit(), 51);
        assert!(!till_dir.path().join("client").exists());
    }

    #[test]
    fn fetch_refuses_a_bad_code_or_host_before_running_anything() {
        let (_d, ctx) = till();
        let out = PathBuf::from("o.pospair");
        for (host, code) in [("8.8.8.8", "ABCDEFGH"), ("storepc", "ABCDEFGH"), ("127.0.0.1", "../etc"), ("127.0.0.1", "abcdefgh"), ("a b", "ABCDEFGH")] {
            let e = run(&ctx, &PairCmd::Fetch { host: host.into(), port: 47304, code: code.into(), out: out.clone() }).unwrap_err();
            assert_eq!(e.code.exit(), 2, "{host} {code}");
        }
    }

    #[test]
    fn curl_arguments_are_https_only_and_bounded() {
        let a = curl_fetch_args("storepc", 47304, "ABCDEFGH");
        assert_eq!(a.last().unwrap(), "https://storepc:47304/_store/pair/ABCDEFGH");
        assert_eq!(a[0], "-q", "never read a curlrc");
        for pair in [["--proto", "=https"], ["--max-filesize", "65536"], ["--max-time", "10"]] {
            assert!(a.windows(2).any(|w| w == pair), "{pair:?}");
        }
        assert!(a.contains(&"-k".to_string()) && a.contains(&"--fail".to_string()));
    }

    #[test]
    fn exit_codes_are_the_envelope_codes() {
        assert_eq!((Code::PairFailed.exit(), Code::PairFingerprintMismatch.exit()), (50, 51));
    }
}
