-- Profile privileges: column grants on profiles, retired PIN-change RPC,
-- search_path on definer functions, attempt limit on the PIN holder lookup.
--
-- 1. profiles: the anon policy goes; the client roles keep only the columns
--    the app reads (SELECT) and writes (UPDATE role, locale). Inserts and
--    deletes go through edge functions with the service role. The sign-in
--    list reads staff_directory, which is owned by postgres and unaffected.
-- 2. clear_must_change_pin is retired: change-own-pin replaced it.
-- 3. Every SECURITY DEFINER function in public pins search_path.
-- 4. staff_pin_holder counts each lookup against its own attempt key
--    (holder:<caller>), separate from the manager prompt's caller: key, so
--    the lookup goes quiet after five calls without affecting the prompt.

DROP POLICY IF EXISTS "profiles_select_anon" ON public.profiles;
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, name, role, is_active, created_at, updated_at, deleted_at, must_change_pin, locale)
  ON public.profiles TO authenticated;
GRANT UPDATE (role, locale) ON public.profiles TO authenticated;

DROP FUNCTION public.clear_must_change_pin(text, text);

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prosecdef
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.fn);
  END LOOP;
END $$;

-- Name of an active staff member who already uses p_pin (NULL when free).
-- Staff managers only; used for the duplicate warning when a PIN is reset.
-- Each lookup counts against the lookup's own five-attempt budget (key
-- holder:<caller>), separate from the manager prompt's budget.
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
    AND p.pin = p_pin
    AND (p_exclude_staff_id IS NULL OR p.id <> p_exclude_staff_id)
  ORDER BY p.name
  LIMIT 1;

  RETURN v_name;
END;
$$;

NOTIFY pgrst, 'reload schema';
