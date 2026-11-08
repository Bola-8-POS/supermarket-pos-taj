-- two-mode Plan 02c, Task 1 (Ruling 1): the RBAC action resolve_offline_sale gates
-- write-off, re-ring and move-to-review of an offline sale. It is granted to every
-- role that holds adjust_inventory at migration time (copied, not a fixed seed).
-- role_permissions.action is free text; manager_approvals.action has no CHECK.
INSERT INTO public.role_permissions (role, action)
SELECT role, 'resolve_offline_sale'
  FROM public.role_permissions
 WHERE action = 'adjust_inventory'
ON CONFLICT (role, action) DO NOTHING;
