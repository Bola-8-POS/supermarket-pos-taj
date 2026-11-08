-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 10 Task 2: [BLOCKING] destructive drop of the
-- promotions/happy-hour discount engine (percentage/fixed-amount/fixed-price
-- discounts targeting items, categories, or pool billing/grants) — out of
-- scope per REQUIREMENTS.md's "Loyalty/rewards program, coupon/promotion
-- engine" exclusion.
--
-- Paired follow-up to Plan 10 Task 1, which deleted every src/ file that
-- read/wrote these tables (the promotion entity, manage-promotions feature,
-- HappyHourBanner, and its ProductGrid.tsx consumer). Nothing in the
-- codebase references promotions/applied_promotions/promotion_availability
-- after this migration lands.
--
-- Live-DB introspection performed before authoring this migration (per the
-- phase's documented pool_tables->resources fragility precedent, and
-- matching Plan 06's payment-RPC finding):
--   - Only 3 functions reference "promotion" in pg_proc: create_order_with_items,
--     evaluate_promotions_for_item, is_promotion_available. evaluate_promotions_pool_grant
--     (mentioned in 01-06-SUMMARY.md's cross-plan note) was already confirmed
--     absent at that plan's push time — no action needed here.
--   - CRITICAL: public.create_order_with_items (the KEPT, generic,
--     payment-critical order-creation RPC — same function every add-item-to-tab
--     call goes through) unconditionally PERFORMs evaluate_promotions_for_item()
--     for every inserted order item. A plain `DROP FUNCTION ... CASCADE` on
--     evaluate_promotions_for_item does NOT cascade into this call site
--     (plpgsql function bodies are opaque text — Postgres does not track
--     call-graph dependencies the way it tracks view/column dependencies), so
--     it must be redefined via CREATE OR REPLACE, dropping ONLY the
--     promotion-evaluation loop, BEFORE the DROP FUNCTION statements below.
--     Without this fix, every real order-add on the new project would fail
--     at runtime with "function evaluate_promotions_for_item(uuid) does not
--     exist" the moment this migration's DROP FUNCTION lines ran — exactly
--     the class of break 01-06-SUMMARY.md documented for
--     process_payment_atomic/process_split_payment_atomic.
--   - Only 2 FKs reference these tables: promotion_availability.promotion_id
--     and applied_promotions.promotion_id (both -> promotions). No FK from
--     any other table's kept schema. applied_promotions.pool_session_id has
--     no live FK constraint — it was already dropped as a dangling-constraint
--     side effect of Plan 06's `DROP TABLE pool_sessions CASCADE`.
--   - promotion_availability is a real table (not named in this plan's
--     files_modified / must_haves, RESEARCH.md's SQL table missed it as a
--     separately-named target) — dropped explicitly below, matching this
--     repo's stated preference for explicitness over relying on CASCADE
--     alone (same pattern as 01-06's resource_transfers finding).
--   - Neither promotions, applied_promotions, nor promotion_availability is
--     a member of the supabase_realtime publication (0 rows from
--     pg_publication_tables) — no ALTER PUBLICATION needed.
--   - No triggers on any of the 3 tables.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Redefine create_order_with_items to drop the promotion-evaluation
--    loop BEFORE the functions it calls are dropped. Byte-for-byte
--    identical to the live body otherwise (pulled via pg_get_functiondef
--    immediately before authoring this migration).
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order_with_items(
  p_tab_id uuid,
  p_staff_id uuid,
  p_status order_status,
  p_notes text,
  p_items jsonb,
  p_skip_depletion boolean DEFAULT false,
  p_expected_version int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_items jsonb;
  v_inserted_item record;
  v_current int;
BEGIN
  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  SELECT version INTO v_current FROM tabs WHERE id = p_tab_id FOR UPDATE;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;
  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  INSERT INTO orders (tab_id, staff_id, status, notes)
  VALUES (p_tab_id, p_staff_id, p_status, p_notes)
  RETURNING * INTO v_order;

  INSERT INTO order_items (
    order_id,
    product_id,
    quantity,
    unit_price,
    modifier_ids,
    modifier_price_delta,
    notes
  )
  SELECT
    v_order.id,
    (elem->>'product_id')::uuid,
    COALESCE((elem->>'quantity')::int, 1),
    (elem->>'unit_price')::numeric,
    COALESCE(
      (
        SELECT array_agg(value::uuid)
        FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)
      ),
      ARRAY[]::uuid[]
    ),
    COALESCE((elem->>'modifier_price_delta')::numeric, 0),
    NULLIF(elem->>'notes', '')
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem;

  -- Phase 4: Deplete ingredients for each order item (same transaction).
  -- Skip when p_skip_depletion=true (manager override path — depletion called separately).
  IF NOT p_skip_depletion THEN
    FOR v_inserted_item IN
      SELECT id FROM order_items WHERE order_id = v_order.id
    LOOP
      PERFORM deplete_for_order_item(v_inserted_item.id, 1::smallint);
    END LOOP;
  END IF;

  -- Phase 1 Plan 10: promotion evaluation loop removed — the promotions
  -- engine (evaluate_promotions_for_item) is dropped by this migration.
  -- order_items.unit_price is once again exactly the client-supplied
  -- p_items[].unit_price with no server-side pricing rewrite step.

  -- Phase 15: bump tabs.version after successful insert. The
  -- bump_version_on_update trigger enforces exact +1 advancement.
  UPDATE tabs SET version = version + 1, updated_at = NOW() WHERE id = p_tab_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
  INTO v_items
  FROM order_items oi
  WHERE oi.order_id = v_order.id;

  RETURN jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean, int) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. Drop promotion evaluation/availability functions.
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.evaluate_promotions_for_item(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_promotion_available(uuid, timestamptz) CASCADE;

-- -----------------------------------------------------------------------
-- 3. Drop promotion tables, FK-dependency order (children before parent).
-- -----------------------------------------------------------------------
DROP TABLE IF EXISTS public.applied_promotions CASCADE;
DROP TABLE IF EXISTS public.promotion_availability CASCADE;
DROP TABLE IF EXISTS public.promotions CASCADE;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN:
-- BEGIN;
--
-- CREATE TABLE public.promotions (
--   id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   name                text NOT NULL,
--   discount_type       text NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount', 'fixed_price')),
--   discount_value      numeric NOT NULL CHECK (discount_value >= 0),
--   target_type         text NOT NULL CHECK (target_type IN ('item', 'category', 'pool_billing', 'pool_grant')),
--   target_product_id   uuid NULL REFERENCES public.products(id) ON DELETE CASCADE,
--   target_category_id  uuid NULL REFERENCES public.categories(id) ON DELETE CASCADE,
--   priority             integer NOT NULL DEFAULT 0,
--   is_active            boolean NOT NULL DEFAULT true,
--   created_at           timestamptz NOT NULL DEFAULT now(),
--   CONSTRAINT promotions_item_target_check CHECK (target_type <> 'item' OR target_product_id IS NOT NULL),
--   CONSTRAINT promotions_category_target_check CHECK (target_type <> 'category' OR target_category_id IS NOT NULL),
--   CONSTRAINT promotions_percentage_bound_check CHECK (discount_type <> 'percentage' OR discount_value <= 100)
-- );
--
-- ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
--
-- CREATE TABLE public.promotion_availability (
--   id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   promotion_id  uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
--   days_of_week  integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
--   start_time    time NULL,
--   end_time      time NULL,
--   start_date    date NULL,
--   end_date      date NULL,
--   created_at    timestamptz NOT NULL DEFAULT now()
-- );
--
-- ALTER TABLE public.promotion_availability ENABLE ROW LEVEL SECURITY;
--
-- CREATE TABLE public.applied_promotions (
--   id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   promotion_id              uuid NULL REFERENCES public.promotions(id) ON DELETE SET NULL,
--   promotion_name_snapshot   text NOT NULL,
--   target_type               text NOT NULL,
--   discount_type              text NULL,
--   discount_value              numeric NULL,
--   tab_id                      uuid NULL REFERENCES public.tabs(id) ON DELETE CASCADE,
--   order_item_id               uuid NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
--   pool_session_id              uuid NULL,
--   original_amount               numeric NULL,
--   discounted_amount             numeric NULL,
--   pool_minutes_granted           integer NULL,
--   consumed_at                     timestamptz NULL,
--   created_at                       timestamptz NOT NULL DEFAULT now()
-- );
--
-- ALTER TABLE public.applied_promotions ENABLE ROW LEVEL SECURITY;
--
-- -- No data restoration — table shape only, matching repo convention.
-- -- RLS policies, indexes, evaluate_promotions_for_item/is_promotion_available
-- -- function bodies, and the create_order_with_items promotion-evaluation
-- -- loop are not restored — shape only.
--
-- COMMIT;
-- =============================================================================
