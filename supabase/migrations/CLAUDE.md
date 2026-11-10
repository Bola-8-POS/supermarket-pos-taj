# supabase/migrations/

Purpose: Postgres schema, RLS and RPCs, applied in filename order.

- Name `<14 digits>_<name>.sql`, version after every grandfathered file; no own transaction control, no cluster-wide DDL (roles, databases, system settings). Enforced by `npm run lint:migrations`.
- Deploy order is migrations, then edge functions, then client. Out of order breaks every checkout. Per-release lists: docs/agent-reference.md "Supabase".
- Never raw INSERT/UPDATE on `auth.users` (NULL token columns break login for everyone); use `auth.admin.createUser()` / `updateUserById()`.
- Never reset a PIN with SQL: `profiles.pin` and the derived Auth password change together via the `admin-reset-pin` function.
- Most migrations have no DOWN script; write them forward-safe.
- 14 migrations are `parse_unusable` for the code graph: read them directly (list in reference "Codebase exploration").
- Applying to a production project (ours or customer) needs the owner's go first. Local dev2 is `http://127.0.0.1:56321`.
- After a schema change regenerate `src/shared/lib/supabase.types.ts`.

Test: npm run lint:migrations; integration against dev2: npm run test:integration.
Persona + model: Database Reliability Engineer (Backend Architect for RPC logic, Application Security Engineer for RLS); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
