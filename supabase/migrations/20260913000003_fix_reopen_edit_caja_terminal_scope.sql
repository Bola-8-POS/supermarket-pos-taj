-- =============================================================================
-- Fix: reopen_tab / edit_paid_tab must anchor their offsetting caja_entries
-- reversal to the SAME terminal the original sale was rung up on, not to
-- "whichever caja session happens to be open" (`WHERE status = 'open' LIMIT 1`).
--
-- 20260913000000_caja_per_terminal.sql intentionally relaxed the DB-wide
-- "one open caja, period" unique constraint to "one open caja per terminal",
-- so it is now normal for two or more terminals to have simultaneously-open
-- caja sessions. reopen_tab and edit_paid_tab were not updated for that —
-- their `LIMIT 1` pick is non-deterministic across terminals, so a reopen/
-- edit performed while Terminal A's tab is being corrected could silently
-- write the reversal into Terminal B's open caja instead (surfaced as
-- integration-test flakiness under concurrent execution, but a real
-- production correctness gap once >1 terminal is live).
--
-- Fix: derive the terminal from the tab's own `tabs.caja_session_id` (the
-- caja session the original sale was recorded against) and require an open
-- caja on THAT terminal for the reversal. Falls back to the old
-- any-open-caja lookup only when the tab has no resolvable original
-- terminal (legacy data), preserving prior behavior for that edge case.
--
-- No signature change on either function — CREATE OR REPLACE only.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reopen_tab(
  p_tab_id uuid,
  p_expected_version int,
  p_reason text,
  p_manager_pin text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_reopen_count int;
  v_last_reopened timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_voided_total numeric;
  v_caja uuid;
  v_terminal text;
  v_concept text;
BEGIN
  SELECT p.id INTO v_staff_id
  FROM profiles p JOIN role_permissions rp ON rp.role = p.role
  WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'reopen_tab';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required' USING ERRCODE = 'P0A01';
  END IF;

  SELECT version, status, reopen_count, last_reopened_at
  INTO v_current, v_status, v_reopen_count, v_last_reopened
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('closed', 'paid') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_REOPENABLE',
      'message', 'Only closed or paid tabs can be reopened'
    );
  END IF;

  IF v_reopen_count >= 2 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_CAP_EXCEEDED',
      'message', 'This tab has already been reopened twice'
    );
  END IF;

  IF v_last_reopened IS NOT NULL AND NOW() - v_last_reopened > INTERVAL '24 hours' THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_WINDOW_EXPIRED',
      'message', 'Reopen window has expired'
    );
  END IF;

  SELECT to_jsonb(t.*) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  WITH newly_voided AS (
    UPDATE payments
    SET status = 'reopened_void', updated_at = NOW()
    WHERE tab_id = p_tab_id AND is_refund = false AND status = 'completed'
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_voided_total FROM newly_voided;

  IF v_voided_total <> 0 THEN
    -- Terminal-scoped lookup (this migration's fix): anchor to the terminal
    -- the tab's original caja session belongs to, so the reversal lands in
    -- the same cash drawer the sale did — not an arbitrary other terminal's
    -- open session.
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      -- No resolvable original terminal (legacy tab with no caja_session_id)
      -- — fall back to the pre-per-terminal-caja behavior.
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a reopen adjustment'
        USING ERRCODE = 'P0A02';
    END IF;

    v_concept := left(
      format(
        'Reopen tab %s: %s',
        substr(p_tab_id::text, 1, 8),
        regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g')
      ),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id)
    VALUES (v_caja, 'expense', v_voided_total, v_concept, v_staff_id);
  END IF;

  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object('ok', true, 'voidedPaymentTotal', v_voided_total);

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, int, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.edit_paid_tab(
  p_tab_id uuid,
  p_expected_version int,
  p_order_item_patches jsonb,
  p_notes text,
  p_reason text,
  p_manager_pin text DEFAULT NULL::text
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
  v_terminal text;
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
  SELECT p.id INTO v_staff_id
  FROM profiles p JOIN role_permissions rp ON rp.role = p.role
  WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'edit_paid_tab';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required' USING ERRCODE = 'P0A01';
  END IF;

  SELECT version, status INTO v_current, v_status
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('paid', 'closed') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_EDITABLE',
      'message', 'Only paid or closed tabs can be edited'
    );
  END IF;

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

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_old_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  SELECT o.id INTO v_last_order_id
  FROM orders o WHERE o.tab_id = p_tab_id
  ORDER BY o.created_at DESC LIMIT 1;

  FOR v_patch IN SELECT * FROM jsonb_array_elements(COALESCE(p_order_item_patches, '[]'::jsonb))
  LOOP
    v_op := v_patch->>'op';

    IF v_op = 'update' THEN
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

      IF v_item_product_id IS NOT NULL AND v_new_qty IS NOT NULL AND v_new_qty <> v_old_qty THEN
        v_qty_delta := v_new_qty - v_old_qty;

        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand - v_qty_delta, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, -v_qty_delta, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'delete' THEN
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

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_new_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  v_delta := v_new_total - v_old_total;

  IF v_delta <> 0 THEN
    -- Terminal-scoped lookup (this migration's fix) — see reopen_tab above.
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a total-changing edit'
        USING ERRCODE = 'P0A02';
    END IF;

    SELECT substr(t.id::text, 1, 8), to_char(t.opened_at, 'YYYY-MM-DD')
    INTO v_short_id, v_orig_date
    FROM tabs t WHERE t.id = p_tab_id;

    v_sanitized_reason := regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g');

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

  UPDATE tabs
  SET notes = COALESCE(p_notes, notes), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

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

  PERFORM record_audit('tab.edit_paid', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object(
    'ok', true,
    'newTotal', v_new_total,
    'delta', v_delta,
    'cajaAdjustmentRecorded', v_delta <> 0
  );

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, int, jsonb, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback): re-apply
-- 20260904000002_manager_pin_identity_audit.sql's reopen_tab/edit_paid_tab
-- bodies verbatim (the `WHERE status = 'open' LIMIT 1` version) to revert.
-- =============================================================================
