-- two-mode Plan 02c, Task 2 (Rulings 2-7, 9): resolve_offline_sale.
--
-- One definer function through which a manager's resolution of an offline sale
-- (write-off, re-ring approval, move to review) is decided and recorded. The
-- server never saw the sale, so everything the till says is stored under
-- `claimed`; actor, approver, ticket, lookup result and server amount are
-- server-derived. The online approval ticket is spent in the same transaction
-- as the audit insert (resolve_approval_ticket, never an offline grant).
--
-- Contents:
--  (a) payments_idempotency_key_pattern_idx: the rering_<sale>_ prefix lookup;
--  (b) audit_logs_offline_sale_written_off_uq: one write-off row per sale;
--  (c) offline_sale_goods_match / offline_sale_stored_outcome: private helpers;
--  (d) resolve_offline_sale itself.

CREATE INDEX IF NOT EXISTS payments_idempotency_key_pattern_idx
  ON public.payments (idempotency_key varchar_pattern_ops);

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_offline_sale_written_off_uq
  ON public.audit_logs (entity_id) WHERE action = 'offline_sale.written_off';

-- Does the tab's non-deleted top-level order_items tally equal p_lines? The tally is
-- quantity per (product, sorted modifiers, weight), as src/entities/offline-sale/model/goods.ts.
CREATE OR REPLACE FUNCTION public.offline_sale_goods_match(p_tab_id uuid, p_lines jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH want AS (
    SELECT (e->>'product_id') || '|'
           || COALESCE((SELECT string_agg(m, ',' ORDER BY m) FROM jsonb_array_elements_text(COALESCE(e->'modifier_ids', '[]'::jsonb)) AS t(m)), '')
           || '|' || COALESCE(NULLIF(e->>'weight_grams', ''), '') AS k,
           SUM((e->>'quantity')::numeric) AS q
    FROM jsonb_array_elements(p_lines) AS e
    GROUP BY 1
  ), have AS (
    SELECT oi.product_id::text || '|'
           || COALESCE((SELECT string_agg(m::text, ',' ORDER BY m::text) FROM unnest(oi.modifier_ids) AS m), '')
           || '|' || COALESCE(oi.weight_grams::text, '') AS k,
           SUM(oi.quantity)::numeric AS q
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false
    GROUP BY 1
  )
  SELECT NOT EXISTS (
    (SELECT k, q FROM want EXCEPT SELECT k, q FROM have)
    UNION ALL
    (SELECT k, q FROM have EXCEPT SELECT k, q FROM want)
  );
$$;

-- The stored answer of an earlier call: (a) same sale, same caller, same ticket, any
-- server row; (b) when p_any_written_off, the sale's write-off row whatever the ticket.
CREATE OR REPLACE FUNCTION public.offline_sale_stored_outcome(p_sale_id uuid, p_actor uuid, p_approval_id uuid, p_any_written_off boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.audit_logs%ROWTYPE;
BEGIN
  IF p_approval_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.audit_logs a
     WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id AND a.actor_id = p_actor
       AND left(a.action, 13) = 'offline_sale.' AND a.after->>'approvalId' = p_approval_id::text
     ORDER BY a.created_at, a.id LIMIT 1;
  END IF;
  IF v_row.id IS NULL AND p_any_written_off THEN
    SELECT * INTO v_row FROM public.audit_logs a
     WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id AND a.action = 'offline_sale.written_off'
     LIMIT 1;
  END IF;
  IF v_row.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true, 'outcome', v_row.after->>'outcome', 'tabId', v_row.after->>'linkedTabId',
    'approverId', v_row.after->>'approverId', 'auditId', v_row.id, 'idempotent', true));
END;
$$;

