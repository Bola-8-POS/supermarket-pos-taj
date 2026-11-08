//! The two hidden answers of a switch (two-mode 11H, T15, owner ruling Q1): the cloud's staff-password pepper and ONE active
//! admin's PIN. They are typed on the console with echo off, never an argument, never the environment, never a file (the
//! `test-hooks` build alone may read them from a file the Sandbox names), held in memory only, registered for redaction and
//! zeroed when the last holder lets go.
//!
//! `stdin` is the cloud-credential channel (`--source-db-stdin`), so the prompt opens the console device itself (`CONIN$`).
//! A run with no console refuses `PIN_PROMPT_REQUIRED` before anything is touched.
use std::sync::Mutex;

/// A typed secret. Not `Clone`, never printed, zeroed on drop.
pub struct Entered(Vec<u8>);

impl Entered {
    pub fn new(s: String) -> Entered {
        Entered(s.into_bytes())
    }
    pub fn expose(&self) -> &str {
        std::str::from_utf8(&self.0).unwrap_or("")
    }
}

impl std::fmt::Debug for Entered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Entered(***)")
    }
}

impl Drop for Entered {
    fn drop(&mut self) {
        self.0.iter_mut().for_each(|b| *b = 0);
        // ponytail: no zeroize crate (a new dependency needs the owner); `black_box` keeps the compiler from dropping the dead store.
        // Copies the allocator or the console driver made are out of reach: the ceiling is "not kept by this process".
        std::hint::black_box(&mut self.0);
    }
}

/// What the switch keeps after the pre-fence proof: who signed in, the PIN they typed and the pepper that proved it. The pepper is
/// installed as the local one after the swap; the PIN signs the admin in to the new store, then both are dropped with the run.
pub struct AdminProof {
    pub admin_id: String,
    pub pepper: Entered,
    pub pin: Entered,
}

impl std::fmt::Debug for AdminProof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdminProof(***)")
    }
}

/// A place that can ask for a hidden line. `None`: there is no console (or it ended).
pub trait Console {
    fn read_hidden(&mut self, prompt: &str) -> Option<Entered>;
}

/// The answers the run's report scrubber must mask (`commands::switch::scrub_all` reads them once the run is over).
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Registers a value for redaction. Called with every typed answer and every value derived from it.
pub fn register(secret: &str) {
    if secret.is_empty() {
        return;
    }
    if let Ok(mut r) = REGISTERED.lock() {
        if !r.iter().any(|s| s == secret) {
            r.push(secret.to_string());
        }
    }
}

/// Takes the registered values out of the registry (moved, not cloned: no second copy is left behind). The caller masks with them
/// and then hands them to `zero_strings`.
pub fn take_registered() -> Vec<String> {
    match REGISTERED.lock() {
        Ok(mut r) => std::mem::take(&mut *r),
        Err(_) => vec![],
    }
}

/// Overwrites the bytes of a secret `String` with NULs in place (its length stays) before it is dropped. Best effort: copies the
/// allocator or a growing buffer made earlier are out of reach (no zeroize crate; a new dependency needs the owner).
pub fn zero_string(s: &mut String) {
    let mut bytes = std::mem::take(s).into_bytes();
    bytes.iter_mut().for_each(|b| *b = 0);
    std::hint::black_box(&mut bytes);
    // NULs are valid UTF-8: the zeroed buffer goes back so the `String` still owns the (now blank) allocation
    *s = String::from_utf8(bytes).unwrap_or_default();
}

pub fn zero_strings(v: &mut [String]) {
    v.iter_mut().for_each(zero_string);
}

/// The console the run uses: the Sandbox's answer file in a `test-hooks` build, otherwise the real hidden console.
pub fn console() -> Box<dyn Console> {
    match crate::ops::hooks::switch_console_file() {
        Some(path) => Box::new(FileConsole::open(&path)),
        None => Box::new(RealConsole),
    }
}

/// Answers from a file, one per line (test-hooks builds only: the stub returns `None` everywhere else).
pub struct FileConsole {
    lines: std::collections::VecDeque<String>,
}

impl FileConsole {
    pub fn open(path: &str) -> FileConsole {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        FileConsole {
            lines: text.lines().map(|l| l.trim().to_string()).collect(),
        }
    }
}

