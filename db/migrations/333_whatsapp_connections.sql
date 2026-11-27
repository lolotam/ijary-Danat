-- 333_whatsapp_connections.sql (T158)
--
-- ينشئ جدول `whatsapp_connections` لإعدادات ربط واتساب لكل شركة (QR عبر Evolution،
-- أو Cloud API الرسمي، أو Coexistence)، ويفرض وجود طريقة نشطة واحدة فقط لكل شركة
-- وتفرّد الرقم النشط ومعرّف رقم الهاتف عالمياً عبر الشركات لمنع التداخل في توجيه
-- الويب هوك. كما يرحّل البيانات من `evolution_connections`، ويضيف `connection_id`
-- إلى جداول `whatsapp_*` الأربعة مع مفتاح أجنبي مركّب ومشغّل تعبئة تلقائي،
--
-- Per spec.md User Story 9 (FR-062..FR-064), data-model.md section 5, and
-- research.md R15:
--   - `whatsapp_connections`: one row per `(company_id, method)`, at most one
--     `is_active = true` row per company via partial unique index.
--   - Global uniqueness on active normalized `connected_number` and active
--     `phone_number_id` across all companies: WhatsApp numbers and Meta
--     `phone_number_id`s are globally unique external routing keys for inbound
--     webhooks (`/api/public/webhooks/meta` and Evolution), so two companies
--     cannot simultaneously hold the same active number or `phone_number_id`.
--   - `evolution_connections` is kept intact for now (removed in T159–T162).
--     `platform_company_health()` keeps reading it until the Evolution code
--     writes `whatsapp_connections` (T159–T162); switching earlier would show
--     the one-time backfill as live status.
--   - `connection_id` on the four `whatsapp_*` tables is nullable with a
--     BEFORE INSERT trigger that fills it from the company's active connection
--     when omitted, so existing inserts keep working without changing app code
--     in this slice, while any non-null `connection_id` is enforced by the
--     composite FK `(company_id, connection_id)` -> `whatsapp_connections (company_id, id)`.
--
-- Rollback:
--   drop trigger if exists whatsapp_chats_set_connection on public.whatsapp_chats;
--   drop trigger if exists whatsapp_contacts_set_connection on public.whatsapp_contacts;
--   drop trigger if exists whatsapp_messages_set_connection on public.whatsapp_messages;
--   drop trigger if exists whatsapp_contact_contracts_set_connection on public.whatsapp_contact_contracts;
--   drop function if exists public.tg_whatsapp_default_connection();
--   alter table public.whatsapp_contact_contracts drop constraint if exists whatsapp_contact_contracts_company_connection_fkey;
--   alter table public.whatsapp_contact_contracts drop column if exists connection_id;
--   alter table public.whatsapp_messages drop constraint if exists whatsapp_messages_company_connection_fkey;
--   alter table public.whatsapp_messages drop column if exists connection_id;
--   alter table public.whatsapp_contacts drop constraint if exists whatsapp_contacts_company_connection_fkey;
--   alter table public.whatsapp_contacts drop column if exists connection_id;
--   alter table public.whatsapp_chats drop constraint if exists whatsapp_chats_company_connection_fkey;
--   alter table public.whatsapp_chats drop column if exists connection_id;
--   drop table if exists public.whatsapp_connections;

------------------------------------------------------------
-- 1. whatsapp_connections
------------------------------------------------------------

create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default public.current_company_id()
    references public.companies(id) on delete cascade,
  method text not null
    check (method in ('evolution_qr', 'cloud_api', 'cloud_coexistence')),
  is_active boolean not null default false,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'pairing', 'connected', 'error')),
  connected_number text,
  instance_name text,
  phone_number_id text,
  waba_id text,
  -- Pairing credential: excluded from `authenticated` column-level SELECT grant.
  last_qr text,
  last_seen_at timestamptz,
  last_error text,
  disconnect_alert_armed boolean not null default false,
  disconnected_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, method)
);

-- At most one active WhatsApp method per company (FR-063).
create unique index if not exists whatsapp_connections_one_active_per_company
  on public.whatsapp_connections (company_id)
  where is_active;

