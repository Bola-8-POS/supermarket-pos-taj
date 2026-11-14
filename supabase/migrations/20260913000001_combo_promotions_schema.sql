-- Combos as a promotion kind (Part A of the combos-and-terminal-caja design,
-- docs/superpowers/specs/2026-09-12-combos-and-terminal-caja-design.md, A.3).
--
-- Adds promotions.kind ('discount' | 'combo'), extends discount_type with two
-- combo-only pricing modes (bundle_price, cheapest_free), a new
-- promotion_combo_slots table (ordered "N units from this set" composition),
-- promotion_targets.slot_id (links a target to a specific slot for combo
-- rows; NULL for plain discount rows), and categories.combo_eligible
-- (products.combo_eligible already exists, dormant since Phase 1 — not
-- re-added here).
--
-- This migration is schema-only: process_direct_sale_atomic's combo-matching
-- pass (spec A.6) and the client (A.4/A.5) are later tasks in this plan.
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. promotions.kind
-- -----------------------------------------------------------------------------

ALTER TABLE promotions ADD COLUMN kind text NOT NULL DEFAULT 'discount'
  CHECK (kind IN ('discount', 'combo'));

-- -----------------------------------------------------------------------------
-- 2. Extend discount_type to allow the two combo-only pricing modes.
--    The existing inline CHECK (discount_type IN ('percent','fixed')) has an
--    auto-generated name that can drift across environments seeded at
--    different times, so it is looked up by definition (the pure
--    discount_type membership check, not promotions_check — the
--    discount_value/percent-cap CHECK that also mentions discount_type and
--    must be left alone) rather than assumed by name.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'promotions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%discount_type%'
    AND pg_get_constraintdef(oid) NOT ILIKE '%discount_value%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE promotions DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE promotions ADD CONSTRAINT promotions_discount_type_check
  CHECK (discount_type IN ('percent', 'fixed', 'bundle_price', 'cheapest_free'));

-- A discount-kind promotion may only use the two original pricing modes; the
-- two combo-only modes require kind='combo'.
ALTER TABLE promotions ADD CONSTRAINT promotions_kind_type_consistent
  CHECK (kind = 'combo' OR discount_type IN ('percent', 'fixed'));

-- cheapest_free's discount_value is "N cheapest units free" — must be a
-- positive integer (existing promotions_check already enforces > 0).
ALTER TABLE promotions ADD CONSTRAINT promotions_cheapest_free_integer
  CHECK (discount_type <> 'cheapest_free' OR discount_value = floor(discount_value));
ALTER TABLE promotions ADD CONSTRAINT promotions_cheapest_free_min
  CHECK (discount_type <> 'cheapest_free' OR discount_value >= 1);

-- -----------------------------------------------------------------------------
-- 3. promotion_combo_slots — ordered composition ("N units from this set")
--    for a combo-kind promotion. RLS mirrors promotion_targets verbatim
--    (20260904000001_promotion_targets_recurrence.sql:58-61), renamed.
-- -----------------------------------------------------------------------------

CREATE TABLE promotion_combo_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  label text CHECK (label IS NULL OR char_length(label) <= 60),
  UNIQUE (promotion_id, position)
);

ALTER TABLE promotion_combo_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY promotion_combo_slots_select_authenticated ON promotion_combo_slots
  FOR SELECT TO authenticated USING (true);
CREATE POLICY promotion_combo_slots_manage ON promotion_combo_slots FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'))
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'));

-- -----------------------------------------------------------------------------
-- 4. promotion_targets.slot_id — links a target row to the slot it belongs
--    to for a combo-kind promotion; stays NULL for a plain discount-kind
--    promotion's targets. The existing partial-unique indexes on
--    (promotion_id, product_id|category_id) are untouched, so a product or
--    category can still appear in only one slot of a given combo.
-- -----------------------------------------------------------------------------

ALTER TABLE promotion_targets ADD COLUMN slot_id uuid
  REFERENCES promotion_combo_slots(id) ON DELETE CASCADE;
CREATE INDEX idx_promotion_targets_slot ON promotion_targets(slot_id);

-- -----------------------------------------------------------------------------
-- 5. categories.combo_eligible — products.combo_eligible already exists
--    (dormant since the Phase-1 combo drop); this is the category-level
--    counterpart. Effective eligibility = product flag AND every ancestor
--    category's flag (enforced app-side, spec A.2).
-- -----------------------------------------------------------------------------

ALTER TABLE categories ADD COLUMN combo_eligible boolean NOT NULL DEFAULT true;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE categories DROP COLUMN IF EXISTS combo_eligible;
-- DROP INDEX IF EXISTS idx_promotion_targets_slot;
-- ALTER TABLE promotion_targets DROP COLUMN IF EXISTS slot_id;
-- DROP TABLE IF EXISTS promotion_combo_slots CASCADE;
-- ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_cheapest_free_min;
-- ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_cheapest_free_integer;
-- ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_kind_type_consistent;
-- ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_discount_type_check;
-- ALTER TABLE promotions ADD CONSTRAINT promotions_discount_type_check CHECK (discount_type IN ('percent','fixed'));
-- ALTER TABLE promotions DROP COLUMN IF EXISTS kind;
-- COMMIT;
-- =============================================================================
