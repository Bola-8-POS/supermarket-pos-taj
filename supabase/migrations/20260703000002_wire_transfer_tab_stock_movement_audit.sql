-- =============================================================================
-- Phase 14-03: Wire record_audit() into transfer_tab + record_stock_movement
--
-- This migration patches the last 2 genuine `PERFORM record_audit(...)` wiring
-- targets from RESEARCH.md's "8 remaining RPCs" list (the other 6 need new RPCs
-- or client-side calls, handled by later Phase 14 plans). Both RPCs also gain a
-- new trailing `p_terminal_id text DEFAULT NULL` parameter so their audit rows
-- carry terminal_id (record_audit/8, added by 20260703000001).
--
-- Patched RPCs:
--   1. transfer_tab           -> 'tab.transfer'          / entity_type 'tab'
--   2. record_stock_movement  -> 'inventory.manual_adjust'/ entity_type 'ingredient'
--
-- record_audit() is called once, immediately before the success-path RETURN,
-- never inside a validation-error / RAISE / early-return branch. Audit
-- failures are non-fatal: record_audit() catches its own exceptions and
-- returns NULL (see 20260703000001_record_audit_terminal_id.sql).
--
-- Because adding a defaulted trailing param creates a new overload alongside
-- the existing signature, we DROP each old signature first to avoid PGRST203
-- "function not unique" ambiguity on the previous positional call form.
--
-- All action labels match constants in src/shared/lib/audit-actions.ts
-- (AuditActionSchema.options).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. transfer_tab — wire 'tab.transfer'
--    Source: 20260420000003_transfers.sql
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS transfer_tab(uuid, uuid, uuid, int, text, text);