impl Console for FileConsole {
    fn read_hidden(&mut self, _prompt: &str) -> Option<Entered> {
        self.lines.pop_front().map(Entered::new)
    }
}

/// The person at the keyboard.
pub struct RealConsole;

impl Console for RealConsole {
    fn read_hidden(&mut self, prompt: &str) -> Option<Entered> {
        read_console_hidden(prompt)
    }
}

/// Echo is off for exactly as long as this value lives: `Drop` puts the saved console mode back on every way out of the read
/// (return, `?`, panic), and a console control handler does the same for Ctrl+C and Ctrl+Break, which end the process without
/// unwinding and would otherwise leave the operator's console silent.
#[cfg(windows)]
struct EchoOff {
    handle: windows::Win32::Foundation::HANDLE,
    mode: windows::Win32::System::Console::CONSOLE_MODE,
}

#[cfg(windows)]
mod echo_saved {
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize};
    /// The console input handle and its mode before echo was switched off, for the control handler (a plain function, no captures).
    pub static HANDLE: AtomicUsize = AtomicUsize::new(0);
    pub static MODE: AtomicU32 = AtomicU32::new(0);
    pub static ARMED: AtomicBool = AtomicBool::new(false);
}

/// Runs on a thread the system creates for Ctrl+C / Ctrl+Break / close: restores the saved mode, then reports the event as not
/// handled so the default action (ending the process) still happens.
#[cfg(windows)]
unsafe extern "system" fn restore_echo_on_ctrl(_ctrl_type: u32) -> windows::core::BOOL {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{SetConsoleMode, CONSOLE_MODE};
    if echo_saved::ARMED.swap(false, Ordering::SeqCst) {
        let h = HANDLE(echo_saved::HANDLE.load(Ordering::SeqCst) as *mut core::ffi::c_void);
        // SAFETY: the handle is the console input handle `EchoOff` saved and keeps open while ARMED is set; SetConsoleMode on it
        // from any thread is allowed, and a failure is ignored (nothing else can be done on the way out).
        unsafe {
            let _ = SetConsoleMode(h, CONSOLE_MODE(echo_saved::MODE.load(Ordering::SeqCst)));
        }
    }
    false.into()
}

#[cfg(windows)]
impl EchoOff {
    fn new(handle: windows::Win32::Foundation::HANDLE) -> Option<EchoOff> {
        use std::sync::atomic::Ordering;
        use windows::Win32::System::Console::{
            GetConsoleMode, SetConsoleCtrlHandler, SetConsoleMode, CONSOLE_MODE, ENABLE_ECHO_INPUT,
        };
        let mut mode = CONSOLE_MODE(0);
        // SAFETY: plain console-mode calls on the console input handle the caller keeps open for the life of the returned value;
        // the handler function is `'static` and captures nothing.
        unsafe {
            GetConsoleMode(handle, &mut mode).ok()?;
            echo_saved::HANDLE.store(handle.0 as usize, Ordering::SeqCst);
            echo_saved::MODE.store(mode.0, Ordering::SeqCst);
            echo_saved::ARMED.store(true, Ordering::SeqCst);
            let _ = SetConsoleCtrlHandler(Some(restore_echo_on_ctrl), true);
        }
        let guard = EchoOff { handle, mode };
        // SAFETY: as above. On failure `guard` drops here and restores the mode it saved.
        unsafe { SetConsoleMode(handle, CONSOLE_MODE(mode.0 & !ENABLE_ECHO_INPUT.0)).ok()? };
        Some(guard)
    }
}

#[cfg(windows)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        use windows::Win32::System::Console::{SetConsoleCtrlHandler, SetConsoleMode};
        // the handler may have restored it already (Ctrl+C racing the end of the read); restoring twice is harmless
        echo_saved::ARMED.store(false, Ordering::SeqCst);
        // SAFETY: restores the mode saved in `new` on the same, still open, handle and removes the handler added there.
        unsafe {
            let _ = SetConsoleMode(self.handle, self.mode);
            let _ = SetConsoleCtrlHandler(Some(restore_echo_on_ctrl), false);
        }
    }
}

