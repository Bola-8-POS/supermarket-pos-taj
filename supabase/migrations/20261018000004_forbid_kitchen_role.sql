-- Kitchen role removal (D29), step 4 of 4: constraints.
-- Ruling 1: Postgres cannot drop an enum label, and recreating user_role would mean
-- dropping/re-creating ~110 dependent policies. The label 'kitchen' therefore STAYS in
-- user_role (and in supabase.types.ts); the role is made unrepresentable by an allow-list
-- CHECK, which also refuses any label added later. Validated on add: fails if a kitchen
-- row survived steps 1-3, which is the intent.

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_not_kitchen CHECK (role IN ('cashier', 'manager', 'admin'));
ALTER TABLE public.role_permissions
  ADD CONSTRAINT role_permissions_role_not_kitchen CHECK (role IN ('cashier', 'manager', 'admin'));
