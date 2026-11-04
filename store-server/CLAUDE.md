# store-server/

Purpose: Rust store server (gateway, services, packs, `posctl`) for local-store mode, with Windows installer/sandbox tooling.

- Windows-machine tests (services, HKLM, ACLs, elevation, reboots, installers, `posctl`) run only in Windows Sandbox: `store-server/sandbox/run-scenario.ps1 -Id <nn>` after `stage-payload.ps1`. Never on the dev PC.
- A new Windows-only check is a new scenario in `sandbox/scenarios.json` (flags `needsInternet`, `needsReboot`). Sandbox networking is off by default; one sandbox at a time; close only your own sandbox by PID, never by image name.
- Host tests stay pure (fake `Runtime`, temp dirs); tests needing elevation or real services are `#[ignore]` and run in the sandbox.
- "Done" for Windows-facing work = sandbox result file passed, not host unit tests.
- Reference: docs/agent-reference.md "Windows-machine testing goes in Windows Sandbox".

Test: cargo test --manifest-path store-server/Cargo.toml; npm run test:pack; Windows checks: sandbox runner above.
Persona + model: Desktop App Engineer (services/installer/Sandbox), Rust Refactoring Specialist (Rust code), SRE (Site Reliability Engineer) for gateway reliability; Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
