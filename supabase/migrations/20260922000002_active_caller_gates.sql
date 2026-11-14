-- Active caller gates.
--
-- Six role-gated RPCs read the caller's role straight from profiles and so
-- did not notice a deactivated profile. Each body below is the live
-- definition with one change: the caller lookup requires is_active = true
-- (clear_must_change_pin gains that guard next to its existing AUTH check).
-- Signatures, SET clauses, security and volatility are unchanged.

CREATE OR REPLACE FUNCTION public.caja_open(p_opening_cash numeric, p_opened_by uuid, p_terminal_id text DEFAULT NULL::text)
 RETURNS caja_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role TEXT;
  v_row         caja_sessions;
  v_terminal    text;
BEGIN
  -- Permission check — same manager/admin gate the RLS INSERT policy enforced.
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Only managers and admins can open the caja.';
  END IF;

  v_terminal := COALESCE(NULLIF(trim(p_terminal_id), ''), 'POS-1');

  INSERT INTO caja_sessions (opening_cash, opened_by, terminal_id)
  VALUES (p_opening_cash, p_opened_by, v_terminal)
  RETURNING * INTO v_row;

  -- AUDIT: record successful caja open (Phase 14-04)
  PERFORM record_audit(
    'caja.open',
    'caja_session',
    v_row.id,
    NULL,
    to_jsonb(v_row),
    'rpc',
    v_terminal
  );

  RETURN v_row;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.clear_must_change_pin(p_new_pin text, p_terminal_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: active staff profile required';
  END IF;

  IF p_new_pin !~ '^\d{6}$' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: PIN must be exactly 6 digits';
  END IF;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles
  SET pin = p_new_pin,
      must_change_pin = false
  WHERE id = v_uid;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_after FROM profiles p WHERE p.id = v_uid;

  PERFORM record_audit(
    'permission.force_pin_change',
    'staff',
    v_uid,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.close_caja_session(p_caja_id uuid, p_closed_by uuid, p_closing_cash numeric, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row jsonb;
  v_opening_cash NUMERIC(12,2);
  v_cash_sales NUMERIC(12,2);
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'admin') THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Only managers and admins can close the caja.'
    ));
  END IF;

  IF p_closed_by IS DISTINCT FROM auth.uid() THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Caja close must be attributed to the authenticated caller.'
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
    closed_by = auth.uid(),
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

  SELECT COALESCE(SUM(p.amount), 0)
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
$function$
;

CREATE OR REPLACE FUNCTION public.close_tab(p_tab_id uuid, p_status tab_status, p_expected_version integer DEFAULT NULL::integer, p_terminal_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  WHERE id = auth.uid() AND role IN ('manager', 'admin') AND is_active = true;

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
$function$
;

CREATE OR REPLACE FUNCTION public.confirm_transfer_payment(p_payment_id uuid, p_entered_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id  uuid;
  v_transfer  record;
BEGIN
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin')
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  SELECT bt.*, p.reference_number INTO v_transfer
  FROM bank_transfers bt
  JOIN payments p ON p.id = bt.payment_id
  WHERE bt.payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no pending bank transfer for payment %', p_payment_id;
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PROCESSED: transfer already %', v_transfer.status;
  END IF;

  -- Luhn check strictly BEFORE the equality compare (D-08) — a mistyped code
  -- is rejected as "please re-enter," never silently compared and mismatched.
  IF NOT bank_transfer_is_valid_code(p_entered_code) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: entered code fails check-digit validation';
  END IF;

  IF p_entered_code IS DISTINCT FROM v_transfer.reference_number THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: entered code does not match this sale''s reference code';
  END IF;

  UPDATE bank_transfers
  SET status = 'confirmed', confirmed_by = v_staff_id, confirmed_at = now()
  WHERE payment_id = p_payment_id;

  PERFORM record_audit(
    'payment.transfer_confirmed',
    'payment',
    p_payment_id,
    to_jsonb(v_transfer),
    jsonb_build_object('status', 'confirmed', 'confirmedBy', v_staff_id),
    'rpc'
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.dispute_transfer_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id  uuid;
  v_transfer  record;
BEGIN
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin')
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  SELECT bt.*, p.reference_number INTO v_transfer
  FROM bank_transfers bt
  JOIN payments p ON p.id = bt.payment_id
  WHERE bt.payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no pending bank transfer for payment %', p_payment_id;
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PROCESSED: transfer already %', v_transfer.status;
  END IF;

  IF NULLIF(TRIM(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: dispute reason is required';
  END IF;

  UPDATE bank_transfers
  SET status = 'disputed', disputed_by = v_staff_id, disputed_at = now(), dispute_reason = TRIM(p_reason)
  WHERE payment_id = p_payment_id;

  PERFORM record_audit(
    'payment.transfer_disputed',
    'payment',
    p_payment_id,
    to_jsonb(v_transfer),
    jsonb_build_object('status', 'disputed', 'disputeReason', TRIM(p_reason)),
    'rpc'
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

NOTIFY pgrst, 'reload schema';
