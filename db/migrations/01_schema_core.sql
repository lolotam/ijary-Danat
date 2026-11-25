-- 01_schema_core.sql
-- Core foundation: companies, profiles, roles, has_role() and base RLS.
-- Idempotent. Later phase files add property/tenant/contract/invoice tables.

------------------------------------------------------------
-- Enums
------------------------------------------------------------

do $$ begin
  create type public.app_role as enum ('admin', 'accountant', 'collector', 'readonly', 'tenant');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.locale_code as enum ('ar', 'en');
exception when duplicate_object then null; end $$;

------------------------------------------------------------
-- companies (single-company MVP, schema is multi-company ready)
------------------------------------------------------------

create table if not exists public.companies (
  id                          uuid primary key default gen_random_uuid(),
  name_ar                     text not null,
  name_en                     text not null,
  logo_url                    text,
  email                       citext,
  phone                       text,
  whatsapp                    text,
  address_ar                  text,
  address_en                  text,
  map_url                     text,
  iban                        text,
  bank_name                   text,
  facebook_url                text,
  instagram_url               text,
  invoice_footer_ar           text,
  invoice_footer_en           text,
  brand_primary               text,   -- oklch/hex; UI decides representation
  brand_accent                text,
  default_locale              public.locale_code not null default 'ar',
  timezone                    text not null default 'Asia/Kuwait',
  currency                    text not null default 'KWD',
  max_visible_unpaid_invoices integer not null default 6
    check (max_visible_unpaid_invoices > 0),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

grant select, insert, update, delete on public.companies to authenticated;
grant all on public.companies to service_role;

alter table public.companies enable row level security;

------------------------------------------------------------
-- profiles (mirrors auth.users; one row per user; NO role column)
------------------------------------------------------------

create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  company_id       uuid references public.companies(id) on delete set null,
  username         citext unique,
  display_name     text,
  email            citext,
  phone            text,
  preferred_locale public.locale_code not null default 'ar',
  is_active        boolean not null default true,
  -- when this profile represents a tenant portal user, link to tenants.id
  -- (tenants table arrives in a later phase; column left nullable + unindexed here)
  tenant_id        uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

------------------------------------------------------------
-- user_roles (roles live HERE only, never on profiles)
------------------------------------------------------------

create table if not exists public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.app_role not null,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

------------------------------------------------------------
-- has_role() — SECURITY DEFINER; used by every RLS policy that gates by role
------------------------------------------------------------

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id
      and role in ('admin', 'accountant', 'collector', 'readonly')
  )
$$;

------------------------------------------------------------
-- Policies
------------------------------------------------------------

-- companies: staff can read; only admin can write.
drop policy if exists companies_select_staff on public.companies;
create policy companies_select_staff on public.companies
  for select to authenticated
  using (public.is_staff(auth.uid()));

drop policy if exists companies_write_admin on public.companies;
create policy companies_write_admin on public.companies
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- profiles: user can read/update their own row; admin can read/update all.
drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles
  for select to authenticated
  using (auth.uid() = id or public.has_role(auth.uid(), 'admin'));

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin on public.profiles
  for update to authenticated
  using (auth.uid() = id or public.has_role(auth.uid(), 'admin'))
  with check (auth.uid() = id or public.has_role(auth.uid(), 'admin'));

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

-- user_roles: everyone authenticated can read (needed by has_role for their
-- own row); only admin (or service_role) can write. Note has_role runs as
-- SECURITY DEFINER so it does not itself depend on this policy.
drop policy if exists user_roles_select_all on public.user_roles;
create policy user_roles_select_all on public.user_roles
  for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));

drop policy if exists user_roles_write_admin on public.user_roles;
create policy user_roles_write_admin on public.user_roles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

------------------------------------------------------------
-- updated_at trigger helper
------------------------------------------------------------

create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists set_updated_at on public.companies;
create trigger set_updated_at before update on public.companies
  for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();
