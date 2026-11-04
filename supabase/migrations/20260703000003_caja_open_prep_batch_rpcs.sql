-- =============================================================================
-- Phase 14-04: caja_open + produce_prep_batch SECURITY DEFINER RPCs
--
-- Two of the ROADMAP's "remaining RPCs" do not exist today — they are
-- direct client-side table INSERTs under RLS (RESEARCH.md Pitfall 6 + D-02):
--
--   1. caja_open           -> 'caja.open'    / entity_type 'caja_session'
--   2. produce_prep_batch  -> 'prep.produce' / entity_type 'prep_production'
--
-- Both are new thin SECURITY DEFINER wrapper RPCs that perform the same
-- INSERT the client used to do directly, then call record_audit() atomically
-- on the success path (D-02 explicitly forbids client-side post-insert audit
-- for caja_open). Audit failures are non-fatal: record_audit() catches its
-- own exceptions and returns NULL.
--
-- caja_open re-asserts the manage_caja (manager+) gate that the direct-INSERT
-- path got for free from RLS's "Managers can insert caja sessions" policy —
-- SECURITY DEFINER bypasses RLS, so the RPC itself must gate. The existing
-- caja_sessions_one_open unique index is left untouched; the unique_violation
-- exception path is not audited (no state changed).
--
-- produce_prep_batch performs the same INSERT into prep_productions that the
-- client used to do directly; the existing AFTER INSERT trigger
-- (trg_prep_production_insert / fn_prep_production_insert) still fires and
-- may RAISE PREP_INGREDIENT_REQUIRED / INGREDIENT_NOT_FOUND / INVENTORY_NEGATIVE.
-- Those exceptions are NOT caught here — they propagate so the client's
-- existing error-message mapping keeps working, and the INSERT (plus this
-- audit PERFORM, which runs after the trigger) rolls back atomically with it.
--
-- Action labels match constants in src/shared/lib/audit-actions.ts
-- (AuditActionSchema.options): 'caja.open', 'prep.produce'.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. caja_open — audits 'caja.open'
--    Replaces client-side `db.from('caja_sessions').insert(...)` under RLS.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_open(
  p_opening_cash numeric,
  p_opened_by    uuid,
  p_terminal_id  text DEFAULT NULL
)
RETURNS caja_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role TEXT;
  v_row         caja_sessions;
BEGIN
  -- Permission check — same manager/admin gate the RLS INSERT policy enforced.
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Only managers and admins can open the caja.';
  END IF;

  INSERT INTO caja_sessions (opening_cash, opened_by)
  VALUES (p_opening_cash, p_opened_by)
  RETURNING * INTO v_row;

  -- AUDIT: record successful caja open (Phase 14-04)
  PERFORM record_audit(
    'caja.open',
    'caja_session',
    v_row.id,
    NULL,
    to_jsonb(v_row),
    'rpc',
    p_terminal_id
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.caja_open(numeric, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caja_open(numeric, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. produce_prep_batch — audits 'prep.produce'
--    Replaces client-side `db.from('prep_productions').insert(...)`.
--    The existing trg_prep_production_insert trigger still fires and may
--    RAISE PREP_INGREDIENT_REQUIRED / INGREDIENT_NOT_FOUND / INVENTORY_NEGATIVE;
--    those exceptions are NOT caught here and propagate to the client.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.produce_prep_batch(
  p_prep_ingredient_id uuid,
  p_qty_produced       numeric,
  p_notes              text DEFAULT NULL,
  p_produced_by        uuid DEFAULT NULL,
  p_terminal_id        text DEFAULT NULL
)
RETURNS prep_productions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row prep_productions;
BEGIN
  INSERT INTO prep_productions (prep_ingredient_id, qty_produced, notes, produced_by)
  VALUES (p_prep_ingredient_id, p_qty_produced, p_notes, p_produced_by)
  RETURNING * INTO v_row;

  -- AUDIT: record successful prep batch production (Phase 14-04)
  PERFORM record_audit(
    'prep.produce',
    'prep_production',
    v_row.id,
    NULL,
    to_jsonb(v_row),
    'rpc',
    p_terminal_id
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.produce_prep_batch(uuid, numeric, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.produce_prep_batch(uuid, numeric, text, uuid, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.produce_prep_batch(uuid, numeric, text, uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.produce_prep_batch(uuid, numeric, text, uuid, text);
-- REVOKE EXECUTE ON FUNCTION public.caja_open(numeric, uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.caja_open(numeric, uuid, text);
-- -- Client call sites (useMutationOpenCaja / useMutationCreatePrepProduction)
-- -- must be reverted to direct table INSERTs (see git history for this file's
-- -- companion commits) before dropping these RPCs, or the app will break.
-- COMMIT;
-- =============================================================================
