//! The local assistant bridge: three narrow Tauri commands in front of a per-user llama-server child.
//!
//! The renderer can read the assistant's state, send one chat request and cancel it. The loopback port and the
//! per-launch key live only in `AssistantState` (Rust memory) and never appear in any command result. Start-up
//! (verify the signed install, spawn, wait for health) runs on its own thread and can never block or fail the POS: any
//! problem leaves the assistant reported as `unavailable` or `not_installed`.

// Off Windows only the pure helpers and tests are compiled in; the start-up path is Windows-only.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod bridge;
pub mod manifest;
pub mod sidecar;

use bridge::ChatMessage;
use manifest::{Profile, RequestSpec};
use serde::Serialize;
use serde_json::Value;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::Manager;

/// The manifest's `timeout_ms` is clamped to this (AI-SPEC §4: 8 s).
const MAX_TIMEOUT_MS: u64 = 8_000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NotInstalled,
    Starting,
    Ready,
    Unavailable,
}

/// What the renderer may know. There is deliberately no field for the port, the key or the install path.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatusDto {
    pub state: State,
    pub reason: Option<String>,
    pub model_id: Option<String>,
    pub runtime_tag: Option<String>,
}

struct Inner {
    state: State,
    reason: Option<String>,
    model_id: Option<String>,
    runtime_tag: Option<String>,
    port: Option<u16>,
    key: Option<String>,
    spec: Option<RequestSpec>,
    profile: Option<Profile>,
    child: Option<std::process::Child>,
    /// Held for the app lifetime: dropping it (app exit) kills the child.
    #[cfg(windows)]
    job: Option<sidecar::Job>,
    health_failures: u32,
    /// Set while available memory is below the profile floor; the assistant reads as unavailable but keeps running.
    memory_pressure: bool,
    /// The one request in flight: its id and a closure that aborts it.
    inflight: Option<(String, Box<dyn Fn() + Send>)>,
}

pub struct AssistantState {
    inner: Mutex<Inner>,
    client: reqwest::Client,
    /// Available physical memory now; replaced in tests.
    avail_mem: Box<dyn Fn() -> Option<u64> + Send + Sync>,
}

