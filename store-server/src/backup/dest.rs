//! Destinations: where the second copy lives. Chosen with `backup dest add`, validated here.
//! A foreign or empty replacement drive is never initialised automatically (only `dest add` creates
//! a repository, and only in an empty folder).
//!
//! Locking (CARRY from Task 2): `backup dest add|remove` must hold `update.lock` SHARED for their whole run,
//! because they rewrite the `backup` section of `posctl.json`, which `config set` and pack activation rewrite
//! under the EXCLUSIVE lock. The lock is taken by the CLI layer (Task 11, `commands/backup.rs`, the one place that
//! already owns lock acquisition for every `backup` subcommand), not here: these functions take no lock so they
//! stay callable from an in-process caller that already holds one, and unit-testable without a lock directory.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::config::{self, valid_dest_name, DestKind, Destination};
use super::ctx::BackupCtx;
use super::keys::ensure_machine_key;
use super::repo::{dest_repo, ensure_local_repo};
use super::restic::{cat_config_args, describe_exit, init_args, key_add_args, parse_key_id, run_restic, Password, Repo};
use super::result::{BResult, BackupError};
use super::state::{BackupState, DestState};
use super::util::{free_bytes, hex, now_secs, random_bytes, tail, write_atomic, Exec};

pub const DEFAULT_FOLDER: &str = "SupermarketPOS-Backup";
/// The one refusal for every network-share spelling (PM ruling: UNC destinations are out of v1).
pub const NETWORK_REFUSAL: &str = "network shares are not supported; use a USB drive or R2";
/// The weekly verify's task limit (`backup_tasks`) is derived from this: one local repository plus this many copies.
pub const MAX_DESTINATIONS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveKind {
    Removable,
    Fixed,
    Remote,
    Other,
}

#[cfg(windows)]
pub fn drive_kind(letter: char) -> DriveKind {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    let w: Vec<u16> = format!("{}:\\", letter.to_ascii_uppercase()).encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `w` is a NUL-terminated UTF-16 string that outlives the call.
    let t = unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) };
    match t {
        2 => DriveKind::Removable,
        3 => DriveKind::Fixed,
        4 => DriveKind::Remote,
        _ => DriveKind::Other,
    }
}

#[cfg(windows)]
pub fn logical_drives() -> Vec<char> {
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;
    // SAFETY: no arguments; returns a bitmask.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8).filter(|i| mask & (1u32 << i) != 0).map(|i| (b'A' + i) as char).collect()
}

/// `1A2B-3C4D`, the form `vol` and Explorer show for a volume serial number.
pub fn format_vol_serial(serial: u32) -> String {
    format!("{:04X}-{:04X}", serial >> 16, serial & 0xFFFF)
}

/// The serial number of the volume mounted at `letter:\` (language independent; replaces the plan's `cmd /C vol`).
#[cfg(windows)]
pub fn volume_serial(letter: char) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    let w: Vec<u16> = format!("{}:\\", letter.to_ascii_uppercase()).encode_utf16().chain(std::iter::once(0)).collect();
    let mut serial = 0u32;
    // SAFETY: `w` is NUL-terminated and outlives the call; `serial` is a valid out pointer; the optional buffers are None.
    unsafe { GetVolumeInformationW(PCWSTR(w.as_ptr()), None, Some(&mut serial), None, None, None) }.ok()?;
    Some(format_vol_serial(serial))
}

/// Same path or below it, compared case-insensitively on a folder boundary (`...\POS-Backup` is not inside `...\POS`).
pub(crate) fn is_inside(p: &Path, root: &Path) -> bool {
    let norm = |x: &Path| x.to_string_lossy().to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string();
    let (p, root) = (norm(p), norm(root));
    p == root || p.starts_with(&format!("{root}\\"))
}

/// Pure validation of what the owner typed. `kind` is the Windows drive type of the letter
/// (None for UNC or unknown).
pub fn validate_device_path(
    raw: &str,
    data: &Path,
    program_files: &Path,
    system_drive: char,
    kind: Option<DriveKind>,
    allow_fixed: bool,
) -> Result<PathBuf, String> {
    let raw = raw.trim().replace('/', "\\");
    let raw = raw.as_str();
    if raw.is_empty() {
        return Err("no path given".into());
    }
    if raw.split('\\').any(|s| s == "..") {
        return Err("'..' is not allowed in a backup path".into());
    }
    // v1 has no network-share destinations (a share the scheduled task, which runs as SYSTEM, may not reach). Every
    // spelling that starts with two backslashes is refused here: \\host\share, the \\?\ and \\.\ device paths,
    // \\localhost and this computer's own name. (Forward slashes were turned into backslashes above.)
    if raw.starts_with(r"\\") {
        return Err(NETWORK_REFUSAL.into());
    }
    let result = {
        let b = raw.as_bytes();
        if b.len() < 2 || b[1] != b':' || !b[0].is_ascii_alphabetic() {
            return Err("give a full path such as E:\\".into());
        }
        let letter = (b[0] as char).to_ascii_uppercase();
        if letter == system_drive.to_ascii_uppercase() {
            return Err(format!("{letter}: is the system drive; a backup on the same drive does not protect against losing it"));
        }
        match kind {
            Some(DriveKind::Removable) => {}
            Some(DriveKind::Fixed) if allow_fixed => {}
            Some(DriveKind::Fixed) => {
                return Err(format!("{letter}: is an internal disk; confirm it is a separate physical drive by adding --allow-fixed"));
            }
            Some(DriveKind::Remote) => {
                return Err(format!("{letter}: is a mapped network drive; {NETWORK_REFUSAL}"));
            }
            _ => return Err(format!("{letter}: is not available")),
        }
        let rest = raw[2..].replace('/', "\\");
        let rest = rest.trim_matches('\\');
        let folder = if rest.is_empty() { DEFAULT_FOLDER } else { rest };
        PathBuf::from(format!("{letter}:\\{folder}"))
    };
    if is_inside(&result, data) || is_inside(&result, program_files) {
        return Err("the backup folder cannot be inside the store's own program or data folders".into());
    }
    Ok(result)
}

