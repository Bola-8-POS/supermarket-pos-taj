//! Print-job audit read path: `get_print_jobs`/`get_print_job` call the
//! broker's `GET /jobs`/`GET /jobs/{id}` HTTP endpoints — never Supabase
//! (RESEARCH.md Pitfall 5). Reuses `printer.rs`'s `submit_to_broker`
//! reqwest client-builder shape (connect-timeout, bearer auth, the IPv4
//! literal `127.0.0.1:8973`), swapped from POST to GET.

use serde::{Deserialize, Serialize};

const BROKER_URL: &str = "http://127.0.0.1:8973";
const BROKER_CONNECT_TIMEOUT_MS: u64 = 1500;

fn broker_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(BROKER_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())
}

/// Filters accepted by `get_print_jobs`, matching the broker's `GET /jobs`
/// query-string parameters 1:1 (`fromMs`/`toMs` are epoch-millisecond
/// integers computed client-side via `Date.getTime()` — no date-parsing
/// crate needed on this side).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobFiltersReq {
    pub origin: Option<String>,
    pub printer_name: Option<String>,
    pub status: Option<String>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

impl PrintJobFiltersReq {
    fn to_query_string(&self, page_param: u32) -> String {
        let mut pairs: Vec<String> = Vec::new();
        if let Some(v) = &self.origin {
            pairs.push(format!("origin={v}"));
        }
        if let Some(v) = &self.printer_name {
            pairs.push(format!("printer_name={v}"));
        }
        if let Some(v) = &self.status {
            pairs.push(format!("status={v}"));
        }
        if let Some(v) = self.from_ms {
            pairs.push(format!("from_ms={v}"));
        }
        if let Some(v) = self.to_ms {
            pairs.push(format!("to_ms={v}"));
        }
        pairs.push(format!("offset={page_param}"));
        pairs.join("&")
    }
}

#[derive(Serialize, Deserialize)]
pub struct PrintJobRow {
    pub job_id: String,
    pub status: String,
    pub origin: String,
    pub printer_name: String,
    pub attempts: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct PrintJobsPage {
    pub jobs: Vec<PrintJobRow>,
    pub total: i64,
}

#[derive(Serialize, Deserialize)]
pub struct PrintJobEventRow {
    pub ts: String,
    pub category: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct PrintJobDetailResp {
    pub job_id: String,
    pub status: String,
    pub origin: String,
    pub printer_name: String,
    pub attempts: i64,
    pub win32_job_id: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub events: Vec<PrintJobEventRow>,
}

#[derive(Serialize, Deserialize)]
pub struct PrinterList {
    pub printers: Vec<String>,
    pub default: Option<String>,
}

/// Proxies the broker's `GET /printers` — installed Windows printer queue
/// names plus the OS-configured default, for the Settings printer-select
/// dropdown (closes the gap where the Tauri print commands sent a hardcoded
/// placeholder printer name that never matched real hardware).
#[tauri::command(rename_all = "camelCase")]
pub async fn list_printers() -> Result<PrinterList, String> {
    let client = broker_client()?;
    let secret = crate::commands::broker_secret::resolve_broker_secret()?;
    let resp = client
        .get(format!("{BROKER_URL}/printers"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|e| format!("broker unreachable: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("broker rejected request: HTTP {}", resp.status()));
    }
    resp.json::<PrinterList>().await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_print_jobs(filters: PrintJobFiltersReq, page_param: u32) -> Result<PrintJobsPage, String> {
    let client = broker_client()?;
    let secret = crate::commands::broker_secret::resolve_broker_secret()?;
    let query = filters.to_query_string(page_param);
    let resp = client
        .get(format!("{BROKER_URL}/jobs?{query}"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|e| format!("broker unreachable: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("broker rejected request: HTTP {}", resp.status()));
    }
    resp.json::<PrintJobsPage>().await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_print_job(job_id: String) -> Result<PrintJobDetailResp, String> {
    let client = broker_client()?;
    let secret = crate::commands::broker_secret::resolve_broker_secret()?;
    let resp = client
        .get(format!("{BROKER_URL}/jobs/{job_id}"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|e| format!("broker unreachable: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("broker rejected request: HTTP {}", resp.status()));
    }
    resp.json::<PrintJobDetailResp>().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test 5: get_print_jobs deserializes the broker's GET /jobs JSON
    // response into a typed Vec<PrintJobRow> without panicking on an empty
    // jobs array.
    #[test]
    fn print_jobs_page_deserializes_empty_jobs_array_without_panicking() {
        let body = r#"{"jobs":[],"total":0}"#;
        let page: PrintJobsPage = serde_json::from_str(body).expect("must deserialize empty jobs array");
        assert!(page.jobs.is_empty());
        assert_eq!(page.total, 0);
    }

    #[test]
    fn print_jobs_page_deserializes_populated_jobs_array() {
        let body = r#"{"jobs":[{"job_id":"j1","status":"accepted","origin":"receipt","printer_name":"P","attempts":0,"created_at":"1","updated_at":"1"}],"total":1}"#;
        let page: PrintJobsPage = serde_json::from_str(body).expect("must deserialize");
        assert_eq!(page.jobs.len(), 1);
        assert_eq!(page.jobs[0].job_id, "j1");
    }

    #[test]
    fn filters_req_builds_query_string_from_present_fields_only() {
        let filters = PrintJobFiltersReq {
            origin: Some("receipt".to_string()),
            printer_name: None,
            status: Some("failed".to_string()),
            from_ms: None,
            to_ms: None,
        };
        let qs = filters.to_query_string(0);
        assert!(qs.contains("origin=receipt"));
        assert!(qs.contains("status=failed"));
        assert!(!qs.contains("printer_name="));
        assert!(qs.contains("offset=0"));
    }
}
