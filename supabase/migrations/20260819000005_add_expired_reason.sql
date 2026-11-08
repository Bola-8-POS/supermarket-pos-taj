-- Add 'expired' to the stock_movements_reason_check CHECK constraint (D-01).
-- Mirrors 20260422000003_add_physical_count_reason.sql's DROP+ADD CONSTRAINT ... NOT VALID
-- pattern — NOT VALID skips scanning historical rows, matching every prior migration on
-- this table.
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
    'expired'
  )) NOT VALID;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
-- ALTER TABLE stock_movements
--   ADD CONSTRAINT stock_movements_reason_check
--   CHECK (reason IN (
--     'sale',
--     'manual_adjustment',
--     'waste',
--     'delivery',
--     'correction',
--     'physical_count',
--     'prep_production',
--     'prep_consumption',
--     'combo_component',
--     'refund',
--     'void'
--   )) NOT VALID;
-- COMMIT;
-- =============================================================================
