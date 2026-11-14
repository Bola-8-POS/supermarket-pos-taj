-- Phase 29 (Plan 29-10): server-side role gate for the assistant's sales/caja summary.
--
-- Research Pitfall 1: get_caja_report(p_caja_id) runs as its owner and has no role check of its own,
-- so any authenticated session that knows a caja id can read the full report. The assistant must not become
-- a way around the role matrix (D-06 item 4, D-11), so it never calls get_caja_report directly. It calls this
-- wrapper, which requires an active profile whose role holds the `view_reports` action in role_permissions
-- (same join as adjust_inventory) and only then returns get_caja_report for the terminal's caja.
-- get_caja_report itself is unchanged.
--
-- Refusals are RETURNED as {ok:false, code}, not raised: the client classifies by code (L11/L12).
-- No new table, so no store_fence_guard.
CREATE OR REPLACE FUNCTION public.assistant_sales_summary(p_terminal_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_caja record;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles p
    JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_uid AND p.is_active = true AND rp.action = 'view_reports'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  -- Same shape as caja_sessions.terminal_id's CHECK and the client's TERMINAL_ID_PATTERN.
  IF p_terminal_id IS NULL OR p_terminal_id !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGUMENT');
  END IF;

  -- The terminal's open caja (at most one per terminal), else its most recently opened one.
  SELECT id, opened_at, closed_at INTO v_caja
  FROM caja_sessions
  WHERE terminal_id = p_terminal_id
  ORDER BY (status = 'open') DESC, opened_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CAJA');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'caja_id', v_caja.id,
    'opened_at', v_caja.opened_at,
    'closed_at', v_caja.closed_at,
    'report', get_caja_report(v_caja.id)::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_sales_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_sales_summary(text) TO authenticated, service_role;