impl AssistantState {
    pub fn new() -> AssistantState {
        AssistantState {
            inner: Mutex::new(Inner {
                state: State::NotInstalled,
                reason: None,
                model_id: None,
                runtime_tag: None,
                port: None,
                key: None,
                spec: None,
                profile: None,
                child: None,
                #[cfg(windows)]
                job: None,
                health_failures: 0,
                memory_pressure: false,
                inflight: None,
            }),
            client: bridge::loopback_client(),
            avail_mem: Box::new(sidecar::available_memory_bytes),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, state: State, reason: Option<&str>) {
        let mut g = self.lock();
        g.state = state;
        g.reason = reason.map(str::to_owned);
        g.memory_pressure = false;
        g.health_failures = 0;
        if state != State::Ready {
            g.port = None;
            g.key = None;
        }
    }

    /// Re-reads available memory; true while the assistant should refuse work. Recovers by itself when memory does.
    fn refresh_pressure(&self, g: &mut Inner) -> bool {
        g.memory_pressure = match &g.profile {
            Some(p) if g.state == State::Ready => sidecar::pressure((self.avail_mem)(), p),
            _ => false,
        };
        g.memory_pressure
    }

    pub fn status(&self) -> AssistantStatusDto {
        let mut g = self.lock();
        let pressured = self.refresh_pressure(&mut g);
        let (state, reason) = if pressured { (State::Unavailable, Some("MEMORY_PRESSURE".to_owned())) } else { (g.state, g.reason.clone()) };
        AssistantStatusDto { state, reason, model_id: g.model_id.clone(), runtime_tag: g.runtime_tag.clone() }
    }

    /// `status()` after a liveness check of the running server: a child that exited, or three /health failures in a row,
    /// switch the assistant off (no automatic restart). Checkout is never involved.
    pub async fn status_checked(&self) -> AssistantStatusDto {
        let port = {
            let mut g = self.lock();
            if g.state == State::Ready && g.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(Some(_)))) {
                drop(g);
                self.set(State::Unavailable, Some("EXITED"));
                return self.status();
            }
            if g.state == State::Ready { g.port } else { None }
        };
        if let Some(port) = port {
            let ok = sidecar::health_ok_async(&self.client, port).await;
            let mut g = self.lock();
            if g.state == State::Ready {
                let (failures, dead) = sidecar::next_health(g.health_failures, ok);
                g.health_failures = failures;
                if dead {
                    if let Some(c) = g.child.as_mut() {
                        let _ = c.kill(); // our own child, never by name
                    }
                    drop(g);
                    self.set(State::Unavailable, Some("HEALTH_FAILED"));
                }
            }
        }
        self.status()
    }

    /// Verify the install, start the server, wait for health. Blocking; runs on its own thread.
    fn run_start(&self) {
        let Some(loc) = sidecar::install_dir() else {
            return self.set(State::NotInstalled, Some("NOT_WINDOWS"));
        };
        if !loc.dir.join("manifest.json").exists() {
            return self.set(State::NotInstalled, None);
        }
        self.set(State::Starting, None);
        if let Err(code) = self.start_verified(&loc) {
            self.set(State::Unavailable, Some(code));
        }
    }

    #[cfg(windows)]
    fn start_verified(&self, loc: &sidecar::InstallLocation) -> Result<(), &'static str> {
        if loc.vet {
            let pf = crate::commands::posctl_console::known_program_files().ok_or("UNTRUSTED_PATH")?;
            sidecar::check_trusted(&loc.dir, &pf, &crate::path_owner_sid, &crate::path_is_reparse_point, &crate::drive_is_fixed)?;
        }
        let verified = manifest::verify_install(&loc.dir).map_err(|c| if c == "NOT_INSTALLED" { "MANIFEST_INVALID" } else { c })?;
        let port = sidecar::pick_port().map_err(|_| "NO_PORT")?;
        let key = sidecar::new_key();
        let cpus = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(2);
        let model = loc.dir.join(&verified.manifest.model_file);
        let args = sidecar::build_args(&verified.manifest, port, &model, cpus)?;
        let exe = loc.dir.join(manifest::RUNTIME_EXE);
        // ASSUMED env name, verified against the pinned binary's --help in Plan 29-07 (fallback: --api-key-file).
        let limits = sidecar::job_limits_from(&verified.manifest.profile);
        let mut spawned = sidecar::spawn_with_args(&exe, &args, &[("LLAMA_API_KEY", key.as_str())], Some(&limits)).map_err(|_| "SPAWN_FAILED")?;
        if let Err(code) = sidecar::wait_healthy(&self.client, port, &mut spawned.child, sidecar::health_wait_default()) {
            let _ = spawned.child.kill();
            return Err(code);
        }
        let mut g = self.lock();
        g.model_id = Some(verified.model_id.clone());
        g.runtime_tag = Some(verified.runtime_tag.clone());
        g.spec = Some(verified.manifest.request.clone());
        g.profile = Some(verified.manifest.profile.clone());
        g.job = spawned.job.take();
        g.port = Some(port);
        g.key = Some(key);
        g.child = Some(spawned.child);
        g.state = State::Ready;
        g.reason = None;
        Ok(())
    }

    #[cfg(not(windows))]
    fn start_verified(&self, _loc: &sidecar::InstallLocation) -> Result<(), &'static str> {
        Err("NOT_WINDOWS")
    }

    pub async fn infer(&self, request_id: String, messages: Vec<ChatMessage>, schema: Value) -> Result<String, &'static str> {
        bridge::validate_request(&messages, &schema)?;
        if request_id.is_empty() || request_id.len() > 64 {
            return Err("INVALID_REQUEST");
        }
        let join = {
            let mut g = self.lock();
            match g.state {
                State::Ready => {}
                State::Unavailable => return Err("UNAVAILABLE"),
                State::NotInstalled | State::Starting => return Err("NOT_READY"),
            }
            if self.refresh_pressure(&mut g) {
                return Err("MEMORY_PRESSURE");
            }
            if g.inflight.is_some() {
                return Err("BUSY");
            }
            let (Some(port), Some(key), Some(spec)) = (g.port, g.key.clone(), g.spec.clone()) else { return Err("NOT_READY") };
            let body = bridge::build_request_body(&messages, &schema, &spec);
            let timeout = Duration::from_millis(spec.timeout_ms.clamp(1, MAX_TIMEOUT_MS));
            let client = self.client.clone();
            let join = tauri::async_runtime::spawn(async move { bridge::infer(&client, port, &key, &body, timeout).await });
            let abort = join.inner().abort_handle();
            g.inflight = Some((request_id.clone(), Box::new(move || abort.abort())));
            join
        };
        let out = join.await;
        {
            let mut g = self.lock();
            if g.inflight.as_ref().is_some_and(|(id, _)| *id == request_id) {
                g.inflight = None;
            }
        }
        match out {
            Ok(result) => result,
            Err(_) => Err("CANCELLED"),
        }
    }

    pub fn cancel(&self, request_id: &str) {
        let g = self.lock();
        if let Some((id, abort)) = &g.inflight {
            if id == request_id {
                abort();
            }
        }
    }
}

