# src/pages/

Purpose: thin route containers.

- FSD direction `app -> pages -> widgets -> features -> entities -> shared`: `pages` may import only from: widgets, features, entities, shared. A violation is a blocking lint error (eslint-plugin-boundaries).
- Layout + widgets only; no logic or data fetching here. Routes list: reference "Routes".
- Shared TS rules: see src/CLAUDE.md.

Test: npx vitest run <path> (single file); npm run test (all unit).
Persona + model: Frontend Developer; Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
