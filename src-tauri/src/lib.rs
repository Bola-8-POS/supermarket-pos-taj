mod commands;

use commands::logger::write_log;
use commands::print_audit::{get_print_job, get_print_jobs, list_printers};
use commands::printer::{open_cash_drawer, print_raw_text, print_receipt, test_print};
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub supabase_url: String,
    pub supabase_anon_key: String,
    /// Licensing server (separate Supabase project). Empty = fall back to VITE_ build-time env.
    pub license_server_url: String,
    pub license_server_anon_key: String,
    /// A rejected runtime-override URL or an accepted one is recorded here
    /// (naming the field and the offending host, never the key) instead of
    /// `eprintln!`, which a release build's `windows_subsystem = "windows"`
    /// detaches before anyone could see it. Read and logged by AppConfigProvider.
    pub warnings: Vec<String>,
}

/// A runtime-override backend host is only trusted when it is the
/// project's own Supabase host (over https) or a local dev/loopback stack
/// (either scheme) — never an arbitrary host that merely contains
/// "supabase.co" somewhere in it (e.g. `evil.supabase.co.attacker.example`,
/// which does NOT end with ".supabase.co" once parsed and checked on the
/// host alone, not the whole URL string).
fn is_allowed_backend_url(url_str: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url_str) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let is_loopback = host == "localhost" || host == "127.0.0.1";
    match parsed.scheme() {
        "https" => host.ends_with(".supabase.co") || host.ends_with(".supabase.in") || is_loopback,
        "http" => is_loopback,
        _ => false,
    }
}

/// The host to name in a warning — never the full URL, which may carry
/// userinfo (`https://user:pass@host`) that a warning must not repeat back
/// through AppConfigProvider's logger.
fn describe_host(url_str: &str) -> String {
    url::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "unparseable URL".to_string())
}

/// Pure parse of a `.env` file's content into an `AppConfig` — extracted from
/// `read_env_config` so the line-order-independent validation below, and the
/// whole function, are unit-testable without touching the filesystem.
fn parse_env_config(content: &str) -> AppConfig {
    let mut config = AppConfig::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "VITE_SUPABASE_URL" => config.supabase_url = value.trim().to_string(),
                "VITE_SUPABASE_ANON_KEY" => {
                    config.supabase_anon_key = value.trim().to_string()
                }
                "VITE_LICENSE_SERVER_URL" => {
                    config.license_server_url = value.trim().to_string()
                }
                "VITE_LICENSE_SERVER_ANON_KEY" => {
                    config.license_server_anon_key = value.trim().to_string()
                }
                _ => {}
            }
        }
    }

    // Validated AFTER the full line loop, not inline mid-loop: a paired key's
    // line can appear before or after its URL's line in the file, so only a
    // post-loop pass over the fully-populated struct can reliably clear both
    // together — clearing inline could miss a not-yet-parsed key or let a
    // later line silently re-set one already cleared.
    if !config.supabase_url.is_empty() {
        if is_allowed_backend_url(&config.supabase_url) {
            config.warnings.push(format!(
                "Using VITE_SUPABASE_URL override — host: {}",
                describe_host(&config.supabase_url)
            ));
        } else {
            config.warnings.push(format!(
                "Ignored VITE_SUPABASE_URL override — host not allowed: {}",
                describe_host(&config.supabase_url)
            ));
            config.supabase_url = String::new();
            config.supabase_anon_key = String::new();
        }
    }
    if !config.license_server_url.is_empty() {
        if is_allowed_backend_url(&config.license_server_url) {
            config.warnings.push(format!(
                "Using VITE_LICENSE_SERVER_URL override — host: {}",
                describe_host(&config.license_server_url)
            ));
        } else {
            config.warnings.push(format!(
                "Ignored VITE_LICENSE_SERVER_URL override — host not allowed: {}",
                describe_host(&config.license_server_url)
            ));
            config.license_server_url = String::new();
            config.license_server_anon_key = String::new();
        }
    }

    config
}

