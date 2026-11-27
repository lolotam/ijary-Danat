-- 317_platform_admins.sql
--
-- هوية مشرف المنصة، سجل تدقيق المنصة، وبذر إعدادات الشركة الجديدة.
--
-- Research R16 makes a super admin a GoTrue user with a `platform_admins` row
-- and no `profiles` row: `current_company_id()` is null for them, so RLS hands
-- them no company row at all. The second factor is a database rule and not a
-- screen — `is_platform_admin()` needs the row, an active flag, and GoTrue's
-- `aal2` claim — so a stolen password alone reaches nothing.
--
-- `platform_audit_log` is insert-only on purpose. No role holds UPDATE or
-- DELETE on it, and a trigger refuses both even for the table owner, so the
-- log cannot be rewritten after the fact (SC-015).
--
-- A new company receives copies of the platform defaults, never re-typed
-- values: `platform.default_rows` holds one snapshot of every default row
-- (role grants, notification templates, option lists, workflows) taken from
-- the company the migration chain seeded, and `seed_company_defaults()` gives
-- each company its own editable copy.
--
-- Rollback: drop `public.seed_company_defaults(uuid)`,
-- `public.platform_audit_log`, `public.platform_admins` and the `platform`
-- schema, then re-apply migration 254's `is_platform_admin()` stub. Audit rows
-- are history — dump them before dropping anything.

------------------------------------------------------------
-- 1. platform_admins
------------------------------------------------------------

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

revoke all on public.platform_admins from public, anon, authenticated, company_service, service_role;
grant select on public.platform_admins to authenticated, service_role;
grant insert, update, delete on public.platform_admins to service_role;

alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;

------------------------------------------------------------
-- 2. is_platform_admin(): the row AND the second factor
------------------------------------------------------------

/**
 * يحدّد ما إذا كان المستدعي مشرفاً للمنصة: صف نشط في `platform_admins` وادعاء `aal2`.
 *
 * The second factor is enforced by the database and not by a screen: GoTrue
 * adds `aal2` to the access token only after the user enrols a second factor.
 * Both halves are required — the row alone would let anyone who once was an
 * admin back in, and the claim alone would let any signed-in user in.
 *
 * The claim is read from `request.jwt.claims` rather than `auth.jwt()` because
 * the SQL test database (Postgres 15) does not define `auth.jwt()`; the JSON
 * claim blob is what both the test database and production carry.
 */
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
           select 1
             from public.platform_admins pa
            where pa.user_id = auth.uid()
              and pa.is_active
         )
     and coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal',
           ''
         ) = 'aal2';
$$;

revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

-- A signed-in super admin may read the roster (the panel names the other
-- admins); nobody else may read or write it.
drop policy if exists platform_admins_select_admin on public.platform_admins;
create policy platform_admins_select_admin on public.platform_admins
  for select to authenticated
  using ((select public.is_platform_admin()));

drop policy if exists platform_admins_service_role_all on public.platform_admins;
create policy platform_admins_service_role_all on public.platform_admins
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. platform_audit_log (insert-only)
------------------------------------------------------------

