-- Phase 23-01: extend payment_method with 'bank_transfer'.
--
-- Ships alone in its own migration/transaction, never referenced by name in
-- the same file as anything that uses the new value (Pitfall 4) — Postgres
-- forbids using a freshly-added enum value in the same transaction that adds
-- it. 20260831000003_bank_transfers_schema.sql (which does reference it) is a
-- separate migration applied afterward.
--
-- One-way door: Postgres has no ALTER TYPE ... DROP VALUE. Confirmed via
-- checkpoint decision (2026-08-31): enum-extend chosen over text+CHECK or a
-- boolean flag — see .planning/phases/23-bank-transfer-payment-tracking/23-01-PLAN.md.
--
-- No DOWN script (project convention — Supabase Cloud has no automated
-- rollback mechanism, see CLAUDE.md).

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'bank_transfer';
