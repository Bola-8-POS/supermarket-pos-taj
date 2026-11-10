# Agent reference (moved verbatim from CLAUDE.md)

Long-form reference split out of the root `CLAUDE.md` so that file stays short enough to be read. Nothing here is new; section text is unchanged. The enforced rules live in `CLAUDE.md`.

## UAT / Verification: automate it, never ask the user to click through

**Never ask the user to manually click through the app and report back what happened.** This includes `/gsd-verify-work` UAT checkpoints, "please verify X", or any other request for the user to be the test harness. The user has explicitly and repeatedly stated this is unacceptable.

Instead, when a feature needs to be verified in the running app:
- Drive it yourself with the Playwright MCP tools (`mcp__playwright__browser_navigate`, `browser_click`, `browser_snapshot`, `browser_network_requests`/`browser_network_request`, `browser_console_messages`, etc.) against the dev server (`npm run dev`, port 1520).
- Read the actual network responses / console errors to find root causes — don't guess and don't narrate a hypothetical click-through.
- If something can be verified with `npx playwright test` against an existing or new spec file, do that instead of ad-hoc browser driving.
- Only report back to the user once you have concrete, reproduced evidence (pass, or a specific failure with request/response/error detail).
- If a check is genuinely impossible to automate (e.g. requires physical hardware), say so explicitly and explain why — don't default to "please check for me."

## Token discipline — short plans, targeted reads (NON-NEGOTIABLE, owner rule 2026-10-03)

- **Never read a large file whole.** Any file over ~300 lines (plans, specs, reports, logs, transcripts, generated code) is located first — codebase-memory MCP / graphify for code, `Grep -n` (or `rg -n`) for text and Markdown — then read with `offset`/`limit` for only the lines needed. This applies to the orchestrator and to every subagent; put it in every subagent brief.
- **Plans are short.** A plan file is at most ~500 lines: goal, constraints, and per task the files, interfaces/signatures, test names + what they assert, commands, acceptance. **No full source code in plans** — code is written at execution time against the real repo. A 6,000-line plan is a failure, not thoroughness.
- **Review the code, not the plan.** Plan review is a short checklist pass; the deep review happens on the executed diff. Do not spend an agent reading a whole plan line by line.
- Before launching parallel subagents, estimate the token cost and keep the fan-out small; a usage-limit hit means the plan was too expensive.

## Codebase exploration — codebase-memory MCP is MANDATORY, checked first, every time

**This is a hard, non-negotiable rule, not a preference.** This repo (project id `D-Projects-Code-supermarket-pos` in the `codebase-memory-mcp` server) is fully indexed — 21k+ nodes, 46k+ edges, all TypeScript/Rust/Python/SQL source, and **all 208 Supabase/Postgres migrations under `supabase/migrations/`** (schema history, RPCs, RLS policies, triggers — including dropped bar-pos-era tables like `pool_tables`, `kds`, `combos`, `modifier_groups`, `waitlist`, `tip_distribution`, visible in migration history even though dropped from live schema). Querying this graph costs a tiny fraction of the tokens that Glob/Grep/Read across the same surface would cost, and stays exhaustive where a manual search stays partial. Treat it as the **first and default tool for any question about "where is X", "what calls Y", "how does Z connect to W", "what tables/RPCs does this touch", "what changed in schema history for table T"** — including at the start of any new feature, refactor, or bug investigation, before opening a single file.

Priority order, strictly enforced:

1. **`mcp__codebase-memory-mcp__*` tools — always try first.**
   - `get_architecture` (aspects: overview/structure/routes/dependencies/hotspots/boundaries/layers/file_tree/clusters) — orient on a directory or the whole repo before touching it.
   - `search_graph` — find symbols/functions/types by name, regex, or BM25/semantic query.
   - `trace_path` — callers/callees, data flow, cross-service edges (e.g. "what calls `process_direct_sale_atomic`", "what does `checkout-sale` write to").
   - `query_graph` — multi-hop Cypher for anything the above can't answer in one shot (e.g. "which RPCs touch `inventory` and were added after migration X").
   - `get_code_snippet` / `get_file_outline` — read the specific lines you actually need instead of a whole file.
   - `check_index_coverage` — run this for any path/scope you're about to rely on for a non-trivial decision (new feature scoping, refactor blast-radius, migration planning). It's best-effort, not proof, but flags known gaps.
   - This covers **SQL migrations too** — search/trace/query work the same way over `supabase/migrations/*.sql`, `supabase/functions/*`, and Postgres schema/RPC/trigger definitions as they do over TS. Use the graph to answer "what does the DB schema/RPC look like today" and "how did it get there" before opening migration files one by one.
2. **`graphify` CLI/skill** (`graphify-out/graph.json`, 5309 nodes) — a secondary, smaller/older index. Use only if codebase-memory-mcp genuinely lacks an answer (e.g. it returns nothing and coverage looks stale) or the graphify skill is explicitly invoked (`/graphify`). Do not use it as the primary tool going forward.
3. **Glob/Grep/Read** — last resort only: literal string/config search, non-code files, confirming a graph result before an edit, or actually editing/reading full file content to write code. Never use these as the *first* move to answer a "where/what/how" question when the graph tools above haven't been tried.

**Before any large or multi-file feature (new POS capability, cross-cutting refactor, schema change):** run `get_architecture` scoped to the relevant area + `search_graph`/`trace_path` on the key entry points + `check_index_coverage` on the paths you're about to depend on, and build your plan from that — do not read through directories file-by-file to "get a feel for it." If `check_index_coverage` reports a gap for something load-bearing to the plan, read only the flagged files directly, then proceed.

**If the graph looks stale or incomplete for something you need** (new files not yet indexed, a recent large schema change, low-confidence/low-precision results on a query that should have a clear answer): say so, then request a re-index/update via the codebase-memory MCP tooling (`index_repository`/`detect_changes`) rather than silently falling back to manual file-by-file reads for the whole task. Precision here compounds — a stale or coarse graph makes every future session pay full grep/read cost again.

**Known graph blind spot — read these SQL files directly, do not trust the graph for their internals:** `index_status(diagnostics: summary)` shows 14 migration files as `parse_unusable` (whole-file tree-sitter-SQL parse failure — confirmed a parser limitation on complex PL/pgSQL, not staleness; re-indexing does not change it):
- `20260813000001_process_direct_sale_atomic.sql` / `20260813000002_fix_direct_sale_split_idempotency.sql` / `20260814000001_loose_weight_items.sql` / `20260814000002_weighted_direct_sale_price.sql` / `20260815000001_direct_sale_atomic_paid_and_shift_guard.sql` / `20260816000001_direct_sale_authoritative_totals.sql` / `20260818000003_process_direct_sale_atomic_cost_snapshot.sql` — the successive definitions of `process_direct_sale_atomic`, the sole checkout/pricing RPC.
- `20260427000002_split_tab_rpcs.sql` / `20260708000001_fix_split_tab_rpcs_version_bump.sql`
- `20260810000007_deplete_for_order_item_v6.sql`, `20260913000002_combo_sale_pricing.sql`, `20260825000001_restore_refunded_product_inventory.sql`, `20260424000002_categories_tree.sql`, `20260718000000_profiles_locale.sql`

For any of these, `search_graph`/`trace_path` will return nothing or an incomplete picture — go straight to Read/Grep on the file. For every *other* SQL migration (194 of 208), the graph is indexed and reliable per `get_architecture(aspects:["file_tree"], path:"supabase/migrations")`. Re-run `index_status(diagnostics: summary)` after a large migration-writing session to see if this list has grown, and update this list if so.

## GSD Tools Location in Windows
C:\Users\giris\.claude\gsd-core

## Session Memory (claude-mem — check before re-deriving)

`claude-mem` is installed and auto-active (hooks fire on SessionStart/UserPromptSubmit/PostToolUse — it already captures observations and injects prior context automatically, no manual save step needed). **Prefer it over rebuilding context from scratch:**