CREATE OR REPLACE FUNCTION transfer_tab(
  p_tab_id          UUID,
  p_transferred_by  UUID,
  p_to_staff_id     UUID DEFAULT NULL,
  p_to_table        INT  DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_transfer_type   TEXT DEFAULT 'manual',
  p_terminal_id     TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tab             RECORD;
  v_from_staff_id   UUID;
  v_from_table      INT;
  v_transfer_id     UUID;
  v_before          jsonb;
  v_after           jsonb;
BEGIN
  -- Fetch current tab state
  SELECT staff_id, table_number, status
  INTO v_tab
  FROM tabs
  WHERE id = p_tab_id AND is_deleted = FALSE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Tab not found.'
    ));
  END IF;

  IF v_tab.status <> 'open' THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TAB_NOT_OPEN', 'message', 'Only open tabs can be transferred.'
    ));
  END IF;

  v_from_staff_id := v_tab.staff_id;
  v_from_table    := v_tab.table_number;

  -- Capture before state (Phase 14-03)
  SELECT to_jsonb(t) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  -- Apply changes to tab
  UPDATE tabs
  SET
    staff_id     = COALESCE(p_to_staff_id, staff_id),
    table_number = COALESCE(p_to_table, table_number)
  WHERE id = p_tab_id;

  -- Log the transfer
  INSERT INTO tab_transfers (
    tab_id, transferred_by, from_staff_id, to_staff_id,
    from_table, to_table, reason, transfer_type
  ) VALUES (
    p_tab_id, p_transferred_by, v_from_staff_id, p_to_staff_id,
    v_from_table, p_to_table, p_reason, p_transfer_type
  )
  RETURNING id INTO v_transfer_id;

  -- AUDIT: record successful tab transfer (Phase 14-03)
  SELECT to_jsonb(t) INTO v_after FROM tabs t WHERE t.id = p_tab_id;
  PERFORM record_audit(
    'tab.transfer',
    'tab',
    p_tab_id,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION transfer_tab(uuid, uuid, uuid, int, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. record_stock_movement — wire 'inventory.manual_adjust'
--    Source: 20260426000003_record_stock_movement_rpc.sql
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_stock_movement(uuid, numeric, text, text, uuid, text);

CREATE OR REPLACE FUNCTION record_stock_movement(
  p_ingredient_id  uuid,
  p_delta          numeric,
  p_reason         text,
  p_ref_type       text,
  p_ref_id         uuid,
  p_notes          text DEFAULT NULL,
  p_terminal_id    text DEFAULT NULL
)
RETURNS stock_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current  numeric;
  v_new      numeric;
  v_row      stock_movements;
  v_staff_id uuid;
BEGIN
  -- Capture calling user (SECURITY DEFINER preserves auth.uid() via JWT claims)
  v_staff_id := auth.uid();

  -- 1. Lock the ingredient row to prevent concurrent quantity drift
  SELECT quantity_on_hand INTO v_current
  FROM   ingredients
  WHERE  id = p_ingredient_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: ingredient % does not exist', p_ingredient_id;
  END IF;

  -- 2. Compute new quantity
  v_new := v_current + p_delta;

  -- 3. Negative-stock guard: correction and physical_count bypass the guard
  --    (they can legitimately drive qty below 0 to correct data errors)
  IF v_new < 0 AND p_reason NOT IN ('correction', 'physical_count') THEN
    RAISE EXCEPTION 'INVENTORY_NEGATIVE: result would be % for ingredient %', v_new, p_ingredient_id;
  END IF;

  -- 4. Insert the movement row
  INSERT INTO stock_movements (
    product_id,
    ingredient_id,
    quantity_delta,
    reason,
    ref_type,
    ref_id,
    staff_id,
    notes
  )
  VALUES (
    NULL,
    p_ingredient_id,
    p_delta,
    p_reason,
    p_ref_type,
    p_ref_id,
    v_staff_id,
    p_notes
  )
  RETURNING * INTO v_row;

  -- 5. Update ingredient quantity_on_hand atomically in the same transaction
  UPDATE ingredients
  SET    quantity_on_hand = v_new,
         updated_at       = now()
  WHERE  id = p_ingredient_id;

  -- AUDIT: record successful manual stock adjustment (Phase 14-03)
  PERFORM record_audit(
    'inventory.manual_adjust',
    'ingredient',
    p_ingredient_id,
    NULL,
    to_jsonb(v_row),
    'rpc',
    p_terminal_id
  );

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION record_stock_movement(uuid, numeric, text, text, uuid, text, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION transfer_tab(uuid, uuid, uuid, int, text, text, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS transfer_tab(uuid, uuid, uuid, int, text, text, text);
-- CREATE OR REPLACE FUNCTION transfer_tab(
--   p_tab_id          UUID,
--   p_transferred_by  UUID,
--   p_to_staff_id     UUID DEFAULT NULL,
--   p_to_table        INT  DEFAULT NULL,
--   p_reason          TEXT DEFAULT NULL,
--   p_transfer_type   TEXT DEFAULT 'manual'
-- )
-- RETURNS JSON
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- AS $$
-- DECLARE
--   v_tab             RECORD;
--   v_from_staff_id   UUID;
--   v_from_table      INT;
--   v_transfer_id     UUID;
-- BEGIN
--   SELECT staff_id, table_number, status
--   INTO v_tab
--   FROM tabs
--   WHERE id = p_tab_id AND is_deleted = FALSE;
--   IF NOT FOUND THEN
--     RETURN json_build_object('ok', false, 'error', json_build_object(
--       'code', 'NOT_FOUND', 'message', 'Tab not found.'
--     ));
--   END IF;
--   IF v_tab.status <> 'open' THEN
--     RETURN json_build_object('ok', false, 'error', json_build_object(
--       'code', 'TAB_NOT_OPEN', 'message', 'Only open tabs can be transferred.'
--     ));
--   END IF;
--   v_from_staff_id := v_tab.staff_id;
--   v_from_table    := v_tab.table_number;
--   UPDATE tabs
--   SET
--     staff_id     = COALESCE(p_to_staff_id, staff_id),
--     table_number = COALESCE(p_to_table, table_number)
--   WHERE id = p_tab_id;
--   INSERT INTO tab_transfers (
--     tab_id, transferred_by, from_staff_id, to_staff_id,
--     from_table, to_table, reason, transfer_type
--   ) VALUES (
--     p_tab_id, p_transferred_by, v_from_staff_id, p_to_staff_id,
--     v_from_table, p_to_table, p_reason, p_transfer_type
--   )
--   RETURNING id INTO v_transfer_id;
--   RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
-- END;
-- $$;
-- GRANT EXECUTE ON FUNCTION transfer_tab(uuid, uuid, uuid, int, text, text) TO authenticated;
--
-- REVOKE EXECUTE ON FUNCTION record_stock_movement(uuid, numeric, text, text, uuid, text, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS record_stock_movement(uuid, numeric, text, text, uuid, text, text);
-- CREATE OR REPLACE FUNCTION record_stock_movement(
--   p_ingredient_id  uuid,
--   p_delta          numeric,
--   p_reason         text,
--   p_ref_type       text,
--   p_ref_id         uuid,
--   p_notes          text DEFAULT NULL
-- )
-- RETURNS stock_movements
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $$
-- DECLARE
--   v_current  numeric;
--   v_new      numeric;
--   v_row      stock_movements;
--   v_staff_id uuid;
-- BEGIN
--   v_staff_id := auth.uid();
--   SELECT quantity_on_hand INTO v_current
--   FROM   ingredients
--   WHERE  id = p_ingredient_id
--   FOR UPDATE;
--   IF NOT FOUND THEN
--     RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: ingredient % does not exist', p_ingredient_id;
--   END IF;
--   v_new := v_current + p_delta;
--   IF v_new < 0 AND p_reason NOT IN ('correction', 'physical_count') THEN
--     RAISE EXCEPTION 'INVENTORY_NEGATIVE: result would be % for ingredient %', v_new, p_ingredient_id;
--   END IF;
--   INSERT INTO stock_movements (
--     product_id, ingredient_id, quantity_delta, reason, ref_type, ref_id, staff_id, notes
--   )
--   VALUES (
--     NULL, p_ingredient_id, p_delta, p_reason, p_ref_type, p_ref_id, v_staff_id, p_notes
--   )
--   RETURNING * INTO v_row;
--   UPDATE ingredients
--   SET    quantity_on_hand = v_new,
--          updated_at       = now()
--   WHERE  id = p_ingredient_id;
--   RETURN v_row;
-- END;
-- $$;
-- GRANT EXECUTE ON FUNCTION record_stock_movement(uuid, numeric, text, text, uuid, text) TO authenticated;
-- COMMIT;
-- =============================================================================
