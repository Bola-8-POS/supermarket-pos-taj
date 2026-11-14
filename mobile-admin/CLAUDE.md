# mobile-admin/

Purpose: Expo (React Native) admin app; own `package.json` and lockfile, separate from the desktop app.

- Run npm commands from `mobile-admin/`, not the repo root.
- No service-role key and no hardcoded secrets in the app; it talks to the same Supabase backend.
- Source in `src/` (`app/`, `components/`, `features/`, `lib/`, `theme.ts`).

Test: cd mobile-admin && npm run typecheck && npm test (jest); lint: npm run lint (expo lint).
Persona + model: Frontend Developer; Sonnet writes code, Haiku runs tests/search, Opus review only (root CLAUDE.md model routing).
