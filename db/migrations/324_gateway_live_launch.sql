-- 324_gateway_live_launch.sql (T151)
--
-- ينشئ جدول `platform_gateway_launch` للتحكم على مستوى المنصة في السماح
-- بتشغيل كل مزوّد بوابة دفع في الوضع الفعلي (SC-012)، ويضيف مشغّلاً على
-- `gateway_connections` يمنع ضبط `mode = 'live'` قبل تفعيل الإذن للمزوّد.
--
-- Rollback:
--   drop trigger if exists gateway_connections_guard_live on public.gateway_connections;
--   drop function if exists public.tg_gateway_connections_guard_live();
--   drop trigger if exists set_updated_at on public.platform_gateway_launch;
--   drop table if exists public.platform_gateway_launch;

------------------------------------------------------------
-- 1. platform_gateway_launch table & RLS
------------------------------------------------------------

create table if not exists public.platform_gateway_launch (
  provider text primary key check (provider in ('myfatoorah', 'tap', 'upayments')),
  live_allowed boolean not null default false,
  checklist_note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.platform_gateway_launch;
create trigger set_updated_at
  before update on public.platform_gateway_launch
  for each row execute function public.tg_set_updated_at();

alter table public.platform_gateway_launch enable row level security;
alter table public.platform_gateway_launch force row level security;

revoke all on public.platform_gateway_launch from public, anon, authenticated, company_service;
grant all on public.platform_gateway_launch to service_role;

drop policy if exists platform_gateway_launch_service_role_all on public.platform_gateway_launch;
create policy platform_gateway_launch_service_role_all
  on public.platform_gateway_launch
  for all
  to service_role
  using (true)
  with check (true);

insert into public.platform_gateway_launch (provider, live_allowed)
values
  ('myfatoorah', false),
  ('tap', false),
  ('upayments', false)
on conflict (provider) do nothing;

------------------------------------------------------------
-- 2. Guard trigger on gateway_connections
------------------------------------------------------------

/**
 * يمنع إدراج اتصال بوابة دفع أو تحويله إلى الوضع الفعلي (`mode = 'live'`)
 * ما لم يكن المزوّد مفعّلاً في `platform_gateway_launch` (SC-012).
 *
 * Uses `security definer` so `company_service` does not need any grant on
 * `platform_gateway_launch`. Existing `live` connections are not blocked on
 * unrelated updates (such as deactivation or test-status updates) when the
 * flag is later turned off.
 */
create or replace function public.tg_gateway_connections_guard_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.mode = 'live'
     and (tg_op = 'INSERT' or new.mode is distinct from old.mode) then
    if not exists (
      select 1
        from public.platform_gateway_launch p
       where p.provider = new.provider
         and p.live_allowed = true
    ) then
      raise exception 'GATEWAY_LIVE_NOT_ALLOWED';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists gateway_connections_guard_live on public.gateway_connections;
create trigger gateway_connections_guard_live
  before insert or update of mode on public.gateway_connections
  for each row execute function public.tg_gateway_connections_guard_live();

-- A trigger function is never called directly: no API role may execute it.
revoke all on function public.tg_gateway_connections_guard_live() from public, anon, authenticated;
