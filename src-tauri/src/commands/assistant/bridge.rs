//! The one HTTP call the assistant makes: a chat completion on the loopback llama-server. Everything that shapes the
//! request is fixed here (temperature 0, bounded output, no streaming, schema-constrained); the renderer supplies only
//! the messages and the JSON schema, both size-checked first. Errors are the short codes of the bridge contract.

use super::manifest::RequestSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// Sized for the real prompt (system + 42 few-shot + user = 44) with headroom; the contract test pins it (review CR-01).
pub const MAX_MESSAGES: usize = 64;
pub const MAX_CONTENT_CHARS: usize = 4000;
pub const MAX_SCHEMA_BYTES: usize = 64 * 1024;
/// Hard ceiling on output tokens whatever the manifest says (AI-SPEC §4).
pub const MAX_OUTPUT_TOKENS: u32 = 160;
const MAX_REPLY_BYTES: usize = 4096;
const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// `INVALID_REQUEST` when the renderer's request is oversized or malformed.
pub fn validate_request(messages: &[ChatMessage], schema: &Value) -> Result<(), &'static str> {
    let ok = !messages.is_empty()
        && messages.len() <= MAX_MESSAGES
        && messages.iter().all(|m| matches!(m.role.as_str(), "system" | "user" | "assistant") && m.content.chars().count() <= MAX_CONTENT_CHARS)
        && serde_json::to_vec(schema).map(|b| b.len() <= MAX_SCHEMA_BYTES).unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("INVALID_REQUEST")
    }
}

