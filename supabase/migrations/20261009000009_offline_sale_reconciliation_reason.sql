-- Add 'offline_sale_reconciliation' to stock_movements_reason_check (Plan 02c, Task 10).
-- Same DROP+ADD ... NOT VALID pattern as 20260819000005_add_expired_reason.sql, whose twelve
-- values are carried forward. adjust_inventory passes the reason through unchecked, so no
-- function changes.
BEGIN;

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IN (
    'sale',
    'manual_adjustment',
    'waste',
    'delivery',
    'correction',
    'physical_count',
    'prep_production',
    'prep_consumption',
    'combo_component',
    'refund',
    'void',
    'expired',
    'offline_sale_reconciliation'
  )) NOT VALID;

COMMIT;
