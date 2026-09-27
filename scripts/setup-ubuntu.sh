#!/usr/bin/env bash
set -euo pipefail

# Idempotent Ubuntu/Debian dev-environment setup for the Tauri 2 native shell.
# Safe to re-run: apt-get install is already idempotent, and the Rust step is
# guarded by `command -v cargo`. See D-06/D-07/D-08/D-09 in
# .planning/phases/36-migrate-development-environment-from-windows-to-ubuntu/36-RESEARCH.md.

cd "$(dirname "$0")/.."

# 1. OS guard — fail fast on non-Debian/Ubuntu systems rather than misbehave silently.
if ! grep -qE '^ID(_LIKE)?=.*(ubuntu|debian)' /etc/os-release 2>/dev/null; then
  echo "setup-ubuntu.sh: this script targets Ubuntu/Debian. Detected /etc/os-release:" >&2
  cat /etc/os-release >&2
  exit 1
fi

# Diagnostic only — never branch package selection on these (D-06: the required
# package set is identical across Ubuntu 22.04 through 26.04).
# shellcheck disable=SC1091
VERSION_ID=$(. /etc/os-release && echo "$VERSION_ID")
# shellcheck disable=SC1091
VERSION_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "Detected Ubuntu/Debian VERSION_ID=${VERSION_ID} VERSION_CODENAME=${VERSION_CODENAME}"

# 2. Native Tauri 2 Linux system libraries.
sudo add-apt-repository -y universe || true
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config

# 3. Node preflight — this script deliberately does not install Node itself (D-09).
if ! command -v node >/dev/null 2>&1; then
  echo "setup-ubuntu.sh: node not found. Install it via nvm or fnm, then re-run this script." >&2
  exit 1
fi

# 4. Stale Windows node_modules detection (D-13).
if [ -d node_modules ] && [ ! -d node_modules/@tauri-apps/cli-linux-x64-gnu ]; then
  echo "setup-ubuntu.sh: node_modules/ carries Windows-only native bindings (no @tauri-apps/cli-linux-x64-gnu)." >&2
  echo "Fix: rm -rf node_modules && npm ci" >&2
  exit 1
fi

# 5. Rust toolchain (D-08). Prefer Ubuntu's signed apt archive over piping a
# remote script to a shell (T-36-01); fall back to the official installer only
# when apt has no rustup candidate.
if command -v cargo >/dev/null 2>&1; then
  echo "cargo already installed: $(cargo --version)"
else
  if apt-cache policy rustup 2>/dev/null | grep -q 'Candidate: [^(]'; then
    sudo apt-get install -y rustup
    rustup default stable
  else
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  fi
  # shellcheck source=/dev/null
  [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
fi

# 6. Final sanity check — cross-checks Node, Rust and the webkit2gtk system
# libraries together. Uses the local devDependency CLI (not `npx --yes`), so
# it cannot silently fetch a different version.
npx @tauri-apps/cli info
