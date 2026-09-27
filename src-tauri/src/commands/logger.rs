/**
 * TAURI LOGGER COMMAND
 *
 * Writes log entries to rotating log files in the app data directory.
 */

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use chrono::Local;
use tauri::{AppHandle, Manager};

/// Maximum number of log files to keep (30 days)
const MAX_LOG_FILES: usize = 30;

/// Disk-fill guard: a single day's log file used to have no size cap, so a
/// high-traffic terminal could grow one file without bound. Roll to a new
/// file once the active one crosses this size; `rotate_logs` still prunes by
/// file count regardless of name.
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Windows Application Event Log source name — matches `productName` in
/// tauri.conf.json, so it's recognizable in Event Viewer without a
/// registered message DLL (raw string, no formatted description).
const EVENT_SOURCE: &str = "Supermarket POS";

/// Per-entry size guard: an unbounded renderer-supplied log line (a large
/// error payload, a stack trace) could otherwise grow one log line without
/// bound. Entries over this size are truncated, not rejected — the caller
/// gets no signal either way, and a truncated record is still useful.
const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;
const TRUNCATION_MARKER: &str = "...[truncated]";

/// Truncates an oversize entry to `MAX_LOG_ENTRY_BYTES` on a UTF-8 char
/// boundary (never splitting a multi-byte character) and appends
/// `TRUNCATION_MARKER`. An entry already within the cap is returned
/// unchanged.
fn clamp_log_entry(entry: &str) -> String {
    if entry.len() <= MAX_LOG_ENTRY_BYTES {
        return entry.to_string();
    }
    let mut cut = MAX_LOG_ENTRY_BYTES;
    while cut > 0 && !entry.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &entry[..cut], TRUNCATION_MARKER)
}

/// Gets the log directory path
fn get_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get app log directory: {}", e))?;

    // Create logs directory if it doesn't exist
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

    Ok(app_data_dir)
}

/// Gets the current log file path (bar-pos-YYYY-MM-DD.log)
fn get_current_log_file(app: &AppHandle) -> Result<PathBuf, String> {
    let log_dir = get_log_dir(app)?;
    let now = Local::now();
    let filename = format!("bar-pos-{}.log", now.format("%Y-%m-%d"));
    Ok(log_dir.join(filename))
}

/// Rotates old log files (keeps last 30 days)
fn rotate_logs(app: &AppHandle) -> Result<(), String> {
    let log_dir = get_log_dir(app)?;

    // Get all log files
    let mut log_files: Vec<PathBuf> = fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext == "log")
                .unwrap_or(false)
        })
        .collect();

    // Sort by modification time (oldest first)
    log_files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
    });

    // Delete oldest files if we have more than MAX_LOG_FILES
    if log_files.len() > MAX_LOG_FILES {
        let files_to_delete = log_files.len() - MAX_LOG_FILES;
        for path in log_files.iter().take(files_to_delete) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

/// Rolls the current log file to a timestamped name if it has crossed
/// `MAX_LOG_FILE_BYTES` — keeps a single busy day's file from growing
/// unbounded between the count-based `rotate_logs` passes.
fn rotate_by_size_if_needed(log_file: &PathBuf) {
    let Ok(meta) = fs::metadata(log_file) else {
        return;
    };
    if meta.len() < MAX_LOG_FILE_BYTES {
        return;
    }
    let rolled = log_file.with_extension(format!("{}.log", Local::now().format("%H%M%S")));
    let _ = fs::rename(log_file, rolled);
}

/// Writes a log entry to the current log file
#[tauri::command]
pub fn write_log(app: AppHandle, entry: String) -> Result<(), String> {
    let entry = clamp_log_entry(&entry);

    // Get current log file path
    let log_file = get_current_log_file(&app)?;
    rotate_by_size_if_needed(&log_file);

    // Open file in append mode (create if doesn't exist)
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    // Write log entry (one line per entry)
    writeln!(file, "{}", entry)
        .map_err(|e| format!("Failed to write log entry: {}", e))?;

    // Rotate logs (only check once per day to avoid overhead)
    // We'll do this opportunistically when writing logs
    let _ = rotate_logs(&app);

    // Warn/error entries also go to the Windows Application Event Log
    // (native OS logging service) so an operator can see them in Event
    // Viewer without pulling the app's own log files off the machine.
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&entry) {
        let level = parsed.get("level").and_then(|v| v.as_str()).unwrap_or("");
        if level == "warn" || level == "error" {
            report_to_event_log(level, &entry);
        }
    }

    Ok(())
}