fn read_env_config() -> AppConfig {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let env_path = exe_dir.join(".env");

    let content = std::fs::read_to_string(&env_path).unwrap_or_default();
    parse_env_config(&content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_a_customer_supabase_host_over_https() {
        assert!(is_allowed_backend_url("https://abcdefgh.supabase.co"));
        assert!(is_allowed_backend_url("https://abcdefgh.supabase.in"));
    }

    #[test]
    fn allows_loopback_over_either_scheme() {
        assert!(is_allowed_backend_url("http://localhost:54321"));
        assert!(is_allowed_backend_url("https://localhost:54321"));
        assert!(is_allowed_backend_url("http://127.0.0.1:54321"));
        assert!(is_allowed_backend_url("https://127.0.0.1:54321"));
    }

    #[test]
    fn rejects_a_host_suffix_match_that_is_not_a_real_suffix() {
        // A `contains`/`ends_with`-on-the-whole-URL check would wrongly allow
        // this; the check must be on the parsed host alone.
        assert!(!is_allowed_backend_url(
            "https://evil.supabase.co.attacker.example"
        ));
    }

    #[test]
    fn rejects_a_supabase_host_over_plain_http() {
        assert!(!is_allowed_backend_url("http://abcdefgh.supabase.co"));
    }

    #[test]
    fn rejects_garbage_and_unparseable_urls() {
        assert!(!is_allowed_backend_url("not a url"));
        assert!(!is_allowed_backend_url(""));
        assert!(!is_allowed_backend_url("ftp://abcdefgh.supabase.co"));
    }

    #[test]
    fn parses_keys_and_skips_comments_and_blank_lines() {
        let content = "\n# comment\nVITE_SUPABASE_URL=https://abcdefgh.supabase.co\n\nVITE_SUPABASE_ANON_KEY=anon-key-1\nVITE_LICENSE_SERVER_URL=https://ijklmnop.supabase.co\nVITE_LICENSE_SERVER_ANON_KEY=anon-key-2\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "https://abcdefgh.supabase.co");
        assert_eq!(config.supabase_anon_key, "anon-key-1");
        assert_eq!(config.license_server_url, "https://ijklmnop.supabase.co");
        assert_eq!(config.license_server_anon_key, "anon-key-2");
        // Both overrides are allowed hosts, so both get a warning.
        assert_eq!(config.warnings.len(), 2);
    }

    #[test]
    fn clears_a_rejected_url_and_its_paired_key_when_the_key_line_comes_after() {
        let content = "VITE_SUPABASE_URL=https://evil.supabase.co.attacker.example\nVITE_SUPABASE_ANON_KEY=some-anon-key\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "");
        assert_eq!(config.supabase_anon_key, "");
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn rejects_a_userinfo_host_trick() {
        // The `url` crate parses the host of `scheme://user@host` as `host`,
        // not the string before the first `.`/`@` — confirms the allow-list
        // check runs on the parsed host, not a raw string match.
        assert!(!is_allowed_backend_url(
            "https://x.supabase.co@evil.example/"
        ));
    }

    #[test]
    fn clears_a_rejected_url_and_its_paired_key_when_the_key_line_comes_before() {
        // .env line order is arbitrary — the paired key's line can precede
        // the URL's own line.
        let content = "VITE_LICENSE_SERVER_ANON_KEY=some-anon-key\nVITE_LICENSE_SERVER_URL=https://evil.supabase.co.attacker.example\n";
        let config = parse_env_config(content);
        assert_eq!(config.license_server_url, "");
        assert_eq!(config.license_server_anon_key, "");
        assert_eq!(config.warnings.len(), 1);
    }

    #[test]
    fn keeps_an_allowed_override_and_its_paired_key() {
        let content = "VITE_SUPABASE_URL=https://abcdefgh.supabase.co\nVITE_SUPABASE_ANON_KEY=some-anon-key\n";
        let config = parse_env_config(content);
        assert_eq!(config.supabase_url, "https://abcdefgh.supabase.co");
        assert_eq!(config.supabase_anon_key, "some-anon-key");
        // An accepted override still gets a warning — it's real logged
        // behavior a dev/support session should be able to see, unlike a
        // silent default.
        assert_eq!(config.warnings.len(), 1);
        assert!(config.warnings[0].contains("abcdefgh.supabase.co"));
    }
}

#[tauri::command]
fn get_runtime_config(state: tauri::State<AppConfig>) -> AppConfig {
    state.inner().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = read_env_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            app.manage(config);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            print_receipt,
            print_raw_text,
            open_cash_drawer,
            test_print,
            get_print_jobs,
            get_print_job,
            list_printers,
            get_runtime_config,
            write_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
