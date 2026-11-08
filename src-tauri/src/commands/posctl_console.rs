//! `posctl_open_console`: reopens the elevated posctl console for one fixed action (set up the server, resume setup,
//! add a till, join a server, show the recovery key). The renderer sends only the action name; the argv is fixed
//! here, the exe is `<app folder>\posctl\posctl.exe`, and it is launched only when the folder chain is on a local
//! fixed drive, is not a junction/symlink and is owned by Administrators or SYSTEM (an elevated launch of a file a
//! standard user could replace would be a privilege escalation) and sits under Program Files (the installer's
//! `PosctlTrusted` rule). Nothing sensitive crosses this call.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleAction {
    SetUpServer,
    ResumeSetup,
    AddTill,
    JoinServer,
    ShowRecoveryKey,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleLaunch {
    Launched,
    Declined,
    NotInstalled,
    Untrusted,
}

/// What the shell said when asked to start the process elevated.
#[derive(Debug, PartialEq, Eq)]
pub enum ShellOutcome {
    Started,
    /// The user answered "No" on the UAC prompt (`ERROR_CANCELLED`).
    Cancelled,
    Failed,
}

impl ConsoleAction {
    /// The fixed argument line; it is never built from renderer input.
    pub fn argv(self) -> &'static str {
        match self {
            ConsoleAction::SetUpServer => "provision --console",
            ConsoleAction::ResumeSetup => "provision --resume --console",
            ConsoleAction::AddTill => "pair create --lan --console",
            ConsoleAction::JoinServer => "pair join --prompt --console",
            ConsoleAction::ShowRecoveryKey => "backup key-export",
        }
    }
}

type OwnerOf<'a> = &'a dyn Fn(&Path) -> Result<String, String>;
type PathTest<'a> = &'a dyn Fn(&Path) -> bool;

/// True when `exe_dir` is strictly inside `program_files`, the same rule as the installer's `PosctlTrusted`
/// (windows/hooks.nsh): case-insensitive prefix `<Program Files>\`, so `C:\Program Files (x86)evil` and
/// `C:\Program Files Evil\` fail; `\\?\` and trailing slashes are normalised; `..` and 8.3 `~` names below the
/// root are refused.
fn is_under_program_files(exe_dir: &Path, program_files: &Path) -> bool {
    // `\\?\C:\x` -> `c:\x`; forward slashes and trailing separators are dropped
    fn norm(p: &Path) -> String {
        let s = p.to_string_lossy().replace('/', "\\");
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
        s.trim_end_matches('\\').to_ascii_lowercase()
    }
    let (dir, root) = (norm(exe_dir), norm(program_files));
    if root.len() < 3 || root.starts_with(r"\\") {
        return false;
    }
    match dir.strip_prefix(&root).and_then(|rest| rest.strip_prefix('\\')) {
        Some(rest) => !rest.is_empty() && !rest.split('\\').any(|c| c == ".." || c.contains('~')),
        None => false,
    }
}

/// `SHGetKnownFolderPath(FOLDERID_ProgramFiles)`: not redirectable with an environment variable.
#[cfg(windows)]
fn known_program_files() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    // SAFETY: the returned PWSTR is copied then freed with CoTaskMemFree.
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None).ok()?;
        let out = p.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(p.0 as *const _));
        out
    }
}

/// `<exe dir>\posctl\posctl.exe` if it exists and the three-level chain is trusted, else why not.
fn resolve_posctl(exe_dir: &Path, program_files: &Path, owner_of: OwnerOf, is_reparse: PathTest, is_fixed: PathTest) -> Result<PathBuf, ConsoleLaunch> {
    if !is_under_program_files(exe_dir, program_files) {
        return Err(ConsoleLaunch::Untrusted);
    }
    crate::vet_base(exe_dir, is_fixed).map_err(|_| ConsoleLaunch::Untrusted)?;
    let exe = exe_dir.join("posctl").join("posctl.exe");
    // checked before exists(), which follows junctions
    if exe.ancestors().take(3).any(is_reparse) {
        return Err(ConsoleLaunch::Untrusted);
    }
    if !exe.exists() {
        return Err(ConsoleLaunch::NotInstalled);
    }
    let owners: Vec<_> = exe.ancestors().take(3).map(owner_of).collect();
    if !crate::owners_trusted(&owners) {
        return Err(ConsoleLaunch::Untrusted);
    }
    Ok(exe)
}

