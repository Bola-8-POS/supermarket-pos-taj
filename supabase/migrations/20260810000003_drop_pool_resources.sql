-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 06 Task 2: [BLOCKING] destructive drop of the
-- pool table / billiards session domain (D-09 — "pool tables have no meaning
-- for a grocery store").
--
-- Paired follow-up to Plan 06 Task 1, which deleted the `resource` entity, its
-- 5 pool-session lifecycle features, 3 widgets, 2 pages, and the Settings tab.
--
-- CRITICAL cross-cutting finding (not called out by RESEARCH.md's SQL removal
-- table): `process_payment_atomic` and `process_split_payment_atomic` — the
-- KEPT, generic payment RPCs used by every real checkout, not just former
-- pool-charge tabs — both open with a `SELECT ... FROM pool_sessions` guard
-- that blocks payment while a pool session is running. Dropping pool_sessions
-- without first redefining these two functions would break EVERY payment on
-- the new project (relation "pool_sessions" does not exist), not just
-- pool-related ones. This migration redefines both functions first (dropping
-- only the pool-session guard block, byte-for-byte identical otherwise, taken
-- from `pg_get_functiondef` against the live new project) before dropping any
-- pool table.
--
-- Also drops `resource_transfers` (born `pool_table_transfers`, renamed in
-- 20260728000001_rename_pool_tables_to_resources.sql) — a 100% pool-transfer
-- history table discovered via a live FK dependency query
-- (`information_schema.table_constraints` against `resources`/`pool_sessions`)
-- that RESEARCH.md's migration-filename audit did not separately name.
-- `waitlist_entries.table_id` and `applied_promotions.pool_session_id` also FK
-- into these tables (owned by Plans 01-08 and 01-10, not yet run in this
-- wave) — DROP TABLE ... CASCADE removes only the now-dangling FK
-- CONSTRAINT on those tables, never the tables themselves or their data.
--
-- `evaluate_promotions_pool_grant` (RESEARCH.md's flagged cross-plan
-- dependency with the Promotions migration group) does not exist yet on this
-- project as of this migration — a live `pg_proc` query
-- (`prosrc ILIKE '%pool_session%'`) confirms zero rows. If Plan 01-10 lands
-- later in this wave and (re)introduces a function referencing pool_sessions,
-- that is expected transient same-wave state per this plan's own threat
-- register (T-01-13), not a defect in this migration.
--
-- Dropped pool-only functions confirmed via a live `pg_proc` query
-- (`prosrc ILIKE '%resources%' OR prosrc ILIKE '%pool_session%'`, cross-
-- checked against `pg_get_function_identity_arguments` for signatures — none
-- have overloads): `start_pool_session`, `stop_pool_session`,
-- `transfer_pool_session`, `seat_waitlist_party_and_start_session` (unused —
-- zero call sites in src/, confirmed by grep), `deactivate_floating_resource`
-- (the AFTER UPDATE trigger function on pool_sessions).
--
-- `update_resources_updated_at`/`update_pool_sessions_updated_at` (both call
-- the shared generic `update_updated_at_column()`) and
-- `trg_pool_sessions_version` (calls the shared generic
-- `bump_version_on_update()`) are attached directly to the dropped tables and
-- go with them via CASCADE — the two generic trigger functions themselves are
-- shared by `tabs`/`caja_sessions`/etc. and are explicitly NOT touched.
--
-- Irreversible (Pitfall 4, matching 20260711000001's convention): the DOWN
-- section below restores table/index/trigger/RLS shape only (verified via
-- `pg_dump --schema-only` against the live new project) — it does not restore
-- pool session/table row data, nor the dropped pool-specific RPC bodies, nor
-- the pool-session guard removed from process_payment_atomic/
-- process_split_payment_atomic (re-adding that guard is a data-shape decision
-- for whoever unwinds this, since the pool_sessions table it reads would
-- itself need restoring first).
-- =============================================================================

-- UP:
BEGIN;

-- Redefine the two KEPT generic payment RPCs first, dropping only their
-- pool-session-active guard block. Every other line is byte-for-byte
-- identical to the live new-project definition (pulled via
-- pg_get_functiondef immediately before authoring this migration).

CREATE OR REPLACE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_tip_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id UUID;
  v_existing_tab UUID;
  v_tab_status tab_status;
  v_rappi_tab TEXT;
  v_total NUMERIC;
  v_payment_id UUID;
  v_method payment_method;
  v_tab_updated INT;
  v_owed NUMERIC;
  v_paid_line NUMERIC;
  v_payment_row jsonb;
  v_current INT;
BEGIN
  IF p_method NOT IN ('cash', 'card', 'rappi') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, or rappi');
  END IF;

  v_method := p_method::payment_method;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
  END IF;

  SELECT id, tab_id INTO v_existing_id, v_existing_tab
  FROM payments
  WHERE idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_tab IS DISTINCT FROM p_tab_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_MISMATCH', 'message', 'Idempotency key belongs to another tab');
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
  END IF;

  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  -- Combined with status/rappi read into a single FOR UPDATE select.
  SELECT status, rappi_order_id, version
  INTO v_tab_status, v_rappi_tab, v_current
  FROM tabs
  WHERE id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_tab_status IS DISTINCT FROM 'open'::tab_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open');
  END IF;

  IF p_method = 'rappi' THEN
    IF v_rappi_tab IS NULL OR v_rappi_tab IS DISTINCT FROM p_rappi_order_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RAPPI_ORDER_MISMATCH', 'message', 'Rappi order id does not match tab');
    END IF;
  END IF;

  v_total := ROUND(p_amount + p_tip_amount, 2);

  IF p_method = 'cash' THEN
    IF p_tendered_amount IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_REQUIRED', 'message', 'Tendered amount required for cash');
    END IF;
    IF ROUND(p_tendered_amount, 2) < v_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_TENDER', 'message', 'Tendered amount is less than total');
    END IF;
  ELSE
    IF p_tendered_amount IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_NOT_ALLOWED', 'message', 'Tendered amount is only for cash payments');
    END IF;
  END IF;

  INSERT INTO payments (
    tab_id,
    amount,
    tip_amount,
    method,
    processed_by,
    square_payment_id,
    square_receipt_url,
    tendered_amount,
    reference_number,
    idempotency_key,
    discount_scope,
    discount_type,
    discount_value,
    discount_amount
  ) VALUES (
    p_tab_id,
    ROUND(p_amount, 2),
    ROUND(p_tip_amount, 2),
    v_method,
    p_staff_id,
    NULL,
    NULL,
    CASE WHEN p_method = 'cash' THEN ROUND(p_tendered_amount, 2) ELSE NULL END,
    NULLIF(TRIM(p_reference_number), ''),
    p_idempotency_key,
    p_discount_scope,
    p_discount_type,
    p_discount_value,
    p_discount_amount
  )
  RETURNING id INTO v_payment_id;

  -- Subtotal from line items (excludes priced combo children) — same basis as split_tab_evenly
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  -- Phase 23: exclude reopened_void rows (voided by reopen_tab) from the
  -- "already paid" sum so a reopened-then-repaid tab is not double-counted.
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  -- Close only when the tab's item subtotal is fully covered (multi-pay / split).
  -- Phase 15: bump tabs.version on close. The bump_version_on_update trigger
  -- enforces +1 advancement.
  IF v_paid_line + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET
      status = 'paid'::tab_status,
      closed_at = NOW(),
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE id = v_payment_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  ELSE
    -- Partial payment path: still advance version so concurrent partial-pay
    -- attempts using the same expected_version are rejected by the next call's
    -- guard. No status change.
    UPDATE tabs
    SET
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id;
  END IF;

  -- AUDIT: record successful payment (Phase 14-03; preserved). Sits AFTER the
  -- version guard so on P0V01/P0V02 the raise fires first and audit is skipped.
  SELECT to_jsonb(p) INTO v_payment_row FROM payments p WHERE p.id = v_payment_id;
  PERFORM record_audit(
    'payment.process',
    'payment',
    v_payment_id,
    NULL,
    v_payment_row,
    'rpc'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'paymentId', v_payment_id
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing_id FROM payments WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
    END IF;
    -- Multiple payments per tab are allowed: do not treat tab_id as idempotent
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate payment');
  WHEN sqlstate 'P0V01' THEN
    -- Re-raise STALE_VERSION so the caller (PostgREST) propagates the SQLSTATE
    -- to the client; do NOT swallow into the generic 'ok=false' shape.
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    -- Re-raise NOT_FOUND_VERSIONED for the same reason.
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Payment failed');
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_split_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_legs jsonb, p_expected_total numeric, p_idempotency_key text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_leg_count       INT;
  v_existing_id     UUID;
  v_existing_group  UUID;
  v_payment_ids     UUID[];
  v_tab_status      tab_status;
  v_rappi_tab       TEXT;
  v_current         INT;
  v_legs_sum        NUMERIC;
  v_group_id        UUID;
  v_i               INT;
  v_leg             JSONB;
  v_method          TEXT;
  v_leg_amount      NUMERIC;
  v_leg_tip         NUMERIC;
  v_leg_tendered    NUMERIC;
  v_leg_ref         TEXT;
  v_leg_rappi       TEXT;
  v_payment_id      UUID;
  v_owed            NUMERIC;
  v_paid_line       NUMERIC;
  v_tab_updated     INT;
BEGIN
  -- 1. FORBIDDEN guard
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
  END IF;

  -- 2. Leg-count validation (D-02: up to 4 rows total)
  v_leg_count := jsonb_array_length(p_legs);
  IF v_leg_count < 1 OR v_leg_count > 4 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'TOO_MANY_LEGS',
      'message', format('Split payment must have between 1 and 4 legs, got %s', v_leg_count)
    );
  END IF;

  -- 3. Idempotency replay (Pattern 3 — per-leg derived keys, -leg0 sentinel)
  SELECT id, payment_group_id INTO v_existing_id, v_existing_group
  FROM payments
  WHERE idempotency_key = p_idempotency_key || '-leg0'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    SELECT array_agg(id ORDER BY split_index) INTO v_payment_ids
    FROM payments
    WHERE payment_group_id = v_existing_group;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'paymentGroupId', v_existing_group,
      'paymentIds', to_jsonb(v_payment_ids)
    );
  END IF;

  -- 4. Version guard — copied verbatim from process_payment_atomic
  --    (20260512000002_rpc_versioned_group_a.sql lines 103-119).
  SELECT status, rappi_order_id, version
  INTO v_tab_status, v_rappi_tab, v_current
  FROM tabs
  WHERE id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_tab_status IS DISTINCT FROM 'open'::tab_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open');
  END IF;

  -- 5. Sum validation (D-05) — server-side authoritative check
  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0) INTO v_legs_sum
  FROM jsonb_array_elements(p_legs) AS leg;

  IF ABS(v_legs_sum - p_expected_total) > 0.01 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SPLIT_TOTAL_MISMATCH',
      'message', format('Split legs sum %s does not match expected total %s (+/-0.01 allowed)', v_legs_sum, p_expected_total)
    );
  END IF;

  v_group_id := gen_random_uuid();
  v_payment_ids := '{}';

  -- 8. Per-leg loop — insert 1-4 payment rows sharing v_group_id
  FOR v_i IN 0..(v_leg_count - 1) LOOP
    v_leg := p_legs->v_i;
    v_method       := v_leg->>'method';
    v_leg_amount   := (v_leg->>'amount')::numeric;
    v_leg_tip      := COALESCE((v_leg->>'tipAmount')::numeric, 0);
    v_leg_tendered := (v_leg->>'tenderedAmount')::numeric;
    v_leg_ref      := v_leg->>'referenceNumber';
    v_leg_rappi    := v_leg->>'rappiOrderId';

    IF v_method NOT IN ('cash', 'card', 'rappi') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, or rappi');
    END IF;

    -- Pitfall 3: pre-empt the amount_positive CHECK constraint with a
    -- descriptive per-leg error before the INSERT ever fires.
    IF v_leg_amount IS NULL OR v_leg_amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_LEG', 'message', format('Leg %s has amount <= 0', v_i));
    END IF;

    IF v_method = 'cash' THEN
      IF v_leg_tendered IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_REQUIRED', 'message', 'Tendered amount required for cash leg');
      END IF;
      IF ROUND(v_leg_tendered, 2) < ROUND(v_leg_amount + v_leg_tip, 2) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_TENDER', 'message', 'Tendered amount is less than leg total');
      END IF;
    ELSE
      IF v_leg_tendered IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_NOT_ALLOWED', 'message', 'Tendered amount is only for cash payments');
      END IF;
    END IF;

    IF v_method = 'rappi' THEN
      IF v_rappi_tab IS NULL OR v_rappi_tab IS DISTINCT FROM v_leg_rappi THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RAPPI_ORDER_MISMATCH', 'message', 'Rappi order id does not match tab');
      END IF;
    END IF;

    -- Discount stored ONLY on split_index=0 (D-04: discount computed once on
    -- the full tab, not per row — avoids double-count in SUM(discount_amount)
    -- reports).
    INSERT INTO payments (
      tab_id,
      amount,
      tip_amount,
      method,
      processed_by,
      tendered_amount,
      reference_number,
      idempotency_key,
      payment_group_id,
      split_index,
      discount_scope,
      discount_type,
      discount_value,
      discount_amount
    ) VALUES (
      p_tab_id,
      ROUND(v_leg_amount, 2),
      ROUND(v_leg_tip, 2),
      v_method::payment_method,
      p_staff_id,
      CASE WHEN v_method = 'cash' THEN ROUND(v_leg_tendered, 2) ELSE NULL END,
      NULLIF(TRIM(v_leg_ref), ''),
      p_idempotency_key || '-leg' || v_i::text,
      v_group_id,
      v_i,
      CASE WHEN v_i = 0 THEN p_discount_scope ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_type ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_value ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_amount ELSE NULL END
    )
    RETURNING id INTO v_payment_id;

    v_payment_ids := v_payment_ids || v_payment_id;
  END LOOP;

  -- 9. Tab-close — copied verbatim from process_payment_atomic
  --    (20260512000002_rpc_versioned_group_a.sql lines 184-222), adapted to
  --    delete ALL group legs (not a single row) on the close-race.
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  -- Phase 23: exclude reopened_void rows (voided by reopen_tab) from the
  -- "already paid" sum so a reopened-then-repaid tab is not double-counted.
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  IF v_paid_line + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET
      status = 'paid'::tab_status,
      closed_at = NOW(),
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE payment_group_id = v_group_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  ELSE
    -- Partial payment path: still advance version so concurrent partial-pay
    -- attempts using the same expected_version are rejected by the next call's
    -- guard. No status change.
    UPDATE tabs
    SET
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id;
  END IF;

  -- 10. Audit
  PERFORM record_audit(
    'payment.process_split',
    'payment',
    v_group_id,
    NULL,
    jsonb_build_object('paymentIds', to_jsonb(v_payment_ids), 'legCount', v_leg_count),
    'rpc'
  );

  -- 11. Return
  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'paymentGroupId', v_group_id,
    'paymentIds', to_jsonb(v_payment_ids)
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT id, payment_group_id INTO v_existing_id, v_existing_group
    FROM payments
    WHERE idempotency_key = p_idempotency_key || '-leg0'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT array_agg(id ORDER BY split_index) INTO v_payment_ids
      FROM payments
      WHERE payment_group_id = v_existing_group;

      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'paymentGroupId', v_existing_group,
        'paymentIds', to_jsonb(v_payment_ids)
      );
    END IF;

    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate split payment');
  WHEN sqlstate 'P0V01' THEN
    -- Re-raise STALE_VERSION so the caller (PostgREST) propagates the SQLSTATE
    -- to the client; do NOT swallow into the generic 'ok=false' shape.
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    -- Re-raise NOT_FOUND_VERSIONED for the same reason.
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Split payment failed');
END;
$function$;

