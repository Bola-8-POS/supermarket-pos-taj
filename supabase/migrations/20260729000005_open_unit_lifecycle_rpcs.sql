-- =============================================================================
-- Phase 27 (27-04): open_open_unit / correct_open_unit / void_open_unit
--
-- The three manual lifecycle RPCs the admin Open-Units tab drives. Unlike
-- consume_open_unit (27-02), which only auto-opens units as a side effect of
-- a sale, these are the client-callable write API for SC-3 ("staff can
-- manually open a new one") and D-10 ("correct the count / void a unit
-- early").
--
-- RBAC split (the security-relevant part of this migration):
--   - open_open_unit is bartender+ (D-11) — a high-frequency, low-risk action
--     at a busy bar, same guard shape as deplete_for_order_item.
--   - correct_open_unit / void_open_unit are manager+ (D-12) — both are stock
--     write-off vectors, same guard shape as process_refund. The client-side
--     ManagerPinDialog is UX only; the get_user_role() guard inside each
--     function body is the actual control (T-27-09).
--
-- open_open_unit deliberately takes no negative-stock-bypass parameter of any
-- kind: D-05 scopes that single override mechanism to the order-entry path,
-- where a manager PIN gate already exists, and a bypass here would be a
-- second override mechanism D-05 explicitly rejects (T-27-12).
--
-- All three go through record_audit()/audit_logs, never the legacy singular
-- audit_log table (27-RESEARCH.md Pitfall 1).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- open_open_unit — bartender+ (D-11)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_open_unit(p_product_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_per_package int;
  v_qty_on_hand int;
  v_unit_id     uuid;
  v_existing    record;
  v_after       jsonb;
BEGIN
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: bartender or higher required to open a unit';
  END IF;

  SELECT units_per_package INTO v_per_package
  FROM   products
  WHERE  id = p_product_id;

  IF v_per_package IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: product % is not configured for open units', p_product_id;
  END IF;

  -- Lock the BOX product's inventory row before deciding whether a package
  -- is available. No bypass parameter exists here (see header note) — the
  -- manager-PIN-gated override lives on the order-entry path only.
  SELECT quantity_on_hand INTO v_qty_on_hand
  FROM   inventory
  WHERE  product_id = p_product_id
  FOR UPDATE;

  IF NOT FOUND OR v_qty_on_hand < 1 THEN
    RAISE EXCEPTION 'INVENTORY_NEGATIVE: no unopened package available for product %', p_product_id;
  END IF;

  -- Insert-then-catch (not look-then-insert): the partial unique index
  -- open_units_one_active_per_product decides, so two bartenders tapping
  -- simultaneously is race-proof by construction (D-07). The loser gets the
  -- friendly D-08 message with the live remaining count, not a silent
  -- auto-close of the existing unit.
  BEGIN
    INSERT INTO open_units (product_id, remaining_count, status, opened_by)
    VALUES (p_product_id, v_per_package, 'active', auth.uid())
    RETURNING id INTO v_unit_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM   open_units
    WHERE  product_id = p_product_id AND status = 'active';

    RAISE EXCEPTION 'DUPLICATE_ENTRY: an open unit already exists for this product (% remaining) — sell through it first', v_existing.remaining_count;
  END;

  -- Package decrement happens only after the insert succeeds — a rejected
  -- open must never consume a package (T-27-03).
  UPDATE inventory
  SET    quantity_on_hand = quantity_on_hand - 1,
         updated_at       = now()
  WHERE  product_id = p_product_id;

  SELECT to_jsonb(u) INTO v_after FROM open_units u WHERE u.id = v_unit_id;
  PERFORM record_audit('open_unit.open', 'open_unit', v_unit_id, NULL, v_after, 'rpc');

  RETURN v_unit_id;
END;
$$;

GRANT EXECUTE ON FUNCTION open_open_unit(uuid) TO authenticated;

-- -----------------------------------------------------------------------
-- correct_open_unit — manager+ (D-12)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION correct_open_unit(
  p_open_unit_id    uuid,
  p_remaining_count int,
  p_reason          text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit        record;
  v_per_package int;
  v_before      jsonb;
  v_after       jsonb;
BEGIN
  -- The client-side ManagerPinDialog is UX; this guard is the actual
  -- control (T-27-09) — a bartender calling this RPC directly must be
  -- rejected here, independent of any UI.
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- A correction with no reason is exactly the unaudited-shrinkage hole
  -- T-27-10 covers.
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reason is required';
  END IF;

  SELECT * INTO v_unit
  FROM   open_units
  WHERE  id = p_open_unit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: open unit % does not exist', p_open_unit_id;
  END IF;

  -- Correcting a closed unit would silently reopen stock.
  IF v_unit.status <> 'active' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: open unit % is not active', p_open_unit_id;
  END IF;

  SELECT units_per_package INTO v_per_package
  FROM   products
  WHERE  id = v_unit.product_id;

  IF p_remaining_count < 0 OR p_remaining_count > v_per_package THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: remaining count % is out of range 0..%', p_remaining_count, v_per_package;
  END IF;

  v_before := to_jsonb(v_unit);

  UPDATE open_units
  SET    remaining_count = p_remaining_count,
         updated_at      = now(),
         -- Freeing the partial unique index when corrected down to zero lets
         -- a fresh unit be opened for this product.
         status          = CASE WHEN p_remaining_count = 0 THEN 'exhausted' ELSE status END,
         closed_at       = CASE WHEN p_remaining_count = 0 THEN now() ELSE closed_at END,
         closed_by       = CASE WHEN p_remaining_count = 0 THEN auth.uid() ELSE closed_by END,
         closed_reason   = CASE WHEN p_remaining_count = 0 THEN 'corrected_to_zero' ELSE closed_reason END
  WHERE  id = p_open_unit_id;

  SELECT to_jsonb(u) INTO v_after FROM open_units u WHERE u.id = p_open_unit_id;

  -- Both the old and new counts must be recoverable from the audit row,
  -- which is why the before/after sandwich is mandatory here rather than
  -- optional. The supplied reason is merged into the after payload so it is
  -- recoverable even when the correction doesn't zero the unit out (in
  -- which case closed_reason on the row itself stays null).
  PERFORM record_audit(
    'open_unit.correct',
    'open_unit',
    p_open_unit_id,
    v_before,
    v_after || jsonb_build_object('reason', p_reason),
    'rpc'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION correct_open_unit(uuid, int, text) TO authenticated;

-- -----------------------------------------------------------------------
-- void_open_unit — manager+ (D-12)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION void_open_unit(
  p_open_unit_id uuid,
  p_reason       text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit   record;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reason is required';
  END IF;

  SELECT * INTO v_unit
  FROM   open_units
  WHERE  id = p_open_unit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: open unit % does not exist', p_open_unit_id;
  END IF;

  IF v_unit.status <> 'active' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: open unit % is not active', p_open_unit_id;
  END IF;

  v_before := to_jsonb(v_unit);

  -- D-10 frames voiding as abandoning a physically opened box (damage,
  -- miscount) — the package is already gone, so inventory is NOT credited
  -- back (T-27-11: doing so would fabricate stock).
  UPDATE open_units
  SET    status        = 'void',
         remaining_count = 0,
         closed_at     = now(),
         closed_by     = auth.uid(),
         closed_reason = p_reason,
         updated_at    = now()
  WHERE  id = p_open_unit_id;

  SELECT to_jsonb(u) INTO v_after FROM open_units u WHERE u.id = p_open_unit_id;

  PERFORM record_audit('open_unit.void', 'open_unit', p_open_unit_id, v_before, v_after, 'rpc');
END;
$$;

GRANT EXECUTE ON FUNCTION void_open_unit(uuid, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP FUNCTION IF EXISTS open_open_unit(uuid);
-- DROP FUNCTION IF EXISTS correct_open_unit(uuid, int, text);
-- DROP FUNCTION IF EXISTS void_open_unit(uuid, text);
-- COMMIT;
-- =============================================================================
