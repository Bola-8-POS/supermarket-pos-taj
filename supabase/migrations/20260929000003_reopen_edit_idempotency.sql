-- Makes reopen_tab and edit_paid_tab replay-safe using the generic idempotency
-- ledger from 20260929000001_rpc_idempotency_ledger.sql, the same pattern Task 2
-- applied to process_refund (20260929000002_process_refund_idempotency.sql).
--
-- Both RPCs today get only ACCIDENTAL protection from their optimistic-concurrency
-- version guard (p_expected_version): that guard only rejects a replay while the
-- retry resubmits the exact tabs.version it originally captured. A sync worker (or
-- any offline-queue retry) that re-reads the tab's current version before retrying
-- would sail straight past it and reopen/edit the tab a second time -- a second
-- caja_entries reversal/adjustment row, a second reopen_count bump, a second set of
-- order_item patches and inventory/stock_movements writes (recon R2 SS B5). The
-- explicit idempotency check below must run BEFORE the version guard (and before
-- resolve_manager_approval, see the deviation note), or it is dead code.
--
-- Deviation from the plan's literal Step 3 pseudocode (documented per
-- constraints.md's deviation-handling policy; identical deviation, and identical
-- reasoning, to the one Task 2 documented in 20260929000002_process_refund_idempotency.sql):
-- the plan's snippet names v_staff_id as the idempotency-ledger scope and says to
-- place the replay check "before the version guard" -- but in BOTH of these RPCs
-- v_staff_id is only ever assigned FROM resolve_manager_approval()'s return value,
-- so it does not exist yet at any point genuinely before that call, let alone
-- before the version guard that follows it. Placing the replay check before
-- resolve_manager_approval() (rather than merely before the version guard) is what
-- controller ruling #2 requires and what the plan's own intent demands: a replay
-- must still succeed even after the original call's single-use approval ticket has
-- already been consumed -- an approval ticket is consumed inside
-- resolve_manager_approval() itself, so the replay check must run strictly before
-- that call, not merely before the SELECT ... FOR UPDATE a few lines later. The
-- scope identity used below is therefore v_caller (auth.uid(), the authenticated
-- RPC caller, resolved once at the very top of each function) rather than
-- v_staff_id (the ticket's approver, resolved later, and not necessarily the same
-- person retrying the call). v_caller is reused unchanged for both
-- idempotency_begin and idempotency_commit so a caller's replay always matches the
-- row its own original call created. A direct, positive consequence (verified by
-- the concurrent-replay tests added alongside this migration): a replayed call --
-- including a genuinely concurrent one racing on the same key -- never touches the
-- approval ticket at all if it loses the race; only the call that performs the
-- real first-time work ever calls resolve_manager_approval().
--
-- Per the brief, the idempotency-ledger scope hash deliberately excludes
-- p_expected_version: it is p_tab_id + p_reason for reopen_tab, and additionally
-- p_order_item_patches for edit_paid_tab. This is what makes "a replay that
-- refreshes the version first is still blocked" work -- a caller that re-reads
-- tabs.version before retrying the same logical attempt still matches the ledger
-- row on the same key and gets back the original result, rather than tripping
-- IDEMPOTENCY_MISMATCH or re-running the whole operation against the new version.
--
-- Every existing guard, error code (STALE_VERSION/NOT_FOUND_VERSIONED/
-- NO_OPEN_CAJA/AUTH_FORBIDDEN/PIN_LOCKED/REOPEN_CAP_EXCEEDED/REOPEN_WINDOW_EXPIRED/
-- TAB_NOT_REOPENABLE/TAB_NOT_EDITABLE), the reopen cap of 2, and the 24-hour reopen
-- window are otherwise byte-for-byte unchanged. idempotency_commit is called only
-- immediately before each function's single successful `RETURN jsonb_build_object(
-- 'ok', true, ...)` -- an early rejection (AUTH_FORBIDDEN, REOPEN_CAP_EXCEEDED,
-- TAB_NOT_EDITABLE, ...) is never cached, so a replay of a key that previously hit
-- one of those guards simply re-evaluates the guards against current state instead
-- of being permanently pinned to a stale rejection.

DROP FUNCTION IF EXISTS public.reopen_tab(uuid, integer, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.reopen_tab(p_tab_id uuid, p_expected_version integer, p_reason text, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_approval jsonb;
  v_caller uuid;
  v_replay jsonb;
  v_success_payload jsonb;
BEGIN
  v_caller := auth.uid();

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public.idempotency_begin(
      p_idempotency_key, 'reopen_tab', v_caller,
      p_tab_id::text || '|' || coalesce(p_reason, '')
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay || jsonb_build_object('idempotent', true);
    END IF;
  END IF;

  v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'reopen_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

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

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id, source)
    VALUES (v_caja, 'expense', v_voided_total, v_concept, v_staff_id, 'reopen');
  END IF;

  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  v_success_payload := jsonb_build_object('ok', true, 'voidedPaymentTotal', v_voided_total);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.idempotency_commit(
      p_idempotency_key, 'reopen_tab', v_caller,
      p_tab_id::text || '|' || coalesce(p_reason, ''),
      v_success_payload
    );
  END IF;

  RETURN v_success_payload;

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
$function$;

REVOKE ALL ON FUNCTION public.reopen_tab(uuid, integer, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, integer, text, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, integer, text, uuid, uuid, text) TO service_role;

DROP FUNCTION IF EXISTS public.edit_paid_tab(uuid, integer, jsonb, text, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.edit_paid_tab(p_tab_id uuid, p_expected_version integer, p_order_item_patches jsonb, p_notes text, p_reason text, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_approval jsonb;
  v_caller uuid;
  v_replay jsonb;
  v_success_payload jsonb;
BEGIN
  v_caller := auth.uid();

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public.idempotency_begin(
      p_idempotency_key, 'edit_paid_tab', v_caller,
      p_tab_id::text || '|' || coalesce(p_reason, '') || '|' || coalesce(p_order_item_patches::text, '')
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay || jsonb_build_object('idempotent', true);
    END IF;
  END IF;

  v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'edit_paid_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

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

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id, source)
    VALUES (
      v_caja,
      CASE WHEN v_delta > 0 THEN 'income' ELSE 'expense' END,
      abs(v_delta),
      v_concept,
      v_staff_id,
      'edit'
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
  ) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.edit_paid', 'tab', p_tab_id, v_before, v_after, 'rpc');

  v_success_payload := jsonb_build_object(
    'ok', true,
    'newTotal', v_new_total,
    'delta', v_delta,
    'cajaAdjustmentRecorded', v_delta <> 0
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.idempotency_commit(
      p_idempotency_key, 'edit_paid_tab', v_caller,
      p_tab_id::text || '|' || coalesce(p_reason, '') || '|' || coalesce(p_order_item_patches::text, ''),
      v_success_payload
    );
  END IF;

  RETURN v_success_payload;

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
$function$;

REVOKE ALL ON FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, uuid, uuid, text) TO service_role;
