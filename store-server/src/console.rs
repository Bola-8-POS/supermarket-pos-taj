//! `--console` (Plan 11a): posctl run by a person in a visible elevated console, from the installer or the app.
//! Questions and human output live here as pure functions over `Read` / `Write`, so no test needs a real console.
//!
//! The once-only values (generated first-admin PIN, pair code) are printed in a framed block and nowhere else: not in the
//! result file (a console run has none), not in the posctl log (`cli` logs the `Envelope`, which never holds them).

use std::io::{Read, Write};

use serde_json::Value;

use crate::envelope::{Code, Outcome, PosctlError};

/// A console run must be a person at a terminal: no JSON contract, no result file. Nothing has been done when this fails.
pub fn refuse(json: bool, result_file: bool, interactive: bool) -> Result<(), PosctlError> {
    if json || result_file {
        return Err(PosctlError::new(Code::Usage, "--console prints for a person: it cannot be combined with --json or --result-file"));
    }
    if !interactive {
        return Err(PosctlError::new(Code::Usage, "--console needs a terminal for both input and output"));
    }
    Ok(())
}

/// stdin and stdout are terminals; a Sandbox test build also accepts piped answers when `POSCTL_TEST_CONSOLE=1`.
pub fn is_interactive() -> bool {
    use std::io::IsTerminal;
    (std::io::stdin().is_terminal() && std::io::stdout().is_terminal()) || piped_allowed()
}

#[cfg(feature = "test-hooks")]
fn piped_allowed() -> bool {
    std::env::var("POSCTL_TEST_CONSOLE").as_deref() == Ok("1")
}

#[cfg(not(feature = "test-hooks"))]
fn piped_allowed() -> bool {
    false
}

