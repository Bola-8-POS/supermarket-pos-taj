-- =============================================================================
-- Phase 20 (promotions-engine), Plan 01: promotions + promotion_availability
-- tables, CHECK constraints, per-verb role_permissions RLS, FK indexes.
--
-- Cloned from combo_slots/combo_availability (20260425000001_combo_schema.sql)
-- for table shape, but using the CURRENT per-verb role_permissions RLS
-- pattern from 20260510000001_rls_rewrite_phase13.sql (NOT the deprecated
-- combo-era auth.jwt() style).
-- =============================================================================

-- UP: promotions, promotion_availability tables + RLS
BEGIN;

CREATE TABLE IF NOT EXISTS promotions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  discount_type       text NOT NULL CHECK (discount_type IN ('percentage','fixed_amount','fixed_price')),
  discount_value      numeric NOT NULL CHECK (discount_value >= 0),
  target_type         text NOT NULL CHECK (target_type IN ('item','category','pool_billing','pool_grant')),
  target_product_id   uuid REFERENCES products(id) ON DELETE CASCADE,
  target_category_id  uuid REFERENCES categories(id) ON DELETE CASCADE,
  priority            integer NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_percentage_bound_check CHECK (discount_type <> 'percentage' OR discount_value <= 100),
  CONSTRAINT promotions_item_target_check CHECK (target_type <> 'item' OR target_product_id IS NOT NULL),
  CONSTRAINT promotions_category_target_check CHECK (target_type <> 'category' OR target_category_id IS NOT NULL)
);

CREATE INDEX idx_promotions_target_product ON promotions(target_product_id);
CREATE INDEX idx_promotions_target_category ON promotions(target_category_id);
CREATE INDEX idx_promotions_active ON promotions(is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS promotion_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id  uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  days_of_week  integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',  -- ISO 1=Mon, 7=Sun
  start_time    time,    -- null = all day
  end_time      time,    -- null = all day
  start_date    date,    -- null = no date restriction
  end_date      date,    -- null = no date restriction
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_promotion_availability_promotion ON promotion_availability(promotion_id);

-- RLS: all authenticated can SELECT; manager+admin (manage_products) can
-- INSERT/UPDATE/DELETE. Separate per-verb policies (NEVER a combined FOR ALL).
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "promotions_select_authenticated" ON promotions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "promotions_insert_manager_admin" ON promotions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "promotions_update_manager_admin" ON promotions
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "promotions_delete_manager_admin" ON promotions
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "promotion_availability_select_authenticated" ON promotion_availability
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "promotion_availability_insert_manager_admin" ON promotion_availability
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "promotion_availability_update_manager_admin" ON promotion_availability
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "promotion_availability_delete_manager_admin" ON promotion_availability
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS promotion_availability;
-- DROP TABLE IF EXISTS promotions;
-- COMMIT;
-- =============================================================================
