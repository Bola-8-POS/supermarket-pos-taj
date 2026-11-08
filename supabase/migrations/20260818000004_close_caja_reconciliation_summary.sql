-- Phase 04 Plan 03: return the payment-method cash reconciliation generated
-- by a successful caja close. Existing callers keep their `{ ok: true }`
-- contract; the added field is observational only.
BEGIN;

CREATE OR REPLACE FUNCTION close_caja_session(
  p_caja_id UUID,
  p_closed_by UUID,
  p_closing_cash NUMERIC(12,2),
  p_notes TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row jsonb;
  v_opening_cash NUMERIC(12,2);
  v_cash_sales NUMERIC(12,2);
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('manager', 'admin') THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Only managers and admins can close the caja.'
    ));
  END IF;

  SELECT COUNT(*) INTO v_open_tab_count
  FROM tabs
  WHERE caja_session_id = p_caja_id
    AND status = 'open'
    AND is_deleted = FALSE;

  IF v_open_tab_count > 0 THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'OPEN_TABS_EXIST',
      'message', format(
        'Cannot close the caja: %s tab(s) are still open. Close all tabs before closing the caja.',
        v_open_tab_count
      ),
      'openTabCount', v_open_tab_count
    ));
  END IF;

  SELECT to_jsonb(c), c.opening_cash
  INTO v_before_row, v_opening_cash
  FROM caja_sessions c
  WHERE c.id = p_caja_id;

  UPDATE caja_sessions
  SET
    closed_at = now(),
    closed_by = p_closed_by,
    closing_cash = p_closing_cash,
    notes = COALESCE(p_notes, notes),
    status = 'closed',
    version = version + 1
  WHERE id = p_caja_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND',
      'message', 'Caja session not found or already closed.'
    ));
  END IF;

  SELECT COALESCE(SUM(p.amount + p.tip_amount), 0)
  INTO v_cash_sales
  FROM payments p
  JOIN tabs t ON t.id = p.tab_id
  WHERE t.caja_session_id = p_caja_id
    AND t.is_deleted = FALSE
    AND p.method = 'cash'
    AND p.is_deleted = FALSE
    AND p.status IS DISTINCT FROM 'reopened_void';

  SELECT to_jsonb(c) INTO v_after_row FROM caja_sessions c WHERE c.id = p_caja_id;
  PERFORM record_audit('caja.close', 'caja_session', p_caja_id, v_before_row, v_after_row, 'rpc');

  RETURN json_build_object(
    'ok', true,
    'cashReconciliation', json_build_object(
      'openingCash', v_opening_cash,
      'cashSales', v_cash_sales,
      'expectedCash', v_opening_cash + v_cash_sales,
      'closingCash', p_closing_cash,
      'variance', p_closing_cash - (v_opening_cash + v_cash_sales)
    )
  );
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
