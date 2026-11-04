-- =============================================================================
-- Phase 22 code review CR-01 fix: edit_paid_tab inventory adjustment
--
-- edit_paid_tab's whitelisted 'update' (quantity change) and 'delete'
-- (soft-delete via is_deleted=true) ops never adjusted inventory.quantity_on_hand
-- or wrote a stock_movements row. The two triggers that normally cover this
-- (decrement_inventory_on_order_item / restore_inventory_on_order_item_delete,
-- supabase/migrations/20260424000001_stock_movements.sql:44-82) only fire on a
-- hard INSERT/DELETE of order_items — this RPC does neither (it soft-deletes,
-- and an 'update' is a plain UPDATE), so every quantity correction or line-item
-- removal made through this tool silently desynced inventory.quantity_on_hand.
--
-- Fix: mirror those two triggers' exact inventory.quantity_on_hand + stock_movements
-- semantics directly inside this RPC (same reason as a "manual" correction —
-- 'correction' is one of the reasons stock_movements_reason_check already allows,
-- and is deliberately excluded from idx_stock_movements_idempotency so it can be
-- written here without colliding with the 'sale' row already recorded for this
-- order_item at creation time).
--
-- Recipe/modifier-driven ingredient depletion (deplete_for_order_item, the
-- ingredients/recipes system used by void-order/process_refund) is a separate
-- subsystem not named in CR-01 (which cites inventory.quantity_on_hand
-- specifically) and is out of scope here — deplete_for_order_item always reads
-- order_items.quantity fresh and is keyed by (ref_type, ref_id, ingredient_id)
-- idempotency, so it cannot be safely re-invoked for an order_item that already
-- has a recorded 'sale' movement without either no-op'ing or duplicating a much
-- larger existing limitation shared by void-order/process_refund; deferred.
--
-- Everything else about the RPC (role re-check, p_expected_version guard,
-- whitelist scoping, record_audit call, conditional caja offsetting entry) is
-- unchanged — this is a targeted addition, not a rewrite.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION public.edit_paid_tab(
  p_tab_id uuid,
  p_expected_version int,
  p_order_item_patches jsonb,
  p_notes text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_before jsonb;
  v_after jsonb;
  v_old_total numeric;
  v_new_total numeric;
  v_delta numeric;
  v_caja uuid;
  v_concept text;
  v_sanitized_reason text;
  v_short_id text;
  v_orig_date text;
  v_last_order_id uuid;
  v_patch jsonb;
  v_op text;
  v_item_product_id uuid;
  v_old_qty int;
  v_new_qty int;
  v_qty_delta int;
BEGIN
  -- 1. Role re-check (defense-in-depth — the client's ManagerPinDialog is
  -- UX-only; this is the actual security boundary). Copied from
  -- process_refund's exact AUTH_FORBIDDEN check.
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid() AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required' USING ERRCODE = 'P0A01';
  END IF;

  -- 2. Version guard (Phase 15 Group A template).
  SELECT version, status INTO v_current, v_status
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  -- Only paid/closed tabs are correctable — this is a correction tool, not a
  -- reopen. Phase 23 (reopen_tab) is out of scope here.
  IF v_status NOT IN ('paid', 'closed') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_EDITABLE',
      'message', 'Only paid or closed tabs can be edited'
    );
  END IF;

  -- 3. Capture before-state (tab row + live order_items).
  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  )
  INTO v_before
  FROM tabs t WHERE t.id = p_tab_id;

  -- 4. Old total — item subtotal basis, SAME as process_payment_atomic
  -- (Pitfall 3: never compare against payments.amount, which can differ from
  -- the item subtotal after a discount/split).
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_old_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  -- Most-recent order id, target for any 'add' op.
  SELECT o.id INTO v_last_order_id
  FROM orders o WHERE o.tab_id = p_tab_id
  ORDER BY o.created_at DESC LIMIT 1;

  -- 5. Apply the WHITELISTED patch. Only the named keys id/op/quantity/
  -- unit_price/notes/product_id are ever read — a bogus extra key in an
  -- element is simply never destructured, so it is silently ignored (T-22-01
  -- mitigation). No dynamic column-name SQL anywhere in this loop.
  FOR v_patch IN SELECT * FROM jsonb_array_elements(COALESCE(p_order_item_patches, '[]'::jsonb))
  LOOP
    v_op := v_patch->>'op';

    IF v_op = 'update' THEN
      -- Capture pre-update product_id/quantity so a quantity change can drive
      -- an inventory.quantity_on_hand delta below (CR-01 fix).
      SELECT product_id, quantity INTO v_item_product_id, v_old_qty
      FROM order_items
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id);

      UPDATE order_items
      SET
        quantity = COALESCE((v_patch->>'quantity')::int, quantity),
        unit_price = COALESCE((v_patch->>'unit_price')::numeric, unit_price),
        notes = COALESCE(v_patch->>'notes', notes),
        updated_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING quantity INTO v_new_qty;

      -- CR-01: a quantity change must adjust inventory.quantity_on_hand the
      -- same way decrement_inventory_on_order_item/restore_inventory_on_order_item_delete
      -- would for a hard INSERT/DELETE. Notes/unit_price-only edits (quantity
      -- unchanged) skip this entirely — nothing was actually re-served/removed.
      IF v_item_product_id IS NOT NULL AND v_new_qty IS NOT NULL AND v_new_qty <> v_old_qty THEN
        v_qty_delta := v_new_qty - v_old_qty;

        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand - v_qty_delta, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, -v_qty_delta, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'delete' THEN
      -- CR-01: soft-delete never fires trigger_restore_inventory_on_order_item_delete
      -- (that trigger is AFTER DELETE only) — restore the item's full quantity
      -- back to inventory.quantity_on_hand ourselves, same as that trigger would.
      UPDATE order_items
      SET is_deleted = true, deleted_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING product_id, quantity INTO v_item_product_id, v_old_qty;

      IF v_item_product_id IS NOT NULL THEN
        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand + v_old_qty, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, v_old_qty, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'add' THEN
      IF v_last_order_id IS NULL THEN
        RAISE EXCEPTION 'NO_ORDER_FOUND: tab % has no orders to attach a new item to', p_tab_id;
      END IF;
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes)
      VALUES (
        v_last_order_id,
        (v_patch->>'product_id')::uuid,
        COALESCE((v_patch->>'quantity')::int, 1),
        (v_patch->>'unit_price')::numeric,
        NULLIF(v_patch->>'notes', '')
      );
    END IF;
  END LOOP;

  -- 7. New total — same basis as step 4, computed after the patch.
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_new_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  v_delta := v_new_total - v_old_total;

  -- 8. Offsetting caja entry (D-02/D-03) — only when the edit changes the
  -- total. Notes-only edits (v_delta = 0) skip this block entirely and
  -- proceed regardless of caja state.
  IF v_delta <> 0 THEN
    SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a total-changing edit'
        USING ERRCODE = 'P0A02';
    END IF;

    SELECT substr(t.id::text, 1, 8), to_char(t.opened_at, 'YYYY-MM-DD')
    INTO v_short_id, v_orig_date
    FROM tabs t WHERE t.id = p_tab_id;

    -- Sanitize p_reason before concatenating into caja_entries.concept
    -- (CHECK char_length BETWEEN 1 AND 200): strip characters that would
    -- break later free-text parsing, mirroring sanitizeSearch() (T-22-04).
    v_sanitized_reason := regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g');

    -- Deliberate free-text encoding (D-02/Open Question 3 resolved): no
    -- caja_entries.source_tab_id/source_type columns exist yet. Phase 23
    -- (reopen_tab) needs the identical offsetting-entry mechanism and may
    -- introduce those columns later to replace this text encoding — do not
    -- add them here.
    v_concept := left(
      format('Edit paid tab %s (%s): %s', v_short_id, v_orig_date, v_sanitized_reason),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id)
    VALUES (
      v_caja,
      CASE WHEN v_delta > 0 THEN 'income' ELSE 'expense' END,
      abs(v_delta),
      v_concept,
      v_staff_id
    );
  END IF;

  -- 6/9. tabs.notes + version bump — MUST be a single UPDATE statement: the
  -- bump_version_on_update trigger rejects ANY update to `tabs` that does
  -- not advance version by exactly +1, so a separate notes-only UPDATE would
  -- itself raise STALE_VERSION.
  UPDATE tabs
  SET notes = COALESCE(p_notes, notes), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  -- 10. Capture after-state, with the reason embedded as a synthetic key
  -- (mirrors the existing `_truncated` synthetic-key precedent in
  -- record_audit — no new `reason` column on audit_logs).
  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  ) || jsonb_build_object('reason', p_reason)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  -- 11. Audit — success path ONLY. A raised exception rolls back the whole
  -- transaction including any audit insert attempted after it, so this must
  -- never sit inside the EXCEPTION block.
  PERFORM record_audit('tab.edit_paid', 'tab', p_tab_id, v_before, v_after, 'rpc');

  -- 12. Result.
  RETURN jsonb_build_object(
    'ok', true,
    'newTotal', v_new_total,
    'delta', v_delta,
    'cajaAdjustmentRecorded', v_delta <> 0
  );

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    -- STALE_VERSION — re-raise so PostgREST propagates the SQLSTATE/message
    -- to the client; do NOT swallow into the generic ok=false shape.
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    -- NOT_FOUND_VERSIONED — same as above.
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    -- AUTH_FORBIDDEN — re-raise (expected/testable business exception, not
    -- an internal failure).
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    -- NO_OPEN_CAJA — re-raise, same reasoning.
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, int, jsonb, text, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- Re-apply the prior (20260719000001) body verbatim via CREATE OR REPLACE
-- FUNCTION (no inventory/stock_movements adjustment in update/delete branches):
-- BEGIN;
-- -- ... (see supabase/migrations/20260719000001_edit_paid_tab_rpc.sql)
-- COMMIT;
-- =============================================================================
