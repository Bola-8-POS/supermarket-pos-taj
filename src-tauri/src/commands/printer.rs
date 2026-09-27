//! ESC/POS thermal receipt printing (58mm / 32 columns).
//! Line content (all labels, locale-translated) is built in TypeScript —
//! `bar-pos/src/shared/lib/receipt-format.ts` via `receiptDataToPrinterLines()`.
//! This module only ESC/POS-encodes the pre-formatted lines it receives; it
//! holds zero receipt-label strings.

#[cfg(not(target_os = "windows"))]
use std::fs;
#[cfg(not(target_os = "windows"))]
use std::io::Write;
#[cfg(not(target_os = "windows"))]
use std::time::{SystemTime, UNIX_EPOCH};

use base64::prelude::*;
use image::imageops::colorops::{dither, BiLevel};
use image::imageops::FilterType;

const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;

/// Real trust boundary for logo bytes: a direct `receipt_settings` UPDATE via
/// the Supabase client bypasses the browser canvas resizer's 200KB client-side
/// cap entirely, so this Rust-side cap (a generous margin over that UX-only
/// cap) is the one that actually protects `image::load_from_memory`.
const MAX_LOGO_DECODED_BYTES: usize = 512 * 1024;

/// Drawer kick: ESC p 0 0x19 0xFA
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const DRAWER_PULSE: [u8; 5] = [ESC, 0x70, 0x00, 0x19, 0xFA];

fn lines_to_esc_pos(lines: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[ESC, b'@']);
    if let Some(first) = lines.first() {
        out.extend_from_slice(&[ESC, b'a', 1]);
        out.extend_from_slice(&[ESC, b'E', 1]);
        out.extend_from_slice(first.as_bytes());
        out.push(b'\n');
    }
    out.extend_from_slice(&[ESC, b'a', 0]);
    out.extend_from_slice(&[ESC, b'E', 0]);
    for line in lines.iter().skip(1) {
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    }
    out.extend_from_slice(&[GS, b'V', 0x42, 0x03]);
    out
}

/// ESC/POS-encodes an already fully-formatted raw text blob (used by
/// `print_raw_text` — pre-cheques, caja summaries — where the caller has
/// already built every line, including any trailing cut sequence). Unlike
/// `lines_to_esc_pos`, this does NOT apply the bold-first-line header
/// styling: the text arrives pre-formatted and is emitted byte-for-byte
/// after only an ESC @ (initialize) prefix.
fn text_to_esc_pos(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[ESC, b'@']);
    out.extend_from_slice(text.as_bytes());
    out
}

/// Encodes decoded image bytes (PNG/JPEG) into an ESC/POS `GS v 0` monochrome
/// raster block: an 8-byte header followed by 1-bit-per-dot packed rows,
/// MSB-first, zero-padded on the trailing bits of a non-8-aligned width.
/// Never panics on malformed/attacker-controlled input — every failure path
/// returns `Err`.
fn encode_logo_raster(png_or_jpeg_bytes: &[u8], target_width_dots: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png_or_jpeg_bytes).map_err(|e| e.to_string())?;
    if img.width() == 0 || img.height() == 0 {
        return Err("Logo image has zero width or height".to_string());
    }

    let scale = target_width_dots as f32 / img.width() as f32;
    let target_height = ((img.height() as f32) * scale).round().max(1.0) as u32;

    let resized = img.resize(target_width_dots, target_height, FilterType::Lanczos3);
    let mut gray = resized.to_luma8();
    dither(&mut gray, &BiLevel);

    let width_bytes = (target_width_dots as usize).div_ceil(8);
    let height = gray.height();

    let mut out = vec![
        GS,
        b'v',
        b'0',
        0,
        (width_bytes & 0xFF) as u8,
        ((width_bytes >> 8) & 0xFF) as u8,
        (height & 0xFF) as u8,
        ((height >> 8) & 0xFF) as u8,
    ];

    for y in 0..height {
        for byte_i in 0..width_bytes {
            let mut byte = 0u8;
            for bit in 0..8u32 {
                let x = (byte_i as u32) * 8 + bit;
                if x < target_width_dots {
                    let pixel = gray.get_pixel(x, y).0[0];
                    if pixel == 0 {
                        byte |= 1 << (7 - bit);
                    }
                }
            }
            out.push(byte);
        }
    }

    Ok(out)
}

