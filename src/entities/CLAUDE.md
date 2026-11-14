# src/entities/

Purpose: business domain models: `model/` (types, Zustand store, TanStack Query hooks) and `ui/`.

- FSD direction `app -> pages -> widgets -> features -> entities -> shared`: `entities` may import only from: shared only. A violation is a blocking lint error (eslint-plugin-boundaries).
- Server state = TanStack Query (`model/queries.ts`, optimistic updates for mutations); local/Realtime state = Zustand (`model/store.ts`).
- Integration tests (`*.integration.test.ts`) run against dev2 (127.0.0.1:56321) via `npm run test:integration`. `npm run lint` has 49 known errors in 6 `src/entities/tab/model/*.integration.test.ts` files (root blocker).
- Shared TS rules: see src/CLAUDE.md.

Test: npx vitest run <path>; integration: npm run test:integration (dev2).
Persona + model: Frontend Developer (Realtime Collaboration Engineer for Realtime subscriptions); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
