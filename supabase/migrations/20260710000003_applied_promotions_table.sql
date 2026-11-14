-- =============================================================================
-- Phase 20 Plan 03: applied_promotions — immutable per-application audit table
--
-- One row per applied promotion instance (an order_item or pool_session may
-- accumulate multiple rows when several promotions stack — D-03 sequential
-- compounding). Written exclusively by the SECURITY DEFINER
-- evaluate_promotions_for_item() function (Task 2 of this plan) and, in a
-- later plan, the pool_billing/pool_grant paths (Plan 20-05). No client can
-- write this table (append-only by omission — mirrors
-- tip_distribution_entries, 20260709000001_tip_distribution_entries_table.sql).
--
-- promotion_id is ON DELETE SET NULL (not RESTRICT/CASCADE) so the audit
-- trail survives a hard-deleted promotion — promotion_name_snapshot plus the
-- captured discount_type/discount_value preserve what actually happened at
-- application time (RESEARCH Open Question 4, resolved).
--
-- pool_session_id / pool_minutes_granted / consumed_at are present now but
-- only written by Plan 20-05's pool_grant path — this plan (item/category
-- only) never populates them.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applied_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid REFERENCES promotions(id) ON DELETE SET NULL,
  promotion_name_snapshot text NOT NULL,
  target_type text NOT NULL,
  discount_type text,
  discount_value numeric,
  tab_id uuid REFERENCES tabs(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id) ON DELETE CASCADE,
  pool_session_id uuid REFERENCES pool_sessions(id) ON DELETE CASCADE,
  original_amount numeric,
  discounted_amount numeric,
  pool_minutes_granted integer,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_applied_promotions_order_item
  ON applied_promotions(order_item_id);

CREATE INDEX IF NOT EXISTS idx_applied_promotions_tab
  ON applied_promotions(tab_id);

CREATE INDEX IF NOT EXISTS idx_applied_promotions_pool_session
  ON applied_promotions(pool_session_id);

-- Plan 20-05's grant-consumption lookup: find an unconsumed pool-minute grant
-- for a given tab.
CREATE INDEX IF NOT EXISTS idx_applied_promotions_unconsumed_grant
  ON applied_promotions(tab_id)
  WHERE consumed_at IS NULL AND pool_minutes_granted IS NOT NULL;

-- -----------------------------------------------------------------------
-- 3. RLS — append-only
-- -----------------------------------------------------------------------
ALTER TABLE applied_promotions ENABLE ROW LEVEL SECURITY;

-- SELECT: manager+ only
CREATE POLICY applied_promotions_select_manager
  ON applied_promotions FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- INSERT/UPDATE/DELETE: nobody.
-- (no policies = no access; append-only by omission — the SECURITY DEFINER
--  evaluate_promotions_for_item / pool RPCs are the sole writers and bypass
--  RLS entirely.)

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS applied_promotions;
-- COMMIT;
-- =============================================================================