/// Write 4 KiB of random bytes, read them back, delete. Proves the folder is writable and honest.
pub fn probe_write(dir: &Path) -> std::io::Result<()> {
    let mut id = [0u8; 6];
    random_bytes(&mut id).map_err(|e| std::io::Error::other(e.message))?;
    let f = dir.join(format!(".posctl-probe-{}", hex(&id)));
    let mut data = [0u8; 4096];
    random_bytes(&mut data).map_err(|e| std::io::Error::other(e.message))?;
    let result = (|| {
        write_atomic(&f, &data)?;
        let back = std::fs::read(&f)?;
        if back != data {
            return Err(std::io::Error::other("the drive returned different bytes than were written"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&f);
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Up,
    Down,
    /// The path is on a volume whose serial differs from the one recorded when the destination was added: another
    /// drive got this letter. Never written, never retried as a normal failure.
    Foreign,
}

/// A dead share or a sleeping USB disk can take a while to answer; a slow answer is not an unplugged drive.
pub const REACH_TIMEOUT: Duration = Duration::from_secs(15);

fn device_state(path: &Path, recorded_serial: Option<&str>) -> Reach {
    #[cfg(windows)]
    if device_refused_now(path, recorded_serial) {
        return Reach::Foreign;
    }
    #[cfg(not(windows))]
    let _ = recorded_serial;
    config_state(path)
}

fn config_state(path: &Path) -> Reach {
    if path.join("config").is_file() { Reach::Up } else { Reach::Down }
}

/// The run-time judgment every device path shares (`dest_repo` and the reachability probe): the system volume is the Windows
/// folder's serial, and an unidentifiable system volume refuses (fail closed). Host tests run on the system volume, so they
/// pass an explicit serial to `device_refused` instead.
#[cfg(windows)]
pub(crate) fn device_refused_now(path: &Path, recorded_serial: Option<&str>) -> bool {
    #[cfg(not(test))]
    {
        match crate::sys::known_folder(crate::sys::KnownFolder::Windows).ok().and_then(|w| volume_serial_of_path(&w)) {
            Some(sys) => device_refused(path, recorded_serial, Some(sys)),
            None => true,
        }
    }
    #[cfg(test)]
    device_refused(path, recorded_serial, None)
}

pub(crate) const DEVICE_REFUSED_MSG: &str = "the destination folder is a link or is on the system drive, or a different drive is connected; nothing was read from or written to it";

/// The first reparse point (junction, symlink, mount point, OneDrive-style placeholder) on `path`, on any folder above it, or ANYWHERE
/// under it: the walk lists every directory and refuses on any reparse entry it meets, files included (the safer choice; a
/// deduplicated or cloud-placeholder volume could therefore read as foreign, which is acceptable for a USB backup drive). It lists
/// directories only: a regular file is never opened or stat-ed beyond its directory entry. One walk serves the destination check on
/// every run-time path and the photos restore. A restic repository has about 270 directories (root, keys, locks, snapshots, index,
/// data and its 256 data/xx), so the walk is a few hundred directory listings. A missing path is not a reparse point.
pub(crate) fn reparse_on_path(path: &Path) -> std::io::Result<Option<PathBuf>> {
    use crate::pack::is_reparse;
    for a in path.ancestors().filter(|a| a.file_name().is_some()) {
        match std::fs::symlink_metadata(a) {
            Ok(m) if is_reparse(&m) => return Ok(Some(a.to_path_buf())),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    // an explicit stack: a planted tree thousands of levels deep must not overflow ours
    let mut todo = vec![path.to_path_buf()];
    while let Some(dir) = todo.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => continue,
            Err(e) => return Err(e),
        };
        for e in rd {
            let e = e?;
            let m = e.metadata()?; // lstat semantics: a junction is reported as the link itself
            if is_reparse(&m) {
                return Ok(Some(e.path()));
            }
            if m.is_dir() {
                todo.push(e.path());
            }
        }
    }
    Ok(None)
}

/// True when a device destination must never be written or read as an off-PC copy: a reparse point on or above the repository
/// folder (a standard user could point it at the local repository), a volume serial that differs from the recorded one, or
/// the system volume itself. The serial is the drive root's.
#[cfg(windows)]
pub(crate) fn device_refused(path: &Path, recorded_serial: Option<&str>, system_serial: Option<u32>) -> bool {
    if !matches!(reparse_on_path(path), Ok(None)) {
        return true;
    }
    // The serial is always the DRIVE ROOT's (the volume that holds the path), and it exists even when the repo folder does not: a
    // blank drive that got the recorded letter is Foreign, not Down. A root that is not there at all is an unplugged drive: Down.
    let Some(root) = path.ancestors().last().filter(|r| !r.as_os_str().is_empty()) else { return true };
    match std::fs::symlink_metadata(root) {
        Ok(_) => {}
        Err(e) => return e.kind() != std::io::ErrorKind::NotFound,
    }
    let Some(have) = volume_serial_of_path(root) else { return true };
    // The nearest ancestor that exists must sit on that same volume (the walk never crosses onto another one). Every ancestor was
    // already checked for reparse points above, so the chain from the root down to it is plain folders.
    for a in path.ancestors() {
        match std::fs::canonicalize(a) {
            Ok(real) => {
                if volume_serial_of_path(&crate::provision::strip_verbatim(real)) != Some(have) {
                    return true;
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return true,
        }
    }
    recorded_serial.is_some_and(|want| !want.eq_ignore_ascii_case(&format_vol_serial(have))) || system_serial == Some(have)
}

#[cfg(all(windows, test))]
fn device_state_with(path: &Path, recorded_serial: Option<&str>, system_serial: Option<u32>) -> Reach {
    if device_refused(path, recorded_serial, system_serial) { Reach::Foreign } else { config_state(path) }
}

/// Device: foreign (serial mismatch), up (the repository marker file exists) or down; judged on a helper thread so a
/// hung share cannot hang the tick. R2: assumed up; a failed copy records the error instead.
pub fn probe_within(d: &Destination, timeout: Duration) -> Reach {
    match d.kind {
        DestKind::R2 => Reach::Up,
        DestKind::Device => {
            let (path, serial) = (PathBuf::from(d.location()), d.volume_serial.clone());
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                let _ = tx.send(device_state(&path, serial.as_deref()));
            });
            rx.recv_timeout(timeout).unwrap_or(Reach::Down)
        }
    }
}

pub fn probe(d: &Destination) -> Reach {
    probe_within(d, REACH_TIMEOUT)
}

/// Reachable for a copy: up, and not a foreign drive.
pub fn reachable(d: &Destination) -> bool {
    probe(d) == Reach::Up
}

/// Serial number of the volume that holds `p` (mount points and junction targets resolved by the caller).
#[cfg(windows)]
pub fn volume_serial_of_path(p: &Path) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut root = [0u16; 261];
    let mut serial = 0u32;
    // SAFETY: `w` is NUL-terminated and outlives both calls; `root` is a writable buffer the API fills and
    // terminates; `serial` is a valid out pointer; the optional buffers are None.
    unsafe {
        GetVolumePathNameW(PCWSTR(w.as_ptr()), &mut root).ok()?;
        GetVolumeInformationW(PCWSTR(root.as_ptr()), None, Some(&mut serial), None, None, None).ok()?;
    }
    Some(serial)
}

/// Err(PRECONDITION) when `dir` (links and mount points resolved) is on the same volume as `system`, i.e. the
/// system disk, or when that cannot be proven. A drive letter, a junction or a mounted folder cannot smuggle the
/// system volume past the name-based checks in `validate_device_path`; the system volume is identified by the
/// Windows folder's serial (never the `SystemDrive` variable).
#[cfg(windows)]
pub fn refuse_system_volume(dir: &Path, system: &Path) -> BResult<()> {
    let real = std::fs::canonicalize(dir).map_err(|e| BackupError::precondition(format!("cannot resolve {}: {e}", dir.display())))?;
    let real = crate::provision::strip_verbatim(real);
    let here = volume_serial_of_path(&real).ok_or_else(|| BackupError::precondition(format!("cannot identify the volume of {}", real.display())))?;
    let sys = volume_serial_of_path(system).ok_or_else(|| BackupError::precondition("cannot identify the system volume"))?;
    if here == sys {
        return Err(BackupError::precondition(format!("{} is on the system drive; a backup on the same drive does not protect against losing it", real.display())));
    }
    Ok(())
}

/// Non-blocking advice for a drive that is not NTFS (FAT and exFAT have no journal: a power cut during a write can
/// corrupt them). An unknown filesystem is no reason to warn.
pub fn fs_warning(fs: &str) -> Option<String> {
    if fs.is_empty() || fs.eq_ignore_ascii_case("NTFS") {
        return None;
    }
    Some(format!("this drive is {fs}; a power cut while writing can corrupt it — NTFS is safer"))
}

/// Name of the filesystem of the volume that holds `p` (`NTFS`, `FAT32`, `exFAT`).
#[cfg(windows)]
pub fn volume_fs_of_path(p: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut root = [0u16; 261];
    let mut fs = [0u16; 64];
    // SAFETY: `w` is NUL-terminated and outlives both calls; `root` and `fs` are writable buffers the API fills and
    // terminates; the other optional out parameters are None.
    unsafe {
        GetVolumePathNameW(PCWSTR(w.as_ptr()), &mut root).ok()?;
        GetVolumeInformationW(PCWSTR(root.as_ptr()), None, None, None, None, Some(&mut fs)).ok()?;
    }
    let n = fs.iter().position(|&c| c == 0).unwrap_or(fs.len());
    Some(String::from_utf16_lossy(&fs[..n]))
}

#[cfg(not(windows))]
pub fn volume_fs_of_path(_p: &Path) -> Option<String> {
    None
}

pub struct AddDevice {
    pub name: Option<String>,
    pub path: String,
    pub allow_fixed: bool,
    pub recovery_key: Option<String>,
}

fn unique_name(cfg: &config::BackupConfig, wanted: Option<String>, fallback: &str) -> BResult<String> {
    let name = wanted.unwrap_or_else(|| fallback.to_string());
    if !valid_dest_name(&name) {
        return Err(BackupError::usage("a destination name is 1-32 lowercase letters, digits or dashes, and not 'local'"));
    }
    if cfg.destinations.iter().any(|d| d.name == name) {
        return Err(BackupError::usage(format!("a destination named '{name}' already exists")));
    }
    if cfg.destinations.len() >= MAX_DESTINATIONS {
        return Err(BackupError::precondition(format!("at most {MAX_DESTINATIONS} backup destinations are supported; remove one first")));
    }
    Ok(name)
}

#[cfg(windows)]
pub fn add_device(ctx: &BackupCtx, exec: &dyn Exec, a: &AddDevice) -> BResult<Value> {
    let letter = a.path.trim().chars().next().filter(|c| c.is_ascii_alphabetic() && a.path.trim().as_bytes().get(1) == Some(&b':'));
    let kind = letter.map(drive_kind);
    let system_drive = std::env::var("SystemDrive").ok().and_then(|s| s.chars().next()).unwrap_or('C');
    let program_files = ctx.paths.roots().program.clone();
    let dir = validate_device_path(&a.path, ctx.paths.data(), &program_files, system_drive, kind, a.allow_fixed).map_err(BackupError::usage)?;
    if let Some(parent) = dir.parent() {
        if !parent.exists() {
            return Err(BackupError::precondition(format!("{} is not available", parent.display())));
        }
    }
    // the system volume by serial (junctions, mount points and odd spellings resolved), before and after the folder exists
    let win = crate::sys::known_folder(crate::sys::KnownFolder::Windows).map_err(BackupError::error)?;
    refuse_system_volume(if dir.exists() { &dir } else { dir.parent().unwrap_or(&dir) }, &win)?;
    std::fs::create_dir_all(&dir).map_err(|e| BackupError::precondition(format!("cannot create {}: {e}", dir.display())))?;
    refuse_system_volume(&dir, &win)?;
    probe_write(&dir).map_err(|e| BackupError::precondition(format!("cannot write to {}: {e}", dir.display())))?;
    let serial = letter.and_then(volume_serial);
    add_device_validated(ctx, exec, dir, a.name.clone(), a.recovery_key.clone(), serial)
}

/// The recovery key a new destination must receive, once one has been issued (`key-export` already ran). The
/// owner supplies it on stdin (Task 11 wires `--key-stdin`); without it nothing is added. `None` before the first export.
fn issued_recovery_key(given: Option<&str>, st: &BackupState) -> BResult<Option<String>> {
    if st.recovery_key.is_none() {
        return Ok(None);
    }
    let g = given.ok_or_else(|| BackupError::precondition("a recovery key was already issued, so a new destination must receive it too; supply the owner's recovery key (--key-stdin)"))?;
    super::keys::normalize_recovery_key(g).map(Some).ok_or_else(|| BackupError::usage("that is not a valid recovery key"))
}

/// The supplied key must open the local repository (it was added there at export time): catches a mistyped or
/// stale key before the drive is touched.
fn verify_recovery_key(ctx: &BackupCtx, exec: &dyn Exec, local: &Repo, rk: Option<&str>) -> BResult<()> {
    let Some(rk) = rk else { return Ok(()) };
    let with_rk = Repo { password: Password::Plain(rk.to_string()), ..local.clone() };
    let out = run_restic(exec, ctx, &with_rk, &cat_config_args(), Duration::from_secs(60))?;
    if !out.ok() {
        return Err(BackupError::precondition("that recovery key does not open the local backup; check it and try again"));
    }
    Ok(())
}

/// Adds the recovery key to the new repository (through a file in a private folder, never argv) and records its id
/// so a later rotation can remove it. A repository adopted with that same key gets a second copy of it (harmless).
// CARRY T9: `keys::dests_without_recovery_key` lists destinations that still lack a key (added before any export).
fn record_recovery_key(ctx: &BackupCtx, exec: &dyn Exec, st: &mut BackupState, name: &str, repo: &Repo, rk: Option<&str>) -> BResult<()> {
    let Some(rk) = rk else { return Ok(()) };
    let id = super::keys::with_key_file(ctx, rk, |file| {
        let out = run_restic(exec, ctx, repo, &key_add_args(file), Duration::from_secs(120))?;
        if !out.ok() {
            return Err(BackupError::precondition(format!("cannot add the recovery key to '{name}': {}", tail(&out.stderr))));
        }
        parse_key_id(&out.stdout).ok_or_else(|| BackupError::error(format!("restic did not report the new key id for '{name}'")))
    })?;
    if let Some(k) = st.recovery_key.as_mut() {
        k.key_ids.insert(name.to_string(), id);
    }
    Ok(())
}

/// Everything after path validation: free space, repository check or creation, config and state.
// Private on purpose: `add_device` is the only caller, and it runs the path, drive-kind and system-volume checks first.
fn add_device_validated(
    ctx: &BackupCtx,
    exec: &dyn Exec,
    dir: PathBuf,
    name: Option<String>,
    recovery_key: Option<String>,
    serial: Option<String>,
) -> BResult<Value> {
    let mut cfg = config::load(&ctx.paths.conf_file())?;
    let fallback = format!("usb-{}", dir.to_string_lossy().chars().next().map(|c| c.to_ascii_lowercase()).unwrap_or('x'));
    let name = unique_name(&cfg, name, &fallback)?;
    let mut st = BackupState::load_in(&ctx.paths, now_secs())?;
    let rk = issued_recovery_key(recovery_key.as_deref(), &st)?;
    let local = ensure_local_repo(ctx, exec, !cfg.destinations.is_empty())?;
    let machine_key = ensure_machine_key(ctx, true)?;
    verify_recovery_key(ctx, exec, &local, rk.as_deref())?;
    std::fs::create_dir_all(&dir)?;
    let need = 1u64 << 30;
    if let Ok(free) = free_bytes(&dir) {
        let local_size = dir_size(&ctx.paths.repo());
        if free < need.max(local_size.saturating_mul(2)) {
            return Err(BackupError::precondition(format!("only {} MB free on the drive; the backup needs at least {} MB", free >> 20, need.max(local_size.saturating_mul(2)) >> 20)));
        }
    }
    let repo = Repo { location: dir.to_string_lossy().into_owned(), password: Password::File(machine_key.clone()), extra_env: vec![] };
    let cat = run_restic(exec, ctx, &repo, &cat_config_args(), Duration::from_secs(60))?;
    match cat.code {
        0 if !cat.timed_out => {}
        12 => {
            let rk = recovery_key.ok_or_else(|| {
                BackupError::precondition("this drive already holds a backup protected by a different key; supply the owner's recovery key (--key-stdin) to adopt it")
            })?;
            let rk = super::keys::normalize_recovery_key(&rk).ok_or_else(|| BackupError::usage("that is not a valid recovery key"))?;
            let with_rk = Repo { password: Password::Plain(rk), ..repo.clone() };
            let add = run_restic(exec, ctx, &with_rk, &key_add_args(&machine_key), Duration::from_secs(120))?;
            if !add.ok() {
                return Err(BackupError::precondition("the recovery key does not open the backup on this drive"));
            }
        }
        10 => {
            let has_entries = std::fs::read_dir(&dir)?.next().is_some();
            if has_entries {
                return Err(BackupError::precondition(format!("{} is not empty and is not a backup; choose an empty folder", dir.display())));
            }
            let init = run_restic(exec, ctx, &repo, &init_args(Some((&local.location, &machine_key))), Duration::from_secs(120))?;
            if !init.ok() {
                return Err(BackupError::precondition(format!("cannot create the backup repository: {}", tail(&init.stderr))));
            }
        }
        _ => return Err(BackupError::precondition(format!("cannot read the drive: {}", describe_exit(&cat)))),
    }
    record_recovery_key(ctx, exec, &mut st, &name, &repo, rk.as_deref())?;
    let dest = Destination {
        name: name.clone(),
        kind: DestKind::Device,
        path: Some(dir.to_string_lossy().into_owned()),
        repo: None,
        volume_serial: serial.clone(),
        added_at: now_secs(),
        extra: Default::default(),
    };
    cfg.destinations.push(dest.clone());
    config::save(&ctx.paths.conf_file(), &cfg)?;
    st.destinations.insert(name.clone(), DestState { reachable: true, ok: true, ..Default::default() });
    st.save_in(ctx)?;
    // a destination added after `key-export` must carry escrow.age too; a failure is a warning, never an error
    let escrow_warning = super::escrow::ensure_on(ctx, &dest, super::escrow::real_put().as_ref()).err();
    // non-blocking advice, never an error: the drive is added either way
    let warnings: Vec<String> = volume_fs_of_path(&dir).and_then(|f| fs_warning(&f)).into_iter().collect();
    Ok(json!({ "name": name, "path": dir.to_string_lossy(), "volumeSerial": serial, "pendingCopy": true, "escrowWarning": escrow_warning, "warnings": warnings }))
}

fn dir_size(p: &Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}


/// R2 by contract: Plan 12 writes `secrets\r2.env` first, then calls this with the S3 repository URL.
pub fn add_r2(ctx: &BackupCtx, exec: &dyn Exec, name: Option<String>, repo_url: &str, recovery_key: Option<String>) -> BResult<Value> {
    super::restore::refuse_s3_credentials(repo_url)?;
    if !repo_url.starts_with("s3:") {
        return Err(BackupError::usage("an R2 repository looks like s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<folder>"));
    }
    let mut cfg = config::load(&ctx.paths.conf_file())?;
    let name = unique_name(&cfg, name, "r2")?;
    let mut st = BackupState::load_in(&ctx.paths, now_secs())?;
    let rk = issued_recovery_key(recovery_key.as_deref(), &st)?;
    let local = ensure_local_repo(ctx, exec, !cfg.destinations.is_empty())?;
    let machine_key = ensure_machine_key(ctx, true)?;
    verify_recovery_key(ctx, exec, &local, rk.as_deref())?;
    let d = Destination { name: name.clone(), kind: DestKind::R2, path: None, repo: Some(repo_url.to_string()), volume_serial: None, added_at: now_secs(), extra: Default::default() };
    let repo = dest_repo(ctx, &d)?;
    let cat = run_restic(exec, ctx, &repo, &cat_config_args(), Duration::from_secs(60))?;
    match cat.code {
        0 if !cat.timed_out => {}
        10 => {
            let init = run_restic(exec, ctx, &repo, &init_args(Some((&local.location, &machine_key))), Duration::from_secs(120))?;
            if !init.ok() {
                return Err(BackupError::precondition(format!("cannot create the R2 repository: {}", tail(&init.stderr))));
            }
        }
        _ => return Err(BackupError::precondition(format!("cannot use the R2 repository: {}", describe_exit(&cat)))),
    }
    record_recovery_key(ctx, exec, &mut st, &name, &repo, rk.as_deref())?;
    cfg.destinations.push(d.clone());
    config::save(&ctx.paths.conf_file(), &cfg)?;
    st.destinations.insert(name.clone(), DestState { reachable: true, ok: true, ..Default::default() });
    st.save_in(ctx)?;
    let escrow_warning = super::escrow::ensure_on(ctx, &d, super::escrow::real_put().as_ref()).err();
    Ok(json!({ "name": name, "repo": repo_url, "pendingCopy": true, "escrowWarning": escrow_warning }))
}

/// Forget a destination. Its data is left alone (the owner may still need that drive).
pub fn remove(ctx: &BackupCtx, name: &str) -> BResult<Value> {
    let mut cfg = config::load(&ctx.paths.conf_file())?;
    let before = cfg.destinations.len();
    cfg.destinations.retain(|d| d.name != name);
    if cfg.destinations.len() == before {
        return Err(BackupError::usage(format!("no destination named '{name}'")));
    }
    config::save(&ctx.paths.conf_file(), &cfg)?;
    let mut st = BackupState::load_in(&ctx.paths, now_secs())?;
    st.destinations.remove(name);
    if let Some(rk) = st.recovery_key.as_mut() {
        rk.key_ids.remove(name);
    }
    st.save_in(ctx)?;
    Ok(json!({ "removed": name }))
}

/// Per-destination health for `dest check` and `dest list`.
pub fn check(ctx: &BackupCtx, exec: &dyn Exec, only: Option<&str>) -> BResult<Value> {
    let cfg = config::load(&ctx.paths.conf_file())?;
    let mut out = Vec::new();
    // one repository that cannot be read (locked by a prune, R2 settings missing) must not hide the others
    let mut broken = Vec::new();
    for d in cfg.destinations.iter().filter(|d| only.is_none_or(|n| n == d.name)) {
        let pr = probe(d);
        let reach = pr == Reach::Up;
        let mut entry = json!({ "name": d.name, "kind": d.kind, "location": d.location(), "reachable": reach, "foreign": pr == Reach::Foreign });
        if reach {
            let looked = dest_repo(ctx, d).and_then(|repo| run_restic(exec, ctx, &repo, &cat_config_args(), Duration::from_secs(60)));
            match looked {
                Ok(cat) => {
                    entry["opens"] = json!(cat.ok());
                    entry["detail"] = json!(describe_exit(&cat));
                    if d.kind == DestKind::Device {
                        entry["freeBytes"] = json!(free_bytes(Path::new(d.location())).ok());
                    }
                }
                Err(e) => {
                    broken.push(json!({ "dest": d.name, "error": "failed", "detail": e.message }));
                    continue;
                }
            }
        }
        out.push(entry);
    }
    if let Some(n) = only {
        if out.is_empty() {
            return Err(BackupError::usage(format!("no destination named '{n}'")));
        }
    }
    Ok(json!({ "destinations": out, "broken": broken }))
}

/// Drives the owner could choose, for the status screen picker.
#[cfg(windows)]
pub fn candidates(system_drive: char) -> Value {
    let list: Vec<Value> = logical_drives()
        .into_iter()
        .filter(|l| !l.eq_ignore_ascii_case(&system_drive))
        .map(|l| {
            let kind = drive_kind(l);
            let (usable, reason) = match kind {
                DriveKind::Removable => (true, "removable drive"),
                DriveKind::Fixed => (true, "internal disk: confirm it is a separate physical drive"),
                DriveKind::Remote => (false, "mapped network drive: network shares are not supported"),
                DriveKind::Other => (false, "not available"),
            };
            json!({ "letter": l.to_string(), "kind": format!("{kind:?}").to_lowercase(), "usable": usable, "reason": reason,
                    "freeBytes": free_bytes(Path::new(&format!("{l}:\\"))).ok() })
        })
        .collect();
    json!({ "candidates": list })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::util::fake::{test_ctx, FakeExec};
    use crate::envelope::Code;

    const DATA: &str = r"C:\ProgramData\SupermarketPOS";
    const PF: &str = r"C:\Program Files\SupermarketPOS";

    fn v(p: &str, kind: Option<DriveKind>, fixed: bool) -> Result<PathBuf, String> {
        validate_device_path(p, Path::new(DATA), Path::new(PF), 'C', kind, fixed)
    }

    #[test]
    fn a_usb_drive_root_gets_a_dedicated_folder() {
        assert_eq!(v(r"E:\", Some(DriveKind::Removable), false).unwrap(), Path::new(r"E:\SupermarketPOS-Backup"));
        assert_eq!(v("e:/pos/b", Some(DriveKind::Removable), false).unwrap(), Path::new(r"E:\pos\b"));
    }

    #[test]
    fn the_system_drive_mapped_drives_and_unknown_drives_are_refused_with_advice() {
        assert!(v(r"C:\backup", Some(DriveKind::Fixed), true).unwrap_err().contains("system drive"));
        assert!(v(r"Z:\b", Some(DriveKind::Remote), false).unwrap_err().contains("network shares are not supported"));
        assert!(v(r"Q:\b", Some(DriveKind::Other), false).is_err());
        assert!(v(r"Q:\b", None, false).is_err());
    }

    #[test]
    fn a_second_internal_disk_needs_an_explicit_confirmation() {
        assert!(v(r"D:\b", Some(DriveKind::Fixed), false).unwrap_err().contains("--allow-fixed"));
        assert!(v(r"D:\b", Some(DriveKind::Fixed), true).is_ok());
    }

    #[test]
    fn network_shares_and_every_unc_style_spelling_are_refused_in_v1() {
        let me = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "THISPC".into());
        let own = format!(r"\\{me}\s");
        let msg = "network shares are not supported; use a USB drive or R2";
        for p in [r"\\nas\backups", r"\\nas\backups\pos", r"\\nas", "//nas/backups", r"\\?\E:\b", r"\\?\UNC\nas\s\b", r"\\.\E:\b", r"\\localhost\s", r"\\127.0.0.1\s", own.as_str()] {
            assert_eq!(v(p, Some(DriveKind::Removable), true).unwrap_err(), msg, "{p}");
        }
    }

    #[test]
    fn relative_empty_and_dotdot_paths_are_refused() {
        assert!(v(r"backups", None, false).is_err());
        assert!(v(r"E:\a\..\..\x", Some(DriveKind::Removable), false).is_err());
        assert!(v("", Some(DriveKind::Removable), false).is_err());
    }

    #[test]
    fn nothing_inside_the_data_or_program_folders_is_a_destination_but_a_sibling_name_is() {
        let data = Path::new(r"E:\ProgramData\SupermarketPOS");
        let chk = |p: &str| validate_device_path(p, data, Path::new(PF), 'C', Some(DriveKind::Fixed), true);
        assert!(chk(r"E:\ProgramData\SupermarketPOS\x").is_err());
        assert!(chk(r"E:\ProgramData\SupermarketPOS").is_err());
        assert!(chk(r"E:\programdata\supermarketpos\x").is_err());
        assert!(chk(r"E:\ProgramData\SupermarketPOS-Backup").is_ok());
    }

    #[test]
    fn the_volume_serial_is_formatted_like_vol_shows_it() {
        assert_eq!(format_vol_serial(0x1A2B_3C4D), "1A2B-3C4D");
        assert_eq!(format_vol_serial(0x0000_00AF), "0000-00AF");
    }

    #[cfg(windows)]
    #[test]
    fn the_system_drive_is_a_fixed_disk_with_a_serial_and_unused_letters_have_none() {
        assert_eq!(drive_kind('C'), DriveKind::Fixed);
        assert!(logical_drives().contains(&'C'));
        let s = volume_serial('C').expect("C: has a serial");
        assert_eq!(s.len(), 9);
        let unused = ('D'..='Z').rev().find(|l| !logical_drives().contains(l)).expect("a free letter");
        assert_eq!(volume_serial(unused), None);
        assert_eq!(drive_kind(unused), DriveKind::Other);
    }

    #[test]
    fn the_probe_writes_reads_back_and_cleans_up() {
        let d = tempfile::tempdir().unwrap();
        probe_write(d.path()).unwrap();
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
        assert!(probe_write(&d.path().join("missing")).is_err());
    }

    fn fixture() -> (tempfile::TempDir, BackupCtx, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let mut c = test_ctx();
        c.paths = crate::backup::paths::BackupPaths::from_roots(&crate::paths::Roots::custom(d.path().join("d"), d.path().join("p")));
        for p in [c.paths.secrets(), c.paths.backups(), c.paths.backups_tmp(), c.paths.state_dir(), c.paths.conf_file().parent().unwrap().to_path_buf()] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(c.paths.conf_file(), r#"{"schema":1}"#).unwrap();
        let usb = d.path().join("usb");
        (d, c, usb)
    }

    #[test]
    fn an_empty_folder_becomes_a_repository_that_copies_the_local_chunker_parameters() {
        let (_d, c, usb) = fixture();
        let exec = FakeExec::default().on("cat config", 10, "");
        let out = add_device_validated(&c, &exec, usb.clone(), Some("usb-e".into()), None, Some("1A2B-3C4D".into())).unwrap();
        assert_eq!(out["name"], "usb-e");
        let init = exec.calls.borrow().iter().find(|l| l.contains("--copy-chunker-params")).cloned().expect("init with chunker params");
        assert!(init.contains(&usb.to_string_lossy().to_string()));
        let cfg = crate::backup::config::load(&c.paths.conf_file()).unwrap();
        assert_eq!(cfg.destinations[0].volume_serial.as_deref(), Some("1A2B-3C4D"));
        let st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        assert!(st.destinations["usb-e"].reachable);
    }

    #[test]
    fn a_folder_with_foreign_files_is_never_initialised() {
        let (_d, c, usb) = fixture();
        std::fs::create_dir_all(&usb).unwrap();
        std::fs::write(usb.join("family-photos.zip"), b"x").unwrap();
        let exec = FakeExec::default().on("cat config", 10, "");
        let e = add_device_validated(&c, &exec, usb.clone(), None, None, None).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        let usb_s = usb.to_string_lossy().to_string();
        assert!(exec.calls.borrow().iter().all(|l| !(l.contains(&usb_s) && l.contains(" init"))), "init must not run on the foreign folder");
        assert!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
    }

    #[test]
    fn a_repository_with_another_key_is_refused_unless_the_recovery_key_is_supplied() {
        let (_d, c, usb) = fixture();
        std::fs::create_dir_all(&usb).unwrap();
        let exec = FakeExec::default().on("cat config", 12, "");
        let e = add_device_validated(&c, &exec, usb.clone(), None, None, None).unwrap_err();
        assert!(e.message.contains("recovery key"));
        let exec2 = FakeExec::default().on("cat config", 12, "").on("key add", 0, "saved new key with ID dddd4444\n");
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        add_device_validated(&c, &exec2, usb.clone(), None, Some(rk.clone()), None).unwrap();
        assert!(exec2.index_of("key add").is_some());
        // the recovery key travels in the child's environment, never on the command line
        assert!(exec2.calls.borrow().iter().all(|l| !l.contains(&rk)));
        let (_d2, c2, usb2) = fixture();
        std::fs::create_dir_all(&usb2).unwrap();
        let bad = add_device_validated(&c2, &exec, usb2, None, Some("not-a-key".into()), None).unwrap_err();
        assert_eq!(bad.code, Code::Usage);
    }

    #[test]
    fn removing_a_destination_forgets_it_but_never_touches_its_data() {
        let (_d, c, usb) = fixture();
        let exec = FakeExec::default().on("cat config", 10, "");
        let n = add_device_validated(&c, &exec, usb.clone(), Some("usb-e".into()), None, None).unwrap()["name"].as_str().unwrap().to_string();
        std::fs::write(usb.join("keep.txt"), b"x").unwrap();
        remove(&c, &n).unwrap();
        assert!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
        assert!(usb.join("keep.txt").exists());
        assert_eq!(remove(&c, &n).unwrap_err().code, Code::Usage);
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_on_the_system_volume_is_refused_by_serial_even_through_a_junction() {
        let win = crate::sys::known_folder(crate::sys::KnownFolder::Windows).unwrap();
        let system_serial = volume_serial_of_path(&win).expect("the Windows folder has a volume serial");
        // a plain folder under the user's temp (on the system volume on this host; skip the claim when TEMP is elsewhere)
        let t = tempfile::tempdir().unwrap();
        if volume_serial_of_path(t.path()) == Some(system_serial) {
            let e = refuse_system_volume(t.path(), &win).unwrap_err();
            assert_eq!(e.code, Code::Precondition);
        }
        // a folder that does not exist cannot be proven safe: refuse (fail closed)
        assert!(refuse_system_volume(&t.path().join("missing"), &win).is_err());
        // a junction that lives on another volume but points onto the system volume (needs a second volume and no elevation)
        let other = Path::new(r"D:\tmp");
        if other.is_dir() && volume_serial_of_path(other) != Some(system_serial) && volume_serial_of_path(t.path()) == Some(system_serial) {
            let off = tempfile::tempdir_in(other).unwrap();
            let link = off.path().join("link");
            let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &t.path().display().to_string()]).output().unwrap();
            assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stdout));
            assert!(refuse_system_volume(&link, &win).is_err(), "the link target is on the system volume");
            assert!(refuse_system_volume(off.path(), &win).is_ok(), "a plain folder on the other volume is fine");
        }
    }

    fn mark_recovery_key_issued(c: &BackupCtx) {
        let st = BackupState { first_seen_at: 1, recovery_key: Some(crate::backup::state::RecoveryKeyRef { issued_at: 1, key_ids: [("local".to_string(), "aaaa1111".to_string())].into() }), ..Default::default() };
        st.save_in(c).unwrap();
        std::fs::write(c.paths.machine_key(), crate::backup::keys::generate_machine_key().unwrap()).unwrap();
        std::fs::create_dir_all(c.paths.repo()).unwrap();
        std::fs::write(c.paths.repo().join("config"), b"x").unwrap();
    }

    #[test]
    fn once_a_recovery_key_exists_a_new_destination_needs_it_and_without_it_nothing_is_added() {
        let (_d, c, usb) = fixture();
        mark_recovery_key_issued(&c);
        let exec = FakeExec::default().on("cat config", 10, "");
        let e = add_device_validated(&c, &exec, usb.clone(), Some("usb-e".into()), None, None).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(e.message.contains("recovery key"), "{}", e.message);
        assert!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
        let usb_s = usb.to_string_lossy().to_string();
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&usb_s)), "the drive must not be touched");
        let st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        assert!(!st.destinations.contains_key("usb-e"));
    }

    #[test]
    fn the_recovery_key_is_added_to_the_new_repository_and_its_id_recorded() {
        let (_d, c, usb) = fixture();
        mark_recovery_key_issued(&c);
        let local_cat = format!("{} cat config", c.paths.repo().display());
        let exec = FakeExec::default().on(&local_cat, 0, "").on("cat config", 10, "").on("key add", 0, "saved new key with ID 9a8b7c6d\n");
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        add_device_validated(&c, &exec, usb.clone(), Some("usb-e".into()), Some(rk.clone()), None).unwrap();
        let st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        assert_eq!(st.recovery_key.unwrap().key_ids.get("usb-e").map(String::as_str), Some("9a8b7c6d"));
        assert_eq!(exec.count_of("key add"), 1);
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&rk)), "the key must not appear on argv");
        assert_eq!(std::fs::read_dir(c.paths.backups_tmp()).unwrap().count(), 0, "no key file may remain");
    }

    #[test]
    fn an_s3_address_with_credentials_is_refused_without_echoing_it_and_nothing_is_written() {
        let (_d, c, _usb) = fixture();
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k
").unwrap();
        let before = std::fs::read(c.paths.conf_file()).unwrap();
        let exec = FakeExec::default().on("cat config", 10, "");
        for url in ["s3:https://AKIAEXAMPLE:topsecretvalue@h.example/b/f", "s3:https://user@h.example/b"] {
            let e = add_r2(&c, &exec, Some("cloud".into()), url, None).unwrap_err();
            assert_eq!(e.code, Code::Usage, "{url}");
            assert!(!e.message.contains("topsecretvalue") && !e.message.contains("AKIAEXAMPLE") && !e.message.contains("h.example"), "never echoed: {}", e.message);
        }
        assert_eq!(std::fs::read(c.paths.conf_file()).unwrap(), before, "posctl.json is untouched");
        assert!(exec.calls.borrow().is_empty(), "no tool ran");
    }

    #[test]
    fn dest_check_lists_a_destination_it_cannot_read_under_broken_and_still_lists_the_others() {
        let (d, c, _usb) = fixture();
        let up = d.path().join("up");
        std::fs::create_dir_all(&up).unwrap();
        std::fs::write(up.join("config"), b"x").unwrap();
        let mk = |n: &str, kind: DestKind, path: Option<String>, repo: Option<String>| Destination { name: n.into(), kind, path, repo, volume_serial: None, added_at: 1, extra: Default::default() };
        let mut cfg = crate::backup::config::load(&c.paths.conf_file()).unwrap();
        // no secrets2.env: the R2 repository cannot even be opened
        cfg.destinations = vec![mk("cloud", DestKind::R2, None, Some("s3:https://h.example/b/f".into())), mk("usb-e", DestKind::Device, Some(up.display().to_string()), None)];
        crate::backup::config::save(&c.paths.conf_file(), &cfg).unwrap();
        let exec = FakeExec::default().on("cat config", 0, "");
        let v = check(&c, &exec, None).unwrap();
        assert_eq!(v["destinations"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect::<Vec<_>>(), ["usb-e"]);
        assert_eq!(v["broken"].as_array().unwrap().len(), 1);
        assert_eq!(v["broken"][0]["dest"], "cloud");
        assert_eq!(v["broken"][0]["error"], "failed");
    }

    #[test]
    fn at_most_eight_destinations_so_the_weekly_verify_stays_inside_its_task_limit() {
        let (_d, c, _usb) = fixture();
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k\n").unwrap();
        let mut cfg = crate::backup::config::load(&c.paths.conf_file()).unwrap();
        for i in 0..MAX_DESTINATIONS {
            cfg.destinations.push(Destination { name: format!("d{i}"), kind: DestKind::Device, path: Some(format!("E:\\d{i}")), repo: None, volume_serial: None, added_at: 1, extra: Default::default() });
        }
        crate::backup::config::save(&c.paths.conf_file(), &cfg).unwrap();
        let exec = FakeExec::default().on("cat config", 10, "");
        let e = add_r2(&c, &exec, Some("cloud".into()), "s3:https://h.example/b/f", None).unwrap_err();
        assert_eq!(e.code, Code::Precondition, "a full house is a state of the store, not a typo");
        assert!(e.message.contains(&MAX_DESTINATIONS.to_string()), "{}", e.message);
        assert_eq!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.len(), MAX_DESTINATIONS, "nothing was added");
    }

    #[test]
    fn an_r2_destination_added_after_key_export_needs_the_recovery_key_too() {
        let (_d, c, _usb) = fixture();
        mark_recovery_key_issued(&c);
        std::fs::write(c.paths.r2_env(), "AWS_ACCESS_KEY_ID=k\n").unwrap();
        let local_cat = format!("{} cat config", c.paths.repo().display());
        let url = "s3:https://h.example/b/f";
        let exec = FakeExec::default().on(&local_cat, 0, "").on("cat config", 10, "").on("key add", 0, "saved new key with ID 1a2b3c4d\n");
        let e = add_r2(&c, &exec, Some("cloud".into()), url, None).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        add_r2(&c, &exec, Some("cloud".into()), url, Some(rk.clone())).unwrap();
        let st = BackupState::load(&c.paths.state_file(), 0).unwrap();
        assert_eq!(st.recovery_key.unwrap().key_ids.get("cloud").map(String::as_str), Some("1a2b3c4d"));
        assert!(exec.calls.borrow().iter().all(|l| !l.contains(&rk)), "the key must not appear on argv");
    }

    #[test]
    fn a_recovery_key_that_does_not_open_the_local_repository_is_refused_and_nothing_is_added() {
        let (_d, c, usb) = fixture();
        mark_recovery_key_issued(&c);
        let local_cat = format!("{} cat config", c.paths.repo().display());
        let exec = FakeExec::default().on(&local_cat, 12, "").on("cat config", 10, "");
        let rk = crate::backup::keys::new_recovery_key().unwrap();
        let e = add_device_validated(&c, &exec, usb.clone(), None, Some(rk), None).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(crate::backup::config::load(&c.paths.conf_file()).unwrap().destinations.is_empty());
        assert_eq!(exec.count_of("key add"), 0);
    }

    #[test]
    fn device_reachability_means_the_repository_marker_file_is_there() {
        let d = tempfile::tempdir().unwrap();
        let dest = Destination { name: "usb".into(), kind: DestKind::Device, path: Some(d.path().to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() };
        assert!(!reachable(&dest));
        std::fs::write(d.path().join("config"), b"x").unwrap();
        assert!(reachable(&dest));
    }

    #[test]
    fn a_volume_serial_mismatch_is_foreign_a_match_or_no_record_is_up() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("config"), b"x").unwrap();
        let mk = |serial: Option<String>| Destination { name: "usb".into(), kind: DestKind::Device, path: Some(d.path().to_string_lossy().into_owned()), repo: None, volume_serial: serial, added_at: 0, extra: Default::default() };
        let have = format_vol_serial(volume_serial_of_path(d.path()).expect("the temp volume has a serial"));
        assert_eq!(probe(&mk(Some(have.to_lowercase()))), Reach::Up, "case does not matter");
        assert_eq!(probe(&mk(None)), Reach::Up);
        let foreign = mk(Some("0000-0000".into()));
        assert_eq!(probe(&foreign), Reach::Foreign);
        assert!(!reachable(&foreign), "a foreign drive is not reachable for copy");
        std::fs::remove_file(d.path().join("config")).unwrap();
        assert_eq!(probe(&mk(None)), Reach::Down);
    }

    #[cfg(windows)]
    fn mklink_j(link: &Path, target: &Path) {
        let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
        assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stdout));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_planted_at_the_repo_folder_or_above_it_is_foreign_not_up() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join("real");
        std::fs::create_dir_all(real.join("repo")).unwrap();
        std::fs::write(real.join("repo").join("config"), b"x").unwrap();
        assert_eq!(device_state_with(&real.join("repo"), None, None), Reach::Up, "a plain folder is up");
        let link = t.path().join("link");
        mklink_j(&link, &real.join("repo"));
        assert_eq!(device_state_with(&link, None, None), Reach::Foreign, "the repo folder is a junction");
        let up = t.path().join("up");
        mklink_j(&up, &real);
        assert_eq!(device_state_with(&up.join("repo"), None, None), Reach::Foreign, "a folder above the repo is a junction");
    }

    #[cfg(windows)]
    #[test]
    fn a_repo_on_the_system_volume_is_foreign_at_run_time() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("config"), b"x").unwrap();
        let here = volume_serial_of_path(d.path()).expect("the temp volume has a serial");
        assert_eq!(device_state_with(d.path(), None, Some(here)), Reach::Foreign, "same serial as the system volume");
        assert_eq!(device_state_with(d.path(), None, Some(here ^ 1)), Reach::Up, "another system volume leaves it up");
    }

    #[cfg(windows)]
    #[test]
    fn building_the_repository_of_a_junctioned_device_destination_is_refused() {
        let (_d, c, usb) = fixture();
        let real = tempfile::tempdir().unwrap();
        let link = real.path().join("link");
        mklink_j(&link, &usb);
        let d = Destination { name: "usb".into(), kind: DestKind::Device, path: Some(link.to_string_lossy().into_owned()), repo: None, volume_serial: None, added_at: 0, extra: Default::default() };
        let e = dest_repo(&c, &d).unwrap_err();
        assert_eq!(e.code, Code::Precondition);
        assert!(dest_repo(&c, &Destination { path: Some(usb.to_string_lossy().into_owned()), ..d }).is_ok(), "the real folder is fine");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_deep_in_the_repo_is_foreign_and_a_full_repo_walk_is_fast() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        for d in ["keys", "locks", "snapshots", "index"] {
            std::fs::create_dir_all(repo.join(d)).unwrap();
        }
        std::fs::write(repo.join("config"), b"x").unwrap();
        for i in 0..256 {
            let d = repo.join("data").join(format!("{i:02x}"));
            std::fs::create_dir_all(&d).unwrap();
            for f in 0..20 {
                std::fs::write(d.join(format!("pack{f}")), b"p").unwrap();
            }
        }
        assert_eq!(device_state_with(&repo, None, None), Reach::Up, "a plain repo is up");
        let real = t.path().join("elsewhere");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::remove_dir_all(repo.join("data").join("7f")).unwrap();
        mklink_j(&repo.join("data").join("7f"), &real);
        assert_eq!(device_state_with(&repo, None, None), Reach::Foreign, "a junction at data/7f");
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_repo_folder_is_judged_by_the_drive_it_would_be_on() {
        let d = tempfile::tempdir().unwrap();
        let missing = d.path().join("SupermarketPOS-Backup"); // a blank drive that got the letter: the folder is not there
        let have = format_vol_serial(volume_serial_of_path(d.path()).expect("the temp volume has a serial"));
        // another drive in the recorded one's place: foreign, although the folder does not exist
        assert_eq!(device_state_with(&missing, Some("0000-0000"), None), Reach::Foreign);
        // the recorded drive, folder simply absent: down, as before
        assert_eq!(device_state_with(&missing, Some(&have), None), Reach::Down);
        assert_eq!(device_state_with(&missing, None, None), Reach::Down);
        // a missing folder on the system volume is refused too
        assert_eq!(device_state_with(&missing, None, volume_serial_of_path(d.path())), Reach::Foreign);
        // the drive itself is gone (unplugged): down, with no drive to compare
        if let Some(l) = ('D'..='Z').rev().find(|l| !Path::new(&format!("{l}:{}", chr_backslash())).exists()) {
            assert_eq!(device_state_with(&PathBuf::from(format!("{l}:{}SupermarketPOS-Backup", chr_backslash())), Some("0000-0000"), None), Reach::Down);
        }
    }

    #[cfg(windows)]
    fn chr_backslash() -> char {
        char::from(92u8)
    }

    #[test]
    fn only_ntfs_gets_no_filesystem_warning() {
        assert_eq!(fs_warning("NTFS"), None);
        assert_eq!(fs_warning("ntfs"), None);
        for fs in ["FAT32", "exFAT", "FAT", "ReFS"] {
            let w = fs_warning(fs).unwrap_or_else(|| panic!("{fs}"));
            assert!(w.contains(&format!("this drive is {fs}")) && w.contains("power cut while writing can corrupt it") && w.contains("NTFS is safer"), "{w}");
        }
        assert_eq!(fs_warning(""), None, "unknown is not a reason to warn");
    }

    #[test]
    fn the_add_result_carries_the_filesystem_warning_list() {
        let (_d, c, usb) = fixture();
        let exec = FakeExec::default().on("cat config", 10, "");
        let out = add_device_validated(&c, &exec, usb.clone(), Some("usb-e".into()), None, None).unwrap();
        let expect: Vec<String> = volume_fs_of_path(&usb).and_then(|f| fs_warning(&f)).into_iter().collect();
        assert_eq!(out["warnings"], serde_json::json!(expect));
    }

    #[test]
    fn the_reachability_wait_is_15_seconds() {
        assert_eq!(REACH_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn a_destination_added_after_key_export_receives_the_escrow_file() {
        let (d, c, usb) = fixture();
        crate::backup::escrow::publish(&c, b"cipher", &[], crate::backup::escrow::real_put().as_ref()).unwrap();
        let exec = FakeExec::default().on("cat config", 10, "");
        let out = add_device_validated(&c, &exec, usb, Some("usb-e".into()), None, None).unwrap();
        assert!(out["escrowWarning"].is_null());
        assert_eq!(std::fs::read(d.path().join("escrow.age")).unwrap(), b"cipher");
    }
}