impl Default for AssistantState {
    fn default() -> Self {
        Self::new()
    }
}

/// Called once from `setup()`. Never blocks start-up and never panics the app.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        app.state::<AssistantState>().run_start();
    });
}

#[tauri::command]
pub async fn assistant_status(state: tauri::State<'_, AssistantState>) -> Result<AssistantStatusDto, String> {
    Ok(state.status_checked().await)
}

#[tauri::command]
pub async fn assistant_infer(state: tauri::State<'_, AssistantState>, request_id: String, messages: Vec<ChatMessage>, schema: Value) -> Result<String, String> {
    state.infer(request_id, messages, schema).await.map_err(str::to_owned)
}

#[tauri::command]
pub fn assistant_cancel(state: tauri::State<'_, AssistantState>, request_id: String) {
    state.cancel(&request_id);
}

#[cfg(test)]
mod tests {
    use super::bridge::fake::*;
    use super::*;
    use serde_json::json;

    const SECRET_KEY: &str = "k-9f8e7d6c5b4a39281716059483726150";

    fn ready_state(port: u16, timeout_ms: u64) -> AssistantState {
        let st = AssistantState::new();
        {
            let mut g = st.lock();
            g.state = State::Ready;
            g.model_id = Some("test-model".into());
            g.runtime_tag = Some("b0000".into());
            g.port = Some(port);
            g.key = Some(SECRET_KEY.into());
            g.spec = Some(RequestSpec { max_tokens: 160, timeout_ms, extra: json!({}) });
        }
        st
    }
    fn msgs() -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: "hola".into() }]
    }
    fn ask(st: &AssistantState, id: &str) -> Result<String, &'static str> {
        tauri::async_runtime::block_on(st.infer(id.into(), msgs(), json!({ "type": "object" })))
    }

    #[test]
    fn status_exposes_no_port_or_key() {
        let st = ready_state(54321, 8000);
        let json = serde_json::to_value(st.status()).unwrap();
        for k in json.as_object().unwrap().keys() {
            let k = k.to_lowercase();
            assert!(!["port", "key", "token", "secret"].iter().any(|bad| k.contains(bad)), "status key {k}");
        }
        assert_eq!(json["state"], "ready");
        assert_eq!(json["modelId"], "test-model");
        assert_eq!(json["runtimeTag"], "b0000");
        let text = json.to_string();
        assert!(!text.contains(SECRET_KEY) && !text.contains("54321"), "{text}");
    }

    #[test]
    fn status_serializes_every_state_in_snake_case() {
        let s = |st| serde_json::to_value(AssistantStatusDto { state: st, reason: None, model_id: None, runtime_tag: None }).unwrap()["state"].clone();
        assert_eq!([s(State::NotInstalled), s(State::Starting), s(State::Ready), s(State::Unavailable)], ["not_installed", "starting", "ready", "unavailable"]);
    }

    fn with_profile(mut st: AssistantState, avail: std::sync::Arc<std::sync::atomic::AtomicU64>) -> AssistantState {
        let profile = serde_json::from_str::<manifest::Manifest>(manifest::fixtures::MANIFEST).unwrap().profile;
        st.lock().profile = Some(profile);
        st.avail_mem = Box::new(move || Some(avail.load(std::sync::atomic::Ordering::SeqCst)));
        st
    }

    #[test]
    fn memory_pressure_refuses_infer_without_a_server_and_recovers() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let floor = 1_500_000_000;
        let avail = std::sync::Arc::new(AtomicU64::new(floor - 1));
        // port 1 would refuse a connection: reaching the server would give UNAVAILABLE, not MEMORY_PRESSURE
        let st = with_profile(ready_state(1, 8000), avail.clone());
        assert_eq!(ask(&st, "r1"), Err("MEMORY_PRESSURE"));
        let s = st.status();
        assert_eq!((s.state, s.reason.as_deref()), (State::Unavailable, Some("MEMORY_PRESSURE")));
        avail.store(floor, Ordering::SeqCst);
        let s = st.status();
        assert_eq!((s.state, s.reason), (State::Ready, None), "recovers when memory does");
        assert_eq!(st.lock().port, Some(1), "the server was never stopped");
    }

    #[test]
    fn three_failed_health_checks_in_a_row_switch_the_assistant_off() {
        let (port, _, h) = serve(vec![Reply::Status(500), Reply::Status(200), Reply::Status(500), Reply::Status(500), Reply::Status(500)]);
        let st = ready_state(port, 8000);
        let poll = |st: &AssistantState| tauri::async_runtime::block_on(st.status_checked());
        assert_eq!(poll(&st).state, State::Ready);
        assert_eq!(poll(&st).state, State::Ready, "a 200 resets the count");
        assert_eq!(poll(&st).state, State::Ready);
        assert_eq!(poll(&st).state, State::Ready, "two failures so far");
        let s = poll(&st);
        assert_eq!((s.state, s.reason.as_deref()), (State::Unavailable, Some("HEALTH_FAILED")));
        h.join().unwrap();
        assert_eq!(ask(&st, "r1"), Err("UNAVAILABLE"));
    }

    #[test]
    fn infer_before_ready_is_refused_without_a_server() {
        let st = AssistantState::new();
        assert_eq!(ask(&st, "r1"), Err("NOT_READY"));
        st.set(State::Starting, None);
        assert_eq!(ask(&st, "r1"), Err("NOT_READY"));
        st.set(State::Unavailable, Some("EXITED"));
        assert_eq!(ask(&st, "r1"), Err("UNAVAILABLE"));
    }

    #[test]
    fn infer_rejects_a_bad_request_before_anything_else() {
        let st = ready_state(1, 8000);
        let bad = vec![ChatMessage { role: "tool".into(), content: "x".into() }];
        assert_eq!(tauri::async_runtime::block_on(st.infer("r".into(), bad, json!({}))), Err("INVALID_REQUEST"));
        assert_eq!(ask(&st, ""), Err("INVALID_REQUEST"));
    }

    #[test]
    fn infer_round_trips_through_the_bridge() {
        let (port, seen, h) = serve(vec![Reply::Json(completion(r#"{"kind":"refuse"}"#))]);
        let st = ready_state(port, 8000);
        assert_eq!(ask(&st, "r1").as_deref(), Ok(r#"{"kind":"refuse"}"#));
        h.join().unwrap();
        assert!(seen.lock().unwrap()[0].0.contains(&format!("authorization: bearer {SECRET_KEY}")));
        assert!(st.lock().inflight.is_none(), "the slot is freed");
    }

    #[test]
    fn a_second_infer_while_one_runs_is_busy_and_cancel_aborts_the_first() {
        let (port, _, _h) = serve(vec![Reply::Slow(Duration::from_millis(3000), completion("late"))]);
        let st = std::sync::Arc::new(ready_state(port, 8000));
        let first = {
            let st = st.clone();
            std::thread::spawn(move || ask(&st, "r1"))
        };
        while st.lock().inflight.is_none() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(ask(&st, "r2"), Err("BUSY"));
        st.cancel("other-id");
        assert!(st.lock().inflight.is_some(), "a different id cancels nothing");
        st.cancel("r1");
        assert_eq!(first.join().unwrap(), Err("CANCELLED"));
        assert!(st.lock().inflight.is_none());
    }
}
