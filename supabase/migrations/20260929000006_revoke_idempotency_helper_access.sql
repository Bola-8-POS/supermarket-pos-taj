-- Opus re-review task 1 (Important) fix. 20260929000001's `REVOKE ALL ... FROM PUBLIC` on
-- idempotency_begin/idempotency_commit does not remove the schema-public default privilege
-- (20260921000001) that separately grants EXECUTE to `authenticated`. Both helpers are
-- SECURITY DEFINER and trust a caller-supplied p_staff, so any signed-in staff member could
-- call them directly via PostgREST to plant, read, or overwrite another staff member's
-- ledger row ahead of the real RPC's replay. Follow the sibling pattern used for
-- pin_attempt_* (20260921000003) and rate_limit_hit (20260925000001): revoke from
-- PUBLIC, anon and authenticated explicitly, keep service_role only. The five adopting RPCs
-- are unaffected — they run as SECURITY DEFINER owners, not as `authenticated`.
--
-- This must be a new migration: 20260929000001 is already applied on dev2, so its own
-- REVOKE/GRANT statements cannot be edited in place.

REVOKE ALL ON FUNCTION public.idempotency_begin(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idempotency_commit(text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.rpc_idempotency FROM PUBLIC, anon, authenticated;
