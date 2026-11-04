# supabase/functions/

Purpose: Deno edge functions (staff sign-in, sales, payments, receiving, settings). Shared code in `_shared/`.

- Errors go through `_shared/errors.ts` `fail()` with a stable code (VALIDATION_ERROR, FORBIDDEN, ...); never return raw Postgres/Auth messages.
- 503 / `UPSTREAM_UNAVAILABLE` only for an unreachable upstream or outcome-unknown on money paths (`_shared/upstream.ts`, `_shared/caller.ts`); real business errors keep their own codes.
- Money functions (`process-direct-sale`, `process-payment`, `process-split-payment`) retry under the same idempotency key; changes get an extra Opus review.
- PIN/password: `deriveStaffPassword` in `_shared/staff-password.ts`; never persist or log the pepper or PINs.
- Keep contracts in step with `src/shared/lib/edge-function-contracts.ts`. Import/config gates: `npm run lint:function-imports`, `npm run lint:functions-config`.
- Deploy after migrations, before the client. Production deploy or secret = owner go first.

Test: npm run test:deno
Persona + model: Backend Architect (Identity & Access Engineer for auth, Payments & Billing Engineer for money); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
