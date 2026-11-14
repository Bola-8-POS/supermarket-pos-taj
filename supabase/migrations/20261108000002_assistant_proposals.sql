-- Phase 29 (Plan 29-03): server-side approval contract for the local assistant's write proposals.
--
-- The assistant (a local LLM) only ever PROPOSES. A write is staged here, previewed item by item, approved with a
-- manager/admin PIN ticket and executed by the server in one RPC. manager_approvals alone binds only caller + action;
-- assistant_proposals adds the rest of the AI-SPEC guarantee: payload-, actor-, terminal- and time-bound, single use.
--
--   assistant_stage   -> validates and stores the batch (2-minute lifetime, <= 25 items), returns the server preview
--   assistant_approve -> locks the row, re-checks every binding, consumes the PIN ticket, runs adjust_inventory per
--                        item in ONE subtransaction (all or nothing)
--   assistant_finish  -> verifies a price batch the client applied (Plan 29-05) against live products
--   assistant_cancel  -> requester cancels or lets a staged proposal expire
--   assistant_gate / assistant_record_rejection -> server cool-down: 5 refusals/denials in 10 minutes lock the
--                        assistant for that staff user for 10 minutes. Checkout RPCs are never touched.
--
-- Every refusal is RETURNED as {ok:false, code} (never RAISEd after an audit insert), so the audit row survives and
-- the client classifies by code. Audit rows are written only by the definer helper assistant_audit; record_audit
-- (carried whole below from 20261009000012) refuses the reserved 'assistant' namespace for every non-service caller.
--
-- Production note (L44): record_audit is redefined here. Diff the LIVE production definition against
-- 20261009000012 before any production push; the push needs the owner's go (release step, Plan 29-09 runbook).
-- New tables carry the store_fence_guard statement trigger (a frozen or moved store accepts no assistant writes).

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.assistant_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   uuid NOT NULL REFERENCES public.profiles (id),
  approver_id    uuid REFERENCES public.profiles (id),
  kind           text NOT NULL CHECK (kind IN ('inventory.adjust', 'product.price')),
  action         text NOT NULL,
  reason         text,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  item_count     int NOT NULL CHECK (item_count BETWEEN 1 AND 25),
  terminal_id    text NOT NULL,
  model          text NOT NULL,
  policy_version text NOT NULL,
  prompt_version text NOT NULL,
  status         text NOT NULL DEFAULT 'staged'
                 CHECK (status IN ('staged', 'executing', 'executed', 'partial', 'failed', 'expired', 'cancelled', 'outcome_unknown')),
  outcome        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  approved_at    timestamptz,
  finished_at    timestamptz
);

