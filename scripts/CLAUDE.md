# scripts/

Purpose: repo tooling: lint gates (`check-*.mjs`), seeds, customer onboarding/deploy, installer verification.

- `check-*.mjs` back the `npm run lint:*` gates; most check-*.mjs have a *.test.mjs. Findings print `file[:line]: rule`, never secret or SQL text.
- Never hardcode secrets or print env values. Seed/cleanup scripts target dev2 only.
- `deploy-remote-backend.ps1` and `onboard-customer.ps1` write to production projects: owner go first. Customer registry: `customers/customers.json`.
- Staff password helper `scripts/lib/staff-password.ts` is the Node twin of the edge function one; PIN resets go through `admin-reset-pin`.
- `remote-signin-smoke.mjs` reads a deployed project (SMOKE_PROJECT_REF, SMOKE_SERVICE_ROLE_KEY, SMOKE_ANON_KEY); prints only role + HTTP status + PASS/FAIL, never keys or PINs; `--selftest` runs offline against a stub server. Owner go before pointing it at production.
- Windows-machine checks (`verify-*.ps1`) run in Windows Sandbox, not on the dev PC.

Test: npm run lint:secrets, lint:migrations, lint:control-bytes, lint:function-imports (the gates these scripts implement).
Persona + model: Backend Architect (Desktop App Engineer for installer scripts); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
