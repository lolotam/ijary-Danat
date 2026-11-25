-- ============================================================
-- Migration 39: Tenant English name + managerial tenant assignment
--
-- 1. tenants.name_en — optional English name. `tenants.name` stays the
--    primary/Arabic name (it is read across invoices, receipts and
--    notification dispatch); the UI falls back to it when name_en is null.
-- 2. users.assign_tenants permission — gates who may assign tenant portal
--    access to a managerial user.
-- 3. user_tenants — many-to-many link letting one managerial account open
--    the portal of several tenants. This is a convenience switcher: it does
--    not widen the user's data access, which stays governed by has_permission.
-- Idempotent.
-- ============================================================

------------------------------------------------------------
-- 1. tenants.name_en
------------------------------------------------------------
alter table public.tenants add column if not exists name_en text;

comment on column public.tenants.name_en is
  'Optional English name. public.tenants.name remains the primary (Arabic) name.';

------------------------------------------------------------
-- 2. users.assign_tenants permission
------------------------------------------------------------
-- `permissions.code` is constrained to module || '.' || action, so the parts
-- are inserted rather than the literal code.
insert into public.permissions (code, module, action, is_system)
values ('users.assign_tenants', 'users', 'assign_tenants', true)
on conflict (code) do nothing;

-- Built-in admins hold every permission.
insert into public.role_permissions (role, permission_code)
values ('admin'::public.app_role, 'users.assign_tenants')
on conflict (role, permission_code) do nothing;

------------------------------------------------------------
-- 3. user_tenants
------------------------------------------------------------
create table if not exists public.user_tenants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (user_id, tenant_id)
);

create index if not exists user_tenants_user_idx on public.user_tenants (user_id);
create index if not exists user_tenants_tenant_idx on public.user_tenants (tenant_id);

grant select, insert, delete on public.user_tenants to authenticated;
grant all on public.user_tenants to service_role;

alter table public.user_tenants enable row level security;

-- A user always sees their own assignments (the portal switcher needs them);
-- reading someone else's requires users.read.
drop policy if exists user_tenants_select on public.user_tenants;
create policy user_tenants_select on public.user_tenants
  for select to authenticated
  using (user_id = auth.uid() or public.has_permission(auth.uid(), 'users.read'));

drop policy if exists user_tenants_write on public.user_tenants;
create policy user_tenants_write on public.user_tenants
  for all to authenticated
  using (public.has_permission(auth.uid(), 'users.assign_tenants'))
  with check (public.has_permission(auth.uid(), 'users.assign_tenants'));

drop policy if exists user_tenants_service_all on public.user_tenants;
create policy user_tenants_service_all on public.user_tenants
  for all to service_role using (true) with check (true);