- At session start, read the injected `<claude-mem-context>` block before asking the user "what were we doing" or re-reading multiple planning docs to reconstruct state.
- Before investigating "why was X built this way" / "what did we decide about Y" / "have we hit this bug before", use the `mem-search` skill (or the `mcp-search` MCP tools directly) to query prior sessions instead of grepping through `.planning/` or old commit messages.
- Use `smart-explore` / `knowledge-agent` skills for "how does this codebase work" questions that are really about accumulated project understanding, not live code structure (for live code structure, use the graphify graph above instead — they're complementary: graphify answers "what connects to what in the code right now", claude-mem answers "what did we learn/decide across sessions").
- Only fall back to manually reading historical files/docs when claude-mem has no relevant memory (e.g. very first session, or memory was cleared).

## GSD Workflow State (don't re-scan `.planning/` by hand)

This project uses GSD for phase planning — `.planning/STATE.md`, `ROADMAP.md`, `PROJECT.md`, `REQUIREMENTS.md` are already the source of truth for "what phase are we on / what's next / what's been decided". **Enter through the GSD situational commands instead of manually reading and cross-referencing those files:**

- `/gsd-progress` — the unified entry point: reports current state and can dispatch the right next action (discuss/plan/execute/verify) in one call.
- `/gsd-resume-work` — resume mid-phase work with full context restoration after a break, instead of re-reading the last few phase docs to reconstruct where things left off.
- Only open `.planning/phases/**` files directly when actively planning/executing a specific phase (i.e. when a GSD skill would open them anyway) — not as a first move to "catch up."

Do not enable GSD's MemPalace integration (`gsd-mempalace-*`) on top of this — it would run a third overlapping memory system alongside claude-mem and GSD's own `.planning/STATE.md`. claude-mem covers cross-session recall; `.planning/` covers phase/roadmap state. That's sufficient.

## Specialist Agent Routing (agency-agents)

`agency-agents` (300+ domain-specialist subagents) is installed globally at `~/.claude/agents/`. gsd-core's `/gsd-execute-phase` supports routing a plan's executor to a named specialist instead of the generic `gsd-executor`, via `agent_hint: <Name>` in that plan's `PLAN.md` frontmatter (`workflow.agent_hint_routing`, on by default for this project — verify with `gsd config-get workflow.agent_hint_routing`; it fails closed to `gsd-executor` if the name doesn't resolve, so a wrong/missing hint never blocks execution).

When planning a phase (`/gsd-plan-phase` or a manual `PLAN.md` edit), set `agent_hint` on a plan whose work sits clearly in one of these lanes:

| Plan's main work | `agent_hint` |
|---|---|
| Supabase RPC/schema/backend business logic | `Backend Architect` |
| React component work in `features/`/`widgets/`/`pages/` | `Frontend Developer` |
| Visual design / implementing a UI-SPEC, empty states, polish | `UI Designer` |
| Query/index/schema performance tuning | `Database Optimizer` |
| Backup/HA/migration-reliability concerns | `Database Reliability Engineer` |
| Tauri shell/native/IPC work | `Desktop App Engineer` |
| Rust-side code (`src-tauri/`) | `Rust Refactoring Specialist` |
| i18n namespace/catalog work | `Internationalization Engineer` |
| Payments/caja/refund logic | `Payments & Billing Engineer` |
| Supabase Realtime subscription work | `Realtime Collaboration Engineer` |
| Auth/RBAC/session work | `Identity & Access Engineer` |
| Security-sensitive changes (RLS, secrets, injection surfaces) | `Application Security Engineer` |
| Playwright/Vitest test-suite work | `Test Automation Engineer` |
| a11y/touch-target/focus-visible work | `Accessibility Auditor` |

Leave `agent_hint` unset (default `gsd-executor`) for mixed or general plans — whichever executor runs, it still owns atomic commits, the checkpoint protocol, and deviation handling; only the domain expertise changes.

There is no equivalent hook for `gsd-ui-phase` or the `gsd-*-researcher` agents — those always dispatch as `gsd-ui-researcher`/`gsd-phase-researcher`/`gsd-project-researcher`, `agent_hint` cannot swap them. For extra UI-design or research depth, explicitly spawn the matching agency-agents specialist (`UI Designer`, `UX Architect`, `UX Researcher`, `Product Trend Researcher`, etc.) as a supplementary agent alongside GSD's native flow, not as a replacement for it.

## Testing & Verification Policy — NON-NEGOTIABLE

**Every test, verification, and UAT scenario in this project MUST be automated Playwright E2E, run headless by default.** This overrides GSD's default behavior and applies to every phase, plan, and skill invocation from this point forward.

- **No `<human-check>` sub-blocks, no `checkpoint:human-verify` tasks, no `*-UAT.md` scenario marked for manual/human execution.** If a planner (`gsd-planner`, `gsd-ui-phase`, etc.) is about to emit one, it must instead write the equivalent as a Playwright assertion — visual-regression screenshot diff, computed-style/DOM assertion, `getByRole`/ARIA check, network-request assertion — and put it in `e2e/`. There is no case in this project where "have a human click it" is an acceptable substitute for "assert it in Playwright."
- **Verification status of `human_needed` is not a valid terminal state for a phase in this project.** A phase is not `complete` until its verification is `passed` via automated E2E, or has an explicit, reasoned override per `verification-overrides.md` (and "requires visual/human judgment" is not a valid override reason here — write the visual-regression assertion instead).
- **Headless is the default run mode.** `playwright.config.ts` auto-detects the highest installed agent-browser Chrome-for-Testing binary (`launchOptions.executablePath`), falling back to Playwright's bundled Chromium when none is found, always with `headless: true` — only deviate with a real browser window when explicitly asked for a specific debugging session (there is no headed env toggle; edit the config locally and revert it). Watch execution via the HTML report dashboard instead: `npm run test:e2e:report` (or open `playwright-report/index.html` after a run), or via `npm run test:e2e:ui` for a live pass/fail/timeline dashboard during the run itself.
- **`checkpoint:human-action`** (an auth step or credential only a human can perform) and **`checkpoint:decision`** (a choice the executor needs from the user) are a different category — those aren't post-hoc verification of finished work, so this policy doesn't touch them. Only human *verification/testing* of already-built work is banned.
- This policy is retroactive in intent: existing phases carrying `human_needed`/`gaps_found`/pending manual UAT scenarios (see `.planning/STATE.md` Deferred Items and `.planning/audits/2026-08-07-cross-phase-todos-and-gaps.md`) are backlog to close via Playwright, not accepted end states — do not treat their current `human_needed` status as precedent for new phases.
- Full rationale and scope: `.planning/decisions/2026-08-07-mandatory-automated-testing-no-manual-verification.md`.

## Windows-machine testing goes in Windows Sandbox — NON-NEGOTIABLE (owner rule 2026-10-18)

**Anything that must be tested on a real Windows machine runs inside Windows Sandbox, never on the developer PC.** That covers installing or registering Windows services, `HKLM` registry writes, local accounts, firewall rules, scheduled tasks, ACLs/owners on system folders (`ProgramData`, `Program Files`), elevated (admin) code paths, reboots, installers (NSIS), and `posctl provision`/`unprovision`/`start`/`stop` against real services.

- **Use the runner:** `store-server/sandbox/run-scenario.ps1 -Id <nn>` (host side, PowerShell 5.1 compatible), after `store-server/sandbox/stage-payload.ps1`. Payload is staged at `E:\tmp\two-mode-sandbox\payload` (mapped read-only), results land in `E:\tmp\two-mode-sandbox\<runId>\out\result.json` (`{id, expected, actual, pass}` per check). A new Windows-only check is a new scenario registered in `store-server/sandbox/scenarios.json`, not an ad-hoc run on the host.
- **Networking is off in the sandbox** (`scenario.wsb.template`). Everything the scenario needs is copied in. Only a scenario that genuinely needs the internet may turn it on, and it must say so in `scenarios.json` (`needsInternet`).
- **One sandbox at a time.** Close only the sandbox process the runner started, by PID — never `Stop-Process`/`taskkill` by image name.
- **On the host**, tests stay pure: Rust unit tests for command builders, fake `Runtime`s, temp directories. A test that needs elevation or real services is `#[ignore]` on the host and runs in the sandbox (scenario 21 runs the `--ignored` tests elevated).
- **"Done" for Windows-facing work means the sandbox scenarios passed**, with the result file as evidence — not "unit tests pass on the host". If Windows Sandbox is not enabled on a machine, enabling it is a `checkpoint:human-action`; never fall back to testing on the host.

## Code Review — run the local pipeline first, it is free and already tuned

**`npm run audit:tech-debt` is the entry point for any "how healthy is this codebase / what's the coverage / where's the dead code / any code smells" question.** It runs knip, jscpd, madge, an `as any` probe, a TODO/FIXME probe, a file-size census, ESLint and `tsc --noEmit`, and writes every report to `.audit-tmp/`. It is deterministic, fully local, and costs nothing. Both tool configs were tuned on 2026-10-02 and their output verified, so **their findings are now actionable as-is — do not dismiss them as noise.**

