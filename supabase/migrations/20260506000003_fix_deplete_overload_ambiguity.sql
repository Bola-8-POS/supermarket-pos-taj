-- =============================================================================
-- Fix: drop deplete_for_order_item(uuid, smallint) v1 overload
--
-- Problem: both v1 (uuid, smallint) and v2 (uuid, smallint, boolean DEFAULT false)
-- match 2-arg calls — PostgreSQL raises "function is not unique".
-- Callers in create_order_with_items, add_combo_to_tab, process_refund all use
-- 2-arg form. After dropping v1, those calls unambiguously resolve to v2 with
-- p_allow_negative=false, which is identical behavior to v1.
--
-- Depends on: 20260428000004_deplete_for_order_item_v2.sql (v2 must exist first)
-- =============================================================================

-- UP:
DROP FUNCTION IF EXISTS deplete_for_order_item(uuid, smallint);

-- DOWN:
-- Re-create v1 if needed (see 20260428000002_deplete_for_order_item.sql for body).
