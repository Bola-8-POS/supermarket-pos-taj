-- =============================================================================
-- Phase 27 (27-02): open_units table
--
-- Tracks an opened package/box's remaining loose-piece count (D-01/D-02/D-07,
-- locked schema shape per 27-01-SUMMARY.md). open_units.product_id references
-- the BOX (parent/packaged) product, NOT the loose product sold to customers —
-- the loose product links to its box via products.parent_product_id, added in
-- the next migration.
--
-- remaining_count counts loose PIECES and is distinct from inventory.
-- quantity_on_hand, which tracks package-level (unopened box) stock. Do not
-- conflate the two — see 27-RESEARCH.md Pitfall 2.
--
-- D-07's "at most one active open unit per product" invariant is enforced by
-- a partial unique index (open_units_one_active_per_product), not an
-- application-level look-then-insert — race-proof by construction, exact
-- pattern already used for caja_sessions_one_open
-- (20260420000002_caja_sessions.sql).
--
-- RLS mirrors modifier_inventory_rules (20260706000002): all authenticated
-- reads, manager+/admin direct writes. Bartender-initiated opens (D-11) still
-- work because the lifecycle RPCs are SECURITY DEFINER and bypass RLS — the
-- same arrangement stock_movements + record_stock_movement already ships.
-- =============================================================================

-- UP:
BEGIN;

CREATE TABLE IF NOT EXISTS open_units (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id),  -- the BOX (parent) product
  remaining_count int NOT NULL CHECK (remaining_count >= 0),
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'exhausted', 'void')),
  opened_by      uuid REFERENCES profiles(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_by      uuid REFERENCES profiles(id),
  closed_at      timestamptz,
  closed_reason  text,  -- e.g. 'exhausted' | 'voided' | 'corrected_to_zero'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- D-07: strictly one active open unit per product at a time.
CREATE UNIQUE INDEX IF NOT EXISTS open_units_one_active_per_product
  ON open_units (product_id)
  WHERE status = 'active';

-- Admin Open-Units tab's "show currently active/exhausted rows" query (SC-3).
CREATE INDEX IF NOT EXISTS idx_open_units_status
  ON open_units (status);

ALTER TABLE open_units ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open_units_select_authenticated"
  ON open_units FOR SELECT TO authenticated USING (true);

CREATE POLICY "open_units_write_manager_admin"
  ON open_units FOR ALL TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS open_units CASCADE;
-- COMMIT;
-- =============================================================================
