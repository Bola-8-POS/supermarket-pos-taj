-- =============================================================================
-- Phase 27 Plan 01: Promotions & Discount Management — backend spine.
--
-- New `promotions` table (product- or category-scoped, percent/fixed,
-- active date range), RLS (admin-only manage, everyone-read), audit-trigger
-- coverage on every CRUD op, and the order_items per-line discount snapshot
-- columns process_direct_sale_atomic writes to (Plan 01 Task 2/Migration 2).
--
-- ON DELETE CASCADE on promotions.product_id/category_id is deliberate: a
-- promotion whose scope target is deleted becomes meaningless, so the row
-- goes with it rather than dangling (resolves UI-SPEC's "deleted scope
-- target" open question structurally).
--
-- ON DELETE SET NULL on order_items.promotion_id is equally deliberate the
-- other way: a promotion being deleted later must never disturb a historical
-- sale's numeric discount snapshot (PROMO-06) — RESTRICT/CASCADE would be
-- wrong here.
--
-- role_permissions seeding: 'manage_promotions' is admin-only (mirrors
-- manage_settings' seeding — no manager/cashier row); 'apply_custom_discount'
-- is manager+ (mirrors process_refund's tier) and is reused by both the
-- ad-hoc whole-sale discount path and the below-cost floor-guard override
-- (Migration 2 / PROMO-05/PROMO-07, D-07).
-- =============================================================================

-- UP:
BEGIN;

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  scope_type text NOT NULL CHECK (scope_type IN ('product', 'category')),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value numeric(10,2) NOT NULL CHECK (
    discount_value > 0 AND (discount_type <> 'percent' OR discount_value <= 100)
  ),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Exactly one of product_id/category_id is set — a promotion targets
  -- either a single product or a single category, never both, never neither.
  CONSTRAINT promotions_exactly_one_target CHECK (
    (product_id IS NOT NULL) <> (category_id IS NOT NULL)
  )
);

CREATE INDEX idx_promotions_product_active ON promotions (product_id) WHERE active = true;
CREATE INDEX idx_promotions_category_active ON promotions (category_id) WHERE active = true;

CREATE TRIGGER update_promotions_updated_at BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY promotions_select_authenticated ON promotions FOR SELECT TO authenticated USING (true);
CREATE POLICY promotions_manage ON promotions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'))
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'));

INSERT INTO role_permissions (role, action) VALUES
  ('admin', 'manage_promotions'),
  ('manager', 'apply_custom_discount'),
  ('admin', 'apply_custom_discount');

-- Audit trigger: keeps promotion CRUD as plain RLS-gated table writes (no
-- RPC layer needed, RESEARCH.md Pitfall 3) while still getting full audit
-- coverage on every write path via the existing record_audit() function.
CREATE OR REPLACE FUNCTION promotions_record_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM record_audit(
    CASE TG_OP
      WHEN 'INSERT' THEN 'promotion.create'
      WHEN 'UPDATE' THEN 'promotion.update'
      ELSE 'promotion.deactivate'
    END,
    'promotion',
    COALESCE(NEW.id, OLD.id),
    to_jsonb(OLD),
    to_jsonb(NEW),
    'trigger'
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER promotions_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON promotions
  FOR EACH ROW EXECUTE FUNCTION promotions_record_audit();

-- order_items per-line discount snapshot (PROMO-06) — mirrors the existing
-- cost_price_snapshot column pattern (20260818000002_order_items_cost_price_snapshot.sql).
ALTER TABLE order_items
  ADD COLUMN promotion_id uuid REFERENCES promotions(id) ON DELETE SET NULL,
  ADD COLUMN discount_rate numeric,
  ADD COLUMN discount_amount numeric(10,2);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE order_items DROP COLUMN IF EXISTS discount_amount;
-- ALTER TABLE order_items DROP COLUMN IF EXISTS discount_rate;
-- ALTER TABLE order_items DROP COLUMN IF EXISTS promotion_id;
-- DROP TRIGGER IF EXISTS promotions_audit_trigger ON promotions;
-- DROP FUNCTION IF EXISTS promotions_record_audit();
-- DELETE FROM role_permissions WHERE action IN ('manage_promotions', 'apply_custom_discount');
-- DROP TABLE IF EXISTS promotions CASCADE;
-- COMMIT;
-- =============================================================================
