-- =============================================================================
-- Phase 20 Plan 05 Task 2: stop_pool_session SECURITY DEFINER RPC (D-05a)
--
-- Introduces the FIRST server-side RPC boundary for the pool-session stop
-- write (RESEARCH Pitfall 3 / Open Question 2). Prior to this migration,
-- `useMutationStopSession` (src/entities/pool-table/model/queries.ts)
-- performed the billing computation client-side (computePoolSessionBilling,
-- src/shared/lib/pool-billing.ts) and wrote `total_charge`/`billed_minutes`
-- via a raw client `.update()` with an optimistic-concurrency
-- `.eq('version', expected)` check — no SECURITY DEFINER RPC wrapped this
-- write, unlike every other atomic order-time operation in this codebase
-- (add_combo_to_tab, create_order_with_items, close_caja_session, close_tab).
--
-- This RPC mirrors the close_tab precedent (20260703000004_close_tab_rpc.sql,
-- Phase 14): FOR UPDATE lock, p_expected_version `IS DISTINCT FROM` guard
-- (P0V01 STALE_VERSION / P0V02 NOT_FOUND_VERSIONED, Phase 15 parity), explicit
-- `version = v_current_version + 1` (the bump_version_on_update trigger only
-- VALIDATES the +1 advance, it does not perform it), and a record_audit call
-- after the version guard so a conflicting stop never gets audited.
--
-- From this migration forward, stop_pool_session is the SOLE authoritative
-- writer of pool_sessions.total_charge / billed_minutes:
--   - rate_per_hour is read server-side from pool_tables (never trusted from
--     the client)
--   - firstHourMode is read server-side from settings.value->>'firstHourMode'
--     (settings.key = 'billing'), defaulting to 'prorated' — same convention
--     as useMutationStopSession's pre-RPC client read
--   - unconsumed pool_grant minutes (Plan 20-05 Task 1,
--     applied_promotions.pool_minutes_granted / consumed_at) are summed and
--     consumed (consumed_at = now(), pool_session_id = this session) in the
--     SAME transaction as the billing write — a grant cannot be consumed
--     twice (T-20-06)
--   - eligible pool_billing promotions (target_type = 'pool_billing') are
--     compounded onto the base charge using the identical sequential-
--     compounding CASE + GREATEST(0, ROUND(...,2)) clamp as
--     evaluate_promotions_for_item, with applied_promotions rows tagged
--     pool_session_id = this session
--
-- The client rewire that CALLS this RPC (replacing the raw `.update()`) is
-- Plan 20-08 — this migration only authors the server side.
--
-- Billing math (ported from computePoolSessionBilling, pool-billing.ts
-- lines ~41-59, per this plan's explicit action spec):
--   v_elapsed_minutes := EXTRACT(EPOCH FROM (now() - v_started_at)) / 60
--   v_base_billed      := 60 if firstHourMode='full' AND elapsed < 60, else elapsed
--   v_chargeable       := GREATEST(0, v_base_billed - v_prepaid)
--   v_billed_minutes   := 0 if chargeable=0, else CEIL(chargeable / 15.0) * 15
--   v_base_charge      := ROUND((v_billed_minutes / 60.0) * v_rate_per_hour, 2)
--
-- Depends on:
--   - 20260414000005_pool_tables.sql (pool_sessions, pool_tables.rate_per_hour)
--   - 20260512000001_versioned_rows.sql (bump_version_on_update trigger, P0V01)
--   - 20260710000001_promotions_schema.sql (promotions, target_type='pool_billing')
--   - 20260710000003_applied_promotions_table.sql (pool_session_id, pool_minutes_granted, consumed_at)
--   - 20260703000001_record_audit_terminal_id.sql (record_audit current 8-arg signature)
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION public.stop_pool_session(
  p_session_id uuid,
  p_expected_version int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before             jsonb;
  v_started_at         timestamptz;
  v_tab_id             uuid;
  v_table_id           uuid;
  v_current_version    int;
  v_rate_per_hour      numeric;
  v_first_hour_mode    text;
  v_prepaid            numeric := 0;
  v_elapsed_minutes    numeric;
  v_base_billed        numeric;
  v_chargeable         numeric;
  v_billed_minutes     numeric;
  v_base_charge        numeric;
  v_total              numeric;
  v_original           numeric;
  v_promo              record;
BEGIN
  -- 1. Lock the row + capture before-state, started_at, tab/table ids, version.
  SELECT to_jsonb(ps), ps.started_at, ps.tab_id, ps.table_id, ps.version
  INTO v_before, v_started_at, v_tab_id, v_table_id, v_current_version
  FROM pool_sessions ps
  WHERE ps.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  -- 2. Server-authoritative rate + firstHourMode (never trust a client value).
  SELECT rate_per_hour INTO v_rate_per_hour FROM pool_tables WHERE id = v_table_id;

  SELECT COALESCE(value ->> 'firstHourMode', 'prorated')
  INTO v_first_hour_mode
  FROM settings
  WHERE key = 'billing';

  IF v_first_hour_mode IS NULL THEN
    v_first_hour_mode := 'prorated';
  END IF;

  -- 3. Consume unconsumed pool_grant minutes for this tab (T-20-06:
  --    single UPDATE ... consumed_at = now() inside this transaction —
  --    a grant cannot be consumed twice).
  IF v_tab_id IS NOT NULL THEN
    SELECT COALESCE(SUM(pool_minutes_granted), 0)
    INTO v_prepaid
    FROM applied_promotions
    WHERE tab_id = v_tab_id
      AND pool_minutes_granted IS NOT NULL
      AND consumed_at IS NULL;

    UPDATE applied_promotions
    SET consumed_at = now(), pool_session_id = p_session_id
    WHERE tab_id = v_tab_id
      AND pool_minutes_granted IS NOT NULL
      AND consumed_at IS NULL;
  END IF;

  -- 4. Billing math, ported from computePoolSessionBilling.
  v_elapsed_minutes := EXTRACT(EPOCH FROM (now() - v_started_at)) / 60;

  IF v_first_hour_mode = 'full' AND v_elapsed_minutes < 60 THEN
    v_base_billed := 60;
  ELSE
    v_base_billed := v_elapsed_minutes;
  END IF;

  v_chargeable := GREATEST(0, v_base_billed - v_prepaid);

  v_billed_minutes := CASE WHEN v_chargeable = 0 THEN 0 ELSE CEIL(v_chargeable / 15.0) * 15 END;

  v_base_charge := ROUND((v_billed_minutes / 60.0) * v_rate_per_hour, 2);

  -- 5. Apply pool_billing promotions — same sequential-compounding shape as
  --    evaluate_promotions_for_item's price loop.
  v_total := v_base_charge;

  FOR v_promo IN
    SELECT p.*
    FROM promotions p
    WHERE p.is_active
      AND p.target_type = 'pool_billing'
      AND is_promotion_available(p.id, now())
    ORDER BY p.priority ASC, p.created_at ASC, p.id ASC
  LOOP
    v_original := v_total;

    CASE v_promo.discount_type
      WHEN 'percentage' THEN
        v_total := GREATEST(0, ROUND(v_total * (1 - v_promo.discount_value / 100), 2));
      WHEN 'fixed_amount' THEN
        v_total := GREATEST(0, ROUND(v_total - v_promo.discount_value, 2));
      WHEN 'fixed_price' THEN
        v_total := v_promo.discount_value;
      ELSE
        CONTINUE;
    END CASE;

    INSERT INTO applied_promotions (
      promotion_id,
      promotion_name_snapshot,
      target_type,
      discount_type,
      discount_value,
      tab_id,
      pool_session_id,
      original_amount,
      discounted_amount
    ) VALUES (
      v_promo.id,
      v_promo.name,
      'pool_billing',
      v_promo.discount_type,
      v_promo.discount_value,
      v_tab_id,
      p_session_id,
      v_original,
      v_total
    );
  END LOOP;

  -- 6. Write the session — sole authoritative writer of total_charge/billed_minutes.
  UPDATE pool_sessions
  SET
    stopped_at = now(),
    billed_minutes = v_billed_minutes,
    total_charge = v_total,
    version = v_current_version + 1
  WHERE id = p_session_id;

  -- 7. Audit (best-effort; record_audit swallows its own exceptions).
  PERFORM record_audit(
    'promotion.apply',
    'pool_session',
    p_session_id,
    v_before,
    jsonb_build_object(
      'billedMinutes', v_billed_minutes,
      'baseCharge', v_base_charge,
      'prepaidMinutes', v_prepaid,
      'totalCharge', v_total
    ),
    'rpc',
    NULL
  );

  -- 8. Return the updated session row so the client can map it (Plan 20-08).
  RETURN (
    SELECT jsonb_build_object(
      'id', ps.id,
      'stopped_at', ps.stopped_at,
      'billed_minutes', ps.billed_minutes,
      'total_charge', ps.total_charge,
      'version', ps.version,
      'tab_id', ps.tab_id,
      'table_id', ps.table_id
    )
    FROM pool_sessions ps
    WHERE ps.id = p_session_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.stop_pool_session(uuid, int) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.stop_pool_session(uuid, int) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.stop_pool_session(uuid, int);
-- COMMIT;
-- =============================================================================
