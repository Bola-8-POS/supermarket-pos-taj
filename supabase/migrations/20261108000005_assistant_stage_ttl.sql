-- Phase 29 review WR-02 (a fix to an applied migration goes in a new file).
--
-- assistant_stage returned only the absolute expires_at, which the till compared with its own clock: a till clock
-- two minutes or more fast expired every preview on its first render, a slow one left Confirm enabled after the
-- server window closed. It now also returns expires_in_seconds (the server's own remaining window at staging time)
-- so the client counts down from the moment the reply arrives and never compares a server timestamp with Date.now().
-- Redefined whole from 20261108000002 (only the RETURN changes); CREATE OR REPLACE keeps the grants.
CREATE OR REPLACE FUNCTION public.assistant_stage(
  p_kind text,
  p_items jsonb,
  p_reason text,
  p_terminal_id text,
  p_model text,
  p_policy_version text,
  p_prompt_version text,
  p_raw_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_uid uuid := auth.uid();
  v_until timestamptz;
  v_kind text;
  v_action text;
  v_text text := btrim(COALESCE(p_raw_text, ''));
  v_item jsonb;
  v_pid uuid;
  v_seen uuid[] := '{}';
  v_name text;
  v_qty int;
  v_delta int;
  v_exp int;
  v_price numeric;
  v_cur_price numeric;
  v_exp_price numeric;
  v_cur_upd timestamptz;
  v_exp_upd timestamptz;
  v_items jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_hash text;
  v_id uuid := gen_random_uuid();
  v_expires timestamptz := now() + interval '2 minutes';
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  v_until := public.assistant_lock_state(v_uid);
  IF v_until IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ASSISTANT_LOCKED', 'until', v_until);
  END IF;

  v_kind := CASE WHEN p_kind IN ('inventory.adjust', 'product.price') THEN p_kind END;
  IF v_kind IS NULL THEN
    RETURN public.assistant_deny('INVALID_PROPOSAL', NULL, NULL, NULL);
  END IF;
  v_action := CASE v_kind WHEN 'inventory.adjust' THEN 'adjust_inventory' ELSE 'manage_products' END;

  -- D-11: the requester's own role must hold the action; the approver's PIN never substitutes for it.
  IF NOT EXISTS (
    SELECT 1 FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_uid AND p.is_active = true AND rp.action = v_action
  ) THEN
    RETURN public.assistant_deny('AUTH_FORBIDDEN', v_kind, NULL, NULL);
  END IF;

  IF p_terminal_id IS NULL OR p_terminal_id !~ '^[A-Za-z0-9_-]{1,32}$'
     OR COALESCE(p_model, '') !~ '^[A-Za-z0-9_.@:+/-]{1,120}$'
     OR COALESCE(p_policy_version, '') !~ '^[A-Za-z0-9_.-]{1,60}$'
     OR COALESCE(p_prompt_version, '') !~ '^[A-Za-z0-9_.-]{1,60}$'
     OR char_length(v_text) NOT BETWEEN 1 AND 500
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) < 1
     OR (v_kind = 'inventory.adjust' AND (p_reason IS NULL OR p_reason NOT IN ('waste', 'correction', 'manual_adjustment')))
     OR (v_kind = 'product.price' AND p_reason IS NOT NULL AND p_reason !~ '^[a-z_]{1,40}$') THEN
    RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, CASE WHEN p_terminal_id ~ '^[A-Za-z0-9_-]{1,32}$' THEN p_terminal_id END);
  END IF;

  IF jsonb_array_length(p_items) > 25 THEN
    RETURN public.assistant_deny('TOO_MANY_ITEMS', v_kind, NULL, p_terminal_id);
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord LOOP
    IF jsonb_typeof(v_item) <> 'object' OR COALESCE(v_item->>'product_id', '') !~* c_uuid THEN
      RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
    END IF;
    v_pid := (v_item->>'product_id')::uuid;
    IF v_pid = ANY (v_seen) THEN
      RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
    END IF;
    v_seen := v_seen || v_pid;

    IF v_kind = 'inventory.adjust' THEN
      IF COALESCE(v_item->>'delta', '') !~ '^-?[1-9][0-9]{0,3}$'
         OR COALESCE(v_item->>'expected_quantity', '') !~ '^[0-9]{1,9}$' THEN
        RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
      END IF;
      v_delta := (v_item->>'delta')::int;
      v_exp := (v_item->>'expected_quantity')::int;

      SELECT i.quantity_on_hand, p.name INTO v_qty, v_name
      FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = v_pid AND p.is_active = true;
      IF NOT FOUND THEN
        RETURN public.assistant_deny('NOT_FOUND', v_kind, NULL, p_terminal_id);
      END IF;
      IF v_qty <> v_exp THEN
        RETURN public.assistant_deny('STALE_TARGET', v_kind, NULL, p_terminal_id);
      END IF;
      IF v_qty + v_delta < 0 THEN
        RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
      END IF;
      v_items := v_items || jsonb_build_object('product_id', v_pid, 'name', v_name, 'before', v_qty, 'after', v_qty + v_delta);
    ELSE
      IF COALESCE(v_item->>'price', '') !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$'
         OR COALESCE(v_item->>'expected_price', '') !~ '^[0-9]{1,6}(\.[0-9]{1,4})?$'
         OR COALESCE(v_item->>'expected_updated_at', '') !~ '^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?$' THEN
        RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
      END IF;
      v_price := (v_item->>'price')::numeric;
      v_exp_price := (v_item->>'expected_price')::numeric;
      IF v_price <= 0 OR v_price > 100000 THEN
        RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
      END IF;
      BEGIN
        v_exp_upd := (v_item->>'expected_updated_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RETURN public.assistant_deny('INVALID_PROPOSAL', v_kind, NULL, p_terminal_id);
      END;

      SELECT p.base_price, p.updated_at, p.name INTO v_cur_price, v_cur_upd, v_name
      FROM products p WHERE p.id = v_pid AND p.is_active = true;
      IF NOT FOUND THEN
        RETURN public.assistant_deny('NOT_FOUND', v_kind, NULL, p_terminal_id);
      END IF;
      IF v_cur_price <> v_exp_price OR v_cur_upd <> v_exp_upd THEN
        RETURN public.assistant_deny('STALE_TARGET', v_kind, NULL, p_terminal_id);
      END IF;
      v_items := v_items || jsonb_build_object(
        'product_id', v_pid, 'name', v_name, 'before', v_cur_price, 'after', v_price, 'expected_updated_at', v_cur_upd);
    END IF;
  END LOOP;

  v_payload := jsonb_build_object('kind', v_kind, 'reason', p_reason, 'items', v_items);
  v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

  INSERT INTO assistant_proposals (
    id, requester_id, kind, action, reason, payload, payload_hash, item_count, terminal_id,
    model, policy_version, prompt_version, status, expires_at
  ) VALUES (
    v_id, v_uid, v_kind, v_action, p_reason, v_payload, v_hash, jsonb_array_length(v_items), p_terminal_id,
    p_model, p_policy_version, p_prompt_version, 'staged', v_expires
  );
  INSERT INTO assistant_proposal_texts (proposal_id, raw_text) VALUES (v_id, v_text);

  PERFORM public.assistant_audit(
    'assistant.staged', v_id,
    jsonb_build_object('kind', v_kind, 'item_count', jsonb_array_length(v_items), 'payload_hash', v_hash, 'expires_at', v_expires),
    p_terminal_id);

  RETURN jsonb_build_object(
    'ok', true, 'proposal_id', v_id, 'payload_hash', v_hash, 'expires_at', v_expires,
    'expires_in_seconds', floor(extract(epoch FROM (v_expires - now())))::int, 'items', v_items);
END;
$$;
