# src-tauri/

Purpose: Tauri 2 desktop shell (Rust; WebView2 on Windows, webkit2gtk on Ubuntu dev). This is Tauri 2, not Electron.

- `capabilities/` and `permissions/` define what the renderer may call; grant the narrowest permission, no broad wildcards.
- Native commands live in `src/commands/`; keep them thin.
- No secrets in `tauri.conf.json` or Rust source (`npm run lint:secrets`).
- Windows-machine behaviour (services, HKLM, ACLs, elevation, installers) is NOT tested on the dev PC: Windows Sandbox only (see `store-server/CLAUDE.md`).
- Rust audit helper: `scripts/audit-rust.sh`. Reference: docs/agent-reference.md "Windows-machine testing goes in Windows Sandbox".

Test: cargo test --manifest-path src-tauri/Cargo.toml; full app: npm run tauri dev.
Persona + model: Desktop App Engineer (IPC/shell) or Rust Refactoring Specialist (Rust code); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