/// Strips the `data:image/png;base64,` prefix and decodes the payload,
/// rejecting oversized or malformed input before any bytes reach the image
/// decoder. Never panics on attacker-controlled input — every failure path
/// returns `Err`.
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (_, b64) = data_url
        .split_once(',')
        .ok_or_else(|| "Malformed data URL: no comma separator".to_string())?;
    let bytes = BASE64_STANDARD.decode(b64).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_LOGO_DECODED_BYTES {
        return Err(format!(
            "Logo payload exceeds {MAX_LOGO_DECODED_BYTES} byte cap"
        ));
    }
    Ok(bytes)
}

// ASSUMED: 58mm(32-char)->384dot / 80mm(40/48-char)->576dot @203dpi — conventional ESC/POS mapping, not verified against this store's actual printer hardware spec sheet (RESEARCH.md Assumption A1 / Open Question 2). Adjust this mapping if the real printer differs.
fn dot_width_for_paper(paper_width_chars: u16) -> u32 {
    if paper_width_chars <= 32 {
        384
    } else {
        576
    }
}

/// Assembles the full print payload: an optional GS v0 logo raster block
/// (best-effort — any decode/encode failure is logged and skipped, never
/// fails the whole print job) followed by the text lines.
fn build_print_payload(lines: &[String], logo_data_url: Option<&str>, paper_width_chars: u16) -> Vec<u8> {
    let mut out = Vec::new();

    if let Some(url) = logo_data_url {
        match decode_data_url(url)
            .and_then(|bytes| encode_logo_raster(&bytes, dot_width_for_paper(paper_width_chars)))
        {
            Ok(raster) => out.extend_from_slice(&raster),
            Err(e) => eprintln!("[printer] WARNING: logo raster failed: {e}"),
        }
    }

    out.extend_from_slice(&lines_to_esc_pos(lines));
    out
}

/// Only reachable from the non-Windows dev fallback (`write_fallback_ack`) —
/// no broker is ever installed on a non-Windows development machine.
#[cfg(not(target_os = "windows"))]
fn write_fallback_bytes(bytes: &[u8]) -> Result<(), String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let path = std::env::temp_dir().join(format!("receipt_{ts}.prn"));
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    eprintln!(
        "[printer] WARNING: no printer or print failed; wrote ESC/POS bytes to {}",
        path.display()
    );
    Ok(())
}

// The direct-WinSpool `win_print`/`try_send_raw` path (OpenPrinterW/
// StartDocPrinterW/WritePrinter) that used to live here was removed in Plan
// 19-03: now that all four commands (print_receipt, print_raw_text,
// open_cash_drawer, test_print) route through submit_to_broker on Windows,
// nothing calls it any more. The exact same Win32 sequence is already ported
// into broker/src/delivery.rs (Plan 19-01), which is the only place that
// still talks to WinSpool directly.

/// Fallback used only when Settings has no `printerName` configured yet
/// (fresh install, or a store that never opened Hardware Settings) — kept as
/// a named sentinel rather than silently picking the OS default, so an
/// unconfigured store gets an obvious "printer not found" broker rejection
/// instead of a job silently landing on the wrong queue.
fn default_printer_name() -> String {
    "RECEIPT_PRINTER".to_string()
}

/// Resolves the printer name to submit a job under: the caller-supplied
/// value (sourced from `ReceiptSettings.printerName` on the frontend) when
/// non-empty, otherwise `default_printer_name()`.
fn resolve_printer_name(printer_name: Option<String>) -> String {
    printer_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_printer_name)
}

