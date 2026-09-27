-- =============================================================================
-- Phase 20 (promotions-engine), Plan 10 Task 2: [BLOCKING] destructive drop of
-- the legacy happy-hour columns.
--
-- Paired follow-up to 20260710000007_migrate_happy_hour_data.sql (additive
-- data migration into the promotions engine) and gated behind:
--   - Plan 20-09's server-side parity gate (evaluate_promotions_for_item
--     reproduces every legacy resolveProductPrice() charged price)
--   - Human UAT approval ("Proceed on automated gates only", 2026-07-10)
--   - Plan 20-10 Task 1 (this plan): every DB-typed consumer of these columns
--     was neutralized first, so nothing reads/writes them anymore
--     (categories/products/tab/inventory queries.ts all supply/expect null).
--
-- Irreversible (Pitfall 4): once dropped, the legacy columns cannot be
-- restored without re-deriving values from the promotions data created by
-- the paired additive migration. No DOWN section is provided for the drop
-- itself; see that migration's DOWN block to remove the derived promotions
-- if this needs to be unwound at the promotions layer instead.
-- =============================================================================

BEGIN;

ALTER TABLE categories DROP COLUMN IF EXISTS happy_hour_start;
ALTER TABLE categories DROP COLUMN IF EXISTS happy_hour_end;
ALTER TABLE products DROP COLUMN IF EXISTS happy_hour_price;

COMMIT;

NOTIFY pgrst, 'reload schema';
