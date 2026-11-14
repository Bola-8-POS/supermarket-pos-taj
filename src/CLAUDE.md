# src/

Purpose: the React 19 + TypeScript renderer (Feature-Sliced Design). Per-layer rules are in `src/<layer>/CLAUDE.md`.

- Layers: `app -> pages -> widgets -> features -> entities -> shared`; imports only point downward; lint-enforced.
- Types come from Zod (`shared/lib/domain.ts`). Async returns `Result<T>`. Logger, not `console.log`.
- No `any` without a same-line justification; `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.
- No hardcoded secrets; no service-role key in the renderer.
- User-facing strings go through i18n (reference "i18n / Multi-Language"). The kitchen role is a leftover; do not treat it as real.
- Confirm a feature/entity exists in `src/` before relying on docs (docs can be stale).
- Co-locate tests next to the code (`*.test.ts`, `*.integration.test.ts`).

Test: npm run typecheck (0 errors before commit); npm run lint; npm run test; single file: npx vitest run <path>.
Persona + model: Frontend Developer; Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
