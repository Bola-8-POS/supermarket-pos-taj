-- two-mode Plan 02d, review finding F12 (part C): resolve_offline_sale uses the shared re-ring predicate.
--
-- resolve_offline_sale carried whole from 20261017000006. Changes:
--   1. The three copies of the "a paid re-ring counts" test (twin lookup, write-off guard, paidReringCount)
--      are replaced by offline_sale_rering_counts (000007), which also counts a reopened, still-open tab.
--   2. serverAmount / amountShort come from the NET amount of the linked tab (non-deleted payments, refunds
--      negative, reopened_void positives excluded), the same filter the predicate uses.
--   3. Kind 'tab' with NO payment under the sale's own key links the paid re-ring; DUPLICATE_SERVER_SALE is
--      raised only when the original key's payment was found (cashier / tab / goods).
-- Signature, security, search_path and grants unchanged.

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
  v_untrusted boolean;
  v_orig_kind text;
  v_differ    boolean := false;
  v_paid_tab  uuid;
  v_paid_n    integer;
  v_short     numeric;
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

  v_untrusted := COALESCE((v_claim->>'keyUntrusted')::boolean, false) OR v_key IS NULL;
  IF v_untrusted AND p_intent = 'rering' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
  END IF;

  -- 3. Replay, before the ticket.
  v_prior := public.offline_sale_stored_outcome(p_sale_id, v_uid, p_approval_id, p_intent = 'write_off');
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;

  -- One resolution at a time per sale (seed 1; the per-tab lock below uses seed 0), taken before the
  -- written-off check so a write-off and a re-ring/review racing for one sale cannot both commit.
  -- Order is always sale lock, then tab lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sale_id::text, 1));

  -- A written-off sale is terminal: re-ring and review are refused before the ticket is spent.
  IF p_intent <> 'write_off' AND EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id AND a.action = 'offline_sale.written_off') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_WRITTEN_OFF');
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
    IF v_key IS NOT NULL AND NOT v_untrusted THEN
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
    ELSIF v_untrusted THEN
      NULL;  -- never auto-linked: only the write-off / escalation outcomes remain
    ELSIF p_recorded_tab_id IS NOT NULL THEN
      v_kind := 'tab';
    ELSIF p_intent <> 'review' THEN
      -- Twin: a re-ring paid after the earliest rering_approved row for this sale.
      SELECT min(a.created_at) INTO v_since FROM public.audit_logs a
       WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id AND a.action = 'offline_sale.rering_approved';
      SELECT COALESCE(array_agg(k) || array_agg(k || '-leg0'), ARRAY[]::text[]) INTO v_all_keys FROM unnest(v_rkeys) AS k
       WHERE k LIKE ('rering\_' || p_sale_id::text || '\_%');
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
             AND public.offline_sale_rering_counts(p_sale_id, p.id)
           ORDER BY p.processed_at, p.id LIMIT 1;
          IF FOUND THEN
            v_kind := 'twin';
          END IF;
        END IF;
      END IF;
    END IF;

    -- Claimed: a held or twin tab already named as linked by another offline sale.
    -- Serialised per tab (held until commit) so check-then-insert cannot interleave.
    IF v_kind IN ('held', 'twin') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(v_tab::text, 0));
    END IF;
    IF v_kind IN ('held', 'twin') AND EXISTS (
      SELECT 1 FROM public.audit_logs a
       WHERE a.entity_type = 'offline_sale' AND a.action = 'offline_sale.linked'
         AND a.entity_id <> p_sale_id AND a.after->>'linkedTabId' = v_tab::text
    ) THEN
      v_kind := 'claimed';
    END IF;

    -- 6. A write-off never sits beside a paid re-ring. Only a re-ring the same approver rang and that is
    -- not fully refunded counts. Kinds none/attempt LINK the earliest one (linkOverride). A sale the server
    -- already holds under its own key (cashier/tab/goods) raises DUPLICATE_SERVER_SALE (refund the re-ring,
    -- then write off); a tab already linked elsewhere (claimed) raises RERING_ALREADY_PAID, before the
    -- second tab lock. Raises roll the ticket spend back.
    IF p_intent = 'write_off' AND v_kind NOT IN ('held', 'twin') THEN
      SELECT p.tab_id INTO v_paid_tab FROM public.payments p
       WHERE NOT p.is_refund AND NOT p.is_deleted
         AND public.offline_sale_rering_counts(p_sale_id, p.id)
       ORDER BY p.processed_at, p.id LIMIT 1;
      IF FOUND THEN
        IF v_kind = 'claimed' THEN
          RAISE EXCEPTION 'RERING_ALREADY_PAID: this sale was already re-rung';
        END IF;
        IF v_found AND v_kind IN ('cashier', 'tab', 'goods') THEN
          RAISE EXCEPTION 'DUPLICATE_SERVER_SALE: the original sale is already paid on the server';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(v_paid_tab::text, 0));
        IF EXISTS (
          SELECT 1 FROM public.audit_logs a
           WHERE a.entity_type = 'offline_sale' AND a.action = 'offline_sale.linked'
             AND a.entity_id <> p_sale_id AND a.after->>'linkedTabId' = v_paid_tab::text
        ) THEN
          RAISE EXCEPTION 'RERING_ALREADY_PAID: this sale was already re-rung';
        END IF;
        SELECT count(DISTINCT p.tab_id) INTO v_paid_n FROM public.payments p
         WHERE NOT p.is_refund AND NOT p.is_deleted
           AND public.offline_sale_rering_counts(p_sale_id, p.id);
        v_orig_kind := v_kind;
        v_differ := true;
        v_tab := v_paid_tab;
        v_kind := 'twin';
      END IF;
    END IF;

    -- Outcome.
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
      SELECT COALESCE(sum(p.amount), 0)::numeric(10,2) INTO v_amount FROM public.payments p
       WHERE p.tab_id = v_tab AND NOT p.is_deleted AND (p.is_refund OR p.status IS DISTINCT FROM 'reopened_void');
      v_short := round(greatest(CASE WHEN (v_claim->>'total') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_claim->>'total')::numeric ELSE 0 END - v_amount, 0), 2);
    END IF;

    INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, source, terminal_id, after)
    VALUES (v_uid, v_action, 'offline_sale', p_sale_id, 'rpc', NULLIF(v_claim->>'terminalId', ''), jsonb_strip_nulls(jsonb_build_object(
      'intent', p_intent,
      'outcome', v_outcome,
      'resolution', substr(v_action, 14),
      'approverId', v_approver,
      'approvalId', p_approval_id,
      'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
      'serverCheck', jsonb_build_object('kind', COALESCE(v_orig_kind, v_kind), 'tabId', v_tab),
      'linkOverride', CASE WHEN v_differ THEN true END,
      'paidReringCount', CASE WHEN v_paid_n > 1 THEN v_paid_n END,
      'amountShort', v_short,
      'linkedTabId', CASE WHEN v_kind IN ('held', 'twin') THEN v_tab END,
      'serverAmount', v_amount,
      'keyUntrusted', v_untrusted,
      'manualResponsibility', CASE WHEN p_intent = 'write_off' THEN 'cash_and_stock' END,
      'claimed', jsonb_build_object(
        'total', v_claim->'total', 'sellerId', p_seller_id, 'soldAt', v_claim->'soldAt',
        'receiptNumber', v_claim->'receiptNumber', 'terminalId', v_claim->'terminalId', 'lastCode', v_claim->'lastCode')
    )))
    RETURNING id INTO v_audit_id;

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', true, 'outcome', v_outcome, 'tabId', CASE WHEN v_kind IN ('held', 'twin') THEN v_tab END,
      'approverId', v_approver, 'auditId', v_audit_id, 'idempotent', false,
      'serverAmount', CASE WHEN v_kind IN ('held', 'twin') THEN v_amount END,
      'amountShort', v_short));
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
