# src/widgets/

Purpose: composite UI panels that compose features and entities (e.g. OrderPanel, ProductGrid).

- FSD direction `app -> pages -> widgets -> features -> entities -> shared`: `widgets` may import only from: features, entities, shared. A violation is a blocking lint error (eslint-plugin-boundaries).
- Compose, do not own business rules. Use shadcn components from `shared/ui/` before custom ones; dark mode is default.
- Shared TS rules: see src/CLAUDE.md.

Test: npx vitest run <path> (single file); npm run test (all unit).
Persona + model: Frontend Developer (UI Designer for visual polish; Accessibility Auditor for a11y); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
