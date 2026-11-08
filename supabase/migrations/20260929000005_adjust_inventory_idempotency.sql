-- Makes adjust_inventory replay-safe using the generic idempotency ledger from
-- 20260929000001_rpc_idempotency_ledger.sql, the same pattern Tasks 2-4 applied
-- to process_refund / reopen_tab / edit_paid_tab / register_caja_entry.
--
-- adjust_inventory's own p_expected_quantity compare-and-swap only rejects a
-- replay AFTER the first call has already moved quantity_on_hand -- two
-- back-to-back replays that both still carry the expected quantity captured
-- before either one ran (e.g. an offline queue firing the same manual
-- adjustment or physical-count line twice before either response comes back)
-- both pass that CAS check and double-apply the delta (recon R2 SS B7).
--
-- Per the brief, the idempotency-ledger scope hash is p_product_id +
-- p_quantity_delta + p_reason -- deliberately excluding p_expected_quantity,
-- the same way reopen_tab/edit_paid_tab's scope excludes p_expected_version:
-- a replay that re-reads the current stock level before retrying the
-- identical logical adjustment still matches the ledger row on the same key
-- and gets the original result back, rather than tripping STOCK_CHANGED or
-- IDEMPOTENCY_MISMATCH.
--
-- Ordering (controller ruling): AUTH_FORBIDDEN and the cheap INVALID_DELTA/
-- INVALID_REASON input validation stay first (read-only checks, no side
-- effect to protect), then idempotency_begin, then the
-- SELECT ... FOR UPDATE + STOCK_CHANGED compare-and-swap. This differs from
-- reopen_tab/edit_paid_tab, where the replay check had to move ahead of
-- resolve_manager_approval() because that call consumes a single-use
-- approval ticket; adjust_inventory has no such side-effecting call before
-- the row lock, so no equivalent reordering is needed here.
--
-- idempotency_commit runs only immediately before the single success
-- `RETURN jsonb_build_object('ok', true, ...)` -- an early rejection
-- (AUTH_FORBIDDEN/INVALID_DELTA/INVALID_REASON/NOT_FOUND/STOCK_CHANGED) is
-- never cached, so a replay of a key that previously hit one of those guards
-- simply re-evaluates the guards against current state instead of being
-- permanently pinned to a stale rejection. Every existing error message
-- (AUTH_FORBIDDEN, INVALID_DELTA, INVALID_REASON, NOT_FOUND, STOCK_CHANGED)
-- is otherwise byte-for-byte unchanged, and the function keeps its original
-- shape: no new EXCEPTION block, so IDEMPOTENCY_KEY_INVALID/_MISMATCH/
-- _UNAUTHORIZED raised by idempotency_begin propagate to the client as-is,
-- same as every other RAISE EXCEPTION in this function.

DROP FUNCTION IF EXISTS public.adjust_inventory(uuid, integer, text, text, integer);

CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_product_id uuid,
  p_quantity_delta integer,
  p_reason text,
  p_notes text DEFAULT NULL,
  p_expected_quantity integer DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_before record;
  v_after  record;
  v_movement_id uuid;
  v_replay jsonb;
  v_success_payload jsonb;
BEGIN
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles p
    JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_caller AND p.is_active = true AND rp.action = 'adjust_inventory'
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: not allowed to adjust stock';
  END IF;
  IF p_quantity_delta IS NULL OR p_quantity_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_DELTA: quantity delta must be non-zero';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'INVALID_REASON: a reason is required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public.idempotency_begin(
      p_idempotency_key, 'adjust_inventory', v_caller,
      p_product_id::text || '|' || p_quantity_delta::text || '|' || p_reason
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay || jsonb_build_object('idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_before FROM inventory WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no stock row for product %', p_product_id;
  END IF;
  IF p_expected_quantity IS NOT NULL AND v_before.quantity_on_hand <> p_expected_quantity THEN
    RAISE EXCEPTION 'STOCK_CHANGED: expected % but stock is %', p_expected_quantity, v_before.quantity_on_hand;
  END IF;

  UPDATE inventory
     SET quantity_on_hand = quantity_on_hand + p_quantity_delta, updated_at = now()
   WHERE product_id = p_product_id
   RETURNING * INTO v_after;

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, notes)
  VALUES (p_product_id, p_quantity_delta, p_reason, v_caller, p_notes)
  RETURNING id INTO v_movement_id;

  PERFORM record_audit('inventory.adjust', 'inventory', v_before.id,
    to_jsonb(v_before), to_jsonb(v_after) || jsonb_build_object('reason', p_reason, 'movement_id', v_movement_id), 'rpc');

  v_success_payload := jsonb_build_object('ok', true, 'quantityOnHand', v_after.quantity_on_hand, 'movementId', v_movement_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.idempotency_commit(
      p_idempotency_key, 'adjust_inventory', v_caller,
      p_product_id::text || '|' || p_quantity_delta::text || '|' || p_reason,
      v_success_payload
    );
  END IF;

  RETURN v_success_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_inventory(uuid, integer, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory(uuid, integer, text, text, integer, text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
