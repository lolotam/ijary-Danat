-- 254_company_context.sql
-- Foundational multi-company context primitives (Phase 2 / T006):
--   1. `company_service` role (no BYPASSRLS, granted to authenticator & postgres)
--   2. `public.reserved_slugs` with reserved host/platform slug seed
--   3. `public.companies` multi-company columns (slug, status, suspension, phone_country_code)
--      + immutability/reserved-slug guard + revoke DELETE from all app roles
--   4. `public.current_company_id()` and `public.is_platform_admin()` stub
--   5. `public.company_domains` table + RLS
--   6. Grant `company_service` the same `public` table/sequence/function privileges
--      as `authenticated` (minus `companies` DELETE).
-- Idempotent.

------------------------------------------------------------
-- 1. Role: company_service (no BYPASSRLS)
------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'company_service') then
    create role company_service nologin nobypassrls inherit;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant company_service to authenticator;
  end if;
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant company_service to postgres;
  end if;
end $$;

------------------------------------------------------------
-- 2. reserved_slugs
------------------------------------------------------------

create table if not exists public.reserved_slugs (
  slug       text primary key
               check (slug = lower(btrim(slug)) and slug <> ''),
  created_at timestamptz not null default now()
);

insert into public.reserved_slugs (slug) values
  ('admin'),
  ('www'),
  ('api'),
  ('app'),
  ('supabase'),
  ('mail'),
  ('static'),
  ('cdn'),
  ('status'),
  ('support'),
  ('evolution')
on conflict (slug) do nothing;

revoke all on public.reserved_slugs from public, anon, authenticated, company_service;
grant select on public.reserved_slugs to authenticated, company_service;
grant all on public.reserved_slugs to service_role;

alter table public.reserved_slugs enable row level security;
alter table public.reserved_slugs force row level security;

drop policy if exists reserved_slugs_select_authenticated on public.reserved_slugs;
create policy reserved_slugs_select_authenticated on public.reserved_slugs
  for select to authenticated, company_service
  using (true);

drop policy if exists reserved_slugs_service_role_all on public.reserved_slugs;
create policy reserved_slugs_service_role_all on public.reserved_slugs
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. companies (extended for multi-company SaaS)
------------------------------------------------------------

alter table public.companies
  add column if not exists slug text,
  add column if not exists status text not null default 'active',
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text,
  add column if not exists suspended_by uuid references auth.users(id) on delete set null,
  add column if not exists phone_country_code text not null default '965';

update public.companies
   set slug = 'co-' || substr(replace(id::text, '-', ''), 1, 12)
 where slug is null;