Do not reach for a paid LLM reviewer to answer a codebase-health question. Those tools review a *diff*, which is a different question:

| Tool | Scope | Notes |
|---|---|---|
| `npm run audit:tech-debt` | whole repo, deterministic | **Start here.** Free, repeatable, no API key. |
| `/code-review` (this harness) | current diff / PR / branch | Covered by the Claude Code subscription — the cheapest LLM review. |
| Greptile MCP (`mcp__greptile__*`) | **PR only** | `trigger_code_review` needs `name`/`remote`/`defaultBranch`/`prNumber`. Cannot review a worktree or a whole repo, and its knowledge-base tools are empty until the repo is indexed in the Greptile dashboard (`indexPresent: false` as of 2026-10-02). Repo name must be fully qualified: `bola-8-pos/supermarket-pos`. |
| `ocr` (open-code-review) | diff, or whole files via `ocr scan` | Bills a real Anthropic key per token. `ocr scan` across ~1000 files is expensive — it exhausted a $5 balance in one run. Use `--max-tokens-budget` and scope with `--exclude`, or prefer delegation mode (`/open-code-review-delegate`), which uses OCR only for file selection and costs nothing. |

### Baselines — distinguish a regression from the status quo

Measured 2026-10-02 on `chore/2026-09-29-offline-first-audit-and-plans`. A reviewer should flag movement **away** from these, not re-report them as new findings:

- `tsc --noEmit`: **0 errors.** Any error is a regression; this must stay at zero.
- `npm run lint`: **0 errors** (verified 2026-11-04 on v1.11.4; the earlier 49 errors in `src/entities/tab/model/*.integration.test.ts` are fixed). Any error is new.
- Coverage (`npm run test:coverage`, 1,988 tests): **51.2% statements / 45% branches / 48.3% functions / 52.1% lines.** 105 of 397 instrumented files at 0% — mostly UI covered by Playwright instead, so a zero is not automatically a gap. The real gaps are non-UI: `entities/brand/model/queries.ts`, `entities/category/model/queries.ts`, `features/manage-modifier-groups/ui/ModifierGroupEditor.tsx`.
- FSD import direction: **zero violations in production code.** `eslint-plugin-boundaries` enforces this and a violation is a blocking lint error. Note the codebase-memory graph's `boundaries` aggregate reports `shared→widgets` (61) and `features→widgets` (129) — **these are a graph artifact**, resolving entirely into `widgets/SettingsTabsPanel/tabs/LanguageSettingsTab.test.tsx`. Verify any suspected violation with a non-test import grep before reporting it.
- Circular deps (madge): **2**, both 2-node — `license/features ↔ upgrade-dialog-store`, `inventory/queries ↔ store`.
- Duplication (jscpd, tuned): **8.66% repo-wide; 1.7% within `src/`.**
- `as any`: **117 occurrences, none with the same-line justification comment this file requires.** 83 in tests (the documented missing-generated-types workaround), **34 in production** — those 34 are a real open violation.
- TODO/FIXME across `src/` + `e2e/`: **4**.
- knip: **11 unused files + 2 unused dependencies**, all real (see below).

### Reading the tuned tool output

- **knip** (`knip.json`) declares `entry` for the app, Storybook stories, Playwright specs, all 8 `playwright*.config.ts`, `scripts/`, the 16 Supabase edge-function `index.ts` entry points and their Deno `*_test.ts` files. Without those entries knip reported 50 unused files, 39 of which were live code it simply could not reach. The surviving 11 are genuine dead code, as are the 2 unused deps — `@tauri-apps/plugin-notification` (pairs with the dead `shared/lib/tauri-notify.ts`) and `input-otp` (pairs with the dead `shared/ui/input-otp.tsx`). These are deliberately **left flagged rather than suppressed**; delete the file and the dep together. Only `shadcn` is in `ignoreDependencies`, because it is a CLI invoked via `npx shadcn@latest add`.
  - knip's remaining ~318 unused exports / 168 unused types are dominated by `shared/lib/domain.ts` (110) and `shared/ui/index.ts` (88), which are barrel/Zod-single-source modules where unused exports are expected by design. Treat the file and dependency counts as the actionable tiers.
  - **JSON-parsing gotcha:** in knip's `--reporter json` output each issue's `files` key is an *array*, and `[]` is truthy in JS. Filtering with `issues.filter(i => i.files)` matches every file with any issue at all. Use `i.files.length`.
- **jscpd** (`.jscpd.json`) ignores `supabase/migrations/**` — migrations redefine whole PL/pgSQL functions by design (`process_direct_sale_atomic` has 7 successive definitions) and an applied migration cannot be refactored, so duplication there is the documented pattern, not debt. Also ignored: `.agents/`/`.claude/`/`.kiro/` skill LICENSE files, the tracked `broker/` Rust crate (consistent with `src-tauri/**`), untracked `scratchpad/`, and `e2e/tutorials/**` (a separate `testDir` holding deliberate copies of the real specs for video recording). What remains is worth consolidating: the manager-PIN-identity specs triplicated across `e2e/payments` and `e2e/tabs`, and ~50 shared lines between the `process-payment` and `process-split-payment` edge functions.
- **`.audit-tmp/` is not gitignored.** Check it before committing after an audit run.

### Known orphans — confirmed dead, do not re-derive

Each verified to have zero production importers by direct grep, not just by knip. `override-negative-stock` is still listed under "Implemented Features" below despite being unreachable:

`features/override-negative-stock/{index.ts,model/useOverrideNegativeStock.ts}` · `features/manage-products/ui/CatalogCategoriesTab.tsx` · `features/lookup-product-by-barcode/index.ts` · `widgets/LowStockAlert/index.tsx` · `shared/lib/tauri-notify.ts` · `shared/ui/{card,collapsible,input-otp}.tsx` · `shared/ui/CategoryTreePicker/index.ts` · `entities/rbac/model/types.ts`

### This file is known-stale — verify before planning against it

As of 2026-10-02, 13 feature folders and 2 entities exist in `src/` and appear nowhere in this file. The `bank-transfer` entity plus `confirm-dispute-transfer` and `export-bank-transfers` form a bank-transfers subsystem that renders **live on `/payments`** (`pages/payments/index.tsx`). Also undocumented: `create-purchase-order`, `suggest-reorder`, `issue-offline-approvals`, `admin-reset-pin`, `print-job`, `manage-promotions`, `create-staff`, `deactivate-staff`, `open-open-unit`, `open-product-peek-window`, `reprint-receipt`, `upload-logo`.

The route table is accurate (router.tsx and this file match exactly); the feature and entity lists are not. **Confirm against `src/` before concluding a feature does or does not exist.** Closing this gap is backlog, not accepted state.

## Project Overview

A single-store supermarket POS built as a Tauri 2 desktop app shipping to Windows/WebView2 end users. Ubuntu is an officially supported development OS, running the same native shell through webkit2gtk instead of WebView2. Frontend is React 19 + TypeScript + Vite. Backend is Supabase (PostgreSQL + Auth + Realtime + RLS).

This repo started as a bar/pool-parlour POS (`bar-pos`) and pivoted in-place (2026-08-10) into a standalone supermarket product for a single grocery store selling goods imported from India (packaged spices/masalas, atta/rice/dals, snacks, pickles/papads, ghee/oil, tea/coffee, frozen items, sweets — mostly barcoded packaged goods, some sold loose by weight). The bar-pos codebase's generic retail infrastructure (auth, RBAC, caja/register sessions, payments, barcode scanning, receipt printing, AI vision) was kept and its bar/pool-specific domain layers (tabs-based POS, pool tables/sessions, KDS/kitchen-prep, waitlist, Rappi delivery, combos/recipes/ingredients, promotions engine, tip-distribution) were stripped end-to-end from both code and DB schema. `bar-pos` itself is maintained separately elsewhere — this is not a shared codebase. Inventory management (supplier receiving, expiry tracking, and eventually AI-assisted invoice intake) is the core strength of this product. See `.planning/PROJECT.md` for full business context and `.planning/ROADMAP.md`/`.planning/REQUIREMENTS.md` for current milestone status.

All source code lives in `supermarket-pos/`. Run all commands from `supermarket-pos/`.

### Licensing/subscription control lives in a SEPARATE repo — `pos-license-server`, not here

