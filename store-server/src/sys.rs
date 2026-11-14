//! Windows facts that must not come from the environment, and the Job Object used to kill a tool's
//! whole process tree. An elevated process must not trust `%ProgramData%` / `%ProgramFiles%` /
//! `%SystemRoot%`, which the invoking user's environment can override. This is the only module
//! allowed `unsafe`; it must never read an environment variable to locate a system folder.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownFolder {
    ProgramFiles,
    ProgramData,
    System,
    Windows,
}

/// `SHGetKnownFolderPath` on Windows; the conventional path elsewhere (dev/test machines). Fails
/// closed: an elevated process must not guess a system folder, so any API failure is an error.
pub fn known_folder(which: KnownFolder) -> Result<PathBuf, String> {
    imp::known_folder(which)
}

/// `C:\Windows\System32`, from the API (never `%SystemRoot%`).
pub fn system_dir() -> Result<PathBuf, String> {
    known_folder(KnownFolder::System)
}

pub use imp::{
    listening_tcp_ports, create_dir_with_sddl, open_trust, free_disk_bytes, is_elevated, path_acl, path_owner_sid, registry_key_sddl, service_bin_path, service_start_type, service_status,
    set_path_security, set_registry_key_dacl, wait_to_kill_delete, wait_to_kill_get, wait_to_kill_set,
};

/// One ACE of a DACL as read back from the OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ace {
    /// `ACCESS_ALLOWED_ACE_TYPE`; anything else (deny, object, ...) is `false`.
    pub allow: bool,
    /// `AceFlags` (OI 0x1, CI 0x2, INHERITED 0x10, ...).
    pub flags: u8,
    pub mask: u32,
    pub sid: String,
}

/// The DACL of a file or folder: `SE_DACL_PROTECTED` and the ACEs in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathAcl {
    pub protected: bool,
    pub aces: Vec<Ace>,
}

/// Everything a trust decision needs about one path, read from ONE handle opened without following
/// a reparse point (no window between "is it a link?" and "who owns it?").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleInfo {
    pub reparse: bool,
    pub is_dir: bool,
    pub owner: String,
    pub acl: PathAcl,
}

/// `SERVICE_STATUS`: current state and the exit codes of the last run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScmStatus {
    pub state: u32,
    pub win32_exit: u32,
    pub specific_exit: u32,
}

/// `dwCurrentState` of a service from the SCM, or `None` when it is not installed.
pub fn service_state_number(name: &str) -> Result<Option<u32>, String> {
    Ok(service_status(name)?.map(|s| s.state))
}

/// A `WaitToKillServiceTimeout` read: absent is `None`, a value of the wrong registry type
/// (`ERROR_BAD_FILE_TYPE`, e.g. a REG_DWORD) is garbage and reads as the empty text (the caller then
/// raises it to 30000 and restores by deleting), any other failure stays an error.
pub fn wait_to_kill_from(r: std::io::Result<String>) -> Result<Option<String>, String> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.raw_os_error() == Some(222) => Ok(Some(String::new())),
        Err(e) => Err(format!("cannot read WaitToKillServiceTimeout: {e}")),
    }
}

/// State of one service from the SCM API (no text parsing: `sc query` labels are localized).
pub fn service_state(name: &str) -> Result<crate::services::ServiceState, String> {
    Ok(match service_state_number(name)? {
        None => crate::services::ServiceState::NotInstalled,
        Some(n) => crate::services::ServiceState::from_scm(n),
    })
}

/// `HKLM\SYSTEM\CurrentControlSet\Services\<service>\Environment` (REG_MULTI_SZ) is where the
/// Functions secrets live: SCM hands the values to the service process, no file and no command
/// line ever carries them, and the key's ACL is SYSTEM and Administrators only.
pub const SERVICE_KEY_DACL_SDDL: &str = "D:P(A;OICI;KA;;;SY)(A;OICI;KA;;;BA)";

pub fn service_registry_path(service: &str) -> String {
    format!("SYSTEM\\CurrentControlSet\\Services\\{service}")
}

/// Write `KEY=value` entries as one REG_MULTI_SZ value under `<hive>\<subkey>`.
#[cfg(windows)]
pub fn write_multi_sz(hive: &winreg::RegKey, subkey: &str, name: &str, entries: &[String]) -> Result<(), String> {
    use winreg::enums::KEY_SET_VALUE;
    use winreg::types::ToRegValue;
    let key = hive.open_subkey_with_flags(subkey, KEY_SET_VALUE).map_err(|e| format!("cannot open {subkey}: {e}"))?;
    key.set_raw_value(name, &entries.to_vec().to_reg_value()).map_err(|e| format!("cannot write {name}: {e}"))
}

#[cfg(windows)]
pub fn read_multi_sz(hive: &winreg::RegKey, subkey: &str, name: &str) -> Result<Vec<String>, String> {
    use winreg::enums::KEY_READ;
    let key = hive.open_subkey_with_flags(subkey, KEY_READ).map_err(|e| format!("cannot open {subkey}: {e}"))?;
    key.get_value::<Vec<String>, _>(name).map_err(|e| format!("cannot read {name}: {e}"))
}

