#!/usr/bin/env bash
# scripts/run-tech-debt-audit.sh — Phase 10 tech-debt audit pipeline.
#
# NOTE: `set -uo pipefail` deliberately WITHOUT `-e`. Every tool invoked below
# is expected to exit non-zero when it finds something to report (knip exits 1
# on issues, madge --circular exits 1 on cycles, eslint/vitest/playwright exit
# non-zero on failures). That exit code IS the audit signal, not a script
# failure — do not "fix" this back to `set -e`. Each invocation is suffixed
# with `|| true` so the script always runs every check and writes every report.
set -uo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/.audit-tmp"
mkdir -p "$OUT"

npx knip --reporter json > "$OUT/knip-report.json" || true
npx knip --production --reporter json > "$OUT/knip-production.json" || true

npx jscpd . --reporters json --output "$OUT/jscpd-out" || true

npx madge --circular --json --ts-config tsconfig.json --extensions ts,tsx \
  --exclude '(graphify-out|supabase\.types\.ts|\.stories\.tsx|\.test\.tsx?)$' \
  src > "$OUT/madge-circular.json" || true

# Unjustified `as any` probe (D-02). Emits file:line:content so a same-line
# justification comment (CLAUDE.md: "No any without a justification comment
# on the same line") is visible in the output without opening the file.
# Classification of justified vs unjustified is Plan 03's job, not this
# script's — the raw matched line carries the evidence either way.
grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=graphify-out \
  -E '\bas any\b' src \
  | grep -v '^src/shared/lib/supabase\.types\.ts:' > "$OUT/as-any.txt" || true

# Stale TODO/FIXME probe (D-02). No git-blame age calculation here — Plan 03
# only needs file:line at this tier.
grep -rn --include='*.ts' --include='*.tsx' \
  -E 'TODO|FIXME' src e2e > "$OUT/todo-fixme.txt" || true

# Oversized-file probe (D-02). Line-counts every src .ts/.tsx file (excluding
# the generated supabase.types.ts) and sorts descending so the head of the
# file is the finding list; threshold application is Plan 03's job.
find src -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path 'src/graphify-out/*' \
  -not -path 'src/shared/lib/supabase.types.ts' \
  -print0 | xargs -0 wc -l | grep -v ' total$' | sort -rn > "$OUT/file-sizes.txt" || true

npx eslint src --format json --max-warnings 0 > "$OUT/eslint-report.json" || true

npx tsc --noEmit --pretty false > "$OUT/tsc-errors.txt" 2>&1 || true

npx vitest run --project unit --reporter json --outputFile "$OUT/vitest-results.json" || true

# Playwright's json reporter is already wired in playwright.config.ts with a
# fixed outputFile; PLAYWRIGHT_JSON_OUTPUT_FILE overrides that path so this
# script's report lands in $OUT instead (verified: env var wins over the
# config's own reporter outputFile option). Run last — by far the slowest
# check, and every other report is already on disk if this is interrupted.
PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/playwright-results.json" npx playwright test || true

echo "Reports written to $OUT"