/// Opens the console devices (not stdin: that carries the cloud credentials), switches echo off for the read and back on after,
/// and reads one line byte by byte into a buffer that never grows (a longer answer is cut, and refused later by its own check).
#[cfg(windows)]
fn read_console_hidden(prompt: &str) -> Option<Entered> {
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;

    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .open("CONOUT$")
        .ok()?;
    let input = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONIN$")
        .ok()?;
    let handle = HANDLE(input.as_raw_handle());
    // A handle that is not a console makes GetConsoleMode fail, and then nothing is read (never an echoing read).
    let echo = EchoOff::new(handle)?;
    let _ = write!(out, "{prompt} ");
    let _ = out.flush();
    let mut line: Vec<u8> = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    let mut any = false;
    let mut reader = &input;
    while matches!(reader.read(&mut b), Ok(1)) {
        any = true;
        if b[0] == b'\n' {
            break;
        }
        if b[0] != b'\r' && line.len() < 255 {
            line.push(b[0]);
        }
    }
    drop(echo);
    let _ = writeln!(out);
    if !any {
        return None;
    }
    match String::from_utf8(line) {
        Ok(mut typed) => {
            let answer = Entered::new(typed.trim().to_string());
            zero_string(&mut typed);
            Some(answer)
        }
        Err(e) => {
            let mut bytes = e.into_bytes();
            bytes.iter_mut().for_each(|b| *b = 0);
            std::hint::black_box(&mut bytes);
            None
        }
    }
}

#[cfg(not(windows))]
fn read_console_hidden(_prompt: &str) -> Option<Entered> {
    None
}

/// Scripted answers for the tests of every module that prompts.
#[cfg(test)]
pub(crate) mod scripted {
    use super::*;

    pub struct Script {
        pub answers: std::collections::VecDeque<Option<String>>,
        pub asked: usize,
    }
    impl Script {
        pub fn new(a: &[&str]) -> Script {
            Script {
                answers: a.iter().map(|s| Some(s.to_string())).collect(),
                asked: 0,
            }
        }
        pub fn none() -> Script {
            Script {
                answers: std::collections::VecDeque::new(),
                asked: 0,
            }
        }
    }
    impl Console for Script {
        fn read_hidden(&mut self, _p: &str) -> Option<Entered> {
            self.asked += 1;
            self.answers.pop_front().flatten().map(Entered::new)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entered_secret_never_prints_and_a_file_console_reads_one_answer_per_line() {
        let e = Entered::new("424242".into());
        assert_eq!(format!("{e:?}"), "Entered(***)");
        assert_eq!(e.expose(), "424242");
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("answers.txt");
        std::fs::write(&f, "first\r\nsecond\n").unwrap();
        let mut c = FileConsole::open(&f.to_string_lossy());
        assert_eq!(c.read_hidden("x").unwrap().expose(), "first");
        assert_eq!(c.read_hidden("x").unwrap().expose(), "second");
        assert!(
            c.read_hidden("x").is_none(),
            "no more answers: like a console that ended"
        );
    }

    #[test]
    fn registered_values_are_handed_over_once_and_forgotten() {
        register("sentinel-pin-value");
        register("sentinel-pin-value");
        register("");
        let got = take_registered();
        assert_eq!(got.iter().filter(|s| *s == "sentinel-pin-value").count(), 1);
        assert!(!take_registered().iter().any(|s| s == "sentinel-pin-value"));
    }

    #[test]
    fn zeroed_strings_keep_their_length_and_hold_only_nuls() {
        let mut v = vec!["sentinel-pw".to_string(), String::new(), "é9".to_string()];
        zero_strings(&mut v);
        assert_eq!(v.iter().map(|s| s.len()).collect::<Vec<_>>(), vec![11, 0, 3]);
        assert!(v.iter().all(|s| s.bytes().all(|b| b == 0)));
    }

    #[test]
    fn taking_the_registry_moves_the_values_out_and_leaves_it_empty() {
        register("sentinel-moved-value");
        let mut got = take_registered();
        assert!(got.iter().any(|s| s == "sentinel-moved-value"));
        assert!(!take_registered().iter().any(|s| s == "sentinel-moved-value"), "the registry holds no copy any more");
        zero_strings(&mut got);
        assert!(got.iter().all(|s| s.bytes().all(|b| b == 0)), "the handed-out values are zeroed after use");
    }

    #[cfg(not(windows))]
    #[test]
    fn without_a_console_nothing_is_read() {
        assert!(RealConsole.read_hidden("x").is_none());
    }
}