/// Production entry point: protect the service key, then write the Functions environment.
#[cfg(windows)]
pub fn set_service_environment(service: &str, entries: &[String]) -> Result<(), String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let hklm = winreg::RegKey::predef(HKEY_LOCAL_MACHINE);
    let sub = service_registry_path(service);
    set_registry_key_dacl(&format!("MACHINE\\{sub}"), SERVICE_KEY_DACL_SDDL)?;
    write_multi_sz(&hklm, &sub, "Environment", entries)
}
#[cfg(not(windows))]
pub fn set_service_environment(_: &str, _: &[String]) -> Result<(), String> {
    Err("Windows only".into())
}

/// `SetThreadExecutionState`: `true` = `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (the PC may not sleep), `false` = `ES_CONTINUOUS` (back to
/// normal). The state belongs to the CALLING THREAD, so the thread that sets it must be the one that clears it (`awake::KeepAwake`).
/// A no-op off Windows. Tests never reach this: they run on the fake `Deps::keep_awake`.
#[cfg(windows)]
pub fn set_thread_awake(on: bool) {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    // SAFETY: takes a flag set by value, touches no memory; the previous state it returns is of no use here.
    let _ = unsafe { SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS }) };
}
#[cfg(not(windows))]
pub fn set_thread_awake(_: bool) {}

/// Seconds since the PC booted (`GetTickCount64`); `None` off Windows. The health task uses it to tell "the lockout
/// canary last ran before this boot" from "it ran since".
#[cfg(windows)]
pub fn uptime_secs() -> Option<u64> {
    // SAFETY: GetTickCount64 takes no arguments and cannot fail.
    Some(unsafe { windows::Win32::System::SystemInformation::GetTickCount64() } / 1000)
}
#[cfg(not(windows))]
pub fn uptime_secs() -> Option<u64> {
    None
}

/// Who a running process is: its full image path and its creation time (FILETIME ticks). A pid alone is reused by
/// Windows; the pair is what says "this is still the process we started".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcIdentity {
    pub image: String,
    pub created: u64,
}

/// The identity of `pid`; `Ok(None)` when no such process is running (never started, or exited), `Err` when the
/// lookup itself failed (access denied, API error): the caller must not read that as "gone".
pub fn process_identity(pid: u32) -> Result<Option<ProcIdentity>, String> {
    imp::process_identity(pid)
}

/// The creation time of a child we just spawned, read from its own handle (no pid-reuse window).
pub fn child_creation_time(child: &std::process::Child) -> Result<u64, String> {
    imp::child_creation_time(child)
}

pub use imp::{clear_std_handle_inheritance, Job};

