-- =============================================================================
-- Phase 23 Plan 02 — payments.status column
--
-- Models the reopen-void state (D-01): a payment row that WAS a completed
-- charge but has since been voided by reopen_tab (Phase 23, next migration)
-- flips to 'reopened_void' instead of being deleted/mutated in place. This is
-- the first status column on `payments` — previously the only "does this row
-- still count" signal was `is_refund`, which is orthogonal (a reopen-voided
-- row is explicitly NOT a refund per D-05).
--
-- Kept deliberately minimal per Claude's Discretion (CONTEXT.md): only the two
-- values this phase actually needs, not a speculative broader enum.
--
-- A companion migration (20260720000005, Plan 03) patches every existing
-- payment-summing site (process_payment_atomic, process_split_payment_atomic,
-- get_caja_report, close_caja_session, process_refund) to exclude
-- 'reopened_void' rows from their totals — this column alone does not change
-- any existing query's behavior.
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
  CHECK (status IN ('completed', 'reopened_void'));

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- BEGIN;
-- ALTER TABLE payments DROP COLUMN IF EXISTS status;
-- COMMIT;
-- =============================================================================
