-- Root-cause fix for a production login outage on 2026-08-30: the remote project's
-- one real admin account ("the store owner") was seeded via a raw/manual SQL INSERT into
-- auth.users during an earlier /gsd-explore session (2026-08-27), skipping GoTrue's
-- own Admin API user-creation code path. GoTrue's Go driver scans several auth.users
-- text columns into non-nullable Go strings, and some of them have NO DEFAULT '' at
-- the Postgres level (unlike their siblings, which already default to ''):
--   confirmation_token, email_change, email_change_token_new, recovery_token
-- A raw INSERT that omits these leaves them NULL, and any GoTrue endpoint that reads
-- the full user row then fails with a 500 "Scan error ... converting NULL to string
-- is unsupported" -- this broke password login (/token), password recovery
-- (/recover), magic link (/magiclink), and the admin user list (/admin/users) for
-- the affected row.
--
-- IMPORTANT -- this migration does NOT (and cannot) add a schema-level DEFAULT '' to
-- close the gap at the column level: `alter table auth.users alter column ... set
-- default ''` fails with `must be owner of table users` (SQLSTATE 42501) under both
-- `supabase db push` and a direct SQL Editor/service-role connection, and even
-- `set role supabase_auth_admin` is itself permission-denied to project-level roles.
-- Supabase deliberately locks ownership of the `auth` schema to its own managed
-- GoTrue service so project migrations cannot alter its DDL-level shape. This is a
-- platform boundary, not a gap this project can close with a migration.
--
-- The actual prevention going forward is PROCEDURAL, not schematic: never create an
-- auth.users row via a raw SQL INSERT again. Always provision accounts through
-- GoTrue's own Admin API (`supabase.auth.admin.createUser()`, used by every script in
-- this repo -- scripts/setup-dev-users.ts, scripts/setup-test-fixtures.ts,
-- scripts/seed-remote-e2e-admin.ts) or the Supabase Studio "Add user" button (which
-- calls the same Admin API internally) -- both already set every token column
-- correctly, which is exactly why none of this repo's own seeded fixture accounts
-- ever hit this bug, only the one hand-seeded production admin account did.
--
-- What this migration DOES do: a defensive, idempotent backfill so any row already
-- carrying NULL in one of these columns (from this incident, or a future one-off
-- manual insert someone runs anyway) gets repaired the next time this migration set
-- is applied to any environment (fresh local dev reset, a new project deployment).
--
-- No DOWN script (project convention -- Supabase Cloud has no automated rollback
-- mechanism, see CLAUDE.md).

update auth.users
set
  confirmation_token = coalesce(confirmation_token, ''),
  recovery_token = coalesce(recovery_token, ''),
  email_change_token_new = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  email_change = coalesce(email_change, ''),
  reauthentication_token = coalesce(reauthentication_token, ''),
  phone_change_token = coalesce(phone_change_token, '')
where confirmation_token is null
   or recovery_token is null
   or email_change_token_new is null
   or email_change_token_current is null
   or email_change is null
   or reauthentication_token is null
   or phone_change_token is null;
