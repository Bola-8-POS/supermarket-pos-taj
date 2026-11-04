-- Add table_type column to pool_tables to support pool, carom, and consumption tables.
-- The column uses a text CHECK constraint (matching the project's migration style for
-- post-enum additions) rather than a new Postgres enum, so no enum migration is needed.
-- Default 'pool' preserves existing rows unchanged.

ALTER TABLE pool_tables
  ADD COLUMN IF NOT EXISTS table_type TEXT NOT NULL DEFAULT 'pool'
    CHECK (table_type IN ('pool', 'carom', 'consumption'));

-- Update RLS: the existing policies already allow reads/writes for the row owner roles;
-- no new RLS policy needed — this column inherits the table's existing policies.

-- Allow the seeded dev pool tables to have their type updated via anon/service_role:
-- (The queries.ts file already sends table_type on INSERT and UPDATE using `supabase as any`
-- until supabase.types.ts is regenerated; this migration makes the column live in the DB.)
