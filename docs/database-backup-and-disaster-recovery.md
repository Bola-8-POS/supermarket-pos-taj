# Database Backup & Disaster Recovery

## Scope

This document covers **full-database** disaster recovery: `orders`, `payments`,
`inventory`, `suppliers`, `shipments`, `caja_sessions`, `profiles`, `audit_logs`,
and every other table in this project's schema — everything needed to restore
the store's operational data after data loss.

This is explicitly **not** the same thing as the existing `BackupSettingsTab`
(`src/widgets/SettingsTabsPanel/tabs/BackupSettingsTab.tsx`) feature, backed by
the `settings-backup` edge function
(`supabase/functions/settings-backup/index.ts`). That feature snapshots only
five configuration-ish tables — `settings`, `categories`, `products`,
`modifiers`, `product_modifiers` — via the Settings UI. It is useful for
recovering catalog/config state, but it is **not a substitute** for the
full-database DR plan described here: it never touches `orders`, `payments`,
`inventory`, `suppliers`, `shipments`, `caja_sessions`, `profiles`, or
`audit_logs`.

## Production hosting: undecided

Whether this project ships on a self-hosted Docker Supabase stack or on
Supabase Cloud has not been decided yet. `supabase/config.toml` states (D-06):

> D-06 (REVISED): self-hosted Supabase stack on localhost:8000, not a linked
> Supabase Cloud project — there is no cloud project_id to `supabase link`
> against. This value is purely a local identifier; `supabase db push` targets
> the self-hosted stack directly via `--db-url`. The prior value
> ("shsrhxleopmovzpzqmex") was the live production bar project and must never
> be restored here.

That comment describes the local CLI dev stack (API on `localhost:8000`,
Postgres on `54322` per `[db] port = 54322` in the same file) — it is not a
statement about where production will actually run. Because that decision is
still open, this document covers both paths rather than assuming one.

## Self-hosted

If the store ends up running a self-hosted Docker Supabase stack, there is no
managed point-in-time-recovery (PITR) available today — self-hosted Supabase
does not provide it out of the box. The recommended mechanism is a `pg_dump`
snapshot via `scripts/backup-db.sh`, which:

- reads the target Postgres connection string from the `DATABASE_URL`
  environment variable (never hardcoded, never committed),
- guards on `pg_dump` being installed,
- writes a timestamped `--format=custom` dump to `backups/`.

Run it as: `DATABASE_URL=<connection-string> ./scripts/backup-db.sh`

Scheduling this script (cron, systemd timer, or equivalent) is a deploy-time
decision that has not been made yet and is out of scope for this document —
the script is ready to be wired into whichever scheduling mechanism the
eventual self-hosted deployment uses.

## Supabase Cloud

If Supabase Cloud is chosen instead, PITR coverage depends on the project's
paid tier. `[ASSUMED — verify against Supabase's current pricing page before
relying on it]`: at the time this document was written, PITR was generally a
paid-tier feature with retention length varying by plan. No specific tier name
or day-count is asserted here as fact — confirm the actual tier and retention
window against Supabase's current pricing/docs before depending on it for
disaster recovery.

## Restore

`pg_restore` is the counterpart to `scripts/backup-db.sh`'s
`--format=custom` dumps: `pg_restore --dbname="$DATABASE_URL" backups/backup-<timestamp>.dump`.

Always test a restore against a non-production instance first — never restore
directly onto a live database.
