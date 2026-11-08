-- =============================================================================
-- S2-04: product_combo_usage reporting view
-- =============================================================================

-- UP: product_combo_usage reporting view
BEGIN;

CREATE OR REPLACE VIEW product_combo_usage AS
SELECT
  p.id            AS product_id,
  p.name          AS product_name,
  oi_parent.id    AS parent_order_item_id,
  oi_parent.created_at AS ordered_at,
  t.id            AS tab_id,
  t.customer_name AS tab_name,
  COUNT(oi_child.id) AS child_item_count
FROM order_items oi_parent
JOIN products p ON p.id = oi_parent.product_id AND p.is_combo = true
LEFT JOIN order_items oi_child ON oi_child.parent_order_item_id = oi_parent.id
LEFT JOIN orders o ON o.id = oi_parent.order_id
LEFT JOIN tabs t ON t.id = o.tab_id
WHERE oi_parent.parent_order_item_id IS NULL
GROUP BY p.id, p.name, oi_parent.id, oi_parent.created_at, t.id, t.customer_name;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP VIEW IF EXISTS product_combo_usage;
-- COMMIT;
-- =============================================================================