-- Global uniqueness across companies for active normalized phone numbers and
-- active Meta `phone_number_id`s: inbound webhooks route to a single company
-- by number / `phone_number_id`, so two companies cannot share an active one.
create unique index if not exists whatsapp_connections_active_number_uidx
  on public.whatsapp_connections ((regexp_replace(connected_number, '[^0-9]', '', 'g')))
  where is_active
    and nullif(regexp_replace(coalesce(connected_number, ''), '[^0-9]', '', 'g'), '') is not null;

create unique index if not exists whatsapp_connections_active_phone_number_id_uidx
  on public.whatsapp_connections (phone_number_id)
  where is_active
    and nullif(btrim(coalesce(phone_number_id, '')), '') is not null;

drop trigger if exists set_updated_at on public.whatsapp_connections;
create trigger set_updated_at
  before update on public.whatsapp_connections
  for each row execute function public.tg_set_updated_at();

alter table public.whatsapp_connections enable row level security;
alter table public.whatsapp_connections force row level security;

revoke all on public.whatsapp_connections from public, anon, authenticated, company_service, service_role;
-- Column-level SELECT for `authenticated` omits `last_qr` so pairing QR
-- payloads are never exposed directly through PostgREST.
grant select (
  id,
  company_id,
  method,
  is_active,
  status,
  connected_number,
  instance_name,
  phone_number_id,
  waba_id,
  last_seen_at,
  last_error,
  disconnected_at,
  connected_at,
  created_at,
  updated_at
) on public.whatsapp_connections to authenticated;
grant select, insert, update, delete on public.whatsapp_connections to company_service;
grant all on public.whatsapp_connections to service_role;

drop policy if exists whatsapp_connections_select_staff on public.whatsapp_connections;
create policy whatsapp_connections_select_staff
  on public.whatsapp_connections
  for select
  to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'::text))
  );

drop policy if exists whatsapp_connections_company_service_all on public.whatsapp_connections;
create policy whatsapp_connections_company_service_all
  on public.whatsapp_connections
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

drop policy if exists whatsapp_connections_service_role_all on public.whatsapp_connections;
create policy whatsapp_connections_service_role_all
  on public.whatsapp_connections
  for all
  to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. Backfill from evolution_connections
------------------------------------------------------------

insert into public.whatsapp_connections (
  company_id,
  method,
  is_active,
  status,
  connected_number,
  instance_name,
  last_qr,
  disconnect_alert_armed,
  disconnected_at,
  connected_at,
  created_at,
  updated_at
)
select
  ec.company_id,
  'evolution_qr',
  true,
  case
    when ec.last_connection_state = 'open' then 'connected'
    when ec.last_connection_state = 'connecting' then 'pairing'
    when ec.last_connection_state in ('close', 'disconnected') then 'disconnected'
    when ec.last_connection_state is not null then 'error'
    else 'disconnected'
  end,
  nullif(btrim(ec.connected_number), ''),
  ec.instance_name,
  ec.last_qr,
  coalesce(ec.disconnect_alert_armed, false),
  ec.disconnected_at,
  ec.connected_at,
  ec.created_at,
  ec.updated_at
from public.evolution_connections ec
on conflict (company_id, method) do nothing;

------------------------------------------------------------
-- 3. connection_id on whatsapp_* tables + composite FKs
------------------------------------------------------------

alter table public.whatsapp_chats
  add column if not exists connection_id uuid;
alter table public.whatsapp_contacts
  add column if not exists connection_id uuid;
alter table public.whatsapp_messages
  add column if not exists connection_id uuid;
alter table public.whatsapp_contact_contracts
  add column if not exists connection_id uuid;

update public.whatsapp_chats t
   set connection_id = wc.id
  from (
    select distinct on (company_id) company_id, id
      from public.whatsapp_connections
     order by company_id, is_active desc, created_at asc
  ) wc
 where wc.company_id = t.company_id
   and t.connection_id is null;

update public.whatsapp_contacts t
   set connection_id = wc.id
  from (
    select distinct on (company_id) company_id, id
      from public.whatsapp_connections
     order by company_id, is_active desc, created_at asc
  ) wc
 where wc.company_id = t.company_id
   and t.connection_id is null;

