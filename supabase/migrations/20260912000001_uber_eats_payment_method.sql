-- Configurable payment methods: extend payment_method with 'uber_eats'.
--
-- 'uber_eats' becomes a "platform tender" alongside 'rappi' — the delivery
-- platform collected the money, so at the POS it behaves exactly like 'card'
-- (no tendered amount, optional free-text reference, tax applies normally,
-- no cash drawer). The Rappi-era coupling (rappi_order_id match, zero-tax
-- carve-out) is removed for both platform tenders in the follow-up migration
-- (20260912000002_platform_tenders_rappi_uber_eats.sql).
--
-- Ships alone in its own migration/transaction (Pitfall 4, same as
-- 20260831000002_bank_transfer_payment_method.sql) — Postgres forbids using a
-- freshly-added enum value in the same transaction that adds it.
--
-- One-way door: Postgres has no ALTER TYPE ... DROP VALUE.
--
-- No DOWN script (project convention — Supabase Cloud has no automated
-- rollback mechanism, see CLAUDE.md).

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'uber_eats';
