#!/usr/bin/env bash
# scripts/audit-rust.sh — Rust leg of the tech-debt audit (also: `npm run audit:rust`).
#
# Same contract as run-tech-debt-audit.sh: `set -uo pipefail` WITHOUT `-e`.
# A tool that finds something exits non-zero; that is the signal, not a script
# failure. A missing tool or a crate that does not build is recorded and skipped,
# never fatal. The script itself always exits 0.
#
# Per crate, per tool, output lands in .audit-tmp/rust/<crate>-<tool>.txt and a
# crate x tool summary table is printed at the end.
#
# Env:
#   AUDIT_RUST_HEAVY=1   also run `cargo bloat` and `cargo geiger` (release builds; slow)
#   CARGO_BUILD_JOBS     honoured as-is (cargo reads it); this script never sets it.
#
# `cargo deny` runs advisories, bans and sources only. Licences are skipped on
# purpose: there is no deny.toml and the allowed-licence policy is the owner's call.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.audit-tmp/rust"
mkdir -p "$OUT"
cd "$ROOT" || exit 0

HEAVY="${AUDIT_RUST_HEAVY:-0}"
TOOLS=(audit deny machete outdated treedup fmt clippy doc)
[ "$HEAVY" = "1" ] && TOOLS+=(bloat geiger)

# Every tracked Cargo.toml with a [package] (skips workspace-only manifests and
# the archived spike under .planning/).
CRATES=()
while IFS= read -r f; do
  case "$f" in .planning/*) continue ;; esac
  grep -q '^\[package\]' "$f" && CRATES+=("$(dirname "$f")")
done < <(git ls-files '*Cargo.toml')

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not installed: Rust audit not run"
  exit 0
fi

# have <tool>: is the cargo subcommand usable?
have() {
  case "$1" in
    clippy | fmt) cargo "$1" --version >/dev/null 2>&1 ;;
    doc | tree) return 0 ;;
    *) command -v "cargo-$1" >/dev/null 2>&1 ;;
  esac
}

declare -A RES

# run <crate-dir> <tool> <result-kind> -- <cmd...>
# Runs cmd inside the crate dir, saves output, then sets RES[crate|tool].
run() {
  local dir="$1" tool="$2" kind="$3"
  shift 4
  local crate file code
  crate="$(basename "$dir")"
  file="$OUT/$crate-$tool.txt"
  local bin="$tool"
  case "$tool" in treedup) bin=tree ;; esac
  if ! have "$bin"; then
    echo "not installed" > "$file"
    RES["$crate|$tool"]="not installed"
    return
  fi
  (cd "$ROOT/$dir" && "$@") > "$file" 2>&1
  code=$?
  # A build script that panics (src-tauri without posctl\backend.pospack) means
  # nothing that compiles can run; say so instead of reporting a bogus failure.
  if [[ "$kind" == clippy || "$kind" == doc || "$kind" == heavy ]] && grep -q 'failed to run custom build command' "$file"; then
    RES["$crate|$tool"]="not run: build script failed"
    return
  fi
  case "$kind" in
    audit)
      local v w
      v="$(grep -oE '[0-9]+ vulnerabilit' "$file" | grep -oE '^[0-9]+' | head -1)"
      w="$(grep -oE '[0-9]+ allowed warning' "$file" | grep -oE '^[0-9]+' | head -1)"
      RES["$crate|$tool"]="${v:-0}v/${w:-0}w" ;;
    passfail | clippy) [ $code -eq 0 ] && RES["$crate|$tool"]="pass" || RES["$crate|$tool"]="fail" ;;
    outdated) RES["$crate|$tool"]="$(grep -cE ' (Normal|Development|Build) ' "$file")" ;;
    treedup) RES["$crate|$tool"]="$(grep -cE '^[A-Za-z0-9_-]+ v[0-9]' "$file")" ;;
    fmt)
      if [ $code -eq 0 ]; then RES["$crate|$tool"]="0"
      else RES["$crate|$tool"]="$(grep '^Diff in' "$file" | sed -E 's/:[0-9]+:$//' | sort -u | wc -l | tr -d ' ')"; fi ;;
    doc)
      if [ $code -ne 0 ]; then RES["$crate|$tool"]="fail"
      else RES["$crate|$tool"]="$(grep -E '^warning' "$file" | grep -vcE 'future version of Rust|generated [0-9]+ warning')"; fi ;;
    heavy) [ $code -eq 0 ] && RES["$crate|$tool"]="done" || RES["$crate|$tool"]="fail" ;;
  esac
}

for dir in "${CRATES[@]}"; do
  # No compile needed.
  run "$dir" audit    audit    -- cargo audit
  run "$dir" deny     passfail -- cargo deny check advisories bans sources
  run "$dir" machete  passfail -- cargo machete
  run "$dir" outdated outdated -- cargo outdated --root-deps-only
  run "$dir" treedup  treedup  -- cargo tree --duplicates
  run "$dir" fmt      fmt      -- cargo fmt --check
  # Compiles.
  run "$dir" clippy   clippy   -- cargo clippy --all-targets -- -D warnings
  run "$dir" doc      doc      -- cargo doc --no-deps
  if [ "$HEAVY" = "1" ]; then
    run "$dir" bloat  heavy    -- cargo bloat --release --crates -n 20
    run "$dir" geiger heavy    -- cargo geiger
  fi
done

# Summary table.
echo
echo "Rust audit (counts: audit=vulns/warnings, outdated/treedup/fmt/doc=N, others=pass|fail):"
printf '%-14s' crate; for t in "${TOOLS[@]}"; do printf '%-30s' "$t"; done; echo
for dir in "${CRATES[@]}"; do
  crate="$(basename "$dir")"
  printf '%-14s' "$crate"
  for t in "${TOOLS[@]}"; do printf '%-30s' "${RES[$crate|$t]:--}"; done
  echo
done
echo "Rust reports written to $OUT"
exit 0
