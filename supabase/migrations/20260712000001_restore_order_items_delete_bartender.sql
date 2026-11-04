-- =============================================================================
-- Restore the bartender DELETE policy on order_items
--
-- 20260420165000_order_items_bartender_delete.sql originally added
-- "order_items_delete_bartender" so the remove-item feature works: the
-- ManagerPinDialog gates the UI client-side, and after PIN approval the
-- DELETE still runs under the acting bartender's own auth token (the PIN
-- check does not re-authenticate as a manager).
--
-- 20260510000001_rls_rewrite_phase13.sql rewrote every order_items policy
-- from scratch. Its own section header comment says "order_items (bartender
-- SELECT+insert+delete; kitchen SELECT+update for kds_status)" but the
-- CREATE POLICY for bartender delete was never written — only
-- order_items_delete_manager_admin was recreated. This silently broke
-- bartender-initiated item removal (with manager PIN override) ever since,
-- surfaced by e2e/16-table-status.spec.ts T7 failing with the remove button
-- count never decreasing (RLS filters the DELETE to 0 rows, no error).
-- =============================================================================

-- UP:
BEGIN;

CREATE POLICY "order_items_delete_bartender" ON order_items
  FOR DELETE TO authenticated
  USING (get_user_role() = 'bartender');

COMMIT;

-- DOWN:
-- BEGIN;
-- DROP POLICY IF EXISTS "order_items_delete_bartender" ON order_items;
-- COMMIT;
