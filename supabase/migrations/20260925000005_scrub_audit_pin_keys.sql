-- Data migration (owner sign-off recorded in the portal on 2026-09-25): historic
-- audit payloads drop the same keys audit_redact removes from new rows. Idempotent.
DO $$
DECLARE v_count integer;
BEGIN
  WITH hit AS (
    UPDATE audit_logs
       SET before = audit_redact(before),
           after  = audit_redact(after)
     WHERE before IS DISTINCT FROM audit_redact(before)
        OR after  IS DISTINCT FROM audit_redact(after)
     RETURNING 1
  ) SELECT count(*) INTO v_count FROM hit;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source)
  VALUES (NULL, 'audit.redact_keys', 'audit_logs', NULL, NULL,
          jsonb_build_object('rowsUpdated', v_count, 'keys', jsonb_build_array('pin','old_pin','new_pin','manager_pin')), 'rpc');
  RAISE NOTICE 'audit_logs rows updated: %', v_count;
END $$;

-- Redact on insert too, so a direct insert through the WITH CHECK (true)
-- insert policy is covered and the scrub's guarantee holds for future rows.
CREATE OR REPLACE FUNCTION public.audit_logs_redact_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.before := audit_redact(NEW.before);
  NEW.after := audit_redact(NEW.after);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_redact ON audit_logs;
CREATE TRIGGER audit_logs_redact
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_logs_redact_on_insert();