/// Response shape for a durably-accepted broker job (Phase 19: Store-Local
/// Durable Printing Service). `job_id` is the broker's stable UUID for this
/// print job — never a Windows spooler job id.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PrintJobAck {
    pub job_id: String,
    pub status: String,
}

/// Non-Windows dev-only fallback (no broker installed on non-Windows
/// development machines): writes the ESC/POS bytes to a temp file and wraps
/// the outcome in a `PrintJobAck` so the command's return type stays uniform
/// across platforms. `job_id` is intentionally empty — there is no durable
/// broker job behind a dev fallback.
#[cfg(not(target_os = "windows"))]
fn write_fallback_ack(bytes: &[u8]) -> Result<PrintJobAck, String> {
    write_fallback_bytes(bytes).map(|()| PrintJobAck {
        job_id: String::new(),
        status: "dev_fallback".to_string(),
    })
}

const BROKER_URL: &str = "http://127.0.0.1:8973";
const BROKER_CONNECT_TIMEOUT_MS: u64 = 1500;

/// Submits a print job to the store-local broker over authenticated HTTP.
/// Never falls back to a direct-WinSpool path on failure — an unreachable
/// broker, a rejected job, or a persistence failure must surface as a real
/// error, not a silent success (PRN-02). D-12: explicit ~1.5s connect-timeout
/// and the IPv4 literal `127.0.0.1` (never the hostname `localhost`, which
/// can add dual-stack DNS resolution delay before a connection attempt).
///
/// `broker_url` is a parameter (not the hardcoded `BROKER_URL` constant
/// directly) purely so tests can point this at an in-process mock HTTP
/// listener instead of the real broker; `secret` is a parameter for the same
/// reason — resolving it from `%ProgramData%\PrintBroker\client-secret.txt`
/// inside this function would make every test that calls it depend on the
/// host machine's real broker install (it would only pass on a machine that
/// happens to have one). Every real caller goes through the `submit_to_broker`
/// thin wrapper below, which always uses `BROKER_URL` and resolves the real
/// secret.
async fn submit_to_broker_to(
    broker_url: &str,
    secret: &str,
    payload: &[u8],
    printer_name: &str,
    origin: &str,
) -> Result<PrintJobAck, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(BROKER_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "idempotency_key": uuid::Uuid::new_v4().to_string(),
        "printer_name": printer_name,
        "payload_b64": BASE64_STANDARD.encode(payload),
        "origin": origin,
    });

    let resp = client
        .post(format!("{broker_url}/jobs"))
        .bearer_auth(secret.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("broker unreachable: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("broker rejected job: HTTP {}", resp.status()));
    }
    resp.json::<PrintJobAck>().await.map_err(|e| e.to_string())
}

