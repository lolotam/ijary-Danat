-- 319_gateway_connections.sql (T141)
--
-- ينشئ جدول `gateway_connections` لإعدادات بوابات الدفع لكل شركة (MyFatoorah وTap
-- وUPayments)، ويفرض وجود اتصال نشط واحد فقط لكل شركة بعد نجاح الاختبار،
-- ويوسّع `payment_requests` و`webhook_events` لربط كل معاملة بالاتصال وإصداره.
--
-- Per data-model.md section 3 & research.md R14:
--   - `gateway_connections`: one row per `(company_id, provider)`, at most one
--     `is_active = true` row per company via partial unique index (FR-056).
--   - Activation requires a recorded passing test (`last_test_ok = true` and
--     `last_test_at is not null`), enforced by CHECK constraint plus a trigger
--     that invalidates test state and deactivates on credential rotation (FR-055).
--   - `payment_requests` records `gateway_connection_id` and `credentials_version`
--     with a composite FK `(company_id, gateway_connection_id)` so settlement
--     uses the exact connection/version that initiated the request (FR-057).
--   - `webhook_events` records `connection_id` and `provider` with a composite FK
--     `(company_id, connection_id)` and unique `(provider, connection_id,
--     provider_event_id)` for replay protection.
--
-- Rollback:
--   drop index if exists public.webhook_events_provider_connection_event_uidx;
--   alter table public.webhook_events drop constraint if exists webhook_events_company_connection_fkey;
--   alter table public.webhook_events drop column if exists provider, drop column if exists connection_id;
--   alter table public.payment_requests drop constraint if exists payment_requests_company_gateway_connection_fkey;
--   alter table public.payment_requests drop column if exists credentials_version, drop column if exists gateway_connection_id;
--   drop trigger if exists gateway_connections_guard_activation on public.gateway_connections;
--   drop function if exists public.tg_gateway_connections_guard_activation();
--   drop table if exists public.gateway_connections;

------------------------------------------------------------
-- 1. gateway_connections
------------------------------------------------------------

create table if not exists public.gateway_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('myfatoorah', 'tap', 'upayments')),
  mode text not null default 'test' check (mode in ('test', 'live')),
  public_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(public_config) = 'object'),
  is_active boolean not null default false,
  last_test_at timestamptz,
  last_test_ok boolean not null default false,
  last_test_message text,
  credentials_version int not null default 1 check (credentials_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, provider),
  constraint gateway_connections_active_requires_passing_test
    check (not is_active or (last_test_ok and last_test_at is not null))
);

create unique index if not exists gateway_connections_one_active_per_company
  on public.gateway_connections (company_id)
  where is_active;

/**
 * يبطل نتيجة الاختبار السابق ويعطّل الاتصال تلقائياً عند تدوير بيانات الاعتماد
 * دون تسجيل اختبار جديد في نفس التحديث (FR-055).
 */
create or replace function public.tg_gateway_connections_guard_activation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.credentials_version is distinct from old.credentials_version
     and new.last_test_at is not distinct from old.last_test_at then
    new.last_test_ok := false;
    new.last_test_at := null;
    new.last_test_message := null;
    new.is_active := false;
  end if;
  return new;
end;
$$;

drop trigger if exists gateway_connections_guard_activation on public.gateway_connections;
create trigger gateway_connections_guard_activation
  before update on public.gateway_connections
  for each row execute function public.tg_gateway_connections_guard_activation();

drop trigger if exists set_updated_at on public.gateway_connections;
create trigger set_updated_at
  before update on public.gateway_connections
  for each row execute function public.tg_set_updated_at();

alter table public.gateway_connections enable row level security;
alter table public.gateway_connections force row level security;

revoke all on public.gateway_connections from public, anon, authenticated, company_service;
grant select on public.gateway_connections to authenticated;
grant select, insert, update, delete on public.gateway_connections to company_service;
grant all on public.gateway_connections to service_role;

drop policy if exists gateway_connections_select_staff on public.gateway_connections;
create policy gateway_connections_select_staff
  on public.gateway_connections
  for select
  to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'::text))
  );

drop policy if exists gateway_connections_company_service_all on public.gateway_connections;
create policy gateway_connections_company_service_all
  on public.gateway_connections
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

drop policy if exists gateway_connections_service_role_all on public.gateway_connections;
create policy gateway_connections_service_role_all
  on public.gateway_connections
  for all
  to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. payment_requests (extended)
------------------------------------------------------------

alter table public.payment_requests
  add column if not exists gateway_connection_id uuid,
  add column if not exists credentials_version int
    check (credentials_version is null or credentials_version >= 1);

alter table public.payment_requests drop constraint if exists payment_requests_company_gateway_connection_fkey;
alter table public.payment_requests
  add constraint payment_requests_company_gateway_connection_fkey
    foreign key (company_id, gateway_connection_id)
    references public.gateway_connections (company_id, id)
    on delete restrict;

create index if not exists payment_requests_company_gateway_connection_idx
  on public.payment_requests (company_id, gateway_connection_id)
  where gateway_connection_id is not null;

------------------------------------------------------------
-- 3. webhook_events (extended)
------------------------------------------------------------

alter table public.webhook_events
  add column if not exists connection_id uuid,
  add column if not exists provider text
    check (provider is null or provider in ('myfatoorah', 'tap', 'upayments'));

update public.webhook_events
   set provider = gateway::text
 where provider is null;

alter table public.webhook_events drop constraint if exists webhook_events_company_connection_fkey;
alter table public.webhook_events
  add constraint webhook_events_company_connection_fkey
    foreign key (company_id, connection_id)
    references public.gateway_connections (company_id, id)
    on delete restrict;

create unique index if not exists webhook_events_provider_connection_event_uidx
  on public.webhook_events (provider, connection_id, provider_event_id)
  where provider is not null
    and connection_id is not null
    and provider_event_id is not null;