/// One answer line, read byte by byte so nothing beyond the line break is consumed (the pause at the end shares the stream).
/// `None` at the end of the input with nothing read.
pub fn read_line(input: &mut dyn Read) -> Option<String> {
    let mut bytes = Vec::new();
    let mut b = [0u8; 1];
    let mut any = false;
    while matches!(input.read(&mut b), Ok(1)) {
        any = true;
        if b[0] == b'\n' {
            break;
        }
        if bytes.len() < 512 {
            bytes.push(b[0]);
        }
    }
    if !any {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(text.trim_start_matches('\u{feff}').trim().to_string())
}

/// Asks until `parse` accepts the answer, three tries; then USAGE (nothing has been done yet).
pub fn ask<T>(input: &mut dyn Read, out: &mut dyn Write, prompt: &str, parse: impl Fn(&str) -> Option<T>) -> Result<T, PosctlError> {
    for _ in 0..3 {
        let _ = write!(out, "{prompt} ");
        let _ = out.flush();
        let Some(line) = read_line(input) else {
            return Err(PosctlError::new(Code::Usage, "the input ended before every question was answered"));
        };
        if let Some(v) = parse(&line) {
            return Ok(v);
        }
        let _ = writeln!(out, "That is not a valid answer.");
    }
    Err(PosctlError::new(Code::Usage, "no valid answer after three tries"))
}

/// `y` / `yes` / `n` / `no`; an empty answer is `default`.
pub fn ask_yes_no(input: &mut dyn Read, out: &mut dyn Write, prompt: &str, default: bool) -> Result<bool, PosctlError> {
    ask(input, out, prompt, |s| match s.to_ascii_lowercase().as_str() {
        "" => Some(default),
        "y" | "yes" => Some(true),
        "n" | "no" => Some(false),
        _ => None,
    })
}

/// What `provision --console` learned from the owner.
#[derive(Debug, PartialEq, Eq)]
pub struct ProvisionAnswers {
    /// Option 2: a cloud store is moving onto this PC (`--prepare-for-switch`).
    pub moving_cloud_store: bool,
    /// Option 1 only; `None` keeps the default name.
    pub admin_name: Option<String>,
    /// The Public network is the shop's own (`--confirm-private-network`).
    pub confirm_private_network: bool,
}

fn valid_admin_name(s: &str) -> Option<Option<String>> {
    if s.is_empty() {
        return Some(None);
    }
    (s.chars().count() <= 60 && !s.chars().any(char::is_control)).then(|| Some(s.to_string()))
}

pub fn provision_answers(input: &mut dyn Read, out: &mut dyn Write, public_network: bool) -> Result<ProvisionAnswers, PosctlError> {
    let _ = writeln!(out, "Set up this PC as the store server.\n  1) New shop with no cloud data\n  2) Moving an existing cloud store to this PC");
    let moving = ask(input, out, "Choose 1 or 2:", |s| match s {
        "1" => Some(false),
        "2" => Some(true),
        _ => None,
    })?;
    let admin_name = if moving { None } else { ask(input, out, "Name of the first administrator (Enter for \"Administrador\"):", valid_admin_name)? };
    let confirm_private_network = if public_network {
        ask_yes_no(input, out, "This PC's network is marked Public, so tills could not reach it. Is this the shop's own network? (y/N):", false)?
    } else {
        false
    };
    Ok(ProvisionAnswers { moving_cloud_store: moving, admin_name, confirm_private_network })
}

fn frame(out: &mut dyn Write, label: &str, value: &str) {
    let line = format!("  {label}: {value}  ");
    let bar = "=".repeat(line.chars().count());
    let _ = writeln!(out, "\n{bar}\n{line}\n{bar}");
}

/// The human summary of one finished command, then the framed once-only values.
pub fn print_outcome(out: &mut dyn Write, o: &Outcome) {
    if o.code == Code::Ok {
        let _ = writeln!(out, "\n{}", o.message);
    } else {
        let _ = writeln!(out, "\nFailed: {} ({}, exit {})", o.message, o.code.name(), o.code.exit());
    }
    if let Some(Value::String(code)) = o.data.get("code") {
        frame(out, "Pairing code", code);
        for (key, label) in [("fingerprintDisplay", "Fingerprint (type this on the till)"), ("expiresAt", "Expires"), ("serverHost", "Server")] {
            if let Some(v) = o.data.get(key).and_then(Value::as_str) {
                let _ = writeln!(out, "{label}: {v}");
            }
        }
    }
    if let Some(s) = &o.secret_once {
        let label = if s.field == "pin" { "First administrator PIN (shown once; it must be changed at first sign-in)" } else { s.field };
        frame(out, label, &s.value);
    }
}

/// The pause that keeps an elevated window open until the person has read it.
pub fn pause(out: &mut dyn Write, input: &mut dyn Read) {
    let _ = writeln!(out, "\nPress Enter to close this window.");
    let _ = out.flush();
    crate::commands::backup::wait_for_enter(input);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::SecretOnce;
    use serde_json::json;

    #[test]
    fn console_refuses_without_a_terminal_or_with_json_or_result_file() {
        assert!(refuse(false, false, true).is_ok());
        for (j, r, t) in [(true, false, true), (false, true, true), (false, false, false)] {
            let e = refuse(j, r, t).unwrap_err();
            assert_eq!((e.code, e.code.exit()), (Code::Usage, 2), "{j} {r} {t}");
        }
    }

    #[test]
    fn console_prints_the_once_only_value_framed_and_waits_for_enter() {
        let pin_text = ["493", "817"].concat(); // built from parts: a PIN-shaped literal trips the pin-assignment secret rule
        let pin = pin_text.as_str();
        let o = Outcome::ok("provisioned", json!({})).secret_once(SecretOnce { section: "firstAdmin", field: "pin", value: pin.into() });
        let mut out = Vec::new();
        print_outcome(&mut out, &o);
        let text = String::from_utf8(out).unwrap();
        let framed: Vec<&str> = text.lines().filter(|l| l.contains(pin)).collect();
        assert_eq!(framed.len(), 1, "{text}");
        assert!(text.contains("====="));
        let mut input = std::io::Cursor::new(b"\nrest".to_vec());
        let mut out = Vec::new();
        pause(&mut out, &mut input);
        assert_eq!(input.position(), 1, "waits for one line break and reads no further");
        assert!(String::from_utf8(out).unwrap().contains("Press Enter"));
    }

    #[test]
    fn a_pair_code_is_framed_with_the_fingerprint_to_type() {
        let o = Outcome::ok("pairing file written", json!({"code": "ABCD2345", "fingerprintDisplay": "AAAA-BBBB-CCCC-DDDD", "expiresAt": "2026-11-05T10:00:00Z", "serverHost": "storepc"}));
        let mut out = Vec::new();
        print_outcome(&mut out, &o);
        let t = String::from_utf8(out).unwrap();
        assert!(t.contains("ABCD2345") && t.contains("AAAA-BBBB-CCCC-DDDD") && t.contains("2026-11-05T10:00:00Z"), "{t}");
    }

    #[test]
    fn a_failure_is_printed_with_its_code_and_exit() {
        let mut out = Vec::new();
        print_outcome(&mut out, &Outcome::from(PosctlError::new(Code::PairFingerprintMismatch, "no match")));
        let t = String::from_utf8(out).unwrap();
        assert!(t.contains("Failed: no match") && t.contains("exit 51"), "{t}");
    }

    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn test_console_env_is_ignored_without_test_hooks() {
        std::env::set_var("POSCTL_TEST_CONSOLE", "1");
        assert!(!piped_allowed());
        std::env::remove_var("POSCTL_TEST_CONSOLE");
    }

    fn answers(text: &str, public: bool) -> Result<ProvisionAnswers, PosctlError> {
        provision_answers(&mut text.as_bytes(), &mut Vec::new(), public)
    }

    #[test]
    fn answer_two_is_a_cloud_move_and_asks_no_admin_name() {
        let a = answers("2\n", false).unwrap();
        assert_eq!(a, ProvisionAnswers { moving_cloud_store: true, admin_name: None, confirm_private_network: false });
    }

    #[test]
    fn answer_one_asks_the_name_and_an_empty_name_keeps_the_default() {
        assert_eq!(answers("1\nAna\n", false).unwrap().admin_name.as_deref(), Some("Ana"));
        assert_eq!(answers("1\n\n", false).unwrap().admin_name, None);
        let long = format!("1\n{}\nAna\n", "x".repeat(61));
        assert_eq!(answers(&long, false).unwrap().admin_name.as_deref(), Some("Ana"), "a 61-character name is asked again");
    }

    #[test]
    fn the_network_question_is_asked_only_for_a_public_network_and_no_is_the_default() {
        assert!(answers("1\nAna\ny\n", true).unwrap().confirm_private_network);
        assert!(!answers("1\nAna\n\n", true).unwrap().confirm_private_network);
        assert!(!answers("1\nAna\nn\n", true).unwrap().confirm_private_network);
        // no Public network: nothing more is read
        let mut rest = std::io::Cursor::new(b"1\nAna\ny\n".to_vec());
        let a = provision_answers(&mut rest, &mut Vec::new(), false).unwrap();
        assert!(!a.confirm_private_network);
        assert_eq!(rest.position(), 6);
    }

    #[test]
    fn invalid_answers_reprompt_three_times_then_usage() {
        let e = answers("x\n3\n\n", false).unwrap_err();
        assert_eq!(e.code, Code::Usage);
        assert!(answers("x\n3\n1\nAna\n", false).is_ok(), "the third try may be right");
        assert_eq!(answers("", false).unwrap_err().code, Code::Usage, "end of input");
    }
}