fn open_console_with(
    action: ConsoleAction,
    exe_dir: &Path,
    program_files: &Path,
    owner_of: OwnerOf,
    is_reparse: PathTest,
    is_fixed: PathTest,
    shell_execute: &dyn Fn(&Path, &str) -> ShellOutcome,
) -> Result<ConsoleLaunch, String> {
    let exe = match resolve_posctl(exe_dir, program_files, owner_of, is_reparse, is_fixed) {
        Ok(exe) => exe,
        Err(refused) => return Ok(refused),
    };
    match shell_execute(&exe, action.argv()) {
        ShellOutcome::Started => Ok(ConsoleLaunch::Launched),
        ShellOutcome::Cancelled => Ok(ConsoleLaunch::Declined),
        ShellOutcome::Failed => Err("the console could not be started".to_string()),
    }
}

#[cfg(windows)]
fn shell_execute_runas(exe: &Path, args: &str) -> ShellOutcome {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    const ERROR_CANCELLED_HRESULT: u32 = 0x8007_04C7; // HRESULT_FROM_WIN32(ERROR_CANCELLED)
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let params: Vec<u16> = args.encode_utf16().chain(std::iter::once(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: 1, // SW_SHOWNORMAL
        ..Default::default()
    };
    // SAFETY: `info` is fully initialised and `file` / `params` are NUL-terminated and outlive the call; no wait.
    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => ShellOutcome::Started,
        Err(e) if e.code().0 as u32 == ERROR_CANCELLED_HRESULT => ShellOutcome::Cancelled,
        Err(_) => ShellOutcome::Failed,
    }
}

#[cfg(not(windows))]
fn shell_execute_runas(_exe: &Path, _args: &str) -> ShellOutcome {
    ShellOutcome::Failed
}

