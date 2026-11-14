//! Test-only driver of the assistant's verify + spawn path for the Windows Sandbox scenarios 120-123 (Plan 29-04).
//! It lives in `examples/`, which `tauri build` never bundles, so the `--test-*` fault flags can never ship.
//!
//!   assistant_probe --install-dir <dir> --pubkey-file <file> --verify-only
//!       prints {"ok":bool,"reason":str|null,"totalBytes":n}
//!   assistant_probe --install-dir <dir> --pubkey-file <file> [--hold-seconds N] [--test-host <addr>] [--test-skip-job]
//!       [--test-no-key] [--test-print-key]
//!       verifies, spawns llama-server exactly like the app (build_args + spawn_with_args + Job from the manifest
//!       profile), waits for /health, then prints ONE line {"ok":true,"probePid","childPid","port","jobLimits":{...}|null}
//!       and holds. Exiting (or being killed) closes the Job, which must end the child.
//!
//! The POS app trusts only the updater key; this probe trusts the throwaway test key given by `--pubkey-file`.

#[cfg(windows)]
fn main() {
    use supermarket_pos_lib::assistant::{bridge, manifest, sidecar};
    use serde_json::json;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn arg(name: &str) -> Option<String> {
        let a: Vec<String> = std::env::args().collect();
        a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
    }
    fn flag(name: &str) -> bool {
        std::env::args().any(|x| x == name)
    }
    fn say(v: serde_json::Value) {
        println!("{v}");
        let _ = std::io::stdout().flush();
    }
    fn dir_bytes(dir: &Path) -> u64 {
        let mut total = 0;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                match e.metadata() {
                    Ok(m) if m.is_dir() => total += dir_bytes(&e.path()),
                    Ok(m) => total += m.len(),
                    _ => {}
                }
            }
        }
        total
    }
    // A reparse point (junction or symlink) is a link; mirrors the app's check.
    fn is_link(p: &Path) -> bool {
        use std::os::windows::fs::MetadataExt;
        std::fs::symlink_metadata(p).map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(false)
    }

    let Some(dir) = arg("--install-dir").map(PathBuf::from) else {
        say(json!({"ok": false, "reason": "USAGE: --install-dir"}));
        std::process::exit(2);
    };
    let Some(pubkey) = arg("--pubkey-file").and_then(|f| std::fs::read_to_string(f).ok()) else {
        say(json!({"ok": false, "reason": "USAGE: --pubkey-file unreadable"}));
        std::process::exit(2);
    };
    let total = dir_bytes(&dir);
    let probes = manifest::Probes { size_of: &|_, len| len, is_link: &is_link };
    let verified = match manifest::verify_install_with(&dir, pubkey.trim(), &probes) {
        Ok(v) => v,
        Err(reason) => {
            say(json!({"ok": false, "reason": reason, "totalBytes": total}));
            std::process::exit(1);
        }
    };
    if flag("--verify-only") {
        say(json!({"ok": true, "reason": null, "totalBytes": total}));
        return;
    }

    let port = sidecar::pick_port().expect("a free loopback port");
    let key = sidecar::new_key();
    let cpus = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(2);
    let model = dir.join(&verified.manifest.model_file);
    let mut args = sidecar::build_args(&verified.manifest, port, &model, cpus).expect("argv from a verified manifest");
    if let Some(host) = arg("--test-host") {
        if let Some(i) = args.iter().position(|a| a == "--host") {
            args[i + 1] = host;
        }
    }
    let limits = sidecar::job_limits_from(&verified.manifest.profile);
    let env: Vec<(&str, &str)> = if flag("--test-no-key") { vec![] } else { vec![("LLAMA_API_KEY", key.as_str())] };
    let exe = dir.join(manifest::RUNTIME_EXE);
    let started = Instant::now();
    let mut spawned = match sidecar::spawn_with_args(&exe, &args, &env, if flag("--test-skip-job") { None } else { Some(&limits) }) {
        Ok(s) => s,
        Err(e) => {
            say(json!({"ok": false, "reason": "SPAWN_FAILED", "detail": e}));
            std::process::exit(1);
        }
    };
    let client = bridge::loopback_client();
    if let Err(code) = sidecar::wait_healthy(&client, port, &mut spawned.child, Duration::from_secs(120)) {
        let _ = spawned.child.kill(); // our own child handle
        say(json!({"ok": false, "reason": code}));
        std::process::exit(1);
    }
    let job_limits = spawned.job.as_ref().and_then(|j| j.read_back().ok()).map(|l| {
        json!({
            "cpuRateHardCap": l.cpu_rate_hard_cap,
            "memoryLimitBytes": l.process_memory_bytes,
            "priorityClass": if l.below_normal_priority { "BELOW_NORMAL" } else { "OTHER" },
            "killOnClose": l.kill_on_close,
        })
    });
    let ready_ms = started.elapsed().as_millis() as u64;
    let mut line = json!({"ok": true, "probePid": std::process::id(), "childPid": spawned.child.id(), "port": port, "readyMs": ready_ms, "jobLimits": job_limits});
    if flag("--test-print-key") {
        line["key"] = json!(key);
    }
    say(line);

    let hold: u64 = arg("--hold-seconds").and_then(|s| s.parse().ok()).unwrap_or(600);
    let until = Instant::now() + Duration::from_secs(hold);
    while Instant::now() < until {
        if matches!(spawned.child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    // dropping `spawned` closes the Job handle; KILL_ON_JOB_CLOSE ends the child
}

#[cfg(not(windows))]
fn main() {
    eprintln!("assistant_probe is a Windows Sandbox driver");
    std::process::exit(2);
}