/// The request body. Manifest `extra` keys are merged first so they can never override the fixed ones.
pub fn build_request_body(messages: &[ChatMessage], schema: &Value, spec: &RequestSpec) -> Value {
    let mut body = match &spec.extra {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    body.insert("messages".into(), json!(messages));
    body.insert("temperature".into(), json!(0));
    body.insert("max_tokens".into(), json!(spec.max_tokens.min(MAX_OUTPUT_TOKENS)));
    body.insert("stream".into(), json!(false));
    // The OpenAI nesting (`json_schema.schema`): measured in Plan 29-07 against llama-server b12201, the flat
    // `{type, schema}` form is accepted but NOT enforced (free text came back unconstrained), this one is.
    body.insert("response_format".into(), json!({ "type": "json_schema", "json_schema": { "name": "proposal", "strict": true, "schema": schema } }));
    Value::Object(body)
}

async fn attempt(client: &reqwest::Client, url: &str, key: &str, body: &Value, timeout: Duration) -> Result<String, Failure> {
    let resp = client.post(url).bearer_auth(key).timeout(timeout).json(body).send().await.map_err(Failure::from_send)?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 || status.as_u16() == 503 {
        return Err(Failure::Final("UNAVAILABLE"));
    }
    if !status.is_success() {
        return Err(Failure::Final("BAD_RESPONSE"));
    }
    let bytes = resp.bytes().await.map_err(|e| if e.is_timeout() { Failure::Final("TIMEOUT") } else { Failure::Final("BAD_RESPONSE") })?;
    if bytes.len() > MAX_HTTP_BODY_BYTES {
        return Err(Failure::Final("BAD_RESPONSE"));
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Final("BAD_RESPONSE"))?;
    match parsed["choices"][0]["message"]["content"].as_str() {
        Some(text) if text.len() <= MAX_REPLY_BYTES => Ok(text.to_owned()),
        _ => Err(Failure::Final("BAD_RESPONSE")),
    }
}

enum Failure {
    /// Nothing came back from the server at all (refused, reset, closed): worth one retry.
    Transport,
    Final(&'static str),
}

impl Failure {
    fn from_send(e: reqwest::Error) -> Failure {
        if e.is_timeout() {
            Failure::Final("TIMEOUT")
        } else if e.is_connect() || e.is_request() {
            Failure::Transport
        } else {
            Failure::Final("BAD_RESPONSE")
        }
    }
}

/// Posts the completion and returns `choices[0].message.content` (at most 4 KB). One retry only, and only when the
/// first attempt got no response bytes at all.
pub async fn infer(client: &reqwest::Client, port: u16, key: &str, body: &Value, timeout: Duration) -> Result<String, &'static str> {
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    for tries_left in [1u8, 0] {
        match attempt(client, &url, key, body, timeout).await {
            Ok(text) => return Ok(text),
            Err(Failure::Final(code)) => return Err(code),
            Err(Failure::Transport) if tries_left == 0 => return Err("UNAVAILABLE"),
            Err(Failure::Transport) => {}
        }
    }
    Err("UNAVAILABLE")
}

/// A client that never goes through a proxy: loopback traffic must not leave the machine.
pub fn loopback_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod fake {
    //! A throwaway HTTP server on 127.0.0.1 for the bridge tests: one scripted reply per accepted connection.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    pub enum Reply {
        /// 200 with this body.
        Json(String),
        /// This status line and an empty body.
        Status(u16),
        /// Sleep, then 200 with this body.
        Slow(Duration, String),
        /// Accept and hang up without a byte.
        Hangup,
    }

    /// Headers (lower-cased names) and the body of each request seen.
    pub type Seen = Arc<Mutex<Vec<(String, String)>>>;

    pub fn serve(script: Vec<Reply>) -> (u16, Seen, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let handle = std::thread::spawn(move || {
            for reply in script {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                // read until the headers end and the declared body has arrived
                let (head, body) = loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    raw.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(pos) = text.find("\r\n\r\n") {
                        let head = text[..pos].to_ascii_lowercase();
                        let want = head.lines().find_map(|l| l.strip_prefix("content-length: ")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        if raw.len() >= pos + 4 + want {
                            break (head, text[pos + 4..].to_owned());
                        }
                    }
                    if n == 0 {
                        break (text, String::new());
                    }
                };
                log.lock().unwrap().push((head, body));
                let (status, payload) = match reply {
                    Reply::Hangup => continue,
                    Reply::Json(b) => (200, b),
                    Reply::Status(s) => (s, String::new()),
                    Reply::Slow(d, b) => {
                        std::thread::sleep(d);
                        (200, b)
                    }
                };
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
            }
        });
        (port, seen, handle)
    }

    pub fn completion(content: &str) -> String {
        serde_json::json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn spec() -> RequestSpec {
        RequestSpec { max_tokens: 160, timeout_ms: 8000, extra: json!({ "chat_template_kwargs": { "enable_thinking": false } }) }
    }
    fn msgs() -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: "price of milk".into() }]
    }
    fn run(port: u16, key: &str, timeout_ms: u64) -> Result<String, &'static str> {
        let body = build_request_body(&msgs(), &json!({ "type": "object" }), &spec());
        tauri::async_runtime::block_on(infer(&loopback_client(), port, key, &body, Duration::from_millis(timeout_ms)))
    }

    #[test]
    fn validate_request_caps_messages_content_roles_and_schema() {
        let schema = json!({ "type": "object" });
        assert!(validate_request(&msgs(), &schema).is_ok());
        assert!(validate_request(&[], &schema).is_err());
        let many: Vec<_> = (0..MAX_MESSAGES + 1).map(|_| msgs().remove(0)).collect();
        assert_eq!(validate_request(&many, &schema), Err("INVALID_REQUEST"));
        let at_cap = ChatMessage { role: "user".into(), content: "ñ".repeat(MAX_CONTENT_CHARS) };
        assert!(validate_request(&[at_cap], &schema).is_ok(), "the cap counts characters, not bytes");
        let long = ChatMessage { role: "user".into(), content: "x".repeat(MAX_CONTENT_CHARS + 1) };
        assert_eq!(validate_request(&[long], &schema), Err("INVALID_REQUEST"));
        let tool = ChatMessage { role: "tool".into(), content: "x".into() };
        assert_eq!(validate_request(&[tool], &schema), Err("INVALID_REQUEST"));
        let big_schema = json!({ "pad": "x".repeat(MAX_SCHEMA_BYTES) });
        assert_eq!(validate_request(&msgs(), &big_schema), Err("INVALID_REQUEST"));
    }

    /// Review CR-01: the renderer's real worst-case request (written by `bridge-contract.test.ts` from the real prompt
    /// builder) must pass the bridge's own validation. Regenerate the fixture with UPDATE_ASSISTANT_FIXTURE=1.
    #[test]
    fn worst_case_renderer_request_is_accepted() {
        #[derive(Deserialize)]
        struct Req {
            messages: Vec<ChatMessage>,
            schema: Value,
        }
        let req: Req = serde_json::from_str(include_str!("fixtures/worst-case-infer-request.json")).expect("fixture parses");
        assert!(req.messages.len() > 12, "fixture should be the few-shot prompt, not a stub");
        assert_eq!(validate_request(&req.messages, &req.schema), Ok(()));
    }

    #[test]
    fn request_body_is_fixed_by_rust() {
        let mut s = spec();
        s.max_tokens = 5000;
        s.extra = json!({ "temperature": 1.5, "stream": true, "max_tokens": 9999, "chat_template_kwargs": { "enable_thinking": false } });
        let body = build_request_body(&msgs(), &json!({ "type": "object" }), &s);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 160);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["schema"]["type"], "object", "nested form: the flat one is not enforced by llama-server");
        assert!(body["response_format"].get("schema").is_none());
        assert_eq!(body["messages"][0]["content"], "price of milk");
    }

    #[test]
    fn infer_returns_the_message_content_with_the_bearer_key() {
        let (port, seen, h) = serve(vec![Reply::Json(completion(r#"{"kind":"refuse"}"#))]);
        assert_eq!(run(port, "good-key", 2000).as_deref(), Ok(r#"{"kind":"refuse"}"#));
        h.join().unwrap();
        let log = seen.lock().unwrap();
        assert!(log[0].0.contains("authorization: bearer good-key"), "{}", log[0].0);
        assert!(log[0].1.contains("\"temperature\":0"), "{}", log[0].1);
    }

    #[test]
    fn infer_without_the_right_key_is_unavailable() {
        let (port, _, h) = serve(vec![Reply::Status(401)]);
        assert_eq!(run(port, "wrong", 2000), Err("UNAVAILABLE"));
        h.join().unwrap();
    }

    #[test]
    fn infer_times_out() {
        let (port, _, h) = serve(vec![Reply::Slow(Duration::from_millis(1500), completion("late"))]);
        assert_eq!(run(port, "k", 200), Err("TIMEOUT"));
        h.join().unwrap();
    }

    #[test]
    fn infer_retries_transport_once() {
        let (port, seen, h) = serve(vec![Reply::Hangup, Reply::Json(completion("ok"))]);
        assert_eq!(run(port, "k", 2000).as_deref(), Ok("ok"));
        h.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2, "exactly one retry");
    }

    #[test]
    fn infer_gives_up_after_the_second_transport_failure() {
        let (port, seen, h) = serve(vec![Reply::Hangup, Reply::Hangup, Reply::Json(completion("never"))]);
        assert_eq!(run(port, "k", 2000), Err("UNAVAILABLE"));
        assert_eq!(seen.lock().unwrap().len(), 2, "no third attempt");
        drop(h); // the unused third reply keeps that thread parked in accept(); it ends with the test process
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // Windows takes about 2 s to report a refused loopback connect, so the timeout must outlast two of them
        assert_eq!(run(closed, "k", 8000), Err("UNAVAILABLE"), "connection refused twice");
    }

    #[test]
    fn infer_maps_bad_replies_to_bad_response() {
        let (port, _, h) = serve(vec![Reply::Json("not json at all".into())]);
        assert_eq!(run(port, "k", 2000), Err("BAD_RESPONSE"));
        h.join().unwrap();
        let (port, _, h) = serve(vec![Reply::Json(r#"{"choices":[]}"#.into())]);
        assert_eq!(run(port, "k", 2000), Err("BAD_RESPONSE"));
        h.join().unwrap();
        let (port, _, h) = serve(vec![Reply::Json(completion(&"x".repeat(MAX_REPLY_BYTES + 1)))]);
        assert_eq!(run(port, "k", 2000), Err("BAD_RESPONSE"), "reply over 4 KB");
        h.join().unwrap();
        let (port, _, h) = serve(vec![Reply::Status(500)]);
        assert_eq!(run(port, "k", 2000), Err("BAD_RESPONSE"));
        h.join().unwrap();
    }
}