-- D-17: the raw text of a write request lives apart from the audit trail, readable by admins only.
CREATE TABLE public.assistant_proposal_texts (
  proposal_id uuid PRIMARY KEY REFERENCES public.assistant_proposals (id) ON DELETE CASCADE,
  raw_text    text NOT NULL CHECK (char_length(raw_text) BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.assistant_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_proposal_texts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.assistant_proposals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.assistant_proposal_texts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.assistant_proposals TO service_role;
GRANT ALL ON public.assistant_proposal_texts TO service_role;

GRANT SELECT ON public.assistant_proposal_texts TO authenticated;
CREATE POLICY assistant_proposal_texts_select_admin
  ON public.assistant_proposal_texts FOR SELECT TO authenticated
  USING (public.get_user_role() = 'admin');

CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.assistant_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard();
CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.assistant_proposal_texts
  FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard();

CREATE INDEX assistant_proposals_requester_idx ON public.assistant_proposals (requester_id, created_at);
CREATE INDEX audit_logs_assistant_actor_idx ON public.audit_logs (actor_id, created_at) WHERE action LIKE 'assistant.%';

-- ---------------------------------------------------------------------------
-- 2. record_audit, carried whole from 20261009000012 (L13). Only change: a non-service caller may not write any
--    action that reads as 'assistant' anywhere in its letters (assistant.* rows come from the definer helpers only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid DEFAULT NULL::uuid,
  p_before jsonb DEFAULT NULL::jsonb,
  p_after jsonb DEFAULT NULL::jsonb,
  p_source text DEFAULT 'rpc'::text,
  p_terminal_id text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor_id   uuid;
  v_before     jsonb;
  v_after      jsonb;
  v_log_id     uuid;
BEGIN
  v_before := public.audit_redact(p_before);
  v_after := public.audit_redact(p_after);

  -- Only the service role may name the actor (trusted server paths); every
  -- other caller is recorded as the authenticated user.
  -- A plain database session without JWT claims (auth.role() NULL) gets a NULL actor.
  IF auth.role() = 'service_role' THEN
    v_actor_id := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor_id := auth.uid();

  END IF;

  -- Truncate oversized payloads (>64KB) with marker
  IF pg_column_size(v_before) > 65536 THEN
    v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;
  IF pg_column_size(v_after) > 65536 THEN
    v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;

  -- Non-service callers: action names are lower-case [a-z0-9_.] only, and the
  -- server's offline-sale and assistant namespaces (any spelling that reads as them, anywhere in the name) are
  -- reserved, except the three offline rows the client still writes. Evaluated on the stored
  -- (post-truncation) payload so padding cannot carry an allowed resolution.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF p_action !~ '^[a-z0-9_.]+$'
       OR regexp_replace(p_action, '[^a-z]', '', 'g') LIKE '%assistant%'
       OR (regexp_replace(p_action, '[^a-z]', '', 'g') LIKE '%offlinesale%'
           AND NOT (p_action = 'offline_sale_needs_review'
                    OR (p_action = 'offline_sale_resolved'
                        AND COALESCE(v_after->>'resolution', '') IN ('rering', 'confirmed_after_retry')))) THEN
      RAISE WARNING 'record_audit refused reserved or malformed action %', p_action;
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source, terminal_id)
  VALUES (v_actor_id, p_action, p_entity_type, p_entity_id, v_before, v_after, p_source, p_terminal_id)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- Audit failure must NEVER fail the primary action
  -- Log to PostgreSQL server log for DBA visibility
  RAISE WARNING 'record_audit failed: % %', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no EXECUTE for clients). Definer-to-definer calls need no caller grant.
-- ---------------------------------------------------------------------------

-- The only writer of assistant.* audit rows. Actor is always the caller; a failure here fails the RPC (fail closed).
CREATE FUNCTION public.assistant_audit(p_action text, p_entity_id uuid, p_after jsonb, p_terminal text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source, terminal_id)
  VALUES (
    auth.uid(), p_action, 'assistant_proposal', p_entity_id, NULL,
    public.audit_redact(COALESCE(p_after, '{}'::jsonb) || jsonb_build_object('origin', 'local_assistant')),
    'rpc', p_terminal
  );
END;
$$;

-- Locked while the latest assistant.locked row of the actor names a time in the future; returns that time or NULL.
CREATE FUNCTION public.assistant_lock_state(p_uid uuid)
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.lock_until FROM (
    SELECT (a.after->>'until')::timestamptz AS lock_until
    FROM public.audit_logs a
    WHERE a.actor_id = p_uid AND a.action = 'assistant.locked' AND a.action LIKE 'assistant.%'
    ORDER BY a.created_at DESC
    LIMIT 1
  ) l
  WHERE l.lock_until > now();
$$;

-- Records one refusal/denial row (reason code and kind only, never text) and applies the cool-down (D-15):
-- 5 rows in 10 minutes lock the actor for 10 minutes. While locked nothing more is inserted.
CREATE FUNCTION public.assistant_reject(p_action text, p_code text, p_kind text, p_entity_id uuid, p_terminal text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_max_rejections CONSTANT int := 5;
  c_window CONSTANT interval := interval '10 minutes';
  c_lock CONSTANT interval := interval '10 minutes';
  v_uid uuid := auth.uid();
  v_until timestamptz;
  v_count int;
BEGIN
  v_until := public.assistant_lock_state(v_uid);
  IF v_until IS NOT NULL THEN
    RETURN jsonb_build_object('locked', true, 'until', v_until);
  END IF;

  PERFORM public.assistant_audit(p_action, p_entity_id, jsonb_build_object('code', p_code, 'kind', p_kind), p_terminal);

  SELECT count(*) INTO v_count
  FROM audit_logs a
  WHERE a.actor_id = v_uid AND a.action LIKE 'assistant.%'
    AND a.action IN ('assistant.rejected', 'assistant.denied')
    AND a.created_at > now() - c_window;

  IF v_count >= c_max_rejections THEN
    v_until := now() + c_lock;
    PERFORM public.assistant_audit('assistant.locked', NULL, jsonb_build_object('until', v_until, 'count', v_count), p_terminal);
    RETURN jsonb_build_object('locked', true, 'until', v_until);
  END IF;
  RETURN jsonb_build_object('locked', false, 'until', NULL);
END;
$$;

-- A server-side refusal: counted as a denial, returned as a coded result.
CREATE FUNCTION public.assistant_deny(p_code text, p_kind text, p_entity_id uuid, p_terminal text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assistant_reject('assistant.denied', p_code, p_kind, p_entity_id, p_terminal);
  RETURN jsonb_build_object('ok', false, 'code', p_code);
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_audit(text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assistant_lock_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assistant_reject(text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assistant_deny(text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. assistant_record_rejection: the client reports a refusal it decided itself (screen, model refusal, invalid
--    proposal, client role denial). Reason and kind are shape-checked codes, never free text.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_record_rejection(p_reason text, p_kind text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;
  IF p_reason IS NULL OR p_reason !~ '^[a-z_]{1,40}$' OR (p_kind IS NOT NULL AND p_kind !~ '^[a-z.]{1,40}$') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PROPOSAL');
  END IF;
  v_res := public.assistant_reject('assistant.rejected', p_reason, p_kind, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'locked', (v_res->>'locked')::boolean, 'until', v_res->'until');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. assistant_gate: lock state, plus reconcile the caller's own stale rows.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_gate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row record;
  v_until timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  FOR v_row IN
    SELECT id, terminal_id FROM assistant_proposals
    WHERE requester_id = v_uid AND status = 'staged' AND expires_at <= now()
    FOR UPDATE
  LOOP
    UPDATE assistant_proposals SET status = 'expired', finished_at = now() WHERE id = v_row.id;
    PERFORM public.assistant_audit('assistant.expired', v_row.id, '{}'::jsonb, v_row.terminal_id);
  END LOOP;

  -- An execution that never reported back (crash, lost connection) is surfaced, never silently retried.
  FOR v_row IN
    SELECT id, terminal_id FROM assistant_proposals
    WHERE requester_id = v_uid AND status = 'executing' AND approved_at < now() - interval '10 minutes'
    FOR UPDATE
  LOOP
    UPDATE assistant_proposals SET status = 'outcome_unknown', finished_at = now() WHERE id = v_row.id;
    PERFORM public.assistant_audit('assistant.outcome_unknown', v_row.id, '{}'::jsonb, v_row.terminal_id);
  END LOOP;

  v_until := public.assistant_lock_state(v_uid);
  RETURN jsonb_build_object('ok', true, 'locked', v_until IS NOT NULL, 'until', v_until);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. assistant_stage
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_stage(
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

  RETURN jsonb_build_object('ok', true, 'proposal_id', v_id, 'payload_hash', v_hash, 'expires_at', v_expires, 'items', v_items);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. assistant_approve
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_approve(
  p_proposal_id uuid,
  p_payload_hash text,
  p_approval_id uuid,
  p_approver_id uuid,
  p_terminal_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p assistant_proposals%ROWTYPE;
  v_res jsonb;
  v_approver uuid;
  v_item jsonb;
  v_n int;
  v_results jsonb := '[]'::jsonb;
  v_after int;
  v_code text;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  SELECT * INTO v_p FROM assistant_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_p.requester_id <> v_uid THEN
    RETURN public.assistant_deny('NOT_OWNER', v_p.kind, p_proposal_id, p_terminal_id);
  END IF;
  IF v_p.status <> 'staged' THEN
    RETURN public.assistant_deny('ALREADY_USED', v_p.kind, p_proposal_id, v_p.terminal_id);
  END IF;
  IF now() >= v_p.expires_at THEN
    UPDATE assistant_proposals SET status = 'expired', finished_at = now() WHERE id = v_p.id;
    PERFORM public.assistant_audit('assistant.expired', v_p.id, '{}'::jsonb, v_p.terminal_id);
    RETURN jsonb_build_object('ok', false, 'code', 'PROPOSAL_EXPIRED');
  END IF;
  IF p_terminal_id IS DISTINCT FROM v_p.terminal_id THEN
    RETURN public.assistant_deny('TERMINAL_MISMATCH', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;
  IF p_payload_hash IS DISTINCT FROM v_p.payload_hash THEN
    RETURN public.assistant_deny('PAYLOAD_MISMATCH', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;
  IF public.assistant_lock_state(v_uid) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ASSISTANT_LOCKED', 'until', public.assistant_lock_state(v_uid));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_uid AND p.is_active = true AND rp.action = v_p.action
  ) THEN
    RETURN public.assistant_deny('AUTH_FORBIDDEN', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;

  -- The PIN ticket is bound to this caller and this action and is consumed here (single use).
  v_res := public.resolve_manager_approval(p_approval_id, p_approver_id, v_p.action, v_uid);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN public.assistant_deny(COALESCE(v_res->>'code', 'INVALID_APPROVAL'), v_p.kind, v_p.id, v_p.terminal_id);
  END IF;
  v_approver := (v_res->>'approver_id')::uuid;

  -- D-12: the matrix decides who may hold the action; for the assistant the approver must also be a manager or admin.
  IF NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.id = v_approver AND p.is_active = true AND p.role::text IN ('manager', 'admin')
  ) THEN
    RETURN public.assistant_deny('APPROVER_NOT_MANAGER', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;

  UPDATE assistant_proposals
     SET approver_id = v_approver, approved_at = now(), status = 'executing'
   WHERE id = v_p.id;
  PERFORM public.assistant_audit(
    'assistant.approved', v_p.id,
    jsonb_build_object('kind', v_p.kind, 'requester_id', v_p.requester_id, 'approver_id', v_approver,
                       'self_approved', v_approver = v_p.requester_id),
    v_p.terminal_id);

  IF v_p.kind = 'product.price' THEN
    -- Plan 29-05: the client applies the prices through the existing product update, then calls assistant_finish.
    RETURN jsonb_build_object('ok', true, 'status', 'executing', 'items', v_p.payload->'items');
  END IF;

  -- inventory.adjust: every item through adjust_inventory inside one subtransaction. Any exception
  -- (STOCK_CHANGED, NOT_FOUND, AUTH_FORBIDDEN, ...) rolls back every item; the status/audit writes below survive.
  BEGIN
    FOR v_item, v_n IN
      SELECT e.value, e.ord::int FROM jsonb_array_elements(v_p.payload->'items') WITH ORDINALITY AS e(value, ord) ORDER BY e.ord
    LOOP
      v_res := public.adjust_inventory(
        (v_item->>'product_id')::uuid,
        (v_item->>'after')::int - (v_item->>'before')::int,
        v_p.payload->>'reason',
        'assistant ' || v_p.id::text,
        (v_item->>'before')::int,
        v_p.id::text || ':' || v_n::text);
      v_after := (v_res->>'quantityOnHand')::int;
      v_results := v_results || jsonb_build_object(
        'product_id', v_item->>'product_id', 'name', v_item->>'name', 'before', (v_item->>'before')::int, 'after', v_after);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_code := split_part(SQLERRM, ':', 1);
    IF v_code !~ '^[A-Z_]{3,40}$' THEN
      v_code := 'EXECUTION_FAILED';
    END IF;
    UPDATE assistant_proposals
       SET status = 'failed', finished_at = now(), outcome = jsonb_build_object('code', v_code)
     WHERE id = v_p.id;
    PERFORM public.assistant_audit('assistant.failed', v_p.id, jsonb_build_object('kind', v_p.kind, 'code', v_code), v_p.terminal_id);
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'status', 'failed');
  END;

  UPDATE assistant_proposals
     SET status = 'executed', finished_at = now(), outcome = jsonb_build_object('items', v_results)
   WHERE id = v_p.id;
  PERFORM public.assistant_audit(
    'assistant.executed', v_p.id,
    jsonb_build_object('kind', v_p.kind, 'requester_id', v_p.requester_id, 'approver_id', v_approver, 'items', v_results),
    v_p.terminal_id);

  RETURN jsonb_build_object('ok', true, 'status', 'executed', 'items', v_results);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. assistant_finish: the server verifies what a price batch really did (the client's word is not evidence).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_finish(p_proposal_id uuid, p_outcome jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p assistant_proposals%ROWTYPE;
  v_item jsonb;
  v_cur numeric;
  v_state text;
  v_results jsonb := '[]'::jsonb;
  v_applied int := 0;
  v_status text;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;
  SELECT * INTO v_p FROM assistant_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_p.requester_id <> v_uid THEN
    RETURN public.assistant_deny('NOT_OWNER', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;
  IF v_p.kind <> 'product.price' OR v_p.status <> 'executing' THEN
    RETURN public.assistant_deny('ALREADY_USED', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_p.payload->'items') AS e(value) LOOP
    SELECT p.base_price INTO v_cur FROM products p WHERE p.id = (v_item->>'product_id')::uuid;
    v_state := CASE
      WHEN v_cur = (v_item->>'after')::numeric THEN 'applied'
      WHEN v_cur = (v_item->>'before')::numeric THEN 'stale'
      ELSE 'mismatch' END;
    IF v_state = 'applied' THEN v_applied := v_applied + 1; END IF;
    v_results := v_results || jsonb_build_object(
      'product_id', v_item->>'product_id', 'name', v_item->>'name',
      'before', (v_item->>'before')::numeric, 'after', (v_item->>'after')::numeric, 'result', v_state);
  END LOOP;

  v_status := CASE WHEN v_applied = v_p.item_count THEN 'executed' WHEN v_applied = 0 THEN 'failed' ELSE 'partial' END;
  UPDATE assistant_proposals
     SET status = v_status, finished_at = now(), outcome = jsonb_build_object('items', v_results)
   WHERE id = v_p.id;
  PERFORM public.assistant_audit(
    'assistant.' || v_status, v_p.id,
    jsonb_build_object('kind', v_p.kind, 'requester_id', v_p.requester_id, 'approver_id', v_p.approver_id, 'items', v_results),
    v_p.terminal_id);
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'items', v_results);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. assistant_cancel: the requester drops a staged proposal ('expired' when the preview ran out of time).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assistant_cancel(p_proposal_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p assistant_proposals%ROWTYPE;
  v_status text;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('expired', 'user') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PROPOSAL');
  END IF;
  SELECT * INTO v_p FROM assistant_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_p.requester_id <> v_uid THEN
    RETURN public.assistant_deny('NOT_OWNER', v_p.kind, v_p.id, v_p.terminal_id);
  END IF;
  IF v_p.status <> 'staged' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_USED');
  END IF;
  v_status := CASE p_reason WHEN 'expired' THEN 'expired' ELSE 'cancelled' END;
  UPDATE assistant_proposals SET status = v_status, finished_at = now() WHERE id = v_p.id;
  PERFORM public.assistant_audit('assistant.' || v_status, v_p.id, jsonb_build_object('kind', v_p.kind), v_p.terminal_id);
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: clients reach the contract only through these RPCs.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.assistant_record_rejection(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_gate() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_stage(text, jsonb, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_approve(uuid, text, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_finish(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assistant_cancel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_record_rejection(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_gate() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_stage(text, jsonb, text, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_approve(uuid, text, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_finish(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_cancel(uuid, text) TO authenticated, service_role;