#[cfg(windows)]
mod imp {
    use super::{Ace, KnownFolder, PathAcl};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use windows::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use std::path::Path;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT, SE_OBJECT_TYPE, SE_REGISTRY_KEY,
    };
    use windows::Win32::Security::{
        AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, GetTokenInformation, TokenElevation, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::Security::Authorization::GetSecurityInfo;
    use windows::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, GetDiskFreeSpaceExW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAGS_AND_ATTRIBUTES,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW, QueryServiceStatus, QUERY_SERVICE_CONFIGW,
        SC_MANAGER_CONNECT, SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS, SERVICE_STATUS,
    };
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_System, FOLDERID_Windows, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
    };

    pub fn known_folder(which: KnownFolder) -> Result<PathBuf, String> {
        let id = match which {
            KnownFolder::ProgramFiles => &FOLDERID_ProgramFiles,
            KnownFolder::ProgramData => &FOLDERID_ProgramData,
            KnownFolder::System => &FOLDERID_System,
            KnownFolder::Windows => &FOLDERID_Windows,
        };
        // SAFETY: the returned PWSTR is valid until freed; it is copied out and freed exactly once.
        let s = unsafe {
            let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None)
                .map_err(|e| format!("SHGetKnownFolderPath({which:?}) failed: {e}"))?;
            let s = p.to_string();
            CoTaskMemFree(Some(p.0 as *const _));
            s.map_err(|e| format!("known folder {which:?} is not valid Unicode: {e}"))?
        };
        let path = PathBuf::from(s);
        if path.is_absolute() {
            Ok(path)
        } else {
            Err(format!("known folder {which:?} resolved to a relative path"))
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn pwstr_to_string(p: PWSTR) -> String {
        // SAFETY: `p` is a NUL-terminated wide string returned by the OS.
        unsafe { p.to_string().unwrap_or_default() }
    }

    /// True when this process runs with an elevated token (an Administrator, not just a member).
    pub fn is_elevated() -> bool {
        // SAFETY: standard token query on the current process; the handle is closed below.
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION::default();
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
            .is_ok();
            let _ = CloseHandle(token);
            ok && elevation.TokenIsElevated != 0
        }
    }

    /// Local ports of every TCP listener (IPv4 and IPv6, any address), from the OS listener table.
    pub fn listening_tcp_ports() -> Result<Vec<u16>, String> {
        use windows::Win32::NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        };
        const AF_INET: u32 = 2;
        const AF_INET6: u32 = 23;
        let mut out = Vec::new();
        for (family, row_size) in [(AF_INET, std::mem::size_of::<MIB_TCPROW_OWNER_PID>()), (AF_INET6, std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>())] {
            let mut buf: Vec<u64> = vec![0; 512];
            loop {
                let mut size = (buf.len() * 8) as u32;
                // SAFETY: `buf` is 8-aligned and `size` bytes long; both outlive the call.
                let rc = unsafe { GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) };
                match rc {
                    0 => break,
                    122 => buf.resize((size as usize).div_ceil(8) + 64, 0), // ERROR_INSUFFICIENT_BUFFER: the table grew
                    e => return Err(format!("GetExtendedTcpTable(family {family}) failed: {e}")),
                }
            }
            // SAFETY: on success the buffer holds a u32 entry count followed by that many fixed-size rows.
            let base = buf.as_ptr().cast::<u8>();
            let n = unsafe { base.cast::<u32>().read() } as usize;
            for i in 0..n {
                // dwLocalPort is the second u32 of both row layouts (state, local addr/port differ: v4 = state,addr,port; v6 = addr[16],scope,port)
                let off = 4 + i * row_size;
                let port_off = if family == AF_INET { off + 8 } else { off + 20 };
                // SAFETY: the OS wrote `n` rows of `row_size` bytes; the port field lies inside each row.
                let raw = unsafe { base.add(port_off).cast::<u32>().read_unaligned() };
                out.push(u16::from_be(raw as u16));
            }
        }
        Ok(out)
    }

    /// Free bytes available to the caller on the volume that holds `path`.
    pub fn free_disk_bytes(path: &Path) -> Result<u64, String> {
        let w = wide(&path.display().to_string());
        let mut avail = 0u64;
        // SAFETY: `w` is NUL-terminated and outlives the call; `avail` is a valid out pointer.
        unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut avail), None, None) }
            .map_err(|e| format!("GetDiskFreeSpaceEx failed: {e}"))?;
        Ok(avail)
    }

    /// The owner of a file or folder as a SID string (`S-1-5-32-544`).
    pub fn path_owner_sid(path: &Path) -> Result<String, String> {
        let w = wide(&path.display().to_string());
        let mut owner = PSID::default();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: out pointers are valid; the returned descriptor is freed with LocalFree below.
        unsafe {
            let rc = GetNamedSecurityInfoW(PCWSTR(w.as_ptr()), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, Some(&mut owner), None, None, None, &mut sd);
            if rc.0 != 0 {
                return Err(format!("GetNamedSecurityInfo failed ({})", rc.0));
            }
            let mut s = PWSTR::null();
            let r = ConvertSidToStringSidW(owner, &mut s);
            let out = if r.is_ok() { Ok(pwstr_to_string(s)) } else { Err("ConvertSidToStringSid failed".to_string()) };
            if !s.is_null() {
                let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
            }
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            out
        }
    }

    /// Replace the DACL of a registry key with the one in `sddl` and protect it from inheritance.
    /// `key` uses the `SetNamedSecurityInfo` form: `MACHINE\SYSTEM\...` or `CURRENT_USER\Software\...`.
    pub fn set_registry_key_dacl(key: &str, sddl: &str) -> Result<(), String> {
        set_security(key, SE_REGISTRY_KEY, sddl)
    }

    /// Set the owner (when the SDDL has an `O:`) and replace the DACL of a file or folder, protected,
    /// in ONE `SetNamedSecurityInfo` call: no window in which a planted explicit ACE survives.
    pub fn set_path_security(path: &Path, sddl: &str) -> Result<(), String> {
        set_security(&path.display().to_string(), SE_FILE_OBJECT, sddl)
    }

    fn set_security(object: &str, kind: SE_OBJECT_TYPE, sddl: &str) -> Result<(), String> {
        let k = wide(object);
        let s = wide(sddl);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: both strings are NUL-terminated; the descriptor from the conversion is freed below and
        // the DACL/owner pointers point into it, so they are only used before that free.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(s.as_ptr()), SDDL_REVISION_1, &mut sd, None)
                .map_err(|e| format!("bad SDDL: {e}"))?;
            let mut present = windows::core::BOOL::default();
            let mut defaulted = windows::core::BOOL::default();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut owner = PSID::default();
            let res = GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted)
                .map_err(|e| format!("GetSecurityDescriptorDacl failed: {e}"))
                .and_then(|_| {
                    if !present.as_bool() || dacl.is_null() {
                        return Err("the SDDL carries no DACL".to_string());
                    }
                    GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted).map_err(|e| format!("GetSecurityDescriptorOwner failed: {e}"))?;
                    let mut info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
                    let owner_arg = if owner.0.is_null() {
                        None
                    } else {
                        info |= OWNER_SECURITY_INFORMATION;
                        Some(owner)
                    };
                    let rc = SetNamedSecurityInfoW(PCWSTR(k.as_ptr()), kind, info, owner_arg, None, Some(dacl), None);
                    if rc.0 == 0 { Ok(()) } else { Err(format!("SetNamedSecurityInfo failed ({})", rc.0)) }
                });
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            res
        }
    }

    /// The DACL of a file or folder, ACE by ACE (not SDDL text: aliases and mask names would have to be
    /// parsed back). A NULL DACL (everyone, full control) is an error.
    pub fn path_acl(path: &Path) -> Result<PathAcl, String> {
        let w = wide(&path.display().to_string());
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: out pointers are valid; ACE pointers come from GetAce on the returned ACL and are read
        // before the descriptor is freed with LocalFree.
        unsafe {
            let rc = GetNamedSecurityInfoW(PCWSTR(w.as_ptr()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(&mut dacl), None, &mut sd);
            if rc.0 != 0 {
                return Err(format!("GetNamedSecurityInfo failed ({})", rc.0));
            }
            let out = read_acl(sd, dacl);
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            out
        }
    }

    unsafe fn read_acl(sd: PSECURITY_DESCRIPTOR, dacl: *mut ACL) -> Result<PathAcl, String> {
        const SE_DACL_PROTECTED: u16 = 0x1000;
        let mut control = 0u16;
        let mut revision = 0u32;
        GetSecurityDescriptorControl(sd, &mut control, &mut revision).map_err(|e| format!("GetSecurityDescriptorControl failed: {e}"))?;
        if dacl.is_null() {
            return Err("the object has a NULL DACL (full access for everyone)".to_string());
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        GetAclInformation(dacl, &mut info as *mut _ as *mut core::ffi::c_void, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation)
            .map_err(|e| format!("GetAclInformation failed: {e}"))?;
        let mut aces = Vec::new();
        for i in 0..info.AceCount {
            let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
            GetAce(dacl, i, &mut p).map_err(|e| format!("GetAce({i}) failed: {e}"))?;
            let header = *(p as *const ACE_HEADER);
            // ACCESS_ALLOWED (0) and ACCESS_DENIED (1) share one layout; object ACEs and the rest do not.
            if header.AceType <= 1 {
                let ace = p as *const ACCESS_ALLOWED_ACE;
                let sid = PSID(std::ptr::addr_of!((*ace).SidStart) as *mut _);
                let mut text = PWSTR::null();
                ConvertSidToStringSidW(sid, &mut text).map_err(|e| format!("ConvertSidToStringSid failed: {e}"))?;
                let sid = pwstr_to_string(text);
                let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
                aces.push(Ace { allow: header.AceType == 0, flags: header.AceFlags, mask: (*ace).Mask, sid });
            } else {
                aces.push(Ace { allow: false, flags: header.AceFlags, mask: 0, sid: format!("<ace type {}>", header.AceType) });
            }
        }
        Ok(PathAcl { protected: control & SE_DACL_PROTECTED != 0, aces })
    }

    fn io_win32(code: u32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code as i32)
    }

    /// Open `path` itself (a reparse point is opened, not followed), then read its attributes, owner and
    /// DACL from that one handle. Trust decisions use this, never the by-name query: a name can be
    /// swapped for a junction between two by-name calls.
    pub fn open_trust(path: &Path) -> std::io::Result<super::HandleInfo> {
        const READ_CONTROL: u32 = 0x0002_0000;
        const FILE_READ_ATTRIBUTES: u32 = 0x80;
        const REPARSE: u32 = 0x400;
        const DIRECTORY: u32 = 0x10;
        let w = wide(&path.display().to_string());
        // SAFETY: `w` is NUL-terminated; the handle is closed on every path; the descriptor from
        // GetSecurityInfo is freed with LocalFree after the ACEs were copied out.
        unsafe {
            let h = CreateFileW(
                PCWSTR(w.as_ptr()),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0),
                None,
            )
            .map_err(|e| io_win32((e.code().0 as u32) & 0xFFFF))?;
            let out = (|| {
                let mut info = BY_HANDLE_FILE_INFORMATION::default();
                GetFileInformationByHandle(h, &mut info).map_err(|e| std::io::Error::other(format!("GetFileInformationByHandle failed: {e}")))?;
                let mut owner = PSID::default();
                let mut sd = PSECURITY_DESCRIPTOR::default();
                let mut dacl: *mut ACL = std::ptr::null_mut();
                let rc = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, Some(&mut owner), None, Some(&mut dacl), None, Some(&mut sd));
                if rc.0 != 0 {
                    return Err(std::io::Error::other(format!("GetSecurityInfo failed ({})", rc.0)));
                }
                let acl = read_acl(sd, dacl);
                let mut s = PWSTR::null();
                let owner_text = ConvertSidToStringSidW(owner, &mut s).map(|_| pwstr_to_string(s));
                if !s.is_null() {
                    let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
                }
                let _ = LocalFree(Some(HLOCAL(sd.0)));
                Ok(super::HandleInfo {
                    reparse: info.dwFileAttributes & REPARSE != 0,
                    is_dir: info.dwFileAttributes & DIRECTORY != 0,
                    owner: owner_text.map_err(|e| std::io::Error::other(format!("ConvertSidToStringSid failed: {e}")))?,
                    acl: acl.map_err(std::io::Error::other)?,
                })
            })();
            let _ = CloseHandle(h);
            out
        }
    }

    /// `CreateDirectoryW` with the descriptor from `sddl` (protected DACL, optional owner): the folder
    /// exists with its final ACL from its first instant. `AlreadyExists` is a normal `io::Error`.
    pub fn create_dir_with_sddl(path: &Path, sddl: &str) -> std::io::Result<()> {
        let w = wide(&path.display().to_string());
        let s = wide(sddl);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: both strings are NUL-terminated; `sd` outlives the CreateDirectoryW call and is freed after it.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(s.as_ptr()), SDDL_REVISION_1, &mut sd, None)
                .map_err(|e| std::io::Error::other(format!("bad SDDL: {e}")))?;
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
            let r = CreateDirectoryW(PCWSTR(w.as_ptr()), Some(&sa));
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            r.map_err(|e| io_win32((e.code().0 as u32) & 0xFFFF))
        }
    }

    /// The DACL of a registry key as an SDDL string (used by the audit and by the test).
    pub fn registry_key_sddl(key: &str) -> Result<String, String> {
        let k = wide(key);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: out pointers are valid; the descriptor and the string are freed with LocalFree.
        unsafe {
            let rc = GetNamedSecurityInfoW(PCWSTR(k.as_ptr()), SE_REGISTRY_KEY, DACL_SECURITY_INFORMATION, None, None, None, None, &mut sd);
            if rc.0 != 0 {
                return Err(format!("GetNamedSecurityInfo failed ({})", rc.0));
            }
            let mut text = PWSTR::null();
            let r = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text, None);
            let out = if r.is_ok() { Ok(pwstr_to_string(text)) } else { Err("ConvertSecurityDescriptorToStringSecurityDescriptor failed".to_string()) };
            if !text.is_null() {
                let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            }
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            out
        }
    }

    const ERROR_SERVICE_DOES_NOT_EXIST: u32 = 1060;

    /// `SERVICE_STATUS` of a service (state and exit codes of the last run), or `None` when it is not installed.
    pub fn service_status(name: &str) -> Result<Option<super::ScmStatus>, String> {
        let n = wide(name);
        // SAFETY: handles are closed on every path; `n` is NUL-terminated and outlives the calls.
        unsafe {
            let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).map_err(|e| format!("OpenSCManager failed: {e}"))?;
            let svc = match OpenServiceW(scm, PCWSTR(n.as_ptr()), SERVICE_QUERY_STATUS) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseServiceHandle(scm);
                    return if e.code() == windows::core::HRESULT::from_win32(ERROR_SERVICE_DOES_NOT_EXIST) {
                        Ok(None)
                    } else {
                        Err(format!("OpenService({name}) failed: {e}"))
                    };
                }
            };
            let mut st = SERVICE_STATUS::default();
            let r = QueryServiceStatus(svc, &mut st).map_err(|e| format!("QueryServiceStatus({name}) failed: {e}"));
            let _ = CloseServiceHandle(svc);
            let _ = CloseServiceHandle(scm);
            r.map(|_| {
                Some(super::ScmStatus { state: st.dwCurrentState.0, win32_exit: st.dwWin32ExitCode, specific_exit: st.dwServiceSpecificExitCode })
            })
        }
    }

    /// The binPath (`lpBinaryPathName`) a service is registered with.
    pub fn service_bin_path(name: &str) -> Result<String, String> {
        let n = wide(name);
        // SAFETY: handles are closed on every path; the buffer is u64-aligned and as large as the API asked for.
        unsafe {
            let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).map_err(|e| format!("OpenSCManager failed: {e}"))?;
            let svc = match OpenServiceW(scm, PCWSTR(n.as_ptr()), SERVICE_QUERY_CONFIG) {
                Ok(h) => h,
                Err(e) => {
                    let _ = CloseServiceHandle(scm);
                    return Err(format!("OpenService({name}) failed: {e}"));
                }
            };
            let mut needed = 0u32;
            let _ = QueryServiceConfigW(svc, None, 0, &mut needed); // sizing call: fails with INSUFFICIENT_BUFFER
            let out = if needed == 0 {
                Err(format!("QueryServiceConfig({name}) reported no size"))
            } else {
                let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
                let cfg = buf.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW;
                match QueryServiceConfigW(svc, Some(cfg), needed, &mut needed) {
                    Ok(()) => Ok(pwstr_to_string((*cfg).lpBinaryPathName)),
                    Err(e) => Err(format!("QueryServiceConfig({name}) failed: {e}")),
                }
            };
            let _ = CloseServiceHandle(svc);
            let _ = CloseServiceHandle(scm);
            out
        }
    }

    /// A service's `Start` value (2 automatic, 3 on demand, 4 disabled), or `None` when it is not installed.
    pub fn service_start_type(name: &str) -> Result<Option<u32>, String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        let path = super::service_registry_path(name);
        match winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(&path, KEY_READ) {
            Ok(k) => k.get_value::<u32, _>("Start").map(Some).map_err(|e| format!("cannot read Start of {name}: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("cannot open {path}: {e}")),
        }
    }

    const WAIT_TO_KILL_KEY: &str = "SYSTEM\\CurrentControlSet\\Control";
    const WAIT_TO_KILL_VALUE: &str = "WaitToKillServiceTimeout";

    /// `WaitToKillServiceTimeout` (REG_SZ), `None` when absent.
    pub fn wait_to_kill_get() -> Result<Option<String>, String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(WAIT_TO_KILL_KEY, KEY_READ)
            .map_err(|e| format!("cannot open {WAIT_TO_KILL_KEY}: {e}"))?;
        super::wait_to_kill_from(key.get_value::<String, _>(WAIT_TO_KILL_VALUE))
    }

    pub fn wait_to_kill_set(value: &str) -> Result<(), String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_SET_VALUE};
        let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(WAIT_TO_KILL_KEY, KEY_SET_VALUE)
            .map_err(|e| format!("cannot open {WAIT_TO_KILL_KEY}: {e}"))?;
        key.set_value(WAIT_TO_KILL_VALUE, &value).map_err(|e| format!("cannot write {WAIT_TO_KILL_VALUE}: {e}"))
    }

    /// Restoring "the value was absent" deletes it; an already-absent value is success.
    pub fn wait_to_kill_delete() -> Result<(), String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_SET_VALUE};
        let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(WAIT_TO_KILL_KEY, KEY_SET_VALUE)
            .map_err(|e| format!("cannot open {WAIT_TO_KILL_KEY}: {e}"))?;
        match key.delete_value(WAIT_TO_KILL_VALUE) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot delete {WAIT_TO_KILL_VALUE}: {e}")),
        }
    }

    /// Stops this process's stdin, stdout and stderr handles from being inherited by any child, for good (called
    /// before a long-lived child is started with its own explicit stdio): a caller that reads posctl's stdout to the
    /// end would otherwise wait for the child to exit. Done once and never restored: Rust's `Stdio::inherit` and every
    /// piped stdio hand a child a duplicate marked inheritable, so nothing else in posctl relies on the originals.
    pub fn clear_std_handle_inheritance() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            for r in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
                // SAFETY: plain handle-flag call on this process's own standard handles; an invalid or null handle
                // (no console, closed stream) just fails and is skipped.
                unsafe {
                    let _ = SetHandleInformation(HANDLE(r), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
                }
            }
        });
    }

    /// An owned process handle, closed on drop.
    struct Proc(HANDLE);
    impl Drop for Proc {
        fn drop(&mut self) {
            // SAFETY: closing our own handle once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn creation_time_of(h: HANDLE) -> Result<u64, String> {
        let (mut created, mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        // SAFETY: `h` is a live process handle with query rights; the out-pointers are locals.
        unsafe { GetProcessTimes(h, &mut created, &mut exit, &mut kernel, &mut user) }.map_err(|e| format!("GetProcessTimes failed: {e}"))?;
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub fn child_creation_time(child: &std::process::Child) -> Result<u64, String> {
        creation_time_of(HANDLE(child.as_raw_handle()))
    }

    pub fn process_identity(pid: u32) -> Result<Option<super::ProcIdentity>, String> {
        // SAFETY: OpenProcess returns an owned handle or an error; it is closed by `Proc`.
        let h = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(h) => Proc(h),
            // ERROR_INVALID_PARAMETER: there is no such process
            Err(e) if e.code() == windows::core::HRESULT::from_win32(87) => return Ok(None),
            Err(e) => return Err(format!("cannot open process {pid}: {e}")),
        };
        let mut code = 0u32;
        // SAFETY: valid handle, local out-pointer.
        unsafe { GetExitCodeProcess(h.0, &mut code) }.map_err(|e| format!("GetExitCodeProcess failed for {pid}: {e}"))?;
        if code != 259 {
            return Ok(None); // STILL_ACTIVE is 259: anything else has exited (a handle elsewhere may keep the object alive)
        }
        let created = creation_time_of(h.0)?;
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` has `len` UTF-16 units; the call writes at most that many and updates `len`.
        unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.map_err(|e| format!("QueryFullProcessImageNameW failed for {pid}: {e}"))?;
        let image = String::from_utf16_lossy(&buf[..len as usize]);
        Ok(Some(super::ProcIdentity { image, created }))
    }

    /// A Job Object with KILL_ON_JOB_CLOSE: every process assigned to it (and its descendants) dies
    /// when `kill` is called or the `Job` is dropped.
    pub struct Job(HANDLE);

    impl Job {
        pub fn new() -> Result<Job, String> {
            // SAFETY: plain Win32 calls on a handle we own; the handle is closed in Drop.
            unsafe {
                let h = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
                let job = Job(h);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| format!("SetInformationJobObject failed: {e}"))?;
                Ok(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
            // SAFETY: the child's process handle is valid while `child` is borrowed.
            unsafe {
                AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle()))
                    .map_err(|e| format!("AssignProcessToJobObject failed: {e}"))
            }
        }

        /// Kill every process in the job now.
        pub fn kill(&self) {
            // SAFETY: valid job handle.
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle once; KILL_ON_JOB_CLOSE ends any survivors.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Ace, KnownFolder, PathAcl};
    use std::path::PathBuf;

    pub fn known_folder(which: KnownFolder) -> Result<PathBuf, String> {
        Ok(PathBuf::from(match which {
            KnownFolder::ProgramFiles => r"C:\Program Files",
            KnownFolder::ProgramData => r"C:\ProgramData",
            KnownFolder::System => r"C:\Windows\System32",
            KnownFolder::Windows => r"C:\Windows",
        }))
    }

    use std::path::Path;
    const W: &str = "Windows only";
    pub fn is_elevated() -> bool { false }
    pub fn listening_tcp_ports() -> Result<Vec<u16>, String> { Err(W.into()) }
    pub fn free_disk_bytes(_: &Path) -> Result<u64, String> { Err(W.into()) }
    pub fn path_owner_sid(_: &Path) -> Result<String, String> { Err(W.into()) }
    pub fn set_registry_key_dacl(_: &str, _: &str) -> Result<(), String> { Err(W.into()) }
    pub fn registry_key_sddl(_: &str) -> Result<String, String> { Err(W.into()) }
    pub fn service_status(_: &str) -> Result<Option<super::ScmStatus>, String> { Err(W.into()) }
    pub fn service_start_type(_: &str) -> Result<Option<u32>, String> { Err(W.into()) }
    pub fn path_acl(_: &Path) -> Result<super::PathAcl, String> { Err(W.into()) }
    pub fn open_trust(path: &Path) -> std::io::Result<super::HandleInfo> {
        let m = std::fs::symlink_metadata(path)?;
        Ok(super::HandleInfo { reparse: m.file_type().is_symlink(), is_dir: m.is_dir(), owner: String::new(), acl: super::PathAcl { protected: false, aces: vec![] } })
    }
    pub fn create_dir_with_sddl(path: &Path, _: &str) -> std::io::Result<()> { std::fs::create_dir(path) }
    pub fn set_path_security(_: &Path, _: &str) -> Result<(), String> { Err(W.into()) }
    pub fn service_bin_path(_: &str) -> Result<String, String> { Err(W.into()) }
    pub fn wait_to_kill_get() -> Result<Option<String>, String> { Err(W.into()) }
    pub fn wait_to_kill_set(_: &str) -> Result<(), String> { Err(W.into()) }
    pub fn wait_to_kill_delete() -> Result<(), String> { Err(W.into()) }

    pub fn clear_std_handle_inheritance() {}
    pub fn process_identity(_: u32) -> Result<Option<super::ProcIdentity>, String> { Err(W.into()) }
    pub fn child_creation_time(_: &std::process::Child) -> Result<u64, String> { Err(W.into()) }

    /// No-op off Windows (dev/test machines): `exec` falls back to killing the direct child.
    pub struct Job;

    impl Job {
        pub fn new() -> Result<Job, String> {
            Ok(Job)
        }
        pub fn assign(&self, _child: &std::process::Child) -> Result<(), String> {
            Ok(())
        }
        pub fn kill(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Two tests rewrite process-wide environment variables: serialize them (cargo runs tests in parallel).
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn a_wrong_typed_wait_to_kill_value_is_garbage_not_an_error() {
        let wrong_type = std::io::Error::from_raw_os_error(222); // ERROR_BAD_FILE_TYPE: a REG_DWORD read as a string
        assert_eq!(wait_to_kill_from(Err(wrong_type)).unwrap(), Some(String::new()));
        assert_eq!(wait_to_kill_from(Ok("5000".into())).unwrap(), Some("5000".into()));
        assert_eq!(wait_to_kill_from(Err(std::io::Error::from(std::io::ErrorKind::NotFound))).unwrap(), None);
        assert!(wait_to_kill_from(Err(std::io::Error::from_raw_os_error(5))).is_err(), "access denied stays an error");
        assert_eq!(crate::services::wait_to_kill_target(Some("")), Some("30000".to_string()));
    }

    #[test]
    fn known_folders_ignore_the_environment() {
        let _g = env_lock();
        let keys = ["ProgramData", "ProgramFiles", "SystemDrive", "SystemRoot", "windir"];
        let saved: Vec<_> = keys.iter().map(|k| (*k, std::env::var_os(k))).collect();
        let all = [KnownFolder::ProgramData, KnownFolder::ProgramFiles, KnownFolder::System, KnownFolder::Windows];
        let before: Vec<_> = all.iter().map(|f| known_folder(*f).unwrap()).collect();
        for k in keys {
            std::env::set_var(k, r"Z:\evil");
        }
        let after: Vec<_> = all.iter().map(|f| known_folder(*f).unwrap()).collect();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        assert_eq!(before, after);
        assert!(after.iter().all(|p| p.is_absolute() && !p.starts_with(r"Z:\")));
    }

    #[cfg(windows)]
    #[test]
    fn program_files_is_the_64_bit_one_and_system_dir_exists() {
        let pf = known_folder(KnownFolder::ProgramFiles).unwrap().display().to_string();
        assert!(!pf.contains("(x86)"), "{pf}");
        assert!(system_dir().unwrap().join("cmd.exe").is_file());
    }

    #[cfg(windows)]
    mod win {
        use super::*;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
        use winreg::RegKey;

        #[test]
        fn elevation_query_runs_and_disk_space_is_positive() {
            let _ = is_elevated(); // either answer is fine; it must not crash
            assert!(free_disk_bytes(&std::env::temp_dir()).unwrap() > 0);
        }

        #[test]
        fn a_new_folder_reports_an_owner_sid() {
            let d = tempfile::tempdir().unwrap();
            let sid = path_owner_sid(d.path()).unwrap();
            assert!(sid.starts_with("S-1-5-"), "unexpected owner {sid}");
            assert!(path_owner_sid(&d.path().join("missing")).is_err());
        }

        // F8 h: one handle gives attributes, owner and DACL; a junction is reported, not followed.
        #[test]
        fn open_trust_reads_owner_and_acl_from_one_handle_and_does_not_follow_a_junction() {
            let d = tempfile::tempdir().unwrap();
            let sub = d.path().join("plain");
            std::fs::create_dir(&sub).unwrap();
            let t = open_trust(&sub).unwrap();
            assert!(!t.reparse && t.is_dir);
            assert_eq!(t.owner, path_owner_sid(&sub).unwrap());
            assert_eq!(t.acl, path_acl(&sub).unwrap());
            let target = d.path().join("elsewhere");
            std::fs::create_dir(&target).unwrap();
            let link = d.path().join("link");
            let st = std::process::Command::new("cmd").args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()]).output().unwrap();
            assert!(st.status.success());
            assert!(open_trust(&link).unwrap().reparse);
            assert_eq!(open_trust(&d.path().join("missing")).unwrap_err().kind(), std::io::ErrorKind::NotFound);
        }

        // F8 i: the folder is born with its final protected DACL.
        #[test]
        fn a_folder_created_with_an_sddl_has_exactly_that_dacl_from_the_start() {
            use crate::acl::{sddl_for, verify_dacl, Grant, Inherit};
            let d = tempfile::tempdir().unwrap();
            let me = path_owner_sid(d.path()).unwrap();
            let grants = vec![Grant::new("S-1-5-18", "F", Inherit::ObjectContainer), Grant::new(me, "F", Inherit::ObjectContainer)];
            let p = d.path().join("born");
            create_dir_with_sddl(&p, &sddl_for(None, &grants).unwrap()).unwrap();
            verify_dacl(&grants, &path_acl(&p).unwrap()).unwrap();
            assert_eq!(create_dir_with_sddl(&p, &sddl_for(None, &grants).unwrap()).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        }

        // service state comes from the SCM API, not from localized `sc query` text.
        #[test]
        fn service_state_uses_the_scm_api_and_needs_no_elevation() {
            assert_eq!(service_state("EventLog").unwrap(), crate::services::ServiceState::Running);
            assert_eq!(service_state("SupermarketPOS-NoSuchService-0000").unwrap(), crate::services::ServiceState::NotInstalled);
        }

        #[test]
        fn the_service_status_carries_the_exit_codes() {
            let st = service_status("EventLog").unwrap().expect("installed");
            assert_eq!((st.state, st.win32_exit, st.specific_exit), (4, 0, 0));
            assert_eq!(service_status("SupermarketPOS-NoSuchService-0000").unwrap(), None);
        }

        #[test]
        fn a_service_bin_path_is_readable_without_elevation() {
            assert!(!service_bin_path("EventLog").unwrap().is_empty());
            assert!(service_bin_path("SupermarketPOS-NoSuchService-0000").is_err());
        }

        // tool and folder locations ignore the process environment.
        #[test]
        fn system_tool_and_known_folder_paths_ignore_the_environment() {
            let _g = env_lock();
            let sys32 = system_dir().unwrap();
            let pf = known_folder(KnownFolder::ProgramFiles).unwrap();
            let pd = known_folder(KnownFolder::ProgramData).unwrap();
            let keys = ["SystemRoot", "windir", "ProgramFiles", "ProgramData"];
            let saved: Vec<_> = keys.iter().map(|k| (*k, std::env::var_os(k))).collect();
            for k in keys {
                std::env::set_var(k, "C:\\evil");
            }
            let same = system_dir().unwrap() == sys32
                && known_folder(KnownFolder::ProgramFiles).unwrap() == pf
                && known_folder(KnownFolder::ProgramData).unwrap() == pd
                && crate::acl::icacls_exe_for_test().starts_with(&sys32)
                && crate::services::sc_exe_for_test().starts_with(&sys32);
            for (k, v) in saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
            assert!(same);
        }

        #[test]
        fn multi_sz_round_trips_and_the_key_dacl_is_protected_and_replaced() {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let sub = format!("Software\\posctl-proto-test-{}", std::process::id());
            let (key, _) = hkcu.create_subkey(&sub).unwrap();
            drop(key);
            let entries = vec!["A=1".to_string(), "B=two words".to_string()];
            write_multi_sz(&hkcu, &sub, "Environment", &entries).unwrap();
            assert_eq!(read_multi_sz(&hkcu, &sub, "Environment").unwrap(), entries);

            // Same shape as production, but with owner rights so the test can clean up afterwards.
            let before = registry_key_sddl(&format!("CURRENT_USER\\{sub}")).unwrap();
            set_registry_key_dacl(&format!("CURRENT_USER\\{sub}"), "D:P(A;OICI;KA;;;OW)").unwrap();
            let after = registry_key_sddl(&format!("CURRENT_USER\\{sub}")).unwrap();
            assert!(after.starts_with("D:P"), "DACL must be protected, got {after}");
            assert!(after.contains("(A;OICI;KA;;;OW)"), "got {after}");
            assert_ne!(before, after);
            let _ = hkcu.open_subkey_with_flags(&sub, KEY_ALL_ACCESS).map(|_| hkcu.delete_subkey_all(&sub));
        }

        #[test]
        fn the_production_sddl_parses() {
            // Applying SYSTEM+Administrators-only to a key we own would lock cleanup out, so apply an
            // owner-rights variant of the same structure.
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let sub = format!("Software\\posctl-proto-sddl-{}", std::process::id());
            hkcu.create_subkey(&sub).unwrap();
            let variant = SERVICE_KEY_DACL_SDDL.replace(";;;SY)", ";;;OW)").replace(";;;BA)", ";;;SY)");
            assert!(set_registry_key_dacl(&format!("CURRENT_USER\\{sub}"), &variant).is_ok());
            let _ = hkcu.delete_subkey_all(&sub);
        }
    }

    #[cfg(windows)]
    fn norm(p: &str) -> String {
        p.replace('/', "\\").to_lowercase()
    }

    #[cfg(windows)]
    #[test]
    fn the_identity_of_this_process_is_its_exe_and_a_stable_creation_time() {
        let me = process_identity(std::process::id()).unwrap().expect("this process is running");
        assert_eq!(norm(&me.image), norm(&std::env::current_exe().unwrap().display().to_string()));
        assert!(me.created > 0);
        assert_eq!(process_identity(std::process::id()).unwrap().unwrap(), me);
    }

    #[cfg(windows)]
    #[test]
    fn a_spawned_childs_identity_matches_the_creation_time_read_from_its_handle_and_an_exited_one_is_gone() {
        let cmd = system_dir().unwrap().join("cmd.exe");
        let mut child = std::process::Command::new(&cmd).args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let id = process_identity(child.id()).unwrap().expect("the child is running");
        assert_eq!(norm(&id.image), norm(&cmd.display().to_string()));
        assert_eq!(child_creation_time(&child).unwrap(), id.created);
        child.kill().unwrap();
        child.wait().unwrap(); // the handle stays open until `child` drops: an exited process is still not "running"
        assert_eq!(process_identity(child.id()).unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn clearing_std_handle_inheritance_is_idempotent() {
        clear_std_handle_inheritance();
        clear_std_handle_inheritance();
    }
}