REVOKE ALL ON FUNCTION public.offline_sale_goods_match(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.offline_sale_stored_outcome(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_offline_sale(
  p_intent text,
  p_sale_id uuid,
  p_idempotency_key text,
  p_rering_keys text[],
  p_lines jsonb,
  p_seller_id uuid,
  p_recorded_tab_id uuid,
  p_claim jsonb,
  p_reason text,
  p_approval_id uuid,
  p_approver_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_key       text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_rkeys     text[] := COALESCE(p_rering_keys, ARRAY[]::text[]);
  v_prior     jsonb;
  v_ticket    jsonb;
  v_approver  uuid;
  v_pay_tab   uuid;
  v_pay_by    uuid;
  v_found     boolean := false;
  v_kind      text;            -- held | twin | none | cashier | tab | goods | attempt | claimed
  v_tab       uuid;            -- the server tab the lookup settled on
  v_since     timestamptz;
  v_cands     integer;
  v_outcome   text;
  v_action    text;
  v_audit_id  uuid;
  v_amount    numeric;
  v_all_keys  text[];
  v_claim     jsonb := COALESCE(p_claim, '{}'::jsonb);
BEGIN
  -- 1. Caller.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND is_active) THEN
    RAISE EXCEPTION 'FORBIDDEN: inactive or unknown staff member';
  END IF;

  -- 2. Validation.
  IF p_intent IS NULL OR p_intent NOT IN ('write_off', 'rering', 'review') OR p_sale_id IS NULL
     OR (p_intent = 'write_off' AND (p_reason IS NULL OR char_length(btrim(p_reason)) < 10))
     OR char_length(COALESCE(p_reason, '')) > 500
     OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200
     OR cardinality(v_rkeys) > 20
     OR jsonb_typeof(v_claim) IS DISTINCT FROM 'object'
     OR octet_length(v_claim::text) > 4096
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_lines) AS e
       WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
          OR (e->>'product_id') IS NULL
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') IS NULL OR (e->>'quantity') !~ '^[0-9]+(\.[0-9]+)?$'
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
  END IF;

  -- 3. Replay, before the ticket.
  v_prior := public.offline_sale_stored_outcome(p_sale_id, v_uid, p_approval_id, p_intent = 'write_off');
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;

  BEGIN
    -- 4. Ticket (online tickets only). A double tap waits here on the ticket row lock.
    v_ticket := public.resolve_approval_ticket(p_approval_id, p_approver_id, 'resolve_offline_sale', v_uid);
    IF NOT COALESCE((v_ticket->>'ok')::boolean, false) THEN
      v_prior := public.offline_sale_stored_outcome(p_sale_id, v_uid, p_approval_id, p_intent = 'write_off');
      IF v_prior IS NOT NULL THEN
        RETURN v_prior;
      END IF;
      RETURN jsonb_build_object('ok', false, 'code', v_ticket->>'code');
    END IF;
    v_approver := (v_ticket->>'approver_id')::uuid;

    -- 5. Lookup, as definer. Held: a payment under the key (or its -leg0).
    v_kind := 'none';
    IF v_key IS NOT NULL THEN
      SELECT p.tab_id, p.processed_by INTO v_pay_tab, v_pay_by
        FROM public.payments p
       WHERE p.idempotency_key IN (v_key, v_key || '-leg0') AND NOT p.is_refund AND NOT p.is_deleted
       ORDER BY p.processed_at, p.id LIMIT 1;
      v_found := FOUND;
    END IF;
    IF v_found THEN
      v_tab := v_pay_tab;
      v_kind := CASE
        WHEN v_pay_by IS DISTINCT FROM p_seller_id THEN 'cashier'
        WHEN p_recorded_tab_id IS NOT NULL AND p_recorded_tab_id IS DISTINCT FROM v_pay_tab THEN 'tab'
        WHEN NOT public.offline_sale_goods_match(v_pay_tab, p_lines) THEN 'goods'
        ELSE 'held' END;
    ELSIF p_recorded_tab_id IS NOT NULL THEN
      v_kind := 'tab';
    ELSIF p_intent <> 'review' THEN
      -- Twin: a re-ring paid after the earliest rering_approved row for this sale.
      SELECT min(a.created_at) INTO v_since FROM public.audit_logs a
       WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id AND a.action = 'offline_sale.rering_approved';
      SELECT COALESCE(array_agg(k) || array_agg(k || '-leg0'), ARRAY[]::text[]) INTO v_all_keys FROM unnest(v_rkeys) AS k;
      SELECT count(*) INTO v_cands FROM public.payments p
       WHERE NOT p.is_refund AND NOT p.is_deleted
         AND (p.idempotency_key = ANY (v_all_keys) OR p.idempotency_key LIKE ('rering\_' || p_sale_id::text || '\_%'));
      IF v_cands > 0 THEN
        v_kind := 'attempt';
        IF v_since IS NOT NULL THEN
          SELECT p.tab_id INTO v_tab FROM public.payments p
           WHERE NOT p.is_refund AND NOT p.is_deleted AND p.processed_at > v_since
             AND (p.idempotency_key = ANY (v_all_keys) OR p.idempotency_key LIKE ('rering\_' || p_sale_id::text || '\_%'))
             AND public.offline_sale_goods_match(p.tab_id, p_lines)
           ORDER BY p.processed_at, p.id LIMIT 1;
          IF FOUND THEN
            v_kind := 'twin';
          END IF;
        END IF;
      END IF;
    END IF;

    -- Claimed: a held or twin tab already named as linked by another offline sale.
    IF v_kind IN ('held', 'twin') AND EXISTS (
      SELECT 1 FROM public.audit_logs a
       WHERE a.entity_type = 'offline_sale' AND a.action = 'offline_sale.linked'
         AND a.entity_id <> p_sale_id AND a.after->>'linkedTabId' = v_tab::text
    ) THEN
      v_kind := 'claimed';
    END IF;

    -- 6. Outcome.
    IF v_kind IN ('held', 'twin') THEN
      v_outcome := CASE v_kind WHEN 'held' THEN 'already_recorded' ELSE 'already_rerung' END;
      v_action := 'offline_sale.linked';
    ELSIF v_kind = 'none' OR p_intent = 'write_off' THEN
      v_outcome := CASE p_intent WHEN 'write_off' THEN 'written_off' WHEN 'rering' THEN 'proceed' ELSE 'moved_to_review' END;
      v_action := CASE p_intent WHEN 'write_off' THEN 'offline_sale.written_off' WHEN 'rering' THEN 'offline_sale.rering_approved' ELSE 'offline_sale.escalated' END;
    ELSE
      -- Raised, so the ticket spend rolls back and only a ticket holder learns a lookup result.
      RAISE EXCEPTION 'SERVER_MISMATCH: %', v_kind;
    END IF;

    IF v_kind IN ('held', 'twin') THEN
      SELECT COALESCE(sum(p.amount), 0) INTO v_amount FROM public.payments p WHERE p.tab_id = v_tab AND NOT p.is_refund AND NOT p.is_deleted;
    END IF;

    INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, source, terminal_id, after)
    VALUES (v_uid, v_action, 'offline_sale', p_sale_id, 'rpc', NULLIF(v_claim->>'terminalId', ''), jsonb_strip_nulls(jsonb_build_object(
      'intent', p_intent,
      'outcome', v_outcome,
      'resolution', substr(v_action, 14),
      'approverId', v_approver,
      'approvalId', p_approval_id,
      'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'serverCheck', jsonb_build_object('kind', v_kind, 'tabId', v_tab),
      'linkedTabId', CASE WHEN v_kind IN ('held', 'twin') THEN v_tab END,
      'serverAmount', v_amount,
      'keyUntrusted', COALESCE((v_claim->>'keyUntrusted')::boolean, v_key IS NULL),
      'manualResponsibility', CASE WHEN p_intent = 'write_off' THEN 'cash_and_stock' END,
      'claimed', jsonb_build_object(
        'total', v_claim->'total', 'sellerId', p_seller_id, 'soldAt', v_claim->'soldAt',
        'receiptNumber', v_claim->'receiptNumber', 'terminalId', v_claim->'terminalId', 'lastCode', v_claim->'lastCode')
    )))
    RETURNING id INTO v_audit_id;

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', true, 'outcome', v_outcome, 'tabId', CASE WHEN v_kind IN ('held', 'twin') THEN v_tab END,
      'approverId', v_approver, 'auditId', v_audit_id, 'idempotent', false));
  EXCEPTION WHEN unique_violation THEN
    -- A lost write-off race: the spend above is undone with this block; answer as the winner did.
    v_prior := public.offline_sale_stored_outcome(p_sale_id, v_uid, p_approval_id, true);
    IF v_prior IS NULL THEN
      RAISE;
    END IF;
    RETURN v_prior;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_offline_sale(text, uuid, text, text[], jsonb, uuid, uuid, jsonb, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_offline_sale(text, uuid, text, text[], jsonb, uuid, uuid, jsonb, text, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
