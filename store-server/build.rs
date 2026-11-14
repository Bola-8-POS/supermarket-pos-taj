//! Embeds the Tauri updater public key into the binary at build time. `posctl` verifies the
//! backend pack's manifest signature with it, so the pack and the app updates share ONE trust
//! anchor (conventions section 10). The customer overrides under `customers/*/tauri.override.json`
//! change identifier, icons and endpoints only, and a Plan 04 check enforces that.

use std::path::PathBuf;

fn main() {
    let conf = PathBuf::from("../src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("updater_pubkey.txt");
    let key = std::fs::read_to_string(&conf)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["plugins"]["updater"]["pubkey"].as_str().map(str::to_string))
        .unwrap_or_default();
    if key.is_empty() {
        // A crate checked out without the repo: the binary then refuses every pack (empty key).
        println!("cargo:warning=no updater pubkey found in ../src-tauri/tauri.conf.json; pack verification will refuse everything");
    }
    std::fs::write(out, key).expect("write updater_pubkey.txt");
}
