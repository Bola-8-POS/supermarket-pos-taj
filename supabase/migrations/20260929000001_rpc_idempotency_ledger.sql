-- Generic idempotency ledger. Copies the semantics already proven in
-- process_direct_sale_atomic (ownership-scoped key, lookup before work, replay returns the
-- original response) so that RPCs without a natural "one row per operation" to hang a key on
-- can be made replay-safe uniformly. Needed because an offline queue will retry these calls.
--
-- pgcrypto on this stack is installed in the `extensions` schema, not `public` (verified via
-- `select extname, extnamespace::regnamespace from pg_extension where extname='pgcrypto'` on
-- supabase_db_supermarket-pos-dev2 -> `extensions`; `show search_path` on the same instance is
-- `"$user", public, extensions`, which is NOT the `public, pg_temp` search_path these
-- SECURITY DEFINER functions run under). So digest() is schema-qualified as extensions.digest()
-- below rather than relying on search_path resolution.

CREATE TABLE IF NOT EXISTS public.rpc_idempotency (
  idempotency_key text PRIMARY KEY,
  rpc_name        text NOT NULL,
  staff_id        uuid NOT NULL REFERENCES public.profiles(id),
  scope_hash      text NOT NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rpc_idempotency_created_at
  ON public.rpc_idempotency (created_at);

ALTER TABLE public.rpc_idempotency ENABLE ROW LEVEL SECURITY;
-- No policy: the table is written and read only by SECURITY DEFINER helpers below.
-- Deliberately no grants to anon/authenticated.

CREATE OR REPLACE FUNCTION public.idempotency_begin(
  p_key   text,
  p_rpc   text,
  p_staff uuid,
  p_scope text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.rpc_idempotency;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' OR length(p_key) > 255 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_INVALID: key must be 1-255 non-blank characters';
  END IF;

  -- Callers do begin -> real work -> commit inside one RPC transaction. Without this lock, two
  -- concurrent calls with the same key both see NULL here and both perform the real work. This
  -- transaction-scoped advisory lock makes the second caller block until the first commits (or
  -- rolls back), so its SELECT below then sees the row the first caller stored.
  PERFORM pg_advisory_xact_lock(hashtextextended('rpc_idempotency:' || p_key, 0));

  SELECT * INTO v_row FROM public.rpc_idempotency WHERE idempotency_key = p_key;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.rpc_name IS DISTINCT FROM p_rpc THEN
    RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key already used by a different operation';
  END IF;
  IF v_row.staff_id IS DISTINCT FROM p_staff THEN
    RAISE EXCEPTION 'IDEMPOTENCY_UNAUTHORIZED: not authorized to replay this operation';
  END IF;
  IF v_row.scope_hash IS DISTINCT FROM encode(extensions.digest(p_scope, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key replayed with different arguments';
  END IF;

  RETURN v_row.result;
END;
$$;

CREATE OR REPLACE FUNCTION public.idempotency_commit(
  p_key    text,
  p_rpc    text,
  p_staff  uuid,
  p_scope  text,
  p_result jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  INSERT INTO public.rpc_idempotency (idempotency_key, rpc_name, staff_id, scope_hash, result)
  VALUES (p_key, p_rpc, p_staff, encode(extensions.digest(p_scope, 'sha256'), 'hex'), p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT result INTO v_result FROM public.rpc_idempotency WHERE idempotency_key = p_key;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.idempotency_begin(text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idempotency_commit(text, text, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.idempotency_begin(text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.idempotency_commit(text, text, uuid, text, jsonb) TO service_role;
