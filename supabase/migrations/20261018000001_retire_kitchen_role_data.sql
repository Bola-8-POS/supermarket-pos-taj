-- Kitchen role removal (owner decision D29), step 1 of 4: data.
-- Reassigns every kitchen profile to cashier (Ruling 2: each gains selling power;
-- the owner reviews the before-list) and deletes kitchen role_permissions rows.
-- dev2 expectation: 3 profiles, 4 role_permissions rows.
-- Never touches auth.users (raw_user_meta_data.role is informational, never read).

WITH moved AS (
  UPDATE public.profiles SET role = 'cashier'::user_role
  WHERE role = 'kitchen'::user_role
  RETURNING id
)
INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, before, after, source)
SELECT NULL, 'staff.role_reassigned', 'profiles', id,
       jsonb_build_object('role', 'kitchen'), jsonb_build_object('role', 'cashier'), 'rpc'
FROM moved;

DELETE FROM public.role_permissions WHERE role = 'kitchen'::user_role;