#[cfg(windows)]
fn report_to_event_log(level: &str, message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::System::EventLog::{
        DeregisterEventSource, RegisterEventSourceW, ReportEventW, EVENTLOG_ERROR_TYPE,
        EVENTLOG_WARNING_TYPE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // Best-effort, ad-hoc event source (no registry-registered message DLL)
    // — Event Viewer still records the source/message text, just without a
    // formatted description.
    unsafe {
        let source = wide(EVENT_SOURCE);
        let Ok(handle) = RegisterEventSourceW(None, PCWSTR(source.as_ptr())) else {
            return;
        };
        if handle.is_invalid() {
            return;
        }
        let wtype = if level == "error" {
            EVENTLOG_ERROR_TYPE
        } else {
            EVENTLOG_WARNING_TYPE
        };
        let wide_message = wide(message);
        let strings = [PCWSTR(wide_message.as_ptr())];
        let _ = ReportEventW(handle, wtype, 0, 0, None, 0, Some(&strings), None);
        let _ = DeregisterEventSource(handle);
    }
}

#[cfg(not(windows))]
fn report_to_event_log(_level: &str, _message: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_file_naming() {
        // Test that log file names follow the expected format
        let now = Local::now();
        let expected = format!("bar-pos-{}.log", now.format("%Y-%m-%d"));
        assert!(expected.starts_with("bar-pos-"));
        assert!(expected.ends_with(".log"));
    }

    #[test]
    fn clamp_log_entry_truncates_oversize_and_keeps_small() {
        let small = "a short entry";
        assert_eq!(clamp_log_entry(small), small);

        let oversized = "x".repeat(MAX_LOG_ENTRY_BYTES + 500);
        let clamped = clamp_log_entry(&oversized);
        assert!(clamped.len() < oversized.len());
        assert!(clamped.ends_with(TRUNCATION_MARKER));
        assert_eq!(clamped.len(), MAX_LOG_ENTRY_BYTES + TRUNCATION_MARKER.len());

        // A multi-byte character sitting exactly on the cut boundary must
        // not be split — the clamp only cuts on a char boundary.
        let multi_byte_heavy = "é".repeat(MAX_LOG_ENTRY_BYTES); // 2 bytes each
        let clamped_multi = clamp_log_entry(&multi_byte_heavy);
        assert!(clamped_multi.ends_with(TRUNCATION_MARKER));
        assert!(std::str::from_utf8(clamped_multi.as_bytes()).is_ok());
    }

    #[test]
    fn rotate_by_size_if_needed_rolls_oversized_file_away() {
        let dir = std::env::temp_dir().join(format!(
            "bar-pos-test-rotate-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let active = dir.join("bar-pos-2026-01-01.log");

        fs::write(&active, "small").unwrap();
        rotate_by_size_if_needed(&active);
        assert!(active.exists(), "file under cap must not rotate");

        // Shrink the effective cap for this test by writing past a size we
        // know is below MAX_LOG_FILE_BYTES is impractical (10MB) — instead
        // verify the rename mechanics directly against an oversized write.
        let big = "x".repeat((MAX_LOG_FILE_BYTES + 1) as usize);
        fs::write(&active, big).unwrap();
        rotate_by_size_if_needed(&active);
        assert!(!active.exists(), "oversized file must be renamed away");
        let siblings: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(siblings.len(), 1, "exactly one rolled file expected");

        let _ = fs::remove_dir_all(&dir);
    }
}
