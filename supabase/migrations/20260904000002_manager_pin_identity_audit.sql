-- =============================================================================
-- Folded todo: audit-manager-pin-identity-in-remaining-rpcs
-- (.planning/todos/pending/audit-manager-pin-identity-in-remaining-rpcs.md)
--
-- Root cause: the same class of bug already fixed once for
-- process_direct_sale_atomic (G-27-13, 20260903090000_process_direct_sale_
-- manager_pin_reverify.sql) is present in three more manager-PIN-gated RPCs.
-- process_refund already accepts p_manager_pin but never reads it — it
-- authorizes off `id = auth.uid() AND role IN ('manager', 'admin')`, i.e. the
-- CALLER's own session role, not the identity of the staff member whose PIN
-- was actually entered into ManagerPinDialog. reopen_tab/edit_paid_tab make
-- the identical auth.uid()-based mistake and have no p_manager_pin parameter
-- at all. A cashier who gets a real manager to type their PIN into the dialog
-- is incorrectly denied (FORBIDDEN) on all three, because the check re-derives
-- authorization from the cashier's own role, not the PIN's.
--
-- close_tab is a separate, more severe gap: it is a live
-- `GRANT EXECUTE ... TO authenticated` PostgREST endpoint with ZERO
-- authorization check of any kind — any authenticated staff member (cashier
-- included) can call it directly and force a tab back to 'open'/'closed'/
-- 'paid'/'voided' with no manager involvement whatsoever.
--
-- Fix (four changes, each scoped to identity/authorization only — every other
-- line of each function body is copied verbatim from its current live
-- definition):
--
-- 1. process_refund — CREATE OR REPLACE (same signature, no DROP needed).
--    Re-key the identity check onto `profiles.pin = p_manager_pin` joined to
--    role_permissions, exactly the G-27-13 pattern.
-- 2. reopen_tab — DROP FUNCTION IF EXISTS (uuid, int, text) first (parameter
--    count changes), then CREATE with p_manager_pin appended LAST
--    (DEFAULT NULL::text, per this repo's append-only PostgREST-identity
--    convention). Same re-key.
-- 3. edit_paid_tab — same DROP + append-last + re-key pattern.
-- 4. close_tab — same signature (no DROP needed). Adds the SAME simple
--    auth.uid()-based role check reopen_tab/edit_paid_tab had BEFORE this
--    migration's fix (deliberately NOT the p_manager_pin pattern: close_tab
--    has zero client callers today per 28-RESEARCH.md Pitfall 4, so there is
--    no PIN to thread and no UI regression risk) — this closes the "any
--    authenticated staff member, no check at all" gap with the minimum
--    change.
--
-- Rule 2 addition (not explicitly named by the plan, required for
-- correctness): `role_permissions` has never had rows for the 'reopen_tab'/
-- 'edit_paid_tab' actions — neither action needed one before this migration
-- (both previously authorized off a plain `role IN ('manager','admin')`
-- check, no role_permissions join at all). This migration's re-keyed check
-- now joins `role_permissions` for both actions, so without seeding these
-- rows the new check would find zero matches and permanently deny every
-- real manager/admin PIN — the exact opposite of this migration's purpose.
-- Seeded below, mirroring 20260703000006_role_permissions_view_audit_log.sql's
-- (role, action) ON CONFLICT DO NOTHING pattern.
-- =============================================================================

-- =============================================================================
-- 1. process_refund — re-key identity check onto the entered PIN
-- =============================================================================