alter table public.companies
  alter column slug set default ('co-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  alter column slug set not null;

alter table public.companies drop constraint if exists companies_slug_key;
alter table public.companies add constraint companies_slug_key unique (slug);

alter table public.companies drop constraint if exists companies_slug_format;
alter table public.companies add constraint companies_slug_format
  check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$');

alter table public.companies drop constraint if exists companies_status_check;
alter table public.companies add constraint companies_status_check
  check (status in ('active', 'suspended'));

alter table public.companies drop constraint if exists companies_currency_check;
alter table public.companies add constraint companies_currency_check
  check (currency = 'KWD');

alter table public.companies drop constraint if exists companies_timezone_check;
alter table public.companies add constraint companies_timezone_check
  check (timezone = 'Asia/Kuwait');

alter table public.companies drop constraint if exists companies_phone_country_code_check;
alter table public.companies add constraint companies_phone_country_code_check
  check (phone_country_code ~ '^[0-9]{1,4}$');

alter table public.companies drop constraint if exists companies_suspension_fields_check;
alter table public.companies add constraint companies_suspension_fields_check
  check (
    (status = 'active'
      and suspended_at is null
      and suspended_reason is null
      and suspended_by is null)
    or
    (status = 'suspended'
      and suspended_at is not null
      and nullif(btrim(coalesce(suspended_reason, '')), '') is not null)
  );

/**
 * يمنع استخدام المعرّف المختصر المحجوز أو تعديله بعد إنشاء الشركة.
 */
create or replace function public.tg_guard_company_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and exists (select 1 from public.reserved_slugs rs where rs.slug = new.slug) then
    raise exception 'SLUG_RESERVED: company slug "%" is reserved', new.slug
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    raise exception 'SLUG_IMMUTABLE: companies.slug cannot be modified after creation'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_guard_company_slug() from public, anon;

drop trigger if exists trg_guard_company_slug on public.companies;
create trigger trg_guard_company_slug
  before insert or update on public.companies
  for each row execute function public.tg_guard_company_slug();

-- Company deletion is forbidden across the platform; suspension is the only removal of access.
revoke delete on public.companies from public, anon, authenticated, company_service, service_role;

------------------------------------------------------------
-- 4. Context functions: current_company_id() & is_platform_admin() stub
------------------------------------------------------------

/**
 * يُعيد معرّف الشركة النشطة للمستدعي الحالي أو null عند عدم التحقق أو الإيقاف.
 *
 * Reads `request.jwt.claims` (supported in both Postgres 15 test-db and Postgres 17
 * PostgREST) and checks the active Postgres role GUC first so an `authenticated`
 * caller can never spoof `company_service` or `allow_suspended` claims.
 * Returns null for suspended companies unless `company_service` carries `allow_suspended = true`.
 */
create or replace function public.current_company_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_role text := coalesce(
    nullif(nullif(current_setting('role', true), 'none'), ''),
    nullif(v_claims ->> 'role', ''),
    auth.role()
  );
  v_uid uuid := auth.uid();
  v_claim_sub text := v_claims ->> 'sub';
  v_claim_company text := v_claims ->> 'company_id';
  v_company_id uuid;
  v_allow_suspended boolean := false;
  v_resolved_id uuid;
begin
  if v_role = 'company_service' then
    if coalesce(v_claim_company, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_company_id := v_claim_company::uuid;
    else
      return null;
    end if;

    if jsonb_typeof(v_claims -> 'allow_suspended') = 'boolean' then
      v_allow_suspended := (v_claims ->> 'allow_suspended')::boolean;
    end if;
  elsif v_role = 'authenticated' then
    -- Support-session lookup is added in migration 297; fail closed if the claim appears early.
    if nullif(btrim(coalesce(v_claims ->> 'impersonation_session', '')), '') is not null then
      return null;
    end if;

    if v_uid is null
       and coalesce(v_claim_sub, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      v_uid := v_claim_sub::uuid;
    end if;

    if v_uid is null then
      return null;
    end if;

    select p.company_id
      into v_company_id
      from public.profiles p
     where p.id = v_uid
       and p.is_active;
  else
    return null;
  end if;

  if v_company_id is null then
    return null;
  end if;

  select c.id
    into v_resolved_id
    from public.companies c
   where c.id = v_company_id
     and (c.status = 'active' or v_allow_suspended);

  return v_resolved_id;
end;
$$;

revoke execute on function public.current_company_id() from public, anon;
grant execute on function public.current_company_id() to authenticated, company_service, service_role;

/**
 * دالة مبدئية للتحقق من مشرف المنصة — تُستبدل في ترحيل جدول مشرفي المنصة لاحقاً.
 *
 * Fail-closed stub until `platform_admins` and `aal2` enforcement arrive in migration 289.
 */
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select false;
$$;

revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

------------------------------------------------------------
-- 5. company_domains
------------------------------------------------------------

create table if not exists public.company_domains (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  host                text not null,
  kind                text not null check (kind in ('subdomain', 'custom')),
  is_primary          boolean not null default false,
  verification_status text not null default 'pending'
                        check (verification_status in ('verified', 'pending', 'failed')),
  provider_ref        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint company_domains_host_lowercase
    check (host = lower(btrim(host)) and host <> ''),
  constraint company_domains_subdomain_verified
    check (kind <> 'subdomain' or verification_status = 'verified')
);

create unique index if not exists company_domains_host_key
  on public.company_domains (host);
create index if not exists company_domains_company_id_idx
  on public.company_domains (company_id);
create unique index if not exists company_domains_one_primary_per_company_idx
  on public.company_domains (company_id)
  where is_primary;

drop trigger if exists set_updated_at on public.company_domains;
create trigger set_updated_at before update on public.company_domains
  for each row execute function public.tg_set_updated_at();

revoke all on public.company_domains from public, anon, authenticated, company_service;
grant select on public.company_domains to authenticated, company_service;
grant all on public.company_domains to service_role;

alter table public.company_domains enable row level security;
alter table public.company_domains force row level security;

drop policy if exists company_domains_select_own on public.company_domains;
create policy company_domains_select_own on public.company_domains
  for select to authenticated, company_service
  using (company_id = (select public.current_company_id()));

drop policy if exists company_domains_service_role_all on public.company_domains;
create policy company_domains_service_role_all on public.company_domains
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 6. Mirror authenticated privileges in `public` onto `company_service`
------------------------------------------------------------

grant usage on schema public to company_service;

do $$
declare
  r record;
begin
  -- Mirror existing table privileges held by `authenticated` (excluding any
  -- destructive/DDL privileges on `companies`, which only keeps SELECT/INSERT/UPDATE).
  for r in
    select table_name, privilege_type
      from information_schema.role_table_grants
     where grantee = 'authenticated'
       and table_schema = 'public'
       and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
       and not (table_name = 'companies' and privilege_type = 'DELETE')
  loop
    execute format(
      'grant %s on table public.%I to company_service',
      lower(r.privilege_type),
      r.table_name
    );
  end loop;

  for r in
    select sequence_name
      from information_schema.sequences
     where sequence_schema = 'public'
  loop
    execute format(
      'grant usage, select on sequence public.%I to company_service',
      r.sequence_name
    );
  end loop;

  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname not in ('tg_guard_company_slug', 'is_platform_admin')
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not exists (
         select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('grant execute on function %s to company_service', r.sig);
  end loop;
end $$;

-- Keep future tables and sequences in `public` accessible to `company_service`
-- (functions remain granted explicitly per function).
alter default privileges in schema public
  grant select, insert, update, delete on tables to company_service;
alter default privileges in schema public
  grant usage, select on sequences to company_service;

------------------------------------------------------------
-- 7. Legacy single-company backfill source (migrations 255-273)
------------------------------------------------------------

/**
 * يرجع معرف الشركة الوحيدة الموجودة لملء `company_id` في الصفوف القديمة، ويرفض لو فيه أكثر من شركة.
 *
 * Backfills of pre-conversion rows (one-company Danat data) need a company id.
 * Picking "the oldest company" silently assigns rows to the wrong company once
 * a second one exists, so this fails loudly instead: zero companies returns
 * null (nothing to backfill), more than one raises and the backfill must be
 * written explicitly. Migration-only: no API role can execute it.
 */
create or replace function public._legacy_single_company_id()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_count integer;
  v_id uuid;
begin
  select count(*) into v_count from public.companies;
  if v_count > 1 then
    raise exception 'LEGACY_BACKFILL_AMBIGUOUS: % companies exist; backfill company_id explicitly', v_count;
  end if;
  select c.id into v_id from public.companies c;
  return v_id;
end;
$$;

revoke execute on function public._legacy_single_company_id()
  from public, anon, authenticated, company_service;
