-- =============================================================================
-- Phase 14-05: close_tab SECURITY DEFINER RPC — audits manual tab status
-- transitions as 'tab.close' while PRESERVING the Phase-15 optimistic-
-- concurrency contract (RESEARCH.md Pitfall 6 / explicit Phase-15-regression
-- warning).
--
-- Prior to this migration, `useMutationUpdateTabStatus` performed the status
-- transition via a direct `.from('tabs').update({status, version}).eq(...)`
-- call (Group B hook-optimistic pattern) with NO audit trail. This migration
-- moves that write server-side into a SECURITY DEFINER RPC so the mutation
-- can be audited atomically in the same transaction as the status change,
-- matching the pattern already used by process_payment_atomic (Group A).
--
-- Version-bump decision (per plan instruction — must not double-increment):
-- `bump_version_on_update()` (20260512000001_versioned_rows.sql) is a
-- BEFORE UPDATE trigger that only VALIDATES `new.version = old.version + 1`
-- (raising P0V01 on mismatch) — it does NOT itself increment version. Every
-- writer (Group A RPCs, Group B hooks) must explicitly set
-- `version = version + 1` in its own UPDATE statement. This RPC follows the
-- same explicit-increment pattern as process_payment_atomic /
-- create_order_with_items (20260512000002_rpc_versioned_group_a.sql) to
-- avoid relying on the trigger to perform an increment it does not perform.
--
-- Rule 2 addition (not explicitly specified in the plan, but required for
-- correctness): `tabs` has a pre-existing CHECK constraint
-- (closed_at_requires_closed_status, 20260414000004_tabs_and_orders.sql)
-- requiring `closed_at IS NOT NULL` whenever status is 'closed'/'paid'/
-- 'voided', and `closed_at IS NULL` when status is 'open'. The pre-RPC direct
-- `.update({status})` call never touched closed_at, so a transition into a
-- terminal status via this path would have violated that CHECK constraint
-- (latent bug — the hook is not currently wired to any UI call site, so this
-- was never exercised in production). The RPC now sets closed_at
-- consistently with the constraint: NULL when returning to 'open', otherwise
-- COALESCE(closed_at, NOW()) so an already-closed timestamp is preserved on
-- an idempotent re-close.
-- =============================================================================

-- UP:
BEGIN;

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
BEGIN
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

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.close_tab(UUID, tab_status, INT, TEXT) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.close_tab(UUID, tab_status, INT, TEXT);
-- COMMIT;
-- =============================================================================