#[tauri::command]
pub async fn posctl_open_console(action: ConsoleAction) -> Result<ConsoleLaunch, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| "the app folder is unknown".to_string())?;
    #[cfg(windows)]
    {
        let Some(program_files) = known_program_files() else { return Ok(ConsoleLaunch::Untrusted) };
        open_console_with(action, &exe_dir, &program_files, &crate::path_owner_sid, &crate::path_is_reparse_point, &crate::drive_is_fixed, &shell_execute_runas)
    }
    #[cfg(not(windows))]
    {
        // Offline only is a Windows product: nothing to open elsewhere.
        let _ = (action, exe_dir);
        Ok(ConsoleLaunch::NotInstalled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn tree(name: &str, with_exe: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("posctl-console-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("posctl")).unwrap();
        if with_exe {
            std::fs::write(dir.join("posctl").join("posctl.exe"), b"x").unwrap();
        }
        dir
    }
    fn admin(_: &Path) -> Result<String, String> {
        Ok("S-1-5-32-544".to_string())
    }
    fn plain(_: &Path) -> bool {
        false
    }
    fn fixed(_: &Path) -> bool {
        true
    }

    #[test]
    fn every_action_maps_to_its_fixed_argv() {
        let all = [
            (ConsoleAction::SetUpServer, "provision --console"),
            (ConsoleAction::ResumeSetup, "provision --resume --console"),
            (ConsoleAction::AddTill, "pair create --lan --console"),
            (ConsoleAction::JoinServer, "pair join --prompt --console"),
            (ConsoleAction::ShowRecoveryKey, "backup key-export"),
        ];
        for (action, argv) in all {
            assert_eq!(action.argv(), argv);
            let dir = tree("argv", true);
            let seen = RefCell::new(String::new());
            let shell = |_: &Path, a: &str| {
                *seen.borrow_mut() = a.to_string();
                ShellOutcome::Started
            };
            assert_eq!(open_console_with(action, &dir, &std::env::temp_dir(), &admin, &plain, &fixed, &shell), Ok(ConsoleLaunch::Launched));
            assert_eq!(*seen.borrow(), argv);
        }
        let parsed: ConsoleAction = serde_json::from_str("\"ShowRecoveryKey\"").unwrap();
        assert_eq!(parsed, ConsoleAction::ShowRecoveryKey);
        assert!(serde_json::from_str::<ConsoleAction>("\"provision --x\"").is_err());
    }

    #[test]
    fn untrusted_or_missing_posctl_is_refused_before_shell_execute() {
        let called = RefCell::new(false);
        let shell = |_: &Path, _: &str| {
            *called.borrow_mut() = true;
            ShellOutcome::Started
        };
        let run = |dir: &Path, owner: OwnerOf, reparse: PathTest, fx: PathTest| {
            open_console_with(ConsoleAction::SetUpServer, dir, &std::env::temp_dir(), owner, reparse, fx, &shell)
        };
        let user = |_: &Path| Ok("S-1-5-21-1-2-3-1001".to_string());
        let unreadable = |_: &Path| Err("denied".to_string());
        let junction = |p: &Path| p.ends_with("posctl");
        let removable = |_: &Path| false;
        let with = tree("trust", true);
        assert_eq!(run(&with, &user, &plain, &fixed), Ok(ConsoleLaunch::Untrusted));
        assert_eq!(run(&with, &unreadable, &plain, &fixed), Ok(ConsoleLaunch::Untrusted));
        assert_eq!(run(&with, &admin, &junction, &fixed), Ok(ConsoleLaunch::Untrusted));
        assert_eq!(run(&with, &admin, &plain, &removable), Ok(ConsoleLaunch::Untrusted));
        assert_eq!(run(Path::new(r"\\10.0.0.66\share"), &admin, &plain, &fixed), Ok(ConsoleLaunch::Untrusted));
        let without = tree("missing", false);
        assert_eq!(run(&without, &admin, &plain, &fixed), Ok(ConsoleLaunch::NotInstalled));
        assert!(!*called.borrow(), "the shell must never be reached for a refused posctl");
    }

    #[test]
    fn program_files_prefix_is_strict() {
        let pf = Path::new(r"C:\Program Files");
        let under = |p: &str| is_under_program_files(Path::new(p), pf);
        assert!(under(r"C:\Program Files\Supermarket POS"));
        assert!(under("c:\\program files\\SUPERMARKET POS\\"));
        assert!(under(r"\\?\C:\Program Files\Supermarket POS"));
        assert!(under("C:/Program Files/Supermarket POS"));
        assert!(is_under_program_files(Path::new(r"C:\Program Files\App"), Path::new("C:\\Program Files\\")));
        assert!(!under(r"C:\Program Files"));
        assert!(!under("C:\\Program Files\\"));
        assert!(!under(r"C:\Program Files (x86)evil\App"));
        assert!(!under(r"C:\Program Files Evil\App"));
        assert!(!under(r"C:\Program Files (x86)\App"));
        assert!(!under(r"C:\Program Files\..\Users\x\App"));
        assert!(!under(r"C:\Program Files\PROGRA~2\App"));
        assert!(!under(r"C:\Users\x\Program Files\App"));
        assert!(!under(r"D:\Program Files\App"));
        assert!(!under(r"\\server\Program Files\App"));
        assert!(!under(""));
        assert!(!is_under_program_files(Path::new(r"C:\Program Files\App"), Path::new("")));
    }

    #[test]
    fn a_posctl_outside_program_files_is_refused_before_shell_execute() {
        let dir = tree("pf", true);
        let called = RefCell::new(false);
        let shell = |_: &Path, _: &str| {
            *called.borrow_mut() = true;
            ShellOutcome::Started
        };
        let elsewhere = Path::new(r"C:\Program Files");
        assert_eq!(open_console_with(ConsoleAction::SetUpServer, &dir, elsewhere, &admin, &plain, &fixed, &shell), Ok(ConsoleLaunch::Untrusted));
        assert!(!*called.borrow());
    }

    #[test]
    fn cancelled_uac_maps_to_declined() {
        let dir = tree("uac", true);
        let go = |outcome: fn() -> ShellOutcome| {
            let shell = move |_: &Path, _: &str| outcome();
            open_console_with(ConsoleAction::AddTill, &dir, &std::env::temp_dir(), &admin, &plain, &fixed, &shell)
        };
        assert_eq!(go(|| ShellOutcome::Cancelled), Ok(ConsoleLaunch::Declined));
        assert_eq!(go(|| ShellOutcome::Started), Ok(ConsoleLaunch::Launched));
        assert!(go(|| ShellOutcome::Failed).is_err());
    }

    #[test]
    fn peek_capability_does_not_list_the_command() {
        let peek = include_str!("../../capabilities/peek.json");
        let main = include_str!("../../capabilities/main.json");
        assert!(!peek.contains("posctl"));
        assert!(main.contains("allow-posctl-open-console"));
    }
}
