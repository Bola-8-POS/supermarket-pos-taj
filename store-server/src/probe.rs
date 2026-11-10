//! Health gates: how to tell that a component is really serving, not merely that its service
//! reports RUNNING (conventions 8.2).
//! It must never call a component healthy because its service says RUNNING; only its own answer counts.

use std::time::{Duration, Instant};

use crate::http::get_status;
use crate::pg::{isready, PgTools};
use crate::ports::Ports;
use crate::services::Component;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    PgIsReady { port: u16 },
    Http { url: String },
}

pub fn gate_for(c: Component, p: &Ports) -> Gate {
    match c {
        Component::Postgres => Gate::PgIsReady { port: p.pg() },
        Component::Auth => Gate::Http { url: format!("http://127.0.0.1:{}/health", p.gotrue()) },
        Component::Rest => Gate::Http { url: format!("http://127.0.0.1:{}/ready", p.rest_admin()) },
        Component::Functions => Gate::Http { url: format!("http://127.0.0.1:{}/functions/v1/_health", p.functions()) },
        Component::Gateway => Gate::Http { url: format!("http://127.0.0.1:{}/auth/v1/health", p.gateway_internal()) },
    }
}

pub fn check(gate: &Gate, tools: &PgTools) -> bool {
    match gate {
        Gate::PgIsReady { port } => isready(tools, *port),
        Gate::Http { url } => get_status(url, &[], Duration::from_secs(3)) == Some(200),
    }
}

/// Poll until healthy; returns the milliseconds it took, or `None` on timeout.
pub fn wait_healthy(c: Component, p: &Ports, tools: &PgTools, timeout: Duration) -> Option<u64> {
    let start = Instant::now();
    let gate = gate_for(c, p);
    while start.elapsed() < timeout {
        if check(&gate, tools) {
            return Some(start.elapsed().as_millis() as u64);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gates_point_at_the_documented_endpoints() {
        let p = Ports { base: 47300 };
        assert_eq!(gate_for(Component::Postgres, &p), Gate::PgIsReady { port: 47300 });
        assert_eq!(gate_for(Component::Auth, &p), Gate::Http { url: "http://127.0.0.1:47301/health".into() });
        assert_eq!(gate_for(Component::Rest, &p), Gate::Http { url: "http://127.0.0.1:47306/ready".into() });
        assert_eq!(gate_for(Component::Functions, &p), Gate::Http { url: "http://127.0.0.1:47303/functions/v1/_health".into() });
        assert_eq!(gate_for(Component::Gateway, &p), Gate::Http { url: "http://127.0.0.1:47305/auth/v1/health".into() });
    }

    #[test]
    fn an_http_gate_follows_the_status_code() {
        let m = crate::http::mock::start(|r| if r.path == "/health" { (200, "{}".into()) } else { (503, "{}".into()) });
        let tools = PgTools { bin: std::path::PathBuf::new() };
        assert!(check(&Gate::Http { url: format!("{}/health", m.url()) }, &tools));
        assert!(!check(&Gate::Http { url: format!("{}/other", m.url()) }, &tools));
        assert!(!check(&Gate::Http { url: "http://127.0.0.1:1/".into() }, &tools));
    }
}
