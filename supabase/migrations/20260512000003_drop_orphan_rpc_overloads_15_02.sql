-- =============================================================================
-- Phase 15 Plan 02 follow-up — drop orphan RPC overloads.
--
-- The CREATE OR REPLACE FUNCTION calls in 20260512000002_rpc_versioned_group_a.sql
-- changed the parameter list (added p_expected_version) which, in Postgres,
-- creates a NEW overload rather than replacing the old function. The old
-- signatures (without p_expected_version) remained live and would silently
-- bypass the version guard for any caller that omitted the new parameter.
--
-- This migration drops the now-orphan overloads so only the version-guarded
-- canonical signatures remain. Applied directly to remote on 2026-04-28
-- via Supabase MCP after live verification surfaced the duplicate signatures;
-- captured here so fresh deploys (and Wave 6 integration tests) are correct
-- from a clean replay.
-- =============================================================================

DROP FUNCTION IF EXISTS public.process_payment_atomic(
  uuid, uuid, numeric, numeric, text, text, numeric, text, text, text, text, numeric, numeric
);

DROP FUNCTION IF EXISTS public.create_order_with_items(
  uuid, uuid, order_status, text, jsonb
);

DROP FUNCTION IF EXISTS public.create_order_with_items(
  uuid, uuid, order_status, text, jsonb, boolean
);

-- =============================================================================
-- DOWN:
-- No-op. Restoring the old signatures is destructive (would re-introduce the
-- version-guard bypass). Use 20260511000002_rpc_audit_wiring.sql and
-- 20260428000003_create_order_with_items_v2.sql to recreate the prior shapes
-- if you truly need to roll back the entire Phase 15 RPC migration set.
-- =============================================================================
