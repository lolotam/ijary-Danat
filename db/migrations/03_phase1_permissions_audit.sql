-- 03_phase1_permissions_audit.sql
-- Phase 1: granular permissions, role mappings, and append-only audit logs.
-- Idempotent. Re-running preserves existing assignments and audit records.

------------------------------------------------------------
-- permissions
------------------------------------------------------------

create table if not exists public.permissions (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  module         text not null,
  action         text not null,
  description_ar text,
  description_en text,
  is_system      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (module, action),
  constraint permissions_code_matches_parts
    check (code = module || '.' || action)
);

create index if not exists permissions_module_idx on public.permissions (module);

grant select, insert, update, delete on public.permissions to authenticated;
grant all on public.permissions to service_role;

alter table public.permissions enable row level security;

drop policy if exists permissions_select_authenticated on public.permissions;
create policy permissions_select_authenticated on public.permissions
  for select to authenticated
  using (true);

drop policy if exists permissions_write_admin on public.permissions;
create policy permissions_write_admin on public.permissions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists permissions_service_role_all on public.permissions;
create policy permissions_service_role_all on public.permissions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- role_permissions
------------------------------------------------------------

create table if not exists public.role_permissions (
  id              uuid primary key default gen_random_uuid(),
  role            public.app_role not null,
  permission_code text not null references public.permissions(code) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (role, permission_code)
);

create index if not exists role_permissions_role_idx on public.role_permissions (role);
create index if not exists role_permissions_permission_code_idx
  on public.role_permissions (permission_code);

grant select, insert, update, delete on public.role_permissions to authenticated;
grant all on public.role_permissions to service_role;

alter table public.role_permissions enable row level security;

drop policy if exists role_permissions_select_authenticated on public.role_permissions;
create policy role_permissions_select_authenticated on public.role_permissions
  for select to authenticated
  using (true);

drop policy if exists role_permissions_write_admin on public.role_permissions;
create policy role_permissions_write_admin on public.role_permissions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists role_permissions_service_role_all on public.role_permissions;
create policy role_permissions_service_role_all on public.role_permissions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- audit_logs (append-only for application users)
------------------------------------------------------------

create table if not exists public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid references auth.users(id) on delete set null,
  actor_label    text,
  role           text,
  action         text not null,
  entity_type    text,
  entity_id      uuid,
  method         text,
  path           text,
  ip             text,
  user_agent     text,
  correlation_id text,
  before         jsonb,
  after          jsonb,
  result         text not null default 'success'
    check (result in ('success', 'failure', 'error')),
  error_code     text,
  created_at     timestamptz not null default now()
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_id_idx on public.audit_logs (actor_id);
create index if not exists audit_logs_entity_type_idx on public.audit_logs (entity_type);
create index if not exists audit_logs_action_idx on public.audit_logs (action);

grant select, insert on public.audit_logs to authenticated;
grant all on public.audit_logs to service_role;
revoke update, delete on public.audit_logs from authenticated;

alter table public.audit_logs enable row level security;

drop policy if exists audit_logs_select_staff on public.audit_logs;
create policy audit_logs_select_staff on public.audit_logs
  for select to authenticated
  using (public.is_staff(auth.uid()));

drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists audit_logs_insert_own on public.audit_logs;
create policy audit_logs_insert_own on public.audit_logs
  for insert to authenticated
  with check (actor_id = auth.uid());

drop policy if exists audit_logs_service_role_all on public.audit_logs;
create policy audit_logs_service_role_all on public.audit_logs
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- write_audit() — derives request metadata and actor snapshots server-side
------------------------------------------------------------

create or replace function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_result text default 'success',
  p_error_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  v_actor_id uuid := auth.uid();
  v_actor_label text;
  v_role text;
  v_id uuid;
begin
  if v_actor_id is null
     and coalesce(v_claims ->> 'sub', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    v_actor_id := (v_claims ->> 'sub')::uuid;
  end if;

  if v_actor_id is not null then
    select coalesce(p.username::text, p.display_name, p.email::text)
      into v_actor_label
      from public.profiles p
     where p.id = v_actor_id;

    select string_agg(ur.role::text, ',' order by ur.role::text)
      into v_role
      from public.user_roles ur
     where ur.user_id = v_actor_id;
  end if;

  v_actor_label := coalesce(
    v_actor_label,
    v_claims -> 'user_metadata' ->> 'username',
    v_claims ->> 'email',
    case when v_actor_id is null then 'system' end
  );
  v_role := coalesce(v_role, v_claims ->> 'role', case when v_actor_id is null then 'system' end);

  insert into public.audit_logs (
    actor_id,
    actor_label,
    role,
    action,
    entity_type,
    entity_id,
    method,
    path,
    ip,
    user_agent,
    correlation_id,
    before,
    after,
    result,
    error_code
  ) values (
    v_actor_id,
    v_actor_label,
    v_role,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(v_headers ->> 'x-http-method', v_headers ->> 'x-forwarded-method'),
    coalesce(v_headers ->> 'x-forwarded-uri', v_headers ->> 'x-original-url'),
    nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'cf-connecting-ip', ''), ',', 1)), ''),
    v_headers ->> 'user-agent',
    coalesce(v_headers ->> 'x-request-id', v_headers ->> 'x-correlation-id'),
    p_before,
    p_after,
    p_result,
    p_error_code
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text)
  from public;