async fn submit_to_broker(
    payload: &[u8],
    printer_name: &str,
    origin: &str,
) -> Result<PrintJobAck, String> {
    let secret = crate::commands::broker_secret::resolve_broker_secret()?;
    submit_to_broker_to(BROKER_URL, &secret, payload, printer_name, origin).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn print_receipt(
    lines: Vec<String>,
    logo_data_url: Option<String>,
    paper_width_chars: u16,
    printer_name: Option<String>,
) -> Result<PrintJobAck, String> {
    let bytes = build_print_payload(&lines, logo_data_url.as_deref(), paper_width_chars);

    #[cfg(target_os = "windows")]
    {
        submit_to_broker(&bytes, &resolve_printer_name(printer_name), "receipt").await
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("[printer] WARNING: non-Windows host; writing receipt bytes to temp file");
        write_fallback_ack(&bytes)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_cash_drawer(printer_name: Option<String>) -> Result<PrintJobAck, String> {
    #[cfg(target_os = "windows")]
    {
        submit_to_broker(&DRAWER_PULSE, &resolve_printer_name(printer_name), "cash_drawer").await
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Thermal printer is only supported on Windows.".to_string())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn print_raw_text(text: String, printer_name: Option<String>) -> Result<PrintJobAck, String> {
    #[cfg(target_os = "windows")]
    {
        submit_to_broker(&text_to_esc_pos(&text), &resolve_printer_name(printer_name), "caja_summary").await
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("[printer] WARNING: non-Windows host; writing raw text bytes to temp file");
        write_fallback_ack(&text_to_esc_pos(&text))
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn test_print(printer_name: Option<String>) -> Result<PrintJobAck, String> {
    let lines = vec![
        "Bar POS".to_string(),
        "TEST PRINT".to_string(),
        String::new(),
    ];
    let bytes = lines_to_esc_pos(&lines);
    submit_to_broker(&bytes, &resolve_printer_name(printer_name), "test_print").await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed value for every test below that calls `submit_to_broker_to`
    /// directly — the mock broker never checks it, but a real secret
    /// parameter (rather than resolving `%ProgramData%\PrintBroker\
    /// client-secret.txt` inside `submit_to_broker_to` itself) means these
    /// tests never depend on the host machine having a broker installed.
    const TEST_SECRET: &str = "test-secret-for-mock-broker";

    /// Encodes a solid-color `width`x`height` RGB fixture as an in-memory PNG,
    /// exercising the real `image::load_from_memory` decode path in tests
    /// rather than just the packing math in isolation.
    fn solid_fixture_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let img = image::RgbImage::from_fn(width, height, |_, _| image::Rgb(rgb));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .expect("encoding fixture PNG must not fail");
        buf
    }

    #[test]
    fn encode_logo_raster_solid_black_8x8() {
        let png = solid_fixture_png(8, 8, [0, 0, 0]);
        let out = encode_logo_raster(&png, 8).expect("encode must succeed");
        assert_eq!(&out[0..8], &[0x1D, 0x76, 0x30, 0x00, 0x01, 0x00, 0x08, 0x00]);
        assert_eq!(&out[8..], &[0xFF; 8]);
    }

    #[test]
    fn encode_logo_raster_solid_white_8x8() {
        let png = solid_fixture_png(8, 8, [255, 255, 255]);
        let out = encode_logo_raster(&png, 8).expect("encode must succeed");
        assert_eq!(&out[0..8], &[0x1D, 0x76, 0x30, 0x00, 0x01, 0x00, 0x08, 0x00]);
        assert_eq!(&out[8..], &[0x00; 8]);
    }

    #[test]
    fn encode_logo_raster_non_multiple_of_8_width_pads_with_zero() {
        let png = solid_fixture_png(12, 12, [0, 0, 0]);
        let out = encode_logo_raster(&png, 12).expect("encode must succeed");
        // width_bytes = ceil(12/8) = 2, height = 12 -> header yL=12,yH=0
        assert_eq!(&out[0..8], &[0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x0C, 0x00]);
        let data = &out[8..];
        assert_eq!(data.len(), 2 * 12);
        for row in data.chunks(2) {
            assert_eq!(row, &[0xFF, 0xF0]);
        }
    }

    #[test]
    fn decode_data_url_rejects_oversized_payload_before_image_decode() {
        // A base64 payload whose decoded length exceeds the 512KB cap must be
        // rejected by decode_data_url alone, never reaching image::load_from_memory.
        let oversized_bytes = vec![0u8; MAX_LOGO_DECODED_BYTES + 1];
        let b64 = BASE64_STANDARD.encode(&oversized_bytes);
        let data_url = format!("data:image/png;base64,{b64}");
        let result = decode_data_url(&data_url);
        assert!(result.is_err());
    }

    #[test]
    fn encode_logo_raster_returns_err_not_panic_on_non_image_bytes() {
        let not_a_real_png = b"not a real png";
        let result = encode_logo_raster(not_a_real_png, 8);
        assert!(result.is_err());
    }

    #[test]
    fn decode_data_url_rejects_missing_comma_separator() {
        let malformed = "data:image/png;base64NOCOMMA";
        let result = decode_data_url(malformed);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_printer_name_uses_configured_value_when_present() {
        assert_eq!(resolve_printer_name(Some("EPSON TM-T88V".to_string())), "EPSON TM-T88V");
    }

    #[test]
    fn resolve_printer_name_falls_back_to_default_when_none_or_blank() {
        assert_eq!(resolve_printer_name(None), default_printer_name());
        assert_eq!(resolve_printer_name(Some(String::new())), default_printer_name());
        assert_eq!(resolve_printer_name(Some("   ".to_string())), default_printer_name());
    }

    #[test]
    fn text_to_esc_pos_prefixes_init_then_emits_raw_bytes_unchanged() {
        let out = text_to_esc_pos("hello\nworld");
        assert_eq!(&out[0..2], &[ESC, b'@']);
        assert_eq!(&out[2..], b"hello\nworld");
    }

    /// Binds an ephemeral port, accepts exactly one connection on a background
    /// thread, drains the request, and replies with a canned 200 JSON
    /// PrintJobAck body — a minimal in-process stand-in for the real broker
    /// so `submit_to_broker_to` can be exercised without a live broker
    /// process (mirrors the raw-TCP-client test pattern already used in
    /// broker/src/http.rs, just server-side instead of client-side).
    #[cfg(target_os = "windows")]
    fn spawn_mock_broker_accepting(job_id: &str) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let addr = listener.local_addr().expect("read local addr");
        let body = format!(r#"{{"job_id":"{job_id}","status":"accepted"}}"#);

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf); // drain the request; body content is not asserted here
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        format!("http://{addr}")
    }

    /// Reserves an ephemeral port and immediately releases it without ever
    /// accepting a connection — connecting to it deterministically fails
    /// with "connection refused", simulating an unreachable broker.
    #[cfg(target_os = "windows")]
    fn unreachable_broker_url() -> String {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port to find a free one");
        let addr = listener.local_addr().expect("read local addr");
        drop(listener);
        format!("http://{addr}")
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn print_receipt_broker_success_returns_ack_with_job_id_never_falls_back() {
        let broker_url = spawn_mock_broker_accepting("job-abc-123");
        let bytes = build_print_payload(&["line".to_string()], None, 32);

        let result = tauri::async_runtime::block_on(submit_to_broker_to(
            &broker_url,
            TEST_SECRET,
            &bytes,
            &default_printer_name(),
            "receipt",
        ));

        let ack = result.expect("mocked broker success must return Ok(PrintJobAck)");
        assert_eq!(ack.job_id, "job-abc-123");
        assert!(!ack.job_id.is_empty());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn print_receipt_broker_failure_returns_err_never_silent_ok() {
        let broker_url = unreachable_broker_url();
        let bytes = build_print_payload(&["line".to_string()], None, 32);

        let result = tauri::async_runtime::block_on(submit_to_broker_to(
            &broker_url,
            TEST_SECRET,
            &bytes,
            &default_printer_name(),
            "receipt",
        ));

        assert!(
            result.is_err(),
            "an unreachable broker must return Err — never a silent Ok(()) fallback (PRN-02)"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn open_cash_drawer_broker_success_returns_ack_with_job_id() {
        let broker_url = spawn_mock_broker_accepting("job-drawer-1");

        let result = tauri::async_runtime::block_on(submit_to_broker_to(
            &broker_url,
            TEST_SECRET,
            &DRAWER_PULSE,
            &default_printer_name(),
            "cash_drawer",
        ));

        let ack = result.expect("mocked broker success must return Ok(PrintJobAck)");
        assert_eq!(ack.job_id, "job-drawer-1");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn open_cash_drawer_broker_failure_returns_err_never_silent_ok() {
        let broker_url = unreachable_broker_url();

        let result = tauri::async_runtime::block_on(submit_to_broker_to(
            &broker_url,
            TEST_SECRET,
            &DRAWER_PULSE,
            &default_printer_name(),
            "cash_drawer",
        ));

        assert!(result.is_err());
    }
}
