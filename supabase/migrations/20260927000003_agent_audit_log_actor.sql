-- Bind the agent-audit insert policy to the writing session.
--
-- agent_audit_log_insert_authenticated previously allowed any authenticated
-- session to insert a row naming any user_id. The client already sends its
-- own session's staff id and role with every row; this migration makes the
-- server refuse a row whose user_id does not match the inserting session,
-- so the audit table can no longer be filled with another staff member's id.
-- user_role stays client-attested (unchanged): binding on role too would
-- silently drop rows after a mid-session role change, since the client's
-- role value is store state, not re-derived from the JWT.

DROP POLICY IF EXISTS agent_audit_log_insert_authenticated ON public.agent_audit_log;

CREATE POLICY agent_audit_log_insert_authenticated ON public.agent_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
