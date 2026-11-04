\set ON_ERROR_STOP on
-- Assertions: line removal, refund bounds, stock adjustments, purchase
-- order guards, idempotency key.
-- Run as the migration role:
--   psql -v ON_ERROR_STOP=1 < scripts/sql/verify-stock-and-line-bounds.sql
-- Static catalog checks only; behavior lives in the *.integration.test.ts
-- files listed in the wave 3a plan.
DO $$
DECLARE
  v_bad     text;
  v_defargs_names text[] := ARRAY[
    'remove_tab_item', 'restore_inventory_on_order_item_delete', 'process_refund',
    'restore_inventory_on_refund_item', 'get_caja_report', 'adjust_inventory',
    'update_purchase_order_atomic', 'receive_shipment'
  ];
  v_name    text;
BEGIN
  -- 1. order_items has no DELETE policy left.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND cmd = 'DELETE') THEN
    RAISE EXCEPTION 'order_items still has a DELETE policy';
  END IF;

  -- 2. remove_tab_item: caller gate.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'remove_tab_item') <> 1 THEN
    RAISE EXCEPTION 'remove_tab_item must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'remove_tab_item'
      AND prosecdef
      AND prosrc LIKE '%auth.uid() IS NULL OR%'
      AND prosrc LIKE '%is_active = true%'
  ) THEN
    RAISE EXCEPTION 'remove_tab_item is missing the active-caller gate';
  END IF;

  -- 3. process_refund: per-line bounds, approver recorded, open-unit restock
  --    active and restocking by the refunded quantity (consume_open_unit),
  --    not the whole line (deplete_for_order_item read order_items.quantity).
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'process_refund') <> 1 THEN
    RAISE EXCEPTION 'process_refund must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'process_refund'
      AND prosrc LIKE '%REFUND_QTY_EXCEEDS_LINE%'
      AND prosrc LIKE '%REFUND_AMOUNT_EXCEEDS_LINE%'
      AND prosrc LIKE '%approved_by%'
      AND prosrc LIKE '%consume_open_unit(v_line.product_id, (v_item->>''qty'')::integer%'
      AND prosrc NOT LIKE '%undefined_function%'
  ) THEN
    RAISE EXCEPTION 'process_refund is missing the per-line bounds or restocks a loose product by the whole line instead of the refunded quantity';
  END IF;

  -- 4. restore_inventory_on_refund_item: weighed restock.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'restore_inventory_on_refund_item'
      AND prosrc LIKE '%sold_by_weight%' AND prosrc LIKE '%weight_grams%'
  ) THEN
    RAISE EXCEPTION 'restore_inventory_on_refund_item does not restore weighed products in grams';
  END IF;

  -- 5. restore_inventory_on_order_item_delete: real actor in the ledger row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'restore_inventory_on_order_item_delete'
      AND prosrc LIKE '%COALESCE(auth.uid(), o.staff_id)%'
  ) THEN
    RAISE EXCEPTION 'restore_inventory_on_order_item_delete does not name the real actor';
  END IF;

  -- 6. adjust_inventory: one RPC, locks the row, granted to authenticated
  --    and service_role, refused to anon, ledger + audit in the body.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'adjust_inventory') <> 1 THEN
    RAISE EXCEPTION 'adjust_inventory must exist exactly once';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.adjust_inventory(uuid, integer, text, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.adjust_inventory(uuid, integer, text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'adjust_inventory privileges are wrong';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'adjust_inventory'
      AND prosecdef
      AND prosrc LIKE '%FOR UPDATE%'
      AND prosrc LIKE '%STOCK_CHANGED%'
      AND prosrc LIKE '%record_audit%'
  ) THEN
    RAISE EXCEPTION 'adjust_inventory does not lock the row, check the expected quantity or write the audit row';
  END IF;

  -- 7. purchase_orders / purchase_order_items: no FOR ALL policy on
  --    purchase_orders; UPDATE and DELETE policies are draft-only; exactly
  --    one FOR ALL policy on purchase_order_items, also draft-only.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'purchase_orders' AND cmd = 'ALL') THEN
    RAISE EXCEPTION 'purchase_orders still has a FOR ALL policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'purchase_orders' AND cmd = 'UPDATE' AND qual LIKE '%draft%'
  ) THEN
    RAISE EXCEPTION 'purchase_orders UPDATE policy is not draft-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'purchase_orders' AND cmd = 'DELETE' AND qual LIKE '%draft%'
  ) THEN
    RAISE EXCEPTION 'purchase_orders DELETE policy is not draft-only';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'purchase_order_items' AND cmd = 'ALL') <> 1 THEN
    RAISE EXCEPTION 'purchase_order_items must have exactly one FOR ALL policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'purchase_order_items' AND cmd = 'ALL' AND qual LIKE '%draft%'
  ) THEN
    RAISE EXCEPTION 'purchase_order_items FOR ALL policy is not draft-only';
  END IF;

  -- 8. update_purchase_order_atomic: received orders refuse an update.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'update_purchase_order_atomic'
      AND prosrc LIKE '%PO_RECEIVED%' AND prosrc LIKE '%FOR UPDATE%'
  ) THEN
    RAISE EXCEPTION 'update_purchase_order_atomic does not guard against a received order';
  END IF;

  -- 9. receive_shipment: idempotency key argument, idempotent replay,
  --    unique index on shipments.idempotency_key.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'receive_shipment') <> 1 THEN
    RAISE EXCEPTION 'receive_shipment must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'receive_shipment'
      AND pg_get_function_identity_arguments(oid) LIKE '%p_idempotency_key text%'
      AND prosrc LIKE '%''idempotent'', true%'
  ) THEN
    RAISE EXCEPTION 'receive_shipment does not take an idempotency key or does not replay idempotently';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'shipments' AND indexname = 'shipments_idempotency_key_idx'
  ) THEN
    RAISE EXCEPTION 'shipments_idempotency_key_idx is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'shipments_idempotency_key_idx' AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'shipments_idempotency_key_idx is not unique';
  END IF;

  -- 10. get_caja_report: the cross-product join is gone, the aggregated
  --     subquery is in.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'get_caja_report'
      AND prosrc LIKE '%LEFT JOIN payments pay ON pay.tab_id = ANY(v_tab_ids)%'
  ) THEN
    RAISE EXCEPTION 'get_caja_report still joins payments directly to profiles';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'get_caja_report'
      AND prosrc LIKE '%GROUP BY processed_by%'
  ) THEN
    RAISE EXCEPTION 'get_caja_report does not aggregate payments by processed_by';
  END IF;

  -- 11. Every function named above that is SECURITY DEFINER pins search_path.
  FOREACH v_name IN ARRAY v_defargs_names LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = v_name AND prosecdef
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = v_name AND prosecdef
        AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
    ) THEN
      RAISE EXCEPTION '% is SECURITY DEFINER but does not pin search_path', v_name;
    END IF;
  END LOOP;
END $$;
SELECT 'verify-stock-and-line-bounds: ok' AS result;