-- Pool-only RPCs and the pool-session-stop trigger function. None have
-- overloads (checked via pg_get_function_identity_arguments), so name-only
-- DROP is unambiguous.
DROP FUNCTION IF EXISTS public.start_pool_session(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.stop_pool_session(uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS public.transfer_pool_session(uuid, uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.seat_waitlist_party_and_start_session(uuid, uuid, uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.deactivate_floating_resource() CASCADE;

-- Realtime publication membership must be dropped before the table itself.
-- Note: unlike ADD TABLE, PostgreSQL's ALTER PUBLICATION ... DROP TABLE does
-- not support IF EXISTS (neither for the publication membership nor the
-- table) — DO block below makes the drop idempotent by hand (same pattern as
-- 20260810000002_drop_rappi_orders.sql). pool_sessions was never added to the
-- publication (verified via pg_publication_tables), so only resources needs
-- this treatment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'resources'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE resources;
  END IF;
END $$;

-- Child table first (FKs into both resources and pool_sessions).
DROP TABLE IF EXISTS resource_transfers CASCADE;

-- pool_sessions before resources: resources.current_session_id FKs into
-- pool_sessions, and CASCADE on the pool_sessions drop cleans that up: the
-- inverse order (resources first) would also work via CASCADE, but this
-- order matches the plan's action text and needs no cross-table FK guessing.
DROP TABLE IF EXISTS pool_sessions CASCADE;
DROP TABLE IF EXISTS resources CASCADE;

-- Used only by resources.status; safe to drop now that the table is gone
-- (verified via pg_attribute — resources.status was its only column user).
DROP TYPE IF EXISTS resource_status;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- DOWN:
-- BEGIN;
--
-- CREATE TYPE resource_status AS ENUM (
--   'available',
--   'occupied',
--   'reserved',
--   'maintenance'
-- );
--
-- CREATE TABLE resources (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   number INTEGER NOT NULL,
--   label VARCHAR(50) NOT NULL,
--   rate_per_hour NUMERIC(10,2) NOT NULL,
--   status resource_status NOT NULL DEFAULT 'available',
--   current_session_id UUID,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   deleted_at TIMESTAMPTZ,
--   is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
--   table_type TEXT NOT NULL DEFAULT 'pool',
--   is_temp BOOLEAN NOT NULL DEFAULT FALSE,
--   CONSTRAINT resources_number_positive CHECK (number > 0),
--   CONSTRAINT resources_rate_positive CHECK (rate_per_hour > 0),
--   CONSTRAINT resources_table_type_check CHECK (table_type = ANY (ARRAY['pool', 'carom', 'consumption', 'floating'])),
--   CONSTRAINT pool_tables_number_key UNIQUE (number)
-- );
--
-- CREATE TABLE pool_sessions (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   table_id UUID NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
--   tab_id UUID REFERENCES tabs(id) ON DELETE SET NULL,
--   started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   stopped_at TIMESTAMPTZ,
--   billed_minutes INTEGER,
--   total_charge NUMERIC(10,2),
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   deleted_at TIMESTAMPTZ,
--   is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
--   previous_table_id UUID REFERENCES resources(id),
--   prepaid_minutes INTEGER NOT NULL DEFAULT 0,
--   source_order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL,
--   version INTEGER NOT NULL DEFAULT 1,
--   CONSTRAINT billed_minutes_non_negative CHECK (billed_minutes IS NULL OR billed_minutes >= 0),
--   CONSTRAINT billed_minutes_requires_stopped_at CHECK (billed_minutes IS NULL OR stopped_at IS NOT NULL),
--   CONSTRAINT stopped_at_after_started_at CHECK (stopped_at IS NULL OR stopped_at > started_at),
--   CONSTRAINT total_charge_non_negative CHECK (total_charge IS NULL OR total_charge >= 0),
--   CONSTRAINT total_charge_requires_stopped_at CHECK (total_charge IS NULL OR stopped_at IS NOT NULL)
-- );
--
-- ALTER TABLE resources ADD CONSTRAINT fk_resources_current_session
--   FOREIGN KEY (current_session_id) REFERENCES pool_sessions(id) ON DELETE SET NULL;
--
-- CREATE TABLE resource_transfers (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   pool_session_id UUID NOT NULL REFERENCES pool_sessions(id),
--   transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   transferred_by UUID NOT NULL REFERENCES profiles(id),
--   from_resource_id UUID NOT NULL REFERENCES resources(id),
--   to_resource_id UUID NOT NULL REFERENCES resources(id),
--   reason TEXT
-- );
--
-- CREATE INDEX idx_pool_sessions_active ON pool_sessions(table_id, started_at) WHERE stopped_at IS NULL;
-- CREATE INDEX idx_pool_sessions_source_order_item_id ON pool_sessions(source_order_item_id) WHERE source_order_item_id IS NOT NULL;
-- CREATE INDEX idx_pool_sessions_started_at ON pool_sessions(started_at DESC);
-- CREATE INDEX idx_pool_sessions_tab_id ON pool_sessions(tab_id);
-- CREATE INDEX idx_pool_sessions_table_id ON pool_sessions(table_id);
-- CREATE INDEX idx_resources_current_session_id ON resources(current_session_id) WHERE current_session_id IS NOT NULL;
-- CREATE INDEX idx_resources_number ON resources(number);
-- CREATE INDEX idx_resources_status ON resources(status);
-- CREATE INDEX resource_transfers_session_idx ON resource_transfers(pool_session_id);
--
-- -- Trigger functions reference the shared generic functions that were never
-- -- dropped (update_updated_at_column, bump_version_on_update). This DOWN
-- -- block does NOT restore deactivate_floating_resource()'s body — recreate it
-- -- from git history (this migration's UP section quotes it verbatim) if
-- -- needed.
-- CREATE TRIGGER update_resources_updated_at BEFORE UPDATE ON resources
--   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- CREATE TRIGGER update_pool_sessions_updated_at BEFORE UPDATE ON pool_sessions
--   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- CREATE TRIGGER trg_pool_sessions_version BEFORE UPDATE ON pool_sessions
--   FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--
-- ALTER PUBLICATION supabase_realtime ADD TABLE resources;
--
-- ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE pool_sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE resource_transfers ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "resources_select_authenticated" ON resources
--   FOR SELECT TO authenticated USING (is_deleted = false);
-- CREATE POLICY "resources_insert_manager_admin" ON resources
--   FOR INSERT TO authenticated WITH CHECK (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "resources_update_manager_admin" ON resources
--   FOR UPDATE TO authenticated
--   USING (get_user_role() IN ('manager', 'admin'))
--   WITH CHECK (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "resources_delete_manager_admin" ON resources
--   FOR DELETE TO authenticated USING (get_user_role() IN ('manager', 'admin'));
--
-- -- No data restoration, no pool-specific RPC bodies, no re-added
-- -- pool-session guard on process_payment_atomic/process_split_payment_atomic
-- -- — table/index/trigger/RLS shape only, matching repo convention
-- -- (20260711000001_drop_happy_hour_columns.sql, 20260810000002_drop_rappi_orders.sql).
--
-- COMMIT;
-- =============================================================================