The vendor-side licensing system (multi-tenant Supabase project + admin portal that gates which
stores' terminals are allowed to run this POS) was originally prototyped in-repo under
`license-server/` (2026-09-06, `.planning/decisions/2026-09-06-licensing-and-subscription-control.md`)
and was extracted on 2026-09-11 into its own GitHub repo: **github.com/zedfauji/pos-license-server**
(private), on disk at `D:\Projects\Code\pos-license-server` — a sibling of this repo, not a
subfolder of it. This closed a real risk that repo carried while `license-server/` lived here:
`release.yml`'s customer-sync job does `git push --mirror` (full-history, not build-artifact) to
each customer's own GitHub repo, which would have copied vendor-only license-server *source* into
every customer repo the next time a release was cut. Do not re-add a `license-server/` directory
to this repo for that reason — always work in the standalone repo instead.

**What stays in THIS repo** (the POS-side "hooks" — the client half of the licensing system):
`src/app/LicenseGate.tsx` + `LicenseBanner.tsx` (app-shell gating/banner), `src/shared/lib/license/*`
(token verify, `evaluateLicense` pure policy, zustand store, terminal-id, heartbeat hook),
`src/features/activate-license/*` (activation UI), `src/widgets/SettingsTabsPanel/tabs/LicenseSettingsTab.tsx`
(Settings → Licencia tab), the `LICENSE_LOCKED`/`LICENSE_ERROR` `AppErrorCode`s in
`src/shared/lib/result.ts`, and small wiring in `src/app/{App,AppConfigProvider,providers}.tsx` +
`src/shared/lib/supabase.ts` (refuses non-GET/non-auth fetches while locked) + `src-tauri/src/lib.rs`
(reads the runtime `.env` next to the Tauri executable for `VITE_LICENSE_SERVER_URL`/`VITE_LICENSE_SERVER_ANON_KEY`
overrides). These files have zero server-side secrets and only talk to the license server's public
HTTP API (edge functions `activate`/`heartbeat`/`issue-offline-token`) — that's why they're safe to
keep in a repo that gets mirrored to customers.

**What moved to `pos-license-server`** (never bring this back here): the license server's own
Supabase project (`tenants`/`payments`/`terminals` tables, RPCs, edge functions with the ECDSA
signing key), the admin portal (`portal/`, Tenants/TenantDetail/Fleet pages), and
`scripts/setup-admin.mjs`. Full ops docs, local dev setup (still the same local Supabase stack on
ports 55321-55323, unchanged), and the "moving to a remote Supabase project" runbook are in that
repo's own `README.md` — read it there, don't expect it here.

**Production instance** (created 2026-09-11): remote Supabase project `zhvcivnojpvgwiknlpuj`
(https://zhvcivnojpvgwiknlpuj.supabase.co). Migration applied, all 3 edge functions deployed, a
fresh production-only ECDSA signing keypair generated (never shared with the local dev keypair),
email signup disabled, one portal admin created. To point a production POS build at it, set
`VITE_LICENSE_SERVER_URL`, `VITE_LICENSE_SERVER_ANON_KEY` (or the new `sb_publishable_...` key),
and `VITE_LICENSE_PUBLIC_KEY` (the prod SPKI, not the dev one baked into `public-key.ts`) at build
time — see `src/shared/lib/license/{config,public-key}.ts` for exactly how those overrides work.

**Demo edition** (2026-09-14) — a self-service 14-day trial layered on the same token-driven
entitlement model, plus a Firebase-hosted online demo of this repo's web build. Feature gating is
`FEATURE_KEYS` in `src/shared/lib/license/features.ts` (10 keys: `report_export`, `ai_assistant`,
`email_receipts`, `settings_backup`, `audit_log`, `edit_history`, `staff_management`,
`rbac_editing`, `promotions`, `purchase_orders`); a demo token's server-side allow-list is only
`promotions` + `purchase_orders` — every other key is locked (`LockedFeature`/`FeatureLockedPage`
in `src/shared/ui/`), so checkout/inventory/suppliers/caja/reports/payments stay fully usable
while the demo still has something to sell. A demo tenant is 14 days, 0 grace days, 14-day lease,
1 terminal. `startDemoTrial()`/`resetTerminalForNewDemo()` (`src/shared/lib/license/actions.ts`)
call the `start-demo` edge function — that function, like the rest of the license server, lives in
`pos-license-server` (branch `feat/demo-plan`, **not yet deployed to the prod license server** —
local 553xx stack only for now). `VITE_DEMO_AUTO_START` skips the "Try it free" click for the web
build (auto-provisions on first load); `VITE_DEMO_CONTACT_URL`/`VITE_DEMO_CONTACT_EMAIL` override
the `UpgradeDialog`'s (`src/features/upgrade-license/`) sales contact links. Demo staff — shared
across every demo tenant, seeded by `npm run seed:demo` (`scripts/seed-demo.ts`) from the single
source of truth `src/shared/lib/license/demo-accounts.ts` — are Ana Admin (admin), Luis
Gerente (manager), Sofía Cajera (cashier; PINs in demo-accounts.ts); this is why `staff_management` and
`rbac_editing` are locked in a demo. Two E2E tiers: `npm run test:e2e:license` (hermetic, a
committed test-only P-256 keypair in `e2e/helpers/license-keys.ts` signs tokens, two extra
`webServer`s per `playwright.license.config.ts` — no license-server Docker needed) and
`npm run test:e2e:license:live` (opt-in, hits a real local license server; not part of the default
`npm run test:e2e` run). The web build is `npm run build:web` (`tsc && vite build`, no cargo);
hosting/deploy/reset automation is `firebase.json` + `.github/workflows/{deploy-demo,reset-demo}.yml`
at the repo root, with the full runbook (demo Supabase project, prod license-server deploy steps,
Firebase site setup, GitHub secrets, marketing-site CTA) in `docs/online-demo.md`.


## Commands (full list)

```bash
# First-time setup (Ubuntu only)
bash scripts/setup-ubuntu.sh   # Installs native Tauri deps + Rust toolchain

# Development
npm run dev          # Vite dev server (port 1520, Tauri mode)
npm run tauri dev    # Full Tauri desktop app

# Build
npm run build        # TypeScript check + Vite production build

# Code quality (run before committing)
npm run typecheck    # Strict TS check (no emit)
npm run lint         # ESLint (max-warnings: 0)
npm run lint:fix     # Auto-fix lint issues
npm run format       # Prettier on src/

# Testing — unit
npm run test                           # Vitest unit tests (run once)
npm run test:watch                     # Vitest unit tests (watch mode)
npm run test:ui                        # Vitest with browser UI
npm run test:coverage                  # Coverage report
npx vitest run src/path/to.test.ts     # Single test file

# Testing — E2E (Playwright)
npm run test:e2e                       # Full Playwright suite (requires dev server)
npm run test:e2e:report                # Open HTML report after a run
npm run test:e2e:license               # Hermetic license/demo e2e suite (test keypair, no license-server needed)
npm run test:e2e:license:live          # Opt-in license/demo e2e against a real local license server
npx playwright test e2e/caja/session-management.spec.ts   # Single spec file
npx playwright test --headed           # Non-headless (watch browser)
npx playwright show-report             # Open last HTML report

# Component development
npm run storybook    # Storybook on port 6006

# Setup
npm run setup:dev    # Create dev users + seed data
npm run build:web    # Web bundle for the online demo (tsc + vite build, no cargo)
npm run seed:demo    # Seed demo staff (DEMO_STAFF) + catalog + store name for the online/desktop demo
```

### Ubuntu dev notes

- `node_modules` is platform-specific. A checkout carried over from Windows has `@esbuild/win32-x64`, `@rollup/rollup-win32-x64-*` and `@tauri-apps/cli-win32-x64-msvc` and nothing Linux; fix with `rm -rf node_modules && npm ci`, not by deleting `package-lock.json`.
- Native prerequisites and the Rust toolchain are installed by `scripts/setup-ubuntu.sh`; `npx @tauri-apps/cli info` is the one-command sanity check.
- Git hooks are inert in this repo: `.husky/` is gitignored (absent on a fresh clone), and husky cannot self-install from `supermarket-pos/` because the git root is one level above.
- Playwright E2E prefers agent-browser's bundled Chrome-for-Testing binary (auto-detected at config load time, `playwright.config.ts`), falling back to Playwright's own bundled Chromium (`npx playwright install`) when agent-browser isn't present — no separate Chrome install is required either way. E2E is out of scope for the CI `tauri-build` job.
- `npm run test:storybook` uses `@vitest/browser-playwright` with Playwright's own bundled Chromium, so it needs a one-time `npx playwright install` (optionally `--with-deps`); this is deliberately not in `scripts/setup-ubuntu.sh`, which is scoped to native Tauri prerequisites and the Rust toolchain.
- Release builds and code signing stay on Windows.

## Architecture: Feature-Sliced Design (FSD)

The codebase follows strict FSD with enforced import boundaries. ESLint (`eslint-plugin-boundaries`) will fail if you violate the layer hierarchy.

**Import direction — each layer may only import from layers below it:**

```
app → pages → widgets → features → entities → shared
```

**Layer responsibilities:**

- `app/` — Providers, router, Tauri initialization, global CSS
- `pages/` — Thin route containers only; no logic, just layout + widgets
- `widgets/` — Composite UI panels composing features + entities (e.g., `OrderPanel`, `ProductGrid`)
- `features/` — One user action per folder (e.g., `add-item-to-tab/`, `process-payment/`); contains 1 mutation hook + 1 UI component
- `entities/` — Business domain models; each has `model/types.ts`, `model/store.ts`, `model/queries.ts`, `ui/`
- `shared/` — Zero business logic; UI primitives (`shared/ui/`), utilities (`shared/lib/`), constants

## Key Conventions

**Types:** Single source of truth is `src/shared/lib/domain.ts` (Zod schemas). Never manually write entity types — infer from Zod: `type Tab = z.infer<typeof TabSchema>`.

**Generated files — never edit manually:**

- `src/shared/lib/supabase.types.ts` — regenerate with `npx supabase gen types typescript`
- `src/shared/ui/` — shadcn components, add new ones via `npx shadcn@latest add <component>`

**Error handling:** All async operations return `Result<T>` from `src/shared/lib/result.ts` (`Ok(value)` / `Err(error)`). Use the logger from `src/shared/lib/logger.ts` for structured logging.

**State:**

- Zustand stores (`entities/*/model/store.ts`) — UI/local state and Supabase Realtime subscriptions
- TanStack Query hooks (`entities/*/model/queries.ts`) — all server state, use optimistic updates for mutations

**TypeScript:** Strict mode enforced. No `any`. Zod for all external data validation (API responses, user input).

**Styling:** Tailwind CSS with CSS variables for theming. Dark mode is default. Use shadcn/ui components from `shared/ui/` before building custom ones.

**Testing:**

- Unit: Vitest + React Testing Library. Co-locate `.test.ts` files with source. Property-based tests via `fast-check` for pure utilities.
- E2E: Playwright (`e2e/` directory). Config at `supermarket-pos/playwright.config.ts`. Videos + traces always recorded to `e2e-results/`. Tests require `.env.local` E2E credentials — see `CURSOR_VERIFICATION_PROMPT.md`.
- Storybook: Required for every new `shared/ui/` component.
- CI gate: `npm run test` (unit) must pass before any PR. `npm run test:e2e` is run manually before releases.

## Adding a New Feature

Follow the pattern in existing features (e.g., `src/features/add-item-to-tab/`):

1. Define/extend Zod types in `src/shared/lib/domain.ts`
2. Add entity model in `src/entities/<entity>/model/`
3. Create feature folder in `src/features/<action-name>/` with mutation hook + UI
4. Compose into a widget or page

Refer to `supermarket-pos/FSD-STRUCTURE.md` and `supermarket-pos/DOMAIN-CONTRACTS.md` for detailed patterns.

## Routes

All routes are registered in `src/app/router.tsx`. Protected by `<ProtectedRoute>`.

| Path            | Page            | Notes                                                                   |
| ---------------- | --------------- | ------------------------------------------------------------------------ |
| `/home`          | HomePage        | Big-box nav dashboard                                                   |
| `/pos`            | PosPage         | Direct-sale checkout (scan/search → cart → pay); no "tab" concept       |
| `/inventory`      | InventoryPage   | Stock management (admin/manager)                                       |
| `/staff`          | StaffPage       | Staff management                                                        |
| `/suppliers`      | SuppliersPage   | Supplier records + shipment receiving                                   |
| `/reports`        | ReportsPage     | Reports, trimmed to supermarket-relevant tabs (gated by `ReportsRoute`) |
| `/settings`       | SettingsPage    | Hardware + receipt settings (admin only)                                |
| `/payments`       | PaymentsPage    | Payments history, refund/reopen a completed sale                        |
| `/promotions`     | PromotionsPage  | Promotion list; create/edit is a dialog on this same route, opened via `?new=1` or `?edit=<id>` deep links (not a separate page) |
| `/login`          | LoginPage       | PIN login                                                                |
| `/rbac`           | RbacPage        | Role & permission management (admin only)                               |
| `/audit`          | AuditPage       | Audit log (gated by `AuditRoute`)                                       |
| `/edit-history`   | EditHistoryPage | History of edits to already-paid sales (gated by `EditHistoryRoute`)    |

Bar/pool-parlour-era routes (`/pool-tables`, `/pool-tables/:tableId`, `/rappi`, `/waitlist`, `/kds`, `/kds-bar`, `/kitchen-prep`) were removed in Phase 1 (Strip & Rebrand, 2026-08-10) — do not re-add them or plan around them existing.

## Implemented Features (as of 2026-09-04)

Bar/pool-parlour-era features (pool sessions, KDS/kitchen-prep, waitlist, Rappi delivery, split-tab/transfer-tab, combos/recipes/ingredients, tip-distribution) were removed end-to-end in Phase 1 (2026-08-10) — do not assume any of them exist; the removal touched code, routes, and DB schema (RLS/RPCs/triggers/Realtime) together. The bar-pos-era promotions engine was dropped in that same Phase-1 removal, but promotions was rebuilt from scratch for the supermarket product in Phase 27 (Promotions & Discount Management, 2026-09-02) and extended in Phase 28 (Promotion Management Redesign, 2026-09-04) — see the dedicated bullet below. Do not assume any *other* bar/pool-parlour feature in this list exists; promotions is the one exception.

- **Direct-sale checkout** (`checkout-sale`, `scan-barcode-to-cart`, `lookup-product-by-barcode`, `add-loose-weight-item`, `hold-sale`) — scan or search a product → cart → pay (cash/card/split, atomic via `process_direct_sale_atomic`) → receipt; replaced the old bar's tab-based POS page. Handles multi-unit items: loose-weight (kg/g) and case→piece breakdown via `open-unit`/`correct-open-unit`/`void-open-unit`.
- **Supplier & receiving** (`manage-suppliers`, `receive-shipment`) — supplier CRUD plus one-step atomic goods receiving (`receive_shipment` RPC): line items (product, qty, cost price, expiry date) update stock, cost, and expiry together, no PO approval workflow.
- **Expiry tracking** — one active expiry date per product, captured at receiving time; near-expiry alert (14-day default, admin-configurable) surfaces on Home dashboard, Inventory page, and checkout, not only in Reports.
- **Inventory** (`adjust-inventory`, `physical-count`, `override-negative-stock`) — manual stock adjustment with required reason (audit-logged), physical count/stocktake reconciliation, low-stock list driven by per-product reorder point. `/inventory` (`InventoryPagePanel`) is a 5-tab hub: Stock, Catalog, Open Units, Near Expiry, and Movements (the last reads the `stock_movements` ledger, not `inventory_log`).
- **Payments/completed-sale management** (`process-payment`, `process-refund`, `reopen-tab`, `edit-paid-tab`, `remove-tab-item`, `remove-item-from-tab`, `close-tab`) — a completed sale still uses the `tabs`/`orders`/`order_items` tables under the hood even though the checkout UI is sale-focused; refund (manager PIN gate + optional inventory reversal), reopen a paid sale, and edit a paid sale's line items are reachable from `PaymentPane` on `/payments`.
- **Staff & RBAC** (`clock-in-staff`, `clock-out-staff`, `manager-pin-gate`, `force-pin-change`, `edit-staff-role`, `edit-staff-locale`, `toggle-permission`) — PIN login, shift clock-in/out, role/permission management on `/rbac` and `/staff`.
- **Caja (register) sessions** — daily cash session open/close/reconcile (`register-caja-entry`, `close_caja_session`); scoped per-terminal (one open caja per `terminal_id`, default `POS-1`, configurable in Settings → Hardware) rather than one globally.
- **Reports** (`export-report`) — trimmed to supermarket-relevant tabs: Caja, Product Sales (with historical-cost-snapshot margin), Hourly Breakdown, Payment Methods, Deletions Pre/Post, Audit-adjacent report views. `rowsToCsv` CSV serializer (`shared/lib/exporters/csv.ts`) neutralizes CSV formula injection (CWE-1236) by prefixing risky leading characters with `'`.
- **Product/category catalog** (`manage-products`, `manage-categories`, `manage-modifier-groups`) — CRUD, barcode lookup. Reachable via `/inventory` → Catalog tab (`manage_products` RBAC gate; the tab isn't rendered at all for roles without it) — not under Settings.
- **AI vision pipeline** (`agent-chat` feature, `src/shared/lib/agent/{brain,vision}.ts`) — image/PDF/CSV → Anthropic extraction → confirm → bulk product import. Currently name+price extraction only; extending to full invoice line items (qty/cost/supplier/expiry) is v2/Beta scope (`AI-01..05` in `.planning/REQUIREMENTS.md`), which also covers moving the Anthropic call server-side into an edge function instead of the current client-side key.
- i18n / multi-language (es-MX default, en-US) — `react-i18next` across every FSD layer, self-service Language tab in Settings (all roles), admin per-staff locale field on `/staff`, locale-aware receipts/PDFs, `i18next/no-literal-string` lint gate — see "i18n / Multi-Language" section below.
- Touch-target & focus-visible sweep — `focusEmphasis` CVA variant on `Button`/`POSButton`, `touchSize` (44/56/72px) rollout, `ConfirmDialog`'s `confirmClassName` passthrough for destructive confirms.
- **Promotions & discounts** (`/promotions`, `src/entities/promotion/`, RBAC `manage_promotions` — admin-only) — percent or fixed-amount discounts scoped to specific products/categories or store-wide (`promotions` + `promotion_targets` junction table), with an active date range plus optional day-of-week/time-of-day recurrence. Best-price-wins pricing is evaluated both client-side (live cart preview, `evaluateBestPromotion` in `src/entities/promotion/model/promotion-pricing.ts`) and server-side inline inside `process_direct_sale_atomic` (sole pricing authority — there is no separate "apply promotion" RPC), which also auto-applies a configurable near-expiry discount tier. Applied discounts are snapshotted per line item on `order_items` (`promotion_id`/`discount_rate`/`discount_amount`) so refunds/reopens preserve historical pricing. A separate `apply_custom_discount` RBAC action (manager+) gates ad-hoc checkout discounts independent of the promotions engine. Combos are supported as a promotion `kind` (bundle/mix-and-match/3x2/percent-off-bundle) built from product/category-level combo-eligibility flags, composed in a combo builder in the same promotion dialog and priced authoritatively alongside regular promotions inside `process_direct_sale_atomic`.
- **Idle screen lock** (`src/features/idle-screen-lock/ui/IdleLockProvider.tsx`) — locks the app behind the PIN overlay after inactivity; lock state is persisted (`lock-state` localStorage key, `src/shared/lib/lock-state-store.ts`) so quitting/restarting the app while locked cannot bypass the PIN overlay.
- **Settings unsaved-changes guard** (`src/widgets/SettingsTabsPanel/`) — a dirty Settings tab prompts Save/Discard/Cancel on tab switch, on sidebar navigation away from `/settings`, and on app close; tabs register their dirty state via `useRegisterUnsavedChanges` (`SettingsTabsPanel/model/unsaved-changes.tsx`), sidebar navigation is intercepted via the route guard in `shared/lib/navigation-guard.ts`, and app close is intercepted via `SettingsTabsPanel/model/useCloseGuard.ts` (Tauri close event + `beforeunload` fallback).
- **Payment amount keypad** (`features/payment-keypad`, composed into `PaymentModal/PaymentForm`) — tap-only on-screen numeric keypad next to the cash "Amount tendered" field; digit taps shift into the amount digit-by-digit (like a calculator), sharing state with the quick-tender buttons and the MoneyInput's own keyboard entry. Visibility toggle persisted per terminal in localStorage (`pos.payment_keypad_visible`). Replaced the earlier PLU/qty keypad that lived on the cart-building checkout screen (`CheckoutPanel`) — that one added products by barcode and armed a ×N multiplier, which had no meaning once the cashier reached the payment step; it was removed rather than kept.

## Key DB Tables (Remote Supabase)

| Table                                       | Description                                             |
| -------------------------------------------- | --------------------------------------------------------- |
| `profiles`                                   | Staff accounts + roles                                    |
| `shifts`                                     | Clock-in/out records                                       |
| `products` / `categories`                    | Product catalog                                             |
| `tabs` / `orders` / `order_items`            | Sales (a completed sale is still modeled as a "tab")      |
| `payments`                                   | Payment records                                             |
| `inventory` / `inventory_log`                | Stock levels + movement log (linked to `products`)         |
| `caja_sessions` / `caja_entries`             | Daily cash register sessions                                |
| `suppliers` / `supplier_products` / `shipments` | Supplier records + shipment receiving (Phase 3)          |
| `receipt_settings`                           | Per-terminal receipt config                                 |
| `open_units`                                 | Case→piece unit-breakdown tracking                          |
| `audit_logs`                                 | Audit trail                                                 |
| `role_permissions`                           | RBAC permission overrides                                    |
| `promotions` / `promotion_targets`           | Promotion engine (Phase 27/28) — discount rules + product/category targeting junction; live, not dropped |
| `promotion_combo_slots`                      | Combo slot composition (N units from a product/category set) for `kind='combo'` promotions |

Bar/pool-parlour-era tables (`pool_sessions`, `pool_tables`/`resources`, `rappi_orders`, `waitlist_entries`/`waitlist_notifications`, `prep_productions`, `combo_*`/`recipes`/`ingredients`/`modifier_inventory_rules`, `tab_transfers`, `tip_distribution_entries`) were dropped in Phase 1 — do not reference them. The bar-pos-era `promotions`/`promotion_availability`/`applied_promotions` trio was dropped in that same Phase-1 pass, but a differently-shaped `promotions`/`promotion_targets` schema was reintroduced in Phase 27/28 (see table above and the "Implemented Features" section) — do not assume the promotions tables are gone.

## RBAC Actions

Defined in `src/shared/lib/rbac.ts`. Roles: `cashier < manager < admin`. The bar-pos `kitchen` role was retired (migrations `20261018000001`–`04`): the `user_role` enum label remains, but CHECK constraints on `profiles.role` and `role_permissions.role` refuse it. (The role set was `bartender < manager < admin` in the original bar-pos codebase; renamed to `cashier` end-to-end — DB enum, RLS, TS types — as part of Phase 1's rebrand, D-16.)

Actions: `create_order`, `view_own_tabs`, `view_all_tabs`, `clock_in`, `clock_out`, `close_tab`, `view_reports`, `adjust_inventory`, `manage_products`, `manage_staff`, `manage_settings`, `delete_tab`, `view_all_shifts`, `manage_caja`, `process_refund`, `view_audit_log`, `edit_paid_tab`, `reopen_tab`, `manage_promotions` (admin-only, Phase 27), `apply_custom_discount` (manager+, Phase 27 — ad-hoc checkout discount + below-cost floor-guard override), `resolve_offline_sale` (granted to holders of `adjust_inventory` when migration `20261009000001` ran — approves an offline-sale write-off, two-mode Plan 02c). There is no `transfer_tab` action — tab transfer was a bar-pos-only concept removed in Phase 1; do not plan around it existing. There is no `void_order` action either — the void-order feature was removed end-to-end in Phase 5 (v1.1); `process_refund` is the sole staff-facing reversal path for a completed sale.

Settings page requires `manage_settings` (admin only). Inventory page requires `adjust_inventory` (manager+).

## Offline Queue

Offline mutation queue is in `tabsStore.offlineQueue` (Zustand). `OfflineQueueProcessor` component replays queued actions on reconnect. Guard mutations with `isOnline()` from `@shared/lib/network`. `OfflineBanner` in `@shared/ui` surfaces connection state.

**Offline SALES are a separate store, not `tabsStore.offlineQueue`** (two-mode Plan 02b). A till keeps selling cash, card (with an approval reference) and cash+card split through an outage: each sale is a record in `entities/offline-sale` (pure state machine `queued → replaying → confirmed | needs_review → resolved`, eligibility, limits of 500 unsent sales / 24 h, provisional receipt, storage-pressure eviction of the oldest confirmed sales), replayed once per sale by `app/OfflineSaleReplayer.tsx` through `process_direct_sale_atomic` under its idempotency key, and reviewed/resolved by a manager (retry, re-ring, write-off, move to review) in `features/review-offline-sales`. The server stays the only price authority: a sale it refuses on replay goes to manager review, it is never repriced by the client. Owner decisions that amend the plan (sign-out rules, limits, retry rules) are in `.planning/decisions/2026-10-09-two-mode-02b-owner-decisions.md`.

## Supabase

Realtime subscriptions are initialized in Zustand stores, not React components. Edge function contracts are defined in `src/shared/lib/edge-function-contracts.ts`. See `supermarket-pos/SUPABASE-CONTRACTS.md` for the full API contract.

**Missing generated types workaround:** When a new table or RPC exists in the DB but `supabase.types.ts` has not been regenerated yet, use `const db = supabase as any` at the file level with a file-level `/* eslint-disable */` comment. Regenerate types ASAP with `npx supabase gen types typescript --local > src/shared/lib/supabase.types.ts` and remove the cast.

**Deploy migrations before edge functions before the client (combos/per-terminal-caja release).** The `20260913000000_caja_per_terminal.sql` / `20260913000001..000003_combo_*`/`fix_reopen_edit_caja_terminal_scope.sql` migrations and the `process-direct-sale` edge function must land in that exact order — `supabase db push` (migrations) before redeploying `process-direct-sale`, before shipping the client — because the client now always sends `p_terminal_id` and reads `caja_sessions.terminal_id`; deploying out of order breaks every checkout on that terminal.

**Same order for the two-mode combined release (Plan 02c):** migrations `20261009000001`-`000012` (after `20260929000001`-`000008` and `20261002000001`-`000002`), then `process-direct-sale`, `process-payment`, `process-split-payment`, then the client — store closed, every till updated before the first sale (an old till is refused `AMOUNT_MISMATCH` on some sales and cannot write off an offline sale). Owner steps: `docs/superpowers/plans/2026-10-02-two-mode-RELEASE-CHECKLIST.md`, section Plan 02c.

**Release blockers resolved (2026-11-04, v1.11.4).** Migrations `20260929000001`–`000008` and `20261009000001`–`000012` are applied to both production projects (267 migrations, 16 functions each), and `npm run lint` has 0 errors. Handoff: `E:/backups/handoff/HANDOFF-2026-11-04-cloud-offline-release.md`. Local-mode plans 05b–13 remain deferred.

The persisted-PIN-verifier decision is resolved (2026-10-01): an admin's offline verifier stays in memory only, and manager/cashier verifiers persist for 24 h. Do not change this without the owner.

**Migration DOWN scripts:** most migrations (including all post-Phase-1 pivot migrations) lack DOWN scripts — retroactive addition is out of scope as Supabase Cloud has no automated rollback mechanism.

**Never create or repair an `auth.users` row with a raw `INSERT`/`UPDATE`.** Always go through `supabase.auth.admin.createUser()` / `admin.updateUserById()` (or Studio's "Add user", which calls the same API). A raw INSERT can leave `confirmation_token`, `recovery_token`, `email_change_token_new`, or `email_change` as `NULL` — these 4 columns have no schema-level `DEFAULT ''` (confirmed: `ALTER TABLE auth.users ... SET DEFAULT` fails with `must be owner of table users` even via service-role/`set role supabase_auth_admin` — Supabase locks `auth.*` DDL to its own GoTrue service, unfixable from this project). A NULL in any of them crashes **every** GoTrue endpoint that reads the row full-row (`/token`, `/recover`, `/magiclink`, `/admin/users`) with a 500 `sql: Scan error ... converting NULL to string is unsupported` — this took down login for the one real production admin account on 2026-08-30. If a raw fix on `auth.users` is ever unavoidable, immediately follow it with `supabase/migrations/20260830000001_auth_users_token_defaults.sql`'s backfill pattern (`COALESCE(col, '')` on all 7 token columns) in the same statement.

**PIN/password has two separate credential stores — a manual reset must update both, in one operation.** `public.profiles.pin` is a salted bcrypt hash (11H; the `profiles_hash_pin` trigger hashes a 6-digit write, a `$2` value passes verbatim; compare with `verify_staff_pin` / `staff_ids_with_pin`, never `.eq('pin', ...)`) and is what the PIN-checking RPCs compare (`verify_staff_pin`, manager approvals). `auth.users.encrypted_password` is what Supabase Auth checks, and since two-mode plan 01 it is **not the PIN**: it is `deriveStaffPassword(staffId, pin)` = `v1.` + base64url(HMAC-SHA256(`STAFF_PASSWORD_PEPPER`, `barpos-staff-password|v1|<lower-case staff id>|<pin>`)) (`supabase/functions/_shared/staff-password.ts`; Node twin `scripts/lib/staff-password.ts`). So `crypt('<pin>', gen_salt('bf', 10))` no longer produces a working password — never reset a PIN with raw SQL. Reset through the `admin-reset-pin` function (the Staff page), or from a script with `updateUserById(id, { password: await deriveStaffPassword(id, pin) })` together with the matching `profiles.pin` update. Patching only one store leaves login failing with a clean `400 invalid_credentials` (the 2026-08-30 incident, `.planning/notes/vinty-owner-login-outage-rca.md`). If `STAFF_PASSWORD_PEPPER` is lost or rotated, passwords cannot be re-derived from the hash: set the new secret and reset every staff PIN through `admin-reset-pin` (the re-derive script was deleted in 11H).

## E2E Test Suite (`supermarket-pos/e2e/`)

The suite was fully rewritten in Phase 17 (E2E Suite Overhaul) from a flat 50-file layout into domain folders under `e2e/`, one folder per subsystem, each grouped by Playwright's `global-teardown.ts` report classification (folder path, not filename prefix). 51 spec files across 20 folders — all must pass before release (`npm run test:e2e`), aside from the intentional carve-out documented below.

| Folder | Covers |
|--------|--------|
| `e2e/a11y/` | Keyboard focus/Tab-order regression coverage (ManagerPinDialog, inventory filter row, Batch Adjustment dialog) |
| `e2e/ai/` | AI vision pipeline (agent-chat): file-drop → extraction preview → confirm → bulk product import, Anthropic call mocked via `page.route()` |
| `e2e/audit/` | Audit log table/diff viewer, cross-entity ID linking from Audit Log to Payments/Staff |
| `e2e/caja/` | Caja (register) session open/close, cash-entry registration |
| `e2e/checkout/` | Direct-sale checkout happy paths, atomic RPC/idempotency guards, barcode/search product discovery, per-item cart notes |
| `e2e/errors/` | Cross-cutting error/validation scenarios (closed-caja guard, out-of-stock confirm gate, field-length validation) |
| `e2e/home/` | Home dashboard navigation, RBAC-gated route redirects, removed-route catch-all behavior |
| `e2e/infra/` | CI smoke checks, general infra checks, Tauri build sanity, updater, offline mutation queue |
| `e2e/inventory/` | Manual adjustment, low-stock/near-expiry alerts, physical count, open-unit (case→piece) breakdown, loose-weight sale/hold |
| `e2e/license/` | Hermetic demo-edition coverage (`npm run test:e2e:license`): demo start/lock points/auto-start/paid-license regression, signed via a committed test-only keypair — no license-server Docker needed |
| `e2e/license-live/` | Opt-in demo-lifecycle coverage against a real local license server (`npm run test:e2e:license:live`); excluded from the default `npm run test:e2e` run (`playwright.config.ts` `testIgnore`) |
| `e2e/offline-sales/` | Offline checkout with the backend cut: a provisional sale is stored, replayed once and confirmed; a sale refused on replay is surfaced and manager-resolved (re-ring, write-off with its audit row, already-recorded); a duplicate tap and a lost replay answer are charged once; offline card sale and cash+card split land in the right payment rows; who may leave the till while a sale is queued or in review |
| `e2e/payments/` | Core payment completion, PaymentPane navigation, edge cases (tip/discount/underpayment), refund (with stock-movement assertions), tab split-payment |
| `e2e/products/` | Product CRUD/visibility in the checkout grid, category tree + modifier-groups RLS |
| `e2e/purchase-orders/` | PO creation, reorder-suggestion draft, receive-and-close, cashier RBAC/RLS denial |
| `e2e/rbac/` | Role/permission matrix, staff management (clock-in/out, role/locale edits), RLS-boundary denial (cashier vs. manager) |
| `e2e/receipts/` | Hardware/receipt settings, category+modifier grouping on the printed receipt, print-retry resilience, reprint, PDF/email delivery |
| `e2e/reports/` | Report tabs (caja/product-sales/hourly/payment-methods/margin/turnover), product-sales report, CSV export, discount-and-revenue |
| `e2e/settings/` | Self-service locale switch, settings backup/restore |
| `e2e/soak/` | Full-day multi-role soak test exercising checkout, caja, and staff flows together |
| `e2e/suppliers/` | Supplier CRUD, shipment receiving (including forced-failure atomicity), loading/error states |
| `e2e/tabs/` | Edit a paid sale's line items, reopen a closed ticket, optimistic-concurrency conflict handling on a version-guarded save |
| `e2e/visual/` | Visual-regression baseline across the full route × role matrix |

**One documented manual-verification exception:** the native Tauri window shell, the physical USB-HID PIN keypad, and Supabase's local `devtools` UI cannot be driven by a Playwright browser session — there is no way to intercept OS-level window chrome or real hardware input from a headless Chrome-for-Testing process. This is the sole carve-out from this repo's "no `human_needed`/manual-UAT" testing policy (see `## Testing & Verification Policy` above); every other scenario formerly gated behind `test.skip` in the old `14-manual-stubs.spec.ts` (CI/build/Tauri sanity) was closed with real automated coverage in `e2e/infra/` instead, and that placeholder file was deleted, not left as a stub.

Auth helpers are in `e2e/helpers/auth.ts`. Use `loginAs(page, 'admin')` — admin PIN is in the E2E env.

## i18n / Multi-Language

Stack: `react-i18next` + `i18next`, singleton at `src/shared/lib/i18n/index.ts` (lives in the `shared` FSD layer — every layer imports it, no layer above `shared` may be a dependency). No `i18next-http-backend`/`i18next-browser-languagedetector` — this is an offline, statically-bundled Tauri app; all catalogs ship in the signed binary and locale is staff-driven (`profiles.locale`), not browser/OS-driven.

**Namespace scheme** (10 namespaces, one JSON file per locale under `src/shared/lib/i18n/locales/{es-MX,en-US}/`), one per FSD layer/concern:

| Namespace | Layer / concern |
|-----------|------------------|
| `common` | `shared/ui` — cross-cutting buttons, loading states, shared component copy |
| `featOrders` | `features/` — order/pool-timer/payment/refund/split/void/caja-entry actions |
| `featMgmt` | `features/` — management-action features (products, staff, RBAC-adjacent) |
| `wPanels` | `widgets/` — operational panels (POS/checkout, payments, suppliers, caja, inventory, home) |
| `wAdmin` | `widgets/` — report/analytics/audit/RBAC/inventory/settings-tab admin widgets |
| `entities` | `entities/` — domain model hooks + `ui/` cards/rows |
| `pages` | `pages/` — route container titles/labels |
| `settings` | Settings tabs (incl. the Language tab itself) |
| `staff` | Staff management page |
| `receipt` | Printed receipts / PDF exports |

**Locale is a per-staff preference** (`profiles.locale`, `LocaleSchema` = `'es-MX' | 'en-US'`, default `es-MX`), not a terminal/browser setting — it persists across devices/logins. Two write paths: (1) self-service via Settings → Language, open to every authenticated role including cashier (`LanguageSettingsTab`, role-agnostic, always the first/default Settings tab); (2) admin override of another staff member's locale on `/staff`, gated by the existing `manage_staff` RBAC action. Switching your own locale calls `i18n.changeLanguage()` on save, re-rendering the whole app immediately with no page reload.

**Catalog rule for this phase:** es-MX values are byte-identical to the pre-migration hardcoded literal (the migration only changed the *source* of each string, not its content); en-US values are genuine English translations. Full Spanish-content translation (i.e., changing the es-MX values themselves) is out of scope / future work.

**Enforcement (D-05):** `i18next/no-literal-string: error` is committed in `eslint.config.js`, scoped to `shared/ui`, `entities`, `features`, `widgets`, and `pages`, `mode: 'all'`, no grandfather/ignore list — any new hardcoded UI string in those layers fails `npm run lint`.

## TypeScript Gotchas

**`exactOptionalPropertyTypes` is enabled.** Never write `prop?: string` for mutation inputs — write `prop: string | undefined` instead. Optional chaining and default values still work normally.

**AppErrorCode** — the full union is in `src/shared/lib/result.ts`. When adding a new error code, add it to that union first, then use `const appErr: AppError = { code: 'YOUR_CODE' as AppErrorCode, ... }`.

Current codes: `NETWORK_OFFLINE | AUTH_REQUIRED | AUTH_FORBIDDEN | NOT_FOUND | VALIDATION_ERROR | DUPLICATE_ENTRY | TAB_ALREADY_CLOSED | SESSION_STILL_RUNNING | PAYMENT_DECLINED | PAYMENT_ALREADY_PROCESSED | INVENTORY_NEGATIVE | CAJA_CLOSED | OPEN_TABS_EXIST | POOL_TABLE_OCCUPIED | SUPABASE_ERROR | TAURI_ERROR | UNKNOWN_ERROR`

---

### Actual Stack (from package.json / tsconfig.json)

| Technology      | Version                                        | Notes                                                                 |
| --------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| React           | 19.1.0                                         | Function components only; hooks-only                                  |
| TypeScript      | 5.8.3                                          | strict mode; `exactOptionalPropertyTypes: true`                       |
| Desktop runtime | Tauri 2 (`@tauri-apps/api ^2`)                 | **NOT Electron** — IPC via `invoke()` from `@tauri-apps/api/core`     |
| Build tool      | Vite 7                                         |                                                                       |
| Server state    | TanStack Query v5 (`@tanstack/react-query ^5`) | All server state via TanStack Query                                   |
| Local/UI state  | Zustand v5                                     | Realtime subscriptions initialized in stores                          |
| Validation      | Zod v4                                         | Single source of truth for domain types in `src/shared/lib/domain.ts` |
| Styling         | Tailwind CSS v3 + shadcn/ui                    | Do not introduce new CSS systems                                      |
| Unit tests      | Vitest v4 + React Testing Library v16          | `npm run test`                                                        |
| Property-based  | fast-check v4                                  | Use for billing math, boundary conditions                             |
| E2E             | Playwright v1.59                               | `npm run test:e2e`; specs in `supermarket-pos/e2e/`                           |
| Storybook       | v10                                            | Required for new `shared/ui/` components                              |

### Architecture

Feature-Sliced Design (FSD). Import direction: `app → pages → widgets → features → entities → shared`. Enforced by `eslint-plugin-boundaries`. A boundary violation is a blocking lint error.

### TypeScript Gotchas (Critical)

- **`exactOptionalPropertyTypes: true`** — Never write `prop?: string` for mutation inputs. Write `prop: string | undefined`.
- **`noUncheckedIndexedAccess: true`** — Array access returns `T | undefined`. Always check before use.
- **No `any`** without a justification comment on the same line.

### Forbidden Patterns

```typescript
// ❌ Manual type interfaces for domain entities
interface Tab { id: string }  // use Zod schema in domain.ts instead

// ❌ Ignored Supabase error
const { data } = await supabase.from('tabs').select();  // error must be handled

// ❌ console.log
console.log('debug');  // use src/shared/lib/logger.ts

// ❌ Hardcoded secrets
const key = 'eyJ...';

// ❌ Electron IPC patterns (this is Tauri 2)
ipcRenderer.send('event');
contextBridge.exposeInMainWorld(...);

// ❌ Service-role key in renderer
createClient(url, SUPABASE_SERVICE_ROLE_KEY);

// ❌ any without justification
const x: any = response;
```

### Commit Convention

Conventional Commits: `<type>(<ticket-id>): <description>`
Types: `feat` | `fix` | `refactor` | `test` | `chore`
No `--no-verify`. Pre-commit hooks (husky + lint-staged) must pass.

### Test Commands

```bash
cd supermarket-pos
npm run typecheck          # tsc --noEmit — must pass before every commit
npm run lint               # ESLint max-warnings: 0
npm run test               # Vitest unit (run once)
npm run test:e2e           # Playwright — requires .env.local E2E credentials
npx vitest run src/path/to/file.test.ts   # single test file
npx playwright test e2e/caja/session-management.spec.ts   # single E2E spec
```
