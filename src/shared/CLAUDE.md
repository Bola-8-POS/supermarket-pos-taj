# src/shared/

Purpose: zero business logic: UI primitives (`ui/`), utilities and schemas (`lib/`), constants (`config/`). Imports nothing from other layers.

- Generated, never hand-edit: `src/shared/lib/supabase.types.ts` (regenerate with `npx supabase gen types typescript --local > src/shared/lib/supabase.types.ts`) and `src/shared/ui/` (shadcn; add via `npx shadcn@latest add <component>`).
- `src/shared/lib/domain.ts` is the single source of entity types (Zod). Edge function contracts: `src/shared/lib/edge-function-contracts.ts`.
- Missing-generated-types workaround: docs/agent-reference.md "Supabase".
- Result/logger/no-`any`/exactOptionalPropertyTypes rules as in `src/CLAUDE.md`.
- Non-`ui/` code needs a co-located unit test; use `fast-check` for pure utilities.

Test: npx vitest run <path>; npm run test (all unit). Storybook: npm run test:storybook.
Persona + model: Frontend Developer (UI Designer for `ui/` tokens); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
