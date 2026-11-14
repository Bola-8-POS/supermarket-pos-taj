-- Add is_temp column and the 'floating' table_type value to resources (D-01/D-04).
-- The column uses a text CHECK constraint (matching this project's established
-- migration style for post-launch schema growth, see
-- 20260421000002_pool_tables_type_column.sql) rather than a new Postgres enum,
-- so no enum migration is needed. Default FALSE preserves every existing row
-- as non-floating with no backfill required.
--
-- The pre-existing table_type CHECK was declared inline at table-creation time
-- (ADD COLUMN ... CHECK (...)), so Postgres auto-named it. Live-catalog check
-- (pg_constraint against the renamed `resources` relation, run before writing
-- this migration) confirms the generated name survived Plan 01's table rename
-- unchanged: `pool_tables_table_type_check`. Do not guess this name blind.

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS is_temp BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS pool_tables_table_type_check;
ALTER TABLE resources ADD CONSTRAINT resources_table_type_check
  CHECK (table_type IN ('pool', 'carom', 'consumption', 'floating'));
