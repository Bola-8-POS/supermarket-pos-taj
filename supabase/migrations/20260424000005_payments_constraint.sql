-- =============================================================================
-- S1-05: Allow multiple payments per tab
-- Drops the UNIQUE constraint on payments.tab_id so a tab can have
-- multiple payment records (split payments, partial payments, refunds).
-- =============================================================================

BEGIN;

-- Drop the inline UNIQUE constraint created by "tab_id UUID NOT NULL UNIQUE"
-- in migration 20260414000006. PostgreSQL names this payments_tab_id_key.
-- The non-unique index idx_payments_tab_id (line 22 of that migration) remains.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_tab_id_key;

-- Ensure a non-unique index exists for efficient tab_id lookups
-- (idx_payments_tab_id already exists from 20260414000006 line 22 — this is a no-op).
CREATE INDEX IF NOT EXISTS idx_payments_tab_id ON payments(tab_id);

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_payments_tab_id;
-- ALTER TABLE payments ADD CONSTRAINT payments_tab_id_key UNIQUE (tab_id);
-- COMMIT;
-- =============================================================================
