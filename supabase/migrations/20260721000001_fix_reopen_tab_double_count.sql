-- =============================================================================
-- Phase 23 CR-01 fix — reopen_tab double-counts the offsetting caja expense
-- on a tab's second reopen
--
-- 20260720000004_reopen_tab_rpc.sql sized the offsetting caja_entries expense
-- row by re-summing SUM(amount) WHERE status = 'reopened_void' for the whole
-- tab, which also picks up every payment voided by a PRIOR reopen of the same
-- tab (reopen_count is capped at 2, so a tab can legitimately go through this
-- flow twice — 23-REVIEW.md CR-01). On a tab's second reopen this double-
-- counts the first reopen's already-voided total into the second reopen's
-- caja expense, overstating get_caja_report's totalExpenses/netBalance.
--
-- Fix: capture only the amount actually voided by THIS statement via
-- `UPDATE ... RETURNING amount`, instead of re-deriving it from a filter
-- that also matches previously-voided rows.
--
-- This migration was pushed to remote AFTER 20260720000004 had already been
-- applied there (see 23-REVIEW-FIX.md) — CREATE OR REPLACE FUNCTION replaces
-- the entire function body, so the rest of the function is reproduced
-- unchanged from 20260720000004; only step 6/7's voided-total calculation
-- differs.
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

GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, int, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- Re-applying 20260720000004's CREATE OR REPLACE body would restore the
-- double-counting behavior this migration fixes, so there is no safe DOWN
-- other than re-running that prior migration's body verbatim. Documented
-- here rather than scripted to avoid accidentally reintroducing CR-01.
-- =============================================================================
