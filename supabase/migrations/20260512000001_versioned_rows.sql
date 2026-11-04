-- Phase 15 — versioned rows for optimistic concurrency (D-01, D-02, D-13)
-- Custom SQLSTATE P0V01 = STALE_VERSION; P0V02 = NOT_FOUND_VERSIONED (D-18)

alter table public.tabs add column if not exists version int not null default 1;
alter table public.pool_sessions add column if not exists version int not null default 1;
alter table public.caja_sessions add column if not exists version int not null default 1;

create or replace function public.bump_version_on_update()
returns trigger
language plpgsql
as $$
begin
  -- Guard: any UPDATE that does not advance version by exactly +1 is rejected.
  -- Both Group A (RPC guard) and Group B (hook .eq('version', expected) + version:expected+1)
  -- explicitly advance version by 1; this trigger is the universal backstop. (D-02)
  if new.version is distinct from (old.version + 1) then
    raise exception 'STALE_VERSION' using errcode = 'P0V01';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tabs_version on public.tabs;
create trigger trg_tabs_version
  before update on public.tabs
  for each row execute function public.bump_version_on_update();

drop trigger if exists trg_pool_sessions_version on public.pool_sessions;
create trigger trg_pool_sessions_version
  before update on public.pool_sessions
  for each row execute function public.bump_version_on_update();

drop trigger if exists trg_caja_sessions_version on public.caja_sessions;
create trigger trg_caja_sessions_version
  before update on public.caja_sessions
  for each row execute function public.bump_version_on_update();

-- DOWN (manual, Supabase Cloud has no automated rollback) — Phase 8 standard
-- drop trigger if exists trg_tabs_version on public.tabs;
-- drop trigger if exists trg_pool_sessions_version on public.pool_sessions;
-- drop trigger if exists trg_caja_sessions_version on public.caja_sessions;
-- drop function if exists public.bump_version_on_update();
-- alter table public.tabs drop column if exists version;
-- alter table public.pool_sessions drop column if exists version;
-- alter table public.caja_sessions drop column if exists version;
