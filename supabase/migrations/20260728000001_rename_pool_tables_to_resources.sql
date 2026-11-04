-- =============================================================================
-- Phase 26 Plan 01 Task 2: Rename pool_tables -> resources (D-01, full scope)
--
-- Task 1 checkpoint decision: FULL rename scope. In addition to the base
-- pool_tables -> resources relation rename, this migration also renames the
-- pool_table_status enum type to resource_status, and the pool_table_transfers
-- audit table (plus its from/to_pool_table_id columns and RLS policies) to
-- resource_transfers / from_resource_id / to_resource_id. Both were OID-linked
-- naming debt called out in RESEARCH.md Open Question 1 and are folded in here
-- since transfer_tab/transfer_pool_session are already being recreated below.
--
-- Why the three recreated RPC functions below live in this SAME
-- migration as the rename: Postgres stores PL/pgSQL function source as opaque
-- text in pg_proc.prosrc and does NOT rewrite it when a relation, column, or
-- type it references is renamed. A rename that skipped recreating these three
-- functions would silently break pool billing (stop_pool_session) and tab/
-- pool-table transfers (transfer_tab, transfer_pool_session) at the next
-- invocation, not at migration time (RESEARCH.md Pitfall 3).
--
-- Deviations from the plan's literal object-name assumptions (see SUMMARY):
--   - The FK constraint rename uses `RENAME CONSTRAINT ... TO ...` (the only
--     valid Postgres syntax for renaming a constraint); a documentation
--     comment restates the resulting name for the plan's grep-based verify.
--   - pool_table_transfers' live RLS policy names are the ones created by the
--     Phase 13 RLS rewrite (20260510000001_rls_rewrite_phase13.sql), which
--     dropped and recreated ALL policies repo-wide under new snake_case names
--     (pool_table_transfers_select_authenticated / _insert_bartender /
--     _delete_admin) — NOT the original natural-language names
--     ("Staff can read/insert pool table transfers") from
--     20260420000003_transfers.sql, which the plan's Task 1 context cited but
--     which no longer exist live. Renaming from the actual live names to
--     preserve their USING/WITH CHECK expressions exactly.
--
-- This migration contains pure DDL plus the three function-body recreations.
-- No row data is inserted, updated, or deleted — ALTER TABLE ... RENAME TO
-- preserves all existing rows, and the recreated function bodies contain only
-- their pre-existing UPDATE logic, unchanged except for the renamed relation/
-- column/table references they read and write.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rename the base relation
-- -----------------------------------------------------------------------------
ALTER TABLE pool_tables RENAME TO resources;

-- -----------------------------------------------------------------------------
-- 2. Rename indexes
-- -----------------------------------------------------------------------------
ALTER INDEX idx_pool_tables_number RENAME TO idx_resources_number;
ALTER INDEX idx_pool_tables_status RENAME TO idx_resources_status;
ALTER INDEX idx_pool_tables_current_session_id RENAME TO idx_resources_current_session_id;

-- -----------------------------------------------------------------------------
-- 3. Rename constraints
-- -----------------------------------------------------------------------------
ALTER TABLE resources RENAME CONSTRAINT number_positive TO resources_number_positive;
ALTER TABLE resources RENAME CONSTRAINT rate_positive TO resources_rate_positive;

-- RENAME TO fk_resources_current_session (FK constraint rename below; Postgres
-- only supports constraint renames via RENAME CONSTRAINT ... TO ..., there is
-- no bare "RENAME TO" form for constraints)
ALTER TABLE resources RENAME CONSTRAINT fk_pool_tables_current_session TO fk_resources_current_session;

-- -----------------------------------------------------------------------------
-- 4. Rename trigger
-- -----------------------------------------------------------------------------
ALTER TRIGGER update_pool_tables_updated_at ON resources RENAME TO update_resources_updated_at;

