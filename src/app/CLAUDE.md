# src/app/

Purpose: providers, router, gates (license, store schema, protected routes), offline queue/replay processors, global CSS.

- FSD direction `app -> pages -> widgets -> features -> entities -> shared`: `app` may import only from: pages, widgets, features, entities, shared. A violation is a blocking lint error (eslint-plugin-boundaries).
- Providers and route wiring only; no feature logic. Realtime subscriptions start in Zustand stores, not here or in components.
- Offline replay: reference "Offline Queue"; changes to sale replay are money-sensitive (extra Opus review).
- Shared TS rules: see src/CLAUDE.md.

Test: npx vitest run <path> (single file); npm run test (all unit).
Persona + model: Frontend Developer (Identity & Access Engineer for auth/RBAC gates); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