CREATE OR REPLACE FUNCTION public.process_refund(p_original_payment_id uuid, p_items jsonb, p_reason text, p_manager_pin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id         uuid;
  v_payment          record;
  v_already_refunded numeric;
  v_refund_total     numeric;
  v_refund_id        uuid;
  v_item             jsonb;
  v_refund_row       jsonb;
BEGIN
  -- 1. Re-derive the AUTHORIZING staff from the entered PIN itself, never
  -- from the caller's own auth.uid() session role (folded todo fix, mirrors
  -- G-27-13's process_direct_sale_atomic fix).
  SELECT p.id INTO v_staff_id
  FROM profiles p JOIN role_permissions rp ON rp.role = p.role
  WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'process_refund';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- 2. Get original payment (must not itself be a refund, and must not
  --    already be voided by a reopen — Phase 23 Pitfall 6)
  SELECT * INTO v_payment FROM payments
  WHERE id = p_original_payment_id
    AND is_refund = false
    AND status IS DISTINCT FROM 'reopened_void';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: payment % not found or is itself a refund', p_original_payment_id;
  END IF;

  -- 3. Compute already-refunded amount for this original payment
  SELECT COALESCE(SUM(r.amount), 0) INTO v_already_refunded
  FROM refunds r
  WHERE r.original_payment_id = p_original_payment_id;

  -- 4. Compute new refund total from items
  SELECT SUM((item->>'amount')::numeric) INTO v_refund_total
  FROM jsonb_array_elements(p_items) AS item;

  -- 5. Over-refund guard
  IF v_refund_total > (v_payment.amount - v_already_refunded) THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_ORIGINAL: refund % exceeds remaining refundable amount %',
      v_refund_total, (v_payment.amount - v_already_refunded);
  END IF;

  -- 6. Insert refund record
  INSERT INTO refunds (original_payment_id, reason, amount, created_by)
  VALUES (p_original_payment_id, p_reason, v_refund_total, v_staff_id)
  RETURNING id INTO v_refund_id;

  -- 7. Insert refund_items + optionally call deplete_for_order_item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = (v_item->>'order_item_id')::uuid
        AND o.tab_id = v_payment.tab_id
    ) THEN
      RAISE EXCEPTION 'ITEM_NOT_IN_ORIGINAL_ORDER: item % not in payment''s tab',
        v_item->>'order_item_id';
    END IF;

    INSERT INTO refund_items (refund_id, order_item_id, qty, amount, restock)
    VALUES (
      v_refund_id,
      (v_item->>'order_item_id')::uuid,
      (v_item->>'qty')::integer,
      (v_item->>'amount')::numeric,
      (v_item->>'restock')::boolean
    );

    IF (v_item->>'restock')::boolean THEN
      BEGIN
        PERFORM deplete_for_order_item((v_item->>'order_item_id')::uuid, -1);
      EXCEPTION WHEN undefined_function THEN
        NULL;
      END;
    END IF;
  END LOOP;

  -- 8. Insert negative payment row
  INSERT INTO payments (tab_id, amount, method, processed_at, processed_by, is_refund, refund_id, idempotency_key)
  VALUES (
    v_payment.tab_id,
    -v_refund_total,
    v_payment.method,
    now(),
    v_staff_id,
    true,
    v_refund_id,
    'refund-' || v_refund_id::text
  );

  -- 9. Legacy audit_log table (kept for backward compat; will be removed in Phase 22)
  --    FIX: actor_id, not staff_id (audit_log's actual column name).
  BEGIN
    INSERT INTO audit_log (action, entity_type, entity_id, actor_id, details)
    VALUES (
      'refund',
      'payment',
      p_original_payment_id,
      v_staff_id,
      jsonb_build_object('refund_id', v_refund_id, 'amount', v_refund_total)
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  -- AUDIT: record refund (Phase 14-03)
  SELECT to_jsonb(r) INTO v_refund_row FROM refunds r WHERE r.id = v_refund_id;
  PERFORM record_audit(
    'payment.refund',
    'payment',
    p_original_payment_id,
    to_jsonb(v_payment),
    v_refund_row,
    'rpc'
  );

  RETURN v_refund_id;
END;
$function$;

-- =============================================================================
-- 2. reopen_tab — append p_manager_pin (last param), re-key identity check
-- =============================================================================

DROP FUNCTION IF EXISTS public.reopen_tab(uuid, int, text);

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
  v_concept text;
BEGIN
  -- 1. Re-derive the AUTHORIZING staff from the entered PIN itself, never
  -- from the caller's own auth.uid() session role (folded todo fix, mirrors
  -- G-27-13's process_direct_sale_atomic fix). The client's ManagerPinDialog
  -- is UX-only; this is the actual security boundary.
  SELECT p.id INTO v_staff_id
  FROM profiles p JOIN role_permissions rp ON rp.role = p.role
  WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'reopen_tab';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required' USING ERRCODE = 'P0A01';
  END IF;

  -- 2. Version guard + cap/window read, all under the SAME row lock
  -- (D-03 — the cap must never be derived from a separate audit_logs scan).
  SELECT version, status, reopen_count, last_reopened_at
  INTO v_current, v_status, v_reopen_count, v_last_reopened
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  -- Only closed/paid tabs are reopenable — excludes 'open'/'split' (already
  -- open, nothing to reopen) and 'voided' (a voided tab is not reopenable).
  IF v_status NOT IN ('closed', 'paid') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_REOPENABLE',
      'message', 'Only closed or paid tabs can be reopened'
    );
  END IF;

  -- 3. Cap check (D-03): max 2 reopens total, ever, no reset of the count.
  IF v_reopen_count >= 2 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_CAP_EXCEEDED',
      'message', 'This tab has already been reopened twice'
    );
  END IF;

  -- 4. Window check (D-02): 24h from the MOST RECENT reopen, not the
  -- original close. NULL last_reopened_at means "never reopened before" —
  -- first reopen always skips this check.
  IF v_last_reopened IS NOT NULL AND NOW() - v_last_reopened > INTERVAL '24 hours' THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_WINDOW_EXPIRED',
      'message', 'Reopen window has expired'
    );
  END IF;

  -- 5. Capture before-state.
  SELECT to_jsonb(t.*) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  -- 6/7. Void payments (D-05): plain tab_id scope naturally catches every
  -- payment_group_id sibling from a split payment (Phase 18) and every
  -- sequential single-method payment in one statement — no group-aware
  -- branching needed (payment_group_id is a descriptive tag, not a filter
  -- requirement). Existing is_refund=true rows are untouched.
  --
  -- CR-01 fix: capture the amount actually voided by THIS statement via
  -- RETURNING, instead of re-summing status='reopened_void' across the whole
  -- tab (which would also include amounts voided by a PRIOR reopen of this
  -- same tab, double-counting the offsetting caja expense).
  WITH newly_voided AS (
    UPDATE payments
    SET status = 'reopened_void', updated_at = NOW()
    WHERE tab_id = p_tab_id AND is_refund = false AND status = 'completed'
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_voided_total FROM newly_voided;

  -- 8. Offsetting caja entry — only when there is something to reverse.
  -- A 'closed'-status tab (comp'd, zero payments) naturally no-ops here.
  -- type='expense' (A2): reopening reverses revenue already booked as income.
  IF v_voided_total <> 0 THEN
    SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a reopen adjustment'
        USING ERRCODE = 'P0A02';
    END IF;

    -- Sanitize p_reason before concatenating into caja_entries.concept
    -- (CHECK char_length BETWEEN 1 AND 200) — mirrors edit_paid_tab's
    -- exact sanitization (T-23-05).
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

  -- 9. Single combined tabs UPDATE — closed_at = NULL is MANDATORY in this
  -- SAME statement (Pitfall 1: closed_at_requires_closed_status CHECK
  -- rejects status='open' AND closed_at IS NOT NULL), and version=version+1
  -- must also be in this SAME statement (bump_version_on_update trigger
  -- rejects any UPDATE to tabs that doesn't advance version by exactly +1).
  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  -- 10. Capture after-state, with the reason embedded as a synthetic key
  -- (mirrors edit_paid_tab's identical convention — no new `reason` column
  -- on audit_logs).
  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  -- 11. Audit — success path ONLY (SC-4). A raised exception rolls back the
  -- whole transaction including any audit insert attempted after it, so this
  -- must never sit inside the EXCEPTION block.
  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  -- 12. Result.
  RETURN jsonb_build_object('ok', true, 'voidedPaymentTotal', v_voided_total);

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

GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, int, text, text) TO authenticated;

-- =============================================================================
-- 3. edit_paid_tab — append p_manager_pin (last param), re-key identity check
-- =============================================================================

DROP FUNCTION IF EXISTS public.edit_paid_tab(uuid, int, jsonb, text, text);

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
  -- 1. Re-derive the AUTHORIZING staff from the entered PIN itself, never
  -- from the caller's own auth.uid() session role (folded todo fix, mirrors
  -- G-27-13's process_direct_sale_atomic fix). The client's ManagerPinDialog
  -- is UX-only; this is the actual security boundary.
  SELECT p.id INTO v_staff_id
  FROM profiles p JOIN role_permissions rp ON rp.role = p.role
  WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'edit_paid_tab';

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

GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, int, jsonb, text, text, text) TO authenticated;

-- =============================================================================
-- 4. close_tab — add the simple auth.uid()-based role gate (no PIN, no UI
--    caller today — closes the "zero check at all" gap with the minimum
--    change; see 28-RESEARCH.md Pitfall 4)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.close_tab(
  p_tab_id UUID,
  p_status tab_status,
  p_expected_version INT DEFAULT NULL,
  p_terminal_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_current_version int;
  v_staff_id uuid;
BEGIN
  -- Role gate (folded todo fix, T-28-05): close_tab was previously a live
  -- `GRANT EXECUTE ... TO authenticated` endpoint with zero authorization
  -- check of any kind — any authenticated staff member (cashier included)
  -- could call it directly. This is the same simple auth.uid()-based check
  -- reopen_tab/edit_paid_tab had BEFORE this migration's PIN re-key above.
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid() AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required' USING ERRCODE = 'P0A01';
  END IF;

  -- Lock the row + capture before-state and current version.
  SELECT to_jsonb(t), t.version INTO v_before, v_current_version
  FROM tabs t
  WHERE t.id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  -- Phase 15 parity: NULL expected version skips the check, mirroring the
  -- hook's pre-RPC no-cached-version fallback path.
  IF p_expected_version IS NOT NULL AND v_current_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  UPDATE tabs
  SET
    status = p_status,
    closed_at = CASE WHEN p_status = 'open'::tab_status THEN NULL ELSE COALESCE(closed_at, NOW()) END,
    updated_at = NOW(),
    version = v_current_version + 1
  WHERE id = p_tab_id;

  SELECT to_jsonb(t) INTO v_after FROM tabs t WHERE t.id = p_tab_id;

  -- AUDIT: record the manual status transition as 'tab.close' (Phase 14-05).
  -- Sits AFTER the version guard so on P0V01/P0V02 the raise fires first and
  -- nothing has been written — audit is correctly skipped on conflict.
  PERFORM record_audit('tab.close', 'tab', p_tab_id, v_before, v_after, 'rpc', p_terminal_id);

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_tab(UUID, tab_status, INT, TEXT) TO authenticated;

-- =============================================================================
-- 5. role_permissions seed (Rule 2 — see note above): 'reopen_tab'/
--    'edit_paid_tab' never had rows here; the re-keyed checks above depend on
--    them existing.
-- =============================================================================

INSERT INTO role_permissions (role, action) VALUES
  ('manager', 'reopen_tab'),
  ('admin', 'reopen_tab'),
  ('manager', 'edit_paid_tab'),
  ('admin', 'edit_paid_tab')
ON CONFLICT (role, action) DO NOTHING;

NOTIFY pgrst, 'reload schema';