create table if not exists public.platform_audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references auth.users(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists platform_audit_log_created_at_idx
  on public.platform_audit_log (created_at desc);

create index if not exists platform_audit_log_company_created_at_idx
  on public.platform_audit_log (company_id, created_at desc);

-- `company_id` is a plain reference to the company an action touched, not the
-- scoping column of a company-scoped table: the log belongs to the platform,
-- its rows are read by platform admins, and no policy filters it by company.
revoke all on public.platform_audit_log from public, anon, authenticated, company_service, service_role;
grant select on public.platform_audit_log to authenticated, service_role;
grant insert on public.platform_audit_log to service_role;

alter table public.platform_audit_log enable row level security;
alter table public.platform_audit_log force row level security;

drop policy if exists platform_audit_log_select_admin on public.platform_audit_log;
create policy platform_audit_log_select_admin on public.platform_audit_log
  for select to authenticated
  using ((select public.is_platform_admin()));

drop policy if exists platform_audit_log_insert_service_role on public.platform_audit_log;
create policy platform_audit_log_insert_service_role on public.platform_audit_log
  for insert to service_role
  with check (true);

/**
 * يرفض أي تعديل أو حذف لسطر في سجل تدقيق المنصة.
 *
 * The grants already deny UPDATE and DELETE to every role, but a role that
 * owns the table (the migration role) can still write to it, so the trigger is
 * the guard that actually holds: an audit row is written once and stays.
 */
create or replace function public.tg_platform_audit_log_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'PLATFORM_AUDIT_LOG_IMMUTABLE: platform_audit_log rows cannot be %ed', lower(tg_op)
    using errcode = '42501';
end;
$$;

revoke execute on function public.tg_platform_audit_log_immutable() from public, anon;

drop trigger if exists platform_audit_log_immutable_update on public.platform_audit_log;
create trigger platform_audit_log_immutable_update
  before update on public.platform_audit_log
  for each row execute function public.tg_platform_audit_log_immutable();

drop trigger if exists platform_audit_log_immutable_delete on public.platform_audit_log;
create trigger platform_audit_log_immutable_delete
  before delete on public.platform_audit_log
  for each row execute function public.tg_platform_audit_log_immutable();

------------------------------------------------------------
-- 4. The platform defaults every new company starts from
------------------------------------------------------------

-- The catalogue lives outside `public` on purpose: PostgREST exposes `public`,
-- `storage` and `graphql_public` only, so no API role can read it and the
-- company-scoped schema rules (company_id, current_company_id policies) stay
-- untouched.
create schema if not exists platform;

create table if not exists platform.default_rows (
  kind       text not null,
  key        text not null,
  parent_key text,
  payload    jsonb not null,
  primary key (kind, key)
);

-- The snapshot is taken from the company the migration chain seeded, which is
-- the only company whose rows hold the platform defaults. With more than one
-- company the source is ambiguous, so the catalogue is left empty and the
-- operator seeds it explicitly instead of the migration guessing.
do $$
declare
  v_source uuid;
  v_companies integer;
begin
  select count(*) into v_companies from public.companies;

  if v_companies <> 1 then
    raise notice 'PLATFORM_DEFAULTS_SKIPPED: % companies exist; the platform defaults were not captured', v_companies;
    return;
  end if;

  v_source := public._legacy_single_company_id();

  insert into platform.default_rows (kind, key, parent_key, payload)
  select 'role_permission',
         rp.role::text || ':' || rp.permission_code,
         null,
         to_jsonb(rp) - 'id' - 'company_id'
    from public.role_permissions rp
   where rp.company_id = v_source
  on conflict (kind, key) do nothing;

  insert into platform.default_rows (kind, key, parent_key, payload)
  select 'notification_template',
         nt.code,
         null,
         to_jsonb(nt) - 'id' - 'company_id'
    from public.notification_templates nt
   where nt.company_id = v_source
  on conflict (kind, key) do nothing;

  insert into platform.default_rows (kind, key, parent_key, payload)
  select 'option_list',
         ol.code,
         null,
         to_jsonb(ol) - 'id' - 'company_id'
    from public.option_lists ol
   where ol.company_id = v_source
  on conflict (kind, key) do nothing;

  insert into platform.default_rows (kind, key, parent_key, payload)
  select 'option_list_item',
         ol.code || ':' || oli.value,
         ol.code,
         to_jsonb(oli) - 'id' - 'company_id' - 'list_id'
    from public.option_list_items oli
    join public.option_lists ol
      on ol.company_id = oli.company_id
     and ol.id = oli.list_id
   where oli.company_id = v_source
  on conflict (kind, key) do nothing;

  -- A workflow carries the last run of the source company; a new company
  -- starts with no run at all.
  insert into platform.default_rows (kind, key, parent_key, payload)
  select 'workflow',
         cj.key,
         null,
         to_jsonb(cj) - 'id' - 'company_id'
              - 'last_run_at' - 'last_status' - 'last_duration_ms'
              - 'last_error' - 'last_claimed_at'
    from public.cron_jobs cj
   where cj.company_id = v_source
  on conflict (kind, key) do nothing;
end $$;

/**
 * يهبّئ شركة جديدة بالأدوار والقوالب والقوائم وسير العمل والأقسام والحدود الافتراضية.
 *
 * The rows are copied from `platform.default_rows`, so a company starts from
 * the platform's own defaults and then owns its copy: editing a template in
 * one company never reaches another. Sections and limits come from
 * data-model.md's defaults and are filled only when their tables exist — they
 * arrive in their own migrations, and a company created before them gets them
 * when they land.
 */
create or replace function public.seed_company_defaults(_company_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if _company_id is null then
    raise exception 'COMPANY_REQUIRED: seed_company_defaults needs a company id';
  end if;

  if not exists (select 1 from public.companies where id = _company_id) then
    raise exception 'COMPANY_NOT_FOUND: %', _company_id;
  end if;

  insert into public.role_permissions
  select (jsonb_populate_record(null::public.role_permissions,
           d.payload || jsonb_build_object(
             'id', gen_random_uuid(),
             'company_id', _company_id,
             'created_at', now()
           )
         )).*
    from platform.default_rows d
   where d.kind = 'role_permission'
  on conflict do nothing;

  insert into public.notification_templates
  select (jsonb_populate_record(null::public.notification_templates,
           d.payload || jsonb_build_object(
             'id', gen_random_uuid(),
             'company_id', _company_id,
             'created_at', now(),
             'updated_at', now()
           )
         )).*
    from platform.default_rows d
   where d.kind = 'notification_template'
  on conflict do nothing;

  insert into public.option_lists
  select (jsonb_populate_record(null::public.option_lists,
           d.payload || jsonb_build_object(
             'id', gen_random_uuid(),
             'company_id', _company_id,
             'created_at', now(),
             'updated_at', now()
           )
         )).*
    from platform.default_rows d
   where d.kind = 'option_list'
  on conflict do nothing;

  insert into public.option_list_items
  select (jsonb_populate_record(null::public.option_list_items,
           d.payload || jsonb_build_object(
             'id', gen_random_uuid(),
             'company_id', _company_id,
             'list_id', ol.id,
             'created_at', now(),
             'updated_at', now()
           )
         )).*
    from platform.default_rows d
    join public.option_lists ol
      on ol.company_id = _company_id
     and ol.code = d.parent_key
   where d.kind = 'option_list_item'
  on conflict do nothing;

  insert into public.cron_jobs
  select (jsonb_populate_record(null::public.cron_jobs,
           d.payload || jsonb_build_object(
             'id', gen_random_uuid(),
             'company_id', _company_id,
             'created_at', now(),
             'updated_at', now()
           )
         )).*
    from platform.default_rows d
   where d.kind = 'workflow'
  on conflict do nothing;

  -- Every section on except the landing page and maintenance (spec.md).
  if to_regclass('public.company_modules') is not null then
    insert into public.company_modules (company_id, module_key, enabled)
    select _company_id, m.module_key, m.enabled
      from (values
              ('invoices', true),
              ('tenants', true),
              ('properties', true),
              ('units', true),
              ('contracts', true),
              ('payments', true),
              ('deposits', true),
              ('expenses', true),
              ('electricity', true),
              ('maintenance', false),
              ('employees', true),
              ('inbox', true),
              ('reports', true),
              ('audit', true),
              ('online_payments', true),
              ('whatsapp', true),
              ('landing_page', false)
            ) as m(module_key, enabled)
    on conflict do nothing;
  end if;

  -- No limit means unlimited (data-model.md).
  if to_regclass('public.company_limits') is not null then
    insert into public.company_limits (company_id)
    values (_company_id)
    on conflict do nothing;
  end if;
end;
$$;

revoke execute on function public.seed_company_defaults(uuid) from public, anon, authenticated, company_service;
grant execute on function public.seed_company_defaults(uuid) to service_role;
