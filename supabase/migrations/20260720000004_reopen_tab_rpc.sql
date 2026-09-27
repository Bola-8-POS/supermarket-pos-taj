-- =============================================================================
-- Phase 23 Plan 02 — reopen_tab RPC
--
-- Status-reversal tool for a closed/paid tab: flips tabs.status back to
-- 'open', voids the tab's completed (non-refund) payment row(s) via
-- payments.status='reopened_void', writes an offsetting expense caja_entries
-- row, enforces a 24h-rolling/2x-total reopen cap, and audit-logs the reopen.
-- This is the mirror image of Phase 22's edit_paid_tab (which patches a
-- paid/closed tab IN PLACE and explicitly never touches status) — reopen_tab
-- is the first RPC to ever flip tabs.status back to 'open' from a terminal
-- state, which is why it must clear closed_at in the SAME UPDATE statement
-- that sets status='open' (closed_at_requires_closed_status CHECK,
-- 20260427000001_split_bill_schema.sql).
--
-- Once reopened, the tab is a fully normal open tab (D-06) — no special
-- "reopened mode" UI. Existing add-item-to-tab/remove-item-from-tab/
-- close-tab/process-payment features apply unmodified; re-payment produces
-- fresh payment row(s), separate from the voided originals.
--
-- Depends on:
--   - 20260512000001_versioned_rows.sql (version column + bump_version_on_update trigger)
--   - 20260512000002_rpc_versioned_group_a.sql (p_expected_version/FOR UPDATE template)
--   - 20260511000001_audit_logs_table.sql (record_audit helper)
--   - 20260421000003_caja_entries.sql (caja_entries table)
--   - 20260420000002_caja_sessions.sql (caja_sessions table)
--   - 20260720000002_payments_status_column.sql (payments.status, this plan)
--   - 20260720000003_tabs_reopen_columns.sql (tabs.reopen_count/last_reopened_at, this plan)
--   - src/shared/lib/audit-actions.ts already registers 'tab.reopen' (23-01)
--
-- NOT pushed here — the BLOCKING db push is Plan 04. A follow-up migration
-- (Plan 03) patches process_payment_atomic/process_split_payment_atomic/
-- get_caja_report/close_caja_session/process_refund to exclude
-- 'reopened_void' rows from their sums (23-RESEARCH.md Pitfalls 3-6).
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION public.reopen_tab(
  p_tab_id uuid,
  p_expected_version int,
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
  v_reopen_count int;
  v_last_reopened timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_voided_total numeric;
  v_caja uuid;
  v_concept text;
BEGIN
  -- 1. Role re-check (defense-in-depth — the client's ManagerPinDialog is
  -- UX-only; this is the actual security boundary). Copied from
  -- edit_paid_tab's exact AUTH_FORBIDDEN check (T-23-01).
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid() AND role IN ('manager', 'admin');

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

  -- 6. Void payments (D-05): plain tab_id scope naturally catches every
  -- payment_group_id sibling from a split payment (Phase 18) and every
  -- sequential single-method payment in one statement — no group-aware
  -- branching needed (payment_group_id is a descriptive tag, not a filter
  -- requirement). Existing is_refund=true rows are untouched.
  UPDATE payments
  SET status = 'reopened_void', updated_at = NOW()
  WHERE tab_id = p_tab_id AND is_refund = false AND status = 'completed';

  SELECT COALESCE(SUM(amount), 0) INTO v_voided_total
  FROM payments WHERE tab_id = p_tab_id AND status = 'reopened_void';

  -- 7. Offsetting caja entry — only when there is something to reverse.
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

  -- 8. Single combined tabs UPDATE — closed_at = NULL is MANDATORY in this
  -- SAME statement (Pitfall 1: closed_at_requires_closed_status CHECK
  -- rejects status='open' AND closed_at IS NOT NULL), and version=version+1
  -- must also be in this SAME statement (bump_version_on_update trigger
  -- rejects any UPDATE to tabs that doesn't advance version by exactly +1).
  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  -- 9. Capture after-state, with the reason embedded as a synthetic key
  -- (mirrors edit_paid_tab's identical convention — no new `reason` column
  -- on audit_logs).
  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  -- 10. Audit — success path ONLY (SC-4). A raised exception rolls back the
  -- whole transaction including any audit insert attempted after it, so this
  -- must never sit inside the EXCEPTION block.
  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  -- 11. Result.
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

GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, int, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.reopen_tab(uuid, int, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.reopen_tab(uuid, int, text);
-- COMMIT;
-- =============================================================================