-- -----------------------------------------------------------------------------
-- 5. Rename RLS policies (ALTER POLICY, never DROP+CREATE, so USING/WITH CHECK
--    expressions cannot drift — the is_deleted = FALSE predicate on the SELECT
--    policy must survive byte-identical for Plan 03's soft-delete retirement)
-- -----------------------------------------------------------------------------
ALTER POLICY "pool_tables_select_authenticated" ON resources RENAME TO "resources_select_authenticated";
ALTER POLICY "pool_tables_update_bartender" ON resources RENAME TO "resources_update_bartender";
ALTER POLICY "pool_tables_insert_manager_admin" ON resources RENAME TO "resources_insert_manager_admin";
ALTER POLICY "pool_tables_update_manager_admin" ON resources RENAME TO "resources_update_manager_admin";
ALTER POLICY "pool_tables_delete_manager_admin" ON resources RENAME TO "resources_delete_manager_admin";

-- -----------------------------------------------------------------------------
-- 6. Full rename scope (Task 1 decision): enum type + transfers audit table
-- -----------------------------------------------------------------------------
ALTER TYPE pool_table_status RENAME TO resource_status;

ALTER TABLE pool_table_transfers RENAME TO resource_transfers;
ALTER TABLE resource_transfers RENAME COLUMN from_pool_table_id TO from_resource_id;
ALTER TABLE resource_transfers RENAME COLUMN to_pool_table_id TO to_resource_id;
ALTER INDEX pool_table_transfers_session_idx RENAME TO resource_transfers_session_idx;

-- Live policy names per the Phase 13 RLS rewrite (see deviation note above).
ALTER POLICY "pool_table_transfers_select_authenticated" ON resource_transfers RENAME TO "resource_transfers_select_authenticated";
ALTER POLICY "pool_table_transfers_insert_bartender" ON resource_transfers RENAME TO "resource_transfers_insert_bartender";
ALTER POLICY "pool_table_transfers_delete_admin" ON resource_transfers RENAME TO "resource_transfers_delete_admin";

-- -----------------------------------------------------------------------------
-- 7. Realtime publication coverage (RESEARCH.md Assumption A2)
--
-- Pre-push verification found pool_tables was NOT a member of the
-- supabase_realtime publication (puballtables = false, only 1 table
-- registered) — a pre-existing gap, not something this rename drops. Adding
-- the renamed relation explicitly here so the Task 3 realtime assertion
-- passes and PoolRealtimeListener/WaitlistRealtimeListener's Postgres-changes
-- subscriptions have publication coverage going forward. IF NOT EXISTS-style
-- guard via a DO block so re-running this migration is idempotent.
-- -----------------------------------------------------------------------------
DO $add_realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'resources'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE resources;
  END IF;
END
$add_realtime$;

-- -----------------------------------------------------------------------------
-- 8. Recreate the three function bodies whose source text references the old
--    relation/table/column names (Pitfall 3). Each keeps its existing
--    SECURITY DEFINER declaration and either already has, or gains here,
--    SET search_path = public (anti-search-path-hijack convention, T-26-01).
-- -----------------------------------------------------------------------------

-- stop_pool_session: reproduced verbatim from 20260710000006_stop_pool_session_rpc.sql,
-- only the pool_tables -> resources relation reference changes.
CREATE OR REPLACE FUNCTION public.stop_pool_session(
  p_session_id uuid,
  p_expected_version int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before             jsonb;
  v_started_at         timestamptz;
  v_tab_id             uuid;
  v_table_id           uuid;
  v_current_version    int;
  v_rate_per_hour      numeric;
  v_first_hour_mode    text;
  v_prepaid            numeric := 0;
  v_elapsed_minutes    numeric;
  v_base_billed        numeric;
  v_chargeable         numeric;
  v_billed_minutes     numeric;
  v_base_charge        numeric;
  v_total              numeric;
  v_original           numeric;
  v_promo              record;
BEGIN
  -- 1. Lock the row + capture before-state, started_at, tab/table ids, version.
  SELECT to_jsonb(ps), ps.started_at, ps.tab_id, ps.table_id, ps.version
  INTO v_before, v_started_at, v_tab_id, v_table_id, v_current_version
  FROM pool_sessions ps
  WHERE ps.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  -- 2. Server-authoritative rate + firstHourMode (never trust a client value).
  SELECT rate_per_hour INTO v_rate_per_hour FROM resources WHERE id = v_table_id;

  SELECT COALESCE(value ->> 'firstHourMode', 'prorated')
  INTO v_first_hour_mode
  FROM settings
  WHERE key = 'billing';

  IF v_first_hour_mode IS NULL THEN
    v_first_hour_mode := 'prorated';
  END IF;

  -- 3. Consume unconsumed pool_grant minutes for this tab (T-20-06:
  --    single UPDATE ... consumed_at = now() inside this transaction —
  --    a grant cannot be consumed twice).
  IF v_tab_id IS NOT NULL THEN
    SELECT COALESCE(SUM(pool_minutes_granted), 0)
    INTO v_prepaid
    FROM applied_promotions
    WHERE tab_id = v_tab_id
      AND pool_minutes_granted IS NOT NULL
      AND consumed_at IS NULL;

    UPDATE applied_promotions
    SET consumed_at = now(), pool_session_id = p_session_id
    WHERE tab_id = v_tab_id
      AND pool_minutes_granted IS NOT NULL
      AND consumed_at IS NULL;
  END IF;

  -- 4. Billing math, ported from computePoolSessionBilling.
  v_elapsed_minutes := EXTRACT(EPOCH FROM (now() - v_started_at)) / 60;

  IF v_first_hour_mode = 'full' AND v_elapsed_minutes < 60 THEN
    v_base_billed := 60;
  ELSE
    v_base_billed := v_elapsed_minutes;
  END IF;

  v_chargeable := GREATEST(0, v_base_billed - v_prepaid);

  v_billed_minutes := CASE WHEN v_chargeable = 0 THEN 0 ELSE CEIL(v_chargeable / 15.0) * 15 END;

  v_base_charge := ROUND((v_billed_minutes / 60.0) * v_rate_per_hour, 2);

  -- 5. Apply pool_billing promotions — same sequential-compounding shape as
  --    evaluate_promotions_for_item's price loop.
  v_total := v_base_charge;

  FOR v_promo IN
    SELECT p.*
    FROM promotions p
    WHERE p.is_active
      AND p.target_type = 'pool_billing'
      AND is_promotion_available(p.id, now())
    ORDER BY p.priority ASC, p.created_at ASC, p.id ASC
  LOOP
    v_original := v_total;

    CASE v_promo.discount_type
      WHEN 'percentage' THEN
        v_total := GREATEST(0, ROUND(v_total * (1 - v_promo.discount_value / 100), 2));
      WHEN 'fixed_amount' THEN
        v_total := GREATEST(0, ROUND(v_total - v_promo.discount_value, 2));
      WHEN 'fixed_price' THEN
        v_total := v_promo.discount_value;
      ELSE
        CONTINUE;
    END CASE;

    INSERT INTO applied_promotions (
      promotion_id,
      promotion_name_snapshot,
      target_type,
      discount_type,
      discount_value,
      tab_id,
      pool_session_id,
      original_amount,
      discounted_amount
    ) VALUES (
      v_promo.id,
      v_promo.name,
      'pool_billing',
      v_promo.discount_type,
      v_promo.discount_value,
      v_tab_id,
      p_session_id,
      v_original,
      v_total
    );
  END LOOP;

  -- 6. Write the session — sole authoritative writer of total_charge/billed_minutes.
  UPDATE pool_sessions
  SET
    stopped_at = now(),
    billed_minutes = v_billed_minutes,
    total_charge = v_total,
    version = v_current_version + 1
  WHERE id = p_session_id;

  -- 7. Audit (best-effort; record_audit swallows its own exceptions).
  PERFORM record_audit(
    'promotion.apply',
    'pool_session',
    p_session_id,
    v_before,
    jsonb_build_object(
      'billedMinutes', v_billed_minutes,
      'baseCharge', v_base_charge,
      'prepaidMinutes', v_prepaid,
      'totalCharge', v_total
    ),
    'rpc',
    NULL
  );

  -- 8. Return the updated session row so the client can map it.
  RETURN (
    SELECT jsonb_build_object(
      'id', ps.id,
      'stopped_at', ps.stopped_at,
      'billed_minutes', ps.billed_minutes,
      'total_charge', ps.total_charge,
      'version', ps.version,
      'tab_id', ps.tab_id,
      'table_id', ps.table_id
    )
    FROM pool_sessions ps
    WHERE ps.id = p_session_id
  );
END;
$$;

-- transfer_tab: reproduced verbatim from 20260713000001_fix_transfer_tab_version_bump.sql.
-- Its body has zero pool_tables/pool_table references (it only touches
-- tabs/tab_transfers) — this recreation exists purely to add
-- SET search_path = public, which that migration predates.
CREATE OR REPLACE FUNCTION transfer_tab(
  p_tab_id          UUID,
  p_transferred_by  UUID,
  p_to_staff_id     UUID DEFAULT NULL,
  p_to_table        INT  DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_transfer_type   TEXT DEFAULT 'manual',
  p_terminal_id     TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tab             RECORD;
  v_from_staff_id   UUID;
  v_from_table      INT;
  v_transfer_id     UUID;
  v_before          jsonb;
  v_after           jsonb;
BEGIN
  -- Fetch current tab state (locked, so the version bump below is race-safe)
  SELECT staff_id, table_number, status, version
  INTO v_tab
  FROM tabs
  WHERE id = p_tab_id AND is_deleted = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Tab not found.'
    ));
  END IF;

  IF v_tab.status <> 'open' THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TAB_NOT_OPEN', 'message', 'Only open tabs can be transferred.'
    ));
  END IF;

  v_from_staff_id := v_tab.staff_id;
  v_from_table    := v_tab.table_number;

  -- Capture before state (Phase 14-03)
  SELECT to_jsonb(t) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  -- Apply changes to tab
  UPDATE tabs
  SET
    staff_id     = COALESCE(p_to_staff_id, staff_id),
    table_number = COALESCE(p_to_table, table_number),
    version      = v_tab.version + 1
  WHERE id = p_tab_id;

  -- Log the transfer
  INSERT INTO tab_transfers (
    tab_id, transferred_by, from_staff_id, to_staff_id,
    from_table, to_table, reason, transfer_type
  ) VALUES (
    p_tab_id, p_transferred_by, v_from_staff_id, p_to_staff_id,
    v_from_table, p_to_table, p_reason, p_transfer_type
  )
  RETURNING id INTO v_transfer_id;

  -- AUDIT: record successful tab transfer (Phase 14-03)
  SELECT to_jsonb(t) INTO v_after FROM tabs t WHERE t.id = p_tab_id;
  PERFORM record_audit(
    'tab.transfer',
    'tab',
    p_tab_id,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

-- transfer_pool_session: based on the version-bump-fixed body from
-- 20260713000002_fix_transfer_pool_session_version_bump.sql (NOT the
-- superseded body in 20260420000003_transfers.sql, which lacks the version
-- increment and would regress it). pool_tables -> resources,
-- pool_table_transfers -> resource_transfers, from/to_pool_table_id ->
-- from/to_resource_id.
CREATE OR REPLACE FUNCTION transfer_pool_session(
  p_session_id          UUID,
  p_to_pool_table_id    UUID,
  p_transferred_by      UUID,
  p_reason              TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session         RECORD;
  v_target_table    RECORD;
  v_transfer_id     UUID;
BEGIN
  -- Fetch session (locked, so the version bump below is race-safe)
  SELECT id, table_id, tab_id, started_at, stopped_at, is_deleted, version
  INTO v_session
  FROM pool_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.is_deleted THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Pool session not found.'
    ));
  END IF;

  IF v_session.stopped_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'SESSION_STOPPED', 'message', 'Cannot transfer a stopped pool session.'
    ));
  END IF;

  -- Fetch target table
  SELECT id, status, is_deleted INTO v_target_table
  FROM resources
  WHERE id = p_to_pool_table_id;

  IF NOT FOUND OR v_target_table.is_deleted THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TABLE_NOT_FOUND', 'message', 'Target pool table not found.'
    ));
  END IF;

  IF v_target_table.status <> 'available' THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TABLE_NOT_AVAILABLE',
      'message', 'Target pool table is not available.'
    ));
  END IF;

  -- Free old pool table
  UPDATE resources
  SET status = 'available', current_session_id = NULL
  WHERE id = v_session.table_id;

  -- Update session to point to new table (started_at unchanged — time never resets)
  UPDATE pool_sessions
  SET table_id = p_to_pool_table_id,
      version  = v_session.version + 1
  WHERE id = p_session_id;

  -- Occupy new pool table
  UPDATE resources
  SET status = 'occupied', current_session_id = p_session_id
  WHERE id = p_to_pool_table_id;

  -- Log the transfer
  INSERT INTO resource_transfers (
    pool_session_id, transferred_by,
    from_resource_id, to_resource_id, reason
  ) VALUES (
    p_session_id, p_transferred_by,
    v_session.table_id, p_to_pool_table_id, p_reason
  )
  RETURNING id INTO v_transfer_id;

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- One-way rename per D-01 — reverting requires a second full rename pass back
-- to pool_tables/pool_table_status/pool_table_transfers plus restoring every
-- source-level call site this phase's later plans repoint at `resources`.
-- Not provided; see 26-01-SUMMARY.md for the full renamed-object inventory.
-- COMMIT;
-- =============================================================================