update public.whatsapp_messages t
   set connection_id = wc.id
  from (
    select distinct on (company_id) company_id, id
      from public.whatsapp_connections
     order by company_id, is_active desc, created_at asc
  ) wc
 where wc.company_id = t.company_id
   and t.connection_id is null;

update public.whatsapp_contact_contracts t
   set connection_id = wc.id
  from (
    select distinct on (company_id) company_id, id
      from public.whatsapp_connections
     order by company_id, is_active desc, created_at asc
  ) wc
 where wc.company_id = t.company_id
   and t.connection_id is null;

alter table public.whatsapp_chats drop constraint if exists whatsapp_chats_company_connection_fkey;
alter table public.whatsapp_chats
  add constraint whatsapp_chats_company_connection_fkey
    foreign key (company_id, connection_id)
    references public.whatsapp_connections (company_id, id)
    on delete restrict;

alter table public.whatsapp_contacts drop constraint if exists whatsapp_contacts_company_connection_fkey;
alter table public.whatsapp_contacts
  add constraint whatsapp_contacts_company_connection_fkey
    foreign key (company_id, connection_id)
    references public.whatsapp_connections (company_id, id)
    on delete restrict;

alter table public.whatsapp_messages drop constraint if exists whatsapp_messages_company_connection_fkey;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_company_connection_fkey
    foreign key (company_id, connection_id)
    references public.whatsapp_connections (company_id, id)
    on delete restrict;

alter table public.whatsapp_contact_contracts drop constraint if exists whatsapp_contact_contracts_company_connection_fkey;
alter table public.whatsapp_contact_contracts
  add constraint whatsapp_contact_contracts_company_connection_fkey
    foreign key (company_id, connection_id)
    references public.whatsapp_connections (company_id, id)
    on delete restrict;

create index if not exists whatsapp_chats_company_connection_idx
  on public.whatsapp_chats (company_id, connection_id)
  where connection_id is not null;

create index if not exists whatsapp_contacts_company_connection_idx
  on public.whatsapp_contacts (company_id, connection_id)
  where connection_id is not null;

create index if not exists whatsapp_messages_company_connection_idx
  on public.whatsapp_messages (company_id, connection_id)
  where connection_id is not null;

create index if not exists whatsapp_contact_contracts_company_connection_idx
  on public.whatsapp_contact_contracts (company_id, connection_id)
  where connection_id is not null;

/**
 * يملأ `connection_id` تلقائياً من اتصال واتساب النشط للشركة عند الإدراج إن غاب،
 * حتى تستمر الإدراجات القائمة بالعمل دون تعديل شيفرة التطبيق في هذه المرحلة.
 */
create or replace function public.tg_whatsapp_default_connection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(new.company_id, public.current_company_id());
begin
  if new.connection_id is null and v_company_id is not null then
    select wc.id
      into new.connection_id
      from public.whatsapp_connections wc
     where wc.company_id = v_company_id
       and wc.is_active
     limit 1;
  end if;
  return new;
end;
$$;

revoke execute on function public.tg_whatsapp_default_connection() from public, anon, authenticated;

drop trigger if exists whatsapp_chats_set_connection on public.whatsapp_chats;
create trigger whatsapp_chats_set_connection
  before insert on public.whatsapp_chats
  for each row execute function public.tg_whatsapp_default_connection();

drop trigger if exists whatsapp_contacts_set_connection on public.whatsapp_contacts;
create trigger whatsapp_contacts_set_connection
  before insert on public.whatsapp_contacts
  for each row execute function public.tg_whatsapp_default_connection();

drop trigger if exists whatsapp_messages_set_connection on public.whatsapp_messages;
create trigger whatsapp_messages_set_connection
  before insert on public.whatsapp_messages
  for each row execute function public.tg_whatsapp_default_connection();

-- Named `_set_connection` so it sorts alphabetically after
-- `whatsapp_contact_contracts_inherit_company` and sees the inherited `company_id`.
drop trigger if exists whatsapp_contact_contracts_set_connection on public.whatsapp_contact_contracts;
create trigger whatsapp_contact_contracts_set_connection
  before insert on public.whatsapp_contact_contracts
  for each row execute function public.tg_whatsapp_default_connection();
