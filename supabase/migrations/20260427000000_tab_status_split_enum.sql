-- =============================================================================
-- S4-01: Extend tab_status ENUM with 'split' value
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- This file intentionally has NO BEGIN/COMMIT wrapper.
-- Supabase CLI processes this migration outside a transaction automatically.
-- Run BEFORE 20260427000001_split_bill_schema.sql.
-- =============================================================================

ALTER TYPE tab_status ADD VALUE IF NOT EXISTS 'split';
