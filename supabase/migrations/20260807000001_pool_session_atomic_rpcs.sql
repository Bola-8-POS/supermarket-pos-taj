-- =============================================================================
-- Phase 07 Plan 09 Task 1 — atomic pool-session RPCs + pg_net enable (D-01, D-02, D-04, D-06, D-08)
--
-- (a) pg_net (D-08). 20260501000003's header wrongly claims "pg_net is
-- pre-enabled on Supabase hosted" -- the live project has no `net` schema,
-- so `trg_waitlist_notify` (20260501000003/20260501000004) has been
-- completely non-functional since Phase 7 shipped: every
-- `UPDATE waitlist_entries SET status = 'notified'` aborts the whole
-- statement with `schema "net" does not exist` because the trigger raises
-- inside an AFTER UPDATE OF status trigger. This is NOT a trigger rewrite
-- (D-08 explicitly rejected that) -- it only enables the extension the
-- pre-existing trigger already assumed.
--
-- (b) public.start_pool_session(uuid, uuid) -- the atomic replacement for
-- the 2-step client write in src/entities/resource/model/queries.ts
-- (useMutationStartSession: pool_sessions insert, then resources status +
-- current_session_id update). Adds a FOR UPDATE lock + status <> 'available'
-- guard that the raw 2-step write never had -- this is what makes
-- double-seating a single table impossible, and it means a stale
-- offline-queued start-pool-timer replay now fails cleanly with
-- POOL_TABLE_OCCUPIED instead of creating a second concurrent session on an
-- occupied table. Deliberately has NO role gate: its only current caller
-- path (StartSessionSheet -> start_pool_timer) is bartender-accessible
-- today, and a manager+ gate here would silently regress the manual pool
-- flow -- mirrors the documented "deliberately does NOT add a manager/admin
-- role gate" precedent in remove_tab_item (20260721000005).
--
-- (c) public.seat_waitlist_party_and_start_session(uuid, uuid, uuid, uuid, uuid)
-- -- makes "seat waitlist party -> open tab -> start pool timer" one
-- transaction (D-02). Re-asserts the waitlist_entries_update_manager RLS
-- policy this SECURITY DEFINER function bypasses (get_user_role() NOT IN
-- ('manager','admin') -> AUTH_FORBIDDEN) as its first statement, before any
-- read or write -- restores, not adds, an authorization rule (T-0709-02).
-- Branches on resources.table_type (D-06): floating gets neither tab nor
-- session (D-05); consumption gets a tab only and deliberately never writes
-- resources.status (nothing in this codebase ever clears that status
-- without a pool session to stop, so writing it would strand consumption
-- tables as permanently occupied); pool/carom call start_pool_session and
-- RAISE if it reports ok:false -- that RAISE is the single most
-- load-bearing line in this migration: a plain RETURN from a called plpgsql
-- function does not roll anything back, so without it the tab insert and
-- the waitlist status UPDATE would commit while no session exists, which is
-- precisely the non-atomic outcome D-02 rejected.
--
-- Every `code` value returned by either function (NOT_FOUND,
-- POOL_TABLE_OCCUPIED, DUPLICATE_ENTRY, AUTH_FORBIDDEN, VALIDATION_ERROR)
-- is already a member of the AppErrorCode union in src/shared/lib/result.ts
-- -- no new codes were added.
--
-- Depends on:
--   - 20260501000001_waitlist_entries.sql (waitlist_entries columns/RLS)
--   - 20260501000003/20260501000004 (trg_waitlist_notify -- the pg_net consumer)
--   - 20260414000004_tabs_and_orders.sql (tabs columns, customer_name_or_table CHECK)
--   - 20260414000009_rls_policies.sql (get_user_role() helper)
--   - 20260512000001_versioned_rows.sql (bump_version_on_update fires BEFORE
--     UPDATE only on tabs/pool_sessions -- both RPCs only INSERT into those
--     tables, so no version handling is needed here)
--   - 20260728000001_rename_pool_tables_to_resources.sql (resources relation,
--     resource_status enum, current_session_id)
--   - 20260728000002_resources_is_temp_floating.sql (resources.table_type
--     CHECK IN ('pool','carom','consumption','floating'))
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------------
-- (a) pg_net (D-08)
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -----------------------------------------------------------------------------
-- (b) start_pool_session
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_pool_session(p_table_id uuid, p_tab_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status  text;
  v_session pool_sessions%ROWTYPE;
BEGIN
  -- Lock the resource row for the duration of the transaction. Combined
  -- with the status guard below, this is what makes double-seating a single
  -- table impossible -- a concurrent caller blocks here until this
  -- transaction commits or rolls back, then re-reads the now-updated status.
  SELECT r.status::text INTO v_status
  FROM resources r
  WHERE r.id = p_table_id AND r.is_deleted = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- New behavior vs. the raw 2-step client write: a stale offline-queued
  -- start-pool-timer replay (or any concurrent racer) now fails cleanly
  -- with POOL_TABLE_OCCUPIED instead of silently creating a second
  -- concurrent session on an already-occupied table.
  IF v_status <> 'available' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_TABLE_OCCUPIED');
  END IF;

  -- p_tab_id is passed through verbatim including NULL -- the existing hook
  -- allows tabId: string | null and that contract must not change.
  INSERT INTO pool_sessions (table_id, tab_id)
  VALUES (p_table_id, p_tab_id)
  RETURNING * INTO v_session;

  UPDATE resources
  SET status = 'occupied', current_session_id = v_session.id
  WHERE id = p_table_id;

  RETURN jsonb_build_object('ok', true, 'session', to_jsonb(v_session));
END;
$$;

-- Deliberately NO role gate here (see header comment): the only current
-- caller path is bartender-accessible today via start_pool_timer, and a
-- manager+ gate would silently regress the manual pool flow. Mirrors the
-- explicit "deliberately does NOT add a manager/admin role gate" precedent
-- in remove_tab_item (20260721000005).
GRANT EXECUTE ON FUNCTION public.start_pool_session(uuid, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- (c) seat_waitlist_party_and_start_session
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seat_waitlist_party_and_start_session(
  p_entry_id uuid,
  p_table_id uuid,
  p_staff_id uuid,
  p_shift_id uuid,
  p_caja_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry      waitlist_entries%ROWTYPE;
  v_table_type text;
  v_status     text;
  v_tab_id     uuid;
  v_start      jsonb;
BEGIN
  -- Re-assert the waitlist_entries_update_manager RLS policy this function
  -- bypasses by running as the table owner, as the first statement before
  -- any read or write. Without this a bartender could seat parties and open
  -- tabs, which that policy forbids today. This restores, not adds, an
  -- authorization rule -- manage_waitlist already covers this on the client.
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  SELECT * INTO v_entry FROM waitlist_entries WHERE id = p_entry_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_entry.status = 'seated' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE_ENTRY');
  END IF;

  -- Lock the resource row here too, deliberately, before any write in this
  -- function. Taking this lock now means the later start_pool_session call
  -- cannot lose a race on this table -- the only remaining failure modes
  -- inside it are genuine exceptions, not a concurrent occupancy race.
  SELECT r.table_type, r.status::text INTO v_table_type, v_status
  FROM resources r
  WHERE r.id = p_table_id AND r.is_deleted = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_status <> 'available' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_TABLE_OCCUPIED');
  END IF;

  UPDATE waitlist_entries
  SET status = 'seated', table_id = p_table_id, seated_at = now()
  WHERE id = p_entry_id;

  -- floating branch (D-05/D-06): zero automation, preserving today's
  -- fully-manual behavior for the Phase-26 floating-table path.
  IF v_table_type = 'floating' THEN
    RETURN jsonb_build_object('ok', true, 'tab_id', NULL, 'session', NULL);
  END IF;

  -- D-01 tab-naming convention: "{name} ({party_size})", e.g. "García (4)".
  -- table_number is NULL, matching StartSessionSheet's existing call; the
  -- customer_name_or_table CHECK is satisfied by customer_name.
  INSERT INTO tabs (customer_name, table_number, staff_id, shift_id, status, notes, caja_session_id)
  VALUES (v_entry.name || ' (' || v_entry.party_size::text || ')', NULL, p_staff_id, p_shift_id, 'open', NULL, p_caja_session_id)
  RETURNING id INTO v_tab_id;

  -- consumption branch (D-06): tab only, no pool_sessions row. Deliberately
  -- do NOT set resources.status = 'occupied' here -- nothing in this
  -- codebase ever clears that status without a pool session to stop
  -- (deactivate_floating_resource fires on session stop only), so writing
  -- it would strand consumption tables as permanently occupied. Leaving
  -- status untouched preserves exactly today's behavior.
  IF v_table_type = 'consumption' THEN
    RETURN jsonb_build_object('ok', true, 'tab_id', v_tab_id, 'session', NULL);
  END IF;

  -- pool/carom branch (D-06): identical treatment for both.
  v_start := start_pool_session(p_table_id, v_tab_id);

  -- This RAISE is the single most load-bearing line in this migration.
  -- start_pool_session signals failure by RETURNING ok:false, and a plain
  -- return from a called plpgsql function does not roll anything back --
  -- without this RAISE the tab insert and the waitlist status update above
  -- would commit while no session exists, which is precisely the
  -- non-atomic outcome D-02 rejected.
  IF NOT COALESCE((v_start->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'SEAT_START_SESSION_FAILED:%', COALESCE(v_start->>'code', 'UNKNOWN')
      USING errcode = 'P0S01';
  END IF;

  RETURN jsonb_build_object('ok', true, 'tab_id', v_tab_id, 'session', v_start->'session');

  -- Fallback for an unrecognised table_type (schema CHECK should prevent
  -- this from ever being reached, but every branch must return explicitly).
  RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
END;
$$;

GRANT EXECUTE ON FUNCTION public.seat_waitlist_party_and_start_session(uuid, uuid, uuid, uuid, uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback -- Phase 8 standard).
-- Does NOT include DROP EXTENSION pg_net -- the pre-existing
-- trg_waitlist_notify trigger (20260501000003/20260501000004) depends on it.
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.seat_waitlist_party_and_start_session(uuid, uuid, uuid, uuid, uuid) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.seat_waitlist_party_and_start_session(uuid, uuid, uuid, uuid, uuid);
-- REVOKE EXECUTE ON FUNCTION public.start_pool_session(uuid, uuid) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.start_pool_session(uuid, uuid);
-- COMMIT;
-- =============================================================================
