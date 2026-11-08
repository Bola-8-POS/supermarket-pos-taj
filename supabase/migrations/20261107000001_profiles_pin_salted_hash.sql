-- Plan 11H T14 (ruling P11-4, one migration for cloud and store databases):
-- profiles.pin holds a salted bcrypt hash instead of the 6-digit PIN.
--
-- * pin becomes text; the 6-digit CHECKs (pin_length, pin_numeric) and idx_profiles_pin go.
-- * Trigger profiles_hash_pin hashes a plaintext 6-digit value on INSERT and on UPDATE OF pin,
--   passes a bcrypt value through verbatim (compensation paths write a previous stored value
--   back), and rejects anything else with PIN_FORMAT. Writers keep sending the PIN.
-- * Existing rows are backfilled, then CHECK profiles_pin_is_bcrypt holds.
-- * verify_staff_pin and staff_pin_holder compare with crypt() (same signatures, grants, codes).
-- * staff_ids_with_pin(p_pin) is the hash-aware "who holds this PIN" lookup for service_role
--   (scripts and e2e helpers cannot use .eq('pin', ...) on a hash).
--
-- Forward-only: hashes cannot be reversed. Cost 8 (~10 ms per compare) is deliberate: a 30-staff
-- verify stays under 1 s, cost 10 is about 4x slower. Hash and pepper together in one snapshot
-- make an offline brute force of a 6-digit PIN feasible, so protection rests on restic backup
-- encryption and on the column privileges. 20260922000003_profile_privileges.sql already restricts
-- profiles.pin for anon/authenticated; check each production with
-- has_column_privilege('authenticated','public.profiles','pin','SELECT') (must be false).
-- pgcrypto lives in the `extensions` schema on this stack, so every call is schema-qualified.

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_profiles_pin;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS pin_length;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS pin_numeric;
-- Dropped first: a re-run cannot ALTER the type of a column a trigger depends on (recreated below).
DROP TRIGGER IF EXISTS profiles_hash_pin ON public.profiles;
ALTER TABLE public.profiles ALTER COLUMN pin TYPE text;

CREATE OR REPLACE FUNCTION public.profiles_hash_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.pin IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pin IS NOT DISTINCT FROM OLD.pin THEN
    RETURN NEW;
  END IF;
  IF NEW.pin ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RETURN NEW;
  END IF;
  IF NEW.pin ~ '^[0-9]{6}$' THEN
    NEW.pin := extensions.crypt(NEW.pin, extensions.gen_salt('bf', 8));
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PIN_FORMAT: a PIN is six digits' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.profiles_hash_pin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_hash_pin ON public.profiles;
CREATE TRIGGER profiles_hash_pin
  BEFORE INSERT OR UPDATE OF pin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_hash_pin();

-- Backfill: every remaining 6-digit value is hashed by the trigger (the value differs from the
-- old one only by being hashed, so the UPDATE writes the hash).
-- Guarded so a re-run on hashed rows issues no UPDATE (a statement-level store_fence_guard trigger
-- would raise STORE_FROZEN/STORE_MOVED even for zero rows).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE pin ~ '^[0-9]{6}$') THEN
    UPDATE public.profiles SET pin = extensions.crypt(pin, extensions.gen_salt('bf', 8)) WHERE pin ~ '^[0-9]{6}$';
  END IF;
END $$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_pin_is_bcrypt;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_pin_is_bcrypt CHECK (pin ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$');

-- Active staff holding p_pin (service role only).
CREATE OR REPLACE FUNCTION public.staff_ids_with_pin(p_pin text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id
  FROM profiles p
  WHERE p_pin ~ '^[0-9]{6}$'
    AND p.is_active = true
    AND p.pin = extensions.crypt(p_pin, p.pin);
$$;
REVOKE ALL ON FUNCTION public.staff_ids_with_pin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_ids_with_pin(text) TO service_role;

-- verify_staff_pin: unchanged except the comparison (20260922000004_approval_tickets.sql).
CREATE OR REPLACE FUNCTION public.verify_staff_pin(p_pin text, p_staff_id uuid DEFAULT NULL, p_required_action text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_key         text;
  v_wait        integer;
  v_matches     jsonb;
  v_approval_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  v_key := 'caller:' || v_uid::text;

  v_wait := pin_attempt_begin(v_key);
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LOCKED', 'retry_after', v_wait);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role) ORDER BY p.name)
    INTO v_matches
  FROM profiles p
  WHERE p.is_active = true
    AND p_pin ~ '^\d{6}$'
    AND (p_staff_id IS NULL OR p.id = p_staff_id)
    AND (p_required_action IS NULL OR EXISTS (
      SELECT 1 FROM role_permissions rp WHERE rp.role = p.role AND rp.action = p_required_action
    ))
    AND p.pin = extensions.crypt(p_pin, p.pin);

  IF v_matches IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PIN', 'retry_after', pin_attempt_retry_after(v_key));
  END IF;

  PERFORM pin_attempt_record(v_key, true);
  IF p_required_action IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'matches', v_matches);
  END IF;
  DELETE FROM manager_approvals WHERE created_at < now() - interval '1 day';
  DELETE FROM pin_attempts WHERE updated_at < now() - interval '1 day';
  INSERT INTO manager_approvals (caller_id, action, approver_ids)
  VALUES (v_uid, p_required_action,
          (SELECT array_agg((m->>'id')::uuid) FROM jsonb_array_elements(v_matches) m))
  RETURNING id INTO v_approval_id;
  RETURN jsonb_build_object('ok', true, 'matches', v_matches, 'approval_id', v_approval_id);
END;
$$;

-- staff_pin_holder: unchanged except the comparison (20260922000003_profile_privileges.sql).
CREATE OR REPLACE FUNCTION public.staff_pin_holder(p_pin text, p_exclude_staff_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
  v_wait integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role = get_user_role() AND rp.action = 'manage_staff'
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: staff management permission required';
  END IF;

  v_wait := pin_attempt_begin('holder:' || auth.uid()::text);
  IF v_wait > 0 THEN
    RAISE EXCEPTION 'PIN_LOCKED: retry after % seconds', v_wait;
  END IF;

  SELECT p.name INTO v_name
  FROM profiles p
  WHERE p.is_active = true
    AND p_pin ~ '^[0-9]{6}$'
    AND p.pin = extensions.crypt(p_pin, p.pin)
    AND (p_exclude_staff_id IS NULL OR p.id <> p_exclude_staff_id)
  ORDER BY p.name
  LIMIT 1;

  RETURN v_name;
END;
$$;

NOTIFY pgrst, 'reload schema';
