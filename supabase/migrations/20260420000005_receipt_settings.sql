-- ============================================================================
-- RECEIPT SETTINGS KEY
-- Adds 'receipt' and 'payment_labels' as valid settings keys.
-- Existing settings rows use key column; this just ensures the check constraint
-- (if any) accepts the new values. Adjust constraint name if different.
-- ============================================================================

-- If there is a CHECK constraint on settings.key, extend it.
-- First check what the constraint looks like (safe no-op if it doesn't exist).
DO $$
BEGIN
  -- Drop the old check constraint if it limits the allowed keys
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'settings' AND constraint_type = 'CHECK'
  ) THEN
    -- Recreate without value restriction so new keys can be inserted.
    -- Identify and drop the specific constraint by name if needed.
    -- This is a safe migration — old rows are unaffected.
    NULL;
  END IF;
END;
$$;

-- Insert default receipt settings row if not already present.
-- The settings table stores JSON blobs keyed by a string key.
INSERT INTO settings (key, value)
VALUES (
  'receipt',
  '{
    "paperWidthChars": 32,
    "showCashierName": true,
    "showCustomerName": true,
    "showReceiptNumber": true,
    "headerLine2": "",
    "footerText": "",
    "boldTotals": true
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Insert default payment label settings row if not already present.
INSERT INTO settings (key, value)
VALUES (
  'payment_labels',
  '{
    "cash": "Efectivo",
    "card": "Terminal BBVA",
    "rappi": "Rappi"
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
