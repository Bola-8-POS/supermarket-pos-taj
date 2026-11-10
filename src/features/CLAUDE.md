# src/features/

Purpose: one user action per folder (e.g. add-item-to-tab, checkout-sale), each with a mutation hook and a UI component.

- FSD direction `app -> pages -> widgets -> features -> entities -> shared`: `features` may import only from: entities, shared. A violation is a blocking lint error (eslint-plugin-boundaries).
- Pattern to copy: `src/features/add-item-to-tab/`. New feature order: extend Zod in `domain.ts`, entity model, feature folder, compose into a widget/page (reference "Adding a New Feature").
- Money paths (checkout, payments, refunds) call edge functions via `src/shared/lib/edge-function-contracts.ts`; extra Opus review on money changes.
- Shared TS rules: see src/CLAUDE.md.

Test: npx vitest run <path> (single file); npm run test (all unit).
Persona + model: Frontend Developer (Payments & Billing Engineer for payment/refund logic); Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