grant execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text)
  to authenticated, service_role;

------------------------------------------------------------
-- Permission catalog
------------------------------------------------------------

with base_modules(module) as (
  values
    ('tenants'),
    ('contracts'),
    ('invoices'),
    ('payments'),
    ('deposits'),
    ('expenses'),
    ('reports'),
    ('notifications'),
    ('properties'),
    ('units'),
    ('company'),
    ('users'),
    ('audit'),
    ('portal'),
    ('payment_links'),
    ('receipts')
),
base_actions(action) as (
  values ('create'), ('read'), ('update'), ('delete'), ('export')
),
catalog as (
  select module, action from base_modules cross join base_actions
  union
  select * from (values
    ('payments', 'reverse'),
    ('payments', 'override_chronological_order'),
    ('portal', 'enable'),
    ('notifications', 'send')
  ) as special(module, action)
)
insert into public.permissions (code, module, action, is_system)
select module || '.' || action, module, action, true
from catalog
on conflict (code) do nothing;

------------------------------------------------------------
-- Default role mappings
------------------------------------------------------------

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, p.code
from public.permissions p
where
  (p.module in ('payments', 'deposits', 'expenses')
    and p.action in ('create', 'read', 'update', 'export'))
  or p.code = 'payments.reverse'
  or p.code in (
    'tenants.read',
    'contracts.read',
    'invoices.read',
    'invoices.export',
    'reports.read',
    'reports.export',
    'receipts.create',
    'receipts.read',
    'receipts.export'
  )
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'collector'::public.app_role, p.code
from public.permissions p
where p.code in ('tenants.read', 'invoices.read', 'notifications.send')
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'readonly'::public.app_role, p.code
from public.permissions p
where p.action = 'read'
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'tenant'::public.app_role, p.code
from public.permissions p
where p.code in ('portal.read', 'receipts.read')
on conflict (role, permission_code) do nothing;

------------------------------------------------------------
-- has_permission() — role mapping lookup with admin short-circuit
------------------------------------------------------------

create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.has_role(_user_id, 'admin')
    or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role = ur.role
      where ur.user_id = _user_id
        and rp.permission_code = _code
    ),
    false
  )
$$;

revoke all on function public.has_permission(uuid, text) from public;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;

-- Phase 0 granted only SELECT on user_roles. Phase 1 Admin role management
-- also needs table privileges; the existing RLS policy still restricts writes.
grant insert, delete on public.user_roles to authenticated;

------------------------------------------------------------
-- Apply granular permissions to Phase 0 tables
------------------------------------------------------------

drop policy if exists companies_select_staff on public.companies;
create policy companies_select_staff on public.companies
  for select to authenticated
  using (public.has_permission(auth.uid(), 'company.read'));

drop policy if exists companies_write_admin on public.companies;

drop policy if exists companies_insert_permitted on public.companies;
create policy companies_insert_permitted on public.companies
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'company.create'));

drop policy if exists companies_update_permitted on public.companies;
create policy companies_update_permitted on public.companies
  for update to authenticated
  using (public.has_permission(auth.uid(), 'company.update'))
  with check (public.has_permission(auth.uid(), 'company.update'));

drop policy if exists companies_delete_permitted on public.companies;
create policy companies_delete_permitted on public.companies
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'company.delete'));

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles
  for select to authenticated
  using (auth.uid() = id or public.has_permission(auth.uid(), 'users.read'));

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin on public.profiles
  for update to authenticated
  using (auth.uid() = id or public.has_permission(auth.uid(), 'users.update'))
  with check (auth.uid() = id or public.has_permission(auth.uid(), 'users.update'));

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'users.create'));

drop policy if exists user_roles_select_all on public.user_roles;
create policy user_roles_select_all on public.user_roles
  for select to authenticated
  using (auth.uid() = user_id or public.has_permission(auth.uid(), 'users.read'));

drop policy if exists user_roles_write_admin on public.user_roles;

drop policy if exists user_roles_insert_permitted on public.user_roles;
create policy user_roles_insert_permitted on public.user_roles
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'users.update'));

drop policy if exists user_roles_delete_permitted on public.user_roles;
create policy user_roles_delete_permitted on public.user_roles
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'users.delete'));
